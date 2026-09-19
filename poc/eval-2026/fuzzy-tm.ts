// poc/eval-2026/fuzzy-tm.ts — C4 A/B: does a fuzzy cross-run translation memory
// add meaningful, quality-safe hits over our EXACT content-addressed cache?
//
// We already reuse exact (model|prompt|temp|src|masked) matches. pdfzh §7.4 adds
// FUZZY reuse (normalized edit-similarity >= 0.92 -> skip the model). This test
// measures, over the real book's unit stream:
//   - exact-repeat rate (what our cache already captures)
//   - ADDITIONAL fuzzy-only hits (the incremental win)
//   - sample of fuzzy-only pairs + similarity, to judge whether reuse is SAFE
//     (a near-dup with different meaning/tense would make reuse a quality bug)
// No model, no IO beyond the PDF. Run from repo root.
import path from 'node:path'
import { captureFlow, type ContentBlock } from '../../electron/pdf/capture/flow'

const ROOT = process.cwd()
const BOOK = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const FUZZY_THRESHOLD = 0.92

function sources(blocks: ContentBlock[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.type === 'code' || b.type === 'image' || b.type === 'table' || b.type === 'formula') continue
    if (b.type === 'list') { for (const it of b.items ?? []) if (it.trim()) out.push(it.trim()) }
    else if ((b.text ?? '').trim()) out.push(b.text!.trim())
  }
  return out
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

// normalized Levenshtein similarity via rolling DP (bounded by length)
function similarity(a: string, b: string): number {
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  // early reject: length ratio already below threshold
  if (Math.min(a.length, b.length) / maxLen < FUZZY_THRESHOLD) return 0
  const m = a.length, n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const t = prev; prev = curr; curr = t
  }
  return 1 - prev[n] / maxLen
}

async function main() {
  const { blocks } = await captureFlow(BOOK, {})
  const srcs = sources(blocks)
  const norm = srcs.map(normalize)
  const seenExact = new Map<string, number>()
  const prior: Array<{ norm: string; idx: number }> = []
  let exactHits = 0
  let fuzzyOnlyHits = 0
  const samples: Array<{ sim: number; a: string; b: string }> = []
  for (let i = 0; i < srcs.length; i++) {
    const key = norm[i]
    if (seenExact.has(key)) { exactHits++; continue }
    seenExact.set(key, i)
    // fuzzy against prior (skip exact-equal, already handled)
    let best = 0
    let bestIdx = -1
    for (const p of prior) {
      const s = similarity(key, p.norm)
      if (s > best) { best = s; bestIdx = p.idx }
    }
    if (best >= FUZZY_THRESHOLD && bestIdx >= 0) {
      fuzzyOnlyHits++
      if (samples.length < 25) samples.push({ sim: +best.toFixed(3), a: srcs[bestIdx], b: srcs[i] })
    }
    prior.push({ norm: key, idx: i })
  }
  const total = srcs.length
  console.log(JSON.stringify({
    totalUnits: total,
    distinctExact: seenExact.size,
    exactRepeatRate: +((exactHits / total) * 100).toFixed(1),
    fuzzyOnlyHits,
    fuzzyOnlyRate: +((fuzzyOnlyHits / total) * 100).toFixed(1),
    combinedReuseRate: +(((exactHits + fuzzyOnlyHits) / total) * 100).toFixed(1)
  }, null, 2))
  console.log('--- fuzzy-only samples (judge reuse safety) ---')
  for (const s of samples) console.log(`[${s.sim}] A: ${s.a.slice(0, 60)}\n      B: ${s.b.slice(0, 60)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
