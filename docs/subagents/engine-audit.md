# Aether 引擎子代理审计与分阶段方案

审计日期：2026-09-29。范围：`D:/dev/ai-agent-engine` 当前工作区源码；只读审计，未改引擎。下文路径均相对该仓库，行号对应审计时工作区，存在其他未提交改动。Wuzu/Claude 的外部对照由另一份研究提供；本报告不推断其未公开实现。

## 结论

这不是一个只有 LLM 400 的问题。当前子代理是“在一个工具函数里新建普通会话并循环收集字符串”，尚没有完整的子任务实体、父子关系、生命周期或可回放事件模型。因此本次请求体错误、失败显示成功、未命名子会话污染主历史、历史无子工具详情，是几处确定缺陷叠加；权限、模型、工作区与取消也缺少一致的继承契约。

建议先做小范围纠错和可靠状态，再建立可持久化子任务，最后增加可选恢复/后台等能力。无需一次性重写整个 agent-loop，也不应把现有子会话记录直接删除。

## 一、确定缺陷及证据

### 1. 400 的直接根因：消息数组当成 content

- `src/tools/subagent/subagent-tool.ts:335-338`：`strategy.run([{ role:'user', content:task }], subCtx)`。
- `src/core/agent-loop/react.ts:195,214-224`：run 的 input 是单条消息内容，直接包装成 `user.content`。
- `src/core/llm-adapter/anthropic.ts:156,321-330,366`：普通 user content 直接进入 Anthropic 请求。
- 实际得到 `content:[{role:'user',content:'...'}]`，元素没有内容块必需的 `type`。主代理 `chat.ts:1030` 传 prompt 内容，因此不触发。
- 两轮真实日志的子会话仅一条 user、content 为上述数组。根提交 `4a1a7dd` 已存在该调用，不是当前未提交修改新引入。
- OpenAI 路径也不正确：`openai.ts:315-343` 只识别 `type:text/image_url`，这种数组元素会被丢弃为 `''`，并非切换提供商即可解决。

### 2. 失败被当作成功，截断/用尽步数也可能假成功

- `react.ts:492-499` 捕获 LLM 异常后 yield 普通错误文本然后 return；并没有抛回 subagent。
- `subagent-tool.ts:383,408,424-425` 拼接文本、只判空、非空即 `success:true`。
- `react.ts:982-983` 的 maxIterations 文本也走同样路径；预算耗尽的普通文本也是同类问题。
- `subagent-tool.ts:334-374,408-420` 保存了 blocked 信息，但只有结果为空时才判失败；该条件无法作为通用终态判定依据。
- 工具开始时 `success:true`（子工具摘要 :351），没收到结束事件也保持成功，没有 running/cancelled/skipped。

### 3. 子会话污染主历史与“未命名”的组合原因

- `subagent-tool.ts:234,300-308` 为每次执行建立普通 `subagent-UUID` session，并使用普通历史工厂。
- `jsonl-history.ts:341-357` 的 append 对所有会话硬写 `isSidechain:false`；迁移、summary 等其他写入同样如此。JSONL 的 parentUuid 只是同文件消息前后链，不是父子会话关联。
- `jsonl-history.ts:685-727` 扫描该租户所有 `.jsonl`，不区分 root/child；`:713-719` 仅字符串能生成 title。
- 错传 input 造成数组 title 缺失；“普通会话全量列出”造成它进入主历史。这两个缺陷分别存在。仅修 task 字符串后，只会从“未命名”变成“任务描述标题”，仍污染主历史。
- `conversation.ts:46-51` 原样返回 listSessions。
- SQLite 回退也没有子会话过滤：`history.ts:418-469` 从所有 conversations 左联 sessions。`SessionStore` 仅管理 agent 绑定，`session/index.ts:17,43` 没有 child 元数据。

### 4. 父子关系丢失，无法可靠重放/清理/定位

- `SubagentMeta` (`subagent-tool.ts:17-27`) 仅 toolCalls、tokens、durationMs，没有 runId/childSessionId/parentSessionId/parentToolCallId。
- child session ID 仅通过日志输出（:236），没有写到父 tool metadata。
- parent toolCallId 仅用于运行中内存取消表（:228-230），结束即删除（:443）。重启无法恢复运行状态，也无法可靠从父卡打开子 transcript。
- `conversation.ts:90-119` 删除根会话只清该 session 的历史/绑定/沙箱，不遍历子任务。因没有关系，无法制定可靠级联、保留或归档策略。

### 5. 历史没有子工具详情，是持久化前主动剥离

- `subagent-tool.ts:339-382` 吞掉所有子控制帧，仅采集 tool start/end/usage/permission；thinking、todo、file_change 等不向父 UI 透传。
- `SubagentToolCall` 仅名字/成功布尔/80 字摘要，不含 toolCallId、完整参数、输出、错误、时间；即时版本也并不具备完整详情。
- 父 `react.ts:882-893` 把含 `__SUBAGENT_META__` 的输出发送给 SSE；`:923-935` 调用 stripSubagentMeta 后再 append tool message，且没把结构移到 metadata。
- 所以实时卡可能有摘要，重启读取历史无法重建；不能靠前端再解析已经被删除的 marker 补回。
- 修复应保留“模型文本与 UI 结构分离”的原意，将结构存入 metadata/子任务事件表；不建议把整个子 transcript 塞回父 LLM 上下文。

### 6. 工作区继承与提示词宣称不一致

- 子继承 `workspacePaths`（subagent :303），但 `WorkspaceManager.getPaths` (`workspace/manager.ts:16-19`) 返回 `[childSandbox,...customPaths]`。
- `getPath/init` (:22-29) 取首项；standard/full-access 相对路径 (:40-46) 取首项；safe 对新文件 (:71-73) 也落首项。safe 对已存在相对路径才逐个查找。
- `cmd-tool.ts:80-82` 默认 cwd 是这个子沙箱；只有 full-access 且显式给 cwd 才切换。
- 子 defaultPrompt :268 等却宣称相对路径以主工作区为基准，:296-299 的注释也把实际顺序写反。失败前的空工作区探测与此一致。
- 项目上下文另有确定选址问题：`chat.ts:648` 不带项目参数调用 `getProjectContextBlock`；`project-context.ts:35-40`、`aether-config.ts:51-52` 读取引擎 `process.cwd()` 下 AE.md/.aether，而非 IDE 项目根。这与截图把 Aether IDE 叫成 Aether Engine 强关联，但不能单凭源码证明模型该次误认的全部因果。

### 7. 权限不继承，工具集合也不继承

- 安全模式 `security/policy-engine.ts:16,23-34,53-58` 按 tenant+session 存内存；子新 session 没有复制或引用父模式，回落 DEFAULT_SECURITY_MODE。父已批准命令也不继承。
- 结果可能比父更严，也可能在默认权限更宽的配置下比父更宽；“永远更安全”不能成立。
- `subagent-tool.ts:239` 无参数重建 registry；而主 `chat.ts:565-571` 明确传 allowedTools、allowedSkills、inlineSkills、inlineMcpServers、inlineAgents。子会丢父资源，也可能重新获得父已禁用的工具。
- 子仅 unregister subagent（:240），仍保留 ask_user；工厂 `registry-factory.ts:210` 附近始终注册提问。子无审批通道却暴露它，靠提示词约束不足。
- 只读调研目前只是自然语言任务描述，没有 read-only capability/sandbox 的执行层契约。此条是设计缺失，不等同于本次已发生越权写入。

### 8. 模型名继承了，完整模型调用配置没有

- 模型顺序 :316：显式 model > subagentModel > parent modelName > 默认，合理但未形成可复用 resolver。
- 主 chat.ts:711-743 支持请求 apiKey/baseUrl/provider 覆盖，:1014 传 extraHeaders；子 :132-154 重新读 ModelsStore/default，不保留本轮 resolved connection。
- 子切换模型时 :128 只传 model 名解析 capability，不读该模型 DB overrides/baseUrl/provider；而主 :771-779 都读。
- 工厂 `llm-adapter/factory.ts:198` effectiveOptions 漏了 overrides.capabilities，现有 capability 参数并未真正传给普通 OpenAI adapter。这是另一确定 bug，本次 Anthropic 400 无须靠它解释。
- 新 child context 没有 modelName/modelCaps/utilityModel（:300-308）；图像能力判断 `file/utils.ts:88-92`、vision-proxy 模型路由 :50、ReAct 压缩窗口 :294 因此与实际模型不一致。
- 源码 factory :63 已优先识别 /anthropic；不要在没有 runtime 证据时将此次归咎于 DeepSeek/Anthropic 选错。

### 9. 取消只有一半链路生效

- 子创建独立 AbortController，联动父 signal、finally 清理监听/注册表，方向正确（:217-230,:442-444）。
- 但 AnthropicAdapter.stream (`anthropic.ts:309-366`) 没有把 options.signal 传 SDK，也没监听并中止 stream；cmd spawn (`cmd-tool.ts:118-128`) 只有 timeout，无 ctx.signal；MCP `client.ts:40,69,82` 只有独立 timeout。
- 因此停止可能只能等当前 LLM/命令/外部工具自己结束，再在循环边界感知；UI 不应在资源尚运行时宣称已完全停止。
- cancel registry key (`subagent-tool.ts:38-39`) 仅 sessionId+toolCallId；路由 `chat.ts:306-324` 不含 tenant，应补 tenant 所属校验。主 chat cancel 已从 authContext 获取 tenant，可沿用。
- ReAct 在共享 ctx 上改 currentToolCallId (:790,:804)，是结构风险。当前 subagent 被 registry 绕过池且 execute 在第一个 await 前同步捕获 ID，不能断言当前一定发生串号；应改调用级不可变 context 以免以后加 await/排队时触发。

### 10. 并发与持久化时机的问题

- `react.ts:811` 对整轮工具 Promise.all，`:852` 之后才持久化和发结束帧。快子任务完成后要等最慢兄弟任务，用户看到的完成延迟，进程中途退出时已完成的结果也可能尚未落父历史。
- `tool-registry/registry.ts:39-49` 子代理不占普通工具池，已正确避免“父 subagent 占满池导致内层工具永远排队”的死锁。应保留这个设计。
- 但子代理 LLM 并发没有独立上限/排队，模型输出几个 subagent 就开几个；普通工具全局池默认 8（concurrency-pool.ts:79-86）。池队列无 AbortSignal，取消后尚未开始的任务也不会移除。
- 全轮默认并发还包括写工具，缺乏只读/可并行工具标记；这是调度策略设计缺失，不应声称已经复现写冲突。
- 无后台任务、恢复、retries/attempts、deadline、run-level 状态表；当前仅同步等所有子任务结束，是能力边界。

### 11. 预算和用量含义混用

- 子 :307 获得父剩余 tokenBudget 数值的独立副本，父不会扣子消耗；N 个子可各自花同一额度。
- ReAct :503 仅扣 output tokens；该字段同时用于 history/context-window 限制，因此不能把它当完整费用上限。
- maxSteps :173/190 无 min/max 或运行时整数校验，ToolRegistry.execute 不校验 schema；需要服务端夹紧边界。
- 子累计 usage 只取 totalTokens（:374-376），没有 provider/model/input/output/cache 等分项，父总用量未聚合子用量。
- JSONL `getSessionUsage` (:595-608) 求 m.tokens（历史内容估算/输出 tokens），SQLite `history.ts:364-378` 求 usage 分项，两后端语义不一致。可回放账本应与上下文大小分开。

## 二、建议的最小稳定契约

1. **执行环境快照**：projectRoot、workingDirectory、workspaceRoots、resolvedModel（含能力/协议/内存凭证引用）、effectivePermissions、toolCatalog、deadline/limits。父转子显式继承，子配置只能收窄权限；切换模型重新解析模型配置。密钥/请求头不写 transcript。
2. **子任务实体**：runId、tenantId、parentSessionId、parentConversationId、parentToolCallId、childSessionId、task/title、modelId、createdAt/startedAt/finishedAt、status、stopReason、usage、resultSummary、error、transcriptRef、attempt。建议新增 subagent_runs 索引，JSONL 继续存 transcript；不把主会话列表当运行索引。
3. **终态枚举**：queued/running/completed/failed/cancelled/blocked/limit_reached/interrupted。completed 只由正常 final outcome 产生；异常、审批、步数、预算、断连均有独立 stopReason。
4. **事件与文本分离**：run/tool start、args、tool result、usage、status 等有 runId + seq；持久化后再广播。先保留现有主 SSE 适配器，将新 typed event 映射旧帧，减少前端与第三方协议迁移风险。
5. **父历史只存引用和摘要**：toolMsg.metadata.subagent 保存 runId/childSessionId/最终状态/摘要/usage。父 LLM 只读精简结果文本。展开详情用 runId 查子 transcript，实时和重启后读同一结构。
6. **主历史默认只列 root**：会话类型与父关系进入查询模型；isSidechain 正确写入但不能单靠扫描每行决定索引。现有 subagent-* 可兼容识别为 legacy child 并从主列表隐藏，无法可靠推断父关系的记录保留为 legacy orphan，不能乱挂到任意父会话。

## 三、分阶段实施与验收

### P0：恢复正确执行和基础可信度（范围可独立交付）

- 修 run(task)；收紧 MessageContent 类型，拒绝嵌套 Message[]，对合法文本/图片内容块保留兼容。
- 引入 typed run outcome 或子代理专用 throw-on-error 适配，完成/失败/取消/限额/blocked 不能由“输出是否为空”判断；暂不以正则匹配英文错误文案判状态。
- 主历史服务端隐藏 legacy subagent-*，新记录有 kind/parent 标识；不删除旧文件。
- 明确 projectRoot/workingDirectory 并用于 WorkspaceManager、cmd、project-context；多个 workspace 不要默默选错，显式 primary root。
- 子继承父 effective 权限和工具资源；调研角色默认只读工具集合，禁用 ask_user/subagent；需要审批返回 blocked(reason) 给父，不伪装完成。
- 接通 Anthropic signal 与命令进程取消；API tenant 作用域正确。

验收：真实两个子任务能完成最小只读任务；主历史仍只有一个父会话；停止一个不会停另一个，且实际请求被 abort；默认相对目录就是选定项目；主/子受同一安全边界约束。

### P1：可靠子任务与历史详情（解决截图完整体验）

- 建 subagent_runs + 父子关联；创建后先记 queued/running；每个工具结果/状态持久化，父 tool metadata 持引用。
- 去掉 meta 字符串作为唯一通道。保留一段兼容期能读旧 marker，新的实时和 replay 都使用同一 DTO。
- 独立发每个子任务完成事件，父聚合等待可以保留；不等所有兄弟结束才展示/保存快子任务。
- 展开卡展示：任务、模型、状态/原因、耗时、用量、工具参数/输出/错误、最终结论；file changes 关联回主任务，避免子写了文件而父完全不知。
- 引擎重启后 running/queued 明确变 interrupted（默认不自动重跑有副作用工具）；父/子删除与保留制定明确策略。

验收：重启后卡片与结束前信息一致；断流重连不重复工具/事件；崩溃时已经完成的子结果仍可查；快速子先显示完成，慢子继续运行。

### P2：并发、预算与可扩展能力

- subagent 专用池（例如默认 3-4，可配置），普通工具池独立；排队任务可取消。调用级 context 不共享 currentToolCallId。
- 将 context window、输出额度、总费用/用量上限、时间期限区分；父预算聚合或保留/释放，不能 N 倍无上限复制。
- 完成统一模型 resolver/credential reference，涵盖 DB/env/request、多协议/headers、不同 child 模型。
- 再决定是否支持 background、resume/follow-up、显式重试、代码修改隔离 worktree。它们不是修复当前错误必须同批上线的前提；引入后必须有持久状态和恢复语义。

## 四、必要测试（优先低成本契约测试，再真机 E2E）

| 测试 | 核心断言 |
|---|---|
| subagent 正常执行到真实 adapter 的离线契约 | Anthropic/OpenAI 捕获请求；task 完整，content schema 合法，无嵌套 Message[] |
| 子 LLM 400/网络失败/步数尽/预算尽/审批 | status 与 stopReason 准确，success=false；父能继续，不显示成功勾 |
| 父子列表与双后端 | root list 不含 child；child transcript 可按父 run 查询；JSONL/SQLite 一致 |
| 工作目录与项目上下文 | engine cwd 与 projectRoot 不同；相对读/写/命令定位项目；AE.md 不读错项目 |
| 权限和工具继承矩阵 | safe/standard/full-access、父工具白名单、只读 child、inline MCP/skills；子权限不扩大 |
| 模型矩阵 | 同模型继承请求端点/headers；切模型读 child caps；不得把父 thinking/vision 配置串给子 |
| 单子取消/父取消/排队取消 | 当前请求与进程确实终止，兄弟正常；queued 不执行；无残留 listeners/runs |
| 并发池与持久化 | 大于上限有 queued；无嵌套池死锁；快任务立即持久化并发完成事件 |
| 元数据 replay | 输出超长截断后，metadata/run reference 仍完整；重启不丢工具 args/output/status |
| 费用与上下文分离 | 父累计 usage 包含子且不重复；上下文 gauge 只算当前模型输入；双后端同语义 |
| 真机 IDE E2E | 发起两个子任务→一成功一失败→展开→切历史→重启回放；历史没有额外普通会话，卡片状态/详情不变 |

当前 `subagent-tool.test.ts:120-138` 仅非法 role execute，不走正常 LLM；`react.test.ts:324-343` 仅验证异常转错误文本。这正是需要增加跨 subagent/loop/adapter 契约测试的原因，不必为纯展示改动堆大量镜像测试。

## 五、实施注意

- 当前引擎有较多未提交改动，后续修复先记录已有差异，不覆盖它们；源码与 dist 曾观察到路由实现不同，验收必须明确实际加载的产物并 build。
- 原始日志、task/prompt、完整工具结果可能含敏感内容；普通列表/API 只暴露必要摘要，详情仍受 tenant/父任务授权约束。模型密钥始终只保留内存引用或受保护配置，不复制到事件表。
- 这份审计未修改引擎，也没有对真实 LLM 发起新请求。现有日志足以确认本次格式错误和历史污染；其他确定项是代码路径可证实的缺陷，未将未运行的风险当作已发生事故。
