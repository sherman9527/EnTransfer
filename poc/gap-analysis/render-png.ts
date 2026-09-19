// render-png.ts — rasterise selected PDF pages to PNG for visual inspection
// (pdfjs + @napi-rs/canvas, same stack the app uses). Lets us tell a real
// typesetting defect apart from a text-extraction artifact.
//   node poc/gap-analysis/render-png.cjs "<pdf>" <outDir> <scale> <page> [<page>...]
import fs from 'node:fs'
import path from 'node:path'

async function main(): Promise<void> {
  const canvasMod = await import('@napi-rs/canvas')
  const ns = await import('pdfjs-dist/legacy/build/pdf.js')
  const mod: any = (ns as any).default ?? ns
  const pdfPath = process.argv[2]!
  const outDir = process.argv[3]!
  const scale = Number(process.argv[4] ?? 2)
  const pages = process.argv.slice(5).map(Number)
  const pkgDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist')
  fs.mkdirSync(outDir, { recursive: true })
  const pdf = await mod.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    isEvalSupported: false,
    cMapUrl: path.join(pkgDir, 'cmaps') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(pkgDir, 'standard_fonts') + '/'
  }).promise
  for (const p of pages) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale })
    const canvas = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height))
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    const out = path.join(outDir, `p${p}.png`)
    fs.writeFileSync(out, canvas.toBuffer('image/png'))
    console.log('wrote', out, canvas.width + 'x' + canvas.height)
  }
}
main().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1) })
