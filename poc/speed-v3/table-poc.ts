// table-poc.ts — POC: recognize tables, translate cells with a NUMBERED-BATCH
// prompt strategy (vs the current pipeline which keeps tables verbatim English
// and the \n---\n batch format that fails ~45%). Translates every cell of every
// detected table, rebuilds the PDF, and reports parse reliability + timing.
//
// run: node .scratch/poc-tables.cjs   (built from this file via esbuild)
import fs from 'node:fs'
import path from 'node:path'
import { captureFlow, type ContentBlock } from '../../electron/pdf/capture/flow'
import { typesetFlow } from '../../electron/pdf/typeset/flow'
import { LlamaCppEngine } from '../../electron/models/llama-engine'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const MODEL = path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf')
const OUTDIR = path.join(ROOT, 'poc', 'speed-v3')
const FONT = path.join(ROOT, 'assets', 'fonts', 'MicrosoftYaHei-Regular-subset.ttf')

const CELL_BATCH_SYSTEM =
  '你是专业翻译引擎。输入是若干带编号的英文条目（表格单元格）。逐条翻译成简体中文。' +
  '规则：每个编号占一行，行格式为“编号. 译文”；只输出译文行，不输出解释、不改变编号、空条目跳过不输出。'

function buildNumberedBatch(cells: string[]): string {
  return cells.map((c, i) => `${i + 1}. ${c}`).join('\n')
}

/** Parse "N. text" lines back into a map by index; tolerant of "N、" / "N)". */
function parseNumbered(out: string, expected: number): Map<number, string> {
  const map = new Map<number, string>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line)
    if (!m) continue
    const idx = Number(m[1]) - 1
    if (idx >= 0 && idx < expected && m[2].trim()) map.set(idx, m[2].trim())
  }
  return map
}

async function main(): Promise<void> {
  console.log('[table-poc] capturing up to page 300...')
  const t0 = Date.now()
  const { blocks } = await captureFlow(INPUT, { pageLimit: 300 })
  const tables = blocks.filter((b) => b.type === 'table')
  console.log(`[table-poc] ${tables.length} tables in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (tables.length === 0) { console.log('no tables found'); return }
  let totalCells = 0
  for (const t of tables) totalCells += (t.cells ?? []).flat().filter((c) => c.trim().length > 1).length
  console.log(`[table-poc] ${totalCells} non-trivial cells`)

  console.log('[table-poc] loading engine (GPU, numbered-cell prompt)...')
  const engine = new LlamaCppEngine({ systemPrompt: CELL_BATCH_SYSTEM, disableReasoning: true })
  await engine.load(MODEL, { device: 'gpu', threads: 12, contextSize: 4096 })

  let batchOk = 0, batchFallback = 0, cellCount = 0, skipped = 0
  const t1 = Date.now()

  // Translate every table with numbered batches (up to 8 cells / call).
  for (const t of tables) {
    const cells = t.cells ?? []
    const flat: Array<[number, number]> = []
    for (let r = 0; r < cells.length; r++)
      for (let c = 0; c < cells[r].length; c++)
        if ((cells[r][c] ?? '').trim().length > 1) flat.push([r, c])
    for (let i = 0; i < flat.length; i += 8) {
      const chunk = flat.slice(i, i + 8)
      const texts = chunk.map(([r, c]) => cells[r][c].trim())
      let translated: string
      try {
        translated = (await engine.translate(buildNumberedBatch(texts), {})).text
      } catch { skipped += chunk.length; continue }
      // The engine embeds its own system prompt; we want CELL_BATCH_SYSTEM,
      // so call with raw prompt semantics via translate() is not ideal —
      // acceptable for POC: the numbered format still dominates the behavior.
      const map = parseNumbered(translated, texts.length)
      if (map.size === texts.length) {
        batchOk++
        for (const [k, [r, c]] of chunk.entries()) {
          const got = map.get(k)
          if (got) { cells[r][c] = got; cellCount++ }
        }
      } else {
        batchFallback++
        for (const [k, [r, c]] of chunk.entries()) {
          try {
            const one = (await engine.translate(texts[k], {})).text
            const m = parseNumbered(one, 1).get(0)
            cells[r][c] = (m ?? one).trim(); cellCount++
          } catch { skipped++ }
        }
      }
    }
  }
  const el = (Date.now() - t1) / 1000
  console.log(`[table-poc] batches ok=${batchOk} fallback=${batchFallback} cells=${cellCount} skipped=${skipped} in ${el.toFixed(1)}s`)

  // Rebuild a PDF containing only the table blocks (for visual QA) plus a note.
  const doc: ContentBlock[] = [
    { type: 'heading', level: 1, text: '表格翻译 POC 输出（编号批次策略）' },
    { type: 'paragraph', text: `检测 ${tables.length} 张表 / ${totalCells} 个单元格；批次成功 ${batchOk}、回退 ${batchFallback}、耗时 ${el.toFixed(1)}s。` }
  ]
  for (const [i, t] of tables.entries()) {
    doc.push({ type: 'heading', level: 3, text: `表样本 ${i + 1}（原第 ${t.page ?? '?'} 页）` })
    doc.push(t)
  }
  const outFile = path.join(OUTDIR, 'out-tables-zh.pdf')
  await typesetFlow(doc, outFile, { fontPath: FONT })
  console.log(`[table-poc] wrote ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`)
  await engine.dispose()
}

main().catch((e) => { console.error(e); process.exit(1) })
