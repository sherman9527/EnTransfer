// electron/pdf/validate.ts — deterministic per-block translation invariants.
//
// Inspired by EnTransferQt's validation ladder but re-derived for our pipeline.
// Two phases, run back to back inside translateText():
//   validateModelOutput(masked, raw)   — before placeholder restore: the model
//     must have kept every §X§ sentinel it was given (multiset semantics, so
//     dropped/duplicated tokens are caught, not just "present").
//   validateRestored(source, restored) — after restore: echo detection,
//     untranslated-Latin, numeric integrity (against the ORIGINAL source, so
//     numbers living inside restored sentinels are counted correctly), length
//     band, marker leaks, cell-mode single-line.
//
// Pure functions, no IO, no Electron: unit-testable, reusable from pipeline,
// quality report and POC harness.

export interface ValidationOutcome {
  ok: boolean
  reasons: string[]
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const SENTINEL_RE = /§[A-Z]§/g
const NUMBER_RE = /\d+(?:[.,]\d+)*/g
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]{3,}/g

function matches(text: string, re: RegExp): string[] {
  return text.match(new RegExp(re.source, re.flags)) ?? []
}

function fail(...reasons: string[]): ValidationOutcome {
  return { ok: false, reasons }
}

/** Phase 1: model raw output vs the masked prompt it was given. */
export function validateModelOutput(masked: string, raw: string): ValidationOutcome {
  const reasons: string[] = []
  if (raw.trim().length === 0) return fail('empty')
  const want = matches(masked, SENTINEL_RE)
  if (want.length > 0) {
    const counts = new Map<string, number>()
    for (const t of matches(raw, SENTINEL_RE)) counts.set(t, (counts.get(t) ?? 0) + 1)
    const missing: string[] = []
    for (const t of want) {
      const c = (counts.get(t) ?? 0) - 1
      if (c < 0) missing.push(t)
      else counts.set(t, c)
    }
    if (missing.length > 0) reasons.push(`sentinel-lost:${missing.join('')}`)
  }
  return reasons.length ? fail(...reasons) : { ok: true, reasons: [] }
}

/** Phase 2: restored translation vs the original source. */
export function validateRestored(
  source: string,
  restored: string,
  opts: { cellMode?: boolean } = {}
): ValidationOutcome {
  const reasons: string[] = []
  const src = source.trim()
  const out = restored.trim()
  if (out.length === 0) return fail('empty')

  // Residual sentinels after restore = lost mapping or hallucinated token.
  if (SENTINEL_RE.test(out)) reasons.push('sentinel-leak')
  SENTINEL_RE.lastIndex = 0

  // Echo: copied the source verbatim — but only a problem when the source
  // actually wanted translating (a sentence, not a preserved term/heading).
  const translatable = matches(src, LATIN_WORD_RE).length >= 4 || src.length > 60
  if (translatable && (out === src || (src.length > 40 && norm(out) === norm(src)))) reasons.push('echo')

  // Untranslated Latin: zero CJK, substantial length, ≥3 long English words.
  // Short Latin-only stretches (headers, author lists, bibliographies, labels)
  // are legitimately preservable and must not be flagged — measured calibration
  // on 80 real paragraphs: only outputs >100 chars are reliably "should be Chinese".
  if (!CJK_RE.test(out) && out.length > 100 && matches(out, LATIN_WORD_RE).length >= 3) {
    reasons.push('untranslated-latin')
  }

  // Numeric integrity against the ORIGINAL source (restored sentinel values
  // have their numbers back), tolerating thousands-separator rewrites.
  // Calibration findings (E5 suite): Chinese legitimately rewrites magnitudes
  // ($1M -> 100万, 250K -> 25万) which breaks exact digit matching; when the
  // output is Chinese AND carries magnitude words, a full numeric mismatch is
  // accepted. A single dropped number in Chinese output is also tolerated
  // ("chapter 12" -> "第十二章"). Latin output must keep every number.
  const srcNums = matches(src, NUMBER_RE)
  if (srcNums.length > 0) {
    const outNums = new Set(matches(out, NUMBER_RE).flatMap((n) => [n, n.replace(/[.,]/g, '')]))
    const dropped = srcNums.filter((n) => !outNums.has(n) && !outNums.has(n.replace(/[.,]/g, '')))
    const magnitudeRewrite = CJK_RE.test(out) && /万|亿|千|[KMBT]\b|百分/.test(out)
    const tolerance = !CJK_RE.test(out) ? 0 : magnitudeRewrite ? srcNums.length : 1
    if (dropped.length > tolerance) reasons.push(`number-dropped:${dropped.slice(0, 4).join(',')}`)
  }

  // NOTE: an "unterminated sentence" probe was calibrated out — 10/80 FPs on
  // legitimate unpunctuated lines (bullets, headings). Trailing-clause drops
  // (observed in the E5 long-context case) are semantic and NOT detectable by
  // deterministic invariants; the adversarial quality suite covers them.

  // Length sanity band (Chinese is denser than English by char count).
  if (src.length > 0) {
    const ratio = out.length / src.length
    const lo = opts.cellMode ? 0.05 : 0.12
    const hi = opts.cellMode ? 3.5 : 2.2
    if (ratio < lo || ratio > hi) reasons.push(`length-ratio:${ratio.toFixed(2)}`)
  }

  // Prompt/thinking marker leaks.
  if (/<\/?think|<system|assistant:|```|"schema_version"/i.test(out)) reasons.push('marker-leak')

  // Cell mode must stay single-line (structure lives in coordinates).
  if (opts.cellMode && /[\r\n]/.test(out)) reasons.push('cell-newline')

  return reasons.length ? fail(...reasons) : { ok: true, reasons: [] }
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}
