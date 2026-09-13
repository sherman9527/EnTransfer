// engine.ts — backward-compatible facade.
//
// The implementation now lives in llama-engine.ts (LlamaCppEngine). This file
// keeps the historical `TranslationEngine` name so existing imports
// (pipeline, manager, e2e-test, __test__) compile unchanged. New code should
// import from llama-engine.ts / engine-interface.ts / engine-manager.ts.
export {
  LlamaCppEngine,
  LlamaCppEngine as TranslationEngine,
  HY_MT2_SYSTEM_PROMPT,
  GENERIC_SYSTEM_PROMPT
} from './llama-engine.ts'
export type { LlamaEngineOptions } from './llama-engine.ts'
export type {
  LoadOptions,
  TranslateOpts,
  TranslateResult
} from './engine-interface.ts'
// The structural interface itself lives in engine-interface.ts; re-export it
// under its own name (not aliased to the value class) to avoid a name clash.
export type { TranslationEngine as TranslationEngineContract } from './engine-interface.ts'
