# EnTransferQt（Python+PySide6 同类项目）学习笔记

> 调研对象：`C:\Users\_Cole\Desktop\ADEMO\EntransferQt\EnTransferQt`（源码 ~4MB，Python 3.12 + PySide6 + Nuitka shell，安装器 1.14GB）。
> 结论先行：**它的翻译模型和我们同级（MiniCPM5-2B ≈ Qwen3-1.7B，双方横评都是 4.9 质量分），速度我们反而快 2.4×（它 26 tok/s on Quadro P1000，我们 61.5 tok/s on 1060）。你感受到的"质量差距"几乎全部来自工程管线，不来自模型**——好消息是这些全部可移植，且大多不增加体积。

## 一、它的架构一句话版

```
PDF → Docling(RT-DETR 版面模型 + TableFormer 表格模型, CPU) → 语义块清单 manifest v2(JSON, 带哈希)
    → MiniCPM5-2B via Ollama（JSON 批量翻译 + 三级重试 + 内容寻址缓存 + 术语表）
    → 纯字符串拼 HTML + CSS → 系统 Edge headless --print-to-pdf
```

与我们：

```
PDF → pdfjs 文本 + 手工启发式（行→段/锚点聚簇表/正则噪声）→ ContentBlock[]
    → Qwen3-1.7B via node-llama-cpp（编号批次 + 前缀KV复用）
    → pdf-lib 逐行手工排版（自己算换行/页断/基线）
```

## 二、它的质量优势拆解（按贡献排序）

### 1. 语义块结构（贡献最大，移植成本也最大）
- Docling 用视觉模型判定"这是一级标题/这是段落/这是表格/这是图"，**段落边界、层级、阅读顺序是模型给的**，不是我们这种"行距<1.6×字号就合并"的几何启发式。段落切错→翻译上下文断裂→质量断崖，这是两项目最本质的差距来源。
- 表格是 TableFormer 输出的**真拓扑**：row/col index + rowspan/colspan + 单元格 bbox；我们的锚点聚簇检测不到合并单元格。
- 噪声排除是"label 语义 + 几何位置"双规则，外加**跨页重复页边文本检测**（同一文本出现在 >50% 页的边缘→判页眉页脚），比我们的 6% 边带正则稳。
- 代价：它是 Python 全家桶（这正是它 1.14GB 的原因），且 CPU 跑版面模型，824 页提取要拆 40-range 批 + worker 回收。

### 2. HTML/CSS + Edge 打印排版（贡献第二大，移植成本小，强烈推荐）
- 核心哲学写在 ADR-0005：**"LLMs do not make layout or pagination decisions"**——翻译产物填进确定性 HTML，排版交给 Chromium。
- 我们手写的这些坑它全部由 CSS 白拿：
  - `p{text-align:justify; orphans:2; widows:2}`（两端对齐+孤寡行控制——我们完全没有）
  - `h1..h4{break-after:avoid}`、`.chapter-heading{break-before:page}`（章标题不悬挂页尾/章前分页——我们的"超高块画穿页底"bug 不存在）
  - `.structured-table{border-collapse} td{border;padding;vertical-align:top}` + 行首加深色底（真 `<table>` 渲染——比我们逐格算线好）
  - `figure img{max-height:220mm;object-fit:contain}`（图片限高防溢出）
  - 字体直接用系统微软雅黑 `msyh.ttc`（**我们被字体子集化/CID 损坏坑过 5 个 KNOWN-ISSUES，它零成本**）
- 824 页 HTML→PDF 合成仅 35.6s；有 Edge 崩溃重试（fresh profile + 二换参数）与 PDF 头尾校验的成熟处理。
- **对我们的意义**：Electron 环境里 Edge/Chromium 本来就有（甚至可以 `new BrowserWindow().webContents.printToPDF()` 零外部进程！），替换 typeset/flow.ts 的潜力巨大：排版质量↑、代码量↓、输出体积↓（Chromium 自动子集化字体）。

### 3. 完整性校验与降级阶梯（贡献第三，成本小）
- 每个译块过确定性不变量：非空、占位符未泄漏、非原文照抄、**≥3 个连续英文词则必须含 CJK**、protected token 按 `Counter` **计**核对（不只是存在性）、表格行列计数不变。
- 三级重试阶梯：JSON 批(6块) → JSON 单块(带占位符保护) → 纯文本单块(中文指令)；**失败只降级未 resolved 的块，成功块永不重算**。
- 熔断：连续 20 块回退或 >100 块后回退率 >30% → 停，不烧机。
- 结果可审计：`.quality-report.json` 逐块记 page/kind/警告 + 输出 PDF 里给回退块打**橙色"原文保留"徽章**——"整本书悄悄变差"变成"150 处可点击复查"。
- 我们的 `translationLooksSane`（长度比 0.1~5）比它弱一个数量级，且无逐块审计产物。

### 4. 翻译经济学（成本小到中）
- **内容寻址缓存**：key = sha256(源文本+token+模型+量化+prompt 版本+命中术语表+管线版本)，命中还要复校验。改 CSS/排版回归时**零模型开销**（这点对我们做 A/B 也有巨大价值——今晚我反复跑同一语料，缓存能省一半时间）。
- 术语表 = 用户可编辑 JSON（`{en:zh}`），只注入本批命中的 term，另有 exact-override 修补 + `Chapter N→第N章` 正则。
- `is_preservable_technical_term()`：纯标识符/缩写直接**不调模型**短路（省 token 又防意译错）。
- 批参数与我们同思路：≤6 块/3000 字符、num_predict 按字符预算钳制（≈我们的 maxTokens 窗口钳制）、`temperature:0 + format:json + think:false`。
- 它独立验证过的两个结论与我们的实测**互相印证**：大批(10块)否决、显式并行请求否决、整表一次生成否决（>10 分钟！）——与我们"多序列无收益/编号批次最优/表格逐格"完全一致。
- 有意思的对照：它的 protected 占位符是**两级策略**（先明文带原 token，失败才换成 `__ENTRANSFER_PROTECTED_X__` + few-shot 示例"第__X__章"），比我们恒定 `§A§` 更省一次格式破坏；重试 prompt 里给例子这个技巧很便宜。
- 它同样被 Hy-MT2 卡住：**因为需要 llama.cpp 的 STQ 路径而 blocked**——与我们今晚的 2bit/1.25bit 加载失败发现互相印证，这条路线整个生态都还没就绪。

### 5. 工程纪律（软性，但值得学）
- OpenSpec 规格驱动：需求/设计/任务/验收全部版本化在仓库里（5 个 change 目录）；ADR 记录每次技术选型的**理由+自认代价**；HANDOVER.md 精确到字节和 SHA。
- 512 个 pytest + 发布门禁脚本（release gate）保留 JSON 证据。
- 回归基准 `translation-cases.json`：**12 例对抗型测试集**（数字代码/URL 占位/否定/条件句/caption/表格格/长上下文）×多模型×4 种 prompt 风格——这正是我们"质量防回归"缺的东西，我们只有人工评分文档。

## 三、它的弱点（我们的相对优势）
1. **体积 1.14GB** 安装包（Nuitka shell 76MB + 内嵌 Ollama runtime + Python worker + Docling/Paddle 全家桶）；我们 131MB。它的 ADR 明确写了"不内嵌权重，三包分开下载"，但依赖运行时就是大。
2. **速度**：26 tok/s（Quadro P1000 4GB）+ 大量重试 → 824 页 ≈ 3.8h 纯翻译（≈3.6 页/分钟）；我们 61.5 tok/s + 编号批次 → 353 页 34.7min（≈10.2 页/分钟），**按 token 快 2.4×、按页快 ~2.8×**。
3. 依赖系统 Edge 且无书签/TOC（我们也没有，但这其实是两边共同的可抄项：Chromium printToPDF 支持书签要另加工具）。
4. Electron 侧我们自带 Chromium，**学它的 HTML 排版不需要引入任何外部运行时**——这是性价比最高的一条。

## 四、采纳清单（按性价比排序，落到我们栈）
| 优先级 | 借鉴点 | 我们的实现路径 | 工作量 | 体积代价 |
|---|---|---|---|---|
| P0 | HTML+CSS 排版引擎替换 pdf-lib 直排 | Electron `webContents.printToPDF()`（零外部进程！）或复用系统 msedge --print-to-pdf；typeset/flow.ts 退役为 HTML 生成器；顺带消灭字体子集化全家坑+输出体积 | 中(2-3d) | 0 |
| P0 | 块级校验阶梯 + 回退徽章 + quality-report.json | 强化 translationLooksSane 为其不变量集；pipeline 记录逐块审计 JSON | 小(0.5d) | 0 |
| P1 | 内容寻址翻译缓存（key 含管线版本） | 新缓存目录 + 复校验；跨 job 复用 | 小(1d) | 0 |
| P1 | 术语表 JSON（用户可编辑）+ 命中注入 + 纯标识符短路 | 挂进现有 glossary.ts/freeze 通道 | 小(1d) | 0 |
| P1 | 两级占位符策略（明文优先，失败才换保护符+few-shot） | freezeProtected 改造 | 小(0.5d) | 0 |
| P2 | 12 例对抗质量回归集 + 多模型×prompt 矩阵 harness | poc/quality-regression/，接入 score-outputs.ts | 小(1d) | 0 |
| P2 | 熔断（连续/比例回退阈值停机） | pipeline 计数即可 | 小(0.2d) | 0 |
| P3 | 语义块提取（Docling 级） | **不移植 Python**；可选路线：纯 JS 版面模型（ONNX RT-DETR 量化版）或"可选 sidecar 包"作为高级档；短期先用"跨页重复边带检测"等便宜规则补齐噪声排除 | 大(1-2w)/小(0.5d 规则版) | 0 / +若干 |
| P3 | 表格真拓扑（rowspan/colspan） | 依赖 P3 语义提取；短期用我们的坐标逐格方案（已比它的分隔符方案更不易错位，只是没有合并单元格） | 中 | 0 |
| 记录 | Hy-MT2/STQ blocked 情报 | 与我们 TQ2 加载失败发现一致，等 llama.cpp | — | — |

## 五、金句备忘（它的 ADR 原话，值得贴在我们墙上）
- "LLMs do not make layout or pagination decisions."
- 检查点只在原子页/块边界提交，"never freeze a thread or assume a third-party engine can resume its call stack."
- 批量失败只把**未 resolved 的单块**降级重试，成功块留在 resolved 里。
- 缓存命中也要重新过校验（"CACHE_REJECTED"）——缓存不可信任，不变量才可信任。
