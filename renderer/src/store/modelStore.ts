import { create } from 'zustand'
import { events, modelApi } from '../ipc/client'
import { useSettingsStore } from './settingsStore'
import type { ModelInfo } from '../../../shared/types'

interface ModelState {
  models: ModelInfo[]
  loading: boolean
  /** id -> busy while an action (download / delete / set-default) is in flight. */
  busyIds: Record<string, boolean>

  fetchModels: () => Promise<void>
  downloadModel: (id: string) => Promise<void>
  cancelDownload: (id: string) => Promise<void>
  removeModel: (id: string) => Promise<void>
  setDefaultModel: (id: string) => Promise<void>
}

export const useModelStore = create<ModelState>((set) => ({
  models: [],
  loading: false,
  busyIds: {},

  fetchModels: async () => {
    set({ loading: true })
    try {
      const models = await modelApi.list()
      set({ models })
    } catch (err) {
      console.error('[models] fetchModels failed', err)
    } finally {
      set({ loading: false })
    }
  },

  downloadModel: async (id) => {
    setBusy(id, true)
    try {
      // The IPC handler awaits the whole download; it rejects on cancel/error.
      await modelApi.download(id)
    } catch (err) {
      // Cancellation is an expected user action; live status is driven by pushes.
      console.debug('[models] download settled', id, err)
    } finally {
      setBusy(id, false)
    }
  },

  cancelDownload: async (id) => {
    try {
      await modelApi.cancelDownload(id)
    } catch (err) {
      console.error('[models] cancelDownload failed', err)
    }
  },

  removeModel: async (id) => {
    setBusy(id, true)
    try {
      await modelApi.remove(id)
    } catch (err) {
      console.error('[models] removeModel failed', err)
    } finally {
      setBusy(id, false)
    }
  },

  setDefaultModel: async (id) => {
    setBusy(id, true)
    try {
      await modelApi.setDefault(id)
      // Keep the settings copy of "default model" in sync so the badge and the
      // Settings screen dropdown agree on one source of truth.
      await useSettingsStore.getState().updateSettings({ defaultModel: id })
    } catch (err) {
      console.error('[models] setDefaultModel failed', err)
    } finally {
      setBusy(id, false)
    }
  }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upsertModel(model: ModelInfo): void {
  useModelStore.setState((s) => {
    const exists = s.models.some((m) => m.id === model.id)
    const models = exists
      ? s.models.map((m) => (m.id === model.id ? model : m))
      : [...s.models, model]
    return { models }
  })
}

function setBusy(id: string, busy: boolean): void {
  useModelStore.setState((s) => {
    const busyIds = { ...s.busyIds }
    if (busy) busyIds[id] = true
    else delete busyIds[id]
    return { busyIds }
  })
}

// ---------------------------------------------------------------------------
// Subscribe to main -> renderer push events (model:updated) exactly once.
// Carries live download progress, speed and availability state.
// ---------------------------------------------------------------------------
events.onModelUpdate((model) => upsertModel(model))
