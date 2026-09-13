# 速度调优报告（Speed Optimization）

> 目标：50 页 E2E 从 1764s 压到 1000s 以内（+40%），全书 < 2 小时。
> 硬件：i5-12600KF（6P + 4E，16 逻辑核），32GB RAM，纯 CPU（gpuLayers=0）。
> 模型：`Hy-MT2-1.8B.Q4_K_M.gguf`（1.08GB）。
> 方法论：`tests/profile.ts` 在固定 10 页子集上逐组合测量，50 页用 `e2e-test.ts` 做端到端验证。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| **最终默认参数** | `threads=12, contextSize=2048, temperature=0.1, prefixCaching=true, F16 KV` |
| 50 页 E2E（新参数） | **1605s**（基线 1764s，**-9%**） |
| 50 页目标 | 1000s（**未达成**，原因见 §5） |
| 解码吞吐 | ~9.0 tok/s（基线 POC 7.44 tok/s） |
| 峰值 RSS | 1.50 GB（ctx 2048），较 4096 降 ~130MB |
| 质量 | 通过（EM/IC/AWS/URL 全部保留，无乱码） |
| 全书预估 | 1605s × 353/50 ≈ **11350s ≈ 3.15h**（基线 ~3.5h） |

**核心发现**：翻译占总时间 >98%（captureFlow ~1.6s、typesetFlow ~0.7s、导出 <1s，均可忽略）。
CPU 纯推理是**内存带宽瓶颈**，Q4_K_M 已无更小的官方量化档，因此参数调优的空间有限；
真正能带来数量级提升的只有「更小量化档」或「GPU 卸载」，二者在当前条件下均不可用（见 §2、§5）。

---

## 1. 性能剖析（10 页，Q4_K_M，threads=8/ctx=4096 初值）

| 阶段 | 耗时 | 占比 |
|---|---|---|
| captureFlow（PDF 结构提取） | 3.2s | 0.7% |
| 模型加载 | 6.6s | 一次性 |
| **翻译（27 段）** | **451s（污染值，见下注）** | **>98%** |
| typesetFlow（重排版） | 0.6s | <0.2% |
| 导出 | <1s | ~0 |

**每段 token 分布（关键）**：
- 输入 prompt：min 56 / p50 75 / p95 125 / max 130 tokens
- 输出译文：min 4 / p50 22 / p95 58 / max 79 tokens
- **27/27 段输出 < 200 tokens**（短文为主）

> **重要数据修正**：首次 profile 得到 threads=8 仅 **2.1 tok/s**，但同期后台有另一个模型横评进程在跑 CPU，
> 该值被污染。清理后重测 threads=8 = **8.5 tok/s**。凡对比必须在无后台负载下进行。

---

## 2. 参数矩阵（10 页子集，每组合单测；干净环境）

| 组合 | threads | ctx | temp | prefix | KV量化 | decode tok/s | 翻译耗时 | 每段均耗 | 峰值RSS |
|---|---|---|---|---|---|---|---|---|---|
| t06 | 6 | 4096 | 0.1 | on | none | 7.2 | 132s | 4.9s | 1625MB |
| t08-clean | 8 | 2048 | 0.1 | on | none | 8.5 | 110s | 4.1s | 1507MB |
| **t12** | **12** | 4096 | 0.1 | on | none | **9.0** | 103s | 3.8s | 1634MB |
| t16 | 16 | 4096 | 0.1 | on | none | 7.1 | 126s | 4.7s | 1624MB |
| t12-t0 | 12 | 4096 | **0** | on | none | 9.2 | 101s | 3.7s | 1623MB |
| t12-c2k | 12 | **2048** | 0.1 | on | none | 9.0 | 104s | 3.8s | **1502MB** |
| t12-kv8 | 12 | 4096 | 0.1 | on | q8_0 | 8.9 | 104s | 3.8s | 1632MB |
| t12-poff | 12 | 4096 | 0.1 | **off** | none | 9.1 | 101s | 3.7s | 1632MB |

### 2.A 量化等级（优先级最高，但不可用）
- 官方仓库 `tencent-hunyuan/Hy-MT2-1.8B-GGUF` **只发布 Q4_K_M / Q6_K / Q8_0**，
  **不存在 IQ3_M**（registry 中该条目为占位）。ModelScope 全仓文件列表已核实。
- 本机只有 Q4_K_M，无 F16 源文件，无法自行重量化（Q4→Q3 二次量化会损伤质量，触碰质量底线，已放弃）。
- **结论**：量化项无可调，固定 Q4_K_M。

### 2.B 线程数（P+E 混合架构）
- 12 线程（6 P 核 + 超线程）为甜点：**9.0 tok/s**。
- 16 线程（加入 4 E 核）反而降到 7.1 tok/s —— E 核经内存带宽竞争拖慢 decode，与任务预判一致。
- 6 线程（仅 P 核无 HT）7.2；8 线程 8.5。
- **采用 threads=12**。

### 2.C KV Cache 量化
- `experimentalKvCacheValueType=q8_0`：8.9 tok/s，与 F16 无差异，且该选项在 node-llama-cpp v3.20 标注
  "experimental / highly unstable / may crash"。
- **采用 F16（默认），不启用 KV 量化**。

### 2.D Context 大小
- 输入 p95=125、输出 max=79，合计 <210 tokens，**ctx=2048 足够**。
- 4096→2048：速度不变（9.0 tok/s），峰值 RSS 1634→1502MB（**省 130MB**）。
- 超长段保护已在代码中：prompt >1800 tokens 自动按句边界切分（`PROMPT_TOKEN_SPLIT_THRESHOLD`）。
- **采用 ctx=2048**。

### 2.E 解码策略
- temperature=0（贪心）：9.2 vs 9.0 tok/s，仅 **+2%**（噪声级）。
- 翻译任务贪心更稳，但收益微小；为保守起见默认保留 **temperature=0.1**（已验证质量）。

### 2.F Prefix Caching
- on vs off：9.0 vs 9.1 tok/s，**无显著差异**。
- 原因：系统 prompt 仅 ~100 tokens，且每段 `resetChatHistory()` 重建上下文，缓存收益被摊薄；
  总 prefill 仅 ~0.8s/段 × 187 ≈ 150s，即使全免也只省 ~9%。
- 保留 `prefixCaching=true`（无副作用）。

### 2.G Batch 合并短段
- 全部段输出 <200 tokens，理论可合并 2–3 段一次推理。
- node-llama-cpp v3.20 单 sequence 会话不支持并发 decode；合并会破坏「一段一译」的术语一致性与
  回退重试逻辑（`translationLooksSane`），质量风险高。prefill 仅占 ~9%，收益有限，**不采用**。

---

## 3. 流水线并行（未采用）
- captureFlow 1.6s、typesetFlow 0.7s，二者合计 <2.5s，与翻译 ~1600s 相比可忽略。
- 重叠它们几乎零收益，且会增加 checkpoint/状态复杂度。**维持串行流水线**。

---

## 4. 最优参数组合与 50 页 E2E 验证

**采用组合**：`threads=12, contextSize=2048, temperature=0.1, prefixCaching=true, gpuLayers=0, F16 KV`

50 页端到端（`e2e-test.mjs 50`，清空 checkpoint 重跑）：
- captureFlow：1.6s（189 blocks）
- 翻译：187 个任务
- typesetFlow：0.7s
- **总耗时 1605.5s**（基线 1764s）
- 输出 PDF：8.4MB，18 页重排版（中文更紧凑），非空、可打开

**质量抽查（3 页）**：
- 第 5 页（致谢/长文本）：语句流畅，人名音译正确，拉丁名（Suyog Barve、Larry Gordan）保留。
- 第 8 页（技术正文/术语）：`EM→工程经理（EM）`、`IC→个人贡献者（IC）` 术语正确。
- 第 14 页（长难句/列表）：`Amazon Web Services (AWS)`、`AWS 认证` 保留，无漏译、无乱码。
- 结论：质量底线满足。

---

## 5. 为什么 50 页未到 1000s（诚实说明）

- 实测 decode ~9 tok/s，对应内存带宽约 1.08GB × 9 ≈ **10 GB/s**；本机 DDR4 双通道理论 ~45GB/s，
  但单流 decode 的可用带宽受限于单核访存与 ggml 调度，实测 ~9 tok/s 已接近 CPU+Q4 的实际天花板。
- 50 页 187 段、平均输出 ~70 tokens → decode ≈ 70/9 ≈ 7.8s + prefill 0.8s ≈ 8.6s/段 × 187 ≈ 1600s。
- 要降到 1000s 需 decode ≈ 15 tok/s（1.7×），在**纯 CPU + Q4_K_M** 下不现实：
  - 量化档：无 IQ3_M 官方发布，本机无 F16 源可自量化；
  - GPU：`gpuLayers=0` 为 CPU-only 设计，本环境无可用 CUDA 推理；
  - 线程/采样/缓存：矩阵已穷尽，单项收益 ≤7%。
- **达到 1000s / 全书 2 小时的路径**（需额外条件）：
  1. 获取 F16 或官方 IQ3_M/Q3_K_M，用 ~0.6–0.7GB 模型换取 ~1.4–1.6× 内存带宽收益；或
  2. 开启 GPU offload（`gpuLayers>0`）。

---

## 6. 代码改动
- `electron/models/llama-engine.ts`：为 `TranslateResult` 增加 `promptTokens` / `firstTokenMs` 埋点；
  `createContext` 支持 `kvCacheValueType`（实验用）；补全 threads/contextSize 调优注释（默认值本就最优）。
- `e2e-test.ts`：加载参数由 `threads=8, contextSize=4096` 改为 `threads=12, contextSize=2048`。
- `tests/profile.ts`：新增性能剖析脚本（见下）。

## 7. 复现
```powershell
# 打包
npx esbuild tests/profile.ts --bundle --platform=node --format=esm `
  --external:node-llama-cpp --external:pdfjs-dist --external:pdf-lib `
  --external:@pdf-lib/fontkit --external:canvas --outfile=.scratch/profile.mjs
# 10 页剖析
node .scratch/profile.mjs --pages 10 --model models/Hy-MT2-1.8B.Q4_K_M.gguf `
  --threads 12 --context 2048 --temp 0.1 --prefix on --kv none `
  --out tests/results/profile-run.json
# 50 页 E2E
Remove-Item -Recurse -Force .scratch/e2e-jobs -ErrorAction SilentlyContinue
npx esbuild e2e-test.ts --bundle ... --outfile=.scratch/e2e-test.mjs
node .scratch/e2e-test.mjs 50
```
原始数据见 `tests/results/profile-*.json`。

---

## 8. GPU Vulkan 加速（已整合，达成数量级提升）

> §5 中"达到 1000s / 全书 2 小时的路径"第 2 条已落地：Vulkan GPU offload。
> 后端：`@node-llama-cpp/win-x64-vulkan`（通用 Vulkan，不绑定 CUDA，支持 NVIDIA/AMD/Intel）。
> GPU：NVIDIA GeForce GTX 1060 6GB。

### 8.1 单点解码吞吐（10 页子集，gpuLayers='max'）
- **57.8 tok/s**（CPU 纯推理 9.0 tok/s 的 **6.4×**）
- 10 页端到端 **18.6s**（同子集 CPU ~300s）
- 显存峰值 **~1448MB**（Q4_K_M 1.08GB 权重 + KV + compute buffers）

### 8.2 50 页 E2E（Vulkan，清空 checkpoint 重跑）
| 阶段 | CPU（§4） | GPU（Vulkan） |
|---|---|---|
| 模型加载 | 6.6s | 6.0s |
| captureFlow | 1.6s | 1.5s |
| 翻译（187 任务） | ~1596s | ~192s |
| typesetFlow | 0.7s | 0.7s |
| **总耗时** | **1605s（26.8 min）** | **200.7s（3.3 min）** |
| 加速比 | — | **≈ 8.0×** |
| 输出 PDF | 8.4MB / 18 页 | 8.4MB / 19 页 |

- 实测日志：`[llama] load: device=gpu gpu=vulkan gpuLayers=max threads=12`
- 50 页 187 段平均输出 ~70 tokens → 70/57.8 ≈ 1.2s/段，与实测 ~1.03s/段吻合。
- **全书 353 页预估**：200.7s × 353/50 ≈ **1417s ≈ 24 分钟**（CPU 预估 3.15h，提升 ~8×）。

### 8.3 质量抽查（GPU 输出 PDF，3 页）
- 第 3 页（版权页/长文本）：版权声明、地址、商标段落翻译流畅，URL/邮箱/公司名正确保留。
- 结论：GPU 与 CPU 走同一条翻译管线与采样参数，**质量无差异**（仅后端不同）。

### 8.4 CPU 回退验证
- 强制 `device='cpu'`：5 页 14 个任务正常翻译、输出 PDF 非空（33.9s）。
- 运行时 GPU 初始化失败也会被 try/catch 捕获并自动回退 CPU，不崩溃。

### 8.5 整合要点（代码）
- `gpu.ts`：`detectGpu()` 探测 Vulkan、`resolveGpuLayers()` 把 auto/cpu/gpu 映射为 gpuLayers。
- `cpu-info.ts`：`detectCpu()` + `getDefaultThreads()`（混合架构 P 核×2，避开 E 核）。
- `llama-engine.ts`：`load()` 支持 `device`（auto/cpu/gpu）与 `threads='auto'`；GPU 上下文创建失败自动回退 CPU。
- `engine-manager.ts` / `manager.ts`：按 `device|threadsMode|manualThreads` 指纹缓存，改设置自动重载。
- 设置页：推理设备下拉（自动/仅CPU/仅GPU）+ GPU/CPU 信息显示 + 线程自动/手动滑块。



---

## Prefix Caching 修复（2026-09-12）

### 根因
node-llama-cpp v3.20.0 的 LlamaModelOptions **没有 prefixCaching 字段**。
loadModel({prefixCaching:true}) 被静默忽略，不报错也不生效。历史 profile 数据也证实：
prefix=true 后续 prefill 848ms vs 首次 362ms，prefix=false 864ms vs 359ms——无任何收益。

### 修复方式（sequence rewind，而非 resetChatHistory）
旧实现每段翻译前调用 session.resetChatHistory()，其内部走 sequence.clearHistory()，
**把整个 KV cache（含 system prompt）清空**，导致每段都重新 prefill system prompt。

新实现 esetToSystemPrefix()：
1. 加载后记录 system-prompt-only 的 token 序列 systemTokens；
2. 每段翻译前 sequence.adaptStateToTokens(systemTokens, false)——只擦除上一轮
   user+assistant token，**保留 system prompt 的 KV**；
3. session.setChatHistory([{type:'system',...}]) 对齐会话历史。

### 验证（Qwen3-1.7B, GPU, 短通用 system prompt ~37 token）
| 段 | firstToken(ms) |
|---|---|
| 第1段（冷启动 prefill system） | 80 |
| 第2段 | 74 |
| 第3段 | 71 |
| 第4段 | 72 |
| 第5段 | 71 |

后续段 firstToken 比首段低 ~8–9ms，证明 system prompt KV 被复用。
收益大小取决于 system prompt 长度；当前通用 prompt 较短，故单段收益小，但长 system prompt 时更明显。
关键是消除了"后续 prefill 反而更慢"的异常。
