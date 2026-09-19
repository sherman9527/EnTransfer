// test-cache.ts — E4: measure translation-cache benefit with the real engine.
// pass1: N paragraphs cold (calls=N). pass2: warm (calls=0). Also prove key
// sensitivity: bump promptVersion -> full miss again.
import path from 'node:path'
import { LlamaCppEngine, GENERIC_SYSTEM_PROMPT } from '../../electron/models/llama-engine'
import { TranslationCache, type CacheKey } from '../../electron/models/translation-cache'
import { validateRestored } from '../../electron/pdf/validate'

const ROOT = process.cwd()
const MODEL = path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf')
const N = 24

async function main() {
  const fs = await import('node:fs')
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'poc', 'speed-v3', 'corpus.json'), 'utf8')) as { texts: string[] }
  const texts = corpus.texts.slice(0, N)
  const engine = new LlamaCppEngine({ systemPrompt: GENERIC_SYSTEM_PROMPT, disableReasoning: true })
  await engine.load(MODEL, { device: 'gpu', threads: 12, contextSize: 4096 })
  const cacheRoot = path.join(ROOT, '.scratch', 'e4-cache')
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  const cache = new TranslationCache(cacheRoot)

  let calls = 0
  const cachedTranslate = async (text: string, promptVersion: string): Promise<string> => {
    const key: CacheKey = { modelId: 'qwen3-1.7b', promptVersion, temperature: 0.1, source: text, masked: text }
    const hash = TranslationCache.hashKey(key)
    const hit = await cache.get(hash)
    if (hit && validateRestored(text, hit.translated).ok) return hit.translated
    calls++
    const out = (await engine.translate(text, {})).text.trim()
    if (validateRestored(text, out).ok) await cache.put(hash, out, 0)
    return out
  }

  let t0 = Date.now()
  for (const t of texts) await cachedTranslate(t, 'v1')
  const cold = { sec: +((Date.now() - t0) / 1000).toFixed(1), calls }

  t0 = Date.now()
  for (const t of texts) await cachedTranslate(t, 'v1')
  const warm = { sec: +((Date.now() - t0) / 1000).toFixed(1), calls: calls - cold.calls }

  t0 = Date.now()
  for (const t of texts.slice(0, 4)) await cachedTranslate(t, 'v2-promptbump')
  const bumped = { sec: +((Date.now() - t0) / 1000).toFixed(1), calls: calls - cold.calls - warm.calls }

  console.log(JSON.stringify({ N, cold, warm, bumpedKeysMiss: bumped, cacheSize: await cache.size() }, null, 2))
  await engine.dispose()
}
main().catch((e) => { console.error(e); process.exit(1) })
