// poc/doclayout-poc/test-render.ts — Layer-2 end-to-end: main-process render
// (pdf.js + @napi-rs/canvas) -> detect (ORT-node) -> clip render -> PNG.
// Verifies the whole C1 pass works headless in Node on a known vector-figure
// page (p57) and writes the clip PNG for eyeballing. Run from repo root.
import fs from 'node:fs'
import path from 'node:path'
import { renderForDetect, renderClip } from '../../electron/pdf/capture/page-renderer'
import { LayoutDetector, REGION_CLASSES } from '../../electron/pdf/capture/layout-detector'

async function main() {
  const pdf = path.resolve('Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
  const det = new LayoutDetector()
  const ok = await det.ensureLoaded()
  if (!ok) { console.log('detector unavailable:', det.error); process.exit(1) }
  const t0 = Date.now()
  const buf = await renderForDetect(pdf, 57, 2)
  if (!buf) { console.log('FAIL: render unavailable'); process.exit(1) }
  const boxes = await det.detect(buf.rgba, buf.renderW, buf.renderH)
  const regions = boxes.filter((b) => REGION_CLASSES.has(b.cls))
  console.log(`render+detect in ${Date.now() - t0}ms; render ${buf.renderW}x${buf.renderH}; regions=${regions.length}`)
  let pass = regions.length > 0
  for (const r of regions) {
    console.log(`  ${r.cls} ${r.score.toFixed(2)} [${[r.x0, r.y0, r.x1, r.y1].map((v) => v.toFixed(0))}]`)
    const clip = await renderClip(pdf, 57, { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, 2)
    if (clip) {
      const out = `poc/doclayout-poc/clip_${r.cls}.png`
      fs.writeFileSync(out, clip.png)
      console.log(`  -> ${out} ${clip.w}x${clip.h} ${(clip.png.length / 1024).toFixed(0)}KB`)
      if (clip.png.length < 1024) pass = false // suspiciously empty clip
    } else pass = false
  }
  console.log(pass ? 'PASS: render->detect->clip chain works' : 'FAIL: chain broken')
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
