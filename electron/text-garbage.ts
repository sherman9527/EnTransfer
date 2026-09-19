// electron/text-garbage.ts — undecodable-text gate (pdfzh §6.3 "garbage" node).
//
// Type3 / CID fonts without a ToUnicode CMap make pdfjs emit replacement
// characters (U+FFFD) or private-use-area codepoints. Such text must NEVER
// reach the model: it "translates" into plausible-looking junk, and junk in the
// output is worse than a kept-English paragraph. Blocks over the threshold are
// dropped from translation (kept verbatim + badged + reported).
const GARBAGE_CHARS_RE = /[\uFFFD\uE000-\uF8FF\uFFF0-\uFFFF]/g

/** Fraction (0..1) of replacement/PUA/reserved characters in trimmed text. */
export function garbageRatio(text: string): number {
  const t = text.trim()
  if (t.length === 0) return 0
  let bad = 0
  for (const m of t.matchAll(GARBAGE_CHARS_RE)) bad += m[0].length
  return bad / t.length
}

/** >20% undecodable chars → treat the whole unit as garbage. */
export const GARBAGE_THRESHOLD = 0.2
export function isGarbageText(text: string): boolean {
  return garbageRatio(text) > GARBAGE_THRESHOLD
}
