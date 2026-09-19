// quality-cases.ts — E5: adversarial translation regression suite.
// Each case runs through the FULL production stack (expand → freeze → engine
// → restore) exactly like pipeline.translateText, then deterministic predicates
// decide pass/fail. Goal: a machine-checkable quality baseline for model swaps
// and prompt changes — no vibes.
import path from 'node:path'
import fs from 'node:fs'
import { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } from '../../electron/models/llama-engine'
import { expandAbbreviations } from '../../electron/pdf/capture/glossary'
import { freezeProtected, restorePlaceholders } from '../../electron/pdf'
import { validateRestored, validateModelOutput } from '../../electron/pdf/validate'

const ROOT = process.cwd()
const MODEL = path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf')

interface Case {
  id: string
  cat: string
  src: string
  checks: Array<{ name: string; p: (out: string) => boolean }>
}

const CJK = /[一-鿿]/
const ck = (name: string, p: (o: string) => boolean) => ({ name, p })

const CASES: Case[] = [
  { id: 'num1', cat: 'numbers', src: 'The cluster holds 4,096 items across 128 nodes and 32 racks.', checks: [ck('cjk', (o) => CJK.test(o)), ck('4096', (o) => /4[,，]?096|4096/.test(o)), ck('128', (o) => /128/.test(o)), ck('32', (o) => /32/.test(o))] },
  { id: 'num2', cat: 'numbers', src: 'Latency dropped from 350ms to 45ms, a 87% improvement.', checks: [ck('cjk', (o) => CJK.test(o)), ck('350', (o) => /350/.test(o)), ck('45', (o) => /45/.test(o)), ck('87', (o) => /87/.test(o))] },
  { id: 'sec', cat: 'numbers', src: 'See section 3.2.8 for the rollback policy.', checks: [ck('cjk', (o) => CJK.test(o)), ck('3.2.8', (o) => /3\.2\.8/.test(o))] },
  { id: 'neg1', cat: 'negation', src: 'This practice is not uncommon in smaller teams, though it is far from ideal.', checks: [ck('cjk', (o) => CJK.test(o)), ck('neg', (o) => /不|未|非|无/.test(o))] },
  { id: 'neg2', cat: 'negation', src: 'The paper used for archival binding must be acid-free.', checks: [ck('cjk', (o) => CJK.test(o)), ck('no-acid', (o) => /无酸|不含酸|酸性/.test(o))] },
  { id: 'neg3', cat: 'negation', src: 'Nothing stopped the deployment from failing silently.', checks: [ck('cjk', (o) => CJK.test(o)), ck('neg', (o) => /没|未|无|不/.test(o))] },
  { id: 'url1', cat: 'url', src: 'For details visit https://example.com/docs/guide-v2#setup before filing an issue.', checks: [ck('cjk', (o) => CJK.test(o)), ck('url', (o) => o.includes('https://example.com/docs/guide-v2#setup'))] },
  { id: 'url2', cat: 'url', src: 'Reach us at team@manning.example.com or www.manning.com anytime.', checks: [ck('urlmail', (o) => o.includes('team@manning.example.com')), ck('urlweb', (o) => o.includes('www.manning.com'))] },
  { id: 'cond1', cat: 'conditional', src: 'If the build fails twice in a row, the pipeline halts and notifies the on-call engineer.', checks: [ck('cjk', (o) => CJK.test(o)), ck('if', (o) => /如|若|假如|一旦/.test(o))] },
  { id: 'cond2', cat: 'conditional', src: 'Unless the team trusts its manager, no process change will stick.', checks: [ck('cjk', (o) => CJK.test(o)), ck('unless', (o) => /除非|如果不|若不/.test(o))] },
  { id: 'abbr1', cat: 'terminology', src: 'The EM coached two ICs who later became VP candidates.', checks: [ck('em', (o) => /工程经理|工程管理/.test(o)), ck('ic', (o) => /个人贡献者|个体贡献者/.test(o)), ck('vp', (o) => /副总裁/.test(o))] },
  { id: 'abbr2', cat: 'terminology', src: 'We track OKRs and KPIs to prove ROI of the CI/CD investment.', checks: [ck('okr', (o) => /OKR|目标与关键结果/.test(o)), ck('kpi', (o) => /KPI|关键绩效/.test(o)), ck('roi', (o) => /ROI|投资回报/.test(o))] },
  { id: 'cite1', cat: 'citation', src: 'Servant leadership remains contested (Greenleaf, 1977; Pressman, 2006).', checks: [ck('cjk', (o) => CJK.test(o)), ck('g1977', (o) => /Greenleaf/.test(o) && /1977/.test(o)), ck('p2006', (o) => /Pressman/.test(o) && /2006/.test(o))] },
  { id: 'figref', cat: 'caption', src: 'Figure 6.1 shows the three-phase transition described below.', checks: [ck('cjk', (o) => CJK.test(o)), ck('fig', (o) => /图\s*6\.1|Figure\s*6\.1/.test(o))] },
  { id: 'cell1', cat: 'table-cell', src: 'Q3 revenue growth', checks: [ck('cjk', (o) => CJK.test(o)), ck('Q3', (o) => /Q3|三季度|第三季度/.test(o))] },
  { id: 'passive', cat: 'wordness', src: 'The legacy API was deprecated in favor of a gRPC interface two quarters ago.', checks: [ck('cjk', (o) => CJK.test(o)), ck('not-echo-deprecated', (o) => !/deprecated/.test(o))] },
  { id: 'longctx', cat: 'long-context', src: 'Because on-call rotations compress the feedback loop between the people who build a service and the people who operate it, engineers who carry a pager tend to write more reliable code, prefer boring technology, and design for failure from the first commit, which is why many organizations pair feature work with operational duty instead of separating them into different teams.', checks: [ck('cjk', (o) => CJK.test(o)), ck('ratio', (o) => o.length > 100), ck('pager', (o) => /值班|寻呼|随叫随到|待命/.test(o))] },
  { id: 'order1', cat: 'structure', src: 'First, run the test suite. Second, stage the artifact. Finally, notify stakeholders.', checks: [ck('cjk', (o) => CJK.test(o)), ck('seq', (o) => /首先|第一/.test(o) && /其次|第二|然后/.test(o) && /最后|最终/.test(o))] },
  { id: 'q1', cat: 'structure', src: 'Does delegation erode technical skills over time?', checks: [ck('cjk', (o) => CJK.test(o)), ck('quest', (o) => /？|\?/.test(o))] },
  { id: 'quot', cat: 'punctuation', src: '“Done is better than perfect,” the design lead often reminded the team.', checks: [ck('cjk', (o) => CJK.test(o)), ck('quote-keep', (o) => /[“”"«]/.test(o)), ck('no-stray', (o) => !/”\s*$/.test(o.trim()) || CJK.test(o))] },
  { id: 'money', cat: 'numbers', src: 'A $1M budget and a €250K overrun followed within one fiscal year.', checks: [ck('cjk', (o) => CJK.test(o)), ck('1M', (o) => /\$1M|100\s*万|1M/.test(o)), ck('250K', (o) => /250K|25\s*万|€250K/.test(o))] },
  { id: 'code', cat: 'identifier', src: 'Run `kubectl apply -f pod.yaml` before restarting the daemon.', checks: [ck('cjk', (o) => CJK.test(o)), ck('cmd', (o) => o.includes('kubectl apply -f pod.yaml'))] },
  { id: 'listfrag', cat: 'table-cell', src: 'Onboarding checklist: laptop, accounts, badge.', checks: [ck('cjk', (o) => CJK.test(o)), ck('three', (o) => /笔记本/.test(o) && /账户|账号/.test(o) && /工牌|徽章|胸卡/.test(o))] },
  { id: 'det2', cat: 'determinism-pair', src: 'The OKR review exposed misaligned incentives between platform and product teams.', checks: [ck('cjk', (o) => CJK.test(o))] },
  { id: 'titlecase', cat: 'wordness', src: 'Best Practices for Leading Distributed Teams Remotely', checks: [ck('cjk', (o) => CJK.test(o)), ck('not-all-latin', (o) => o.replace(/[A-Za-z]/g, '').length > 3)] },
  { id: 'range', cat: 'numbers', src: 'The report covers pages 12-45 and chapters 2 through 4.', checks: [ck('cjk', (o) => CJK.test(o)), ck('12-45', (o) => /12\s*(?:[-–~]|至|到)\s*45/.test(o)), ck('ch', (o) => /2/.test(o) && /4/.test(o))] },
]

async function main() {
  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true })
  await engine.load(MODEL, { device: 'gpu', threads: 12, contextSize: 4096 })
  const results: Array<{ id: string; cat: string; pass: boolean; failed: string[]; valReasons: string[] }> = []
  const texts: string[] = []
  const outputs: string[] = []
  for (const c of CASES) {
    const expanded = expandAbbreviations(c.src)
    const { text: masked, placeholders } = freezeProtected(expanded)
    const raw = (await engine.translate(masked, {})).text.trim()
    const out = restorePlaceholders(raw, placeholders).trim()
    texts.push(c.src); outputs.push(out)
    const vm = validateModelOutput(masked, raw)
    const vr = validateRestored(c.src, out)
    const failed: string[] = []
    for (const chk of c.checks) if (!chk.p(out)) failed.push(chk.name)
    results.push({ id: c.id, cat: c.cat, pass: failed.length === 0, failed, valReasons: [...(vm.ok ? [] : vm.reasons), ...(vr.ok ? [] : vr.reasons)] })
    const tag = failed.length === 0 ? 'PASS' : `FAIL[${failed}]`
    console.log(`${tag.padEnd(14)} ${c.id.padEnd(10)} ${out.slice(0, 70)}`)
  }
  // determinism pair: same input twice must translate identically at temp 0.1
  const dup = expandAbbreviations(CASES[23].src)
  const { text: dm, placeholders: dp } = freezeProtected(dup)
  const dupOut = restorePlaceholders((await engine.translate(dm, {})).text.trim(), dp).trim()
  const identical = dupOut === outputs[23]
  console.log(`\nsuite: ${results.filter((r) => r.pass).length}/${results.length} pass; validator would-flag: ${results.filter((r) => r.valReasons.length > 0).length}`)
  console.log(`determinism repeat: ${identical ? 'IDENTICAL' : 'DIVERGED'}`)
  console.log(JSON.stringify(results, null, 2))
  await engine.dispose()
}
main().catch((e) => { console.error(e); process.exit(1) })
