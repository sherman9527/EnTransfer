// score-outputs.ts — cheap automatic quality proxies for bench out-*.txt files.
// Metrics per file: paragraphs, untranslated-rate (no CJK in ZH line),
// latin-residue-rate (English words >4 chars remaining in ZH), avg len ratio ZH/SRC.
// usage: node .scratch/poc-score.cjs poc/speed-v3/out-*.txt
import fs from 'node:fs'

const files = process.argv.slice(2)
const rows: string[] = []
for (const f of files) {
  if (!fs.existsSync(f)) continue
  const raw = fs.readFileSync(f, 'utf8')
  const paras = raw.split(/^### \d+$/m).slice(1)
  let n = 0, untr = 0, residue = 0, ratioSum = 0
  for (const p of paras) {
    const src = /^SRC: (.*)$/m.exec(p)?.[1] ?? ''
    const zh = /^ZH : (.*)$/m.exec(p)?.[1] ?? ''
    if (!src) continue
    n++
    const cjk = [...zh].filter((c) => (c.codePointAt(0) ?? 0) >= 0x4e00 && (c.codePointAt(0) ?? 0) <= 0x9fff).length
    if (cjk === 0) untr++
    const words = zh.match(/[A-Za-z]{5,}/g) ?? []
    // words that also appear in source are legit leftovers (names/URLs) — count NEW ones
    const bad = words.filter((w) => !src.toLowerCase().includes(w.toLowerCase())).length
    if (bad > 0) residue++
    ratioSum += zh.length / Math.max(1, src.length)
  }
  rows.push(
    `${f.split(/[\\/]/).pop()}: n=${n} untranslated=${((untr / Math.max(1, n)) * 100).toFixed(1)}% ` +
    `latin-residue=${((residue / Math.max(1, n)) * 100).toFixed(1)}% zhLen/srcLen=${(ratioSum / Math.max(1, n)).toFixed(2)}`
  )
}
console.log(rows.join('\n'))
