import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite builds three tiers: main (electron/), preload (electron/), renderer (renderer/).
// Local cross-process types live in shared/ and are imported (type-only) by both tiers.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      lib: {
        entry: resolve(__dirname, 'electron/main.ts')
      },
      rollupOptions: {
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
