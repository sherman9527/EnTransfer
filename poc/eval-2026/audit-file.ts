// poc/eval-2026/audit-file.ts — capture audit on ANY pdf (env PDF_PATH, PAGE_LIMIT).
// Reports extraction shape + C1 layout-pass behavior for cross-corpus validation.
import path from 'node:path'
import { captureFlow } from '../../electron/pdf/capture/flow'

async function main() {
  const pdf = path.resolve(process.env.PDF_PATH ?? '.scratch/delta.pdf')
  const limit = Number(process.env.PAGE_LIMIT ?? 50)
  const t0 = Date.now()
  const { blocks, pageCount, imageCount } = await captureFlow(pdf, { pageLimit: limit })
  const byType: Record<string, number> = {}
  for (const b of blocks) byType[b.type] = (byType[b.type] ?? 0) + 1
  const startsLower = blocks.filter((b) => b.type === 'paragraph' && /^[a-z]/.test(b.text ?? '')).length
  const tiny = blocks.filter((b) => b.type === 'paragraph' && (b.text ?? '').length < 25).length
  console.log(JSON.stringify({
    pdf: path.basename(pdf), pages: pageCount, ms: Date.now() - t0,
    blocks: blocks.length, byType, imageCount, startsLower, tinyParas: tiny
  }, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
