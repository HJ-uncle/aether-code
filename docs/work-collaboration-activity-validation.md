# Work 子代理协作与原位活动验收（2026-10-12）

本轮对应「@Agent 被拒绝」与「活动回到对话内展开」两项反馈。沿用已安装的 ui-ux-pro-max、macos-design 指引，复用 Code 的消息、差异、命令、子代理卡片与主题令牌。

## 行为

- 主 Agent 选择与协作引用分开。已启动任务的主 Agent 固定，`@Agent` 作为结构化 collaborators 字段提交；引擎确定启动真实子代理，父模型可以读取其结果。
- 子代理继承所选 Agent 的模型、温度、提示词、工具、技能、MCP、知识库配置；配置保存在子代理续跑快照中。同一父任务再次 @ 同一 Agent 复用 childSessionId 与独立历史。
- 子代理列表按独立上下文分组，不将每轮续跑显示成新代理。详情显示工作轮次、实际工具与输出，支持继续任务、停止本轮；主输入框草稿保留。
- 新增完整对话入口，验证父子归属后按页读取真实子会话历史，长产出逐段展开。读取失败显示错误并保留已有内容；后端不支持完整归档时明确说明可用历史的限制。
- 活动摘要直接在对话原位展开。文件、命令、子代理复用 Code 组件；通用输入输出高亮、完整复制、分页和错误反馈。侧栏活动总览仍可单独打开。
- 点击或用键盘展开详情会暂停自动追尾。Work 文件改动中的路径打开当前任务的成果预览，避免套用 Code 工作区。
- 用户引用消息复用共用组件，隐藏协议元数据，恢复 Agent 标签，长消息按实际八行高度折叠。长标签限制宽度并保留完整悬停提示。
- JSON 输出高亮保留原文本，不重新编码大整数、重复字段或源码空白。

## 引擎边界与验证

- 协作选择最多八个，仅接收服务端身份；预校验失败不修改主 Agent、运行状态或历史。
- 子代理续跑校验租户、父任务、目录及并发状态，安全模式和预算继续约束子代理。普通模型委派仍与父工具及资源权限相交，不能伪造用户委派。
- 自定义子代理的技能脚本严格限制在绑定资源真实路径内；安全模式不启动 MCP 扩展来发现工具。
- 准备阶段已纳入持久化子代理生命周期，资源准备慢或失败时仍有实际身份与状态。
- 引擎新增测试 30 项：协作准入 15、真实 HTTP 协作 8、真实技能脚本 7。广回归 19 个文件 / 201 passed / 0 skipped；typecheck、build、diff 检查通过。
- HTTP 验证覆盖真实 runner、历史与文件副作用、配置绑定、同上下文续跑、父模型失败恢复、断流后完成与查询、停止子代理。模型适配器与 MCP transport 使用受控夹具。

## 证据边界

前端专项独立用例合计 **75 passed**，重跑不重复计数：

| 范围 | 结果 |
| --- | --- |
| Work 模式真实 Electron 全文件 | 22/22，最终构建复跑通过 |
| 共享文件卡与用户消息、真实引擎子代理生命周期 | 12/12 |
| 协作引用、分组、完整对话、活动、远端通信契约 | 41/41 |

完整对话窗口用例实际读取 61 条归档记录，展开超过 8K 的原始产出、读取更早记录、打开工具输出，并注入 503 验证失败保留与重试。第三轮在完整对话页真实提交停止请求，确认服务端已取消且页面保持显示「已取消」。

专项测试曾发现停止成功后完整对话页缺少终态提示，修复后 Work 全文件再次通过。截图核查发现直接修改设置的测试方式没有保证实时主题切换，已改为通过设置界面操作、确认 html 主题属性与背景颜色实际变化，定向复跑通过。窗口尺寸覆盖 860×640、940×600、1100×760、1440×900；深浅主题截图已人工查看。

最终 `npm run typecheck`、`npm run build`、`git diff --check` 通过。新增 Work 样式无未定义令牌及写死颜色。Electron Work 健康记录为 exit 0 / nativeEvents 0 / failures 0；没有通过更改产品行为来迎合测试。

截图保存在 `.ae/qa/work-collaboration-20261012/`：

- `work-inline-activity-expanded.png`
- `work-subagent-full-transcript.png`
- `work-collaboration-dark-860.png`
- `work-collaboration-light-860.png`

可复跑命令（先运行 `npm run build`；Electron 测试始终 workers=1）：

```powershell
npx playwright test e2e/work-mode.spec.ts
npx playwright test e2e/user-message-collapse-ui.spec.ts e2e/chat-message-layout-ui.spec.ts e2e/subagent-lifecycle.spec.ts
npx playwright test e2e/work-agent-collaboration.spec.ts e2e/work-subagent-groups.spec.ts e2e/work-subagents-contract.spec.ts e2e/work-inline-activity-contract.spec.ts e2e/work-subagent-transcript.spec.ts e2e/remote-connection-contract.spec.ts
```

本轮是交互与协作专项验收。没有重新执行外部模型一小时压力测试，不能据此承诺已经证明 7×24 小时运行。此前长测证据限制见 `work-soak-evidence-audit.md`。

用户常驻应用及 12323 引擎未被中断。主进程和引擎改动需要新进程加载；前端热更新不能替代主进程或引擎重启。
