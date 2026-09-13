// Cross-process shared types for EnTransfer.
// Imported type-only by the main process (electron/), preload and the renderer (renderer/src).

export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'translating'
  | 'typesetting'
  | 'exporting'
  | 'done'
  | 'paused'
  | 'canceled'
  | 'error'

export interface TranslationJob {
  id: string
  inputPath: string
  outputPath: string
  status: JobStatus
  /** 0 - 100 */
  progress: number
  totalPages: number
  currentPage: number
  model: string
  createdAt: number
  updatedAt: number
  error?: string
}

export type ModelStatus = 'available' | 'downloading' | 'not-downloaded' | 'error'

export interface ModelInfo {
  id: string
  name: string
  description: string
  /** human-readable size label, e.g. "1.8B" */
  size: string
  /** download URL (HF mirror) */
  url: string
  sha256?: string
  /** quantization label, e.g. "Q4_K_M" */
  quant: string
  /** inference engine, e.g. "llama.cpp" */
  engine: string
  status: ModelStatus
  downloadProgress?: number
  downloadSpeed?: string
}

export interface AppSettings {
  defaultModel: string
  outputDir: string
  mirrorSource: string
  cpuThreads: number
  /** 'auto' = use the runtime-detected smart default; 'manual' = use manualThreads. */
  threadsMode?: 'auto' | 'manual'
  /** user-chosen thread count when threadsMode === 'manual' */
  manualThreads?: number
  /**
   * Inference device preference.
   * - 'auto': detect GPU at startup, use it if available (default)
   * - 'cpu': force CPU-only inference
   * - 'gpu': force GPU (Vulkan); falls back to CPU if no GPU detected
   */
  device?: 'auto' | 'cpu' | 'gpu'
}

/** CPU hardware snapshot, shared between main (detect) and renderer (display). */
export interface CpuInfo {
  model: string
  physicalCores: number
  logicalCores: number
  isHybrid: boolean
  performanceCores: number
  architecture: 'x64' | 'arm64' | 'unknown'
  physicalSource: 'wmi' | 'estimate'
  /** Pre-formatted human summary, e.g. "Intel i5-12600KF（6P+4E，16逻辑核）". */
  description?: string
  /** Smart default thread count recommended by the CPU heuristic. */
  recommendedThreads?: number
}

/** GPU hardware snapshot, shared between main (detect) and renderer (display). */
export interface GpuInfo {
  /** 'vulkan' when GPU acceleration is active, null otherwise. */
  type: 'vulkan' | null
  /** Total VRAM in MB. */
  vramMB?: number
  /** Free VRAM in MB. */
  vramFreeMB?: number
  /** Human-readable GPU device name. */
  name?: string
}

/** IPC request channels (ipcRenderer.invoke / ipcMain.handle). */
export type IpcChannel =
  | 'job:list'
  | 'job:add'
  | 'job:pause'
  | 'job:resume'
  | 'job:cancel'
  | 'job:delete'
  | 'job:open-folder'
  | 'model:list'
  | 'model:download'
  | 'model:cancel-download'
  | 'model:delete'
  | 'model:set-default'
  | 'settings:get'
  | 'settings:set'
  | 'app:open-folder'
  | 'app:open-models-dir'
  | 'app:get-models-dir'
  | 'gpu:info'
  | 'cpu:info'
  | 'dialog:open-pdf'
  | 'dialog:open-dir'

/** Push event channels (main -> renderer) exposed via the preload listeners. */
export type IpcEvent = 'job:updated' | 'model:updated' | 'app:log'

/* ---- Renderer-facing API contract (window.api) ---- */

export interface JobApi {
  list: () => Promise<TranslationJob[]>
  add: (inputPath: string) => Promise<TranslationJob>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  openFolder: (id: string) => Promise<void>
}

export interface ModelApi {
  list: () => Promise<ModelInfo[]>
  download: (id: string) => Promise<void>
  cancelDownload: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setDefault: (id: string) => Promise<void>
}

export interface SettingsApi {
  get: () => Promise<AppSettings>
  set: (patch: Partial<AppSettings>) => Promise<AppSettings>
}

export interface AppApi {
  openFolder: (dir?: string) => Promise<void>
  /** Open the on-disk directory where .gguf model files are scanned. */
  openModelsDir: () => Promise<void>
  /** Absolute path of the models directory (dev: <project>/models; packaged: <exe_dir>/models). */
  getModelsDir: () => Promise<string>
  /** Native file picker for a single PDF. Returns the absolute path, or null if cancelled. */
  openPdfDialog: () => Promise<string | null>
  /** Native directory picker. `current` is the suggested starting path. Null if cancelled. */
  openDirDialog: (current?: string) => Promise<string | null>
  /** Probe the system for a Vulkan GPU. Never rejects; { type: null } when absent. */
  getGpuInfo: () => Promise<GpuInfo>
  /** Detect the host CPU (cores, hybrid layout). Cheap; cached across calls. */
  getCpuInfo: () => Promise<CpuInfo>
}

export interface EnTransferApi {
  job: JobApi
  model: ModelApi
  settings: SettingsApi
  app: AppApi
  onJobUpdate: (cb: (job: TranslationJob) => void) => () => void
  onModelUpdate: (cb: (model: ModelInfo) => void) => () => void
  onLog: (cb: (line: string) => void) => () => void
}
