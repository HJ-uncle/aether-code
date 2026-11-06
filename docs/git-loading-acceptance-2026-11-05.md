# Work Git 首屏加载与遗留占用验收（2026-11-05）

用户现场是旧会话的 workspace session lease 遗留：owner PID 35812 已结束，Git 仓库占用已经有核验通过的恢复归档，但会话绑定锁仍在。当前绑定表不再包含该旧会话，旧恢复入口无法释放它。每次 `/workspace/bind` 等待 30 秒后返回 `Resource is busy`；后台刷新再重复等待。

前一轮验收不足：功能测试先等待引擎就绪、提前绑定临时任务和预热 Code Git，再打开 Work。没有覆盖用户已有任务跨进程恢复，也没有实测此 150 文件仓库的首屏耗时。此前功能用例通过不能证明这个路径通过。

本轮修改：

- 绑定前核对遗留占用与仓库恢复证据；要求会话、租户、路径、PID、generation 一致，并重新核验原生进程和 Git 子进程退出证据。保留不能核验的占用，不凭 PID 消失直接释放 Git 锁。
- 同轮状态与分支读取共用一次目标捕获；每次请求仍执行绑定校验。
- 文件状态返回立即展示，分支信息慢或失败不会吞掉文件列表。后台相同快照保留引用，避免无意义重绘。
- 未就绪、初次读取和失败状态分别展示，未读到状态时不显示“工作空间干净”。

已观察到的对照结果（本机单次测量，不是性能 SLA）：

| 场景 | 结果 |
| --- | --- |
| 旧运行快照 + 真实中断进程 + 丢失会话绑定 | 30,018 ms 后失败，报 `Resource is busy` |
| 最终修复版 + 完全相同回归 | 411 ms 恢复绑定，534 ms 读出状态 |
| 新任务读取 `D:\web\wuzu-client` | 151 个变更，页面重载到文件列表 2,043 ms；分支与刷新按钮就绪 2,975 ms |
| 引擎未就绪时已挂载面板，随后收到 ready | 自动加载，1,964 ms；无需切页或手动刷新 |
| 首次状态故障，手动重试 | 转圈结束、错误可见、重试成功 |

参考项目同仓库的只读命令基准：`git status` 66–70 ms，未暂存 numstat 99–109 ms，暂存 numstat 86–89 ms。按 Wuzu 并行调用顺序复刻的本地扫描约 173–177 ms。这是命令管线计时，不是 Wuzu 页面首屏计时，不应直接与 Aether 的页面重载计时等同比较。Work 另有任务绑定、HTTP 桥和原生 Git 进程监督开销。

验证证据：

- 应用 `npm run typecheck` 与隔离目录完整 build 通过。
- 状态隔离、慢分支、失败保留数据、后台刷新：50 条纯回归通过。
- `work-git-loading.spec.ts` 和 `git-work-recovery-real.spec.ts`：6 条真实 Electron / 引擎回归通过。冷启动时序和首次 HTTP 故障为受控注入，Git 数据与绑定来自真实引擎。
- 真实中断回归创建并终止测试自己的进程，使用原生退出审计，验证仓库与其它绑定不变；已确认旧版本失败、修复版通过。
- 真实仓库测试关闭自动 fetch，校验 Git index 内容未改变。
- 引擎恢复、恢复流程中断和交错获取：33 条回归通过，typecheck 与 build 通过。
- 最终引擎 buildId：`sha256:07b77ecdc587a4a3c01278b070cffd8e23e75b126ba47b9e70ffb5e1828ad247`。最终产物再次验证两个真实恢复用例和实际仓库首屏，共 3/3 通过；表格采用这次的最终计时。

复跑（先 build，Playwright 单 worker）：

```powershell
npm run build -- --outDir .e2e-tmp/work-git-build
$env:AETHER_E2E_APP_ENTRY = 'D:\dev\aether-code\.e2e-tmp\work-git-build\main\index.js'
$env:AETHER_GIT_LOADING_REPO = 'D:\web\wuzu-client'
npx playwright test e2e/work-git-loading.spec.ts e2e/git-work-recovery-real.spec.ts
```

原始计时 JSON 与真实仓库截图保存在 `.e2e-tmp/work-git-loading-before.json`、`.e2e-tmp/binding-recovery-timing.json`、`.e2e-tmp/work-git-real-repo-load.json` 和 `.e2e-tmp/work-git-live-repo.png`。

现场处置：通过生产 `recoverGitBindingLease` 函数核验并归档目标旧租约，113 ms 完成，恢复保护锁正常释放，index SHA-256 前后相同。随后在原 Aether 窗口点击“重试”，实际显示 `xl-dev`、151 个变更、暂存 108、未暂存 64。该仓库在验收期间仍有其它工作继续进行，因此变更数从最初计时的 150 增至 151；最终计时已按 151 项复核。现场结果记录于 `.e2e-tmp/work-git-live-recovery.json`。

运行状态：当前窗口无需重启已经恢复。开发引擎使用启动时固定的源码快照；新增自动恢复逻辑需下次重新运行 `npm run dev` 才由该常驻引擎载入。
