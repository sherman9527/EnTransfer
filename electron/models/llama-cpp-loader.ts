// llama-cpp-loader.ts — Lazy dynamic import of node-llama-cpp (ESM-only package).
//
// node-llama-cpp v3 is ESM-only ("type": "module", no "require" export condition).
// When the Electron main process is built as CJS, a static `require('node-llama-cpp')`
// fails with ERR_REQUIRE_ESM. This loader caches a single dynamic import() and is
// awaited at first use (inside async load/detect methods).

let modulePromise: Promise<typeof import('node-llama-cpp')> | null = null

/** Returns the cached node-llama-cpp module (imported once on first call). */
export function loadLlamaCpp(): Promise<typeof import('node-llama-cpp')> {
  if (!modulePromise) {
    modulePromise = import('node-llama-cpp')
  }
  return modulePromise
}
