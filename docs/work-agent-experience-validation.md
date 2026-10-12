# Work Agent 体验修复与验证（2026-10-12）

本轮处理 Agent 编辑流程、首个响应等待反馈、任务顶部 Agent 身份和输入区固定项四个问题。UI 采用已安装的 `ui-ux-pro-max` 与 `macos-design` 指引，沿用项目主题令牌。

## 已实现行为

- 任务顶部显示实际使用的 Agent 名称，包括默认助手。刷新任务后仍能恢复，配置变化后刷新名称；点击可进入 Agent 管理并返回原任务。
- 首次发送后固定的 Agent、工作目录从输入区隐藏。模型、思考、记忆、安全等可调整项保留。
- 准备会话与等待首个内容时立即显示反馈，并按思考、工具执行、生成、等待交互和上下文压缩等真实阶段更新。显示实际耗时，不制造进度百分比；工具阶段可打开对应活动。
- 准备阶段停止任务会清除排队启动，迟到的会话响应不会再次启动任务。迟到的原生目录选择结果也不会修改已固定的工作目录。
- Agent 编辑器拆为基础配置、资源绑定、工具权限。资源按技能、MCP、知识库切换，支持搜索和选择数量；内容区独立滚动，页签与保存操作保持可见。
- 目录权限错误就近显示且可重试；失效的已有绑定保留并可解绑；保存失败保留草稿，支持 Ctrl/⌘ S 重试。关闭未保存编辑会确认弃稿，保存过程中防止关闭。

## 配置与运行修复

- Work 明确使用 `general` 工具范围，Code 使用 `code`，不再由当前可见模式污染后台任务请求。
- Agent 工具目录使用 `/tools`，携带当前项目路径。新建 Agent 显式保存允许的工具；“仅对话”明确清空权限。技能运行绑定使用技能名称，而非管理目录的路径哈希 ID。
- 后台任务持久性独立于工具范围。Aether 请求携带 `X-Aether-Run-Lifetime: durable`，已准入的 Work 任务断开 SSE 后仍继续；准备阶段的断开仍取消。非法生命周期头返回 400。
- 引擎工具目录支持项目路径且不改变当前会话绑定。远程鉴权场景校验目录授权、真实路径和租户边界。
- MCP 在建立连接前按 `allowedMcpServers` 精确过滤，与工具白名单取交集。空数组禁用 MCP；未指定保持原行为。

## 验证证据

| 验证 | 结果与范围 |
| --- | --- |
| Aether `npm run typecheck`、`npm run build` | 通过 |
| Work 六组 E2E：mode、state、composer、subagents、timeline、security | 44 passed |
| Work transport、status-timeout、performance-state | 8 passed |
| 最终 engine-host-contract + work-mode | 28 passed / 1 skipped；含重跑的 Work 19 项 |
| 引擎生命周期与准备取消测试 | 20/20；真实 HTTP 断流超过 15 秒后 general durable 仍完成 |
| 引擎工具路由、目录授权、MCP 与权限边界测试 | 66/66 |
| 目录授权最终复跑 | 10/10；junction 能力不足时明确 skip，当前环境实际验证通过 |
| 引擎 typecheck、build | 通过 |
| CSS 令牌和 diff 检查 | 无未定义令牌；本轮样式无写死颜色；`git diff --check` 通过 |

Aether 本轮独立用例合计 61 passed / 1 环境能力 skip，不重复计算 Work 重跑。skip 为操作系统 safeStorage 加密凭据能力不可用。Work 的 19 项真实 Electron 用例均通过，测试了 860×640、1100×760、1440×900 和深浅主题，包括横向溢出、保存操作可见性、资源权限失败恢复、长工具列表搜索、保存失败重试以及 Agent 身份恢复。

Electron 最终健康记录为正常退出（exit 0）、无 native 事件、无健康检查失败。终端失败分支夹具会输出预期的 `terminal:create` 错误；这不等同于真实 PTY 能力验证。

## 截图与适用范围

专项截图及窗口健康记录保存在 `.ae/qa/work-agent-20261012/`：

- `work-task-agent-identity.png`：顶部 Agent 名称和输入区固定项隐藏。
- `work-first-response-feedback.png`：首个响应等待反馈。
- `agent-basics-{860,1100,1440}.png`：不同窗口的基础表单布局。
- `agent-resource-permission-860.png`、`agent-tools-search-860.png`：窄窗资源重试、长列表搜索。
- `work-agents-{dark,light}-860.png`：深浅主题。

本轮 Electron 交互测试使用受控 Provider，验证真实窗口、IPC 和请求/响应流程；引擎回归另有真实 HTTP 断流测试。没有在新构建上重新执行一小时外部模型压力测试，不能据此宣称已经证明 7×24 小时运行。此前长测的构建、工具范围和证据限制见 `docs/work-soak-evidence-audit.md`。

客户端与同级引擎均已构建。用户正在运行的应用及常驻引擎未被中断；主进程和引擎的新行为需要新的进程加载。
