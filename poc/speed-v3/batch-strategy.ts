// batch-strategy.ts — A/B the two short-paragraph batching delimiters on the
// SAME 80-paragraph corpus, so the pipeline's batch format choice is backed by
// data (current \n---\n falls back ~45-50% per docs/E2E-QUALITY-REVIEW).
//   strategy "hr"    : join with "\n---\n"          (what pipeline.ts does now)
//   strategy "number": join with "1. x\n2. y\n..."  (what table-poc proved 100%)
// Reports fallback rate + wall time + aggregate tok/s for each.
import fs from 'node:fs'
import path from 'node:path'
import { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } from '../../electron/models/llama-engine'

const ROOT = process.cwd()
const MODEL = path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf')
const BATCH_SYSTEM =
  '把下面编号的英文条目逐条翻译成简体中文。每个条目占一行，行格式为“编号. 译文”。只输出译文行，不改变编号，不解释。'

const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'poc', 'speed-v3', 'corpus.json'), 'utf8')) as { texts: string[] }

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function run(engine: LlamaCppEngine, strat: 'hr' | 'number', size: number) {
  const groups = chunk(corpus.texts, size)
  let fallback = 0, ok = 0, totTok = 0
  const t0 = Date.now()
  for (const g of groups) {
    const joined = strat === 'hr' ? g.join('\n---\n') : g.map((x, i) => `${i + 1}. ${x}`).join('\n')
    const out = (await engine.translate(joined, {})).text
    let parts: string[]
    if (strat === 'hr') {
      parts = out.split('\n---\n')
      if (parts.length !== g.length) { fallback++; totTok += engine.tokenizeCount(out); continue }
    } else {
      const map = new Map<number, string>()
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line)
        if (m && m[2].trim()) map.set(Number(m[1]), m[2].trim())
      }
      if (map.size === g.length) { ok++ } else { fallback++ }
      totTok += engine.tokenizeCount(out)
      continue
    }
    ok++; totTok += engine.tokenizeCount(out)
  }
  const el = (Date.now() - t0) / 1000
  return { strat, size, groups: groups.length, ok, fallback, fallbackPct: +((fallback / groups.length) * 100).toFixed(1), sec: +el.toFixed(1), tokPerSec: +(totTok / el).toFixed(1) }
}

async function main() {
  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true })
  await engine.load(MODEL, { device: 'gpu', threads: 12, contextSize: 4096 })
  const results = []
  results.push(await run(engine, 'hr', 3))
  results.push(await run(engine, 'hr', 4))
  results.push(await run(engine, 'number', 3))
  results.push(await run(engine, 'number', 4))
  // numbered with dedicated prompt
  const eng2 = new LlamaCppEngine({ systemPrompt: BATCH_SYSTEM, disableReasoning: true })
  await eng2.load(MODEL, { device: 'gpu', threads: 12, contextSize: 4096 })
  results.push(await run(eng2, 'number', 4))
  console.log(JSON.stringify(results, null, 2))
  await engine.dispose(); await eng2.dispose()
}
main().catch((e) => { console.error(e); process.exit(1) })
