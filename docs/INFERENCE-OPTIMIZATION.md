# 推理优化指南（Inference Optimization）

> 原则二：速度通过参数优化获得，而非降级模型。本文档记录每项优化的
> **测试方法论 + 结果模板**。实测数据待 E2E 完成后由 `tests/tuning-runner.ts`
> 与补充脚本填入。硬件：i5-12600KF（P 核 + E 核混合），CPU-only。

## 速查表（结果待填）

| 优化项 | 配置 | 加速比 | 内存变化 | 质量影响 | 推荐 |
|---|---|---|---|---|---|
| Prefix caching | on vs off | | | 无 | ✅ 必开 |
| Context 复用 | 复用 vs 每段新建 | | | 无 | ✅ 已实现 |
| KV 量化 q8_0 | kvCacheQuantization=q8_0 | | ↓ | 待评 | ⏳ 待测 |
| KV 量化 q4_0 | kvCacheQuantization=q4_0 | | ↓↓ | 待评 | ⏳ 待测 |
| Context=1024 | 短文 | | ↓ | 长文需切分 | ⏳ |
| Context=2048 | 基线 | 1.0× | — | — | ✅ 默认 |
| Context=4096 | 长文 | | ↑ | 长文更好 | ⏳ 按需 |
| 线程=8 | 基线 | 1.0× | — | — | ✅ 默认 |
| 线程=12/16 | 超订 | | | | ⏳ 找甜点 |
| temperature=0.1 | 确定性 | — | — | 最稳 | ✅ 默认 |
| mmq / FlashAttn | 如支持 | | | | ⏳ 查支持 |

---

## 1. KV Cache 优化

### 1.1 Prefix Caching 开/关
- **方法**：同一 5 个用例，`prefixCaching=true` vs `false`，比平均 tok/s。
- **原理**：系统 prompt 是稳定前缀；开后 KV cache 命中，重复前缀免重算。
- **预期**：重复系统 prompt 段明显加速。
- **结果**：on=＿＿ tok/s；off=＿＿ tok/s；加速比=＿＿。

### 1.2 Context 复用 vs 每段新建
- **方法**：对比「复用 context/session + resetChatHistory」（已实现）vs「每段新建 context」。
- **原理**：新建 context 每次 ~1–2s 开销，且碎片 KV。
- **结果**：复用=＿＿；新建=＿＿；每段节省=＿＿。

### 1.3 KV Cache 量化（q8_0 / q4_0）
- **方法**：如 node-llama-cpp v3.20 支持 `kvCacheQuantization`，对比 fp16 / q8_0 / q4_0 的 RSS 与速度。
- **原理**：KV cache 精度换内存，小 context 收益有限。
- **结果**：fp16 RSS=＿＿；q8_0 RSS=＿＿；q4_0 RSS=＿＿；质量影响=＿＿。

### 1.4 Context 大小
- **方法**：1024 / 1536 / 2048 / 3072 / 4096 跑同一批用例。
- **原理**：更大 context = 更少二次切分（长句更完整），但 KV 占内存更大。
- **结果**：见 `MODEL-TUNING.md` 第 3 节。

## 2. 量化等级（质量-体积-速度曲线）

- **方法**：对 Hy-MT2 测 Q4_K_M（已有）/ Q6_K / Q8_0；其他 Q2_K/Q3_K_M/IQ3_M/Q5_K_M 官方未提供，记录待下载。
- **曲线**：质量随量化位数下降，体积/速度改善。Q4_K_M 通常是甜点。
- **结果**：见 `MODEL-TUNING.md` 第 2 节。

## 3. Prefill 优化

- **Batch prefill（短段落合并）**：
  - 方法：把多个短用例拼成一次 prompt，比逐条 prefill 更快；但破坏独立性，仅适合吞吐场景。
  - 结果：＿＿。
- **Prompt 预分词缓存**：`model.tokenize()` 结果缓存（系统 prompt 固定）。
- **mmap 确认**：GGUF 默认 mmap，确认无显式禁用；mmap 让 OS 按需页入，降低启动 RSS 峰值。

## 4. 线程调优（i5-12600KF P+E 混合）

- **方法**：4 / 6 / 8 / 10 / 12 / 16 线程曲线。
- **注意**：16 线程 = 10 P 核(SMT 20) 中的超订；过大会触发 E 核调度抖动。
- **结果**：见 `MODEL-TUNING.md` 第 4 节，标出甜点。

## 5. 采样参数

- **temperature=0.1**（已实现，翻译需确定性）。
- **topK=20 / topP=0.9**（已实现）。
- **调优**：可对比 topK=10/20/40，观察质量与发散度；翻译任务建议低 topK。

## 6. 其他

- **mmq（matrix multiplication quantization）**：如 GGUF 支持，确认开启。
- **Flash Attention**：node-llama-cpp 后端如支持，开启可降 prefill 耗时。
- **Warmup**：加载后跑一次 `hi`，消除首段首触页故障开销（已实现）。

## 7. 推荐参数组合（模板）

```
gpuLayers=0            # CPU-only
contextSize=2048       # 甜点
threads=8              # 甜点（待线程曲线确认）
temperature=0.1
topK=20
topP=0.9
prefixCaching=true     # 必开
量化=Q4_K_M            # 甜点
```
