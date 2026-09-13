/**
 * electron/queue/storage.ts — persistence of the jobs list.
 *
 * The catalog of all jobs lives atomically at `<jobsRoot>/jobs.json`. On startup
 * the JobManager calls {@link loadJobs}; every in-memory mutation calls the
 * debounced {@link saveJobs} so a burst of progress events does not thrash disk.
 *
 * Writes are atomic (tmp→rename) like the per-job checkpoints. No Electron
 * import: the root dir is passed in, so this is unit-testable against a temp dir.
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TranslationJob } from '../../shared/types'

const CATALOG_FILE = 'jobs.json'
const DEBOUNCE_MS = 120

function catalogPath(root: string): string {
  return join(root, CATALOG_FILE)
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, path)
}

/**
 * Load the jobs catalog. Returns [] when the file is missing or corrupt (a fresh
 * install / a truncated last write) rather than throwing.
 */
export async function loadJobs(root: string): Promise<TranslationJob[]> {
  try {
    const raw = await fsp.readFile(catalogPath(root), 'utf8')
    const parsed = JSON.parse(raw) as TranslationJob[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ---- debounced writer (module-level: one pending flush per process) ----

let pendingRoot: string | null = null
let pendingJobs: TranslationJob[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null

async function writeNow(root: string, jobs: TranslationJob[]): Promise<void> {
  await atomicWrite(catalogPath(root), JSON.stringify(jobs, null, 2))
}

/**
 * Debounced atomic save of the jobs catalog. Coalesces rapid progress updates
 * into a single disk write. Call {@link flushJobs} before process exit / before
 * asserting on disk in tests.
 */
export function saveJobs(root: string, jobs: TranslationJob[]): void {
  pendingRoot = root
  // Snapshot so a later mutation of the passed array does not race the timer.
  pendingJobs = jobs.map((j) => ({ ...j }))
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (pendingRoot) {
      const r = pendingRoot
      const body = pendingJobs
      pendingRoot = null
      inflight = writeNow(r, body).catch(() => undefined)
    }
  }, DEBOUNCE_MS)
}

/** Await any debounced + in-flight catalog write. Safe to call when idle. */
export async function flushJobs(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
    if (pendingRoot) {
      const r = pendingRoot
      const body = pendingJobs
      pendingRoot = null
      inflight = writeNow(r, body).catch(() => undefined)
    }
  }
  if (inflight) {
    await inflight
    inflight = null
  }
}
