# Code 模式移除：现状复核与执行计划

> **本报告中的迁移路线已被用户的新前提替代。** 用户于 2026-11-11 明确：项目尚未发布，Code 模式数据均可清理；源码编辑等能力不作为移除前置。当前执行方案见 [Code 模式直接移除计划](code-mode-removal-plan-2026-11-11.md)。下文保留源码调查证据，其历史兼容、数据迁移及完整 IDE 对齐要求不再作为执行门槛。

调研日期：2026-11-11。读取基线：`827734f` 加当前工作区未提交修改。范围：Aether 当前源码、现存测试、11 月 4–6 日相关评估，以及同级 `ai-agent-engine` 的执行协议。本文新增调研文档，没有实施模式移除、数据迁移或业务代码修改。

## 1. 结论与推荐范围

**推荐统一为 Work 入口，但现在不能直接删 Code subtree。** 当前主要阻断已经从“Work 缺大多数工程工具”，收敛为：可写文档及恢复、LSP/问题导航、统一命令路由、旧会话与队列接管，以及 Code 完全不挂载的验收。

实施目标应分成三件事，分别放行：

1. **入口统一**：Work 成为唯一用户工作台，工程工具按任务可达。
2. **外壳移除**：删除 Code 布局、模式切换及其重复的 UI 状态管理。
3. **兼容层退役**：最后才评估旧存储、Code queue owner 与协议字段能否退出。引擎 `code` tool profile 不纳入本轮默认删除范围。

推荐路线是“**单一 Work 界面 + 显式任务身份 + 旧 Code 执行兼容**”。历史会话沿用原 sessionId 和服务端记录；迁移目录索引、草稿、恢复数据和打开路由。没有必要为了换界面复制整份引擎历史，也不能给旧 UUID 加 `work-` 前缀。

旧评估 [Code → Work 功能对齐与单工作台迁移评估](code-work-mode-parity-2026-11-04.md) 的边界原则仍适用，但其功能矩阵已部分过时。本文以当前源码重新判定；旧验收数量只作为历史专项证据，不累计为本轮通过数。

## 2. 当前能力：哪些已迁入，哪些仍会消失

| 能力 | 当前判定 | 证据与移除影响 |
|---|---|---|
| 文件新建、目录新建、改名、剪切复制粘贴、删除、多选 | 已有 Work 路径 | `WorkWorkspacePanel.tsx:426,603,618,663,710`；绑定会话 target，应保留并回归。不能继续列为整体缺失 |
| 文件拖拽移动、文件操作撤销 | 尚有差距 | Code `ExplorerView.tsx:1161,1261` 有实现；Work 文件树没有同等 pointer 拖拽和 Ctrl+Z 文件操作链路。逐项迁移或明确退休 |
| 项目全文搜索、替换预览与实际写入 | 已有 Work 路径 | `WorkWorkspacePanel.tsx:753,766`、`WorkWorkspaceSearch.tsx:33`、`work-search-controller.ts:81,120`；当前搜索走引擎 `/workspace/search` |
| 自由交互 PTY | 已有 Work 路径 | `WorkTerminalPanel.tsx:162` 直接挂共享 `TerminalView`，显式传 `sessionId/cwd/active`；不是只有 AI 命令输出 |
| Git | 已有共享核心 | `WorkGitPanel.tsx:144,147` 挂共享面板及 Work diff，自建任务 store；保留底层 Git client、写操作保护和同步 |
| 代码索引 | 已有 Work 路径 | 共享 `ComposerOptions.tsx:372` → `ComposerCodegraphRow.tsx:12`；11/06 有专项验收 |
| Office/PDF、媒体、Markdown、源码预览 | 已有共享核心 | `WorkArtifactPanel.tsx:432,451`；共享 FilePreview、Monaco、worker 与主题继续保留 |
| 可写文本编辑、保存、脏状态、撤销栈 | **未闭环，P0** | `WorkCodePreview.tsx:41` 明确 `readOnly: true, domReadOnly: true`；Work 文件上的保存动作是下载或保存副本，不是缓冲区写回 |
| 未保存编辑恢复、外部改动冲突 | **未闭环，P0** | `editor-recovery.ts:53–54`、`document-sync.ts:34` 排除 sessionFileTarget。工作目录恢复不等于编辑草稿恢复 |
| LSP、问题面板与跳转 | **未迁入正确 owner，P0** | `core/lsp/lifecycle.ts:30` 用全局 workspace 根；`ts-client.ts:27` 排除 sessionFileTarget。Work 的 `aether-work-preview` URI 不会因此获得 LSP |
| Quick Open / Ctrl+P | **缺 Work 等价路由** | `QuickOpen.tsx:129,227` 用 Code workspace 和 editor-store；资源树名称过滤不能覆盖项目快速打开与 `文件:行:列` |
| 编辑器分组、标签及高级编辑动作 | 尚需能力清单 | 现有 Code `EditorArea`/editor-groups 不等于 Work 资源标签。保留哪些效率动作，应在移除前逐项确定 |
| 菜单、快捷键、用户键位 | **路由未统一，P0** | `app-mode.ts:37` 的白名单屏蔽 Work 中许多 Code 命令；直接放开会命中旧 store。应保持旧 ID 兼容并替换动作目标 |
| 引擎原始日志 | 缺可达替代 | `OutputView.tsx:8–14` 依赖 Code 输出面板；Work 监控不是日志浏览和启动失败诊断的完整替代 |
| 会话历史、草稿、资源与队列接管 | **未实施，P0** | 当前 Work ID 规则、目录发现及持久 owner 都不支持直接塞入旧 Code 会话，详见第 4 节 |

11/06 的项目搜索报告 [work-project-search](work-project-search-2026-11-06.md) 已明确替代早期前端遍历方案，不能继续按旧实现评估容量与请求数。该报告记载 106 项相关专项通过；[代码索引验收](work-codegraph-acceptance-2026-11-06.md) 记载 31 条契约和 4 项窗口测试；[工作目录恢复](work-workspace-recovery-2026-11-06.md) 记载 24 条桌面专项。这些是当时的证据，部分对应 spec 在本次工作区已不存在，必须重新建立可复现入口。

## 3. 外壳与共享基础的删除边界

### 满足放行条件后可删除

- `Workbench.tsx` 中 Code 的 ActivityBar/Sidebar/EditorArea/PanelArea/ChatPanel/StatusBar 布局与 Code 分隔条计算。
- `MenuBar.tsx` 中模式切换、`aether.mode.*`、Code 菜单及专属布局入口。
- `code-pane-budget` 及仅服务该布局的样式和记忆。
- 已移交完成且没有其他调用者的 Code UI 组件及专属注册。

这是一份候选边界，不是可整目录删除清单。部分宿主还导出业务动作，例如 EditorArea 的关闭标签操作，须先迁移调用关系。

### 必须保留或先拆分

- `contrib/index.ts:68` 混合注册 Code 视图、编辑器、浏览器、引擎、终端和设置命令。先拆成共享注册、Work 注册、旧 Code 兼容注册，不能整删。
- `contrib/chat` 同时承载共享输入、消息、附件、引用、模型/思考偏好、工具结果与 Work 组件依赖。目录名不能作为删除依据。
- Monaco、语言/worker 初始化、主题归一化、FilePreview、Office/PDF/媒体、FileTreeView、SearchPanel、Git client、TerminalView/terminal-store、浏览器与账号能力继续保留。
- 命令注册、快捷键派发、CommandPalette、确认框、toast、设置和主题保持独立初始化。
- 旧存储 reader、Code queue IPC/owner、browser presentation 的旧字段暂留兼容；待各自迁移和协议验收后再减。

### 隐藏 Code 的副作用要单独拆

`ModeSurface.tsx` 持续渲染 children，切到 Work 只是隐藏 Code。现有“Work 下通过”仍可能依赖 Code 的挂载、注册与请求。

- `Workbench.tsx:46–47` 在父级启动文件监听与编辑草稿恢复；只删 Code section，它们仍会执行。先接管脏文件数据，再调整生命周期。
- `bootstrap.ts:35` 注册所有贡献；`:41–45` 启动全局 workspace 的 LSP、文件/Git 同步并恢复 lastFolder。不能让已移除界面的旧目录继续决定统一工作台的操作范围。
- Work 自身的预览、终端、Git 已有直接初始化路径；浏览器 wiring 也在 bootstrap。应通过禁止挂载 Code 的测试证明，而不是靠 import 关系推定。

命令策略应从“当前 mode 是否 code”变成“当前上下文是否具备能力且捕获了有效 target”。同一 Ctrl+S/Ctrl+P/搜索/终端动作应只使用激活任务的身份；面板切换后，在途写入不能转向新任务。

## 4. 数据和协议：最危险的四个耦合

### 4.1 WorkTask.id 同时充当 sessionId，并且限制前缀

`work-state.ts:224` 附近只接受 `work-*` 或合法 automation origin。普通 Code UUID 写入 tasks 后，刷新时会被 normalize 过滤。`SessionHistoryView.tsx:183` 一侧发现引擎历史并排除 `work-*`；Work runtime 主要读取自己的本地任务索引，没有完整接管该历史发现路径。

`work-conversation-reference.ts:19–23` 还要求会话已存在当前 source 的 Work tasks 中；因此“旧链接能解析”不代表能打开旧会话。

**建议**：为已核实来源的旧 Code 会话增加明确的 legacy provenance，并允许原 ID 进入 Work 索引。不要伪装成 automation，也不要仅凭 UUID 推断执行 profile。引擎历史、run、turn、change、子代理、审批、附件归属保持原 ID。

### 4.2 UI mode 与 tool profile 不是同一个概念

当前 `core/engine/client.ts:80,386` 根据 AppMode 默认选择 `general/code`；`useChat.ts:1060,1499` 还根据 commandOwner 选择。旧会话被移入 Work 后，现有逻辑可能改变执行语义。

引擎 `../ai-agent-engine/src/api/http/routes/chat.ts:702` 明确要求恢复使用原 tool profile，否则返回 409。两种 profile 还影响工具暴露、执行提示、知识范围与运行策略；不能当成展示标签批量替换。

桌面 `src/main/engine/protocol.ts:53` 的身份校验还要求引擎声明 `code` profile。单改引擎删除它，会使现有客户端拒绝连接。

**建议**：把以下概念拆成显式字段/上下文（这是拟议设计，不是当前已有接口）：

| 概念 | 建议规则 |
|---|---|
| 工作台呈现 | 统一 Work |
| sessionId | 保留原值 |
| origin | 原生 Work、automation、已核实 legacy-code 等 |
| executionProfile | 旧运行保持原 code/general；新 Work 按产品策略创建 |
| queueOwner | 兼容期保持已有持久 owner |
| target | source/account/tenant/session/root/binding generation 的捕获对象 |

当前公开 `shared/root-run.ts:39–52` 的请求配置不暴露 toolProfile，但引擎 `src/storage/root-runs/index.ts:102–107` 的内部持久请求有该字段。接管运行前，应提供安全、权威的 profile/provenance 元信息或等价解析机制；不能从用户可编辑标题、路径和 ID 形状猜。无法核实时可以读历史，但不应自动续跑。

本地 origin/profile 标签只参与展示与路由，不授予执行权限。主进程仍须通过既有 gateway capture 和引擎身份核对确定 tenant、namespace 与实际 scope；旧 Code owner 继续走原 code gateway，不能接受 renderer 随意覆盖 owner/profile。

### 4.3 队列 owner 是持久身份，不能简单改名

`shared/next-turn-queue.ts:6` 的 owner 是 `work | code`。队列 scope 同时含 source/account、tenant、namespace generation、taskId；附件回执也携带这个 scope。两类 owner 从主进程持久队列恢复，并分别校验所属范围。

`next-turn-admission-protocol.ts:79–91` 把 owner 与执行 transport/profile 放入摘要；已认领项保存 frozen wireBody、requestKey、回执与 CAS 修订。只改 owner 或 taskId 会破坏完整性、附件 scope 或重试去重。

**建议**：第一阶段让统一 Work UI 通过适配层查看/编辑允许修改的旧 Code 队列，并继续由原 owner 派发与恢复。pending、dispatching、admission-unknown、accepted/terminal 分别处理；已冻结请求不重新构造。已有运行仅重连和对账，禁止为了迁移重发。

因此 `window.aether.codeQueue`、Code owner 和其主进程恢复逻辑不能随模式按钮一起删。以后若必须迁 owner，应另立有版本、可证明幂等的队列协议迁移项目。

清点还应包括 `aether.code-queue-command.v1:*` 的持久 intent/confirmed ACK（`code-queue-intent.ts:16,54–74`）。它避免“入队已成功、清草稿前刷新”造成重复提交，不能只搬草稿却丢掉该证据。主进程还有默认文件队列与 opt-in native 队列两条存储路径，迁移须识别实际后端，不能只备份其中一个目录。

### 4.4 “导出任务”不是完整备份

Code 草稿在 `contrib/chat/draft-store.ts` 的 `aether:chatDrafts`，含正文、mentions、revision、附件与 attachmentRoot；还有 session-meta、模型/思考选择、编辑恢复键、浏览记忆等。Work 另存 `aether.work.state.v1`。两边不能通过复制一段消息正文完成合并。

Work 当前草稿结构没有与 Code ChatDraft 相同的 revision/入队 ACK 模型。接管必须保留旧修订及其已提交证据，再设计统一草稿协议。`lastSessionId` 也仍被 workspace/browser connection 和远端终端的默认目标使用；先注入明确 session target，再评估删除设置字段。

`work-runtime.ts:1260–1320` 的 exportTask 是用户内容导出，不能覆盖全部工具、交互、run、用量、完整分页归档、队列和本地草稿，也没有完整导入闭环。

优先建立实际触及数据的原始备份、校验及恢复工具。完整引擎备份/导入可另行完善；单纯接管界面时应保持服务端历史原地不动，避免把重写历史变成不必要的前置工程。

## 5. 建议的迁移流程与回滚约束

以下流程尚未实现。

1. **预检与清点**：按稳定 source/account/tenant 分组，分页发现会话；联合本地 metadata、pending session、草稿、编辑恢复项和队列记录。识别 automation、原生 Work、legacy 与未知来源，避免重复导入或误归类。只处理当前已验证身份可访问的范围。
2. **保存原始证据**：快照记录本次实际触及的 localStorage 原值、当前窗口 sessionStorage 中的 pending session、旧/新 schema 版本、数据摘要、迁移 ID、目标修订；另保留队列文件和服务端必要备份。sessionStorage 数据有窗口生命周期，清点必须发生在销毁旧窗口状态前。不在报告里复制消息、凭据或用户文件正文。
3. **准备阶段**：先生成新 Work 索引、草稿映射和恢复计划。保留原 sessionId；名称/置顶/收藏等能映射则映射，无目标字段则保留 legacy metadata，不能静默丢弃。
4. **冲突处理**：目标已有草稿不覆盖；两份用户意图分开保留并可选择。附件保留身份、路径/回执与内容摘要；不能读到的附件明确标记。只有本地路径的旧编辑恢复数据不能自动绑定到某个同路径远端任务。
5. **权威核对**：工作区绑定以引擎为准；session-meta.workspacePath 只作提示。接管运行需核对 run/profile/审批/队列状态；迁移本身不发模型消息、不移动文件、不重绑目录。
6. **发布阶段**：使用版本化目标存储与迁移清单，提交前再次核对原数据修订；新 reader 只使用完整发布的数据。优先用单份版本化目标快照原子发布；确需跨多个 key 写入时，再设计 staging、commit marker 与中断恢复。不能先写 done 标志，再假定剩余写入一定成功。
7. **恢复与重入**：每个 source 和 session 有独立进度；重复执行不生成新 session、不重复 task、不重发队列。远端离线可以延后该 source，保留原始数据和可恢复提示。
8. **回滚**：回滚 reader/入口和必要本地索引，保留迁移后新增内容。已产生的新消息、文件写入和 Git 操作不能通过恢复旧 JSON 倒退；队列只对账，不能把旧快照直接覆盖到仍在运行的派发器。

迁移期间应避免 Code 和 Work 同时写同一草稿槽位。兼容 reader 可以共存，但每份可变用户数据要有明确的写入方和修订检查。旧存储的清理放到独立版本，不与首次接管同时进行。

## 6. 当前验证基线的问题

本次实际执行：

| 检查 | 本轮结果 | 能证明的范围 |
|---|---|---|
| `npm run typecheck` | **通过，exit 0** | Node 与 Web 当前整合工作区的类型检查 |
| `npx playwright test --list --reporter=list` | **失败，exit 1；Total: 0 tests in 0 files** | 默认测试收集入口当前不可用；不是“没有测试” |
| build、Electron 窗口、完整 E2E、迁移演练 | **未运行** | 本次只做调研和测试入口核查，没有形成新的运行验收结论 |

当前 `e2e` 有 112 个 `.spec.ts` 文件，数量不是测试用例数。根目录缺默认 `playwright.config.ts`；package.json 仍通过默认 `playwright test` 启动。默认收集进入 `scripts/__tests__` 和源码 Node 契约测试，导入时执行顶层代码，并遇到手写 loader、依赖顺序和 alias 的收集错误。

其中包括 office-verified-submit 的旧依赖预期、未适配 `@shared/toolkits` 的 loader、SessionTray 的 `@renderer` 解析，以及预览契约对新增 useDocumentContextMenu 的 loader 支持。应先限定 Electron/Playwright 的 testDir/testMatch，再决定哪些 Node 契约独立执行及修复其 loader；不要把所有收集错误都当产品故障。

AGENTS.md 中的 103 条基线及 smoke/lsp/history-replay 文件名无法按当前目录复现；部分 11/06 文档引用的 spec 同样不存在。现存专项配置还处于未跟踪状态，正式基线要随代码一起纳入版本控制。

至少 12 份现存 spec 显式依赖 Code tab、`#mode-code` 或双模式循环。`work-terminal-ui.spec.ts:459–474` 会切到 Code 做隔离对照；`git-commit-notice-ui.spec.ts:41` 的夹具明确容许隐藏挂载的 Code 以 UUID 会话后台读取 Git。它们证明当前双模式场景，不能证明 Code 不挂载。

## 7. 建议按七个可审查变更交付

| 顺序 | 变更范围 | 完成标准 |
|---|---|---|
| 0：恢复可复现测试 | 默认 Playwright 配置、单 worker、诊断 reporter、Node 契约分离、更新真实基线 | `--list` 成功，测试数量和 skip 原因可追踪；旧报告缺失 spec 有明确去向 |
| 1：身份与执行解耦 | origin/profile/queueOwner、任务 target、共享注册与命令上下文 | UUID 不误过滤；原 Code 恢复保持 code；切任务/账号/连接不串操作；不改变既有派发语义 |
| 2：人工编辑闭环 | Work 可写文档、保存、脏状态、冲突、恢复；接入 LSP/问题及 Quick Open | 任务文件编辑→保存→Git diff→终端运行→问题跳转→重启恢复，不借用隐藏 Code |
| 3：历史与草稿接管 | 分页发现、legacy 索引、草稿附件、元数据、旧链接/命令兼容、队列适配 | 原 ID 不变；源数据保留；重复/中断/离线/目标已有数据均可恢复；已确认入队但草稿未清空时退出→迁移→重启，不产生第二次 enqueue 或模型请求 |
| 4：Work 独立宿主演练 | 增加受控 Work-only 启动路径，完全不创建 Code subtree；移交日志及剩余命令 | 无 Code DOM、无无关 Code 会话/后台请求；共享设置、浏览器、AI workbench API 等仍完整初始化 |
| 5：入口与外壳移除 | 正式 Work 默认与唯一入口，删 Code 布局/模式切换/专属注册，迁移双模式测试 | 同一候选构建通过全部移除专项和统一工作台回归；兼容执行层仍可处理旧任务 |
| 6：后续清理 | 根据兼容证据清理旧 reader/样式/无调用组件；单列 profile/队列协议变更 | 有真实数据验证和可用恢复路径；不靠全局搜索替换 code 字符串删除能力 |

步骤 2 与步骤 3 可以在步骤 1 稳定后并行准备；最后在步骤 4 汇合。工作量主要在身份、持久化和回归，不能按删除组件数量估算。当前尚有大量并行未提交变更，应以明确候选构建记录证据，不把后续测试套用到变化后的源码。

## 8. 移除放行矩阵

| 场景 | 必须断言的结果 |
|---|---|
| 完全不挂载 Code | 没有 Code surface 与无关 Code 会话自动创建；设置、模型、浏览器、文档预览、AI workbench API、命令均独立可用 |
| 本地两个任务同路径、远端两个账号同 sessionId、重连 | 缓冲区、文件、Git、终端、草稿、浏览器和迟到响应不越界；在途写入保持原 target |
| 人工编辑 | 实际磁盘保存、失败保留内容、外部改动冲突保护、关闭确认、未保存内容跨重启可恢复 |
| 工程工具 | 搜索预览与实际写盘、Quick Open 行列、LSP 问题跳转、PTY 输入输出/cwd、Git 写入与冲突恢复 |
| 旧会话与长历史 | UUID、多页归档、已归档任务、子代理、引用、用量与消息操作连续；原 ID、run/turn/change 关联不变 |
| 队列与审批 | pending/dispatching/admission-unknown/accepted 分别演练；原 requestKey/frozen body 不重写；审批及恢复 profile 不变化 |
| 迁移异常 | 每个阶段退出、损坏 schema、存储写失败、缺附件、远端离线、重入与目标草稿冲突；原数据仍可读 |
| 回滚 | 旧入口可恢复；迁移后新增用户内容、磁盘/Git 成果保留；没有重发模型请求和覆盖活动队列 |
| 交互与性能 | 深浅主题、窄窗、键盘/焦点、DPR、长历史/大文件、隐藏暂停；不按固定盲等或 DPR=1 写断言 |

验证顺序：修复测试入口 → typecheck → 独立构建 → 迁移纯逻辑/契约 → Work-only 真实 Electron 专项 → 相关完整回归。真实窗口保持 `workers: 1`；手动运行 Playwright 前必须确认候选源码已经 build，使用独立 outDir 和 app entry 时记录其对应关系。失败先读诊断 reporter 的 app-errors，再判断产品或用例。

终端需要探测当前机器的 PTY 能力；不能将历史沙箱失败当作当前机器固定事实。能力缺失要验证准确失败态，记录 skip 或环境能力注记，并明确真实 PTY 交互未验证，不把失败态验证记作交互通过。

## 9. 实施中容易误删的同名概念

| 出现的 code | 本轮处理 |
|---|---|
| 应用模式 AppMode.code | 最终删除展示分支，兼容读取另行保留 |
| toolProfile.code | 保留旧执行语义；是否统一另立协议变更 |
| queue scope owner.code | 兼容期保留持久身份与原派发器 |
| Mention/QueueMention 的 source.code | 表示代码选区引用，应保留 |
| codegraph、code_diagnose、代码高亮与 Monaco | 工程能力，应保留 |
| API 返回的 code 数字、代码语言标识 | 与模式移除无关 |

本次推荐的第一项工程工作是恢复测试入口并建立 Work-only 候选构建，同时设计 session/profile/queueOwner 的显式身份。达到这些条件后，功能补齐、迁移与删外壳才具备可靠的验证基础。
