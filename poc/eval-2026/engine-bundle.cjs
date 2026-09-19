"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/models/llama-engine.ts
var llama_engine_exports = {};
__export(llama_engine_exports, {
  GENERIC_SYSTEM_PROMPT: () => GENERIC_SYSTEM_PROMPT,
  HY_MT2_SYSTEM_PROMPT: () => HY_MT2_SYSTEM_PROMPT,
  LlamaCppEngine: () => LlamaCppEngine
});
module.exports = __toCommonJS(llama_engine_exports);
var import_node_os2 = __toESM(require("node:os"));

// electron/models/llama-cpp-loader.ts
var modulePromise = null;
function loadLlamaCpp() {
  if (!modulePromise) {
    modulePromise = import("node-llama-cpp");
  }
  return modulePromise;
}

// electron/models/gpu.ts
async function detectGpu() {
  try {
    const { getLlama } = await loadLlamaCpp();
    const llama = await getLlama({ gpu: "vulkan" });
    if (llama.gpu !== "vulkan" || !llama.supportsGpuOffloading) {
      await llama.dispose().catch(() => {
      });
      return { type: null };
    }
    const vram = await llama.getVramState();
    const devices = await llama.getGpuDeviceNames();
    const name = devices.length > 0 ? devices[0] : void 0;
    const info = {
      type: "vulkan",
      vramMB: Math.round(vram.total / 1024 / 1024),
      vramFreeMB: Math.round(vram.free / 1024 / 1024),
      name
    };
    await llama.dispose().catch(() => {
    });
    return info;
  } catch {
    return { type: null };
  }
}
function resolveGpuLayers(device, gpu) {
  if (device === "cpu") return 0;
  if (device === "gpu") {
    return gpu?.type === "vulkan" ? "max" : 0;
  }
  return gpu?.type === "vulkan" ? "max" : 0;
}

// electron/models/cpu-info.ts
var import_node_os = __toESM(require("node:os"));
var import_node_child_process = require("node:child_process");
function detectArchitecture() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  return "unknown";
}
function detectPhysicalCores(logicalCores) {
  if (process.platform === "win32") {
    try {
      const out = (0, import_node_child_process.execSync)(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json"',
        { timeout: 5e3, windowsHide: true }
      ).toString();
      const parsed = JSON.parse(out);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const physical2 = arr.reduce(
        (sum, row) => sum + Number(row.NumberOfCores ?? 0),
        0
      );
      if (physical2 > 0) return { physicalCores: physical2, source: "wmi" };
    } catch {
    }
  }
  const physical = logicalCores % 2 === 1 ? logicalCores : Math.round(logicalCores / 2);
  return { physicalCores: physical, source: "estimate" };
}
var HYBRID_GEN_RE = /(?:1[2345]th|15th)[\s-]?Gen|Core Ultra/i;
var PCORE_BY_SKU = {
  // 12th Gen (Alder Lake)
  "12600": 6,
  // i5-12600K/KF (6P+4E)
  "12700": 8,
  // i7-12700K/KF (8P+8E)
  "12900": 8,
  // i9-12900K/KF (8P+8E)
  // 13th Gen (Raptor Lake)
  "13600": 6,
  // i5-13600K/KF (6P+8E)
  "13700": 8,
  // i7-13700K/KF (8P+8E)
  "13900": 8,
  // i9-13900K/KF (8P+16E)
  // 14th Gen (Raptor Lake Refresh)
  "14600": 6,
  // i5-14600K/KF (6P+8E)
  "14700": 8,
  // i7-14700K/KF (8P+12E)
  "14900": 8
  // i9-14900K/KF (8P+16E)
};
function matchIntelSku(model) {
  const m = model.match(/i[3579]-?(\d{4,5})/i);
  return m ? m[1] : null;
}
function estimatePerformanceCores(model, physicalCores) {
  const sku = matchIntelSku(model);
  if (sku) {
    const p = PCORE_BY_SKU[sku];
    if (p && p <= physicalCores) return p;
  }
  return physicalCores;
}
function buildCpuInfo(model, logicalCores, physicalCores, architecture, physicalSource = "estimate") {
  const genHybrid = HYBRID_GEN_RE.test(model);
  const structuralHybrid = logicalCores > physicalCores && logicalCores < physicalCores * 2;
  const estimateFallbackHybrid = physicalSource === "estimate" && genHybrid && logicalCores > physicalCores * 1.5;
  const isHybrid = structuralHybrid || estimateFallbackHybrid;
  const performanceCores = isHybrid ? estimatePerformanceCores(model, physicalCores) : physicalCores;
  return {
    model,
    physicalCores,
    logicalCores,
    isHybrid,
    performanceCores,
    architecture,
    physicalSource
  };
}
function detectCpu() {
  const logicalCores = Math.max(1, import_node_os.default.cpus().length);
  const model = import_node_os.default.cpus()[0]?.model?.trim() ?? "Unknown CPU";
  const architecture = detectArchitecture();
  const { physicalCores, source } = detectPhysicalCores(logicalCores);
  return buildCpuInfo(model, logicalCores, physicalCores, architecture, source);
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function getDefaultThreads(cpu) {
  if (cpu.isHybrid) {
    return clamp(cpu.performanceCores * 2, 2, cpu.logicalCores);
  }
  if (cpu.architecture === "unknown") {
    return clamp(cpu.logicalCores - 1, 2, cpu.logicalCores);
  }
  return clamp(cpu.performanceCores, 2, cpu.logicalCores);
}

// electron/models/engine-errors.ts
var HARDWARE_ERROR_RE = /device\s*lost|vk_error|vulkan|out of memory|oom|allocation.*(fail|error)|cu(da|arses)?\s*error|ggml_(vk|cuda)|no (valid\s+)?device/i;
function isHardwareError(message) {
  return HARDWARE_ERROR_RE.test(message);
}
var SICK_ESCALATION_ERRORS = 3;

// electron/models/llama-engine.ts
var CONTEXT_SIZE = 2048;
var DEFAULT_TEMPERATURE = 0.1;
var DEFAULT_TOP_K = 20;
var DEFAULT_TOP_P = 0.9;
var MAX_TOKENS = 2048;
var PROMPT_TOKEN_SPLIT_THRESHOLD = 1800;
var HY_MT2_SYSTEM_PROMPT = "\u5C06\u4EE5\u4E0B\u82F1\u6587\u6280\u672F\u6587\u6863\u7FFB\u8BD1\u4E3A\u7B80\u4F53\u4E2D\u6587\u3002\n\u8981\u6C42\uFF1A\n1. \u4FDD\u7559\u4EE3\u7801\u5757\u3001\u516C\u5F0F\u3001URL \u4E0D\u7FFB\u8BD1\n2. \u4E13\u4E1A\u672F\u8BED\u51C6\u786E\n3. \u53EA\u8F93\u51FA\u8BD1\u6587\uFF0C\u4E0D\u8981\u6DFB\u52A0\u89E3\u91CA\u6216\u539F\u6587";
var GENERIC_SYSTEM_PROMPT = "Translate the following English text to Chinese. Output only the translation, no explanation.";
function defaultThreads() {
  return Math.min(12, Math.max(2, import_node_os2.default.cpus().length - 1));
}
function splitAtSentenceBoundary(text) {
  const len = text.length;
  if (len < 8) return Math.ceil(len / 2);
  const mid = Math.floor(len / 2);
  const min = Math.floor(len * 0.3);
  const max = Math.floor(len * 0.7);
  let best = -1;
  let bestDist = Infinity;
  const re = /[.!?](?:\s|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index < min) continue;
    if (m.index > max) break;
    const dist = Math.abs(m.index - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = m.index + 1;
    }
  }
  if (best > 0) return best;
  const space = text.lastIndexOf(" ", mid);
  if (space > len * 0.2) return space;
  return mid;
}
var LlamaCppEngine = class {
  id;
  systemPrompt;
  llama = null;
  model = null;
  context = null;
  session = null;
  loadedPath = "";
  loadPromise = null;
  threads;
  contextSize;
  temperature;
  topK;
  topP;
  prefixCaching;
  kvCacheValueType;
  device;
  threadsMode;
  disableReasoning;
  /**
   * Token sequence of the system-prompt-only chat state. Captured once after
   * warmup; reused between translations via `sequence.adaptStateToTokens` so the
   * system prompt's KV cache survives across paragraphs (prefix caching), instead
   * of `resetChatHistory()` which clears the whole KV and forces a full re-prefill.
   */
  systemTokens = [];
  constructor(options = {}) {
    this.id = options.id ?? "llama";
    this.systemPrompt = options.systemPrompt ?? HY_MT2_SYSTEM_PROMPT;
    this.contextSize = options.contextSize ?? CONTEXT_SIZE;
    this.threads = options.threads ?? defaultThreads();
    this.temperature = options.sampling?.temperature ?? DEFAULT_TEMPERATURE;
    this.topK = options.sampling?.topK ?? DEFAULT_TOP_K;
    this.topP = options.sampling?.topP ?? DEFAULT_TOP_P;
    this.prefixCaching = options.prefixCaching ?? true;
    this.kvCacheValueType = options.kvCacheValueType;
    this.device = options.device ?? "auto";
    this.threadsMode = options.threadsMode ?? "auto";
    this.disableReasoning = options.disableReasoning ?? false;
  }
  get isLoaded() {
    return this.model !== null && this.context !== null && this.session !== null;
  }
  /** Absolute path of the loaded model (compat: used to be `currentModelPath`). */
  get modelPath() {
    return this.loadedPath;
  }
  /** @deprecated use modelPath; kept for backward compatibility. */
  get currentModelPath() {
    return this.loadedPath;
  }
  buildPrompt(text) {
    return `${this.systemPrompt}

\u539F\u6587\uFF1A
${text}

\u8BD1\u6587\uFF1A`;
  }
  load(modelPath, options) {
    const path = modelPath ?? this.loadedPath;
    if (this.loadedPath === path && this.isLoaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad(path, options).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }
  async doLoad(modelPath, options) {
    await this.dispose();
    const { getLlama, JinjaTemplateChatWrapper, LlamaChatSession } = await loadLlamaCpp();
    const device = options?.device ?? this.device;
    this.device = device;
    const reqThreads = options?.threads;
    let threads;
    if (reqThreads === "auto" || reqThreads == null && this.threadsMode === "auto") {
      threads = getDefaultThreads(detectCpu());
    } else if (typeof reqThreads === "number") {
      threads = reqThreads;
    } else {
      threads = this.threads;
    }
    this.threads = threads;
    const gpu = device === "cpu" ? null : await detectGpu();
    let gpuLayers = resolveGpuLayers(device, gpu);
    const wantGpu = gpuLayers !== 0;
    const baseContext = options?.contextSize ?? this.contextSize;
    this.contextSize = wantGpu ? Math.max(baseContext, 4096) : baseContext;
    console.log(`[llama] contextSize=${this.contextSize} (${wantGpu ? "GPU" : "CPU"})`);
    console.log(
      `[llama] load: device=${device} gpu=${gpu?.type ?? "none"} gpuLayers=${gpuLayers} threads=${threads}`
    );
    const contextOptions = () => {
      const co = { contextSize: this.contextSize, threads };
      if (this.kvCacheValueType) {
        co.experimentalKvCacheValueType = this.kvCacheValueType;
      }
      return co;
    };
    try {
      this.llama = wantGpu ? await getLlama({ gpu: "vulkan" }) : await getLlama();
      this.model = await this.llama.loadModel({
        modelPath,
        gpuLayers,
        prefixCaching: this.prefixCaching
      });
      this.context = await this.model.createContext(contextOptions());
    } catch (err) {
      console.warn("[llama] GPU/Vulkan load failed, falling back to CPU:", err);
      await this.context?.dispose().catch(() => {
      });
      await this.model?.dispose().catch(() => {
      });
      await this.llama?.dispose().catch(() => {
      });
      this.llama = null;
      this.model = null;
      this.context = null;
      gpuLayers = 0;
      this.llama = await getLlama();
      this.model = await this.llama.loadModel({
        modelPath,
        gpuLayers: 0,
        prefixCaching: this.prefixCaching
      });
      this.context = await this.model.createContext(contextOptions());
    }
    let chatWrapper;
    if (this.disableReasoning) {
      try {
        const tmpl = this.model.fileInfo?.metadata?.tokenizer?.chat_template;
        if (typeof tmpl === "string") {
          chatWrapper = new JinjaTemplateChatWrapper({
            template: tmpl,
            reasoning: false,
            tokenizer: this.model.tokenizer
          });
        }
      } catch (err) {
        console.warn("[llama] disableReasoning wrapper build failed, using default:", err);
        chatWrapper = void 0;
      }
    }
    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      chatWrapper: chatWrapper ?? "auto",
      systemPrompt: this.systemPrompt
    });
    this.loadedPath = modelPath;
    try {
      await this.session.promptWithMeta("hi", { maxTokens: 1, temperature: 0 });
    } catch {
    }
    this.session.resetChatHistory();
    this.systemTokens = [...this.session.sequence.contextTokens];
  }
  /**
   * Rewind the sequence to the system-prompt-only state while KEEPING the system
   * prompt's KV cache warm. Unlike `session.resetChatHistory()` (which calls
   * `sequence.clearHistory()` and wipes every cached token), this erases only the
   * previous user+assistant turn via `adaptStateToTokens`, so the next translation
   * reuses the cached system-prompt prefix and skips its prefill.
   */
  async resetToSystemPrefix() {
    if (!this.session) return;
    const seq = this.session.sequence;
    if (this.systemTokens.length > 0) {
      await seq.adaptStateToTokens(this.systemTokens, false);
    }
    this.session.setChatHistory([{ type: "system", text: this.systemPrompt }]);
  }
  async translate(text, options) {
    if (!this.model || !this.context || !this.session) {
      throw new Error("LlamaCppEngine: model not loaded; call load() first");
    }
    await this.resetToSystemPrefix();
    const promptTokenCount = this.model.tokenize(this.buildPrompt(text), false).length;
    const splitThreshold = Math.min(PROMPT_TOKEN_SPLIT_THRESHOLD, Math.floor(this.contextSize * 0.45));
    if (promptTokenCount <= splitThreshold) {
      return this.translateOne(text, options, promptTokenCount);
    }
    const cut = splitAtSentenceBoundary(text);
    const first = await this.translateOne(text.slice(0, cut), options);
    await this.resetToSystemPrefix();
    const second = await this.translateOne(text.slice(cut), options);
    return {
      text: first.text + second.text,
      tokens: first.tokens + second.tokens,
      timeMs: first.timeMs + second.timeMs,
      promptTokens: promptTokenCount,
      firstTokenMs: first.firstTokenMs
    };
  }
  /** True when a mid-generation failure (Vulkan device lost, driver crash,
   *  VRAM OOM) marks this engine unfit; EngineManager then rebuilds it —
   * sticky — on CPU so the running job can continue. */
  sick = false;
  consecErrors = 0;
  get isSick() {
    return this.sick;
  }
  async translateOne(text, options, promptTokenCount) {
    const model = this.model;
    const session = this.session;
    if (!model || !session) {
      throw new Error("LlamaCppEngine: model not loaded; call load() first");
    }
    const prompt = this.buildPrompt(text);
    const promptTokens = promptTokenCount ?? model.tokenize(prompt, false).length;
    const t0 = Date.now();
    let firstTokenAt = null;
    const maxTokens = Math.max(64, Math.min(MAX_TOKENS, this.contextSize - promptTokens - 16));
    let result;
    try {
      result = await session.promptWithMeta(prompt, {
        maxTokens,
        temperature: options?.temperature ?? this.temperature,
        topK: this.topK,
        topP: this.topP,
        signal: options?.signal,
        stopOnAbortSignal: true,
        onTextChunk: () => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
        }
      });
    } catch (err) {
      if (!options?.signal?.aborted) {
        const msg = err?.message ?? String(err);
        this.consecErrors++;
        if (isHardwareError(msg) || this.consecErrors >= SICK_ESCALATION_ERRORS) this.sick = true;
      }
      throw err;
    }
    this.consecErrors = 0;
    const timeMs = Date.now() - t0;
    const tokens = model.tokenize(result.responseText, false).length;
    return {
      text: result.responseText,
      tokens,
      timeMs,
      promptTokens,
      firstTokenMs: firstTokenAt !== null ? firstTokenAt - t0 : timeMs
    };
  }
  /** Token count of a text under the loaded model's tokenizer (benchmark helper). */
  tokenizeCount(text) {
    return this.model ? this.model.tokenize(text, false).length : 0;
  }
  /** Release the loaded model and context. Safe to call repeatedly.
   *  dispose() on model/context is async in node-llama-cpp — awaiting here
   *  prevents VRAM doubling when the manager rebuilds right after. */
  async dispose() {
    const teardown = [];
    const session = this.session;
    this.session = null;
    if (session) teardown.push(Promise.resolve(session.dispose()).catch(() => {
    }));
    const ctx = this.context;
    this.context = null;
    if (ctx) teardown.push(Promise.resolve(ctx.dispose()).catch(() => {
    }));
    const model = this.model;
    this.model = null;
    if (model) teardown.push(Promise.resolve(model.dispose()).catch(() => {
    }));
    this.loadedPath = "";
    await Promise.allSettled(teardown);
  }
  /** Interface alias for {@link dispose}. */
  async unload() {
    await this.dispose();
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GENERIC_SYSTEM_PROMPT,
  HY_MT2_SYSTEM_PROMPT,
  LlamaCppEngine
});
