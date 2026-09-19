// test-failover.ts — ④ drill: a mid-run engine failure must NOT error the job.
// Fake engine dies once ('Vulkan device lost'), the manager hands out a fresh
// engine on re-fetch, and the pipeline must recover and finish.
import path from 'node:path'
import fs from 'node:fs'
import { createPipeline } from '../../electron/pipeline'
import type { TranslationJob } from '../../shared/types'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const JOBS = path.join(ROOT, '.scratch', 'failover-jobs')
const OUT = path.join(ROOT, '.scratch', 'failover-zh.pdf')

let calls = 0
let reloads = 0

const goodEngine = {
  id: 'fake',
  async translate(text: string): Promise<{ text: string }> {
    calls++
    // keep validation plausible: CJK-heavy, roughly 25% length
    return { text: '译'.repeat(Math.max(8, Math.floor(text.length * 0.25))) }
  }
}
const flakyOnce = {
  id: 'fake',
  async translate(text: string): Promise<{ text: string }> {
    calls++
    throw new Error('Vulkan device lost (simulated)')
  }
}

async function main() {
  fs.rmSync(JOBS, { recursive: true, force: true })
  fs.mkdirSync(JOBS, { recursive: true })
  let firstEngineUsed = false
  const modelManager = {
    async getEngine() {
      if (!firstEngineUsed) { firstEngineUsed = true; return flakyOnce }
      reloads++
      return goodEngine
    }
  }
  const pipeline = createPipeline(modelManager as never, JOBS, { pageLimit: 6 })
  const job: TranslationJob = {
    id: 'failover-1', inputPath: INPUT, outputPath: OUT, status: 'queued',
    progress: 0, totalPages: 0, currentPage: 0, model: 'fake',
    createdAt: Date.now(), updatedAt: Date.now()
  }
  const ac = new AbortController()
  await pipeline.run(job, () => undefined, ac.signal)
  const outSize = fs.statSync(OUT).size
  console.log(JSON.stringify({ calls, reloads, outSize, status: job.status }))
  if (reloads === 1 && outSize > 10000) console.log('FAILOVER TEST PASS')
  else { console.log('FAILOVER TEST FAIL'); process.exit(1) }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
