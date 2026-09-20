import { useEffect } from 'react'
import { NavRail } from './components/NavRail'
import { TaskQueueScreen } from './screens/TaskQueueScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useSettingsStore } from './store/settingsStore'
import { useModelStore } from './store/modelStore'
import { useUiStore } from './store/uiStore'

export function App() {
  const screen = useUiStore((s) => s.screen)
  const setScreen = useUiStore((s) => s.setScreen)
  const toast = useUiStore((s) => s.toast)
  const dismissToast = useUiStore((s) => s.dismissToast)

  // Warm shared state once: the default model (settings) and the model catalog
  // are needed by several screens, and event subscriptions install themselves
  // at store import time.
  useEffect(() => {
    void useSettingsStore.getState().fetchSettings()
    void useModelStore.getState().fetchModels()
  }, [])

  return (
    <div className="flex h-full w-full bg-base">
      <NavRail active={screen} onNavigate={setScreen} />
      <main className="flex-1 overflow-hidden p-6">
        {screen === 'queue' && <TaskQueueScreen />}
        {screen === 'models' && <ModelsScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-card border border-warn/40 bg-panel px-4 py-3 text-sm text-ink shadow-rest">
          <span className="min-w-0">{toast}</span>
          <button
            onClick={dismissToast}
            className="shrink-0 rounded-btn px-2 py-0.5 text-xs text-ink3 hover:bg-card"
          >
            知道了
          </button>
        </div>
      )}
    </div>
  )
}
