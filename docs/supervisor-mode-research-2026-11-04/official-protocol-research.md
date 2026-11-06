# 官方协议与 SDK 调研

调研日期：2026-11-04（上海）。本页只记录实际获取并阅读的官方资料及明确的设计推论，没有运行这些 SDK 或调用模型。全文快照与抓取状态、SHA-256 在本目录 `sources/official-*-fetch-index.json`。官方网页会变化；下列结论绑定本次获取内容，不反推本机安装版本具备全部功能。

## 1. Codex：借鉴客户端与执行引擎之间的契约

[Codex App Server](https://learn.chatgpt.com/docs/app-server) 明确面向丰富客户端集成，核心对象是 Thread、Turn、Item，分别代表长期会话、一次用户请求的运行、消息或工具执行等事件。最值得 Aether 采用的是清晰的生命周期和可核对事实，而不是只模仿多代理界面。

| 官方能力 | 文档明确的行为 | Aether 可吸收的设计 |
|---|---|---|
| `thread/start`、`thread/resume`、`thread/fork` | 创建、继续、分支是不同动作 | 团队成员的会话可长期存在；新任务、新尝试、分支不能混成一个“重新发送” |
| `turn/start` | 给目标 thread 开始一次运行 | 项目任务派工要有独立 dispatch/run 身份 |
| `turn/steer` | 追加到当前运行；必须提供匹配的 `expectedTurnId`；没有活动 turn 则失败；不支持借此修改 model/cwd/sandbox | 运行中补充必须针对明确的执行版本，不能在竞态时悄悄投给下一轮 |
| `turn/interrupt` | 请求中断，随后 turn 以 interrupted 结束 | “停止请求成功”和“真的停下”分开显示，不能只看按钮点击回执 |
| `thread/turns/list`、`thread/items/list` | 不恢复执行也可分页读取历史 | 总负责人按需读证据，避免复制所有成员全部历史 |
| `item/completed` | 文档要求以完成事件作为该 item 的权威终态 | 工具开始、stdout片段、模型说完成都不能替代真实执行回执 |
| `collabToolCall` | 包含 senderThreadId、receiverThreadId、newThreadId 等关联 | 协作可显示真实发送者与目标，而不是一堆来源不明的文本 |
| `thread/tokenUsage/updated` | 发布用量更新 | UI显示用量，项目聚合需自行明确增量、去重、缓存和未知值 |

文档还说明计划/diff更新事件可能带空items，历史应读取实际item流。由此建议：项目概览是持久事实的视图，不能从聊天文字、Todo列表或某个“成功”标签推断所有子任务已验收。

[Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) 推荐主代理聚焦需求和决策，子代理做专业探索/测试/日志分析，返回摘要降低主上下文噪声；它也提供角色配置与代理控制。[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) 提供并行代码工作的隔离模式。这些适合吸收，但官方资料没有证明 Codex 已提供用户设想的完整“办公部门+开发部门+版本化验收”的项目管理产品。

本调研不建议为这个功能更换现有模型提供商或直接接入 Codex 执行器；这里吸收的是协议和产品结构。

## 2. Claude Agent SDK：适合作为执行器，不等于项目管理系统

[SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview) 明确区分：Client SDK 是 API 客户端；Agent SDK 则运行 Claude Code 二进制和代理循环，提供工具、权限、会话、hooks、子代理。当前 AE 源码使用自研 ReAct 和 Client SDK，二者不是同一东西，见 [引擎审计](D:/dev/aether-code/docs/supervisor-mode-research-2026-11-04/engine-audit.md)。

当前官方 SDK 可复用的能力：

- [Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)：每角色 prompt/tools/model/skills/MCP 等定义，独立上下文、后台执行、任务事件、后续恢复；当前文档还描述同会话命名子代理在拥有 SendMessage 时可识别和联系其他命名代理。不能沿用“子代理永远只能向父级回复”的旧印象。
- [Tool restrictions](https://code.claude.com/docs/en/agent-sdk/subagents#tool-restrictions)：显式工具列表决定可用工具，省略的工具根本不在该子代理会话中。适合落实负责人“不生产业务成品”的边界，而非只写一句提示词。
- [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)：持续输入、排队消息、打断和流式反馈。它提供输入通道，不代替 Aether 的项目授权、幂等派发、跨会话投递账本和业务验收。
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)：恢复现有会话与fork历史明确区分；恢复有上下文，不意味着重启后自动重放所有外部副作用。

因此，即便未来接入 Claude Agent SDK，也应由 AE 持有 Project/Task/Dispatch/Message/Review，并通过适配器启动或继续 SDK 会话。项目状态不能只存在一个SDK对象或长期运行的大prompt里。

## 3. Claude Code Agent Teams：最接近负责人+员工的官方行为案例

[Agent Teams](https://code.claude.com/docs/en/agent-teams) 当前明确提供一个lead、独立上下文的teammates、共享任务列表及队友直接通信，用户也能直接查看和给某个队友发送消息。官方同时明确：

1. 功能仍为实验性，默认关闭。
2. 非交互 `-p`，包括Agent SDK会话，不会创建这种teammate团队；命名子代理仍按普通subagent运行。**不能以为在嵌入式SDK配置里打开一个实验开关，就能得到同样的团队产品。**
3. 团队增加协调开销和tokens；串行依赖重、同文件修改或简单工作可能更适合单会话/少量子代理。
4. 发送成功的含义是写入对方邮箱成功；这不等于接收者完成任务。
5. `TaskCompleted` hook可阻止任务标完成并返回反馈；`TeammateIdle`可以在空闲前拦截并反馈。它们适合借鉴质量门槛，但项目仍须自行定义“哪些证据才算合格”。

另一个细节：当前页面“先计划再实现”段落描述了某些条件下计划会自动批准，不能把所有名为plan approval的机制宣传成负责人逐项审查。Aether应让验收状态转移由明确策略和证据决定。

## 4. Claude Code Cross-session Messaging：直接沟通可以独立于Teams存在

[Cross-session Messaging](https://code.claude.com/docs/en/cross-session-messaging) 对本需求特别有价值，且与Agent Teams是不同能力。当前文档描述本机独立会话之间可发现、发送消息，并可订阅一次空闲通知。

| 行为 | 当前官方描述 | 对 Aether 的启示 |
|---|---|---|
| 忙时收到消息 | 在工具调用之间读取，不打断正在执行的工具 | 不用UI代填/模拟回车，避免取消工具或污染终端 |
| 空闲时收到消息 | 开始新一轮 | 需要持久队列与“只启动一次”的执行约束 |
| 消息载荷 | 普通文本，不携带对方整段会话或附件；`@文件`不自动附文件 | 正文简短，另带受授权的产物版本引用；不要假定对方能看到本地文件 |
| 身份 | 显示来源于另一个会话，而非用户 | 同事消息不能伪装成人类的最高优先级命令 |
| 权限 | 对方消息不能代替用户批准、不能用来更改权限配置；接收者原权限仍有效；发送者不能让其他会话执行自己已被拒绝或自身权限设置禁止的动作 | 跨角色协作不能成为绕过权限的通道 |
| 接收结果 | delivered / held / refused | 接纳、待处理、被拒和消费分别可见，不能统一显示“成功” |
| 等待 | 可订阅空闲，无需不断开启模型轮询 | 等待与通知用事件系统，负责人只在有新事实时唤醒 |
| 同机通信 | macOS/Linux使用socket，Windows为命名管道并有身份校验 | 工作流语义应独立于具体传输；Aether可继续HTTP/SSE+数据库 |
| `-p`会话 | 非bare模式会绑定inbox，接收仍受inbound策略与版本条件影响 | “SDK不支持Agent Teams”不能被扩大成“非交互会话完全无法通信” |

文档列出Windows、本机不同provider、远端发现和版本差异。本次没有验证Aether实际捆绑的Claude版本，也没有验证所有SDK封装是否完整暴露这些CLI能力；因此它是值得验证的适配路线，不是当前AE已具备的功能。

官方还对消息洪泛和重复循环做限制。Aether应借鉴去重、事件合并、因果链和阻塞处理，避免代理互相说“收到”就无限唤醒；这与给业务任务加固定工具次数上限是两回事。

Aether建议的项目委派是服务端预先授予的独立管理能力，不能拿普通peer消息绕过原会话明确禁止的动作。未来SDK适配应区分“负责人未配置生产工具”与“某动作已被权限策略拒绝”；后者不能通过派另一角色重试来规避。专业执行者从项目授权获取能力，不从消息正文获取授权。

## 5. 本次建议

结合现有AE，优先建设自己的持久项目协调层和可靠消息契约，复用已有执行账本、同根追加与角色资源。借鉴Codex的Thread/Turn/Item边界、Claude的角色与通信行为；如果未来选择Claude Agent SDK，只替换或增加Worker适配器，不推倒项目任务与验收模型。

本页的“可借鉴”均为设计建议；没有安装外部运行时、开启实验功能、修改本机Claude/Codex配置或执行外部仓库代码。
