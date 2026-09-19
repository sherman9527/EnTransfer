/**
 * electron/pdf/typeset/measure.ts — mixed CJK/Latin measurement and
 * deterministic line wrapping for the pdf-lib fallback composer.
 *
 * A translated line mixes Chinese, Latin words and URLs: Chinese breaks
 * per-character, Latin breaks on spaces, and a URL never breaks mid-token. Each
 * script is drawn with its OWN embedded font, so measurement is per-run. The wrap
 * is deterministic (same input ⇒ same lines).
 *
 * (Adaptive bbox font-fitting was removed with the legacy same-page path; the
 * Chromium composer owns pagination now.)
 */

import type { PDFFont } from 'pdf-lib'

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
