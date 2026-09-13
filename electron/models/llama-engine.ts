// llama-engine.ts — node-llama-cpp (llama.cpp) implementation of TranslationEngine.
//
// This is the behavioural heir of the original electron/models/engine.ts. The
// translation loop (reused model/context/session, prefix caching, sentence-boundary
// splitting for over-budget paragraphs) is unchanged; what changed is that the
// system prompt and sampling defaults are now injected via the constructor so the
// same code drives Hy-MT2 (Chinese prompt) and generic instruct models
// (English prompt) alike.
import os from 'node:os'
import {
  getLlama,
  LlamaChatSession,
  JinjaTemplateChatWrapper,
  type Llama,
  type LlamaContext,
  type LlamaModel,
  type LlamaModelOptions,
  type ChatWrapper,
  type Token
} from 'node-llama-cpp'
import type {
  LoadOptions,
  TranslateOpts,
  TranslateResult
} from './engine-interface.ts'
import {
  detectGpu,
  resolveGpuLayers,
  type DevicePreference,
  type GpuInfo
} from './gpu.ts'
import { detectCpu, getDefaultThreads } from './cpu-info.ts'

/**
 * Default KV context size.
 *
 * Tuning (docs/SPEED-OPTIMIZATION.md): measured prompt p95=125 tokens and
 * output max=79 tokens, so 2048 is comfortably enough for one paragraph +
 * system prompt. 4096 gave identical decode speed but ~130MB higher peak RSS.
 */
const CONTEXT_SIZE = 2048
const DEFAULT_TEMPERATURE = 0.1
const DEFAULT_TOP_K = 20
const DEFAULT_TOP_P = 0.9
const MAX_TOKENS = 2048
/** Split a paragraph on a sentence boundary once the prompt would exceed this. */
const PROMPT_TOKEN_SPLIT_THRESHOLD = 1800

/** Default system prompt: the validated Hy-MT2 Chinese technical-translation prompt. */
export const HY_MT2_SYSTEM_PROMPT =
  '将以下英文技术文档翻译为简体中文。\n' +
  '要求：\n1. 保留代码块、公式、URL 不翻译\n2. 专业术语准确\n3. 只输出译文，不要添加解释或原文'

/** Generic prompt for ordinary instruct models (Qwen / MiniCPM / …). */
export const GENERIC_SYSTEM_PROMPT =
  'Translate the following English text to Chinese. Output only the translation, no explanation.'

export interface LlamaEngineOptions {
  /** stable model id; defaults to "llama" */
  id?: string
  /** system prompt prepended to every translation; defaults to the Hy-MT2 prompt */
  systemPrompt?: string
  /** default context size (overridable per load) */
  contextSize?: number
  /** default thread count (overridable per load) */
  threads?: number
  sampling?: Partial<{ temperature: number; topK: number; topP: number }>
  /** enable KV prefix caching (default true); set false for A/B testing */
  prefixCaching?: boolean
  /** experimental KV cache value quantization (e.g. "q8_0"); undefined = F16 default */
  kvCacheValueType?: string
  /**
   * inference device preference (default 'auto'). When 'auto', a Vulkan GPU is
   * probed at load() time and used if present; CPU otherwise.
   */
  device?: DevicePreference
  /**
   * thread-count policy. 'auto' (default) resolves the smart default from the
   * detected CPU at load(); 'manual' honours `threads` verbatim.
   */
  threadsMode?: 'auto' | 'manual'
  /**
   * Disable chain-of-thought / reasoning models (Qwen3, MiniCPM5) by forcing the
   * chat template's `enable_thinking=false` equivalent. Without this these models
   * emit hundreds of hidden `<think>` tokens, tanking speed ~50x and polluting the
   * output. Builds a JinjaTemplateChatWrapper from the model's own template.
   */
  disableReasoning?: boolean
}

/**
 * Adaptive default thread count.
 *
 * Tuning on i5-12600KF (6P+4E, 16 logical): decode is memory-bandwidth bound.
 *   threads 6 (P cores, no HT):  7.2 tok/s
 *   threads 8 (mixed):           ~8.5 tok/s
 *   threads 12 (P cores + HT):   9.0 tok/s   <- sweet spot
 *   threads 16 (all + E cores):  7.1 tok/s   <- E cores hurt via contention
 * Capping at 12 deliberately excludes the efficiency cores. On other CPUs this
 * is still a reasonable "physical-ish" default; override per load if needed.
 */
function defaultThreads(): number {
  return Math.min(12, Math.max(2, os.cpus().length - 1))
}

/**
 * Pick a split position near the middle of `text` on a sentence boundary.
 */
function splitAtSentenceBoundary(text: string): number {
  const len = text.length
  if (len < 8) return Math.ceil(len / 2)
  const mid = Math.floor(len / 2)
  const min = Math.floor(len * 0.3)
  const max = Math.floor(len * 0.7)
  let best = -1
  let bestDist = Infinity
  const re = /[.!?](?:\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index < min) continue
    if (m.index > max) break
    const dist = Math.abs(m.index - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = m.index + 1
    }
  }
  if (best > 0) return best
  const space = text.lastIndexOf(' ', mid)
  if (space > len * 0.2) return space
  return mid
}

export class LlamaCppEngine {
  readonly id: string
  readonly systemPrompt: string
  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private context: LlamaContext | null = null
  private session: LlamaChatSession | null = null
  private loadedPath = ''
  private loadPromise: Promise<void> | null = null
  private threads: number
  private contextSize: number
  private readonly temperature: number
  private readonly topK: number
  private readonly topP: number
  private readonly prefixCaching: boolean
  private readonly kvCacheValueType: string | undefined
  private device: DevicePreference
  private readonly threadsMode: 'auto' | 'manual'
  private readonly disableReasoning: boolean
  /**
   * Token sequence of the system-prompt-only chat state. Captured once after
   * warmup; reused between translations via `sequence.adaptStateToTokens` so the
   * system prompt's KV cache survives across paragraphs (prefix caching), instead
   * of `resetChatHistory()` which clears the whole KV and forces a full re-prefill.
   */
  private systemTokens: Token[] = []

  constructor(options: LlamaEngineOptions = {}) {
    this.id = options.id ?? 'llama'
    this.systemPrompt = options.systemPrompt ?? HY_MT2_SYSTEM_PROMPT
    this.contextSize = options.contextSize ?? CONTEXT_SIZE
    this.threads = options.threads ?? defaultThreads()
    this.temperature = options.sampling?.temperature ?? DEFAULT_TEMPERATURE
    this.topK = options.sampling?.topK ?? DEFAULT_TOP_K
    this.topP = options.sampling?.topP ?? DEFAULT_TOP_P
    this.prefixCaching = options.prefixCaching ?? true
    this.kvCacheValueType = options.kvCacheValueType
    this.device = options.device ?? 'auto'
    this.threadsMode = options.threadsMode ?? 'auto'
    this.disableReasoning = options.disableReasoning ?? false
  }

  get isLoaded(): boolean {
    return this.model !== null && this.context !== null && this.session !== null
  }

  /** Absolute path of the loaded model (compat: used to be `currentModelPath`). */
  get modelPath(): string {
    return this.loadedPath
  }

  /** @deprecated use modelPath; kept for backward compatibility. */
  get currentModelPath(): string {
    return this.loadedPath
  }

  private buildPrompt(text: string): string {
    return `${this.systemPrompt}\n\n原文：\n${text}\n\n译文：`
  }

  load(modelPath?: string, options?: LoadOptions): Promise<void> {
    // Backward-compat: legacy callers pass the path as the first argument.
    const path = modelPath ?? this.loadedPath
    if (this.loadedPath === path && this.isLoaded) return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.doLoad(path, options).finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async doLoad(modelPath: string, options?: LoadOptions): Promise<void> {
    await this.dispose()

    // ---- Resolve device preference -------------------------------------
    const device: DevicePreference = options?.device ?? this.device
    this.device = device

    // ---- Resolve thread count ------------------------------------------
    // Precedence: explicit numeric option > 'auto' resolution > ctor threads.
    const reqThreads = options?.threads
    let threads: number
    if (reqThreads === 'auto' || (reqThreads == null && this.threadsMode === 'auto')) {
      threads = getDefaultThreads(detectCpu())
    } else if (typeof reqThreads === 'number') {
      threads = reqThreads
    } else {
      threads = this.threads
    }
    this.threads = threads
    this.contextSize = options?.contextSize ?? this.contextSize

    // ---- Resolve GPU offloading ----------------------------------------
    // 'cpu' skips probing entirely (cheap, no Vulkan init). Otherwise probe.
    const gpu: GpuInfo | null = device === 'cpu' ? null : await detectGpu()
    let gpuLayers = resolveGpuLayers(device, gpu)
    const wantGpu = gpuLayers !== 0
    console.log(
      `[llama] load: device=${device} gpu=${gpu?.type ?? 'none'} gpuLayers=${gpuLayers} threads=${threads}`
    )

    const contextOptions = (): Parameters<LlamaModel['createContext']>[0] => {
      const co: Record<string, unknown> = { contextSize: this.contextSize, threads }
      if (this.kvCacheValueType) {
        // Experimental in node-llama-cpp v3.20; passed through for A/B tuning only.
        co.experimentalKvCacheValueType = this.kvCacheValueType
      }
      return co as Parameters<LlamaModel['createContext']>[0]
    }

    // ---- Load with the chosen backend, auto-fallback to CPU on failure --
    try {
      this.llama = wantGpu ? await getLlama({ gpu: 'vulkan' }) : await getLlama()
      this.model = await this.llama.loadModel({
        modelPath,
        gpuLayers,
        prefixCaching: this.prefixCaching
      } as LlamaModelOptions)
      this.context = await this.model.createContext(contextOptions())
    } catch (err) {
      console.warn('[llama] GPU/Vulkan load failed, falling back to CPU:', err)
      // Tear down the half-initialised GPU stack and retry on plain CPU.
      await this.context?.dispose().catch(() => {})
      await this.model?.dispose().catch(() => {})
      await this.llama?.dispose().catch(() => {})
      this.llama = null
      this.model = null
      this.context = null
      gpuLayers = 0

      this.llama = await getLlama()
      this.model = await this.llama.loadModel({
        modelPath,
        gpuLayers: 0,
        prefixCaching: this.prefixCaching
      } as LlamaModelOptions)
      this.context = await this.model.createContext(contextOptions())
    }

    // Build a reasoning-disabling chat wrapper for reasoning models (Qwen3 /
    // MiniCPM5). Falls back to the model's default wrapper if the GGUF lacks a
    // jinja chat template.
    let chatWrapper: ChatWrapper | undefined
    if (this.disableReasoning) {
      try {
        const tmpl = (this.model as any).fileInfo?.metadata?.tokenizer?.chat_template
        if (typeof tmpl === 'string') {
          chatWrapper = new JinjaTemplateChatWrapper({
            template: tmpl,
            reasoning: false,
            tokenizer: this.model.tokenizer
          })
        }
      } catch (err) {
        console.warn('[llama] disableReasoning wrapper build failed, using default:', err)
        chatWrapper = undefined
      }
    }

    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      chatWrapper: chatWrapper ?? 'auto',
      systemPrompt: this.systemPrompt
    })
    this.loadedPath = modelPath

    try {
      await this.session.promptWithMeta('hi', { maxTokens: 1, temperature: 0 })
    } catch {
      // ignore warmup failures
    }
    this.session.resetChatHistory()
    // Capture the system-prompt-only token sequence for KV-prefix reuse.
    this.systemTokens = [...this.session.sequence.contextTokens]
  }

  /**
   * Rewind the sequence to the system-prompt-only state while KEEPING the system
   * prompt's KV cache warm. Unlike `session.resetChatHistory()` (which calls
   * `sequence.clearHistory()` and wipes every cached token), this erases only the
   * previous user+assistant turn via `adaptStateToTokens`, so the next translation
   * reuses the cached system-prompt prefix and skips its prefill.
   */
  private async resetToSystemPrefix(): Promise<void> {
    if (!this.session) return
    const seq = this.session.sequence
    if (this.systemTokens.length > 0) {
      await seq.adaptStateToTokens(this.systemTokens, false)
    }
    // Re-align the in-memory chat history to the bare system message so the next
    // promptWithMeta builds on the same prefix (and does not re-add system tokens).
    this.session.setChatHistory([{ type: 'system', text: this.systemPrompt }])
  }

  async translate(text: string, options?: TranslateOpts): Promise<TranslateResult> {
    if (!this.model || !this.context || !this.session) {
      throw new Error('LlamaCppEngine: model not loaded; call load() first')
    }
    await this.resetToSystemPrefix()

    const promptTokenCount = this.model.tokenize(this.buildPrompt(text), false).length
    if (promptTokenCount <= PROMPT_TOKEN_SPLIT_THRESHOLD) {
      return this.translateOne(text, options, promptTokenCount)
    }
    const cut = splitAtSentenceBoundary(text)
    const first = await this.translateOne(text.slice(0, cut), options)
    await this.resetToSystemPrefix()
    const second = await this.translateOne(text.slice(cut), options)
    return {
      text: first.text + second.text,
      tokens: first.tokens + second.tokens,
      timeMs: first.timeMs + second.timeMs,
      promptTokens: promptTokenCount,
      firstTokenMs: first.firstTokenMs
    }
  }

  private async translateOne(
    text: string,
    options?: TranslateOpts,
    promptTokenCount?: number
  ): Promise<TranslateResult> {
    const model = this.model
    const session = this.session
    if (!model || !session) {
      throw new Error('LlamaCppEngine: model not loaded; call load() first')
    }
    const prompt = this.buildPrompt(text)
    const promptTokens = promptTokenCount ?? model.tokenize(prompt, false).length
    const t0 = Date.now()
    let firstTokenAt: number | null = null
    const result = await session.promptWithMeta(prompt, {
      maxTokens: MAX_TOKENS,
      temperature: options?.temperature ?? this.temperature,
      topK: this.topK,
      topP: this.topP,
      signal: options?.signal,
      stopOnAbortSignal: true,
      onTextChunk: () => {
        if (firstTokenAt === null) firstTokenAt = Date.now()
      }
    })
    const timeMs = Date.now() - t0
    const tokens = model.tokenize(result.responseText, false).length
    return {
      text: result.responseText,
      tokens,
      timeMs,
      promptTokens,
      firstTokenMs: firstTokenAt !== null ? firstTokenAt - t0 : timeMs
    }
  }

  /** Release the loaded model and context. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.session?.dispose()
    this.session = null
    this.context?.dispose()
    this.context = null
    this.model?.dispose()
    this.model = null
    this.loadedPath = ''
  }

  /** Interface alias for {@link dispose}. */
  async unload(): Promise<void> {
    await this.dispose()
  }
}
