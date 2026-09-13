/**
 * electron/queue/__test__.ts — self-contained Node tests for the queue module.
 *
 * Runs under plain Node via type-stripping (no Electron, no test runner):
 *   node --experimental-strip-types electron/queue/__test__.ts
 *
 * Covers: state-machine legality, crash-safe checkpoint (atomic write +
 * append-only jsonl), JobManager add/pause/resume/cancel/remove with a mock
 * pipeline, and startup orphan repair.
 */

import { promises as fsp } from 'node:fs'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranslationJob } from '../../shared/types'
import {
  ACTIVE_STATUSES,
  RESUMABLE_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canCancel,
  canDelete,
  canPause,
  canResume,
  isLegalTransition
} from './stateMachine.ts'
import { CheckpointStore } from './checkpoint.ts'
import { JobManager, type TranslationPipeline } from './manager.ts'
import { flushJobs } from './storage.ts'

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 15): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(stepMs)
  }
  return cond()
}

/** A cooperative mock pipeline that emits progress and honors AbortSignal. */
function makePipeline(stepMs = 8): TranslationPipeline {
  return {
    async run(job, onProgress, signal) {
      job.status = 'translating'
      for (let p = 0; p <= 100; p += 20) {
        await sleep(stepMs)
        if (signal.aborted) return // cooperative stop
        onProgress(p, p)
      }
      job.status = 'exporting'
      onProgress(100, 100)
    }
  }
}

function makeManager(root: string): { manager: JobManager; events: TranslationJob[] } {
  const events: TranslationJob[] = []
  const manager = new JobManager({
    jobsDir: join(root, 'jobs'),
    outputDir: join(root, 'output'),
    model: 'test-model',
    onEvent: (j) => events.push(j)
  })
  return { manager, events }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'entransfer-queue-'))
  await fsp.mkdir(join(root, 'output'), { recursive: true })

  // --------------------------------------------------------------- state machine
  section('state machine')
  check('ACTIVE_STATUSES has 4 phases', ACTIVE_STATUSES.length === 4)
  check('RESUMABLE = paused/error/canceled', RESUMABLE_STATUSES.join() === 'paused,error,canceled')
  check('TERMINAL = done', TERMINAL_STATUSES.join() === 'done')
  check('legal queued->extracting', isLegalTransition('queued', 'extracting'))
  check('legal extracting->translating', isLegalTransition('extracting', 'translating'))
  check('legal exporting->done', isLegalTransition('exporting', 'done'))
  check('legal active->paused', isLegalTransition('translating', 'paused'))
  check('legal active->canceled', isLegalTransition('translating', 'canceled'))
  check('legal active->error', isLegalTransition('translating', 'error'))
  check('legal paused->queued (resume)', isLegalTransition('paused', 'queued'))
  check('legal canceled->queued (resume)', isLegalTransition('canceled', 'queued'))
  check('illegal queued->done', !isLegalTransition('queued', 'done'))
  check('illegal translating->done (skip)', !isLegalTransition('translating', 'done'))
  check('illegal done->anything', !isLegalTransition('done', 'queued'))
  check('illegal done->paused', !isLegalTransition('done', 'paused'))
  check('no-op self transition allowed', isLegalTransition('translating', 'translating'))
  let threw = false
  try {
    assertTransition('done', 'queued')
  } catch {
    threw = true
  }
  check('assertTransition throws on illegal', threw)
  check('canPause only active', canPause('translating') && !canPause('queued') && !canPause('done'))
  check('canResume paused/error/canceled', canResume('paused') && canResume('error') && canResume('canceled') && !canResume('queued'))
  check('canCancel excludes done/canceled', canCancel('queued') && canCancel('paused') && !canCancel('done') && !canCancel('canceled'))
  check('canDelete excludes active', canDelete('done') && canDelete('paused') && !canDelete('translating'))

  // --------------------------------------------------------------- checkpoint
  section('checkpoint')
  const store = new CheckpointStore(join(root, 'jobs'))
  const cpid = 'cp-001'
  await store.save(cpid, { phase: 'translating', completedPages: 12, progress: 40, translatedUnits: 5, totalUnits: 9 })
  const loaded = await store.load(cpid)
  check('checkpoint roundtrip', loaded?.completedPages === 12 && loaded.progress === 40)
  check('no leftover tmp after atomic write', !existsSync(join(store.getJobDir(cpid), 'checkpoint.json.tmp')))
  // overwrite atomically (crash-safety contract: rename over existing target)
  await store.save(cpid, { phase: 'typesetting', completedPages: 30, progress: 80, translatedUnits: 8, totalUnits: 9 })
  const overwritten = await store.load(cpid)
  check('atomic overwrite keeps latest', overwritten?.progress === 80 && overwritten.completedPages === 30)

  // append-only jsonl: append, read, append again (resume must not truncate)
  await store.appendTranslation(cpid, 'u1', '译文一')
  await store.appendTranslation(cpid, 'u2', '译文二')
  let map = await store.loadTranslations(cpid)
  check('jsonl holds 2 units', map.size === 2 && map.get('u2') === '译文二')
  // resume path: append more without truncating
  await store.appendTranslation(cpid, 'u3', '译文三')
  map = await store.loadTranslations(cpid)
  check('append-only resume does not truncate (3 units)', map.size === 3)

  // state snapshot
  await store.saveState(cpid, { status: 'paused', updatedAt: 1 })
  const st = await store.loadState(cpid)
  check('state.json snapshot', st?.status === 'paused')

  // clear removes the dir
  await store.clear(cpid)
  check('clear removes job dir', !(await fsp.access(store.getJobDir(cpid)).then(() => true).catch(() => false)))

  // --------------------------------------------------------------- manager: add/done
  section('manager add -> done (FIFO single)')
  {
    const mgrRoot = join(root, 'mgr1')
    const { manager, events } = makeManager(mgrRoot)
    manager.setPipeline(makePipeline())
    await manager.bootstrap()

    const job = await manager.add('/books/a.pdf')
    // add() kicks the queue synchronously, so it may already be in an active phase.
    check('job created and running', ['queued', 'extracting', 'translating'].includes(job.status))
    const done = await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'done')
    check('job runs to done', done)
    let list = await manager.list()
    const final = list.find((j) => j.id === job.id)!
    check('done progress=100', final.progress === 100 && final.status === 'done')
    check('job:updated events emitted', events.length > 0)
    await flushJobs()
  }

  // --------------------------------------------------------------- manager: pause/resume
  section('manager pause -> resume -> done')
  {
    const mgrRoot = join(root, 'mgr2')
    const { manager } = makeManager(mgrRoot)
    manager.setPipeline(makePipeline(40)) // slow enough to catch mid-run
    await manager.bootstrap()

    const job = await manager.add('/books/b.pdf')
    // wait until it actually starts translating
    await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'translating')
    await manager.pause(job.id)
    const paused = await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'paused')
    check('pause cooperatively suspends to paused', paused)

    await manager.resume(job.id)
    const done = await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'done')
    check('resume re-enters via queued and completes', done)
    await flushJobs()
  }

  // --------------------------------------------------------------- manager: cancel
  section('manager cancel')
  {
    const mgrRoot = join(root, 'mgr3')
    const { manager } = makeManager(mgrRoot)
    manager.setPipeline(makePipeline(40))
    await manager.bootstrap()

    const job = await manager.add('/books/c.pdf')
    await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'translating')
    await manager.cancel(job.id)
    const canceled = await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'canceled')
    check('cancel settles to canceled', canceled)
    // temp job dir cleaned (settle: transition -> flush -> clear), but output PDF retained.
    await waitFor(() => !existsSync(join(join(mgrRoot, 'jobs'), job.id)))
    const jobDirExists = existsSync(join(join(mgrRoot, 'jobs'), job.id))
    check('cancel cleans temp job dir', !jobDirExists)

    // A second add may already be running; cancel settles it (or a still-queued job) to canceled.
    const queuedJob = await manager.add('/books/d.pdf')
    await manager.cancel(queuedJob.id)
    await waitFor(async () => (await manager.list()).find((j) => j.id === queuedJob.id)?.status === 'canceled')
    const after = (await manager.list()).find((j) => j.id === queuedJob.id)
    check('queued/running cancel -> canceled', after?.status === 'canceled')
    await flushJobs()
  }

  // --------------------------------------------------------------- manager: remove
  section('manager remove')
  {
    const mgrRoot = join(root, 'mgr4')
    const { manager } = makeManager(mgrRoot)
    manager.setPipeline(makePipeline())
    await manager.bootstrap()

    const job = await manager.add('/books/e.pdf')
    await waitFor(async () => (await manager.list()).find((j) => j.id === job.id)?.status === 'done')
    // simulate an output PDF on disk
    await fsp.mkdir(join(mgrRoot, 'output'), { recursive: true })
    await fsp.writeFile(job.outputPath, '%PDF-fake', 'utf8')
    await manager.remove(job.id)
    const list = await manager.list()
    check('remove drops the record', !list.some((j) => j.id === job.id))
    check('remove deletes output PDF', !(await fsp.access(job.outputPath).then(() => true).catch(() => false)))
    await flushJobs()
  }

  // --------------------------------------------------------------- manager: FIFO serialization
  section('manager FIFO serialization (one at a time)')
  {
    const mgrRoot = join(root, 'mgr5')
    const { manager } = makeManager(mgrRoot)
    let concurrent = 0
    let maxConcurrent = 0
    manager.setPipeline({
      async run(job, onProgress, signal) {
        job.status = 'translating'
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        for (let p = 0; p <= 100; p += 25) {
          if (signal.aborted) return
          onProgress(p, p)
          await sleep(5)
        }
        job.status = 'exporting'
        concurrent--
      }
    })
    await manager.bootstrap()
    await manager.add('/books/f1.pdf')
    await manager.add('/books/f2.pdf')
    await manager.add('/books/f3.pdf')
    await waitFor(async () => (await manager.list()).filter((j) => j.status === 'done').length === 3)
    check('runs strictly one at a time', maxConcurrent === 1)
    const fList = await manager.list()
    check('all three done', fList.every((j) => j.status === 'done'), fList.map((j) => `${j.id.slice(0,4)}:${j.status}`).join(','))
    await flushJobs()
  }

  // --------------------------------------------------------------- orphan repair
  section('startup orphan repair')
  {
    const mgrRoot = join(root, 'mgr6')
    const jobsRoot = join(mgrRoot, 'jobs')
    await fsp.mkdir(jobsRoot, { recursive: true })
    await fsp.mkdir(join(mgrRoot, 'output'), { recursive: true })
    // Persist a catalog whose job is stuck in an active phase (crashed mid-run).
    const orphan: TranslationJob = {
      id: 'orphan-1',
      inputPath: '/books/x.pdf',
      outputPath: join(mgrRoot, 'output', 'x.zh.pdf'),
      status: 'translating',
      progress: 33,
      totalPages: 100,
      currentPage: 33,
      model: 'test-model',
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000
    }
    await fsp.writeFile(join(jobsRoot, 'jobs.json'), JSON.stringify([orphan]), 'utf8')

    const { manager } = makeManager(mgrRoot)
    await manager.bootstrap()
    const list = await manager.list()
    const repaired = list.find((j) => j.id === 'orphan-1')
    check('active orphan repaired to paused', repaired?.status === 'paused')
  }

  // --------------------------------------------------------------- summary
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  console.log('')
  if (failures > 0) {
    console.error(`TESTS FAILED: ${failures} failure(s)`)
    process.exit(1)
  } else {
    console.log('ALL TESTS PASSED')
  }
}

main().catch((err) => {
  console.error('TEST RUNNER ERROR', err)
  process.exit(1)
})
