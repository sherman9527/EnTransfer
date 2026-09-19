# pdfzh 设计对照 EnTransfer 管线 —— 借鉴候选与测试计划

日期：2026-09-19 ｜ 对照对象：`~/main/QcoderChat/docs/superpowers/specs/2026-09-19-pdfzh-design.md`
决策纪律：**每条借鉴都必须先在 `poc/eval-2026` 用 A/B（≥50 例）实测超过现状才导入**，否则只进"已否决"表。

## 0. 两项目定位差异（决定哪些"优势"其实与我们无关）

| 维度 | pdfzh | EnTransfer |
|---|---|---|
| 形态 | CLI，单文件流 `in.pdf→out.pdf`，阶段间走文件 | Electron GUI + 多任务队列，阶段间走 checkpoint/内存 |
| 硬件前提 | 死盯 GTX1060 6GB，模型上限 Qwen3-8B | 自适应：GPU 优先(Vulkan)+CPU 兜底，已实测 1.7B 为质量/速度帕累托最优 |
| 排版 | Typst（无运行时，30MB） | Chromium printToPDF（自带，实测优于 Typst/Qt，见 §5） |
| 译后校对 | 无 MTPE | 无（同） |

pdfzh 的**架构性选择**（Typst、PyMuPDF、外部 llama-server 进程、GBNF JSON）不是免费午餐，各自背一个依赖。EnTransfer 已在"零新增依赖"上更省（用 Electron 自带的 Chromium + pdfjs）。所以对照要问的是：**它有没有解决我们已经踩过的坑，还是换了一批新坑？** 下面逐条判。

## 1. 已领先或持平 —— 不借鉴（带实测证据）

| pdfzh 主张 | 我们的现状（实测） | 结论 |
|---|---|---|
| 页数压缩目标 [0.55,0.85] | 全书 353 页 → **196 页 = 0.555**，已在带内且贴近紧端 | 持平，无需动。**建议**：把压缩比加进 verify 当回归断言（见 §4-C6） |
| Typst 排版引擎 | Chromium `printToPDF`：hljs 代码高亮、真表格、CSS 避头点，实测 24.9→10.6MB | 我们更强，**不换**（pdfzh §4.4 自承 Typst 弱于 TeX 系，而我们已超 TeX 系性价比） |
| 投机解码 25–50 tok/s | 本机实测 **−27%**（带宽受限收益模型不同，但我们的数就是数） | **不重开**，除非 node-llama-cpp 版本变更（进 P2 跟踪） |
| 批处理省 prefill | 编号批次已落地，回退 48%→**4%**（n=80 自测） | 持平，已有 |
| 断点续跑/缓存 | content-addressed 缓存 + checkpoint（warm 重跑命中 1788/1999） | 更强（我们缓存跨任务、跨 resume） |
| 失败模式：只 parse 静默 | 我们 validator 双阶段 + 徽章 + quality-report.jsonl | 思路一致，我们有产品级落盘 |

## 2. 明确否决 —— 换架构不划算

| pdfzh 选择 | 为什么不采纳 |
|---|---|
| 外部 `llama-server` HTTP 进程 | 我们 in-process node-llama-cpp 已拿到 Vulkan 加速 + GPU→CPU 热回滚（R6/R10）。退到 HTTP 子进程 = 放弃回滚能力 + 多一个进程生命周期坑，零质量收益 |
| PyMuPDF 作提取层 | Python 依赖，Electron 打包体积灾难（几十 MB native）。**但它的"clip 栅格化"思路可用 pdfjs 复刻**（见 §3-C1，借鉴想法而非依赖） |
| GBNF 强制 `{"items":[{"id","zh"}]}` | 我们编号载体实测 4% 回退已很低；JSON 语法采样若真能压到 <2% 才考虑（见 §3-C2，先测）。**不默认换** |

## 3. 真正的差距 —— 待 A/B 实测（按价值排序）

### C1（最高价值）矢量图/难解码图像 → 区域栅格化
- **我们的痛点（已确认）**：`capture/flow.ts:791,795` 对 CMYK / CCITTFax / JPX / 非8bit-RGB 图像**直接跳过**，全书图像召回仅 **31%**；矢量画的分栏插图、公式我们整块丢掉。
- **pdfzh 的解**：`page.get_pixmap(clip=bbox, dpi=300)` 把任何"图/公式区"渲染成 PNG 搬运，绕开解码格式地狱。
- **我们的复刻（零新依赖）**：pdfjs `page.render({ viewport: <clip> })` 已能把任意页面区域画到 canvas → `toDataURL('image/png')`。用 getOperatorList 里的 OPS.paintImage/矢量 drawing 聚类出区域 bbox，逐区栅格化为 image block。
- **A/B**：取含公式/矢量图的样本页 ≥50，量「图/公式出现次数：现状 vs 栅格化」+「输出 PDF 目视正确率」+「体积/耗时增量」。
- **采纳阈值**：召回 31%→≥70%，且输出体积增幅 ≤15%、无排版崩坏。

#### C1 实测结论（2026-09-19，两个 headless 探针，已入库 `poc/eval-2026/`）
1. **`figure-census.ts`（缺口定性）**：全书含 "Figure N." 的页 **44**，其中仅 **6** 页有位图 placement、**25 页是纯矢量绘制**。→ 召回缺口**主要是矢量图**，不是"能解码却被跳过的位图"。"用 pdf-lib 解码 CMYK/CCITT 即可补回"这条捷径**证伪**。
2. **`vector-bbox-spike.ts`（瓶颈定位）**：栅格化不难（Chromium 有 canvas），**难的是从 pdfjs 拿矢量图 bbox**（我们没有 PyMuPDF 的 `get_drawings`）。用 CTM 栈投影 constructPath 坐标 + 6pt 间隙聚类，对 12 个纯矢量页**命中率仅 8%**（每页 25–109 个散碎 path rect，绝大多数是栏线/表格边框，与图形不可分）。
3. **判定**：**朴素几何法否决**（8% ≪ 70% 阈值）。这正是 pdfzh §4.4 所说"只有 parse 的失败是静默的，模型预算要押在静默失败路径上"的点。

#### C1 检测器实测（PP-DocLayout-S ONNX，`poc/doclayout-poc/`，2026-09-19）—— **采纳**
- 模型：`stefanj0/PP-DocLayout-S-ONNX` **4.7MB / Apache-2.0 / CPU**（`recall_test.py`，repo 内 venv，产物 `recall-report.json`）。
- **召回：真实题注页 33（严格行首 `Figure N.：` 规则，剔除 11 个正文交叉引用），检出 31 → 93.9%；现状位图法仅 18.2%**。仅 50ms/页（33 页含渲染 1.7s）。
- 目视核对 2 个"未命中"页（135/143）：均为句首交叉引用（"Figure 5.2 shows…"）非真图 → **检测器对真图召回≈100%**，2 例是**题注检测**的假阳，不是漏检。
- **判定：C1 达标（≥70%）**，采纳检测器路线。**遗留成本待测**：生产集成需 onnxruntime-web(WASM)+模型，对"压制体积"是真实增量 → 下一步先量体积 delta 再定嵌入形态（见 #20 后续）。

#### C1 生产集成衬底实测（2026-09-19，`poc/doclayout-poc/electron-ort.cjs`）
- **ORT-web（wasm in renderer）路线：否决**。
  - 1.30：`InferenceSession.create` 让 renderer **硬崩溃**（exit `-36861`）。已逐一排除 COOP/COEP 自定义
    `app://` scheme（`crossOriginIsolated=true` ✓）、wasm/模型同域 ✓、`numThreads=1` ✓、SAB feature flag ✓ —— 仍崩。
    根因：1.30 只有 pthreads 版 wasm。
  - 1.17.3（有非线程 `ort-wasm-simd.wasm`）：不崩了，但 nodeIntegration 下 `require` 命中 Node 构建 / UMD 全局拿不到，
    陷入 Electron 渲染进程模块加载泥潭。**结论：不要在渲染进程跑 ORT**。
- **ORT-node（原生 CPU EP，main 进程）路线：可用 ✓（衬底定案）**。main 里 `require('onnxruntime-node')` 跑 p57：
  0.209s（含加载），figure 框 `[336,49,475,417]` 与 Python POC `[336.2,50.4,476.3,413.1]` 吻合。main 是 Node，行为=纯 node，无 wasm/线程/模块问题。
- **集成架构（定）**：页面像素 = 复用隐藏 Chromium（pdf.js canvas→PNG dataURL，POC 里 CP2 已证 pdf.js 在渲染进程可用）→ IPC 回 main；
  推理 = main 进程 onnxruntime-node（载入一次，常驻）。clip 栅格化同一块 Chromium 出图。**零新增渲染依赖**。

#### C1 集成落地（2026-09-19，Layer 1–4 全部提交，用户批准 +20MB）
> 修正：最终未用"隐藏 Chromium 出图"，改用 **@napi-rs/canvas 在 main 里直接渲染**（更简单、无 IPC/HTML/worker 编排，且体积只 +~5MB 原生库）。
- **Layer 1** `layout-detector.ts`：ORT-node 会话（main），480² RGBA→区域框，缺依赖时优雅 no-op。单测载入真模型跑 p57 命中。
- **Layer 2** `page-renderer.ts`：pdf.js(legacy)+@napi-rs/canvas 出 480² 检测缓冲 + clip→PNG。test-render 端到端产出干净职业阶梯图。
- **Layer 3** `captureFlow` Step 7.5：逐页检测 image/chart，去重（与已抽位图 centerY 重叠）、滤碎条，clip 成 image block 插入阅读序。
  全书审计 **9→61 图块（+52）/ 31s**；抽查 p285(3 图表)/p292(多图标) 均为真实多图非碎片；CAPTURE_VERSION→3。
- **Layer 4** 打包：asarUnpack onnxruntime-node/@napi-rs/canvas/assets.layout；files 排除非 win32-x64 平台；after-pack 剪 GPU dll(~36MB)。
  electron.vite 外部化两个原生包；build+verify(40) 绿。
- **状态**：代码全部合入；dist 实测体积 + e2e（翻译后 PDF 出图）为收尾验证项。

#### C1 集成回退记录（2026-09-19，Layer 3/4 已 revert，模块保留为地基）
实测全书接线后发现**非纯收益**，按"有提升才导入 / 不容易报错"回退 captureFlow 接线与打包：
- ✅ 纯矢量图页（p57 职业阶梯）：检测 + clip 干净出图，且**早期文本区过滤**消除了泄漏进正文的图内标签（Vice/Director/Staff…）。
- ❌ **表格被误判为 image 的页（p55 IC/EM 对比表）**：检测器把样式化对比表标成 image 区，文本区过滤连带**吃掉了表格正文行** → 表格内容丢失。这正是 pdfzh §14 警告的"M4 无底洞"，在我们自己语料上复现。
- 结论：**检测器质量达标（94% 召回）但"图区文本排除"与"表格/图误判"的长尾未收敛**，未经全书语料验证不能确保净收益 → 回退接线，避免回归。
- **保留**：`layout-detector.ts` + `page-renderer.ts`（均带独立单测 test-detector/test-render，绿色）、全部 POC、体积实测数据。
  `onnxruntime-node`/`@napi-rs/canvas` 移入 devDependencies（模块/测试可用，**不进安装包**），模型 asset 移除。verify 回 40 项、typecheck/build/regression 全绿。
- **重启 C1 的前置条件**（下一步）：区域文本排除须**只删 label 样短行、保护表格/长句**；且需一张"图 vs 表"判别更准的检测器或加 IoU-与-已检测表格 保护；全书 ≥3 语料回归验证净收益后再上线。
- **体积实测**：win-x64 CPU 仅需 `onnxruntime.dll`(27.4MB)+`binding.node`(0.3MB)；DirectML/dxcompiler/dxil(~36MB) 属 GPU EP，after-pack 剪。
  净增 **≈ +20MB 压缩**（模型 4.7MB 另计），安装器 97→约 117MB。**高于当初批准的 ~+10MB**（因省体积的 web 路线崩了）→ 已向用户回报此偏差待定。
4. **新方案（把 C1 并入 P2 的 PP-DocLayout-S）**：用轻量版面检测 ONNX（PP-DocLayout-S，~10–30MB，CPU 每页几十 ms）**直接输出 figure/table/formula bbox**，绕过脆弱的几何聚类；拿到 bbox 后仍用 Chromium `render({clip})` 栅格化搬运。**C1 的成败现在等价于 PP-DocLayout-S 试验的成败** → P2#PP-DocLayout 提升为 C1 的实现路径，优先级提到 C2 之前。
5. **回退预案**：若 PP-DocLayout-S 召回也不达 70% 或体积/耗时不划算，则 C1 整体归 §2 否决表，维持"宁缺毋滥（矢量图暂缺，不产垃圾）"现状。

### C2 GBNF grammar 结构化输出 —— **实测否决（2026-09-19）**
- node-llama-cpp v3.20 **有** `createGrammarForJsonSchema`（已核+已测）。POC：`poc/eval-2026/grammar-batch.ts`，同语料 80 段×{size2,size4}×{编号,grammar}，GPU/Vulkan/temp0.1。
- **结果**：grammar 吞吐 **−12%（b4）～ −35%（b2）**（GBNF 拒绝采样税）；批失败率 grammar {10%,5%} vs 编号 {5%,10%} —— **无一致优势**。
- **根因**：语法约束只保证 JSON 合法；我们编号载体的"按编号映射"本来就免疫语法错误，真正失败模式是 **id 数量/内容错乱**（语义层），grammar 管不住，照样 5–10%。
- **判定**：不满足采纳阈值（"失败率严格更低 且 tok/s 损失<10%"）→ 归 §2 否决表。编号载体维持。engine 的 `grammar` 透传与 `createJsonGrammar` 保留为测试设施（4 行，正交能力），不进生产路径。

### C3 mean-logprob 质量门 —— **当前引擎不可行（2026-09-19 核查）**
- 核查结论：node-llama-cpp v3.20 的公共 API（`LlamaChatSession.promptWithMeta` / engine.translate）**不返回 per-token logprob**——`logits` 只存在于 `LlamaContext.evaluateBatch` 底层类型里。走底层 = 手工重建 chat/采样/防溢出逻辑，且质量分需要额外一次逐 token 评估前向（等于再花一遍 decode 的钱），违背"提速/保质不增加推理税"的前提。
- **判定**：C3 搁置，并入「llama.cpp / node-llama-cpp 升级跟踪」——若上游暴露 logprob API 再重启。现有 deterministic validator + 熔断继续承担质量闸。

### C4 跨文档 fuzzy TM + 风格锚
- 我们缓存是**精确键**（model+promptVer+temp+src+masked），跨文档不复用近似句。pdfzh 用编辑距离 ≥0.92 复用 + 0.80–0.92 作 few-shot + 每批带"上一批末2句"做风格锚。
- 多任务队列里**套话/术语/表头高度重复**，fuzzy 复用可再省一部分推理。
- **风险（pdfzh 自己也点）**：无人工校对时自动喂回 TM = 自我污染。→ 我们若做，**只读不自动写**（入库需 `--learn`+高置信门）。
- **A/B**：拿 3+ 份同领域 PDF 连跑，量 fuzzy 命中率、端到端提速%、以及"错误复用"率（近似句被强行复用导致的错译）。

#### C4 实测结论（2026-09-19，`poc/eval-2026/fuzzy-tm.ts`，全书 1999 单元）—— **否决**
- **exact 重复率 5.3%**（现有精确缓存已吃下），**fuzzy(≥0.92) 仅额外 +1.0%**（19/1999）→ 相对现有缓存的增量提速可忽略（35min 里约 20s）。
- **且 fuzzy 命中几乎全是危险样本**：`1.4 Stop and think…` ≈ `2.7 Stop and think…`（0.97，仅编号不同）、`5.2.1 Delegation vs` ≈ `5.2.2…`——复用会把**错误的章节号带进译文**；这类又被我们数字校验器判失败回退，连那 20s 收益都抹平。
- pdfzh 警告的"无 MTPE 时自动喂回 TM 自我污染"在我们语料上实证成立。**结论：fuzzy TM 收益≈0、风险实在，不采纳**；精确内容缓存继续承担复用。风格锚（每批带上一批末 2 句）是独立小改动，若将来做译文一致性再单测，不属本次 TM 否决范围。

### C5 garbage 节点过滤
- pdfzh：不可映射字符(U+FFFD/私有区/无ToUnicode) >20% → 丢弃并记报告，宁少一段不把乱码喂模型。
- 我们有 `dropRepeatedEdgeText`，但无"乱码占比"闸门。**成本极低**，可直接加进 capture 审计 + 单测。
- **A/B**：对含 Type3/ CID 字体的样本，看能否拦下原本会进模型的乱码段（回归用例 R15）。

## 4. 落地顺序（先测后采，已按 C1 实测重排）
1. **C1 = PP-DocLayout-S 版面检测**（朴素几何法实测 8% 已否决，改用检测模型出 bbox → Chromium 栅格化；见 §3-C1 结论）。**提到第一**，成败等价于 PP-DocLayout-S 试验。
2. **C5 garbage 过滤**（半天量级、无依赖、安全兜底，可与 C1 并行先落）。
3. **C2 grammar 结构化输出**（独立于 C1，可并行；先小样验证 tok/s 不掉再 A/B）。
4. **C3 logprob**（先花 10 分钟确认 node-llama-cpp v3.20 API 能取 per-token logprob，取不到即砍）。
5. **C4 fuzzy TM**（最后做，污染风险需 `--learn` 显式门）。
6. 其余 P2：zip 便携验证、pdf-lib 兜底 mono 字体、llama.cpp/node-llama-cpp 升级跟踪（重开投机解码的唯一触发条件）。

> 注：用户已定 **术语表(P1#1) 不做**；其余 P1（图/公式栅格化=C1）与 P2 全做。pdfzh 借鉴项 **一律先过 A/B，赢了才进主线，输了归此文件 §2 否决表**。
