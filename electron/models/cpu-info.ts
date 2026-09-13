// cpu-info.ts — runtime CPU detection & smart inference-thread selection.
//
// Rationale: llama.cpp inference on a modern CPU is memory-bandwidth bound, so
// throwing every logical thread (incl. Hyper-Threading siblings and E-cores) at
// it usually hurts more than it helps. The right default is:
//   * Intel hybrid (12th Gen+ / Core Ultra): P-cores only, WITH their HT siblings.
//   * Non-hybrid big-core CPU: physical cores (skip HT siblings).
//   * ARM (Apple Silicon / Snapdragon): performance cores.
//
// Physical-core count is read from WMI on Windows; elsewhere (or on failure)
// it is estimated from the logical count. Pure heuristics live in buildCpuInfo()
// so they can be unit-tested without touching the OS.
import os from 'node:os'
import { execSync } from 'node:child_process'

export interface CpuInfo {
  /** Raw model string, e.g. "12th Gen Intel(R) Core(TM) i5-12600KF". */
  model: string
  /** Physical (permanent) cores. P+E combined on hybrid chips. */
  physicalCores: number
  /** Logical processors (os.cpus().length). */
  logicalCores: number
  /** True on Intel P+E hybrid (or ARM big.LITTLE) layouts. */
  isHybrid: boolean
  /** Performance-core count (P-cores on Intel, big-cores on ARM). */
  performanceCores: number
  architecture: 'x64' | 'arm64' | 'unknown'
  /** How physicalCores was obtained: WMI query vs. estimate. */
  physicalSource: 'wmi' | 'estimate'
}

// ---------------------------------------------------------------------------
// Architecture mapping (process.arch → our 3-way bucket)
// ---------------------------------------------------------------------------
function detectArchitecture(): CpuInfo['architecture'] {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Physical-core detection
// ---------------------------------------------------------------------------
interface PhysicalCores {
  physicalCores: number
  source: 'wmi' | 'estimate'
}

/**
 * Query Windows WMI for the real physical core count. On non-Windows hosts or
 * when the query fails, estimate physicalCores ≈ logical/2 (assume SMT/HT).
 */
function detectPhysicalCores(logicalCores: number): PhysicalCores {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json"',
        { timeout: 5000, windowsHide: true }
      ).toString()
      const parsed: unknown = JSON.parse(out)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      const physical = arr.reduce(
        (sum, row) => sum + Number((row as Record<string, unknown>).NumberOfCores ?? 0),
        0
      )
      if (physical > 0) return { physicalCores: physical, source: 'wmi' }
    } catch {
      // WMI unavailable (locked-down box / old PowerShell) — fall through.
    }
  }
  // Estimate: assume Hyper-Threading/SMT, except when logical count is odd.
  const physical = logicalCores % 2 === 1 ? logicalCores : Math.round(logicalCores / 2)
  return { physicalCores: physical, source: 'estimate' }
}

// ---------------------------------------------------------------------------
// Intel hybrid-generation / P-core heuristics
// ---------------------------------------------------------------------------
/** Matches Intel 12th–15th Gen and Core Ultra (Meteor Lake / Arrow Lake). */
const HYBRID_GEN_RE = /(?:1[2345]th|15th)[\s-]?Gen|Core Ultra/i

/**
 * Known desktop SKU → performance-core (P) count. Keyed by the 4-digit product
 * number in the marketing string (e.g. "12600" → i5-12600K/KF = 6P).
 *
 * Only the K-series desktop parts are encoded; anything not listed falls back
 * to physicalCores (conservative: assume every core is a performance core).
 */
const PCORE_BY_SKU: Record<string, number> = {
  // 12th Gen (Alder Lake)
  '12600': 6, // i5-12600K/KF (6P+4E)
  '12700': 8, // i7-12700K/KF (8P+8E)
  '12900': 8, // i9-12900K/KF (8P+8E)
  // 13th Gen (Raptor Lake)
  '13600': 6, // i5-13600K/KF (6P+8E)
  '13700': 8, // i7-13700K/KF (8P+8E)
  '13900': 8, // i9-13900K/KF (8P+16E)
  // 14th Gen (Raptor Lake Refresh)
  '14600': 6, // i5-14600K/KF (6P+8E)
  '14700': 8, // i7-14700K/KF (8P+12E)
  '14900': 8 // i9-14900K/KF (8P+16E)
}

/** Extract the 4–5 digit SKU from an Intel marketing string, if present. */
function matchIntelSku(model: string): string | null {
  const m = model.match(/i[3579]-?(\d{4,5})/i)
  return m ? m[1] : null
}

/**
 * Estimate the performance-core (P) count for a hybrid chip.
 *
 * Falls back to `physicalCores` when the SKU is unknown — safe because llama.cpp
 * only benefits from excluding E-cores; over-counting P-cores just means we may
 * schedule onto an E-core, which never crashes and only slightly slows down.
 */
function estimatePerformanceCores(model: string, physicalCores: number): number {
  const sku = matchIntelSku(model)
  if (sku) {
    const p = PCORE_BY_SKU[sku]
    if (p && p <= physicalCores) return p
  }
  return physicalCores
}

// ---------------------------------------------------------------------------
// Pure builder — split out so heuristics are unit-testable (see tests/)
// ---------------------------------------------------------------------------
export function buildCpuInfo(
  model: string,
  logicalCores: number,
  physicalCores: number,
  architecture: CpuInfo['architecture'],
  physicalSource: CpuInfo['physicalSource'] = 'estimate'
): CpuInfo {
  const genHybrid = HYBRID_GEN_RE.test(model)
  // Structural E-core signal: a hybrid chip has SOME hyperthreaded (P) and
  // some not (E) cores, so logical/physical sits strictly between 1 and 2.
  //   * pure HT chip : logical == 2*physical  → ratio exactly 2 (excluded)
  //   * pure no-HT   : logical ==  physical    → ratio exactly 1 (excluded)
  //   * hybrid       : 1 < ratio < 2           → detected
  const structuralHybrid = logicalCores > physicalCores && logicalCores < physicalCores * 2
  // Fallback ONLY when real physical-core info is unavailable (WMI failed and
  // physicalCores was estimated as logical/2, which erases the structural
  // signal). A known hybrid generation with >half-physical logical count is
  // assumed hybrid. This must NOT run off WMI data, else non-hybrid 12th-gen
  // parts like the i5-12400 (6P, 12 logical) would be false-positived.
  const estimateFallbackHybrid =
    physicalSource === 'estimate' && genHybrid && logicalCores > physicalCores * 1.5

  const isHybrid = structuralHybrid || estimateFallbackHybrid
  const performanceCores = isHybrid
    ? estimatePerformanceCores(model, physicalCores)
    : physicalCores

  return {
    model,
    physicalCores,
    logicalCores,
    isHybrid,
    performanceCores,
    architecture,
    physicalSource
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Detect the CPU on the current machine. Cheap; safe to call once at startup. */
export function detectCpu(): CpuInfo {
  const logicalCores = Math.max(1, os.cpus().length)
  const model = os.cpus()[0]?.model?.trim() ?? 'Unknown CPU'
  const architecture = detectArchitecture()
  const { physicalCores, source } = detectPhysicalCores(logicalCores)
  return buildCpuInfo(model, logicalCores, physicalCores, architecture, source)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/**
 * Smart default thread count for llama.cpp inference.
 *
 *   hybrid (P+E)        → P-cores × 2 (HT), capped at logicalCores
 *   non-hybrid big-core → physicalCores (skip HT siblings: bandwidth-bound)
 *   ARM                 → performanceCores (big cores)
 *   unknown arch        → max(2, logicalCores - 1)
 *
 * Floor is 2 threads; ceiling is always the logical-core count.
 */
export function getDefaultThreads(cpu: CpuInfo): number {
  if (cpu.isHybrid) {
    return clamp(cpu.performanceCores * 2, 2, cpu.logicalCores)
  }
  if (cpu.architecture === 'unknown') {
    return clamp(cpu.logicalCores - 1, 2, cpu.logicalCores)
  }
  // x64 non-hybrid + ARM both map to the physical / performance core count.
  return clamp(cpu.performanceCores, 2, cpu.logicalCores)
}

/** Short, friendly product name, e.g. "Intel i5-12600KF" or "AMD Ryzen 7". */
export function shortCpuName(model: string): string {
  const clean = model.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' ').trim()
  const token = clean.match(/i[3579]-?\d{4,5}[a-z]*/i)
  if (token) {
    const brand = /AMD/i.test(clean) ? 'AMD' : /Apple/i.test(clean) ? 'Apple' : 'Intel'
    return `${brand} ${token[0]}`
  }
  const ultra = clean.match(/Core Ultra\s*\d+.*$/i)
  if (ultra) return `Intel ${ultra[0].replace(/\s+/g, ' ').trim()}`
  const ryzen = clean.match(/Ryzen\s*\d.*$/i)
  if (ryzen) return `AMD ${ryzen[0].replace(/\s+/g, ' ').trim()}`
  return clean
}

/** Human-readable summary, e.g. "Intel i5-12600KF（6P+4E，16逻辑核）". */
export function describeCpu(cpu: CpuInfo): string {
  const name = shortCpuName(cpu.model)
  if (cpu.isHybrid) {
    const e = cpu.physicalCores - cpu.performanceCores
    const ePart = e > 0 ? `+${e}E` : ''
    return `${name}（${cpu.performanceCores}P${ePart}，${cpu.logicalCores}逻辑核）`
  }
  return `${name}（${cpu.physicalCores}核，${cpu.logicalCores}逻辑核）`
}
