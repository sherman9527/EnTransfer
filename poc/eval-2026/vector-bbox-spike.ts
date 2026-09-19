// poc/eval-2026/vector-bbox-spike.ts — C1 risk spike: can we recover vector
// figure bounding boxes from pdfjs's operatorList (no PyMuPDF get_drawings)?
//
// Strategy: walk the operatorList maintaining a CTM stack (transform/saveState/
// restoreState). Each constructPath op carries raw path coords; project them
// through the current CTM into page space and collect per-paint rectangles
// (a rect is flushed on stroke/fill/fillEvenOdd). Cluster nearby rects into
// connected components; a component with >= MIN_RECTS boxes and area within
// [MIN%, MAX%] of the page is a figure candidate. Report per-page hit vs the
// caption census so we know if bbox extraction is viable before building the
// Chromium render pass.
import path from 'node:path'
import fs from 'node:fs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.js'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')

// 3x2 affine [a b c d e f]: p' = (a*x + c*y + e, b*x + d*y + f)
type M = number[]
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
]
const apply = (m: M, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

// how many flat coords each path op consumes (constructPath opsArray)
function coordLen(op: number): number {
  switch (op) {
    case OPS.moveTo: return 2
    case OPS.lineTo: return 2
    case OPS.curveTo: return 6
    case OPS.curveTo2: return 4
    case OPS.curveTo3: return 4
    case OPS.rectangle: return 4
    case OPS.closePath: return 0
    default: return 0
  }
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
const overlapMerge = (a: Rect, b: Rect, gap: number): Rect | null => {
  if (a.x0 - gap > b.x1 || b.x0 - gap > a.x1 || a.y0 - gap > b.y1 || b.y0 - gap > a.y1) return null
  return {
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)
  }
}
const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0)

async function main() {
  const data = new Uint8Array(fs.readFileSync(INPUT))
  const pdf = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const CAPTURED = [57, 58, 61, 90, 144, 147, 174, 187, 190, 200, 208, 215]

  let hitPages = 0
  const report: unknown[] = []
  for (const p of CAPTURED) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const ol = await page.getOperatorList()
    const stack: M[] = []
    let ctm: M = [1, 0, 0, 1, 0, 0]
    const rects: Rect[] = []
    let cur: Rect | null = null
    const IMG_OPS = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject])
    const PAINT = new Set([OPS.stroke, OPS.fill, OPS.fillEvenOdd, OPS.strokeFill])
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i]
      const arg = ol.argsArray[i]
      if (fn === OPS.transform && arg) ctm = mul(ctm, arg)
      else if (fn === OPS.save) stack.push(ctm.slice())
      else if (fn === OPS.restore) { const s = stack.pop(); if (s) ctm = s }
      else if (fn === OPS.constructPath && arg) {
        const [ops, coords] = arg as [number[], number[]]
        let k = 0
        for (const op of ops) {
          const n = coordLen(op)
          for (let j = 0; j < n; j += 2) {
            if (op === OPS.rectangle && n === 4) {
              const [x, y] = apply(ctm, coords[k], coords[k + 1])
              const [x2, y2] = apply(ctm, coords[k] + coords[k + 2], coords[k + 1] + coords[k + 3])
              const r = { x0: Math.min(x, x2), y0: Math.min(y, y2), x1: Math.max(x, x2), y1: Math.max(y, y2) }
              cur = cur ? { x0: Math.min(cur.x0, r.x0), y0: Math.min(cur.y0, r.y0), x1: Math.max(cur.x1, r.x1), y1: Math.max(cur.y1, r.y1) } : r
              k += 4
            } else if (n >= 2) {
              const [x, y] = apply(ctm, coords[k], coords[k + 1])
              cur = !cur ? { x0: x, y0: y, x1: x, y1: y } : { x0: Math.min(cur.x0, x), y0: Math.min(cur.y0, y), x1: Math.max(cur.x1, x), y1: Math.max(cur.y1, y) }
              k += 2
              // curve control points: consume remaining without treating as bbox-critical
              if (op === OPS.curveTo) k += 4
              else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 2
            }
          }
        }
      } else if (PAINT.has(fn) && cur) { rects.push(cur); cur = null }
      else if (IMG_OPS.has(fn) && cur) { rects.push(cur); cur = null }
    }
    // cluster rects into figure components (gap 6pt), >=3 boxes, 0.3%..85% page area
    let comps: Rect[] = rects.map((r) => ({ ...r }))
    let merged = true
    while (merged) {
      merged = false
      outer: for (let i = 0; i < comps.length; i++) {
        for (let j = i + 1; j < comps.length; j++) {
          const m = overlapMerge(comps[i], comps[j], 6)
          if (m) { comps[i] = m; comps.splice(j, 1); merged = true; break outer }
        }
      }
    }
    const pageArea = vp.width * vp.height
    const figures = comps.filter((c) => {
      const a = area(c)
      return a >= pageArea * 0.003 && a <= pageArea * 0.85 && (c.x1 - c.x0) > 25 && (c.y1 - c.y0) > 25
    })
    const hit = figures.length > 0
    if (hit) hitPages++
    report.push({ page: p, rawRects: rects.length, figureBoxes: figures.length, largestPct: figures.length ? +((area(figures.sort((a, b) => area(b) - area(a))[0]) / pageArea) * 100).toFixed(1) : 0 })
    await page.cleanup()
  }
  console.log(JSON.stringify({ captionedVectorPages: CAPTURED.length, pagesWithFigureBox: hitPages, recallPct: +((hitPages / CAPTURED.length) * 100).toFixed(0), report }, null, 2))
  await pdf.destroy()
}
main().catch((e) => { console.error(e); process.exit(1) })
