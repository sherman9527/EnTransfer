// electron/pdf/capture/page-renderer.ts — turn a PDF page into pixels IN THE
// MAIN PROCESS using pdf.js (legacy build) + @napi-rs/canvas. This is the
// render half of the C1 layout pass; detection is layout-detector.ts (ORT-node).
//
// Why not a hidden Chromium window: a separate renderer would need HTML + a
// pdf.js worker + bundling + IPC round-trips for every page — fragile and
// heavier. @napi-rs/canvas is a single native module (~5MB) that lets pdf.js
// render headlessly in main, so the whole pass stays in one process.
//
// Degrades to unavailable (returns null) if the native canvas isn't present, so
// capture keeps working without the detector.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface DetectBuffer {
  /** 480×480 RGBA, the model's input size (aspect distortion is expected). */
  rgba: Uint8Array
  /** page pixel size at the render scale, to map boxes back to page points. */
  renderW: number
  renderH: number
  scale: number
}

export interface ClipBox { x0: number; y0: number; x1: number; y1: number }

type AnyPdf = {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (src: unknown) => { promise: Promise<PdfDoc> }
}
interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  destroy?: () => Promise<void>
}
interface PdfPage {
  getViewport(opts: { scale: number; offsetX?: number; offsetY?: number }): any
  render(opts: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> }
  cleanup(): Promise<void>
}

let pdfjs: AnyPdf | null | undefined
let createCanvas: ((w: number, h: number) => any) | null | undefined
let workerConfigured = false
const docCache = new Map<string, PdfDoc>()

/** Load pdf.js + @napi-rs/canvas lazily; returns false if unavailable. */
function backend(): boolean {
  if (pdfjs !== undefined && createCanvas !== undefined) return !!pdfjs && !!createCanvas
  try {
    const ns = require('pdfjs-dist/legacy/build/pdf.js')
    pdfjs = ((ns as { default?: AnyPdf }).default ?? ns) as AnyPdf
    createCanvas = require('@napi-rs/canvas').createCanvas
  } catch (err) {
    console.warn('[page-renderer] backend unavailable:', (err as Error).message)
    pdfjs = null
    createCanvas = null
  }
  return !!pdfjs && !!createCanvas
}

function configureWorker() {
  if (workerConfigured || !pdfjs) return
  try {
    const p = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js')
    pdfjs.GlobalWorkerOptions.workerSrc = p
  } catch {
    pdfjs.GlobalWorkerOptions.workerSrc = path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.js')
  }
  workerConfigured = true
}

/**
 * pdf.js allocates SCRATCH canvases (patterns, soft masks, form XObjects) via
 * `require('canvas')` in Node; electron.vite aliases `canvas` -> @napi-rs/canvas
 * (see canvas-stub.js) so those pages render. No per-render canvasFactory needed.
 */
async function getDoc(pdfPath: string): Promise<PdfDoc | null> {
  if (!backend()) return null
  configureWorker()
  let doc = docCache.get(pdfPath)
  if (!doc) {
    if (!existsSync(pdfPath)) return null
    const data = new Uint8Array(readFileSync(pdfPath))
    doc = await pdfjs!.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
    docCache.set(pdfPath, doc)
  }
  return doc
}

/** Render a page and downscale to the 480×480 detection buffer. */
export async function renderForDetect(pdfPath: string, pageNumber: number, scale = 2): Promise<DetectBuffer | null> {
  if (!backend()) return null
  const doc = await getDoc(pdfPath)
  if (!doc) return null
  const page = await doc.getPage(pageNumber)
  try {
    const vp = page.getViewport({ scale })
    const renderW = Math.ceil(vp.width)
    const renderH = Math.ceil(vp.height)
    const full = createCanvas!(renderW, renderH)
    await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise
    const small = createCanvas!(480, 480)
    const sctx = small.getContext('2d')
    sctx.drawImage(full, 0, 0, 480, 480)
    const img = sctx.getImageData(0, 0, 480, 480).data
    const rgba = new Uint8Array(img.buffer ? img.byteLength : img.length)
    for (let i = 0; i < rgba.length; i++) rgba[i] = img[i]
    full.dispose?.()
    small.dispose?.()
    return { rgba, renderW, renderH, scale }
  } finally {
    await page.cleanup()
  }
}

/**
 * Render a clip region (box in render-pixel space at `scale`) to a PNG buffer,
 * for embedding as an image block. Renders the full page at `scale` then crops
 * via drawImage source-rect (reliable — avoids pdf.js viewport-transform math).
 */
export async function renderClip(pdfPath: string, pageNumber: number, box: ClipBox, scale = 2): Promise<{ png: Buffer; w: number; h: number } | null> {
  if (!backend()) return null
  const doc = await getDoc(pdfPath)
  if (!doc) return null
  const page = await doc.getPage(pageNumber)
  try {
    const vp = page.getViewport({ scale })
    const renderW = Math.ceil(vp.width)
    const renderH = Math.ceil(vp.height)
    const full = createCanvas!(renderW, renderH)
    await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise
    const x0 = Math.max(0, Math.round(box.x0))
    const y0 = Math.max(0, Math.round(box.y0))
    const w = Math.max(1, Math.min(renderW - x0, Math.round(box.x1 - box.x0)))
    const h = Math.max(1, Math.min(renderH - y0, Math.round(box.y1 - box.y0)))
    const out = createCanvas!(w, h)
    out.getContext('2d').drawImage(full, x0, y0, w, h, 0, 0, w, h)
    const png: Buffer = out.toBuffer('image/png')
    full.dispose?.()
    out.dispose?.()
    return { png, w, h }
  } finally {
    await page.cleanup()
  }
}

/** Free cached documents (call when a job finishes). */
export async function disposeRenderer(): Promise<void> {
  for (const d of docCache.values()) { try { await d.destroy?.() } catch { /* ignore */ } }
  docCache.clear()
}
