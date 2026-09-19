// electron-print.cjs — E2: print HTML -> PDF using Electron's bundled Chromium
// via webContents.printToPDF(). This is the "zero external runtime, zero size
// cost" alternative to our pdf-lib manual layout AND to EnTransferQt's system-Edge
// dependency (we already ship Chromium inside Electron). Measures wall time +
// output size. Runs headless offscreen.
// usage: electron electron-print.cjs <in.html> <out.pdf>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const [,, inHtml, outPdf] = process.argv
if (!inHtml || !outPdf) { console.error('usage: electron electron-print.cjs <in.html> <out.pdf>'); app.exit(2) }

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 794, height: 1123,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  const t0 = Date.now()
  await win.loadFile(path.resolve(inHtml))
  // wait for layout + local file:// images
  await new Promise((r) => setTimeout(r, 800))
  const data = await win.webContents.printToPDF({
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#8a8a8a;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    headerTemplate: '<div></div>'
  })
  fs.writeFileSync(path.resolve(outPdf), data)
  const el = Date.now() - t0
  const pdfHeader = data.slice(0, 5).toString('latin1')
  const hasEOF = data.slice(-6).toString('latin1').includes('%%EOF')
  console.log(JSON.stringify({ ms: el, bytes: data.length, header: pdfHeader, eof: hasEOF }))
  await win.destroy()
  app.quit()
}).catch((e) => { console.error('PRINT FAIL', e); app.exit(1) })
