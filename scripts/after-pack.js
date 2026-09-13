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

  // --- 2. Drop node-llama-cpp source-build bundle --------------------------
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
}
