# EnTransfer 开发指南

> 本文档记录 EnTransfer 项目的架构设计、关键技术决策、踩坑经验和开发流程，供后续开发和维护参考。

## 目录

1. [项目概述](#项目概述)
2. [系统架构](#系统架构)
3. [核心模块详解](#核心模块详解)
4. [关键技术决策](#关键技术决策)
5. [踩坑记录与解决方案](#踩坑记录与解决方案)
6. [模型配置与优化](#模型配置与优化)
7. [开发流程](#开发流程)
8. [构建与发布](#构建与发布)
9. [性能优化](#性能优化)
10. [代码规范](#代码规范)

---

## 项目概述

EnTransfer 是一个 Windows 桌面应用，将英文文字版 PDF 离线翻译为中文 PDF。核心特点：

- **纯离线**：基于本地 LLM，无需联网，保护隐私
- **流式重排**：丢弃原 PDF 坐标，重新紧凑排版，无重叠无乱码
- **GPU 加速**：Vulkan 通用后端，兼容 NVIDIA/AMD/Intel
- **任务队列**：多 PDF 排队翻译，支持暂停/恢复/取消
- **模型可插拔**：支持手动放置模型文件或 App 内下载

### 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 33 |
| 前端 | React 18 + TypeScript + Tailwind CSS + Zustand |
| 构建工具 | electron-vite |
| 翻译引擎 | node-llama-cpp + Qwen3-1.7B Q4_K_M |
| PDF 提取 | pdfjs-dist |
| PDF 重排版 | pdf-lib + @pdf-lib/fontkit |
| 字体 | Microsoft YaHei（微软雅黑）子集化 |
| 打包 | electron-builder (NSIS) |

---

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│                    Renderer (React UI)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ 任务队列  │ │ 模型管理  │ │ 翻译进度  │ │ 设置   │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
│       └──────────────┴──────────────┴────────────┘    │
│                    contextBridge (IPC)                   │
├─────────────────────────────────────────────────────────┤
│                    Main Process (Node.js)                 │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ PDF Pipeline│  │ Translation │  │   Task Queue      │  │
│  │  capture    │  │   Engine    │  │  状态机+checkpoint│  │
│  │  typeset    │  │ (llama.cpp) │  │   FIFO 单并发     │  │
│  └─────┬──────┘  └─────┬──────┘  └────────┬─────────┘  │
│        └─────────────────┼───────────────────┘            │
│                    ┌──────┴──────┐                         │
│                    │  Pipeline    │                         │
│                    │  编排器       │                         │
│                    └──────────────┘                         │
├─────────────────────────────────────────────────────────────┤
│  本地资源: models/ (GGUF) + assets/fonts/ (子集字体)        │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

```
英文PDF → pdfjs-dist提取 → 结构化内容流(标题/段落/代码/图片/表格)
    → 过滤(表格/公式/图片不翻译) → LLM翻译(仅正文和标题)
    → 合并内容流 → pdf-lib流式重排(A4页面,微软雅黑) → 中文PDF
```

---

## 核心模块详解

### 1. PDF 提取 (capture)

**文件**: `electron/pdf/capture/`

使用 pdfjs-dist 提取 PDF 文本和结构：

- **文本提取**: `page.getTextContent()` 获取带坐标和字体信息的文本项
- **结构识别**: 多信号检测标题（字号+加粗+位置+内容模式+前后空白）
- **内容分类**: 将提取的内容分为 heading / paragraph / code / image / table / formula
- **坐标丢弃**: 不保留原 PDF 的坐标信息，仅保留内容和语义类型

**关键设计**: 流式内容流（Content Stream），每个元素有 type 和 content，后续排版模块按顺序处理。

### 2. PDF 重排版 (typeset)

**文件**: `electron/pdf/typeset/`

使用 pdf-lib 在全新 A4 页面上从头排版：

- **流式布局 (Flow Layout)**: 内容从上到下、从左到右自然流动，不参考原坐标
- **页面管理**: 自动分页，内容超出页面高度时新建页面
- **字体嵌入**: 微软雅黑子集化（Regular + Bold），Consolas 用于代码
- **元素渲染**:
  - 标题: Bold 字体，更大字号，前后留白
  - 正文: Regular 字体，标准行高，两端对齐
  - 代码块: Consolas 字体，灰色背景，等宽
  - 图片: 按比例缩放，居中
  - 表格: 保留原文，绘制表格线
- **颜色**: 纯黑 #000000 正文

### 3. 翻译引擎 (translation)

**文件**: `electron/models/`

基于 node-llama-cpp 封装：

- **模型加载**: 支持 GGUF 格式，自动检测 GPU (Vulkan)，失败回退 CPU
- **推理配置**:
  - `contextSize`: 1024（足够覆盖系统提示+段落）
  - `threads`: 自动检测 CPU 核心数，混合架构优选 P 核
  - `temperature`: 0.1（低温度保证翻译一致性）
  - `gpuLayers`: 最大（GPU 模式下尽可能多层放 GPU）
  - `disableReasoning`: true（关闭 thinking mode，大幅提速）
- **翻译流程**: 系统提示词（翻译指令）+ 用户内容（英文段落）→ 模型生成中文

### 4. 任务队列 (queue)

**文件**: `electron/queue/`

9 状态状态机 + atomic checkpoint：

```
pending → extracting → translating → typesetting → completed
   ↓          ↓            ↓             ↓
paused     failed       failed        failed
   ↓
cancelled
```

- **FIFO 单并发**: 同时只翻译一个任务，避免 GPU 显存竞争
- **Checkpoint**: 每个段落翻译完成后保存进度，崩溃后可恢复
- **暂停/恢复**: 暂停后保存当前状态，恢复时从 checkpoint 继续
- **取消/删除**: 取消当前任务，删除已完成任务的输出文件

### 5. 模型管理 (model registry)

**文件**: `electron/models/registry.ts`

- **模型扫描**: 启动时扫描 `models/` 目录，识别 GGUF 文件
- **状态显示**: 未下载 / 下载中 / 已就绪
- **App 内下载**: 支持从 ModelScope 下载，显示进度（百分比/速度/剩余时间）
- **手动放置**: 用户可手动将 GGUF 文件放到 `models/` 目录，自动识别

---

## 关键技术决策

### 决策1: 流式重排 vs 原位替换

**选择**: 流式重排 (Flow Layout)

**原因**:
- 原位替换保留原 PDF 坐标，但中文比英文宽，导致文字重叠
- 目录页点引线残留、页码与标题融合
- 用户明确要求"当纯文本排入新 PDF"

**实现**: 提取结构化内容流 → 丢弃所有坐标 → 在新 A4 页面从头排版

### 决策2: Qwen3-1.7B vs 其他模型

**选择**: Qwen3-1.7B Q4_K_M, disableReasoning=true

**横评结果** (8 模型 CPU+GPU 全量测试):

| 模型 | 质量 | GPU速度 | CPU速度 | 体积 | 综合 |
|------|------|---------|---------|------|------|
| Qwen3-1.7B Q4_K_M | 4.9/5 | 70.1 tok/s | 9 tok/s | 1.22GB | **4.59** |
| MiniCPM5-2B | 4.9/5 | 10.2 tok/s | - | 1.4GB | 淘汰 |
| MiniCPM3 | 4.5/5 | - | - | - | 淘汰 |
| Hy-MT2-1.8B | 4.7/5 | - | - | 1.2GB | 备选 |

**关键发现**: Qwen3/MiniCPM5 默认开启 thinking mode，速度暴跌到 0.3-1.4 tok/s。关闭后 (disableReasoning=true) Qwen3 达 70 tok/s。

**MiniCPM5 淘汰原因**: Vulkan 下仅 10 tok/s（架构不兼容），虽然质量高但速度不可接受。

### 决策3: Vulkan 通用 GPU 后端

**选择**: 仅支持 Vulkan，不绑定 CUDA

**原因**:
- 用户可能用 AMD 或 Intel 显卡，不只是 NVIDIA
- node-llama-cpp 原生支持 Vulkan 后端
- GTX 1060 6GB 上 Vulkan 达 70 tok/s，显存占用仅 1.5-1.8GB
- 自动检测，失败回退 CPU

### 决策4: 微软雅黑 vs Noto Sans SC

**选择**: Microsoft YaHei（微软雅黑）

**原因**:
- 用户参考 PDF 使用微软雅黑，效果更符合预期
- Windows 系统自带，从 `C:\Windows\Fonts\msyh.ttc` 提取
- 子集化后 Regular 14.4MB + Bold 11.8MB
- 包含 GBK (21886 汉字) + Latin Extended-A（欧洲字符）

### 决策5: 表格/公式/图片不翻译

**选择**: 保留原文，不翻译

**原因**:
- 表格翻译后结构难以保持，容易错位
- 公式翻译会破坏数学表达
- 图片无法翻译文字内容
- 用户明确要求"表格/公式/图片可以不翻译"

---

## 踩坑记录与解决方案

### 坑1: 中文重叠 (原位替换)

**现象**: 输出 PDF 中文字重叠，目录页点引线残留

**根因**: 原位坐标替换，中文比英文宽，超出原文本框

**解决**: 彻底放弃原位替换，改为流式重排

### 坑2: 列表项 □ 乱码

**现象**: 列表项开头显示方框 □

**根因**: 原 PDF 自定义字体将 bullet 字形映射到 Unicode 私用区 (PUA) U+F0A1，不在任何标准字符范围内

**解决**: 全局清理 PUA 区域字符 (U+E000-U+F8FF)，列表项由 typeset 自行绘制矢量填充小圆点

### 坑3: 字体子集太小导致乱码

**现象**: 部分汉字显示为方框

**根因**: 最初字体子集仅 GB2312 (6763 字)，不够覆盖所有常用汉字

**解决**: 扩大到 GBK (21886 字) + Latin Extended-A + 常用标点

### 坑4: pdf-lib subset:true 损坏字体

**现象**: 启用 pdf-lib 的 `subset:true` 选项后，中文字体 CID 映射损坏

**根因**: pdf-lib 的子集化与 CID 字体（中文字体）不兼容

**解决**: 构建时预子集化（用 fonttools），pdf-lib 加载已子集化的字体，不启用运行时 subset

### 坑5: 标题与正文折叠同行

**现象**: "1.1.3 优秀工程经理的特质 一名优秀的工程经理..." 标题和正文在同一行

**根因**: capture 阶段标题块和后续正文块之间没有正确分段，typeset 阶段标题后没有强制换行

**解决**: heading 块渲染后强制换行 + margin-bottom，capture 阶段确保标题独立成块

### 坑6: Thinking mode 导致速度暴跌

**现象**: Qwen3-1.7B 推理速度仅 0.3-1.4 tok/s

**根因**: Qwen3 默认开启 thinking mode (reasoning)，模型先生成思考过程再生成答案，token 数翻倍

**解决**: 设置 `disableReasoning: true`，速度提升到 70 tok/s

### 坑7: CPU 线程数不是越多越好

**现象**: i5-12600KF (6P+4E/16线程) 设 16 线程反而降到 7.1 tok/s

**根因**: 混合架构 CPU，E 核性能低，调度到 E 核拖慢整体；超线程对推理帮助有限

**解决**: 12 线程最优（P 核超线程，避开 E 核），根据实际 CPU 核心数自动调优

### 坑8: Prefix Caching 选项被静默忽略

**现象**: node-llama-cpp v3.20.0 的 `loadModel` 传入 `prefixCaching: true` 不生效

**根因**: 该版本 `loadModel` 无 `prefixCaching` 选项，传入被静默忽略

**解决**: 用 `eraseContextTokenRanges()` + `adaptStateToTokens()` 做 sequence rewind，手动实现 prefix caching

### 坑9: canvas npm 包 Windows 编译失败

**现象**: `npm install canvas` 在 Windows 上编译失败

**根因**: canvas 需要 native 编译，依赖 cairo 等系统库

**解决**: 不使用 canvas，pdfjs-dist 在 disableFontFace 模式下不需要 canvas

### 坑10: 国内网络无法访问 HuggingFace

**现象**: 模型下载超时

**解决**: 使用 ModelScope 作为国内下载源，同时保留 HuggingFace 作为海外备选

---

## 模型配置与优化

### 推荐模型

**Qwen3-1.7B Q4_K_M**
- 下载: [ModelScope](https://modelscope.cn/models/Qwen/Qwen3-1.7B-GGUF)
- 体积: 1.22GB
- 质量: 4.9/5
- GPU 速度: ~70 tok/s (Vulkan, GTX 1060)
- CPU 速度: ~9 tok/s (12 线程)

### 推理参数

| 参数 | 值 | 说明 |
|------|-----|------|
| contextSize | 1024 | 足够覆盖系统提示+段落 |
| threads | 自动 (P核×2) | 根据 CPU 核心数调优 |
| temperature | 0.1 | 低温度保证一致性 |
| gpuLayers | max | GPU 模式下最大层数 |
| disableReasoning | true | 关闭 thinking mode |
| topK | 40 | 默认 |
| topP | 0.95 | 默认 |

### 模型放置路径

- **开发模式**: `<项目根目录>/models/`
- **编译后**: `<exe 所在目录>/data/models/`

### 速度优化手段

1. **disableReasoning**: 关闭 thinking mode，速度提升 50 倍
2. **GPU Vulkan**: 比 CPU 快 6-8 倍
3. **线程调优**: 混合架构 CPU 优选 P 核，12 线程优于 16 线程
4. **批量翻译**: 短段落合并翻译，减少 prefill 开销（实验中）
5. **Prefix Caching**: 复用系统提示词 KV cache（实验中）
6. **量化**: Q4_K_M 是质量/速度/体积的最优平衡点

---

## 开发流程

### 环境准备

```bash
# 克隆仓库
git clone https://github.com/sherman9527/EnTransfer.git
cd EnTransfer

# 安装依赖
npm install

# 安装字体子集化工具
pip install fonttools

# 生成微软雅黑子集字体（首次需要）
python scripts/subset-font.py

# 开发模式运行
npm run dev
```

### 日常开发

```bash
# 开发模式（热重载）
npm run dev

# 代码检查
npm run lint

# 类型检查
npm run typecheck
```

### 提交规范

```
feat: 新功能
fix: 修复bug
docs: 文档更新
style: 代码格式
refactor: 重构
perf: 性能优化
test: 测试
chore: 构建/工具
```

### E2E 测试

```bash
# 运行端到端测试（前50页）
node e2e-test.ts --pages 50

# 测试输出在 docs/E2E-输出样例-*.pdf
```

**测试检查清单**:
- [ ] 无 □ 乱码
- [ ] 无文字重叠
- [ ] 标题独立成行
- [ ] 字体统一（微软雅黑）
- [ ] 正文纯黑
- [ ] 表格保留英文不翻译
- [ ] 图片正常显示
- [ ] 代码块等宽字体
- [ ] 页码连续
- [ ] 无多余空白页

---

## 构建与发布

### 打包 EXE

```bash
# 构建
npm run build

# 打包（NSIS 安装包）
npm run dist

# 产物在 release/ 目录
# EnTransfer Setup 0.1.0.exe
```

### 体积优化

- **maximum 压缩**: electron-builder `compression: maximum`
- **裁剪 locale**: after-pack 钩子删除 53 个不需要的 locale 文件，节省 39MB
- **删除 gitRelease.bundle**: node-llama-cpp 自带的 git bundle，节省 32.8MB
- **排除无用依赖**: package.json 中移除未使用的包
- **字体子集化**: 微软雅黑从 35MB 子集化到 26MB

### 发布流程

1. 更新 package.json 版本号
2. 运行 E2E 测试验证
3. `npm run build && npm run dist`
4. 本地安装测试
5. git commit + push
6. (可选) 上传到 GitHub Releases

---

## 性能优化

### PDF 提取优化

- 禁用 pdfjs-dist 的字体加载 (`disableFontFace: true`)，不需要 canvas
- 批量处理页面，减少 I/O
- 只提取需要的内容（文本+图片），忽略注释和元数据

### 翻译优化

- 系统提示词精简到最核心指令
- 短段落批量翻译（实验中）
- Prefix caching 复用系统提示词 KV cache（实验中）
- 低温度 (0.1) 减少生成 token 数

### 排版优化

- 流式布局避免坐标计算
- 字体预子集化，避免运行时子集化开销
- 图片压缩后嵌入

### EXE 启动优化

- 懒加载模型（首次翻译时才加载，不是启动时）
- 主进程和渲染进程分离
- 字体文件预加载

---

## 代码规范

### 目录结构

```
EnTransfer/
├── electron/              # 主进程
│   ├── pdf/
│   │   ├── capture/      # PDF 提取
│   │   └── typeset/      # PDF 重排版
│   ├── models/           # 翻译引擎 + 模型管理
│   ├── queue/            # 任务队列
│   ├── pipeline.ts       # 翻译流水线编排
│   ├── main.ts           # 主进程入口
│   └── preload.ts        # contextBridge
├── renderer/             # 渲染进程 (React UI)
│   └── src/
│       ├── pages/        # 页面组件
│       ├── store/        # Zustand 状态管理
│       └── ipc/          # IPC 客户端
├── shared/               # 跨进程共享类型
├── scripts/              # 构建脚本
├── assets/               # 静态资源
├── docs/                 # 文档
├── tests/                # 测试
├── poc/                  # 技术验证 POC
└── package.json
```

### 命名规范

- 文件: kebab-case (`pdf-capture.ts`)
- 组件: PascalCase (`TaskQueue.tsx`)
- 变量/函数: camelCase (`translateParagraph`)
- 常量: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)
- 类型: PascalCase (`TranslationTask`)

### IPC 规范

- 所有 IPC 通道名在 `shared/ipc-channels.ts` 统一定义
- 使用 `contextBridge.exposeInMainWorld` 暴露 API
- 渲染进程不直接使用 `ipcRenderer`

### 错误处理

- 所有异步操作必须 try/catch
- 错误通过 IPC 传递到渲染进程显示
- 翻译失败自动重试（最多 3 次），重试失败标记任务为 failed

---

## 附录

### 相关文档

- [README.md](../README.md) - 项目介绍和使用说明
- [PROGRESS.md](PROGRESS.md) - 开发进度追踪
- [MODEL-BENCHMARK.md](MODEL-BENCHMARK.md) - 8 模型横评报告
- [SPEED-OPTIMIZATION.md](SPEED-OPTIMIZATION.md) - 速度优化报告
- [GPU-ACCELERATION.md](GPU-ACCELERATION.md) - GPU 加速文档
- [E2E-QUALITY-REVIEW.md](E2E-QUALITY-REVIEW.md) - 质量审查报告
- [architecture/architecture.drawio](architecture/architecture.drawio) - 架构图

### 参考项目

- 校书郎 (xiaoshulang): OCR PDF 重建方法参考
- node-llama-cpp: LLM 推理引擎
- pdf-lib: PDF 生成库
- pdfjs-dist: PDF 解析库

---

*最后更新: 2026-09-13*
