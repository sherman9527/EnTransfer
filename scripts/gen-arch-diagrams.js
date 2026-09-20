// scripts/gen-arch-diagrams.js — render the 4 architecture diagrams to PNG.
//
// Why not the draw.io source: the doc should embed images, not a file to open
// separately. No drawio CLI is installed, so we generate SVG (precise boxes /
// arrows / CJK text) and rasterize it with headless Microsoft Edge (a full
// Chromium, so ① ② → ≥ · etc. render via the OS YaHei font). Output PNGs go to
// docs/architecture/images/ and are embedded from docs/ARCHITECTURE.md.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const OUT = path.join(__dirname, '..', 'docs', 'architecture', 'images')
const HTML_DIR = path.join(__dirname, '..', '.scratch', 'arch-html')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(HTML_DIR, { recursive: true })

const C = {
  blue: ['#dae8fc', '#6c8ebf'], orange: ['#ffe6cc', '#d79b00'], green: ['#d5e8d4', '#82b366'],
  purple: ['#e1d5e7', '#9673a6'], yellow: ['#fff2cc', '#d6b656'], grey: ['#f5f5f5', '#666666'],
  red: ['#f8cecc', '#b85450'], white: ['#ffffff', '#999999']
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// box: {id,x,y,w,h,t,fill,stroke,fs,align,italic,bold}
function rect(b) {
  const fill = b.fill || C.white[0], stroke = b.stroke || C.white[1]
  const fs_ = b.fs || 13
  const lines = String(b.t).split('\n')
  const anchorX = b.align === 'left' ? b.x + 10 : b.x + b.w / 2
  const textAnchor = b.align === 'left' ? 'start' : 'middle'
  const lh = fs_ * 1.32
  const total = lines.length * lh
  const startY = b.container ? b.y + 22 : b.y + b.h / 2 - total / 2 + lh * 0.8
  const tspans = lines.map((ln, i) =>
    `<tspan x="${anchorX}" y="${startY + i * lh}">${esc(ln)}</tspan>`).join('')
  const style = `font-family:'Microsoft YaHei','Segoe UI',sans-serif;font-size:${fs_}px;${b.bold ? 'font-weight:700;' : ''}${b.italic ? 'font-style:italic;' : ''}fill:#1a1a2e`
  const rx = b.container ? 6 : 8
  return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${b.container ? 1.5 : 1.6}" ${b.dash ? 'stroke-dasharray="6 4"' : ''}/>` +
    `<text style="${style}" text-anchor="${textAnchor}">${tspans}</text>`
}

// edge: {a,b,label,dashed} — anchor at side midpoints by dominant direction.
function edge(e, boxes) {
  const A = boxes[e.a], B = boxes[e.b]
  if (!A || !B) return ''
  const ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 }
  const dx = bc.x - ac.x, dy = bc.y - ac.y
  let p1, p2
  if (Math.abs(dx) >= Math.abs(dy)) {
    p1 = { x: dx >= 0 ? A.x + A.w : A.x, y: ac.y }
    p2 = { x: dx >= 0 ? B.x : B.x + B.w, y: bc.y }
  } else {
    p1 = { x: ac.x, y: dy >= 0 ? A.y + A.h : A.y }
    p2 = { x: bc.x, y: dy >= 0 ? B.y : B.y + B.h }
  }
  const dash = e.dashed ? 'stroke-dasharray="5 4"' : ''
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  const lbl = e.label ? `<text x="${mid.x}" y="${mid.y - 4}" text-anchor="middle" style="font-family:'Microsoft YaHei',sans-serif;font-size:11px;fill:#555">${esc(e.label)}</text>` : ''
  return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#555" stroke-width="1.4" marker-end="url(#arrow)" ${dash}/>${lbl}`
}

function svg(title, W, H, boxes, edges, legend) {
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]))
  const body = edges.map((e) => edge(e, byId)).join('') + boxes.map(rect).join('')
  const head = `<text x="24" y="34" style="font-family:'Microsoft YaHei',sans-serif;font-size:20px;font-weight:700;fill:#1a1a2e">${esc(title)}</text>`
  const leg = legend ? `<text x="24" y="56" style="font-family:'Microsoft YaHei',sans-serif;font-size:12px;fill:#666">${esc(legend)}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,3 L0,6 Z" fill="#555"/></marker></defs><rect width="${W}" height="${H}" fill="#ffffff"/>${head}${leg}${body}</svg>`
}

function page(name, s) {
  const htmlPath = path.join(HTML_DIR, name + '.html')
  const pngPath = path.join(OUT, name + '.png')
  fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><body style="margin:0">${s}</body>`)
  const m = /width="(\d+)" height="(\d+)"/.exec(s)
  const W = +m[1], H = +m[2]
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${W},${H}`, `--user-data-dir=${path.join(HTML_DIR, 'profile')}`,
    `--screenshot=${pngPath}`, 'file:///' + htmlPath.replace(/\\/g, '/')], { stdio: 'ignore' })
  const ok = fs.existsSync(pngPath)
  console.log(ok ? `✓ ${name}.png (${fs.statSync(pngPath).size} bytes)` : `✗ ${name} FAILED`)
  return ok
}

// ── Diagram 1: 总体架构 ────────────────────────────────────────────
function d1() {
  const b = (id, x, y, w, h, t, col, extra = {}) => ({ id, x, y, w, h, t, fill: C[col][0], stroke: C[col][1], ...extra })
  const boxes = [
    b('cmain', 40, 80, 600, 360, '主进程  Electron / Node.js', 'grey', { container: true, bold: true, align: 'left' }),
    b('main', 70, 120, 250, 48, 'electron/main.ts\n入口 · IPC 注册 · 窗口', 'blue', { fs: 12 }),
    b('queue', 350, 120, 270, 48, 'queue/manager.ts\nFIFO · 单并发 · 状态机 · checkpoint', 'blue', { fs: 12 }),
    b('pipeline', 70, 188, 250, 48, 'pipeline.ts\n编排 4 阶段', 'blue', { fs: 12 }),
    b('engine', 350, 188, 270, 52, 'models/manager · engine-manager\nllama-engine (node-llama-cpp)', 'orange', { fs: 12 }),
    b('capture', 70, 258, 250, 56, 'pdf/capture\nflow · line-utils · page-renderer\nlayout-detector (C1)', 'green', { fs: 12 }),
    b('typeset', 350, 258, 270, 56, 'pdf/typeset\nchromiumPrint · htmlFlow · flow', 'green', { fs: 12 }),
    b('settings', 70, 332, 250, 44, 'settings · translation-cache', 'blue', { fs: 12 }),
    b('preload', 350, 332, 270, 44, 'preload.ts (contextBridge) 安全 IPC 面', 'blue', { fs: 12 }),
    b('crend', 700, 80, 360, 360, '渲染进程  React 18 + Zustand + Tailwind', 'grey', { container: true, bold: true, align: 'left' }),
    b('screens', 725, 120, 310, 48, 'screens  任务队列 · 模型管理 · 设置', 'purple', { fs: 12 }),
    b('stores', 725, 188, 310, 48, 'Zustand stores  queue·model·settings·ui', 'purple', { fs: 12 }),
    b('app', 725, 250, 310, 44, 'App.tsx — 屏幕导航 + 全局 toast', 'purple', { fs: 12 }),
    b('client', 725, 310, 310, 44, 'ipc/client.ts (window.api)', 'purple', { fs: 12 }),
    b('model', 40, 470, 280, 48, '模型下载 ModelScope\nQwen3-1.7B-Q4_K_M ~1.2GB', 'yellow', { fs: 12 }),
    b('fs', 350, 470, 280, 48, '文件系统 data/ + models/\n安装目录内 · 卸载零残留', 'grey', { fs: 12 }),
    b('chromium', 660, 470, 280, 48, '隐藏 Chromium 窗口\nprintToPDF 排版', 'yellow', { fs: 12 })
  ]
  const edges = [
    { a: 'preload', b: 'client', label: 'invoke / 事件推送', dashed: true },
    { a: 'main', b: 'pipeline' }, { a: 'pipeline', b: 'capture' }, { a: 'pipeline', b: 'typeset' },
    { a: 'pipeline', b: 'engine' }, { a: 'engine', b: 'model' }, { a: 'typeset', b: 'chromium' },
    { a: 'capture', b: 'fs' }, { a: 'screens', b: 'stores' }, { a: 'stores', b: 'client' }
  ]
  return svg('通事官 — 总体架构（Electron 双进程 + 离线本地推理）', 1090, 545, boxes, edges,
    '蓝=编排/主进程  橙=原生引擎  绿=PDF 处理  紫=渲染进程  黄=外部/系统  灰=存储')
}

// ── Diagram 2: 翻译流水线 ──────────────────────────────────────────
function d2() {
  const b = (id, x, y, w, h, t, col, extra = {}) => ({ id, x, y, w, h, t, fill: C[col][0], stroke: C[col][1], ...extra })
  const boxes = [
    b('src', 30, 70, 110, 46, '源 PDF', 'grey', { bold: true }),
    b('p1', 175, 70, 120, 46, '① 提取\n0–5%', 'green', { bold: true }),
    b('blk', 330, 70, 150, 46, 'ContentBlock[]', 'yellow'),
    b('p2', 515, 70, 120, 46, '② 翻译\n5–90%', 'orange', { bold: true }),
    b('tr', 670, 70, 100, 46, '已译块', 'yellow'),
    b('p3', 805, 70, 120, 46, '③ 排版\n90–98%', 'green', { bold: true }),
    b('p4', 960, 70, 120, 46, '④ 导出\n98–100%', 'blue', { bold: true }),
    b('out', 1115, 70, 110, 46, '中文 PDF', 'grey', { bold: true }),
    b('g1', 40, 150, 380, 165,
      '① 提取子步骤 (capture/flow.ts)\n• pdfjs getTextContent：坐标/字号/字体名\n• 阅读顺序 · 分栏 · 段落合并 · 去连字符\n• 元素分类：标题/正文/代码/表格/图/家具\n• 家具剥离 + 出血页码清理（保守）\n• C1 PP-DocLayout-S (ONNX) 稀疏图区\n• 图片：pdf-lib 字节 + JPX 栅格化(pdfjs)\n• 重叠 placement 去重（防重复）', 'green',
      { align: 'left', fs: 12 }),
    b('g2', 450, 150, 380, 165,
      '② 翻译子步骤 (pipeline + llama-engine)\n• 仅译标题/正文；代码/表格/图 VERBATIM\n• 编号分批（带序号防错位）\n• Qwen3-1.7B temp0.1/topK20/topP0.9 关思考\n• 校验：sentinel / 数量级 / 空槽拒收\n• 占位符冻结→恢复（§A§ 公式/URL）\n• 熔断：≥200 单元且回退>30% 中止\n• 缓存 key=model+temp+topK+topP', 'orange',
      { align: 'left', fs: 12 }),
    b('g3', 860, 150, 365, 165,
      '③ 排版子步骤 (typeset)\n• blocksToHtml → Chromium printToPDF (主)\n• 全新 A4，字体子集内嵌\n• 兜底：pdf-lib typesetFlow\n• 溢出：自适应字号 14→6pt\n④ 导出：原子写 tmp→rename\n崩溃安全：append-only checkpoint', 'blue',
      { align: 'left', fs: 12 }),
    b('sm', 40, 340, 1185, 44, '状态机：queued → extracting → translating → typesetting → exporting → done（各阶段可 paused/canceled/error；暂停/取消经 AbortController 协作式传播）', 'grey', { fs: 12, italic: true })
  ]
  const edges = [
    { a: 'src', b: 'p1' }, { a: 'p1', b: 'blk' }, { a: 'blk', b: 'p2' }, { a: 'p2', b: 'tr' },
    { a: 'tr', b: 'p3' }, { a: 'p3', b: 'p4' }, { a: 'p4', b: 'out' }
  ]
  return svg('翻译流水线数据流（pipeline.ts 编排 · 崩溃可断点续传）', 1255, 410, boxes, edges)
}

// ── Diagram 3: 体积压缩 ────────────────────────────────────────────
function d3() {
  const b = (id, x, y, w, h, t, col, extra = {}) => ({ id, x, y, w, h, t, fill: C[col][0], stroke: C[col][1], ...extra })
  const rows = [
    ['① 模型外挂下载：不打包 1.2GB GGUF（最大单项，运行时 ModelScope 拉取）', 'yellow'],
    ['② after-pack：Electron locales 55 → 2（zh-CN + en-US），省 ~40 MB', 'orange'],
    ['③ after-pack：删 onnxruntime GPU EP（DirectML/dxcompiler/dxil），省 ~36 MB', 'orange'],
    ['④ after-pack：删 node-llama-cpp gitRelease.bundle，省 ~33 MB', 'orange'],
    ['⑤ after-pack：裁剪 ggml-cpu ISA 变体（留 x64/sse42/ivybridge/haswell/alderlake/zen4）', 'orange'],
    ['⑥ files 排除：全量字体、cuda/arm64、darwin/linux、lucide-react', 'green'],
    ['⑦ 字体子集化：YaHei/Consolas ~12–15MB；弃 NotoSansSC 全量（-13MB）', 'green'],
    ['⑧ asar 打包 + asarUnpack 仅原生模块；npmRebuild:false', 'blue'],
    ['⑨ NSIS compression: maximum（LZMA）', 'blue']
  ]
  const boxes = [b('start', 40, 70, 240, 56, '未优化基线\nElectron + 全部原生依赖\n~300+ MB', 'red', { bold: true, fs: 12 })]
  const edges = [{ a: 'start', b: 'r0' }]
  rows.forEach((r, i) => {
    const inset = i * 14
    boxes.push(b('r' + i, 60 + inset, 150 + i * 42, 980 - inset * 2, 36, r[0], r[1], { align: 'left', fs: 12 }))
    if (i > 0) edges.push({ a: 'r' + (i - 1), b: 'r' + i })
  })
  boxes.push(b('end', 300, 540, 480, 46, '交付安装包  ~120 MB（不含模型）', 'green', { bold: true }))
  edges.push({ a: 'r' + (rows.length - 1), b: 'end' })
  return svg('安装包体积压缩（交付 ~120 MB，不含模型）', 1080, 610, boxes, edges)
}

// ── Diagram 4: 质量把控 ────────────────────────────────────────────
function d4() {
  const b = (id, x, y, w, h, t, col, extra = {}) => ({ id, x, y, w, h, t, fill: C[col][0], stroke: C[col][1], ...extra })
  const boxes = [
    b('gate', 40, 70, 460, 66, '提交门禁  npm run gate\n= typecheck(strict + noUnused) + 回归 R1–R24(纯函数,<1s)', 'red', { align: 'left', fs: 12 }),
    b('verify', 40, 148, 460, 60, '结构不变式  npm run verify — 54 项\npackage/产物/源码/3g 回归不变式(对应 R#)/资源/asar', 'red', { align: 'left', fs: 12 }),
    b('e2e', 40, 220, 460, 60, '端到端  e2e-test.ts\n12 页 / 全书 353 页 + 黄金样例 docs/E2E-输出样例', 'orange', { align: 'left', fs: 12 }),
    b('control', 40, 300, 460, 50, '对照测试（防误伤）：Manning 9 张真表格必须存活', 'orange', { align: 'left', fs: 12 }),
    b('port', 40, 362, 460, 56, '便携性  install-drill.ps1\n装→跑→卸 端到端，卸载零残留', 'blue', { align: 'left', fs: 12 }),
    b('breaker', 40, 430, 460, 46, '运行期熔断：翻译回退 >30% 即中止', 'blue', { align: 'left', fs: 12 }),
    b('tdd', 540, 70, 500, 190,
      'TDD 防回归闭环\n1) 先在 regression.__test__.ts 写红色 R# 用例\n     （旧行为必须失败）\n2) 修代码变绿\n3) 无法单测的时序约束固化进 verify-build.js\n4) 台账 REGRESSION.md · 坑 KNOWN-ISSUES.md · 复盘 LESSONS.md', 'green', { align: 'left', fs: 12 }),
    b('principle', 540, 272, 500, 150,
      '核心原则\n• 一切自测：不信外部报告，A/B ≥ 50 例\n• 任何改动先测，有提升才采纳\n• 修根因而非点修（做对照控制测试）\n• 提交前 gate 无一例外', 'green', { align: 'left', fs: 12 }),
    b('flow', 40, 500, 1000, 50, '改动 → gate（必过）→ verify（涉打包/结构）→ E2E（涉 pipeline/engine/typeset）→ 全书回归（发版前）→ install-drill（发版前）', 'yellow', { align: 'left', fs: 12 })
  ]
  return svg('迭代质量把控（多层门禁 + TDD 防回归）', 1080, 575, boxes, [])
}

const all = { '1-overview': d1(), '2-pipeline': d2(), '3-size': d3(), '4-quality': d4() }
let ok = 0
for (const [name, s] of Object.entries(all)) if (page(name, s)) ok++
console.log(`\n${ok}/4 diagrams rendered → docs/architecture/images/`)
