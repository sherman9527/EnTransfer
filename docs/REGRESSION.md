# 防回归机制（TDD / Regression Gate）

> 背景：2026-09-19 对抗式 code review 确认了 12 个真实 bug（R1–R12，部分为
> HIGH：批翻译空串静默丢段、缓存温度键写死）。全部已修复，并且**每个可单测的
> bug 都有一条红色用例永久留在仓库里**。本文档定义后续开发必须遵循的机制。

## 核心规则

1. **修 bug 先补红用例。** 在 `electron/regression.__test__.ts` 里新增一个
   `R<n>` 分节，先在旧行为下失败（可用 git stash/手工回退验证 red），再修代码
   让它变绿。没有进回归套件的修复不算修完。
2. **提交门禁（gate）**：每次 commit 前必须全绿——
   ```bash
   npm run gate      # = typecheck + 回归套件（<1s，无模型、无 Electron）
   npm run verify    # 打包结构检查（38 项，含结构不变式 R1–R12）
   ```
   改动涉及打包/资源/asar 时 `npm run verify` 必跑；纯逻辑改动至少 `npm run gate`。
3. **结构不变式**：无法纯单测的时序/顺序约束（熔断 throw 必须在写报告之后、
   dispose 必须 await、打印前必须等 fonts 解码……）以源码模式检查的形式固化在
   `scripts/verify-build.js` 的 “3g. 回归结构不变式” 一节，改这些代码时 verify
   会红，不允许绕过。
4. **管线级 drill 不放行不行**：改动 pipeline / engine / typeset 后，除了
   `npm test`，还须至少跑 12 页 E2E（`poc/eval-2026/electron-e2e.ts` 或
   `pipeline.__test__` 的 esbuild 流程）；全量 353 页回归在发版前跑一次。
5. **KNOWN-ISSUES 同步**：新坑写进 `docs/KNOWN-ISSUES.md`（现象/根因/修法），
   并给对应 R 编号；R 编号在本文件表格和测试注释里一一对应。

## R 编号台账

| R | 严重度 | 现象 | 防回归手段 |
|---|--------|------|-----------|
| R1 | HIGH | 批翻译空槽（模型只回编号）被 writeBack+checkpoint 持久化 → 段落永久消失 | regression R1（splitBatch 拒空槽）+ verify 3g |
| R2 | HIGH | 缓存键温度写死 0.1，换采样参数会命中旧译文 | regression R2（键敏感性）+ verify 3g（callsite） |
| R3 | MED | 熔断 throw 跳过 quality-report 写入，事故现场丢失 | verify 3g（源码顺序不变式） |
| R4 | MED | magnitudeRewrite 一刀切豁免：中文输出丢任意数字都能过 | regression R4（红=旧行为） |
| R5 | MED | dispose() 不 await 异步释放，重建时显存翻倍 | verify 3g（allSettled） |
| R6 | MED | 任何非 abort 错误都标 sick → 永久降级 CPU | regression R6（isHardwareError 分类）|
| R7 | LOW | 幻觉/重复 sentinel 不报错 | regression R7（sentinel-extra） |
| R8 | LOW | 共享 /g 正则 lastIndex 状态漂移 | regression R8（双调用一致性） |
| R9 | LOW | 缓存 .tmp 固定名，并发写互相踩 | regression R9（并发 put 无残留） |
| R10 | WATCH | 引擎反复 sick 重建无上限 | verify 3g（sickRebuilds 上限） |
| R11 | WATCH | 打印固定 500ms 等待，大图会截断 | verify 3g（fonts.ready） |
| R12 | LOW | webp/gif 按 jpeg 声明；临时 HTML 泄漏 | regression 静态 + verify 3g |
| R13 | HIGH | assisted 安装器把整个安装器(~100MB+)复制进 `%LOCALAPPDATA%\<name>-updater`，卸载不清理（零残留演练实测抓出；`differentialPackage:false` 对 assisted 模式无效） | verify（flag + nsh 兜底删除 R13b）+ 安装→卸载演练 |
| R14 | HIGH | `npm run dist` 直连 electron-vite，npm `postbuild`（pdf.worker.js 拷贝）从不执行 → 安装包缺 worker，pdf.js 静默降级 fake-worker | dist/pack 脚本改为 `npm run build && electron-builder …`；verify「out/main/pdf.worker.js 存在」常跑 |
| R15 | MED | 无 ToUnicode 的 Type3/CID 字体产出乱码文本会被模型"译"成看似通顺的垃圾（静默污染译文） | regression R15（garbageRatio>20% 拒进模型；乱码块原文保留+徽章+报告记 `garbage-skipped`） |
| R16 | LOW | pdf-lib 兜底代码块用 mono 字体测量却用 regular 绘制 → 字宽不符错位、非等宽 | verify 3g（代码 drawLine 传 mono=true，与 codeAdapter 测量字体一致） |

## 新用例模板

```ts
console.log('R13 <模块>: <一句话现象>')
{
  check('<旧 bug 会失败、新代码通过> 的断言', cond)
}
```
保持套件纯函数化：不 import electron/node-llama-cpp/pdfjs 运行时，只用
node:fs/os/path；需要新逻辑可测时，先把纯函数下沉到独立模块（参考
`electron/batch-format.ts`、`electron/models/engine-errors.ts` 的做法）。
