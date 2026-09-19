/**
 * electron/queue/manager.ts — the JobManager: owns every translation job, a
 * FIFO queue that runs exactly ONE job at a time (CPU-only constraint), and the
 * crash-safe checkpoint wiring.
 *
 * Concurrency model: a single in-flight job. `processQueue()` picks the oldest
 * `queued` job, marks it active, and runs the injected {@link TranslationPipeline}.
 * Pause / cancel are COOPERATIVE: the manager aborts an AbortController and the
 * pipeline must poll `signal.aborted` between units. A job re-enters the pipeline
 * only via `queued`, always through the state machine.
 *
 * The pipeline is INJECTED via {@link setPipeline} — this module never performs
 * real translation. Electron is also not imported here: the output-folder opener
 * and the renderer push channel are injected through {@link ManagerOptions}, so
 * the whole queue is unit-testable under plain Node.
 */

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JobStatus, TranslationJob } from '../../shared/types'
import { CheckpointStore } from './checkpoint.ts'
import {
  assertTransition,
  canCancel,
  canDelete,
  canPause,
  canResume,
  isActiveStatus
} from './stateMachine.ts'
import { flushJobs, loadJobs, saveJobs } from './storage.ts'

/**
 * Abstract translation pipeline, implemented later by the orchestration module.
 * It MAY mutate `job.status` through the forward phases (extracting → … →
 * exporting) and MUST periodically check `signal.aborted` to honor cooperative
 * pause / cancel.
 */
export interface TranslationPipeline {
  run(
    job: TranslationJob,
    onProgress: (page: number, progress: number) => void,
    signal: AbortSignal
  ): Promise<void>
}

export interface ManagerOptions {
  /** `<userData>/jobs` — per-job dirs + jobs.json catalog live here. */
  jobsDir: string
  /** Where finished PDFs are written. */
  outputDir: string
  /** Model id stamped on every new job. */
  model?: string
  /** Push a job update to the renderer (main → renderer `job:updated`). */
  onEvent?: (job: TranslationJob) => void
  /** Open a folder in the OS shell (injected so this module stays Electron-free). */
  opener?: (dir: string) => unknown | Promise<unknown>
}

type AbortReason = 'pause' | 'cancel'

const clamp100 = (n: number): number => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0))

export class JobManager {
  private readonly jobsDir: string
  private outputDir: string
  private readonly model: string
  private readonly onEvent?: (job: TranslationJob) => void
  private readonly opener?: (dir: string) => unknown | Promise<unknown>

  private readonly checkpoints: CheckpointStore
  private jobs = new Map<string, TranslationJob>()
  private activeJobId: string | null = null
  private pipeline: TranslationPipeline | null = null
  private readonly aborts = new Map<string, AbortController>()
  private readonly reasons = new Map<string, AbortReason>()
  /** per-job progress-rate sampling for ETA (t=last sample ms, p=last progress, ema=ms per 100%) */
  private readonly rateSamples = new Map<string, { t: number; p: number; ema: number }>()
  /** In-flight durable checkpoint writes, awaited before a dir is cleared. */
  private readonly pendingWrites = new Set<Promise<unknown>>()

  constructor(options: ManagerOptions) {
    this.jobsDir = options.jobsDir
    this.outputDir = options.outputDir
    this.model = options.model ?? ''
    this.onEvent = options.onEvent
    this.opener = options.opener
    this.checkpoints = new CheckpointStore(options.jobsDir)
  }

  /** Inject the translation pipeline (dependency injection; real logic lives elsewhere). */
  setPipeline(pipeline: TranslationPipeline): void {
    this.pipeline = pipeline
  }

  /** Redirect where FUTURE jobs write their output PDF (settings change). */
  setOutputDir(dir: string): void {
    this.outputDir = dir
  }

  // ------------------------------------------------------------------ catalog

  /** Oldest-first list of all jobs (renderer display order: FIFO — the job that
   * entered the queue first stays on top, newly-added tasks append to the back). */
  async list(): Promise<TranslationJob[]> {
    return [...this.jobs.values()]
  }

  private queueSave(): void {
    saveJobs(this.jobsDir, [...this.jobs.values()])
  }

  /** Push a job update to the renderer (cloned so the renderer never aliases ours). */
  private push(job: TranslationJob): void {
    this.onEvent?.({ ...job })
  }

  /** Track a fire-and-forget durable write so a later clear() can await it. */
  private trackWrite(p: Promise<unknown>): void {
    this.pendingWrites.add(p)
    void p.finally(() => this.pendingWrites.delete(p))
  }

  /** Await every in-flight durable checkpoint write (so clear() cannot race). */
  private async flushPendingWrites(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites])
  }

  /**
   * The ONLY way to mutate a job status: route through the state machine, update
   * timestamps, push to the renderer, persist the catalog, and durably snapshot
   * state.json. Await it before a subsequent `clear()` so the snapshot write can
   * never race / resurrect a deleted job dir.
   */
  private async transition(job: TranslationJob, to: JobStatus): Promise<void> {
    assertTransition(job.status, to)
    job.status = to
    job.updatedAt = Date.now()
    this.push(job)
    this.queueSave()
    await this.checkpoints.saveState(job.id, { status: to, updatedAt: job.updatedAt })
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Load the catalog and run startup orphan repair: any job still in an ACTIVE
   * phase cannot have a live executor (we just launched), so it is repaired to
   * `paused` so it can be resumed.
   */
  async bootstrap(): Promise<void> {
    const loaded = await loadJobs(this.jobsDir)
    this.jobs = new Map()
    for (const j of loaded) this.jobs.set(j.id, j)

    let repaired = false
    for (const j of this.jobs.values()) {
      if (isActiveStatus(j.status)) {
        j.status = 'paused'
        j.updatedAt = Date.now()
        repaired = true
      }
    }
    if (repaired) this.queueSave()
    await flushJobs()
  }

  /** Create a queued job and kick the queue. */
  async add(inputPath: string): Promise<TranslationJob> {
    const id = randomUUID()
    const stem = basename(inputPath).replace(/\.pdf$/i, '') || 'document'
    const job: TranslationJob = {
      id,
      inputPath,
      outputPath: join(this.outputDir, `${stem}.zh.pdf`),
      status: 'queued',
      progress: 0,
      totalPages: 0,
      currentPage: 0,
      model: this.model,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.jobs.set(id, job)
    this.push(job)
    this.queueSave()
    void this.processQueue()
    return job
  }

  // ------------------------------------------------------------------ controls

  /** Pause the currently-running job (cooperative; stops after the current unit). */
  async pause(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || !canPause(job.status)) return
    this.reasons.set(id, 'pause')
    this.aborts.get(id)?.abort()
  }

  /** Resume a paused / errored / canceled job: re-enter via `queued`. */
  async resume(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || !canResume(job.status)) return
    job.error = undefined
    this.transition(job, 'queued')
    void this.processQueue()
  }
  /**
   * Cancel a job. If it is running, abort cooperatively and let the pipeline
   * settle to `canceled`; otherwise transition immediately. Temporary job files
   * are cleaned, but a finished output PDF is kept.
   */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || !canCancel(job.status)) return

    if (this.aborts.has(id)) {
      // Running: pipeline will observe the signal and settle to 'canceled'.
      this.reasons.set(id, 'cancel')
      this.aborts.get(id)?.abort()
      return
    }

    await this.transition(job, 'canceled')
    await this.flushPendingWrites()
    await this.checkpoints.clear(id)
    this.queueSave()
  }

  /**
   * Delete a job record, its output PDF, and its checkpoint dir. Aborts it first
   * if it is currently running.
   */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    // Abort an in-flight run; the executeJob finally guards the push once the
    // record is gone, so it will not resurrect the job.
    this.reasons.set(id, 'cancel')
    this.aborts.get(id)?.abort()

    this.jobs.delete(id)
    try {
      await fsp.rm(job.outputPath, { force: true })
    } catch {
      /* output already gone */
    }
    await this.flushPendingWrites()
    await this.checkpoints.clear(id)
    this.queueSave()
  }

  /** Open the folder containing the job's output PDF in the OS shell. */
  async openFolder(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    const target = job.outputPath ? dirname(job.outputPath) : this.checkpoints.getJobDir(id)
    if (this.opener) await this.opener(target)
  }

  // ------------------------------------------------------------------ queue pump

  /**
   * FIFO pump: pick the oldest `queued` job, run it exclusively, then loop.
   * No-op unless a pipeline is set and nothing is currently active.
   */
  private async processQueue(): Promise<void> {
    if (!this.pipeline || this.activeJobId) return
    const next = [...this.jobs.values()].find((j) => j.status === 'queued')
    if (!next) return
    this.activeJobId = next.id
    void this.executeJob(next)
  }

  private onProgress(job: TranslationJob, page: number, progress: number): void {
    if (!this.jobs.has(job.id)) return
    job.currentPage = page
    job.progress = clamp100(progress)
    job.updatedAt = Date.now()
    // ETA: EMA over wall-time-per-progress-point, only while progress moves.
    const now = Date.now()
    const prev = this.rateSamples.get(job.id)
    if (prev && job.progress > prev.p + 0.001) {
      const inst = (now - prev.t) / ((job.progress - prev.p) / 100)
      const ema = prev.ema > 0 ? prev.ema * 0.7 + inst * 0.3 : inst
      this.rateSamples.set(job.id, { t: now, p: job.progress, ema })
      if (job.progress > 5 && job.progress < 100) {
        job.etaSec = Math.max(1, Math.round(((100 - job.progress) / 100) * ema / 1000))
      }
    } else {
      this.rateSamples.set(job.id, { t: now, p: job.progress, ema: 0 })
    }
    this.push(job)
    this.trackWrite(
      this.checkpoints.save(job.id, {
        phase: job.status,
        completedPages: page,
        progress: job.progress,
        translatedUnits: 0,
        totalUnits: 0
      })
    )
    this.queueSave()
  }

  /**
   * Settle a job whose run ended because of an abort request (cooperative pause
   * or cancel). Distinguished by the explicit `reason` (NOT `signal.aborted`,
   * which can be set on an already-finished run by `remove()`). A job that was
   * `remove()`d mid-run has no record left, so nothing is persisted for it.
   */
  private async settleAfterAbort(job: TranslationJob, reason: AbortReason): Promise<void> {
    if (!this.jobs.has(job.id)) return
    if (reason === 'cancel') {
      // Persist the canceled snapshot, wait for any in-flight progress write,
      // THEN clear — or a late write would resurrect the job dir.
      await this.transition(job, 'canceled')
      await this.flushPendingWrites()
      // Clean temp files; a finished output PDF (if any) is preserved.
      await this.checkpoints.clear(job.id)
    } else {
      // pause: keep the checkpoint so resume continues from the same offset.
      await this.transition(job, 'paused')
    }
  }

  private async executeJob(job: TranslationJob): Promise<void> {
    const pipeline = this.pipeline
    if (!pipeline) return

    const ac = new AbortController()
    this.aborts.set(job.id, ac)

    try {
      await this.transition(job, 'extracting') // queued → extracting
      await pipeline.run(
        job,
        (page, progress) => this.onProgress(job, page, progress),
        ac.signal
      )

      // A pause/cancel was requested mid-run → settle cooperatively. An absent
      // reason means the run completed normally (even if remove() later aborted a
      // resolved controller).
      const reason = this.reasons.get(job.id)
      if (reason) {
        await this.settleAfterAbort(job, reason)
      } else {
        await this.transition(job, 'done')
        job.progress = 100
        job.currentPage = job.totalPages > 0 ? job.totalPages : job.currentPage
        await this.checkpoints.save(job.id, {
          phase: 'done',
          completedPages: job.currentPage,
          progress: 100,
          translatedUnits: 0,
          totalUnits: 0
        })
      }
    } catch (err) {
      const reason = this.reasons.get(job.id)
      if (reason) {
        await this.settleAfterAbort(job, reason)
      } else {
        await this.transition(job, 'error')
        job.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      this.aborts.delete(job.id)
      this.reasons.delete(job.id)
      this.rateSamples.delete(job.id)
      if (this.activeJobId === job.id) this.activeJobId = null
      // Only emit if the job still exists (it may have been `remove()`d mid-run).
      if (this.jobs.has(job.id)) {
        this.push(job)
        this.queueSave()
      }
      void this.processQueue()
    }
  }
}

// Re-export the small guards the IPC layer finds handy.
export { canPause, canResume, canCancel, canDelete, isActiveStatus }
