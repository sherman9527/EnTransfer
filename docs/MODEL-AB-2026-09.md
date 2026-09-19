# 小模型选型与权重优化结论（2026-09）

> 用户核心问题：**有没有翻译质量更好、更快的小模型？没有的话，参数/权重能不能优化？**
> 一切结论基于本机（GTX1060 6GB + i5-12600KF）实测，不采信外部榜单。

## 1. 模型 A/B（实测，quality-cases 26 例 + 全书速度）

| 模型 | 质量(26例) | 速度 | 结论 |
|---|---|---|---|
| **Qwen3-1.7B-Q4_K_M（现用）** | **26/26** | ~48 tok/s GPU | ✅ 当前最优 |
| Qwen3.5-2B-Q4_K_M | 24/26（abbr1 术语、longctx 长句挂） | 更慢 | ❌ 更新≠更好，质量速度双输 |
| Qwen3-1.7B-Q3_K_M / IQ2_XXS | 明显下降（此前 E 系列测） | 略快 | ❌ 降比特换速度不值 |
| Hy-MT2-1.8B（MT 专用）Q4 | ≈ 1.7B；2bit/1.25bit 在 node-llama-cpp 3.20/3.21 **加载失败** | — | ❌ 无净收益 |
| 投机解码（0.6B 草稿） | 无损但 | **−27%** | ❌ 本机证伪 |
| 多序列批 | — | 0% | ❌ 无收益 |

**结论 1：没有更好的现成小模型。** 1–2B 段里 Qwen3-1.7B-Q4 是质量/速度帕累托前沿；更大的（3.5-2B、8B）要么装不进 6GB、要么更慢且不一定更准（术语/长句反而退步）。翻译专用小模型（Hy-MT2/NLLB 系）在本代没有跑赢通用 Qwen3 的证据。

## 2. 权重能不能优化？（诚实分层）

- **量化**：已到甜点。Q4_K_M 最优；Q3/IQ2 质量崩（实测）；Q5+ 体积涨、质量增益微弱。**没有"更小还更好"的量化空间**。
- **结构化剪枝 / 蒸馏（大→小）**：理论上"更好的小模型"唯一正道，但——
  - Qwen3-1.7B **本身已是 8B 家族蒸馏产物**；再蒸需要平行语料 + 训练机（GPU 数小时~数天）+ 评测闭环。
  - 剪枝后的架构 GGUF/llama.cpp 支持差，llama.cpp 主线不支持任意稀疏结构。
  - **不是配置能解决的，是一个独立 ML 工程项目。**
- **LoRA（EN→ZH 领域微调）—— 唯一现实的"权重优化"抓手**：
  - 在 1.7B 上挂一个 EN→ZH 技术领域 LoRA（数据：Manning/Delta 等平行句 + 通用 MT 语料），合并进 GGUF。
  - 6GB 显存可训（1.7B LoRA 很轻），产出 +~10–50MB adapter，**质量可超 base**，速度几乎不变。
  - 代价：需要 (a) 干净平行语料（可用现有两本书的译文自举 + 公开 MT 集），(b) 一次训练跑（本机或云），(c) 用 quality-cases + chrF 守门。
  - **这是"更好小模型"最可行的路径，但要单独立项做，不是几行能改完。**

## 3. 不训权重、当下就能拿的质量/速度增益（建议优先做，零风险）

1. **Few-shot 提示**：给 system prompt 加 1–2 条高质量 EN→ZH 范例，专治 abbr1/longctx 类。可用 quality-cases 直接 A/B（有无 few-shot 的 26 例 + 速度）。**零依赖、零体积**。
2. **KV-cache 量化（q8_0）**：省显存 → 更大有效上下文 → 长段落少切分 → longctx 一致性↑。可测。
3. **风格锚**（每批带上一批末 2 句译文）：跨句指代/术语一致，pdfzh 借鉴项，独立于已否决的 fuzzy TM。

## 4. 建议路线
先做 §3.1 few-shot A/B（最快见效、零风险）→ 若质量还想再上一台阶，再立项 §2 LoRA 微调（需平行语料 + 一次训练）。§1 已证明"换现成模型"这条路到顶了。

## 5. 引擎升级跟踪（node-llama-cpp / llama.cpp，2026-09-19）
- 现用 **node-llama-cpp 3.20.0**，最新 **3.21.1**（捆绑 llama.cpp fork build b10361）。
- **3.21.x 没有我们想要的东西**：依赖与 3.20 基本一致；无 model-draft 投机解码 API、无 MTP；Hy-MT2 TQ2/TQ1 低比特**仍加载失败**（3.20 与 3.21.1 都实测过）。投机解码公共 API 面只有 `DraftSequenceTokenPredictor`（已测 −27%）。
- 真正能提速/提质的那几个上游能力——**llama.cpp `--model-draft` 正规投机解码、Qwen3.5-MTP、Hy-MT2 TQ 量化**——都在 upstream llama.cpp，node-llama-cpp 绑定层**尚未暴露**。→ 保持观察：一旦 node-llama-cpp 绑定跟上，重开投机解码（唯一触发条件）。
- 结论：**升级本身无收益**（可仅为 bugfix 升 3.21.1，但非必需）；瓶颈是绑定层特性，不是版本新旧。

## 6. 第二语料验证（Delta Lake，2026-09-19）
- 前 30 页冷跑：201 单元，批次 13/0 回退，校验回退 1.5%，~0.8s/单元，30→13 页(压缩 0.43)。
- 翻译质量：数据工程领域流畅准确（"我们为本书设立了网页，其中列出勘误表…"），URL/邮箱/技术 token 保留完好。
- C1 保守门：文本密集区 0 图（**无误判、无假阳**），符合设计。→ 多语料下 C1 保守门**无回归**。

## 7. MiniCPM5-2B 实测（2026-09-19，ModelScope 下载，用户点名要测）
> 结论先行：**MiniCPM5-2B 质量确实更好，但在我们的部署栈上慢到不可用（3.5 tok/s），且它的加速路径我们用不了。** 不是它不如 Qwen3，是它在我们这套栈上跑不动。

**A/B（同 engine、同 disableReasoning、同 GPU）**：
| 指标 | Qwen3-1.7B-Q4 | MiniCPM5-2B-Q4 |
|---|---|---|
| quality-cases(26) | 26/26 | 25/26（仅 range 挂） |
| 速度(GPU/Vulkan) | **53.5 tok/s** | **3.5 tok/s**（15×慢） |
| 速度(CPU) | ~10–15（估） | **~1–2 tok/s** |
| GPU 层卸载 | 29/29 | **43/43（全卸载）** |
| 体积 | 1.28GB | 1.49GB |
| 领域词 | ❌ "team→球队/manager→教练" | ✅ "团队/管理者" |

**为什么全量卸载到 GPU 还这么慢**（实测非猜测）：
- 两模型都 `offloaded N/N layers to GPU`，但 MiniCPM5 GPU 3.5 vs CPU 1–2 → **GPU 只快 ~2×**（Qwen3 是 ~4–5×）。说明 Vulkan 后端对 MiniCPM5 的算子加速很差：层虽"卸载"，层内关键算子（GQA 16Q/2KV、大词表 LM head、128K RoPE 路径）在 Pascal-Vulkan 上退化/回退 CPU，逐层同步把吞吐拖垮。
- MiniCPM5 更深（43 vs 29 层）+ 510 special tokens + 128K 上下文配置，进一步放大。

**拓展性 / 它比 Qwen3 强在哪（诚实）**：
- **优势真实**：中文/领域更准（修了 team/manager 类错）、原生 **128K 上下文**、官方称 2B-class SOTA（avg 53.9，可与 4B 竞争）、**开放训练数据**（UltraX/UltraData-SFT/RL，对 LoRA 极有用）。
- **官方加速 = DSpark 草稿模型 + SGLang 投机解码**（`--speculative-algorithm DSPARK`），**不是 MTP**（模型无 MTP 头）。但 SGLang 需要现代 CUDA GPU + 独立服务栈——**我们（GTX1060 Pascal + node-llama-cpp + Electron 内嵌）用不了**。
- node-llama-cpp 3.21.1 也没给它 Vulkan 高效内核（实测 3.5 tok/s）。→ **在我们栈上，MiniCPM 的速度硬伤无解**，除非换推理后端（SGLang/新 CUDA 卡）。

**判定**：EnTransfer 现栈继续用 **Qwen3-1.7B-Q4**（唯一能在 1060 上 53 tok/s 的）。MiniCPM5 记为"质量更好但栈不兼容"的候选——**若将来上云/换 CUDA 卡跑 SGLang，MiniCPM5+DSpark 是明显升级**。当前它的领域优势我们改用 **few-shot / LoRA 喂给 Qwen3** 来追（见 §8）。

## 8. 由 A/B 得到的具体行动
- Qwen3 暴露的**唯一实质质量短板 = 领域多义词**（team→球队、manager→教练）。这正是 few-shot（加技术语境范例）和 LoRA（用户英文 PDF 微调）能精准打的点，且 MiniCPM 证明"天花板更高"值得追。
- 下一步（零风险）：few-shot 范例 A/B，目标修 team/manager 类，且不掉速（范例进 system 前缀，被 prefix-KV 复用，边际成本≈0）。

## 9. few-shot A/B 实测（2026-09-19）—— **不采纳**
带领域消歧 + 2 范例的 few-shot system prompt，同模型同配置实测：
- ✅ **确实修好领域错**：`Unless the team trusts its manager` 由 baseline "除非**球队**信任其**教练**" → "除非**团队**信任其**经理**"。
- ❌ **但回归另一例**：quality-cases 26/26 → **25/26**（`range` 案例被带偏）。
- ❌ **且掉速**：micro-bench 57.4 → 47.4 tok/s（−17%，更长 system 前缀每单元重算）。
- 判定：净收益为负（修 1 类、坏 1 类、慢 17%）→ **不采纳**。team/manager 这类领域多义词的正解是 **LoRA**（用你的英文 PDF 微调，既修多义又不牺牲其它、几乎不额外耗时）；few-shot 是廉价近似，此处不划算。
- KV q8_0：仅省显存、非质量/速度增益（现 2048 上下文已够，不触发更长切分），**暂不启用**。

## opus-mt-en-zh (Helsinki, 600M) via CTranslate2 int8 — 2026-09-19 — ❌ REJECTED

自测（不信报告）。下载 Helsinki-NLP/opus-mt-en-zh → CT2 int8（转换 9.2s）→
翻译 poc/speed-v3/corpus.json 的 80 段 Manning 英文（同一套 ≥50 例基准）。
产物：poc/models-bench/out-opus-mt.txt。

- 速度：CPU int8 1.23 段/秒（~224 中文字/秒）——**单看速度尚可**，与 Qwen3-GPU 同量级。
- 质量：**灾难性退化重复**，完全不可用：
  - "更新 。 更新 。 更新 。…"（无限循环）
  - 邮箱/URL 变纯噪声："命令@manning. comcomcomcoms:sords@…"
  - 长句复读："以任何形式或以任何形式…"、"曼宁的政策是让曼宁的政策是让…"
  - 专名打碎："Marddddddddddddddddddd"
- 根因：Marian/NMT 对长、域外段落触发经典 repetition degeneration；且 NMT **无法执行管线指令**
  （代码/表格原样保留、术语锁定、上下文），也处理不了我们编号批次的多段拼接。
- 判定：**不采纳**。Qwen3-1.7B-Q4 仍是正确基座。

## NLLB-200-3.3B — 结论预判（未跑，待用户定夺）

opus-mt 的失败 + 结构性论据已足以回答"专用 NMT 是否更好"= 否。NLLB-3.3B 更大更慢
(3.3B vs 1.7B)、同为非指令式 NMT、同样易复读，几乎不可能改变结论，且下载/转换成本高
(~13GB, hf-mirror 慢)。建议：除非用户坚持，**不投入 NLLB 基准**，维持 Qwen3。
