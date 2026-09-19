import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { JobManager } from './queue/manager.ts'
import { registerJobIpc } from './queue/ipc.ts'
import { ModelManager } from './models/manager.ts'
import { registerModelIpc } from './models/ipc.ts'
import { createPipeline } from './pipeline.ts'
import { detectGpu } from './models/gpu.ts'
import { detectCpu, describeCpu, getDefaultThreads } from './models/cpu-info.ts'
import { SettingsStore, defaultSettings, settingsFileFor } from './settings.ts'

// ---------------------------------------------------------------------------
// Data root: portable mode — all data stays next to the app (requirement #20).
//   Dev:  <project>/models/  +  <project>/data/{jobs,output}/
//   Packaged:  <exe_dir>/models/  +  <exe_dir>/data/{jobs,output}/
// ---------------------------------------------------------------------------
function appRoot(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : process.cwd()
}
const modelsDir = () => join(appRoot(), 'models')
const dataRoot = () => join(appRoot(), 'data')
const jobsDir = () => join(dataRoot(), 'jobs')
const outputDir = () => join(dataRoot(), 'output')
const tmpDir = () => join(dataRoot(), 'tmp')

// Chromium/Electron session data (HTTP cache, Local Storage, GPU cache) lives
// in %APPDATA%\EnTransfer by default — it must follow the portable root so an
// uninstall leaves nothing behind. Set before app ready to cover all Chromium
// subsystems; the legacy %APPDATA% copy is removed by the NSIS uninstaller.
app.setPath('userData', join(dataRoot(), 'session'))

function ensureDataDirs(): void {
  for (const dir of [jobsDir(), modelsDir(), outputDir(), tmpDir()]) {
    mkdirSync(dir, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// Job queue manager (real persistence + checkpoint; pipeline injected later)
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null
let jobManager: JobManager | null = null
let modelManager: ModelManager | null = null
let settings: SettingsStore | null = null

// One-time hardware probes (GPU init is expensive — never re-probe per request).
let cachedGpu: Awaited<ReturnType<typeof detectGpu>> | null = null
let cachedCpu: (import('../shared/types').CpuInfo) | null = null

function createJobManager(): JobManager {
  const s = settings?.current
  return new JobManager({
    jobsDir: jobsDir(),
    outputDir: s?.outputDir || outputDir(),
    model: s?.defaultModel ?? '',
    onEvent: (job) => mainWindow?.webContents.send('job:updated', job),
    opener: (dir) => shell.openPath(dir)
  })
}

function createModelManager(): ModelManager {
  // Settings is the single source of truth for the default model id.
  const manager = new ModelManager(settings?.current.defaultModel)
  // Push live model status / download progress to the renderer.
  manager.onUpdated = (model) => mainWindow?.webContents.send('model:updated', model)
  // Engine-level notices (GPU->CPU failover etc.) ride the app:log channel.
  manager.setOnNotice((msg) => mainWindow?.webContents.send('app:log', msg))
  return manager
}

/** Push the inference-relevant slice of settings into the ModelManager. */
function applyInferenceSettings(): void {
  const s = settings?.current
  if (!s) return
  modelManager?.setInferenceSettings({
    device: s.device ?? 'auto',
    threadsMode: s.threadsMode ?? 'auto',
    manualThreads: s.manualThreads ?? s.cpuThreads
  })
  modelManager?.setMirror(s.mirrorSource)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    icon: join(app.getAppPath(), 'assets/icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // External links open in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc(): void {
  // ---- Jobs (delegated to the real JobManager; registered separately) ----
  if (jobManager) registerJobIpc(ipcMain, jobManager)

  // ---- Models (delegated to the real ModelManager) ----
  if (modelManager) registerModelIpc(ipcMain, modelManager)

  // ---- Settings (persistent; real JSON store under dataRoot) ----
  ipcMain.handle('settings:get', () => settings?.current)
  ipcMain.handle('settings:set', (_e, patch: Partial<import('../shared/types').AppSettings>) => {
    if (!settings) return undefined
    const prev = { ...settings.current }
    const next = settings.set(patch)
    applyInferenceSettings()
    // Keep the active default model in sync with settings (single source).
    if (patch.defaultModel && modelManager) {
      try {
        modelManager.setDefault(patch.defaultModel)
        jobManager?.setDefaultModel(patch.defaultModel) // stamp it on future jobs (#16)
      } catch {
        // Unknown id — leave the current default untouched.
      }
    }
    // Output dir change takes effect for future jobs immediately.
    if (patch.outputDir && patch.outputDir !== prev.outputDir && jobManager) {
      try {
        mkdirSync(patch.outputDir, { recursive: true })
        jobManager.setOutputDir(patch.outputDir)
      } catch {
        // Unwritable dir — existing jobs keep their original outputPath.
      }
    }
    return next
  })

  // ---- Hardware detection (GPU / CPU) for the settings page ----
  ipcMain.handle('gpu:info', async () => {
    // Lazy cache: probe once, reuse. detectGpu() never throws.
    if (!cachedGpu) cachedGpu = await detectGpu()
    return cachedGpu
  })
  ipcMain.handle('cpu:info', () => {
    // detectCpu() is synchronous and cheap (one WMI query at most); cache it.
    if (!cachedCpu) {
      const cpu = detectCpu()
      cachedCpu = {
        ...cpu,
        description: describeCpu(cpu),
        recommendedThreads: getDefaultThreads(cpu)
      }
    }
    return cachedCpu
  })

  // ---- App ----
  ipcMain.handle('app:open-folder', (_e, dir?: string) => {
    void shell.openPath(dir ?? settings?.current.outputDir ?? outputDir())
  })

  // ---- Models directory (manual model placement UX) ----
  ipcMain.handle('app:get-models-dir', () => modelsDir())
  ipcMain.handle('app:open-models-dir', () => {
    mkdirSync(modelsDir(), { recursive: true })
    return shell.openPath(modelsDir())
  })

  // ---- Native file / directory pickers (renderer has no Node access) ----
  ipcMain.handle('dialog:open-pdf', async () => {
    const win = mainWindow
    const opts: Electron.OpenDialogOptions = {
      title: '选择要翻译的 PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('dialog:open-dir', async (_e, current?: string) => {
    const win = mainWindow
    const opts: Electron.OpenDialogOptions = {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current ?? settings?.current.outputDir ?? outputDir()
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  ensureDataDirs()

  // Load persistent settings FIRST — managers and the job queue derive from it.
  settings = new SettingsStore(settingsFileFor(dataRoot()), defaultSettings(outputDir()))
  settings.load()

  jobManager = createJobManager()
  // Load the catalog + run startup orphan repair before any IPC answers.
  await jobManager.bootstrap()

  modelManager = createModelManager()
  // Push default device / thread policy into the engine before any job runs.
  applyInferenceSettings()

  // Wire the capture → translate → typeset pipeline into the queue BEFORE any
  // IPC answers (so job:add can actually start a run).
  jobManager.setPipeline(createPipeline(modelManager, jobsDir()))

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (modelManager) void modelManager.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
