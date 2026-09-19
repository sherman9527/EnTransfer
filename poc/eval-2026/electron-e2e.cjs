// electron-e2e.cjs — run the REAL pipeline inside Electron (main process), so
// the Chromium typesetting path (webContents.printToPDF) and fallback badges
// are exercised in the exact production environment. Translations come from
// the warm content-addressed cache, so this finishes in seconds.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

process.env.EN_SPEC_DECODING = '0'

async function main() {
  const ROOT = path.resolve(__dirname, '..', '..')
  process.chdir(ROOT)
  const { createPipeline } = await import('./pipeline-bundle.cjs')
  const { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } = await import('./engine-bundle.cjs')

  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true, id: 'qwen3-1.7b-q4_k_m' })
  await engine.load(path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf'), { threads: 12, contextSize: 2048, device: 'gpu' })
  const jobsDir = path.join(ROOT, '.scratch', 'electron-e2e-jobs')
  fs.rmSync(jobsDir, { recursive: true, force: true })
  fs.mkdirSync(jobsDir, { recursive: true })
  const pipeline = createPipeline({ getEngine: async () => engine }, jobsDir, { pageLimit: 12 })
  const out = path.join(ROOT, '.scratch', 'electron-e2e-zh.pdf')
  const job = {
    id: 'electron-e2e', inputPath: path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf'),
    outputPath: out, status: 'queued', progress: 0, totalPages: 0, currentPage: 0,
    model: 'qwen3-1.7b-q4_k_m', createdAt: Date.now(), updatedAt: Date.now()
  }
  await pipeline.run(job, () => undefined, new AbortController().signal)
  const size = fs.statSync(out).size
  const head = fs.readFileSync(out).subarray(0, 5).toString('latin1')
  const report = path.join(ROOT, '.scratch', 'electron-e2e-result.json')
  const ok = head === '%PDF-' && size > 500_000 && job.status === 'exporting'
  fs.writeFileSync(report, JSON.stringify({ status: job.status, bytes: size, head, typeset: 'chromium' }))
  console.log(ok ? 'ELECTRON E2E PASS (chromium path)' : 'ELECTRON E2E FAIL')
  await engine.dispose()
  app.quit()
}
app.whenReady().then(main).catch((e) => { console.error('ELECTRON E2E FAIL', e); process.exit(1) })
