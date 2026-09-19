// probe-text.ts — report how much selectable text a PDF has (detect scanned/image-only).
//   node poc/lora-corpus/probe-text.cjs "<pdf>" [probePages]
import path from 'node:path'
import fs from 'node:fs'

async function main(): Promise<void> {
  const ns = await import('pdfjs-dist/legacy/build/pdf.js')
  const mod: any = (ns as any).default ?? ns
  const arg = process.argv[2]!
  const pdfPath = path.isAbsolute(arg) ? arg : path.join(path.resolve(process.cwd(), '..', '..', 'good book'), arg)
  const probePages = Number(process.argv[3] ?? 40)
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const pdf = await mod.getDocument({ data, isEvalSupported: false }).promise
  let items = 0
  let chars = 0
  const max = Math.min(probePages, pdf.numPages)
  for (let i = 1; i <= max; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent()
    for (const it of tc.items) {
      const s = (it as any).str || ''
      if (s.trim()) { items++; chars += s.trim().length }
    }
  }
  const cjk = /[一-鿿]/.test(String.fromCharCode(0x4e00))
  console.log(`${path.basename(pdfPath)}`)
  console.log(`  pages=${pdf.numPages}  textItems(${max}p)=${items}  chars(${max}p)=${chars}  avg=${items ? Math.round(chars / items) : 0}`)
}
main().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1) })
