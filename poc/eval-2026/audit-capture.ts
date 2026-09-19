// audit-capture.ts — E1: quantify OUR extraction quality on the whole book, so
// the "do we need Docling-grade semantic extraction?" decision is data-driven
// instead of vibes-driven. Measures failure classes the Qt project's ADRs claim
// matter: paragraph integrity, heading merges, over/under splitting, table
// recall (via caption census), formula leakage, reading-order regressions, and
// image extraction yield (placements vs matched).
import path from 'node:path'
import { captureFlow } from '../../electron/pdf/capture/flow'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')

interface Audit {
  totalBlocks: number
  paragraphs: number
  startsLowercase: { n: number; samples: string[] }
  noTerminalPunct: { n: number; samples: string[] }
  headingMergedInside: { n: number; samples: string[] }
  overlongBlocks: { n: number; max: number }
  tinyParagraphs: number
  headings: number
  lists: number
  codeBlocks: number
  tablesDetected: number
  tableCaptionsInText: number          // "Table N." caption paragraphs = recall proxy
  figureCaptionsInText: number
  formulaLeakIntoParagraphs: number
  pageOrderRegressions: number          // block stream page number going backwards
  tocLeaks: number                      // dot-leader lines surviving filters
  imagesMatched: number
}

async function main() {
  const t0 = Date.now()
  const { blocks, pageCount, imageCount } = await captureFlow(INPUT, {})
  const a: Audit = {
    totalBlocks: blocks.length, paragraphs: 0,
    startsLowercase: { n: 0, samples: [] }, noTerminalPunct: { n: 0, samples: [] },
    headingMergedInside: { n: 0, samples: [] },
    overlongBlocks: { n: 0, max: 0 }, tinyParagraphs: 0, headings: 0, lists: 0, codeBlocks: 0,
    tablesDetected: 0, tableCaptionsInText: 0, figureCaptionsInText: 0,
    formulaLeakIntoParagraphs: 0, pageOrderRegressions: 0, tocLeaks: 0, imagesMatched: imageCount
  }
  let lastPage = 0
  for (const b of blocks) {
    if ((b.page ?? 0) < lastPage) a.pageOrderRegressions++
    lastPage = Math.max(lastPage, b.page ?? 0)
    if (b.type === 'table') { a.tablesDetected++; continue }
    if (b.type === 'heading') { a.headings++; continue }
    if (b.type === 'list') { a.lists++; continue }
    if (b.type === 'code') { a.codeBlocks++; continue }
    if (b.type === 'image' || b.type === 'formula') continue
    const t = (b.text ?? '').trim()
    if (!t) continue
    a.paragraphs++
    a.overlongBlocks.max = Math.max(a.overlongBlocks.max, t.length)
    if (t.length > 1600) a.overlongBlocks.n++
    if (t.length < 40) a.tinyParagraphs++
    if (/^[a-z]/.test(t)) {
      a.startsLowercase.n++
      if (a.startsLowercase.samples.length < 3) a.startsLowercase.samples.push(t.slice(0, 60))
    }
    if (!/[.!?:""\)%.\-]$/.test(t)) {
      a.noTerminalPunct.n++
      if (a.noTerminalPunct.samples.length < 3) a.noTerminalPunct.samples.push(t.slice(-60))
    }
    const hm = /(?<=[a-z.)"' ])\d+\.\d+(?:\.\d+)?\s+[A-Z][a-z]/.exec(t)
    if (hm) {
      a.headingMergedInside.n++
      if (a.headingMergedInside.samples.length < 3) a.headingMergedInside.samples.push(t.slice(Math.max(0, hm.index - 30), hm.index + 50))
    }
    if ((t.match(/[∑∫√∞≈≠≤≥±×÷∂∆∏]/g) ?? []).length >= 2) a.formulaLeakIntoParagraphs++
    if (/\.{5,}\s*\d+\s*($|\s)/.test(t)) a.tocLeaks++
    if (/^(Table|图)\s*\d+[.:]/i.test(t)) a.tableCaptionsInText++
    if (/^(Figure|Fig\.)\s*\d+/i.test(t)) a.figureCaptionsInText++
  }
  console.log(`pages=${pageCount} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(JSON.stringify(a, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
