// dump-pair.ts — eyeball check that a claimed EN↔ZH pair is a genuine
// translation and how well paragraph order aligns. Uses a minimal pdfjs text
// scrape (no capture / no native C1), so it bundles and runs standalone.
//   node poc/lora-corpus/dump-pair.cjs "<EN.pdf>" "<ZH.pdf>" [pageLimit] [n]
import path from 'node:path'
import fs from 'node:fs'

async function pdfjs(): Promise<any> {
  const ns = await import('pdfjs-dist/legacy/build/pdf.js')
  const mod = ns.default ?? ns
  return mod
}

// merge items into visual lines via y-coordinate, return non-empty lines
async function pageLines(mod: any, pdf: any, pageNo: number): Promise<string[]> {
  const page = await pdf.getPage(pageNo)
  const tc = await page.getTextContent()
  const rows = new Map<number, { x: number; s: string }[]>()
  for (const it of tc.items) {
    const str = (it as any).str
    if (!str) continue
    const y = Math.round(it.transform[5])
    const x = it.transform[4]
    const bucket = rows.get(y) ?? []
    bucket.push({ x, s: str })
    rows.set(y, bucket)
  }
  const ys = [...rows.keys()].sort((a, b) => b - a)
  const lines: string[] = []
  for (const y of ys) {
    const parts = rows.get(y)!.sort((a, b) => a.x - b.x).map((p) => p.s)
    const line = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (line) lines.push(line)
  }
  return lines
}

async function scrape(pdfPath: string, pageLimit: number): Promise<string[]> {
  const mod = await pdfjs()
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const pdf = await mod.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const lines: string[] = []
  const max = Math.min(pageLimit, pdf.numPages)
  for (let p = 1; p <= max; p++) lines.push(...(await pageLines(mod, pdf, p)))
  return lines
}

const gb = path.resolve(process.cwd(), '..', '..', 'good book')
const EN = process.argv[2]
const ZH = process.argv[3]
const pageLimit = Number(process.argv[4] ?? 40)
const n = Number(process.argv[5] ?? 10)

async function main(): Promise<void> {
  const enPath = path.isAbsolute(EN) ? EN : path.join(gb, EN)
  const zhPath = path.isAbsolute(ZH) ? ZH : path.join(gb, ZH)
  const [en, zh] = await Promise.all([scrape(enPath, pageLimit), scrape(zhPath, pageLimit)])
  const enProse = en.filter((l) => l.length >= 40)
  const zhProse = zh.filter((l) => l.length >= 20)
  console.log(`EN lines ${en.length} (prose>=40 ${enProse.length})   ZH lines ${zh.length} (prose>=20 ${zhProse.length})\n`)
  for (let i = 0; i < n; i++) {
    console.log(`── [${i}] ──`)
    console.log('EN:', (enProse[i] ?? '(none)').slice(0, 160))
    console.log('ZH:', (zhProse[i] ?? '(none)').slice(0, 160))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
