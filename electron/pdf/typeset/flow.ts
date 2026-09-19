/**
 * electron/pdf/typeset/flow.ts — flow-based typesetting on a fresh A4 canvas.
 *
 * PRINCIPLE: the source PDF's layout is completely ignored. We take a flat
 * ContentBlock[] stream and lay it out from scratch on clean A4 pages. No old
 * text, no original coordinates, no decorative elements survive.
 *
 * Page: A4 (595 × 842 pt), 50pt margins → content area 495 × 742 pt.
 *
 * Fonts: Microsoft YaHei (Regular body, Bold headings) + Consolas (code).
 *   body  Microsoft YaHei Regular  11pt / line-height 16pt
 *   h1    Microsoft YaHei Bold     18pt / 24pt, before 16 after 10
 *   h2    Microsoft YaHei Bold     15pt / 20pt, before 12 after 8
 *   h3    Microsoft YaHei Bold     13pt / 17pt, before 10 after 6
 *   h4    Microsoft YaHei Bold     12pt / 16pt, before  8 after 6
 *   code  Consolas                 9.5pt / 13pt, gray background, left-indented
 *   list  body style with bullet prefix + 20pt left indent
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFPage, type PDFFont, type PDFImage } from 'pdf-lib'
import { wrapMixed, type LaidOutLine } from './measure'
import type { ContentBlock } from '../capture/flow'

/**
 * Embedded font set for flow typesetting.
 * Regular YaHei is used for body/prose; Bold YaHei for headings; Consolas for code.
 * All are pre-subsetted TTFs (GBK + Latin Extended-A + symbols, ~12-15 MB each).
 */
interface FlowFonts {
  /** Regular body font (Microsoft YaHei Regular subset). */
  regular: PDFFont
  /** Bold heading font (Microsoft YaHei Bold subset). */
  bold: PDFFont
  /** Monospace code font (Consolas subset). */
  mono: PDFFont
}

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------
const PAGE_W = 595
const PAGE_H = 842
const MARGIN = 50
const CONTENT_LEFT = MARGIN
const CONTENT_RIGHT = PAGE_W - MARGIN // 545
const CONTENT_TOP = PAGE_H - MARGIN  // 792
const CONTENT_BOTTOM = MARGIN        // 50
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT // 495

// ---------------------------------------------------------------------------
// Style definitions
// ---------------------------------------------------------------------------
interface BlockStyle {
  size: number
  lineHeight: number
  before: number
  after: number
}

const STYLES: Record<'body' | 'h1' | 'h2' | 'h3' | 'h4' | 'code', BlockStyle> = {
  body: { size: 11, lineHeight: 16, before: 0, after: 6 },
  h1:   { size: 18, lineHeight: 24, before: 16, after: 10 },
  h2:   { size: 15, lineHeight: 20, before: 12, after: 8 },
  h3:   { size: 13, lineHeight: 17, before: 10, after: 6 },
  h4:   { size: 12, lineHeight: 16, before: 8,  after: 6 },
  code: { size: 9.5, lineHeight: 13, before: 4, after: 6 }
}

/** Ink color: pure black. */
const INK = rgb(0, 0, 0)
/** Code block background: light gray. */
const CODE_BG = rgb(0.95, 0.95, 0.95)
/** Page-number gray. */
const MUTED = rgb(0.55, 0.55, 0.55)
/** Vertical spacing before/after an image block. */
const IMAGE_SPACING_BEFORE = 8
const IMAGE_SPACING_AFTER = 14

// ---------------------------------------------------------------------------
// Internal drawing helpers
// ---------------------------------------------------------------------------

/**
 * Draw one laid-out line (mixed CJK/Latin runs) starting at (x, baselineY).
 * Each run uses its own font; the x cursor advances by run width.
 * `heading` selects the Bold variant for headings.
 */
function drawLine(
  page: PDFPage,
  line: LaidOutLine,
  x: number,
  baselineY: number,
  fonts: FlowFonts,
  size: number,
  color = INK,
  heading = false,
  mono = false
): void {
  let cx = x
  const runFont = (run: { script: string }): PDFFont => {
    // Code lines are measured with the mono font (codeAdapter), so they MUST be
    // drawn with it too — otherwise measured width != drawn width and runs
    // misalign. CJK falls back to regular (Consolas has no CJK glyphs).
    if (mono || run.script === 'mono') return run.script === 'cjk' ? fonts.regular : fonts.mono
    return heading ? fonts.bold : fonts.regular
  }
  for (const run of line.runs) {
    if (run.text.length === 0) continue
    // Strip bullet/marker glyphs that capture or the model may have embedded;
    // typeset draws its own vector circle for list items. Also strip Private
    // Use Area chars (U+E000-U+F8FF) — original PDFs often map custom bullets
    // (e.g. U+F0A1) to PUA, and they have no glyph in our font.
    const text = run.text.replace(/[\u2022\u25AA\u25A0\u25A1\u25CF\u25E6\u2610\u2612\u25B8\u25B9\uE000-\uF8FF]/g, '')
    if (text.length === 0) continue
    const f = runFont(run)
    try {
      page.drawText(text, {
        x: cx,
        y: baselineY,
        size,
        font: f,
        color
      })
    } catch {
      /* missing glyph — skip run */
    }
    // Advance by the cleaned text's actual width.
    try {
      cx += f.widthOfTextAtSize(text, size)
    } catch {
      cx += run.width
    }
  }
}

/**
 * Post-process translated text to clean up extraction artifacts:
 * - "Table 1 .xxx" → "表1 xxx" (translate "Table N" prefix, strip stray dots)
 * - Line-break hyphens: "Fran- cisco" → "Francisco"
 */
function cleanText(text: string): string {
  let t = text
  // Translate "Table N" / "Figure N" captions and strip stray punctuation.
  t = t.replace(/^(?:Table|Fig(?:ure)?)\s*(\d+)\s*[.:]\s*/i, (_m, num: string) => `表${num} `)
  // Remove line-break hyphenation: "word- word" → "wordword" (lowercase after hyphen).
  t = t.replace(/([a-z])-\s+([a-z])/g, '$1$2')
  return t
}

// ---------------------------------------------------------------------------
// Main typeset
// ---------------------------------------------------------------------------

export interface TypesetFlowOptions {
  /** Override the bundled CJK TTF path. */
  fontPath?: string
}

/**
 * Lay out the given ContentBlock stream onto a fresh A4 PDF at `outputPath`.
 *
 * The `blocks` array may carry translated text already (in `.text`, `.items`,
 * or verbatim `.code`). Blocks whose text is empty are skipped.
 */
export async function typesetFlow(
  blocks: ContentBlock[],
  outputPath: string,
  options: TypesetFlowOptions = {}
): Promise<{ outputPath: string; pageCount: number; fileSize: number }> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)

  // Embed pre-subsetted Microsoft YaHei (Regular + Bold) and Consolas.
  // Subsetting done at build time via scripts/subset-yahei.py (fontTools).
  // Resolve all fonts from the same directory as the regular font (passed via
  // options.fontPath from pipeline.ts, which uses app.getAppPath()).
  const regularPath = options.fontPath
    ?? path.resolve(process.cwd(), 'assets', 'fonts', 'MicrosoftYaHei-Regular-subset.ttf')
  const fontsDir = path.dirname(regularPath)
  const boldPath = path.join(fontsDir, 'MicrosoftYaHei-Bold-subset.ttf')
  const monoPath = path.join(fontsDir, 'Consolas-subset.ttf')

  const regular = await doc.embedFont(fs.readFileSync(regularPath), { subset: false })
  const bold = await doc.embedFont(fs.readFileSync(boldPath), { subset: false })
  const mono = await doc.embedFont(fs.readFileSync(monoPath), { subset: false })
  const fonts: FlowFonts = { regular, bold, mono }

  // Adapter objects for measure.ts wrapMixed (expects {cjk, latin}).
  // YaHei covers both CJK and Latin glyphs, so cjk and latin point to the same font.
  const bodyAdapter = { cjk: regular, latin: regular }
  const headingAdapter = { cjk: bold, latin: bold }
  const codeAdapter = { cjk: regular, latin: mono }

  // Image cache: keyed by the Uint8Array object reference → embedded PDFImage.
  // Each ContentBlock carries its own unique imageData reference.
  const imageCache = new WeakMap<Uint8Array, PDFImage>()
  const getEmbeddedImage = async (block: ContentBlock): Promise<PDFImage | null> => {
    const data = block.imageData
    if (!data || data.length === 0) return null
    const cached = imageCache.get(data)
    if (cached) return cached
    try {
      const img = block.imageFormat === 'png'
        ? await doc.embedPng(data)
        : await doc.embedJpg(data)
      imageCache.set(data, img)
      return img
    } catch (err) {
      console.warn(`[typeset/flow] failed to embed image: ${(err as Error).message}`)
      return null
    }
  }

  // Layout state.
  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H])
  // baselineY = y of the next line's baseline (bottom-left origin).
  let baselineY = CONTENT_TOP - STYLES.body.size

  /** Start a fresh A4 page; reset baseline to the top. */
  const newPage = (): void => {
    page = doc.addPage([PAGE_W, PAGE_H])
    baselineY = CONTENT_TOP - STYLES.body.size
  }

  /** Draw page number at the bottom center of the current page. */
  const drawPageNumber = (): void => {
    const num = doc.getPageCount()
    page.drawText(String(num), {
      x: PAGE_W / 2 - 10,
      y: CONTENT_BOTTOM - 20,
      size: 9,
      font: fonts.regular,
      color: MUTED
    })
  }

  for (const block of blocks) {
    // ---- image blocks: embed and draw centered ----
    if (block.type === 'image') {
      const img = await getEmbeddedImage(block)
      if (!img) continue

      // Calculate display dimensions: scale to fit CONTENT_W, preserve aspect.
      const pxW = block.imagePixelWidth ?? img.width
      const pxH = block.imagePixelHeight ?? img.height
      // Clamp by BOTH width and available page height — a tall image scaled only
      // to CONTENT_W overflowed below CONTENT_BOTTOM (baselineY went negative).
      const maxH = CONTENT_TOP - CONTENT_BOTTOM - IMAGE_SPACING_BEFORE - IMAGE_SPACING_AFTER
      const scale = Math.min(1, CONTENT_W / pxW, maxH / pxH)
      const drawW = pxW * scale
      const drawH = pxH * scale

      const totalHeight = IMAGE_SPACING_BEFORE + drawH + IMAGE_SPACING_AFTER

      // Page break if image doesn't fit.
      if (baselineY - totalHeight < CONTENT_BOTTOM) {
        drawPageNumber()
        newPage()
      }

      // Center horizontally.
      const imgX = CONTENT_LEFT + (CONTENT_W - drawW) / 2
      // Bottom-left corner of the image (bottom-up origin).
      const imgY = baselineY - IMAGE_SPACING_BEFORE - drawH

      page.drawImage(img, {
        x: imgX,
        y: imgY,
        width: drawW,
        height: drawH
      })

      baselineY -= totalHeight
      continue
    }

    // ---- resolve style + text to draw ----
    let style: BlockStyle = STYLES.body
    let text = ''
    let isCode = false
    let isList = false
    let isHeading = false

    if (block.type === 'heading') {
      const lv = block.level ?? 4
      style = lv === 1 ? STYLES.h1 : lv === 2 ? STYLES.h2 : lv === 3 ? STYLES.h3 : STYLES.h4
      text = cleanText(block.text ?? '')
      isHeading = true
    } else if (block.type === 'code') {
      style = STYLES.code
      text = block.code ?? ''
      isCode = true
    } else if (block.type === 'list') {
      style = STYLES.body
      isList = true
    } else {
      style = STYLES.body
      text = cleanText(block.text ?? '')
    }

    // ---- list blocks: render each item with bullet prefix ----
    if (isList) {
      const items = block.items ?? []
      // Compute total height for page-break check.
      const bulletW = 8 // vector circle + spacing, no font dependency
      const listIndent = 20
      const listLeft = CONTENT_LEFT + listIndent
      const listW = CONTENT_W - listIndent
      let totalHeight = style.before
      const wrappedItems: LaidOutLine[][] = []
      for (const item of items) {
        // Strip any leading bullet/marker characters that capture may have
        // embedded in the text (typeset draws its own vector circle bullet).
        const cleanItem = cleanText(item.replace(/^[\s\u2022\u25CF\u25AA\u25E6\u25A0\u25A1\u2610\u2612\u25B8\u25B9\u25BA\u25BB\uE000-\uF8FF*\-–—―·•]+/, ''))
        const wrapped = wrapMixed(cleanItem, bodyAdapter, style.size, listW - bulletW)
        wrappedItems.push(wrapped)
        totalHeight += wrapped.length * style.lineHeight
      }
      totalHeight += style.after

      // Page break?
      if (baselineY - totalHeight < CONTENT_BOTTOM) {
        drawPageNumber()
        newPage()
      }

      baselineY -= style.before
      for (let i = 0; i < wrappedItems.length; i++) {
        const lines = wrappedItems[i]
        // Draw bullet as a vector-filled circle (no font dependency).
        const bulletY = baselineY + style.size * 0.35
        page.drawCircle({
          x: CONTENT_LEFT + 6,
          y: bulletY,
          size: 2,
          color: INK
        })
        for (const line of lines) {
          drawLine(page, line, listLeft, baselineY, fonts, style.size)
          baselineY -= style.lineHeight
        }
      }
      baselineY -= style.after
      continue
    }

    // ---- table blocks: bordered grid, wrapped cells, gray header ----
    if (block.type === 'table') {
      const cells = block.cells ?? []
      const rows = cells.length
      const cols = block.cols ?? (cells[0]?.length ?? 0)
      if (rows > 0 && cols > 0) {
        const padX = 6
        const cellFontSize = STYLES.body.size
        // Column widths: capture-stage weights (anchor spacing), equal-width
        // fallback, and a minimum clamp so wrapped text never collapses into
        // a one-character vertical stack.
        const MIN_COL_W = 48
        const anchorW: number[] =
          block.colWidths && block.colWidths.length === cols
            ? block.colWidths.slice()
            : new Array(cols).fill(1 / cols)
        // Blend anchor spacing with content mass: the source layout's column
        // gaps fit ENGLISH text heights; a re-typeset Chinese grid needs wide
        // columns where long cells live, or text collapses to one char per line.
        const weights: number[] = new Array(cols).fill(0)
        {
          const colMax: number[] = new Array(cols).fill(1)
          for (const row of cells)
            for (let c = 0; c < cols; c++) colMax[c] = Math.max(colMax[c], (row[c] ?? '').trim().length)
          const csum = colMax.reduce((a, b) => a + b, 0)
          for (let c = 0; c < cols; c++) {
            weights[c] = 0.45 * anchorW[c] + 0.55 * (colMax[c] / csum)
          }
          const wsum = weights.reduce((a, b) => a + b, 0) || 1
          for (let c = 0; c < cols; c++) weights[c] /= wsum
          let lifted = 0
          let rest = 0
          for (let c = 0; c < cols; c++) {
            const wPt = weights[c] * CONTENT_W
            if (wPt < MIN_COL_W) {
              lifted += MIN_COL_W - wPt
              weights[c] = MIN_COL_W / CONTENT_W
            } else {
              rest += wPt
            }
          }
          if (lifted > 0 && rest > lifted) {
            const scale = (rest - lifted) / rest
            for (let c = 0; c < cols; c++) {
              const wPt = weights[c] * CONTENT_W
              if (wPt > MIN_COL_W) weights[c] = (wPt * scale) / CONTENT_W
            }
          }
        }
        const colEdges: number[] = [CONTENT_LEFT]
        for (let c = 0; c < cols; c++) colEdges.push(colEdges[c] + weights[c] * CONTENT_W)
        const colWs: number[] = []
        for (let c = 0; c < cols; c++) colWs.push(Math.max(20, colEdges[c + 1] - colEdges[c] - padX * 2))
        const wrappedCells: LaidOutLine[][][] = cells.map((row) =>
          row.map((cell, c) => wrapMixed(cleanText(cell ?? ''), bodyAdapter, cellFontSize, colWs[c]))
        )
        const rowHeights = wrappedCells.map((row) => {
          const lines = Math.max(1, ...row.map((w) => w.length))
          return lines * STYLES.body.lineHeight + 6
        })

        // Row-at-a-time drawing with page splitting; the header row repeats on
        // continuation pages and each page segment gets its own grid frame.
        baselineY -= STYLES.body.before
        let segTop: number | null = null
        let segBottom = 0
        const closeSeg = (): void => {
          if (segTop === null) return
          page.drawRectangle({
            x: CONTENT_LEFT,
            y: segBottom,
            width: CONTENT_W,
            height: segTop - segBottom,
            borderColor: rgb(0.7, 0.7, 0.7),
            borderWidth: 0.6
          })
          for (let c = 1; c < cols; c++) {
            page.drawLine({
              start: { x: colEdges[c], y: segBottom },
              end: { x: colEdges[c], y: segTop },
              thickness: 0.4,
              color: rgb(0.8, 0.8, 0.8)
            })
          }
          segTop = null
        }
        const drawRow = (r: number): void => {
          const rh = rowHeights[r]
          if (segTop === null) segTop = baselineY
          const rowTop = baselineY
          const rowBottom = baselineY - rh
          if (block.hasHeader && r === 0) {
            page.drawRectangle({
              x: CONTENT_LEFT,
              y: rowBottom,
              width: CONTENT_W,
              height: rh,
              color: CODE_BG
            })
          }
          for (let c = 0; c < cols; c++) {
            const cellX = colEdges[c] + padX
            let cy = rowTop - STYLES.body.lineHeight + 2
            for (const line of wrappedCells[r][c]) {
              drawLine(page, line, cellX, cy, fonts, cellFontSize)
              cy -= STYLES.body.lineHeight
            }
          }
          page.drawLine({
            start: { x: CONTENT_LEFT, y: rowTop },
            end: { x: CONTENT_LEFT + CONTENT_W, y: rowTop },
            thickness: 0.4,
            color: rgb(0.8, 0.8, 0.8)
          })
          baselineY = rowBottom
          segBottom = rowBottom
        }
        for (let r = 0; r < rows; r++) {
          if (segTop !== null && baselineY - rowHeights[r] < CONTENT_BOTTOM) {
            closeSeg()
            drawPageNumber()
            newPage()
            if (block.hasHeader) drawRow(0)
          }
          drawRow(r)
        }
        closeSeg()
        baselineY -= STYLES.body.after
      }
      continue
    }

    if (text.trim().length === 0) continue

    // ---- code blocks: gray background + monospace ----
    if (isCode) {
      const codeIndent = 10
      const codeLeft = CONTENT_LEFT + codeIndent
      const codeW = CONTENT_W - codeIndent
      // Wrap code lines (split by \n first, then wrap each line).
      const rawLines = text.split('\n')
      const wrappedLines: LaidOutLine[] = []
      for (const rl of rawLines) {
        const wl = wrapMixed(rl, codeAdapter, style.size, codeW)
        wrappedLines.push(...wl)
      }
      const totalHeight = style.before + wrappedLines.length * style.lineHeight + style.after

      if (baselineY - totalHeight < CONTENT_BOTTOM) {
        drawPageNumber()
        newPage()
      }

      // Draw gray background rect.
      const rectY = baselineY - wrappedLines.length * style.lineHeight - style.after + 2
      const rectH = wrappedLines.length * style.lineHeight + style.before + style.after
      page.drawRectangle({
        x: CONTENT_LEFT + 2,
        y: rectY,
        width: CONTENT_W - 4,
        height: rectH,
        color: CODE_BG
      })

      baselineY -= style.before
      for (const line of wrappedLines) {
        drawLine(page, line, codeLeft, baselineY, fonts, style.size, rgb(0.15, 0.15, 0.15), false, true)
        baselineY -= style.lineHeight
      }
      baselineY -= style.after
      continue
    }

    // ---- normal heading / paragraph ----
    const wrapAdapter = isHeading ? headingAdapter : bodyAdapter
    const wrapped = wrapMixed(text, wrapAdapter, style.size, CONTENT_W)
    const totalHeight = style.before + wrapped.length * style.lineHeight + style.after

    if (baselineY - totalHeight < CONTENT_BOTTOM) {
      drawPageNumber()
      newPage()
    }

    baselineY -= style.before
    for (const line of wrapped) {
      drawLine(page, line, CONTENT_LEFT, baselineY, fonts, style.size, INK, isHeading)
      baselineY -= style.lineHeight
    }
    baselineY -= style.after
  }

  // Finalize last page number.
  drawPageNumber()

  const outBytes = await doc.save()
  fs.writeFileSync(outputPath, outBytes)
  return {
    outputPath,
    pageCount: doc.getPageCount(),
    fileSize: outBytes.byteLength
  }
}
