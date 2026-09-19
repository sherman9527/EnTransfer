/**
 * electron/regression.__test__.ts — anti-regression suite for confirmed bugs.
 *
 * EVERY case here is a real bug that shipped and was fixed (R-numbers match
 * docs/REGRESSION.md). The rule for future work: a fix is not done until its
 * red case lives in this file. Pure TS only — no Electron, no models, no PDF
 * IO — so it runs in <1s.
 *
 * Run (from the project root):
 *   npm test
 * or: node electron/regression.__test__.ts
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { joinBatch, splitBatch } from './batch-format.ts'
import { isGarbageText, garbageRatio } from './text-garbage.ts'
import { validateModelOutput, validateRestored } from './pdf/validate.ts'
import { TranslationCache } from './models/translation-cache.ts'
import { isHardwareError } from './models/engine-errors.ts'
import { joinFragments, isRunningFurniture } from './pdf/capture/line-utils.ts'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

// ---------------------------------------------------------------------------
// R1 — batch parser must refuse empty slots (paragraph-loss bug)
// ---------------------------------------------------------------------------
console.log('R1 batch-format: empty-slot refusal')
{
  const ok = splitBatch('1. 第一\n2. 第二', 2)
  check('normal split returns parts', ok !== null && ok[0] === '第一' && ok[1] === '第二')
  check('bare number "2." with no content → null (not ["第一",""])', splitBatch('1. 第一\n2.', 2) === null)
  check('missing item → null', splitBatch('1. 第一', 2) === null)
  check('continuation lines folded', (() => {
    const r = splitBatch('1. 第一\n接上句\n2. 第二', 2)
    return r !== null && r[0] === '第一 接上句'
  })())
  check('reordered numbering maps by number', (() => {
    const r = splitBatch('2. 第二\n1. 第一', 2)
    return r !== null && r[0] === '第一' && r[1] === '第二'
  })())
  check('duplicate number folds content, loses nothing', (() => {
    const r = splitBatch('1. A\n1. B\n2. C', 2)
    return r !== null && r[0] === 'A B' && r[1] === 'C'
  })())
  check('joinBatch roundtrip', joinBatch(['a b', 'c d']) === '1. a b\n2. c d')
}

// ---------------------------------------------------------------------------
// R4 — validateRestored: magnitude exemption must not excuse arbitrary loss
// ---------------------------------------------------------------------------
console.log('R4 numbers: tightened magnitude rewrite')
{
  const en = 'The budget was $1,000,000 and the team had 120 engineers across 32 offices.'
  // legitimate Chinese magnitude rewrite (100万 for 1,000,000)
  const good = validateRestored(en, '预算为 100万，团队有 120 名工程师分布在 32 个办公室。')
  check('magnitude rewrite passes', good.ok)
  // multi-number round rewrite (roundRewrite path: >1 dropped, all round thousands)
  const rounds = validateRestored('Contracts worth $2,000,000 and $3,000,000 were signed.', '签约合同总价值 200万 与 300万。')
  check('round-thousands rewrites with 万 pass', rounds.ok)
  // arbitrary non-round numbers dropped while 千/万 words present → must FAIL
  const bad = validateRestored('The ratio 3.7 beat 2.4 by margin in region 47 with cohort 12.', '地区的比率优于千分比。')
  check('non-round dropped numbers NOT excused by 万/千 presence', !bad.ok && bad.reasons.some((r) => r.startsWith('number-dropped')))
  // latin output must keep every number
  const latin = validateRestored('Set the timeout to 30 seconds and 5 retries.', 'Set the timeout to seconds and retries.')
  check('latin output dropping numbers fails', !latin.ok && latin.reasons.some((r) => r.startsWith('number-dropped')))
  // single dropped number in Chinese still tolerated (第十二章 case)
  const single = validateRestored('Chapter 12 explains caching in depth for engineers.', '第十二章详细讲解了缓存机制。')
  check('single dropped number tolerated in Chinese', single.ok)
}

// ---------------------------------------------------------------------------
// R7 — sentinel multiset: hallucinated/extra tokens now flagged
// ---------------------------------------------------------------------------
console.log('R7 sentinels: lost + extra')
{
  check('lost sentinel flagged', !validateModelOutput('keep §A§ and §B§ here', '保留 和 这里 §A§').ok)
  check('extra/hallucinated sentinel flagged', !validateModelOutput('no placeholders', '没有 §A§ 占位符').ok)
  check('duplicate sentinel flagged as extra', !validateModelOutput('keep §A§', '保留 §A§ 再加 §A§').ok)
  check('clean pass', validateModelOutput('keep §A§', '保留 §A§ 内容').ok)
}

// ---------------------------------------------------------------------------
// R8 — shared /g regex statefulness must never return
// ---------------------------------------------------------------------------
console.log('R8 sentinel-leak probe is stateless across calls')
{
  const src = 'This is a long enough English sentence that clearly wants translation work.'
  const leaky = '这是一句话 §A§'
  const a = validateRestored(src, leaky)
  const b = validateRestored(src, leaky)
  check('same input, same verdict (no lastIndex drift)', a.ok === b.ok && !a.ok)
  const c = validateRestored(src, '这是一句正常且完整的中文译文。')
  check('clean output after leaky call still ok', c.ok)
}

// ---------------------------------------------------------------------------
// R2 — cache key must cover every output-affecting input
// ---------------------------------------------------------------------------
console.log('R2 cache key: temperature/model/prompt sensitivity')
{
  const base = { modelId: 'qwen3-1.7b-q4_k_m', promptVersion: 'p1-numbered', temperature: 0.1, source: 'text', masked: 'text' }
  check('different temperature → different key', TranslationCache.hashKey(base) !== TranslationCache.hashKey({ ...base, temperature: 0.7 }))
  check('different quant-in-modelId → different key', TranslationCache.hashKey(base) !== TranslationCache.hashKey({ ...base, modelId: 'qwen3-1.7b-q3_k_m' }))
  check('different promptVersion → different key', TranslationCache.hashKey(base) !== TranslationCache.hashKey({ ...base, promptVersion: 'p0' }))
}

// ---------------------------------------------------------------------------
// R9 — concurrent puts of the same key leave no temp residue
// ---------------------------------------------------------------------------
console.log('R9 cache: concurrent same-key puts')
{
  const dir = await mkdtemp(join(tmpdir(), 'entransfer-cache-'))
  try {
    const cache = new TranslationCache(dir)
    const hash = TranslationCache.hashKey({ modelId: 'm', promptVersion: 'p', temperature: 0.1, source: 's', masked: 's' })
    await Promise.all([cache.put(hash, '译文一', 3), cache.put(hash, '译文二', 3)])
    const hit = await cache.get(hash)
    check('entry readable after concurrent puts', hit !== null && ['译文一', '译文二'].includes(hit.translated))
    const shardFiles = await readdir(join(dir, hash.slice(0, 2)))
    check('no .tmp residue', shardFiles.every((f) => !f.includes('.tmp')))
    check('exactly one json', shardFiles.filter((f) => f.endsWith('.json')).length === 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// R6 — hardware-error classification gates the CPU demotion
// ---------------------------------------------------------------------------
console.log('R6 failover: error classification')
{
  check('device lost → hardware', isHardwareError('LlamaRuntimeError: Vulkan error VK_ERROR_DEVICE_LOST'))
  check('VRAM OOM → hardware', isHardwareError('out of memory allocating 1024 MB'))
  check('generic generation error → NOT hardware', !isHardwareError('Grammar validation failed: parser error at byte 4'))
  check('empty/undefined-ish → NOT hardware', !isHardwareError(String(undefined)))
}

// ---------------------------------------------------------------------------
// R15 — garbage-node filter (pdfzh §6.3 borrow): undecodable text never
// reaches the model (it "translates" into plausible-looking junk)
// ---------------------------------------------------------------------------
console.log('R15 garbage filter: undecodable-font gate')
{
  check('replacement chars >20% → garbage', isGarbageText('This is \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD broken text here'))
  check('private-use-area run → garbage', isGarbageText('\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007 some readable words'))
  check('single \uFFFD in long clean paragraph → NOT garbage', !isGarbageText('The engineering manager ships software through her team and one \uFFFD stray replacement char in a long sentence stays below threshold.'))
  check('normal prose → NOT garbage', !isGarbageText('Agile teams iterate on working software and gather feedback every sprint.'))
  check('empty/whitespace → NOT garbage (handled upstream)', !isGarbageText('   '))
  check('ratio is bounded 0..1', garbageRatio('\uFFFD\uFFFD') <= 1 && garbageRatio('abc') >= 0)
}

// R17 — word-breaking / space corruption (gap analysis #1): join fragments by
// real horizontal gap, not by embedded spaces. "The"+"Data" (word gap) must get
// a space; "Generat"+"ed" (kerning split, no gap) must NOT.
console.log('R17 fragment join: geometry-based spacing')
{
  const fs = 10
  // word boundary: "The"@0 w20 -> end20, "Data"@26 -> gap 6 > 1.8 -> space
  check('word gap -> space', joinFragments([{ str: 'The', x: 0, width: 20 }, { str: 'Data', x: 26, width: 24 }], fs) === 'The Data')
  // kerning split: "Generat"@0 w40 -> end40, "ed"@41 -> gap 1 < 1.8 -> no space
  check('kerning split -> no space', joinFragments([{ str: 'Generat', x: 0, width: 40 }, { str: 'ed', x: 41, width: 8 }], fs) === 'Generated')
  // phantom space inside an item string must be re-derived, not trusted blindly
  check('embedded space w/o gap -> removed', joinFragments([{ str: 'Column ', x: 0, width: 30 }, { str: 's', x: 31, width: 4 }], fs) === 'Columns')
  // single clean item passes through unchanged
  check('single item unchanged', joinFragments([{ str: 'lakehouse architecture', x: 0, width: 100 }], fs) === 'lakehouse architecture')
}

// R18 — running header/footer leak (gap analysis #2): the O'Reilly
// "<num> | <title>" footer sitting ~7% from the bottom edge must be dropped,
// including the glued "数据仓库|5" variant; ordinary prose with a "|" must not.
console.log('R18 running furniture detection')
{
  const H = 612
  check('footer "16 | Chapter 1: …" near bottom -> furniture', isRunningFurniture('16 | Chapter 1: The Evolution of Data Architectures', 42, H))
  check('glued "数据仓库|5" near bottom -> furniture', isRunningFurniture('数据仓库|5', 40, H))
  check('leading-num "6|第一章…" near bottom -> furniture', isRunningFurniture('6|第一章：数据架构的演变', 30, H))
  check('lone page number -> furniture', isRunningFurniture('16', 42, H))
  check('mid-page prose with a pipe -> NOT furniture', !isRunningFurniture('the value is x | y in this sentence about data', 300, H))
  check('real body paragraph -> NOT furniture', !isRunningFurniture('lakehouses leverage low-cost object stores like Amazon S3', 214, H))
}

// R19 — regression guard: the Roman/lone-number rule must be edge-gated, or it
// drops real short content lines that happen to be spelled with i/v/x/l/c/d/m.
console.log('R19 furniture Roman rule is edge-gated')
{
  const H = 612
  check('mid-page "mill" -> NOT furniture', !isRunningFurniture('mill', 300, H))
  check('mid-page "civic" -> NOT furniture', !isRunningFurniture('civic', 300, H))
  check('edge Roman "iv" -> furniture', isRunningFurniture('iv', 585, H))
  check('edge lone number "16" -> furniture', isRunningFurniture('16', 42, H))
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} regression check(s) FAILED`)
  process.exit(1)
}
console.log('\nall regression checks passed')
