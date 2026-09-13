import type { EnTransferApi } from '../../../shared/types'

/**
 * Thin wrapper around the preload-exposed `window.api`.
 *
 * The renderer should always go through this module instead of touching
 * `window.api` directly, so the IPC surface stays in one place. Each sub-API is
 * exported under the names the stores use (`jobApi`, `modelApi`, ...).
 */
export const api: EnTransferApi = window.api

export const jobApi = api.job
export const modelApi = api.model
export const settingsApi = api.settings
export const appApi = api.app

/** Subscribe helpers (return an unsubscribe function). */
export const events = {
  onJobUpdate: api.onJobUpdate,
  onModelUpdate: api.onModelUpdate,
  onLog: api.onLog
}
