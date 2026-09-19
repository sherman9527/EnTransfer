# EnTransfer — 开发约定（必读）

Electron 离线英译中 PDF 翻译器。主进程推理（node-llama-cpp/Vulkan），Chromium
排版输出。全中文 UI。

## 提交门禁（每次 commit 前，无一例外）

1. `npm run gate` — typecheck + 回归套件（纯函数，<1s）。
2. 改动涉及打包/资源/结构不变式时加跑 `npm run verify`（38 项）。
3. 改动 pipeline / engine / typeset 后另跑 12 页 E2E；发版前跑全书回归。

## 修 bug 的固定流程（TDD）

- 先在 `electron/regression.__test__.ts` 加 `R<n>` 红色用例（旧行为必须失败，
  用 git stash 或临时回退验证 red），再修代码变绿；
- 无法单测的时序约束固化进 `scripts/verify-build.js` 的 3g 结构不变式；
- 台账与模板见 `docs/REGRESSION.md`；新坑同步进 `docs/KNOWN-ISSUES.md`。

## 其它硬约束

- 所有 POC 脚本、模型下载、测试产物必须留在本仓库目录内（`.scratch/`、`poc/`）。
- A/B 测试样本 ≥ 50 例；不信任外部报告，一切自测。
- 排版主路径是 Chromium `printToPDF`；pdf-lib 仅作兜底，别再给它加功能。
- 表格/图片/代码保持原文不翻译（VERBATIM 决策，勿再翻转）。
- 安装后运行期文件只允许落在安装目录 `data/`、`models/`（卸载零残留，
  verify 有便携性检查 + scripts/install-drill.ps1 端到端演练（装→跑→卸）必须 PASS）。
- 行为日志随手记入根目录 `MEMO.md`，防上下文丢失。
