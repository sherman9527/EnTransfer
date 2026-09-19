/**
 * electron/pipeline.ts — the translation pipeline orchestrator (flow-based).
 *
 * Glues the flow-based PDF modules into the one pipeline the JobManager drives:
 *
 *   captureFlow (structured content blocks) → translate → typesetFlow (fresh A4)
 *
 * Phases map onto the job state machine:
 *   extracting → translating → typesetting → exporting → done
 * Progress: extract 0–5, translate 5–90, typeset 90–98, export 98–100.
 *
 * Crash safety: every translated unit is appended (append-only) to
 * translation.jsonl immediately. On resume, persisted translations are loaded
 * and those units are skipped. Unit IDs are block-index based:
 *   `b{i}`     — heading / paragraph block i
 *   `b{i}-j`   — list item j within block i
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { TranslationJob } from '../shared/types'
import type { TranslationPipeline } from './queue/manager'
import { CheckpointStore } from './queue/checkpoint.ts'
import type { CheckpointData } from './queue/checkpoint.ts'
import { captureFlow, type ContentBlock } from './pdf/capture/flow'
import { typesetFlow } from './pdf/typeset/flow'
import { blocksToHtml } from './pdf/typeset/htmlFlow'
import { printHtmlToPdf } from './pdf/typeset/chromiumPrint'
import { validateModelOutput, validateRestored } from './pdf/validate'
import { TranslationCache } from './models/translation-cache'
import { freezeProtected, restorePlaceholders } from './pdf'
import { expandAbbreviations } from './pdf/capture/glossary'
import type { ModelManager } from './models/manager'

/** The narrow engine surface this module depends on. */
interface PipelineEngine {
  readonly id?: string
  translate(
    text: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ text: string }>
}

/** Options the factory accepts. */
export interface PipelineOptions {
  /** Stop capture after this many pages (1-based inclusive). */
  pageLimit?: number
}

/** Keep progress within [0, 100]. */
function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0))
}

/**
 * Resolve the bundled CJK TTF across dev and packaged builds.
 * In packaged mode, app.getAppPath() returns the asar path; Node reads
 * files inside asar transparently. In dev, it returns the project root.
 */
export function resolveFontPath(): string {
  const appRoot = app?.getAppPath?.() ?? process.cwd()
  const candidates = [
    path.join(appRoot, 'assets', 'fonts', 'MicrosoftYaHei-Regular-subset.ttf'),
    path.join(appRoot, 'assets', 'fonts', 'NotoSansSC-Subset.ttf'),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return candidates[0]
}

// ---------------------------------------------------------------------------
// Translation task model
// ---------------------------------------------------------------------------

/** One translatable text fragment derived from a ContentBlock. */
interface TransTask {
  /** Unit ID used for checkpoint/resume. */
  id: string
  /** Source text to translate. */
  sourceText: string
  /** Index into the blocks array. */
  blockIndex: number
  /** For list blocks: which item (undefined for heading/paragraph). */
  listIndex?: number
  /** For table blocks: [row, col] cell coordinates. */
  cellRow?: number
  cellCol?: number
  /** Source page number (for progress reporting). */
  page: number
}

/**
 * Walk the block stream and produce a flat list of translation tasks.
 * Code, images, tables and formulas are skipped entirely (VERBATIM policy,
 * user decision 2026-09-19): translating table cells left mixed English/Chinese
 * headers ("Status") and risked row/col drift — recognized + re-typeset nicely,
 * never translated.
 */
function buildTasks(blocks: ContentBlock[]): TransTask[] {
  const tasks: TransTask[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'code' || b.type === 'image' || b.type === 'table' || b.type === 'formula') continue
    const page = b.page ?? 1
    if (b.type === 'list') {
      const items = b.items ?? []
      for (let j = 0; j < items.length; j++) {
        if (items[j].trim().length > 0) {
          tasks.push({ id: `b${i}-${j}`, sourceText: items[j], blockIndex: i, listIndex: j, page })
        }
      }
    } else {
      const text = b.text ?? ''
      if (text.trim().length > 0) {
        tasks.push({ id: `b${i}`, sourceText: text, blockIndex: i, page })
      }
    }
  }
  return tasks
}

/** Write a translated result back into the blocks array. */
function writeBack(blocks: ContentBlock[], task: TransTask, translated: string): void {
  const block = blocks[task.blockIndex]
  if (!block) return
  if (task.listIndex !== undefined) {
    if (block.items) {
      block.items[task.listIndex] = translated
    }
  } else if (task.cellRow !== undefined && task.cellCol !== undefined) {
    if (block.cells) {
      block.cells[task.cellRow][task.cellCol] = translated
    }
  } else {
    block.text = translated
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPipeline(
  modelManager: Pick<ModelManager, 'getEngine'>,
  jobsDir: string,
  options: PipelineOptions = {}
): TranslationPipeline {
  const checkpoint = new CheckpointStore(jobsDir)
  const cache = new TranslationCache(path.join(jobsDir, '..', 'translations'))
  const cacheStats = { cacheHits: 0 }
  const pageLimit = options.pageLimit && options.pageLimit > 0 ? options.pageLimit : undefined

  return {
    async run(
      job: TranslationJob,
      onProgress: (page: number, progress: number) => void,
      signal: AbortSignal
    ): Promise<void> {
      // ==================================================================
      // Phase 1 — extracting
      // ==================================================================
      console.log('[pipeline] captureFlow starting...')
      const t0 = Date.now()
      const { blocks, pageCount, imageCount } = await captureFlow(job.inputPath, pageLimit ? { pageLimit } : {})
      job.totalPages = pageCount
      job.currentPage = 0
      console.log(`[pipeline] extracted ${blocks.length} blocks (${imageCount} images) from ${pageCount} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      onProgress(0, 5)
      await checkpoint.save(job.id, {
        phase: 'extracting',
        completedPages: 0,
        progress: 5,
        translatedUnits: 0,
        totalUnits: 0
      } as CheckpointData)

      if (signal.aborted) return

      // Build translation tasks from blocks.
      const tasks = buildTasks(blocks)
      const total = tasks.length
      console.log(`[pipeline] ${total} translation tasks`)

      await checkpoint.save(job.id, {
        phase: 'extracting',
        completedPages: 0,
        progress: 5,
        translatedUnits: 0,
        totalUnits: total
      } as CheckpointData)

      // ==================================================================
      // Phase 2 — translating (with short-paragraph batching)
      // ==================================================================
      job.status = 'translating'

      // Resume: load every task already finalized on disk and skip.
      const recovered = await checkpoint.loadTranslations(job.id)
      let translatedCount = recovered.size
      let currentPage = 0
      for (const task of tasks) {
        const recoveredText = recovered.get(task.id)
        if (recoveredText !== undefined) {
          writeBack(blocks, task, recoveredText)
          if (task.page > currentPage) currentPage = task.page
        }
      }

      let engine: PipelineEngine
      try {
        engine = await modelManager.getEngine()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/not\s*download|not-downloaded/i.test(msg)) {
          throw new Error('请先在模型管理页面下载翻译模型')
        }
        throw err
      }

      // Batch translation: merge consecutive short paragraphs into one request
      // to amortize prompt-prefill overhead. Numbered lines ("1. x\n2. y") are
      // used as the carrier format: measured 5% parse-failure vs 48% for the
      // previous "\n---\n" delimiter (poc/speed-v3/batch-strategy.ts, n=80).
      // Parsing maps BY NUMBER, so a model that reorders lines still resolves.
      const BATCH_SIZE = 4
      const SHORT_MAX_CHARS = 250
      const numberJoin = (ts: string[]): string => ts.map((t, i) => `${i + 1}. ${t}`).join('\n')
      const numberSplit = (out: string, n: number): string[] | null => {
        const map = new Map<number, string[]>()
        let last: number | null = null
        for (const line of out.split('\n')) {
          const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line)
          if (m) {
            const idx = Number(m[1])
            if (idx >= 1 && idx <= n && !map.has(idx)) {
              map.set(idx, [m[2].trim()])
              last = idx
            } else if (last !== null && m[2].trim()) {
              map.get(last)!.push(m[2].trim())
            } else {
              last = null
            }
          } else if (last !== null && line.trim()) {
            // continuation line of the previous numbered item — keep, don't drop
            map.get(last)!.push(line.trim())
          }
        }
        if (map.size !== n) return null
        return Array.from({ length: n }, (_, i) => (map.get(i + 1) as string[]).join(' ').trim())
      }
      let batchHits = 0
      let batchFalls = 0
      const fallbacks: Array<{ unit: string; page: number; reasons: string[] }> = []
      const noteFallback = (t: TransTask, r: TranslateAttempt): void => {
        if (!r.ok) fallbacks.push({ unit: t.id, page: t.page, reasons: r.reasons })
      }
      // Circuit breaker: a pathological run (bad model state, corrupted page
      // storm) must stop early instead of quietly falling back for a whole book.
      const checkBreaker = (): void => {
        if (translatedCount >= 200 && fallbacks.length / translatedCount > 0.3) {
          throw new Error(`翻译质量熔断：已处理 ${translatedCount} 单元，回退 ${fallbacks.length}（>30%），中止任务`)
        }
      }

      const saveProgress = async (): Promise<void> => {
        await checkpoint.save(job.id, {
          phase: 'translating',
          completedPages: currentPage,
          progress: clamp100(5 + (translatedCount / Math.max(1, total)) * 85),
          translatedUnits: translatedCount,
          totalUnits: total
        })
      }

      let taskIdx = 0
      while (taskIdx < tasks.length) {
        const task = tasks[taskIdx]

        // Cooperative pause/cancel.
        if (signal.aborted) {
          await saveProgress()
          return
        }

        // Already translated in a previous run → skip.
        if (recovered.has(task.id)) {
          taskIdx++
          continue
        }

        // ---- Try to batch this task with following short tasks ------------
        // Collect up to BATCH_SIZE consecutive short, untranslated prose-like
        // tasks on the same page. Very short fragments (headings, bullets,
        // front-matter crumbs) break numbered-list formatting at ~2x the rate
        // of real sentences, so they go single.
        const BATCH_MIN_CHARS = 60
        const batchable = (t: TransTask): boolean =>
          t.sourceText.length >= BATCH_MIN_CHARS && t.sourceText.length <= SHORT_MAX_CHARS
        const batch: TransTask[] = [task]
        let bi = taskIdx + 1
        while (
          batch.length < BATCH_SIZE &&
          bi < tasks.length &&
          !recovered.has(tasks[bi].id) &&
          tasks[bi].page === task.page &&
          batchable(tasks[bi]) &&
          batchable(task)
        ) {
          batch.push(tasks[bi])
          bi++
        }

        if (batch.length >= 2) {
          // ---- Batch translate -------------------------------------------
          const joinedSource = numberJoin(batch.map((t) => t.sourceText))
          let res: TranslateAttempt
          try {
            res = await translateText(engine, joinedSource, signal, cache, cacheStats)
          } catch (err) {
            if (signal.aborted) { await saveProgress(); return }
            throw err
          }

          // Split the output by line numbers. Format breakage OR a failed
          // batch-level validation falls back to individual translation.
          const parts = res.ok ? numberSplit(res.text, batch.length) : null
          if (parts === null) {
            batchFalls++
            for (const t of batch) {
              if (signal.aborted) { await saveProgress(); return }
              const one = await translateText(engine, t.sourceText, signal, cache, cacheStats)
              noteFallback(t, one)
              writeBack(blocks, t, one.text)
              await checkpoint.appendTranslation(job.id, t.id, one.text)
              translatedCount++
              if (t.page > currentPage) { currentPage = t.page; job.currentPage = currentPage }
              onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
              checkBreaker()
            }
          } else {
            batchHits++
            for (let k = 0; k < batch.length; k++) {
              writeBack(blocks, batch[k], parts[k].trim())
              await checkpoint.appendTranslation(job.id, batch[k].id, parts[k].trim())
              translatedCount++
              if (batch[k].page > currentPage) { currentPage = batch[k].page; job.currentPage = currentPage }
            }
            onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
            checkBreaker()
          }
          taskIdx = bi
        } else {
          // ---- Single translate (long paragraph) -------------------------
          let res: TranslateAttempt
          try {
            res = await translateText(engine, task.sourceText, signal, cache, cacheStats)
          } catch (err) {
            if (signal.aborted) { await saveProgress(); return }
            throw err
          }
          noteFallback(task, res)
          writeBack(blocks, task, res.text)
          await checkpoint.appendTranslation(job.id, task.id, res.text)
          translatedCount++
          if (task.page > currentPage) {
            currentPage = task.page
            job.currentPage = currentPage
          }
          onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
          checkBreaker()
          taskIdx++
        }
      }
      console.log(`[pipeline] prose batches: ${batchHits} ok / ${batchFalls} fell back to single; validation fallbacks: ${fallbacks.length}; cache hits: ${cacheStats.cacheHits}/${total}`)
      if (fallbacks.length > 0) {
        try {
          await fsp.writeFile(
            path.join(checkpoint.getJobDir(job.id), 'quality-report.jsonl'),
            fallbacks.map((f) => JSON.stringify(f)).join('\n') + '\n',
            'utf8'
          )
        } catch (err) {
          console.warn('[pipeline] quality report write failed:', (err as Error).message)
        }
      }

      // ==================================================================
      // Phase 3 — typesetting (Chromium primary, pdf-lib fallback)
      // ==================================================================
      job.status = 'typesetting'
      onProgress(job.totalPages, 92)
      const t1 = Date.now()
      const fallbackKeys = new Set(fallbacks.map((f) => f.unit))
      try {
        console.log('[pipeline] chromium compose+print starting...')
        await printHtmlToPdf(blocksToHtml(blocks, { fallbackKeys }), job.outputPath)
        console.log(`[pipeline] chromium typeset done in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
      } catch (err) {
        console.warn(`[pipeline] chromium typeset failed (${(err as Error).message}); falling back to pdf-lib`)
        await typesetFlow(blocks, job.outputPath, { fontPath: resolveFontPath() })
        console.log(`[pipeline] pdf-lib typeset done in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
      }
      onProgress(job.totalPages, 98)

      // ==================================================================
      // Phase 4 — exporting
      // ==================================================================
      job.status = 'exporting'
      await checkpoint.save(job.id, {
        phase: 'exporting',
        completedPages: job.totalPages,
        progress: 98,
        translatedUnits: translatedCount,
        totalUnits: total
      })
      let stat: { size: number }
      try {
        stat = await fsp.stat(job.outputPath)
      } catch (err) {
        throw new Error(`输出 PDF 未生成：${(err as Error).message}`)
      }
      if (stat.size <= 0) throw new Error('输出 PDF 为空文件（0 字节）')

      onProgress(job.totalPages, 100)
    }
  }
}

// ---------------------------------------------------------------------------
// Translation helper: glossary → freeze → engine → restore → VALIDATE.
// Two-phase invariants (see pdf/validate.ts); one retry on failure; a unit
// that still fails keeps its SOURCE text and is recorded for the quality
// report + badge. Abort propagates to the caller's cooperative handling.
// ---------------------------------------------------------------------------

export interface TranslateAttempt {
  text: string
  ok: boolean
  reasons: string[]
}

export const PROMPT_VERSION = 'p1-numbered'

async function translateText(
  engine: PipelineEngine,
  source: string,
  signal: AbortSignal,
  cache: TranslationCache,
  stats: { cacheHits: number }
): Promise<TranslateAttempt> {
  const expanded = expandAbbreviations(source)
  const { text: masked, placeholders } = freezeProtected(expanded)
  const key = { modelId: engine.id ?? 'llama', promptVersion: PROMPT_VERSION, temperature: 0.1, source, masked }
  const hash = TranslationCache.hashKey(key)
  const hit = await cache.get(hash)
  if (hit && validateRestored(source, hit.translated).ok) {
    stats.cacheHits++
    return { text: hit.translated, ok: true, reasons: [] }
  }
  let lastReasons: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await engine.translate(masked, { signal })
    const raw = res.text
    const vm = validateModelOutput(masked, raw)
    const restored = restorePlaceholders(raw, placeholders).trim()
    const vr = validateRestored(source, restored)
    if (vm.ok && vr.ok) {
      void cache.put(hash, restored, 0)
      return { text: restored, ok: true, reasons: [] }
    }
    lastReasons = [...vm.reasons, ...vr.reasons]
  }
  return { text: source, ok: false, reasons: lastReasons }
}
