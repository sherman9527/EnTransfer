// electron/batch-format.ts — numbered-list carrier format for batch
// translation (see pipeline.ts: N short paragraphs are joined as "1. x\n2. y"
// and the model is asked to keep the numbering; measured 5% parse failure vs
// 48% for "---" delimiters, poc/speed-v3/batch-strategy.ts n=80).
//
// Lives at module scope so the regression suite can test the parser directly.
// `splitBatch` NEVER returns an array containing an empty slot: a model that
// answers "3." with no content is a format break (null), not a legitimate
// empty translation — persisting "" silently deletes a paragraph (bug 2026-09-19 R1).

export function joinBatch(texts: string[]): string {
  return texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
}

/** Parse numbered model output into exactly `n` non-empty parts, or null. */
export function splitBatch(out: string, n: number): string[] | null {
  const map = new Map<number, string[]>()
  let last: number | null = null
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line)
    if (m) {
      const idx = Number(m[1])
      if (idx >= 1 && idx <= n && !map.has(idx)) {
        map.set(idx, [m[2].trim()])
        last = idx
      } else if (last !== null && m[2].trim()) {
        map.get(last)!.push(m[2].trim())
      } else {
        last = null
      }
    } else if (last !== null && line.trim()) {
      // continuation line of the previous numbered item — keep, don't drop
      map.get(last)!.push(line.trim())
    }
  }
  if (map.size !== n) return null
  const parts = Array.from({ length: n }, (_, i) => (map.get(i + 1) as string[]).join(' ').trim())
  return parts.every((p) => p.length > 0) ? parts : null
}
