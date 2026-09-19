# E6 · 评估结论与架构决策（2026-09-19 上午）
> 依据：E0-E5 本机实测（数据文件在 `poc/eval-2026/results/`），不采信任何外部项目的测试报告。约束（用户拍板）：不引入 CUDA；GPU 可用必用 Vulkan，**GPU 故障时 CPU 必须顶上来继续跑**；体积不爆炸；目标=比参考项目（EnTransferQt）更好/更精巧/更严谨/更快。
> **09-19 修订：许可不作为约束**（本地自用，AGPL/许可不清的 MinerU、MuPDF 等重进候选池）；筛选标准只剩 效果 × 体积 × 集成复杂度。Phase 2 允许把 Docling/MinerU 当"效果上限参照"跑分（不一定进产品）。

## 一、实测结论一览

| 项 | 数据 | 判定 |
|---|---|---|
| E1 提取审计（全书） | 段落过度切分 **8.2%**、碎片 8.9%、表格召回 **~75%**、图片提取率 **31%**(9/29+矢量图全漏)、顺序倒退/TOC 泄漏=0 | 主要短板=图片与表格召回；段落问题是规则可修的 |
| E2 排版 A/B（60页同块双渲染） | Chromium 30页/7.6MB/12.5s vs pdf-lib 26页/24MB/0.7s；字体自动子集化（AAAAAA+YaHei 实证）；跨页/孤寡行/表格结构性胜出；两家同源缺陷（未译单元格）证明排版层背锅完毕 | **采纳 Chromium 主排版，pdf-lib 降级为 fallback** |
| E3 校验器 | 误报 **0/80**、坏译文检出 **55/57**、合成破坏 52/60；两轮校准（单位换算/中文数词） | 采纳为管线内两阶段校验；语义漏译它测不出→靠 E5 |
| E4 缓存 | 冷 16s/24 调用 → 热 **0s/0 调用**；键敏感（prompt 版本变更即失效） | 采纳（崩溃续跑/排版回归零模型成本） |
| E5 对抗集 | **26/26** 通过（含数字/否定/URL/术语/引用/被动语态等）；已知弱点实录：长句压缩漏尾句（1例）、球队/team 领域歧义（校验测不出，人审发现） | 作为永久质量门禁 |
| 速度定论（昨夜+今晨） | 投机/多序列/低比特=全负；fa +2.6%；编号批次回退 48→5%（全书 112/5） | 单序列 Q4_K_M+前缀复用+批次 = 当前最优解锁定 |

## 二、Docling 的替代方案调研（用户质询后补做，结论：有，且更配我们）

| 路线 | 许可 | 体积代价 | 依赖 | 判定 |
|---|---|---|---|---|
| Docling 全家桶（Python sidecar） | MIT，但运行时要 Python+torch 级依赖 | +数百 MB~GB（参考项目 1.14GB 之根源） | 子进程 Python | ❌ 违背体积红线 |
| MinerU / marker | AGPL 或许可不清 | — | Python | ❌ 许可/体积 |
| **PP-DocLayout-S**（PicoDet-S 骨干，Apache-2.0，论文 arXiv:2503.17213，CPU 实时） | **Apache** | ONNX **~10-30MB** | **onnxruntime-web（Electron 渲染进程内 WASM/WebGPU，无新原生依赖）** | ✅ **Phase 2 唯一候选** |
| 规则/语言学修复（大小写续接合并、跨页重复边带、表格锚点松绑） | 0 | 0 | 纯 TS | ✅ 先做，吃掉 8.2% 里的大头 |
| 图片矢量区域光栅化（pdfjs render 已有：Electron 渲染进程自带 canvas） | 0 | 0 | 已有 | ✅ 修 31% 图片召回，无新依赖 |

要点：**先规则+光栅化（免费），再决定是否上 PP-DocLayout-S（+30MB 封顶）**。onnxruntime-node 实测 301MB 解包——排除；浏览器侧 onnxruntime-web 才是 Electron 的正确打开方式，且 WebGPU 坏了自动回退 WASM=天然符合"GPU 坏 CPU 顶"策略。

## 三、GPU 故障接管（用户修正后的设计）
- 现状：启动探测失败→CPU ✓；**运行中 GPU 挂（驱动丢失/显存 OOM/推理卡死）→ 现在只是 job=error**。
- 设计：`EngineManager` 加健康状态机——连续 N 次引擎异常或单段翻译超时看门狗（如 240s 无 token）→ dispose → `device:'cpu'` 重载 → **当前 job 从 jsonl 检查点无缝续跑**（per-unit 持久化已具备，改动集中在 manager/pipeline 各 ~40 行）；UI 显示"GPU 异常，已切换 CPU 继续（速度约降 8×）"。恢复后再探测可回切。

## 四、集成计划（按此顺序做，每步带回归）
**Phase 1（本轮做）**
1. HTML composer + `printToPDF` 主排版（pdf-lib 保留为 fallback；line-height 1.6 折中页数）
2. 校验阶梯接进 `translateText`（两阶段 validate + 单块降级 + quality-report.jsonl + 回退徽章类名）
3. 翻译缓存接入（getEngine 后按 unit 查询；命中仍过校验）
4. GPU→CPU 运行时接管 + 看门狗
5. 规则式提取修复：小写续接合并、无标点段落合并策略收紧、跨页重复边带检测（目标：8.2%→<3%）
**Phase 2（Phase 1 数据出来后拍板）**：矢量图区域光栅化；术语表文件；PP-DocLayout-S ONNX POC（renderer 内）
**Phase 3（外部依赖就绪才做）**：Hy-MT2 TQ2 档（用官方 llama.cpp 预编译验证中）；蒸馏 0.6B
**体积账**：Phase 1 全部 **0 新增**；Phase 2 最坏 +30MB（若 ONNX 上）；模型仍 1.22GB。
**回归门禁**：每次改动跑 E5 套件(26例) + 12页 E2E + verify-build + 缓存命中断言。

## 五、已知未解（诚实清单）
- 长句压缩漏尾句（1.7B 模型能力线；候选：尾部完整性 prompt 强化/超长句拆分翻译——E5 已能自动抓）
- 领域词歧义（team→球队）→ 术语表/上下文注入解（Phase 2）
- 表格召回 75%：锚点法上限；PP-DocLayout-S 或人工 sample 修
- printToPDF 对 Edge 版本无关（Electron 自带 Chromium，反而是优势：渲染器**钉死在我们构建版本**，参考项目用系统 Edge 才有版本漂移坑）
