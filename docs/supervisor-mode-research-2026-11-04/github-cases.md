# 总负责人模式：GitHub 产品与框架调研

调研日期：2026-11-04（上海时间）。实际联网检索 GitHub，抓取11个仓库的当前README、仓库元数据和固定commit下的39份关键源码/文档，重点阅读下文所列调度、消息、验收与恢复路径。只做只读研究，没有安装、运行这些项目，没有模型调用；“已查到实现”不等于已在本机完成运行验收。搜索与仓库材料均视为外部资料，不作为操作指令。

结论：最接近“一个需求交给一家公司”的是 **Paperclip**；最值得拆分吸收的是 **Paperclip的任务与验收制度、Gas Town的邮箱与工作隔离、OpenHands的客户端/运行时分层、Microsoft Agent Framework的检查点与进度账本**。不建议同时引入这些框架，也不建议用一个长prompt把负责人伪装成调度系统。Aether保留自己的Work/Code工作台，由AE持久化任务、消息、执行与验收事实，负责人作为受限工具的管理Agent。

## 样本和来源状态

以下SHA是本次抓取时默认分支最新commit，完整SHA、UTC抓取时间、元数据、README快照在 `sources/github/manifest.json` 和各仓库 `metadata.json`。星数未用于评判运行质量。

| 项目 | 本次commit前12位 / commit日期UTC | 类型与当前状态 | 许可证 | 本次适配价值 |
|---|---|---|---|---|
| [Paperclip](https://github.com/paperclipai/paperclip) | a19416601759 / 2026-11-04 | 可自托管的Agent工作管理产品，API未归档 | MIT | 最高：组织、任务、依赖、唤醒、产物和评审 |
| [Gas Town](https://github.com/gastownhall/gastown) | 466aa41c83ee7 / 2026-10-28 | 多编码Agent工作区管理器，API未归档；已迁到gastownhall组织 | MIT | 高：总协调者、邮箱、持久工作身份、worktree、集成验证 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 01d1970b8f96 / 2026-11-03 | 当前为Agent Canvas控制中心，API未归档 | MIT | 高：前台与Agent Server/SDK分层、多后端与会话工作区 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | dc6617aa96f2 / 2026-11-03 | .NET/Python工作流框架，API未归档 | MIT | 高：任务/进度账本、检查点、人介入与恢复 |
| [Magentic-UI / MagenticLite](https://github.com/microsoft/magentic-ui) | d3c9d13c3928 / 2026-07-23 | 当前主分支为MagenticLite应用；旧0.1独立分支 | MIT | 中高：执行中用户介入、子Agent介入回传、可见验证证据 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | dd21ecce11aa / 2026-11-03 | Python多Agent框架，API未归档 | MIT | 中：manager按能力委派、同事问答、当前版本已有checkpoint |
| [ChatDev 2.0 / DevAll](https://github.com/OpenBMB/ChatDev) | 464a681ba7bd / 2026-10-30 | 当前为可配置多Agent工作流平台；旧虚拟软件公司在chatdev1.0分支 | Apache-2.0 | 中：角色模板、DAG/并行层、工作流可视配置 |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 11cdf466d042 / 2026-01-21 | 软件公司SOP研究框架，API未归档；本次最新commit较早 | MIT | 中：产品/架构/项目管理/工程文档契约，不等于成熟交付保证 |
| [LangGraph Swarm](https://github.com/langchain-ai/langgraph-swarm-py) | 8956b138bbb4 / 2026-10-28 | 小型handoff库，API未归档 | MIT | 中：控制权转交语义；不是并行团队消息总线 |
| [LangGraph Supervisor](https://github.com/langchain-ai/langgraph-supervisor-py) | 88859b34017a / 2026-07-15 | GitHub API明确archived=true；README建议直接工具调用模式 | MIT | 只吸收模式，不推荐新产品依赖该归档包 |
| [AutoGen](https://github.com/microsoft/autogen) | d07c667a3239 / 2026-10-28 | API archived=false，但README明确已归档、无维护，推荐MAF | 代码MIT；根LICENSE为CC-BY-4.0文档许可 | 历史参考；不能按旧资料当作当前首选框架 |

许可证通过GitHub元数据核对；AutoGen另读 `LICENSE-CODE` 与根 `LICENSE`，避免把元数据的CC-BY-4.0误报成代码许可。对其他项目未审计所有子目录/依赖许可，实际移植具体代码仍应随文件检查。商业产品/云服务功能不自动等于上述仓库开源实现。

## 1. Paperclip：最接近整体产品目标

其核心是Agent工作管理的控制层，不替代Agent推理引擎。README已把身份、任务、heartbeat执行、审批、工作区、预算拆为不同子系统；Agent可由Claude Code、Codex、CLI或HTTP适配器驱动。它很适合回答“负责人界面在哪、调度事实存在哪”。

本次重点核查了以下真实实现，而非仅引用“AI公司”宣传：

- **任务是稳定实体，运行是某次尝试。** Issue关联company/project/goal/parent、负责人和执行策略，支持blocker依赖；checkout原子领取，另一个Agent占有时409，崩溃后可按运行是否活跃重领。不能用聊天标题或模型的todo段落代替。
- **事件唤醒可持久化。** `agent_wakeup_requests`有source/reason/payload、queued状态、claimedAt/finishedAt、coalescedCount、idempotencyKey、runId，若干递送类别具有数据库唯一索引。对Aether最有价值的是“消息先落盘再递送、重启后仍能继续”，不是定时重复问Agent进展。
- **验收绑定当前成果。** `required-quality-review.ts`校验文档latestRevisionId或附件assetId+sha256，发现旧版本批准会标stale；`done`前有服务端门槛。计划文档、模型口头说通过、文件存在均不能替代已配置的成果验收。该quality review是opt-in，不应机械变成每次计划都问用户确认。
- **独立验收者是规则。** interactions支持anyone/not_creator/human_only；被点名的addressee只能由本人或用户响应。若需求要求独立评审，创建者不能给自己通过。Aether可按任务风险区分机械校验、独立Agent验收和用户验收。
- **有明确写入回执。** PATCH可以返回实际变化from/to，no-op不报成变化；可用`Prefer: return=minimal`缩小回执。与用户重视token成本一致。

**直接跨Agent输入的边界必须说准确：** 当前issues API明确“Agent @提及只作上下文，不触发heartbeat”；普通评论反馈可唤醒当前assignee；请另一个Agent行动，应显式assignment/review request，或使用带`addresseeAgentId`的interaction。不能照搬旧版“@谁就自动唤醒谁”的假设，也不能把所有评论都变成新模型请求。

成本控制支持记录用量、分维度聚合、警告和暂停，但README承认依赖已上报花费，在途请求/上报延迟可导致滞后，不能宣称绝对不超支。Aether应借鉴可观测/配置化成本治理，不恢复用户已要求移除的任意工具次数硬上限。

**不整体搬入的原因：** 该产品包含完整公司级权限、Postgres/组织/插件/外部渠道，远大于Aether本机工作台需要；整体引入将制造第二套任务、会话、权限与存储。优先移植数据契约与状态机思想，再与AE现有实现对接。

主要固定版本证据：

- [README架构](https://github.com/paperclipai/paperclip/blob/a194166017597860a0e53c0c1314e95c597d75cc/README.md#whats-under-the-hood)
- [Issues API：领取、评论、评审、文档版本](https://github.com/paperclipai/paperclip/blob/a194166017597860a0e53c0c1314e95c597d75cc/docs/api/issues.md)
- [质量验收服务](https://github.com/paperclipai/paperclip/blob/a194166017597860a0e53c0c1314e95c597d75cc/server/src/services/required-quality-review.ts)
- [唤醒请求数据库结构](https://github.com/paperclipai/paperclip/blob/a194166017597860a0e53c0c1314e95c597d75cc/packages/db/src/schema/agent_wakeup_requests.ts)
- [Heartbeat协议：长期子任务完成唤醒父任务、避免轮询](https://github.com/paperclipai/paperclip/blob/a194166017597860a0e53c0c1314e95c597d75cc/docs/guides/agent-developer/heartbeat-protocol.md)

## 2. Gas Town：负责人、邮箱、文件隔离与集成验收

Mayor是用户的总协调入口；worker有持久身份、短生命周期会话。Witness负责卡住/崩溃恢复，Refinery负责合并队列和验证门槛。这种分工说明“安排任务”“执行任务”“判断能否集成”应有不同权力，而不必真的给每个小需求启动一整套虚拟公司。

关键代码事实：

- `internal/mail/types.go`区分task、escalation、notification、reply；有from/to、thread_id/reply_to、priority、queue/interrupt，以及pending/acked递送状态。
- `internal/nudge/queue.go`把追加消息写进队列，在自然回合边界取出；源码说明直接向tmux输入可能取消在途工具。队列有TTL、深度和遗留claim处理——这些是传输/防拥塞规则，不能混作Agent可工作的总轮数。
- mail-protocol把POLECAT_DONE、MERGE_READY、MERGED、MERGE_FAILED、REWORK_REQUEST区分为独立事件。开发说“完成”不意味着已通过集成；失败应回到明确的返工路径。
- worktree/git-backed hooks保存工作，与Agent会话生命周期分开。它主要解决代码协作，不是Word/Excel多人同时修改同一二进制文件的自动合并方案。

对Aether的直接启发：Work可以向Code会话发“需求变更/澄清/验收反馈”，Code可以向Work发“解释问题/请求资料/提交验收”；每条消息应带来源和任务绑定，并能显示已入队、已投递、已消费、已答复。不要用“自动点开另一个会话并在输入框代填”实现，也不要让peer消息冒充用户最高优先级指令。

不建议照搬tmux/CLI管理和大量拟人角色术语；Aether已有Electron、AE、办公预览，把这些概念直接映射到后台协议更合适。

证据：[README](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/README.md)、[mail types](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/internal/mail/types.go)、[nudge队列](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/internal/nudge/queue.go)、[邮件协议](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/docs/design/mail-protocol.md)。

## 3. OpenHands Agent Canvas：前台与引擎分层的现实案例

当前README已将项目描述为常驻工程团队的开发者控制中心，支持不同Agent后端。不能仍按早期单一聊天编程助手介绍。

它明确划分：

| 部分 | 职责 |
|---|---|
| OpenHands/OpenHands | Canvas前端、用户控制中心、后端选择、本地启动编排 |
| OpenHands/software-agent-sdk | Python SDK、Agent Server、agents/tools/conversations/workspaces/events、规范API |
| OpenHands/typescript-client | 浏览器可用的TypeScript客户端 |
| automation service | 决定何时运行，并把会话分发给Agent Server/SDK |

因此Aether加管理视图并不代表调度只需写在React里。前台负责让用户理解/控制任务；关闭或切换视图后仍应由运行时处理消息、任务归属、取消及恢复。

README特别声明：每个conversation可以有独立Docker sandbox和持久state，但使用同一个host workspace的会话依然共享文件，需要独立目录/worktree避免冲突。Aether也必须把“两个会话”与“两个可安全并行写入的工作区”分开。

本次读取了Canvas发送消息与plan/build UI源码作为分层交叉检查，未完整审计其独立software-agent-sdk仓库，故不推断它已实现本需求的全部角色与原生跨会话邮箱。其主要适配价值是专业Code执行端和客户端/运行时边界，不能拿来替换成熟的本地办公预览。

证据：[当前README与仓库职责表](https://github.com/OpenHands/OpenHands/blob/01d1970b8f96d576d8b42aad48fee5aa117f1cb8/README.md)、[发送消息hook](https://github.com/OpenHands/OpenHands/blob/01d1970b8f96d576d8b42aad48fee5aa117f1cb8/src/hooks/use-send-message.ts)。

## 4. Microsoft Agent Framework：进度判断与可恢复流程

MAF提供sequential/concurrent/handoff/group workflow、checkpoint、streaming及人介入，不是完整的办公开发产品。它对AE的价值在调度机制而非替换客户端。

`_magentic.py`包含任务账本和进度账本，字段包括 `is_request_satisfied`、`is_in_loop`、`is_progress_being_made`、`next_speaker`、`instruction_or_question`，以及stall_count。负责人应关注“是否出现新的有效证据、是否在同一错误上循环”，而不是不断复述下属消息。

`WorkflowCheckpoint`包含执行器状态、消息/边递送的已提交状态、待响应的人介入事件；官方sample展示用户离线时退出，重启后恢复并重新发出待回答请求。Aether可借鉴：运行结束不等于任务完成；等待用户/等待同事不应白白占模型循环；恢复时不能重复发已执行的命令。检查点本身不能替代外部副作用幂等与回执核对。

本次不建议把.NET/Python工作流引擎塞入已有TypeScript AE；优先采纳状态设计及测试思路。

证据：[README](https://github.com/microsoft/agent-framework/blob/dc6617aa96f26407cfbb2486941e8c3b069cfbe6/README.md)、[Magentic账本](https://github.com/microsoft/agent-framework/blob/dc6617aa96f26407cfbb2486941e8c3b069cfbe6/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py)、[checkpoint定义](https://github.com/microsoft/agent-framework/blob/dc6617aa96f26407cfbb2486941e8c3b069cfbe6/python/packages/core/agent_framework/_workflows/_checkpoint.py)、[人工审阅后恢复sample](https://github.com/microsoft/agent-framework/blob/dc6617aa96f26407cfbb2486941e8c3b069cfbe6/python/samples/03-workflows/checkpoint/checkpoint_with_human_in_the_loop.py)。

## 5. MagenticLite：用户中途介入，不能被负责人旧计划覆盖

当前microsoft/magentic-ui主分支已为MagenticLite，README称其采用小模型编排与Fara浏览器模型；旧Magentic-UI 0.1另有分支。本次不把旧版多Agent演示当作主分支事实。

实际 `_user_interjection.py`区分“用户直接给主Agent的运行中消息”和“用户直接给子Agent的消息”；后者向主Agent明确子Agent已经据此行动，负责人不能再照旧计划覆盖用户的新要求。这一细节非常适合Aether：用户直接进入Work/Code会话追加要求后，管理层必须收到带来源的变更事件，更新任务计划，不能等会话结束才看总结。

`_verifier.py`对部分破坏性shell命令提供前后文件状态证据，明确哪些复杂命令无法解析并跳过。值得吸收的是“验证说清范围”的方式，不是声称任何命令都可自动全面验证。

证据：[当前README](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/README.md)、[用户介入包装](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/src/magentic_ui/teams/omniagent/_user_interjection.py)、[有明确边界的验证器](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/src/magentic_ui/teams/omniagent/_verifier.py)。

## 其他案例：吸收模式，避免错误选型

**CrewAI。** Hierarchical模式由manager根据角色/能力分配并检查结果；实际有 `DelegateWorkTool(task, context, coworker)` 与 `AskQuestionTool(question, context, coworker)`，与本需求的“分任务”和“向同事澄清”相符。当前源码也已有Crew.from_checkpoint/fork，不应套用“完全无恢复”的旧印象。但工具函数调用/框架checkpoint不自动等于Aether跨根会话的持久消息收件箱、UI状态和独立成果门槛。可参考职责和context最小化，暂不整体引入Python runtime。[hierarchical文档](https://github.com/crewAIInc/crewAI/blob/dd21ecce11aa008d5ef0325e6802a3962ce4d443/docs/edge/en/learn/hierarchical-process.mdx)、[delegate](https://github.com/crewAIInc/crewAI/blob/dd21ecce11aa008d5ef0325e6802a3962ce4d443/lib/crewai/src/crewai/tools/agent_tools/delegate_work_tool.py)、[ask](https://github.com/crewAIInc/crewAI/blob/dd21ecce11aa008d5ef0325e6802a3962ce4d443/lib/crewai/src/crewai/tools/agent_tools/ask_question_tool.py)。

**ChatDev 2.0 / DevAll。** 当前不是仅限虚拟软件公司的ChatDev1；支持自定义Agent/workflow，例子有需求拆解、技术实现、信息检索、审核和唯一总结出口。DAGExecutor明确按拓扑层执行、层内并行、Human节点串行。可借角色模板、依赖图和可视运行记录；不应照搬固定“所有部门都开会”流程，也不能由角色prompt推出隔离/交付质量已成立。本次未验证其崩溃恢复、外部副作用幂等、办公格式预览。[README](https://github.com/OpenBMB/ChatDev/blob/464a681ba7bda869db97a50c5fa707c9a0fb57a0/README.md)、[角色工作流样例](https://github.com/OpenBMB/ChatDev/blob/464a681ba7bda869db97a50c5fa707c9a0fb57a0/yaml_instance/general_problem_solving_team.yaml)、[DAG执行](https://github.com/OpenBMB/ChatDev/blob/464a681ba7bda869db97a50c5fa707c9a0fb57a0/workflow/executor/dag_executor.py)。

**MetaGPT。** README的SOP包括产品经理/架构师/项目经理/工程师；Team支持角色聘用、序列化恢复与成本检查；Environment按收件地址投递消息，再并发运行角色。可借“需求→设计→任务→代码→审查”输入/输出契约。SOP与角色名称并不能保证成果正确，不能拿论文/演示成功代替本产品验收。[Team](https://github.com/FoundationAgents/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/team.py)、[Environment消息分发](https://github.com/FoundationAgents/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/environment/base_env.py)。

**LangGraph supervisor/swarm。** Supervisor仓库已归档，README当前建议直接工具调用实现supervisor模式以便控制context。Swarm的handoff源码通过`Command(goto=agent, graph=PARENT)`切换active_agent，默认把当前完整messages交给下一位。它是控制权交接，不是“Work和Code并行工作并互发消息”；整段历史传来传去还可能显著增加tokens。可借图状态和自定义handoff输入，不建议将全历史handoff直接用作跨会话通讯。[Supervisor当前建议](https://github.com/langchain-ai/langgraph-supervisor-py/blob/88859b34017ac3569bbd4a3092c7e77593a0a960/README.md)、[Swarm handoff源码](https://github.com/langchain-ai/langgraph-swarm-py/blob/8956b138bbb475b00c98d040176dbb8da667c612/langgraph_swarm/handoff.py)。

**AutoGen。** API archived字段与README叙述不同，报告如实保留：API为false，但固定commit README明确已停止维护/支持、建议新用户从MAF开始。适合历史研究，不作为新引擎依赖推荐。不能仅因当前仍可拉取源码或最近有提交，就写成活跃维护。[README](https://github.com/microsoft/autogen/blob/d07c667a3239ea4ab7af62a53b0f4ff205a1f23d/README.md)、[代码MIT许可](https://github.com/microsoft/autogen/blob/d07c667a3239ea4ab7af62a53b0f4ff205a1f23d/LICENSE-CODE)。

## 给Aether的吸收清单

| 要解决的问题 | 首选参考 | 建议采纳的设计 | 不应照搬的部分 |
|---|---|---|---|
| 用户一个需求形成团队工作 | Paperclip、CrewAI | 稳定任务、角色能力、负责人、依赖和成果约定；简单需求只派一个执行者 | 固定把所有“公司岗位”都唤醒 |
| 两个模式直接交流 | Gas Town、Paperclip | 带来源/任务/回复关联的持久消息、显式唤醒和消费回执 | UI代填输入框、任意@即新模型调用、peer伪装user |
| 用户途中改变下属方向 | MagenticLite | 下属执行新要求时通知负责人，保留用户优先级和受影响任务版本 | 负责人按旧计划把下属改回去 |
| 客户端关闭后还可恢复 | OpenHands、MAF | 前台显示与持久调度分离，检查点恢复等待状态 | 把唯一任务状态放React内存或仅放模型上下文 |
| 多Code Agent同时改项目 | Gas Town、OpenHands | 独立worktree/目录、明确合并者与测试门槛 | 多会话共一目录就宣称隔离；自动合并Office二进制 |
| 不再靠模型自报“验收通过” | Paperclip | 绑定需求版本、产物revision/hash、实际测试回执；独立评审者 | 文件存在或最终回复含“完成”就关任务 |
| 成本/循环控制 | Paperclip、MAF | 事件唤醒、摘要与按需读全文、重复失败识别、可配置用户预算 | 持续轮询所有Agent；任意轮次上限；把压缩当成推理纠错 |

最小落地时可以只保留“负责人、执行者、验收者”三种职责。Work/Code是工具与工作台能力profile，产品经理/研究员/文档作者/测试工程师是角色模板，两者不应混成同一个mode枚举。负责人不写业务产物，但必须能读取任务与成果、提出澄清、分派/变更/暂停任务、请求独立验收；这些权限应由引擎工具白名单保证，而不是仅靠prompt说“不要写代码”。

本报告的架构建议是研究推导；具体AE可复用的服务、schema与端点，以本次引擎/客户端源码审计报告为准。

## 本地证据索引

- `sources/github/manifest.json`：11仓库、完整commit、commit时间、API归档字段、许可、README大小。
- `sources/github/<owner>__<repo>/metadata.json`：原始GitHub仓库元数据及抓取时间。
- 同目录 `README.snapshot.md`：固定commit README；`tree.json`为10个仓库完整目录树，本次均truncated=false。
- `sources/github/file-manifest.json`：39份关键文件的固定raw URL与大小；同目录`files/`保存实际内容。
- 抓取脚本仅执行HTTP只读请求，不执行下载的项目代码。没有把本次调研作为功能性能或安全完整性实测。
