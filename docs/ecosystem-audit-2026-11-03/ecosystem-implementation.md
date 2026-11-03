# 生态衔接优化与验证

2026-11-03。实施对象：`D:\dev\ai-agent-engine` 与 `D:\dev\aether-code`。本次采用调研中 Codex 的能力发现、执行身份、真实回执与恢复模式，落实到 Aether 现有引擎和客户端；不是把静态工具数量当作能力完成度。

## 已实现

| 用户遇到的问题 | 实施后的行为 |
| --- | --- |
| AI 不清楚自己的工具和环境 | 每轮从实际注册表生成能力快照，包含工具来源、schema 版本、引擎运行环境、客户端声明、权限与当前连接状态。新增 `get_tool_details` 查询完整参数、前置条件和失败恢复方式。 |
| Work 会开发却缺少操作指引 | Work、Code 与子代理共享公共执行协议：程序与参数分开、后台任务复用、版本冲突重读、浏览器状态恢复、办公依赖探测、真实产物交付。限制过的工具不出现在能力指引中。 |
| AI 只能说文件已生成，无法操作客户端 | 新增 `workbench_context`、`workbench_open`。模型可读取所属会话的文件及终端状态，并请求在工作台打开文件；引擎等待客户端真实回执。 |
| 打开请求与实际显示脱节 | Code 激活目标编辑器、保留用户未保存内容，复用已有编辑缓冲区或等待新文件读取完成；Work 切到正确预览位置，同路径再次打开显式刷新文件，不能沿用旧缓存回“成功”。回执区分打开、读取与视觉验收。 |
| 切会话、取消后的旧操作串入新任务 | 工作台通道绑定引擎代次、租户、用户、会话和执行身份；投递前及客户端有效性检查发现失效时不执行。已投递后的取消结果可能“不确定”，晚到回执不接受，不自动重放。 |
| 浏览器看不见就反复点击/改网页 | 暴露窗口、页面和布局状态；输入等待新的布局确认。原生截图失败时可只读使用 CDP 后备并验证图像；不抢前台、不重复输入，失败带明确恢复信息。 |
| Node/Python/shell 写文件不进成果 | 命令运行结束、失败、停止、超时都观察 cwd 内文件变化，保存多文件回执；历史回放和后台轮询都恢复成果。子代理后台命令也按可见父轮次归集到 Work 成果及导出；失败或取消任务留下的文件标为“待核验”，删除父轮次后不会被旧任务复活。每条回执保留原始调用、命令任务与运行归属。 |
| 回退可能覆盖手动编辑 | 命令观察记录明确标注“命令期间变化”，自动整轮回退跳过它们。用户逐项选择后，仍校验当前文件 hash；冲突保留文件及对话历史。 |
| MCP/schema/profile 信息丢失或不一致 | 保留 MCP 来源、outputSchema、structuredContent 和非文本内容 envelope；同步 browser wait/fill 等参数与执行规则；修正历史查询和依赖检查的说明。 |
| 窄窗口工作区被标题栏挤压 | 容器宽度不超过 990px 时，标题和当前面板上下排列；工作区模式的标题区域仅占自身高度。940px 窗口中工作区从 67px 恢复到 876px，活动、成果和子代理面板不再横向溢出。 |

主要实现入口：

- 引擎：`src/core/runtime-capabilities.ts`、`src/core/execution-protocol.ts`、`src/tools/workbench/`、`src/api/http/routes/workbench.ts`。
- 命令账本：`src/tools/cmd/command-change-observer.ts`、`src/core/command-jobs/manager.ts`、`src/storage/changes/`、`src/core/agent-loop/react.ts`。
- 客户端：`src/renderer/src/core/workbench/`、`core/engine/tool-file-changes.ts`、`core/engine/command-job-state.ts`、`contrib/work/WorkArtifactPanel.tsx`。
- 浏览器：`src/main/browser/service.ts`、`src/main/browser-bridge.ts` 及引擎 `src/tools/browser/`。

## 性能与回退边界

观察器使用有界 8 路读取，结束时未变化文件通过 stat 特征跳过第二次内容读取；回退仍验证字节 hash。以下为本机隔离夹具每组 3 次结果，是文件观察开销，不是整条命令耗时，也不是办公预览性能承诺。

| 文件规模 | 观察开销 |
| --- | --- |
| 20 × 1 KiB | 11–16 ms |
| 512 × 32 KiB，共 16 MiB | 223–287 ms；优化前 1.05–1.18 秒 |
| 2000 文件 | 434–468 ms；超出观察范围明确返回 partial |

默认覆盖 cwd 内最多 512 文件、16 MiB、单文件 8 MiB、128 条变化。排除依赖目录、内部目录与链接。开始和结束观察各有 1500 ms 协作预算，超出标记 partial，不能把它解释为所有副作用可撤回。目录外写入、系统副作用及任意外部同时写入仍不能保证归属，因此必须逐项审阅。

## 验证记录

测试均使用隔离目录、受控服务或本地进程；未调用真实模型，未重启用户服务。Electron 单 worker 串行执行。

- 客户端：`npm run build -- --outDir .e2e-tmp/ecosystem-build`，包含 node/web typecheck，通过。
- 引擎：`npm run typecheck` 与 `tsc --noEmitOnError` 隔离编译通过；没有替换运行中的 dist。
- 客户端纯逻辑：最终 88 项通过，覆盖回退、发送拒收、后台任务归属、主/子代理多文件成果、历史恢复和远端路由；Code adapter 另 6 项通过。
- 引擎能力/工作台：最终 7 文件、68 项通过；工作台含真实 Fastify HTTP 契约测试。
- 引擎浏览器：10 文件、177 项通过。
- 命令观察、ReAct、回退与 HTTP 取消：相关 178 项分组通过。修正旧夹具的 SQLite 内存库事务问题、取消入口和聚合错误预期，未改变生产取消行为。
- Electron 已通过：Workbench 8 项（含真实预览、同路径刷新、Code 未保存内容与会话隔离）；浏览器恢复 4 项、导航 3 项、会话及菜单 8 项、后台隔离 4 项；终端菜单 8 项、连接恢复 3 项；运行中追加、停止与重试 9 项；持续流交互 2 项。共 49 项，分批串行完成。

实际窗口截图已查看并保留：[Work 打开文本](validation/workbench-open-text.png)、[Code 保留未保存编辑](validation/workbench-code-dirty-buffer.png)。Workbench 的准入夹具已补全，截图前断言无协议/队列错误。

持续流最终两项用时 13.4 秒。在 5 个子代理及 50ms 事件间隔的受控服务下，首项记录 30 次交互，可见结果响应为 48.95–431.15ms，原 2500ms 预算未放宽；940px 下切换对话为 175.48ms、切回工作区为 117.57ms。1440/1102/940px 窗口中，工作区宽度分别为 538/456/876px，横向溢出均为 0。原生进程、渲染与协议错误均为 0；该数据用于描述这组本机夹具，不代表真实模型延迟或所有负载的性能保证。

持续流证据：[交互耗时与运行回执](validation/work-streaming-interaction-receipts.json)、[完成状态回执](validation/work-streaming-completion-receipts.json)、[940px 工作区截图](validation/streaming-child-940.png)、[940px 对话截图](validation/streaming-conversation-940.png)、[940px 布局尺寸](validation/workspace-layout-940.json)。两张窄屏截图已目视核验。

端到端验证曾发现并修复：远端工作台 POST 路由未开放、Work 路径选择进入错误面板、Code 未激活目标标签/已有文档错误重绑、同路径缓存误作新读取，以及窄屏隐藏对话后仍保留横向布局导致工作区被挤压。旧测试 fixture 同步了当前 subagent/admission/snapshot/collaboration 协议和实际导航入口，没有用强制点击或放宽产品校验让测试通过。

分组运行存在重叠，不将以上数字累加为唯一总数。完整能力协议分项说明见 [能力协议实施记录](capability-protocol-implementation.md)。

## 仍需后续实现或验证

- MCP 图片/音频现在保留完整结构数据，尚未接通所有模型提供方的原生多模态工具结果；MCP resources/prompts 也未完整接入。
- legacy edit/regenerate 路由已共享协议，但尚未迁移到主聊天的统一执行准入。已连接但缺少执行身份时，能力快照报告 requires-run；实际工具调用返回 WORKBENCH_RUN_REQUIRED，不伪造身份调用。
- 用户 PTY 提供同会话列表与只读输出；AI 命令仍由 execute_cmd/command_output/cancel_command 管理，尚未实现 AI 在任意用户 PTY 内直接输入。
- 打开与读取成功不等于 Office 渲染或网页视觉验收成功。回执保留 visualVerification=false。
- 尚未用真实模型完整重放围棋项目任务，因此这里验证的是产品执行与恢复链路，不保证模型每次都能正确规划或选择工具。
