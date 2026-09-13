import { useEffect, useState } from 'react'
import { NavRail, type ScreenId } from './components/NavRail'
import { TaskQueueScreen } from './screens/TaskQueueScreen'
import { ModelsScreen } from './screens/ModelsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useSettingsStore } from './store/settingsStore'
import { useModelStore } from './store/modelStore'

export function App() {
  const [screen, setScreen] = useState<ScreenId>('queue')

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
    </div>
  )
}
