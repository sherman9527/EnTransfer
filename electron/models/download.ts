// Resumable HTTP/HTTPS model download with progress and cancellation.
//
// Uses the global fetch (Node >= 18) so redirects (ModelScope / hf-mirror both
// redirect to CDN hosts) are followed automatically. Resume is implemented via
// the HTTP `Range` header against a sidecar `<file>.part` file.
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { ModelInfo } from '../../shared/types'
import { getModelPath } from './registry.ts'

export interface DownloadProgress {
  /** bytes downloaded so far (including any resumed portion) */
  downloaded: number
  /** total expected bytes (best effort; 0 if unknown) */
  total: number
  /** average speed of this session, MB/s */
  speed: number
  /** 0 - 100 */
  percent: number
}

const MIN_VALID_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Rewrite a ModelScope download URL for the user's chosen mirror.
 * Currently supports hf-mirror.com (same org/repo/file layout, main branch).
 * Unknown mirror or non-ModelScope URLs pass through untouched.
 */
export function applyMirror(model: ModelInfo, mirror?: string): ModelInfo {
  if (!mirror || mirror === 'https://modelscope.cn') return model
  const m = /^https?:\/\/modelscope\.cn\/models\/(.+?)\/resolve\/master\/(.+)$/.exec(model.url)
  if (!m) return model
  const base = mirror.replace(/\/+$/, '')
  if (base === 'https://hf-mirror.com') {
    return { ...model, url: `${base}/${m[1]}/resolve/main/${m[2]}` }
  }
  return model
}

/**
 * Download a model to the local models directory. Supports resume via the
 * `Range` header, progress callbacks, and cancellation via `signal`.
 *
 * Resolves once the `.part` file is renamed to its final name and the size has
 * been sanity-checked. Rejects on network error, abort, or a truncated file.
 */
export async function downloadModel(
  model: ModelInfo,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const destPath = getModelPath(model.id)
  if (!destPath) throw new Error(`Unknown model id: ${model.id}`)

  await mkdir(dirname(destPath))

  // Already fully present? Skip download.
  if (existsSync(destPath) && statSync(destPath).size >= MIN_VALID_BYTES) {
    onProgress({
      downloaded: statSync(destPath).size,
      total: statSync(destPath).size,
      speed: 0,
      percent: 100
    })
    return
  }

  const tmpPath = destPath + '.part'
  let startByte = existsSync(tmpPath) ? statSync(tmpPath).size : 0

  const headers: Record<string, string> = {
    'User-Agent': 'EnTransfer/0.1 (model downloader)',
    Accept: 'application/octet-stream'
  }
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`

  const res = await fetch(model.url, { headers, redirect: 'follow', signal })

  // 206 = partial content (our Range honoured). 200 = server ignored Range.
  if (res.status === 200) startByte = 0
  else if (res.status !== 206) {
    throw new Error(`Download failed: HTTP ${res.status}`)
  }

  // Resolve total size.
  let total = 0
  const contentRange = res.headers.get('content-range') // e.g. "bytes 0-123/456"
  if (contentRange) {
    total = parseInt(contentRange.split('/')[1] ?? '0', 10) || 0
  }
  if (!total) {
    const len = parseInt(res.headers.get('content-length') ?? '0', 10)
    total = startByte > 0 ? startByte + len : len
  }

  const body = res.body
  if (!body) throw new Error('Download response had no body')

  const writeStream = createWriteStream(tmpPath, { flags: startByte > 0 ? 'a' : 'w' })
  let downloaded = startByte
  const sessionStart = Date.now()
  let sessionBytes = 0

  try {
    const reader = body.getReader()
    for (;;) {
      if (signal?.aborted) {
        const reason = signal.reason
        throw (reason instanceof Error ? reason : new Error('Download aborted'))
      }
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) {
        await writeChunk(writeStream, value)
        downloaded += value.length
        sessionBytes += value.length
        const elapsedSec = Math.max((Date.now() - sessionStart) / 1000, 0.1)
        const speed = sessionBytes / 1024 / 1024 / elapsedSec
        onProgress({
          downloaded,
          total,
          speed,
          percent: total > 0 ? Math.min(100, (downloaded / total) * 100) : 0
        })
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.close((err) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    // Best-effort cleanup of the write stream; keep the .part file for resume.
    writeStream.destroy()
    throw err
  }

  // Rename .part -> final and verify.
  renameSync(tmpPath, destPath)
  const finalSize = statSync(destPath).size
  if (finalSize < MIN_VALID_BYTES) {
    // A server error page saved as .gguf would otherwise linger and confuse
    // both the status probe and the next resume attempt — remove it.
    try { unlinkSync(destPath) } catch { /* best effort */ }
    throw new Error(`Downloaded file too small (${finalSize} bytes), likely truncated`)
  }
  onProgress({ downloaded: finalSize, total: finalSize, speed: 0, percent: 100 })
}

function mkdir(dir: string): Promise<void> {
  return new Promise((resolve) => {
    mkdirSync(dir, { recursive: true })
    resolve()
  })
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()))
  })
}
