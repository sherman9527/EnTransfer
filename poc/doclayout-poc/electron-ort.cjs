// poc/doclayout-poc/electron-ort.cjs — C1 integration de-risk: prove ORT-web
// loads PP-DocLayout-S INSIDE our Electron renderer and reproduces the Python
// POC's boxes on a known vector-figure page (p57). If boxes match, the
// renderer-based layout pass is viable and we wire it into captureFlow.
//
// KEY: ort-wasm-simd-threaded.wasm needs SharedArrayBuffer => the renderer must
// be crossOriginIsolated => serve assets over a custom privileged scheme with
// COOP/COEP headers (file:// cannot carry response headers).
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..', '..')
const PDF = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const POC = __dirname

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

let resolveResult
const got = new Promise((r) => { resolveResult = r })

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, '')
    const filePath = path.join(POC, rel)
    const res = await net.fetch(pathToFileURL(filePath).toString())
    return new Response(res.body, {
      headers: {
        'Content-Type': contentType(filePath),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    })
  })

  const win = new BrowserWindow({
    show: false, width: 1200, height: 1600,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  })
  ipcMain.on('ort-result', (_e, payload) => resolveResult(payload))
  ipcMain.on('ort-log', (_e, msg) => console.log('[renderer]', msg))
  ipcMain.once('renderer-ready', () => {
    win.webContents.send('go', {
      pdfPath: PDF, pocDir: POC,
      pdfjsWorker: path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.js'),
      pages: [57, 90, 208]
    })
  })
  win.webContents.on('console-message', (_e, _lvl, message) => console.log('[console]', message))
  win.webContents.on('render-process-gone', (_e, d) => { console.log('[gone]', JSON.stringify(d)); resolveResult({ ok: false, error: 'render-process-gone' }) })
  await win.loadURL('app://local/detect.html')
  setTimeout(() => resolveResult({ ok: false, error: 'TIMEOUT 90s' }), 90000)
  const res = await got
  console.log(JSON.stringify(res, null, 2))
  app.quit()
})

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html'
  if (p.endsWith('.wasm')) return 'application/wasm'
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript'
  if (p.endsWith('.onnx')) return 'application/octet-stream'
  return 'application/octet-stream'
}
