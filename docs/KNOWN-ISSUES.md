# Known Issues & Pitfalls — 防回归手册

> 本文档记录开发过程中踩过的所有坑、根因和修复方案。
> 每次修改代码前，请对照本文档检查是否会重蹈覆辙。
> 每次发现新问题，必须追加到本文档。

---

## 一、打包后运行时路径问题（最高频）

### 1.1 字体文件 ENOENT — `process.resourcesPath` 指向 asar 外部

**症状**：
```
ENOENT: no such file or directory, open 'C:\...\resources\assets\fonts\MicrosoftYaHei-Regular-subset.ttf'
```

**根因**：
- `process.resourcesPath` 在打包后指向 `resources/` 目录（asar **外部**）
- 但字体文件实际在 `resources/app.asar/assets/fonts/`（asar **内部**）
- Node.js 可以透明读取 asar 内文件，但路径必须指向 asar 内部

**修复**：
- 用 `app.getAppPath()` 替代 `process.resourcesPath`
- 打包后 `app.getAppPath()` 返回 `resources/app.asar`，Node 可透明读取
- 开发模式下返回项目根目录

**涉及文件**：`electron/pipeline.ts` → `resolveFontPath()`

**检查清单**：
- [ ] 任何访问 `assets/` 下文件的代码，是否用了 `app.getAppPath()`？
- [ ] 是否还有代码用 `process.resourcesPath` 或 `process.cwd()` 访问打包后的资源？

---

### 1.2 Bold/Mono 字体路径用 `process.cwd()`

**症状**：打包后 bold/mono 字体找不到，或 fallback 到默认字体导致排版异常。

**根因**：`typeset/flow.ts` 中 `fontsDir = path.resolve(process.cwd(), 'assets', 'fonts')`，打包后 `process.cwd()` 是安装目录，不是 asar 内部。

**修复**：从 `regularPath` 的目录推导 bold/mono 路径：
```ts
const regularPath = options.fontPath ?? ...
const fontsDir = path.dirname(regularPath)
const boldPath = path.join(fontsDir, 'MicrosoftYaHei-Bold-subset.ttf')
```

**涉及文件**：`electron/pdf/typeset/flow.ts`

---

### 1.3 Logo 图片不显示 — file:// 协议下绝对路径解析错误

**症状**：左侧导航栏 logo 位置空白，或显示破损图片图标。

**根因**：
- Electron 用 `loadFile()` 加载 renderer，页面 URL 是 `file:///.../app.asar/out/renderer/index.html`
- `<img src="/icon.png">` 是绝对路径，在 file:// 协议下解析为 `file:///icon.png`（文件系统根目录）
- Vite 的 `base` 选项只影响构建时的资源引用，不转换 JSX 中的字符串字面量

**修复**：
1. `electron.vite.config.ts` renderer 添加 `base: './'`
2. JSX 中直接用相对路径 `<img src="./icon.png">`
3. 图片放在 `renderer/public/icon.png`，Vite 会复制到 `out/renderer/icon.png`

**涉及文件**：`electron.vite.config.ts`、`renderer/src/components/NavRail.tsx`

**检查清单**：
- [ ] renderer 中所有 `<img src>` 是否都是相对路径（`./` 开头）？
- [ ] vite renderer 配置是否有 `base: './'`？
- [ ] 图片是否在 `renderer/public/` 下？

---

### 1.4 pdf.worker.js 缺失 — fake-worker 回退需要 worker 文件

**症状**：
```
Setting up fake worker failed: "Cannot find module './pdf.worker.js'
Require stack: - ...\resources\app.asar\out\main\index.js"
```

**根因**：
- pdfjs-dist 在 Node.js 环境下使用 fake-worker 回退机制
- 该机制需要 `require('./pdf.worker.js')`，但 worker 文件不在输出目录
- 构建时只 bundle 了主入口，worker 是独立文件不会被自动包含

**修复**：
1. 新建 `scripts/copy-pdf-worker.js`，构建后从 `node_modules/pdfjs-dist/legacy/build/pdf.worker.js` 复制到 `out/main/`
2. `package.json` 添加 `postbuild` 脚本：`node scripts/copy-pdf-worker.js`
3. `flow.ts` 显式设置 `pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.js'`
4. electron-builder `files` 配置包含 `out/**/*`（已包含）

**涉及文件**：`scripts/copy-pdf-worker.js`、`package.json`、`electron/pdf/capture/flow.ts`

**检查清单**：
- [ ] `package.json` 是否有 `postbuild` 脚本？
- [ ] 构建后 `out/main/pdf.worker.js` 是否存在？
- [ ] asar 中是否包含 `/out/main/pdf.worker.js`？

---

## 二、构建工具问题

### 2.1 package.json BOM — PowerShell 写入 UTF-8 带 BOM

**症状**：
```
SyntaxError: Unexpected token '﻿', "﻿{..." is not valid JSON
```

**根因**：PowerShell 的 `Set-Content -Encoding UTF8` 会在文件开头添加 BOM（`EF BB BF`），Vite/Node 的 `JSON.parse` 无法解析带 BOM 的 JSON。

**修复**：用 .NET API 无 BOM 写入：
```powershell
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))
```

**检查清单**：
- [ ] 任何用 PowerShell 修改 `package.json` 的操作，是否用了无 BOM 写入？
- [ ] 构建前是否检查 `package.json` 前 3 字节不是 `239 187 191`？

---

### 2.2 ERR_REQUIRE_ESM — node-llama-cpp 是纯 ESM 包

**症状**：
```
Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported
```

**根因**：node-llama-cpp v3 是纯 ESM 包（`"type": "module"`，无 require 导出条件）。Electron 主进程如果用 CJS 输出，`require('node-llama-cpp')` 会失败。

**修复**：
1. 主进程保持 CJS 输出（Electron 对 ESM 支持不完善）
2. node-llama-cpp 用动态 `import()` 懒加载，封装在 `llama-cpp-loader.ts` 中
3. 其他依赖（pdfjs-dist、pdf-lib、fontkit）全部 bundle 进主进程输出
4. `externalizeDepsPlugin` 只 externalize electron、node 内置模块、node-llama-cpp

**涉及文件**：`electron/models/llama-cpp-loader.ts`、`electron.vite.config.ts`

**检查清单**：
- [ ] 是否有代码直接 `require('node-llama-cpp')` 或 `import ... from 'node-llama-cpp'`（顶层静态导入）？
- [ ] 所有 node-llama-cpp 访问是否都通过 `llama-cpp-loader.ts` 的动态 import？

---

## 三、Electron Builder 配置问题

### 3.1 图标不显示 — 图标必须在 build/ 目录

**症状**：安装包、exe、任务栏图标显示默认 Electron 图标或红色 E。

**根因**：electron-builder 默认从 `build/` 目录查找图标。如果图标在 `assets/`，需要显式配置 `win.icon` 指向正确路径，且 NSIS 的 `installerIcon`/`uninstallerIcon` 也要同步配置。

**修复**：
- 图标放到 `build/icon.ico` 和 `build/icon.png`（electron-builder 默认位置）
- `package.json` build 配置中 `win.icon: "build/icon.ico"`
- NSIS `installerIcon` 和 `uninstallerIcon` 同步指向 `build/icon.ico`

**涉及文件**：`package.json`、`build/icon.ico`、`build/icon.png`

---

### 3.2 asar 内文件访问 — 必须用 app.getAppPath()

**症状**：打包后访问 `assets/` 下文件失败。

**根因**：打包后应用代码在 `resources/app.asar/out/main/index.js`，`__dirname` 指向 asar 内部。但 `process.cwd()` 指向安装目录，`process.resourcesPath` 指向 `resources/`（asar 外部）。

**修复**：所有访问 `assets/` 下文件的代码，统一用 `app.getAppPath()` 作为根路径。

**通用规则**：
| 场景 | 用什么 |
|------|--------|
| 访问打包后的 assets/ | `app.getAppPath()` |
| 访问用户数据（模型、输出） | `app.getPath('userData')` 或项目目录 |
| 访问同目录下的输出文件 | `__dirname`（asar 内）或 `app.getAppPath()` |
| 临时文件 | `app.getPath('temp')` |

---

## 四、PDF 处理问题

### 4.1 原位坐标替换导致中文重叠

**症状**：翻译后中文文字重叠、溢出、排版混乱。

**根因**：最初方案是在原 PDF 坐标位置替换英文为中文，但中文字符比英文宽（1.5-2 倍），导致重叠。原 PDF 的坐标、间距、留空都是为英文设计的。

**修复**：彻底放弃原位替换，改为**流式重排版**（flow layout）：
1. 提取结构化内容流（标题、段落、图片、表格、代码块）
2. 丢弃所有坐标信息
3. 全新 A4 页面从头排版，紧凑布局

**涉及文件**：`electron/pdf/capture/flow.ts`、`electron/pdf/typeset/flow.ts`

---

### 4.2 字体子集化损坏 CID 映射

**症状**：PDF 中部分中文字符显示为方框或乱码。

**根因**：pdf-lib 的 `embedFont(..., { subset: true })` 会对字体做子集化，但 Noto Sans SC 的 CID 映射在子集化后损坏。

**修复**：使用预子集化的字体文件（`scripts/subset-yahei.py` 用 fontTools 提前子集化），嵌入时 `{ subset: false }`。

**涉及文件**：`scripts/subset-yahei.py`、`electron/pdf/typeset/flow.ts`

---

## 五、模型推理问题

### 5.1 Thinking Mode 导致速度暴跌

**症状**：Qwen3/MiniCPM5 推理速度仅 0.3-1.4 tok/s，完全不可用。

**根因**：Qwen3 和 MiniCPM5 默认开启 thinking mode（推理链），模型先生成思考过程再生成答案，token 数翻倍且思考过程无用。

**修复**：加载模型时设置 `disableReasoning: true`（Qwen3）或对应参数关闭 thinking。关闭后 Qwen3-1.7B 达 70 tok/s。

**涉及文件**：`electron/models/llama-cpp-loader.ts`

**检查清单**：
- [ ] 模型加载配置是否关闭了 reasoning/thinking？
- [ ] 新增模型时是否检查该模型是否默认开启 thinking？

---

### 5.2 MiniCPM5 在 Vulkan 下速度异常低

**症状**：MiniCPM5-2B 在 Vulkan GPU 下仅 10 tok/s，远低于 Qwen3-1.7B 的 70 tok/s。

**根因**：MiniCPM5 的架构（MoE + 特定 attention 实现）与 llama.cpp 的 Vulkan 后端兼容性差，GPU 利用率低。

**结论**：MiniCPM5 淘汰，不适合 Vulkan 通用 GPU 后端。

---

## 六、防回归检查清单（每次提交前必过）

### 构建验证
- [ ] `npm run build` 成功
- [ ] `package.json` 无 BOM（前 3 字节不是 `EF BB BF`）
- [ ] `out/main/pdf.worker.js` 存在（>1MB）
- [ ] `out/renderer/icon.png` 存在
- [ ] `out/renderer/assets/*.js` 中 logo 引用是 `./icon.png`

### 打包验证
- [ ] `npx electron-builder --win` 成功
- [ ] asar 中包含 `/out/main/pdf.worker.js`
- [ ] asar 中包含 `/out/renderer/icon.png`
- [ ] asar 中包含 `/assets/fonts/MicrosoftYaHei-Regular-subset.ttf`
- [ ] asar 中包含 `/assets/fonts/MicrosoftYaHei-Bold-subset.ttf`
- [ ] asar 中包含 `/assets/fonts/Consolas-subset.ttf`

### 代码审查
- [ ] 没有新增 `process.resourcesPath` 访问 assets/
- [ ] 没有新增 `process.cwd()` 访问 assets/
- [ ] 没有新增绝对路径 `/xxx.png` 的 img src
- [ ] 没有新增 `require('node-llama-cpp')` 静态导入
- [ ] 所有访问 assets/ 的代码用 `app.getAppPath()`
- [ ] 模型配置关闭了 reasoning/thinking

### 运行时冒烟测试
- [ ] EXE 能正常启动
- [ ] 左侧导航栏 logo 正常显示
- [ ] 模型管理页面能加载模型列表
- [ ] 提交翻译任务不报错
- [ ] 翻译输出 PDF 能正常打开，无乱码、无重叠

---

## 七、自动化验证

运行 `node scripts/verify-build.js` 自动执行构建后检查（构建验证 + 打包验证中的文件存在性检查）。

建议在 CI 中或每次手动打包前运行。
