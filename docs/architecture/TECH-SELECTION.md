# EnTransfer 技术选型方案

> 日期：2026-09-12
> 基于：翻译引擎调研报告 + PDF处理技术路线报告
> 状态：Phase 1 完成，待 POC 验证

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 主进程                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 任务队列  │  │ 模型管理  │  │ PDF 管线  │  │ 翻译引擎 │ │
│  │ Manager  │  │ Download │  │ Pipeline │  │ Engine  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │              │      │
│       ▼              ▼              ▼              ▼      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Checkpoint / State Machine             │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │ IPC
┌────────▼────────────────────────────────────────────────┐
│                 React 渲染进程 (UI)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 任务队列  │  │ 模型管理  │  │ 设置页面  │  │ 日志面板 │ │
│  │  Queue   │  │ Models   │  │ Settings │  │  Logs   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 二、技术栈决策

### 2.1 应用框架

| 组件 | 选型 | 理由 |
|------|------|------|
| 桌面框架 | **Electron 33** | 参考校书郎验证过的版本，Node.js 原生模块支持好 |
| 构建工具 | **electron-vite 2.x** | 主进程+渲染进程统一构建，HMR 支持 |
| UI 框架 | **React 18 + TypeScript** | 参考校书郎，生态成熟 |
| 样式 | **Tailwind CSS 3.x** | 快速开发，参考校书郎 |
| 状态管理 | **Zustand 4.x** | 轻量，参考校书郎 |
| 打包 | **electron-builder 24.x** | NSIS 安装包 + portable zip |

### 2.2 PDF 处理

| 组件 | 选型 | 理由 |
|------|------|------|
| 文本/坐标提取 | **pdfjs-dist 3.x** | Mozilla 官方，getTextContent() 提供坐标+字体信息 |
| PDF 重建/绘制 | **pdf-lib + @pdf-lib/fontkit** | 嵌入自定义中文字体，in-place 修改原 PDF |
| 中文字体 | **Noto Sans SC (思源黑体) TTF** | SIL OFL 开源，覆盖简体中文，TTF 格式避免 fontkit CFF bug |
| 结构分析 | **纯 Node.js 几何启发式** | 无需 Python sidecar，参考校书郎已验证算法 |

### 2.3 翻译引擎（POC 验证后最终确认）

| 优先级 | 模型 | 引擎 | 量化 | 体积 | CPU速度 | 质量 |
|--------|------|------|------|------|---------|------|
| **主推荐** | **Hy-MT2-1.8B-Instruct** | node-llama-cpp (GGUF) | Q4_K_M | ~1.2 GB | ~7 tok/s | ★★★★★ WMT25 COMET 89.6 |
| 备选1 | Qwen2.5-3B-Instruct | node-llama-cpp (GGUF) | Q4_K_M | ~2.0 GB | ~3-5 tok/s | ★★★★☆ 中文理解强 |
| 备选2 | MiniCPM3-4B | node-llama-cpp (GGUF) | Q4_K_M | ~2.5 GB | ~3-5 tok/s | ★★★★☆ 中文优化 |
| 快速草稿 | opus-mt-en-zh | CTranslate2 int8 | int8 | ~80 MB | ~6句/s | ★★★☆☆ MIT商用 |

**关键决策**：
- 主引擎使用 **node-llama-cpp** 原生绑定，**无需 Python sidecar**
- 模型通过应用内下载管理（外挂模式），走 `hf-mirror.com` 镜像
- 不使用 NLLB 系列（CC-BY-NC 禁止商用）
- POC 阶段必须实测 Hy-MT2-1.8B 和 Qwen2.5-3B 的翻译质量和CPU速度

### 2.4 模型打包策略

| 模型 | 体积 | 策略 |
|------|------|------|
| opus-mt-en-zh int8 | ~80 MB | ✅ 可打包进 EXE 作为兜底（如采用 CT2 路线） |
| Hy-MT2-1.8B Q4_K_M | ~1.2 GB | 📦 外挂下载（主引擎） |
| Qwen2.5-3B Q4_K_M | ~2.0 GB | 📦 外挂下载（备选） |

**v1 决策**：主引擎 Hy-MT2-1.8B 走外挂下载，不打包进 EXE。EXE 安装包保持精简。

## 三、翻译流水线（State Machine）

```
queued → extracting → translating → typesetting → exporting → done
              ↓            ↓             ↓            ↓
           paused      paused        paused       paused
              ↓            ↓             ↓            ↓
           canceled    canceled      canceled     canceled
              ↓            ↓             ↓            ↓
            error       error         error        error
```

**五个阶段**：
1. **queued**：任务已提交，等待执行
2. **extracting**：PDF 结构提取（pdfjs-dist）
3. **translating**：正文/标题翻译（node-llama-cpp）
4. **typesetting**：中文重排版（pdf-lib + Noto Sans SC）
5. **exporting**：输出最终 PDF
6. **done**：完成

**Checkpoint 机制**：
- 每个阶段完成后持久化 checkpoint（atomic tmp→rename）
- 翻译阶段按页/段粒度保存进度，崩溃后可从断点恢复
- 暂停/取消通过 AbortController 信号传递
- 任务目录：`%APPDATA%/EnTransfer/jobs/<jobId>/`

## 四、PDF 处理管线

### 4.1 结构提取（Capture）

```
PDF → pdfjs-dist getTextContent()
    → 文本块提取 (坐标/字号/字体名/宽度)
    → 阅读顺序排序 (带状分解 + 分栏聚类)
    → 元素分类 (标题/正文/图注/代码块/公式/表格/家具)
    → 段落合并 (pitch ≤ 1.5×行高)
    → 占位符冻结 (公式/URL/引用 → §A§)
    → TranslationUnit[]
```

**元素分类规则**：
- 标题：fontSize ≥ 15pt 且 ≥ 页面中位数 且 文本 ≤ 40字符
- 正文：默认分类，段落合并
- 代码块：等宽字体 (Courier/Consolas/Menlo) 或 编程符号特征
- 公式：数学字体 (Cambria Math) 或 数学Unicode区间
- 图注：Figure/Table 前缀
- 家具：页码/页眉（旋转文本、窄栏位置）

### 4.2 翻译（Translate）

```
TranslationUnit[] (仅 body + title)
    → 占位符保护 (§A§ 不翻译)
    → 分批送 node-llama-cpp (每批 1-3 段)
    → Hy-MT2-1.8B 翻译 prompt
    → 译文质量检查 (长度异常/空译文检测)
    → 占位符恢复
    → 已翻译 TranslationUnit[]
```

**翻译 Prompt**：
```
将以下英文技术文档翻译为简体中文。
要求：
1. 保留代码块、公式、URL 不翻译
2. 专业术语保持准确
3. 输出纯译文，不要添加解释

原文：
{text}

译文：
```

### 4.3 重排版（Typeset）

```
原 PDF → pdf-lib load
    → 嵌入 NotoSansSC (subset: true, 全文只嵌一次)
    → 逐页处理:
        sanitizePage()  删除旧 BT...ET 文本对象
        fitTextToBox()  自适应字号 (14pt→6pt 递减)
        drawLaidOutLines()  混合 CJK/Latin 绘制
    → pdf.save() (只调用一次)
    → 输出中文 PDF
```

**关键不变量**：
- 绝不 copyPages（in-place 修改）
- 字体全文只嵌入一次
- 旧文本必须从内容流删除，不能白色覆盖
- 最小字号门槛 6pt，低于此标记 overflow
- 图片/代码块/表格区域不清除文本（保留原文）

## 五、任务队列设计

### 5.1 数据模型

```typescript
interface TranslationJob {
  id: string                    // UUID
  inputPath: string             // 原PDF路径
  outputPath: string            // 输出PDF路径
  status: JobStatus             // queued/extracting/translating/typesetting/exporting/done/paused/canceled/error
  progress: number              // 0-100
  totalPages: number
  currentPage: number
  model: string                 // 使用的模型 ID
  createdAt: number
  updatedAt: number
  error?: string
  checkpoint?: CheckpointData
}
```

### 5.2 队列操作
- 提交任务 → queued
- 队列按 FIFO 执行，同时只运行 1 个任务（CPU资源限制）
- 暂停：当前阶段完成后挂起，保存 checkpoint
- 恢复：从 checkpoint 继续
- 取消：终止当前执行，清理临时文件
- 删除：移除任务记录和输出文件

## 六、模型管理设计

### 6.1 模型清单（内置）

```typescript
interface ModelInfo {
  id: string
  name: string
  description: string
  size: number           // bytes
  url: string            // 下载地址 (hf-mirror)
  sha256: string
  quant: string          // Q4_K_M / int8
  engine: 'llama.cpp' | 'ctranslate2'
  status: 'not_downloaded' | 'downloading' | 'installing' | 'ready' | 'error'
  downloadProgress?: number
  downloadSpeed?: number
}
```

### 6.2 下载流程
1. 用户点击"下载" → 检查磁盘空间
2. HTTP Range 断点续传下载（hf-mirror.com）
3. 进度：百分比 + 已下载/总大小 + 速度 + ETR
4. 下载完成 → SHA256 校验 → "安装中"（GGUF 无需解压，直接校验）
5. 校验通过 → 绿色 "Ready"

## 七、目录结构

```
EnTransfer/
├── electron/                    # 主进程
│   ├── main.ts                  # 入口
│   ├── preload.ts               # 预加载
│   ├── ipc.ts                   # IPC 路由
│   ├── queue/                   # 任务队列
│   │   ├── manager.ts
│   │   ├── stateMachine.ts
│   │   └── checkpoint.ts
│   ├── models/                  # 模型管理
│   │   ├── download.ts
│   │   ├── registry.ts
│   │   └── engine.ts            # node-llama-cpp 封装
│   ├── pdf/                     # PDF 处理
│   │   ├── capture/             # 结构提取
│   │   │   ├── extract.ts
│   │   │   ├── segment.ts
│   │   │   ├── readingOrder.ts
│   │   │   ├── classify.ts
│   │   │   ├── placeholders.ts
│   │   │   └── types.ts
│   │   └── typeset/             # 重排版
│   │       ├── typeset.ts
│   │       ├── sanitize.ts
│   │       ├── measure.ts
│   │       ├── draw.ts
│   │       ├── fonts.ts
│   │       └── types.ts
│   └── pipeline.ts              # 翻译流水线编排
├── renderer/                    # 渲染进程
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── store/               # Zustand stores
│       ├── components/          # UI 组件
│       └── screens/             # 页面
├── shared/                      # 共享类型
│   └── types.ts
├── assets/
│   ├── fonts/                   # NotoSansSC TTF
│   └── icons/
├── poc/                         # POC 测试代码
├── docs/                        # 文档
├── scripts/                     # 构建脚本
└── tests/                       # 测试
```

## 八、风险与应对

| 风险 | 等级 | 应对 |
|------|------|------|
| Hy-MT2 模型实际翻译质量不达标 | 高 | POC 实测，备选 Qwen2.5-3B |
| node-llama-cpp 在 Electron 中编译失败 | 中 | 使用预编译二进制，Docker 辅助构建 |
| 1.2GB 模型下载慢/失败 | 中 | hf-mirror 镜像 + 断点续传 + 重试 |
| pdf-lib 字体子集化 bug | 中 | 必须用 TTF 格式，POC 验证 |
| 旧文本层清除不彻底（双层文字） | 高 | sanitize 后扫描验证，fail-closed |
| 中文译文溢出 bbox | 中 | 自适应字号递减，6pt 门槛 |
| PDF 文件体积膨胀 | 中 | in-place 修改，字体只嵌一次，3× 阈值监控 |
| 双栏/跨页表格排版错误 | 中 | v1 表格保留原文不翻译，仅翻标题 |

## 九、POC 验证计划

### POC-1: PDF 提取 + 重排版
- 输入：Manning PDF 前 5 页
- 验证：文本提取准确率、元素分类、中文绘制无乱码、无双层文字、体积可控
- 翻译：使用 mock 译文（固定中文文本）测试排版管线

### POC-2: 翻译引擎
- 输入：从 PDF 提取的 10 段技术文本
- 模型：Hy-MT2-1.8B Q4_K_M + Qwen2.5-3B Q4_K_M
- 验证：翻译质量（人工评分）、CPU 速度（tok/s）、内存占用
- 输出：对比数据，确定最终引擎

### POC-3: 端到端
- 输入：Manning PDF 前 5 页
- 完整流程：提取 → 翻译 → 排版 → 输出
- 验证：输出 PDF 可正常打开、中文无乱码、图片保留、排版紧凑
