# Aether 引擎生态与工具完整清单

调研日期：2026-11-03。源码基线：当前工作区 \`D:\dev\ai-agent-engine\`（含已有未提交改动）；本次只读审查产品代码，未调用真实模型、MCP 服务或生产写接口。附带会话是历史证据，不能证明其当时运行二进制与当前源码完全一致。

本文件和 [engine-tools.json](engine-tools.json) 对照注册工厂，列出 **76 个静态可注册能力**：71 个非记忆能力 + 5 个按 scope 启用的记忆能力，含 3 个技能接口和 15 个浏览器工具。Code 基础允许集为 **48 个**，可以按会话配置再加入 5 个真实内置记忆实现；扩展 MCP 另计。general/Work 默认使用 balanced OSM、session memory 时可注册全部 76 个，真实单次请求还会被自定义 Agent、allowedTools、OSM、技能和 MCP 绑定进一步缩窄。这不是该历史会话的运行时工具快照。

## 核心发现

1. **模型确实收到完整的工具描述与输入 schema。** \`ToolRegistry.list()\` 提供 name/description/parameters；ReAct 从注册表取全列表，正常轮次映射完整定义给模型，主要动态排除是 ask_user 次数限制和最终收尾清空工具。OpenAI 与 Anthropic adapter 保留 parameters/input_schema。证据：\`src/core/tool-registry/registry.ts:30\`、\`src/core/agent-loop/react.ts:571,668,894\`、\`src/core/llm-adapter/openai.ts:526\`、\`src/core/llm-adapter/anthropic.ts:278\`。不能把问题概括为“工具定义没给 AI”。
2. **能力目录、运行就绪与操作合同分散。** \`get_current_context\` 要模型主动调用，目录只截取工具描述前 50 字，不给参数；平台是引擎平台，Node 版本不代表 PATH 中能执行该程序；浏览器工具注册不代表宿主已连接。证据：\`src/tools/get-context/get-context-tool.ts:37,87,116\`。当前注册链路未见统一的可执行依赖、浏览器就绪、所有工具 recovery、UI 打开方式一起注入的能力快照。
3. **Work 有执行协议，但与 Code 的环境操作指引不等量。** Work 有规模判断、最小调查、计划、后台服务和收尾；Code 额外有 Git/项目规则、版本编辑、环境失败分类、浏览器身份/恢复、异步子代理结果归属和历史证据使用的完整协议。工具本身部分已有这些约束；差距在跨工具任务编排与全局环境认知，并非所有知识都缺失。
4. **外部命令写文件没有接入现有文件变更账本。** \`execute_cmd\` 只启动/观察 command job，未包裹前后文件快照；全源码 \`commitWriteChange/commitDeleteChange\` 调用仅出现在 file/office 的明确写入口；ReAct 只在 \`result.change\` 时发文件变更帧。因此 Node \`fs.writeFileSync\` 这条调用路径不自动产生同一账本的撤回记录。证据：\`src/tools/cmd/execute-command.ts:89\`、\`src/tools/file/change-recorder.ts:100\`、\`src/core/agent-loop/react.ts:362\`。这是静态链路结论，未核验历史会话数据库，不能进一步声称其所有文件均无法恢复。
5. **前端有入口不等于模型有工具。** 模型有浏览器操作、文件、办公、命令、计划、子代理、Skills/MCP、记忆和自动化，但没有注册专用“打开资源预览/定位文档页/管理终端标签/撤回文件改动/知识库目录与精确检索”的工具。后端存在相关 HTTP 管理路由；不能让模型靠猜 API 或 shell 补产品能力。
6. **MCP 当前按工具适配，未保留完整 MCP 内容生态。** 按服务发现 tools/list、调用 tools/call，命名 \`mcp_<serverId>_<toolName>\`；未见该 client 中 resources/list、resources/read、prompts/get 对模型的标准入口。JSON-RPC content 非 text 被 JSON.stringify 成文本，REST content 只取 text；structuredContent/outputSchema/图片资源并没有以完整原生结构继续投递。证据：\`src/tools/mcp/client.ts:406,542,564\`。
7. **声明与执行细节有漂移。** \`browser_wait\` 的 JSON schema 不要求 selector/text 但运行时要求至少一项；fill 互斥只在 Zod refine；search_history JSON schema 不 formal require query/messageId 但执行强制；list_packages 声称已安装包，实际读 package.json 声明，global 参数没有对应全局安装枚举。这些会造成“按 schema 合法，实际失败”或能力认知偏差。

## 注册、权限与执行链

\`chat request → toolProfile/Agent/resource scope → createToolRegistry → ToolRegistry.list → ReAct effectiveTools → provider tool schema → model tool call → preflight → runtime → ToolResult → history/SSE/client\`

- 默认 profile 为 general；Code 是明确 48 项 allowlist，拒绝 cron_ / agent_ / task_ 业务管理和 general-only Office、包管理、计算/时间；但 code 保留 skills 和 MCP 扩展。原名别名仅用于配置规范化：run_command→execute_cmd、glob→glob_search、grep→grep_search、smart_read→read_file，没有给模型注册这些别名。
- \`plan_update\` 为当前会话内建控制，无论业务 allowedTools 是否为空均注册，扩展不能冒名。显式业务 allowedTools=[] 不会开放其它业务工具。
- memory scope 是独立配置：global/session；全局 ENABLE_LONG_TERM_MEMORY=false 强制关闭；general 旧默认 session，legacy Code 默认关闭，生产聊天传实际解析的 scopes。写入优先 session，避免会话内容升级为全局。
- OSM off 取较窄核心集；balanced/methodology/max 工具默认全量。实际 \`resolveOSMMode\` 未配置返回 balanced，不要使用旧注释误判 off。methodology/max 另注入 os-using-superpowers，找不到时有静态 fallback；其余模式隐藏方法论技能。
- 所有工具先 preflight。可信实现决定 readonly/subagent/serial，不信任扩展自报名称；subagent 和 wait/cancel 有编排池豁免，避免子任务与父等待死锁。
- safe 模式禁止不可约束副作用的 MCP/脚本扩展；命令按 safe/standard/full-access 策略审批。删除类命令、内联删除在所有模式仍被专门拒绝，要求 delete_file。不要把 full-access 注释当成无条件放行的事实。
- \`execute_cmd\` 默认直接执行程序+args，非 shell 字符串；cwd 先解析工作区，但 cwd 本身不是操作系统沙箱。full-access 继承完整环境，其他模式传 PATH/PATHEXT/HOME/SystemRoot/COMSPEC。当前实现省略 timeoutMs 所有模式均无截止；显式 timeoutMs 必须正数，不能传 0（与其它工具 0=无限不统一）。

证据：\`src/tools/registry-factory.ts:142,154,166,190,230,260,319,356,386\`；\`src/tools/tool-profile.ts:22\`；\`src/core/osm.ts:165\`；\`src/security/tool-policy.ts:22\`；\`src/security/policy-engine.ts:322\`；\`src/middleware/memory/policy.ts:13\`。

## Work 与 Code：逐项差异

| 主题 | general/Work 当前系统级约束 | Code 额外明确内容 | 影响 |
|---|---|---|---|
| 任务尺度与收尾 | quick/standard/large、少量验证、达成验收后结束 | 分阶段推进及验收交付合同 | Work 并非完全无协议 |
| 初始环境 | 工作区路径、附件名、必要图谱提示；平台由 get_current_context 主动查询 | 同样工具能力基础，要求读适用 AGENTS.md/AE.md、Git 状态 | Work 默认不建立同等工程环境基线 |
| 文件修改 | Office 有 expectedHash 专用协议；普通 file 工具描述也有版本要求 | 全局要求普通文件编辑复用最近真实 hash，保护现有 Git 改动 | 多工具选择时约束不够集中 |
| 命令 | 后台服务和避免重复运行；execute_cmd 说明提供参数范式 | 失败先区分启动/脚本/断言/环境，command_output 观察既有任务 | Work 容易把操作故障转为代码修补 |
| 浏览器 | 各 browser 工具自己的描述及错误 recovery | tabId/会话归属/空列表/新快照/operationPerformed/不可因环境错改网页 | 缺少跨多次操作的统一恢复纪律 |
| 子代理 | subagent 各定义 + 共享运行时约束 | 自包含委派、默认只读、同一次多调用并行、角色与真实 runId、不可用旧正文代替机器状态 | 团队编排教学分散 |
| 历史压缩 | 有 search_history 工具 | 摘要为索引，关键精确信息回查原 messageId/turnId | 压缩后生态使用知识是否保留不够可见 |
| 临时工件 | 通用 Work 没有同等目录协议 | .ae/plans、.ae/tmp、.ae/logs 等目录纪律 | 测试工件容易混进交付项目 |

共同规则还有中文、原始工具名、关键问题才 ask_user、plan_update、禁止自造解码/OCR轮子。Office 有独立通用协议，只在 general 且 office_document 真正注册时加入。证据：\`src/api/http/routes/chat.ts:83,1372-1388\`、\`src/core/code-agent-prompt.ts\`、\`src/core/office-prompt.ts\`。

## 生态资源：发现、详情、执行与边界

| 生态 | 发现与详情 | 执行/注入 | 边界与当前缺项 |
|---|---|---|---|
| Skills | 内置 aether-office；全局 ~/.aether/skills、项目 .ae/skills（兼容 .aether/skills、SKILLs）、部署 SKILLS_ROOT；list_skills/get_skill | 目录名称+描述进 system，正文按 get_skill；references/*.md 按 resource 读取；脚本 run_skill_script | 项目层覆盖全局；本地同名优先于 inline；inline 无真实脚本路径。虚拟技能可读说明不等于脚本可执行 |
| MCP | 本地+项目配置与请求 inline；逐服务 tools/list；allowedMcpServers IDs；disabledTools | 动态 mcp_ 命名，完整 inputSchema 注册；支持 stdio/http/SSE/streamableHttp；stdio/SSE 发现后断开，调用时重连 | 连接失败 warn并跳过，不阻断整个聊天；模型可能不知道某预期服务为何缺席。当前标准适配仅 tools，不是完整资源/提示词/图像原生通道 |
| Knowledge | 客户端元数据目录（≤100项）+服务端知识库 HTTP CRUD/search | 聊天开始根据用户纯文本 searchChunks，topK片段进系统提示；Agent绑定白名单，code无绑定默认[] | 注册表没有 knowledge_list/search/read；模型不能受控地自主补检索。目录 metadata 不是正文 |
| Memory | 5个工具，scope由服务端；get_current_context可列近期5条 | 请求时 buildMemoryRecallBlock + inline memories；remember/recall/graph links | scope需启用；只有5个实际工具，没有已注册 search_memory（只是旧allowlist文字） |
| 自定义 Agent | agent_list/get +管理工具；local DB与inline列表按id合并，本地优先 | subagent(agentId)继承选中角色/模型/资源，仍交集父权限 | inline Agent只读；Code无agent_list/get，subagent描述仍提到这两个发现入口，是profile文案缺口 |
| 子代理协作 | subagent_participants/inbox | 同步/异步启动、send/wait/cancel、resumeRunId | 子代理不可递归、无ask/审批；默认只读；收件回执不含正文，正文在执行边界自动整合 |
| Browser | browser_tabs +snapshot/screenshot/network | engine bridge→当前tenant/root session/run身份→在线客户端宿主→真实可视页面 | 15个工具，无JS evaluate；可视截图/点击有宿主/窗口要求；file仅本机授权目录HTML，远端localhost语义明确 |
| Terminal/命令 | command_output、command jobs HTTP | execute_cmd后台jobId、分页持久输出、进程树取消 | 命令job不是客户端所有终端标签管理；当前静态注册没有通用 terminal_tabs/read/write 控制工具 |
| Office | aether-office及4个references，office_environment | 原生 DOCX/XLSX/PPTX/PDF create/inspect/edit/recalculate；资源UI预览 | 引擎不具备Office UI预览打开/页定位工具；结构检查非视觉；PDF非原格式转换 |
| 文件与撤回 | 文件工具path/hash/change；HTTP /changes | file/office写入进入ChangeStore，前端收 __file_change__ | 无LLM专用revert/keep工具；execute_cmd写文件没有进入同一账本 |
| 计划/自动化/后台任务 | plan_update、todo_*、cron_*、task_* | 持久会话计划、定时任务、后台队列 | 属于不同身份域；task id、command jobId、subagent runId不可混用 |
| 项目说明/规则 | user AE.md + project .ae/AE.md，兼容旧路径 | 每请求实时加载，单份最多32KiB；OSM额外引导 | AGENTS.md不是这里自动扫描的同一入口，Code协议要求模型主动阅读 |
| LSP/代码图 | code_diagnose、codegraph | TS/ESLint与符号/调用图，index异步 | HTML/CSS不在诊断支持内；图索引须用户明确要求；未支持不等于通过 |

主要源码：\`src/skills/skills-registry.ts\`、\`src/skills/external-loader.ts:192\`、\`src/skills/builtin/aether-office/SKILL.md\`、\`src/tools/skill/index.ts\`、\`src/tools/mcp/loader.ts\`、\`src/tools/mcp/client.ts\`、\`src/api/http/routes/chat.ts:1087,1109,1333\`、\`src/core/project-context.ts\`。

## 后端“客户端管理 API”与“模型工具”不是同一目录

- 工具展示：GET /tools、/system-tools、/external-skills。前两者会重新建registry，包含动态MCP发现；当前 /tools 把非skill source统一展示为 builtin，MCP provenance 被丢失。source标识不应当作注册表真实生态分类。
- Skills：\`src/api/http/routes/skill-imports.ts\` 的导入/读取/配置/删除；模型只拿 list/get/run 三入口。
- MCP：\`src/api/http/routes/mcp.ts\` 的服务CRUD、enable/disable/test、config import/export；模型拿服务器提供的 tools。
- Knowledge：\`src/api/http/routes/knowledge.ts\` 的 bases/documents CRUD、formats、POST /knowledge/search；未注册为模型能力。
- 文件改动：\`src/api/http/routes/changes.ts\` 的 list、keep、keep-all/keep-many、revert、revert-batch；未注册为模型工具。
- 执行控制：\`command-jobs.ts\`、\`subagent.ts\`、\`collaboration.ts\`、\`browser.ts/browser-hosts.ts\`、\`terminal.ts\` 各自有客户端协议；不能把HTTP路由数量计入模型工具数量。
- Agent/记忆/自动化：\`agents.ts\`、\`memory.ts\`、\`cron.ts\`、\`tasks.ts\`、\`todos.ts\` 同时服务管理UI；其模型工具只是特定子集。

本次静态盘点未连接配置中的外部服务，因此无法给出“此机器此刻所有远端 MCP 实例及其tools”的活跃清单；也没有读取用户凭据、全量私人知识库或记忆数据。内置与动态边界已完整分开。

## 会话证据与机制对应

提供会话文本约7520行。可复核的环境/生态适配失败包括：6819 截图 \`Current display surface not available for capture\`；多次 \`BROWSER_TAB_NOT_VISIBLE\`；7256-7262 用 browser_navigate 执行 javascript: URL被拒；7287 命令中删除触发必须 delete_file 的策略；7305 file导航不属于当前网页目录；7379可见性失败给出恢复宿主/新tabs/snapshot的指引。模型转写 Node DOM桩及浏览器selftest，说明它在补工具能力与真实交互验证之间没有稳定区分。

这些证据不能证明每次失败都由平台造成：记录还包含项目逻辑与断言错误，末尾也说明未做真机触摸与受限截图/点击，不能把单元测试计数当作完整UI验收。当前源码已存在一些非常明确的工具说明，因此需进一步比对历史请求的实际 system prompt、effective tool definitions、客户端宿主状态与模型输入日志，才可断言究竟是当时版本缺指引、提示词未注入、还是模型未遵循。

## 产物展示、后台服务、文档选区的模型契约

全 profile 都注入 `buildWorkspaceDownloadPrompt`（`src/core/workspace-download-prompt.ts:2`、`src/api/http/routes/chat.ts:1373`）：真实成功回执后，用主工作区相对路径构造 `/api/v1/workspace/file/download?sessionId=...&path=...` Markdown 链接，保留完整目录，每个 query 值只编码一次；不得猜文件、不得用 file://。这是一套交付链接合同，尚不是“创建完成后自动打开客户端资源标签”的模型工具合同。

Office 专用 prompt 与 aether-office 技能说原格式在 Aether 资源预览查看；没有 `open_artifact`、聚焦资源标签、跳转页码/单元格、读取已选区域的工具。Work 执行协议只要求服务/watch 走后台命令且设置合理超时；没有将 jobId、可访问服务 URL、browser tabId 和客户端预览卡片统一交付的系统级规约。browser_* 自身已说明 tabId/navigationId 使用方式，不能说这些字段完全没解释。

引擎 ChatBody 的文件附件是 name/content/type/encoding（`src/api/http/routes/chat.ts:139`）；通用 message 可包含客户端构造的文本/多模态块，附件经 `attachment-auto-processor.ts` 转换模型输入。当前引擎专用请求类型和 prompt 中未见 Office selection 的 fileHash/range/selectedText/page/cell 等结构合同，也未见 browser/terminal reference 的独立类型。选区可能已经由客户端序列化为 message 文本；是否包含锚点、版本、来源及防陈旧语义，应以前端构造链路为准，不能仅因后端没专用字段断言选区功能不存在。

另有跨 profile 一致性缺口：Code 保留 subagent，而其原始 description 仍指向本 profile 排除的 agent_list/agent_get；默认内置技能层有 aether-office，但 Code 不注册 office_document/office_inspect/office_environment，实际是否看到该技能还取决于 allowedSkills。能力说明应由实际可执行集合生成，避免提到当前无法调用的入口。

## 每项工具详情

下列 description 与 JSON Schema 来自当前 TypeScript AST 静态提取（对象展开/本地常量已解析）；保留源码英文说明与现有中文，不替实现添加缺失 default/required。运行时默认/更严格校验列在 notes。统一 ToolResult 包含 success、output:string，及可选 status/error/durationMs/needsConfirmation/pendingAction/metadata/change；模型定义没有每工具 typed output schema。工具返回说明均为源码观察，不是运行实测。


