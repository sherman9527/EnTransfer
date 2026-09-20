#!/usr/bin/env node
/**
 * scripts/verify-build.js — 防回归自动化检查
 *
 * 在 npm run build 之后、electron-builder 打包之前运行，
 * 自动检查所有已知的打包后运行时问题是否被重新引入。
 *
 * 用法：
 *   node scripts/verify-build.js          # 检查构建产物
 *   node scripts/verify-build.js --asar   # 同时检查 asar 内容（需先打包）
 *
 * 退出码：0 = 全部通过，1 = 有失败项
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath))
}

function readText(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

console.log('╔══════════════════════════════════════════════╗')
console.log('║  EnTransfer Build Verification (防回归检查)   ║')
console.log('╚══════════════════════════════════════════════╝')

// ── 1. package.json 检查 ──────────────────────────────
console.log('\n[1] package.json')
const pkgPath = path.join(ROOT, 'package.json')
const pkgBytes = fs.readFileSync(pkgPath)
const hasBOM = pkgBytes[0] === 0xef && pkgBytes[1] === 0xbb && pkgBytes[2] === 0xbf
check('package.json 无 BOM', !hasBOM, hasBOM ? '前3字节是 EF BB BF' : '')

const pkg = JSON.parse(pkgBytes.toString('utf8'))
check('有 postbuild 脚本', !!pkg.scripts?.postbuild, '缺少 postbuild')
check('postbuild 包含 copy-pdf-worker', pkg.scripts?.postbuild?.includes('copy-pdf-worker') ?? false)

// ── 2. 构建产物检查 ───────────────────────────────────
console.log('\n[2] 构建产物 (out/)')
check('out/main/pdf.worker.js 存在', fileExists('out/main/pdf.worker.js'))
if (fileExists('out/main/pdf.worker.js')) {
  const size = fs.statSync(path.join(ROOT, 'out/main/pdf.worker.js')).size
  check('pdf.worker.js > 1MB', size > 1024 * 1024, `实际 ${(size / 1024 / 1024).toFixed(1)}MB`)
}
check('out/renderer/icon.png 存在', fileExists('out/renderer/icon.png'))
check('out/renderer/index.html 存在', fileExists('out/renderer/index.html'))

// ── 3. 源码静态检查（防止回归） ────────────────────────
console.log('\n[3] 源码静态检查')

// 3a. NavRail logo 路径
if (fileExists('renderer/src/components/NavRail.tsx')) {
  const navRail = readText('renderer/src/components/NavRail.tsx')
  check('NavRail logo 用相对路径 ./icon.png', navRail.includes('./icon.png'), '发现绝对路径或缺失')
  check('NavRail 没有 /icon.png 绝对路径', !navRail.includes('src="/icon.png"'), '发现 /icon.png')
  check('NavRail 没有红色 E 占位', !navRail.includes('bg-accent') || !navRail.includes('>E<'), '发现红色E占位logo')
}

// 3b. pipeline.ts 字体路径
if (fileExists('electron/pipeline.ts')) {
  const pipeline = readText('electron/pipeline.ts')
  check('pipeline.ts 用 app.getAppPath()', pipeline.includes('app.getAppPath()') || pipeline.includes('getAppPath'), '仍用 process.resourcesPath')
  check('pipeline.ts 没有 process.resourcesPath', !pipeline.includes('process.resourcesPath'), '发现 process.resourcesPath')
  check('pipeline.ts 导入了 app', pipeline.includes("from 'electron'") && pipeline.includes('app'), '未导入 electron app')
}

// 3c. typeset/flow.ts 字体路径
if (fileExists('electron/pdf/typeset/flow.ts')) {
  const flow = readText('electron/pdf/typeset/flow.ts')
  check('typeset/flow.ts 从 fontPath 目录推导 fontsDir', flow.includes('path.dirname(regularPath)'), '仍用 process.cwd()')
  // 只检查 process.cwd() 作为主路径赋值（如 const fontsDir = path.resolve(process.cwd(), ...)）
  // 允许在 ?? fallback 中使用（如 options.fontPath ?? path.resolve(process.cwd(), ...)）
  const primaryCwdMatch = flow.match(/=\s*path\.resolve\(process\.cwd\(\)/)
  const fallbackCwdMatch = flow.match(/\?\?\s*path\.resolve\(process\.cwd\(\)/)
  check('typeset/flow.ts 没有 process.cwd() 主路径赋值', !primaryCwdMatch || !!fallbackCwdMatch, primaryCwdMatch && !fallbackCwdMatch ? '发现 process.cwd() 主路径赋值' : '')
}

// 3d. vite 配置
if (fileExists('electron.vite.config.ts')) {
  const viteConfig = readText('electron.vite.config.ts')
  check('vite renderer 有 base: ./', viteConfig.includes("base: './'") || viteConfig.includes('base:"./"'), '缺少 base 配置')
}

// 3e. pdf.worker workerSrc 设置
if (fileExists('electron/pdf/capture/flow.ts')) {
  const captureFlow = readText('electron/pdf/capture/flow.ts')
  check('capture/flow.ts 设置了 GlobalWorkerOptions.workerSrc', captureFlow.includes('GlobalWorkerOptions.workerSrc'), '缺少 workerSrc 设置')
}

// 3e-2. 便携化 / 卸载零残留（回归防线）
{
  const main = fileExists('electron/main.ts') ? readText('electron/main.ts') : ''
  check('main.ts 将 userData 重定向到可移植 data 目录', main.includes("app.setPath('userData'"), 'userData 仍在 %APPDATA%，卸载会残留')
  const print = fileExists('electron/pdf/typeset/chromiumPrint.ts') ? readText('electron/pdf/typeset/chromiumPrint.ts') : ''
  check('chromiumPrint 中间 HTML 可传入 workTmpDir', print.includes('workTmpDir'), '临时文件写死系统 tmp，未跟随安装目录')
  const pipeline = fileExists('electron/pipeline.ts') ? readText('electron/pipeline.ts') : ''
  check('pipeline 打印时传 data/tmp 目录', /printHtmlToPdf\([^)]*'tmp'\)/.test(pipeline) || pipeline.includes("join(jobsDir, '..', 'tmp')"), '未把可移植 tmp 传给 printHtmlToPdf')
  const pkg = fileExists('package.json') ? readText('package.json') : ''
  check('nsis.deleteAppDataOnUninstall=true', pkg.includes('"deleteAppDataOnUninstall": true') || pkg.includes('"deleteAppDataOnUninstall":true'), '卸载不清 appData')
  check('nsis.include 指向 uninstaller.nsh', pkg.includes('build/uninstaller.nsh'), '缺少自定义卸载钩子')
  const nsh = fileExists('build/uninstaller.nsh') ? readText('build/uninstaller.nsh') : ''
  check('uninstaller.nsh 删 $INSTDIR\\models', nsh.includes('$INSTDIR\\models') || nsh.includes('$INSTDIR\\Models'), '未删运行期模型目录')
  check('uninstaller.nsh 删 $INSTDIR\\data', nsh.includes('$INSTDIR\\data'), '未删运行期数据目录')
  // R13: differentialPackage 会把整个安装器(≈120MB)复制到 %LOCALAPPDATA%\<name>-updater，
  // 卸载器不清理 → 静默大残留。项目无自动更新，必须保持 false。
  check('nsis.differentialPackage=false (R13)', pkg.includes('"differentialPackage": false') || pkg.includes('"differentialPackage":false'), '安装器会复制自身到 LOCALAPPDATA entransfer-updater，卸载残留 ~120MB')
  // R13b: assisted(oneClick:false) 安装器无视配置仍会复制自身，卸载钩子必须兜底删除。
  check('uninstaller.nsh 删 $LOCALAPPDATA\\entransfer-updater (R13b)', nsh.includes('entransfer-updater'), 'assisted 安装器自缓存目录未兜底清理')
}

// 3f. node-llama-cpp 没有静态 require
const allSourceFiles = []
function walkDir(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDir(full)
    else if (/\.(ts|js|mjs)$/.test(entry.name)) allSourceFiles.push(full)
  }
}
walkDir(path.join(ROOT, 'electron'))
let staticLlamaImport = false
for (const f of allSourceFiles) {
  let content = fs.readFileSync(f, 'utf8')
  // 移除块注释和行注释（注释中可能包含 require('node-llama-cpp') 字符串）
  content = content.replace(/\/\*[\s\S]*?\*\//g, '')
  content = content.replace(/\/\/[^\n]*/g, '')
  // 移除所有 type-only import 块（多行，从 import type 到 from 'node-llama-cpp'）
  // type import 在编译后被擦除，不产生运行时 require
  content = content.replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"]node-llama-cpp['"]\s*;?/g, '')
  if (content.includes("require('node-llama-cpp')") || content.includes('require("node-llama-cpp")')) {
    staticLlamaImport = true
    console.log(`    ↳ 静态 require 发现于: ${path.relative(ROOT, f)}`)
    break
  }
  // 检查是否还有非 type 的静态 import from 'node-llama-cpp'
  const remainingImport = content.match(/import\s+(?!type)[^;]*from\s+['"]node-llama-cpp['"]/)
  if (remainingImport && !f.includes('llama-cpp-loader')) {
    staticLlamaImport = true
    console.log(`    ↳ 静态 import 发现于: ${path.relative(ROOT, f)}`)
    break
  }
}
check('没有静态 require/import node-llama-cpp', !staticLlamaImport, '发现静态导入，应通过 llama-cpp-loader 动态 import')

// ── 3g. 回归结构不变式（对应 docs/REGRESSION.md 的 R 编号）──
{
  const pipe = readText('electron/pipeline.ts')
  check('R3 熔断 throw 位于 quality-report 写入之后', pipe.indexOf('quality-report.jsonl') !== -1 && pipe.indexOf('quality-report.jsonl') < pipe.indexOf('if (breakerMsg !== null) throw'), '顺序被改动：熔断将跳过质量报告')
  check('R1 批解析走 splitBatch（拒空槽）', pipe.includes('splitBatch(res.text'), '批分割未用受测试的 splitBatch')
  check('R2 缓存键使用引擎真实温度', pipe.includes('temperature: engine.temperature'), '缓存温度键疑似写死')
  const eng = readText('electron/models/llama-engine.ts')
  check('R5 dispose 等待异步释放', eng.includes('await Promise.allSettled'), 'dispose 未 await，重建时可能双份显存')
  const mgr = readText('electron/models/engine-manager.ts')
  check('R10 sick 重建有次数上限', mgr.includes('sickRebuilds > 3'), '缺少重建上限，故障引擎会无限重载')
  const print = readText('electron/pdf/typeset/chromiumPrint.ts')
  check('R11 打印前等 fonts/图片解码而非固定 sleep', print.includes('document.fonts.ready') && !print.includes('setTimeout(r, 500'), '固定 500ms 等待回归')
  const html = readText('electron/pdf/typeset/htmlFlow.ts')
  check('R12 data URI 覆盖 webp/gif MIME', html.includes('image/webp') && html.includes('image/gif'), '图片格式映射缺项')
  // R16: pdf-lib fallback code blocks must draw with the mono font they were measured with.
  const tflow = readText('electron/pdf/typeset/flow.ts')
  check('R16 代码块用 mono 字体绘制（与测量一致）', tflow.includes('rgb(0.15, 0.15, 0.15), false, true)'), '代码回退绘制未传 mono，测量/渲染字体不一致会错位')
  // C1: layout pass must run detection BEFORE prose assembly (protect tables) and gate on ink.
  const cap = readText('electron/pdf/capture/flow.ts')
  check('C1 表格检测在区域文本过滤之前', cap.indexOf('detectTables(bodyLines)') < cap.indexOf('!lineInRegion(l, regionsByPage)'), '顺序颠倒会重蹈 9→8 表格回归')
  check('C1 保守门按 ink 上限过滤', cap.includes('FIGURE_MAX_INK_PCT'), '缺少低-ink 保守门，会误栅格化密集表/图')
  // E2E code/console/JSON handling wiring (regression guards — logic is in line-utils, tested by R21-R23)
  const lineUtils = readText('electron/pdf/capture/line-utils.ts')
  check('代码检测集中在 line-utils.looksLikeCode', lineUtils.includes('export function looksLikeCode') && cap.includes('looksLikeCode('), '代码判定被打散/未接线，控制台块会退回被翻译')
  check('detectTables 按代码字体排除', cap.includes('codeFonts.has(l.fontName)'), 'JSON/控制台 dump 会被误判成表格（塌陷回归）')
  check('段落合并用 joinLines 去连字符', cap.includes('joinLines(cur.texts)'), '软连字符不再合并，"com- monly" 回归')
  check('代码行各自成段（保留换行）', cap.includes('codeLine'), '控制台块丢换行 → 挤成一坨回归')
  const pipeSrc = readText('electron/pipeline.ts')
  check('writeBack 剥离"译文："回显', pipeSrc.includes('cleanTranslation('), '模型回显的"译文："标签会漏进正文')
  check('JPX/未提取图片走 renderClip 栅格化', cap.includes('rasterizePlacements(') && cap.includes('matchedSet.has(p)'), 'JPEG2000 图片会被静默丢弃（缺图回归）')
}

// ── 4. 资源文件检查 ───────────────────────────────────
console.log('\n[4] 资源文件 (assets/)')
check('assets/fonts/MicrosoftYaHei-Regular-subset.ttf', fileExists('assets/fonts/MicrosoftYaHei-Regular-subset.ttf'))
check('assets/fonts/MicrosoftYaHei-Bold-subset.ttf', fileExists('assets/fonts/MicrosoftYaHei-Bold-subset.ttf'))
check('assets/fonts/Consolas-subset.ttf', fileExists('assets/fonts/Consolas-subset.ttf'))
check('assets/icon.png', fileExists('assets/icon.png'))
check('assets/icon.ico', fileExists('assets/icon.ico'))
check('build/icon.ico (electron-builder 默认位置)', fileExists('build/icon.ico'))

// ── 5. asar 内容检查（可选，需先打包） ─────────────────
if (process.argv.includes('--asar')) {
  console.log('\n[5] asar 内容检查 (release/win-unpacked/)')
  const asarPath = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar')
  if (fs.existsSync(asarPath)) {
    // 用 asar CLI 列出内容
    const { execSync } = require('node:child_process')
    try {
      const asarList = execSync(`npx asar list "${asarPath}"`, { encoding: 'utf8', timeout: 30000 })
      check('asar 包含 /out/main/pdf.worker.js', asarList.includes('out\\main\\pdf.worker.js') || asarList.includes('out/main/pdf.worker.js'))
      check('asar 包含 /out/renderer/icon.png', asarList.includes('out\\renderer\\icon.png') || asarList.includes('out/renderer/icon.png'))
      check('asar 包含 /assets/fonts/MicrosoftYaHei-Regular-subset.ttf', asarList.includes('MicrosoftYaHei-Regular-subset.ttf'))
      check('asar 包含 /assets/fonts/MicrosoftYaHei-Bold-subset.ttf', asarList.includes('MicrosoftYaHei-Bold-subset.ttf'))
      check('asar 包含 /assets/fonts/Consolas-subset.ttf', asarList.includes('Consolas-subset.ttf'))
    } catch (e) {
      check('asar list 执行成功', false, e.message)
    }
  } else {
    console.log('  ⚠ asar 不存在，跳过（请先运行 electron-builder）')
  }
}

// ── 结果汇总 ───────────────────────────────────────────
console.log('\n' + '═'.repeat(50))
console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`)
if (failed === 0) {
  console.log('  ✅ 全部检查通过，可以打包')
  process.exit(0)
} else {
  console.log(`  ❌ ${failed} 项检查失败，请修复后再打包`)
  console.log('  参考 docs/KNOWN-ISSUES.md 了解每个问题的修复方案')
  process.exit(1)
}
