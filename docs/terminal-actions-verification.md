# 终端菜单与连接恢复验证

日期：2026-10-08

## 本次完成

- 终端标签和内容区共用右键菜单：新建、重命名、添加到当前会话、复制选区、复制全部输出、粘贴、全选、清屏、重启、关闭、关闭其他、关闭全部。
- 标签支持 Shift+F10 / 菜单键；Escape 能在终端输入持有焦点时关闭菜单。
- 远端断线显示“已断开”，提供“恢复终端连接”；复用原远端进程与终端 ID，不自动创建替代进程。
- 真正退出显示“已退出”，使用“重新启动终端”。运行中重启会说明结束原进程；启动失败保留原标签及输出。
- 添加到当前会话默认引用已保留的全部输出，有选区时引用选区。附件写入当前工作区 `.ae/attachments/`，只插入引用，不自动发送消息。
- 修复远程聊天输入框因旧只读条件而拒收引用的问题。上传过程中切换账号、工作区或会话时取消旧引用的插入。
- 保留创建握手期间的首段输出；关闭全部会取消未完成的新建操作并清理迟到的远端进程。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过，包含再次执行的主进程及渲染进程类型检查。
- 最新构建上的串行 Playwright 回归：**85 passed / 0 failed / 0 skipped**，耗时 65.8 秒。
- `git diff --check`：通过。
- 真实窗口菜单截图已检查，菜单在视口内完整显示。

运行命令：

```powershell
npx playwright test e2e/terminal-actions-ui.spec.ts e2e/terminal-clipboard.spec.ts e2e/terminal-connection-ui.spec.ts e2e/terminal-resize.spec.ts e2e/remote-terminal-contract.spec.ts e2e/terminal-output.spec.ts e2e/editor-chat-context.spec.ts e2e/terminal-shell-input.spec.ts e2e/smoke.spec.ts
```

覆盖：

- 8 条新增真实 Electron 菜单用例：非当前标签操作、启动欢迎语、输出软换行与中文、会话附件、重连、重启失败重试、上传中切换会话、延迟创建期间关闭全部。
- 10 条主进程 HTTP/WS 契约：原 ID 重连、认证刷新、并发去重、身份变更拒绝、已退出/已消失进程、服务暂时拒绝、重连时关闭。
- 10 条真实 xterm 内存缓冲区测试：软换行、空格、宽字符、Emoji、ANSI 渲染、滚动历史、备用屏幕。
- 现有剪贴板、终端就绪与尺寸、编辑器会话引用、真实 Workspace Shell 落盘，以及完整 smoke spec。

## 验证边界

远端连接测试使用独立 HTTP/WS 服务夹具；真实 Shell 用例通过 PTY 执行并验证文件落盘。本轮未在用户的独立 Linux 服务器上部署或验收，也未恢复此前暂停的沙盒改造。

引擎当前没有断线期间的输出重放协议。恢复连接可保留客户端已收到的输出及仍存活的远端进程，但不能补回断线期间丢失的输出；远端进程退出或引擎实例更换时需要重新启动终端。

日志：`.e2e-tmp/terminal-actions-build.log`、`.e2e-tmp/terminal-actions-final-verification.log`。
