/**
 * electron/queue/ipc.ts — wire the `job:*` IPC channels onto the JobManager.
 *
 * Replaces the mock handlers in main.ts. Each channel is a thin async delegate;
 * all real logic (queueing, checkpointing, pause/cancel semantics) lives in the
 * JobManager. model:* and settings:* channels stay in main.ts untouched.
 */

import type { IpcMain } from 'electron'
import type { JobManager } from './manager.ts'

/**
 * Register every `job:*` handler. Must be called after the JobManager has been
 * `bootstrap()`ed and before the renderer asks for jobs.
 */
export function registerJobIpc(ipcMain: IpcMain, manager: JobManager): void {
  ipcMain.handle('job:list', () => manager.list())

  ipcMain.handle('job:add', (_e, inputPath: string) => manager.add(inputPath))

  ipcMain.handle('job:pause', (_e, id: string) => manager.pause(id))

  ipcMain.handle('job:resume', (_e, id: string) => manager.resume(id))

  ipcMain.handle('job:cancel', (_e, id: string) => manager.cancel(id))

  ipcMain.handle('job:delete', (_e, id: string) => manager.remove(id))

  ipcMain.handle('job:open-folder', (_e, id: string) => manager.openFolder(id))
}
