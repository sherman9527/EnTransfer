// verify-output.ts — extract text from a generated PDF and report CJK ratio
// per page (used for eyeballing table/typeset output without opening a viewer).
// usage: node .scratch/poc-verify.cjs <pdfPath> [pagesToPrint]
import fs from 'node:fs'
import { loadLlamaPdfjs } from './pdfjs-helper'

async function main(): Promise<void> {
  const file = process.argv[2]
  const print = Number(process.argv[3] ?? 3)
  const data = new Uint8Array(fs.readFileSync(file))
  const pdfjs = await loadLlamaPdfjs()
  const doc = await pdfjs.getDocument({ data }).promise
  console.log(`pages: ${doc.numPages}`)
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const strs = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ')
    const cjk = [...strs].filter((c) => (c.codePointAt(0) ?? 0) >= 0x4e00 && (c.codePointAt(0) ?? 0) <= 0x9fff).length
    const ratio = strs.length ? cjk / strs.length : 0
    console.log(`p${i}: chars=${strs.length} cjk=${(ratio * 100).toFixed(0)}%  ${strs.slice(0, print > 0 ? 90 : 0)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
