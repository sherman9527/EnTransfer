# Hy-MT2-1.8B 调优报告（Tuning）

> 数据待 `tests/tuning-runner.ts` 跑完后填入。基线配置：Q4_K_M, ctx=2048,
> threads=8, temp=0.1, prefixCaching=on。每个配置跑 5 个代表用例。

## 1. 测试用例

固定 5 个代表用例（跨类别）：
`short-01` / `tech-body-01` / `long-sent-02` / `acronym-01` / `data-01`。

## 2. 量化等级对比

| 量化 | 文件 | 体积 MB | 平均 tok/s | 峰值 RSS MB | 质量（待评） | 备注 |
|---|---|---|---|---|---|---|
| Q4_K_M | Hy-MT2-1.8B.Q4_K_M.gguf | 1081 | | | | ✅ 已下载（基线） |
| Q6_K | Hy-MT2-1.8B-Q6_K.gguf | 1406 | — | — | — | ⏸ 待下载 |
| Q8_0 | Hy-MT2-1.8B-Q8_0.gguf | 1820 | — | — | — | ⏸ 待下载 |
| Q2_K / Q3_K_M / IQ3_M / Q5_K_M | — | — | — | — | — | ⏸ 官方仓库未提供 |

## 3. Context 大小影响

| contextSize | 平均 tok/s | 峰值 RSS MB | 长句质量（待评） | 备注 |
|---|---|---|---|---|
| 1024 | | | | 长段落会触发二次切分 |
| 2048 | | | | 基线 |
| 4096 | | | | KV 占用更大 |

## 4. 线程数曲线（i5-12600KF 混合架构）

| threads | 平均 tok/s | 峰值 RSS MB | 备注 |
|---|---|---|---|
| 4 | | | |
| 8 | | | 基线 |
| 12 | | | |
| 16 | | | 超订 SMT，找甜点 |

## 5. Temperature 对比

| temperature | 平均 tok/s | 译文稳定性（待评） | 备注 |
|---|---|---|---|
| 0.1 | | | 基线，最确定性 |
| 0.3 | | | |
| 0.5 | | | 更发散，质量可能下降 |

## 6. Prefix Caching 开关

| 配置 | 平均 tok/s | 相对基线加速比 | 峰值 RSS MB | 备注 |
|---|---|---|---|---|
| prefix=on | | 1.0×（基线） | | |
| prefix=off | | | | 系统 prompt 每次重算 |

## 7. 结论（模板）

- **推荐 context**：＿＿＿（质量/速度平衡点）。
- **推荐线程数**：＿＿＿（甜点）。
- **推荐 temperature**：0.1（翻译任务需确定性）。
- **prefix caching**：必须开启（系统 prompt 复用，预期 X% 加速）。
- **推荐量化**：Q4_K_M（质量/体积最佳平衡）；若追求质量可上 Q6_K。

## 8. 运行方法

```powershell
node_modules\.bin\esbuild tests/tuning-runner.ts --bundle --platform=node `
  --format=cjs --outfile=tests/out/tuning-runner.cjs `
  --external:node-llama-cpp --external:pdfjs-dist --external:pdf-lib
node tests/out/tuning-runner.cjs
```
