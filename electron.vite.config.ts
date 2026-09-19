import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite builds three tiers: main (electron/), preload (electron/), renderer (renderer/).
// Local cross-process types live in shared/ and are imported (type-only) by both tiers.
export default defineConfig({
  main: {
    // No externalizeDepsPlugin: bundle all pure-JS deps (pdfjs-dist, pdf-lib,
    // fontkit) into the output to avoid runtime require() of ESM modules.
    // node-llama-cpp is loaded via dynamic import() and stays external.
    resolve: {
      alias: {
        // pdfjs-dist optionally requires `canvas` for pixel rendering (unused).
        // Stub it to avoid a top-level require() of an uninstalled native module.
        canvas: resolve(__dirname, 'electron/canvas-stub.js')
      }
    },
    build: {
      sourcemap: false,
      lib: {
        entry: resolve(__dirname, 'electron/main.ts')
      },
      rollupOptions: {
        // Bundle pure-JS deps (pdfjs-dist, pdf-lib, fontkit) into output to
        // avoid runtime require() of ESM modules. Externalize node-llama-cpp
        // (ESM-only + native .node bindings, loaded via dynamic import()) and
        // electron/node builtins.
        external: [
          /^node:/,
          'electron',
          'node-llama-cpp',
          /^@node-llama-cpp\//,
          'onnxruntime-node',
          '@napi-rs/canvas'
        ],
        output: {
          entryFileNames: 'index.js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts')
      },
      rollupOptions: {
        output: {
          entryFileNames: 'index.js'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    // Relative base so asset URLs (./icon.png) resolve correctly under
    // Electron's file:// protocol (absolute /icon.png would hit filesystem root).
    base: './',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
