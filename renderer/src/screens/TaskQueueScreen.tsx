import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  FileText,
  FolderOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
  XCircle
} from 'lucide-react'
import { appApi } from '../ipc/client'
import { STATUS_META, useQueueStore } from '../store/queueStore'
import { useModelStore } from '../store/modelStore'
import { useUiStore } from '../store/uiStore'
import type { JobStatus, TranslationJob } from '../../../shared/types'

const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set([
  'extracting',
  'translating',
  'typesetting',
  'exporting'
])

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function fmtEta(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分钟`
  return `${(sec / 3600).toFixed(1)} 小时`
}

export function TaskQueueScreen() {
  const {
    jobs,
    loading,
    busyIds,
    working,
    fetchJobs,
    addJob,
    pauseJob,
    resumeJob,
    cancelJob,
    retryJob,
    removeJob,
    openJobFolder,
    startAll,
    notices,
    dismissNotices
  } = useQueueStore()

  const [dragOver, setDragOver] = useState(false)
  const [dropHint, setDropHint] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchJobs()
  }, [fetchJobs])

  // Translation can't run without a downloaded, ready model. If none is
  // available, bounce the user to the models page (with an explanation) instead
  // of letting them pick a PDF that would only fail in the queue.
  function ensureModelReady(): boolean {
    const ready = useModelStore.getState().models.some((m) => m.status === 'available')
    if (ready) return true
    const { setScreen, showToast } = useUiStore.getState()
    showToast('还没有下载好可用的翻译模型，已跳转到模型页，请先下载并设为默认')
    setScreen('models')
    return false
  }

  async function handleAddPdf() {
    if (!ensureModelReady()) return
    const path = await appApi.openPdfDialog()
    if (path) void addJob(path)
  }

  // Native file drop (Electron exposes the absolute path on File.path).
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    const p = file?.path
    if (p && /\.pdf$/i.test(p)) {
      if (ensureModelReady()) void addJob(p)
    } else if (p) {
      setDropHint(`仅支持 PDF 文件，已忽略「${basename(p)}」`)
      window.setTimeout(() => setDropHint(''), 4000)
    }
  }

  const pausedCount = jobs.filter((j) => j.status === 'paused').length

  return (
    <div
      className="flex h-full flex-col gap-4"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">任务队列</h1>
          <p className="text-xs text-ink3">{jobs.length} 个任务</p>
        </div>
        <div className="flex items-center gap-2">
          {pausedCount > 0 && (
            <button
              onClick={() => void startAll()}
              disabled={working}
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-2 text-sm text-ink2 transition-colors hover:bg-panel disabled:opacity-50"
            >
              <Play size={15} /> 全部开始（{pausedCount}）
            </button>
          )}
          <button
            onClick={() => void handleAddPdf()}
            disabled={working}
            className="flex items-center gap-1.5 rounded-btn bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={16} /> 添加 PDF
          </button>
        </div>
      </header>

      {notices.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-card border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span className="min-w-0">{notices[notices.length - 1]}</span>
          <button onClick={dismissNotices} className="shrink-0 rounded-btn px-2 py-0.5 hover:bg-warn/20">
            知道了
          </button>
        </div>
      )}
      {dropHint && (
        <div className="rounded-card border border-line bg-panel px-3 py-2 text-xs text-ink2">{dropHint}</div>
      )}

      {loading && jobs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ink3">加载中…</div>
      ) : jobs.length === 0 ? (
        <button
          onClick={() => void handleAddPdf()}
          className={`flex flex-1 flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed transition-colors ${
            dragOver ? 'border-accent bg-accent/10' : 'border-line bg-card'
          }`}
        >
          <UploadCloud size={40} className="text-ink3" />
          <p className="text-sm text-ink2">拖拽 PDF 到此处，或点击选择文件开始翻译</p>
          <p className="text-xs text-ink3">支持任意文字型 PDF，中文译文自动排版输出</p>
        </button>
      ) : (
        <div
          ref={listRef}
          className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1"
        >
          {dragOver && (
            <div className="pointer-events-none rounded-card border border-accent bg-accent/10 px-4 py-2 text-center text-xs text-accent">
              松开以添加 PDF
            </div>
          )}
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              busy={!!busyIds[job.id]}
              onPause={() => void pauseJob(job.id)}
              onResume={() => void resumeJob(job.id)}
              onCancel={() => void cancelJob(job.id)}
              onRetry={() => void retryJob(job.id)}
              onRemove={() => {
                if (window.confirm(`确定删除「${basename(job.inputPath)}」？已完成的部分译文也会一并删除。`)) {
                  void removeJob(job.id)
                }
              }}
              onOpen={() => void openJobFolder(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Job card
// ---------------------------------------------------------------------------

interface JobCardProps {
  job: TranslationJob
  busy: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRetry: () => void
  onRemove: () => void
  onOpen: () => void
}

function JobCard({
  job,
  busy,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
  onOpen
}: JobCardProps) {
  const meta = STATUS_META[job.status]
  const active = ACTIVE_STATUSES.has(job.status)
  const showPause = active
  const showResume = job.status === 'paused'
  const showCancel = job.status !== 'done' && job.status !== 'canceled'
  const showRetry = job.status === 'error'
  const showOpen = job.status === 'done'
  // A running (active-phase) job must not be deleted per the state machine.
  const deletable = !active

  const pct = Math.max(0, Math.min(100, Math.round(job.progress)))

  return (
    <div className="rounded-card border border-line bg-card p-4 shadow-rest">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <FileText size={18} className="mt-0.5 shrink-0 text-ink3" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">
                {basename(job.inputPath)}
              </span>
              <StatusPill status={job.status} />
            </div>
            <p className="mt-1 text-xs text-ink3">
              {job.totalPages > 0
                ? `第 ${job.currentPage} / ${job.totalPages} 页 · ${pct}%`
                : `${pct}%`}
              {active && job.etaSec != null && job.etaSec > 0 && ` · 预计剩余 ${fmtEta(job.etaSec)}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {showPause && (
            <IconBtn title="暂停" disabled={busy} onClick={onPause}>
              <Pause size={16} />
            </IconBtn>
          )}
          {showResume && (
            <IconBtn title="继续" disabled={busy} onClick={onResume}>
              <Play size={16} />
            </IconBtn>
          )}
          {showRetry && (
            <IconBtn title="重试" disabled={busy} onClick={onRetry}>
              <RefreshCw size={16} />
            </IconBtn>
          )}
          {showCancel && (
            <IconBtn title="取消" disabled={busy} onClick={onCancel}>
              <XCircle size={16} />
            </IconBtn>
          )}
          {showOpen && (
            <IconBtn title="打开输出目录" disabled={busy} onClick={onOpen}>
              <FolderOpen size={16} />
            </IconBtn>
          )}
          {deletable && (
            <IconBtn title="删除" danger disabled={busy} onClick={onRemove}>
              <Trash2 size={16} />
            </IconBtn>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-pill bg-panel">
        <div
          className={`h-full rounded-pill ${meta.bar} transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {job.error && (
        <p className="mt-2 break-words text-xs text-danger">错误：{job.error}</p>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={`rounded-pill px-2 py-0.5 text-[10px] font-medium ${meta.text} bg-panel/60`}
    >
      {meta.label}
    </span>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  title: string
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-btn p-1.5 transition-colors disabled:opacity-40 ${
        danger
          ? 'text-ink3 hover:bg-danger/20 hover:text-danger'
          : 'text-ink3 hover:bg-panel hover:text-ink2'
      }`}
    >
      {children}
    </button>
  )
}
