// thread-benchmark.ts — empirically find the fastest CPU thread count.
//
// Theoretical defaults from cpu-info.ts are good, but the memory hierarchy,
// BIOS power plan and thermal limits vary per machine. This module loads the
// model once per candidate thread count, runs a few short generations, and
// reports measured tok/s so the UI can pick the empirical optimum.
//
// Each candidate reloads the model+context (threads are bound at context
// creation), so the whole sweep takes ~30–60s for a 1–2B Q4 model.
import { LlamaCppEngine } from './llama-engine.ts'
import { detectCpu, getDefaultThreads, type CpuInfo } from './cpu-info.ts'

export interface ThreadBenchmarkResult {
  threads: number
  /** average decoded tokens/second across the runs */
  tokPerSec: number
}

const CONTEXT_SIZE = 2048
const RUNS_PER_CANDIDATE = 3
/** Short, deterministic-ish prompt so every candidate decodes comparable text. */
const SAMPLE_PROMPT =
  'Translate the following English text to Chinese, output only the translation: ' +
  'The architecture uses a layered design where each stage reads from a shared queue ' +
  'and pushes results to the next stage, keeping memory bandwidth as the bottleneck.'

/**
 * Default candidate thread counts: spread around the smart default, clamped to
 * the machine's logical-core count. Always includes the recommended value.
 */
export function defaultCandidates(cpu: CpuInfo): number[] {
  const rec = getDefaultThreads(cpu)
  const spread = [rec - 4, rec - 2, rec, rec + 2, rec + 4, rec + 6, 16]
  const set = new Set<number>()
  for (const n of spread) {
    if (n >= 2 && n <= cpu.logicalCores) set.add(n)
  }
  // Always probe a low and a high end for comparison.
  set.add(2)
  if (cpu.logicalCores <= 16) set.add(cpu.logicalCores)
  return [...set].sort((a, b) => a - b)
}

/**
 * Sweep candidate thread counts and return each measured tok/s, sorted fastest
 * first. The first element is the empirically optimal thread count.
 *
 * @param modelPath absolute path to the GGUF model
 * @param candidates optional override of the thread counts to test
 */
export async function benchmarkThreads(
  modelPath: string,
  candidates?: number[]
): Promise<ThreadBenchmarkResult[]> {
  const cpu = detectCpu()
  const cands = candidates ?? defaultCandidates(cpu)
  const results: ThreadBenchmarkResult[] = []

  console.log(
    `[thread-benchmark] ${describeShort(cpu)} — candidates: ${cands.join(', ')}`
  )

  for (const threads of cands) {
    const engine = new LlamaCppEngine({
      id: 'thread-bench',
      contextSize: CONTEXT_SIZE,
      threads
    })
    await engine.load(modelPath, { threads, contextSize: CONTEXT_SIZE })

    let totalTokens = 0
    let totalMs = 0
    for (let i = 0; i < RUNS_PER_CANDIDATE; i++) {
      const r = await engine.translate(SAMPLE_PROMPT, { temperature: 0 })
      totalTokens += r.tokens
      totalMs += r.timeMs
    }
    await engine.unload()

    const tokPerSec = totalMs > 0 ? totalTokens / (totalMs / 1000) : 0
    const rounded = Number(tokPerSec.toFixed(2))
    results.push({ threads, tokPerSec: rounded })
    console.log(`  threads=${String(threads).padStart(2)}: ${rounded.toFixed(2)} tok/s`)
  }

  return results.sort((a, b) => b.tokPerSec - a.tokPerSec)
}

/** One-line descriptor used by the benchmark log. */
function describeShort(cpu: CpuInfo): string {
  const e = cpu.isHybrid ? `${cpu.performanceCores}P+${cpu.physicalCores - cpu.performanceCores}E` : `${cpu.physicalCores}核`
  return `${cpu.model.trim()} (${e}, ${cpu.logicalCores}逻辑)`
}
