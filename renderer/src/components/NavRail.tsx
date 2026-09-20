import { ClipboardList, Cpu, Settings2 } from 'lucide-react'

export type ScreenId = 'queue' | 'models' | 'settings'

interface NavRailProps {
  active: ScreenId
  onNavigate: (screen: ScreenId) => void
}

const items: Array<{ id: ScreenId; label: string; Icon: typeof ClipboardList }> = [
  { id: 'queue', label: '任务队列', Icon: ClipboardList },
  { id: 'models', label: '模型管理', Icon: Cpu },
  { id: 'settings', label: '设置', Icon: Settings2 }
]

export function NavRail({ active, onNavigate }: NavRailProps) {
  return (
    <nav className="flex w-16 flex-col items-center gap-2 border-r border-line bg-card py-4">
      <div className="mb-4 flex h-9 w-9 items-center justify-center overflow-hidden rounded-btn">
        <img src="./icon.png" alt="通事官" className="h-full w-full object-contain" />
      </div>
      {items.map(({ id, label, Icon }) => {
        const isActive = id === active
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`group flex w-12 flex-col items-center gap-1 rounded-btn py-2 text-[10px] transition-colors ${
              isActive
                ? 'bg-panel text-accent'
                : 'text-ink3 hover:bg-panel/60 hover:text-ink2'
            }`}
          >
            <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
            {label}
          </button>
        )
      })}
    </nav>
  )
}
