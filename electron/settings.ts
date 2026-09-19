// electron/settings.ts — persistent AppSettings store (JSON on disk).
//
// Single source of truth for user preferences, replacing the old in-memory
// mock. Writes are atomic (tmp→rename) and synchronous: settings change only
// on explicit user actions (a few per session), so durability-per-write beats
// debouncing. Layout lives next to jobs/models in the portable data root.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'

export function defaultSettings(defaultOutputDir: string): AppSettings {
  return {
    defaultModel: 'qwen3-1.7b-q4_k_m',
    outputDir: defaultOutputDir,
    mirrorSource: 'https://modelscope.cn',
    cpuThreads: 8,
    device: 'auto',
    threadsMode: 'auto',
    manualThreads: 12
  }
}

const KNOWN_KEYS: (keyof AppSettings)[] = [
  'defaultModel', 'outputDir', 'mirrorSource', 'cpuThreads', 'device', 'threadsMode', 'manualThreads'
]

export class SettingsStore {
  private readonly file: string
  private state: AppSettings

  constructor(file: string, initial: AppSettings) {
    this.file = file
    this.state = initial
  }

  /** Read settings.json over the defaults. Missing/corrupt file → defaults (never throws). */
  load(): AppSettings {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const rec = this.state as unknown as Record<string, unknown>
        for (const k of KNOWN_KEYS) {
          if (parsed[k] !== undefined) rec[k] = parsed[k]
        }
      }
    } catch {
      // first run or unreadable file — keep defaults
    }
    return this.state
  }

  get current(): AppSettings {
    return this.state
  }

  /** Merge a whitelisted patch and persist atomically. Returns the new full snapshot. */
  set(patch: Partial<AppSettings>): AppSettings {
    const clean: Partial<AppSettings> = {}
    for (const k of KNOWN_KEYS) {
      if ((patch as Record<string, unknown>)[k] !== undefined) {
        (clean as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k]
      }
    }
    this.state = { ...this.state, ...clean }
    this.save()
    return this.state
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // Settings persistence is best-effort: a read-only data dir must never
      // break the app; in-memory state still holds for this session.
    }
  }

  /** True when the file already existed (diagnostics/tests). */
  get persisted(): boolean {
    return existsSync(this.file)
  }
}

export const settingsFileFor = (dataRoot: string): string => join(dataRoot, 'settings.json')
