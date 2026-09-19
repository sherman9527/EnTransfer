// gpu.ts — GPU detection and device selection for Vulkan acceleration.
//
// This module is independent of llama-engine.ts (which another agent is
// optimizing for CPU). It provides:
//   - detectGpu(): probe whether a Vulkan GPU is available
//   - resolveGpuLayers(): translate the user's device preference into a
//     gpuLayers value suitable for llama.loadModel()
//
// Design decisions:
//   - Vulkan-only: works on NVIDIA, AMD, Intel iGPUs. No CUDA toolkit needed.
//   - Detection is defensive: any failure -> { type: null } -> CPU fallback.
//   - We never throw from detectGpu(); callers decide what to do.

import { loadLlamaCpp } from './llama-cpp-loader.ts'

export type GpuBackend = 'vulkan'

export interface GpuInfo {
  /** Detected GPU backend, or null if no GPU acceleration is available. */
  type: GpuBackend | null
  /** Total VRAM in MB (from llama.cpp's VRAM query). */
  vramMB?: number
  /** Free VRAM in MB at detection time. */
  vramFreeMB?: number
  /** Human-readable GPU device name, e.g. "NVIDIA GeForce GTX 1060 6GB". */
  name?: string
}

/** User-facing device preference. */
export type DevicePreference = 'auto' | 'cpu' | 'gpu'

/**
 * Attempt to detect a Vulkan-capable GPU.
 *
 * Strategy:
 *   1. Call getLlama({ gpu: 'vulkan' }) — this loads the Vulkan backend.
 *   2. If llama.gpu === 'vulkan' and supportsGpuOffloading is true, query
 *      VRAM state and device names.
 *   3. Dispose the temporary llama instance.
 *   4. On any error, return { type: null }.
 *
 * NOTE: This creates a short-lived llama instance purely for probing.
 * It should be called once at app startup, not on every translation.
 */
export async function detectGpu(): Promise<GpuInfo> {
  try {
    const { getLlama } = await loadLlamaCpp()
    const llama = await getLlama({ gpu: 'vulkan' })

    // The backend loaded but may still be CPU-only if the Vulkan loader
    // couldn't find any physical device.
    if (llama.gpu !== 'vulkan' || !llama.supportsGpuOffloading) {
      await llama.dispose().catch(() => { /* ignore */ })
      return { type: null }
    }

    const vram = await llama.getVramState()
    const devices = await llama.getGpuDeviceNames()
    const name = devices.length > 0 ? devices[0] : undefined

    const info: GpuInfo = {
      type: 'vulkan',
      vramMB: Math.round(vram.total / 1024 / 1024),
      vramFreeMB: Math.round(vram.free / 1024 / 1024),
      name
    }

    // Dispose the probe instance so it doesn't hold VRAM.
    await llama.dispose().catch(() => { /* ignore */ })
    return info
  } catch {
    return { type: null }
  }
}

/**
 * Resolve the gpuLayers value to pass to llama.loadModel() based on the
 * user's device preference and the detected GPU.
 *
 *   - 'auto': use GPU if available, otherwise CPU.
 *   - 'cpu': force CPU (gpuLayers=0).
 *   - 'gpu': force GPU. If no GPU is detected, fall back to CPU (0) rather
 *     than throwing — the app should still work, just slower.
 *
 * Returns either a layer count (0 for CPU) or the string "max" (all layers
 * offloaded to GPU).
 */
export function resolveGpuLayers(
  device: DevicePreference,
  gpu: GpuInfo | null
): number | 'max' {
  if (device === 'cpu') return 0
  if (device === 'gpu') {
    return gpu?.type === 'vulkan' ? 'max' : 0
  }
  // 'auto'
  return gpu?.type === 'vulkan' ? 'max' : 0
}
