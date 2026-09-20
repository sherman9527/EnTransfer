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

/** Valid Roman numeral (canonical form), so words like "civic"/"mill" are NOT
 * mistaken for a bleeding page number. */
export function isRoman(s: string): boolean {
  const u = s.toUpperCase()
  return /^[MDCLXVI]{2,7}$/.test(u) &&
    /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(u)
}

/**
 * Strip a standalone page number that bled into a paragraph (running head/foot
 * merged with body text). Conservative to avoid eating real content:
 *   - leading Roman ONLY if a valid numeral ("xiv available" -> "available";
 *     "Civic center" / "Mill lane" untouched);
 *   - leading Arabic only when followed by a Capital (page num + heading word);
 *   - trailing Arabic only on long paragraphs (page bleed lands at the end of
 *     real prose, not short lines like "the value was 3").
 */
export function stripBleedingPageNumbers(text: string): string {
  let t = text.trim()
  const leadRoman = /^([MDCLXVI]{2,7})\s+/i.exec(t)
  if (leadRoman && isRoman(leadRoman[1])) t = t.slice(leadRoman[0].length)
  t = t.replace(/^\d{1,3}\s+(?=[A-Z])/, '')
  if (t.length > 60) t = t.replace(/\s+\d{1,3}\s*$/, '')
  return t.trim()
}

// ---------------------------------------------------------------------------
// Code / console detection (E2E: this book's code uses an opaque subset font
// that MONO_FONT_RE can't see). Centralised here as a pure predicate so the
// rules are regression-testable (R21) without running the native capture.
// ---------------------------------------------------------------------------

/** Font size at/below this fraction of body size is a code candidate. */
export const CODE_FONT_RATIO = 0.86
const MONO_FONT_RE = /Courier|Consolas|Menlo|Monaco|monospace|Code\d*$/i
const CODE_SYMBOL_RE = /[{};=[\]<>|+%#]|=>|::|\/\/|->|--/g
/** Databricks/Zeppelin cell magics (%sql, %python, %sh, …). */
export const MAGIC_CELL_RE = /^\s*%\s*(sql|python|pyspark|scala|r|md|sh|bash|run)\b/i
/** Console ASCII-table borders (+----+ or |----|). */
export const ASCII_DUMP_RE = /^\s*[+][-+=|]{3,}|^\s*[|][-+=| ]{3,}\s*[|]/
/** REPL prompts (scala> / python> / spark> / >). */
export const REPL_PROMPT_RE = /^\s*(scala|python|py|spark|sql|jupyter|in|out)\s*(\[\d*\])?\s*>/i
/** A lone filesystem path line (/dbfs/…). */
export const PATH_LINE_RE = /^\s*[~.]?\/[\w./@+-]{4,}\s*$/
const SQL_CODE_RE = /\b(SELECT|FROM|WHERE|INSERT|INTO|CREATE|DROP|ALTER|MERGE|UPDATE|DELETE|GROUP BY|ORDER BY)\b/i
const PY_CODE_RE = /^\s*(import |from \S+ import|def \w+\(|print\(|return |class \w+)/

/**
 * Is this paragraph code/console output (kept verbatim, never translated)?
 * codeFonts = font names already proven to be code (from magic/ascii/repl lines),
 * the strongest signal — catches bare console output lacking any code symbol.
 */
export function looksLikeCode(
  text: string,
  fontName: string,
  fontSize: number,
  bodySize: number,
  codeFonts: Set<string>
): boolean {
  const isMono = MONO_FONT_RE.test(fontName)
  const isCodeFont = !!fontName && codeFonts.has(fontName)
  const smallFont = fontSize > 0 && fontSize <= bodySize * CODE_FONT_RATIO
  const symCount = (text.match(CODE_SYMBOL_RE) || []).length
  const isDenseCode = text.length > 30 && symCount >= 3 && symCount > text.length / 12
  const isCodeLang = smallFont && (SQL_CODE_RE.test(text) || PY_CODE_RE.test(text) || symCount >= 2)
  return isMono || isCodeFont || isDenseCode || MAGIC_CELL_RE.test(text) ||
    ASCII_DUMP_RE.test(text) || REPL_PROMPT_RE.test(text) || PATH_LINE_RE.test(text) || isCodeLang
}

/**
 * Join a paragraph's visual lines, DE-HYPHENATING soft line-break hyphens:
 * "<letter>-" at line end + a lowercase-starting next line is a hyphenated word
 * split across lines ("com-" + "monly" -> "commonly"), not a real hyphen.
 */
export function joinLines(texts: string[]): string {
  let out = ''
  for (const raw of texts) {
    const t = raw.trim()
    if (!t) continue
    if (out && /[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t
    else out = out ? `${out} ${t}` : t
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Strip the model's echoed prompt label ("译文："/"翻译："/"Translation:") that
 * leaks into output when the model repeats the completion cue (E2E "第一章 译文："). */
export function cleanTranslation(s: string): string {
  return s
    .replace(/^\s*(译文|翻译|中文翻译|Translation|Translated)\s*[:：]\s*/i, '')
    .trim()
}
