// debug-batch.ts — replicate the pipeline's numbered batching on the real
// first-30-pages task list, print WHY each batch fails to parse.
import path from 'node:path'
import { captureFlow } from '../../electron/pdf/capture/flow'
import { expandAbbreviations } from '../../electron/pdf/capture/glossary'
import { freezeProtected, restorePlaceholders } from '../../electron/pdf'
import { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } from '../../electron/models/llama-engine'

const ROOT = process.cwd()
async function main() {
  const { blocks } = await captureFlow(path.join(ROOT, 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf'), { pageLimit: 30 })
  type T = { id: string; text: string; page: number }
  const tasks: T[] = []
  blocks.forEach((b, i) => {
    if (['code', 'image', 'table', 'formula'].includes(b.type)) return
    const page = b.page ?? 1
    if (b.type === 'list') (b.items ?? []).forEach((it, j) => it.trim() && tasks.push({ id: `b${i}-${j}`, text: it, page }))
    else if ((b.text ?? '').trim()) tasks.push({ id: `b${i}`, text: b.text as string, page })
  })
  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true })
  await engine.load(path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf'), { device: 'gpu', threads: 12, contextSize: 4096 })
  const SHORT = 250
  let i = 0
  let shown = 0
  while (i < tasks.length && shown < 6) {
    const batch = [tasks[i]]
    let bi = i + 1
    while (batch.length < 4 && bi < tasks.length && tasks[bi].page === tasks[i].page && tasks[bi].text.length <= SHORT && tasks[bi].text.length >= 60 && batch[0].text.length >= 60 && batch[0].text.length <= SHORT) { batch.push(tasks[bi]); bi++ }
    if (batch.length >= 2) {
      const joined = batch.map((t, k) => `${k + 1}. ${t.text}`).join('\n')
      const { text: masked, placeholders } = freezeProtected(expandAbbreviations(joined))
      const raw = (await engine.translate(masked, {})).text
      const out = restorePlaceholders(raw, placeholders)
      const map = new Map<number, string>()
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s*[.、)．]\s*(.*)$/.exec(line)
        if (m) { const idx = Number(m[1]); if (idx >= 1 && idx <= batch.length && !map.has(idx)) map.set(idx, m[2]) }
      }
      const ok = map.size === batch.length
      if (!ok && shown < 6) {
        shown++
        console.log(`\n=== FAIL batch@${batch[0].id} page${batch[0].page} n=${batch.length} got=${map.size}`)
        console.log('IN :', JSON.stringify(joined.slice(0, 220)))
        console.log('OUT:', JSON.stringify(out.slice(0, 300)))
      }
      i = bi
    } else i++
  }
  await engine.dispose()
}
main().catch((e) => { console.error(e); process.exit(1) })
