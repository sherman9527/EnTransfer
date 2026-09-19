# MEMO — Agent 工作日志（滚动记录，防上下文丢失）

> 本文件是 Qoder agent 本次任务的行为日志 + 结论暂存区。最终会整理成正式方案文档。

## 任务（用户指令汇总）
1. 全面梳理 repo 结构，从头跑通。
2. Code review 找 bug。
3. 思考更优方案：翻译质量/速度/效率；允许做 POC；**一切模型下载、测试脚本都放在当前文件夹内**。
4. E2E 测试统一用根目录 `Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf`；只在乎 翻译质量/排版/速度，注脚/页眉不必保留；表格/图片/code 要尽量识别并以更好方式重排。
5. 调研最新开源模型/项目；考虑 无GPU(CPU) 场景：核数识别、动态并发；LLM 参数优化：KV cache / prefill / 上下文窗口。
6. 审视流程本身是否最优（提取→翻译→重排版，每步库/模型选择），并压制 EXE 体积。
7. LLM 权重非翻译专用 → 如能"优化权重/裁剪模型体积"是突破点。（我的回应路线：imatrix 重量化、量化档位扫描、蒸馏小模型——训练 infra 本机没有，列出方案）

## 环境事实
- 机器：GTX 1060 6GB (driver 582.66, Vulkan OK) + i5-12600KF (6P+4E, 16线程) + 32GB RAM。
- 已有模型：models/Qwen3-1.7B-Q4_K_M.gguf (1.28GB)；models/Qwen3-0.6B-Q4_K_M.gguf (484MB, 草稿, 本次下载)。
- node-llama-cpp 3.20.0（npm 最新 3.21.1）。

## 项目架构（已梳理）
Electron33+React18；主进程：queue/JobManager(FIFO单并发+9态状态机+atomic checkpoint) → pipeline.ts（capture→translate(批量合并短段)→typeset→export）；models/：registry(目录+ModelScope URL) / download(断点Range) / engine-manager(单常驻) / llama-engine(node-llama-cpp Vulkan, prefix KV 复用 adaptStateToTokens, disableReasoning)；pdf/capture/flow.ts 1415行启发式（行/段/表格/代码/公式/TOC/页眉页脚/双栏）；pdf/typeset/flow.ts（A4重排+微软雅黑子集）；poc/ 有历史 POC；docs/ 有大量优化记录。

## 历史优化结论（来自 docs，勿重复造轮子）
GPU Vulkan=8x 已是最大头；threads=12；ctx 2048；前缀KV复用已做；temp0.1；batch合并短段≈净持平(45%分隔符丢失)；量化档无Q3/IQ3(当时判断)；KV q8_0 无收益；流水线并行无收益（capture 1.6s/typeset 0.7s 忽略级）。质量遗留：地名/否定词/中英夹杂/人名一致性。8模型横评：qwen3-1.7b 综合第一(4.9质量/70tok/s)，hy-mt2-1.8b 质量同4.9但65tok/s，qwen3-4b 5.0/36tok/s。

## 本次已发现的问题（code review 编号）
- [P0-已修] llama-engine.ts 未提交改动 TDZ：`wantGpu` 在声明前使用（每次 load 必崩）；`gpuLayers > 0` 对 'max' 恒 false（投机永不启用）；未用 import。→ 已修复+typecheck 通过。
- [P0-已修] registry.ts 草稿模型 URL `Qwen/Qwen3-0.6B-GGUF` 无该文件（ModelScope 返回145B JSON）→ App 内下载必失败。已改 lmstudio-community。
- [P1] engine-config contextSize=1024 与 e2e 用 2048 不一致；GPU 时新代码 max(base,4096)→4096。
- [P1] translate() 分句阈值 1800 token 与 ctx 1024/2048 冲突：>ctx 的 prompt 会静默 contextShift 截断（质量风险）。
- [P1] pipeline batch 回退循环（line ~295）无 abort 检查：暂停时分隔符丢失路径会抛 AbortError 给 manager（状态仍正确，但 saveProgress 被跳过）。
- [P2] checkpoint/atomicWrite 共享 `.tmp` 名：manager.onProgress 与 pipeline.saveProgress 并发写同一 checkpoint.json 有 rename 竞态风险（建议唯一 tmp 后缀+写序列化）。
- [P2] storage.ts flushJobs 与 timer 写并发可丢一次目录写（inflight 未链式等待）。
- [P2] ModelsScreen 草稿模型也可"设为默认"（应隐藏）；draft 被设默认=用0.6B翻译。
- [P2] download.ts 最终校验失败时坏文件留在 models/（无清理）。
- [P2] freezeProtected 上限 26 个占位符/段；URL/括号重叠时 §Z§ 之后不冻结（静默）。
- [P2] typeset 无超高块拆分：单个>整页的段落/list/code 会画过页底（当前语料未触发，风险在）。
- [P3] pdfjs OPS 数字硬编码(10/11/12/74/75/85)——版本升级即坏；workerSrc='./pdf.worker.js' 依赖 cwd。
- [P3] 图片按(宽x高)去重匹配，同页同尺寸多图会漏。
- [P3] 'prefixCaching' 传参在 v3.20 不存在（死代码，静默无效）。

## 跑通状态
- npm run build ✓；postbuild ✓；verify 24/24 ✓。
- e2e-test.cjs（esbuild CJS 打包，`--external:electron`，格式必须 cjs）：8页 GPU 17.9s ✓ 输出中文72%。
- electron-vite preview 启动无错 ✓。
- 运行命令备忘：`EN_DEVICE=gpu node .scratch/e2e-test.cjs <pages>`；跑前 `rm -rf .scratch/e2e-jobs`。

## 未提交改动（保留在工作区，属于用户的投机解码 WIP，我已修3处编译bug+1个URL+加了 EN_SPEC_DECODING=0 开关）

## POC 计划与结果（poc/speed-v3/）
- 语料：corpus.json = 80 段真实段落（captureFlow 从 Manning PDF 1-120页提取，120-400字，均值251字）——满足用户 >50 例 A/B 要求。extract-corpus.ts / bench.ts 已建，bench 复刻引擎语义（system 前缀 KV adaptStateToTokens 复用、temp0.1/topK20/topP0.9、prompt 内嵌原文格式）。
- bench.ts 注意：node-llama-cpp 有 TLA，esbuild 必须走 loadLlamaCpp 动态 import 模式（静态 import 会 ERR_REQUIRE_ASYNC_MODULE）。bundle 输出到 .scratch/，所以路径全部用 process.cwd()。
- 运行方式：`node .scratch/poc-bench.cjs --device gpu|cpu --seq N --spec 0|1 --limit N --main PATH --fa 0|1 [--threads T --ctx N]`
- **已测**：Qwen3.5-2B-Q4_K_M (1.33GB, ModelScope unsloth/Qwen3.5-2B-MTP-GGUF) 在 node-llama-cpp 3.20 捆绑 llama.cpp 上 **可直接加载**；CPU seq1 12线程 = 13.6 tok/s（2段冒烟，vs Qwen3-1.7B 基线 ~9 tok/s，+50%）；样本人工看质量良好、无 thinking 泄漏（jinja reasoning:false 生效）。
- GPU A/B 套件运行中（seq1/seq1+spec/seq2/seq4/seq2+spec，各80段）：结果待填 → g1s0/g1s1/g2s0/g4s0/g2s1.json
- MTP 结论（初步）：node-llama-cpp 无 `--spec-type draft-mtp` 等价 API，MTP 头用不上；自投机仍走 DraftSequenceTokenPredictor（外部草稿模型）。若 Qwen3.5 有 0.8B 小兄弟，同分词器草稿可能更配。
- Hy-MT2：research 文档确认项目已测过新版 Hy-MT2-1.8B（65tok/s 质量4.9）→ 1.8B 无增量。**Hy-MT2-30B-A3B (MoE)** 未测，32GB RAM 可装（Q4≈17-19GB），CPU 场景理论=3B激活速度+接近7B质量，待评估。
- 待做：CPU 基线+多序列A/B 80段；表格/图片/code 排版改进小样；EXE 体积清单。

## GPU A/B 实测结果（corpus=80段, ctx2048, temp0.1）
| 模式 | 总时长 | 生成tok/s(聚合) | 段/分钟 | p50段落延迟 |
|---|---|---|---|---|
| seq1 spec0 (基线) | 57.0s | **61.5** | 84.2 | 693ms |
| seq1 spec1 (0.6B草稿投机) | 77.4s | **45.1 (-27%)** | 62.0 | 925ms |
| seq2 ctx8192 | 跑分中 | | | |
| seq4 ctx8192 | 跑分中 | | | |
- 结论1：**WIP 的草稿投机解码在 1060+llama.cpp 上净负收益**（-27%）。原因：draft/target 尺寸比太大(0.6B/1.7B)、Vulkan 下每步 draft 也是完整 forward、接受率不足。→ 建议移除该 WIP 或默认关（EN_SPEC_DECODING=0 开关已加）。llama.cpp 官方数据也只在 CPU/大模型+高接受率场景正收益。
- 结论2：**GPU 多序列共享 context 无收益**：seq2=50.8 tok/s(-17%)、seq4=59.5(-3%)，1060 上并发反被调度/带宽侵蚀。CPU 多序列在跑（c1/c2/c4.json），这是"无GPU动态并发"的关键数据。
- node-llama-cpp 事实：createContext 的 contextSize 是**每序列**配额（内部 cells=ctx×sequences）；默认 sequences=1，多序列必须显式传 sequences:N，否则 getSequence 抛 "No sequences left"。
- **陷阱（bench 第一版踩中）**：`getLlama()` 默认 gpu:'auto'，且 `loadModel()` 的 gpuLayers 默认 "auto"=全部 offload → 想跑纯 CPU 必须 `getLlama({gpu:false})` + `gpuLayers:0` 双保险，否则测出来的"CPU 速度"其实是 GPU。产品代码 llama-engine CPU 路径显式传了 gpuLayers:0 所以结果正确，但 getLlama() 无参仍会初始化 Vulkan 实例（建议改 {gpu:false}，省启动时间和显存）。
- 复核复现性：GPU seq1 两次 61.5 / 62.9 tok/s ✓。

## 表格 POC 结果（table-poc.ts，80→实际300页全部表格）
- 300页共 **8 张表 / 73 个有效单元格**；编号批次（8格/批）**12/12 批 100% 解析成功，0 回退**，22s（vs 现管线 `\n---\n` 45% 丢失率）→ 编号格式完胜，可反哺正文 batch。
- 输出 poc/speed-v3/out-tables-zh.pdf 目检发现真排版 bug：**typeset 等宽列 → 长文本列一字一行竖排**。已修（产品代码）：
  1. capture: detectTables 现在删除全空列 + 输出 `colWidths`（锚点间距权重），ContentBlock 加 colWidths 字段；hasHeader 改为"首行全是短标签"判定（防止长段落行被当表头每页重复——实测发生过）。
  2. typeset: 列宽=0.45×锚点 + 0.55×内容长度混合，MIN_COL_W=48pt 提升+缩放；表格改为逐行绘制+跨页拆分+续页重复真表头+分段画框线。
  3. 修后输出仍需一次目检回归（等 CPU 套件完 GPU 空闲）。
## CPU 实测（强制 gpu:false 后）
- seq1 t12: **7.2 tok/s 聚合**、9.9段/分、p50 5.8s/段（484.7s/80段）。seq2 在跑(7.0 so far——若最终≈7 则 CPU 多序列同样无收益，node-llama-cpp 未合并 decode batch)。seq4 pending。
- 若 seq2/4 无收益 → 产品结论：**保持单序列**；CPU 提速靠量化（2bit/1.25bit 权重带宽减半理论 +~1.8x）。
- **CPU 多序列实测=负结果**：seq1=7.2, seq2=7.2（p50 从 5.8s→10.8s 正好翻倍=纯排队无并行加速），seq4≈7.3。node-llama-cpp 3.20 CPU 后端未按序列合并 decode batch → "动态并发"路线**证伪**，产品保持单序列。CPU 提速唯一杠杆=量化权重带宽（下测 2bit/1.25bit）。
## 产品代码已修清单（今晚）
llama-engine.ts(TDZ/gpuLayers判断/spec开关/分句阈值/maxTokens钳制) registry.ts(草稿URL) engine-config.ts(ctx 1024→2048) download.ts(坏文件清理) capture/flow.ts(空列裁剪+colWidths+hasHeader) typeset/flow.ts(加权列宽+跨页拆分)。typecheck 全绿。

## GPU 模型矩阵结果（同机 80 段）
- Q4 基线复测（CPU 竞争窗口）60.3 ✓ 稳定；fa=1: 63.1 (+2.6%，可白嫖)。
- Qwen3.5-2B: GPU 49.0（更慢）；CPU ~5.3（更慢，早前 2 段冒烟 13.6 为误导小样本）→ 不换代。
- Hy-MT2 2bit/1.25bit: **加载失败**（hunyuan-dense 架构/TQ2_0 布局，3.20 与 3.21.1 隔离安装均失败）→ 极致量化路线等后端支持。
- Qwen3-1.7B-Q3_K_M: GPU 47.8（**比 Q4 慢**！Pascal 解量化 ALU 瓶颈）。IQ2_XXS GPU 在跑；CPU Q3/IQ2 排队（决定"CPU 用户是否降低比特"）。
- poc/speed-v3 隔离装了 node-llama-cpp@3.21.1（poc/speed-v3/node_modules）+ loadtest.mjs 可复用。
- 当前叙事：**GPU 用户维持 Q4_K_M+单序列；CPU 增益看 IQ2 数据；模型体积路线被后端支持卡住（记 roadmap：升级 llama.cpp→解锁 Hy-MT2 极致量化=速度+体积双收益）**。

## 批次格式 A/B（batch-strategy.ts，80段）— 已落地产品
- 现 `\n---\n`×3=回退48.1%、×4=40%；**编号格式×4=回退5%**（含乱序容忍解析）。→ pipeline.ts 短段合并已改编号格式、BATCH_SIZE=4、回退循环补 abort 检查。
- 编号+专用批次提示词 回退10%（双模型驻留拖慢），不必换 prompt，沿用 GENERIC。
- 加 `LlamaCppEngine.tokenizeCount()` 供基准脚本统计 token（POC 用）。
- 待办：改完 pipeline 需重 build+verify+一次 GPU E2E 回归确认无回退率异常。

## 投机解码去留建议
- 实测 -27%（1060）。且 WIP 里 GPU ctx 动态抬到 4096 与投机解码耦合在一起。
- 建议：**移除 draft 投机解码块**（复杂度+双模型显存/资源泄漏风险+负收益），**保留** GPU ctx=4096（对长段落/批量有利、E2E 已验证无害）。当前用 EN_SPEC_DECODING=0 开关默认关，最终版可彻底删代码。

## 收尾进度（时间可能到次日凌晨）
- 待回填：CPU UD-IQ2_XXS（iq2c，跑分中，预期质量崩+速度未必快）。
- 全部数字回填 PROPOSAL-2026-09.md；MEMO 作过程日志。

## 02:05 用户批准三件事，全部当场落地并回归
- A 投机解码删除 ✓（8页冒烟 3/0；registry 草稿条目删除；保留 GPU ctx4096）
- B 表格进产品 ✓（cell 任务+编号批次；8 表格页集成回归 15/15 全解析；EN_INPUT/EN_OUTPUT 环境变量加入 e2e harness）
- C 设置持久化 ✓（electron/settings.ts 新模块，白名单+原子写；outputDir→JobManager.setOutputDir；mirror→download.applyMirror；open-folder 对话框接设置；单测6/6+队列测试+typecheck+build+verify+preview 全绿）
- 模型问题答复：有 1 个"潜力发现"——Hy-MT2 官方 2bit/1.25bit 是"翻译专用+权重裁剪"的现成答案，当前卡在 TQ2_0/TQ1_0 量化张量布局（repo 曾成功跑 Hy-MT2-1.8B-Q4 → 架构本身支持，是量化格式问题；3.21.1 也不行）。待办：用 llama.cpp 官方预编译 exe 直接验证（今晚 GitHub API 查询不顺未做）；ik_llama.cpp 已有 Hy-MT2-30B-A3B 支持请求（社区在跟进）。
- 未 commit：10 个文件改动 + settings.ts + poc/speed-v3/*，等用户决定。

## （上节追加于）01:20 收尾快照
- CPU IQ2 = 4.8(10/80，提前终止，方向已定)。CPU 量化红利彻底证伪（Q3=5.5<Q4=7.2）。
- 编号批次落地 pipeline.ts：30 页真实回归 **回退 50%→0%**（11命中/0回退），期间踩坑：改完源码忘了重建 .scratch/e2e-test.cjs bundle，两次相同假数据才警觉（教训：esbuild 产物必须跟源码同步重建）。
- 附加修正：numberSplit 支持续行拼接（防多行译文被丢）；batchable 加 60 字下限；LlamaCppEngine 加 tokenizeCount()。
- **全书 353 页回归通过（01:13）**：1771 blocks/2025 tasks；批次 **112 命中/5 回退=4.3%**；Pipeline 2082.8s≈**34.7min**（vs 历史 36.4min）；输出 .scratch/e2e-output-zh.pdf 24.9MB 中文校验 OK；无状态机违规。
- 任务全部完成。给用户的回复已发出；方案入口 docs/PROPOSAL-2026-09.md，过程日志=本文件。
- 遗留待办（明日起）：① 决策是否删投机解码 WIP（建议删，保留 GPU ctx4096）② 接线 outputDir/mirrorSource+设置持久化 ③ 表格翻译进产品（table-poc 逻辑移植+回归，注意全书表格 8张/300页，收益中等）④ checkpoint tmp 竞态修复 ⑤ 蒸馏路线评估（云端）⑥ llama.cpp 升级跟踪 Hy-MT2/hunyuan-dense 支持 ⑦ 工作区改动未 commit——等用户过目后决定提交方式。

## 外部调研（新发现）
- Hy-MT2 (2026-05, arXiv 2605.22064)：1.8B/7B/**30B-A3B(MoE)** 官方GGUF（HF tencent/Hy-MT2-1.8B-GGUF）。注意：repo 基准测过的 "hy-mt2" 需要确认是哪个版本（docs/MODEL-BENCHMARK 有 hy-mt2-1.8b 65tok/s 质量4.9 —— 若已是 Hy-MT2 新版则无增量；30B-A3B 未测过，32GB RAM 可行，CPU 场景 MoE=接近小模型速度+大模型质量）。
- Qwen3.5 系列：2B-MTP-GGUF (Q4_K_M 1.3GB) ModelScope 可下；MTP=自投机解码，llama.cpp flags `--spec-type draft-mtp --spec-draft-n-max 2`，unsloth 文档称 160-240 tok/s（高端卡）；GTX1060 收益待测；**要求 llama.cpp 有 MTP PR** —— node-llama-cpp 3.21.1 是否捆绑支持需实测（poc/speed-v3 里独立安装）。
- BabelDOC (funstory-ai, ACL 2026 demo)：布局保留 PDF 翻译参考项目（Python）。
- llama.cpp speculative.md：draft-chain / mtp 多路投机已入主线。

## 下一步（按序）
1. bench.ts 重写（复刻引擎前缀KV复用；worker 槽位 bug 修掉）→ typecheck → extract-corpus → 跑 GPU 基线 + spec A/B + multi-seq。
2. poc/speed-v3 独立装 node-llama-cpp@3.21.1 测 MTP 支持 + 下载 Qwen3.5-2B-MTP 测加载。
3. CPU 场景多序列吞吐（回答"动态并发"）。
4. 表格/图片/code 重排质量改进小样（对照用户新要求）。
5. 汇总方案文档 docs/PROPOSAL-2026-09.md（含 bug 清单、实测数据、推荐路线、EXE 体积方案）。
