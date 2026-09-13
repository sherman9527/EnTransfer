// IPC wiring for the model subsystem. Registers every `model:*` channel the
// renderer's preload bridge (`window.api.model`) relies on and forwards
// ModelManager state changes back to the renderer.
import type { IpcMain } from 'electron'
import type { ModelManager } from './manager.ts'

export function registerModelIpc(ipcMain: IpcMain, manager: ModelManager): void {
  ipcMain.handle('model:list', () => manager.list())

  ipcMain.handle('model:download', async (_e, id: string) => {
    await manager.download(id)
  })

  ipcMain.handle('model:cancel-download', (_e, id: string) => {
    manager.cancelDownload(id)
  })

  ipcMain.handle('model:delete', (_e, id: string) => {
    manager.remove(id)
  })

  ipcMain.handle('model:set-default', (_e, id: string) => {
    manager.setDefault(id)
  })
}
