// electron/models/engine-errors.ts — inference-failure classification shared by
// the engine (sick marking) and the regression suite.
//
// A mid-generation failure only justifies a GPU→CPU failover when it looks like
// the DEVICE died (Vulkan device lost, VRAM OOM, driver error). One-off bad
// generations must not permanently demote the session to CPU (bug 2026-09-19
// R6: any non-abort error set sick → sticky CPU even for transient failures).

const HARDWARE_ERROR_RE =
  /device\s*lost|vk_error|vulkan|out of memory|oom|allocation.*(fail|error)|cu(da|arses)?\s*error|ggml_(vk|cuda)|no (valid\s+)?device/i

/** True when an engine error message indicates the device/runtime died. */
export function isHardwareError(message: string): boolean {
  return HARDWARE_ERROR_RE.test(message)
}

/** Consecutive non-abort failures after which an engine is declared sick even
 *  without a recognised message (unknown device-lost spellings). */
export const SICK_ESCALATION_ERRORS = 3
