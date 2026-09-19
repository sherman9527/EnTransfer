// poc/eval-2026/model-sbs.ts — side-by-side quality+speed bench. Loads one model
// (env SBS_MODEL), translates a fixed set of hard/diverse sentences through the
// SAME pipeline path (glossary→freeze→translate→restore→validate), prints the
// Chinese output + tok/s so two models can be eyeballed and timed head-to-head.
import path from 'node:path'
import { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } from '../../electron/models/llama-engine'
import { expandAbbreviations } from '../../electron/pdf/capture/glossary'
import { freezeProtected, restorePlaceholders } from '../../electron/pdf'
import { validateRestored } from '../../electron/pdf/validate'

const ROOT = process.cwd()
const MODEL = path.join(ROOT, 'models', process.env.SBS_MODEL ?? 'Qwen3-1.7B-Q4_K_M.gguf')

const SENTENCES = [
  'Because on-call rotations compress the feedback loop between the people who build a service and the people who operate it, engineers who carry a pager tend to write more reliable code and design for failure from the first commit.',
  'The EM coached two ICs who later became VP candidates, and she tracked OKRs to prove the ROI of the CI/CD investment.',
  'This practice is not uncommon in smaller teams, though it is far from ideal.',
  'A $1M budget and a €250K overrun followed within one fiscal year; latency dropped from 350ms to 45ms, an 87% improvement.',
  'Best Practices for Leading Distributed Teams Remotely',
  'Unless the team trusts its manager, no process change will stick, however elegant the tooling.',
  'The report covers pages 12-45 and chapters 2 through 4, referencing (Greenleaf, 1977; Pressman, 2006).'
]

async function main() {
  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true, id: path.basename(MODEL) })
  await engine.load(MODEL, { device: (process.env.SBS_DEVICE as any) ?? 'gpu', threads: 12, contextSize: 4096 })
  let totalTok = 0, totalMs = 0
  console.log(`\n===== ${path.basename(MODEL)} =====`)
  for (const src of SENTENCES) {
    const { text: masked, placeholders } = freezeProtected(expandAbbreviations(src))
    const res = await engine.translate(masked, {})
    const out = restorePlaceholders(res.text, placeholders).trim()
    totalTok += res.tokens; totalMs += res.timeMs
    const ok = validateRestored(src, out).ok
    console.log(`\n[${ok ? 'OK ' : 'VAL-FAIL'} ${res.tokens}tok ${res.timeMs}ms] ${src.slice(0, 48)}...`)
    console.log(`   → ${out}`)
  }
  console.log(`\naggregate: ${totalTok} tok / ${totalMs} ms = ${(totalTok / (totalMs / 1000)).toFixed(1)} tok/s`)
  await engine.dispose()
}
main().catch((e) => { console.error(e); process.exit(1) })
