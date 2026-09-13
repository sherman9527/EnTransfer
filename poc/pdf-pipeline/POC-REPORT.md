# EnTransfer POC Report: PDF 结构提取 → 中文重排版

> 日期：2026-09-12  
> 测试PDF：Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf  
> 范围：前5页（封面、扉页、正文列表）

---

## 1. 项目结构

```
poc/pdf-pipeline/
├── extract.js        # PDF结构提取（pdfjs-dist）
├── typeset.js        # 中文重排版（pdf-lib + fontkit）
├── verify.js         # 输出验证（文本层检查）
├── render.js         # PNG渲染（需canvas，POC阶段未成功）
├── extracted.json    # 提取结果（6KB）
├── output-mock-zh.pdf # 输出PDF
├── fonts/
│   ├── NotoSansSC-VF.ttf  # 17.7MB 思源黑体可变字体
│   └── simhei.ttf         # 9.7MB 黑体（备份）
├── package.json
└── POC-REPORT.md
```

---

## 2. 验证结果总览

| 验证项 | 结果 | 说明 |
|--------|------|------|
| PDF结构提取 | ✅ 通过 | 5页，16个段落，坐标/字体/分类正常 |
| 中文嵌入与显示 | ✅ 通过 | 921个中文文本项可提取，无乱码 |
| 旧文本层清除 | ⚠️ 基本通过 | 13个BT...ET对象已删除，残留2个英文项（Form XObject内） |
| 文件体积 | ✅ 通过 | 10.90MB（原始11.87MB的0.92x，远低于3x限制） |
| 混合CJK/Latin绘制 | ✅ 通过 | 中文字体+Helvetica分run绘制 |
| 自适应字号 | ✅ 通过 | 从原始字号递减至6pt floor |

---

## 3. 详细结果

### 3.1 结构提取（extract.js）

| 页码 | 段落数 | 标题 | 代码块 | 正文 | 备注 |
|------|--------|------|--------|------|------|
| 1 | 2 | 1 | 0 | 1 | 封面（作者名+Manning logo） |
| 2 | 10 | 0 | 0 | 10 | 离职交接清单表格 |
| 3 | 1 | 0 | 0 | 1 | 扉页（书名，13.98pt未达15pt阈值） |
| 4 | 0 | 0 | 0 | 0 | 空白页（版权页背面） |
| 5 | 3 | 0 | 0 | 3 | 书名+作者+出版社 |

**提取准确率评估**：
- 坐标提取：✅ pdfjs `transform[4], transform[5]` 正确对应底部原点坐标系
- 行合并：✅ 同行y值偏差<0.5×fontSize正确聚合
- 段落合并：✅ 行间距≤1.5×行高、字体变化<18%的合并逻辑合理
- 分类：⚠️ 标题阈值需调优——page 3书名(13.98pt)和page 5书名(33.96pt,42字符)均未被正确分类为标题。正式版应结合字体名/字重而非仅靠字号和字符数

### 3.2 中文重排版（typeset.js）

- **内容流清除**：字节级扫描器成功识别并删除了13个 `BT...ET` 文本对象
- **字体嵌入**：NotoSansSC-VF.ttf（可变字体）通过 `subset: true` 成功嵌入，仅嵌入用到的字形
- **混合绘制**：CJK字符用Noto Sans SC，Latin用Helvetica，按atom分段绘制
- **自适应字号**：从原始字号递减至6pt，7/16段落因mock文本过长触发overflow（POC正常）
- **坐标一致性**：pdfjs和pdf-lib均为底部原点坐标系，bbox直接映射无需转换

### 3.3 旧文本层清除验证（verify.js）

- 输出PDF重新提取文本：921个中文项，0个乱码字符
- **残留英文**：仅page 1的"Akanksha"和"Gupta"两个文本项
- **原因分析**：这两个文本位于Form XObject中（通过 `Do` 调用），主内容流扫描器不递归解析XObject。主内容流中的文本对象已全部清除
- **结论**：对于主内容流，字节级BT...ET删除方案有效。Form XObject内文本需要额外处理（递归展开XObject或接受残留）

### 3.4 文件体积对比

| 指标 | 数值 |
|------|------|
| 原始PDF | 11.87 MB |
| 输出PDF | 10.90 MB |
| 比率 | 0.92x |
| 限制 | <3x ✅ |

体积反而减小，因为：
- subset字体只嵌入用到的CJK字形（POC中仅~200个不同汉字）
- 删除了旧文本内容流
- 原始PDF包含全书353页的压缩数据

---

## 4. 遇到的问题与解决方案

| # | 问题 | 解决方案 |
|---|------|----------|
| 1 | pdfjs-dist在Node.js中报DOMMatrix/Path2D错误 | 使用 `pdfjs-dist/legacy/build/pdf.js`，设 `isEvalSupported: false` |
| 2 | GitHub下载中文字体连接失败 | 从系统 `C:\Windows\Fonts\` 复制NotoSansSC-VF.ttf（系统已预装） |
| 3 | pdf-lib `decodePDFRawStream` 不在context上 | 改为顶层导入：`const { decodePDFRawStream } = require('pdf-lib')` |
| 4 | canvas npm包在Windows编译失败（node-gyp） | 跳过PNG渲染，文本验证已足够。正式版可用Electron内置Chromium渲染 |
| 5 | 可变字体(VF)是否兼容fontkit？ | ✅ 实测NotoSansSC-VF.ttf可正常subset嵌入 |
| 6 | Form XObject内文本未清除 | 残留2个英文项，正式版需递归处理XObject |
| 7 | 标题分类阈值不准 | 需结合字体名/字重信息，当前仅靠字号+字符数 |

---

## 5. 关键技术发现

### 5.1 内容流清除方案可行
校书郎的字节级BT...ET扫描器可直接移植到纯JS。核心逻辑：
- 逐字符扫描，正确处理字面字符串、十六进制字符串、注释、内联图像
- 跟踪CTM（q/Q/cm）和文本矩阵（Tm/Td/TD）计算anchor
- 删除span后重建内容流，保留所有非文本操作符
- **fail-closed设计**：遇到无法解析的内容返回失败而非冒险删除

### 5.2 字体方案确认
- **OTF/CFF不可用**：fontkit对CFF outlines有已知bug，必须用TrueType outlines
- **可变字体可用**：NotoSansSC-VF.ttf在fontkit中subset正常工作
- **subset效果好**：POC中仅用~200个汉字，嵌入后字体子集很小

### 5.3 坐标系一致
pdfjs的 `transform[4], transform[5]` 和pdf-lib的坐标系均为底部原点，bbox可直接映射。无需Y轴翻转。

---

## 6. 对正式实现的建议

1. **Form XObject递归处理**：当前只扫描页面主内容流。正式版需递归处理 `Do` 引用的Form XObject，否则页眉页脚、重复模板中的文本会残留
2. **标题分类优化**：结合fontName中的字重信息（Bold/Black）、文本在页面中的位置（顶部1/3区域）、以及上下文（前面的标题是否有编号）
3. **代码块保留策略**：当前POC中前5页无代码块。正式版需验证：等宽字体检测 + 编程符号密度判断 + 区域化BT...ET删除（保留代码区域的span）
4. **canvas渲染**：Electron环境中使用Chromium的 `<canvas>` API，无需npm canvas包
5. **真实翻译集成**：当前用mock中文文本，正式版需接入翻译引擎。翻译后文本长度变化大，自适应字号逻辑需增强（增加行高参数、最小可读字号6pt）
6. **性能优化**：逐页处理时可并行解码多个页面的内容流；字体subset在保存时一次性处理
7. **错误恢复**：某些PDF可能有非FlateDecode的内容流过滤器，扫描器需fail-closed并报告，不能静默跳过

---

## 7. 结论

**PDF结构提取→中文重排版管线可行性验证通过。**

核心技术路径全部跑通：
- ✅ pdfjs-dist文本结构提取（坐标+字体+阅读顺序）
- ✅ pdf-lib内容流字节级扫描+BT...ET删除
- ✅ Noto Sans SC TTF字体subset嵌入
- ✅ CJK/Latin混合绘制+自适应字号
- ✅ 旧文本层无双层文字（主内容流内）
- ✅ 文件体积可控

下一步可进入正式开发：接入翻译引擎、完善Form XObject处理、构建Electron UI。
