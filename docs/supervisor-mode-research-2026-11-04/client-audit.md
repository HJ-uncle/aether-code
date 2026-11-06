# Aether 总负责人模式：客户端现状与职责调研

调研日期：2026-11-04（上海）。范围为当前 `D:\dev\aether-code` 源码的只读审阅；仅新增本研究文件，没有启动 Electron、调用模型、修改配置或实现功能。当前 HEAD：`a41993dcb68c8d1b826fc6ce3c2758544a104f47`，开始审阅时工作树干净。此前对话里提到的 `docs/cooperative-acceptance-2026-11-03` 不在本次当前源码树，不能用旧对话里的测试结果替代此版本的实测。本报告中的“已有”表示源码路径成立，不表示本轮执行过端到端验证。

## 核心判断

可以在 Aether 提供“总负责人”统一入口，现有 Work/Code 保留为两种专业执行工作台。建议把它做成“项目管理与交付层”，而非把现有 Work 换名，或再建一个仅靠提示词指挥的聊天窗口。

客户端已具备角色配置、子代理观测、同一根任务中的运行时追加、主任务取消、历史恢复、办公预览和文件变更入口。**缺的是项目级任务模型、跨独立会话的可靠通信、依赖调度与验收状态机。** 这些不能由新增按钮和 React 状态可靠实现，引擎或独立持久编排服务必须参与。可以在 AE 内分出编排模块，不必把所有逻辑塞进 LLM 循环。

总负责人“不做业务产出”应落实为权限边界：它能读需求、读状态和证据、分配/撤回任务、提出验收结论；业务代码和办公正文由执行者生产。它仍需要阅读与核验能力，否则只能转述下属自报，无法承担验收。

## 已有能力与实际边界

| 能力 | 当前实现 | 对总负责人模式的价值与边界 |
|---|---|---|
| Work/Code 两工作台 | `AppMode = 'code' \| 'work'`；两个 ModeSurface 常驻，隐藏层 inert | 可保留专业工作台和文件缓存；尚无第三个管理入口。视觉模式不应继续充当执行身份 |
| Work 任务 | `WorkTask.id` 直接用于 `/chat` 的 sessionId，含角色、模型、工作目录、资料和状态 | 这是“会话任务”，不是带依赖/交付标准的项目工作包 |
| Work 项目页 | 按任务的 workspacePath 分组，文案也声明后续接项目指令和团队共享 | 没有独立 Project ID、目标/成员/依赖/验收定义；同目录不能代表同项目授权范围 |
| 自定义 Agent | `/agents` 列表、创建、编辑、删除；systemPrompt/model/temperature/skills/MCP/知识库/allowedTools | 足够构成角色模板编辑器；角色模板不是运行实例、会话或任务，不能混用身份 |
| 角色委派 | 用户选中的 Agent mention chip 形成 `collaborators: [{agentId}]` | 已有显式委派入口；手打 `@` 或粘贴元数据不会自动变成委派，未来调度接口也不能靠伪造文本 |
| 子代理目录与历史 | `/subagent/discovery`、run summary、事件、工具分页、详细工具结果、transcript | 可作为员工工作记录面板；当前归属以root/parent/child会话树为中心 |
| 子代理停止与继续 | 当前run取消；已完成子代理通过父会话 `/chat` + `resumeRunId` 继续 | 活动子代理可追加；完成后的继续不是自由向任意会话发消息，仍要求父任务正确且空闲 |
| 当前主任务/子代理追加 | capability协商、精确rootRun/rootAttempt/session/recipient、requestKey、持久待核对文本、同键重试 | 已有可靠投递基础；`queued`只表示接纳，不表示已消费，更不是业务完成；没有证明跨两个独立root任意互投 |
| Work 下一轮队列 | Electron主进程持久owner，冻结请求后dispatch；引擎admission context/receipt去重、核对 | 已经不依赖当前React面板；但scope owner固定work、profile固定general，是同任务后继消息队列，不是项目DAG调度器 |
| Code 下一轮队列 | `useChat` 内按session分组、合并/编辑/移动队列 | 跟Work主进程队列的持久机制不同；总控应统一调度语义，不能假定两者已同等可靠 |
| 任务清单 | EngineTodo只有id/title/description/status/priority/dueAt；TodoTray只读 | 有会话计划展示，尚无owner、dependsOn、验收标准、证据或项目级状态 |
| 文件与成果 | workArtifacts从工具回执/命令变化推导；ready的显示文案是“已写入” | 这是写入证据，不等于内容验收；应保留此区分，新增“已验收”必须另有依据 |
| 文件回滚 | `/changes/revert-batch`，精确turn/message标识，冲突结果逐项展示 | 可提供管理页的变更审阅入口；不等于项目整体可原子回滚或撤销外部系统副作用 |
| 工作台能力桥 | 注册会话拥有的context/open/terminal.read；后台模式保留连接，隐藏预览返回deferred | 为视图跳转、文件检查复用；每个挂载模式当前只登记其选中session，不能宣称所有并行员工都有可见预览环境 |

主要源码定位：

- [模式定义与快捷键边界](D:/dev/aether-code/src/renderer/src/core/platform/app-mode.ts:3)、[常驻工作台](D:/dev/aether-code/src/renderer/src/workbench/Workbench.tsx:93)、[隐藏层处理](D:/dev/aether-code/src/renderer/src/workbench/ModeSurface.tsx:4)。
- [WorkTask/WorkState](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:9)、[本地状态保存](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:264)、[任务创建](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:540)、[Work项目按目录分组](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:3064)。
- [Agent资源模型](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:13)、[角色写入API](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:472)、[显式Agent委派](D:/dev/aether-code/src/renderer/src/contrib/chat/agent-references.ts:24)。
- [子代理身份契约](D:/dev/aether-code/src/shared/subagent.ts:39)、[子代理API](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:195)、[完成后继续](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:862)、[活动子代理追加/停止入口](D:/dev/aether-code/src/renderer/src/contrib/work/WorkSubagentsPanel.tsx:289)。
- [运行中追加契约](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-contract.ts:12)、[发送和核对](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:80)、[接纳与消费区分](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-inspection.ts:72)。
- [Work主进程队列owner](D:/dev/aether-code/src/main/next-turn-dispatcher.ts:19)、[默认磁盘/可选SQLite配置](D:/dev/aether-code/src/main/work-next-turn-ipc.ts:13)、[队列引擎接入](D:/dev/aether-code/src/main/next-turn-engine-gateway.ts:60)、[Code会话队列](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:603)。
- [Todo契约](D:/dev/aether-code/src/shared/ipc.ts:608)、[成果写入状态](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:334)、[回滚结果与冲突](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:119)、[工作台会话桥](D:/dev/aether-code/src/renderer/src/core/workbench/client.ts:140)。

## 两个容易误判的地方

第一，已有的 Agent 配置、子代理、Work 任务、Code 会话是不同对象。Agent定义是可复用配置；session是长期对话上下文；run/attempt是一次执行；task应是承诺一个交付物的工作包；project应是用户的总体目标。把它们都叫“Agent”会让任务重试、换模型、换负责人和引用历史再次混乱。

第二，`done` 不等于验收通过。当前 [workStatus](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:323) 从最后助手状态导出done；[workArtifacts](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:334) 从写入/命令回执导出ready。因此新管理层必须展示“执行完成，待验收”，不能把现有done直接换成绿色“已交付”。“全部Todo完成”同理。

## 建议的客户端结构

把用户提出的三块保留为三种职责，但默认不要同时铺满三套聊天记录。

1. **总览/管理与验收**：默认入口。中部只显示总目标、当前阶段、阻塞、待验收成果；底部一条总负责人输入框。它接收新的目标、变更和验收反馈。
2. **Work 执行视图**：按当前项目列出产品、研究、设计、文档、审阅等成员。打开某成员就是其真实会话与资料/预览，不是复制到新聊天。允许直接追加给某角色，并清晰显示收件人。
3. **Code 执行视图**：聚焦项目、代码、终端、浏览器、测试、变更；同样能定位到真实执行者会话。管理页只展示摘要和关键异常，细节按需进入此处。

管理入口可以在导航中表现为第三项，但底层不要把第三个AppMode等同于第三种普通工具profile。应拆成：`view = overview/work/code` 决定用户看什么；`executionProfile = supervisor/work/code` 决定某个执行者获准做什么；`sessionId/runId` 决定控制哪次工作。这些字段不应从当前聚焦tab反推。

这不是抽象风险：[client.request](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:75) 默认按getAppMode选profile；[dispatchChatRequest](D:/dev/aether-code/src/renderer/src/core/engine/chat-send-request.ts:33) 也按getAppMode发布clientCapabilities；而[useChat的流式请求](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1012) 用commandOwner固定profile。总负责人后台给Code/Work派活时，必须显式传目标会话的执行配置和能力绑定，不能沿用“当前页面就是目标模式”的假设。

建议的默认管理页信息密度：一行项目状态/总预算，一列可折叠任务树，中间成果与验收摘要，底部一个输入框。成员列表、时间线、用量、工具细节在抽屉或二级页。任务树选择某个工作包后，输入框显示明确收件人：“总负责人”或“开发 / 当前任务”；切换不应默默把用户草稿投给不同会话。

## 用户动作与端到端职责

下表右侧是建议流程，未实施。

| 用户动作 | 客户端职责 | 持久编排/引擎职责 |
|---|---|---|
| 输入一个需求 | 建立项目草稿、资料绑定、明确目标范围；展示分配结果 | 创建Project/Mission与总负责人run；按难度产出任务计划，校验角色/工具/预算后创建执行任务 |
| 只交给Work或Code | 提供“自动/办公/开发/协作”简洁选择，默认自动 | 决策可用执行profile；简单任务直接一个执行者，避免无意义多代理开销 |
| 多角色一起做 | 展示角色及依赖关系、谁负责哪个成果 | 持久Task DAG、分配唯一负责人、工作区/文件权限或worktree隔离；依赖满足才启动 |
| 开发完成后交文档 | 显示“开发提交→验证→文档”的交接 | 发出结构化交付事件，绑定构建/提交/文件哈希，唤醒文档任务；不要只把一段“完成了”当信号 |
| 给正在工作的成员追加 | 目标chip、当前轮/下一轮选项、明确投递状态与失败恢复 | 精确收件会话与run/attempt，授权、幂等、收件/消费/处理结果记录；不能向下一次run误投 |
| Work向Code提新要求 | 在两边时间线展示发件角色/原任务/变更内容，用户能追溯 | 项目内消息通道，保留发件身份，不伪装成用户；变更影响范围、优先级、依赖重验由总负责人处理 |
| Code向Work询问规则 | 显示“等待产品答复”和原问题锚点 | request/reply关联；接收者休眠时可唤醒，运行中进入其mailbox；设置可见超时/升级而非无限互聊 |
| 停止全部 | 项目级按钮与停止中状态；列出尚未确认停止的任务 | 停止任务启动、取消当前run及其子树，区分不可逆外部效果；收到终态再报告已停止 |
| 退回修改 | 选验收项并附证据，保留原交付版本 | 创建返工任务/新attempt，明确owner与范围；不覆盖旧验收事实或删除旧分支 |
| 验收与交付 | 标准、证据、实际产物并排显示；支持用户最终决定 | 与生产者分离的检查者；自动检查结果和人工/模型判断分别存；所有必需项满足才允许项目accepted |
| 关闭面板/重启客户端 | 保存视图与草稿，恢复后订阅权威状态 | 任务、投递、依赖、验收账本不依赖renderer存活；定义本地引擎关闭与远端继续的行为 |

## 哪些可以只改客户端，哪些必须有后端参与

**主要是客户端：**管理导航、任务/成员/交付视图、跨模式跳转、统一输入框的收件人选择、草稿隔离、证据展示、局部引用、进度摘要、用量图、现有角色模板编辑器整合。它们可以复用现有预览、历史、回执和变更组件。

**必须引擎或独立持久服务：**跨会话授权及消息入箱、任务/依赖状态机、运行与重试身份、唤醒调度、成员生命周期、批量取消、项目预算与并发治理、验收证据版本约束、断线重启恢复。客户端单独做这些会形成第二套不一致的“真实状态”，尤其在远端引擎或多窗口下。

**两边共同：**身份与能力协商、事件订阅、当前轮与下一轮语义、角色权限、文件/构建/验收关联、UI命令的精确作用域。既有 `expectedEngine`、rootAttempt、requestKey、admission receipt可以复用，但应扩展项目与发件主体，而不是绕过已有检查。

本地Electron主进程现有持久队列已经说明“客户端也能承担部分可靠调度”。但用户希望一个需求驱动多个持久会话，并允许远端引擎执行，这要求以引擎的项目账本作为权威；主进程继续承担本机文件、预览、系统交互及本地待发缓冲，不独占业务编排。

## 最小分阶段方案

**阶段一：有总负责人，仍有明确边界。** 一个项目拥有一个总负责人会话、一个Work执行会话、一个Code执行会话；也允许只生成其中一个。增加项目ID、任务所有权、依赖、标准和交付版本；复用角色定义与运行接口。先支持用户→成员和总负责人→成员的可靠投递。管理者默认无写代码/改文档工具。

**阶段二：双向协作与独立验收。** 项目内Work↔Code结构化消息、请求答复和唤醒；独立检查角色只读产物并运行允许的验证。开发产物提交后才触发最终文档生成，文档引用明确版本；需求变化触发受影响任务重新验收。直连沟通仍由任务范围约束，不让普通内容自行改写总目标。

**阶段三：动态组队。** 根据可并行工作量、任务边界和预算动态增加执行者；支持多个开发worktree、专业Work角色、跨项目复用模板。用真实瓶颈数据决定并发，不预设“每次都开一家公司”。

## 建议验收用例

第一期至少验证：只有Work；只有Code；Work→Code→Work；Code→Work直接提问并答复；两模式并行时用户切换页面；同一目标双击投递；消息ACK丢失后同键恢复；旧run结束瞬间追加；暂停或关闭客户端后恢复；成员异常退出；总负责人被停止时不再启动后继任务；同名文件并行写冲突；产物修改后旧验收过期；执行成功但内容错误被退回；新任务不复用旧项目授权；附件和资料不能串项目。

衡量指标应包括任务完成率、返工率、独立验收准确率、错误接受率、每次有效交付token/金额、阻塞时间、重复投递率、人工干预次数；不要仅统计聊天条数、子代理数量或Todo完成率。

## 本轮结论的限制

本次只读源码调研，不执行新模型或UI测试；未穷尽每个后端路由实现。跨root能力、服务端授权/存储和模型工具集合应与引擎调研报告一起确认。本报告没有把字段未出现在客户端类型中，扩大解释成整个后端绝对没有任何相关机制；确认的是现有客户端没有可用的项目级总负责人工作流和验收管理入口。
