// poc/doclayout-poc/test-detector.ts — Layer-1 unit test for layout-detector:
// loads the real model via onnxruntime-node in plain node, feeds a 480×480 RGBA
// (p57, a known vector-figure page), asserts the image box matches the POC
// (~[336,49,475,417] in render-pixel space at scale 2). Run from repo root.
import fs from 'node:fs'
import { LayoutDetector } from '../../electron/pdf/capture/layout-detector'

async function main() {
  const [W, H] = fs.readFileSync('poc/doclayout-poc/p57.renderdims', 'utf8').split(' ').map(Number)
  const rgba = new Uint8Array(fs.readFileSync('poc/doclayout-poc/p57_480.rgba'))
  const det = new LayoutDetector()
  const ok = await det.ensureLoaded()
  console.log('loaded:', ok, det.error ? `(err: ${det.error})` : '')
  if (!ok) process.exit(1)
  const t0 = Date.now()
  const boxes = await det.detect(rgba, W, H)
  const ms = Date.now() - t0
  const region = boxes.filter((b) => ['image', 'chart', 'table', 'formula'].includes(b.cls))
  console.log(`detect ${ms}ms; regions=${region.length}`)
  for (const b of region) console.log(`  ${b.cls} ${b.score.toFixed(2)} [${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}]`)
  const img = region.find((b) => b.cls === 'image')
  // detector returns RENDER-PIXEL space (scale 2); POC compared page-points, so /2.
  const pass = !!img && Math.abs(img.x0 / 2 - 336) < 25 && Math.abs(img.y0 / 2 - 49) < 25 &&
    Math.abs(img.x1 / 2 - 475) < 25 && Math.abs(img.y1 / 2 - 417) < 25
  console.log(pass ? 'PASS: image box matches POC (÷scale)' : 'FAIL: image box mismatch')
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
