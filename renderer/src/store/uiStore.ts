import { create } from 'zustand'
import type { ScreenId } from '../components/NavRail'

// Cross-screen navigation + a transient global toast. Lives in a store so any
// screen can bounce the user (e.g. upload blocked until a model is ready) and
// explain why with a message that survives the screen change.
interface UiState {
  screen: ScreenId
  toast: string | null
  setScreen: (screen: ScreenId) => void
  showToast: (message: string) => void
  dismissToast: () => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useUiStore = create<UiState>((set) => ({
  screen: 'queue',
  toast: null,

  setScreen: (screen) => set({ screen }),

  showToast: (message) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: message })
    toastTimer = setTimeout(() => set({ toast: null }), 5000)
  },

  dismissToast: () => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: null })
  }
}))
