# Wuzu 子代理 UI、事件归属与历史回放调研

调研日期：2026-09-29。范围：D:\web\wuzu-client 当前工作区代码；只读源码、运行现有纯函数测试，没有修改 Wuzu 或 Aether 业务代码，没有读取 .env 或凭据。

已读 Wuzu 根 AGENTS.md 与 .wuzu/rules/rules.md；`rg --files -g AGENTS.md` 仅找到根文件。以下行号均是本次读取时的工作区行号，不代表某个 Git 提交。

## 1. 结论与责任边界

Wuzu 可借鉴的核心不是卡片样式，而是 **明确的父工具调用 ID、独立子任务状态、子工具事件归属，以及实时和历史回放共同使用的数据模型**。它不把子代理内部消息当作主会话的新对话轮次，也不把工具结束等同于成功。

但不能将其称为 Wuzu 自研的一套完整子代理 runtime：

| 路径 | 谁执行子代理 | Wuzu 负责什么 | 代表入口 |
| --- | --- | --- | --- |
| Claude Code CLI / SDK | `@anthropic-ai/claude-agent-sdk` 的 query；SDK 内部控制 Claude CLI，提供 Agent/Task、parent_tool_use_id、task_*、原生 JSONL 与 stopTask | 选项注入、事件适配、任务归属与统计、主进程 IPC、磁盘回放、Vue 展示 | `src/main/engine/cliProvider/SdkClaudeProvider.ts:2714`，`:3790` |
| Codex CLI / app-server | Codex app-server | item 适配与共用 CLI 渲染层；本次看到的 adapter 没有 collab agent 专用分支 | `src/main/engine/cliProvider/codexAppServer/CodexAppServerManager.ts:1147` |
| lobster 原生宿主路径 | lobster provider / lobster-core（本报告不替后端代理作 runtime 定论） | CoworkMessage/PanelItem 的 metadata.agentId、agentName、runId 聚合成群聊式父子活动段 | `src/renderer/src/components/lobster/AgentTeamChat.vue:5`，`src/renderer/src/composables/useAgentTeamUi.ts:498` |
| agent-engine 路径 | 独立 agent-engine 引擎 | AeChatView 原生协议展示 | `src/renderer/src/components/lobster/CoworkMessagesArea.vue:31` |

`CoworkMessagesArea.vue:12-46` 明确把 Claude/Codex、agent-engine、lobster 分成不同分支。**CliSubagentCard 与 AgentSubagentGroup 不是同一套事件协议的两个皮肤。**

## 2. Claude 事件契约与三种 ID

共享类型：`src/types/claudeCli.ts:30-93`、`:193-220`。

- Wuzu `sessionId`：广播与会话 store 路由所用 ID。
- SDK `task_id` → `taskId`：原生任务控制 ID，停止子代理必须用它。
- 派发 Agent/Task 的 `tool_use_id` → `toolUseId`：卡片身份、任务索引键。
- 子步骤的 `parent_tool_use_id` → `parentToolUseId`：指向派发它的父工具 ID。
- 子步骤自身也有 `toolUseId`，用于内部工具 start/result 配对。
- 原生 `session_id` → `cliNativeSessionId`：转录位置和续跑会话身份，不等于以上 ID。

本地契约的代表性示例（根据类型与 adapter 构造，不是抓取的用户会话）：

```ts
// 父工具调用：在主消息里产生一张子代理卡片
{ type: 'tool_use', toolUseId: 'dispatch-1', toolName: 'Agent',
  toolInput: { description: '调研主进程', prompt: '...', subagent_type: 'Explore' } }

// 原生 SDK task_started 归一后：控制 ID 与展示 ID 建立映射
{ type: 'subagent_task', taskId: 'sdk-task-1', toolUseId: 'dispatch-1',
  status: 'running', startedAt: 1720000000000 }

// 子代理内部调用：挂到 dispatch-1，不生成主气泡
{ type: 'tool_use', toolUseId: 'read-1', parentToolUseId: 'dispatch-1',
  toolName: 'Read', toolInput: { file_path: 'src/main/index.ts' } }
{ type: 'tool_result', toolUseId: 'read-1', parentToolUseId: 'dispatch-1',
  output: '...', isError: false }

// 子任务真实失败：独立于父回合是否最终成功
{ type: 'subagent_task', taskId: 'sdk-task-1', toolUseId: 'dispatch-1',
  status: 'failed', error: '...', endedAt: 1720000005000,
  totalTokens: 3500, toolUses: 1, durationMs: 5000 }
```

消息结构是 `ClaudeCliMessage.thinkingSteps[]` 加 `subagentTasks: Record<toolUseId, ClaudeCliSubagentTask>`（`src/types/claudeCli.ts:135-158`）。子步骤存在父消息的步骤数组，但具有结构化归属；这是展示收拢，不是运行时把子代理上下文混入父上下文。

## 3. SDK → Wuzu 事件适配

`SdkClaudeProvider.ts:2343-2359` 设置 `includePartialMessages: true`、`perTaskStopAffordance: true`、`forwardSubagentText: true`。后一个选项主要用于得到子代理真实 usage，Wuzu 仍主动过滤子正文与思考。

- `:3858-3862`：子代理 `stream_event` 逐字正文/思考直接跳过，不进入主回答。
- `:4078-4082`：读取 `parent_tool_use_id`，产生 `isSubagent`。
- `:4103-4138`：子代理 text/thinking 跳过；tool_use 仍广播，并携带 `parentToolUseId`。
- `:4205-4228`：user/tool_result 同样携带 `parentToolUseId`，明确保留 `is_error` → `isError`。
- `:3944-4044`：task_started/progress/updated/notification 归一为 `subagent_task`；过滤 `skip_transcript` 和 `ambient` 任务；用 Map 记录 `taskId → toolUseId`，补齐不带父工具 ID 的 updated/notification。
- `:3991-4024`：原生 stopped 转成 killed；failed 的 summary/error 进入结构化 `error`；终态保留结束时间。

Wuzu 并未在这里自行实现子代理 LLM 循环、进程隔离、上下文 fork 或原生文件格式。这些能力属于 SDK/CLI。本次源码只证明 Wuzu 如何消费 SDK 事件，未运行真实模型验证供应商行为。

## 4. reducer：归属、终态与错误语义

`src/renderer/src/stores/claudeCliReducer.ts`：

- `:456-463` 将内部工具写成带 parentToolUseId 的步骤。
- `:467-487` 用 toolUseId 找 tool_start，原位收口 tool_end，保留输出，并通过 `classifyToolOutput` 合成 isError。这里没有“结束就是成功”的硬编码。
- `:232-247` 找子任务 owner：优先匹配已建档任务的 toolUseId/taskId，再回退当前流式消息；因此已经收轮后的统计能回到原消息。
- `:298-302` 允许 result 之后的子任务统计/终态继续进入；`:497-500` 明确不得为子任务进度新建消息，防止空气泡。
- `:503-550` 按 toolUseId（或 taskId 反查）合并同一任务；completed/failed/killed/stopped 是终态，首个终态具有粘性，迟到 running 不会复活；paused 非终态。
- `:524-543` tokens、toolUses、durationMs 用 max 合并，未提供统计时保留旧值；startedAt 只记录一次，endedAt 终态时固定。
- `:548-550` 替换 subagentTasks 引用，让气泡节流 watch 能及时触发。

因此推荐 Aether 同样分开 **工具传输结束、子任务终态、父回合终态**；工具内出现失败不必将整个父回合判错，父回合 done 也不应抹去子任务 failed。

## 5. UI：父子隔离与可查详情

`src/renderer/src/components/cli/CliThinkingTimeline.vue:266-307`：

1. 以 parentToolUseId 分组子步骤。
2. 主时间线过滤所有带 parentToolUseId 的步骤。
3. Agent/Task 分组走 `CliSubagentCard`，传 task、children 和 `subagentTasks[toolUseId]`（`:45-54`、`:222`、`:282-291`）。

`src/renderer/src/components/cli/CliSubagentCard.vue`：

- 头部展示类型、稳定标题、运行活动副标题、调用数/tokens/耗时（`:15-44`、`:484-508`、`:635-654`）。标题优先派发时的 description，不被进度 description 冲掉。
- 整卡默认收起，按工具 ID 保存手工展开选择；内部工具运行时自动展开、历史默认收起，手动选择优先（`:310-333`）。
- 目标任务使用父工具 prompt 原文，两行预览/展开全文（`:84-107`、`:488-491`）。
- 内部详情展示工具名、输入/输出状态行，并显示失败数、按工具类型汇总；超过 15 条才限制高度（`:110-141`、`:335-347`）。
- 子代理最终输出独立于统计是否存在，`resultText` 有内容即可展示（`:144-163`）；错误保持原文，正常输出按 Markdown 渲染。
- 放大视图支持全屏阅读；旧截断输出可按 cwd + cliSessionId + toolUseId 懒读原生转录（`:520-571`）。
- running 需要父工具仍是 tool_start、任务无终态且本轮 isStreaming；未收口任务显示 unfinished，避免历史卡片永远转圈（`:369-419`）。
- 秒表起点用状态记录里的 startedAt，不用组件 mounted 时刻；重挂载/切会话不会归零（`:610-631`）。

当前实际工具输出截断上限是 `src/main/engine/cliProvider/history/transcriptParseCore.ts:159` 的 **256000 字符**。部分注释还写 4KB，不能将旧注释当现状。

## 6. 历史：子过程分开落盘，再回填到父卡片

SDK/CLI 转录约定（Wuzu 消费）：

```text
<native-session-id>.jsonl
<native-session-id>/subagents/agent-<task-id>.jsonl
<native-session-id>/subagents/agent-<task-id>.meta.json
```

meta 中读取 `{ toolUseId, agentType, description }`；子 JSONL 内可能带 `agentId`。见 `src/main/engine/cliProvider/history/subagentReader.ts:1-9`、`:29-33`、`:79`。

- `historyReader.ts:149-158` 主转录过滤 isSidechain、压缩摘要、system、task-notification；worker 纯解析路径 `transcriptParseCore.ts:102` 同样过滤。
- `transcriptParseService.ts:208-227` 在 worker 解析完主历史后，由主进程调用 `attachSubagentTranscripts`；旧同步入口 `historyReader.ts:223-224` 也调用它。
- `subagentReader.ts:166-216` 建 `toolUseId → 发起消息` 映射，扫描 *.meta.json，依据 meta.toolUseId 读取同名 JSONL，把子工具步骤附到 owner.thinkingSteps、统计写到 owner.subagentTasks[toolUseId]，不创建新消息。
- `:91-128` 用子工具 ID 配对调用和返回，保留输出/isError，并给每个步骤打 parentToolUseId；只保留工具过程，不把子思考/正文混入主消息。
- `:132-137` 未等到结果的工具收口为“已中断”；`:211` 子任务状态采用 interrupted ? killed : completed。
- `:118-119` 单子代理最多回填 300 条步骤，但 toolUses 继续全量计数；坏文件跳过单个，不拖垮主历史。
- `:217-222` 父轮结束时间取主输出与子任务最后活动的更晚者，修正后台子任务拖后的时间。

这解决的是主会话中的消息/步骤污染。Aether 若子 session 被主会话列表当成普通会话列出，还需要引擎存储层的 parentSessionId/rootSessionId 与列表过滤，不能只抄 UI 的 parentToolUseId 过滤。

## 7. 用量：多来源对账，实时与重启一致

- SDK task_progress 统计、流内 assistant usage、原生转录统计三个来源；`SdkClaudeProvider.ts:3762-3785` 分字段取最大。
- 流内同一 API 响应可能拆多条 assistant 事件且首条 usage=0。`:4153-4172` 按 parentToolUseId + message.id 取最大快照，只记增量；主消息 usage 仅处理非子代理（`:4176`）。
- 转录 `subagentReader.ts:254-275` 同样按 message.id 最大快照聚合，统计口径一致；`:285` 起的 mtime 缓存避免没变的文件重复读盘。
- `SdkClaudeProvider.ts:3627-3669` 收尾继续补统计，连续稳定后停、最多 10 秒；`:3690-3722` 按原 owner 推送无状态统计，不能反向更改终态。
- 子任务 totalTokens 当前只是 input_tokens + output_tokens（`subagentReader.ts:263`）；未合并 Anthropic cache_*。借鉴时必须定义总用量口径，不能把这里的“总 token”当适用于所有供应商的会计总账。

## 8. 取消与恢复

取消单任务的链路：

`CliSubagentCard.requestStop` → `CliChatView.handleStopSubagent` → `claudeCliChat.stopSubagent` → preload `claude-cli:subagent:stop` → `SdkClaudeProvider.stopSubagent` → SDK `Query.stopTask(taskId)`。

证据：

- `CliSubagentCard.vue:435-452` 只允许 SDK 统计里的 taskId，不使用模型自填 toolInput.taskId；8 秒未收口解除 loading。
- `CliChatView.vue:683-688` 只对 Claude 路径发单任务停止。
- `src/renderer/src/stores/claudeCliChat.ts:1504-1524` 不调用会话 stop；失败目前只 console.warn/error。
- `src/preload/claudeCliApi.ts:134-138`；`src/main/engine/cliProvider/ipc/claudeCliIpc.ts:458-476`。
- `SdkClaudeProvider.ts:1555-1597` 根据 Wuzu session 找 active Query；feature detect stopTask；调用 SDK stop_task，不 abort 父 controller、不 close query，避免取消父任务/兄弟。
- 等 task_notification/stopped → killed 再收口 UI，IPC 成功表示停止请求已发送，不是已经终止。

恢复主要是 **父会话恢复和历史回放**，不是 Wuzu 自己实现逐子代理恢复：

- `claudeCliChat.ts:808-858` 查询主进程 activeSessions，对账渲染层残留 running。
- `:880-938` 历史加载不覆盖已有/正在运行的消息；await 期间续跑则不再替换新消息。
- `:1263` 起中断父会话续跑通过原生 session resume/continue；本次未找到独立子任务 resume 按钮或 Wuzu 的子代理复活状态机。

## 9. Codex 与 lobster 的差异

### Codex

现有 app-server `handleItem` 仅专门适配 agentMessage、reasoning、commandExecution、fileChange、mcpToolCall、webSearch，其他 item 只日志（`CodexAppServerManager.ts:1157-1255`）。检索该目录、CodexProvider、CodexHistoryReader、codexCliReducer 未找到 collab/spawn_agent/wait_agent 的专用归属/卡片适配。

因此不能将 Claude `task_* / parent_tool_use_id / stopTask` 描述成 Wuzu 已为 Codex 同样实现。`collaborationMode: plan/default` 是 Codex 的计划模式设置，不是子代理协作事件。这里是当前本地实现缺口，不意味着上游 Codex 没有子代理能力。

### lobster 群聊 UI

`AgentSubagentGroup.vue` 由 `AgentTeamChat.vue:5` 调用。`useAgentTeamUi.ts:498-538` 先按 metadata.agentId/agentName 定归属，兼容 toolInput.subagent_type、工具名、mention 等老协议；异步派发回执仍属于父 Agent，真正子工作另归属。

`:1501-1535` 按同一 Agent 的连续活动切段，顶层调用 taskId / 显式 runId 隔离同名并行任务。`:1876` 的 groupSubagentEvents 只将连续同一 speaker 子活动聚组，父段/用户消息会打断；`:1956-1983` 压平工具与回复摘要成执行列表。

`AgentSubagentGroup.vue:91-103` 组头目前只显示 running/completed 加可恢复错误红点，是一个展示汇总，不能替代统一任务终态。此路径属于 Wuzu 对 lobster 数据的 UI 聚合，不是 Claude CLI 的 parentToolUseId 模型。

## 10. 本地确定的不足与代码推导风险

以下应在 Aether 方案中主动避免，不能把 Wuzu 当完备规范：

1. **历史终态缺权威记录**：`subagentReader.ts:132-137`、`:211` 只按悬挂工具推导 killed/completed；零工具时 LLM 失败、所有工具结束后 LLM 失败，都可能被恢复成 completed 的子任务统计。父 Agent/Task 的 isError 仍可能使卡片显示失败，因此不能说所有这类卡片必然绿；确定缺口是子任务终态本身不能完整还原。
2. **迟到工具结果回填不足**：reducer 允许 tool_result 在非 running 时到达（`:291-295`），但处理体仅用 streamingMsgId 查消息（`:467-469`）；done 在 `:387` 清掉 ID，后到内部输出可能丢失。subagent_task 已有 owner 回查，tool_result 未复用。
3. **卡片独立错误文案可能缺失**：`CliSubagentCard.vue:407-410` 看 stat.error 判红，但 `:518` 的 resultText 只取 toolOutput，模板仅在 resultText 有值时显示返回；若只有 task failed/error、无工具结果，可能红图标却看不到原因。
4. **子代理 synthetic API error 可能升级父错误**：adapter 在已经算出 isSubagent 后，`:4088-4100` 的 synthetic API Error 分支没有 isSubagent 守卫，直接 ctx.emitError。是代码推导风险，未用真实 SDK 失败做复现。
5. **UI 的 running 依赖父流**：卡片 `:369-374` 要求 isStreaming；后台子任务在父 done 后仍跑时可能显示 unfinished。统计允许延迟回收，但独立子任务实时生命周期展示未彻底解耦。
6. **不完整递归树**：CliSubagentCard 内部只用 CliCompactToolRow 渲染 children（`:139`），不递归渲染孙代理卡片；历史 owner map 在 attach 前一次建立，未发现递归回填子目录逻辑。当前模式主要适合一层子任务。
7. **失败停止请求不面向用户显示**：store 的 stopSubagent 错误只写 console（`claudeCliChat.ts:1517-1524`），卡片靠 8 秒重置按钮；可以借鉴控制面隔离，不能照抄这种错误反馈。
8. **统计单调合并需明确适用口径**：max 能抵御迟到小快照，无法纠正源头高估；不同 run/attempt 不能共享同一计数身份；cache 计费与本地工具计数要定义清楚。
9. **测试不覆盖所有这些路径**：本次未发现直接测试 subagentReader 文件读取/归属/故障、SDK stopTask 真实控制或 CliSubagentCard 错误详情的专用测试；已找到的统计 reducer 测试不能证明跨重启和真实取消一定正确。

## 11. 已运行的测试证据

命令（使用仓库的 Windows 路径大小写包装脚本，禁用缓存）：

```text
npm test -- run test/renderer/claudeCliSubagentStats.test.ts test/main/engine/cliProvider/harnessInjectionFilter.test.ts --cache=false
```

结果：**2 test files passed，23 tests passed，exit 0，201ms**。未启动真实 Electron/CLI，未发模型请求。

- `test/renderer/claudeCliSubagentStats.test.ts:66,80,100,119,140,163,190`：7 条覆盖首次统计、小值不回退、增长、终态无统计保留、killed 后 running 不复活、终态后允许统计补齐、兄弟任务互不影响。
- `test/main/engine/cliProvider/harnessInjectionFilter.test.ts:41-219`：16 条覆盖 task-notification/system-reminder 注入过滤、真实用户文本保留、续写引导不进历史、成功续写接管旧错误、再次失败/旧悬挂工具处理。该测试 mock 了 attachSubagentTranscripts，不是子文件回填集成验证。

## 12. 对 Aether 改造的直接建议

建议采用机制而不复制 SDK 适配实现：

1. 引擎持久化任务/会话关系：rootSessionId、parentSessionId、parentToolCallId、runId/attemptId；普通历史列表只列用户主会话，子任务作为附属可展开实体。
2. 明确 child_task_started/progress/completed/failed/cancelled 结构化事件，以及内部工具 start/end 的 childRunId/parentToolCallId；主正文、子过程、任务状态分开路由。错误原因字段不能只藏在 output 文本里。
3. 实时状态和历史读取返回同一 TaskSnapshot/ToolActivity 契约；历史恢复真实 terminal status、error、工具详情、时间与用量，不靠字符串或工具是否悬挂猜成功。
4. 前端 reducer 按任务 ID/调用 ID 回查正确父消息，允许终态后迟到统计/结果收口，不新建主消息；序号或版本防乱序，终态不能被旧 running 覆盖。
5. 卡片目标、实时活动、内部工具详情、最终输出/失败原因、统计独立显示；无统计或零工具时也展示真实失败；复制导出使用同一状态来源。
6. 取消是 childRunId 控制命令，独立 AbortController，确认子任务终止后发 cancelled；UI 保留取消中与请求失败反馈，父任务/兄弟不受影响。
7. 验收必须含：子历史不混入主列表/主气泡、零工具 LLM 失败不成功、live/replay/export 一致、迟到事件不串轮、取消兄弟隔离、重连及重启详情恢复、多子任务与并行/重复 task 标签、用量不重复。

这份报告只证明本地实现和已运行纯函数测试，未声称 Wuzu 的真实 SDK/供应商调用已全部验证。
