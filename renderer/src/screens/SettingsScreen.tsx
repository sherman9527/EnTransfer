import { useEffect, useState } from 'react'
import { FolderOpen, FolderSearch, Cpu, Gpu } from 'lucide-react'
import { appApi } from '../ipc/client'
import { useSettingsStore } from '../store/settingsStore'
import { useModelStore } from '../store/modelStore'
import type { CpuInfo, GpuInfo } from '../../../shared/types'

const MIRRORS = [
  { id: 'modelscope', label: 'ModelScope（国内推荐）', url: 'https://modelscope.cn' },
  { id: 'hf-mirror', label: 'HuggingFace 镜像', url: 'https://hf-mirror.com' }
] as const

type DevicePref = 'auto' | 'cpu' | 'gpu'

const DEVICE_OPTIONS: { id: DevicePref; label: string }[] = [
  { id: 'auto', label: '自动（推荐）' },
  { id: 'cpu', label: '仅 CPU' },
  { id: 'gpu', label: '仅 GPU（Vulkan）' }
]

export function SettingsScreen() {
  const { settings, fetchSettings, updateSettings } = useSettingsStore()
  const { models, fetchModels } = useModelStore()
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null)
  const [cpuInfo, setCpuInfo] = useState<CpuInfo | null>(null)

  useEffect(() => {
    void fetchSettings()
    void fetchModels()
    void appApi.getGpuInfo().then(setGpuInfo).catch(() => setGpuInfo(null))
    void appApi.getCpuInfo().then(setCpuInfo).catch(() => setCpuInfo(null))
  }, [fetchSettings, fetchModels])

  const availableModels = models.filter((m) => m.status === 'available')
  // Show the ACTUAL default model (matches the 默认引擎 badge on the Models
  // screen), not just the first available one (bug #10).
  const currentModel = models.find((m) => m.id === settings.defaultModel) ?? availableModels[0]
  const mirrorId =
    MIRRORS.find((m) => m.url === settings.mirrorSource)?.id ?? 'modelscope'

  const device: DevicePref = settings.device ?? 'auto'
  const threadsMode = settings.threadsMode ?? 'auto'
  const logicalCores = cpuInfo?.logicalCores ?? 16
  const manualThreads = settings.manualThreads ?? cpuInfo?.recommendedThreads ?? 12

  async function chooseOutputDir() {
    const dir = await appApi.openDirDialog(settings.outputDir)
    if (dir) await updateSettings({ outputDir: dir })
  }

  const gpuActive = gpuInfo?.type === 'vulkan'

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <header>
        <h1 className="text-xl font-semibold text-ink">设置</h1>
        <p className="text-xs text-ink3">翻译引擎、输出位置与下载偏好。</p>
      </header>

      {/* Default model — single converged model, no selection needed */}
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">默认翻译模型</h2>
        {availableModels.length === 0 ? (
          <p className="text-xs text-warn">
            尚未下载模型。请先到「模型管理」下载翻译模型。
          </p>
        ) : (
          <p className="text-sm text-ink2">
            当前使用 <span className="font-medium text-ink">{currentModel.name}</span>（{currentModel.size}）。
          </p>
        )}
      </section>

      {/* ---- Inference performance: device + threads + hardware ---- */}
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">推理性能</h2>

        {/* Device selection */}
        <label className="mb-1 block text-xs text-ink2">推理设备</label>
        <select
          value={device}
          onChange={(e) => updateSettings({ device: e.target.value as DevicePref })}
          className="mb-4 w-full max-w-md rounded-btn border border-line bg-base px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          {DEVICE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        {/* GPU status */}
        <div className="mb-4 flex items-start gap-2 rounded-btn border border-line bg-panel px-3 py-2">
          <Gpu size={16} className="mt-0.5 shrink-0 text-ink3" />
          <span className="text-xs text-ink2">
            {gpuActive ? (
              <>
                <span className="text-emerald-500">✅ GPU 加速（Vulkan）</span>
                {' — '}
                {gpuInfo?.name ?? 'Unknown GPU'}
                {gpuInfo?.vramMB ? `（${gpuInfo.vramMB} MB VRAM）` : ''}
              </>
            ) : (
              <span className="text-amber-500">
                ⚠️ 未检测到 Vulkan GPU，将使用 CPU 推理
              </span>
            )}
          </span>
        </div>

        {/* Thread mode */}
        <div className="mb-2 flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-ink2">
            <input
              type="radio"
              name="threadsMode"
              checked={threadsMode === 'auto'}
              onChange={() => updateSettings({ threadsMode: 'auto' })}
              className="accent-accent"
            />
            自动
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink2">
            <input
              type="radio"
              name="threadsMode"
              checked={threadsMode === 'manual'}
              onChange={() => updateSettings({ threadsMode: 'manual' })}
              className="accent-accent"
            />
            手动
          </label>
        </div>

        {threadsMode === 'manual' && (
          <div className="mb-4 flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={logicalCores}
              value={manualThreads}
              onChange={(e) => updateSettings({ manualThreads: Number(e.target.value) })}
              className="w-64 accent-accent"
            />
            <span className="w-20 text-sm text-ink2">{manualThreads} 线程</span>
          </div>
        )}

        {/* CPU status */}
        <div className="flex items-start gap-2 rounded-btn border border-line bg-panel px-3 py-2">
          <Cpu size={16} className="mt-0.5 shrink-0 text-ink3" />
          <span className="text-xs text-ink2">
            {cpuInfo ? (
              <>
                {cpuInfo.description}
                {threadsMode === 'auto' && cpuInfo.recommendedThreads != null && (
                  <>
                    ，自动选择 <span className="text-accent">{cpuInfo.recommendedThreads}</span> 线程
                  </>
                )}
              </>
            ) : (
              '正在检测 CPU…'
            )}
          </span>
        </div>

        <p className="mt-3 text-xs text-ink3">
          GPU 加速可将翻译速度提升数倍；线程数建议保持「自动」——对混合架构 CPU
          会自动避开效率核，过多线程反而争抢内存带宽。
        </p>
      </section>

      {/* Output directory */}
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">输出目录</h2>
        <div className="flex items-center gap-2">
          <input
            value={settings.outputDir}
            readOnly
            placeholder="尚未设置"
            className="w-full max-w-md rounded-btn border border-line bg-base px-3 py-2 text-sm text-ink2 outline-none"
          />
          <button
            onClick={() => void chooseOutputDir()}
            className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-2 text-xs text-ink2 hover:bg-panel"
          >
            <FolderSearch size={14} /> 更改
          </button>
          {settings.outputDir && (
            <button
              onClick={() => void appApi.openFolder(settings.outputDir)}
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-2 text-xs text-ink2 hover:bg-panel"
            >
              <FolderOpen size={14} /> 打开
            </button>
          )}
        </div>
      </section>

      {/* Mirror source */}
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">模型镜像源</h2>
        <div className="flex flex-col gap-2">
          {MIRRORS.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 text-sm text-ink2"
            >
              <input
                type="radio"
                name="mirror"
                checked={mirrorId === m.id}
                onChange={() => updateSettings({ mirrorSource: m.url })}
                className="accent-accent"
              />
              {m.label}
              <span className="text-xs text-ink3">{m.url}</span>
            </label>
          ))}
        </div>
      </section>

      {/* About */}
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="mb-2 text-sm font-semibold text-ink">关于</h2>
        <p className="text-xs text-ink2">译事郎 v0.1.0</p>
        <p className="mt-1 text-xs text-ink3">
          本地 PDF 翻译与排版工具，所有处理均在本机完成，不上传任何文件。
        </p>
      </section>
    </div>
  )
}
