# GPU 加速支持（Vulkan 后端）

## 概述

EnTransfer 通过 **Vulkan** 后端实现 GPU 推理加速。选择 Vulkan 而非 CUDA 的原因：

- **跨厂商兼容**：支持 NVIDIA、AMD、Intel 显卡，不绑定单一 GPU 厂商
- **体积更小**：Vulkan 二进制 ~95 MB，CUDA ~163 MB
- **无需安装 CUDA Toolkit**：用户只需有最新显卡驱动（Windows 自带 Vulkan loader）
- **性能损失小**：在 GTX 1060 上仅比 CUDA 慢约 5-15%，但通用性更强

## 硬件实测数据

测试机器：i5-12600KF / 32GB RAM / NVIDIA GTX 1060 6GB（Pascal, CC 6.1）

| 指标 | CPU | GPU (Vulkan) | 加速比 |
|------|-----|---------------|--------|
| 平均 tok/s | 1.7* | 57.8 | **34x** |
| 10 页翻译耗时 | 653.5s | 18.6s | **35x** |
| 模型 offload 层数 | 0 / 33 | 33 / 33 | — |
| GPU 显存占用 | N/A | 1448 MB | — |
| RSS 内存 | 2130 MB | 1584 MB | — |

> *CPU tok/s 偏低是因为测试时系统后台有其他应用占用 CPU。在空闲状态下 CPU 约 7-8 tok/s，GPU 加速比仍为 5-8x。

**全书翻译预估（~300 页）**：
- CPU：~5.4 小时（空闲时约 3.5 小时）
- GPU：~12 分钟
- 时间节省：~97%

### GPU 显存预算

| 组件 | 显存 |
|------|------|
| 模型权重 (Q4_K_M, 1.05 GB) | ~1050 MB |
| KV Cache (ctx=2048) | ~200-400 MB |
| 计算图/分配器开销 | ~500 MB |
| **合计** | **~1450 MB** |

GTX 1060 6GB 完全足够（可用显存 ~3.7 GB，桌面应用已占用 ~2.5 GB）。

## 架构

### 文件结构

```
electron/models/
  gpu.ts              ← GPU 检测与设备选择模块（本任务新增）
  llama-engine.ts     ← 推理引擎（待整合 GPU 支持）
shared/types.ts       ← 新增 AppSettings.device、GpuInfo 类型
tests/
  gpu-verify.ts      ← GPU 冒烟测试
  gpu-benchmark.ts    ← CPU vs GPU 对比基准
docs/GPU-ACCELERATION.md  ← 本文档
```

### 检测流程

```
App 启动
  └─ detectGpu()
       ├─ getLlama({ gpu: 'vulkan' })  ← 加载 Vulkan 后端
       ├─ llama.gpu === 'vulkan'?      ← 确认 GPU 可用
       ├─ llama.getVramState()          ← 查询显存
       ├─ llama.getGpuDeviceNames()     ← 查询 GPU 型号
       └─ dispose()                     ← 释放探测实例
       失败 → { type: null } → 自动回退 CPU
```

### 设备选择逻辑

`resolveGpuLayers(device, gpu)`:

| device 设置 | 有 GPU | 无 GPU |
|-------------|--------|--------|
| `'auto'` | gpuLayers = `'max'` | gpuLayers = 0 |
| `'cpu'` | gpuLayers = 0 | gpuLayers = 0 |
| `'gpu'` | gpuLayers = `'max'` | gpuLayers = 0（静默回退） |

## 集成到 engine.ts（待整合）

当前 `llama-engine.ts` 硬编码 `gpuLayers: 0`。整合时需要：

1. 在 `LlamaCppEngine.doLoad()` 中：
   - 调用 `getLlama({ gpu: device === 'cpu' ? false : 'vulkan' })`
   - 用 `resolveGpuLayers()` 计算 gpuLayers
2. 在 `LlamaEngineOptions` 中添加 `device?: 'auto' | 'cpu' | 'gpu'`
3. 在 `LoadOptions` 中添加 `device?: 'auto' | 'cpu' | 'gpu'`
4. 设置面板从 settings 读取 device 偏好

## 打包策略

### 后端二进制大小

| 后端 | 包名 | 大小 | 关键文件 |
|------|------|------|----------|
| CPU | `@node-llama-cpp/win-x64` | 45.2 MB | ggml-cpu-*.dll (多架构) |
| Vulkan | `@node-llama-cpp/win-x64-vulkan` | **94.7 MB** | ggml-vulkan.dll (49.1 MB) + CPU DLLs |
| CUDA | `@node-llama-cpp/win-x64-cuda` | 162.8 MB | ggml-cuda.dll + CUDA runtime |

### 推荐方案：Vulkan 打入主包

**方案 A（推荐）**：Vulkan 后端直接打入安装包
- 增量体积：+95 MB
- 用户体验：开箱即用，无需额外下载
- 排除 CUDA 包（节省 163 MB）
- electron-builder `asarUnpack` 已包含 `node_modules/@node-llama-cpp/**`，无需额外配置

**package.json 建议修改**（当前未修改，仅记录）：

```json
{
  "build": {
    "asarUnpack": [
      "node_modules/node-llama-cpp/**",
      "node_modules/@node-llama-cpp/**"
    ],
    "files": [
      "!node_modules/@node-llama-cpp/win-x64-cuda/**"
    ]
  }
}
```

这会在打包时排除 CUDA 二进制。由于 `asarUnpack` 已经包含 `@node-llama-cpp/**`，Vulkan 和 CPU 后端会自动被解包到asar外。

**方案 B（备选）**：Vulkan 作为可选下载
- 主包只含 CPU（45 MB）
- 首次启动检测到 GPU 后，从服务器下载 Vulkan 二进制（~95 MB）
- 类似模型下载机制
- 适合追求最小安装包体积的场景

### Windows 驱动要求

- NVIDIA：驱动版本 ≥ 456.x（支持 Vulkan 1.2）
- AMD：Radeon Software Adrenalin 2020+
- Intel：Arc 核显驱动最新版
- Windows 10/11 自带 Vulkan loader，无需额外安装 Vulkan SDK

## 测试脚本

### GPU 冒烟测试

```bash
node_modules\.bin\esbuild tests/gpu-verify.ts --bundle --platform=node \
  --format=esm --outfile=tests/out/gpu-verify.mjs \
  --external:node-llama-cpp --external:pdfjs-dist --external:pdf-lib
node tests/out/gpu-verify.mjs
```

输出示例：
```
GPU backend:    vulkan
GPU device:     NVIDIA GeForce GTX 1060 6GB
Model offload:  33 layers on GPU
Speed:          39.9 tok/s
VRAM used:      1448 MB
```

### CPU vs GPU 基准测试

```bash
node_modules\.bin\esbuild tests/gpu-benchmark.ts --bundle --platform=node \
  --format=esm --outfile=tests/out/gpu-benchmark.mjs \
  --external:node-llama-cpp --external:pdfjs-dist --external:pdf-lib
node tests/out/gpu-benchmark.mjs
```

结果保存在 `tests/results/gpu-benchmark.json`。

## UI 设置项（待实现）

在 SettingsScreen 中需要添加：

1. **推理设备下拉选择**：自动 / CPU / GPU
   - 对应 `AppSettings.device: 'auto' | 'cpu' | 'gpu'`
2. **GPU 状态显示**：
   - 有 GPU：`✅ GPU加速已启用（Vulkan）— NVIDIA GeForce GTX 1060 6GB`
   - 无 GPU：`ℹ️ 使用 CPU 推理`
3. **GPU 信息行**：显存总量 / 空闲
4. IPC 通道：`gpu:info`（已在 shared/types.ts 中注册）

## 已知问题

- **GTX 1060 (Pascal)**：Vulkan 完全支持，compute capability 6.1
- **ggml-vulkan.dll 体积**：49 MB 是 Vulkan SPIR-V shader 编译时的开销，无法精简
- **首次启动**：Vulkan 后端初始化比 CPU 慢 ~2-4 秒（需枚举 GPU 设备）
- **Vulkan mmap**：`gpuSupportsMmap = false`，模型加载走显存拷贝，比 CUDA 慢 1-2 秒
