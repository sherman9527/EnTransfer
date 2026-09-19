// verify-capture.ts — run the REAL captureFlow (current source) on a PDF and
// report whether gap #1 (word-breaking) and #2 (running furniture) are fixed.
//   node poc/gap-analysis/verify-capture.cjs "<pdf>" [pageLimit]
import { captureFlow } from '../../electron/pdf/capture/flow'
import path from 'node:path'

const pdfPath = process.argv[2]!
const limit = Number(process.argv[3] ?? 0) || undefined

async function main(): Promise<void> {
  const t0 = Date.now()
  const { blocks } = await captureFlow(path.resolve(pdfPath), limit ? { pageLimit: limit } : {})
  const paras = blocks.filter((b) => b.type === 'paragraph' || b.type === 'heading').map((b) => b.text || '')
  const total = paras.length
  // furniture still leaking: "<num>|..." or "...|<num>" or "|第..章"
  const furniture = paras.filter((t) => /^\d{1,4}\s*\|\s*\S/.test(t) || /\S\s*\|\s*\d{1,4}$/.test(t) || /\|\s*第[一二三四五六七八九十\d]+章/.test(t))
  // word-breaking: TheData-style (lowercase immediately followed by Capital, no space) in latin-heavy runs
  const runon = paras.filter((t) => /[a-z]{3}[A-Z][a-z]{3}/.test(t.replace(/[A-Z][a-z]+/g, '')) || /[a-z]{3}[A-Z][a-z]{3}/.test(t))
  // mid-word phantom space: single trailing letter after a space inside a word e.g. "Column s"
  const split = paras.filter((t) => /\b[A-Za-z]{3,} [a-z]{1,2}\b/.test(t) && /[A-Za-z]{3,} [a-z]\b/.test(t))
  console.log(`captureFlow ${((Date.now() - t0) / 1000).toFixed(1)}s  blocks=${blocks.length} prose+headings=${total}`)
  console.log(`furniture leak: ${furniture.length} (${(100 * furniture.length / total).toFixed(1)}%)`)
  console.log(`run-on (TheData): ${runon.length}`)
  console.log(`mid-word split (Column s): ${split.length}`)
  console.log('\n-- first 8 paragraphs --')
  for (const t of paras.slice(0, 8)) console.log(' •', t.slice(0, 100))
  if (furniture.length) { console.log('\n-- furniture samples --'); furniture.slice(0, 5).forEach((t) => console.log(' !', t.slice(0, 80))) }
  if (runon.length) { console.log('\n-- run-on samples --'); runon.slice(0, 5).forEach((t) => console.log(' !', t.slice(0, 90))) }
  if (split.length) { console.log('\n-- mid-word-split samples --'); split.slice(0, 12).forEach((t) => { const m = t.match(/\b[A-Za-z]{3,} [a-z]{1,2}\b/); console.log(' ?', m?.[0], '||', t.slice(0, 70)) }) }
}
main().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1) })
