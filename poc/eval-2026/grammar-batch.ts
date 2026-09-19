// poc/eval-2026/grammar-batch.ts — C2 A/B (pdfzh borrow candidate): does GBNF
// grammar-constrained JSON output beat our numbered-list batch carrier?
//
// Same corpus (80 paras, poc/speed-v3/corpus.json), same model/sampling, two
// strategies x two batch sizes. Metrics: batch parse-failure rate (numbered:
// splitBatch null; grammar: JSON.parse fail / id-set mismatch / empty zh),
// effective tok/s, wall time. Adoption bar (docs/PDFZH-COMPARE.md C2): parse
// failure strictly lower AND tok/s cost < 10% → candidate; else reject to §2.
import fs from 'node:fs'
import path from 'node:path'
import { LlamaCppEngine } from '../../electron/models/llama-engine'
import { joinBatch, splitBatch } from '../../electron/batch-format'

const ROOT = process.cwd()
const MODEL = path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf')
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'poc', 'speed-v3', 'corpus.json'), 'utf8')) as { texts: string[] }

const BATCH_SYSTEM =
  '把下面编号的英文条目逐条翻译成简体中文。每个条目占一行，行格式为“编号. 译文”。只输出译文行，不改变编号，不解释。'
const JSON_SYSTEM =
  '把下面编号的英文条目逐条翻译成简体中文。只输出一个 JSON 对象，形如 {"items":[{"id":编号,"zh":"译文"}]}，每个条目一项，id 必须与编号一致，不解释。'

const JSON_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'zh'],
        properties: { id: { type: 'integer' }, zh: { type: 'string' } }
      }
    }
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

interface Strat { name: 'number' | 'grammar'; system: string }

async function run(engine: LlamaCppEngine, strat: Strat, size: number, grammar: unknown | undefined) {
  const groups = chunk(corpus.texts, size)
  let batches = 0
  let fails = 0
  let units = 0
  let outTokens = 0
  const t0 = Date.now()
  for (const g of groups) {
    batches++
    units += g.length
    const joined = joinBatch(g)
    const res = await engine.translate(joined, { grammar: strat.name === 'grammar' ? grammar : undefined })
    outTokens += res.tokens
    let ok: boolean
    if (strat.name === 'number') {
      ok = splitBatch(res.text, g.length) !== null
    } else {
      ok = false
      try {
        const parsed = JSON.parse(res.text) as { items?: { id: number; zh: string }[] }
        const ids = new Set((parsed.items ?? []).map((i) => i.id))
        ok = parsed.items?.length === g.length && g.every((_, k) => ids.has(k + 1)) &&
          parsed.items.every((i) => typeof i.zh === 'string' && i.zh.trim().length > 0)
      } catch { /* parse failure */ }
    }
    if (!ok) fails++
  }
  const sec = (Date.now() - t0) / 1000
  return {
    strat: strat.name, size, batches, fails, failPct: +((fails / batches) * 100).toFixed(1),
    units, tokPerSec: +(outTokens / sec).toFixed(1), wallSec: +sec.toFixed(1)
  }
}

async function main() {
  const results = []
  for (const strat of [{ name: 'number', system: BATCH_SYSTEM }, { name: 'grammar', system: JSON_SYSTEM }] as Strat[]) {
    // One engine per strategy so the system prompt matches the carrier format
    // (production parity: the batch instruction lives in the system prompt).
    const engine = new LlamaCppEngine({ systemPrompt: strat.system, disableReasoning: true, id: 'qwen3-1.7b-q4_k_m' })
    await engine.load(MODEL, { contextSize: 4096, device: 'auto' })
    let grammar: unknown | undefined
    if (strat.name === 'grammar') {
      grammar = await engine.createJsonGrammar(JSON_SCHEMA)
      if (!grammar) { console.error('[grammar-batch] grammar unavailable, skipping strategy'); await engine.dispose(); continue }
    }
    for (const size of [2, 4]) {
      results.push(await run(engine, strat, size, grammar))
    }
    await engine.dispose()
  }
  console.log(JSON.stringify({ results }, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
