// electron/pdf/capture/line-utils.ts — pure, unit-testable helpers for turning
// pdfjs text fragments into a clean line, and for spotting page furniture.
// Extracted from flow.ts so the word-breaking (#1) and header/footer (#2) rules
// can be regression-tested without a PDF.

export interface Frag {
  str: string
  /** left x (pt). */
  x: number
  /** advance width of the fragment (pt) — pdfjs item.width. */
  width: number
}

/**
 * Join fragments on one baseline into text, inserting a space ONLY where there
 * is a real horizontal gap between glyphs (not where the font merely split a
 * word into runs, and not dropping a space that IS there).
 *
 * Fixes both #1 failure modes:
 *   - "The"+"Data" with a word-space gap  -> "The Data" (was "TheData")
 *   - "Generat"+"ed" kerning split, no gap -> "Generated" (was "Generat ed")
 * Embedded leading/trailing spaces in item strings are stripped and re-derived
 * from geometry, so justified intra-word stretch can't inject phantom spaces.
 */
export function joinFragments(items: Frag[], fontSize: number): string {
  const sorted = items.slice().sort((a, b) => a.x - b.x)
  // A gap larger than this fraction of the font size is a real word space.
  // Calibrated: normal inter-word space ~0.25em; heading tracking ~0.14em;
  // intra-word kerning <0.1em. 0.14 catches tight heading word-gaps without
  // re-introducing phantom spaces in kerned/split words.
  const SPACE_RATIO = 0.14
  let out = ''
  let prevEnd: number | null = null
  for (const it of sorted) {
    const s = it.str.replace(/\s+/g, ' ').trim()
    if (s.length === 0) {
      // a pure-space item: it still advances x, so let the next gap decide
      if (prevEnd !== null) prevEnd = Math.max(prevEnd, it.x + it.width)
      continue
    }
    if (out.length > 0 && prevEnd !== null) {
      const gap = it.x - prevEnd
      if (gap > fontSize * SPACE_RATIO) out += ' '
    }
    out += s
    prevEnd = it.x + it.width
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Is this line page furniture (running header/footer) rather than content?
 *
 * Two independent signals, either suffices:
 *   (a) shape: "<num> | <title>" or "<title> | <num>" — the O'Reilly running
 *       head/foot format. The pipe with a small integer on one side is the tell.
 *   (b) band: sits within `band` fraction of the top/bottom edge AND is short.
 *
 * We require the pipe-shape for (a) so ordinary prose with a stray "|" (tables,
 * code) is not caught; tables/code are handled elsewhere.
 */
export function isRunningFurniture(text: string, y: number, pageHeight: number, band = 0.12): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  const nearEdge = y <= pageHeight * band || y >= pageHeight * (1 - band)
  // "<num> | ..." or "... | <num>" (allow the glued variants "16|Chapter", "数据仓库|5")
  const pipeNum = /^\d{1,4}\s*\|\s*\S/.test(t) || /\S\s*\|\s*\d{1,4}$/.test(t)
  if (pipeNum && nearEdge) return true
  // A lone page number (Arabic or Roman) — ONLY near an edge. Without the
  // nearEdge gate, /^[ivxlcdm]{1,6}$/i matches real words ("mill", "civic",
  // "mid") and would drop mid-page content (regression guard R19).
  if (nearEdge && (/^\d{1,4}$/.test(t) || /^[ivxlcdm]{1,7}$/i.test(t))) return true
  return false
}
