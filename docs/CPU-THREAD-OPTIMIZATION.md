# CPU 检测与推理线程数优化

本文件说明 EnTransfer 如何在运行时检测 CPU 拓扑、智能选择 llama.cpp 推理线程数，
以及设置页需要配套改造的清单（待整合）。

> 新代码：`electron/models/cpu-info.ts`（CPU 检测 + 智能线程选择）
> 新代码：`electron/models/thread-benchmark.ts`（实测扫描最优线程数）
> 测试：`tests/cpu-info-test.ts`

---

## 1. 为什么不再硬编码线程数

旧实现 `llama-engine.ts` 里写死了：

```ts
Math.min(12, Math.max(2, os.cpus().length - 1))
```

问题：
- **上限 12 是拍脑袋的**，换到 8 核/16 核/混合架构机器上不适用。
- **用逻辑核数减一**：在带超线程的 CPU 上会把 HT 兄弟核也算进去，而 llama.cpp
  解码是**内存带宽瓶颈**，多跑的 HT 线程只会争抢带宽、反而变慢。
- **Intel 12 代以后的 P+E 混合架构**：E 核性能弱，把 E 核算进推理线程会拖慢整批，
  应只调度 P 核（及其 HT 兄弟）。

正确做法：运行时检测物理核数与是否混合架构，按规则选线程数。

---

## 2. CPU 检测方法（`cpu-info.ts`）

### 2.1 采集项

| 字段 | 来源 | 说明 |
|------|------|------|
| `model` | `os.cpus()[0].model` | 如 `12th Gen Intel(R) Core(TM) i5-12600KF` |
| `logicalCores` | `os.cpus().length` | 逻辑处理器数 |
| `architecture` | `process.arch` | `x64` / `arm64` / `unknown` |
| `physicalCores` | WMI（Windows）或估算 | 见下 |
| `isHybrid` | 启发式 | 是否 P+E 混合 |
| `performanceCores` | 型号查表 | P 核数（混合架构） |

### 2.2 物理核数检测（Windows）

Windows 上用 PowerShell + WMI 读取真实物理核数：

```powershell
Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json
```

本项目机器实测输出：

```json
{ "NumberOfCores": 10, "NumberOfLogicalProcessors": 16 }
```

即 i5-12600KF = 10 物理核（6P+4E）/ 16 逻辑核。

- 该命令 5 秒超时，`windowsHide: true`，失败静默降级。
- **非 Windows** 或 WMI 失败时估算：`physical = logical / 2`（假设开了 SMT/HT），
  逻辑数为奇数则取逻辑数本身。结果记入 `physicalSource: 'wmi' | 'estimate'`。

### 2.3 混合架构判定

两层信号，取或：

1. **结构信号（WMI 数据可信时用）**：`1 < logical/physical < 2`。
   - 纯 HT 芯片：`logical == 2*physical`（比值恰好 2，排除）
   - 纯无超线程：`logical == physical`（比值恰好 1，排除）
   - 混合芯片：P 核有 HT、E 核没有，比值落在 (1,2) 之间。
2. **型号回退信号（仅当 WMI 失败、物理核靠估算时）**：型号命中
   `12th/13th/14th/15th Gen` 或 `Core Ultra`，且 `logical > physical*1.5`。

> 设计要点：型号回退信号**只在 WMI 失败时**启用。否则像 i5-12400（6P、无 E 核、
> 6 物理 / 12 逻辑）这类纯大核 12 代芯片会被误判成混合架构。

### 2.4 P 核数估算

从型号串里抓 SKU（正则 `i[3579]-?(\d{4,5})`），查表：

| SKU | 型号 | P 核 |
|-----|------|------|
| 12600 | i5-12600K/KF | 6 |
| 12700 | i7-12700K/KF | 8 |
| 12900 | i9-12900K/KF | 8 |
| 13600 | i5-13600K/KF | 6 |
| 13700 | i7-13700K/KF | 8 |
| 13900 | i9-13900K/KF | 8 |
| 14600 | i5-14600K/KF | 6 |
| 14700 | i7-14700K/KF | 8 |
| 14900 | i9-14900K/KF | 8 |

查不到时**保守取 `performanceCores = physicalCores`**（假设全是 P 核）——
不会崩，最坏只是偶尔把 E 核也用上，略慢。

---

## 3. 智能默认线程数规则（`getDefaultThreads`）

| CPU 类型 | 默认线程数 | 理由 |
|----------|-----------|------|
| 混合架构 (P+E) | `P 核 × 2`（HT），不超过逻辑核数 | 只用 P 核及其 HT 兄弟，避开 E 核 |
| 纯大核（有 HT） | 物理核数 | llama.cpp 是内存带宽瓶颈，不用 HT 兄弟 |
| 纯大核（无 HT） | 物理核数 | — |
| ARM（big.LITTLE） | 性能核数（≈物理核数） | 避开能效核 |
| 未知架构 | `max(2, logical - 1)` | 兜底 |

**硬约束**：下限 2 线程，上限不超过逻辑核数。

核心原则：**默认用物理核数而非逻辑核数；混合架构只用 P 核。**

---

## 4. 当前机器检测结果（dev box）

运行 `tests/cpu-info-test.ts` 实测：

```
model        : 12th Gen Intel(R) Core(TM) i5-12600KF
arch         : x64
physical     : 10 (wmi)
logical      : 16
isHybrid     : true
performance  : 6 P-cores
short name   : Intel i5-12600KF
description  : Intel i5-12600KF（6P+4E，16逻辑核）
recommended  : 12 threads
```

符合预期：**混合架构、6P 核、推荐 12 线程**（6P×2 HT，4 个 E 核不用）。

### 复现

```powershell
node_modules\.bin\esbuild tests/cpu-info-test.ts --bundle --platform=node `
  --format=cjs --outfile=.scratch/cpu-info-test.cjs
node .scratch/cpu-info-test.cjs
```

输出 `=== ALL CHECKS PASSED ===`。

---

## 5. 自动 Benchmark（`thread-benchmark.ts`，可选）

理论默认值很稳，但内存层级、BIOS 电源计划、散热墙因机而异。
`benchmarkThreads(modelPath, candidates?)` 实测扫描：

- 每个候选线程数**重新加载模型+上下文**（线程在创建上下文时绑定），
  跑 3 次短推理，取平均 tok/s。
- 默认候选：围绕推荐值展开 `[rec-4, rec-2, rec, rec+2, rec+4, rec+6, 16]`，
  夹到 `[2, logicalCores]`，并恒含 `2` 与 `logicalCores` 作对照。
- 返回按 tok/s 降序的结果数组，第一个即实测最优。
- 1–2B Q4 模型整轮约 **30–60 秒**。

```ts
import { benchmarkThreads } from './electron/models/thread-benchmark.ts'
const results = await benchmarkThreads(modelPath)
const best = results[0] // { threads, tokPerSec }
```

> 注意：该模块 import 了 `LlamaCppEngine`，运行环境需有 `node-llama-cpp`（与
> `tests/benchmark-runner.ts` 同样，bundle 时 `--external:node-llama-cpp`）。

---

## 6. 设置页 UI 变更清单（待整合，本 PR 不改）

以下变更等速度优化子代理完成 `engine.ts` 后由组织者统一接入。

### 6.1 `shared/types.ts`（本 PR 已改）

`AppSettings` 已新增（可选字段，兼容旧 `mockSettings`）：

```ts
threadsMode?: 'auto' | 'manual'
manualThreads?: number
```

另导出了渲染层可复用的 `CpuInfo` 接口。**待补**：在 `IpcChannel` 加 `'cpu:detect'`，
在 `AppApi` 加 `detectCpu: () => Promise<CpuInfo>`（本 PR 暂未加，避免 preload 类型报错）。

### 6.2 `electron/main.ts`

```ts
import { detectCpu, getDefaultThreads } from './models/cpu-info.ts'

// registerIpc() 内：
ipcMain.handle('cpu:detect', () => {
  const cpu = detectCpu()
  return { ...cpu, recommendedThreads: getDefaultThreads(cpu) }
})
```

`mockSettings` 初始化时建议加：
```ts
threadsMode: 'auto',
manualThreads: getDefaultThreads(detectCpu())
```
并让实际创建引擎时按 `threadsMode` 决定用 auto 还是 `manualThreads`（这一步由整合者在
`engine.ts`/`engine-manager.ts` 里做，本 PR 不碰）。

### 6.3 `electron/preload.ts`

在 `app` 对象里暴露：
```ts
detectCpu: () => ipcRenderer.invoke('cpu:detect') as Promise<CpuInfo>,
```
（配合 6.1 补全 `AppApi.detectCpu` 后类型即闭合。）

### 6.4 `renderer/src/screens/SettingsScreen.tsx`

把现有「CPU 线程数」 section 升级为：
- 顶部显示 CPU 信息：`CPU: {describeCpu(cpu)}，自动选择 {recommended} 线程`
- 「自动 / 手动」单选切换（绑 `threadsMode`）
- 手动模式下显示滑块 `1 ~ logicalCores`（绑 `manualThreads`）
- 「测试最优线程数」按钮 → 调 benchmark，跑完回显最快线程数

调用：`const cpu = await window.api.app.detectCpu()`。

### 6.5 `renderer/src/store/settingsStore.ts`

`DEFAULTS` 增加：
```ts
threadsMode: 'auto' as const,
manualThreads: 8,
```

---

## 7. 与子代理的边界

- 本 PR **不修改** `electron/models/engine.ts` / `llama-engine.ts`（速度优化子代理在改）。
- 本 PR **不修改** `electron/pdf/`、`pipeline.ts`、`queue/`。
- 线程数从「检测」到「实际传入引擎」的接线（替换 `llama-engine.ts` 里的
  `defaultThreads()` 硬编码）由整合者在速度优化完成后统一做。
