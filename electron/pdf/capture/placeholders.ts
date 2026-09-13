/**
 * electron/pdf/capture/placeholders.ts — freeze protected spans before translation
 * and restore them verbatim afterward.
 *
 * Rich content that MUST NOT be machine-translated — inline formulas, URLs,
 * author–year citations, figure/table references, editorial brackets and page
 * refs — is replaced by opaque, indexed sentinels (`§A§`, `§B§`, …) BEFORE the
 * text goes to the model, then swapped back after. Restoration is BY INDEX, so
 * the model may reorder tokens (as natural English→Chinese does) without losing
 * anything. Round-trip is lossless: every token's value is the exact matched
 * substring.
 */

const SENTINEL = '§' // §
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Ordered protected patterns (earlier wins a tie). */
const PATTERNS: RegExp[] = [
  /\$[^$\n]+\$/, // inline formula $ ... $
  /(?:https?:\/\/|www\.)\S+/, // URL
  /\([A-Z][A-Za-z.'’-]*(?:,?\s*\d{4}[a-z]?(?:,?\s*pp?\.?\s*\d+(?:[-–]\d+)?)?)\)/, // (Author, 1999, p. 3)
  /(?:Figure|Fig\.|Plate|Table|Scheme)\s+\d+(?:\.\d+)?/, // Figure 6.1
  /pp?\.\s*\d+(?:\s*[-–]\d+)?/, // p. 12 / pp. 3–5
  /\[[^\]\n]*\]/ // editorial bracket [1] / [sic]
]

/** token (§X§) → original substring. */
export type PlaceholderMap = Map<string, string>

/**
 * Freeze every protected span in `text` into a `§<letter>§` sentinel. Returns the
 * masked text and the token→original table.
 */
export function freezeProtected(text: string): { text: string; placeholders: PlaceholderMap } {
  const placeholders: PlaceholderMap = new Map()
  let out = text
  let index = 0
  // Iteratively find the earliest match across all patterns and splice it out.
  // A fixed number of passes keeps it O(n·patterns) and avoids overlapping tokens.
  for (let pass = 0; pass < text.length && index < LETTERS.length; pass++) {
    let best: { start: number; end: number; value: string } | null = null
    for (const re of PATTERNS) {
      re.lastIndex = 0
      const m = re.exec(out)
      if (m && m[0].length > 0 && (!best || m.index < best.start)) {
        best = { start: m.index, end: m.index + m[0].length, value: m[0] }
      }
    }
    if (!best) break
    const token = `${SENTINEL}${LETTERS[index]}${SENTINEL}`
    placeholders.set(token, best.value)
    out = out.slice(0, best.start) + token + out.slice(best.end)
    index++
  }
  return { text: out, placeholders }
}

/** Swap every sentinel token back to its original substring (single pass). */
export function restorePlaceholders(text: string, placeholders: PlaceholderMap): string {
  if (placeholders.size === 0) return text
  return text.replace(/§[A-Z]§/g, (token) => placeholders.get(token) ?? token)
}
