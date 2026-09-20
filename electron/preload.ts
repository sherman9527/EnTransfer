import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  CpuInfo,
  EnTransferApi,
  GpuInfo,
  ModelInfo,
  TranslationJob
} from '../shared/types'

// Subscribe helper: returns an unsubscribe function.
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: EnTransferApi = {
  job: {
    list: () => ipcRenderer.invoke('job:list') as Promise<TranslationJob[]>,
    add: (inputPath: string) =>
      ipcRenderer.invoke('job:add', inputPath) as Promise<TranslationJob>,
    pause: (id: string) => ipcRenderer.invoke('job:pause', id),
    resume: (id: string) => ipcRenderer.invoke('job:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('job:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('job:delete', id),
    openFolder: (id: string) => ipcRenderer.invoke('job:open-folder', id)
  },
  model: {
    list: () => ipcRenderer.invoke('model:list') as Promise<ModelInfo[]>,
    download: (id: string) => ipcRenderer.invoke('model:download', id),
    cancelDownload: (id: string) =>
      ipcRenderer.invoke('model:cancel-download', id),
    remove: (id: string) => ipcRenderer.invoke('model:delete', id),
    setDefault: (id: string) => ipcRenderer.invoke('model:set-default', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    set: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke('settings:set', patch) as Promise<AppSettings>
  },
  app: {
    openFolder: (dir?: string) => ipcRenderer.invoke('app:open-folder', dir),
    openModelsDir: () => ipcRenderer.invoke('app:open-models-dir') as Promise<void>,
    getModelsDir: () => ipcRenderer.invoke('app:get-models-dir') as Promise<string>,
    openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdf') as Promise<string | null>,
    detectScanned: (path: string) => ipcRenderer.invoke('app:detect-scanned', path) as Promise<boolean>,
    openDirDialog: (current?: string) =>
      ipcRenderer.invoke('dialog:open-dir', current) as Promise<string | null>,
    getGpuInfo: () => ipcRenderer.invoke('gpu:info') as Promise<GpuInfo>,
    getCpuInfo: () => ipcRenderer.invoke('cpu:info') as Promise<CpuInfo>
  },
  onJobUpdate: (cb: (job: TranslationJob) => void) =>
    subscribe<TranslationJob>('job:updated', cb),
  onModelUpdate: (cb: (model: ModelInfo) => void) =>
    subscribe<ModelInfo>('model:updated', cb),
  onLog: (cb: (line: string) => void) => subscribe<string>('app:log', cb)
}

contextBridge.exposeInMainWorld('api', api)
