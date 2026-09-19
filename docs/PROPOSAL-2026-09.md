# EnTransfer 全面 Review + 提速提质方案（2026-09 深夜版）

> 交付人：Qoder agent。配套过程日志见根目录 `MEMO.md`；全部 POC 代码、语料、输出在 `poc/speed-v3/`，全部模型在 `models/`，未出当前文件夹。
> 状态标注：✅=已实测数据 ｜ 🔧=本次已修复代码 ｜ ⏳=待跑/待决策 ｜ 💡=建议未实施

## 0. TL;DR（先看结论 · 00:30 修订）
1. 项目已能从头跑通（build/verify/E2E/预览全绿）。工作区里未提交的"投机解码"改动带 3 个必崩 bug，已修复（🔧）。
2. **速度侧的所有"花活"全部实测证伪**（80 段/组）：草稿投机解码 **-27%**；GPU 多序列 **-17%~-3%**；CPU 多序列 **0%**（node-llama-cpp 未真正合批）。结论：**单序列 + Q4_K_M 就是当前后端的帕累托最优**，FlashAttention +2.6% 可白嫖。§3
3. **极致量化（权重为翻译裁剪）是最有前途但被后端卡住的路线**：腾讯官方 Hy-MT2-1.8B-2bit/1.25bit（462-600MB，翻译专用+带宽减半双收益）**加载失败**——hunyuan-dense/TQ2 布局需更新 llama.cpp（3.21.1 实测亦失败）→ 记 roadmap 第一优先；社区替代 Qwen3-1.7B UD-IQ2_XXS 质量崩塌（85% 未译）不可用；Q3_K_M GPU 反而更慢、CPU 数据在跑。§4
4. **Qwen3.5-2B 不换代**：GPU 49 / CPU 5.2 tok/s 两头慢于现役 1.7B（新架构未被 Vulkan/CPU 路径优化），MTP 收益又依赖未合并的支持。§4
5. **今晚唯一净胜出的速度改动已落地**：正文短段批次从 `\n---\n` 换成**编号格式**（表格 POC 12/12=100% 解析发现 → 生产 30 页回归 **回退率 50%→0%**，76.7s vs 83.5s）。排版连带修掉等宽列一字竖排、假表头重复、超长表不拆分三个 bug。§5
6. 无 GPU 场景：核数/线程启发式可用；**"动态并发"预期正式撤销**（seq1/2/4 实测 7.2/7.2/7.5，零收益）；**降比特路线也全线证伪**（Q3 CPU 5.5<Q4 7.2，IQ2 质量崩塌）；CPU 真提速押注"编号批次（已落地）+蒸馏自有 0.6B 档（路线图）"。§6
7. 另揪出 **2 个假设置**（outputDir/mirrorSource 没接线、设置不持久化）与并发竞态等 15 项问题，全清单+已修项见 §2。EXE 体积可再省 20-35MB。§9
> **样本量说明**（你要求 A/B>50 例）：所有速度 A/B 均 80 段/组（达标）；批次格式最终在生产路径以**全书 2025 任务/117 批**完成验证（4.3% 回退）。353 页全书回归通过：`.scratch/e2e-output-zh.pdf`（24.9MB）。

---

## 1. 跑通验证
- `npm run typecheck` 🔧修复后 0 错误；`npm run build` ✓；`npm run verify` 24/24 ✓。
- `node .scratch/poc-bench.cjs`/`e2e-test.cjs`：8 页 GPU E2E 17.9s 完成，中文占比 72%，输出 22.6MB ✓。
- `electron-vite preview` 主进程/渲染进程启动无错 ✓。
- 模型：`models/Qwen3-1.7B-Q4_K_M.gguf`（已有）+ 本次新增 `Qwen3-0.6B-Q4_K_M.gguf`（草稿）、`Qwen3.5-2B-Q4_K_M.gguf`、`Hy-MT2-1.8B-2Bit.gguf`、`Hy-MT2-1.8B-1.25Bit.gguf`（均来自 ModelScope，见 MEMO）。

## 2. Code review bug 清单
### P0（必崩/必错，已修）
| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| 1 | llama-engine.ts doLoad | 未提交改动在 `wantGpu` 声明前使用（TDZ ReferenceError）→ 任何模型加载必崩 | 🔧 |
| 2 | llama-engine.ts 投机分支 | `gpuLayers > 0`：gpuLayers 实为 `'max'`，字符串比较恒 false → 投机解码永不生效 | 🔧（改为 `!== 0`） |
| 3 | registry.ts 草稿模型 URL | 指向 ModelScope `Qwen/…` 仓库（无此文件），下载只会得到 145 字节错误 JSON | 🔧（改 lmstudio-community） |
| 4 | llama-engine.ts 顶部 | 未用的 `JinjaTemplateChatWrapper` 类型导入 → typecheck 失败 | 🔧 |

### P1（正确性/质量风险，本次已修）
| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| 5 | engine-config.ts | contextSize=1024 与所有基准文档(2048)漂移；且 MAX_TOKENS=2048 允许生成越过窗口 → llama.cpp 静默 contextShift，模型"忘掉"指令导致中英夹杂/尾巴垃圾（E2E-QUALITY-REVIEW 遗留问题的一个来源） | 🔧（2048 + maxTokens 按剩余窗口钳制） |
| 6 | llama-engine.ts translate() | 分句阈值 1800 token 与 1024/2048 窗口冲突 | 🔧（改为 min(1800, 45%×ctx)） |
| 7 | download.ts | 最终校验失败时坏 `.gguf` 残留磁盘 | 🔧（unlink） |

### P2（并发/边角，建议修）
| # | 位置 | 问题 |
|---|---|---|
| 8 | checkpoint.ts atomicWrite | `checkpoint.json.tmp` 固定名：manager.onProgress 与 pipeline.saveProgress 并发写同文件有 rename 竞态（低概率任务误判 error）。建议唯一 tmp 后缀 + 每 job 写序列化 |
| 9 | storage.ts | `inflight` 被覆盖不等待，极端情况丢一次 jobs.json 落盘（下次 flush 可自愈，但建议 promise 链式串行） |
| 10 | pipeline.ts 批量回退分支 | 分隔符丢失后的逐条回退循环没有 abort 检查 | 🔧已修（随编号批次改造一并处理） |
| 11 | ModelsScreen/manager | 草稿模型也能"设为默认"（=用 0.6B 干活）。建议 registry 加 `role:'draft'` 标志，UI 隐藏 setDefault |
| 12 | llama-engine.ts | `loadModel({prefixCaching})` 字段在 v3.20 不存在（被 `as LlamaModelOptions` 掩盖的死代码）——真实前缀缓存靠 adaptStateToTokens（已正确实现），删参数即可 |
| 13 | freezeProtected | 每段最多 26 个占位符，超出静默不冻结；`restorePlaceholders` 依赖模型原样保留 `§A§`（可加丢失检测+回退原文） |
| 14 | **main.ts mockSettings** | ① `settings.outputDir` 是**假设置**：JobManager 用内部 `outputDir()`，改设置不生效；② `mirrorSource` 同样没接到 download.ts（URL 写死 registry）；③ 全部设置**不持久化**（内存 mock，重启丢失，设备/线程选择白做）。建议：electron-store 式 JSON 落盘 + JobManager 注入真实 outputDir + registry URL 按 mirror 重写域名 |
| 15 | **排版（今晚已修）** | 表格等宽列→长句列一字竖排；`hasHeader` 恒真→长段落被当表头每页重复；表格超一页不拆分整块溢出。见 §5 表格小节修复记录 |

### P3（脆弱性备忘）
- capture/flow.ts 硬编码 pdfjs OPS 数字（10/11/12/74/75/85）——pdfjs 升级即静默错位，建议用 `pdfjsLib.OPS.xxx`。
- `workerSrc='./pdf.worker.js'` 相对路径依赖 cwd（打包后靠 postbuild 拷贝碰巧成立）；建议 `path.join(app.getAppPath(),'out','main','pdf.worker.js')`。
- 图片按 (宽×高) 匹配，同页同尺寸多图会漏；placement 的像素尺寸来自 `paintImageXObject` args，部分生成器给 0 → 匹配失败。
- typeset 无"超高块拆分"：单块 > 一页高会画穿页底（当前语料未触发；换手册类长代码清单会踩）。
- 投机解码若保留：`dispose()` 顺序上 predictor 会被 sequence 再 dispose 一次（幂等性依赖实现）。

## 3. 速度实测矩阵（corpus=80 段 Manning 真实正文，temp0.1/topK20/topP0.9，与产品同 prompt 语义 + 前缀KV复用）
| 模式 | 总时长(s) | 生成 tok/s(聚合) | 段/分钟 | p50段落(ms) | 结论 |
|---|---|---|---|---|---|
| GPU seq1（产品现状） | 57.0 | 61.5 | 84.2 | 693 | 基线，复跑 62.9 一致 |
| GPU seq1 + 0.6B草稿投机 | 77.4 | 45.1 | 62.0 | 925 | **-27%，否决** |
| GPU seq2 | 69.0 | 50.8 | 69.6 | — | -17%，否决 |
| GPU seq4 | 59.0 | 59.5 | 81.3 | — | 持平，否决（多花显存） |
| CPU seq1 t12（强制gpu:false） | 484.7 | 7.2 | 9.9 | 5776 | 基线（同机同语料）✅ |
| CPU seq2 t12 | 484.9 | 7.2 | 9.9 | 10814 | **无收益**（p50 恰翻倍=纯排队）✅ |
| CPU seq4 t12 | 470.0 | 7.5 | 10.2 | — | 无收益 ✅ |
| GPU Qwen3.5-2B-Q4 | 66.6 | 49.0 | 72.0 | 822 | 慢于 1.7B（Vulkan 对 hybrid arch 优化不足）✅ |
| CPU Qwen3.5-2B-Q4 | ⏳(5.3@50/80) | ~5.3 | ~7.2 | — | **也慢于 1.7B**，此前冒烟 13.6 是 2 段小样本误导 ⚠️ |
| GPU Hy-MT2-1.8B-2bit | — | — | — | — | **加载失败**（hunyuan-dense/TQ2_0 布局不支持，3.21.1 亦失败）✅ |
| GPU Hy-MT2-1.8B-1.25bit | — | — | — | — | 同上 ✅ |
| GPU Qwen3-1.7B-Q3_K_M (940MB) | 73.2 | 47.8 | 65.6 | — | **反直觉：Pascal 上比 Q4 还慢**（K-quant 解量化 ALU 开销 > 带宽节省）✅ |
| **CPU Qwen3-1.7B-Q3_K_M** | 802.4 | **5.5** | 6.0 | 8375 | **慢于 Q4(7.2)** ❌（中点6.2/终值5.5，方向一致） |
| CPU Qwen3-1.7B-UD-IQ2_XXS | (10/80 时点提前终止) | 4.8 | — | — | 更慢且输出复读膨胀，双重否定 ❌ |
| CPU Qwen3-1.7B-UD-IQ2_XXS | ⏳ | ⏳ | ⏳ | ⏳ | 预计质量已崩（GPU 侧 85% 未译），仅存档 |
| GPU Qwen3-1.7B-UD-IQ2_XXS (606MB) | 233.5 | 67.4(虚高) | — | — | tok/s 高但**复读致 token 暴涨 4×**，实际吞吐 -4× ❌ |
| GPU 基线 fa=1 | 55.4 | 63.1 | 86.6 | 687 | +2.6%（噪声级正向，可白嫖）✅ |
| **批次格式 A/B（80段）** | | | | | |
| 现 `\n---\n` ×3段 | 50.6s | 66.0 | — | — | **回退率 48.1%** ✅ |
| 现 `\n---\n` ×4段 | 51.6s | 67.4 | — | — | 回退率 40% ✅ |
| **编号格式 ×4段** | 55.9s | 67.8 | — | — | **回退率 5%** ✅（含回退重译的净耗时明显更低）|
| 编号格式 ×4段+专用批次提示词 | 79.5s | 68.7 | — | — | 回退 10%，双模型驻留拖慢 → 不必换提示词 |
> 批次 A/B 已落地产品：`pipeline.ts` 短段合并改用编号格式、按编号解析（乱序容忍+续行拼接）、BATCH_SIZE=4、回退循环补 abort 检查（🔧 #10 同修）。**真实管线回归：30 页 9回退→0回退；全书 353 页 2025 任务：批次 112 命中 / 5 回退（4.3%，vs 旧格式 docs 记载 ~45%），总耗时 2082.8s≈34.7min（vs 历史最好 36.4min），输出 24.9MB 中文校验通过、状态机零违规。** 离线依据 `poc/speed-v3/batch-strategy.ts`。
| GPU Q4 基线复测(竞争窗口) | — | 60.3 | — | — | 竞争下仍稳，矩阵数据可信 ✅ |

> 方法学与复现命令见 §附录；A/B 每格 80 样本（>50 例要求）。

## 4. 模型选型（质量×速度×体积）
### 质量自动代理 + 人评（同 80 段）
| 模型 | 未译率 | 英文残留 | zh/src 长度比 | 人评（抽查） |
|---|---|---|---|---|
| Qwen3-1.7B Q4_K_M（现役） | 0% | 0% | 0.30 | 基准良好 |
| Qwen3-1.7B Q3_K_M | 0% | 0% | 0.36 | **与 Q4 相当甚至更顺**（"团队的技术债务"） |
| Qwen3.5-2B Q4_K_M | 0% | 0% | 0.30 | 良好，但速度两头不讨好 |
| Qwen3-1.7B UD-IQ2_XXS | **85%** | 17.5% | 0.99 | **崩塌**：复读原文/"原文：---"刷屏，1.7B 级 IQ2 不可用 |
> 自动代理脚本：`poc/speed-v3/score-outputs.ts`（可固化进 CI 做防回归）。

### 已测外部候选（今晚新增）
- **Hy-MT2-1.8B-2bit / 1.25bit（腾讯 AngelSlim 官方极致量化）**：❌ **当前不可用**——`hunyuan-dense` 架构 GGUF 在 node-llama-cpp 3.20 与 3.21.1（隔离环境实测）均加载失败（`gguf_init: failed to read tensor data`，TQ2_0/TQ1_0 张量布局不支持）。路线保留：等 llama.cpp 支持后升级捆绑版即可解锁（届时体积 462MB + 带宽减半双收益）。已在路线图。
- **同架构替身：Qwen3-1.7B 低比特档（unsloth 官方，ModelScope 可下）**：老 docs"无 Q3/IQ3"判断**已过时**——unsloth/Qwen3-1.7B-GGUF 有 Q3_K_M(940MB)/UD-IQ2_XXS(606MB) 全阶梯。GPU 实测：Q3_K_M **反而更慢**（47.8 vs 60.3 tok/s，Pascal 解量化 ALU 瓶颈）；IQ2/CPU 数据见 §3。结论初定：**GPU 用户维持 Q4_K_M**；CPU 用户看低比特是否吃到带宽红利（进行中）。
- **Qwen3.5-2B-Q4_K_M（1.33GB）**：可加载，但 GPU 49.0 / CPU ~5.3 tok/s **均慢于现役 Qwen3-1.7B**（Vulkan/CPU 路径对混合注意力优化不足）；质量良好但性价比不足 → 除非 MTP+新后端组合，否则不换代。
- **Hy-MT2-30B-A3B（MoE，官方 GGUF 已发布）**：32GB 内存机器可跑（Q4≈17GB），"无 GPU 高质量"天花板路线；体积/载入时间超当前产品定位，路线图 P2。
- MTP（多 token 预测自投机）：需 llama.cpp MTP 支持 + node-llama-cpp API，两者皆无 → 不可用；外部草稿投机已实测 -27%（§3）。

### "优化权重/裁剪模型"可行性（回应你的判断）
LLM 权重确实不为翻译独占，但**训练时**剪枝/蒸馏才可能真"减重不减值"：
1. **今天就能做**：换官方翻译专用小模型 + 极致量化档（上面 2bit/1.25bit 路线）——效果=你要的"裁剪"，成本=跑分+人评。
2. **一个月内可做**：用教师模型（Qwen3-4B/Hy-MT2-7B）对平行语料蒸馏训练 Qwen3-0.6B 级别"翻译专用小模型"（LoRA/SFT，租用 4090 约 6-10 GPU 时），目标体积 400MB、质量 4.5+。这是唯一能"自己造权重"的路线；本机 1060 6GB（Pascal 无 bf16）不具备训练条件，需云。
3. **不划算**：运行时动态剪枝（llama.cpp 不支持）、对本机做 imatrix 自量化（无 F16 源+伤质量，docs 已验证过一轮）。

## 5. 质量与排版优化
### 表格（你点名的"更好方式重排"）— POC 已验证 ✅
- 现状：表格被完整识别但整表保留英文（历史逐格自由翻译出过重复垃圾，被一刀切）；且排版有等宽列 bug。
- **编号批次策略实测**（`poc/speed-v3/table-poc.ts`，Manning 前 300 页）：8 张表 / 73 格，8 格/批（`1. 译文` 行格式）→ **12/12 批 100% 解析成功、0 回退**，全部翻译仅 22s。对比现管线正文 `\n---\n` 格式 45% 丢失率——**编号格式完胜**，建议同时反哺正文短段 batch。
- **排版修复（产品代码，今晚已改）**：① capture 输出锚点间距列宽权重 + 裁剪全空列；② typeset 列宽=45%锚点+55%内容长度混合、最小 48pt 钳制；③ 表格逐行绘制、跨页拆分、续页仅重复真表头（hasHeader 判定已修，防长段落当表头每页重播）。效果：POC 输出 7 页→3 页，一字竖排消失：`poc/speed-v3/out-tables-zh.pdf`。
### 图片/代码/公式
- 代码/公式保持原样是正确的，不动。
- 图片：保持嵌入+居中+按原尺寸上限缩放；可改进项：caption 行（"图 6.1 …"）当前会被当正文翻译、与图片脱钩——建议 caption 与 image 块合并为一个语义块。⏳
- 脚注/页眉：capture 已在行级丢弃（HEADER_BAND/FOOTER_BAND 6% + 页码/罗马数字），符合你"不必保留"的要求；无遗留成本。
### 译文质量残留问题（E2E-QUALITY-REVIEW 的 5 类）
1. 地名误译（Shelter Island→男子避难所）→ 占位符系统加 `PROPER_NOUN` 名单冻结（复用 freezeProtected 通道，成本最低）。
2. 否定丢失（acid-free）→ prompt 加"否定/专名后缀保留否定语义"示例对；或温度 0 重跑该段（translationLooksSane 已有重试钩子，扩展成规则重试）。
3. $1M→A1、URL 标点残留 → restore 后正则清理（`§` token 边界标点粘连）。
4. 中英夹杂 → 多为 contextShift 溢出（§2-P1#5 已修）+ 词汇表补全；A/B 里用"未翻译段计数"自动量化（本次 awk 方法可固化进 verify）。
5. 人名音译一致性 → 全书级术语表：首遍翻译时收集（专名→译名）MAP，后续段注入 system prompt 尾部（前缀 KV 仍复用）。⏳ 设计，改动面小。

## 6. 无 GPU（纯 CPU）方案（你点名的问题）
1. **核数识别**：已有 `cpu-info.ts`（WMI 物理核 + Intel 混合架构 P 核表 + 兜底估算），`getDefaultThreads` 规则：混合架构=P核×2、非混合=物理核、上限逻辑核。质量不错；小坑：AMD 非混合走"物理核"是对的，但 **EPYC/Threadripper 大核数机会拿到 32+ 线程反而变慢**，建议加 `min(推荐值, 16)` 上限。
2. **动态并发——实测证伪（重要负结果）**：直觉上 CPU 解码是权重带宽瓶颈，"多序列共享一次权重读取"应有近线性收益；**实测 seq1=7.2 / seq2=7.2 / seq4=7.5 tok/s（各 80 段）——零收益**（node-llama-cpp 3.20 并未把多序列真正合并成单批 llama_decode，只是轮询时间片）。产品结论：**保持单序列 FIFO**，撤掉"CPU 动态并发"预期；若想兑现批处理收益，路线是升级/给上游提 PR（llama.cpp server 的 batch 是真合并的），或自编译捆绑新版验证。
3. **模型侧降比特在 CPU 也无红利（今晚全线证伪）**：带宽瓶颈理论押注低比特，但**实测 CPU Q3_K_M=5.5 tok/s < Q4 7.2**（1.7B 量级解量化 ALU 成本 > 字节节省；i5-12600KF 双通道带宽不是最紧的瓶颈）；UD-IQ2_XXS 更慢(4.8)且质量崩塌（85% 未译复读）。**CPU 提速的现实路线**：① 已落地的编号批次（省 prefill+回退，实测 50%→0% 回退）② 蒸馏自有小模型（0.6B 全功能 Q4 内核，430MB，见 §4-2）③ 等 llama.cpp 对 TQ/hybrid 架构的内核成熟再评估。
4. 参数：threads 自动（P核×2/物理核，≤16）；ctx 1024-2048（省 RSS）；**禁用投机解码**（双模型抢带宽，理论+实测双杀）；temp0.1；prefill 优化已到位（系统前缀 KV 复用）。

## 7. LLM 推理参数科普 + 本项目现值（回应"KVcache/prefill/上下文窗口怎么设"）
| 参数 | 现值 | 为什么 / 证据 |
|---|---|---|
| 上下文窗口 ctx | CPU 2048 / GPU 4096（本次 WIP 修复后生效） | 每序列独占 cells（llama.cpp 按 n_ctx×n_seq 分配 KV）；1024→2048 实测解码速度不变，只 +~130MB RSS，但消除溢出静默截断 |
| KV cache 量化 | 关 | q8_0 A/B 无收益（docs/INFERENCE-OPTIMIZATION） |
| FlashAttention | 可开(--fa) | 长 prompt prefill 更快+KV 读写省；对解码影响小，Pascal Vulkan 支持待实测 ⏳ |
| prefill 优化 | 前缀 KV 复用 | 系统提示词 tokens 常驻（adaptStateToTokens），实测首 token 80→71ms；批合并短段摊薄 prefill 现在净持平（45% 分隔符丢失拖累），编号格式若成立可回收 |
| 采样 | temp0.1/topK20/topP0.9 | 翻译要确定性；贪心仅 +2%（噪声级），0.1 保留一点流畅度 |
| thinking | 强制关 | Qwen3/3.5 开思考 50× 减速（docs 实测+代码双保险 jinja reasoning:false） |
| maxTokens | 2048→按剩余窗口钳制 | 🔧 §2-P1#5 |

## 8. 流程是否最优（提取→翻译→重排）
- 结构正确：全书时间 97% 在翻译（GPU 实测 80 段≈57s vs capture 1.6s/页批量 + typeset 1.8s/8页可忽略）→ 换"每步最优库"的边际收益集中在翻译引擎（§3/§4），不在前后处理。
- 提取（pdfjs-dist 3.11 legacy）：够快够稳；升级 pdfjs 5.x 收益小风险中（worker/API 变动）；MuPDF 提取更强但 **AGPL 传染**，对发行版是许可毒药，否决。
- 重排（pdf-lib + 预子集字体）：正确选型（纯 JS、无原生依赖）。改进点是输出体积（见 §9）与表格翻译（§5）。
- checkpoint/断点续译设计（jsonl 追写 + unit id）健壮，恢复路径语义正确。

## 9. 体积方案（EXE + 模型）
实测 win-unpacked 491MB / 安装包 131MB / zip 183MB：
| 项 | 现状 | 可行削减 | 风险 |
|---|---|---|---|
| Electron 运行时 | ~250MB | 不动（无安全手段） | — |
| @node-llama-cpp 双后端 141MB | CPU 全 ISA 变体+Vulkan | 删用不到的 ISA 变体（保留 baseline+alderlake+vulkan）≈ **-40~60MB** | 老 CPU 用户回退 baseline 稍慢 |
| NotoSansSC-Subset 13MB | 打包内实际不用 | 移出 files ✅ 零风险 -13MB | 无 |
| asar 76MB 冗余 node_modules | 全部生产依赖入包 | 只保留 node-llama-cpp 运行时外依赖，其余已被 vite 打包，files 黑名单 -20~30MB | 需逐项 verify 运行 |
| 字体输出策略 | `subset:false` 整份内嵌（22.6MB/8页！） | fontkit 运行时子集（TTF glyf 路径，此前损坏仅 Noto/CID）：输出 PDF 预计 **-80%体积** | 需 50 页样例回归 |
| 模型下载 1.22GB | Q4_K_M | **1.25bit 路线 → 462MB（-62%）** | 质量人评 §3 |

## 10. 建议路线图
### ✅ 已批准并当场落地（02:00 补充）
- **A 投机解码 WIP 已删除**（llama-engine 投机块/字段/dispose、registry 草稿模型条目全部移除；保留 GPU ctx→4096 提升）。回归：8页冒烟 3命中/0回退 ✓。
- **B 表格逐格翻译已进产品**（pipeline.ts buildTasks 生成 `b{i}-r{r}c{c}` 单元格任务 + 专用编号批次 ≤8格/批 + 逐格 checkpoint；断点续译天然兼容）。集成回归：抽取全书 8 个表格页（p36/137/147/174/215/235/251/319）→ **cell batches 15/15 全解析 0 回退**，输出 `poc/speed-v3/out-tables-zh.pdf`、`.scratch/tables-book-zh.pdf` 中文目检通过。全书表格量级小（8张/353页），此改动主要是"补齐能力"而非提速。
- **C 设置已持久化**：新模块 `electron/settings.ts`（白名单键 + tmp→rename 原子写 + 损坏文件回退默认）；outputDir 接入 JobManager（setOutputDir 对未来任务生效）；mirrorSource 接入 `applyMirror()`（ModelScope↔hf-mirror URL 重写）。单测 6/6 通过、队列测试全过、typecheck/build/verify/预览启动全绿。
- 附带修复：`app:open-folder`/目录选择对话框现用用户设置的 outputDir；`pipeline` 回退循环 abort 检查（§2#10）随 B 一并落地。

### 后续（未动）
- **P1**：checkpoint tmp 竞态修复（§2#8）；storage.ts 写链式串行（#9）；占位符丢失检测（#13）。
- **P2**：后端升级跟踪（解锁 Hy-MT2 极致量化，见 §4）；蒸馏自有 0.6B 档；30B-A3B 高配档；全书术语一致性 MAP；地名/否定词保护。
- **未 commit**：本轮全部改动在工作区（10 文件 + 新文件 settings.ts/poc），等你过目后决定提交拆分。

## 附录：POC 复现
```bash
npm run build && npm run verify
npx esbuild poc/speed-v3/extract-corpus.ts --bundle --platform=node --format=cjs --outfile=.scratch/poc-extract.cjs --external:electron --packages=external && node .scratch/poc-extract.cjs
npx esbuild poc/speed-v3/bench.ts --bundle --platform=node --format=cjs --outfile=.scratch/poc-bench.cjs --external:electron --packages=external
node .scratch/poc-bench.cjs --device gpu --seq 1            # 基线
node .scratch/poc-bench.cjs --device gpu --seq 1 --spec 1   # 草稿投机(否决)
node .scratch/poc-bench.cjs --device cpu --seq 4 --threads 12
node .scratch/poc-bench.cjs --device gpu --main models/Hy-MT2-1.8B-1.25Bit.gguf
npx esbuild poc/speed-v3/table-poc.ts --bundle --platform=node --format=cjs --outfile=.scratch/poc-tables.cjs --external:electron --packages=external && node .scratch/poc-tables.cjs
EN_DEVICE=gpu node .scratch/e2e-test.cjs 25                 # 全管线 E2E
```
产品级修复涉及文件：`electron/models/{llama-engine,registry,engine-config,download}.ts`、`electron/pipeline.ts`（编号批次）、`electron/pdf/capture/flow.ts` + `electron/pdf/typeset/flow.ts`（表格列宽/分页/表头）。typecheck+build+verify+E2E(30页) 全绿；353 页全书回归进行中。
其他 POC：`batch-strategy.ts`（批次格式 A/B）、`debug-batch.ts`（失败样本插桩）、`score-outputs.ts`（未译率/英文残留自动质检）、`loadtest.mjs`（poc/speed-v3 内隔离 node-llama-cpp@3.21.1 探测，结论：新版也加载不了 Hy-MT2）。
