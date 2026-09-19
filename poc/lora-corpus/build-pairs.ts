// build-pairs.ts — align two harvested segment files (an English book + its
// genuine Chinese translation) into high-precision (EN, ZH) parallel pairs and
// emit SFT-ready JSONL.
//
//   node poc/lora-corpus/build-pairs.cjs <en.json> <zh.json> <out.jsonl> [--min=2.0]
//
// Why not a global length/diagonal aligner: the two books have very different
// segment counts (English front matter + line-splits inflate EN ~2x), so any
// proportional diagonal maps unrelated paragraphs together. The reliable signal
// is RARE technical tokens that survive translation verbatim (MeterProvider,
// Kubernetes, Flowmill, section numbers). So:
//   1. build an edge (i,j) for every EN[i]~ZH[j] that share >=1 rare token
//      (idf >= floor), weighted by summed idf of the shared anchors;
//   2. keep only prose pairs (Latin EN, Han ZH) passing a LOOSE length sanity band;
//   3. select the max-weight NON-CROSSING 1:1 chain (weighted LIS on j, i asc) —
//      this enforces document order and forbids one segment matching many.
// Precision-first: recall is modest, but emitted pairs are genuinely aligned.
import fs from 'node:fs'
import path from 'node:path'

interface Seg { page: number; text: string }

const en = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')).segments as Seg[]
const zh = JSON.parse(fs.readFileSync(process.argv[3]!, 'utf8')).segments as Seg[]
const out = process.argv[4] ?? 'poc/lora-corpus/gold.pairs.jsonl'
const minArg = process.argv.find((a) => a.startsWith('--min='))
const W_MIN = minArg ? Number(minArg.split('=')[1]) : 2.0 // min summed rare-anchor idf

const CJKRANGE = '⺀-⻿⼀-⿟　-〿一-鿿豈-'
function cjkLen(s: string): number { return s.replace(/\s+/g, '').length }
function isLatin(s: string): boolean {
  const letters = (s.match(/[A-Za-z]/g) || []).length
  return letters >= 12 && letters > cjkLen(s) * 0.6
}
function isHan(s: string): boolean { return (s.match(new RegExp(`[${CJKRANGE}]`, 'g')) || []).length >= 8 }
// book index / TOC / table-row noise: EN index = "word, 12, word, 34-56"; ZH/EN
// table rows are token-dense with few connective chars. Drop these so they can't
// echo-match real prose on a shared identifier like "service.version".
function isIndexy(s: string): boolean { return (s.match(/[,，]\s*\d[\d\-–,，\s]{3,}/g) || []).length >= 2 }
function isTabley(s: string): boolean {
  const c = cjkLen(s)
  const toks = (s.match(/[A-Za-z][\w.]{3,}|\d[\d.]*/g) || []).length
  return c > 0 && toks / c > 0.12 // identifier/number density too high for prose
}
function isCode(s: string): boolean {
  return (s.match(/[{}();=]{2,}|=>|\bfunc\b|\bfunc \(|\bdef \b|\bimport \b|\breturn\b|package \w+|\.go\b|\bctx\b/g) || []).length >= 2
}
function tokens(s: string): Set<string> {
  const t = new Set<string>()
  for (const m of s.match(/[A-Za-z][A-Za-z0-9]{4,}|[A-Za-z]*\d[\d.]*[A-Za-z0-9.]*/g) || []) {
    const k = m.toLowerCase().replace(/[._]+$/, '')
    if (k.length >= 5 || /\d\.\d/.test(k)) t.add(k)
  }
  return t
}
const enTok = en.map((s) => tokens(s.text))
const zhTok = zh.map((s) => tokens(s.text))
const df = new Map<string, number>()
for (const set of [...enTok, ...zhTok]) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
const totalDocs = en.length + zh.length
const IDF_FLOOR = Math.log(1 / 0.12) // token in <=12% of docs is an anchor
function idf(t: string): number { return Math.log(totalDocs / (df.get(t) ?? 1)) }

// build candidate edges
interface Edge { i: number; j: number; w: number }
const edges: Edge[] = []
for (let i = 0; i < en.length; i++) {
  if (!isLatin(en[i].text) || isIndexy(en[i].text) || isTabley(en[i].text) || isCode(en[i].text)) continue
  const e = cjkLen(en[i].text)
  if (e < 20) continue
  for (let j = 0; j < zh.length; j++) {
    if (!isHan(zh[j].text) || isIndexy(zh[j].text) || isTabley(zh[j].text)) continue
    const z = cjkLen(zh[j].text)
    if (z < 8) continue
    const r = e / z
    if (r < 1.2 || r > 8) continue // loose EN:ZH char-ratio sanity (Han ~2-3x denser)
    let w = 0
    let anchors = 0
    for (const t of enTok[i]) if (zhTok[j].has(t) && idf(t) >= IDF_FLOOR) { w += idf(t); anchors++ }
    if (anchors >= 1 && w >= W_MIN) edges.push({ i, j, w })
  }
}
// weighted non-crossing 1:1 chain: sort by i asc (tie j asc), LIS on j
edges.sort((a, b) => a.i - b.i || a.j - b.j)
const K = edges.length
const dp: number[] = new Array(K)
const prev: number[] = new Array(K).fill(-1)
for (let k = 0; k < K; k++) {
  dp[k] = edges[k].w
  for (let m = 0; m < k; m++) {
    if (edges[m].i < edges[k].i && edges[m].j < edges[k].j && dp[m] + edges[k].w > dp[k]) {
      dp[k] = dp[m] + edges[k].w; prev[k] = m
    }
  }
}
let best = -1
for (let k = 0; k < K; k++) if (best < 0 || dp[k] > dp[best]) best = k
const chain: Edge[] = []
for (let k = best; k >= 0; k = prev[k]) chain.push(edges[k])
chain.reverse()

const SYSTEM = '你是专业的技术图书英译中译者。将下面的英文翻译成流畅、准确的简体中文，保留术语、标识符、URL 与数字，不翻译代码。'
const lines = chain.map((p) => JSON.stringify({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: en[p.i].text },
    { role: 'assistant', content: zh[p.j].text }
  ]
}))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, lines.join('\n') + '\n')
fs.writeFileSync(out.replace(/\.jsonl$/, '.align.json'), JSON.stringify({ enSegs: en.length, zhSegs: zh.length, edges: K, kept: chain.length }, null, 2))
console.log(`edges=${K} -> monotone chain=${chain.length} / ${en.length}·${zh.length} (W_MIN ${W_MIN}) -> ${out}`)
for (const p of chain.filter((_, k) => k % Math.max(1, Math.ceil(chain.length / 8)) === 0).slice(0, 8)) {
  console.log(`\n[${p.w.toFixed(1)}] EN: ${en[p.i].text.slice(0, 80)}`)
  console.log(`        ZH: ${zh[p.j].text.slice(0, 60)}`)
}
