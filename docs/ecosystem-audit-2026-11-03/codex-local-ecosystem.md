# Codex 本地解包客户端生态审查

审查日期：2026-11-03。样本：`E:/rea/codex-src`，`openai-codex-electron` **26.1007.21434 / build 13901**，Electron 42.3.0。

这份报告研究用户提供的打包客户端。它与本次实际工具表、官方在线文档、固定提交的开源 Rust 工具目录是四种独立证据；不能把版本、账号、平台和功能开关差异合并成一个“所有人都可调用”的工具全集。

## 核心结论

Codex 的关键不是界面里拥有多少按钮，而是把生态能力变成模型可以发现、理解和调用的协议：**实际可用工具 → name/description/inputSchema → 按能力生成 developer/app-context → 带线程身份执行 → 结构化结果与原生展示 → 继续编辑或引用同一产物**。

这个闭环在本地代码里有直接证据：thread 启动先 readDynamicTools，再依据可用能力构造 readDeveloperInstructions；办公依赖使用 load_workspace_dependencies 明确告诉模型路径和库；Spaces 创建工具返回 page_id 并明确指导 connect_spaces_artifact → exact artifactRef → artifact_session；打开文件、读取终端、任务管理和自动化都有模型专用入口。

不能反推“只要复制预览组件，模型就自然会懂办公生态”。Viewer、IPC、后端方法、模型工具、技能说明分别属于不同层。

## 数量与边界

| 本报告口径 | 数量 | 含义 |
| --- | ---: | --- |
| 能力域 | 25 | 本报告归纳的结构、功能及上下文连接点 |
| 恢复的具名工具定义 | 66 | 两个 webview 主入口的 description/schema 源码；含条件功能、Chrome 扩展、引导与 prototype |
| RPC 分类索引 | 153 | 客户端 telemetry 方法分类表，**不是模型工具表** |
| bundled 插件槽位 | 15 | 内建插件配置，**不是已安装/启用数** |

66 条定义保留完整原文描述、参数 schema 源表达式、可定位的被引用 schema、中文用途及证据 offset，见 [codex-local-ecosystem.json](./codex-local-ecosystem.json)。原始 JS 未执行，schema_source_expression 是源码，不是运行后生成的 canonical JSON Schema。工具返回的确定形状只在 handler 有直接证据时记录。

本次实际模型可见工具以 [codex-session-tools.json](./codex-session-tools.json) 为准。它的导出范围不含直接 namespace collaboration/cua/clock.sleep/functions 自身；因此也不能把该文件数量当整个系统能力总数。

未复制的 Rust agent 二进制、resources 中未完整提取的 bundled 插件，以及云端按账号发现的 Connector 工具均不由本地样本穷举。插件市场和账号工具本来就是开放集合。

## 分层能力与证据

### 1. 模型工具发现与结构化定义

客户端 tools/list 返回 namespace、name、description、inputSchema；tools/call 带 threadId、turnId、callId、callerSource、hostId；tools/cancel 中止正在执行的工具。

**可确认标识：** `tools/list`, `tools/call`, `tools/cancel`。

- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `308095`，检索 `method:n.w(`tools/list`)`。
- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `309794`，检索 `function zae`。

### 2. 按实际能力生成模型上下文

thread 准备时读取 readDynamicTools；只有四个工作树工具全部具备才启用对应指导；按 threadToolsEnabled/worktreeToolsEnabled 等条件调用 readDeveloperInstructions。

**可确认标识：** `readDynamicTools`, `readDeveloperInstructions`, `enabled_tools`。

- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `657388`，检索 `readDynamicTools`。
- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `1324717`，检索 `### Workspace Dependencies`。
- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `1326310`，检索 `### Thread Coordination`。

### 3. 条件注册与延迟加载

动态注册器 Eac 根据 desktop/localDesktopHost、host 版本、feature flags、pagesEnabled、workspaceDependenciesEnabled、voice、启动类型生成可见工具集合；区分 eagerToolNames/deferredToolNames。

**可确认标识：** `Eac`, `eagerToolNames`, `deferredToolNames`, `create_spaces_artifact`, `connect_spaces_artifact`。

**边界：** 静态定义数量不能解释为每个用户/每个任务都可调用的数量。

- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9578564`，检索 `function Eac(`。

### 4. bundled App Tools 插件桥

从 resources 下 bundled 插件读取 .mcp.json，设置 pipe 与 Node runtime；插件缺失、pipe 缺失或运行时缺失时禁用；可以 defer app tools。

**可确认标识：** `CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_APP_TOOLS_DEFERRED`, `CODEX_MCP_NODE_PATH`, `codex-app-tools`。

**边界：** 真实 bundled 插件不完整包含于解包目录，不能仅凭 Electron handler 宣称完整工具实现已掌握。

- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `182601`，检索 `CODEX_APP_TOOLS_PIPE_PATH`。
- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `185519`，检索 `CODEX_APP_TOOLS_DEFERRED`。

### 5. MCP 标准能力与变更通知

工具含 inputSchema、可选 outputSchema、annotations、execution.taskSupport；返回 content、structuredContent、isError；工具列表可发送变更通知。

**可确认标识：** `tools/list`, `tools/call`, `notifications/tools/list_changed`, `structuredContent`, `taskSupport`。

- `.vite/build/worker.js`，UTF-8 解码字符 offset `921492`，检索 `taskSupport`。
- `.vite/build/worker.js`，UTF-8 解码字符 offset `922260`，检索 `notifications/tools/list_changed`。

### 6. 办公依赖与运行时发现

load_workspace_dependencies 无参数，只适用于 local thread，返回配置的 Node.js/Python 和办公库路径及使用指令；未安装/关闭会真实返回不可用。

**可确认标识：** `load_workspace_dependencies`。

- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `2569249`，检索 `load_workspace_dependencies`。
- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3899471`，检索 `e1n=`load_workspace_dependencies``。

### 7. 内置插件、MCP、技能生态

源代码列出 15 个 bundled 插件槽位（部分隐藏、自动安装、需要 opt-in）；RPC 提供插件市场、安装、搜索、读技能、skills/list/extraRoots/config、MCP 状态/资源/调用/OAuth。

**可确认标识：** `codex-app-tools`, `browser`, `unified-computer-use`, `chrome`, `chrome-dev`, `chrome-internal`, `computer-use`, `messages`, `record-and-replay`, `computer-history`, `latex`, `notebook`, `code-review`, `deep-research`, `visualize`, `skills/list`, `plugin/skill/read`, `mcpServerStatus/list`。

**边界：** 15 是内置插件槽位，不代表安装或启用状态。市场、组织与账号插件无静态全量上限。

- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `1817424`，检索 `Cmt={codexAppTools`。
- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3225837`，检索 `"skills/config/write"`。
- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3224455`，检索 `"mcpServer/oauth/login"`。

### 8. App 身份、授权与可用性

插件/连接器支持多账号、linkId、需要重新认证、管理员禁用；权限模式区分 always_ask / ask_before_writes / review_important_actions / full_access。

**可确认标识：** `always_ask`, `ask_before_writes`, `review_important_actions`, `full_access`, `REAUTH_REQUIRED`。

- `webview/assets/skills-fe62211ab9a5.js`，UTF-8 解码字符 offset `3116`，检索 `always_ask`。
- `webview/assets/skills-fe62211ab9a5.js`，UTF-8 解码字符 offset `2276`，检索 `REAUTH_REQUIRED`。

### 9. MCP App 交互面板

从 citation 读取 producer identity/server/connector/link/plugin；校验匹配工具与 resourceUri，再调用 toolArguments 打开 MCP view；账号变化/资源失效有错误与重试。

**可确认标识：** `resourceUri`, `toolArguments`, `pluginId`, `connectorId`, `linkId`。

**边界：** 前端能展示 MCP App，不等于模型自动知道如何使用其中所有交互。

- `webview/assets/load-mcp-app-tool-05dc57e97d0d.js`，UTF-8 解码字符 offset `4023`，检索 `resourceUri`。

### 10. 文件查看器插件机制

插件声明支持扩展名，用户可选择 preferred viewer；内建查看器兜底，插件发现有 loading/error/retry。

**可确认标识：** `Built-in`, `preferred`。

- `webview/assets/file-type-handlers-57d0e7ae6b47.js`，UTF-8 解码字符 offset `4682`，检索 `Built-in`。

### 11. Office 原生模型导入与按需加载

CSV/TSV 转 Workbook；DOCX/PPTX/XLSX 经 ExtractDocxProto/ExtractSlidesProto/ExtractXlsxProto 解码为 Document/Presentation/Workbook；Notebook、PDF/TeX 专用面板。

**可确认标识：** `Workbook.fromCSV`, `ExtractDocxProto`, `ExtractSlidesProto`, `ExtractXlsxProto`, `NotebookPreviewPanel`, `PdfPreviewPanel`。

**边界：** 这些是显示/导入能力，不能直接算作模型生成文档的工具；未运行性能测试。

- `webview/assets/artifact-preview-loaders.electron-4d849a5a7611.js`，UTF-8 解码字符 offset `2519`，检索 `ExtractDocxProto`。

### 12. 文件预览种类与格式

Library 明确分类 image/pdf/artifact/markdown/html/text/unsupported；artifact 后缀 csv/docx/ipynb/pptx/tsv/xlsx；包含 Google Docs/Slides/Sheets 路由、常见代码文本扩展名；tex 在 library kind 返回 null，单独 artifact 面板可走 PDF/TeX。

**可确认标识：** `csv`, `tsv`, `docx`, `pptx`, `xlsx`, `ipynb`, `pdf`, `md`, `html`, `image`。

**边界：** xlsm MIME 映射到 xlsx 路由，不代表支持执行宏或完整宏编辑。

- `webview/assets/library-file-preview-kind-4b1f33be05cd.js`，UTF-8 解码字符 offset `1385`，检索 `docx`。

### 13. 文档局部选择、评论与 AI 回流

DOCX 支持区域、页区域、元素选择、页点和直接评论；PDF 支持区域/点/直接评论。Artifact follow-up 指导要求复用 exact Artifact Session reference，在现有文档上继续编辑并回复 comment thread。

**可确认标识：** `document-page-region`, `document-element-selection`, `artifact-direct-comment`, `pdf-direct-comment`, `artifactSession.run`。

- `webview/assets/docx-preview-panel-d63f52291d86.js`，UTF-8 解码字符 offset `3480`，检索 `document-element-selection`。
- `webview/assets/pdf-preview-panel-9561a1494340.js`，UTF-8 解码字符 offset `8554`，检索 `pdf-direct-comment`。
- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `782879`，检索 `artifactSession.run`。

### 14. Notebook 专用显示

Notebook 面板识别 stream/error/html/markdown/text/json/image outputs，独立于 Office model 导入。

**可确认标识：** `NotebookPreviewPanel`, `stream`, `error`, `html`, `markdown`, `text`, `json`, `image`。

- `webview/assets/notebook-preview-panel-68808ceb830b.js`，UTF-8 解码字符 offset `1748`，检索 `stream`。

### 15. Spaces 原生表格/演示文稿创建编辑闭环

create_spaces_artifact 创建一张空表/一页空幻灯片，参数 artifact_type/title/idempotency_key/destination；结果 page_id → connect_spaces_artifact(page_id) → artifact_session.artifactRef → exact ref 编辑；重复结果恢复复用同 key，保留原内容。

**可确认标识：** `create_spaces_artifact`, `connect_spaces_artifact`, `artifact_session`, `artifactRef`, `granola_workbook`, `granola_presentation`。

**边界：** 旧样本说明仅 local task，cloud Work、ordinary Pages、native Docs、Canvas 不由该创建工具支持；不意味着本次工具表启用。

- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9574980`，检索 `lac=`connect_spaces_artifact``。
- `webview/assets/create-artifact-agent-tool-05e504cc6e00.js`，UTF-8 解码字符 offset `3539`，检索 `agent_provenance`。

### 16. Page 附件读取工具

read_page_reference 输入 page_id 和 project-file:/library-file:/visualize: 引用；返回 PNG/JPEG/GIF/WebP ≤10 MiB 或 UTF-8 ≤256 KiB；HTML 返回源文本，不执行；Page 与 file 权限分别检查。

**可确认标识：** `read_page_reference`。

- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9576655`，检索 `gac=`read_page_reference``。

### 17. 终端、PTY 与后台输出

TerminalManager 按 owner window/conversation/host/environment 管会话，提供 create/attach/write/resize/runAction/close/snapshot/ownership transfer；模型专用 read_thread_terminal 获取当前线程终端 cwd/shell/buffer；后台命令输出以 commandExecution items 跟踪。

**可确认标识：** `read_thread_terminal`, `process/spawn`, `process/writeStdin`, `process/resizePty`, `process/kill`, `thread/backgroundTerminals/clean`。

**边界：** 进程/PTY RPC 是客户端—app-server 协议，不自动等于同名模型工具；模型自身 exec 工具由 agent runtime 另行提供。

- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `3147869`，检索 `class extends l.Pt{terminalManager`。
- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9577430`，检索 `async function bac(`。
- `webview/assets/local-conversation-background-terminal-signals-fd5100925793.js`，UTF-8 解码字符 offset `418`，检索 `commandExecution`。

### 18. 子代理的原生状态与会话面板

本地和 ChatGPT Work 分别具有 subagents panel；展示 active/done/waiting/failed、任务/最终答复、模型/推理档位、实时经过时间；本地可打开子代理 transcript，是否可交互由 canInteract 决定。

**可确认标识：** `LocalConversationSubagentsPanelTab`, `ChatGPT subagents`, `canInteract`, `startedAtMs`。

**边界：** 面板不是 spawn_agent 工具定义。原生多代理运行时 schema 不在所复制 Rust 二进制内，本地只能确认其显示/协议集成。

- `webview/assets/local-conversation-subagents-panel-tab-ce6f0d615e69.js`，UTF-8 解码字符 offset `1388`，检索 `canInteract`。
- `webview/assets/local-conversation-subagents-panel-tab-ce6f0d615e69.js`，UTF-8 解码字符 offset `6761`，检索 `startedAtMs`。
- `webview/assets/chatgpt-subagents-panel-e7913e8a5ec3.js`，UTF-8 解码字符 offset `7134`，检索 `delegatedTask`。

### 19. 会话生命周期、追加、停止、排队

客户端支持 turn/steer、turn/interrupt、thread/queue 的 add/delete/reorder/start/update；critical 请求有独立优先级；停止逻辑包含后台终端清理及子代理 descendant interruption。

**可确认标识：** `turn/steer`, `turn/interrupt`, `thread/queue/add`, `thread/queue/delete`, `thread/queue/reorder`, `thread/queue/start`, `thread/queue/update`。

**边界：** RPC 存在不能直接推断任意网络故障下保证成功；本调查未执行交互测试。

- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `556105`，检索 `sendInterruptRequest:`。
- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3229029`，检索 `ypn=new Set(`。
- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `853669`，检索 `interruptSubagentDescendantsInBackground`。

### 20. 会话回退与文件工作树管理区分

用户消息编辑可能按版本调用 thread/revert(beforeTurnId) 或 thread/rollback(numTurns)，然后以 edit_user_message 触发新回合。文件隔离/保存/恢复由 worktree 工具管理，archive 保存可恢复快照。

**可确认标识：** `thread/revert`, `thread/rollback`, `edit_user_message`, `create_worktree`, `archive_worktree`, `restore_worktree`。

**边界：** 不把 conversation rollback 等同于任意外部副作用或全部文件自动撤销。

- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `670762`，检索 `beforeTurnId:c.turnId`。
- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9540001`，检索 `Knc={name:`。

### 21. 自动化与线程 heartbeat

automation_update 支持 view/create/update/delete/suggested；heartbeat 默认延续当前线程，cron 另起项目任务；保留通知偏好与 id，用结构化参数；客户端 app context 明确引导先查工具。

**可确认标识：** `automation_update`, `heartbeat`, `cron`, `notificationPolicy`。

- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3897756`，检索 `Y$n=`automation_update``。
- `.vite/build/src-BJv5Mk7n.js`，UTF-8 解码字符 offset `1325642`，检索 `### Automations`。

### 22. 浏览器与 Computer Use 插件边界

包含内置浏览器 feature、external browser、Computer Use、统一 cua_repl 插件和 Node runtime 定位；旧 Chrome getTabContext(tabId) 返回带选区的文本/受支持页面上下文，文档可保存临时文件，屏蔽 masked input。

**可确认标识：** `cua_repl`, `unified-computer-use`, `getTabContext`, `CODEX_BROWSER_USE_NODE_PATH`。

**边界：** cua API 完整定义由插件首调用动态文档给出；未读全部 bundled plugin，不能从 UI feature 声称全量 API。

- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3602304`，检索 `_J=`getTabContext``。
- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `91510`，检索 `CODEX_BROWSER_USE_NODE_PATH`。
- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `67476`，检索 `inAppBrowserUseAllowed`。

### 23. 语音、转接与屏幕上下文

旧样本定义 end_realtime_voice_call、transfer_voice_call、capture_screen_context；按平台与语音状态配置，capture 只在 active voice chat 中使用。

**可确认标识：** `end_realtime_voice_call`, `transfer_voice_call`, `capture_screen_context`。

**边界：** 旧样本 capture 描述为 macOS，当前 Windows 工具说明有差异；以当前已暴露工具描述为准。

- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `5632367`，检索 `kni=`end_realtime_voice_call``。

### 24. 窗口、文件/浏览器/终端/Review 的模型入口

open_in_codex 给模型可调用的展示入口，target union 受 available tab kinds 影响；navigate_to_codex_page 负责导航；read_thread_terminal 负责读取终端。

**可确认标识：** `open_in_codex`, `navigate_to_codex_page`, `read_thread_terminal`, `compile_latex_document`。

**边界：** 打开与读取是不同工具/通道；旧样本 LaTeX 是 standalone，当前会话已扩展 project 支持，不混为同一版本。

- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `5923672`，检索 `function nIa(`。
- `webview/assets/app-initial-b8e1c8014bb4.js`，UTF-8 解码字符 offset `9541722`，检索 `trc={name:`。

### 25. 返回结果、工具来源和追踪

工具调用保存 namespace/tool、callId/threadId/turnId，并可返回 structuredContent；artifact 创建带 provenance；RPC telemetry registry 列出 153 个方法及类别，反映控制面跨度。

**可确认标识：** `structuredContent`, `agent_provenance`, `callId`, `turnId`, `threadId`。

**边界：** 153 是静态观测到的 RPC 分类表条目数，不是 153 个模型工具，也不是服务器实际可用 RPC 全集。

- `.vite/build/main-BklS_2Y2.js`，UTF-8 解码字符 offset `308232`，检索 `method:n.w(`tools/call`)`。
- `webview/assets/app-shared-737655e1fb23.js`，UTF-8 解码字符 offset `3222691`，检索 `tpn={`。

## 66 个恢复出的具名定义：逐项清单

下面只说明样本内存在的定义。是否暴露给模型还要经过注册器 Eac、线程启动类型、host 能力、账号、平台和功能开关。Chrome getTabContext、plugin_management.uninstall_plugin 与专用引导工具不可统称为普通 codex_app 可用工具。

### 辅助界面（1）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `fire_confetti` | 窗口庆祝效果；只在用户要求或已有明确偏好时调用。 | 可选样式配置（原始 schema 见 JSON）。 |

### 窗口与展示（3）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `open_in_codex` | 在 Codex 面板打开文件、浏览器、终端或 Review；可用 target 种类按环境过滤。 | target、placement；打开结果不等于读取内容或编译成功。 |
| `navigate_to_codex_page` | 把主窗口导航到指定任务/聊天。 | threadId。 |
| `compile_latex_document` | 旧版工具编译 standalone .tex 并返回诊断；与终端 TeX 安装无关。 | path；当前版已扩展项目模式，勿混用版本。 |

### 引导/特定环境（7）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `complete_conversational_onboarding_task` | 报告插件引导任务最终成功或未完成结果。 | outcome、output；成功分支要求 url。 |
| `complete_sidebar_onboarding_checklist_task` | 报告 sidebar checklist 任务完成情况。 | outcome=completed/not_completed。 |
| `setup_codex_step` | 推进 native setup 的角色/任务/完成阶段。 | step 等结构化参数；专用 onboarding。 |
| `request_option_picker` | 引导中请求单选/多选。 | 问题、选项与选择模式；专用 onboarding。 |
| `request_onboarding_input` | 请求 1–3 条结构化引导问题。 | questions[{id,header,question,options}]；至少两个选项。 |
| `request_environment_input` | 环境设置流程中等待用户配置决策。 | 结构化问题/选项 schema；不等于通用提问工具。 |
| `finalize_environment` | 完成 simulated cloud environment setup 并写入 prototype 环境列表。 | 环境配置 schema；源码明确是模拟/原型，不能当正式生产能力。 |

### 设置与账号（5）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `check_app_update` | 检查已配置渠道上的应用更新，不下载安装。 | 无参数；只有 up_to_date 才确认无可用更新。 |
| `read_settings` | 读取有效设置与允许访问的机器可读定义，可包含当前任务配置。 | include_config 等；原始 JSON Schema 见 JSON。 |
| `write_settings` | 修改支持的 app settings/config.toml 设置。 | settings/config 等结构化参数；仅支持定义中的设置。 |
| `get_usage_limits` | 读取已登录 ChatGPT 账号用量、额度与重置。 | 无参数；是账号共享额度。 |
| `consume_usage_reset` | 使用一次已有额度重置，要求每次明确确认。 | 用户确认参数与 schema 见 JSON；不用于自动绕过限制。 |

### 任务附件（3）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `attach_artifact` | 把已创建/正在处理的 PR 关联到当前任务。 | artifact_type=pull_request、url。 |
| `list_artifacts` | 列出当前任务关联 PR、活动及归档工作树等。 | 无参数；返回 type/identity/payload/created time，旧 host 能力有差异。 |
| `remove_artifact` | 解除 PR 关联；不关闭或删除 PR。 | artifact_type=pull_request、url。 |

### 工作树（5）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `create_worktree` | 在当前 host 创建并关联工作树；子代理关联至顶层任务；支持异步状态。 | ref、sourceRoot、allowAsync；返回路径或 operationId。 |
| `attach_worktree` | 关联已有 managed worktree，复用现有文件。 | path；返回路径或 operationId。 |
| `get_worktree_creation_status` | 读取 preparing/creating/registering/completed/failed 及 Git 阶段。 | operationId；阶段百分比不等于总体百分比。 |
| `archive_worktree` | 先保存可恢复 Git 快照，再移除工作树；保护固定/共享等工作树。 | root、pullRequestIdentityKeys。 |
| `restore_worktree` | 从当前任务归档恢复原路径与快照。 | root；恢复为 detached HEAD，原未提交变动进入快照 commit。 |

### 项目与主机（4）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `list_hosts` | 列出本地主机和可用 remote hosts，以及批准的 workspace roots。 | 无参数；含 currentHostId。 |
| `move_thread_to_project` | 移动聊天到已有项目或解除本地项目归属。 | threadId、projectId（可空）、source、hostId、beforeThreadId。 |
| `create_project` | 创建本地/远程项目；须先确认 host 与允许访问根目录。 | 名称、路径及 host 等；具体类型原始 schema 见 JSON。 |
| `list_projects` | 列出 local/remote/ChatGPT 项目及是否 Git 仓库。 | 无参数；返回用于 create_thread 的 projectId。 |

### 侧栏组织（11）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `update_sidebar_preferences` | 修改聊天/固定项排序及按项目、连接或列表分组。 | sorting、grouping；省略字段不改动。 |
| `create_sidebar_section` | 新建自定义侧栏分组。 | name。 |
| `rename_sidebar_section` | 重命名已有侧栏分组。 | sectionId、name。 |
| `delete_sidebar_section` | 删除分组，保留其中聊天与项目。 | sectionId。 |
| `move_project_to_sidebar_section` | 将项目移动到固定、自定义或默认分组。 | projectId、sectionId。 |
| `move_thread_to_sidebar_section` | 移动聊天到分组，并可指定相邻顺序。 | threadId、sectionId、beforeThreadId、source、hostId。 |
| `reorder_section` | 对某分组全部聊天排序，项目位置保持。 | sectionId、完整无重复 threadIds。 |
| `reorder_sidebar_projects` | 调整默认项目区中指定项目顺序。 | projectIds。 |
| `reorder_sidebar_sections` | 调整自定义与选定内建分组顺序。 | sectionIds。 |
| `get_thread_emoji` | 读取聊天图标 emoji。 | 可选 threadId，默认当前任务。 |
| `set_thread_emoji` | 设置或清除聊天 emoji。 | 可选 threadId、emoji（可空）。 |

### 聊天管理（14）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `create_thread` | 创建用户可见的新任务；支持项目、本地无项目、ChatGPT cloud。 | prompt、target、可选 title/model/thinking；返回 threadId 或 pending clientThreadId。 |
| `send_message_to_thread` | 向已存在聊天发后续提示，须有人类明确授权。 | threadId、prompt、可选 hostId/model/thinking；不是原生子代理消息工具。 |
| `fork_thread` | 复制 Codex 任务历史，可在同目录或新 worktree。 | 可选 threadId/environment；返回 threadId 或 pending clientThreadId。 |
| `list_threads` | 列出 pinned 与 recent chats，含来源、状态、项目及摘要。 | limit；旧样本与当前 history 参数不同。 |
| `list_archived_threads` | 分页列出归档 Codex 或 ChatGPT 聊天。 | source、hostId、cursor、limit。 |
| `read_thread` | 分页读取状态、回合摘要及可选工具输出。 | threadId、hostId、cursor、turnLimit、includeOutputs、maxOutputCharsPerItem。 |
| `wait_threads` | 等待至多 8 个任务之一完成/需关注；游标去重。 | targets[{threadId,hostId,afterCursor}]、timeoutMs；0 为即时快照。 |
| `set_thread_pinned` | 设置/取消固定。 | threadId、pinned、source。 |
| `set_thread_archived` | 归档/恢复任务，可默认当前任务。 | archived、threadId、source、hostId。 |
| `set_thread_title` | 修改任务标题。 | title、可选 threadId/source。 |
| `set_thread_read_state` | 标为已读/未读；ChatGPT 状态可能只在当前窗口。 | threadId、read、source、hostId。 |
| `handoff_thread` | 迁移另一任务的 checkout/worktree，可条件启用跨 host。 | threadId、可选 destinationHostId/followUpPrompt；返回 operationId/revision。 |
| `get_handoff_status` | 等待 handoff 状态 revision 更新。 | operationId、afterRevision、waitMs（最多 60000）。 |
| `share_thread` | 创建当前或可访问任务的不可变分享链接。 | 可选 threadId/hostId 等；原始 schema 见 JSON。 |

### 原生办公（4）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `connect_spaces_artifact` | 把已有云端 Sheet/Slide deck 连接到 Artifact Session。 | page_id；返回 metadata 与 artifact_session.artifactRef，要求写权限。 |
| `create_spaces_artifact` | 创建并保存空云端表格/幻灯片，返回 Page metadata。 | artifact_type、title、UUID idempotency_key、destination；重试复用同 key。 |
| `read_page_reference` | 读取 Page 引用的可访问图片/文本/visualization 源码。 | page_id、reference；≤10 MiB 图片或 ≤256 KiB UTF-8；不执行 HTML。 |
| `load_workspace_dependencies` | 发现本地 bundled Node/Python/办公库及明确使用说明。 | 无参数；返回运行时指令，关闭/未安装则返回失败。 |

### 终端与浏览器（2）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `read_thread_terminal` | 读取当前线程 app terminal 的 cwd/shell/buffer。 | 无参数；未连接 terminal 时返回不可用。 |
| `getTabContext` | 旧 Chrome 扩展页上下文读取；文本、选区、受支持 YouTube captions。 | tabId；返回纯字符串或临时文件路径，masked inputs 遮蔽。 |

### 插件管理（1）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `uninstall_plugin` | 移除用户明确要求卸载的 Codex 插件。 | plugin（名称或精确 ID）；歧义时要求选择准确 ID。 |

### 运行状态（1）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `update_running_summary` | 更新当前 turn 的短运行摘要。 | status/摘要结构见 JSON；属于特定 UI pill 场景。 |

### Review 特定环境（1）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `record_private_review` | 专用 PR review chat 记录开始/完成及检查结果。 | begin/完成分支 schema；不在普通聊天随意使用。 |

### 语音特定环境（3）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `end_realtime_voice_call` | 按用户明确要求结束语音。 | 无参数。 |
| `transfer_voice_call` | 把语音移至另一任务，或返回先前任务。 | threadId/hostId/context 或 return=true/context。 |
| `capture_screen_context` | 仅 active voice 读取当前画面上下文；平台能力不同。 | 无参数；此旧样本 macOS 描述不代表 Windows 当前行为。 |

### 自动化（1）

| 工具名 | 用途与约束 | 参数 / 返回要点 |
| --- | --- | --- |
| `automation_update` | 创建/修改/查看/删除定时任务；heartbeat 默认续当前聊天，cron 独立运行。 | mode、kind、id/name/prompt/rrule/status、notificationPolicy 等分支 schema。 |

## bundled 插件槽位

`codex-app-tools`、`browser`、`unified-computer-use`、`chrome-dev`、`chrome-internal`、`chrome`、`computer-use`、`messages`、`record-and-replay`、`computer-history`、`latex`、`notebook`、`code-review`、`deep-research`、`visualize`。

配置说明了 installWhenMissing、hidden、excludeFromExecutor、installWhenMissingRequiresOptIn、userUninstallable、mcpServerName 等策略。因此“插件被打包”“插件已安装”“模型可调用”是三个状态。技能还通过 skills/list、plugin/skill/read 读取；MCP 通过 tools/list 和状态变化发现工具；App/Connector 又有账号和授权状态。

## 153 个客户端 RPC：逐项索引

这是 app-shared-737655e1fb23.js 中 tpn 分类表的可观察完整提取。它用于通信/调度/遥测分类，既非服务端支持全集，也非模型工具清单。具体参数需要 app-server 类型定义或运行时 schema，不能从方法名推测。

- **account（13）**：`account/gatewayOAuth/read`、`account/gatewayOAuth/login`、`account/gatewayOAuth/cancel`、`account/login/cancel`、`account/login/start`、`account/bedrock/discover`、`account/bedrock/setup`、`account/logout`、`account/rateLimitResetCredit/consume`、`account/rateLimits/read`、`account/read`、`account/usage/read`、`getAuthStatus`。
- **apps（3）**：`app/list`、`app/installed`、`app/read`。
- **collaboration_modes（1）**：`collaborationMode/list`。
- **command（1）**：`command/exec`。
- **config（5）**：`config/batchWrite`、`config/mcpServer/reload`、`config/read`、`config/value/write`、`configRequirements/read`。
- **filesystem（10）**：`environment/info`、`fs/copy`、`fs/createDirectory`、`fs/getMetadata`、`fs/readDirectory`、`fs/readFile`、`fs/remove`、`fs/unwatch`、`fs/watch`、`fs/writeFile`。
- **features（3）**：`experimentalFeature/enablement/set`、`experimentalFeature/list`、`rollout/compress`。
- **external_agent_config（3）**：`externalAgentConfig/detect`、`externalAgentConfig/import`、`externalAgentConfig/import/readHistories`。
- **feedback（2）**：`feedback/upload`、`interactive/session/upload`。
- **fuzzy_file_search（4）**：`fuzzyFileSearch/sessionStart`、`fuzzyFileSearch/sessionStop`、`fuzzyFileSearch/sessionUpdate`、`fuzzyFileSearch`。
- **hooks（1）**：`hooks/list`。
- **interactive_sessions（3）**：`interactive/liveSessions/list`、`interactive/sessionSandbox/list`、`interactive/sessionSandbox/read`。
- **marketplace（3）**：`marketplace/add`、`marketplace/remove`、`marketplace/upgrade`。
- **mcp（6）**：`mcpServer/oauth/login`、`mcpServer/event/stream/start`、`mcpServer/event/stream/stop`、`mcpServer/resource/read`、`mcpServer/tool/call`、`mcpServerStatus/list`。
- **memory（2）**：`memory/reset`、`memory/status`。
- **mock（1）**：`mock/experimentalMethod`。
- **models（2）**：`model/list`、`modelProvider/capabilities/read`。
- **permissions（1）**：`permissionProfile/list`。
- **plugins（12）**：`plugin/install`、`plugin/installed`、`plugin/list`、`plugin/read`、`plugin/reconcile`、`plugin/search`、`plugin/share/delete`、`plugin/share/list`、`plugin/share/save`、`plugin/share/updateTargets`、`plugin/skill/read`、`plugin/uninstall`。
- **process（4）**：`process/kill`、`process/resizePty`、`process/spawn`、`process/writeStdin`。
- **thread（53）**：`project/create`、`project/delete`、`project/import`、`project/list`、`project/move`、`project/read`、`project/update`、`thread/approveGuardianDeniedAction`、`thread/archive`、`thread/backgroundTerminals/clean`、`thread/compact/start`、`thread/delete`、`thread/fork`、`thread/goal/clear`、`thread/goal/get`、`thread/goal/set`、`thread/inject_items`、`thread/items/list`、`thread/list`、`thread/loaded/list`、`thread/memoryMode/set`、`thread/metadata/update`、`thread/attachment/add`、`thread/attachment/list`、`thread/attachmentOwner/list`、`thread/attachment/remove`、`thread/name/set`、`thread/queue/add`、`thread/queue/delete`、`thread/queue/list`、`thread/queue/reorder`、`thread/queue/start`、`thread/queue/update`、`thread/read`、`thread/resume`、`thread/revert`、`thread/rollback`、`thread/search`、`thread/searchOccurrences`、`thread/section/move`、`thread/settings/update`、`thread/shellCommand`、`thread/start`、`thread/startAeon`、`thread/stop`、`thread/timeline/list`、`thread/turns/list`、`thread/unarchive`、`thread/unsubscribe`、`threadSection/create`、`threadSection/delete`、`threadSection/list`、`threadSection/update`。
- **remote_control（7）**：`remoteControl/client/list`、`remoteControl/client/revoke`、`remoteControl/disable`、`remoteControl/enable`、`remoteControl/pairing/start`、`remoteControl/pairing/status`、`remoteControl/status/read`。
- **review（1）**：`review/start`。
- **skills（3）**：`skills/config/write`、`skills/extraRoots/set`、`skills/list`。
- **turn（4）**：`turn/interrupt`、`turn/settings/update`、`turn/start`、`turn/steer`。
- **windows_sandbox（2）**：`windowsSandbox/readiness`、`windowsSandbox/setupStart`。
- **conversation_summary（1）**：`getConversationSummary`。
- **git（1）**：`gitDiffToRemote`。
- **initialization（1）**：`initialize`。

## 对 Aether 调研的直接启发

1. 为每项自家生态能力分别记录：用户界面入口、前端 bridge、后端 handler、运行时可用性、模型注册名、inputSchema、description、skill 指导、输出结构、继续操作方式。不能只盘点菜单和 IPC。
2. 核对每次真实请求实际发送给模型的工具集和 system/developer 内容，而不仅检查配置文件“写了工具”。Work、Code、子代理、恢复会话、远端环境可能走不同装配路径。
3. 工具描述必须告诉模型什么时候用、参数怎么取、失败怎么处理，以及下一步如何消费结果。create_spaces_artifact 的幂等创建和 exact artifactRef 回流是可直接对照的例子。
4. 提供可查询的真实环境：工作目录、host、可用运行时与办公库、已启动终端、打开产物、已安装技能/MCP/账号。缺失能力要真实返回，不让模型猜环境。
5. 用工具调用与事件链验证闭环：选区→附件上下文→工具调用→实际原生文档→显示→继续编辑；停止/追加/重试也必须贯通引擎和客户端。

以上是研究建议，未修改 Aether 产品实现，也未执行 Codex 二进制或读账号凭据。性能、交互可用性与所有功能的当前启用状态均需后续专门验证。
