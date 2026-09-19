// engine-config.ts — engine settings for the single converged model.
//
// After the 8-model benchmark the project ships only Qwen3-1.7B Q4_K_M with
// thinking disabled. Optimal params (threads=12, context=1024, temp=0.1,
// gpuLayers=max) are hardcoded here; see docs/MODEL-BENCHMARK.md.
import { GENERIC_SYSTEM_PROMPT } from './llama-engine.ts'

export interface EngineConfig {
  /** system prompt (chat-template fallback) */
  systemPrompt: string
  /** default KV context size */
  contextSize: number
  /** default CPU thread count */
  threads: number
  /** sampling */
  temperature: number
  topK: number
  topP: number
  /** CPU-only */
  gpuLayers: 0
  /** disable chain-of-thought / reasoning tokens (Qwen3) */
  disableReasoning?: boolean
}

/** The single shipped model's engine config. */
export const SINGLE_MODEL_CONFIG: EngineConfig = {
  systemPrompt: GENERIC_SYSTEM_PROMPT,
  // 1024 was a doc drift: paragraphs up to ~900 source tokens need prompt +
  // Chinese output in the SAME window (see llama-engine split threshold), and
  // measured decode speed is identical at 2048 (docs/SPEED-OPTIMIZATION.md).
  contextSize: 2048,
  threads: 12,
  temperature: 0.1,
  topK: 20,
  topP: 0.9,
  gpuLayers: 0,
  // Qwen3 defaults to thinking mode -> ~50x slowdown. Always disable it.
  disableReasoning: true
}

/**
 * Resolve the engine config for a model id. The project now ships a single
 * model, so every id resolves to the same config (kept as a function to match
 * the former API).
 */
export function getEngineConfig(_modelId?: string): EngineConfig {
  return SINGLE_MODEL_CONFIG
}
