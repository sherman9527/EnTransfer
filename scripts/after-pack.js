/**
 * electron-builder afterPack hook.
 *
 * Goal: shrink the unpacked app before NSIS packs it into the installer.
 *  - Trim Electron locales down to zh-CN + en-US (55 locales ~= 40 MB).
 *  - Remove node-llama-cpp's gitRelease.bundle (a source-build packfile, ~33 MB,
 *    not needed at runtime because prebuilt win-x64 / vulkan binaries ship).
 */
const fs = require('node:fs')
const path = require('node:path')

const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak'])

// ggml-cpu ISA variants shipped by node-llama-cpp's Windows prebuilds. llama.cpp
// loads the best variant its runtime CPU check accepts, so we only need a
// ladder: baseline (works on every x86-64), an old-core tier, and tiers for
// current Intel/AMD. Anything else is ~2 MB of dead weight per file.
const KEEP_CPU_ISA = new Set(['x64', 'sse42', 'ivybridge', 'haswell', 'alderlake', 'zen4'])

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const log = (m) => console.log(`[after-pack] ${m}`)

  // --- 1. Trim locales -----------------------------------------------------
  const localesDir = path.join(appOutDir, 'locales')
  if (fs.existsSync(localesDir)) {
    let removed = 0
    let saved = 0
    for (const file of fs.readdirSync(localesDir)) {
      if (KEEP_LOCALES.has(file)) continue
      if (!file.endsWith('.pak')) continue
      const p = path.join(localesDir, file)
      try {
        const sz = fs.statSync(p).size
        fs.unlinkSync(p)
        removed++
        saved += sz
      } catch (e) {
        log(`could not remove locale ${file}: ${e.message}`)
      }
    }
    log(`locales: removed ${removed} files, saved ${(saved / 1024 / 1024).toFixed(1)} MB`)
  }

  // --- 2. Drop unused ggml-cpu ISA variants --------------------------------
  const binsRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@node-llama-cpp')
  if (fs.existsSync(binsRoot)) {
    for (const pkg of fs.readdirSync(binsRoot)) {
      if (!pkg.startsWith('win-x64')) continue // cpu + vulkan prebuilds
      const binsDir = path.join(binsRoot, pkg, 'bins')
      if (!fs.existsSync(binsDir)) continue
      for (const arch of fs.readdirSync(binsDir)) {
        const dir = path.join(binsDir, arch)
        let removed = 0
        let saved = 0
        for (const file of fs.readdirSync(dir)) {
          const m = /^ggml-cpu-(.+)\.dll$/.exec(file)
          if (!m || KEEP_CPU_ISA.has(m[1])) continue
          try {
            const p = path.join(dir, file)
            saved += fs.statSync(p).size
            fs.unlinkSync(p)
            removed++
          } catch (e) {
            log(`could not remove ${file}: ${e.message}`)
          }
        }
        if (removed > 0) log(`${pkg}: dropped ${removed} ggml-cpu ISA variants, saved ${(saved / 1024 / 1024).toFixed(1)} MB`)
      }
    }
  }

  // --- 3. Drop node-llama-cpp source-build bundle --------------------------
  const bundlePath = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-llama-cpp',
    'llama',
    'gitRelease.bundle'
  )
  if (fs.existsSync(bundlePath)) {
    try {
      const sz = fs.statSync(bundlePath).size
      fs.unlinkSync(bundlePath)
      log(`removed gitRelease.bundle, saved ${(sz / 1024 / 1024).toFixed(1)} MB`)
    } catch (e) {
      log(`could not remove gitRelease.bundle: ${e.message}`)
    }
  }

  // --- 4. Drop onnxruntime-node GPU EPs (CPU-only detector ships) -----------
  // The layout detector runs on the CPU EP; DirectML/dxcompiler/dxil (~36 MB)
  // are GPU execution providers we never load. onnxruntime.dll + binding.node
  // are the only win32/x64 files needed.
  const ortWin = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
    'win32',
    'x64'
  )
  const ORT_GPU_DROP = ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']
  if (fs.existsSync(ortWin)) {
    let saved = 0
    let removed = 0
    for (const f of ORT_GPU_DROP) {
      const p = path.join(ortWin, f)
      if (fs.existsSync(p)) {
        try {
          saved += fs.statSync(p).size
          fs.unlinkSync(p)
          removed++
        } catch (e) {
          log(`could not remove ${f}: ${e.message}`)
        }
      }
    }
    if (removed) log(`onnxruntime-node: dropped ${removed} GPU dlls, saved ${(saved / 1024 / 1024).toFixed(1)} MB`)
  }
}
