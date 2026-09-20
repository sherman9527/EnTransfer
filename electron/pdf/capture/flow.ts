/**
 * electron/pdf/capture/flow.ts 鈥?flow-based PDF content capture.
 *
 * Unlike the original coordinate-preserving capture (extract 鈫?readingOrder 鈫? * segment 鈫?TranslationUnit with bboxes), this module treats the source PDF as
 * a PURE content source. No x/y/width/height survives into the output.
 *
 * Pipeline:
 *   1. pdfjs getTextContent() per page 鈫?raw text items (str, fontSize, fontName).
 *   2. Group items into visual lines (same baseline).
 *   3. Merge lines into paragraphs (close vertical gap, same font size).
 *   4. Classify each paragraph: heading / paragraph / code / list-item.
 *   5. Group consecutive list-items into one list block; consecutive code
 *      paragraphs into one code block.
 *   6. Drop page furniture: header/footer bands, page numbers, TOC pages.
 *   7. Extract images via pdf-lib (recursive through Form XObjects) and use
 *      pdfjs operatorList to place them in reading order.
 *
 * Output: a flat ContentBlock[] 鈥?text + image blocks. The typeset flow
 * then lays these out on a fresh A4 canvas from scratch.
 */

import * as fs from 'node:fs'
import * as zlib from 'node:zlib'
import * as pdfjsNamespace from 'pdfjs-dist/legacy/build/pdf.js'
import { LayoutDetector } from './layout-detector'
import { renderForDetect, renderClip, disposeRenderer } from './page-renderer'
import {
  joinFragments, isRunningFurniture, stripBleedingPageNumbers,
  looksLikeCode, joinLines, CODE_FONT_RATIO,
  MAGIC_CELL_RE, ASCII_DUMP_RE, REPL_PROMPT_RE
} from './line-utils'
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFDict,
  PDFRawStream,
  type PDFStream
} from 'pdf-lib'

const pdfjsLib = (pdfjsNamespace as unknown as { default?: typeof pdfjsNamespace }).default ?? pdfjsNamespace

// pdfjs-dist uses a worker for PDF parsing. When bundled, the worker file
// (pdf.worker.js) is copied to out/main/ by the postbuild script. Point
// GlobalWorkerOptions at it so the fake-worker fallback can require() it.
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContentBlockType = 'heading' | 'paragraph' | 'code' | 'list' | 'image' | 'table' | 'formula'

export interface ContentBlock {
  type: ContentBlockType
  /** heading only: 1 (largest) .. 4 (smallest). */
  level?: number
  /** heading / paragraph: the text (to be translated). */
  text?: string
  /** code block: verbatim source (NOT translated). */
  code?: string
  /** list: item texts (each translated individually). */
  items?: string[]
  /** 1-based source page (debug only, never used for layout). */
  page?: number
  /** image block: raw image bytes (JPEG or PNG). */
  imageData?: Uint8Array
  /** image block: format. */
  imageFormat?: 'jpg' | 'png'
  /** image block: pixel dimensions (for aspect-ratio preservation). */
  imagePixelWidth?: number
  imagePixelHeight?: number
  /** table block: 2D cell texts (each translated individually). */
  cells?: string[][]
  /** table block: row / column counts. */
  rows?: number
  cols?: number
  /** table block: whether the first row is a header. */
  hasHeader?: boolean
  /** table block: per-column width weights (same length as cols, sums to ~1). */
  colWidths?: number[]
}

export interface FlowCaptureResult {
  blocks: ContentBlock[]
  pageCount: number
  /** Debug: total number of images extracted. */
  imageCount: number
}

/**
 * Bump whenever the block stream changes shape (merge rules, classification).
 * The pipeline stamps it into the job checkpoint and refuses to reuse
 * id-keyed translations from a differently-shaped capture — block ids are
 * positional, so a shifted stream would silently misassign text.
 */
export const CAPTURE_VERSION = 4

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A visual line assembled from fragments sharing a baseline. */
interface RawLine {
  text: string
  fontSize: number
  fontName: string
  y: number
  x: number
  page: number
  /** Page width (for header/footer band detection). */
  pageWidth: number
  /** Page height. */
  pageHeight: number
  /** Column index (0 = left, 1 = right). Forces a paragraph break on change. */
  col: number
  /** Fragments split into column cells by large x-gaps (table detection). */
  segments?: Array<{ text: string; x: number }>
}

/** A paragraph (merged consecutive lines). */
interface Para {
  text: string
  fontSize: number
  fontName: string
  page: number
  pageHeight: number
  /** Top-y of the first line (bottom-up origin), for image interleaving. */
  topY: number
}

// ---------------------------------------------------------------------------
// pdfjs text-item extraction
// ---------------------------------------------------------------------------

interface PdfjsTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

function isTextItem(item: unknown): item is PdfjsTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { str?: unknown }).str === 'string' &&
    Array.isArray((item as { transform?: unknown }).transform)
  )
}

// ---------------------------------------------------------------------------
// Classification heuristics
// ---------------------------------------------------------------------------
// (code/console detection + its regexes live in line-utils.looksLikeCode so they
//  are unit-testable; the list/heading/furniture regexes below stay here.)

/** Numbered list prefix: "1.", "1)", "1.1", "1.1.1", "(1)", "(a)", "a.", etc. */
const LIST_NUMBERED_RE = /^\s*(?:\(\d+(?:\.\d+)*\)|\d+(?:\.\d+)*[.)]\s+|[a-zA-Z][.)]\s+)/
/**
 * Bulleted list prefix. The Manning book uses a filled-square marker (■, U+25A0)
 * and an en-dash ("–Chapter 1…") that sits IMMEDIATELY next to the text with no
 * space, so we allow zero or more trailing spaces (not `\s+`).
 */
const LIST_BULLET_RE = /^\s*[•●▪◦■▪◦*\-–—―·•]\s*/
/** A line whose only content is a bullet marker (its text lives on the next line). */
const BULLET_ONLY_RE = /^\s*[•●▪◦■▪◦*\-–—―·•]+\s*$/

/** TOC dot-leader line: "Title .......... 123" (three+ dots then a page number). */
const TOC_DOT_LEADER_RE = /\.{3,}\s*\d+\s*$/
/**
 * TOC entry whose page number is GLUED to the text (dots are vector graphics in
 * this book, so they never appear as text): "Exploring the role3", "manager28".
 * A letter/quote is immediately followed by 1鈥? digits at the line end.
 */
const TOC_GLUED_NUM_RE = /[A-Za-z)\]'"]\s*\d{1,3}\s*$/
/**
 * TOC entry that starts with a glued section/chapter number:
 *   "1.1Demystifying", "2Individual contributor...", "12.1Importance..."
 */
const TOC_SECTION_START_RE = /^\s*\d+(?:\.\d+){0,2}\s*[A-Z"']/
/** TOC title words. */
const TOC_TITLE_RE = /^(?:brief\s+contents|contents|table\s+of\s+contents)\s*$/i

/** How close to the top/bottom edge counts as header/footer (fraction of page).
 * O'Reilly running feet sit ~7% from the edge, so 0.06 was too tight (gap #2). */
const HEADER_BAND = 0.09
const FOOTER_BAND = 0.09

/**
 * Merge lines into paragraphs when the vertical gap is small and the font size
 * is stable. Simplified from segment.ts 鈥?we don't need alignment detection.
 */
const LINE_GAP_RATIO = 1.6
const FONT_TOLERANCE = 0.18

/**
 * x-gap (pt) between fragments that signals a new table column. Tuned so normal
 * inter-word spacing (~2鈥?pt) never splits a line, but table cell gaps do.
 */
const TABLE_COL_GAP_PT = 22
/** Minimum number of columns for a line to count as a table row. */
const TABLE_MIN_COLS = 3
/** Minimum consecutive table rows to treat a run as a table. */
const TABLE_MIN_ROWS = 2

/**
 * Detect table rows from RawLines: a line whose fragments split into >=TABLE_MIN_COLS
 * column cells, and a run of >=TABLE_MIN_ROWS such rows on the same page/column with
 * consistent column counts. Returns the detected tables plus the set of line indices
 * to exclude from paragraph building.
 */
interface DetectedTable {
  cells: string[][]
  page: number
  startTopY: number
  /** Column x-anchor centers used for detection (for proportional column widths). */
  anchors: number[]
  /** Per-column width weights (sums to ~1), from anchor spacing. */
  colWidths: number[]
}

/** Header row: short labels in every column (guards the page-repeat logic). */
function looksLikeHeaderRow(cells: string[][]): boolean {
  if (cells.length < 2) return false
  const first = cells[0]
  return first.length >= 2 && first.every((c) => c.trim().length > 0 && c.trim().length <= 24)
}

/** Cluster x-positions into column anchors; returns sorted cluster centers. */
function clusterX(xs: number[], clusterGap: number): number[] {  if (xs.length === 0) return []
  const sorted = xs.slice().sort((a, b) => a - b)
  const clusters: number[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - clusters[clusters.length - 1][0] <= clusterGap) {
      clusters[clusters.length - 1].push(sorted[i])
    } else {
      clusters.push([sorted[i]])
    }
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length)
}

function nearestAnchor(x: number, anchors: number[], tol: number): number {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.abs(x - anchors[i])
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return bestDist <= tol ? best : -1
}

/**
 * Detect tables by x-coordinate column clustering.
 *
 * A table page has >=3 recurring column anchors (e.g. x=72 / 181 / 410). Lines
 * whose fragments land on these anchors form the table region. Wrapped cells
 * span multiple visual lines; rows are split by a vertical gap larger than
 * body line spacing (~1.5x font). Continuation lines that touch only some
 * columns are folded into the current row's cells.
 */
function detectTables(lines: RawLine[], codeFonts: Set<string>): { tables: DetectedTable[]; skip: Set<RawLine> } {
  const tables: DetectedTable[] = []
  const skip = new Set<RawLine>()

  const byPage = new Map<number, RawLine[]>()
  for (const l of lines) {
    // Real typeset tables use the body/table font. Console/JSON dumps use the
    // CODE font (the same font the %sql/%sh/+---+ lines use) — exclude only that
    // exact font, so a JSON blob isn't mistaken for a table (E2E Image 4) while
    // smaller-but-real table-cell fonts (Manning) are preserved.
    if (l.fontName && codeFonts.has(l.fontName)) continue
    if (!byPage.has(l.page)) byPage.set(l.page, [])
    byPage.get(l.page)!.push(l)
  }

  for (const [page, plines] of byPage) {
    const withSegs = plines.filter((l) => (l.segments?.length ?? 0) >= 1)
    if (withSegs.length < TABLE_MIN_ROWS) continue

    const allX: number[] = []
    for (const l of withSegs) for (const s of l.segments!) allX.push(s.x)
    const anchors = clusterX(allX, 30).filter(
      (a) => allX.filter((x) => Math.abs(x - a) <= 14).length >= 3
    )
    if (anchors.length < TABLE_MIN_COLS) continue

    // Classify each line: set of anchor indices it touches.
    interface Mapped {
      line: RawLine
      cols: number[]
    }
    const mapped: Mapped[] = []
    for (const l of withSegs) {
      const cols = new Set<number>()
      for (const s of l.segments!) {
        const ai = nearestAnchor(s.x, anchors, 16)
        if (ai >= 0) cols.add(ai)
      }
      if (cols.size >= 1) mapped.push({ line: l, cols: [...cols] })
    }
    // A table region needs a line touching >=3 distinct columns (a real row).
    const hasFullRow = mapped.some((m) => m.cols.length >= TABLE_MIN_COLS)
    if (!hasFullRow) continue

    // Sort top-down (high y first).
    mapped.sort((a, b) => b.line.y - a.line.y)
    // Group into runs that stay on the same anchor set, split by big vertical gaps.
    const runs: Mapped[][] = []
    let curRun: Mapped[] = []
    let prev: Mapped | null = null
    for (const m of mapped) {
      if (prev) {
        const gap = Math.abs(prev.line.y - m.line.y)
        // Break a run when vertical gap exceeds ~2.5x line height (region boundary).
        if (gap > Math.max(prev.line.fontSize, m.line.fontSize) * 2.5) {
          runs.push(curRun)
          curRun = []
        }
      }
      curRun.push(m)
      prev = m
    }
    if (curRun.length) runs.push(curRun)

    for (const run of runs) {
      if (run.length < TABLE_MIN_ROWS) continue
      // Require the run to actually contain a full (>=3-col) row.
      if (!run.some((m) => m.cols.length >= TABLE_MIN_COLS)) continue
      // Console ASCII dumps (+---+ / |---| command output) are CODE, not tables.
      // Real typeset tables use drawn vector rules, never literal + - | text, so
      // the presence of border text is a reliable console-dump signal. Skip the
      // run so its lines fall through to the prose->code path (and so a
      // full-width paragraph above the dump isn't absorbed into column 1).
      const borderLines = run.filter((m) => ASCII_DUMP_RE.test(m.line.text)).length
      if (borderLines >= 2) continue

      // Split run into rows by intra-row vs inter-row gap.
      const ncols = anchors.length
      const rows: string[][] = []
      let curCells: string[][] = []
      let prevLine: RawLine | null = null
      const flushRow = (): void => {
        // Merge per-column fragments top-down.
        const merged = new Array(ncols).fill('')
        for (const parts of curCells) {
          for (let c = 0; c < ncols; c++) {
            if (parts[c]) merged[c] += (merged[c] ? ' ' : '') + parts[c]
          }
        }
        rows.push(merged.map((s: string) => s.trim()))
        curCells = []
      }
      for (const m of run) {
        if (prevLine) {
          const gap = Math.abs(prevLine.y - m.line.y)
          const lineH = Math.max(prevLine.fontSize, m.line.fontSize)
          // Larger gap starts a new logical row (cells wrap, so 1.6x separates rows).
          if (gap > lineH * 1.6 && curCells.length > 0) {
            flushRow()
          }
        }
        // Build this visual line's per-column text.
        const parts: string[] = new Array(ncols).fill('')
        for (const s of m.line.segments!) {
          const ai = nearestAnchor(s.x, anchors, 16)
          if (ai >= 0) parts[ai] += (parts[ai] ? ' ' : '') + s.text.trim()
        }
        curCells.push(parts)
        prevLine = m.line
      }
      flushRow()

      if (rows.length < TABLE_MIN_ROWS) continue
      // Drop fully-empty rows.
      const clean = rows.filter((r) => r.some((c) => c.trim().length > 0))
      if (clean.length < TABLE_MIN_ROWS) continue
      // Prune all-empty columns and derive proportional column widths from the
      // anchor spacing (equal-width columns squeeze wrapped text into one-char
      // vertical stacks — the classic Manning-table rendering bug).
      const keep: number[] = []
      for (let c = 0; c < ncols; c++) {
        if (clean.some((r) => (r[c] ?? '').trim().length > 0)) keep.push(c)
      }
      const pruned = clean.map((r) => keep.map((c) => r[c] ?? ''))
      if (keep.length < 2 || pruned.length < TABLE_MIN_ROWS) continue
      const gaps: number[] = []
      const rawGaps: number[] = []
      for (let i = 1; i < anchors.length; i++) rawGaps.push(anchors[i] - anchors[i - 1])
      rawGaps.sort((a, b) => a - b)
      const medianGap = rawGaps.length ? Math.max(24, rawGaps[Math.floor(rawGaps.length / 2)]) : 60
      for (let i = 0; i < keep.length; i++) {
        const w = i + 1 < keep.length ? anchors[keep[i + 1]] - anchors[keep[i]] : medianGap
        gaps.push(Math.max(24, w))
      }
      const gw = gaps.reduce((a, b) => a + b, 0) || 1
      const colWidths = gaps.map((g) => g / gw)
      tables.push({ cells: pruned, page, startTopY: run[0].line.y, anchors, colWidths })
      for (const m of run) skip.add(m.line)
    }
  }
  return { tables, skip }
}

/** Merge visual lines into paragraphs (joinLines de-hyphenates soft breaks). */
function mergeLinesToParas(lines: RawLine[], bodySize: number): Para[] {
  const paras: Para[] = []
  let cur: {
    texts: string[]
    fontSize: number
    fontName: string
    page: number
    col: number
    pageHeight: number
    topY: number
  } | null = null
  let prevBaseline = 0
  // A line that is ONLY a bullet marker (■ / • …) with its real text on the
  // next visual line: defer it and prepend "• " to that next line instead of
  // emitting a throwaway paragraph that the furniture filter would drop.
  let pendingBullet = false

  for (const line of lines) {
    // Pure bullet-marker line: remember it, skip (don't start/join a paragraph).
    if (BULLET_ONLY_RE.test(line.text.trim())) {
      pendingBullet = true
      continue
    }
    // Prepend a bullet to the first real text line after a marker-only line.
    const lineText = pendingBullet ? '• ' + line.text : line.text
    pendingBullet = false

    if (!cur) {
      cur = {
        texts: [lineText],
        fontSize: line.fontSize,
        fontName: line.fontName,
        page: line.page,
        col: line.col,
        pageHeight: line.pageHeight,
        topY: line.y
      }
      prevBaseline = line.y
      continue
    }
    // Vertical gap between this line's baseline and the previous one (in pt).
    // Larger y = higher on page, so moving to the next line DOWN means y decreases.
    const gap = prevBaseline - line.y
    const lineH = cur.fontSize
    const fontRatio = Math.min(line.fontSize, cur.fontSize) / Math.max(line.fontSize, cur.fontSize)
    // Code is LINE-oriented: never merge a smaller-than-body (code-font) line
    // with its neighbours — each code line stays its own paragraph so the code
    // block preserves its newlines (bug: console dumps collapsed to one line).
    const codeFont = (fs: number): boolean => bodySize > 0 && fs <= bodySize * CODE_FONT_RATIO
    const codeLine = codeFont(line.fontSize) || codeFont(cur.fontSize)
    // Never merge across a page boundary (the y coordinate resets, which would
    // otherwise produce a huge negative gap and glue pages together), nor across
    // a column boundary (left column ends, right column begins).
    const sameFlow = line.page === cur.page && line.col === cur.col
    // A new list marker always starts a fresh logical block: wrapped prose of the
    // previous item must not bleed into the next "–Chapter N…" item.
    const startsListItem =
      LIST_BULLET_RE.test(lineText) || LIST_NUMBERED_RE.test(lineText)
    // A section-numbered heading ("1.1.3 Traits…") always starts a new paragraph,
    // even if the vertical gap to the previous line is small. Without this,
    // the heading gets glued to the following body prose and both render on
    // the same line (the "folding" bug). No length limit: a heading start
    // pattern at the beginning of a line always forces a break, even if the
    // line continues into body text (PDF text extraction may join them).
    const startsHeading = SECTION_NUM_HEADING_RE.test(lineText.trim())
    if (sameFlow && !codeLine && !startsListItem && !startsHeading && gap <= lineH * LINE_GAP_RATIO && fontRatio > 1 - FONT_TOLERANCE) {
      cur.texts.push(lineText)
      cur.fontSize = (cur.fontSize + line.fontSize) / 2
    } else {
      paras.push({
        text: joinLines(cur.texts),
        fontSize: cur.fontSize,
        fontName: cur.fontName,
        page: cur.page,
        pageHeight: cur.pageHeight,
        topY: cur.topY
      })
      cur = {
        texts: [lineText],
        fontSize: line.fontSize,
        fontName: line.fontName,
        page: line.page,
        col: line.col,
        pageHeight: line.pageHeight,
        topY: line.y
      }
    }
    prevBaseline = line.y
  }
  if (cur) {
    paras.push({
      text: joinLines(cur.texts),
      fontSize: cur.fontSize,
      fontName: cur.fontName,
      page: cur.page,
      pageHeight: cur.pageHeight,
      topY: cur.topY
    })
  }
  return paras
}

// ---------------------------------------------------------------------------
// Header / footer / TOC detection
// ---------------------------------------------------------------------------

/**
 * A line is header/footer furniture if it sits in the top/bottom 6% band of the
 * page and uses a small-ish font. We compute the band from the line's baseline y.
 *
 * pdfjs y is bottom-left origin, so:
 *   top of page    = pageHeight  鈫?y near pageHeight
 *   bottom of page = 0           鈫?y near 0
 */
function isInHeaderBand(line: RawLine): boolean {
  return line.y >= line.pageHeight * (1 - HEADER_BAND)
}
function isInFooterBand(line: RawLine): boolean {
  return line.y <= line.pageHeight * FOOTER_BAND
}

/** A non-empty line "looks like" a TOC entry. */
function isTocEntryLine(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 140) return false
  if (TOC_DOT_LEADER_RE.test(t)) return true
  if (TOC_SECTION_START_RE.test(t)) return true
  // Glued trailing page number (letter immediately followed by small int).
  if (TOC_GLUED_NUM_RE.test(t)) return true
  return false
}

/**
 * Heuristic TOC-page detector. A page is TOC if EITHER:
 *   (a) it carries a TOC title word ("contents" / "brief contents" / "鐩綍" ...)
 *       and has at least 3 TOC-entry lines, OR
 *   (b) more than 30% of non-empty lines look like TOC entries.
 *
 * Rationale: in this book the leader dots are vector graphics, so the classic
 * ".... N" pattern only matches the PART lines; the real signal is glued page
 * numbers ("role3") and glued section numbers ("1.1Demystifying").
 */
function isTocPage(lines: RawLine[]): boolean {
  const nonEmpty = lines.filter((l) => l.text.trim().length > 0)
  if (nonEmpty.length < 4) return false
  let entryCount = 0
  let hasTitle = false
  for (const l of nonEmpty) {
    const t = l.text.trim()
    if (TOC_TITLE_RE.test(t)) hasTitle = true
    else if (isTocEntryLine(t)) entryCount++
  }
  if (hasTitle && entryCount >= 3) return true
  return entryCount / nonEmpty.length > 0.3
}

// ---------------------------------------------------------------------------
// Body-size detection (adaptive)
// ---------------------------------------------------------------------------

/**
 * Estimate the body font size: the mode of font sizes weighted by text length.
 * This makes heading thresholds adaptive across books with different base sizes.
 */
function estimateBodySize(items: Array<{ text: string; fontSize: number }>): number {
  const sizeBuckets = new Map<number, number>()
  for (const p of items) {
    const bucket = Math.round(p.fontSize)
    sizeBuckets.set(bucket, (sizeBuckets.get(bucket) ?? 0) + p.text.length)
  }
  let best = 0
  let bestWeight = -1
  for (const [size, weight] of sizeBuckets) {
    if (weight > bestWeight) {
      bestWeight = weight
      best = size
    }
  }
  return best > 0 ? best : 11
}

/** Map a font size to a heading level (1=largest). Returns 0 if not a heading. */
function headingLevel(fontSize: number, bodySize: number): number {
  const ratio = fontSize / bodySize
  if (ratio >= 1.6) return 1
  if (ratio >= 1.35) return 2
  if (ratio >= 1.2) return 3
  if (ratio > 1.08) return 4
  return 0
}

// ---------------------------------------------------------------------------
// Paragraph classification
// ---------------------------------------------------------------------------

type ParaKind = 'heading' | 'body' | 'code' | 'list-item' | 'formula'

/** Math-heavy symbols that mark a line as a formula (never translated). */
const FORMULA_SYMBOL_RE = /[∑∫√∞≈≠≤≥±×÷∂∆∏∏∑∫]/g

/**
 * Section-numbered heading: "1.1 Demystifying the EM role", "1.1.1Roles and
 * responsibilities…". The number is glued to a Capitalized title. Short only —
 * once a heading merges into body prose it stops looking like one.
 */
const SECTION_NUM_HEADING_RE = /^\d+(?:\.\d+)+\s*[A-Z]/

function classifyPara(p: Para, bodySize: number, codeFonts: Set<string>): ParaKind {
  const text = p.text.trim()
  if (text.length === 0) return 'body'

  // Formula: high density of math symbols — passed through verbatim.
  const fSymCount = (text.match(FORMULA_SYMBOL_RE) || []).length
  if (text.length > 5 && fSymCount >= 2 && fSymCount / text.length > 0.08) return 'formula'

  // Code / console output: verbatim, never translated. Decision logic lives in
  // line-utils.looksLikeCode (unit-tested R21); codeFonts are the fonts already
  // proven to be code (from %sql/+---+/REPL lines) — the strongest signal.
  if (looksLikeCode(text, p.fontName, p.fontSize, bodySize, codeFonts)) return 'code'

  // List item?
  if (LIST_NUMBERED_RE.test(text) || LIST_BULLET_RE.test(text)) return 'list-item'

  // Section-numbered heading (e.g. "1.1 Demystifying…", "1.1.3 Traits…"): the
  // size-based detector misses these because they sit only slightly above body.
  if (SECTION_NUM_HEADING_RE.test(text) && text.length <= 90) return 'heading'

  // Heading?
  const level = headingLevel(p.fontSize, bodySize)
  if (level > 0) return 'heading'

  return 'body'
}

// ---------------------------------------------------------------------------
// Image extraction (pdf-lib) + positioning (pdfjs operatorList)
// ---------------------------------------------------------------------------

/** One extracted image: raw bytes + metadata. */
interface ExtractedImage {
  bytes: Uint8Array
  format: 'jpg' | 'png'
  pixelWidth: number
  pixelHeight: number
}

/** Where an image is painted on a page (from pdfjs operatorList CTM tracking). */
interface ImagePlacement {
  /** 1-based page number. */
  page: number
  /** Center-y in PDF coordinates (bottom-up origin). */
  centerY: number
  /** Left x in points (bottom-up origin) — used to rasterize un-extractable images. */
  x: number
  /** Bottom y in points (bottom-up origin). */
  yBot: number
  /** Display width in points. */
  displayW: number
  /** Display height in points. */
  displayH: number
  /** Pixel width (for matching with pdf-lib extracted images). */
  pixelW: number
  /** Pixel height (for matching). */
  pixelH: number
}

// ---- Minimal pure-JS PNG encoder (FlateDecode → PNG) ---------------------
const PNG_CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1 ? 0xedb88320 : 0) ^ (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function pngCrc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode raw 8-bit RGB pixels (width*height*3) as a PNG byte buffer. */
function rgbToPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type = RGB
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const idat = zlib.deflateSync(raw)
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(idat)), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Decode a FlateDecode 8-bit RGB image (no predictor) to PNG bytes, or null. */
function flateImageToPng(
  contents: Uint8Array,
  width: number,
  height: number,
  bitsPerComponent: number,
  colorSpace: string
): Uint8Array | null {
  try {
    if (bitsPerComponent !== 8) return null
    if (colorSpace !== '/DeviceRGB' && colorSpace !== 'DeviceRGB') return null
    const expected = width * height * 3
    const raw = zlib.inflateSync(Buffer.from(contents))
    if (raw.length !== expected) return null // predictor / unusual layout — skip
    return rgbToPng(width, height, new Uint8Array(raw.buffer, raw.byteOffset, raw.length))
  } catch {
    return null
  }
}

/**
 * Recursively walk a resources dictionary (and nested Form XObject resources)
 * to collect all Image XObjects. Returns an ordered list of extracted images
 * per page (1-based).
 *
 * DCTDecode (JPEG) and FlateDecode (8-bit RGB, decoded to PNG) are extracted.
 * Other filters (JPXDecode / CCITTFaxDecode etc.) are skipped.
 */
function extractImagesFromPage(
  pdfDoc: PDFDocument,
  pageIndex: number
): ExtractedImage[] {
  const page = pdfDoc.getPage(pageIndex)
  const leaf = page.node
  const results: ExtractedImage[] = []
  const seen = new Set<string>()

  const walkResources = (res: PDFDict | undefined): void => {
    if (!res) return
    const xobj = res.lookupMaybe(PDFName.XObject, PDFDict)
    if (!xobj) return
    for (const [key] of xobj.entries()) {
      const obj = xobj.lookup(key)
      if (!obj) continue
      const dict = (obj as PDFStream).dict
      if (!dict) continue
      const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
      const subtypeStr = subtype ? subtype.toString() : ''

      if (subtypeStr === '/Image') {
        // It's an image XObject.
        const filter = dict.lookupMaybe(PDFName.of('Filter'), PDFName)
        const filterStr = filter ? filter.toString() : ''
        const w = dict.lookupMaybe(PDFName.of('Width'), PDFNumber)
        const h = dict.lookupMaybe(PDFName.of('Height'), PDFNumber)
        const pw = w ? w.asNumber() : 0
        const ph = h ? h.asNumber() : 0

        // Deduplicate by object identity (same image may appear in multiple
        // resource dicts).
        const refKey = String(obj.constructor.name) + ':' + pw + 'x' + ph + ':' + (obj as { byteOffset?: number }).byteOffset
        if (seen.has(refKey)) continue
        seen.add(refKey)

        if (filterStr === '/DCTDecode' && obj instanceof PDFRawStream) {
          // JPEG — raw contents are already JPEG bytes.
          results.push({
            bytes: obj.contents,
            format: 'jpg',
            pixelWidth: pw,
            pixelHeight: ph
          })
        } else if (filterStr === '/FlateDecode' && obj instanceof PDFRawStream) {
          // FlateDecode — decompress and convert 8-bit RGB to PNG (pure JS).
          const bpcObj = dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)
          const bpc = bpcObj ? bpcObj.asNumber() : 8
          const csObj = dict.lookupMaybe(PDFName.of('ColorSpace'), PDFName)
          const csStr = csObj ? csObj.toString() : ''
          const png = flateImageToPng(obj.contents, pw, ph, bpc, csStr)
          if (png) {
            results.push({ bytes: png, format: 'png', pixelWidth: pw, pixelHeight: ph })
          } else {
            console.log(`[capture/flow] skipped Flate image ${pw}x${ph} bpc=${bpc} cs=${csStr}`)
          }
        } else {
          // JPXDecode / CCITTFaxDecode / etc. — unsupported, skipped.
          console.log(`[capture/flow] skipped image filter=${filterStr} ${pw}x${ph}`)
        }
      } else if (subtypeStr === '/Form') {
        // Recurse into Form XObject resources.
        const innerRes = dict.lookupMaybe(PDFName.Resources, PDFDict)
        walkResources(innerRes)
      }
    }
  }

  const resources = leaf.Resources()
  walkResources(resources)
  return results
}

// ---------------------------------------------------------------------------
// CTM tracking for image placement (pdfjs operatorList)
// ---------------------------------------------------------------------------

type CTM = [number, number, number, number, number, number]

const IDENTITY_CTM: CTM = [1, 0, 0, 1, 0, 0]

function multiplyCTM(m1: CTM, m2: CTM): CTM {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ]
}

function arrayToCTM(arr: number[]): CTM {
  return [arr[0] || 0, arr[1] || 0, arr[2] || 0, arr[3] || 0, arr[4] || 0, arr[5] || 0]
}

/**
 * Walk a page's operator list and record where each Image XObject is painted.
 *
 * We track the CTM through save/restore, transform (cm), and Form XObject
 * nesting. When paintImageXObject fires, the CTM's translation (e,f) and
 * scale (a,d) tell us the image's position and display size on the page.
 */
function trackImagePlacements(
  fnArray: number[],
  argsArray: unknown[][],
  pageNumber: number
): ImagePlacement[] {
  const placements: ImagePlacement[] = []
  let ctm: CTM = [...IDENTITY_CTM]
  const stack: CTM[] = []

  // pdfjs OPS (see probe above):
  //   save = 10, restore = 11, transform = 12
  //   paintFormXObjectBegin = 74, paintFormXObjectEnd = 75
  //   paintImageXObject = 85

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]

    if (fn === 10) {
      // save
      stack.push([...ctm])
    } else if (fn === 11) {
      // restore
      if (stack.length > 0) ctm = stack.pop()!
    } else if (fn === 12) {
      // transform (cm): post-multiply
      if (Array.isArray(args) && args.length >= 6) {
        ctm = multiplyCTM(ctm, arrayToCTM(args as number[]))
      }
    } else if (fn === 74) {
      // paintFormXObjectBegin: args = [matrix, bbox]
      stack.push([...ctm])
      if (Array.isArray(args) && Array.isArray(args[0]) && (args[0] as number[]).length >= 6) {
        ctm = multiplyCTM(ctm, arrayToCTM(args[0] as number[]))
      }
    } else if (fn === 75) {
      // paintFormXObjectEnd
      if (stack.length > 0) ctm = stack.pop()!
    } else if (fn === 85) {
      // paintImageXObject: args = [imageName, pixelW, pixelH]
      if (Array.isArray(args) && args.length >= 3) {
        const pixelW = args[1] as number
        const pixelH = args[2] as number
        // CTM gives us: scaleX=ctm[0], scaleY=ctm[3], x=ctm[4], y=ctm[5]
        const displayW = Math.abs(ctm[0])
        const displayH = Math.abs(ctm[3])
        const y = ctm[5]
        // Center-y of the image (bottom-up origin).
        const centerY = y + displayH / 2
        placements.push({
          page: pageNumber,
          centerY,
          x: ctm[4],
          yBot: y,
          displayW,
          displayH,
          pixelW,
          pixelH
        })
      }
    }
  }

  return placements
}

/**
 * Match pdfjs image placements to pdf-lib extracted images by (pixelW, pixelH).
 * Returns an ordered list of { image, placement } pairs for a page.
 */
function matchImagesToPlacements(
  extracted: ExtractedImage[],
  placements: ImagePlacement[]
): Array<{ image: ExtractedImage; placement: ImagePlacement }> {
  const used = new Set<number>()
  const pairs: Array<{ image: ExtractedImage; placement: ImagePlacement }> = []

  for (const p of placements) {
    // Find the first unused extracted image with matching dimensions.
    let foundIdx = -1
    for (let i = 0; i < extracted.length; i++) {
      if (used.has(i)) continue
      if (extracted[i].pixelWidth === p.pixelW && extracted[i].pixelHeight === p.pixelH) {
        foundIdx = i
        break
      }
    }
    if (foundIdx >= 0) {
      used.add(foundIdx)
      pairs.push({ image: extracted[foundIdx], placement: p })
    }
  }
  return pairs
}


/**
 * Defensive fix for a glued chapter+section heading seen in TOC artifacts:
 *   "11.1Demystifying ..." 鈫?"1.1Demystifying ..."
 *   "1212.1Importance ..." 鈫?"12.1Importance ..."
 * Only strips a leading run of digits D when the immediately following token
 * is "D.M" (i.e. D is its own integer part).
 */
function normalizeHeadingNumber(text: string): string {
  const m = /^(\d{1,2})(\d{1,2}\.\d+(?:\.\d+)?)(?=[A-Z])/.exec(text)
  if (m && m[2].startsWith(m[1])) {
    return m[2] + text.slice(m[0].length)
  }
  return text
}

/** True when `text` carries no translatable content (just bullets / punctuation). */
function isEmptyFurniture(text: string): boolean {
  return !/[A-Za-z0-9]/.test(text)
}

/**
 * Split a long paragraph that starts with a section-numbered heading pattern
 * but was classified as 'body' (because it also contains body text on the same
 * visual line). Returns { heading, body, level } or null if no split needed.
 *
 * Examples:
 *   "1.1.1 Roles and responsibilities: Core capabilities. An EM..."
 *   → heading="1.1.1 Roles and responsibilities", body="Core capabilities. An EM..."
 */
function splitHeadingFromBody(
  text: string
): { heading: string; body: string; level: number } | null {
  const m = /^(\d+(?:\.\d+)+\s*[A-Z][^.]*?)([.:]\s|$)/.exec(text)
  if (!m) return null
  const headingPart = m[1].trim()
  // The heading must be reasonable length (< 80 chars) to avoid splitting prose.
  if (headingPart.length > 80) return null
  const rest = text.slice(m[0].length).trim()
  if (rest.length === 0) return null
  // Use h3 level for x.y.z headings, h2 for x.y.
  const dotCount = (headingPart.match(/\./g) || []).length
  const level = dotCount >= 3 ? 3 : 2
  return { heading: headingPart, body: rest, level }
}

// ---------------------------------------------------------------------------
// Main capture
// ---------------------------------------------------------------------------

export interface CaptureFlowOptions {
  /** Stop after this many pages (1-based inclusive). */
  pageLimit?: number
}

/** A detected figure region in PAGE-POINT, bottom-up coordinates. */
interface FigureRegion {
  page: number
  xLeft: number
  xRight: number
  yTop: number
  yBot: number
}

// C1 conservative gate: only rasterize SPARSE line-art diagrams. Measured on the
// whole book (docs/PDFZH-COMPARE.md #21): ink coverage can't separate a
// misclassified table (p55 18%) from real dense charts (p138/p147 17-19%), but
// genuine vector diagrams sit well under 12% (p57 ladder = 5.6%). Rasterizing
// only low-ink regions recovers clean figures with zero table/text loss.
const FIGURE_MAX_INK_PCT = 12
const FIGURE_MIN_INK_PCT = 0.5

/** Fraction (0..100) of dark pixels of a region, from the 480 detection buffer. */
function regionInkPct(rgba: Uint8Array, box: { x0: number; y0: number; x1: number; y1: number }, renderW: number, renderH: number): number {
  const sx = 480 / renderW
  const sy = 480 / renderH
  const x0 = Math.max(0, Math.floor(box.x0 * sx)), x1 = Math.min(479, Math.ceil(box.x1 * sx))
  const y0 = Math.max(0, Math.floor(box.y0 * sy)), y1 = Math.min(479, Math.ceil(box.y1 * sy))
  const w = x1 - x0, h = y1 - y0
  if (w < 2 || h < 2) return 100
  let dark = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * 480 + x) * 4
    if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 < 160) dark++
  }
  return (dark / (w * h)) * 100
}

/**
 * Detect figure/chart regions, keeping only SPARSE (low-ink) ones, deduped
 * against already-extracted bitmaps. Returns page-point bottom-up regions.
 * [] when the detector/canvas backend is unavailable (graceful no-op).
 */
async function detectFigureRegions(
  inputPath: string,
  max: number,
  matchedImages: Array<{ image: ExtractedImage; placement: ImagePlacement }>
): Promise<FigureRegion[]> {
  const detector = new LayoutDetector()
  let loaded = false
  try {
    loaded = await detector.ensureLoaded()
  } catch {
    loaded = false
  }
  if (!loaded) {
    if (detector.error) console.log(`[capture/flow] layout pass skipped: ${detector.error}`)
    return []
  }
  const covered = new Map<number, Array<{ c: number; h: number }>>()
  for (const m of matchedImages) {
    const arr = covered.get(m.placement.page) ?? []
    arr.push({ c: m.placement.centerY, h: m.placement.displayH })
    covered.set(m.placement.page, arr)
  }
  const DETECT_SCALE = 1.5
  const regions: FigureRegion[] = []
  const t0 = Date.now()
  for (let page = 1; page <= max; page++) {
    let buf
    try {
      buf = await renderForDetect(inputPath, page, DETECT_SCALE)
    } catch {
      continue
    }
    if (!buf) continue
    let boxes
    try {
      boxes = await detector.detect(buf.rgba, buf.renderW, buf.renderH)
    } catch {
      continue
    }
    const pageHpt = buf.renderH / buf.scale
    const cov = covered.get(page) ?? []
    for (const b of boxes) {
      if (b.cls !== 'image' && b.cls !== 'chart') continue
      const yTop = pageHpt - b.y0 / buf.scale
      const yBot = pageHpt - b.y1 / buf.scale
      const xLeft = b.x0 / buf.scale
      const xRight = b.x1 / buf.scale
      const h = yTop - yBot
      if (h < 40 || xRight - xLeft < 60) continue // noise slivers (min diagram size)
      const centerY = (yTop + yBot) / 2
      if (cov.some((c) => Math.abs(c.c - centerY) < (c.h + h) * 0.4)) continue // bitmap already there
      const ink = regionInkPct(buf.rgba, b, buf.renderW, buf.renderH)
      if (ink < FIGURE_MIN_INK_PCT || ink > FIGURE_MAX_INK_PCT) continue // dense chart/table or blank -> leave to text path
      regions.push({ page, xLeft, xRight, yTop, yBot })
    }
  }
  console.log(`[capture/flow] layout detect: ${regions.length} sparse figure regions (ink<=${FIGURE_MAX_INK_PCT}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return regions
}

/** True if a line's anchor falls inside any kept figure region on its page. */
function lineInRegion(line: RawLine, regionsByPage: Map<number, FigureRegion[]>): boolean {
  const rs = regionsByPage.get(line.page)
  if (!rs) return false
  for (const r of rs) {
    if (line.x >= r.xLeft - 2 && line.x <= r.xRight + 2 && line.y >= r.yBot - 2 && line.y <= r.yTop + 2) return true
  }
  return false
}

/** Rasterize kept regions to PNG image blocks (2x), for reading-order interleave. */
async function emitRegionImages(inputPath: string, regions: FigureRegion[]): Promise<Array<{ block: ContentBlock; page: number; topY: number }>> {
  if (regions.length === 0) return []
  const CLIP_SCALE = 2
  const entries: Array<{ block: ContentBlock; page: number; topY: number }> = []
  const pageHptCache = new Map<number, number>()
  for (const r of regions) {
    let pageHpt = pageHptCache.get(r.page)
    if (pageHpt === undefined) {
      const probe = await renderForDetect(inputPath, r.page, 1)
      pageHpt = probe ? probe.renderH / probe.scale : 792
      pageHptCache.set(r.page, pageHpt)
    }
    const clipBox = {
      x0: r.xLeft * CLIP_SCALE,
      y0: (pageHpt - r.yTop) * CLIP_SCALE,
      x1: r.xRight * CLIP_SCALE,
      y1: (pageHpt - r.yBot) * CLIP_SCALE
    }
    let clip
    try {
      clip = await renderClip(inputPath, r.page, clipBox, CLIP_SCALE)
    } catch {
      continue
    }
    if (!clip || clip.png.length < 1024) continue
    entries.push({
      block: {
        type: 'image',
        page: r.page,
        imageData: new Uint8Array(clip.png),
        imageFormat: 'png',
        imagePixelWidth: clip.w,
        imagePixelHeight: clip.h
      },
      page: r.page,
      topY: r.yTop
    })
  }
  await disposeRenderer().catch(() => undefined)
  return entries
}

/**
 * Rasterize image placements we could NOT byte-extract — chiefly JPXDecode
 * (JPEG2000), which pdf-lib can't decode but pdfjs CAN render. Many O'Reilly
 * books store ALL their figures as JPX (Delta Lake: 15/16 in the first 100 pp),
 * so without this they vanish from the output. Renders each placement's page
 * region to PNG at 2x. Returns entries + their placement (for C1 dedup).
 */
async function rasterizePlacements(
  inputPath: string,
  placements: ImagePlacement[]
): Promise<Array<{ block: ContentBlock; page: number; topY: number; placement: ImagePlacement }>> {
  const SCALE = 2
  const entries: Array<{ block: ContentBlock; page: number; topY: number; placement: ImagePlacement }> = []
  const pageHptCache = new Map<number, number>()
  for (const pl of placements) {
    if (pl.displayW < 40 || pl.displayH < 40) continue // skip tiny decorations/rules
    let pageHpt = pageHptCache.get(pl.page)
    if (pageHpt === undefined) {
      const probe = await renderForDetect(inputPath, pl.page, 1)
      pageHpt = probe ? probe.renderH : 792
      pageHptCache.set(pl.page, pageHpt)
    }
    const yTop = pl.yBot + pl.displayH
    const clipBox = {
      x0: pl.x * SCALE,
      y0: (pageHpt - yTop) * SCALE,
      x1: (pl.x + pl.displayW) * SCALE,
      y1: (pageHpt - pl.yBot) * SCALE
    }
    let clip
    try {
      clip = await renderClip(inputPath, pl.page, clipBox, SCALE)
    } catch {
      continue
    }
    if (!clip || clip.png.length < 1024) continue
    entries.push({
      block: {
        type: 'image',
        page: pl.page,
        imageData: new Uint8Array(clip.png),
        imageFormat: 'png',
        imagePixelWidth: clip.w,
        imagePixelHeight: clip.h
      },
      page: pl.page,
      topY: yTop,
      placement: pl
    })
  }
  return entries
}

/**
 * Extract a flat content-block stream from the PDF at `inputPath`.
 *
 * @param inputPath path to the source PDF.
 * @param options   optional pageLimit for fast tests.
 */
export async function captureFlow(
  inputPath: string,
  options: CaptureFlowOptions = {}
): Promise<FlowCaptureResult> {
  const data = new Uint8Array(fs.readFileSync(inputPath))

  // ---- Load with pdfjs for text + operatorList ----
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true
  })
  const pdf = await loadingTask.promise

  const max = options.pageLimit && options.pageLimit > 0 ? Math.min(options.pageLimit, pdf.numPages) : pdf.numPages

  // ---- Load with pdf-lib for image byte extraction ----
  const pdfDoc = await PDFDocument.load(data, { ignoreEncryption: true })

  // Collect all lines first (needed for adaptive body-size detection).
  const allLines: RawLine[] = []
  // Collect image placements per page (from pdfjs operatorList CTM tracking).
  const placementsByPage = new Map<number, ImagePlacement[]>()

  try {
    for (let pageNumber = 1; pageNumber <= max; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1.0 })
      const textContent = await page.getTextContent()
      const pageHeight = viewport.height

      // Step 1: raw items 鈫?lines (group by baseline).
      const linesOnPage = groupItemsIntoLines(textContent.items, pageNumber, viewport.width, pageHeight)

      // Step 2: drop header/footer band text, running "<num>|<title>" heads,
      // and pure page numbers (Arabic + Roman).
      const filtered = linesOnPage.filter((l) => {
        if (isRunningFurniture(l.text, l.y, l.pageHeight)) return false
        if (isInHeaderBand(l) || isInFooterBand(l)) return false
        return true
      })

      // Step 3: TOC page 鈫?skip entirely.
      if (isTocPage(filtered)) {
        await page.cleanup()
        continue
      }

      allLines.push(...filtered)

      // Step 3b: track image placements via operatorList CTM.
      try {
        const opList = await page.getOperatorList()
        const placements = trackImagePlacements(opList.fnArray, opList.argsArray, pageNumber)
        if (placements.length > 0) {
          placementsByPage.set(pageNumber, placements)
        }
      } catch {
        // OperatorList failure shouldn't break text extraction.
      }

      await page.cleanup()
    }
  } finally {
    await pdf.destroy()
  }

  // ---- Extract image bytes via pdf-lib (recursive through Form XObjects) ----
  const extractedByPage = new Map<number, ExtractedImage[]>()
  for (let p = 0; p < max; p++) {
    try {
      const imgs = extractImagesFromPage(pdfDoc, p)
      if (imgs.length > 0) {
        extractedByPage.set(p + 1, imgs)
      }
    } catch {
      // Skip pages that fail image extraction.
    }
  }

  // Match placements to extracted images per page.
  const matchedImages: Array<{ image: ExtractedImage; placement: ImagePlacement }> = []
  let imageCount = 0
  for (const [pageNum, placements] of placementsByPage) {
    const extracted = extractedByPage.get(pageNum) ?? []
    const pairs = matchImagesToPlacements(extracted, placements)
    matchedImages.push(...pairs)
    imageCount += pairs.length
  }
  // Placements pdf-lib couldn't byte-extract (JPXDecode/JPEG2000 etc.) — rasterize
  // them via pdfjs so their figures aren't silently dropped (E2E: missing figures).
  const matchedSet = new Set(matchedImages.map((m) => m.placement))
  const allPlacements = [...placementsByPage.values()].flat()
  const unmatched = allPlacements.filter((p) => !matchedSet.has(p))
  const rasterizedImages = await rasterizePlacements(inputPath, unmatched)
  imageCount += rasterizedImages.length
  console.log(`[capture/flow] extracted ${matchedImages.length} + rasterized ${rasterizedImages.length} images (of ${allPlacements.length} placements) from ${max} pages`)

  // C1 layout detection (BEFORE prose assembly): sparse figure regions, so their
  // extractable labels can be dropped from prose (they'd otherwise leak in as
  // garbage and collide with the rasterized figure). Coverage includes the
  // rasterized JPX placements so C1 doesn't re-rasterize the same region.
  const coverage = [...matchedImages, ...rasterizedImages.map((r) => ({ image: null as unknown as ExtractedImage, placement: r.placement }))]
  const figureRegions = await detectFigureRegions(inputPath, max, coverage)
  const regionsByPage = new Map<number, FigureRegion[]>()
  for (const r of figureRegions) {
    const a = regionsByPage.get(r.page) ?? []
    a.push(r)
    regionsByPage.set(r.page, a)
  }

  // Step 3.5: drop repeated running heads/feet, then detect tables from
  // RawLines (>=3 column cells, consecutive rows).
  // Table lines are pulled out of the prose stream and emitted as TableBlocks.
  // Detect tables on the FULL line set (a figure region must not starve table
  // detection of its grid lines), THEN drop leaked labels from prose only.
  const bodyLines = dropRepeatedEdgeText(allLines, max)
  // Fonts used by DEFINITIVE code markers (%sql, +---+ dumps, REPL prompts).
  // Excluding exactly these from table detection catches JSON/console dumps
  // (E2E Image 4) without harming real table-cell fonts (Manning control).
  const codeFonts = new Set<string>()
  for (const l of bodyLines) {
    if (MAGIC_CELL_RE.test(l.text) || ASCII_DUMP_RE.test(l.text) || REPL_PROMPT_RE.test(l.text)) {
      if (l.fontName) codeFonts.add(l.fontName)
    }
  }
  const { tables, skip: tableLines } = detectTables(bodyLines, codeFonts)
  console.log(`[capture/flow] detected ${tables.length} tables`)
  const proseLines = bodyLines.filter((l) => !tableLines.has(l) && !lineInRegion(l, regionsByPage))
  const tableEntries = tables.map((t) => ({
    block: {
      type: 'table',
      cells: t.cells,
      rows: t.cells.length,
      cols: t.cells[0]?.length ?? 0,
      hasHeader: looksLikeHeaderRow(t.cells),
      colWidths: t.colWidths,
      page: t.page
    } as ContentBlock,
    page: t.page,
    topY: t.startTopY
  }))

  // Step 4: merge lines → paragraphs. Body size estimated from the LINES so the
  // merge keeps code-font (smaller) lines as separate paragraphs, preserving
  // code/console block line structure (E2E Image 3: console wall).
  const bodySize = estimateBodySize(proseLines)
  const paras = mergeLinesToParas(proseLines, bodySize)

  // Step 5: classify.

  // Step 6: build ContentBlock stream, grouping consecutive list-items and code.
  // Track the y-position of each block for image interleaving.
  interface BlockEntry {
    block: ContentBlock
    page: number
    topY: number
  }
  const blockEntries: BlockEntry[] = []

  let pendingList: string[] = []
  let pendingListPage = 0
  let pendingListTopY = 0
  let pendingCode: string[] = []
  let pendingCodePage = 0
  let pendingCodeTopY = 0

  const flushList = (): void => {
    if (pendingList.length > 0) {
      blockEntries.push({
        block: { type: 'list', items: pendingList, page: pendingListPage },
        page: pendingListPage,
        topY: pendingListTopY
      })
      pendingList = []
    }
  }
  const flushCode = (): void => {
    if (pendingCode.length > 0) {
      blockEntries.push({
        block: { type: 'code', code: pendingCode.join('\n'), page: pendingCodePage },
        page: pendingCodePage,
        topY: pendingCodeTopY
      })
      pendingCode = []
    }
  }

  for (const para of paras) {
    const kind = classifyPara(para, bodySize, codeFonts)

    if (kind === 'code') {
      flushList()
      pendingCode.push(para.text)
      pendingCodePage = para.page
      pendingCodeTopY = para.topY
    } else if (kind === 'list-item') {
      flushCode()
      const stripped = stripBleedingPageNumbers(
        para.text.replace(LIST_NUMBERED_RE, '').replace(LIST_BULLET_RE, '')
      )
      // Two list items can share one visual line (side-by-side bullets in a
      // short "advantages" list): split on an embedded mid-line bullet marker so
      // each becomes its own item instead of "• item1 • item2" on one line (#5).
      const parts = stripped.split(/\s+[•●▪◦■]\s+/).map((p) => p.trim()).filter((p) => p.length > 0)
      for (const part of parts.length ? parts : [stripped]) {
        if (part.length > 0) {
          pendingList.push(part)
          pendingListPage = para.page
          pendingListTopY = para.topY
        }
      }
    } else if (kind === 'formula') {
      // Formula: pass through verbatim (pipeline skips translation).
      flushList()
      flushCode()
      blockEntries.push({
        block: { type: 'formula', text: para.text, page: para.page },
        page: para.page,
        topY: para.topY
      })
    } else {
      flushList()
      flushCode()
      if (kind === 'heading') {
        const cleaned = stripBleedingPageNumbers(normalizeHeadingNumber(para.text))
        if (cleaned.length === 0 || isEmptyFurniture(cleaned)) continue
        blockEntries.push({
          block: {
            type: 'heading',
            level: headingLevel(para.fontSize, bodySize),
            text: cleaned,
            page: para.page
          },
          page: para.page,
          topY: para.topY
        })
      } else {
        const cleaned = stripBleedingPageNumbers(para.text)
        if (cleaned.length === 0 || isEmptyFurniture(cleaned)) continue
        // Split a section-numbered paragraph that got merged with body text:
        // e.g. "1.1.1 Roles: Core. An EM..." → heading + body.
        const split = splitHeadingFromBody(cleaned)
        if (split) {
          blockEntries.push({
            block: { type: 'heading', level: split.level, text: split.heading, page: para.page },
            page: para.page,
            topY: para.topY
          })
          if (split.body.length > 0) {
            blockEntries.push({
              block: { type: 'paragraph', text: split.body, page: para.page },
              page: para.page,
              topY: para.topY
            })
          }
        } else {
          blockEntries.push({
            block: { type: 'paragraph', text: cleaned, page: para.page },
            page: para.page,
            topY: para.topY
          })
        }
      }
    }
  }
  flushList()
  flushCode()

  // Steps 7–8: interleave image / figure-region / table blocks into the prose
  // stream by READING POSITION. blockEntries are in top-down order (decreasing
  // topY within a page). The old per-item splice loops broke on the first block
  // ABOVE the item and inserted before it, dumping every image/table near the
  // page top (bug). Instead: append each item with its (page, topY) and do ONE
  // stable sort by (page asc, topY desc) at the end — correct and simpler.
  if (matchedImages.length > 0) {
    for (const { image, placement } of matchedImages) {
      const imgBlock: ContentBlock = {
        type: 'image',
        page: placement.page,
        imageData: image.bytes,
        imageFormat: image.format,
        imagePixelWidth: image.pixelWidth,
        imagePixelHeight: image.pixelHeight
      }
      blockEntries.push({ block: imgBlock, page: placement.page, topY: placement.centerY })
    }
  }
  // Rasterized JPX/other un-extractable figures (E2E: missing figures).
  for (const r of rasterizedImages) blockEntries.push({ block: r.block, page: r.page, topY: r.topY })

  // Step 7.5: C1 — rasterize the detected sparse figure regions into image
  // blocks (their leaked labels were already dropped from prose above).
  const layoutEntries = await emitRegionImages(inputPath, figureRegions)
  for (const entry of layoutEntries) blockEntries.push(entry)
  imageCount += layoutEntries.length

  // Step 8: tables (already extracted from the prose stream).
  for (const t of tableEntries) blockEntries.push(t)

  // Single stable sort into reading order (page top→bottom). Array.sort is
  // stable (ES2019+), so equal-position prose blocks keep their relative order.
  blockEntries.sort((a, b) => a.page - b.page || b.topY - a.topY)

/**
 * Running heads/feet that escape the per-page band filters: identical
 * normalized text sitting in the top/bottom 10% of >=40% of pages is page
 * furniture, not content (Qt-style repeated-edge detection).
 */
function dropRepeatedEdgeText(lines: RawLine[], pageCount: number): RawLine[] {
  if (pageCount < 8) return lines
  // Collapse digit runs so a running foot whose page number varies
  // ("数据仓库|5", "数据仓库|7") normalises to one key and is recognised as
  // repeated furniture (gap analysis #2).
  const norm = (t: string): string => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  const pagesByText = new Map<string, Set<number>>()
  for (const l of lines) {
    const t = norm(l.text)
    if (!t || t.length > 80) continue
    const edge = l.y >= l.pageHeight * 0.88 || l.y <= l.pageHeight * 0.12
    if (!edge) continue
    if (!pagesByText.has(t)) pagesByText.set(t, new Set())
    pagesByText.get(t)!.add(l.page)
  }
  const thr = Math.max(4, Math.floor(pageCount * 0.4))
  const drop = new Set<string>()
  for (const [t, pages] of pagesByText) if (pages.size >= thr) drop.add(t)
  if (drop.size === 0) return lines
  console.log(`[capture/flow] dropped ${drop.size} repeated running head/foot texts`)
  return lines.filter((l) => !drop.has(norm(l.text)))
}

/**
 * Re-join paragraphs that a hard line-break split mid-sentence: previous block
 * ends WITHOUT terminal punctuation and the next starts lowercase/digit/quote.
 * Chained fragments collapse into one block. Measured (E1): ~8.2% of paragraphs
 * started mid-sentence before this rule existed.
 */
function mergeSplitParagraphs(entries: BlockEntry[]): BlockEntry[] {
  const noTerminal = (s: string): boolean => /[a-z0-9,;:)\]}]$/i.test(s.trim()) && !/[.!?…]$/.test(s.trim())
  const continuation = (s: string): boolean => /^[a-z0-9("'“(\[]/.test(s.trim())
  const out: BlockEntry[] = []
  for (const e of entries) {
    const prev = out[out.length - 1]
    const pt = prev?.block.type === 'paragraph' ? (prev.block.text ?? '') : null
    const et = e.block.type === 'paragraph' ? (e.block.text ?? '') : null
    if (prev && pt !== null && et !== null && prev.page === e.page && noTerminal(pt) && continuation(et) && pt.length + et.length < 4000) {
      prev.block.text = `${pt.trim()} ${et.trim()}`
      continue
    }
    out.push(e)
  }
  return out
}

  const mergedEntries = mergeSplitParagraphs(blockEntries)
  const blocks = mergedEntries.map((e) => e.block)
  return { blocks, pageCount: max, imageCount }
}

// ---------------------------------------------------------------------------
// Internal: group pdfjs items into visual lines
// ---------------------------------------------------------------------------

function groupItemsIntoLines(
  items: unknown[],
  pageNumber: number,
  pageWidth: number,
  pageHeight: number
): RawLine[] {
  // Collect items sorted by y (top=high first), then x.
  const fragments: Array<{ str: string; fontSize: number; fontName: string; y: number; x: number; width: number }> = []
  for (const raw of items) {
    if (!isTextItem(raw)) continue
    const str = raw.str
    if (str.trim() === '') continue
    const tm = raw.transform
    const fontSize = Math.abs(tm[3] || 0)
    fragments.push({
      str,
      fontSize,
      fontName: raw.fontName || '',
      y: tm[5],
      x: tm[4],
      width: raw.width || 0
    })
  }
  if (fragments.length === 0) return []

  // Detect a two-column layout: a wide empty vertical gutter in the middle of
  // the page AND evidence that both columns share baselines (real side-by-side
  // columns), not just single-column prose with indented short lines.
  const gutter = findColumnGutter(fragments, pageWidth)
  if (gutter !== null) {
    const left = fragments.filter((f) => f.x < gutter)
    const right = fragments.filter((f) => f.x >= gutter)
    return [
      ...groupColumnIntoLines(left, pageNumber, pageWidth, pageHeight, 0),
      ...groupColumnIntoLines(right, pageNumber, pageWidth, pageHeight, 1)
    ]
  }
  return groupColumnIntoLines(fragments, pageNumber, pageWidth, pageHeight, 0)
}

/**
 * Find the x position of a column gutter. A gutter is real only if:
 *   - it is the widest empty horizontal band in the middle of the page,
 *   - it is wide enough to look like a gutter, AND
 *   - at least 3 baselines carry fragments on BOTH sides (proves the text is
 *     genuinely set side-by-side, not single-column prose with indented lines).
 */
function findColumnGutter(
  fragments: Array<{ x: number; y: number; fontSize: number; str: string }>,
  pageWidth: number
): number | null {
  if (fragments.length < 8) return null
  const xs = fragments.map((f) => f.x).sort((a, b) => a - b)
  let bestGap = 0
  let bestSplit = 0
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1]
    if (gap > bestGap) {
      const mid = (xs[i] + xs[i - 1]) / 2
      if (mid > pageWidth * 0.28 && mid < pageWidth * 0.72) {
        bestGap = gap
        bestSplit = (xs[i] + xs[i - 1]) / 2
      }
    }
  }
  if (bestGap < pageWidth * 0.15) return null

  // Count baselines that carry fragments on BOTH sides. Require the RIGHT-side
  // fragment to be SUBSTANTIVE (>=10 chars) — a real 2-column layout has flowing
  // prose in both columns, whereas a reference list's right-margin ", by" tags are
  // short decoys that must NOT be mistaken for a second column.
  const tolerance = 6
  let overlap = 0
  for (const f of fragments) {
    const onLeft = f.x < bestSplit
    if (!onLeft) continue
    // Require BOTH sides to carry substantive text: tiny bullet markers (■) or
    // short ", by" tags must not count as a real two-column baseline.
    if (f.str.trim().length < 10) continue
    const partner = fragments.find(
      (g) => g.x >= bestSplit && Math.abs(g.y - f.y) < tolerance && g.str.trim().length >= 10
    )
    if (partner) overlap++
  }
  if (overlap < 3) return null
  return bestSplit
}

/** Sort one column's fragments top鈫抌ottom, left鈫抮ight, then baseline-group into lines. */
function groupColumnIntoLines(
  fragments: Array<{ str: string; fontSize: number; fontName: string; y: number; x: number; width: number }>,
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  col: number
): RawLine[] {
  // Sort top鈫抌ottom (y desc), then left鈫抮ight (x asc).
  fragments.sort((a, b) => b.y - a.y || a.x - b.x)

  const lines: RawLine[] = []
  let cur: { items: typeof fragments; baseline: number; fontSize: number } | null = null

  for (const f of fragments) {
    if (!cur) {
      cur = { items: [f], baseline: f.y, fontSize: f.fontSize }
    } else if (Math.abs(f.y - cur.baseline) < cur.fontSize * 0.5) {
      cur.items.push(f)
    } else {
      lines.push(finishLine(cur, pageNumber, pageWidth, pageHeight, col))
      cur = { items: [f], baseline: f.y, fontSize: f.fontSize }
    }
  }
  if (cur) lines.push(finishLine(cur, pageNumber, pageWidth, pageHeight, col))

  return lines
}

function finishLine(
  cur: { items: Array<{ str: string; fontSize: number; fontName: string; y: number; x: number; width: number }>; baseline: number; fontSize: number },
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  col: number
): RawLine {
  const sorted = cur.items.slice().sort((a, b) => a.x - b.x)
  const text = joinFragments(sorted, cur.fontSize)
  const fontSize = Math.max(...cur.items.map((i) => i.fontSize))
  const fontName = cur.items[0]?.fontName ?? ''
  const x = Math.min(...cur.items.map((i) => i.x))
  // Split fragments into column cells when a large x-gap appears (table rows).
  // Track each cell's real right edge (x+width) and join intra-cell fragments
  // with the same gap-aware spacing as prose, so table cells don't word-glue
  // ("TheData") or mis-split columns from a crude char-width estimate (#2).
  const segs: Array<{ text: string; x: number; end: number }> = []
  for (const f of sorted) {
    const fs = f.str.replace(/\s+/g, ' ').trim()
    if (!fs) continue
    const last = segs[segs.length - 1]
    if (!last || f.x - last.end > TABLE_COL_GAP_PT) {
      segs.push({ text: fs, x: f.x, end: f.x + f.width })
    } else {
      last.text += (f.x - last.end > fontSize * 0.14 ? ' ' : '') + fs
      last.end = f.x + f.width
    }
  }
  const segments: Array<{ text: string; x: number }> = segs.map((s) => ({ text: s.text, x: s.x }))
  return { text, fontSize, fontName, y: cur.baseline, x, page: pageNumber, pageWidth, pageHeight, col, segments }
}

