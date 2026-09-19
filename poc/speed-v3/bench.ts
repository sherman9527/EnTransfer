// bench.ts — POC speed benchmark for the translation engine.
//
// Modes (all on the SAME 40-paragraph corpus from corpus.json):
//   --device gpu|cpu      inference device (default gpu)
//   --seq N               concurrent sequences sharing ONE context (default 1)
//   --spec 0|1            speculative decoding with Qwen3-0.6B draft (GPU only, default 0)
//   --threads T           threads per context (default 12)
//   --ctx N               context size (default 2048)
//   --main PATH           main GGUF (default models/Qwen3-1.7B-Q4_K_M.gguf)
//   --draft PATH          draft GGUF (default models/Qwen3-0.6B-Q4_K_M.gguf)
//   --system EN|ZH        system prompt flavor (default EN = GENERIC)
//   --fa 0|1              flash attention (default 0)
//   --limit N             paragraphs to run (default all)
//
// Per-session behaviour mirrors electron/models/llama-engine.ts: system prompt
// embedded in the user message + session systemPrompt, and between units the
// sequence rewinds to the captured system-token prefix (KV stays warm).
import fs from 'node:fs'
import path from 'node:path'
import { loadLlamaCpp } from '../../electron/models/llama-cpp-loader'
import type {
  Llama,
  LlamaModel,
  LlamaContext,
  Token,
  LlamaChatSession
} from 'node-llama-cpp'

const ROOT = process.cwd()

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const device = arg('device', 'gpu') as 'gpu' | 'cpu'
const seqN = Number(arg('seq', '1'))
const specOn = arg('spec', '0') === '1'
const threads = Number(arg('threads', '12'))
const ctxSize = Number(arg('ctx', '2048'))
const mainPath = arg('main', path.join(ROOT, 'models', 'Qwen3-1.7B-Q4_K_M.gguf'))
const draftPath = arg('draft', path.join(ROOT, 'models', 'Qwen3-0.6B-Q4_K_M.gguf'))
const faOn = arg('fa', '0') === '1'
const limit = Number(arg('limit', '999'))
const systemKind = arg('system', 'EN')

const SYSTEM_EN = 'Translate the following English text to Chinese. Output only the translation, no explanation.'
const SYSTEM_ZH =
  '将以下英文技术文档翻译为简体中文。\n要求：\n1. 保留代码块、公式、URL 不翻译\n2. 专业术语准确\n3. 只输出译文，不要添加解释或原文'
const SYSTEM_PROMPT = systemKind === 'ZH' ? SYSTEM_ZH : SYSTEM_EN

function buildPrompt(text: string): string {
  return `${SYSTEM_PROMPT}\n\n原文：\n${text}\n\n译文：`
}

/** One translation lane: session + warm system-prefix rewind (engine semantics). */
class Lane {
  readonly session: LlamaChatSession
  private systemTokens: Token[] = []

  private constructor(session: LlamaChatSession) {
    this.session = session
  }

  static async create(ctx: LlamaContext, model: LlamaModel, predictor?: unknown): Promise<Lane> {
    const { LlamaChatSession, JinjaTemplateChatWrapper } = await loadLlamaCpp()
    let chatWrapper: ConstructorParameters<typeof LlamaChatSession>[0]['chatWrapper']
    const tmpl = (model.fileInfo as { metadata?: { tokenizer?: { chat_template?: string } } })
      ?.metadata?.tokenizer?.chat_template
    if (typeof tmpl === 'string') {
      chatWrapper = new JinjaTemplateChatWrapper({ template: tmpl, reasoning: false, tokenizer: model.tokenizer })
    }
    const seq = ctx.getSequence(predictor ? { tokenPredictor: predictor as never } : undefined)
    const session = new LlamaChatSession({ contextSequence: seq, chatWrapper: chatWrapper ?? 'auto', systemPrompt: SYSTEM_PROMPT })
    const lane = new Lane(session)
    // warmup + capture system-only prefix, exactly like engine.doLoad()
    try { await session.promptWithMeta('hi', { maxTokens: 1, temperature: 0 }) } catch { /* ignore */ }
    session.resetChatHistory()
    lane.systemTokens = [...session.sequence.contextTokens]
    return lane
  }

  async rewind(): Promise<void> {
    if (this.systemTokens.length > 0) {
      await this.session.sequence.adaptStateToTokens(this.systemTokens, false)
    }
    this.session.setChatHistory([{ type: 'system', text: SYSTEM_PROMPT }])
  }

  async translate(model: LlamaModel, src: string): Promise<{ text: string; tokens: number; ms: number }> {
    await this.rewind()
    const t0 = Date.now()
    const res = await this.session.promptWithMeta(buildPrompt(src), {
      maxTokens: 1024, temperature: 0.1, topK: 20, topP: 0.9
    })
    const ms = Date.now() - t0
    return { text: res.responseText.trim(), tokens: model.tokenize(res.responseText, false).length, ms }
  }
}

async function main(): Promise<void> {
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'poc', 'speed-v3', 'corpus.json'), 'utf8')) as { texts: string[] }
  const texts = corpus.texts.slice(0, limit)
  console.error(`[bench] device=${device} seq=${seqN} spec=${specOn ? 'on' : 'off'} threads=${threads} ctx=${ctxSize} fa=${faOn} main=${path.basename(mainPath)} n=${texts.length}`)

  const tLoad0 = Date.now()
  const { getLlama, DraftSequenceTokenPredictor } = await loadLlamaCpp()
  // gpu:false FORCES CPU. The default getLlama() is "auto" (would pick Vulkan)
  // AND loadModel's gpuLayers defaults to "auto" (would offload anyway).
  const llama: Llama = await getLlama(device === 'gpu' ? { gpu: 'vulkan' } : { gpu: false })
  const model: LlamaModel = await llama.loadModel({
    modelPath: mainPath,
    gpuLayers: device === 'gpu' ? ('max' as const) : 0
  })
  const ctx: LlamaContext = await model.createContext({
    contextSize: ctxSize, threads, sequences: seqN, ...(faOn ? { flashAttention: true } : {})
  })
  console.error(`[bench] loaded in ${((Date.now() - tLoad0) / 1000).toFixed(1)}s (backend=${llama.gpu ?? 'cpu'})`)

  let predictor: InstanceType<Awaited<ReturnType<typeof loadLlamaCpp>>['DraftSequenceTokenPredictor']> | null = null
  let draftModel: LlamaModel | null = null
  let draftCtx: LlamaContext | null = null
  if (specOn) {
    draftModel = await llama.loadModel({ modelPath: draftPath, ...(device === 'gpu' ? { gpuLayers: 'max' as const } : {}) })
    draftCtx = await draftModel.createContext({ contextSize: Math.max(ctxSize, 2048), threads: Math.max(2, Math.floor(threads / 2)) })
    predictor = new DraftSequenceTokenPredictor(draftCtx.getSequence(), { maxTokens: 16, minConfidence: 0.6 })
    console.error('[bench] draft predictor attached')
  }

  const lanes: Lane[] = []
  for (let i = 0; i < seqN; i++) lanes.push(await Lane.create(ctx, model, predictor ?? undefined))

  let next = 0
  const results: Array<{ i: number } & { text: string; tokens: number; ms: number }> = []
  const t0 = Date.now()
  const runWorker = async (lane: Lane): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= texts.length) return
      const r = await lane.translate(model, texts[i])
      results.push({ i, ...r })
      const done = results.length
      if (done % 10 === 0 || done === texts.length) {
        const el = (Date.now() - t0) / 1000
        const totTok = results.reduce((a, x) => a + x.tokens, 0)
        console.error(`[bench] ${done}/${texts.length} ${el.toFixed(0)}s ${(totTok / el).toFixed(1)} tok/s agg`)
      }
    }
  }
  await Promise.all(lanes.map((l) => runWorker(l)))
  const totalMs = Date.now() - t0

  let specStats: Record<string, number> | null = null
  if (specOn) {
    const s = lanes[0].session.sequence as unknown as { tokenPredictionStats?: Record<string, number> }
    specStats = s.tokenPredictionStats ?? null
  }

  const totalTokens = results.reduce((a, r) => a + r.tokens, 0)
  const lat = results.map((r) => r.ms).sort((a, b) => a - b)
  const summary = {
    device, seq: seqN, spec: specOn, fa: faOn, threads, ctx: ctxSize,
    main: path.basename(mainPath), system: systemKind,
    paragraphs: results.length,
    totalSec: +(totalMs / 1000).toFixed(1),
    genTokPerSecAgg: +(totalTokens / (totalMs / 1000)).toFixed(1),
    paraPerMin: +((results.length / totalMs) * 60000).toFixed(1),
    p50ParaMs: lat[Math.floor(lat.length / 2)] ?? 0,
    tokens: totalTokens,
    specStats
  }
  console.log(JSON.stringify(summary, null, 2))

  const tag = `${device}-seq${seqN}-spec${specOn ? 1 : 0}-${path.basename(mainPath, '.gguf')}${faOn ? '-fa' : ''}`
  results.sort((a, b) => a.i - b.i)
  fs.writeFileSync(
    path.join(ROOT, 'poc', 'speed-v3', `out-${tag}.txt`),
    results.map((r) => `### ${r.i}\nSRC: ${texts[r.i]}\nZH : ${r.text}\n`).join('\n')
  )

  for (const l of lanes) l.session.dispose()
  predictor?.dispose()
  await draftCtx?.dispose()
  await draftModel?.dispose()
  await ctx.dispose()
  await model.dispose()
  await llama.dispose()
}

main().catch((e) => { console.error(e); process.exit(1) })
