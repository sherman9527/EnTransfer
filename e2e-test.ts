/**
 * E2E real translation test — uses the converged Qwen3-1.7B model (thinking off).
 * Bundled with esbuild and run under plain Node.
 */
import path from 'node:path'
import fs from 'node:fs'
import { TranslationEngine, GENERIC_SYSTEM_PROMPT } from './electron/models/engine'
import { createPipeline } from './electron/pipeline'
import type { TranslationJob } from './shared/types'

const INPUT = path.join(process.cwd(), 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const OUTPUT = path.join(process.cwd(), '.scratch', 'e2e-output-zh.pdf')
const MODEL = path.join(process.cwd(), 'models', 'Qwen3-1.7B-Q4_K_M.gguf')
const JOBS_DIR = path.join(process.cwd(), '.scratch', 'e2e-jobs')

async function main() {
  console.log('=== EnTransfer E2E Real Translation Test ===')
  console.log('Input :', INPUT)
  console.log('Output:', OUTPUT)
  console.log('Model :', MODEL)
  console.log('')

  if (!fs.existsSync(MODEL)) {
    console.error('ERROR: Model file not found at', MODEL)
    console.error('Please copy the model from poc/translation/models/')
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.mkdirSync(JOBS_DIR, { recursive: true })

  // --- Load real translation engine ---
  // Device / thread policy overridable via env so the same script runs both the
  // GPU (Vulkan) and CPU-fallback validation:
  //   $env:EN_DEVICE='gpu'  ; node .scratch/e2e-test.mjs 50
  //   $env:EN_DEVICE='cpu'  ; node .scratch/e2e-test.mjs 50
  const device = (process.env.EN_DEVICE as 'auto' | 'cpu' | 'gpu') || 'gpu'
  console.log('[1/4] Loading Qwen3-1.7B model (thinking off)...')
  console.log(`      device=${device}`)
  const t0 = Date.now()
  const engine = new TranslationEngine({
    systemPrompt: GENERIC_SYSTEM_PROMPT,
    disableReasoning: true
  })
  // Tuned on i5-12600KF (6P+4E/16 thr): threads configurable via EN_THREADS;
  // ctx=2048 allows batch translation and has identical decode speed.
  const threads = Number(process.env.EN_THREADS || 12)
  const contextSize = Number(process.env.EN_CTX || 2048)
  await engine.load(MODEL, { threads, contextSize, device })
  console.log(`      Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // --- Fake modelManager satisfying pipeline's Pick<ModelManager,'getEngine'> ---
  const fakeManager = {
    getEngine: async () => engine
  }

  // --- Create pipeline with pageLimit (default 25; override via argv for fast tests) ---
  const pageLimit = Number(process.argv[2] || 25)
  const pipeline = createPipeline(fakeManager, JOBS_DIR, { pageLimit })

  // --- Create job ---
  const job: TranslationJob = {
    id: 'e2e-test-001',
    inputPath: INPUT,
    outputPath: OUTPUT,
    status: 'queued',
    progress: 0,
    totalPages: 0,
    currentPage: 0,
    model: 'qwen3-1.7b-q4_k_m',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  const controller = new AbortController()
  let lastProgress = 0

  console.log('[2/4] Running pipeline (extract → translate → typeset → export)...')
  const t1 = Date.now()

  await pipeline.run(
    job,
    (page, progress) => {
      if (progress - lastProgress >= 5 || progress === 100) {
        console.log(`      page=${page} progress=${progress.toFixed(0)}% status=${job.status}`)
        lastProgress = progress
      }
    },
    controller.signal
  )

  const elapsed = ((Date.now() - t1) / 1000).toFixed(1)
  console.log(`      Pipeline completed in ${elapsed}s`)
  console.log(`      Final status: ${job.status}, totalPages: ${job.totalPages}`)

  // --- Verify output ---
  console.log('[3/4] Verifying output PDF...')
  const stat = fs.statSync(OUTPUT)
  console.log(`      Output size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`)
  if (stat.size > 1000000) {
    console.log('      ✅ Output PDF is non-empty (>1MB)')
  } else {
    console.log('      ⚠️  Output PDF seems small')
  }

  // --- Quick text extraction check ---
  console.log('[4/4] Quick Chinese text verification...')
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.js')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(OUTPUT)) }).promise
    let chineseChars = 0
    let totalChars = 0
    for (let i = 1; i <= Math.min(5, doc.numPages); i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      for (const item of tc.items) {
        if ('str' in item) {
          totalChars += item.str.length
          for (const ch of item.str) {
            const cp = ch.codePointAt(0)!
            if (cp >= 0x4e00 && cp <= 0x9fff) chineseChars++
          }
        }
      }
    }
    console.log(`      Pages checked: ${Math.min(5, doc.numPages)}`)
    console.log(`      Chinese chars: ${chineseChars} / total ${totalChars}`)
    if (chineseChars > 0) {
      console.log('      ✅ Chinese text found in output PDF')
    } else {
      console.log('      ⚠️  No Chinese text found (may be cover pages)')
    }
  } catch (e) {
    console.log('      Verification skipped:', (e as Error).message)
  }

  engine.dispose()
  console.log('')
  console.log('=== E2E Test Complete ===')
  console.log('Output:', OUTPUT)
}

main().catch((err) => {
  console.error('E2E TEST FAILED:', err)
  process.exit(1)
})
