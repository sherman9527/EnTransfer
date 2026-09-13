# EnTransfer 项目进度追踪 (Handover)

> 最后更新：2026-09-13
> 状态：✅ 最终打磨完成 — 全书353页GPU E2E通过、模型手动放置UX、EXE优化至101MB、旧代码清理

## 项目概览
- **目标**：Windows EXE 桌面应用，英文文字版PDF → 中文PDF，纯离线（CPU+Vulkan GPU可选）
- **项目根目录**：`C:\Users\_Cole\Desktop\ADEMO\EnTransfer`
- **测试PDF**：`Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf` (353页, 12.4MB)
- **参考项目UX**：`C:\Users\_Cole\main\code\xiaoshulang\xiaoshulang` (校书郎，仅参考不修改)

## 环境信息
- Node v22.23.2, npm 10.9.8, Python 3.10.5 (fonttools), Git
- OS: Windows, CPU: i5-12600KF (6P+4E混合架构, 16逻辑核), RAM: 32GB
- GPU: NVIDIA GTX 1060 6GB (Vulkan支持), 驱动582.66

---

## 阶段进度

### Phase 1: Plan ✅ 完成
- 翻译引擎调研（14候选，含超小模型对比）→ `docs/research/translation-engine-research.md`
- PDF处理调研 → `docs/research/pdf-processing-research.md`
- 架构图（draw.io）→ `docs/architecture/architecture.drawio`
- **结论**：Hy-MT2-1.8B Q4_K_M + pdfjs-dist + pdf-lib + Noto Sans SC，纯Node.js无sidecar

### Phase 2: POC ✅ 完成
- **翻译引擎POC**：Hy-MT2-1.8B Q4_K_M，CPU 7.44 tok/s，质量4.9/5，内存1.58GB
- **PDF管线POC**：提取+清除+重排版全链路通过
- 模型已下载到 `%APPDATA%/EnTransfer/models/Hy-MT2-1.8B.Q4_K_M.gguf` (1.08GB)

### Phase 3: Implementation ✅ 完成

#### 3.1 项目骨架 ✅
- Electron 33 + React 18 + TS + electron-vite + Tailwind + Zustand
- 主进程/预加载/渲染进程三层构建

#### 3.2 PDF处理模块 (`electron/pdf/`) ✅ — 已重写为流式布局
- **流式内容提取** `capture/flow.ts`：ContentBlock[]，丢弃坐标，标题按字号分level，TOC页整页跳过，页码剥离，多栏检测，JPEG图片提取
- **流式排版** `typeset/flow.ts`：全新A4页面，正文11pt/行高16pt，h1-h4层级，自动分页，图片居中渲染，代码块Courier等宽+灰底
- **术语表** `capture/glossary.ts`：EM/IC/VP/OKR等缩写翻译前扩展
- 旧原位替换代码保留在 `capture/` 和 `typeset/` 根目录（pipeline不再使用）

#### 3.3 翻译引擎+模型管理 (`electron/models/`) ✅
- `engine.ts`：node-llama-cpp封装，prefixCaching，context=2048，自适应线程，temperature=0.1
- `registry.ts`：Hy-MT2-1.8B Q4_K_M（推荐）+ IQ3_M（轻量）+ Qwen2.5-3B
- `download.ts`：断点续传+进度回调，ModelScope主源
- `manager.ts`, `ipc.ts`

#### 3.4 任务队列+Checkpoint (`electron/queue/`) ✅
- 9状态状态机，atomic checkpoint，append-only jsonl，FIFO单并发
- 支持暂停/恢复/取消/删除，60断言测试全过

#### 3.5 UI界面 (`renderer/src/`) ✅
- TaskQueueScreen（任务队列+进度+操作）
- ModelsScreen（模型下载+进度条+管理）
- SettingsScreen（默认模型/输出目录/镜像源/线程数）

#### 3.6 流水线编排器 (`electron/pipeline.ts`) ✅
- captureFlow → translate → typesetFlow → export
- 每单元append checkpoint，支持resume
- 18/18集成测试通过

### Phase 4: E2E & Packaging ✅
- [x] 50页E2E真实翻译（1764秒，189 blocks，含第1章正文）
- [x] 输出PDF质量验证（无重叠、无乱码、字号统一、图片保留）
- [x] electron-builder打包EXE（NSIS 359.8MB + portable zip 483.1MB）
- [x] 使用文档 → `docs/USER-GUIDE.md`
- [x] E2E输出样例 → `docs/E2E-输出样例-前50页.pdf`

---

## 重大架构变更记录

### 原位替换 → 流式重排（关键转折点）
- **问题**：原位坐标替换导致中文重叠（中文比英文宽）、目录页点引线残留、页码与标题融合
- **方案**：彻底放弃原PDF坐标，提取结构化内容流后在全新A4页面从头排版
- **文件**：`capture/flow.ts` + `typeset/flow.ts`
- **效果**：无重叠、字号统一、无装饰元素残留

### 字体子集化
- **问题**：pdf-lib `subset:true` 损坏Noto Sans SC的CID→glyph映射，被迫全量嵌入(17MB)
- **方案**：构建时用Python fonttools预子集化（GB2312 6763汉字+ASCII+标点=7860字符）
- **结果**：字体 17MB → 4MB（-76%），输出PDF 16.7MB → ~9MB（50页）
- **脚本**：`scripts/subset-font.py`

### 代码块误判修复
- **问题**：CODE_SYMBOL_RE包含`()`，"Manager of managers (leadership)"被误判为代码而不翻译
- **修复**：移除`()`，要求≥3个代码符号，阈值从len/18提高到len/12
- **效果**：100页扫描误判从4个降到1个（表格`<>`边缘情况）

---

## 最终交付物
1. ✅ 完整Electron项目源码
2. ✅ Windows EXE安装包：`release/EnTransfer Setup 0.1.0.exe` (**142.2MB**，含Vulkan GPU后端，已排除500MB+ CUDA二进制)
3. ✅ Portable zip：`release/EnTransfer-0.1.0-win.zip` (191.7MB)
4. ✅ Git仓库（22次提交）
5. ✅ 架构图：`docs/architecture/architecture.drawio`
6. ✅ 使用文档：`docs/USER-GUIDE.md`
7. ✅ POC测试报告：`poc/translation/` + `poc/pdf-pipeline/`
8. ✅ E2E输出样例：`docs/E2E-输出样例-前50页.pdf`

---

## 优化阶段（进行中）

### 已完成
1. **数据路径修复（需求#20）** ✅ commit d9f74e7
   - 模型从 `%APPDATA%/EnTransfer/models/` 移到项目 `models/`（8个模型，12.3GB）
   - 数据目录改为 `<project>/data/`（开发）或 `<exe_dir>/data/`（打包portable）
   - main.ts / registry.ts / e2e-test.ts 全部更新为项目相对路径
   - 删除APPDATA目录和POC重复模型

2. **模型横评准备** ✅
   - 8个模型下载到 `models/`：Hy-MT2-1.8B Q4、Qwen2.5-1.5B/3B、Qwen3-1.7B/4B、MiniCPM5-1B/2B、MiniCPM3-4B
   - 40个测试用例（9类）→ `tests/benchmark-cases.json`
   - 模型解耦重构：engine-interface.ts + llama-engine.ts + engine-config.ts + engine-manager.ts
   - benchmark-runner.ts + tuning-runner.ts 脚本
   - 文档：MODEL-BENCHMARK.md（质量60%+速度20%+体积10%+内存10%）、MODEL-TUNING.md、INFERENCE-OPTIMIZATION.md
   - 横评方法论：每模型单独调优到最优解，再横向对比
   - 未找到：Hy-MT2 1.25bit、opus-mt（需CTranslate2）

3. **线程数自适应** ✅ 已整合
   - `electron/models/cpu-info.ts`：WMI检测物理核数、混合架构判定、P核查表
   - 本机检测：i5-12600KF = 6P+4E混合架构，推荐12线程（P核×2 HT，避开E核）
   - `electron/models/thread-benchmark.ts`：自动扫描最优线程数
   - `shared/types.ts`：threadsMode/manualThreads/device字段

4. **翻译速度优化** ✅ 完成
   - 最优参数：threads=12, contextSize=2048, temperature=0.1, topK=20, topP=0.9, prefixCaching=true
   - CPU 50页：1605s（基线1764s，-9%），详见 `docs/SPEED-OPTIMIZATION.md`
   - 结论：纯CPU+Q4_K_M已到内存带宽天花板（~9 tok/s），进一步提升需GPU

5. **GPU Vulkan加速** ✅ 已整合
   - 后端 `@node-llama-cpp/win-x64-vulkan`（通用Vulkan，不绑定CUDA）
   - `electron/models/gpu.ts`：`detectGpu()` + `resolveGpuLayers()`
   - 实测：GTX 1060 6GB 上 57.8 tok/s（CPU的6.4×），显存~1448MB
   - **50页E2E：200.7s（3.3分钟）vs CPU 1605s，8×加速**

6. **整合优化结果** ✅ 完成
   - `llama-engine.ts`：load() 支持 `device`（auto/cpu/gpu）+ `threads='auto'`，GPU失败自动回退CPU
   - `engine-manager.ts`：按 `device|threadsMode|manualThreads` 指纹缓存，改设置自动重载
   - `manager.ts`：持有并传递推理设置
   - IPC：`gpu:info` / `cpu:info` 通道，preload 暴露 `getGpuInfo()` / `getCpuInfo()`
   - CPU回退验证通过（强制device=cpu，5页正常翻译）

7. **设置页UI** ✅ 完成
   - 推理设备下拉：自动/仅CPU/仅GPU（Vulkan）
   - GPU信息显示：✅ GPU加速（Vulkan）— 型号/显存，或 ⚠️ 未检测到
   - 线程数：自动/手动切换 + 滑块1~逻辑核数
   - CPU信息显示：型号（P+E，逻辑核），自动选择线程数

### 已执行
8. **模型横评推理测试**：8个模型各自调优后横向对比（待后续，非本次范围）
9. **全书353页E2E**：GPU预估~24分钟（待跑，非本次范围）
10. **重新打包EXE** ✅ 完成：含Vulkan后端，排除CUDA二进制
11. **表格处理改进**：坐标聚类检测表格边界（当前被压平为段落）

---

## 关键设计决策
1. **翻译引擎**：Hy-MT2-1.8B Q4_K_M（基准），node-llama-cpp v3.20.0，temperature=0.1，context=2048
2. **GPU加速**：Vulkan通用后端（不绑定CUDA），gpuLayers='max'全部offload，自动回退CPU
3. **线程数**：运行时自适应检测，混合架构只用P核超线程，默认12线程（i5-12600KF）
4. **PDF提取**：pdfjs-dist legacy build，流式内容提取，丢弃坐标
5. **重排版**：pdf-lib + fontkit，全新A4流式布局，Noto Sans SC子集字体(4MB)
6. **任务队列**：FIFO单并发（CPU限制），9状态状态机，atomic checkpoint
7. **模型下载**：ModelScope主源（hf-mirror/huggingface不可达），断点续传
8. **数据路径**：全部在项目目录内（需求#20），portable模式
9. **图片**：仅提取DCTDecode(JPEG)，pdf-lib递归遍历资源字典
10. **代码块**：等宽字体(Courier)+灰底，不翻译
11. **术语表**：翻译前扩展EM→Engineering Manager (EM)等缩写
12. **横评方法论**：每模型单独调优到最优解，再横向对比（质量60%+速度20%+体积10%+内存10%）

---

## 已知问题和待解决项

| # | 问题 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | 表格被压平为段落 | 中 | 3列以上表格被多栏检测压平，`<>`为列分隔符产物（第87页），内容仍翻译但格式不理想 |
| 2 | 非JPEG图片不提取 | 低 | FlateDecode/JPXDecode等格式因缺少canvas/rasterizer跳过，Manning PDF恰好全是JPEG |
| 3 | 完整353页未E2E | 低 | 已验证50页（含第1章正文），全书预估2-3小时 |
| 4 | 使用文档为Markdown | 低 | 未生成PDF版使用文档 |
| 5 | 前言书单页残留", by" | 低 | 项目符号字形fs=3干扰段落合并 |
| 6 | 默认模型ID两份状态 | 低 | ModelManager和settings未完全同步，UI以settings为真源 |

---

## 已验证做不通的方案
- hf-mirror.com / huggingface.co 网络不可达（用ModelScope替代）
- canvas npm包Windows编译失败（Electron中用Chromium canvas）
- OTF/CFF字体在fontkit中有subset bug（必须用TTF）
- pdf-lib `subset:true` 损坏Noto Sans SC CID映射（改用构建时预子集化）
- pdf-lib `removePage`不做垃圾回收（必须用copyPages到新文档）
- `LlamaContext`没有`clearHistory()`（用`session.resetChatHistory()`）

---

## 常用命令
```bash
# 开发模式
npm run dev

# 构建
npm run build

# 类型检查
npx tsc --noEmit -p tsconfig.node.json

# 打包EXE
npm run dist

# E2E测试（N页）
Remove-Item -Recurse -Force .scratch/e2e-jobs
npx esbuild e2e-test.ts --bundle --platform=node --format=esm --external:node-llama-cpp --external:pdfjs-dist --external:pdf-lib --external:@pdf-lib/fontkit --external:canvas --outfile=.scratch/e2e-test.mjs
node .scratch/e2e-test.mjs 50

# 重新生成子集字体
C:\Python310\python.exe scripts/subset-font.py
```


---

## 2026-09-12 模型横评（任务1）完成

### 结论
- **主推荐模型：Qwen3-1.7B-Q4_K_M**（综合分 4.59，质量 4.9/5，GPU 70.1 tok/s，1.22GB，VRAM 1647MB）
- 备选：Hy-MT2-1.8B（4.52，已验证稳妥）、Qwen3-4B（质量天花板 5.0，35.8 tok/s）
- 关键技术发现：Qwen3/MiniCPM5/MiniCPM3 默认开启 thinking，速度暴跌 ~50×；
  必须用 JinjaTemplateChatWrapper({reasoning:false}) 关闭 enable_thinking。
- 修复 getEngineConfig 短 id 查不到带量化后缀键名的 bug（disableReasoning 曾静默失效）。
- 全部 8 模型 GPU 横评完成（关闭 thinking），详见 docs/MODEL-BENCHMARK.md。
- 下一步：任务1.5 收敛单模型 -> 任务2 Prefix Caching -> 3 表格 -> 4 图片 -> 5 模型ID同步。

## 任务3 表格处理（2026-09-12）
- capture/flow.ts: ContentBlock 新增 table 类型 + cells/rows/cols/hasHeader；RawLine 增加 segments（按 x-gap 分列）
- detectTables: 列锚点聚类（>=3列）+ 垂直间隙分行，处理跨行换行单元格，表格行从段落流剔除并按位置交织
- pipeline.ts: buildTasks/writeBack 支持逐 cell 翻译（cellRow/cellCol）
- typeset/flow.ts: 表格绘制（边框/列分隔/表头灰底/单元格自动换行/跨页检查）
- 验证: 页36真表检测成功，50页E2E 210.8s/8.5MB无回归；Manning页87表格因justify文本分栏噪声部分漏检（已知限制）

## 任务4 非JPEG图片（2026-09-12）
- 纯JS手写PNG编码器（zlib.deflate+CRC32），无canvas/sharp依赖
- FlateDecode 8-bit DeviceRGB（无predictor）解压→PNG；CCITTFaxDecode/JPXDecode记录跳过原因
- 修复此前Set-Content批量替换损坏的TOC/list正则（改ASCII）
- 验证: Manning PDF含1张FlateDecode 300x300 RGB图，提取数2→3；CCITT记录跳过；50页E2E 211.6s/8.6MB无回归

## 任务5 默认模型ID状态同步（2026-09-12）
- settings.defaultModel 为唯一真源；ModelManager 构造时从 settings 注入，不再自维护默认
- setDefault: 校验+变更即 engineManager.unload() 失效引擎，下次 getEngine 重载
- 下载完成后若当前默认不可用，自动设为新下载模型
- 删除当前默认后自动切换到第一个已下载模型
- settings:set 中 patch.defaultModel 同步到 ModelManager
- 验证: tsc通过 + npm run build通过 + 50页E2E 213s/8.6MB

---

## 最终打磨三阶段（2026-09-13）

### A. 全书353页GPU E2E + 质量审查
- 输入 Manning 353页全书；Qwen3-1.7B Q4_K_M（disableReasoning），device=gpu，12线程
- 提取 1674 块（9图/9表），**1770 翻译任务全部完成落盘**，无失败/无OOM
- **总耗时 2185.7s（36.4分钟）**，模型加载4.2s，提取3.5s，排版3.4s
- 输出 `docs/E2E-输出样例-全书353页-Qwen3.pdf`：**10.8MB / 181页**（全新A4重排）
- 中文输出占比 1751/1770=98.9%（19条低中文为URL/缩写/数字片段）
- 质量审查：`docs/E2E-QUALITY-REVIEW.md` — 正文流畅、术语(EM/DevOps/SMART)准确、图表保留；
  已知小瑕疵集中在版权页法律套话（Shelter Island→男子避难所、acid-free→酸纸），不阻塞验收

### B. 模型获取UX（手动放置）
- 新IPC：`app:get-models-dir`（返回真实路径）、`app:open-models-dir`（shell.openPath）
- preload 暴露 `getModelsDir()` / `openModelsDir()`；main.ts 注册 handler
- ModelsScreen 新增「手动放置模型文件」虚线卡片：显示目录完整路径 + 复制路径（navigator.clipboard）+ 打开文件夹
- 手动放置与App下载走同一识别逻辑（registry.detectLocalStatus 扫描 models 目录）
- 修正残留：RECOMMENDED_ID 从 hy-mt2 改为 qwen3-1.7b；文案去掉「CPU推理/Hy-MT2」旧描述

### C. 死代码清理 + EXE优化
- 删除旧原位替换管线：capture/{extract,readingOrder,segment,index}.ts、
  typeset/{typeset,sanitize,draw,fonts}.ts、pdf/__test__.ts
- EmbeddedFonts 类型内联进 typeset/measure.ts（原 fonts.ts 删除后 measure 仍可用）
- pipeline.__test__.ts 改用 captureFlow 计算预期任务数
- 生产 console.log 保留（模型加载/阶段诊断，主进程无可见控制台）
- **EXE体积**：NSIS安装包 **142.2MB → 101.1MB（-29%）**
  - NSIS `compression: "maximum"`（7z）
  - afterPack 裁剪 locales 55→2（en-US/zh-CN），省 39.3MB unpacked
  - afterPack 删除 node-llama-cpp `gitRelease.bundle`（源码包），省 32.8MB
  - files 排除 `node_modules/lucide-react/**`（渲染端已vite打包），asar 88.6→65.3MB
- 验证：双tsconfig tsc零错误、npm run build通过、3页回归E2E 4.3s正常

---

## 排版/翻译质量4问题根因修复（2026-09-13）

针对用户截图反馈的4个严重问题，全部从根因修复并经50页GPU E2E验证。

### 问题1：乱码□□□ + 书单", by"孤儿行
- **乱码根因**：`subset-font.py` 用 GB2312(6763字)，模型输出的罕见字/特殊标点不在子集内 → 方框。
  - **修复**：字符集扩到 GBK(21791汉字) + ASCII + 标点 + 数学符号 + 几何图形，共23778字符。
    字体 4MB → 12.6MB（<15MB阈值，无需全量嵌入）。验证繁体字形 見現發關從體書 全覆盖。
- **", by"孤儿行根因**（双重）：
  1. 右margin的", by"短标签(x=448)被 `findColumnGutter` 误判为第二栏中缝，书名与", by"被拆到左右两列。
  2. 即便要求右栏片段≥10字符，独立"■"子弹行(y=510)仍与右栏", by Frederick Brooks"(y=508)在容差6内构成overlap，凑满4个→gutter被误接受。
  - **修复**：gutter双方都要求实质长度(≥10字符)，排除"■"/", by"短标签；另新增 `BULLET_ONLY_RE`，
    独立"■"标记行设 pendingBullet 并跳过，下一行前缀"• "。书单6条目完整合并书名+作者+URL，无孤儿行。

### 问题2：字体不统一（正文灰常规 vs 人名黑粗）
- **根因**：typeset 正文拉丁文本用 Helvetica，中文用 Noto Sans SC；Helvetica 视觉比 Noto 拉丁字形更重，
  导致致谢页人名列表看起来是黑色加粗、正文是灰色常规。
- **修复**：typeset 新增 `bodyFonts = { cjk, latin: cjk, mono }`，正文/列表/表格/标题全部改用 bodyFonts
  （拉丁也走 Noto Sans SC Regular）。Helvetica 仅保留给页码，Courier 仅代码块。字重视觉统一。

### 问题3：标题/列表项未识别
- **根因**：列表正则 `LIST_BULLET_RE` 要求破折号后 `\s+`，但"–Chapter 1..."破折号紧跟文字无空格漏检；
  章节描述行间距13pt < 1.6×10=16pt阈值，全部合并成一个大段落。
- **修复**：`LIST_BULLET_RE` 改 `\s*`（允许破折号后无空格）；`mergeLinesToParas` 新增 `startsListItem` 检查，
  列表标记行强制分段；新增 `SECTION_NUM_HEADING_RE`（"X.X 大写"开头）章节号短行→heading。
  验证：路线图"如何组织"为H3，18个章节条目各自成列表项。

### 问题4：表格/公式被翻译且内容重复
- **根因**：表格逐cell送译，把"聚焦块"等内容翻成中文且重复提取。
- **修复**：
  1. `pipeline.buildTasks`：`code/image/table/formula` 直接 continue，不送翻译，原文透传。
  2. capture 新增 `formula` 块类型（数学符号密度检测 ∑∫√=±∞≈≠≤≥）。
  3. typeset 表格保留英文原文+边框重绘。canvas 不可用故不做截图方案A，采用方案B（原文+边框）。
- **验证**：p36 Table 1.1 渲染为英文原文表格，无中文翻译、无重复乱码。
  （注：单元格边界仍有相邻列轻微合并，为已知capture限制，不影响"不翻译、不重复"的核心要求。）

### E2E验证
- GPU(Vulkan)模式，50页，**总耗时217.9s**（模型加载4.3s/提取1.5s/翻译/排版1.3s）
- 提取167块(3图/1表)，204翻译任务，输出 **14.0MB / 50页**
- 视觉自检：无方框乱码、书单无孤儿行、人名列表字重统一、路线图标题/列表正确、表格英文原文保留
- 产物：`docs/E2E-输出样例-前50页-修复版.pdf`
- 类型检查：双tsconfig tsc零错误

