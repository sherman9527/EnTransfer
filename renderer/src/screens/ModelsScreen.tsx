import { useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  FolderOpen,
  FolderDown,
  RefreshCw,
  Star,
  Trash2,
  XCircle
} from 'lucide-react'
import { useModelStore } from '../store/modelStore'
import { useSettingsStore } from '../store/settingsStore'
import { appApi } from '../ipc/client'
import type { ModelInfo, ModelStatus } from '../../../shared/types'

const RECOMMENDED_ID = 'qwen3-1.7b-q4_k_m'

const STATUS_META: Record<ModelStatus, { label: string; cls: string }> = {
  available: { label: 'Ready', cls: 'text-ok' },
  downloading: { label: '下载中', cls: 'text-warn' },
  'not-downloaded': { label: '未下载', cls: 'text-ink3' },
  error: { label: '失败', cls: 'text-danger' }
}

export function ModelsScreen() {
  const {
    models,
    busyIds,
    loading,
    fetchModels,
    downloadModel,
    cancelDownload,
    removeModel,
    setDefaultModel
  } = useModelStore()
  const defaultModel = useSettingsStore((s) => s.settings.defaultModel)
  const [modelsDir, setModelsDir] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void fetchModels()
    void appApi.getModelsDir().then(setModelsDir).catch(() => setModelsDir(''))
  }, [fetchModels])

  const copyPath = async () => {
    if (!modelsDir) return
    try {
      await navigator.clipboard.writeText(modelsDir)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be unavailable in some contexts; ignore
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink">模型管理</h1>
        <p className="text-xs text-ink3">
          翻译模型需要单独下载，下载后完全离线运行，支持 GPU（Vulkan）加速。推荐 Qwen3-1.7B。
        </p>
      </header>

      {loading && models.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ink3">加载中…</div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {/* 1. 推荐模型卡片 */}
          {models.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              busy={!!busyIds[m.id]}
              isDefault={m.id === defaultModel}
              isRecommended={m.id === RECOMMENDED_ID}
              onDownload={() => void downloadModel(m.id)}
              onCancel={() => void cancelDownload(m.id)}
              onRemove={() => void removeModel(m.id)}
              onSetDefault={() => void setDefaultModel(m.id)}
            />
          ))}

          {/* 2. 手动放置模型提示区 */}
          <ManualPlacementBox
            modelsDir={modelsDir}
            copied={copied}
            onCopy={() => void copyPath()}
            onOpenFolder={() => void appApi.openModelsDir()}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manual model placement: the same on-disk detection used by in-app download
// scans <modelsDir> for the registry filenames (Qwen3-1.7B-Q4_K_M.gguf).
// ---------------------------------------------------------------------------

function ManualPlacementBox({
  modelsDir,
  copied,
  onCopy,
  onOpenFolder
}: {
  modelsDir: string
  copied: boolean
  onCopy: () => void
  onOpenFolder: () => void
}) {
  return (
    <div className="rounded-card border border-dashed border-line bg-card p-4">
      <div className="flex items-center gap-2">
        <FolderDown size={16} className="text-accent" />
        <span className="text-sm font-semibold text-ink">手动放置模型文件</span>
      </div>
      <p className="mt-1.5 text-xs text-ink3">
        也可以手动下载 <code className="rounded bg-panel px-1 text-[11px]">.gguf</code> 文件，放到以下目录后自动识别：
      </p>

      {modelsDir && (
        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-pill bg-panel px-3 py-1.5 text-[11px] text-ink2">
            {modelsDir}
          </code>
          <button
            onClick={onCopy}
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-[11px] text-ink2 transition-colors hover:bg-panel"
            title="复制路径"
          >
            {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
            {copied ? '已复制' : '复制路径'}
          </button>
          <button
            onClick={onOpenFolder}
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-[11px] text-ink2 transition-colors hover:bg-panel"
            title="打开模型文件夹"
          >
            <FolderOpen size={13} />
            打开文件夹
          </button>
        </div>
      )}

      <p className="mt-2 text-[10px] text-ink3">
        推荐文件名需为 <code className="rounded bg-panel px-1">Qwen3-1.7B-Q4_K_M.gguf</code>，与应用内下载走同一套识别逻辑。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ModelCardProps {
  model: ModelInfo
  busy: boolean
  isDefault: boolean
  isRecommended: boolean
  onDownload: () => void
  onCancel: () => void
  onRemove: () => void
  onSetDefault: () => void
}

function ModelCard({
  model: m,
  busy,
  isDefault,
  isRecommended,
  onDownload,
  onCancel,
  onRemove,
  onSetDefault
}: ModelCardProps) {
  const meta = STATUS_META[m.status]
  const available = m.status === 'available'
  const downloading = m.status === 'downloading'
  const failed = m.status === 'error'

  const pct = Math.max(0, Math.min(100, Math.round(m.downloadProgress ?? 0)))
  const downloaded = approxDownloaded(m.size, pct)

  return (
    <div className="rounded-card border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{m.name}</span>
            {isRecommended && (
              <span className="flex items-center gap-1 rounded-pill bg-warn/15 px-2 py-0.5 text-[10px] text-warn">
                <Star size={10} /> 推荐
              </span>
            )}
            <span className="rounded-pill bg-panel px-2 py-0.5 text-[10px] text-ink2">
              {m.size} · {m.quant}
            </span>
            {isDefault && (
              <span className="rounded-pill bg-accent/20 px-2 py-0.5 text-[10px] text-accent">
                默认引擎
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink3">{m.description}</p>
          <p className="mt-1 text-[10px] text-ink3">{m.engine}</p>
        </div>
        <span className={`shrink-0 text-xs ${meta.cls}`}>{meta.label}</span>
      </div>

      {downloading && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-pill bg-panel">
            <div
              className="h-full rounded-pill bg-warn transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink3">
            <span>
              {downloaded} / {m.size}
            </span>
            <span>
              {pct}%{m.downloadSpeed ? ` · ${m.downloadSpeed}` : ''}
            </span>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        {m.status === 'not-downloaded' && (
          <ActionBtn primary onClick={onDownload} disabled={busy}>
            <Download size={14} /> 下载
          </ActionBtn>
        )}
        {failed && (
          <ActionBtn primary onClick={onDownload} disabled={busy}>
            <RefreshCw size={14} /> 重试
          </ActionBtn>
        )}
        {downloading && (
          <ActionBtn onClick={onCancel} disabled={busy}>
            <XCircle size={14} /> 取消
          </ActionBtn>
        )}
        {available && !isDefault && (
          <ActionBtn onClick={onSetDefault} disabled={busy}>
            <CheckCircle2 size={14} /> 设为默认
          </ActionBtn>
        )}
        {available && (
          <ActionBtn danger onClick={onRemove} disabled={busy}>
            <Trash2 size={14} /> 删除
          </ActionBtn>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Size helpers: the main process only reports a percentage + the human-readable
// total size label, so we approximate downloaded bytes for display.
// ---------------------------------------------------------------------------

const UNIT_FACTORS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4
}

function approxDownloaded(totalLabel: string, percent: number): string {
  const match = totalLabel.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i)
  if (!match) return `${percent}%`
  const value = parseFloat(match[1])
  const unit = (match[2] ?? 'B').toUpperCase()
  const factor = UNIT_FACTORS[unit] ?? 1
  const totalBytes = value * factor
  const got = (totalBytes * Math.max(0, Math.min(100, percent))) / 100
  return formatBytes(got)
}

function formatBytes(bytes: number): string {
  if (bytes >= UNIT_FACTORS.GB) return `${(bytes / UNIT_FACTORS.GB).toFixed(2)} GB`
  if (bytes >= UNIT_FACTORS.MB) return `${Math.round(bytes / UNIT_FACTORS.MB)} MB`
  if (bytes >= UNIT_FACTORS.KB) return `${Math.round(bytes / UNIT_FACTORS.KB)} KB`
  return `${Math.round(bytes)} B`
}

function ActionBtn({
  children,
  onClick,
  primary,
  danger,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50 ${
        primary
          ? 'bg-accent text-white hover:opacity-90'
          : danger
            ? 'border border-line text-ink3 hover:bg-danger/20 hover:text-danger'
            : 'border border-line text-ink2 hover:bg-panel'
      }`}
    >
      {children}
    </button>
  )
}
