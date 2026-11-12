# Code 模式直接移除计划

日期：2026-11-11。依据：用户明确项目未发布，现有数据均为测试数据，Code 模式数据允许清理；源码编辑等功能不作为移除的前置条件。

本文替代 [原调研报告](code-mode-removal-research-2026-11-11.md) 中的实施路线。原报告的源码依赖调查仍可参考。本轮只更新计划，没有执行数据清理或业务代码修改。

## 1. 新结论

**可以直接推进 Code 模式移除，不需要先建设旧会话迁移和长期兼容体系。** 产品目标是 Work 成为唯一工作台；保住 Work 已有功能，并彻底去掉隐藏 Code 实例和它的后台副作用。

本次不再要求先把 Work 补成完整 IDE。可写源码、编辑草稿恢复、LSP/问题面板、Quick Open、编辑器分组及 Code 文件拖拽/撤销可单独排期，按实际需要增补。源码只读现状不阻断本次移除。

## 2. 可以从原计划中取消的工作

- Code 历史发现与导入、UUID 接入 Work、legacy-code origin。
- Code 草稿、附件、收藏/置顶等元数据向 Work 的映射与冲突合并。
- 为旧 Code 运行新增执行 profile 元信息及续跑兼容。
- Code 队列向 Work 转换，以及旧 queue owner/IPC 的长期适配层。
- 迁移 staging/commit marker、跨版本降级恢复、完整历史导入导出体系。
- 旧 Code 命令 ID 和用户键位的兼容承诺。
- 在删除前补齐全部人工工程工具的功能对齐要求。

需要保留的是正常工程验证、Work 的任务/账号/连接隔离，以及清理过程中对共享资源的识别。这些不需要发展成历史迁移框架。

## 3. 数据清理范围与顺序

默认清理 Code 数据，Work 现有数据和引擎配置按现有用途保留。一次性开发清理工具即可，不建设发布后的升级迁移系统。

| 数据 | 本次处理 |
|---|---|
| Code 会话、历史、审批、子代理、后台命令与关联回执 | 清理已确认属于 Code 的测试记录；无需迁入 Work |
| Code pending/dispatching/accepted 队列与归档 | 先停止 Code 派发及关联运行，再清理所属 scope；不重发、不转换为 Work owner |
| Code queue intent/confirmed ACK | 随所属队列一起清理，不再保留旧草稿重试语义 |
| Code 草稿、会话元信息、模型/思考偏好、pending session | 清理 Code 对应条目；共享表中保留 Work 使用的条目 |
| Code 编辑恢复、布局、模式记忆、文件树记忆 | 清理 Code 专属键和范围，随后删除 reader/writer |
| Code 浏览器标签、终端与工作台客户端注册 | 关闭或断开所属实例，清理 Code presentation/owner 数据 |
| 附件与缓存 | 删除 Code 独占对象；共享对象按剩余引用处理 |
| 引擎账号、模型、MCP、插件、技能等共享配置 | 保留 Work 仍使用的配置 |
| 会话绑定的项目目录 | 不按会话 root 递归删除项目；仅清理可证明由 Code 独占的测试产物与缓存 |

当前 `src/main/work-next-turn-ipc.ts:19–43` 为 Code 和 Work 使用同一队列根目录；默认文件队列与 native opt-in 后端分别有存储路径。清理应先读取 scope.owner，再删除对应 bucket/记录，不能直接删除整个队列目录。

native 后端还有 `.catalog-registry` 和根目录外的 `.anchor.json` 校验目录集合（`next-turn-queue-catalog-registry.ts:30,97`）。删除 Code catalog 时需要在同一离线维护操作中按登记格式同步更新 registry/anchor，不能只删除目录，导致保留的 Work 队列启动校验失败。

原始 UUID 也不是 Code 数据的充分证据：自动化会话同样可能使用 UUID。清理集合由 Code 会话目录、队列 owner、运行请求及本地记录联合确定，不用“非 work-* 一律删除”代替归属判断。

引擎硬删除会话接口 `DELETE /sessions/:sessionId` 默认还会删除解析到的工作目录（引擎 `routes/conversation.ts:297–325`）。清理历史必须显式传 `keepWorkspace=true`；Code 独占的 scratch/附件另按清单清理，不借会话删除接口顺带删目录。

执行顺序：**阻止 Code 新提交/自动恢复 → 停止所属派发与运行并释放终端/浏览器/worker → 清理 Code 数据 → 删除对应入口、恢复器与协议分支**。等待 dispatcher/IPC/worker 退出后再离线清理 journal；关闭桌面实例不会自动保证远端运行停止，远端 Code 运行也应先取消并核对终态。同一开发版本完成即可，不需要兼容窗口。

## 4. 代码移除范围

### 直接删除 Code 专属部分

- Workbench 中 Code 布局及其 ActivityBar、Sidebar、EditorArea、PanelArea、ChatPanel、StatusBar 宿主。
- 模式切换按钮、Code 菜单、`aether.mode.*` 命令、Code 布局记忆及 pane budget。
- Code ChatView、会话历史界面、专属草稿及恢复入口中已无共享调用的部分。
- Code queue renderer 调用、preload API、IPC handler、主进程 Code owner 与 Code 专属 envelope/intent 逻辑。
- 随 Code 外壳消失且本次不接入 Work 的编辑、问题、大纲和 Quick Open 入口及命令。

### 保留 Work 正在使用的共享能力

- WorkComposer、共享消息/附件/引用/工具组件，以及它们在 contrib/chat 中的依赖。
- Monaco 预览、worker、主题与编辑器显示设置；Office/PDF/媒体预览。
- Work 文件管理、搜索替换、Git、TerminalView/PTY、浏览器及各自的底层服务。
- 引擎连接、账号、模型、资源、插件、技能、自动化、设置、确认框与命令面板。

判断以调用关系和 Work 用户路径为准。`contrib/chat`、`contrib/editor` 不能整体删除；Mention.source 的 `code` 表示代码选区，与旧应用模式无关。

### 移除双模式的运行机制

- Work 直接成为启动工作台，不读取旧 `aether.app.mode` 决定落入 Code。
- 移除 Code ModeSurface；若没有其他用途，再删除双模式 wrapper、订阅与动画逻辑。
- 拆开 contrib 注册，把 Work 仍需的共享初始化保留下来，删除 Code 视图及命令注册。
- 移除 bootstrap 中仅服务旧全局 workspace 的 lastFolder 恢复、LSP 和同步副作用。Work 的会话工作区继续显式管理。
- 删除命令模式白名单，改为保留命令自己的能力与上下文校验。未提供 Work 入口的 Code 命令直接删除，不能放开后继续写旧 store。
- 浏览器、工作台 bridge、终端与请求默认目标直接使用 Work 当前会话，不再回退到 Code lastSessionId。

## 5. 引擎 code profile 的处理

清理旧 Code 数据后，原报告中的“恢复旧运行必须保持 code profile”不再构成阻断。无需为此新增 legacy 元信息或兼容执行层。

推荐本次让桌面存续请求明确使用 Work 所需的 `general` profile，并删除由 AppMode 推导 profile 的分支。主进程 `/meta` 校验也应以 Work 所需能力为准，不再无条件要求引擎支持 code。

引擎是否彻底删除 `code` profile，单独按剩余调用者判断。自动化配置及其他调用方也可使用它；本次移除桌面模式不要求同时改完整引擎协议。保留该引擎能力不意味着保留 Code 界面、队列或旧数据兼容层。

代码工具、codegraph、code_diagnose、代码高亮继续按 Work 的实际使用保留，不因名称含 code 删除。

## 6. 收敛为三个可审查变更

| 变更 | 主要内容 | 完成标准 |
|---|---|---|
| A：清理与停止 Code 路径 | 一次性数据清理、停止所属派发/运行、拆共享注册、确定存续命令 | Code 数据清理集合准确；Work 队列及共享配置正常；没有遗留 Code 自动恢复 |
| B：Work 唯一工作台 | 删除 Code 外壳/切换/专属 IPC 与状态分支，直接接入共享服务，清理命令和样式 | 启动即 Work；Code subtree 从未挂载；没有无关 UUID 会话、旧目录恢复或 Code 后台请求 |
| C：测试与残留收尾 | 修复测试入口、改写双模式测试、清理无调用模块/依赖、检查构建 | typecheck/build 通过；Work 关键路径真实 Electron 回归通过；测试不再依赖隐藏 Code |

测试入口修复与专项用例准备从 A 阶段开始，不等删除完成后才验证。三个变更可以在同一分支连续交付；拆分的目的在于审查清理、外壳与共享依赖是否各自正确。

## 7. 本次真正需要的放行条件

1. Code 完全不挂载，启动、设置、引擎连接、模型和资源初始化仍正常。
2. Work 发消息、流式输出、审批/问答、追加/队列、停止、历史恢复与任务切换正常。
3. Work 文件树、搜索替换、Git、交互终端、浏览器、附件及 Office/PDF 预览保持现有功能。
4. Code 数据清理不删除 Work 队列/会话/共享配置，不误清项目目录；清理后重启不会复活 Code 任务。
5. 任务、账号、引擎切换与迟到响应仍保持正确 owner；旧快捷键不会命中已删除 store。
6. `npm run typecheck`、`npm run build` 与相关 E2E 通过；Electron 测试单 worker，使用本次构建产物，失败检查 app-errors。

不再验收 Code 历史迁入、旧 UUID 在 Work 继续执行、旧队列转换、跨版本回滚及完整 IDE 功能对齐。

上一轮调研的类型检查通过，但默认 Playwright 收集失败且缺默认配置；这是当前测试入口问题。实施时先恢复明确 testDir/testMatch/workers:1 与诊断输出，不沿用过时的通过数量。

## 8. 后续功能独立安排

源码编辑可以从 Work 现有 Monaco 预览按需扩展。是否需要保存/冲突保护、LSP、Quick Open、编辑器分组，由使用需求决定，独立于 Code 模式移除排期。日志入口也可集中到监控或设置，不需要重建旧 Code 底部面板。

本次工程重点是删除重复产品结构、理清 Work 仍使用的共享依赖，以及证明单工作台独立运行。历史迁移与完整 IDE 对齐从本轮范围中移除。
