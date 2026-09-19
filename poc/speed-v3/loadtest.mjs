// loadtest.mjs — minimal "can this GGUF load and generate?" probe using the
// LOCALLY installed node-llama-cpp in poc/speed-v3/node_modules (3.21.1).
// usage: cd poc/speed-v3 && node loadtest.mjs ../../../models/Hy-MT2-1.8B-1.25Bit.gguf
import { getLlama } from 'node-llama-cpp'
import path from 'node:path'

const target = process.argv[2]
if (!target) { console.error('usage: node loadtest.mjs <gguf>'); process.exit(2) }
const abs = path.resolve(process.cwd(), target)
const device = process.env.LT_GPU === '1' ? 'vulkan' : false
console.log(`[loadtest] ${abs} gpu=${device}`)
const t0 = Date.now()
try {
  const llama = await getLlama(device ? { gpu: device } : { gpu: false })
  const model = await llama.loadModel({ modelPath: abs, gpuLayers: device ? 'max' : 0 })
  console.log(`[loadtest] LOADED in ${((Date.now() - t0) / 1000).toFixed(1)}s; arch hint keys sample:`)
  const meta = model.fileInfo?.metadata ?? {}
  for (const k of Object.keys(meta).slice(0, 6)) console.log('  ', k)
  const ctx = await model.createContext({ contextSize: 2048, threads: 8 })
  const seq = ctx.getSequence()
  const { LlamaChatSession } = await import('node-llama-cpp')
  const session = new LlamaChatSession({ contextSequence: seq })
  const out = await session.prompt('Translate to Chinese: The engineering manager held a retrospective.', { maxTokens: 48, temperature: 0 })
  console.log('[loadtest] GEN OK:', out.trim().slice(0, 120))
  await model.dispose(); await ctx.dispose(); await llama.dispose()
  console.log('[loadtest] PASS')
} catch (err) {
  console.error('[loadtest] FAIL:', err.message)
  process.exit(1)
}
