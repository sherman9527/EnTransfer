// engine-interface.ts — the common translation-engine contract.
//
// Every backend (node-llama-cpp GGUF today; CTranslate2 / ONNX NMT tomorrow)
// implements this interface so the pipeline, benchmark runner and EngineManager
// can treat them interchangeably. Adding a new model = adding a config entry,
// never touching engine runtime code.

/** Options honoured when (re)loading a model. */
export interface LoadOptions {
  /**
   * override the number of CPU threads used by the context.
   * A number pins the count; 'auto' asks the backend to pick a smart default
   * (e.g. P-cores × 2 on a hybrid Intel chip).
   */
  threads?: number | 'auto'
  /** override the KV context size */
  contextSize?: number
  /**
   * inference device preference:
   * - 'auto' (default): use a Vulkan GPU if one is detected, else CPU
   * - 'cpu': force CPU-only
   * - 'gpu': force Vulkan GPU (falls back to CPU if none detected)
   */
  device?: 'auto' | 'cpu' | 'gpu'
}

/** Per-call generation options. */
export interface TranslateOpts {
  /** abort an in-flight generation */
  signal?: AbortSignal
  /** sampling temperature; lower = more deterministic */
  temperature?: number
  /**
   * constrained-decoding grammar (opaque LlamaGrammar created via
   * engine.createJsonSchemaGrammar). Undefined = free-form decoding (default).
   */
  grammar?: unknown
}

/** Result of a single translation call. */
export interface TranslateResult {
  text: string
  /** number of tokens in the generated translation */
  tokens: number
  /** wall-clock time for the generation, milliseconds */
  timeMs: number
  /** number of tokens in the prompt fed to the model (system prompt + source). Profiling only. */
  promptTokens?: number
  /** wall-clock time until the first generated token (prefill), ms. Profiling only. */
  firstTokenMs?: number
}

/** Fixed sampling defaults shared across engines. */
export interface SamplingDefaults {
  temperature: number
  topK: number
  topP: number
}

/**
 * Capability surface a translation engine must expose. The concrete
 * constructor may still accept backend-specific options, but the runtime only
 * ever depends on this shape.
 */
export interface TranslationEngine {
  /** stable model id (e.g. "hy-mt2-1.8b-q4_k_m") */
  readonly id: string
  /** absolute path of the currently loaded model, or '' */
  readonly modelPath: string
  /** whether a model + context + session are loaded and ready */
  readonly isLoaded: boolean

  /**
   * Load (or reuse) a model. Pass `modelPath` when selecting a specific file;
   * implementations memoise on the loaded path.
   */
  load(modelPath?: string, options?: LoadOptions): Promise<void>

  /** Translate `text`; resolve with the generated text plus timing metadata. */
  translate(text: string, options?: TranslateOpts): Promise<TranslateResult>

  /** Release the loaded model and context. Safe to call repeatedly. */
  unload(): Promise<void>
}
