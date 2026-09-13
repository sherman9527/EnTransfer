/**
 * electron/queue/checkpoint.ts — crash-safe, durable per-job progress store.
 *
 * Layout under `<jobsRoot>/<jobId>/`:
 *   checkpoint.json   atomic tmp→rename — { phase, completedPages, progress,
 *                                          translatedUnits, totalUnits }
 *   translation.jsonl append-only      — one finalized TranslationUnit per line
 *   state.json        atomic          — task status snapshot
 *
 * Crash safety: every JSON snapshot is written to `<file>.tmp` first and then
 * atomically renamed over the target (libuv uses MoveFileExW with
 * MOVEFILE_REPLACE_EXISTING on Windows, so rename is atomic there too). A power
 * loss mid-write corrupts only the tmp file; the last fully-renamed snapshot
 * survives. `translation.jsonl` is append-only and is NEVER truncated on resume —
 * already-translated units are not re-translated.
 *
 * No Electron import here: the store is constructed with an explicit jobsRoot so
 * the whole lifecycle is unit-testable against a temp dir.
 */

import { promises as fsp } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { JobStatus } from '../../shared/types'

// ---------------------------------------------------------------------------
// jobId path-safety — the run dir is <jobsRoot>/<jobId>, never let a renderer-
// supplied id escape it via '..' or a path separator.
// ---------------------------------------------------------------------------

/** Whether a renderer-supplied jobId is safe to use verbatim as a dir name. */
export function isSafeJobId(id: unknown): id is string {
  return typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9_.-]+$/.test(id)
}

function assertSafe(jobId: string): void {
  if (!isSafeJobId(jobId)) throw new Error(`非法的任务 id：${String(jobId)}`)
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** Durable progress snapshot persisted to checkpoint.json. */
export interface CheckpointData {
  phase: JobStatus
  completedPages: number
  /** 0 - 100 */
  progress: number
  translatedUnits: number
  totalUnits: number
}

/** One finalized translated unit, appended (append-only) to translation.jsonl. */
export interface TranslationUnitRecord {
  unitId: string
  translatedText: string
}

const CHECKPOINT_FILE = 'checkpoint.json'
const TRANSLATION_FILE = 'translation.jsonl'
const STATE_FILE = 'state.json'

// ---------------------------------------------------------------------------
// CheckpointStore
// ---------------------------------------------------------------------------

/**
 * The durable per-job store. Owns checkpoint.json (atomic), translation.jsonl
 * (append-only) and state.json (atomic) under `<jobsRoot>/<jobId>/`.
 */
export class CheckpointStore {
  readonly jobsRoot: string

  constructor(jobsRoot: string) {
    this.jobsRoot = jobsRoot
  }

  /** Absolute dir for a job (created lazily on first write). */
  getJobDir(jobId: string): string {
    assertSafe(jobId)
    return join(this.jobsRoot, jobId)
  }

  private checkpointPath(jobId: string): string {
    return join(this.getJobDir(jobId), CHECKPOINT_FILE)
  }

  private translationPath(jobId: string): string {
    return join(this.getJobDir(jobId), TRANSLATION_FILE)
  }

  private statePath(jobId: string): string {
    return join(this.getJobDir(jobId), STATE_FILE)
  }

  private async ensureDir(jobId: string): Promise<void> {
    await fsp.mkdir(this.getJobDir(jobId), { recursive: true })
  }

  /**
   * Atomic write: serialize to `<path>.tmp`, fsync-less, then rename over the
   * target. On Windows rename replaces the destination atomically (libuv).
   */
  private async atomicWrite(path: string, data: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    await fsp.writeFile(tmp, data, 'utf8')
    await fsp.rename(tmp, path)
  }

  // ----- checkpoint.json (atomic) -----

  /** Persist a progress snapshot atomically. */
  async save(jobId: string, data: CheckpointData): Promise<void> {
    await this.ensureDir(jobId)
    await this.atomicWrite(this.checkpointPath(jobId), JSON.stringify(data))
  }

  /** Read the progress snapshot; null when the job has no checkpoint yet. */
  async load(jobId: string): Promise<CheckpointData | null> {
    try {
      const raw = await fsp.readFile(this.checkpointPath(jobId), 'utf8')
      return JSON.parse(raw) as CheckpointData
    } catch {
      return null
    }
  }

  // ----- translation.jsonl (append-only) -----

  /**
   * Append one finalized unit to translation.jsonl. Append-only: resume never
   * truncates this file, so a unit already translated is never re-translated.
   */
  async appendTranslation(jobId: string, unitId: string, translatedText: string): Promise<void> {
    await this.ensureDir(jobId)
    const record: TranslationUnitRecord = { unitId, translatedText }
    const handle = await fsp.open(this.translationPath(jobId), 'a')
    try {
      await handle.write(JSON.stringify(record) + '\n')
    } finally {
      await handle.close()
    }
  }

  /**
   * Read all durable translations back into a Map<unitId, translatedText>.
   * Tolerant of a partial trailing line (a crash mid-append) — unparseable
   * lines are skipped.
   */
  async loadTranslations(jobId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    let raw: string
    try {
      raw = await fsp.readFile(this.translationPath(jobId), 'utf8')
    } catch {
      return out
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line) as TranslationUnitRecord
        if (rec && typeof rec.unitId === 'string' && typeof rec.translatedText === 'string') {
          out.set(rec.unitId, rec.translatedText)
        }
      } catch {
        /* skip a partial/corrupt trailing line */
      }
    }
    return out
  }

  // ----- state.json (atomic status snapshot) -----

  /** Persist an arbitrary status snapshot object (atomic). */
  async saveState(jobId: string, state: Record<string, unknown>): Promise<void> {
    await this.ensureDir(jobId)
    await this.atomicWrite(this.statePath(jobId), JSON.stringify(state))
  }

  /** Read the status snapshot; null when absent. */
  async loadState(jobId: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fsp.readFile(this.statePath(jobId), 'utf8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }

  // ----- delete -----

  /**
   * Remove the entire job dir (checkpoint + translation.jsonl + state.json).
   * Defense-in-depth: never delete outside jobsRoot even if the dir was built
   * from an unsafe id (the guard runs in getJobDir already).
   */
  async clear(jobId: string): Promise<void> {
    const root = resolve(this.jobsRoot)
    const target = resolve(this.getJobDir(jobId))
    if (target !== root && !target.startsWith(root + sep)) return
    try {
      await fsp.rm(target, { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
}
