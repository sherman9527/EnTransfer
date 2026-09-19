// ModelManager: orchestrates the model catalogue, downloads and the lazy
// translation engine. The IPC layer (ipc.ts) calls into this class; the
// renderer only ever sees ModelInfo snapshots pushed via onUpdated.
import { existsSync, rmSync } from 'node:fs'
import type { ModelInfo, ModelStatus } from '../../shared/types'
import { getModelInfo, getModelPath, getModels, DEFAULT_MODEL_ID } from './registry.ts'
import { downloadModel, applyMirror, type DownloadProgress } from './download.ts'
import type { TranslationEngine } from './engine-interface.ts'
import { EngineManager, type InferenceSettings } from './engine-manager.ts'

interface DownloadTask {
  controller: AbortController
  promise: Promise<void>
}

const DEFAULT_MODEL = DEFAULT_MODEL_ID

export class ModelManager {
  /** Fired whenever a model's status / progress changes. */
  onUpdated: ((model: ModelInfo) => void) | null = null

  private downloads = new Map<string, DownloadTask>()
  private runtimeStatus = new Map<string, ModelStatus>()
  private runtimeProgress = new Map<string, { percent: number; speed: string }>()
  private engineManager = new EngineManager()
  private defaultModelId: string = DEFAULT_MODEL
  /** Inference preferences pushed from main process settings. */
  private inferenceSettings: InferenceSettings = {}
  /** Download mirror origin ('' = keep registry URL). */
  private mirror = ''

  setMirror(mirror: string | undefined): void {
    this.mirror = mirror ?? ''
  }

  // -- Catalogue -----------------------------------------------------------

  list(): ModelInfo[] {
    const runtime: Record<string, ModelStatus> = {}
    for (const [id, status] of this.runtimeStatus) runtime[id] = status
    return getModels(runtime).map((m) => {
      const prog = this.runtimeProgress.get(m.id)
      return prog ? { ...m, downloadProgress: prog.percent, downloadSpeed: prog.speed } : m
    })
  }

  getDefaultModelId(): string {
    return this.defaultModelId
  }

  // -- Downloads ------------------------------------------------------------

  /**
   * Start downloading a model. Resolves when the download completes; rejects on
   * error or cancellation. Safe to call only when not already downloading.
   */
  async download(id: string): Promise<void> {
    const info = getModelInfo(id)
    if (!info) throw new Error(`Unknown model id: ${id}`)
    if (this.downloads.has(id)) throw new Error(`Model ${id} is already downloading`)

    const controller = new AbortController()
    const promise = this.runDownload(id, info, controller.signal)
    this.downloads.set(id, { controller, promise })
    this.emitStatus(id, 'downloading')
    await promise
  }

  private async runDownload(
    id: string,
    info: ModelInfo,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await downloadModel(
        applyMirror(info, this.mirror),
        (p: DownloadProgress) => {
          this.runtimeProgress.set(id, {
            percent: Math.round(p.percent * 10) / 10,
            speed: `${p.speed.toFixed(2)} MB/s`
          })
          this.emitStatus(id, 'downloading')
        },
        signal
      )
      this.runtimeStatus.delete(id)
      this.runtimeProgress.delete(id)
      this.emitStatus(id, 'available')
      // If no model is currently usable as default, promote the freshly
      // downloaded one so the engine always has a valid default.
      if (!this.hasDownloaded(this.defaultModelId)) {
        this.defaultModelId = id
      }
      this.emitDefault()
    } catch (err) {
      this.runtimeProgress.delete(id)
      // If cancellation interrupted a partial download, keep whatever .part
      // bytes remain and revert to the on-disk status for next time.
      this.runtimeStatus.delete(id)
      this.emitStatus(id)
      throw err
    } finally {
      this.downloads.delete(id)
    }
  }

  cancelDownload(id: string): void {
    const task = this.downloads.get(id)
    if (!task) return
    task.controller.abort(new Error('Download cancelled by user'))
  }

  constructor(initialDefaultId?: string) {
    // Single source of truth is the main-process settings store; the manager
    // accepts it at construction instead of maintaining its own default.
    if (initialDefaultId && getModelInfo(initialDefaultId)) {
      this.defaultModelId = initialDefaultId
    }
  }

  // -- Removal --------------------------------------------------------------

  remove(id: string): void {
    if (this.downloads.has(id)) this.cancelDownload(id)
    const path = getModelPath(id)
    if (path) {
      try {
        if (existsSync(path)) rmSync(path)
        const part = path + '.part'
        if (existsSync(part)) rmSync(part)
      } catch {
        // ignore unlink errors
      }
    }
    this.runtimeStatus.delete(id)
    this.runtimeProgress.delete(id)
    this.emitStatus(id, 'not-downloaded')
    // If the deleted model was the default, fall back to the first model that
    // is actually on disk so the engine never points at a missing file.
    if (id === this.defaultModelId) {
      const fallback = this.firstDownloaded()
      this.defaultModelId = fallback ?? this.defaultModelId
      this.emitDefault()
    }
  }

  // -- Default model --------------------------------------------------------

  setDefault(id: string): void {
    if (!getModelInfo(id)) throw new Error(`Unknown model id: ${id}`)
    if (id === this.defaultModelId) return
    this.defaultModelId = id
    // Drop any resident engine so the next getEngine() loads the new default.
    void this.engineManager.unload()
    this.emitDefault()
  }

  /** True if the given model's file exists on disk. */
  private hasDownloaded(id: string): boolean {
    const p = getModelPath(id)
    return !!p && existsSync(p)
  }

  /** First catalogue model whose file is on disk, or null. */
  private firstDownloaded(): string | null {
    for (const m of getModels({})) {
      if (this.hasDownloaded(m.id)) return m.id
    }
    return null
  }

  /** Notify the UI that the active default model changed. */
  private emitDefault(): void {
    const model = this.list().find((m) => m.id === this.defaultModelId)
    if (model && this.onUpdated) this.onUpdated(model)
  }

  /**
   * Push the user's inference preferences (device / thread policy) from the
   * main-process settings store. The next getEngine() reloads the model with
   * the new settings (EngineManager invalidates on change).
   */
  setInferenceSettings(s: InferenceSettings): void {
    this.inferenceSettings = { ...s }
  }

  // -- Translation engine (lazy) --------------------------------------------

  /**
   * Return a ready-to-use translation engine for the default model, loading it
   * on first use (and switching models when the default changes). At most one
   * model stays resident; EngineManager unloads the previous one on switch.
   */
  async getEngine(): Promise<TranslationEngine> {
    const path = getModelPath(this.defaultModelId)
    if (!path) throw new Error('Default model is not downloadable')
    if (!existsSync(path)) {
      throw new Error('Default model not downloaded yet')
    }
    return (await this.engineManager.getEngine(this.defaultModelId, this.inferenceSettings)) as TranslationEngine
  }

  /** Tear down the engine (called on app shutdown). */
  async dispose(): Promise<void> {
    for (const task of this.downloads.values()) task.controller.abort()
    await this.engineManager.unload()
  }

  /** Surface engine-level notices (GPU failover…) to the UI. */
  setOnNotice(cb: (message: string) => void): void {
    this.engineManager.onNotice = cb
  }

  // -- Internals ------------------------------------------------------------

  private emitStatus(id: string, status?: ModelStatus): void {
    if (status) this.runtimeStatus.set(id, status)
    const model = this.list().find((m) => m.id === id)
    if (model && this.onUpdated) this.onUpdated(model)
  }
}
