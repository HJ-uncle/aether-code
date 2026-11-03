# Aether 与 Codex：生态、工具和模型使用协议深度调研

日期：2026-11-03。对象：`D:\dev\aether-code` 客户端、`D:\dev\ai-agent-engine` 引擎、用户提供的围棋会话，以及 Codex 本地解包、官方开源实现和在线资料。

后续实施见 [生态衔接优化与验证](ecosystem-implementation.md)。下文工具数量和问题描述保留调研时的快照，不能当作实施后的现状。

后续工具精简见 [AE 工具精简与请求说明压缩](../../../ai-agent-engine/docs/tool-cleanup-2026-11-03.md)：删除 6 项工具，搜索改名为 `glob` / `grep`，15 项管理或队列工具按需选择；每次请求自动注入环境并发送完整工具参数，精简重复提示。以下清单保留为实施前的调研记录。

## 结论先行

**用户发现的问题成立：现有产品没有让 AI 稳定完成“识别自己的环境—正确使用工具—恢复失败—在客户端交付产物”的全过程。** 但证据不支持“AI 完全没有工具说明”。当前引擎会把工具的完整 description 和 parameters 传给模型，围棋会话也调用过一次获取上下文。

问题主要集中在六个位置：

1. **Work 的操作协议不足。** 它有任务规模、后台任务、收尾要求及独立办公交付提示，但没有像 Code 一样系统说明命令参数、浏览器连接/标签、陈旧引用、失败归因与验证流程。Work 同样能做开发任务，却没有共享同等完整的底层执行约定。
2. **客户端能力没有成为统一的模型能力目录。** 浏览器有明确 AI bridge；文件预览、局部选区、用户 PTY、产物打开等功能则分散在客户端。`/chat` 没有传客户端能力清单、预览支持表、用户终端身份或产物打开协议。引擎的办公提示、下载规则、工具 schema 补上了一部分，但没有覆盖完整客户端操作。
3. **浏览器执行有真实故障。** 记录中四次点击因标签不可见没有执行，两次截图取不到显示表面。当前客户端已经有 reveal、等待 5 秒 bounds 确认，以及新宿主协议；必须核验这些机制在故障条件下为什么仍未成功。提示词不能代替执行层修复。
4. **文件变更账本覆盖不一致。** 文件工具和办公工具会记录变更，`execute_cmd` 内脚本写文件没有进入同一条 `result.change` 链路。客户端成果又依赖 `fileChange.toolCallId → tool.change → workArtifacts`，普通 Markdown 文件名不会自动成为成果。两端串起来看，这条路径会同时影响成果展示和回滚，不只是 AI 的工具选择问题。
5. **交付还缺少客户端内的完整操作链。** 引擎已经要求真实下载链接，也说明可在 Aether 预览；但没有通用的“打开这个产物、聚焦某页/某选区、关联这个后台服务”的模型工具契约。用户看到成熟的 UI，并不代表模型能够主动调用同样的能力。
6. **工具定义和执行规则存在具体不一致。** 例如 `browser_wait` 的 schema 没要求 selector/text，执行却要求至少一项；Code 的 subagent 说明提到当前 profile 没注册的 agent_list/get。MCP 目前还主要保留文本工具结果，资源、图片和 structuredContent 未形成完整原生通道。

本轮只完成调研和清单，没有修改产品实现、运行真实模型、重放围棋任务或重启服务。

## 完整清单入口

以下文件含逐项列表和源码定位。Markdown 便于阅读，JSON 保留完整 schema、签名或原始定义，避免详情被摘要截断。

| 清单 | 覆盖与口径 | 完整详情 |
|---|---|---|
| [Aether 引擎工具](engine-tools.md) | 76 个静态注册能力候选；Code 基础 allowlist 48 个；另有 memory scope、skills、MCP 等动态条件 | [engine-tools.json](engine-tools.json)：工具名、说明、参数、profile、权限和证据 |
| [Aether 客户端生态](client-ecosystem.md) | 187 个 preload 方法、160 个 IPC channel、52 项命令登记、11 项视图登记；客户端扫描覆盖 523 个源码文件 | [client-ecosystem.json](client-ecosystem.json)：调用签名、实现表达式、229 个共享类型契约、路由和能力映射 |
| [客户端 HTTP 与桥接](client-ecosystem.md) | 170 个渲染层 HTTP 请求对象出现点、36 个主进程 HTTP 调用出现点；另有 12 个 native host 调用出现点专项索引 | 同上；专项索引可与主进程出现点重叠，这些数字**不是唯一 endpoint 数，也不是模型工具数** |
| [Codex 本地客户端](codex-local-ecosystem.md) | 25 个能力层面、从两个 webview 主入口恢复的 66 个具名工具定义、153 条客户端 RPC 分类索引 | [codex-local-ecosystem.json](codex-local-ecosystem.json)：描述、schema 源表达式、条件和压缩源码 offset |
| [Codex 官方开源引擎](codex-oss-tools.md) | 35 条核心注册/版本形态；含互斥 V1/V2、托管工具形态及 1 条内部测试工具 | [codex-oss-tools.json](codex-oss-tools.json)：中文参数/结果摘要与完整静态源码定义 |
| [官方生态在线资料](codex-official-ecosystem.md) | Skills、MCP、插件、Apps、浏览器、办公产物、自动化、权限等产品能力与表面差异 | [官方来源索引](official-source-index.json)；已保留实际抓取正文 |
| 当前 Codex 会话工具快照 | `ALL_TOOLS` 当时可观察的 56 项，其中 34 项来自 `mcp__codex_app__` | [codex-session-tools.json](codex-session-tools.json)；不含直接命名空间，不代表产品全集；Pencil 等会话插件不算官方内置 |
| [围棋会话问题复盘](transcript-findings.md) | 128 次可见工具操作，逐项区分工具失败、正常测试失败和交付缺口 | [transcript-actions.json](transcript-actions.json) |

不要用上述几个数直接比较谁的工具多。IPC、用户命令、模型工具、动态插件和同一工具的不同版本是不同统计对象。

## Aether 引擎：全部工具名称速查

参数、默认值、枚举、返回、权限与 Work/Code 条件见引擎完整清单。

| 类别 | 全部名称 |
|---|---|
| 文件读写与查找（8） | `list_files`、`read_file`、`write_file`、`edit_file`、`delete_file`、`create_dir`、`glob_search`、`grep_search` |
| 命令与后台进程（3） | `execute_cmd`、`command_output`、`cancel_command` |
| 浏览器（15） | `browser_tabs`、`browser_open`、`browser_navigate`、`browser_snapshot`、`browser_screenshot`、`browser_click`、`browser_fill`、`browser_scroll`、`browser_press_key`、`browser_wait`、`browser_console`、`browser_network`、`browser_network_request`、`browser_set_viewport`、`browser_close` |
| 办公（3） | `office_environment`、`office_document`、`office_inspect` |
| 技能（3） | `list_skills`、`get_skill`、`run_skill_script` |
| 记忆（5） | `remember`、`recall`、`list_memories`、`forget`、`link_memories` |
| 子代理协作（7） | `subagent`、`subagent_start`、`subagent_send`、`subagent_wait`、`subagent_cancel`、`subagent_participants`、`subagent_inbox` |
| Agent 配置管理（8） | `agent_list`、`agent_get`、`agent_create`、`agent_do_create`、`agent_update`、`agent_do_update`、`agent_delete`、`agent_do_delete` |
| 计划与待办（5） | `plan_update`、`todo_list`、`todo_create`、`todo_update`、`todo_delete` |
| 后台任务（3） | `task_list`、`task_status`、`task_cancel` |
| 定时任务（5） | `cron_list`、`cron_preview`、`cron_create`、`cron_update`、`cron_delete` |
| 环境与历史（2） | `get_current_context`、`search_history` |
| 网络（2） | `http_request`、`web_fetch` |
| 开发辅助（4） | `codegraph`、`code_diagnose`、`install_package`、`list_packages` |
| 基础交互（3） | `ask_user`、`calculate`、`get_time` |

这些是静态注册候选。general/Work 默认 balanced OSM、启用 session memory 时可包含全部 76 项；禁用所有 memory scope 会少 5 项。Code 的基础 allowlist 是 48 项，显式 memory scope 可额外加入记忆工具。实际注册集合受 profile、allowedTools、OSM、资源选择与 MCP 发现结果影响；权限策略、浏览器在线状态等往往在执行时拒绝，未必移除模型收到的 schema。不能把静态表当某个 run 的实际输入或全部工具已就绪的证明。

客户端的人用功能另有资源管理器、编辑器与文档预览、Git/review/回滚、用户终端、会话/队列、Skill/MCP/知识库资源选择、记忆、模型/账号/连接、自动化、设置等。完整入口和每个方法见客户端清单。这里没有把 187 个桥接方法误标为 AI 可直接调用的 187 个工具。

## 前后端与模型的衔接对照

| 能力 | Aether 已有 | AI 当前能得到什么 | 尚缺或需要核实的环节 | 官方可借鉴点 |
|---|---|---|---|---|
| 环境自发现 | 工作区/profile；get_current_context 查询引擎平台、架构和 Node；office_environment 查询办公环境 | 系统上下文和完整工具 schema；get_current_context 中工具列表为短描述 | 未统一描述实际 shell、可执行依赖及客户端能力；短描述不代表 schema 被截短 | app-context + environment context + 依赖运行时工具 + 条件工具目录 |
| Work 执行协议 | Work 任务规模/后台/收尾协议，办公提示，下载交付规则 | 基础执行指导和专项 Office 规则 | 开发任务也会在 Work 执行，命令/浏览器/恢复规则应共享 | 基础执行规则与任务专项技能分层注入 |
| 文件操作 | 文件工具、版本保护、变更账本、回滚 UI | read/write/edit/delete 与冲突错误 | shell 写文件未进同一账本；生成物与外部修改需要一致关联 | 统一执行结果与资源标识；不能声称官方会自动回滚任意 shell 副作用 |
| 用户终端与 AI 命令 | 用户 PTY 多标签；AI command jobs | AI 可执行、读取输出、停止 job | 未发现直接接管用户 PTY 的模型桥；当前是两套资源 | 明确进程/session ID、stdin、生命周期；避免一个“终端”名词隐藏两套执行器 |
| 浏览器 | 15 类操作、旧 session bridge/新 native host、授权根、导航/元素引用、reveal 与 bounds 确认 | 模型有对应完整 schema；桥接注册不要求先开面板 | 围棋记录中可见性/截图故障反复出现；需核验已有恢复在隐藏、最小化或非当前任务下的行为 | 先发现表面/标签，再读取实时状态，按能力选择操作 |
| 浏览器测试 | snapshot/click/console/network/viewport 等 | 可以执行测试并获得明确未执行错误 | 自测通过与真实点击/截图通过要分开；环境失败不应转成改业务代码 | 结果结构与错误分类，以及失败后可验证的恢复步骤 |
| Office 创建 | office_environment/document/inspect；专项提示 | 模型能创建/检查，需报告真实路径和下载链接 | 原格式内容修改、渲染验收、显示能力应分别声明 | Skill + 依赖运行时 + 工具 + 产物预览分层 |
| Office 显示 | PDF/DOCX/XLSX/PPTX、图片/视频、文本/Markdown 等 | 提示告知可在 Aether 预览；工具生成文件 | 没有通用模型打开/聚焦/页定位工具；viewer 本身不是生成工具 | `open_in_codex` 类宿主操作，以及 artifact 状态/错误回执 |
| 局部选区 | 预览内容选中后添加到对话 | 客户端整理为消息引用文字；非隐式全文件传递 | 缺少统一结构化文件版本/页码/区域引用协议 | 将选区锚点与原文件身份一起交付，避免仅有失去位置的文本 |
| 产物交付 | 文件下载协议、资源面板与预览；成果由 fileChange/tool.change 回执关联 | 真实相对路径、下载链接和工具输出 | Markdown 链接不自动形成成果；shell 写盘缺回执；打开位置、服务 URL、tab/job 归属未统一 | thread/worktree/artifact/terminal/tab 使用不同稳定 ID |
| Skills | 列表、详情、脚本执行，资源选择 UI | 指引与具体工具 | 与当前能力、依赖、权限状态需要共同可发现 | 初始短目录 + 按需全文，不把所有说明塞入初始 prompt |
| MCP / 外部生态 | 客户端管理与选择，引擎动态工具注册 | 已连接服务的工具描述/schema | 需区分配置/连接/暴露；当前适配主要保留文本，resources/prompts/图片/structuredContent 原生通道不完整；展示接口可能丢失 MCP 来源 | 工具来源/认证/权限 + 延迟发现；不拿 resource list 代替 tools list |
| 知识库 | 资源选择与检索注入链路 | 由选择/查询进入上下文 | 应记录注入来源和覆盖范围，不能等同永久完整知识 | 区分文件、MCP resources、检索结果和 skills |
| 记忆 | 5 个工具、scope 配置、会话资源 | 按 scope 可读写/检索 | 不能当作技能协议、工具实时可用性的替代品 | 运行能力与长久知识分开；没有证据就不宣称官方使用同款 memory API |
| 子代理 | 同步/后台启动、消息、等待、取消、参与者/收件回执 | 完整协作工具定义；Code 有较完整委派纪律，Work 主要依赖工具说明 | 输出应关联证据和可验证状态；嵌套范围受限制；profile 文案需与实际可用工具一致 | 代理身份、状态、消息与 followup 生命周期明确 |
| 任务控制 | 运行状态、追加、停止、重试与队列 | 控制流通过引擎和客户端事件衔接 | 不能把“已收到停止”直接显示成“全部资源已结束” | 请求受理、执行状态、终态与后续恢复分开 |
| 定时任务 | cron 工具与自动化 UI | general profile 可用 | 调度任务、当前 run 与后台进程是不同对象 | 自动化配置、执行环境与实际 run 分离 |
| 权限与失败反馈 | 工具策略、浏览器授权、审批、结构化错误 | 有拒绝原因和部分恢复说明 | 文件/命令/Office 路径对同类副作用管理不一致 | 权限决定可执行范围，提示负责使用方式；二者不能互相替代 |

## 会话记录证实了什么

128 次可见工具操作中，100 次成功、14 次工具失败、14 次命令退出码为 1。浏览器操作 41 次，其中 10 次失败。具体错误和原记录行号见 [会话复盘](transcript-findings.md)。

最有代表性的四个例子：

- 点击四次被 `BROWSER_TAB_NOT_VISIBLE` 拦下，是执行条件问题。
- 通过导航调用 `javascript:`，编码后又试一次，是工具选择和协议理解问题。
- shell 删除文件被要求改用 `delete_file`，而 shell 创建文件仍然成功，暴露出策略与变更管理不一致。
- 最终说明测试数量并明确披露没有完成截图/真实点击，诚实披露应保留；但交付仍让用户双击文件或手动启动服务，客户端自身的能力没有充分进入交付流程。

无法从导出记录判定当时具体模型、压缩策略或 provider 是否丢失了某段指令。要查这一层，需要该 run 实际序列化的输入快照与工具集版本，不能靠行为倒推“没有发 schema”。

## 建议的改进顺序（本轮未实施）

| 优先级 | 工作 | 具体产出 | 验收方式 |
|---|---|---|---|
| P0 | 定义一次运行的能力快照 | client/engine 共同版本化的能力目录：环境、模式、可用工具、客户端表面、运行库、权限、降级原因 | 记录一次真实模型请求，逐项对齐工具 schema 与当时客户端状态 |
| P0 | Work/Code 共享基础操作协议 | 公共命令/文件/浏览器/产物/恢复规则，Office 和开发专项规则按需叠加 | 同一围棋任务分别在 Work/Code 使用正确工具与交付入口，无多余授权循环 |
| P0 | 修复浏览器执行与恢复 | 在已有 reveal、5 秒 bounds ACK、新宿主协议上复核身份、可见性与表面状态，补齐失败路径 | 覆盖最小化、遮挡、切 tab、后台非当前任务、刷新导致陈旧引用、截图不可用；断言真实副作用 |
| P0 | 补齐命令写盘的变更关联 | shell/脚本/Office/文件工具统一关联 run、文件版本、diff/产物；明确不跟踪项 | 用文件工具、Node/Python 脚本和构建各生成一次文件，界面都能识别并按定义恢复 |
| P1 | 增加客户端产物与资源工具 | 列出/打开产物、定位页/选区、打开项目预览、列出/绑定终端或服务；稳定 ID | AI 生成后直接在客户端打开，错误可返回；选区修订能定位正确文件版本 |
| P1 | 加入调用前发现与用法示例 | 简短能力索引、完整 schema 查询、首用示例、前置条件、恢复方式 | 禁用浏览器/依赖时 AI 能辨识降级；可用时不要求用户手动完成已有客户端功能 |
| P1 | 建立生态契约回归集 | 用真实用户任务覆盖跨层链路，而非只测按钮 | 创建文档→显示→选区修改→回滚；创建项目→服务→浏览器交互→停止→恢复；子代理协作 |
| P2 | 加入可解释的运行审计 | 记录工具集版本、来源、权限判定、失败类别、重试次数与实际执行回执 | 用户能区分 AI 调用错误、客户端故障、权限拒绝和业务测试失败 |

建议新增的能力应从真实 registry 和客户端状态生成，不能手写一段永远声称所有工具可用的长提示词。也没有证据要求先更换模型或 SDK；当前最明确的缺口在产品的执行协议与前后端衔接。

## 范围、版本与复核边界

- Aether 客户端基于当前工作树读取，HEAD `0c9e133a64ecd4aac051cfc7b093648ca05fc8dd`；引擎 HEAD `c978e2eb855042434109d37e2661ea7e96113fff`。两仓均有原有未提交修改，所以这里描述的是**工作树快照**，不是只描述这两个 commit 的内容。
- Codex 本地样本：`E:\rea\codex-src`，`26.1007.21434 / build 13901 / Electron 42.3.0`，无 sourcemap，未包含完整 Rust runtime。压缩代码用文件＋字符 offset 定位，不能伪造源码行号。
- 官方开源版本锁定 `616cab3a3529f572c3385098c12698278770ea98`，来源与下载记录已保存。
- 官方在线资料抓取于 2026-11-03。桌面、CLI、IDE、ChatGPT Work、云端 artifact 和相邻产品分别注明，没有合成一个虚假的固定工具全集。
- 本轮清单是静态审查与会话复盘。没有把源码中“存在”说成真实会话“已经成功启用”，没有重跑性能、UI 或模型行为测试。
