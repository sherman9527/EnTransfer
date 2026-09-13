/**
 * electron/pdf/typeset/measure.ts — mixed CJK/Latin measurement, deterministic
 * line wrapping and adaptive font fitting.
 *
 * A translated line mixes Chinese, Latin words and URLs: Chinese breaks
 * per-character, Latin breaks on spaces, and a URL never breaks mid-token. Each
 * script is drawn with its OWN embedded font, so measurement is per-run. The wrap
 * is deterministic (same input ⇒ same lines).
 *
 * Font fitting shrinks the size until the text fits the unit's bbox, but never
 * below the readable floor: text that still overflows at the floor is drawn AT
 * the floor and flagged overflow — never microscopic.
 */

import type { PDFFont } from 'pdf-lib'
import type { BBox } from '../types'

/** The reusable embedded-font pair for one document (cjk + latin). */
export interface EmbeddedFonts {
  /** CJK font (Noto Sans SC). */
  cjk: PDFFont
  /** Latin / Base14 Helvetica. */
  latin: PDFFont
}

/** The script a glyph is drawn with — selects the font. */
export type RunScript = 'cjk' | 'latin'

/** One same-script segment of a laid-out line, with its measured width. */
export interface LineRun {
  script: RunScript
  text: string
  /** Width in points at the line's font size. */
  width: number
}

/** One laid-out visual line. */
export interface LaidOutLine {
  runs: LineRun[]
  width: number
}

/** The result of fitting text into a bbox. */
export interface FitResult {
  /** The fitted font size (never below the floor). */
  size: number
  /** The wrapped lines at that size. */
  lines: LaidOutLine[]
  /** Line height in points at the fitted size. */
  lineHeight: number
  /** True when text still overflowed the bbox at the floor. */
  overflow: boolean
}

/** Classify a character to the script it must be drawn with. */
export function classifyChar(ch: string): RunScript {
  const cp = ch.codePointAt(0) ?? 0
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // extension A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation
    (cp >= 0xff00 && cp <= 0xffef) || // full-width forms
    (cp >= 0xf900 && cp <= 0xfaff) // compatibility ideographs
  ) {
    return 'cjk'
  }
  return 'latin'
}

interface Atom {
  script: RunScript
  text: string
  /** A trailing soft-break space (Latin only). */
  space: boolean
}

/** Split a paragraph into breakable atoms (CJK per-char, Latin per-token). */
export function atomize(text: string): Atom[] {
  const atoms: Atom[] = []
  const chars = Array.from(String(text ?? ''))
  let latin = ''
  const flushLatin = (space: boolean): void => {
    if (latin.length > 0) {
      atoms.push({ script: 'latin', text: latin, space })
      latin = ''
    } else if (space && atoms.length > 0) {
      atoms[atoms.length - 1].space = true
    }
  }
  for (const ch of chars) {
    if (ch === ' ' || ch === '\t') {
      flushLatin(true)
      continue
    }
    if (classifyChar(ch) === 'cjk') {
      flushLatin(false)
      atoms.push({ script: 'cjk', text: ch, space: false })
    } else {
      latin += ch
    }
  }
  flushLatin(false)
  return atoms
}

/** Measure a run of text in one script at a size (fails soft to an estimate). */
function measureRun(script: RunScript, text: string, fonts: EmbeddedFonts, size: number): number {
  const font = script === 'cjk' ? fonts.cjk : fonts.latin
  try {
    return font.widthOfTextAtSize(text, size)
  } catch {
    return text.length * size * (script === 'cjk' ? 1 : 0.5)
  }
}

function atomWidth(atom: Atom, fonts: EmbeddedFonts, size: number): number {
  return measureRun(atom.script, atom.text, fonts, size)
}

function spaceWidth(fonts: EmbeddedFonts, size: number): number {
  return measureRun('latin', ' ', fonts, size)
}

/** Coalesce the atoms of a line into per-script runs and total width. */
function buildLine(atoms: Atom[], fonts: EmbeddedFonts, size: number): LaidOutLine {
  const runs: LineRun[] = []
  let total = 0
  for (let idx = 0; idx < atoms.length; idx++) {
    const atom = atoms[idx]
    const leadingSpace = idx > 0 && atoms[idx - 1].space
    if (leadingSpace) {
      const sw = spaceWidth(fonts, size)
      const last = runs[runs.length - 1]
      if (last && last.script === 'latin') {
        last.text += ' '
        last.width += sw
      } else {
        runs.push({ script: 'latin', text: ' ', width: sw })
      }
      total += sw
    }
    const w = atomWidth(atom, fonts, size)
    const last = runs[runs.length - 1]
    if (last && last.script === atom.script) {
      last.text += atom.text
      last.width += w
    } else {
      runs.push({ script: atom.script, text: atom.text, width: w })
    }
    total += w
  }
  return { runs, width: total }
}

/**
 * Greedily wrap `text` to `maxWidth` points at `size`, honoring `\n` hard breaks.
 * CJK atoms break anywhere; Latin word/URL atoms stay intact. Deterministic.
 */
export function wrapMixed(
  text: string,
  fonts: EmbeddedFonts,
  size: number,
  maxWidth: number
): LaidOutLine[] {
  const lines: LaidOutLine[] = []
  const sw = spaceWidth(fonts, size)
  for (const para of String(text ?? '').split('\n')) {
    const atoms = atomize(para)
    if (atoms.length === 0) {
      lines.push({ runs: [], width: 0 })
      continue
    }
    let cur: Atom[] = []
    let curWidth = 0
    const flushLine = (): void => {
      lines.push(buildLine(cur, fonts, size))
      cur = []
      curWidth = 0
    }
    for (const atom of atoms) {
      const w = atomWidth(atom, fonts, size)
      const gap = cur.length > 0 && cur[cur.length - 1].space ? sw : 0
      if (cur.length > 0 && curWidth + gap + w > maxWidth) {
        flushLine()
        cur.push(atom)
        curWidth = w
      } else {
        cur.push(atom)
        curWidth += gap + w
      }
    }
    if (cur.length > 0) flushLine()
  }
  return lines
}

function widestAtom(text: string, fonts: EmbeddedFonts, size: number): number {
  let max = 0
  for (const para of String(text ?? '').split('\n')) {
    for (const atom of atomize(para)) max = Math.max(max, atomWidth(atom, fonts, size))
  }
  return max
}

/** Options for {@link fitTextToBox}. */
export interface FitOptions {
  /** Never draw smaller than this (pt). */
  floor: number
  /** Try sizes from here down. */
  start: number
  /** Line height as a multiple of font size (e.g. 1.2). */
  lineHeight: number
}

/**
 * Fit `text` into `box` [x0,y0,x1,y1] (points): find the largest size in
 * `[floor, start]` whose wrapped lines fit the box height AND whose widest atom
 * fits the box width. If nothing fits down to the floor, return the floor layout
 * with `overflow: true` (drawn readable, flagged) — never sub-floor.
 */
export function fitTextToBox(
  text: string,
  fonts: EmbeddedFonts,
  box: BBox,
  opts: FitOptions
): FitResult {
  const width = Math.abs(box[2] - box[0])
  const height = Math.abs(box[3] - box[1])
  const { floor, start, lineHeight } = opts

  const fits = (size: number): { ok: boolean; lines: LaidOutLine[] } => {
    const lines = wrapMixed(text, fonts, size, width)
    const totalH = lines.length * size * lineHeight
    const widthOk = widestAtom(text, fonts, size) <= width + 0.5
    return { ok: totalH <= height + 0.5 && widthOk, lines }
  }

  let size = Math.max(floor, Math.floor(start))
  for (; size >= floor; size--) {
    const r = fits(size)
    if (r.ok) return { size, lines: r.lines, lineHeight: size * lineHeight, overflow: false }
  }
  const atFloor = wrapMixed(text, fonts, floor, width)
  return { size: floor, lines: atFloor, lineHeight: floor * lineHeight, overflow: true }
}
