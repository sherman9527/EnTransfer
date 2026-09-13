# EnTransfer 翻译引擎选型调研报告

> **场景**：Windows Electron 桌面应用，英文 PDF → 中文 PDF（技术书籍，含代码/表格/图表）
> **约束**：CPU-only、纯离线、模型外挂下载（应用内管理）、翻译质量优先、速度其次
> **用户网络**：中国大陆苏州，HuggingFace 模型下载走 `https://hf-mirror.com` 镜像
> **调研日期**：2026-09-12（v2 增补：超小模型 / 打包策略 / 模型管理 UI 需求）
> **参考项目**：校书郎（node-llama-cpp LLM + CTranslate2 NMT 双引擎，CT2 通过 Python sidecar 运行）
> **POC 测试 PDF**：`C:\Users\_Cole\Desktop\ADEMO\EnTransfer\Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf`（技术书籍，含代码、表格、图表；POC 阶段取前 5-10 页快速验证）

---

## 一、候选方案总览

本次调研覆盖 4 大类、14 个具体模型/引擎：

| # | 方案 | 类型 | 推理引擎 |
|---|------|------|----------|
| 1 | NLLB-200-distilled-600M | NMT (encoder-decoder) | CTranslate2 int8 |
| 2 | NLLB-200-distilled-1.3B | NMT (encoder-decoder) | CTranslate2 int8 |
| 3 | Helsinki-NLP/opus-mt-en-zh | NMT (Marian) | CTranslate2 / ONNX |
| 4 | M2M100 418M / 1.2B | NMT (encoder-decoder) | CTranslate2 |
| 5 | mBART-50 large | NMT (multilingual) | CTranslate2 |
| 6 | Qwen2.5-0.5B-Instruct | 通用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 7 | Qwen2.5-1.5B-Instruct | 通用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 8 | Qwen2.5-3B-Instruct | 通用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 9 | Gemma 2 2B-it | 通用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 10 | Phi-3.5-mini-instruct (3.8B) | 通用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 11 | MiniCPM-2B / MiniCPM3-4B | 中文优化 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 12 | **Hy-MT2-1.8B / 7B** | 翻译专用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 13 | TranslateGemma 4B IT | 翻译专用 LLM (decoder-only) | llama.cpp / node-llama-cpp (GGUF) |
| 14 | Argos Translate (en→zh 包) | NMT (OpenNMT) | Python 库 + sidecar |

---

## 二、超小模型重点对比（<2B 参数及邻近量级）

> 本节是 v2 增补核心：聚焦 CPU 桌面场景下"能塞进用户内存、下载不痛苦、翻译质量够用"的甜点区模型。

### 2.1 体积 / 速度 / 质量一览

| 模型 | 参数量 | 推荐量化 | 量化后体积 | CPU 内存占用 | CPU 实测速度（i7/i9 笔记本） | en→zh 技术文档质量 | 中文理解能力 |
|------|--------|----------|-----------|-------------|---------------------------|-------------------|-------------|
| **NLLB-200-distilled-600M** | 0.6B | CT2 int8 | **~529 MB** | ~800 MB | **~860 token/s**（句均 100-200 ms）；最快 | ★★★★☆ FLORES en→zh BLEU 35.2；句子级，长句截断 | 弱（非中文优化，句子级无上下文） |
| **opus-mt-en-zh** | ~0.06B（Marian base） | CT2 int8 | **~70-80 MB** | ~150-300 MB | 50-200 ms/句；~6 句/秒 | ★★★☆☆ Tatoeba 36.1 BLEU；LayoutTranslateBench chrF 37.26（低于 NLLB） | 弱（2020-2021 旧数据） |
| M2M100 418M | 0.42B | int8 | ~220 MB | ~500 MB | 比 NLLB-600M 快 20-30% | ★★☆☆☆ 已被 NLLB 取代 | 弱 |
| **Qwen2.5-0.5B-Instruct** | 0.5B | Q4_K_M | **~400 MB** | ~1.0 GB | **~12-30 tok/s**（强 CPU 可达 50）；最快 LLM | ★★☆☆☆ 技术文档翻译漏译/直译明显，不推荐书籍翻译 | 中（中文尚可，但 0.5B 理解力有限） |
| **Qwen2.5-1.5B-Instruct** | 1.5B | Q4_K_M | **~1.1 GB** | ~2.3 GB | **~6-7 tok/s**（TechRxiv 实测 7.19 TPS） | ★★★☆☆ 可读但偶有漏译；长句处理一般 | 较好（中文 4/5） |
| **Qwen2.5-3B-Instruct** | 3B | Q4_K_M | **~2.0 GB** | ~3.5 GB | ~3-5 tok/s | ★★★★☆ 技术文档流畅，可指令保留代码 | 好（中文 5/5，英文 4/5） |
| **Gemma 2 2B-it** | 2.6B | Q4_K_M | **~1.6-1.8 GB** | ~3.0 GB | ~3-5 tok/s | ★★★☆☆ 通用能力强但中文非母语优化；中文 benchmark 52.6 | 中（中文 benchmark 中等） |
| **Phi-3.5-mini-instruct** | 3.8B | Q4_K_M | **~2.3 GB** | ~3.0 GB | **~5-10 tok/s**（8 核笔记本；官方称 20-35 tok/s 为优化后） | ★★★☆☆ 推理/代码强，中文翻译一般；C-Eval 65.3 | 中偏弱（中文 benchmark 52.6，英文优先） |
| **MiniCPM-2B** | 2.7B（2.4B 非嵌入） | Q4_K_M | **~1.5 GB** | ~2.5 GB | ~4-6 tok/s | ★★★★☆ **中文优化**，SFT 后中文/数学/代码优于 Mistral-7B | **强（面壁+清华，中文原生优化）** |
| **MiniCPM3-4B** | 4B | Q4_K_M | **~2.5 GB** | ~4.0 GB | ~3-5 tok/s | ★★★★☆ 官方称整体超 Phi-3.5-mini 和 GPT-3.5-Turbo，对标 7B-9B | **强（中文优化，Apache-2.0）** |
| **Hy-MT2-1.8B** | 1.8B | Q4_K_M | **~1.2 GB** | ~1.5-2.0 GB | **~7 tok/s**（Rust 实现 CPU 实测） | ★★★★★ WMT25 中英 COMET 89.6，超越 Microsoft/豆包商用 API | 强（腾讯，翻译专项训练） |
| Hy-MT2-7B | 7B | Q4_K_M | ~4.5 GB | ~6-7 GB | ~2-3 tok/s | ★★★★★ 更高一档 | 强 |
| TranslateGemma 4B IT | 4B | Q4_K_M | ~2.6 GB | ~4-5 GB | ~3-5 tok/s | ★★★★☆ Google 2026.1 发布，55 语言 | 较好 |
| Argos Translate en→zh | ~0.1-0.3B | int8 | ~100-300 MB | ~500 MB | 句均 120-200 ms | ★★★☆☆ chrF 54.6（NLLB 56.1） | 弱 |

### 2.2 超小模型选型结论

- **能直接打包进 EXE（<500 MB）的翻译模型**：仅 **opus-mt-en-zh int8（~80 MB）** 和 **Qwen2.5-0.5B Q4_K_M（~400 MB）**。但两者翻译质量都不够撑技术书籍，不建议作为唯一引擎。
- **CPU 速度与质量的甜点**：**Hy-MT2-1.8B Q4_K_M（~1.2 GB，~7 tok/s）** 和 **MiniCPM-2B Q4_K_M（~1.5 GB，中文优化）**。
- **不推荐用于书籍翻译的**：Qwen2.5-0.5B（质量不足）、Gemma 2 2B（中文非母语优化）、Phi-3.5-mini（英文优先，中文翻译 benchmark 仅 52.6）。
- **NMT 阵营**：NLLB-600M 速度碾压但 CC-BY-NC 禁止商用；opus-mt-en-zh 体积最小、MIT 许可，但质量明显弱于 LLM 方案。

---

## 三、全维度对比表

### 3.1 翻译质量（en→zh，技术文档/书籍场景）

| 方案 | en→zh 质量评级 | BLEU / chrF 参考 | 长句/上下文 | 术语一致性 | 代码/表格处理 |
|------|---------------|------------------|-------------|-----------|--------------|
| NLLB-200-distilled-600M | ★★★★☆ | FLORES-200 en→zh BLEU ≈35.2（保留 3.3B 全量 92.3%）；LayoutTranslateBench LTB-100 = 73.71 | 句子级，最长 512 token，长句易截断 | 弱（无上下文） | 差（代码块会被翻译/破坏） |
| NLLB-200-distilled-1.3B | ★★★★☆ | 比 600M 提升约 1-2 BLEU，FLORES en→zh ≈36-37 | 句子级 | 弱 | 差 |
| opus-mt-en-zh | ★★★☆☆ | Tatoeba 36.1 BLEU（zh→en 反向）；LayoutTranslateBench LTB-100 = 68.60，chrF 37.26（明显低于 NLLB 47.61） | 单方向模型，≤256 token | 弱 | 差 |
| M2M100 418M/1.2B | ★★☆☆☆ | 已被 NLLB 全面取代；实测 en→zh 质量弱于 NLLB-600M | 句子级 | 弱 | 差 |
| mBART-50 | ★★☆☆☆ | 50 语言通用，en→zh 非主力方向，质量一般 | 句子级 | 弱 | 差 |
| Qwen2.5-0.5B-Instruct | ★★☆☆☆ | 通用小模型，技术文档翻译漏译明显 | 32K 上下文但理解力不足 | 弱 | 差 |
| Qwen2.5-1.5B-Instruct | ★★★☆☆ | 通用 LLM，非翻译专项；en→zh 可读但偶有漏译/直译感 | 8K 上下文，段落级连贯 | 中（可通过 prompt 约束） | 中（能识别代码块但不稳定） |
| Qwen2.5-3B-Instruct | ★★★★☆ | 中文能力满星（5/5），英文 4/5；技术文档翻译流畅度接近人工初译 | 8K 上下文，长段落理解好 | 较好（prompt 可注入术语表） | 较好（可指令保留代码/表格格式） |
| Gemma 2 2B-it | ★★★☆☆ | MMLU 51.3%，但中文 benchmark 52.6，非中文优化 | 8K 上下文 | 中 | 中 |
| Phi-3.5-mini-instruct | ★★★☆☆ | C-Eval 65.3，中文 benchmark 52.6；代码/推理强但翻译一般 | 128K 上下文（长文优势） | 中 | 较好（代码强） |
| MiniCPM-2B | ★★★★☆ | 中文原生优化，SFT 后中文/数学/代码优于 Mistral-7B | 32K-128K 上下文 | 较好 | 较好 |
| MiniCPM3-4B | ★★★★☆ | 官方称超 Phi-3.5-mini 和 GPT-3.5-Turbo，对标 7B-9B | 更长上下文 | 好 | 好 |
| **Hy-MT2-1.8B** | ★★★★★ | WMT25 中英翻译 COMET 89.6，论文称超越 Microsoft Translator / 豆包翻译；FLORES-200 平均 BLEU 接近 Gemini-1.5-Pro | 翻译专用 prompt，支持段落级；"快思考"专为真实场景设计 | 好（指令遵循能力强，可注入术语） | 好（训练数据含技术文档，支持结构化翻译） |
| Hy-MT2-7B | ★★★★★ | 比 1.8B 再上一档，接近 DeepSeek-V4-Pro / Kimi K2.6 快思考水平 | 同上，更长上下文 | 很好 | 很好 |
| TranslateGemma 4B IT | ★★★★☆ | Google 2026.1 发布，Gemma 3 基座翻译 SFT；55 语言；社区实测 en→zh 基础质量好 | 上下文较好 | 好 | 较好 |
| Argos Translate (en→zh) | ★★★☆☆ | THOTH 评测：中文 chrF 54.6（NLLB 56.1）；句子级上下文 | 句子级 | 弱 | 差 |

### 3.2 离线能力、Node.js/Electron 集成、许可、活跃度

| 方案 | 完全离线 | 首次下载后缓存 | Node/Electron 集成方式 | 集成复杂度 | 许可协议 | 活跃度（2024-2026） |
|------|---------|---------------|----------------------|-----------|---------|-------------------|
| NLLB-200-distilled-600M | ✅ | ✅ 下载 CT2 格式模型即可 | **Python sidecar**（CT2 官方仅 Python/C++ 绑定）；需打包 Python 运行时或用 PyInstaller 打成单 exe | 中（需维护 sidecar） | **CC-BY-NC 4.0（禁止商用！）** | Meta 2022 发布，模型不再更新；CT2 仍活跃维护（4.7.x） |
| NLLB-200-distilled-1.3B | ✅ | ✅ | 同上 | 中 | **CC-BY-NC 4.0（禁止商用！）** | 同上 |
| opus-mt-en-zh | ✅ | ✅ | Python sidecar（CT2 转换）或 ONNX Runtime（可纯 Node） | 中-低（ONNX 路线可纯 JS） | **MIT / CC-BY-4.0**（商用友好） | Helsinki-NLP 模型 2020-2021 训练数据，不再更新；但稳定可用 |
| M2M100 | ✅ | ✅ | Python sidecar | 中 | MIT（代码）/ CC-BY-NC（模型，与 NLLB 同系） | 已被 NLLB 取代，**不推荐新项目采用** |
| mBART-50 | ✅ | ✅ | Python sidecar | 中 | MIT（代码）/ CC-BY-NC（模型） | 2020 模型，老旧 |
| Qwen2.5-0.5B/1.5B/3B-Instruct | ✅ | ✅ 下载 .gguf 文件 | **node-llama-cpp 原生绑定**（官方支持 Electron 主进程；`@electron/llm` 官方封装） | **低（推荐）** | **Qwen License（类 Apache 2.0，可商用；>1 亿 MAU 需单独申请）** | Qwen2.5 系列 2024.9 发布，持续维护；node-llama-cpp 活跃（2026.7 更新 Electron 指南） |
| Gemma 2 2B-it | ✅ | ✅ | node-llama-cpp 原生绑定 | 低 | **Gemma Terms of Use**（可商用，有使用限制） | 2024.7 发布，已被 Gemma 3 / TranslateGemma 取代 |
| Phi-3.5-mini-instruct | ✅ | ✅ | node-llama-cpp 原生绑定 | 低 | **MIT**（微软，最宽松） | 2024.8 发布，活跃；但中文翻译非强项 |
| MiniCPM-2B / MiniCPM3-4B | ✅ | ✅ | node-llama-cpp 原生绑定（OpenBMB 官方提供 GGUF） | 低 | **Apache-2.0**（MiniCPM3 起） | 面壁智能持续迭代（2026 已到 MiniCPM5），中文优化 |
| **Hy-MT2-1.8B / 7B** | ✅ | ✅ 下载 .gguf 文件 | **node-llama-cpp 原生绑定**（GGUF 格式，llama.cpp 原生支持） | **低（推荐）** | **Tencent Hunyuan Open Model License（Apache-2.0 系，可商用）** | **2025.12 / 2026.5 刚开源，当前最活跃**；GGUF 社区量化版本丰富 |
| TranslateGemma 4B IT | ✅ | ✅ 下载 .gguf 文件 | node-llama-cpp 原生绑定（已有 live-translate 等 Electron 集成先例） | 低 | **Gemma Terms of Use**（可商用，但有使用限制） | 2026.1 Google 发布，活跃；GGUF 社区转换版本已可用 |
| Argos Translate en→zh | ✅ | ✅ 下载语言包 | **Python sidecar 进程**（Argos 仅 Python；无 Node 原生绑定） | 中-高（需打包 Python + pip 依赖） | MIT / CC0（引擎与模型均宽松） | 活跃维护（2025-2026 仍有更新），但 en→zh 模型训练数据偏旧 |
| deep-translator | ❌ | ❌ 封装在线 API（Google/DeepL 等） | N/A | N/A | N/A | **不符合离线要求，直接排除** |
| Stanza | ⚠️ | 需下载模型但非翻译专用 | Python sidecar | 高 | Apache-2.0 | 活跃，但翻译质量不如专用 MT 模型 |

---

## 四、模型打包策略：集成 vs 外挂下载

### 4.1 决策原则

| 量化后体积 | 策略 | 理由 |
|-----------|------|------|
| **< 500 MB** | **直接打包进 EXE（开箱即用）** | 下载不痛苦，用户首次启动即可翻译，无需等待；electron-builder 体积增加可接受 |
| **> 500 MB** | **外挂下载（应用内模型管理 UI）** | EXE 体积可控；用户按需下载；支持多模型切换和未来模型升级 |

### 4.2 各候选模型打包建议

| 模型 | 量化后体积 | 打包建议 | 说明 |
|------|-----------|---------|------|
| opus-mt-en-zh (int8) | ~80 MB | ✅ **打包进 EXE** | 作为"开箱即用兜底引擎"，即便用户网络不好也能翻译 |
| Qwen2.5-0.5B-Instruct Q4_K_M | ~400 MB | ⚠️ 可选打包 | 质量不足以主用，不建议占体积 |
| NLLB-200-distilled-600M int8 | ~529 MB | 📦 **外挂下载** | 刚好超过 500 MB 线；且 CC-BY-NC 非商用，不建议打进商用 EXE |
| **Hy-MT2-1.8B Q4_K_M** | **~1.2 GB** | 📦 **外挂下载（主推荐）** | 主引擎，用户首次使用时引导下载 |
| Hy-MT2-1.8B 2-bit/STQ1_0 | ~440 MB | ✅ 可打包（低配版） | 若想"开箱即用低配版"，可打包此版本作为默认；但质量略降 |
| Qwen2.5-1.5B-Instruct Q4_K_M | ~1.1 GB | 📦 外挂下载 | 备选 LLM 引擎 |
| Qwen2.5-3B-Instruct Q4_K_M | ~2.0 GB | 📦 外挂下载 | 高质量备选 |
| Gemma 2 2B-it Q4_K_M | ~1.6 GB | 📦 外挂下载 | 不推荐主用 |
| Phi-3.5-mini Q4_K_M | ~2.3 GB | 📦 外挂下载 | 不推荐主用 |
| MiniCPM-2B Q4_K_M | ~1.5 GB | 📦 外挂下载 | 中文优化备选 |
| MiniCPM3-4B Q4_K_M | ~2.5 GB | 📦 外挂下载 | 高质量中文备选 |
| Hy-MT2-7B Q4_K_M | ~4.5 GB | 📦 外挂下载（可选） | 高性能用户选项 |
| TranslateGemma 4B IT Q4_K_M | ~2.6 GB | 📦 外挂下载 | 可选 |
| Argos Translate en→zh | ~100-300 MB | 📦 外挂（需 Python 运行时） | sidecar 方案另算 |

### 4.3 推荐打包方案

```
EnTransfer EXE（electron-builder 产物）
├── 内置模型（< 500MB，开箱即用）
│   └── opus-mt-en-zh-ct2-int8 (~80 MB)  ← 兜底快速引擎，Python sidecar
│       或 Hy-MT2-1.8B-STQ1_0 (~440 MB)  ← 若接受 LLM 低配版作为默认
│
└── 用户外挂下载（应用内模型管理）
    ├── Hy-MT2-1.8B-Q4_K_M.gguf (~1.2 GB)      ← 主推荐引擎
    ├── Qwen2.5-3B-Instruct-Q4_K_M.gguf (~2.0 GB)  ← 高质量备选
    └── (可选) Hy-MT2-7B-Q4_K_M.gguf (~4.5 GB)      ← 高性能用户
```

### 4.4 electron-builder asarUnpack 配置说明

`node-llama-cpp` 包含原生二进制（.node），**不能打进 asar 归档**，必须设为 unpacked：

```javascript
// electron-builder.config.js
module.exports = {
  asar: true,
  asarUnpack: [
    "node_modules/node-llama-cpp/**",        // 原生绑定必须解包
    "node_modules/llama.cpp/**",             // 若使用预编译 sidecar
    "resources/models/**",                   // 内置模型文件解包（可选）
  ],
  extraResources: [
    { from: "resources/models/", to: "models" },  // 内置模型放到 resources/models
  ],
};
```

模型运行时路径解析逻辑：
```typescript
// 优先用用户已下载的外挂模型（app.getPath('userData')/models/）
// 否则回退到 EXE 内置的兜底模型（process.resourcesPath/models/）
```

---

## 五、模型管理 UI 需求（供后续实现参考）

> 本节记录产品需求，不涉及具体实现。

### 5.1 模型列表页

| 列 | 说明 |
|----|------|
| 名称 | 如 "Hy-MT2-1.8B（推荐主引擎）" |
| 大小 | 量化后体积（如 1.2 GB） |
| 描述 | 翻译质量评级、适用场景、许可协议 |
| 状态 | **未下载 / 下载中 / 安装中 / Ready / 失败** |
| 操作按钮 | 下载 / 暂停 / 继续 / 删除 / 设为默认 |

状态机：
```
未下载 → 下载中 → 安装中（校验 SHA256 + 解压） → Ready
                ↘ 失败（可重试）
Ready → 删除 → 未下载
```

### 5.2 下载进度 UI

必须展示：
- **百分比**（0-100%）
- **已下载 / 总大小**（如 "456 MB / 1.2 GB"）
- **下载速度**（如 "3.2 MB/s"）
- **预计剩余时间**（ETR）

技术要点：
- 使用 `https://hf-mirror.com/<repo>/resolve/main/<file>` 直链下载
- 支持断点续传（HTTP Range 请求）
- 下载完成后校验 SHA256（与模型卡片公布值比对）
- 大文件（>1 GB）建议显示磁盘剩余空间检查

### 5.3 安装进度 UI

下载完成后展示：
- **"安装中 / 解压中"**（若为 zip/tar 包）
- **"校验中"**（SHA256 校验）
- 校验通过后状态切换为 **绿色 "Ready"** 标识

### 5.4 已下载模型

- 绿色 "Ready" 徽标
- 显示最后使用时间
- 支持"设为默认引擎"
- 支持删除释放磁盘空间

---

## 六、前三名推荐方案

### 🥇 第一名：Hy-MT2-1.8B-Instruct（GGUF Q4_K_M）— 翻译质量优先 + CPU 可接受速度

**推荐理由**：
1. **翻译质量专为 en↔zh 优化**：腾讯 2025.12 / 2026.5 开源的翻译专用模型，WMT25 中英翻译 COMET 89.6，论文自评在三项指标上超越 Microsoft Translator 和豆包翻译；FLORES-200 平均 BLEU 接近 Gemini-1.5-Pro。这是当前开源 en→zh 翻译模型里"小参数量 × 高质量"的最佳点。
2. **CPU 速度可接受**：1.8B 参数 Q4_K_M 约 1.2 GB，CPU 实测 ~7 token/s（Rust 实现），一段 500 字技术段落约 30-60 秒完成，对离线桌面应用可接受。
3. **Node.js/Electron 集成最顺**：GGUF 格式，通过 `node-llama-cpp` 原生调用，无需 Python sidecar，与校书郎的 LLM 引擎架构一致。
4. **商用许可干净**：Tencent Hunyuan Open Model License（Apache-2.0 系），无 NLLB 的 NC 限制。
5. **术语一致性/长句处理**：翻译专用模型 + 指令遵循能力，可在 prompt 中注入术语表、要求保留代码块和表格，适合技术书籍翻译。

**模型下载**：
- HuggingFace 官方（需镜像）：`https://hf-mirror.com/tencent/Hy-MT2-1.8B`（原始 bf16 权重）
- **推荐直接用社区 GGUF 量化版**：
  - `https://hf-mirror.com/bartowski/Hy-MT2-1.8B-GGUF` → 选 `Q4_K_M`（约 1.2 GB）
  - 或 `https://hf-mirror.com/AngelSlim/Hy-MT2-1.8B-2Bit-GGUF`（极端 2-bit，440 MB，速度快 1.5 倍，质量略降，适合低配机，也可作为打包进 EXE 的候选）
- ModelScope 国内直链（备选，无需镜像）：`https://modelscope.cn/models/tencent/Hy-MT2-1.8B`

### 🥈 第二名：Qwen2.5-3B-Instruct（GGUF Q4_K_M）— 通用理解强、可处理复杂排版

**推荐理由**：
1. **中文理解能力强**：Qwen2.5-3B 中文能力 5/5、英文 4/5，技术书籍中的长难句、代码注释、上下文指代处理优于 1.5B。
2. **格式保留能力好**：可通过 system prompt 明确要求"保留代码块/表格/Markdown 格式，仅翻译正文"，对 Manning 这类技术书籍场景尤其重要。
3. **生态成熟**：Qwen2.5 GGUF 是 node-llama-cpp / Ollama 生态里测试最充分的小模型，文档和社区案例最多；`@electron/llm`（Electron 官方 LLM 封装）底层就是 node-llama-cpp。
4. **许可友好**：Qwen License，可商用（仅 >1 亿 MAU 需单独申请，桌面应用不触发）。

**代价**：CPU 上 ~3-5 token/s，比 Hy-MT2-1.8B 慢约 40-50%；翻译质量上"翻译专用性"略逊于 Hy-MT2（Hy-MT2 在 WMT 指标上专门训练过）。

**模型下载**：
- `https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF` → 选 `qwen2.5-3b-instruct-q4_k_m.gguf`（约 2.0 GB）
- 低配备选：`https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF` → `q4_k_m`（约 1.1 GB，~6-7 tok/s，质量略降）

### 🥉 第三名：NLLB-200-distilled-600M int8（CTranslate2）— 快速草稿模式 / 对照引擎

**推荐理由**：
1. **速度碾压级**：CT2 int8 下 ~860 token/s，是 LLM 方案的 100 倍以上；整本书 PDF 翻译分钟级完成。
2. **质量在 NMT 里算优秀**：FLORES-200 en→zh BLEU 35.2，LayoutTranslateBench LTB-100 = 73.71（接近 DeepL Text API 的 78.20）。
3. **校书郎同款架构**：CT2 作为 sidecar Python 进程运行，可作为"快速初稿引擎"，Hy-MT2/Qwen 作为"精翻引擎"，双引擎切换。
4. **模型体积极小**：int8 仅 529 MB，下载快。

**⚠️ 致命限制：CC-BY-NC 4.0 许可，禁止商用。** 仅适合：
- 个人/开源免费产品内部使用
- 作为开发期快速草稿引擎
- 若 EnTransfer 未来商业化，必须替换为 Opus-MT（MIT）或 MADLAD-400（Apache）作为 NMT 替代

**模型下载**：
- `https://hf-mirror.com/facebook/nllb-200-distilled-600M`（原始 transformers 权重，首次启动用 `ct2-transformers-converter` 转换 + int8 量化）
- 预转换 CT2 int8 版（社区）：`https://hf-mirror.com/ctrgoeth/nllb-200-distilled-600M-int8-ct2` 或自行转换
- 商用替代（若需要）：`https://hf-mirror.com/Helsinki-NLP/opus-mt-en-zh`（~280 MB，MIT，但质量略低）

---

## 七、最终推荐方案

### 主推荐：Hy-MT2-1.8B-Instruct Q4_K_M（node-llama-cpp）

在"**翻译质量优先、CPU-only、Electron 集成**"三个约束下，这是当前（2026.9）的最优解：

| 维度 | 表现 |
|------|------|
| 翻译质量 | en→zh 开源第一梯队（WMT25 超越 Microsoft/豆包商用 API 的官方评测） |
| CPU 速度 | ~7 tok/s，1.8B 小模型在 CPU 上的甜点 |
| 模型体积 | Q4_K_M 约 1.2 GB，应用内下载友好 |
| 离线 | 完全离线，下载 GGUF 后无需网络 |
| Electron 集成 | node-llama-cpp 原生绑定，主进程调用，**无需 Python sidecar** |
| 许可 | Apache-2.0 系，商用无忧 |
| 活跃度 | 2025.12 首发 / 2026.5 第二代，最新 |

**技术集成路径**：
```
Electron Main Process
  └── node-llama-cpp (npm install node-llama-cpp)
        └── Hy-MT2-1.8B-Q4_K_M.gguf (~1.2GB, 应用内下载)
              └── 翻译 prompt: "<用户文本>\n请将以上英文翻译为中文，保留代码块和表格格式"
```
- node-llama-cpp 官方明确支持 Electron（仅主进程，渲染进程通过 IPC 通信）
- electron-builder 需将 `node-llama-cpp` 设为 unpacked module（不能打进 asar）
- 模型下载走 `https://hf-mirror.com/bartowski/Hy-MT2-1.8B-GGUF/resolve/main/...`

### 备选方案

| 场景 | 备选 | 理由 |
|------|------|------|
| 用户机器性能弱（8GB 内存以下） | Hy-MT2-1.8B **2-bit / STQ1_0**（440 MB） | AngelSlim 极端量化，速度再快 1.5x，质量损失可接受；也可考虑打包进 EXE |
| 追求极致翻译质量、可接受慢速 | Hy-MT2-7B Q4_K_M（~4.5 GB） | 质量再升一档，但 CPU 仅 ~2-3 tok/s，适合高性能台式机 |
| 需要通用 LLM 能力（翻译+排版理解一体） | Qwen2.5-3B-Instruct Q4_K_M | 中文生态最成熟，prompt 工程资料最多 |
| 中文原生优化偏好 | MiniCPM3-4B Q4_K_M（~2.5 GB） | 面壁智能，Apache-2.0，中文 SFT 充分 |
| 需要"秒出草稿"快速模式 | NLLB-200-distilled-600M int8（CT2 sidecar） | 速度 100x 提升，但**注意 CC-BY-NC 非商用** |
| 必须商用 + NMT 路线 | opus-mt-en-zh（CT2 int8，~80 MB） | MIT 许可，体积最小可打包，但质量明显弱于 LLM 方案 |

### 不推荐的方案

- **M2M100 / mBART-50**：2020 年模型，已被 NLLB 全面取代，en→zh 质量差。
- **deep-translator**：本质是在线 API 封装，不符合离线要求。
- **Argos Translate 作为主引擎**：en→zh chrF 54.6 略逊于 NLLB，且必须 Python sidecar，集成成本高于 GGUF 路线；适合已有 Python 技术栈的团队。
- **Qwen2.5-0.5B**：CPU 上虽快（~12-30 tok/s），但 0.5B 翻译质量明显不足，长句和术语处理差，不推荐用于书籍翻译。
- **Gemma 2 2B-it**：通用能力尚可但中文非母语优化，中文 benchmark 仅 52.6，翻译质量不如 Qwen2.5-1.5B 和 MiniCPM。
- **Phi-3.5-mini-instruct**：代码/推理强但中文翻译 benchmark 52.6，英文优先，不适合 en→zh 书籍翻译主用。

---

## 八、下载地址汇总（含 hf-mirror 镜像）

> 中国大陆下载规则：将 `https://huggingface.co/` 替换为 `https://hf-mirror.com/` 即可。

| 模型 | HuggingFace 镜像 URL | 推荐量化文件 |
|------|---------------------|-------------|
| **Hy-MT2-1.8B（主推荐）** | `https://hf-mirror.com/bartowski/Hy-MT2-1.8B-GGUF` | `Hy-MT2-1.8B.Q4_K_M.gguf` (~1.2 GB) |
| Hy-MT2-1.8B 极致量化 | `https://hf-mirror.com/AngelSlim/Hy-MT2-1.8B-2Bit-GGUF` | `*STQ1_0.gguf` (~440 MB) |
| Hy-MT2-7B（高质量备选） | `https://hf-mirror.com/bartowski/Hy-MT2-7B-GGUF` | `Hy-MT2-7B.Q4_K_M.gguf` (~4.5 GB) |
| Qwen2.5-3B-Instruct | `https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF` | `qwen2.5-3b-instruct-q4_k_m.gguf` (~2.0 GB) |
| Qwen2.5-1.5B-Instruct | `https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF` | `qwen2.5-1.5b-instruct-q4_k_m.gguf` (~1.1 GB) |
| Qwen2.5-0.5B-Instruct | `https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF` | `qwen2.5-0.5b-instruct-q4_k_m.gguf` (~400 MB) |
| Gemma 2 2B-it | `https://hf-mirror.com/lmstudio-community/gemma-2-2b-it-GGUF` | `*Q4_K_M.gguf` (~1.6 GB) |
| Phi-3.5-mini-instruct | `https://hf-mirror.com/bartowski/Phi-3.5-mini-instruct-GGUF` | `*Q4_K_M.gguf` (~2.3 GB) |
| MiniCPM3-4B | `https://hf-mirror.com/openbmb/MiniCPM3-4B-GGUF` | `*Q4_K_M.gguf` (~2.5 GB) |
| TranslateGemma 4B IT | `https://hf-mirror.com/vjchou/translategemma-4b-it-GGUF` | `*Q4_K_M.gguf` (~2.6 GB) |
| NLLB-200-distilled-600M | `https://hf-mirror.com/facebook/nllb-200-distilled-600M` | 原始权重，需 CT2 转换为 int8 |
| opus-mt-en-zh（商用 NMT 替代） | `https://hf-mirror.com/Helsinki-NLP/opus-mt-en-zh` | 原始权重，CT2 int8 转换后 ~80 MB |

---

## 九、POC 验证计划

- **测试 PDF**：`C:\Users\_Cole\Desktop\ADEMO\EnTransfer\Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf`
- **验证范围**：前 5-10 页（含正文段落、代码块、表格、图表标题）
- **验证流程**：
  1. PDF 文本提取（保持段落/代码块边界）
  2. 分别用 Hy-MT2-1.8B Q4_K_M 和 Qwen2.5-3B Q4_K_M 翻译
  3. 人工对照原文，评估：术语一致性、代码块完整性、长句流畅度、表格格式保留
  4. 记录每页翻译耗时，验证 CPU 速度假设
  5. 若 NLLB-600M int8 可 sidecar 运行，同时记录其快速草稿质量

---

## 十、来源 URL 索引

1. CTranslate2 官方 benchmark（int8 860 tok/s）：https://github.com/OpenNMT/CTranslate2
2. CTranslate2 PyPI：https://pypi.org/project/ctranslate2/4.7.2/
3. NLLB-200 选型指南（FLORES en→zh BLEU 35.2）：https://blog.csdn.net/gitblog_02465/article/details/149626552
4. NLLB 许可 CC-BY-NC：https://github.com/facebookresearch/fairseq/blob/nllb/README.md
5. NLLB 非商用提醒（Picovoice）：https://picovoice.ai/blog/open-source-translation/
6. LayoutTranslateBench（NLLB vs opus-mt vs DeepL）：https://github.com/Lawrenzho-bit/LayoutTranslateBench
7. opus-mt-en-zh 模型规格（Qualcomm）：https://aihub.qualcomm.com/mobile/models/opus_mt_en_zh
8. opus-mt 推理延迟：https://github.com/hacklaen/opus-mt
9. Qwen2.5 CPU benchmark（TechRxiv 论文，1.5B 7.19 TPS）：https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.177155881.14671832/v1
10. Qwen2.5 CPU 实测（Qiita）：https://qiita.com/kenimo49/items/d97d79fd02c95b2b9ee8
11. Qwen2.5 硬件指南（量化体积表）：https://github.com/Lingdas1/local-llm-guide/blob/main/02-hardware-guide/README.md
12. Qwen2.5-0.5B CPU 速度（llama.cpp discussion）：https://github.com/ggml-org/llama.cpp/discussions/19813
13. Hy-MT2 官方 GitHub：https://github.com/Tencent-Hunyuan/Hy-MT2
14. Hy-MT2 技术报告（arXiv）：https://arxiv.org/abs/2605.22064
15. hy-mt-rs CPU 速度实测（~7 tok/s）：https://github.com/n0madic/hy-mt-rs
16. Hy-MT2 benchmark（neosun100）：https://github.com/neosun100/hy-mt/blob/main/docs/BENCHMARK_REPORT.md
17. Hy-MT2 1.8B 2-bit 量化（440MB）：https://huggingface.co/AngelSlim/Hy-MT2-1.8B-2Bit-GGUF
18. TranslateGemma 4B GGUF：https://huggingface.co/vjchou/translategemma-4b-it-GGUF
19. TranslateGemma 技术报告：https://arxiv.org/pdf/2601.09012v3
20. Argos Translate vs NLLB chrF 对比（THOTH）：https://github.com/profdilley/thoth-translator/blob/main/README.md
21. Argos/LibreTranslate 性能：https://dibi8.com/resources/ai-tools/libretranslate/
22. node-llama-cpp Electron 官方指南：https://node-llama-cpp.withcat.ai/guide/electron
23. @electron/llm 官方封装：https://github.com/electron/llm
24. node-llama-cpp npm：https://www.npmjs.com/package/node-llama-cpp
25. M2M100 被 NLLB 取代讨论：https://github.com/etiennechabert/polyglot/pull/12
26. Qwen License（商用条款）：https://github.com/QwenLM/Qwen/blob/main/LICENSE
27. TranslateGemma Electron 集成先例（live-translate）：https://github.com/rioX432/live-translate/issues/130
28. Gemma 2 2B CPU 速度（localaimaster）：https://localaimaster.com/models/gemma-2b
29. Phi-3.5-mini 中文 benchmark（QuantFactory GGUF）：https://huggingface.com/QuantFactory/Phi-3.5-mini-instruct-GGUF
30. Phi-3.5-mini CPU 速度（PromptQuorum）：https://www.promptquorum.com/local-llms/best-beginner-local-llm-models
31. MiniCPM 官方 GitHub（中文优化）：https://github.com/OpenBMB/MiniCPM
32. MiniCPM3-4B Apache-2.0：https://model.aibase.com/models/MiniCPM
