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
import { freezeProtected, restorePlaceholders } from './pdf'
import { expandAbbreviations } from './pdf/capture/glossary'
import type { ModelManager } from './models/manager'

/** The narrow engine surface this module depends on. */
interface PipelineEngine {
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

/**
 * Heuristic "did the model give us a sane translation?".
 */
function translationLooksSane(source: string, translated: string): boolean {
  const src = source.trim()
  const out = translated.trim()
  if (out.length === 0) return false
  if (src.length === 0) return true
  return out.length >= src.length * 0.1 && out.length <= src.length * 5
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
 * Code blocks are skipped entirely (verbatim). Table cells become individual
 * tasks keyed by [row,col] — the numbered-batch strategy (proven 100% parse
 * on real tables, poc/speed-v3/table-poc.ts) translates them losslessly
 * because structure lives in coordinates, never in the model's output.
 */
function buildTasks(blocks: ContentBlock[]): TransTask[] {
  const tasks: TransTask[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    // Code, images and formulas pass through VERBATIM: code/formula must not
    // be touched, images carry no text.
    if (b.type === 'code' || b.type === 'image' || b.type === 'formula') continue
    const page = b.page ?? 1
    if (b.type === 'table') {
      const cells = b.cells ?? []
      for (let r = 0; r < cells.length; r++) {
        for (let c = 0; c < cells[r].length; c++) {
          const t = (cells[r][c] ?? '').trim()
          if (t.length > 1) {
            tasks.push({ id: `b${i}-r${r}c${c}`, sourceText: t, blockIndex: i, cellRow: r, cellCol: c, page })
          }
        }
      }
      continue
    }
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
      let cellHits = 0
      let cellFalls = 0

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

        // ---- Table cells: dedicated numbered batches ----------------------
        // Cells are usually far below the prose batch min length, so they
        // never enter the prose batcher; the cell format was validated
        // separately (POC: 12/12 batches parsed, 0 fallback). Up to 8 cells
        // of the same table per call.
        if (task.cellRow !== undefined) {
          const cbatch: TransTask[] = [task]
          let ci = taskIdx + 1
          while (
            cbatch.length < 8 &&
            ci < tasks.length &&
            tasks[ci].cellRow !== undefined &&
            tasks[ci].blockIndex === task.blockIndex &&
            !recovered.has(tasks[ci].id)
          ) {
            cbatch.push(tasks[ci])
            ci++
          }
          const cellTexts = cbatch.map((t) => t.sourceText)
          let cparts: string[] | null = null
          if (cbatch.length >= 2) {
            try {
              const cout = await translateText(engine, numberJoin(cellTexts), signal)
              cparts = numberSplit(cout, cbatch.length)
              if (cparts !== null) cellHits++
              else cellFalls++
            } catch (err) {
              if (signal.aborted) { await saveProgress(); return }
              throw err
            }
          }
          for (let k = 0; k < cbatch.length; k++) {
            const t = cbatch[k]
            let text: string
            if (cparts !== null) {
              text = cparts[k]
            } else {
              if (signal.aborted) { await saveProgress(); return }
              try {
                text = await translateText(engine, t.sourceText, signal)
              } catch (err) {
                if (signal.aborted) { await saveProgress(); return }
                throw err
              }
            }
            writeBack(blocks, t, text)
            await checkpoint.appendTranslation(job.id, t.id, text)
            translatedCount++
            if (t.page > currentPage) { currentPage = t.page; job.currentPage = currentPage }
            onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
          }
          taskIdx = ci
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
          let translated: string
          try {
            translated = await translateText(engine, joinedSource, signal)
          } catch (err) {
            if (signal.aborted) { await saveProgress(); return }
            throw err
          }

          // Split the output by line numbers. If the model broke the format,
          // fall back to individual translation.
          const parts = numberSplit(translated, batch.length)
          if (parts === null) {
            // Numbered format not preserved — fall back to individual translations.
            batchFalls++
            for (const t of batch) {
              if (signal.aborted) { await saveProgress(); return }
              const ind = await translateText(engine, t.sourceText, signal)
              writeBack(blocks, t, ind)
              await checkpoint.appendTranslation(job.id, t.id, ind)
              translatedCount++
              if (t.page > currentPage) { currentPage = t.page; job.currentPage = currentPage }
              onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
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
          }
          taskIdx = bi
        } else {
          // ---- Single translate (long paragraph) -------------------------
          let translated: string
          try {
            translated = await translateText(engine, task.sourceText, signal)
          } catch (err) {
            if (signal.aborted) { await saveProgress(); return }
            throw err
          }
          writeBack(blocks, task, translated)
          await checkpoint.appendTranslation(job.id, task.id, translated)
          translatedCount++
          if (task.page > currentPage) {
            currentPage = task.page
            job.currentPage = currentPage
          }
          onProgress(currentPage, clamp100(5 + (translatedCount / Math.max(1, total)) * 85))
          taskIdx++
        }
      }
      console.log(`[pipeline] prose batches: ${batchHits} ok / ${batchFalls} fallback; cell batches: ${cellHits} ok / ${cellFalls} fallback`)

      // ==================================================================
      // Phase 3 — typesetting (fresh A4, flow layout)
      // ==================================================================
      job.status = 'typesetting'
      onProgress(job.totalPages, 92)
      console.log('[pipeline] typesetFlow starting...')
      const t1 = Date.now()
      await typesetFlow(blocks, job.outputPath, {
        fontPath: resolveFontPath()
      })
      console.log(`[pipeline] typesetFlow done in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
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
// Translation helper (same as before: glossary → freeze → engine → restore)
// ---------------------------------------------------------------------------

async function translateText(
  engine: PipelineEngine,
  source: string,
  signal: AbortSignal
): Promise<string> {
  const expanded = expandAbbreviations(source)
  const { text: masked, placeholders } = freezeProtected(expanded)

  const attempt = async (): Promise<string> => {
    const res = await engine.translate(masked, { signal })
    return restorePlaceholders(res.text, placeholders)
  }

  let out = await attempt()

  if (!translationLooksSane(source, out)) {
    try {
      const retry = await attempt()
      if (translationLooksSane(source, retry)) out = retry
    } catch {
      // Keep first attempt.
    }
  }

  if (!translationLooksSane(source, out)) return source
  return out
}
