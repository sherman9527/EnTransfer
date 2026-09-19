// electron/models/translation-cache.ts — content-addressed translation cache.
//
// Re-running a book after a layout/prompt-plumbing change must cost ZERO model
// time, and crash-resume must never re-translate units whose translation is
// already durable. Key = sha256(modelId | quant-label | promptVersion |
// temperature | sourceText | maskedText) so ANY input that can change the
// output invalidates the entry; a cache HIT is still re-validated by the
// caller's invariants (cache is not trusted, invariants are).
//
// On-disk layout: <root>/<hash[0:2]>/<hash>.json — sharded, diffable, and a
// user can delete the whole folder safely (pure derived data).
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

export interface CacheKey {
  modelId: string
  promptVersion: string
  temperature: number
  source: string
  masked: string
}

export interface CacheEntry {
  key: string
  translated: string
  tokens: number
  createdAt: number
}

export class TranslationCache {
  private readonly root: string
  private pending = new Map<string, Promise<void>>()
  private putSeq = 0

  constructor(root: string) {
    this.root = root
  }

  static hashKey(k: CacheKey): string {
    return createHash('sha256')
      .update(`${k.modelId}\u0000${k.promptVersion}\u0000${k.temperature}\u0000${k.source}\u0000${k.masked}`, 'utf8')
      .digest('hex')
  }

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash + '.json')
  }

  async get(hash: string): Promise<CacheEntry | null> {
    try {
      // Wait out any in-flight write of the same key (avoids read-after-write race).
      const w = this.pending.get(hash)
      if (w) await w
      const raw = await fsp.readFile(this.pathFor(hash), 'utf8')
      const e = JSON.parse(raw) as CacheEntry
      if (typeof e.translated !== 'string' || e.translated.length === 0) return null
      return e
    } catch {
      return null
    }
  }

  async put(hash: string, translated: string, tokens: number): Promise<void> {
    const entry: CacheEntry = { key: hash, translated, tokens, createdAt: Date.now() }
    const p = (async (): Promise<void> => {
      try {
        const file = this.pathFor(hash)
        await fsp.mkdir(dirname(file), { recursive: true })
        // unique tmp name: two concurrent writers of the same hash (resume +
        // fresh run) must not stomp on each other's temp file
        const tmp = `${file}.${process.pid}.${(this.putSeq += 1)}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(entry), 'utf8')
        await fsp.rename(tmp, file)
      } catch (err) {
        // cache write failure is never fatal, but must not be silent
        console.warn('[cache] put failed:', (err as Error).message)
      } finally {
        this.pending.delete(hash)
      }
    })()
    this.pending.set(hash, p)
    await p
  }

  /** Total cached entries (for reporting). */
  async size(): Promise<number> {
    let n = 0
    try {
      const shards = await fsp.readdir(this.root)
      for (const s of shards) {
        const files = await fsp.readdir(join(this.root, s))
        n += files.filter((f) => f.endsWith('.json')).length
      }
    } catch {
      /* empty */
    }
    return n
  }
}
