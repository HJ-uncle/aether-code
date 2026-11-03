# 官方开源 Codex：引擎工具与发现协议

版本锁定：[`616cab3a3529`](https://github.com/openai/codex/commit/616cab3a3529f572c3385098c12698278770ea98)，提交时间见 [revision.json](codex-oss/revision.json)。

公开源码注册项目录；包含互斥版本、托管工具形态和内部测试项，不是任何单个会话的工具总数。inputs/outputs 是人工核对摘要；完整静态定义见 sourceFiles，动态覆盖以运行时为准。

本目录共 35 条注册/版本形态，其中包含 1 条内部测试工具。V1/V2 分列，WebSearch 是托管工具形态；**不能拿这个数字与 Aether 的 76 个注册能力直接比大小**。动态插件、MCP 和桌面工具另行列出。完整静态定义和中文摘要见 [codex-oss-tools.json](codex-oss-tools.json)。

## 全部静态注册项与版本形态

### 核心

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`exec_command`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/shell_spec.rs#L22) | 运行 shell 命令，可保留正在运行的进程 | 必填 cmd；可选 workdir/shell/login/tty/yield_time_ms/max_output_tokens；多环境可有 environment_id；权限参数随配置变化 | output、wall_time_seconds；可选 exit_code/session_id/chunk_id/original_token_count | ShellTool + model shell；UnifiedExec 控制恢复进程；UnifiedExecTty 控制 PTY |
| [`write_stdin`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/shell_spec.rs#L108) | 向运行中进程写 stdin 或读取增量输出 | 必填 session_id；可选 chars/yield_time_ms/max_output_tokens | 与 exec_command 相同；完成时 exit_code，运行时 session_id | UnifiedExec 开启且 shell 可用 |
| [`apply_patch`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9) | 以补丁新增/更新/删除文件 | FREEFORM，Lark grammar；多环境可有 Environment ID | 补丁执行结果或失败；受文件权限保护 | 模型 apply_patch_tool_type 可用 |
| [`view_image`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/view_image_spec.rs#L16) | 读取本地图片进行视觉检查 | 必填 path；条件可选 detail=high/original、environment_id | image_url；detail 字段由图像预算配置决定 | ViewImage；图像细节参数受模型/预算配置控制 |
| [`update_plan`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/plan_spec.rs#L7) | 更新任务步骤和状态 | 必填 plan[{step,status}]；status=pending/in_progress/completed；可选 explanation | 计划更新确认，无固定 output_schema | update_plan_enabled |
| [`request_permissions`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/shell_spec.rs#L153) | 请求文件系统/网络权限 | 必填 permissions；可选 reason/environment_id；permissions 含 network.enabled、file_system.read/write | 客户端授予的权限/审批结果；不保证完整授予 | RequestPermissionsTool；用户/客户端审批 |
### 交互

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`request_user_input`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/request_user_input_spec.rs#L16) | 同步向用户提问 | 必填 questions，1–3 项；各有 id/header/question/options，选项含 label/description | 用户答案或模式限制错误；无固定 output_schema | experimental_request_user_input_enabled；可用模式另行限定；DirectModelOnly |
| [`request_user_input_async`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/request_user_input_async.rs#L36) | 工作中异步向用户提问，不结束当前工作 | 必填 questions[]；title 必填，options 可选；模型参数可覆盖 | 立即确认；用户回答作为后续消息到达 | 实验开关 + 模型支持 + 非受限 root；DirectModelOnly |
| [`send_message_to_user_async`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/send_message_to_user_async.rs#L32) | 工作中向用户发送需要即时关注的信息 | 必填 message | 立即返回，不等待回答；无固定 output_schema | SendMessageToUserAsync 或模型支持，非受限 root；DirectModelOnly |
### 核心

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`wait_for_environment`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/wait_for_environment.rs#L85) | 等待挂载执行环境准备完成 | 必填 environment_id | 环境就绪或失败说明；描述和超时策略可由配置覆盖 | DeferredExecutor |
### 上下文

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`new_context`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/new_context_window_spec.rs#L10) | 开始新上下文窗口，保留环境状态 | 空对象；模型可覆盖定义 | 上下文切换控制结果 | TokenBudget；DirectModelOnly |
| [`get_context_remaining`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs#L12) | 查询当前上下文剩余 token | 空对象；模型可覆盖定义 | tokens_left | TokenBudget |
### 时钟

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`clock.curr_time`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/current_time.rs#L54) | 获取当前 UTC 时间 | 空对象 | 当前 UTC 时间 | CurrentTimeReminder 或模型声明 clock |
| [`clock.sleep`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/sleep.rs#L38) | 等待指定时间，可被新用户输入中断 | 必填 duration_ms，1–43200000 | 实际经过时长/中断状态 | SleepTool + AlwaysOn 或对应时钟/模型条件 |
### MCP 资源

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`list_mcp_resources`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L7) | 列出服务器提供的资源 | 可选 server/cursor | 资源与分页信息；服务器返回的资源权限仍适用 | 有 MCP server 或 CodeModeOnly；模型可覆盖说明 |
| [`list_mcp_resource_templates`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L36) | 列出参数化资源模板 | 可选 server/cursor | 资源模板与分页信息 | 同上；不是工具发现接口 |
| [`read_mcp_resource`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L65) | 读取指定服务器的资源 | 必填 server/uri | 文本或二进制资源内容 | 同上；URI 应来自资源/模板发现 |
### 插件

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`list_available_plugins_to_install`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/list_available_plugins_to_install_spec.rs#L7) | 查询可安装插件/连接器候选 | 空对象 | 运行时可用候选名称、ID、类型/描述 | tool_suggest 启用、有候选、presentation=ListTool |
| [`request_plugin_install`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/request_plugin_install_spec.rs#L10) | 建议安装与用户明确请求匹配的插件 | ListTool: tool_type/action_type/tool_id/suggest_reason；RecommendationContext: plugin_id/suggest_reason | 安装建议或客户端审批交互；非静默安装保证 | tool_suggest 启用且有候选；必须匹配用户请求 |
### 发现

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`tool_search`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/tool_search_spec.rs#L15) | 搜索延迟工具并向后续模型调用暴露完整声明 | 必填 query；可选 limit（默认由运行时传入） | 匹配的工具定义；Code Mode 返回 name/description 和 TypeScript 声明 | 由延迟工具、模型 search 能力和路由策略决定；BM25 |
### 协作 V2

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`spawn_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L108) | 创建子代理 | 必填 task_name/message；可选 fork_turns；agent_type/model/reasoning_effort 受配置控制 | task_name，可选 nickname 等元数据 | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
| [`send_message`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L204) | 给已有代理发消息，不触发新 turn | 必填 target/message | 发送确认，无固定 output_schema | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
| [`followup_task`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L236) | 给已有非 root 代理追加任务，闲置时启动 turn | 必填 target/message | 投递/任务确认，无固定 output_schema | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
| [`interrupt_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L361) | 中断代理当前 turn，保留代理可再次使用 | 必填 target | previous_status | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
| [`list_agents`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L315) | 列出当前树内代理状态 | 可选 path_prefix | agents[{agent_name,agent_status,...}] | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
| [`wait_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L303) | 等任意活跃代理邮箱或完成事件，可被用户输入打断 | 可选 timeout_ms；默认/上限由 WaitAgentTimeoutOptions 决定 | message/timed_out 状态摘要，消息正文另行递送 | multi_agent_v2 + collab 条件；namespace/描述/schema 可覆盖；direct message 可禁用 |
### 协作 V1

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`multi_agent_v1.spawn_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L70) | 旧版创建子代理 | message 或 items；可选 fork_context/agent_type/model/reasoning_effort | agent_id/nickname | 旧版协作启用；不与 V2 视作同一会话全部同时暴露 |
| [`multi_agent_v1.send_input`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L166) | 旧版给代理输入，可中断当前任务 | target 必填；message 或 items；可选 interrupt | submission_id | 旧版协作启用；不与 V2 视作同一会话全部同时暴露 |
| [`multi_agent_v1.resume_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L265) | 恢复关闭的代理 | 必填 id | status | 旧版协作启用；不与 V2 视作同一会话全部同时暴露 |
| [`multi_agent_v1.wait_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L287) | 等待指定代理达到最终状态 | 必填 targets；可选 timeout_ms | status/timed_out | 旧版协作启用；不与 V2 视作同一会话全部同时暴露 |
| [`multi_agent_v1.close_agent`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L336) | 关闭代理及未关闭后代，释放并发槽 | 必填 target | previous_status | 旧版协作启用；不与 V2 视作同一会话全部同时暴露 |
### 工具编排

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`exec`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/code-mode-protocol/src/description.rs#L23) | 在 V8 isolate 编排工具；不是 shell/Node | FREEFORM JavaScript；可选首行 pragma yield_time_ms/max_output_tokens；通过 tools 对象调用已注册工具 | text/image/audio 等输出；运行未结束返回 cell ID | Code Mode 运行模式；tools 暴露由 registry 决定 |
| [`wait`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/code-mode-protocol/src/description.rs#L53) | 等待或终止 exec 运行中的 cell | 必填 cell_id；可选 yield_time_ms/max_tokens/terminate | 增量输出、完成或终止；仅在 exec 返回 running 后调用 | Code Mode 运行模式 |
### 托管工具

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`WebSearch / web.run（条件替代）`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/spec_plan.rs#L723) | 搜索互联网；可由 hosted 模型工具或扩展承载 | 此注册器不定义统一 JSON 参数；由 provider/扩展提供 | 搜索结果/来源，具体 schema 随承载工具变化 | provider.web_search、模型配置、StandaloneWebSearch、扩展 web.run 去重策略 |
### 内部测试

| 工具 | 用途 | 参数 | 结果 | 启用条件 |
|---|---|---|---|---|
| [`test_sync_tool`](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/test_sync_spec.rs#L7) | 集成测试同步屏障，不是面向用户的常规工具 | sleep_before_ms/sleep_after_ms/barrier{id,participants,timeout_ms}/wait_for_git_enrichment | 测试执行结果 | 模型实验能力显式声明 test_sync_tool |

## 动态生态入口

- **MCP tools**：从当前已连接 MCP server 获取 description/inputSchema/outputSchema/annotations，经权限和 exposure 策略注册；集合随服务器变化。 [源码](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/mcp.rs)
- **Dynamic tools**：宿主提供的动态工具；名称和 schema 来自当前 client/thread，而不是 core 固定列表。 [源码](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/dynamic.rs)
- **Extension executors**：扩展提供的工具执行器，统一 adapter 转为 registry 工具；目标管理等能力不能单凭 core 固定 handler 列表否定。 [源码](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/handlers/extension_tools.rs)

## 从“注册”到“模型知道怎么用”

1. `build_tool_router` 同时接收模型信息、当前执行环境、工具策略、MCP、动态工具与扩展，不是在所有会话发一套固定工具。
2. registry 区分直接暴露、仅直接模型调用、延迟暴露和隐藏；Code Mode 内部的工具目录与模型直接看见的工具不完全相同。
3. `tool_search` 按 description/name 等元数据搜索延迟工具，并把匹配工具的完整声明提供给下一次模型调用。MCP resources API 用来读资源，不能拿来替代工具发现。
4. Code Mode 描述明确声明没有 Node、文件系统或直接网络；要通过 tools 调用执行器。它附带工具声明、数据类型、输出 helper、ALL_TOOLS 或搜索指引。
5. 说明可以按模型覆盖，Windows 命令指引根据 executor 的真实 OS 决定。多环境时加入 environment_id，避免假定本机 shell 就是执行环境。
6. 工具可以只返回标准控制确认，也可以返回结构化输出 schema。进程、cell 和子代理都有稳定 ID/名称与对应 wait/continue/interrupt 入口。

注册与暴露主证据：[spec_plan.rs](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/spec_plan.rs#L122)、[registry.rs](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/core/src/tools/registry.rs)、[Code Mode description](https://github.com/openai/codex/blob/616cab3a3529f572c3385098c12698278770ea98/codex-rs/code-mode-protocol/src/description.rs#L16)。

## 未在这份核心表中伪造的能力

浏览器、办公预览、工作区依赖、桌面任务/工作树管理、云 artifact 和第三方应用的完整工具来自宿主/扩展/插件。本地客户端目录和官方生态文档分别提供它们的证据；核心表没有某个名字，不能据此宣称官方没有该能力。目标工具等扩展也不能仅凭 35 条静态目录穷尽。

来源文件已只读下载到 [codex-oss/sources](codex-oss/sources/)，下载记录见 [download-index.json](codex-oss/download-index.json)。没有编译、执行这些官方源码。
