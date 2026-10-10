# 快速退出时最新编辑草稿丢失修复

## 已证实缺口

第二完整轮 789 项：787 PASS、1 FAIL、1 serial 未运行、0 显式跳过、flaky0。失败发生在 editor-groups 重启恢复：右组最新 recovered right draft 未恢复，显示磁盘内容 left batch saved。原 JSON/log/trace 均保留在 client-r4-contract-converged-full-20261009.* 与独立 trace 目录。

editor-recovery 使用250ms防抖，并在窗口 beforeunload 同步保存。实际 Playwright app.close 在本机 coreBundle.js:44180 调用 app.quit。主进程 before-quit 原先 preventDefault 后等待终端/引擎清理，再直接 app.exit(0)，绕过窗口 beforeunload。没有运行引擎时清理迅速完成，可能早于防抖保存，导致丢失最后一次未保存编辑。

## 源修复与严格回归

main/index.ts 增加 shutdownComplete。首轮退出仍共享一次清理操作和25秒期限，清理完成后置完成标志，再次 app.quit；第二轮 before-quit 正常继续，由Electron关闭窗口并触发 beforeunload。

editor-groups 回归在最新编辑后立即 app.close，移除等待旧 recovery groups.length 的错误就绪判断；不等待新草稿持久化。加入一次 beforeunload 标记，并在重新启动后核对标记为1及原全部双组标签、焦点、最新草稿和磁盘内容。不会用增加等待或重试掩盖缺口。

明确使用尚未重建的旧 out 验证新回归：11.269秒，4 PASS、1 FAIL、1 serial 未运行。失败精确为 beforeunload 标记 Expected 1 / Received null，因此新回归确实抓到旧退出路径。证据：client-quit-red-20261010.json/.log 和 client-quit-red-traces-20261010。

## 当前验收状态

此条记录源修复和旧out红证据；修复后的新客户端 build（node/web typecheck + electron-vite）已通过，日志为 .e2e-tmp/client-quit-fixed-build-20261010.log；相关绿色专项和新冻结引擎完整回归尚待执行。旧1038完整轮已结束并解除冻结，后续与新引擎包一起验证，不将旧轮视为新版本完整通过。

## 原始证据

- [第二完整轮逐条报告](D:/dev/aether-code/docs/test-reports/2026-10-09-client-r4-second-final-full.md)
- [旧out红回归JSON](D:/dev/aether-code/.e2e-tmp/client-quit-red-20261010.json)
- [客户端模型与思考隔离](D:/dev/aether-code/docs/test-reports/2026-10-09-client-session-composer-fix.md)