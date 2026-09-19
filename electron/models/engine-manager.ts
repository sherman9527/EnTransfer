// engine-manager.ts — owns the single live TranslationEngine.
//
// CPU machines can only afford one model resident at a time, so this manager
// keeps at most one LlamaCppEngine loaded and lazily (re)builds it when the
// requested model id *or* the inference settings (device / thread policy)
// change. Warmup happens on load; switching unloads the previous one first.
import { existsSync } from 'node:fs'
import { LlamaCppEngine } from './llama-engine.ts'
import { getEngineConfig } from './engine-config.ts'
import { getModelPath } from './registry.ts'
import type { TranslationEngine } from './engine-interface.ts'
import type { DevicePreference } from './gpu.ts'

/** Runtime inference preferences supplied by the main process (from settings). */
export interface InferenceSettings {
  /** 'auto' | 'cpu' | 'gpu' (default 'auto') */
  device?: DevicePreference
  /** 'auto' resolves smart threads at load; 'manual' uses manualThreads */
  threadsMode?: 'auto' | 'manual'
  /** user-pinned thread count when threadsMode === 'manual' */
  manualThreads?: number
}

export class EngineManager {
  private engine: LlamaCppEngine | null = null
  private currentKey: string | null = null
  /** Set once an engine reports a mid-run hardware failure; sticky for the
   *  session so we never hand a crashed GPU runtime a second chance. */
  private forcedCpu = false
  /** How many times a sick engine was rebuilt this session. A CPU rebuild
   *  that keeps dying must surface as a job error, not reload forever. */
  private sickRebuilds = 0
  /** UI callback for engine-level notices (failover etc.), wired from main. */
  onNotice: ((message: string) => void) | null = null

  /** Get (loading if needed) the engine for `modelId`. The returned engine is
   * already loaded and warm. Reloads automatically when `settings` change so
   * the user can switch device / thread policy without restarting.
   * When the previous engine died mid-generation (isSick), it is disposed and
   * rebuilt on CPU regardless of the requested device. */
  async getEngine(modelId: string, settings: InferenceSettings = {}): Promise<TranslationEngine> {
    if (this.engine?.isSick) {
      this.sickRebuilds++
      if (this.sickRebuilds > 3) {
        console.error('[engine-manager] engine failed %d rebuilds in a row; surfacing error', this.sickRebuilds)
        throw new Error('推理引擎连续异常（已重建 3 次仍失败），请检查设备或换 CPU 后重试本任务')
      }
      console.warn('[engine-manager] engine reported hardware failure; rebuilding on CPU for the rest of the session')
      this.onNotice?.('GPU 推理异常，已自动切换 CPU 继续翻译（速度下降，进度不受影响）')
      this.forcedCpu = true
      await this.unload()
      this.currentKey = null
    }
    let device: DevicePreference = settings.device ?? 'auto'
    if (this.forcedCpu) device = 'cpu'
    const threadsMode = settings.threadsMode ?? 'auto'
    const manualThreads = settings.threadsMode === 'manual' ? settings.manualThreads ?? 0 : 0
    const key = `${modelId}|${device}|${threadsMode}|${manualThreads}`

    if (this.engine && this.currentKey === key && this.engine.isLoaded) {
      return this.engine
    }
    await this.unload()

    const modelPath = getModelPath(modelId)
    if (!modelPath) throw new Error(`EngineManager: no on-disk file for model id "${modelId}"`)
    if (!existsSync(modelPath)) throw new Error(`EngineManager: model file not found: ${modelPath}`)

    const conf = getEngineConfig(modelId)
    // When manual threads are chosen, pin them; otherwise let the engine resolve
    // the smart default from the detected CPU at load() time.
    const useManualThreads = threadsMode === 'manual' && manualThreads > 0
    const threadsArg: number | 'auto' = useManualThreads ? manualThreads : 'auto'

    this.engine = new LlamaCppEngine({
      id: modelId,
      systemPrompt: conf.systemPrompt,
      contextSize: conf.contextSize,
      device,
      threadsMode,
      threads: useManualThreads ? manualThreads : conf.threads,
      sampling: { temperature: conf.temperature, topK: conf.topK, topP: conf.topP },
      disableReasoning: conf.disableReasoning
    })
    await this.engine.load(modelPath, {
      threads: threadsArg,
      contextSize: conf.contextSize,
      device
    })
    this.currentKey = key
    return this.engine
  }

  /** The currently loaded engine id, or null. */
  get loadedModelId(): string | null {
    return this.currentKey ? this.currentKey.split('|')[0] : null
  }

  /** Unload whatever engine is resident. */
  async unload(): Promise<void> {
    await this.engine?.dispose()
    this.engine = null
    this.currentKey = null
  }
}
