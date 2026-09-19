// poc/eval-2026/region-density.ts — #21 design probe: distinguish sparse
// diagrams (safe to rasterize + drop leaked labels) from text-dense regions the
// detector mislabels as 'image' (must NOT drop their text). Uses ink coverage
// from the 480x480 detection buffer — no second pdf.js instance, no text API.
import path from 'node:path'
import { LayoutDetector } from '../../electron/pdf/capture/layout-detector'
import { renderForDetect } from '../../electron/pdf/capture/page-renderer'

const ROOT = process.cwd()
const BOOK = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const SCALE = 1.5

async function main() {
  const det = new LayoutDetector()
  if (!await det.ensureLoaded()) { console.log('detector unavailable', det.error); process.exit(1) }
  const { numPages } = { numPages: 353 }
  const rows: Array<{ page: number; cls: string; w: number; h: number; ink: number }> = []
  for (let page = 1; page <= numPages; page++) {
    const buf = await renderForDetect(BOOK, page, SCALE)
    if (!buf) continue
    const boxes = await det.detect(buf.rgba, buf.renderW, buf.renderH)
    for (const b of boxes) {
      if (b.cls !== 'image' && b.cls !== 'chart') continue
      // map render-px box -> 480 space
      const sx = 480 / buf.renderW, sy = 480 / buf.renderH
      const x0 = Math.max(0, Math.floor(b.x0 * sx)), x1 = Math.min(479, Math.ceil(b.x1 * sx))
      const y0 = Math.max(0, Math.floor(b.y0 * sy)), y1 = Math.min(479, Math.ceil(b.y1 * sy))
      const w = x1 - x0, h = y1 - y0
      if (w < 6 || h < 6) continue
      let dark = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * 480 + x) * 4
        const lum = (buf.rgba[i] + buf.rgba[i + 1] + buf.rgba[i + 2]) / 3
        if (lum < 160) dark++
      }
      rows.push({ page, cls: b.cls, w, h, ink: +(dark / (w * h) * 100).toFixed(1) })
    }
  }
  const hi = rows.filter((r) => r.ink > 12)
  const lo = rows.filter((r) => r.ink <= 12)
  console.log(JSON.stringify({ regions: rows.length, highInk_gt12pct: hi.length, lowInk: lo.length,
    p55: rows.filter((r) => r.page === 55), p57: rows.filter((r) => r.page === 57) }, null, 2))
  console.log('--- HIGH ink (text-dense, likely misclassified table -> SKIP) ---')
  for (const r of hi.slice(0, 20)) console.log(`  p${r.page} ${r.cls} ${r.w}x${r.h} ink=${r.ink}%`)
}
main().catch((e) => { console.error(e); process.exit(1) })
