# 本地 Claude 子代理机制研究（只读）

研究日期：2026-09-29。研究对象为用户明确指定的安装和 Wuzu 自带 SDK。未启动 CLI、未调用模型、未读取凭证或用户会话，未修改参考项目。结论来自类型契约及打包代码的静态追踪，**不是 CLI 的实际运行验证**。

## 范围与证据可信度

1. **指定安装**：`C:/Users/wb.xielin02/AppData/Roaming/Wuzu Client Dev/cli-binaries/claude/2.1.266`。`package.json:2-5` 为 `@anthropic-ai/claude-code` / `2.1.266`，启动目标 `bin/claude.exe`。文件有 MZ 头，大小 **218,971,808 字节**。`cli-wrapper.cjs:1-7` 明确是未执行 postinstall 时的 fallback launcher，不是 Agent 实现。
2. **同版本公开工具类型**：该目录 `sdk-tools.d.ts`。这是直接随包发布的输入输出契约，作为高可信证据。
3. **同版本有限原生包片段**：可执行文件包含可读的打包 JavaScript。下文引用 **十进制字节偏移**，只核对有限片段；这些是实际随安装分发的代码，而非完整还原源码。受功能开关、上下文、模型、平台影响，不能保证所有路径在用户当前配置里都会启用。
4. **补充 SDK**：`D:/web/wuzu-client/node_modules/@anthropic-ai/claude-agent-sdk/package.json` 为 **0.3.258**，`claudeCodeVersion` 为 **2.1.258**。`sdk.d.ts` 能证明该 SDK 的宿主事件接口，**不能直接声称就是 2.1.266 的全部运行时实现**。默认前后台策略以 2.1.266 自己的类型/代码为准。

可执行文件 SHA256：`D2C5F7B3B6A12819097CEB6EFBCE2A390157166003FCAEE32DBDE0E6D7B45EF7`。下文偏移对应此文件。单独静态字符串只作为线索；报告中的运行机制结论均同时核对了周边条件分支/调用或发布类型。尚未通过真实请求验证网络异常、并发竞争、恢复时序及当前配置的功能开关。

**版本注意：2.1.266 的后台默认不能套到 Wuzu 的 SDK 2.1.258；也不能反过来推定 Wuzu 默认同步。这里没有执行 Wuzu/CLI 来验证其最终有效策略。**

## 1. 它实现的是有身份、有生命周期的运行任务

`2.1.266/sdk-tools.d.ts:683-719`：

- `AgentInput` 必需 `description: string` 和 `prompt: string`，可选 `subagent_type`、`model`、`run_in_background`、`name`、`isolation`。
- `prompt` 是任务内容，不能把一整条 `{role, content}` 消息对象作为内容再嵌套进去。
- `model` 优先于 agent definition / 默认子代理模型；`fork` 忽略模型覆盖，继承父模型。
- `run_in_background` 注释明确：**2.1.266 默认后台**，只有紧接着的动作依赖结果、且无其他有价值工作时设置 false。原生包 `189858989` 的 `BBo` 也做实际前后台决策，还受禁用后台、teammate、agent definition、coordinator 等条件影响。
- `name` 让 Agent 可被 `SendMessage({to: name})` 定位。
- `team_name` 和 `mode` 已废弃；权限默认继承，定义可以配置。
- `isolation` 为 worktree 或 gated remote；默认不代表每个子代理自动拥有 worktree。
- **这个版本的 AgentInput 没有 `resume` 或 `max_turns`**。不能搬用旧版本教程的字段。续跑通过 SendMessage 及内部恢复路径；轮数属于定义/runner 配置。

原生包 `190473650`：运行时 schema 对 `prompt`、`description` 做字符串校验；`call()` 再校验类型、权限、nesting depth、parent stop pending、budget、并发数量和必要 MCP 服务。这些前置失败是异常，不包装为“执行完成”。

原生包 `190479000`：

- depth 限制由 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 控制；到限制拒绝再 spawn。
- 并发检查 `getConcurrentSubagents()`；获取 `takeConcurrencySlot()`，完成时释放。
- budget 已耗尽拒绝新 spawn。
- 停止过程中的父 agent 不能继续 spawn。

## 2. Spawn 结果、运行状态、最终输出是不同层

`2.1.266/sdk-tools.d.ts:103-207` 的 AgentOutput 是判别联合：

| status | 主要内容 | 语义 |
|---|---|---|
| completed | agentId、content 文本块、totalToolUseCount、totalDurationMs、totalTokens、usage、模型信息、worktree 信息 | 返回该次执行结果 |
| async_launched | agentId、description、prompt、outputFile、模型信息 | 已启动，尚无最终结果 |
| remote_launched | taskId、sessionUrl、description、prompt、outputFile | 云端启动回执 |

原生包 `190496313` / `190501059` 返回 async_launched；`190502567` 返回 completed。`190502900` 的结果映射明确告知父模型后台任务尚未完成，不得预测结果；完成后再使用结构化输出与通知。`190506200` 的 completed 映射在报告后加模型用 ID/usage 尾部，续跑方式为 SendMessage。

**ID 不能混为一个值：**

- `session_id`：父会话流/存储命名空间。
- `tool_use_id`：触发 spawn 的工具调用，是 UI 中父卡片的关联键。
- `agentId`：子代理身份及 transcript 键，能够恢复后复用。
- `task_id`：任务注册表键；local agent 某些路径与 agentId 同值，但还有 bash/workflow/remote 等任务，宿主不可普遍假设等同。
- `parentAgentId`：嵌套父代理；`ownerAgentId`：结果应投递给谁。内部可转交 owner，不宜直接照搬全部复杂性。

原生包 `189006441` 附近的前台任务注册也包含 agentId、ownerAgentId、parentAgentId、spawnDepth、toolUseId、abortController、status、isBackgrounded；前台任务不是没有任务记录的临时函数。`190491000` 同一 runner 构造前后台任务，并持有并发资源释放回调。

## 3. 失败、取消与部分输出都有独立信号

`SDK 0.3.258/sdk.d.ts:5119-5143`：`task_notification` 提供 task_id、tool_use_id、`completed | failed | stopped`、output_file、summary、usage。`5167-5201` 的 task_started 还有 task_type、is_backgrounded、spawn_depth。`5203-5220` 的 task_updated patch 有 status/error/is_backgrounded；明确不把 AbortController、messages、result 直接塞进状态广播。

原生包 `190437600` 附近：

- `Tke()` 识别 `isApiErrorMessage`，不是靠正文非空判断成功。
- `ILe` 为 `AgentApiErrorTerminationError`。
- 只有 rate_limit / overloaded / server_error 且已有真实 assistant 输出，`U4o()` 才产生“PARTIAL / agent did NOT finish”恢复报告。
- `190446000` 主任务 runner 在尾消息是 API error 时抛出该错误；异常分支设置 failed 并发送失败通知，取消分支 killed + killedBy 并发送停止通知。
- `190440956` 同步路径对错误恢复有严格区分：不能恢复的 API error 继续抛出；可恢复部分内容带 cutoffNote。

**重要边界：Claude 也不是所有 status 字样都等价于业务成功。**

- SDK `sdk.d.ts:4915` 明说 `subtype: success` 仍可同时 `is_error: true`，需要按 `is_error` 判错。`4932-4935` 是对应字段。
- 同步路径某些 transient failure 的部分内容可能装在 completed 输出容器里，但带醒目的 partial cutoff 提示。因此我们的方案应采用更明确的 `outcome=failed/cancelled/partial/completed` 和 `stopReason`，不要照抄这个容器语义。
- maxTurns 是正常循环停止条件但结果可能只是部分输出；`188998322` 通知描述明确写 reached turn limit / partial，不能把预算耗尽显示成任务已完成。

## 4. 停止不只是 UI 改状态

SDK `sdk.d.ts:2883-2886`：`stopTask(taskId)` 后会发 stopped 通知。`2888-2901`：把前台任务转为后台时，阻塞工具调用先返回 running 回执，实际任务继续执行，终态另发通知。`1398-1401` 是 query 级 AbortController；`8260` 之后说明 process transport 的退出有 stdin EOF + grace window，与单 task stop 不是同一层。

原生包核实：

- `190561000`：stopTask 查任务/名字、运行状态和 owner 权限；若状态已终结但 loop 还没退出，再发 abort 并清理相关进程组，不能仅凭状态认为资源已释放。
- 同一片段在特定 keepalive/嵌套状态下遍历后代，发 stopped 并调用 kill；存在 cascade exemption，说明它有明确的停止传播策略，不是无差别 kill 所有会话。
- `190563926`：用户停止写 `stoppedByUser`、递增 userStopCount，并落盘停止标志；SDK/系统 sweep 有单独 killedBy system 路径。
- `201155710`：resumesInFlight 集合防止相同 agentId 同时恢复；running/resuming 和 still-stopping 的状态拒绝重复恢复。
- `201156600`：读回 metadata 后发现 stoppedByUser，除显式用户发起等受控条件外拒绝恢复。这解决“用户按停止，父 agent 下一秒自动重新唤醒”的问题。
- `190382400`：runner finally 分阶段清理 MCP、hooks、readFileState、REPL、sandbox grant、monitors、shell tasks，单个清理失败记录但不阻断后续 cleanup。
- `184275136`：terminalEmitClaims 负责终态通知 claim 去重；`184277860` 的 `_i` 经它发送 task_notification。
- `188998322`：owner notification 另有 claimed/notified 去重。`188999100` 明说同一 agent 续跑后可能再通知，因此“一个 agent ID 一生只能收到一次终态”也不正确；我们的事件应绑定 **runId** 去重。

## 5. 子代理历史属于父会话，UI 流属于父工具调用

明确的落盘层级与映射：

- SDK `sdk.d.ts:1038-1047`：子记录路径 `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`；`listSubagents(sessionId)` 专门列子 agent。
- SDK `827-834`：`getSubagentMessages(sessionId, agentId)` 专门读子历史。
- 原生包 `185083221`：同样构造 `<sessionId>/subagents/agent-<agentId>.jsonl`，不是创建另一个顶层 session 文件。
- 原生包 `192446314`：persist entry 明确写 `parentUuid`、`logicalParentUuid`、`isSidechain`、`agentId`。main session leaf 更新受 `!isSidechain` 条件保护。
- 原生包 `190377857`：spawn metadata 持久化 `toolUseId`、`parentAgentId`、`spawnDepth`、cwd、description、requestShape、model、worktree 信息。
- SDK `sdk.d.ts:5421-5434`：读取历史消息有 `parent_tool_use_id` 和 `parent_agent_id`。
- 原生包 `190381145`：后台子代理消息转换为 agent_progress 时使用 `parentToolUseID: en`（spawn tool ID），同样能发到 SDK 活跃流。
- SDK `sdk.d.ts:3271-3279` 的 assistant、`4754` 的 partial、`5273` 的 user 均有 parent_tool_use_id，供宿主路由到嵌套 transcript。

UI “没详情”不应靠解析结果正文弥补：SDK `sdk.d.ts:1727-1732` 提供 `forwardSubagentText`。默认只转发子代理 tool_use/tool_result，启用后才转发文本/思考以构建完整嵌套记录；同时 `5276-5278` 明确 UI 应渲染 `tool_use_result` 的结构化 Agent 输出，别解析给模型看的 agentId/usage 文本尾巴。

这为当前 Aether 的“子代理变成未命名顶层会话”给出清晰借鉴：根列表只列 root session；child transcript 保持父 session / spawn tool / agent / run 关联，卡片可展开与重启恢复。

## 6. 上下文与工作目录有明确策略

- 原生包 `190491000`：普通 agent 的初始输入为意图转发附件 + `Ce({content: prompt})`，另有 agent definition 的 system prompt；fork 才设置 `forkContextMessages: parent.messages`、继承父 system prompt 和工具。
- `189853035`：意图转发来自选择后的父输入，带 provenance 元数据，不等于把父消息全量拷进每个 agent。
- `190452991`：fork 模式显式说明继承历史是参考，不是当前任务；执行一条 directive，防止递归 fork；还补齐 fork 边界的 tool_result，维持工具调用配对。
- `190491000`：子 session 的项目上下文由 `session.withProject({cwd})` 构造；worktree 模式把 cwd 与分支绑定到 runner，结果返回路径。
- 同一片段：无变更临时 worktree 可清理，有变更/待恢复/后台 owner 需要保留时返回路径；不能把所有子代理强制 worktree 化。
- `190366361`：runner 从传入 session 取 userContext/systemContext，准备独立消息/读文件状态与权限上下文；没有把父运行中的所有可变状态直接共享成一个 child context。

## 7. 对 Aether 方案的建议：学边界，不替换引擎

适合首阶段：

1. 保留既有 ReAct / 多模型 provider，新增 typed SubagentRunner 与单一入口：`prompt: string | ContentBlock[]`；构造 user message 只能发生一次，入口作运行时校验。
2. Runner 返回判别联合，区分 completed / failed / cancelled / partial，并携带 stopReason、error code、可恢复性、最终文本和 usage；工具是否返回、文字是否非空不能决定成功。
3. 在分配 child 前生成 parentSessionId / parentRunId / parentToolCallId / agentId / runId / depth。子 transcript 存为父的 child，列表默认 root-only。
4. 生命周期为 spawn → running → progress → terminal；所有 event 带关联键和序号。保存 before publish，重连从持久化记录回放；按 runId + event seq 去重，旧 run 的终态不能覆盖新 run。
5. Child AbortController 与 parent/run 取消策略关联，超时/轮数/预算/用户停止都能终止 loop 和工具资源；terminal 只结算一次；UI 等待真实终态，不能点击即伪造成功/完成。
6. 第一阶段默认任务 + 明确 cwd + 权限/工具 allowlist，避免盲目继承全部历史/内存。fork 后续独立设计。
7. 有界重试只用于可重试 provider failure；HTTP 400 invalid message 等协议错误 fail-fast，不让父模型缩短 prompt 盲重试。
8. UI 的状态、详情、失败原因、usage 均消费结构化协议；流和历史使用同一 reducer。

不适合首阶段直接照搬：

- 2.1.266 的后台默认、多轮 SendMessage、owner 迁移、keepalive、observer、自恢复：这些需要完整任务调度和事件存储；当前系统应先做稳定前台链路，再引入可恢复后台。
- teams 与 named teammates：已存在特殊禁用后台/禁止 teammate spawn teammate 等约束，不是简单多个 Promise。
- cloud remote、worktree 自动管理、fork prompt cache：和 Claude 的会话环境强绑定，对修正当前故障不是必要项。
- 把 Claude CLI 当引擎直接替换：会改变模型支持、权限、工具、持久化与部署，范围远大于子代理修复。
- 照抄 `status: completed` 包部分输出、`subtype: success + is_error`：我们的新契约可以更清晰。
- 输出 JSONL 路径让父模型不停读：2.1.266 自己就限制这种行为，避免把所有子工具噪声塞回父上下文；应发精简进度与最终报告。
- 持久化 running 状态后无条件自动复跑：子代理可能已执行写盘/外部副作用，恢复时必须有 run epoch、工具调用记录和用户停止 tombstone；不能仅靠 prompt 重启。

## 8. 与此研究直接对应的验收

- 非法嵌套 message 在 runner/provider 边界被拒绝；合法 task text 构造为恰好一层 user content。
- 首次 400：child failed、父 tool error、卡片 failed；不显示成功、不盲重试。
- 429 等耗尽重试：保留 partial report、failed/partial 终态与原始原因。
- tool output 非空但带 error、maxTurns/budget 到限均不能当业务完成。
- stop 在模型 streaming、工具执行、刚好完成、后台转换时可正确收敛；重复 stop 幂等；先被取消的旧 run 不可污染后续 run。
- 重启后根列表无子会话杂项；父卡片能读回 task / steps / result / error；live 与 replay 状态一致。
- 多 child progress 不串线；嵌套 child 使用父 tool call 链正确归属；运行额度释放，无失控递归。
- 子代理关闭后 shell/MCP/异步监听没有遗留；用户停止过的 child 不被父 agent 自动重启。

