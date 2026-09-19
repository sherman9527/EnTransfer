import { create } from 'zustand'
import { events, jobApi } from '../ipc/client'
import type { JobStatus, TranslationJob } from '../../../shared/types'

interface QueueState {
  jobs: TranslationJob[]
  loading: boolean
  /** id -> busy while an async action is in flight (prevents double clicks). */
  busyIds: Record<string, boolean>
  /** top-level "添加 PDF" / "全部开始" busy flag. */
  working: boolean
  /** engine-level notices (GPU failover etc.), newest last, capped. */
  notices: string[]

  fetchJobs: () => Promise<void>
  addJob: (inputPath: string) => Promise<void>
  pauseJob: (id: string) => Promise<void>
  resumeJob: (id: string) => Promise<void>
  cancelJob: (id: string) => Promise<void>
  /** Error-state retry: re-enter the queue so the checkpoint resumes. */
  retryJob: (id: string) => Promise<void>
  removeJob: (id: string) => Promise<void>
  openJobFolder: (id: string) => Promise<void>
  /** Resume every paused job (used by the "全部开始" toolbar button). */
  startAll: () => Promise<void>
  dismissNotices: () => void
}

// ---------------------------------------------------------------------------
// Status presentation map (label + Tailwind text/progress-bar colour).
// ---------------------------------------------------------------------------
export const STATUS_META: Record<JobStatus, { label: string; text: string; bar: string }> = {
  queued: { label: '排队中', text: 'text-ink3', bar: 'bg-ink3' },
  extracting: { label: '解析页面', text: 'text-sky-400', bar: 'bg-sky-400' },
  translating: { label: '翻译中', text: 'text-warn', bar: 'bg-warn' },
  typesetting: { label: '排版中', text: 'text-ok', bar: 'bg-ok' },
  exporting: { label: '导出中', text: 'text-cyan-400', bar: 'bg-cyan-400' },
  done: { label: '已完成', text: 'text-ok', bar: 'bg-ok' },
  paused: { label: '已暂停', text: 'text-warn', bar: 'bg-warn' },
  canceled: { label: '已取消', text: 'text-ink3', bar: 'bg-ink3' },
  error: { label: '失败', text: 'text-danger', bar: 'bg-danger' }
}

// Guards against stale async writes (bug #9): `rev` bumps on every upsert so a
// slow fetchJobs can detect it was superseded; `tombstones` remembers deleted
// ids so an in-flight push can't resurrect them until the next authoritative fetch.
let rev = 0
const tombstones = new Set<string>()

export const useQueueStore = create<QueueState>((set, get) => ({
  jobs: [],
  loading: false,
  busyIds: {},
  working: false,
  notices: [],

  dismissNotices: () => set({ notices: [] }),

  fetchJobs: async () => {
    set({ loading: true })
    const revAtStart = rev
    try {
      const jobs = await jobApi.list()
      // Discard a stale list if any add/update event landed during the await
      // (bug #9a: otherwise the older response drops/reorders a newer job).
      if (rev !== revAtStart) return
      tombstones.clear() // authoritative snapshot — deleted jobs are gone
      set({ jobs })
    } catch (err) {
      console.error('[queue] fetchJobs failed', err)
    } finally {
      set({ loading: false })
    }
  },

  addJob: async (inputPath) => {
    set({ working: true })
    try {
      const job = await jobApi.add(inputPath)
      upsertJob(job)
    } catch (err) {
      console.error('[queue] addJob failed', err)
    } finally {
      set({ working: false })
    }
  },

  pauseJob: withBusy((id) => jobApi.pause(id)),
  resumeJob: withBusy((id) => jobApi.resume(id)),
  cancelJob: withBusy((id) => jobApi.cancel(id)),

  retryJob: async (id) => {
    // Resume the SAME job record rather than remove+re-add: the checkpoint
    // (already-translated units) and the translation cache are reused, so a
    // retry after an error continues from ~where it stopped instead of
    // restarting the whole book. error/paused/canceled all re-enter via queued.
    const job = get().jobs.find((j) => j.id === id)
    if (!job) return
    setBusy(id, true)
    try {
      await jobApi.resume(id)
    } catch (err) {
      console.error('[queue] retryJob failed', err)
    } finally {
      setBusy(id, false)
    }
  },

  removeJob: async (id) => {
    setBusy(id, true)
    tombstones.add(id)
    try {
      await jobApi.remove(id)
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
    } catch (err) {
      console.error('[queue] removeJob failed', err)
      tombstones.delete(id) // removal failed — allow future pushes for it again
    } finally {
      setBusy(id, false)
    }
  },

  openJobFolder: async (id) => {
    try {
      await jobApi.openFolder(id)
    } catch (err) {
      console.error('[queue] openJobFolder failed', err)
    }
  },

  startAll: async () => {
    const paused = get().jobs.filter((j) => j.status === 'paused')
    if (paused.length === 0) return
    set({ working: true })
    try {
      await Promise.all(paused.map((j) => jobApi.resume(j.id)))
    } catch (err) {
      console.error('[queue] startAll failed', err)
    } finally {
      set({ working: false })
    }
  }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upsertJob(job: TranslationJob): void {
  rev++
  // A job the user just deleted can still have an in-flight push; ignore it so
  // it isn't re-appended (bug #9b). Tombstones clear on the next authoritative fetch.
  if (tombstones.has(job.id)) return
  useQueueStore.setState((s) => {
    const exists = s.jobs.some((j) => j.id === job.id)
    // FIFO display: update in place, or append a new job to the BACK so the
    // in-progress/first task stays on top and freshly-added tasks go below.
    const jobs = exists
      ? s.jobs.map((j) => (j.id === job.id ? job : j))
      : [...s.jobs, job]
    return { jobs }
  })
}

function setBusy(id: string, busy: boolean): void {
  useQueueStore.setState((s) => {
    const busyIds = { ...s.busyIds }
    if (busy) busyIds[id] = true
    else delete busyIds[id]
    return { busyIds }
  })
}

/** Wrap a per-id async call with the busyIds guard so buttons can't double-fire. */
function withBusy(fn: (id: string) => Promise<unknown>): (id: string) => Promise<void> {
  return async (id) => {
    setBusy(id, true)
    try {
      await fn(id)
    } catch (err) {
      console.error('[queue] action failed', id, err)
    } finally {
      setBusy(id, false)
    }
  }
}

// ---------------------------------------------------------------------------
// Subscribe to main -> renderer push events (job:updated) exactly once.
// Each push is a full TranslationJob snapshot; upsert by id.
// ---------------------------------------------------------------------------
events.onJobUpdate((job) => upsertJob(job))

// Engine-level notices (GPU->CPU failover, etc.) arrive on the app:log
// channel; surface the last few as a dismissible banner.
events.onLog((line) => {
  useQueueStore.setState((s) => ({ notices: [...s.notices.filter((n) => n !== line).slice(-4), line] }))
})
