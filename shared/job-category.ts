import type { JobStatus } from './types'

// Task-queue category filter (pure, shared by the renderer and the regression
// suite). Four buckets; `all` is the default view.
export type JobFilter = 'all' | 'active' | 'queued' | 'done'

export const JOB_FILTERS: ReadonlyArray<{ id: JobFilter; label: string }> = [
  { id: 'all', label: '全部任务' },
  { id: 'active', label: '进行中' },
  { id: 'queued', label: '排队中' },
  { id: 'done', label: '已完成' }
]

/**
 * Does a job with `status` belong to `filter`?
 * - queued: waiting to run
 * - active: in the pipeline OR paused (started, not finished)
 * - done: completed successfully
 * - error / canceled are only visible under `all` (they are terminal-but-not-done).
 */
export function matchesFilter(status: JobStatus, filter: JobFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'queued') return status === 'queued'
  if (filter === 'done') return status === 'done'
  return (
    status === 'extracting' ||
    status === 'translating' ||
    status === 'typesetting' ||
    status === 'exporting' ||
    status === 'paused'
  )
}
