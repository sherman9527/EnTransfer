/**
 * electron/queue/stateMachine.ts — pure, side-effect-free translation-job state machine.
 *
 * SINGLE source of truth for legal {@link JobStatus} transitions. No fs, no Electron,
 * no timers — every status write in the JobManager routes through {@link assertTransition}
 * so an executor bug can never persist an impossible status.
 *
 * Forward pipeline (STRICTLY sequential):
 *
 *   queued → extracting → translating → typesetting → exporting → done
 *
 * From every ACTIVE phase the job may drop out to `paused | canceled | error`
 * (user pause / cancel / failure / startup orphan repair). A resumable job
 * re-enters the pipeline ONLY through `queued` (never by jumping straight back
 * into a phase). `done` is fully terminal (delete only).
 */

import type { JobStatus } from '../../shared/types'

/** The four ACTIVE pipeline phases (a live sidecar/executor is expected). */
export const ACTIVE_STATUSES = [
  'extracting',
  'translating',
  'typesetting',
  'exporting'
] as const satisfies readonly JobStatus[]

/** Terminal-but-resumable states that re-enter the pipeline via `queued`. */
export const RESUMABLE_STATUSES = ['paused', 'error', 'canceled'] as const satisfies readonly JobStatus[]

/** Fully terminal states (delete only, never a status transition). */
export const TERMINAL_STATUSES = ['done'] as const satisfies readonly JobStatus[]

/**
 * Whether `status` is one of the four active pipeline phases. At startup an active
 * status with no live executor is an ORPHAN to be repaired to `paused`; at runtime
 * it is the currently-executing job.
 */
export function isActiveStatus(status: JobStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status)
}

/** Whether `status` can re-enter the pipeline through `queued`. */
export function isResumableStatus(status: JobStatus): boolean {
  return (RESUMABLE_STATUSES as readonly string[]).includes(status)
}

/**
 * The legal transition table. Each key lists the statuses it may move to. Anything
 * not listed is rejected. A same-status "transition" (from === to) is a no-op and
 * always allowed (idempotent re-persist).
 */
const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  // Enqueued → begin the pipeline, or be canceled while still waiting.
  queued: ['extracting', 'canceled'],
  extracting: ['translating', 'paused', 'canceled', 'error'],
  translating: ['typesetting', 'paused', 'canceled', 'error'],
  typesetting: ['exporting', 'paused', 'canceled', 'error'],
  exporting: ['done', 'paused', 'canceled', 'error'],
  // Resume a paused job (→ queued) or cancel it outright.
  paused: ['queued', 'canceled'],
  // Retry re-enters the pipeline ONLY through queued, or abandon it outright.
  error: ['queued', 'canceled'],
  canceled: ['queued'],
  // Fully terminal: a done job is opened/deleted, never transitioned.
  done: []
}

/**
 * Whether moving `from → to` is a legal state-machine transition. A no-op
 * (`from === to`) is always legal.
 */
export function isLegalTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true
  return LEGAL_TRANSITIONS[from].includes(to)
}

/**
 * Assert `from → to` is legal, else throw. The JobManager routes EVERY status
 * write through here so a bug can never persist an impossible status.
 */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!isLegalTransition(from, to)) {
    throw new Error(`非法的翻译任务状态迁移：${from} → ${to}`)
  }
}

/** Can the user pause `status`? Only a live active phase cooperatively pauses. */
export function canPause(status: JobStatus): boolean {
  return isActiveStatus(status)
}

/** Can the user resume `status`? paused / error / canceled re-enter via queued. */
export function canResume(status: JobStatus): boolean {
  return isResumableStatus(status)
}

/**
 * Can the user cancel `status`? Anything that is not already canceled and not fully
 * done can be canceled (queued jobs waiting in line, active runs, paused jobs).
 */
export function canCancel(status: JobStatus): boolean {
  return status !== 'canceled' && status !== 'done'
}

/** Can the user delete `status`? A job must not be currently running. */
export function canDelete(status: JobStatus): boolean {
  return !isActiveStatus(status)
}
