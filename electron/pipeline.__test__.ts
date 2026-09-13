/**
 * electron/pipeline.__test__.ts — integration test for the orchestrator.
 *
 * Exercises createPipeline() end to end against the bundled sample PDF:
 *   1. Full run   : extracting → translating → typesetting → exporting, output
 *                    PDF generated, checkpoint translation.jsonl written.
 *   2. Abort      : an AbortSignal aborts translation mid-run and run() resolves
 *                    (no throw); the partial translations are durable.
 *   3. Resume     : re-running the SAME job dir loads translation.jsonl and SKIPS
 *                    the already-translated units (the model is not re-called for
 *                    them).
 *
 * The translation model is replaced by a fake engine that returns a fixed Chinese
 * string, so the 1 GB llama model is never loaded.
 *
 * Run (from the project root):
 *   npx esbuild electron/pipeline.__test__.ts --bundle --platform=node --format=cjs \
 *     --external:pdfjs-dist --external:pdf-lib --external:@pdf-lib/fontkit \
 *     --outfile=.scratch/pipeline-test.cjs
 *   node .scratch/pipeline-test.cjs
 */

import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { captureFlow, type ContentBlock } from './pdf/capture/flow'
import { CheckpointStore } from './queue/checkpoint.ts'
import { createPipeline } from './pipeline.ts'
import type { TranslationJob } from '../shared/types'
import type { ModelManager } from './models/manager'

const PDF_PATH = path.resolve(
  process.cwd(),
  'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf'
)
const SCRATCH = path.resolve(process.cwd(), '.scratch')
const PAGE_LIMIT = 4

// ---------------------------------------------------------------------------
// Fake engine + fake model manager
// ---------------------------------------------------------------------------

interface FakeEngineOptions {
  /** per-call delay (ms) so an abort has a window to land. */
  delayMs?: number
}

function makeFakeEngine(opts: FakeEngineOptions = {}) {
  let calls = 0
  const delay = opts.delayMs ?? 0
  const engine = {
    get calls() {
      return calls
    },
    async translate(text: string, o?: { signal?: AbortSignal }) {
      calls++
      if (delay > 0) {
        for (let i = 0; i < delay / 5; i++) {
          if (o?.signal?.aborted) throw new Error('aborted')
          await new Promise((r) => setTimeout(r, 5))
        }
      }
      if (o?.signal?.aborted) throw new Error('aborted')
      // Echo the source with a wrapper long enough to pass the pipeline's
      // length-sanity heuristic (no spurious retry) — deterministic call count.
      return {
        text: `【译文】${text}（已翻译）`,
        tokens: 1,
        timeMs: 1
      }
    }
  }
  return engine
}

function makeFakeModelManager(engine: {
  translate(text: string, o?: { signal?: AbortSignal }): Promise<{ text: string }>
}): ModelManager {
  return { getEngine: async () => engine } as unknown as ModelManager
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count translatable segments the same way pipeline.buildTasks() does. */
function countTranslatable(blocks: ContentBlock[]): number {
  let n = 0
  for (const b of blocks) {
    if (b.type === 'code' || b.type === 'image') continue
    if (b.type === 'list') {
      for (const item of b.items ?? []) if (item.trim().length > 0) n++
    } else if (b.type === 'table') {
      for (const row of b.cells ?? []) for (const cell of row) if (cell && cell.trim().length > 0) n++
    } else if ((b.text ?? '').trim().length > 0) {
      n++
    }
  }
  return n
}

let jobSeq = 0
function makeJob(id: string, outputPath: string): TranslationJob {
  jobSeq++
  return {
    id,
    inputPath: PDF_PATH,
    outputPath,
    status: 'extracting', // mirror what JobManager sets before calling run()
    progress: 0,
    totalPages: 0,
    currentPage: 0,
    model: 'fake-model',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== EnTransfer pipeline integration test ===')
  await fsp.mkdir(SCRATCH, { recursive: true })

  // How many real translation units exist on the sampled pages? Mirrors the
  // pipeline's buildTasks() counting (list items + table cells + paragraphs,
  // skipping code/image blocks).
  const { blocks } = await captureFlow(PDF_PATH, { pageLimit: PAGE_LIMIT })
  const expectedTotal = countTranslatable(blocks)
  console.log(`Sampled PDF: ${expectedTotal} translation units across ${PAGE_LIMIT} pages\n`)

  // =============================================================== Test 1
  console.log('--- Test 1: full run (extract → translate → typeset → export) ---')
  const jobsDir1 = path.join(SCRATCH, 'pipeline-jobs-1')
  await fsp.rm(jobsDir1, { recursive: true, force: true })
  const out1 = path.join(SCRATCH, 'pipeline-out-1.pdf')
  await fsp.rm(out1, { force: true })

  const engine1 = makeFakeEngine()
  const job1 = makeJob('job-full-1', out1)
  const phases: string[] = []
  const events: { page: number; progress: number; status: string }[] = []

  const pipeline1 = createPipeline(makeFakeModelManager(engine1), jobsDir1, { pageLimit: PAGE_LIMIT })
  await pipeline1.run(
    job1,
    (page, progress) => {
      events.push({ page, progress, status: job1.status })
      phases.push(job1.status)
    },
    new AbortController().signal // never aborted
  )

  check(job1.totalPages === PAGE_LIMIT, `totalPages set to ${PAGE_LIMIT} (got ${job1.totalPages})`)
  check(events.length > 0, `progress events emitted (${events.length})`)
  check(events[events.length - 1].progress === 100, `final progress === 100 (got ${events[events.length - 1].progress})`)
  check(job1.status === 'exporting', `pipeline leaves status='exporting' (got '${job1.status}')`)
  check(engine1.calls === expectedTotal, `engine called once per unit (calls=${engine1.calls}, expected ${expectedTotal})`)
  check(existsSync(out1), 'output PDF file exists')
  if (existsSync(out1)) {
    const sz = (await fsp.stat(out1)).size
    check(sz > 0, `output PDF non-empty (${(sz / 1024).toFixed(1)} KB)`)
  }

  const store1 = new CheckpointStore(jobsDir1)
  const savedTranslations = await store1.loadTranslations('job-full-1')
  check(savedTranslations.size === expectedTotal, `checkpoint holds all ${expectedTotal} translations (got ${savedTranslations.size})`)
  const cpSnapshot = await store1.load('job-full-1')
  check(cpSnapshot !== null && cpSnapshot.progress === 98, 'checkpoint.json persisted exporting snapshot')

  const seen = new Set(phases)
  check(seen.has('translating'), 'phase translating observed')
  check(seen.has('typesetting'), 'phase typesetting observed')
  console.log('')

  // =============================================================== Test 2
  console.log('--- Test 2: abort signal halts translation (partial checkpoint) ---')
  const jobsDir2 = path.join(SCRATCH, 'pipeline-jobs-2')
  await fsp.rm(jobsDir2, { recursive: true, force: true })
  const out2 = path.join(SCRATCH, 'pipeline-out-2.pdf')
  await fsp.rm(out2, { force: true })

  const slowEngine = makeFakeEngine({ delayMs: 40 })
  const job2 = makeJob('job-abort-2', out2)
  const ac = new AbortController()
  const pipeline2 = createPipeline(makeFakeModelManager(slowEngine), jobsDir2, { pageLimit: PAGE_LIMIT })

  const runPromise = pipeline2.run(
    job2,
    () => {},
    ac.signal
  )
  // Let it translate a handful of units, then abort.
  await new Promise((r) => setTimeout(r, 140))
  ac.abort()
  await runPromise // must RESOLVE, not throw (manager settles abort)

  const partialSaved = await new CheckpointStore(jobsDir2).loadTranslations('job-abort-2')
  check(slowEngine.calls > 0 && slowEngine.calls < expectedTotal, `abort stopped mid-way (engine ran ${slowEngine.calls}/${expectedTotal})`)
  check(partialSaved.size >= 1 && partialSaved.size < expectedTotal, `partial checkpoint durable (${partialSaved.size} records)`)
  check(!existsSync(out2), 'no output PDF written after abort-before-typeset')
  const durableBeforeResume = partialSaved.size
  console.log('')

  // =============================================================== Test 3
  console.log('--- Test 3: resume skips already-translated units ---')
  // Reuse the SAME job dir as Test 2; units already on disk must be skipped.
  const resumeEngine = makeFakeEngine() // fresh counter
  const job3 = makeJob('job-abort-2', out2) // same id → shares translation.jsonl
  job3.status = 'extracting'
  const pipeline3 = createPipeline(makeFakeModelManager(resumeEngine), jobsDir2, { pageLimit: PAGE_LIMIT })
  await pipeline3.run(
    job3,
    () => {},
    new AbortController().signal
  )
  // The resume engine only translates the NOT-yet-durable units.
  check(
    resumeEngine.calls === expectedTotal - durableBeforeResume,
    `resume skipped ${durableBeforeResume} done units, translated ${resumeEngine.calls} fresh (expected ${expectedTotal - durableBeforeResume})`
  )
  check(existsSync(out2), 'resume completed → output PDF now written')
  if (existsSync(out2)) {
    check((await fsp.stat(out2)).size > 0, 'resume output PDF non-empty')
  }
  const fullSaved = await new CheckpointStore(jobsDir2).loadTranslations('job-abort-2')
  check(fullSaved.size === expectedTotal, `checkpoint reaches ${expectedTotal} after resume (got ${fullSaved.size})`)
  console.log('')

  // =============================================================== Summary
  if (failures > 0) {
    console.error(`=== FAILED: ${failures} check(s) failed ===`)
    process.exit(1)
  }
  console.log('=== ALL CHECKS PASSED ===')
}

main().catch((err) => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
