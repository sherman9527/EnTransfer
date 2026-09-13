// Standalone smoke test for the translation + model modules.
//
// Run (from the project root):
//   node --experimental-strip-types electron/models/__test__.ts
//
// It exercises: registry model listing, TranslationEngine.load() with the
// copied POC model (now with reused context/session, adaptive threads and the
// new sampling params), and 3 technical passages translated back-to-back.
// Per-segment timing is printed so we can compare against the baseline.
import { getModels, getModelPath, getModelsDir } from './registry.ts'
import { TranslationEngine } from './engine.ts'

const PASSAGES = [
  // Short
  'Garbage collection is a form of automatic memory management. The garbage collector attempts to reclaim memory that was allocated by the program but is no longer referenced; such memory is called garbage.',
  // Medium — typical technical paragraph
  'Linear regression models the relationship between a scalar response and one or more explanatory variables by fitting a linear predictive function to the observed data. The coefficients are estimated by minimizing the sum of squared residuals between the predicted and observed values, which yields a closed-form solution known as the normal equation.',
  // Long — long enough to exercise the token-budget split path
  'In distributed systems, consistency and availability often trade off against one another under network partitions. The CAP theorem states that a shared-data system can provide at most two of the following three guarantees at any given time: strong consistency, high availability, and tolerance to network partitions. Because partitions are unavoidable on unreliable networks, engineers usually choose between consistent partitions that reject requests during an outage and highly available systems that return potentially stale data. A replication strategy must therefore replicate the durability semantics, ordering guarantees, and failure modes that the application can tolerate while keeping the read and write latency within an acceptable budget under realistic failure scenarios. This requires careful analysis of the round-trip time to replicas, the cost of quorum reads and writes, and the behaviour of the membership protocol that detects failed nodes and reconfigures the group.'
]

async function main(): Promise<void> {
  console.log('='.repeat(70))
  console.log('EnTransfer model + engine smoke test (optimized build)')
  console.log('='.repeat(70))
  console.log('Models dir :', getModelsDir())

  // 1. Model list ----------------------------------------------------------
  const models = getModels()
  console.log('\n[1] Model registry:')
  for (const m of models) {
    console.log(`    [${m.status.padEnd(13)}] ${m.id}  (${m.size}, ${m.quant})`)
  }

  const target = models.find((m) => m.status === 'available')
  if (!target) {
    throw new Error('No model with status=available found; expected the copied Hy-MT2 GGUF')
  }
  const modelPath = getModelPath(target.id)
  if (!modelPath) throw new Error('Could not resolve model path')
  console.log(`\n    using model: ${target.id}\n    path: ${modelPath}`)

  // 2. Engine load ---------------------------------------------------------
  const engine = new TranslationEngine()
  console.log('\n[2] Loading model (CPU-only, with warmup)...')
  const tLoad = Date.now()
  await engine.load(modelPath)
  console.log(`    loaded (incl. warmup) in ${((Date.now() - tLoad) / 1000).toFixed(1)}s`)

  // 3. Translate 3 passages back-to-back -----------------------------------
  console.log('\n[3] Translating 3 passages, per-segment timing:')
  const segmentMs: number[] = []
  const tAll = Date.now()

  for (let i = 0; i < PASSAGES.length; i++) {
    const src = PASSAGES[i]
    process.stdout.write(`\n    [seg ${i + 1}] (${src.split(/\s+/).length} words) ... `)
    const t0 = Date.now()
    const result = await engine.translate(src)
    const wall = Date.now() - t0
    segmentMs.push(wall)
    const tokPerSec = result.tokens / (result.timeMs / 1000)
    console.log(`done in ${(wall / 1000).toFixed(2)}s, ${result.tokens} out-tokens, ${tokPerSec.toFixed(2)} tok/s`)
    console.log(`        -> ${result.text}`)
  }

  const totalMs = Date.now() - tAll
  console.log('\n' + '-'.repeat(70))
  console.log('[4] Summary:')
  segmentMs.forEach((ms, i) => console.log(`    segment ${i + 1}: ${(ms / 1000).toFixed(2)}s`))
  console.log(`    total (3 segments): ${(totalMs / 1000).toFixed(2)}s`)
  console.log(`    per-segment avg   : ${(segmentMs.reduce((a, b) => a + b, 0) / segmentMs.length / 1000).toFixed(2)}s`)

  await engine.dispose()
  console.log('\n[OK] smoke test passed')
}

main().catch((err) => {
  console.error('\n[FAIL]', err)
  process.exit(1)
})
