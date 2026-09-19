// extract-corpus.ts — build a fixed translation benchmark corpus from the
// Manning PDF using the app's real capture stage. Outputs poc/speed-v3/corpus.json
// { texts: string[] } — the same 80 paragraphs are used by every bench mode so
// numbers are comparable (>50-case rule for A/B significance).
import path from 'node:path'
import fs from 'node:fs'
import { captureFlow } from '../../electron/pdf/capture/flow'

const ROOT = process.cwd()
const INPUT = path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const OUT = path.join(ROOT, 'poc', 'speed-v3', 'corpus.json')

async function main(): Promise<void> {
  console.log('[extract-corpus] captureFlow on first 120 pages...')
  const { blocks } = await captureFlow(INPUT, { pageLimit: 120 })
  const texts: string[] = []
  for (const b of blocks) {
    if (b.type === 'paragraph' && b.text) {
      const t = b.text.trim()
      if (t.length >= 120 && t.length <= 400) texts.push(t)
    }
    if (texts.length >= 80) break
  }
  if (texts.length < 80) throw new Error(`only ${texts.length} paragraphs found`)
  fs.writeFileSync(OUT, JSON.stringify({ texts }, null, 2))
  console.log(`[extract-corpus] wrote ${texts.length} paragraphs -> ${OUT}`)
  console.log(`  avg length: ${(texts.reduce((a, t) => a + t.length, 0) / texts.length).toFixed(0)} chars`)
}

main().catch((e) => { console.error(e); process.exit(1) })
