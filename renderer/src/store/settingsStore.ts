import { create } from 'zustand'
import { settingsApi } from '../ipc/client'
import type { AppSettings } from '../../../shared/types'

interface SettingsState {
  settings: AppSettings
  loading: boolean
  fetchSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

const DEFAULTS: AppSettings = {
  defaultModel: '',
  outputDir: '',
  mirrorSource: 'https://modelscope.cn',
  cpuThreads: 8,
  device: 'auto',
  threadsMode: 'auto',
  manualThreads: 12
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULTS,
  loading: false,

  fetchSettings: async () => {
    set({ loading: true })
    try {
      const settings = await settingsApi.get()
      set({ settings: { ...DEFAULTS, ...settings } })
    } catch (err) {
      console.error('[settings] fetchSettings failed', err)
    } finally {
      set({ loading: false })
    }
  },

  updateSettings: async (patch) => {
    try {
      const next = await settingsApi.set(patch)
      set({ settings: { ...DEFAULTS, ...next } })
    } catch (err) {
      console.error('[settings] updateSettings failed', err)
      // Optimistic local fallback so the UI stays responsive offline.
      set((s) => ({ settings: { ...s.settings, ...patch } }))
    }
  }
}))
