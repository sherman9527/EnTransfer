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
const SYSTEM = process.env.SBS_SYSTEM === 'fewshot' ? FEWSHOT_SYSTEM : GENERIC_SYSTEM_PROMPT

// few-shot candidate: domain disambiguation + 2 examples, targeting the
// team->球队 / manager->教练 polysemy Qwen3 showed. Kept short so the shared
// system prefix stays cheap under prefix-KV reuse.
export const FEWSHOT_SYSTEM = [
  'Translate the following English text to Simplified Chinese. Output only the translation, no explanation.',
  'In technical and management contexts: team=团队 (not 球队), manager=经理/管理者 (not 教练), ship=交付, release=发布.',
  'Example:',
  'EN: The engineering manager leads her team to ship reliable software and owns the on-call rotation.',
  'ZH: 工程经理带领她的团队交付可靠的软件，并负责值班轮转。',
  'EN: Nothing stopped the deployment from failing silently.',
  'ZH: 没有什么能阻止这次部署悄然失败。'
].join('\n')

const SENTENCES = [
  'Unless the team trusts its manager, no process change will stick, however elegant the tooling.',
  'The manager asked each team to ship the release before the on-call rotation began.',
  'Because on-call rotations compress the feedback loop between the people who build a service and the people who operate it, engineers who carry a pager tend to write more reliable code and design for failure from the first commit.',
  'The EM coached two ICs who later became VP candidates, and she tracked OKRs to prove the ROI of the CI/CD investment.',
  'This practice is not uncommon in smaller teams, though it is far from ideal.',
  'A $1M budget and a €250K overrun followed within one fiscal year; latency dropped from 350ms to 45ms, an 87% improvement.',
  'Best Practices for Leading Distributed Teams Remotely'
]

async function main() {
  const engine = new LlamaCppEngine({ systemPrompt: SYSTEM, disableReasoning: true, id: path.basename(MODEL) })
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
