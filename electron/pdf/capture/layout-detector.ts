// electron/pdf/capture/layout-detector.ts — C1: PP-DocLayout-S document-layout
// detector, running ONNX Runtime (native CPU EP) in the MAIN process.
//
// Why node (not onnxruntime-web in the renderer): the threaded wasm build
// hard-crashes the Electron renderer at InferenceSession.create (exit -36861)
// even crossOriginIsolated — measured 2026-09-19, see docs/PDFZH-COMPARE.md C1.
// The native EP in main is stable and fast (~50ms/page). The renderer's only
// job is turning a PDF page into a 480×480 RGBA buffer (canvas), which it does
// with the pdf.js we already ship — zero new render dependencies.
//
// The whole module degrades to a no-op (detect → []) when onnxruntime-node or
// the model is missing, so capture still works and non-Electron harnesses/tests
// are unaffected. Adoption is gated on isAvailable().
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface LayoutBox {
  /** class label (see CLASS_NAMES). */
  cls: string
  /** detection confidence 0..1. */
  score: number
  /** box in the RENDERED page's pixel space (top-left origin). */
  x0: number
  y0: number
  x1: number
  y1: number
}

/** PP-DocLayout-S 23 classes, ordered to match the upstream inference.yml. */
export const CLASS_NAMES = [
  'paragraph_title', 'image', 'text', 'number', 'abstract', 'content', 'figure_title',
  'formula', 'table', 'table_title', 'reference', 'doc_title', 'footnote', 'header',
  'algorithm', 'footer', 'seal', 'chart_title', 'chart', 'formula_number',
  'header_image', 'footer_image', 'aside_text'
] as const

/** Classes we treat as "must be carried as a rasterized region, never translated". */
export const REGION_CLASSES = new Set(['image', 'chart', 'table', 'formula'])

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
const DET_SIZE = 480
const SCORE_THRESHOLD = 0.3

/** Locate the bundled model across dev, packaged (asar), and harness contexts.
 *  onnxruntime-node opens the model with NATIVE file I/O that cannot traverse
 *  Electron's asar virtual FS, so when packaged we must hand it the physical
 *  app.asar.unpacked path (the model is asarUnpacked in build config). */
export function resolveModelPath(): string {
  const rel = path.join('assets', 'layout', 'pp_doclayout_s.onnx')
  const roots: string[] = []
  if ((process.versions as { electron?: string }).electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const appPath: string = require('electron').app.getAppPath()
      roots.push(appPath.replace(/app\.asar$/, 'app.asar.unpacked'))
      roots.push(appPath)
    } catch { /* ignore */ }
  }
  roots.push(process.cwd())
  for (const r of roots) {
    const p = path.join(r, rel)
    if (existsSync(p)) return p
  }
  return path.join(roots[0] ?? process.cwd(), rel)
}

type OrtSession = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>
}
interface OrtModule {
  InferenceSession: { create: (p: string, o?: unknown) => Promise<OrtSession> }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}

export class LayoutDetector {
  private session: OrtSession | null = null
  private loadError: string | null = null
  private loading: Promise<void> | null = null

  /** true once a session is ready; false (permanently) if the backend/model is unavailable. */
  get isAvailable(): boolean {
    return this.session !== null
  }

  /** Lazily load the model (idempotent, safe to call per page). */
  async ensureLoaded(): Promise<boolean> {
    if (this.session) return true
    if (this.loading) { await this.loading; return this.session !== null }
    this.loading = (async () => {
      const modelPath = resolveModelPath()
      if (!existsSync(modelPath)) {
        this.loadError = `layout model not found: ${modelPath}`
        return
      }
      try {
        // Dynamic require keeps this loadable in non-Electron contexts that lack
        // the native module — it just degrades to unavailable.
        const ort = require('onnxruntime-node') as OrtModule
        this.session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' })
        this.ort = ort
      } catch (err) {
        this.loadError = `onnxruntime-node init failed: ${(err as Error).message}`
      }
    })()
    await this.loading
    return this.session !== null
  }

  private ort: OrtModule | null = null

  /**
   * Detect layout regions on one page. `rgba` is a DET_SIZE×DET_SIZE RGBA buffer
   * (renderer already resized the page to 480×480, distorting is expected by the
   * model contract). `renderW/renderH` are the page's pixel size at the render
   * scale, so returned boxes are in that pixel space (caller divides by scale).
   */
  async detect(rgba: Uint8Array, renderW: number, renderH: number): Promise<LayoutBox[]> {
    const ort = this.ort
    const session = this.session
    if (!ort || !session) return []
    const chw = new Float32Array(3 * DET_SIZE * DET_SIZE)
    for (let y = 0; y < DET_SIZE; y++) {
      for (let x = 0; x < DET_SIZE; x++) {
        const i = (y * DET_SIZE + x) * 4
        for (let c = 0; c < 3; c++) {
          chw[c * DET_SIZE * DET_SIZE + y * DET_SIZE + x] = (rgba[i + c] / 255 - MEAN[c]) / STD[c]
        }
      }
    }
    const image = new ort.Tensor('float32', chw, [1, 3, DET_SIZE, DET_SIZE])
    const sf = new ort.Tensor('float32', new Float32Array([DET_SIZE / renderH, DET_SIZE / renderW]), [1, 2])
    const out = await session.run({ image, scale_factor: sf })
    const keys = Object.keys(out)
    const dets = out[keys[0]]
    const numTensor = out[keys[1]]
    const n = numTensor ? Math.min(numTensor.data[0] | 0, dets.dims[0]) : dets.dims[0]
    const boxes: LayoutBox[] = []
    for (let r = 0; r < n; r++) {
      const cid = dets.data[r * 6] | 0
      const score = dets.data[r * 6 + 1]
      if (score < SCORE_THRESHOLD) continue
      const cls = CLASS_NAMES[cid]
      if (!cls) continue
      boxes.push({
        cls,
        score,
        x0: dets.data[r * 6 + 2],
        y0: dets.data[r * 6 + 3],
        x1: dets.data[r * 6 + 4],
        y1: dets.data[r * 6 + 5]
      })
    }
    return boxes
  }

  get error(): string | null {
    return this.loadError
  }
}
