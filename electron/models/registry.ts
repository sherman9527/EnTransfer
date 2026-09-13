// Model registry: hardcoded catalogue of downloadable GGUF models and the
// on-disk layout used by the app. Status is derived from whether the model file
// already exists under the app models directory.
//
// After the 8-model benchmark (docs/MODEL-BENCHMARK.md) the project converged
// to a single model: Qwen3-1.7B Q4_K_M with thinking disabled. Only this one
// model ships / is listed; see docs/MODEL-BENCHMARK.md for the rationale.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { ModelInfo, ModelStatus } from '../../shared/types'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Built-in model catalogue (single converged model)
// ---------------------------------------------------------------------------
const MODEL_REGISTRY: ModelInfo[] = [
  {
    id: 'qwen3-1.7b-q4_k_m',
    name: 'Qwen3-1.7B Q4_K_M（推荐）',
    description: '横评综合最优：质量 4.9/5，GPU 70 tok/s，1.2GB。已自动关闭 thinking 推理以保证速度。',
    size: '1.2 GB',
    url: 'https://modelscope.cn/models/lmstudio-community/Qwen3-1.7B-GGUF/resolve/master/Qwen3-1.7B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    engine: 'llama.cpp',
    status: 'not-downloaded'
  }
]

/** Canonical id of the single shipped model. */
export const DEFAULT_MODEL_ID = 'qwen3-1.7b-q4_k_m'

/** Local GGUF filename per model id. */
const LOCAL_FILE_NAME: Record<string, string> = {
  'qwen3-1.7b-q4_k_m': 'Qwen3-1.7B-Q4_K_M.gguf'
}

// ---------------------------------------------------------------------------
// Models directory resolution — portable mode (requirement #20).
//   Electron dev:  <project>/models/
//   Electron packaged:  <exe_dir>/models/
//   Plain Node (tests):  <cwd>/models/
// ---------------------------------------------------------------------------
function resolveModelsDir(): string {
  const electronVer = (process.versions as Record<string, string | undefined>).electron
  if (electronVer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    const root = app.isPackaged ? require('node:path').dirname(app.getPath('exe')) : process.cwd()
    return join(root, 'models')
  }
  return join(process.cwd(), 'models')
}

let cachedModelsDir: string | null = null

export function getModelsDir(): string {
  if (!cachedModelsDir) cachedModelsDir = resolveModelsDir()
  return cachedModelsDir
}

/** Absolute path to the model file on disk, or null if unknown id. */
export function getModelPath(id: string): string | null {
  const fileName = LOCAL_FILE_NAME[id]
  if (!fileName) return null
  return join(getModelsDir(), fileName)
}

/** Raw catalogue entry (without live status). */
export function getModelInfo(id: string): ModelInfo | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id)
}

/** Bytes considered "present enough" to count as a downloaded model. */
const MIN_VALID_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Return the catalogue with live status. `available` means the GGUF file exists
 * and is non-trivially sized on disk; `downloading` status is injected by the
 * ModelManager while a download task is in flight.
 */
export function getModels(runtimeStatus?: Record<string, ModelStatus>): ModelInfo[] {
  return MODEL_REGISTRY.map((entry) => {
    const status = runtimeStatus?.[entry.id] ?? detectLocalStatus(entry.id)
    return { ...entry, status }
  })
}

function detectLocalStatus(id: string): ModelStatus {
  const p = getModelPath(id)
  if (!p) return 'not-downloaded'
  try {
    if (existsSync(p) && statSync(p).size >= MIN_VALID_BYTES) return 'available'
  } catch {
    // fall through
  }
  return 'not-downloaded'
}
