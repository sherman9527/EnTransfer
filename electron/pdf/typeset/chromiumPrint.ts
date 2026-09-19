/**
 * electron/pdf/typeset/chromiumPrint.ts — HTML → PDF via Electron's OWN
 * bundled Chromium (webContents.printToPDF). No system browser, no external
 * runtime, no version drift: the renderer is pinned by our build.
 *
 * Throws when Electron is unavailable (plain-node harness/tests) or when the
 * print fails — callers fall back to the pdf-lib composer.
 */
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRINT_TIMEOUT_MS = 90_000

export async function printHtmlToPdf(html: string, outPath: string, workTmpDir?: string): Promise<void> {
  const electronVer = (process.versions as Record<string, string | undefined>).electron
  if (!electronVer) throw new Error('chromiumPrint: not running inside Electron')
  const { BrowserWindow } = require('electron') as typeof import('electron')

  // Intermediate HTML belongs to the portable data root (workTmpDir); the
  // system temp is only a last-resort default for harness use.
  const dir = workTmpDir ?? tmpdir()
  await fsp.mkdir(dir, { recursive: true })
  const file = join(dir, `entransfer-compose-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  await fsp.writeFile(file, html, 'utf8')
  let win: import('electron').BrowserWindow | null = null
  try {
    win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, backgroundThrottling: false } })
    await win.loadFile(file)
    // images are data: URIs — they decode during load; a short grace period
    // lets Chromium settle layout/fonts before pagination.
    await new Promise((r) => setTimeout(r, 500))
    const data = await withTimeout(
      win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#8a8a8a;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      }),
      PRINT_TIMEOUT_MS,
      'printToPDF timeout'
    )
    if (!data || data.length < 1024) throw new Error(`printToPDF produced ${data?.length ?? 0} bytes`)
    // verify PDF magic + trailer before publishing
    const head = data.subarray(0, 5).toString('latin1')
    const tail = data.subarray(-1024).toString('latin1')
    if (head !== '%PDF-' || !tail.includes('%%EOF')) throw new Error('printToPDF produced invalid PDF')
    await fsp.mkdir(join(outPath, '..'), { recursive: true })
    await fsp.writeFile(outPath, data)
  } finally {
    win?.destroy()
    await fsp.rm(file, { force: true }).catch(() => undefined)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
