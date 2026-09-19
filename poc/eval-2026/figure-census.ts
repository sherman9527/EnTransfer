// poc/eval-2026/figure-census.ts — classify WHY figures are missing, so the C1
// (region-rasterization) decision is data-driven:
//   per page that contains a "Figure N." caption, count:
//     - matched bitmaps (what we currently ship)
//     - image placements seen by pdfjs (OPS paintImage)
//     - skipped image XObjects by filter+colorspace (CMYK / CCITTFax / JPX / bpc)
//     - vector drawing ops (constructPath/stroke/fill = figure is drawn, not a bitmap)
// Bucket each captioned figure so we know how much is recoverable by (a) decoding
// stubborn bitmaps vs (b) rasterizing vector regions (needs a canvas).
import path from 'node:path'
import fs from 'node:fs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.js'
import { PDFDocument } from 'pdf-lib'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')

async function main() {
  const data = new Uint8Array(fs.readFileSync(INPUT))
  const pdf = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise

  // Which pages carry a "Figure N." caption?
  const captionPages = new Set<number>()
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    const txt = tc.items.map((i: any) => i.str).join(' ')
    if (/\bFigure\s+\d+[.\d]*/i.test(txt)) captionPages.add(p)
    await page.cleanup()
  }

  // pdf-lib: enumerate image XObjects + their filter/colorspace/bpc.
  const lib = await PDFDocument.load(data, { ignoreEncryption: true })
  const skippedByReason: Record<string, number> = {}
  let totalImageXObjects = 0
  for (const obj of (lib as any).context.allObjects?.() ?? []) {
    if (!obj || typeof obj.dict !== 'object') continue
  }
  // (deep XObject walk is fiddly; rely on placement+vector split below instead)

  // pdfjs per captioned page: placements (paintImage ops) vs vector drawing ops.
  const IMG_OPS = new Set<number>([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject])
  let vectorOnly = 0, hasPlacement = 0, mixed = 0
  const vectorDensePages: number[] = []
  for (const p of captionPages) {
    const page = await pdf.getPage(p)
    const ol = await page.getOperatorList()
    let placements = 0
    let drawOps = 0
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i]
      if (IMG_OPS.has(fn)) placements++
      else if (fn === OPS.constructPath || fn === OPS.stroke || fn === OPS.fill || fn === OPS.fillEvenOdd || fn === OPS.closePath) drawOps++
    }
    if (placements === 0 && drawOps > 20) { vectorOnly++; if (vectorDensePages.length < 12) vectorDensePages.push(p) }
    else if (placements > 0) hasPlacement++
    await page.cleanup()
  }

  console.log(JSON.stringify({
    captionedPages: captionPages.size,
    pagesWithBitmapPlacements: hasPlacement,
    pagesVectorOnly: vectorOnly,
    sampleVectorPages: vectorDensePages,
    totalImageXObjects
  }, null, 2))
  await pdf.destroy()
}
main().catch((e) => { console.error(e); process.exit(1) })
