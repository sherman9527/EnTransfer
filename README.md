# EnTransfer

英文PDF → 中文PDF 离线翻译工具。基于本地大语言模型，无需联网，保护隐私。

## 功能特性

- 📖 **英文文字版PDF自动翻译为中文PDF**：流式重排，丢弃原PDF坐标，重新紧凑排版
- 🧠 **基于 Qwen3-1.7B 本地模型**：离线运行，翻译质量优秀
- ⚡ **GPU加速**：自动检测Vulkan兼容GPU（NVIDIA/AMD/Intel），无GPU则自动回退CPU
- 🖼️ **图片/表格/公式/代码块自动保留**：不翻译，原样嵌入
- 📋 **任务队列**：支持多PDF排队翻译，可暂停/恢复/取消
- 💾 **断点续译**：checkpoint机制，崩溃后可恢复
- 🔤 **微软雅黑字体**：中文渲染清晰，子集化嵌入减小体积
- 📦 **单EXE安装包**：一键安装，portable模式数据随EXE走

## 技术栈

- **前端**：Electron 33 + React 18 + TypeScript + Tailwind CSS + Zustand
- **翻译引擎**：node-llama-cpp + Qwen3-1.7B Q4_K_M（Vulkan GPU加速，disableReasoning）
- **PDF处理**：pdfjs-dist（文本提取）+ pdf-lib（重排版）
- **字体**：Microsoft YaHei（微软雅黑）子集化嵌入
- **任务队列**：9状态状态机 + atomic checkpoint + FIFO单并发

## 系统要求

- Windows 10/11 64位
- 内存：≥8GB（CPU模式）/ ≥4GB显存（GPU模式，推荐NVIDIA GTX 1060及以上）
- 磁盘空间：≥3GB（含模型1.2GB + 安装包）

## 快速开始

### 方式一：下载安装包（推荐）

1. 从 [Releases](https://github.com/sherman9527/EnTransfer/releases) 下载最新版 `EnTransfer Setup x.x.x.exe`
2. 双击安装
3. 启动App，按提示下载模型（或手动放置模型文件）
4. 拖入英文PDF，开始翻译

### 方式二：从源码编译

#### 环境要求

- Node.js ≥ 18
- Python ≥ 3.8（用于字体子集化，需安装fonttools：`pip install fonttools`）
- Git

#### 编译步骤

```bash
# 克隆仓库
git clone https://github.com/sherman9527/EnTransfer.git
cd EnTransfer

# 安装依赖
npm install

# 生成子集字体（首次编译需要，从系统微软雅黑提取）
# Windows系统自带 C:\Windows\Fonts\msyh.ttc
python scripts/subset-font.py

# 开发模式运行
npm run dev

# 打包EXE
npm run build
npm run dist
# 产物在 release/ 目录下
```

## 模型配置

### 推荐模型

**Qwen3-1.7B Q4_K_M**（1.22GB）— 翻译质量4.9/5，GPU约70 tok/s

下载地址：
- ModelScope：https://modelscope.cn/models/Qwen/Qwen3-1.7B-GGUF
- 直接下载：[Qwen3-1.7B-Q4_K_M.gguf](https://modelscope.cn/models/Qwen/Qwen3-1.7B-GGUF/resolve/master/Qwen3-1.7B-Q4_K_M.gguf)

### 手动放置模型

如果不想在App内下载，可以手动将 `.gguf` 文件放到以下目录：

- **开发模式**：`<项目根目录>/models/`
- **安装后**：`<安装目录>/data/models/`（通常是 `C:\Users\<用户名>\AppData\Local\Programs\EnTransfer\data\models\`）

放置后重启App，会自动识别模型并显示"已就绪"。

### App内下载

启动App后，进入「模型管理」页面，点击推荐模型的「下载」按钮，会显示下载进度（百分比、速度、剩余时间）。

## 使用说明

1. 启动App，确保模型状态为「已就绪」
2. 点击「添加PDF」或直接拖入英文PDF文件
3. 任务自动加入队列，开始翻译
4. 翻译完成后，点击「打开文件夹」查看输出PDF
5. 支持暂停/恢复/取消/删除任务

## 项目结构

```
EnTransfer/
├── electron/              # 主进程
│   ├── pdf/              # PDF处理（capture提取 / typeset重排版）
│   ├── models/           # 翻译引擎 + 模型管理（下载/注册表/引擎）
│   ├── queue/            # 任务队列（状态机/checkpoint/存储）
│   ├── pipeline.ts       # 翻译流水线编排
│   ├── main.ts           # 主进程入口
│   └── preload.ts        # contextBridge
├── renderer/             # 渲染进程（React UI）
│   └── src/              # 页面/状态管理/IPC客户端
├── shared/               # 跨进程共享类型
├── scripts/              # 构建脚本（字体子集化等）
├── assets/               # 静态资源（字体子集等）
├── docs/                 # 文档（架构图/使用手册/研究报告）
├── tests/                # 测试和基准脚本
├── poc/                  # 技术验证POC（翻译引擎/PDF管线）
├── e2e-test.ts           # 端到端测试脚本
└── package.json
```

## 性能

| 模式 | 速度 | 353页书籍预估 |
|------|------|--------------|
| GPU（GTX 1060 + Vulkan） | ~70 tok/s | ~35分钟 |
| CPU（i5-12600KF，12线程） | ~9 tok/s | ~3.5小时 |

- 输出PDF：紧凑A4排版，353页源PDF → 约180页输出
- 50页E2E：GPU约3.5分钟，输出约14MB

## 翻译质量

- 术语一致性：EM→工程经理、IC→个人贡献者、OKR/KPI/DORA等正确处理
- 代码/命令/路径：原样保留，不翻译
- 表格/公式/图片：保留原文，不翻译
- 缩写扩展：翻译前自动扩展EM/IC/VP等缩写

## 注意事项

- 仅支持**文字版PDF**，不支持扫描件/图片PDF（无OCR）
- 仅支持**英文→中文**翻译
- 表格/公式/图片保留原文，不翻译
- 首次运行需要下载模型（约1.2GB）
- GPU加速需要Vulkan兼容显卡和最新驱动

## 开发进度

详见 [docs/PROGRESS.md](docs/PROGRESS.md)

## License

MIT
