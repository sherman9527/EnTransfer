/**
 * electron/pdf/__verify__.ts — independent verification of the output PDF:
 * re-extract text and count Chinese vs residual English items on pages 1..3.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'

const OUT = path.resolve(process.cwd(), '.scratch', 'output-zh.test.pdf')

const hasCn = (s: string): boolean => /[一-鿿]/.test(s)
const hasEn = (s: string): boolean => /[A-Za-z]{3,}/.test(s)

async function main(): Promise<void> {
  const data = new Uint8Array(fs.readFileSync(OUT))
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  let cn = 0, en = 0
  for (let n = 1; n <= 3; n++) {
    const page = await pdf.getPage(n)
    const tc = await page.getTextContent()
    const items = (tc.items as Array<{ str?: string }>).map((i) => i.str ?? '').filter((s) => s.trim())
    const pageCn = items.filter(hasCn).length
    const pageEn = items.filter((s: string) => hasEn(s) && !hasCn(s)).length
    cn += pageCn; en += pageEn
    console.log(`page ${n}: ${items.length} items, chinese=${pageCn}, english(no cn)=${pageEn}`)
    for (const s of items.slice(0, 4)) console.log(`   "${s.slice(0, 60)}"`)
    await page.cleanup()
  }
  await pdf.destroy()
  console.log(`\nTOTAL chinese=${cn} english-residual=${en}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
