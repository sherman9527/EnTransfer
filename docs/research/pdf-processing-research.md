# PDF 结构提取与中文重排版技术路线报告

> 调研日期：2026-09-12
> 目标：构建 Windows Electron 桌面应用，将英文文字版 PDF 翻译为中文 PDF
> 参考实现：校书郎（xiaoshulang）electron/translation/ 模块
> 测试 PDF：Manning《Think Like a Software Engineering Manager》(2024)

---

## 目录

- [Part A: PDF 结构提取](#part-a-pdf-结构提取)
- [Part B: 中文 PDF 重排版](#part-b-中文-pdf-重排版)
- [Part C: 开源项目参考分析](#part-c-开源项目参考分析)
- [风险点与难点分析](#风险点与难点分析)
- [最终技术路线图](#最终技术路线图)

---

## Part A: PDF 结构提取

### A.1 推荐工具链总览

| 层级 | 工具 | 运行环境 | 职责 | 推荐度 |
|------|------|----------|------|--------|
| 文本/坐标提取 | **pdfjs-dist** | Node.js / 主进程 | 提取文本块、坐标、字体大小、字体名 | ★★★★★ |
| 图片/对象提取 | **pdf-lib** | Node.js / 主进程 | 读取页面 XObject、提取图片对象 | ★★★★★ |
| 结构化增强（可选） | **Python sidecar (PyMuPDF)** | sidecar 进程 | rawdict 级 span 提取、表格线检测 | ★★★☆☆ |
| 重排版写入 | **pdf-lib + @pdf-lib/fontkit** | Node.js / 主进程 | 嵌入字体、绘制中文、清除旧文本层 | ★★★★★ |

**核心决策**：v1 纯 Node.js（pdfjs-dist + pdf-lib）即可覆盖文字版技术书籍的结构提取需求。Python sidecar 仅在表格线检测、复杂版面分析不足时引入，参考校书郎的 BabelDOC sidecar 模式。

### A.2 pdfjs-dist 文本提取详解

#### A.2.1 基本 API

```typescript
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/build/pdf.worker.entry' // Electron 中需配置 worker

const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise
const page = await doc.getPage(pageNum) // 0-based
const textContent = await page.getTextContent()
```

每个 `item` 的关键字段：

```typescript
interface TextItem {
  str: string           // 文本内容
  transform: number[]   // [a, b, c, d, e, f] 变换矩阵
  width: number         // 文本宽度（pt）
  height: number        // 文本高度（pt）
  hasEOL: boolean       // 是否在行尾
  dir: 'ltr' | 'rtl'   // 文本方向
  fontName: string     // 引用 styles 中的字体名
}

// textContent.styles[fontName] 提供字体元信息：
// { fontFamily, ascent, descent, vertical, fontWeight }
```

#### A.2.2 坐标与字体属性提取

pdfjs 的坐标系为 **底部原点**（y 越大越靠上），与 PDF 原生坐标系一致：

```typescript
interface ExtractedTextBlock {
  page: number
  x: number        // transform[4] — 左下角 x
  y: number        // transform[5] — 左下角 y
  width: number    // item.width
  fontSize: number // Math.abs(transform[3]) 或 height
  fontName: string // item.fontName
  text: string     // item.str
  hasEOL: boolean
  bbox: [number, number, number, number] // [x0, y0, x1, y1]
}
```

**字体大小提取**：`Math.abs(item.transform[3])` 即字体 size（pt）。这是识别标题层级的核心信号。

**字体粗细**：通过 `styles[item.fontName].fontWeight` 获取（`'bold'` / `'normal'`），或通过字体名中的 `Bold`/`Regular` 关键字判断。

#### A.2.3 阅读顺序推断

pdfjs 返回的 items 顺序**不等于视觉阅读顺序**（由内容流编码顺序决定）。需要从几何坐标重排：

**校书郎方案（已验证）**——三阶段排序：

1. **分离家具**：旋转/垂直文本（`dir === 'ttb'` 或 `transform` 含旋转）标记为 `furniture`（页眉/页脚），排到最后
2. **带状分解**：按 top（y）降序排列，当遇到宽度 ≥ 页面宽度 60% 的全宽元素（标题/通栏图注）时，将其上方元素划分为一个"band"（横向带），band 之间不跨栏
3. **栏内排序**：每个 band 内，按 left edge 聚类分栏（栏间距阈值 = 页面宽度 × 12%），每栏内部按 top→bottom、left→right 排序

伪代码：

```typescript
function assignReadingOrder(regions: RawRegion[], pageWidth: number): RawRegion[] {
  const { furniture, flow } = partitionByDirection(regions)

  // 按 top 降序（y 大的在前 = 视觉上方）
  flow.sort((a, b) => b.bbox[3] - a.bbox[3] || a.bbox[0] - b.bbox[0])

  // 带状分解
  const fullWidth = pageWidth * 0.6
  const bands: RawRegion[][] = []
  let current: RawRegion[] = []

  for (const r of flow) {
    if (r.bbox[2] - r.bbox[0] >= fullWidth) {
      if (current.length) { bands.push(current); current = [] }
      bands.push([r]) // 全宽元素单独成 band
    } else {
      current.push(r)
    }
  }
  if (current.length) bands.push(current)

  // 每个 band 内分栏
  const ordered: RawRegion[] = []
  for (const band of bands) {
    const columns = clusterColumns(band, pageWidth, gap = pageWidth * 0.12)
    for (const col of columns) {
      col.sort((a, b) => b.bbox[3] - a.bbox[3] || a.bbox[0] - b.bbox[0])
      ordered.push(...col)
    }
  }

  // 家具排最后
  furniture.sort((a, b) => b.bbox[3] - a.bbox[3])
  ordered.push(...furniture)
  return ordered
}
```

### A.3 元素分类策略

#### A.3.1 分类层级

校书郎将元素分为两个层级：**页面级分类**（page class）和**文本块级分类**（span kind）。

#### A.3.2 文本块分类算法

基于几何 + 字体属性的确定性分类（非机器学习）：

```
输入：阅读顺序排序后的 RawLayoutRegion[]
      每个 region 有 { bbox, text, fontSize, fontName, role? }

分类维度：
  1. 字体大小 vs 页面中位数 → 标题 vs 正文
  2. 行间距（pitch）vs 行高 → 段落边界
  3. 文本前缀模式 → 图注/列表项
  4. 位置 → 页眉/页脚/边注
```

**关键阈值（校书郎经验值，已在真实书籍上验证）：**

| 参数 | 值 | 含义 |
|------|-----|------|
| `MERGE_PITCH_FACTOR` | 1.5 | 两行 top→top 距离 ≤ 1.5×行高 时合并为同段落 |
| `SIZE_CHANGE_TOL` | 0.18 | 字体大小变化 > 18% 视为标题/正文切换 |
| `INDENT_FACTOR` | 0.9 | 首行缩进 ≥ 0.9×行高 视为新段落 |
| `SHORTLINE_FACTOR` | 3.5 | 前行短于栏宽 3.5×行高 视为段落结束 |
| `COLUMN_GAP_FRACTION` | 0.12 | 栏间距 = 页面宽度 × 12% |
| `TITLE_MIN_PT` | 15pt | 标题最小绝对字号 |

**分类伪代码：**

```typescript
function classifyAndSegment(orderedRegions: RawRegion[], pageWidth: number): Span[] {
  // Step 1: 角色精炼——识别家具（页码/页眉）和边注
  const overrides = refinePageRoles(orderedRegions, pageWidth)
  // - isBareFolio(text): /^(p\.?\s*|page\s+)?(\d{1,4}|[ivxlcdm]{1,7})$/ → furniture
  // - isSpacedHeader(text): 单字符 token 比例 ≥ 0.6 → furniture（如 "M a n n i n g"）
  // - narrow block outside main column → note（边注/脚注）

  // Step 2: 按 kind 分区
  const byKind = groupBy(orderedRegions, r => kindOf(r, overrides))

  // Step 3: 每种 kind 用对应策略分段
  for (const [kind, regions] of byKind) {
    switch (kind) {
      case 'body':
      case 'title':
        // 段落合并：pitch ≤ 1.5×行高 且 字体大小变化 < 18% 且 无缩进 → 合并
        segmentByParagraphMerging(regions, pageWidth)
        break
      case 'caption':
        // 合并直到出现 "Figure|Table|Chart N" 前缀
        segmentByCaptionPrefix(regions)
        break
      case 'reference':
      case 'index':
      case 'furniture':
        // 单行，不合并
        treatAsSingletons(regions)
        break
    }
  }

  // Step 4: 恢复原始阅读顺序
  sortSpansByOriginalIndex(spans, orderedRegions)
}
```

#### A.3.3 标题识别

标题识别采用**多信号叠加**（校书郎 preflight/classify.ts 模式）：

1. **字体大小信号**：block 的 fontSize ≥ 页面中位数 fontSize 且 ≥ 15pt（绝对门槛）
2. **位置信号**：block 位于页面上部 40% 区域
3. **文本长度信号**：标题文本 ≤ 40 字符（长文本是正文不是标题）
4. **前缀模式信号**：`Figure 6.1`、`Table 2`、`Chapter N` 等前缀

```typescript
function isHeading(block: TextBlock, medianFontSize: number): boolean {
  return block.fontSize >= 15
      && block.fontSize >= medianFontSize
      && block.bbox[3] >= pageHeight * 0.4  // 上部 40%
      && block.text.length <= 40
}
```

**H1-H3 层级推断**：将页面内所有标题按 fontSize 降序排列，最大为 H1，次大为 H2，依此类推。或使用固定阈值：
- H1: fontSize ≥ 18pt 或 ≥ median × 1.4
- H2: fontSize ≥ 14pt 或 ≥ median × 1.15
- H3: fontSize ≥ 12pt 或 ≥ median × 1.05

#### A.3.4 图片识别

通过 pdfjs 渲染页面时，图片不作为文本 item 出现。需要单独提取：

**pdfjs 方式**：遍历页面操作符树，找 `Do` 操作符引用的 XObject：

```typescript
const operatorList = await page.getOperatorList()
// 遍历 operatorList.fnArray 和 argsArray
// 'objs' (PDFJS.OPS.paintImageXObject) = 36 → 绘制图片
// 'cm' 操作符提供图片的位置和变换矩阵
```

**pdf-lib 方式**（更直接）：

```typescript
const images = page.node.Resources().lookup(pdfLib.PDFName.of('XObject'))
// 遍历 XObject 字典，Subtype = /Image 的即为图片
// 通过内容流中的 cm 矩阵计算图片在页面上的 bbox
```

**推荐**：用 pdf-lib 提取图片对象（image bytes + XObject 引用），用 pdfjs 的 operator list 定位图片在页面上的位置（bbox）。

#### A.3.5 代码块识别

技术书籍中代码块的特征：

1. **字体名**：通常为 `Courier`、`Consolas`、`Menlo` 等等宽字体
2. **文本特征**：以缩进行、括号、分号等编程符号开头/结尾
3. **位置特征**：通常有浅灰色背景矩形，或整块左缩进

```typescript
function isCodeBlock(region: RawRegion): boolean {
  const font = region.fontName || ''
  // 等宽字体特征
  if (/Courier|Consolas|Menlo|Monaco|SourceCode|LiberationMono/i.test(font)) {
    return true
  }
  // 多行连续且每行以编程符号开头
  const lines = region.text.split('\n')
  if (lines.length >= 3 && /^\s*[{(;]|^\s*\/\/|^\s*\/\//m.test(region.text)) {
    return true
  }
  return false
}
```

**注意**：代码块**不翻译**，原样保留。在 capture 阶段标记为 `role: 'code'`，typeset 阶段跳过。

#### A.3.6 公式识别

文字版 PDF 中的公式通常不是图片，而是用数学排版字体渲染的文本：

1. **字体识别**：`Cambria Math`、`Latin Modern Math`、`STIX` 等数学字体
2. **Unicode 区间**：数学运算符 Unicode 区间（U+2200-U+22FF）、上标下标（U+00B9, U+00B2）
3. **行内公式**：被 placeholder 正则冻结（校书郎模式：`$...$` 模式或特殊字符组合）

```typescript
const MATH_FONT_RE = /Cambria.*Math|Latin.*Math|STIX|Asana.*Math|TeX.*Math/i
const MATH_UNICODE_RE = /[\u2200-\u22FF\u27C0-\u27EF\u2A00-\u2AFF\u2080-\u209F]/

function isFormula(region: RawRegion): boolean {
  if (MATH_FONT_RE.test(region.fontName || '')) return true
  if (MATH_UNICODE_RE.test(region.text)) return true
  return false
}
```

**校书郎的 placeholder 策略**：公式不作为独立元素提取，而是在文本层面通过正则识别 `$...$` 内联公式，冻结为 `§A§` 占位符，翻译后恢复。这比像素级公式识别更稳健。

#### A.3.7 表格识别

**v1 方案**：文字版技术书籍的表格结构相对简单，采用启发式检测：

1. **表格线检测**：扫描页面操作符中的线条绘制操作（`re` + `S` 操作符），找到水平/垂直线
2. **单元格对齐**：文本块按 x 坐标聚类成列，y 坐标聚类成行
3. **文本前缀**：连续行的 x 起始位置规律性重复

**校书郎的处理**：表格作为整体区域保留（不翻译表格内文本），仅翻译表格标题（`Table N: ...`）。这是最安全的策略。

```typescript
// 表格检测伪代码
function detectTables(pageOps: OperatorList, textRegions: RawRegion[]): Table[] {
  // 1. 收集所有线条操作符 → lineRects
  // 2. 找水平线和垂直线的交点 → 单元格网格
  // 3. 将 textRegions 映射到网格单元格
  // 4. 返回 Table { bbox, cells: [{ bbox, text }] }
}
```

### A.4 Python Sidecar 方案评估

| 方案 | 优势 | 劣势 | 适用场景 |
|------|------|------|----------|
| **纯 Node.js (pdfjs-dist)** | 无跨进程开销、Electron 原生集成 | 表格线检测弱、复杂版面分析有限 | v1 文字版技术书籍 |
| **PyMuPDF (fitz)** | rawdict 提供 span 级字体/坐标信息、表格线检测强 | 需打包 Python runtime、跨进程通信 | v2 复杂表格/学术论文 |
| **Marker (surya)** | 深度学习版面分析、阅读顺序推断精准 | GPU 依赖重、模型体积大、不适合桌面端 | 不推荐桌面端 |
| **pdf2zh/BabelDOC** | 完整的 IR→render 管线 | 整个项目移植成本高、Python 生态 | 参考其 IR 设计 |

**结论**：v1 使用纯 Node.js 方案。v2 如遇复杂表格，引入 PyMuPDF sidecar（校书郎模式：`spawn` 一个 `shell:false` 的 Python 进程，JSON-over-stdin/stdout 通信）。

### A.5 跨页段落续接

校书郎的方案值得直接借鉴：

```
检测逻辑：
  页面 N 的最后一个 body unit 不以句末标点（.!?。）结尾
  AND 页面 N+1 的第一个 main body unit 不是新结构（标题/列表/ALL-CAPS）
  → 建立 fromId → toId 的 continuation link

歧义时 fail-closed：
  末句以小写字母结尾（明显截断）AND 下一页以新结构开头 → 阻塞检查
```

---

## Part B: 中文 PDF 重排版

### B.1 中文字体嵌入方案

#### B.1.1 字体选择

**推荐：Noto Sans SC（思源黑体）Regular + Bold**

- 开源（SIL Open Font License），可自由分发
- 覆盖简体中文全部常用字（GB2312 + GBK + CJK Unified Ideographs）
- TTF 格式，pdf-lib + @pdf-lib/fontkit 原生支持

**字体文件处理**：

```
assets/fonts/
  NotoSansSC-Regular.ttf    # 原始 TTF（~8MB）
  NotoSansSC-Bold.ttf
```

**注意 CFF/OTF 兼容性问题**：`@pdf-lib/fontkit` v1 对 CFF/OTF 格式的子集化存在已知 bug（会导致 "Embedded font file may be invalid"）。**必须使用 TTF 格式**的 Noto Sans SC，不要用 OTF/CFF 版本。Google Noto 仓库提供 TTF 版本：`https://github.com/notofonts/noto-cjk/tree/main/Sans/Variable/TTF`

#### B.1.2 字体嵌入代码

校书郎的 `fonts.ts` 方案——**全文只嵌入一次**：

```typescript
import { PDFDocument, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

async function embedFontsOnce(pdf: PDFDocument, cjkFontBytes: Uint8Array) {
  pdf.registerFontkit(fontkit)

  // CJK 字体：子集化嵌入（只嵌入实际使用的字形）
  const cjkFont = await pdf.embedFont(cjkFontBytes, { subset: true })

  // Latin 字体：用 Base14 Helvetica（无需嵌入字节）
  const latinFont = await pdf.embedFont(StandardFonts.Helvetica)

  return { cjk: cjkFont, latin: latinFont }
}
```

**关键设计决策**：
1. **只嵌入一次**：300 页 PDF 如果每页嵌入字体，体积会膨胀数百 MB。校书郎明确记录了这个 bug（"后处理 PDF 膨胀到 8.5GB"）
2. **subset: true**：pdf-lib 自动子集化，只嵌入实际绘制的字形
3. **Latin 用 Base14**：Helvetica 无需嵌入，零字节开销
4. **分字体绘制**：中文用 CJK 字体，英文/数字/URL 用 Latin 字体（见 B.3）

#### B.1.3 预子集化优化（可选）

如果 `subset: true` 在复杂场景下有兼容性问题，可以使用 fonttools 预子集化：

```bash
# 安装 fonttools
pip install fonttools

# 基于实际使用字符子集化
pyftsubset NotoSansSC-Regular.ttf \
  --text-file=used_chars.txt \
  --output-file=NotoSansSC-subset.ttf \
  --layout-features='*'
```

但 v1 优先使用 pdf-lib 内置的 `subset: true`，避免额外工具链。

### B.2 排版策略选型

#### 方案一：原位替换（保版模式）——**推荐 v1**

**原理**：在原 PDF 上操作——清除旧英文文本层 → 在原 bbox 内绘制中文。

**校书郎的实现**（已验证，317 页技术书籍）：

```
1. PDFDocument.load(源PDF)           // 加载原 PDF
2. embedFontsOnce()                  // 嵌入 CJK + Latin 字体一次
3. for each page:
   a. sanitizePage()                 // 清除旧文本 BT...ET 对象
   b. for each translation unit:
      fitTextToBox()                  // 自适应字号，塞入原 bbox
      drawLaidOutLines()             // 绘制中文
4. pdf.save()                        // 保存一次
```

**优势**：
- 图片、图表、代码块天然保留（只清除文本对象，不碰图片 XObject）
- 页面布局、分栏、页边距完全不变
- 实现复杂度低
- 文件体积可控（in-place 修改，不复制页面）

**劣势**：
- 中文比英文紧凑，可能留下空白
- 译文比原文长时，需要缩小字号（有最低字号门槛）
- 跨页段落续接处理复杂

**适用**：Manning 技术书籍等单栏/双栏正文为主的 PDF。

#### 方案二：完全流式重排

**原理**：提取所有元素后，丢弃原始布局，按中文阅读习惯从头排版。

**劣势**：
- 实现复杂度极高（需自行处理分页、分栏、图片位置）
- 图片/图表位置需要重新计算
- 与"图片/公式/图表原样保留"的需求冲突
- 校书郎和 BabelDOC 都未选择此方案

**结论**：v1 不采用。

#### 方案三：混合策略——**推荐 v2**

**原理**：正文区域原位替换 + 紧凑化微调，图片/表格/代码块原位保留。

具体做法：
- 正文段落：原位替换，中文排版后测量实际高度，如果比原 bbox 矮，向下微调下一段位置
- 标题：原位替换，字号自适应
- 图片/表格/代码块：完全不动
- 页眉页脚：原位重绘（支持旋转文本）

**这本质上就是校书郎的"保版"策略。**

### B.3 混合 CJK/Latin 文本测量与换行

这是中文排版最核心的技术难点。译文通常是中英混合的（如"使用 React hooks 管理状态"）。

#### B.3.1 字符分类

```typescript
function classifyChar(ch: string): 'cjk' | 'latin' {
  const cp = ch.codePointAt(0)
  // CJK 统一表意文字
  if ((cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // Extension A
      (cp >= 0x3000 && cp <= 0x303f) ||  // CJK 标点符号
      (cp >= 0xff00 && cp <= 0xffef) ||  // 全角形式
      (cp >= 0xf900 && cp <= 0xfaff)) { // 兼容表意文字
    return 'cjk'
  }
  return 'latin'
}
```

#### B.3.2 原子化（atomize）

将文本拆分为可换行的"原子"：
- CJK 字符：每个字符是一个原子，可在任意位置换行
- Latin 单词/URL：整个 token 是一个原子，不可在中间换行

```typescript
interface Atom {
  script: 'cjk' | 'latin'
  text: string
  space: boolean  // Latin token 后的空格（软换行点）
}

function atomize(text: string): Atom[] {
  // CJK: 逐字符原子
  // Latin: 按空格分词，URL 保持完整
}
```

#### B.3.3 测量与换行

```typescript
function wrapMixed(text: string, fonts: EmbeddedFonts, size: number, maxWidth: number): LaidOutLine[] {
  const atoms = atomize(text)
  // 贪心换行：逐原子累加宽度
  // CJK 原子可在任意位置断行
  // Latin 原子 + space 是软换行点
  // 超宽时 flushLine()，开始新行
}
```

**字体测量**：

```typescript
function measureRun(script: 'cjk' | 'latin', text: string, fonts: EmbeddedFonts, size: number): number {
  const font = script === 'cjk' ? fonts.cjk : fonts.latin
  try {
    return font.widthOfTextAtSize(text, size)
  } catch {
    // 字体缺字时的估算回退
    return text.length * size * (script === 'cjk' ? 1 : 0.5)
  }
}
```

#### B.3.4 自适应字号

校书郎的 `fitTextToBox` 策略——**从大到小递减，不低于最小门槛**：

```typescript
function fitTextToBox(
  text: string,
  fonts: EmbeddedFonts,
  box: [number, number, number, number],
  opts: { floor: number; start: number; lineHeight: number }
): FitResult {
  const width = box[2] - box[0]
  const height = box[3] - box[1]

  for (let size = Math.floor(opts.start); size >= opts.floor; size--) {
    const lines = wrapMixed(text, fonts, size, width)
    const totalHeight = lines.length * size * opts.lineHeight
    const widestAtomOk = widestAtom(text, fonts, size) <= width

    if (totalHeight <= height && widestAtomOk) {
      return { size, lines, lineHeight: size * opts.lineHeight, overflow: false }
    }
  }

  // 超过门槛仍放不下 → 按门槛字号绘制，标记 overflow
  return { size: opts.floor, lines: wrapMixed(text, fonts, opts.floor, width),
           lineHeight: opts.floor * opts.lineHeight, overflow: true }
}
```

**推荐参数**（校书郎默认值）：
- `floor`（最小字号）：6pt
- `start`（起始字号）：14pt
- `lineHeight`（行高比）：1.2

### B.4 旧文本层清除（Redaction）

**这是最容易出问题的环节**。如果只是用白色矩形覆盖旧英文，PDF 重新提取时仍会出现隐藏的英文文本层。

#### B.4.1 正确做法：从内容流中删除 BT...ET 对象

校书郎的 `sanitize.ts` 实现了一个字节级内容流扫描器：

```
1. decodePageContent()     // 解码 Flate 压缩的内容流
2. scanTextObjects()       // 扫描所有 BT...ET 文本对象
   - 跟踪 CTM 变换矩阵（q/Q/cm）
   - 跟踪文本矩阵（Tm/Td/TD）
   - 记录每个文本对象的 anchor 坐标
3. sanitizeContent()       // 删除目标文本对象
   - 'all' 模式：删除所有文本对象
   - 区域模式：只删除 anchor 在指定 rect 内的文本对象
4. replacePageContent()    // 替换页面内容流
```

**关键安全保证（fail-closed）**：
- 内容流无法解析时（嵌套 BT、未终止字符串、内联图片无法跳过）→ 返回 `ok: false`，不绘制中文
- 区域模式下文本 anchor 无法定位 → 返回 `ok: false`，不绘制
- 清除后检测残留文本 → 有残留则不绘制

#### B.4.2 清除后验证

```typescript
// 绘制前验证：扫描内容流，确认目标区域内无残留文本对象
function detectTextInRects(content: string, rects: BBox[]): boolean | null {
  const spans = scanTextObjects(content).spans
  for (const span of spans) {
    if (span.anchor === null) return null  // 无法确定 → fail closed
    if (rects.some(r => pointInRect(span.anchor, r))) return true  // 有残留
  }
  return false
}
```

### B.5 图片/公式/图表保留

#### B.5.1 图片保留

**原位修改策略天然保留图片**：因为 `sanitizePage` 只删除 `BT...ET` 文本对象，不删除图片绘制操作（`Do`、`re`、`f` 等）。图片 XObject 完全不受影响。

```typescript
// sanitizeContent 保留的非文本操作符：
// re, f, S, f*, cm, q, Q, Do, BI/ID/EI（内联图片）, path ops
// 删除的只有：BT...ET（文本对象）
```

**如果需要重新放置图片**（如完全重排方案）：

```typescript
// pdf-lib 提取图片
const images = page.node.Resources().lookup(PDFName.of('XObject'))
// 获取 image XObject → 提取 bytes → 在新位置绘制
const embeddedImage = await pdf.embedJpg(or embedPng)(imageBytes)
newPage.drawImage(embeddedImage, { x, y, width, height })
```

#### B.5.2 公式保留

**v1 策略：公式不作为独立元素翻译，而是作为文本内联内容冻结为占位符。**

校书郎的 placeholder 系统：

```typescript
// 翻译前：冻结受保护内容
const PATTERNS = [
  { kind: 'formula', src: '\\$[^$\\n]+\\$' },        // $...$ 行内公式
  { kind: 'url', src: '(?:https?:\\/\\/|www\\.)\\S+' },
  { kind: 'figure-ref', src: '(?:Figure|Fig\\.|Table)\\s+\\d+' },
  { kind: 'citation', src: '\\([A-Z][^)]+\\d{4}[^)]*\\)' },
  // ...
]

// 替换为 §A§, §B§... 不透明 token
// 翻译后按索引恢复（位置无关——NMT 可能重排 token 顺序）
```

**如果公式是独立图片**（如展示公式）：在 capture 阶段标记为 `role: 'image'`，typeset 阶段跳过该区域，原图保留。

#### B.5.3 代码块保留

代码块标记为 `role: 'code'`：
- capture 阶段：提取文本（供参考），但不送翻译
- typeset 阶段：`sanitizePage` 清除旧文本后，在原位置重新绘制等宽字体英文原文（或直接保留原文不清除）

**最简策略**：代码块区域不清除、不重绘，完全保留原文。

### B.6 表格处理

**v1 策略**：表格作为整体保留，仅翻译表标题。

```
1. 检测表格区域（线条检测 + 单元格对齐）
2. 表格内部文本不翻译
3. 表标题（"Table 3: Project timeline"）翻译为中文
4. 表格区域的旧文本层不清除（保留英文表格内容）
```

这是校书郎 `references-keep` 策略的变体——**局部清除（只清除表标题区域），保留页面其余部分**。

### B.7 紧凑排版参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| 正文字号 | 10-11pt | 原文 10-11pt，中文保持一致 |
| 标题字号 H1 | 16-18pt | 比原文略小（中文密度高） |
| 标题字号 H2 | 13-14pt | |
| 行高比 | 1.2 | 中文 1.2 倍行距足够紧凑 |
| 段间距 | 空一行（= 1.2×行高） | |
| 左右页边距 | 继承原文 | 保版模式天然继承 |
| 最小字号门槛 | 6pt | 低于此标记 overflow，不强行缩小 |

---

## Part C: 开源项目参考分析

### C.1 BabelDOC（funstory-ai/BabelDOC）

**核心创新：中间表示（IR）**

BabelDOC 将 PDF 的命令式渲染指令解析为结构化 IR：

```
IR 层级：
  Document
    → Page
      → Character（每个字符的精确坐标、字体、大小）
      → TextLine（字符组成的行）
      → GraphicBlock（矢量图形块）
      → InlineImage（嵌入图片）
```

**IR 的优势**：
- 解析与渲染完全解耦
- IR 同时支持 PDF→PDF（保版）和 PDF→Markdown（重排）两种输出
- 字符级精度，可做自适应字号搜索

**自适应排版算法**（BabelDOC 论文）：
```
for each paragraph:
  scale = 1.0
  while translatedText 不适合 originalBBox:
    scale -= 0.05
    if scale < 0.5: break  # 下限
  draw with scale
```

**对 EnTransfer 的启发**：
- IR 设计值得借鉴，但 v1 不需要完整 IR——校书郎的 `RawLayoutRegion` 扁平结构已足够
- 自适应缩放算法与校书郎的 `fitTextToBox` 思路一致（递减搜索）

### C.2 pdf2zh（BabelDOC 的前身/衍生）

pdf2zh 是早期的 PDF 翻译项目，策略相对简单：
- 用 PyMuPDF 提取文本块
- 翻译后原位粘贴
- 不做精细的文本层清除（存在双层文字问题）

**EnTransfer 不应学习 pdf2zh 的缺点**，应学习 BabelDOC 的 IR 理念和校书郎的 sanitize 策略。

### C.3 Marker（VikParuchuri/marker）

**定位**：PDF → Markdown 转换工具，非 PDF 翻译工具。

**管线**：
1. **文本提取**：启发式 + surya OCR
2. **版面检测**：surya 深度学习模型检测布局和阅读顺序
3. **块格式化**：texify（数学公式 → LaTeX）、tabled（表格 → GFM）
4. **后处理**：合并块、清理页眉页脚

**对 EnTransfer 的价值**：
- **不适合桌面端**：依赖 GPU 深度学习模型（surya），模型体积数 GB
- **阅读顺序推断**：surya 的布局分析精度高，但 v1 用几何启发式即可
- **公式处理**：texify 将公式转为 LaTeX，可作为 v2 的公式识别参考

**结论**：Marker 是 PDF→Markdown 方向的最佳实践，但不适用于"保版 PDF→翻译 PDF"场景。其深度学习版面分析不适合 Electron 桌面端。

### C.4 Nougat（Meta）

**定位**：学术 PDF → Markdown 的端到端视觉 Transformer。

**特点**：纯视觉模型，不依赖 PDF 文本层，直接从页面图像生成 Markdown。

**对 EnTransfer 的价值**：
- **不适用**：纯 OCR/视觉方向，我们的场景是文字版 PDF，不需要 OCR
- 仅在 PDF 为扫描件时才需考虑

### C.5 DocTR

**定位**：OCR 文档提取库。

**对 EnTransfer 的价值**：不适用——我们的输入是文字版 PDF，不需要 OCR。

### C.6 校书郎 typeset 模块（核心参考）

校书郎的 typeset 模块是本项目最直接的参考实现，其设计模式总结：

| 文件 | 设计模式 | 核心思路 |
|------|----------|----------|
| `typeset.ts` | 编排器 | 加载一次 PDF → 逐页调度策略 → 保存一次；绝不 copyPages |
| `strategies.ts` | 策略模式 | 每种页面类型一个策略函数（body/cover/caption/references/index） |
| `draw.ts` | 绘制原语 | `drawLaidOutLines`（混合字体绘制）+ `drawRotatedText`（旋转文本） |
| `measure.ts` | 纯函数测量 | CJK/Latin 分类 → atomize → 贪心换行 → fitTextToBox |
| `fonts.ts` | 依赖注入 | 字体 provider 接口，生产环境注入 NotoSansSC 字节 |
| `sanitize.ts` | fail-closed 清理 | 字节级内容流扫描，删除 BT...ET 对象，验证无残留 |
| `types.ts` | 类型契约 | 输入/输出/问题的完整类型定义 |

---

## 风险点与难点分析

### R1: 跨页表格

**问题**：表格横跨两页，结构提取时被拆成两个独立表格区域。

**应对**：
- v1：不翻译表格内部，仅翻译表标题。跨页表格自然作为两个独立区域保留
- v2：引入跨页检测——如果页面底部有未闭合的表格线，与下一页顶部表格线匹配

### R2: 双栏排版

**问题**：两栏布局的阅读顺序错误，左栏文本混入右栏。

**应对**（校书郎已验证）：
- 按 left edge 聚类分栏（栏间距 = 页面宽度 × 12%）
- 全宽元素（标题/通栏图注）作为 band 分隔符
- 栏内按 top→bottom 排序
- **已知边界情况**：镜像索引页（recto/verso 栏位置不同）需要每页独立检测

### R3: 复杂公式

**问题**：多行展示公式被拆散为多个文本块，翻译后无法还原。

**应对**：
- v1：公式冻结为占位符（`$...$` 正则匹配），翻译后原文恢复
- 复杂公式块：检测数学字体（Cambria Math 等），整块标记为"不翻译"
- v2：考虑用 MathJax/KaTeX 将 LaTeX 公式渲染为图片嵌入

### R4: 脚注

**问题**：脚注文本与正文混在一起，段落合并时污染正文。

**应对**（校书郎 `refinePageRoles` 已解决）：
- 检测窄栏（宽度 ≤ 主栏 55%）且在主栏外侧 → 标记为 `note`
- 检测数字开头的小字号行（`12. `）且在主文本带下方 → 标记为 `note`
- `note` 类型独立流式分段，不与正文合并

### R5: 隐藏双层文字

**问题**：仅用白色矩形覆盖旧英文，PDF 重新提取时英文文本仍在。

**应对**（校书郎 `sanitize.ts` 核心设计）：
- 必须从内容流中删除 `BT...ET` 对象，不能仅视觉覆盖
- 清除后必须扫描验证目标区域无残留文本
- 无法安全清除时 fail-closed（不绘制中文，标记 needs_review）

### R6: 字体子集化兼容性

**问题**：`@pdf-lib/fontkit` 对 CFF/OTF 字体子集化有 bug，可能导致嵌入字体损坏。

**应对**：
- 使用 TTF 格式的 Noto Sans SC（不是 OTF/CFF）
- Google Noto 仓库提供 TTF Variable Font 版本
- 测试输出 PDF 在 Adobe Reader / Chrome / Edge 中正常显示

### R7: 中文溢出 bbox

**问题**：中文译文比英文原文长，无法塞入原 bbox。

**应对**（校书郎 `fitTextToBox`）：
- 从起始字号（14pt）递减搜索，找到最大可容纳字号
- 最低字号门槛 6pt，低于此不继续缩小
- 超出门槛的标记 `overflow: true`，按门槛字号绘制并报告
- **绝不缩到不可读**

### R8: 文件体积膨胀

**问题**：每页嵌入字体或 copyPages 导致 PDF 从 MB 级膨胀到 GB 级。

**应对**（校书郎 typeset.ts 核心不变量）：
- **绝不 copyPages**——在原 PDF 上 in-place 修改
- 字体全文只嵌入一次（CJK + Latin 各一次）
- `pdf.save()` 只调用一次
- 监控输出/源文件大小比（阈值 3×），异常时报告

### R9: 代码块中的缩进/特殊字符

**问题**：代码块中有大量空格、制表符、特殊符号，翻译时可能被破坏。

**应对**：代码块不翻译，capture 阶段标记为 `role: 'code'`，typeset 阶段跳过。

### R10: 目录页/封面

**问题**：封面是位图，直接覆盖会破坏图片。

**应对**（校书郎 cover-overlay 策略）：
- 只覆盖高置信度的标题区域（有验证的背景色）
- 低置信度封面不猜测，标记 needs_review
- 目录页保持英文不翻译（或仅翻译节标题）

---

## 最终技术路线图

### 阶段 1：PoC（2 周）——单页正文翻译

**目标**：用 Manning 测试 PDF 的一页正文，完成端到端流程。

```
技术栈：
  - pdfjs-dist：提取文本块 + 坐标 + 字体大小
  - pdf-lib + @pdf-lib/fontkit：嵌入 NotoSansSC + 绘制中文
  - 翻译：调用外部 API（用户自行接入）

流程：
  1. pdfjs-dist 提取第 N 页文本 items → RawLayoutRegion[]
  2. 按 y 坐标排序（简单版：top→bottom, left→right）
  3. 按段落合并（pitch ≤ 1.5×行高）
  4. 提取正文文本 → 翻译 API → 中文译文
  5. pdf-lib 加载 PDF → 嵌入 NotoSansSC（subset: true）
  6. sanitizePage('all') 清除第 N 页文本
  7. fitTextToBox 自适应字号 → drawLaidOutLines 绘制
  8. 保存 PDF → 验证显示
```

**验收标准**：单页正文中文显示正常，无乱码，无双层文字。

### 阶段 2：核心管线（4 周）——全书结构提取 + 保版排版

**目标**：完整管线，支持标题/正文/图注/代码块分类。

```
模块拆分（参考校书郎目录结构）：

electron/pdf/
  capture/
    extract.ts       # pdfjs-dist 提取文本块 + 图片位置
    segment.ts       # 段落合并 + 元素分类（标题/正文/图注/代码块）
    readingOrder.ts  # 多栏阅读顺序排序
    placeholders.ts  # 公式/URL/引用 占位符
    types.ts         # RawLayoutRegion / TranslationUnit 类型

  typeset/
    typeset.ts       # 编排器：加载 → 嵌入字体 → 逐页排版 → 保存
    strategies.ts    # 页面策略：body-redact-refill / cover-overlay / caption-clean
    draw.ts          # 绘制原语：混合 CJK/Latin 文本
    measure.ts       # 换行 + 自适应字号
    fonts.ts         # 字体嵌入（一次性）
    sanitize.ts      # 旧文本层清除 + 验证
    types.ts         # EmbeddedFonts / TypesetInput / TypesetResult 类型
```

**验收标准**：
- 全书 PDF 翻译后无乱码
- 图片/代码块/公式原样保留
- 文件体积不超过源文件 3×
- 无双层文字问题

### 阶段 3：精细打磨（4 周）——边界情况处理

**目标**：处理跨页续接、双栏、脚注、封面等复杂情况。

```
新增功能：
  - 跨页段落续接检测（continuation link）
  - 双栏阅读顺序优化（band 分解 + column 聚类）
  - 脚注/边注识别与独立排版
  - 封面标题区域覆盖（高置信度才覆盖）
  - 溢出/歧义报告（QA check 系统）
  - 页眉页脚旋转文本重绘
```

### 阶段 4：Python sidecar（可选，按需）

**触发条件**：阶段 2-3 中表格线检测不满足需求。

```
sidecar 方案：
  - spawn 一个 portable Python 进程（shell: false）
  - JSON-over-stdin/stdout 通信协议
  - PyMuPDF 提取 rawdict 级 span 信息 + 表格线检测
  - sidecar 只做结构分析，翻译和排版仍在 Node.js 侧
```

---

## 附录：关键代码模式参考

### A. pdfjs-dist 文本提取

```typescript
const textContent = await page.getTextContent()
const items = textContent.items.filter(i => 'str' in i)

for (const item of items) {
  const style = textContent.styles[item.fontName]
  blocks.push({
    text: item.str,
    x: item.transform[4],
    y: item.transform[5],
    fontSize: Math.abs(item.transform[3]),
    fontName: item.fontName,
    fontWeight: style.fontWeight,
    width: item.width,
    height: item.height,
    hasEOL: item.hasEOL,
    bbox: [item.transform[4], item.transform[5],
           item.transform[4] + item.width, item.transform[5] + Math.abs(item.transform[3])]
  })
}
```

### B. pdf-lib 字体嵌入 + 绘制

```typescript
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'fs'

const pdf = await PDFDocument.load(pdfBytes)
pdf.registerFontkit(fontkit)

const notoSansSC = readFileSync('./assets/fonts/NotoSansSC-Regular.ttf')
const cjkFont = await pdf.embedFont(notoSansSC, { subset: true })
const latinFont = await pdf.embedFont(StandardFonts.Helvetica)

const page = pdf.getPage(0)
page.drawText('你好，世界', {
  x: 72, y: 720,
  size: 11,
  font: cjkFont,
  color: rgb(0.1, 0.1, 0.1)
})
```

### C. 旧文本层清除（核心）

```typescript
// 解码内容流 → 删除 BT...ET → 替换
const content = await decodePageContent(page, lib)
const { content: sanitized, removed } = sanitizeContent(content, 'all')
if (removed > 0) {
  replacePageContent(page, sanitized, lib)
}
// 验证：扫描清除后内容，确认无残留文本对象
const residual = detectTextInRects(readPageContentString(page, lib), paintRects)
if (residual === true) {
  throw new Error('旧文本层未完全清除，拒绝绘制')
}
```

### D. 自适应字号换行

```typescript
// 从 14pt 开始递减，找到最大可塞入 bbox 的字号
const result = fitTextToBox(chineseText, fonts, bbox, {
  floor: 6,      // 最小 6pt
  start: 14,     // 起始 14pt
  lineHeight: 1.2 // 行高比
})
// result.size 为最终字号
// result.lines 为换行后的 LaidOutLine[]
// result.overflow 为 true 表示仍超出（按 floor 字号绘制）
```

---

## 参考资料

1. **校书郎源码**：`C:\Users\_Cole\main\code\xiaoshulang\xiaoshulang\electron\translation\`
   - `capture/` — PDF 结构提取（capture.ts, segment.ts, readingOrder.ts, placeholders.ts）
   - `typeset/` — 中文重排版（draw.ts, measure.ts, fonts.ts, strategies.ts, sanitize.ts, typeset.ts）
   - `preflight/` — 页面分类（classify.ts, columns.ts）
2. **BabelDOC**：arXiv:2605.10845 — "Better Layout-Preserving PDF Translation via Intermediate Representation"
3. **Marker**：github.com/VikParuchuri/marker — PDF→Markdown 深度学习管线
4. **pdfjs-dist**：mozilla.github.io/pdf.js — `getTextContent()` API
5. **pdf-lib**：pdf-lib.js.org — `embedFont()` + `@pdf-lib/fontkit`
6. **PyMuPDF**：pymupdf.readthedocs.io — `get_text("rawdict")` span 级提取
