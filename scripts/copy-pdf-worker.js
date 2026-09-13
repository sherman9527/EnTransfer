// scripts/copy-pdf-worker.js — copy pdfjs-dist worker to out/main/ after build.
// pdfjs-dist needs pdf.worker.js alongside the main bundle for its fake-worker
// fallback when running in Node.js/Electron.
const fs = require('node:fs')
const path = require('node:path')

const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.js')
const destDir = path.join(__dirname, '..', 'out', 'main')
const dest = path.join(destDir, 'pdf.worker.js')

if (!fs.existsSync(src)) {
  console.error('[copy-pdf-worker] source not found:', src)
  process.exit(1)
}
fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, dest)
console.log('[copy-pdf-worker] copied pdf.worker.js -> out/main/')
