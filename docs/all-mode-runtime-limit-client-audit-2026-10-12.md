# 全模式运行时限制客户端审计（2026-10-12）

## 已处理

`src/renderer/src/contrib/work/WorkView.tsx` 的自动化表单不再把单次运行限制固定为 86400 秒：

- 新增“ 不限 ”选项并作为新建任务默认值。
- 自定义时长允许非负整数，`0` 与空值按“不限”发送为 `timeoutSeconds: null`。
- 编辑已有无限任务时正确显示“ 不限 ”，列表和帮助文案同步更新。
- Web 类型检查：`npm run typecheck:web` 通过。

客户端流式请求使用 `src/main/engine/tool-profile.ts` 的 `toolProfileHeaders`，Code 与 Work 均发送
`X-Aether-Run-Lifetime: durable`。页面断开不会按普通 attached 会话的 15 秒宽限期中止已启动任务；用户显式停止仍通过现有 stream abort 入口执行。

## 仍需引擎配套

客户端把无限自动化值发送为 `null`，但当前同级引擎仍在以下位置把它解释为有限默认值：

- `D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:107-133`：`timeoutSeconds ?? DEFAULT_CRON_TIMEOUT_SECONDS`，随后创建 `AbortSignal.timeout`。
- `D:/dev/ai-agent-engine/src/api/http/routes/cron.ts:23,31` 与 `src/storage/cron/index.ts:78,108`：仍校验正整数上限 `86400`（`null` 可通过）。

因此要使定时自动化真正不限时，需在引擎侧让 `null` 跳过调度请求的超时信号，并同步更新校验与测试。客户端单独更新只能移除 UI 上限并保留无限意图，不能改变已经运行的旧远端引擎行为。

## 运行时边界说明

请求连接、上传、WebSocket 握手和浏览器单次操作的超时属于传输/资源清理 watchdog；它们不截断已经 durable 的 AI SSE 任务，不能与模型的上下文窗口、服务商配额或用户主动取消混为“任务运行时限”。
