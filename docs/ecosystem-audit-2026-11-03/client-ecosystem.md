# Aether 客户端生态与能力盘点

日期：2026-11-03。范围：Electron 主进程、preload、React 客户端。此次只进行静态调研，没有修改产品实现、调用模型、启动服务或执行预览性能测试。

核心判断：客户端已经具备很多能力，但客户端有入口、引擎有接口、模型收到工具说明、模型知道如何把结果交付回客户端，是四件不同的事。下面将它们分开记录。不能把 187 个 preload 方法宣称为 187 个 AI 工具，也不能只凭客户端请求中未携带某字段，断言引擎没有注入相应提示。

完整机器可读记录：[client-ecosystem.json](D:/dev/aether-code/docs/ecosystem-audit-2026-11-03/client-ecosystem.json)。其中保留了实现表达式、参数签名、共享类型完整声明以及逐项文件行号。此清单覆盖当前源码登记面与可辨识调用点；动态接口用原始表达式保留，不冒充运行时 OpenAPI 或所有第三方库内部命令。

## 盘点口径

| 项目 | 数量 | 口径 |
| --- | --- | --- |
| 非测试源码文件 | 523 | src 内 .ts/.tsx/.mjs |
| IPC 通道 | 160 | IPC / BROWSER_IPC / WORK_QUEUE_IPC 常量 |
| preload 方法及事件订阅 | 187 | window.aether 下逐项方法；含事件监听 |
| 应用命令登记 | 52 | 应用 command registry；部分不同位置重复登记 |
| Monaco 自定义命令 | 2 | LSP 执行命令、应用 code action |
| 视图登记 | 11 | 含动态 Git 差异视图；另有 1 个文档渲染器 |
| Work 一级入口 | 8 | 工作台 / 项目 / Agent / 成果 / 浏览器 / 自动化 / 连接 / 引擎监控 |
| 设置分区 / 元数据 | 18 / 39 | 元数据用于搜索，数量不等同全部设置控件 |
| HTTP 请求对象出现点 | 170 | 同一接口可能多次出现；含上传与 SSE |
| 主进程 HTTP 调用点 | 36 | fetch 与账号 request 调用；有通用代理，不能与上项直接相加成接口数量 |
| 共享接口/类型声明 | 229 | 完整声明保存于 JSON typeContracts |

## 已确认的能力交付边界

1. **Work 请求使用 general 工具配置。** [src/main/engine/tool-profile.ts:7](D:/dev/aether-code/src/main/engine/tool-profile.ts:7) 定义 X-Aether-Tool-Profile 和 durable 生命周期；[src/renderer/src/core/engine/client.ts:79](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:79) 按当前模式补齐请求配置。不能用 Code 模式的完整工具表推断 Work 当前可见工具。
2. **发送消息有资源选择，没有客户端生态说明字段。** [src/renderer/src/core/engine/chat-send-request.ts:9](D:/dev/aether-code/src/renderer/src/core/engine/chat-send-request.ts:9) 序列化 message、sessionId、agentId、collaborators、model、knowledgeBases、skills、mcpServers、workspacePaths、thinkingMode、subagentModel、utilityModel、memoryScope、attachments。没有预览支持格式、打开成果方式、内置浏览器就绪清单、用户 PTY 标识等字段。引擎可能另行注入系统提示，需要与后端报告联读。
3. **内置浏览器确实有 AI 执行桥。** [src/renderer/src/core/browser/connection.ts:30](D:/dev/aether-code/src/renderer/src/core/browser/connection.ts:30) 在浏览器面板打开之前就可以注册当前会话；Work 使用独立会话覆盖，等待引擎 ready 和有效 session。[src/main/browser-bridge.ts:85](D:/dev/aether-code/src/main/browser-bridge.ts:85) 还检查 aiEnabled 与目标引擎身份。静态存在不等于事故会话当时已连通。
4. **用户终端和 AI 命令任务是两个通路。** [src/renderer/src/contrib/terminal/terminal-store.ts:1](D:/dev/aether-code/src/renderer/src/contrib/terminal/terminal-store.ts:1) 管理 xterm + 本地 node-pty / 远程 WS；[src/renderer/src/core/engine/command-job-store.ts:66](D:/dev/aether-code/src/renderer/src/core/engine/command-job-store.ts:66) 管理引擎 command-jobs 的列表、增量输出和取消。没有找到把 window.aether.terminal 的创建/输入接口直接发布为模型工具的客户端桥，不能据此声称 AI 可以直接控制任意可见 PTY 标签。
5. **成果预览可以打开文件，但不是模型工具 schema。** [src/renderer/src/contrib/work/WorkArtifactPanel.tsx:17](D:/dev/aether-code/src/renderer/src/contrib/work/WorkArtifactPanel.tsx:17) 支持成果读取、刷新、复制、保存副本/原文件、整文件引用/选中片段引用；[src/renderer/src/contrib/chat/open-file.ts:41](D:/dev/aether-code/src/renderer/src/contrib/chat/open-file.ts:41) 承担消息路径到 Work 资源标签 / Code 编辑器的实际打开路由。若模型不知道这条交付约定，容易用手写启动说明替代产品内交付。

## 产物、选区、浏览器恢复的精确链路

**Office / 文档选区进入的是下一条消息正文。** [src/renderer/src/contrib/work/WorkArtifactPanel.tsx:231](D:/dev/aether-code/src/renderer/src/contrib/work/WorkArtifactPanel.tsx:231) 监听 selectionchange，要求 anchorNode 与 focusNode 都在预览容器内。点击引用后，把 selection 与 coverage 交给回调；[src/renderer/src/contrib/work/WorkView.tsx:2339](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:2339) 和 [src/renderer/src/contrib/work/WorkView.tsx:2427](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:2427) 调用 workArtifactSelectionQuote，将“文件名 + 路径 + 选中文字”作为引用段落拼到当前草稿。[src/renderer/src/contrib/work/work-artifact-content.ts:37](D:/dev/aether-code/src/renderer/src/contrib/work/work-artifact-content.ts:37) 区分当前预览、部分预览与历史回执。下一次发送作为 message 文本传入，**不会新增 ChatAttachment**。无选区时则由 [src/renderer/src/contrib/work/work-runtime.ts:1140](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:1140) 生成 source=file 的 Mention，只引用路径。通用 Work 路径没有附加页号/单元格区域坐标这类结构化选区字段；所有格式取字效果需另行实测。

**成果来自写入回执，不从最终回答猜文件。** [src/renderer/src/core/engine/chat-payload.ts:107](D:/dev/aether-code/src/renderer/src/core/engine/chat-payload.ts:107) 根据 payload.fileChange.toolCallId 找到现有 tool activity 并挂上 change。[src/renderer/src/contrib/work/work-state.ts:331](D:/dev/aether-code/src/renderer/src/contrib/work/work-state.ts:331) 只遍历 tool.change：按 change.id 去重、按 seq/createdAt 排序；done 且 success 非 false 标记 ready；正在执行为 draft；其余 unverified；reverted 排除，delete 将既有同路径产物标成 deleted。[src/renderer/src/contrib/work/work-runtime.ts:477](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:477) 缓存派生数组以避免每个文本 token 重建预览。普通 Markdown 文件名不会自动变成已完成成果；用户点击实际链接时 [src/renderer/src/contrib/work/WorkView.tsx:260](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:260) 可生成 path: 的临时资源，通过会话文件接口实际读取。是否所有 shell/Python/第三方工具的写文件都会产生 fileChange，要核对后端，客户端不能自动补出可靠回执。

**浏览器有显示恢复流程，但不是无条件后台交互。** [src/main/browser/service.ts:923](D:/dev/aether-code/src/main/browser/service.ts:923) 在 click/fill/press_key 前检查窗口存在、未最小化、可见；focus 创建 requestId，发 reveal，等待最多 5 秒的最新 bounds ACK。[src/renderer/src/contrib/browser/browser-store.ts:48](D:/dev/aether-code/src/renderer/src/contrib/browser/browser-store.ts:48) 选择目标 tab；[src/renderer/src/contrib/work/WorkView.tsx:329](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:329) 为当前所属 Work task 展开工作区浏览器；[src/renderer/src/contrib/browser/BrowserView.tsx:88](D:/dev/aether-code/src/renderer/src/contrib/browser/BrowserView.tsx:88) 检查几何尺寸、document.hidden、模式、遮挡，再发送带 revealRequestId 的 setBounds。失败返回“尚未执行”以及恢复窗口/关闭遮挡/显示目标页后重试的提示，**没有自动恢复最小化窗口并盲目重放输入**。后台其他任务的 reveal 不会强行切走当前任务，5 秒内不能获得可见面时仍可能失败。scroll 通过目标文档执行，不要求可见：[src/main/browser/service.ts:1132](D:/dev/aether-code/src/main/browser/service.ts:1132)；snapshot 也不依赖窗口焦点。

**新旧浏览器桥并存。** [src/main/browser-ipc.ts:49](D:/dev/aether-code/src/main/browser-ipc.ts:49) 同时实例化 BrowserEngineBridge 与 NativeBrowserHostManager。后者 [src/main/browser/native-host-manager.ts:50](D:/dev/aether-code/src/main/browser/native-host-manager.ts:50) 按 engine/account 宿主注册；GET demands 后建立精确 rootSessionId/rootRunId/ownerRunId 的 v2 client，必须具备 requestWatch、executionIdentity、resultMetadata，支持当前 UI 选择以外的持久根任务。host 轮询在 transient failure 后恢复，404 才重建 host；结果提交失败只释放对应 root client，不重复页面操作。新 host 回传 operationPerformed 元数据；旧 session bridge [src/main/browser-bridge.ts:284](D:/dev/aether-code/src/main/browser-bridge.ts:284) 的 results body 只有 requestId/success/output/error，不能假定它也保留了相同的结构化执行判据。

**尚未找到直接模型桥的 UI 能力（客户端审计范围）。** 通用“在资源/编辑器打开文件”、Office 预览器控制/导出、修改窗口布局、用户 PTY 标签创建/输入/重命名、调用应用命令面板命令、修改应用设置，都没有像 browser 一样的客户端模型执行桥。Git/知识库/技能/MCP/自动化/记忆管理则由客户端调用后端 API；后端可能另有对应模型工具，应与引擎清单逐项映射，不能从 UI 列表下最终结论。

### Native browser host 请求全量补充

以下为原始调用表达式，path 局部变量是 /browser/hosts/{hostId}/demands/{demandId} 或 /browser/clients/{clientId}/requests/{requestId}/state；实际 URI 由当前注册返回值组成。

| 方式 | 路径表达式 | body | options | 证据 |
| --- | --- | --- | --- | --- |
| `'POST'` | `'/browser/hosts'` | `{ protocolVersion: 1, authorityKind: host.transport.authorityKind }` | `—` | [src/main/browser/native-host-manager.ts:139](D:/dev/aether-code/src/main/browser/native-host-manager.ts:139) |
| `'GET'` | `/browser/hosts/${pathId(host.registration.hostId)}/demands` | `—` | `—` | [src/main/browser/native-host-manager.ts:146](D:/dev/aether-code/src/main/browser/native-host-manager.ts:146) |
| `'DELETE'` | `/browser/hosts/${pathId(host.registration.hostId)}/roots/${pathId(demand.execution.rootSessionId)}/runs/${pathId(demand.execution.rootRunId)}` | `—` | `—` | [src/main/browser/native-host-manager.ts:157](D:/dev/aether-code/src/main/browser/native-host-manager.ts:157) |
| `'DELETE'` | `/browser/hosts/${pathId(host.registration.hostId)}` | `undefined` | `{ cleanup: true }` | [src/main/browser/native-host-manager.ts:181](D:/dev/aether-code/src/main/browser/native-host-manager.ts:181) |
| `'POST'` | `path + '/reject'` | `{ execution, demandToken: demand.demandToken, code: 'BROWSER_HOST_SLOT_CAPACITY' }` | `—` | [src/main/browser/native-host-manager.ts:195](D:/dev/aether-code/src/main/browser/native-host-manager.ts:195) |
| `'GET'` | `path + '/state?' + query` | `undefined` | `{ demandToken: demand.demandToken }` | [src/main/browser/native-host-manager.ts:201](D:/dev/aether-code/src/main/browser/native-host-manager.ts:201) |
| `'POST'` | `path + '/client'` | `{ execution, demandToken: demand.demandToken }` | `—` | [src/main/browser/native-host-manager.ts:204](D:/dev/aether-code/src/main/browser/native-host-manager.ts:204) |
| `'GET'` | `/browser/clients/${pathId(root.registration.clientId)}/commands` | `undefined` | `{ client: root.registration, signal }` | [src/main/browser/native-host-manager.ts:218](D:/dev/aether-code/src/main/browser/native-host-manager.ts:218) |
| `'POST'` | `/browser/clients/${pathId(root.registration.clientId)}/results` | `{ requestId: command.requestId, execution, success: result.success, output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null), error: result.error, metadata: result.metadata ?? { code: 'BROWSER_OPERATION_UNCONFIRMED', operationPerformed: 'unknown' } }` | `{ client: root.registration, signal }` | [src/main/browser/native-host-manager.ts:234](D:/dev/aether-code/src/main/browser/native-host-manager.ts:234) |
| `'DELETE'` | `/browser/hosts/${pathId(host.registration.hostId)}/roots/${pathId(root.execution.rootSessionId)}/runs/${pathId(root.execution.rootRunId)}` | `undefined` | `{ cleanup: true }` | [src/main/browser/native-host-manager.ts:258](D:/dev/aether-code/src/main/browser/native-host-manager.ts:258) |
| `'GET'` | `'/chat/status?sessionId=' + pathId(root.execution.rootSessionId)` | `undefined` | `{ signal }` | [src/main/browser/native-host-manager.ts:266](D:/dev/aether-code/src/main/browser/native-host-manager.ts:266) |
| `'GET'` | `path + '?' + query` | `undefined` | `{ client: root.registration, signal: stateSignal }` | [src/main/browser/native-host-manager.ts:286](D:/dev/aether-code/src/main/browser/native-host-manager.ts:286) |

## 功能矩阵

| 能力 | 用户可用功能 | 协议/对象 | 对模型的实际边界 | 证据 |
| --- | --- | --- | --- | --- |
| Work 工作台 | 8 个一级入口；空任务、项目绑定、Agent 管理、成果、浏览器、自动化、连接、引擎监控 | WorkView 导航/面板；任务拥有独立 session | 客户端 UI；模型可见性取决于请求与引擎提示 | [src/renderer/src/contrib/work/WorkView.tsx:141](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:141) |
| 会话发送与恢复 | 流式回复、状态/快照、历史与归档、删除 turn、截断、停止 | POST /chat；GET /chat/stream/status/snapshot；POST /chat/cancel；conversation 路由 | 用户控制面，不等同 AI 可自发操作 | [src/renderer/src/core/engine/useChat.ts:1011](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1011) |
| 运行中追加 / 下一轮队列 | read、reconcile、enqueue、edit-draft、mutate；提交草稿/模型/资源/思考/附件 | WorkQueueRequest(taskId, expectedEngine, action)，版本号/operationId 防止重复提交 | 客户端/主进程队列控制面 | [src/shared/work-next-turn-api.ts:10](D:/dev/aether-code/src/shared/work-next-turn-api.ts:10) |
| 子代理与协作 | 能力发现、运行列表、详情、工具调用详情、事件、取消、对子代理发送消息并读回执 | subagent / collaboration API；run/session/root 身份绑定 | 展示后端代理能力；实际模型工具见引擎表 | [src/renderer/src/core/engine/client.ts:108](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:108) |
| Agent 管理 | 增删改 Agent；systemPrompt/model/temperature/skills/mcp/kb/allowedTools | GET /tools 使用 general 配置；过滤任务计划控制项 | 这是管理已配置 Agent 的 UI，不是自身能力注入 | [src/renderer/src/contrib/work/WorkAgentManager.tsx:391](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:391) |
| 输入引用 @ | file / dir / code / terminal / agent / browser 六种引用 | 代码/浏览器/文本快照转换为 reference 块；普通文件/目录保持路径；Agent chip 生成 collaborators | 显式引用可进 message，普通 @路径 不等于内容已读 | [src/renderer/src/contrib/chat/mention-context.ts:23](D:/dev/aether-code/src/renderer/src/contrib/chat/mention-context.ts:23) |
| 资源选择 / | 选择 skill / mcp / kb；检索；过滤未启用资源 | 列表来自 /skills、/mcp/servers、knowledge bases；当前选择随消息发送 | 资源选择存在；是否加载具体说明由后端负责 | [src/renderer/src/contrib/chat/ResourcePicker.tsx:24](D:/dev/aether-code/src/renderer/src/contrib/chat/ResourcePicker.tsx:24) |
| 文件与工作区 | 选目录/文件、授权根、列目录、读写、创建、重命名、复制、回收站、stat、reveal、watch、导入 | 本地 fs IPC；远程 /workspace 绑定会话与 root；外部文件只读恢复入口 | 客户端可操作磁盘；模型是否有同名工具由引擎决定 | [src/renderer/src/core/workspace/fs-client.ts:72](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:72) |
| 文档与二进制预览 | PDF/DOCX/XLSX/PPTX；图片/视频；文本/Markdown；其他二进制 hex | 格式选择、延迟加载、有界解析和缓存；详见下表 | 主要是用户查看能力；不等于模型文档生成工具 | [src/renderer/src/contrib/documents/document-kind.ts:1](D:/dev/aether-code/src/renderer/src/contrib/documents/document-kind.ts:1) |
| 成果管理 | 成果树、当前文件/历史回执覆盖区分、刷新、引用、保存、源文/预览切换 | 先按会话读取当前文件；失败才显示已注明的回执；Markdown 链接可打开资源 | 文件路径是重要交付契约，客户端会解析并读取 | [src/renderer/src/contrib/work/WorkArtifactPanel.tsx:112](D:/dev/aether-code/src/renderer/src/contrib/work/WorkArtifactPanel.tsx:112) |
| AI 变更管理 | 查询 changes、全部/选中保留、批量回滚、回滚后截断历史 | /changes/keep-all、keep-many、revert-batch；冲突/失败需保留可见状态 | 用户审核控制面；不能混同 Git 历史回滚 | [src/renderer/src/contrib/work/WorkView.tsx:2629](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:2629) |
| Git | 状态/差异、暂存/撤销、提交/amend/undo、分支、远端、同步、merge/rebase/cherry-pick/revert、stash/tag/log/blame、克隆 | 83 个 preload 方法含 onCloneProgress 事件；远程 /git 绑定+动作 | 客户端 Git 能力广；并非 83 个模型工具 | [src/preload/index.ts:282](D:/dev/aether-code/src/preload/index.ts:282) |
| 用户终端 | 多标签、创建/输入/缩放/重连/销毁、复制/粘贴/重命名/清空、输出引用 | 本地 node-pty；远程 terminal/create + WS；身份与原始连接保持绑定 | 目前与 AI command-jobs 为不同管理通路 | [src/renderer/src/contrib/terminal/TerminalView.tsx:168](D:/dev/aether-code/src/renderer/src/contrib/terminal/TerminalView.tsx:168) |
| AI 命令任务 | 运行任务列表、输出分页/增量、取消 | /command-jobs + output + cancel；job/session 归属校验 | 消费引擎命令执行回执 | [src/renderer/src/core/engine/command-job-store.ts:66](D:/dev/aether-code/src/renderer/src/core/engine/command-job-store.ts:66) |
| 内置浏览器 | 用户标签/导航/手机视口/网页共享；AI 打开、读 DOM、截图、点击、填写、网络与控制台 | 19 个 preload 方法；15 个 model action；注册/commands/results/cancel watch | 有明确双向执行桥，需会话注册成功与 aiEnabled | [src/shared/browser-api.ts:22](D:/dev/aether-code/src/shared/browser-api.ts:22) |
| HTML 本地预览 | 当前工作区 HTML/HTM 转本地 HTTP URL；共享相对资源 | BrowserPreviewServer；工作区边界/realpath；公开资源限制；32MB 单资源上限 | UI openFile 是桥方法；模型 browser.open 需可访问 URL | [src/main/browser-preview.ts:41](D:/dev/aether-code/src/main/browser-preview.ts:41) |
| 自动化 | 任务 CRUD、启停、计划预览、运行列表/详情/取消、通知已读 | /cron capabilities/preview/runs/notifications；session binding | UI 具备管理，模型创建能力需看后端工具 | [src/renderer/src/contrib/automations/automation-client.ts:1](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:1) |
| 模型配置 | 模型列表、创建、更新、删除、连接测试、能力检测/定义 | /models CRUD/test/detect-capabilities/capability-defs | 配置控制面；不是任务执行工具 | [src/renderer/src/core/engine/models.ts:1](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:1) |
| 技能管理 | 列表/详情、启用停用、创建删除、导入/分块合并、导入历史清理 | /skills、/skills/imports、chunks/merge | 模型要知道技能目录/触发规则，不能只有设置页面 | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:1](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:1) |
| MCP 管理 | 服务器增删改、启停、测试、导入导出配置 | /mcp/servers 与 /mcp/config；不同 workspace path 查询 | 配置存在与模型当前暴露工具是两层事实 | [src/renderer/src/contrib/settings/McpSettingsView.tsx:1](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:1) |
| 知识库 | 库 CRUD、文档创建/上传/编辑删除、格式表、搜索 | /knowledge/bases/documents/formats/search | 用户资源管理与模型检索工具需对应 | [src/renderer/src/core/engine/knowledge.ts:1](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:1) |
| 记忆 | 记忆列表、节点读写删除、设置/偏好 | /memory/list/nodes/settings/preferences | 后端决定注入范围；客户端可管理 | [src/renderer/src/core/engine/memory.ts:1](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:1) |
| 安全策略 | 读取/设置运行模式；政策列表、单项修改删除、reset | /security/mode/policies | 权限控制面；不能把所有接口无差别开放给模型 | [src/renderer/src/core/engine/security.ts:1](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:1) |
| 语言服务与代码图 | LSP start/stop/send/event、诊断、请求、会话删除；图状态/索引 | 本地 LSP IPC / 远程 LSP API；/codegraph/status/index | 主要编辑器支撑；模型代码工具见后端 | [src/renderer/src/core/lsp/code-actions.ts:209](D:/dev/aether-code/src/renderer/src/core/lsp/code-actions.ts:209) |
| 账号与引擎宿主 | 登录/注册/恢复/外部身份、设备会话；本地运行时导入激活删除、启动停止重启、诊断/日志 | account 14 方法；engine 20；本地/远程身份切换保护 | 用户管理控制面，不应被误算为 AI 自主工具 | [src/preload/index.ts:137](D:/dev/aether-code/src/preload/index.ts:137) |
| 搜索、设置、工作台 | 文件搜索/替换预览；命令面板、快速打开；图形降级；窗口控制 | search 3、settings 7、graphics 3、window 6；18 设置分区 | 客户端通用交互 | [src/preload/index.ts:446](D:/dev/aether-code/src/preload/index.ts:446) |

## 文件格式与预览约定

| 类型 | 支持范围 | 实现/边界 |
| --- | --- | --- |
| 办公与 PDF | pdf、docx、xlsx、pptx | [src/renderer/src/contrib/documents/document-kind.ts:1](D:/dev/aether-code/src/renderer/src/contrib/documents/document-kind.ts:1)；PDF pdfjs、DOCX docx-preview、XLSX ExcelJS worker、PPTX @jvmr/pptx-to-html |
| 图片 | png jpg jpeg gif webp bmp ico avif apng | [src/renderer/src/core/editor/preview.ts:16](D:/dev/aether-code/src/renderer/src/core/editor/preview.ts:16)；平移/缩放/适应窗口；SVG 走文本/源码路径 |
| 视频 | mp4 m4v webm ogv mov | [src/renderer/src/core/editor/preview.ts:27](D:/dev/aether-code/src/renderer/src/core/editor/preview.ts:27)；浏览器原生媒体播放 |
| 文本/代码 | 常规文本与代码；大文本按有界读取/虚拟行显示 | [src/renderer/src/core/editor/TextPreview.tsx:1](D:/dev/aether-code/src/renderer/src/core/editor/TextPreview.tsx:1) |
| Markdown | md markdown mdx | [src/renderer/src/contrib/work/WorkArtifactPanel.tsx:33](D:/dev/aether-code/src/renderer/src/contrib/work/WorkArtifactPanel.tsx:33)；渲染/源码切换 |
| HTML | 工作区 HTML/HTM 可用 browser.openFile 建立 HTTP 预览；应用开发服务需 URL | [src/main/browser-preview.ts:41](D:/dev/aether-code/src/main/browser-preview.ts:41)；远程引擎拒绝本地文件 openFile |
| 其他二进制 | 十六进制前 16 KB | [src/renderer/src/contrib/editor/FilePreview.tsx:65](D:/dev/aether-code/src/renderer/src/contrib/editor/FilePreview.tsx:65) |
| 文档解析边界 | 输入 16MB；解包 64MB；100 页；24 sheet；50000 行；256 列；500000 cells；30秒解析超时 | [src/renderer/src/contrib/documents/document-kind.ts:3](D:/dev/aether-code/src/renderer/src/contrib/documents/document-kind.ts:3)；不能宣称无限文件、任意格式、实测秒开 |

Work 成果预览通过 selectionchange 收集预览区域内选中的文字，再用“引用选中内容”加入对话；完整文件引用只传路径，不把旧写入回执伪装成最新内容。证据：[src/renderer/src/contrib/work/WorkArtifactPanel.tsx:231](D:/dev/aether-code/src/renderer/src/contrib/work/WorkArtifactPanel.tsx:231)、[src/renderer/src/contrib/work/work-artifact-content.ts:37](D:/dev/aether-code/src/renderer/src/contrib/work/work-artifact-content.ts:37)。这证明客户端具有选区回传路径，尚不能据此保证所有格式/页层都能正确取到文字；本轮没有做真实 UI 验证。

## 内置浏览器 AI 桥详情

15 个 action：`open`、`tabs`、`snapshot`、`screenshot`、`click`、`fill`、`scroll`、`press_key`、`wait`、`console`、`network`、`network_detail`、`navigate`、`viewport`、`close`。请求额外字段包括 tabId、url、ref、selector、x/y、text、key、deltaX/deltaY、timeoutMs、viewport、navigationId、query、requestId、bodyTarget/bodyOffset/bodyLimit。上下文包含 sessionId + engineId；执行归属 rootSessionId/rootRunId/ownerRunId 不由模型直接任意指定。返回 success/output/error，可附 operationPerformed 元数据。完整字段见 [src/shared/browser.ts:76](D:/dev/aether-code/src/shared/browser.ts:76)。

| 方式 | 路径 | 参数/返回要点 | 作用 | 证据 |
| --- | --- | --- | --- | --- |
| POST | `/browser/clients` | {sessionId; optional clientId/clientToken for renew} | Register/renew session browser bridge; response clientId/clientToken/capabilities | [src/main/browser-bridge.ts:111](D:/dev/aether-code/src/main/browser-bridge.ts:111) |
| DELETE | `/browser/clients/{clientId}` | session registration headers | Unregister bridge | [src/main/browser-bridge.ts:176](D:/dev/aether-code/src/main/browser-bridge.ts:176) |
| GET | `/browser/clients/{clientId}/commands` | registration headers | Poll queued AI browser operations | [src/main/browser-bridge.ts:266](D:/dev/aether-code/src/main/browser-bridge.ts:266) |
| POST | `/browser/clients/{clientId}/results` | {requestId,success,output,error} | Return browser execution receipt | [src/main/browser-bridge.ts:284](D:/dev/aether-code/src/main/browser-bridge.ts:284) |
| GET | `/browser/clients/{clientId}/requests/{requestId}/state` | wait:boolean | Observe cancellation; abort in-flight page operation | [src/main/browser-bridge.ts:212](D:/dev/aether-code/src/main/browser-bridge.ts:212) |
| POST | `/api/v1/terminal/create` | {sessionId,cols,rows} | Create remote user PTY | [src/main/terminal/remote-terminal.ts:41](D:/dev/aether-code/src/main/terminal/remote-terminal.ts:41) |
| WS | `/api/v1/terminal/ws/{terminalId}` | authenticated socket; resize/write/output messages | Remote user PTY duplex transport | [src/main/terminal/remote-terminal.ts:79](D:/dev/aether-code/src/main/terminal/remote-terminal.ts:79) |
| DELETE | `/api/v1/terminal/{terminalId}` | bound engine and original owner identity | Dispose remote user PTY | [src/main/terminal/remote-terminal.ts:192](D:/dev/aether-code/src/main/terminal/remote-terminal.ts:192) |

浏览器页面无 preload，受信工作台才能调用 IPC；share 必须匹配 session/context；本地 HTML 预览不能跨远程引擎读取用户本机文件。见 [src/main/browser-ipc.ts:46](D:/dev/aether-code/src/main/browser-ipc.ts:46)。取消监控依赖服务端 capabilities.requestWatch，旧引擎会明确报告取消能力较弱，不能把新客户端实现直接当成旧引擎已支持。

## 客户端 preload 全量清单

下面是客户端桥的调用签名与路由表达式，完整实现保存在 JSON preload[].implementation；事件订阅也单独列出。类型名的完整字段在 JSON typeContracts 中。

### workQueue（2）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `workQueue.invoke(input)` | `{ // contextBridge strips custom Error fields; the renderer owns typed error construction. return await ipcRenderer.invoke(WORK_QUEUE_IPC.invoke, input) as WorkQueueInvokeResult }` | [src/preload/index.ts:95](D:/dev/aether-code/src/preload/index.ts:95) |
| `workQueue.onChanged(listener)` | `{ const handler = (_event: unknown, payload: Parameters<Parameters<WorkNextTurnApi['onChanged']>[0]>[0]): void => listener(payload) ipcRenderer.on(WORK_QUEUE_IPC.changed, handler) return () => ipcRenderer.removeList …（完整实现见 JSON）` | [src/preload/index.ts:99](D:/dev/aether-code/src/preload/index.ts:99) |

### browser（19）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `browser.getHostZoomFactor()` | `webFrame.getZoomFactor()` | [src/preload/index.ts:106](D:/dev/aether-code/src/preload/index.ts:106) |
| `browser.list()` | `invokeBrowser('list')` | [src/preload/index.ts:107](D:/dev/aether-code/src/preload/index.ts:107) |
| `browser.create(input)` | `invokeBrowser('create', input)` | [src/preload/index.ts:108](D:/dev/aether-code/src/preload/index.ts:108) |
| `browser.action(input)` | `invokeBrowser('action', input)` | [src/preload/index.ts:109](D:/dev/aether-code/src/preload/index.ts:109) |
| `browser.setBounds(input)` | `invokeBrowser('setBounds', input)` | [src/preload/index.ts:110](D:/dev/aether-code/src/preload/index.ts:110) |
| `browser.close(tabId)` | `invokeBrowser('close', tabId)` | [src/preload/index.ts:111](D:/dev/aether-code/src/preload/index.ts:111) |
| `browser.share(tabId, expectedContext)` | `invokeBrowser('share', tabId, expectedContext)` | [src/preload/index.ts:112](D:/dev/aether-code/src/preload/index.ts:112) |
| `browser.getSettings()` | `invokeBrowser('getSettings')` | [src/preload/index.ts:113](D:/dev/aether-code/src/preload/index.ts:113) |
| `browser.updateSettings(patch)` | `invokeBrowser('updateSettings', patch)` | [src/preload/index.ts:114](D:/dev/aether-code/src/preload/index.ts:114) |
| `browser.clearData()` | `invokeBrowser('clearData')` | [src/preload/index.ts:115](D:/dev/aether-code/src/preload/index.ts:115) |
| `browser.read(tabId, kind)` | `invokeBrowser('read', tabId, kind)` | [src/preload/index.ts:116](D:/dev/aether-code/src/preload/index.ts:116) |
| `browser.network(tabId, query)` | `invokeBrowser('network', tabId, query)` | [src/preload/index.ts:117](D:/dev/aether-code/src/preload/index.ts:117) |
| `browser.networkRequest(tabId, requestId, options)` | `invokeBrowser('networkRequest', tabId, requestId, options)` | [src/preload/index.ts:118](D:/dev/aether-code/src/preload/index.ts:118) |
| `browser.openFile(filePath, workspaceRoot)` | `invokeBrowser('openFile', filePath, workspaceRoot)` | [src/preload/index.ts:119](D:/dev/aether-code/src/preload/index.ts:119) |
| `browser.connect(input)` | `invokeBrowser('connect', input)` | [src/preload/index.ts:120](D:/dev/aether-code/src/preload/index.ts:120) |
| `browser.disconnect()` | `invokeBrowser('disconnect')` | [src/preload/index.ts:121](D:/dev/aether-code/src/preload/index.ts:121) |
| `browser.getConnection()` | `invokeBrowser('getConnection')` | [src/preload/index.ts:122](D:/dev/aether-code/src/preload/index.ts:122) |
| `browser.onEvent(listener)` | `{ const handler = (_event: unknown, value: BrowserEvent): void => listener(value) ipcRenderer.on(BROWSER_IPC.event, handler) return () => ipcRenderer.removeListener(BROWSER_IPC.event, handler) }` | [src/preload/index.ts:123](D:/dev/aether-code/src/preload/index.ts:123) |
| `browser.onConnection(listener)` | `{ const handler = (_event: unknown, value: BrowserConnectionState): void => listener(value) ipcRenderer.on(BROWSER_IPC.connection, handler) return () => ipcRenderer.removeListener(BROWSER_IPC.connection, handler) …（完整实现见 JSON）` | [src/preload/index.ts:128](D:/dev/aether-code/src/preload/index.ts:128) |

### account（14）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `account.getState()` | `invokeAccount('getState')` | [src/preload/index.ts:139](D:/dev/aether-code/src/preload/index.ts:139) |
| `account.setHttpTrust(url, trusted)` | `invokeAccount('setHttpTrust', url, trusted)` | [src/preload/index.ts:140](D:/dev/aether-code/src/preload/index.ts:140) |
| `account.register()` | `invokeAccount('register')` | [src/preload/index.ts:141](D:/dev/aether-code/src/preload/index.ts:141) |
| `account.login(key: string)` | `invokeAccount('login', key)` | [src/preload/index.ts:142](D:/dev/aether-code/src/preload/index.ts:142) |
| `account.updateProfile(input)` | `invokeAccount('updateProfile', input)` | [src/preload/index.ts:143](D:/dev/aether-code/src/preload/index.ts:143) |
| `account.logout(all?: boolean)` | `invokeAccount('logout', all)` | [src/preload/index.ts:144](D:/dev/aether-code/src/preload/index.ts:144) |
| `account.sessions()` | `invokeAccount('sessions')` | [src/preload/index.ts:145](D:/dev/aether-code/src/preload/index.ts:145) |
| `account.revokeSession(id: string)` | `invokeAccount('revokeSession', id)` | [src/preload/index.ts:146](D:/dev/aether-code/src/preload/index.ts:146) |
| `account.exportRecovery()` | `invokeAccount('exportRecovery')` | [src/preload/index.ts:147](D:/dev/aether-code/src/preload/index.ts:147) |
| `account.importRecovery()` | `invokeAccount('importRecovery')` | [src/preload/index.ts:148](D:/dev/aether-code/src/preload/index.ts:148) |
| `account.externalLogin(id, mode, credential)` | `invokeAccount('externalLogin', id, mode, credential)` | [src/preload/index.ts:149](D:/dev/aether-code/src/preload/index.ts:149) |
| `account.cancelExternalLogin()` | `invokeAccount('cancelExternalLogin')` | [src/preload/index.ts:150](D:/dev/aether-code/src/preload/index.ts:150) |
| `account.unlink(id: string)` | `invokeAccount('unlink', id)` | [src/preload/index.ts:151](D:/dev/aether-code/src/preload/index.ts:151) |
| `account.onChanged(listener: (state: AccountState) => void)` | `{ const handler = (_event: unknown, state: AccountState): void => listener(state) ipcRenderer.on(IPC.event.accountChanged, handler) return () => ipcRenderer.removeListener(IPC.event.accountChanged, handler) …（完整实现见 JSON）` | [src/preload/index.ts:152](D:/dev/aether-code/src/preload/index.ts:152) |

### engine（20）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `engine.getSnapshot(): Promise<EngineSnapshot>` | `ipcRenderer.invoke(IPC.invoke.engineGetSnapshot)` | [src/preload/index.ts:159](D:/dev/aether-code/src/preload/index.ts:159) |
| `engine.diagnostics(input?: EngineDiagnosticsInput): Promise<EngineDiagnostics>` | `ipcRenderer.invoke(IPC.invoke.engineDiagnostics, input)` | [src/preload/index.ts:160](D:/dev/aether-code/src/preload/index.ts:160) |
| `engine.start(): Promise<EngineSnapshot>` | `ipcRenderer.invoke(IPC.invoke.engineStart)` | [src/preload/index.ts:161](D:/dev/aether-code/src/preload/index.ts:161) |
| `engine.stop(): Promise<EngineSnapshot>` | `ipcRenderer.invoke(IPC.invoke.engineStop)` | [src/preload/index.ts:162](D:/dev/aether-code/src/preload/index.ts:162) |
| `engine.restart(): Promise<EngineSnapshot>` | `ipcRenderer.invoke(IPC.invoke.engineRestart)` | [src/preload/index.ts:163](D:/dev/aether-code/src/preload/index.ts:163) |
| `engine.getLocalRuntimes(): Promise<EngineRuntimeCatalog>` | `ipcRenderer.invoke(IPC.invoke.engineGetLocalRuntimes)` | [src/preload/index.ts:164](D:/dev/aether-code/src/preload/index.ts:164) |
| `engine.importLocalRuntime(): Promise<EngineRuntimeInfo \| null>` | `ipcRenderer.invoke(IPC.invoke.engineImportLocalRuntime)` | [src/preload/index.ts:165](D:/dev/aether-code/src/preload/index.ts:165) |
| `engine.activateLocalRuntime(id: string \| null): Promise<EngineSnapshot>` | `ipcRenderer.invoke(IPC.invoke.engineActivateLocalRuntime, id)` | [src/preload/index.ts:166](D:/dev/aether-code/src/preload/index.ts:166) |
| `engine.deleteLocalRuntime(id: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.engineDeleteLocalRuntime, id)` | [src/preload/index.ts:167](D:/dev/aether-code/src/preload/index.ts:167) |
| `engine.onImportProgress(listener: (progress: EngineImportProgress) => void): (() => void)` | `{ const handler = (_event: unknown, progress: EngineImportProgress): void => listener(progress) ipcRenderer.on(IPC.event.engineImportProgress, handler) return () => ipcRenderer.removeListener(IPC.event.engineI …（完整实现见 JSON）` | [src/preload/index.ts:168](D:/dev/aether-code/src/preload/index.ts:168) |
| `engine.request<T = unknown>(input: EngineRequestInput): Promise<EngineRequestResult<T>>` | `ipcRenderer.invoke(IPC.invoke.engineRequest, input)` | [src/preload/index.ts:174](D:/dev/aether-code/src/preload/index.ts:174) |
| `engine.upload<T = unknown>(input: EngineUploadInput): Promise<EngineRequestResult<T>>` | `ipcRenderer.invoke(IPC.invoke.engineUpload, input)` | [src/preload/index.ts:176](D:/dev/aether-code/src/preload/index.ts:176) |
| `engine.uploadAttachment(input: RemoteAttachmentInput): Promise<RemoteAttachmentResult>` | `ipcRenderer.invoke(IPC.invoke.engineUploadAttachment, input)` | [src/preload/index.ts:178](D:/dev/aether-code/src/preload/index.ts:178) |
| `engine.saveWorkspaceFile(input: EngineFileSaveInput): Promise<EngineFileSaveResult>` | `ipcRenderer.invoke(IPC.invoke.engineSaveWorkspaceFile, input)` | [src/preload/index.ts:180](D:/dev/aether-code/src/preload/index.ts:180) |
| `engine.cancelAttachmentUpload(requestId: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.engineCancelAttachmentUpload, requestId)` | [src/preload/index.ts:182](D:/dev/aether-code/src/preload/index.ts:182) |
| `engine.stream.start(input: StreamStartInput): Promise<StreamStartResult>` | `ipcRenderer.invoke(IPC.invoke.engineStreamStart, input)` | [src/preload/index.ts:186](D:/dev/aether-code/src/preload/index.ts:186) |
| `engine.stream.abort(streamId: string): Promise<{ ok: boolean }>` | `ipcRenderer.invoke(IPC.invoke.engineStreamAbort, streamId)` | [src/preload/index.ts:188](D:/dev/aether-code/src/preload/index.ts:188) |
| `engine.onSnapshot(listener: (snapshot: EngineSnapshot) => void): (() => void)` | `{ const handler = (_e: unknown, snapshot: EngineSnapshot): void => listener(snapshot) ipcRenderer.on(IPC.event.engineSnapshot, handler) return () => ipcRenderer.removeListener(IPC.event.engineSnapshot, handler …（完整实现见 JSON）` | [src/preload/index.ts:193](D:/dev/aether-code/src/preload/index.ts:193) |
| `engine.onLog(listener: (entry: EngineLogEntry) => void): (() => void)` | `{ const handler = (_e: unknown, entry: EngineLogEntry): void => listener(entry) const batchHandler = (_e: unknown, entries: EngineLogBatch): void => { for (const entry of entries) listener(entry) } …（完整实现见 JSON）` | [src/preload/index.ts:199](D:/dev/aether-code/src/preload/index.ts:199) |
| `engine.onStreamEvent(listener: (event: StreamEvent) => void): (() => void)` | `{ const handler = (_e: unknown, event: StreamEvent): void => listener(event) ipcRenderer.on(IPC.event.streamEvent, handler) return () => ipcRenderer.removeListener(IPC.event.streamEvent, handler) }` | [src/preload/index.ts:212](D:/dev/aether-code/src/preload/index.ts:212) |

### graphics（3）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `graphics.getSnapshot(): Promise<GraphicsSnapshot>` | `ipcRenderer.invoke(IPC.invoke.graphicsGetSnapshot)` | [src/preload/index.ts:220](D:/dev/aether-code/src/preload/index.ts:220) |
| `graphics.resetRecovery(): Promise<GraphicsSnapshot>` | `ipcRenderer.invoke(IPC.invoke.graphicsResetRecovery)` | [src/preload/index.ts:221](D:/dev/aether-code/src/preload/index.ts:221) |
| `graphics.onChanged(listener: (snapshot: GraphicsSnapshot) => void): (() => void)` | `{ const handler = (_event: unknown, snapshot: GraphicsSnapshot): void => listener(snapshot) ipcRenderer.on(IPC.event.graphicsChanged, handler) return () => ipcRenderer.removeListener(IPC.event.graphicsChanged, …（完整实现见 JSON）` | [src/preload/index.ts:222](D:/dev/aether-code/src/preload/index.ts:222) |

### settings（7）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `settings.get(): Promise<AppSettings>` | `ipcRenderer.invoke(IPC.invoke.settingsGet)` | [src/preload/index.ts:230](D:/dev/aether-code/src/preload/index.ts:230) |
| `settings.update(patch: Partial<AppSettings>): Promise<AppSettings>` | `ipcRenderer.invoke(IPC.invoke.settingsUpdate, patch)` | [src/preload/index.ts:231](D:/dev/aether-code/src/preload/index.ts:231) |
| `settings.saveEngine(patch: Partial<AppSettings>, token?: string, auth?: RemoteAuthCredential \| null): Promise<AppSettings>` | `ipcRenderer.invoke(IPC.invoke.settingsSaveEngine, patch, token, auth)` | [src/preload/index.ts:233](D:/dev/aether-code/src/preload/index.ts:233) |
| `settings.remoteAuthStatus(url: string): Promise<RemoteAuthStatus>` | `ipcRenderer.invoke(IPC.invoke.settingsRemoteAuthStatus, url)` | [src/preload/index.ts:235](D:/dev/aether-code/src/preload/index.ts:235) |
| `settings.remoteTokenStatus(): Promise<RemoteTokenStatus>` | `ipcRenderer.invoke(IPC.invoke.settingsRemoteTokenStatus)` | [src/preload/index.ts:237](D:/dev/aether-code/src/preload/index.ts:237) |
| `settings.setRemoteToken(token: string): Promise<RemoteTokenStatus>` | `ipcRenderer.invoke(IPC.invoke.settingsSetRemoteToken, token)` | [src/preload/index.ts:239](D:/dev/aether-code/src/preload/index.ts:239) |
| `settings.clearRemoteToken(): Promise<RemoteTokenStatus>` | `ipcRenderer.invoke(IPC.invoke.settingsClearRemoteToken)` | [src/preload/index.ts:241](D:/dev/aether-code/src/preload/index.ts:241) |

### fs（18）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `fs.pickFolder(): Promise<string \| null>` | `ipcRenderer.invoke(IPC.invoke.fsPickFolder)` | [src/preload/index.ts:250](D:/dev/aether-code/src/preload/index.ts:250) |
| `fs.pickFile(): Promise<string \| null>` | `ipcRenderer.invoke(IPC.invoke.fsPickFile)` | [src/preload/index.ts:251](D:/dev/aether-code/src/preload/index.ts:251) |
| `fs.allowRoot(root: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsAllowRoot, root)` | [src/preload/index.ts:252](D:/dev/aether-code/src/preload/index.ts:252) |
| `fs.readDir(dir: string): Promise<FsEntry[]>` | `ipcRenderer.invoke(IPC.invoke.fsReadDir, dir)` | [src/preload/index.ts:253](D:/dev/aether-code/src/preload/index.ts:253) |
| `fs.readFile(path: string): Promise<FsFileContent>` | `ipcRenderer.invoke(IPC.invoke.fsReadFile, path)` | [src/preload/index.ts:254](D:/dev/aether-code/src/preload/index.ts:254) |
| `fs.readExternalFile(path: string): Promise<FsFileContent>` | `ipcRenderer.invoke(IPC.invoke.fsReadExternalFile, path)` | [src/preload/index.ts:256](D:/dev/aether-code/src/preload/index.ts:256) |
| `fs.writeFile(path: string, content: string): Promise<FsStat>` | `ipcRenderer.invoke(IPC.invoke.fsWriteFile, path, content)` | [src/preload/index.ts:258](D:/dev/aether-code/src/preload/index.ts:258) |
| `fs.createFile(path: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsCreateFile, path)` | [src/preload/index.ts:260](D:/dev/aether-code/src/preload/index.ts:260) |
| `fs.createFolder(path: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsCreateFolder, path)` | [src/preload/index.ts:261](D:/dev/aether-code/src/preload/index.ts:261) |
| `fs.rename(src: string, dest: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsRename, src, dest)` | [src/preload/index.ts:263](D:/dev/aether-code/src/preload/index.ts:263) |
| `fs.copy(src: string, dest: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsCopy, src, dest)` | [src/preload/index.ts:265](D:/dev/aether-code/src/preload/index.ts:265) |
| `fs.trash(path: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsTrash, path)` | [src/preload/index.ts:267](D:/dev/aether-code/src/preload/index.ts:267) |
| `fs.stat(path: string): Promise<FsStat>` | `ipcRenderer.invoke(IPC.invoke.fsStat, path)` | [src/preload/index.ts:268](D:/dev/aether-code/src/preload/index.ts:268) |
| `fs.reveal(path: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsReveal, path)` | [src/preload/index.ts:269](D:/dev/aether-code/src/preload/index.ts:269) |
| `fs.watchDocuments(paths: string[]): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.fsWatchDocuments, paths)` | [src/preload/index.ts:270](D:/dev/aether-code/src/preload/index.ts:270) |
| `fs.onDocumentsChanged(listener: (paths: string[]) => void): (() => void)` | `{ const handler = (_event: Electron.IpcRendererEvent, paths: string[]): void => listener(paths) ipcRenderer.on(IPC.event.fsDocumentsChanged, handler) return () => ipcRenderer.removeListener(IPC.event.fsDocumen …（完整实现见 JSON）` | [src/preload/index.ts:271](D:/dev/aether-code/src/preload/index.ts:271) |
| `fs.listAll(root: string): Promise<string[]>` | `ipcRenderer.invoke(IPC.invoke.fsListAll, root)` | [src/preload/index.ts:276](D:/dev/aether-code/src/preload/index.ts:276) |
| `fs.copyIntoWorkspace(input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult>` | `ipcRenderer.invoke(IPC.invoke.fsCopyIntoWorkspace, input)` | [src/preload/index.ts:277](D:/dev/aether-code/src/preload/index.ts:277) |

### git（83）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `git.init(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitInit, cwd)` | [src/preload/index.ts:287](D:/dev/aether-code/src/preload/index.ts:287) |
| `git.status(cwd: string): Promise<GitStatusResult>` | `ipcRenderer.invoke(IPC.invoke.gitStatus, cwd)` | [src/preload/index.ts:288](D:/dev/aether-code/src/preload/index.ts:288) |
| `git.leaseStatus(cwd: string): Promise<GitLeaseResult>` | `ipcRenderer.invoke(IPC.invoke.gitLeaseStatus, cwd)` | [src/preload/index.ts:289](D:/dev/aether-code/src/preload/index.ts:289) |
| `git.recoverLease(cwd: string, generation: string): Promise<GitLeaseResult>` | `ipcRenderer.invoke(IPC.invoke.gitRecoverLease, cwd, generation)` | [src/preload/index.ts:290](D:/dev/aether-code/src/preload/index.ts:290) |
| `git.diff(cwd: string, path: string, staged: boolean, base?: 'index' \| 'head'): Promise<GitDiffResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiff, cwd, path, staged, base)` | [src/preload/index.ts:291](D:/dev/aether-code/src/preload/index.ts:291) |
| `git.branchInfo(cwd: string): Promise<GitBranchInfoResult>` | `ipcRenderer.invoke(IPC.invoke.gitBranchInfo, cwd)` | [src/preload/index.ts:293](D:/dev/aether-code/src/preload/index.ts:293) |
| `git.stage(cwd: string, path: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStage, cwd, path)` | [src/preload/index.ts:295](D:/dev/aether-code/src/preload/index.ts:295) |
| `git.unstage(cwd: string, path: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitUnstage, cwd, path)` | [src/preload/index.ts:297](D:/dev/aether-code/src/preload/index.ts:297) |
| `git.discardFile(cwd: string, path: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiscardFile, cwd, path)` | [src/preload/index.ts:299](D:/dev/aether-code/src/preload/index.ts:299) |
| `git.discardWorktree(cwd: string, path: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiscardWorktree, cwd, path)` | [src/preload/index.ts:301](D:/dev/aether-code/src/preload/index.ts:301) |
| `git.discardWorktreeFiles(cwd: string, paths: string[]): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiscardWorktreeFiles, cwd, paths)` | [src/preload/index.ts:303](D:/dev/aether-code/src/preload/index.ts:303) |
| `git.stageFiles(cwd: string, paths: string[]): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStageFiles, cwd, paths)` | [src/preload/index.ts:305](D:/dev/aether-code/src/preload/index.ts:305) |
| `git.checkIgnored(cwd: string, paths: string[]): Promise<GitIgnoreCheckResult>` | `ipcRenderer.invoke(IPC.invoke.gitCheckIgnored, cwd, paths)` | [src/preload/index.ts:307](D:/dev/aether-code/src/preload/index.ts:307) |
| `git.unstageFiles(cwd: string, paths: string[]): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitUnstageFiles, cwd, paths)` | [src/preload/index.ts:309](D:/dev/aether-code/src/preload/index.ts:309) |
| `git.discardFiles(cwd: string, paths: string[]): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiscardFiles, cwd, paths)` | [src/preload/index.ts:311](D:/dev/aether-code/src/preload/index.ts:311) |
| `git.headFile(cwd: string, path: string): Promise<GitHeadFileResult>` | `ipcRenderer.invoke(IPC.invoke.gitHeadFile, cwd, path)` | [src/preload/index.ts:313](D:/dev/aether-code/src/preload/index.ts:313) |
| `git.fetch(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitFetch, cwd)` | [src/preload/index.ts:315](D:/dev/aether-code/src/preload/index.ts:315) |
| `git.pull(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPull, cwd)` | [src/preload/index.ts:316](D:/dev/aether-code/src/preload/index.ts:316) |
| `git.push(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPush, cwd)` | [src/preload/index.ts:317](D:/dev/aether-code/src/preload/index.ts:317) |
| `git.divergence(cwd: string): Promise<GitDivergenceResult>` | `ipcRenderer.invoke(IPC.invoke.gitDivergence, cwd)` | [src/preload/index.ts:318](D:/dev/aether-code/src/preload/index.ts:318) |
| `git.pullMerge(cwd: string, remember: boolean): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPullMerge, cwd, remember)` | [src/preload/index.ts:320](D:/dev/aether-code/src/preload/index.ts:320) |
| `git.pullRebaseWithChoice(cwd: string, remember: boolean): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPullRebaseChoice, cwd, remember)` | [src/preload/index.ts:322](D:/dev/aether-code/src/preload/index.ts:322) |
| `git.addSshKey(passphrase: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitAddSshKey, passphrase)` | [src/preload/index.ts:324](D:/dev/aether-code/src/preload/index.ts:324) |
| `git.listBranches(cwd: string): Promise<GitBranchListResult>` | `ipcRenderer.invoke(IPC.invoke.gitBranches, cwd)` | [src/preload/index.ts:326](D:/dev/aether-code/src/preload/index.ts:326) |
| `git.checkout(cwd: string, branch: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCheckout, cwd, branch)` | [src/preload/index.ts:328](D:/dev/aether-code/src/preload/index.ts:328) |
| `git.createBranch(cwd: string, name: string, startPoint?: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCreateBranch, cwd, name, startPoint)` | [src/preload/index.ts:330](D:/dev/aether-code/src/preload/index.ts:330) |
| `git.discardHunk(cwd: string, path: string, hunkId: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDiscardHunk, cwd, path, hunkId)` | [src/preload/index.ts:332](D:/dev/aether-code/src/preload/index.ts:332) |
| `git.commit(cwd: string, message: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCommit, cwd, message)` | [src/preload/index.ts:334](D:/dev/aether-code/src/preload/index.ts:334) |
| `git.stageAllAndCommit(cwd: string, message: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStageAllAndCommit, cwd, message)` | [src/preload/index.ts:336](D:/dev/aether-code/src/preload/index.ts:336) |
| `git.getHeadFile(cwd: string, path: string): Promise<GitHeadFileResult>` | `ipcRenderer.invoke(IPC.invoke.gitHeadFileContent, cwd, path)` | [src/preload/index.ts:338](D:/dev/aether-code/src/preload/index.ts:338) |
| `git.appendGitignore(cwd: string, path: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitAppendGitignore, cwd, path)` | [src/preload/index.ts:340](D:/dev/aether-code/src/preload/index.ts:340) |
| `git.suggestCommitMessage(cwd: string): Promise<GitSuggestMessageResult>` | `ipcRenderer.invoke(IPC.invoke.gitSuggestMessage, cwd)` | [src/preload/index.ts:342](D:/dev/aether-code/src/preload/index.ts:342) |
| `git.commitAmend(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCommitAmend, cwd)` | [src/preload/index.ts:344](D:/dev/aether-code/src/preload/index.ts:344) |
| `git.commitAmendWithMessage(cwd: string, message: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCommitAmendMessage, cwd, message)` | [src/preload/index.ts:345](D:/dev/aether-code/src/preload/index.ts:345) |
| `git.undoCommit(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitUndoCommit, cwd)` | [src/preload/index.ts:347](D:/dev/aether-code/src/preload/index.ts:347) |
| `git.commitEmpty(cwd: string, message: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCommitEmpty, cwd, message)` | [src/preload/index.ts:348](D:/dev/aether-code/src/preload/index.ts:348) |
| `git.sync(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitSync, cwd)` | [src/preload/index.ts:350](D:/dev/aether-code/src/preload/index.ts:350) |
| `git.pullRebase(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPullRebase, cwd)` | [src/preload/index.ts:351](D:/dev/aether-code/src/preload/index.ts:351) |
| `git.pushForce(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPushForce, cwd)` | [src/preload/index.ts:352](D:/dev/aether-code/src/preload/index.ts:352) |
| `git.pushTags(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPushTags, cwd)` | [src/preload/index.ts:353](D:/dev/aether-code/src/preload/index.ts:353) |
| `git.pushTag(cwd: string, name: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPushTag, cwd, name)` | [src/preload/index.ts:354](D:/dev/aether-code/src/preload/index.ts:354) |
| `git.pullFrom(cwd: string, remote: string, branch: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPullFrom, cwd, remote, branch)` | [src/preload/index.ts:356](D:/dev/aether-code/src/preload/index.ts:356) |
| `git.pushTo(cwd: string, remote: string, branch?: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPushTo, cwd, remote, branch)` | [src/preload/index.ts:358](D:/dev/aether-code/src/preload/index.ts:358) |
| `git.listRemoteBranches(cwd: string): Promise<GitRemoteBranchListResult>` | `ipcRenderer.invoke(IPC.invoke.gitRemoteBranches, cwd)` | [src/preload/index.ts:360](D:/dev/aether-code/src/preload/index.ts:360) |
| `git.deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDeleteRemoteBranch, cwd, remote, branch)` | [src/preload/index.ts:362](D:/dev/aether-code/src/preload/index.ts:362) |
| `git.deleteRemoteTag(cwd: string, name: string, remote?: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDeleteRemoteTag, cwd, name, remote)` | [src/preload/index.ts:364](D:/dev/aether-code/src/preload/index.ts:364) |
| `git.deleteBranch(cwd: string, name: string, force?: boolean): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDeleteBranch, cwd, name, force)` | [src/preload/index.ts:366](D:/dev/aether-code/src/preload/index.ts:366) |
| `git.renameBranch(cwd: string, oldName: string, newName: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitRenameBranch, cwd, oldName, newName)` | [src/preload/index.ts:368](D:/dev/aether-code/src/preload/index.ts:368) |
| `git.publishBranch(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitPublishBranch, cwd)` | [src/preload/index.ts:370](D:/dev/aether-code/src/preload/index.ts:370) |
| `git.merge(cwd: string, ref: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitMerge, cwd, ref)` | [src/preload/index.ts:372](D:/dev/aether-code/src/preload/index.ts:372) |
| `git.mergeAbort(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitMergeAbort, cwd)` | [src/preload/index.ts:373](D:/dev/aether-code/src/preload/index.ts:373) |
| `git.rebase(cwd: string, ref: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitRebase, cwd, ref)` | [src/preload/index.ts:374](D:/dev/aether-code/src/preload/index.ts:374) |
| `git.rebaseAbort(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitRebaseAbort, cwd)` | [src/preload/index.ts:375](D:/dev/aether-code/src/preload/index.ts:375) |
| `git.cherryPick(cwd: string, hash: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCherryPick, cwd, hash)` | [src/preload/index.ts:376](D:/dev/aether-code/src/preload/index.ts:376) |
| `git.cherryPickAbort(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCherryPickAbort, cwd)` | [src/preload/index.ts:378](D:/dev/aether-code/src/preload/index.ts:378) |
| `git.revertCommit(cwd: string, hash: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitRevertCommit, cwd, hash)` | [src/preload/index.ts:380](D:/dev/aether-code/src/preload/index.ts:380) |
| `git.listRemotes(cwd: string): Promise<GitRemoteListResult>` | `ipcRenderer.invoke(IPC.invoke.gitRemotes, cwd)` | [src/preload/index.ts:382](D:/dev/aether-code/src/preload/index.ts:382) |
| `git.addRemote(cwd: string, name: string, url: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitAddRemote, cwd, name, url)` | [src/preload/index.ts:384](D:/dev/aether-code/src/preload/index.ts:384) |
| `git.removeRemote(cwd: string, name: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitRemoveRemote, cwd, name)` | [src/preload/index.ts:386](D:/dev/aether-code/src/preload/index.ts:386) |
| `git.clone(options: GitCloneOptions): Promise<GitCloneResult>` | `ipcRenderer.invoke(IPC.invoke.gitClone, options)` | [src/preload/index.ts:388](D:/dev/aether-code/src/preload/index.ts:388) |
| `git.cancelClone(cloneId: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCloneCancel, cloneId)` | [src/preload/index.ts:390](D:/dev/aether-code/src/preload/index.ts:390) |
| `git.onCloneProgress(listener: (payload: GitCloneProgressPayload) => void): (() => void)` | `{ const handler = (_e: unknown, payload: GitCloneProgressPayload): void => listener(payload) ipcRenderer.on(IPC.event.gitCloneProgress, handler) return () => ipcRenderer.removeListener(IPC.event.gitCloneProgre …（完整实现见 JSON）` | [src/preload/index.ts:393](D:/dev/aether-code/src/preload/index.ts:393) |
| `git.listStashes(cwd: string): Promise<GitStashListResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashList, cwd)` | [src/preload/index.ts:398](D:/dev/aether-code/src/preload/index.ts:398) |
| `git.stashPush(cwd: string, message?: string, includeUntracked?: boolean): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashPush, cwd, message, includeUntracked)` | [src/preload/index.ts:400](D:/dev/aether-code/src/preload/index.ts:400) |
| `git.stashPushStaged(cwd: string, message?: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashPushStaged, cwd, message)` | [src/preload/index.ts:402](D:/dev/aether-code/src/preload/index.ts:402) |
| `git.stashPop(cwd: string, index?: number): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashPop, cwd, index)` | [src/preload/index.ts:404](D:/dev/aether-code/src/preload/index.ts:404) |
| `git.stashApply(cwd: string, index?: number): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashApply, cwd, index)` | [src/preload/index.ts:406](D:/dev/aether-code/src/preload/index.ts:406) |
| `git.stashDrop(cwd: string, index: number): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashDrop, cwd, index)` | [src/preload/index.ts:408](D:/dev/aether-code/src/preload/index.ts:408) |
| `git.stashDropBatch(cwd: string, indexes: number[]): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashDropBatch, cwd, indexes)` | [src/preload/index.ts:410](D:/dev/aether-code/src/preload/index.ts:410) |
| `git.stashClear(cwd: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashClear, cwd)` | [src/preload/index.ts:412](D:/dev/aether-code/src/preload/index.ts:412) |
| `git.stashShow(cwd: string, index: number): Promise<GitHeadFileResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashShow, cwd, index)` | [src/preload/index.ts:413](D:/dev/aether-code/src/preload/index.ts:413) |
| `git.stashShowFiles(cwd: string, index: number): Promise<GitHeadFileResult>` | `ipcRenderer.invoke(IPC.invoke.gitStashShowFiles, cwd, index)` | [src/preload/index.ts:415](D:/dev/aether-code/src/preload/index.ts:415) |
| `git.listTags(cwd: string): Promise<GitTagListResult>` | `ipcRenderer.invoke(IPC.invoke.gitTags, cwd)` | [src/preload/index.ts:417](D:/dev/aether-code/src/preload/index.ts:417) |
| `git.createTag(cwd: string, name: string, message?: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitCreateTag, cwd, name, message)` | [src/preload/index.ts:418](D:/dev/aether-code/src/preload/index.ts:418) |
| `git.deleteTag(cwd: string, name: string): Promise<GitResult>` | `ipcRenderer.invoke(IPC.invoke.gitDeleteTag, cwd, name)` | [src/preload/index.ts:420](D:/dev/aether-code/src/preload/index.ts:420) |
| `git.log(cwd: string, limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult>` | `ipcRenderer.invoke(IPC.invoke.gitLog, cwd, limit, skip, query)` | [src/preload/index.ts:422](D:/dev/aether-code/src/preload/index.ts:422) |
| `git.incoming(cwd: string, limit?: number): Promise<GitLogResult>` | `ipcRenderer.invoke(IPC.invoke.gitIncoming, cwd, limit)` | [src/preload/index.ts:424](D:/dev/aether-code/src/preload/index.ts:424) |
| `git.commitShow(cwd: string, hash: string): Promise<GitCommitInfoResult>` | `ipcRenderer.invoke(IPC.invoke.gitCommitShow, cwd, hash)` | [src/preload/index.ts:426](D:/dev/aether-code/src/preload/index.ts:426) |
| `git.showCommitFile(cwd: string, hash: string, path: string): Promise<GitHeadFileResult>` | `ipcRenderer.invoke(IPC.invoke.gitShowCommitFile, cwd, hash, path)` | [src/preload/index.ts:428](D:/dev/aether-code/src/preload/index.ts:428) |
| `git.fileHistory(cwd: string, path: string, limit?: number, cursor?: string): Promise<GitFileHistoryResult>` | `ipcRenderer.invoke(IPC.invoke.gitFileHistory, cwd, path, limit, cursor)` | [src/preload/index.ts:430](D:/dev/aether-code/src/preload/index.ts:430) |
| `git.blame(cwd: string, path: string): Promise<GitBlameResult>` | `ipcRenderer.invoke(IPC.invoke.gitBlame, cwd, path)` | [src/preload/index.ts:432](D:/dev/aether-code/src/preload/index.ts:432) |
| `git.getUserName(cwd: string): Promise<GitUserResult>` | `ipcRenderer.invoke(IPC.invoke.gitUserName, cwd)` | [src/preload/index.ts:434](D:/dev/aether-code/src/preload/index.ts:434) |
| `git.listAuthors(cwd: string): Promise<GitUserListResult>` | `ipcRenderer.invoke(IPC.invoke.gitListAuthors, cwd)` | [src/preload/index.ts:435](D:/dev/aether-code/src/preload/index.ts:435) |

### search（3）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `search.query(root: string, query: string, options: SearchOptions, excludes: FilesExclude): Promise<SearchOutcome>` | `ipcRenderer.invoke(IPC.invoke.searchQuery, root, query, options, excludes)` | [src/preload/index.ts:441](D:/dev/aether-code/src/preload/index.ts:441) |
| `search.replace(root: string, query: string, options: SearchOptions, replaceText: string, excludes: FilesExclude): Promise<ReplaceOutcome>` | `ipcRenderer.invoke(IPC.invoke.searchReplace, root, query, options, replaceText, excludes)` | [src/preload/index.ts:448](D:/dev/aether-code/src/preload/index.ts:448) |
| `search.preview(root: string, query: string, options: SearchOptions, replaceText: string, excludes: FilesExclude): Promise<ReplacePreviewOutcome>` | `ipcRenderer.invoke( IPC.invoke.searchReplacePreview, root, query, options, replaceText, excludes )` | [src/preload/index.ts:456](D:/dev/aether-code/src/preload/index.ts:456) |

### terminal（7）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `terminal.create(input: TerminalCreateInput): Promise<{ id: string }>` | `ipcRenderer.invoke(IPC.invoke.terminalCreate, input)` | [src/preload/index.ts:478](D:/dev/aether-code/src/preload/index.ts:478) |
| `terminal.write(id: string, data: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.terminalWrite, id, data)` | [src/preload/index.ts:480](D:/dev/aether-code/src/preload/index.ts:480) |
| `terminal.resize(id: string, cols: number, rows: number): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.terminalResize, id, cols, rows)` | [src/preload/index.ts:482](D:/dev/aether-code/src/preload/index.ts:482) |
| `terminal.dispose(id: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.terminalDispose, id)` | [src/preload/index.ts:484](D:/dev/aether-code/src/preload/index.ts:484) |
| `terminal.reconnect(id: string): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.terminalReconnect, id)` | [src/preload/index.ts:485](D:/dev/aether-code/src/preload/index.ts:485) |
| `terminal.onData(listener: (event: TerminalDataEvent) => void): (() => void)` | `{ const handler = (_e: unknown, event: TerminalDataEvent): void => listener(event) ipcRenderer.on(IPC.event.terminalData, handler) return () => ipcRenderer.removeListener(IPC.event.terminalData, handler) …（完整实现见 JSON）` | [src/preload/index.ts:486](D:/dev/aether-code/src/preload/index.ts:486) |
| `terminal.onExit(listener: (info: TerminalExitInfo) => void): (() => void)` | `{ const handler = (_e: unknown, info: TerminalExitInfo): void => listener(info) ipcRenderer.on(IPC.event.terminalExit, handler) return () => ipcRenderer.removeListener(IPC.event.terminalExit, handler) }` | [src/preload/index.ts:491](D:/dev/aether-code/src/preload/index.ts:491) |

### lsp（5）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `lsp.start(input: LspStartInput): Promise<LspStartResult>` | `ipcRenderer.invoke(IPC.invoke.lspStart, input)` | [src/preload/index.ts:504](D:/dev/aether-code/src/preload/index.ts:504) |
| `lsp.stop(): Promise<{ ok: boolean }>` | `ipcRenderer.invoke(IPC.invoke.lspStop)` | [src/preload/index.ts:506](D:/dev/aether-code/src/preload/index.ts:506) |
| `lsp.send(message: LspMessage): Promise<{ ok: boolean }>` | `ipcRenderer.invoke(IPC.invoke.lspSend, message)` | [src/preload/index.ts:507](D:/dev/aether-code/src/preload/index.ts:507) |
| `lsp.onMessage(listener: (message: LspMessage) => void): (() => void)` | `{ const handler = (_e: unknown, message: LspMessage): void => listener(message) ipcRenderer.on(IPC.event.lspMessage, handler) return () => ipcRenderer.removeListener(IPC.event.lspMessage, handler) }` | [src/preload/index.ts:509](D:/dev/aether-code/src/preload/index.ts:509) |
| `lsp.onExit(listener: (info: LspExitInfo) => void): (() => void)` | `{ const handler = (_e: unknown, info: LspExitInfo): void => listener(info) ipcRenderer.on(IPC.event.lspExit, handler) return () => ipcRenderer.removeListener(IPC.event.lspExit, handler) }` | [src/preload/index.ts:514](D:/dev/aether-code/src/preload/index.ts:514) |

### window（6）

| 方法 / 参数 | 路由或动作 | 证据 |
| --- | --- | --- |
| `window.minimize(): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.windowMinimize)` | [src/preload/index.ts:523](D:/dev/aether-code/src/preload/index.ts:523) |
| `window.toggleMaximize(): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.windowToggleMaximize)` | [src/preload/index.ts:524](D:/dev/aether-code/src/preload/index.ts:524) |
| `window.close(): Promise<void>` | `ipcRenderer.invoke(IPC.invoke.windowClose)` | [src/preload/index.ts:525](D:/dev/aether-code/src/preload/index.ts:525) |
| `window.isMaximized(): Promise<boolean>` | `ipcRenderer.invoke(IPC.invoke.windowIsMaximized)` | [src/preload/index.ts:526](D:/dev/aether-code/src/preload/index.ts:526) |
| `window.getVisibility(): Promise<boolean>` | `ipcRenderer.invoke(IPC.invoke.windowGetVisibility)` | [src/preload/index.ts:527](D:/dev/aether-code/src/preload/index.ts:527) |
| `window.onVisibility(listener: (visible: boolean) => void): (() => void)` | `{ const handler = (_event: unknown, visible: unknown): void => { if (typeof visible === 'boolean') listener(visible) } ipcRenderer.on(IPC.event.windowVisibility, handler) return () => ipcRenderer.removeListene …（完整实现见 JSON）` | [src/preload/index.ts:528](D:/dev/aether-code/src/preload/index.ts:528) |

## IPC 通道全量清单

| 常量 | 通道 | 证据 |
| --- | --- | --- |
| `BROWSER_IPC.invoke` | `'browser:invoke'` | [src/shared/browser-api.ts:8](D:/dev/aether-code/src/shared/browser-api.ts:8) |
| `BROWSER_IPC.event` | `'browser:event'` | [src/shared/browser-api.ts:8](D:/dev/aether-code/src/shared/browser-api.ts:8) |
| `BROWSER_IPC.connection` | `'browser:connection'` | [src/shared/browser-api.ts:8](D:/dev/aether-code/src/shared/browser-api.ts:8) |
| `IPC.invoke.accountAction` | `'account:action'` | [src/shared/ipc.ts:15](D:/dev/aether-code/src/shared/ipc.ts:15) |
| `IPC.invoke.engineGetSnapshot` | `'engine:get-snapshot'` | [src/shared/ipc.ts:16](D:/dev/aether-code/src/shared/ipc.ts:16) |
| `IPC.invoke.engineDiagnostics` | `'engine:diagnostics'` | [src/shared/ipc.ts:17](D:/dev/aether-code/src/shared/ipc.ts:17) |
| `IPC.invoke.engineStart` | `'engine:start'` | [src/shared/ipc.ts:18](D:/dev/aether-code/src/shared/ipc.ts:18) |
| `IPC.invoke.engineStop` | `'engine:stop'` | [src/shared/ipc.ts:19](D:/dev/aether-code/src/shared/ipc.ts:19) |
| `IPC.invoke.engineRestart` | `'engine:restart'` | [src/shared/ipc.ts:20](D:/dev/aether-code/src/shared/ipc.ts:20) |
| `IPC.invoke.engineGetLocalRuntimes` | `'engine:get-local-runtimes'` | [src/shared/ipc.ts:21](D:/dev/aether-code/src/shared/ipc.ts:21) |
| `IPC.invoke.engineImportLocalRuntime` | `'engine:import-local-runtime'` | [src/shared/ipc.ts:22](D:/dev/aether-code/src/shared/ipc.ts:22) |
| `IPC.invoke.engineActivateLocalRuntime` | `'engine:activate-local-runtime'` | [src/shared/ipc.ts:23](D:/dev/aether-code/src/shared/ipc.ts:23) |
| `IPC.invoke.engineDeleteLocalRuntime` | `'engine:delete-local-runtime'` | [src/shared/ipc.ts:24](D:/dev/aether-code/src/shared/ipc.ts:24) |
| `IPC.invoke.engineRequest` | `'engine:request'` | [src/shared/ipc.ts:25](D:/dev/aether-code/src/shared/ipc.ts:25) |
| `IPC.invoke.engineUpload` | `'engine:upload'` | [src/shared/ipc.ts:26](D:/dev/aether-code/src/shared/ipc.ts:26) |
| `IPC.invoke.engineUploadAttachment` | `'engine:upload-attachment'` | [src/shared/ipc.ts:27](D:/dev/aether-code/src/shared/ipc.ts:27) |
| `IPC.invoke.engineSaveWorkspaceFile` | `'engine:save-workspace-file'` | [src/shared/ipc.ts:28](D:/dev/aether-code/src/shared/ipc.ts:28) |
| `IPC.invoke.engineCancelAttachmentUpload` | `'engine:cancel-attachment-upload'` | [src/shared/ipc.ts:29](D:/dev/aether-code/src/shared/ipc.ts:29) |
| `IPC.invoke.engineStreamStart` | `'engine:stream:start'` | [src/shared/ipc.ts:30](D:/dev/aether-code/src/shared/ipc.ts:30) |
| `IPC.invoke.engineStreamAbort` | `'engine:stream:abort'` | [src/shared/ipc.ts:31](D:/dev/aether-code/src/shared/ipc.ts:31) |
| `IPC.invoke.settingsGet` | `'settings:get'` | [src/shared/ipc.ts:32](D:/dev/aether-code/src/shared/ipc.ts:32) |
| `IPC.invoke.settingsUpdate` | `'settings:update'` | [src/shared/ipc.ts:33](D:/dev/aether-code/src/shared/ipc.ts:33) |
| `IPC.invoke.graphicsGetSnapshot` | `'graphics:get-snapshot'` | [src/shared/ipc.ts:34](D:/dev/aether-code/src/shared/ipc.ts:34) |
| `IPC.invoke.graphicsResetRecovery` | `'graphics:reset-recovery'` | [src/shared/ipc.ts:35](D:/dev/aether-code/src/shared/ipc.ts:35) |
| `IPC.invoke.settingsRemoteTokenStatus` | `'settings:remote-token-status'` | [src/shared/ipc.ts:36](D:/dev/aether-code/src/shared/ipc.ts:36) |
| `IPC.invoke.settingsRemoteAuthStatus` | `'settings:remote-auth-status'` | [src/shared/ipc.ts:37](D:/dev/aether-code/src/shared/ipc.ts:37) |
| `IPC.invoke.settingsSetRemoteToken` | `'settings:set-remote-token'` | [src/shared/ipc.ts:38](D:/dev/aether-code/src/shared/ipc.ts:38) |
| `IPC.invoke.settingsClearRemoteToken` | `'settings:clear-remote-token'` | [src/shared/ipc.ts:39](D:/dev/aether-code/src/shared/ipc.ts:39) |
| `IPC.invoke.settingsSaveEngine` | `'settings:save-engine'` | [src/shared/ipc.ts:40](D:/dev/aether-code/src/shared/ipc.ts:40) |
| `IPC.invoke.fsPickFolder` | `'fs:pick-folder'` | [src/shared/ipc.ts:42](D:/dev/aether-code/src/shared/ipc.ts:42) |
| `IPC.invoke.fsPickFile` | `'fs:pick-file'` | [src/shared/ipc.ts:44](D:/dev/aether-code/src/shared/ipc.ts:44) |
| `IPC.invoke.fsAllowRoot` | `'fs:allow-root'` | [src/shared/ipc.ts:45](D:/dev/aether-code/src/shared/ipc.ts:45) |
| `IPC.invoke.fsReadDir` | `'fs:read-dir'` | [src/shared/ipc.ts:46](D:/dev/aether-code/src/shared/ipc.ts:46) |
| `IPC.invoke.fsReadFile` | `'fs:read-file'` | [src/shared/ipc.ts:47](D:/dev/aether-code/src/shared/ipc.ts:47) |
| `IPC.invoke.fsReadExternalFile` | `'fs:read-external-file'` | [src/shared/ipc.ts:49](D:/dev/aether-code/src/shared/ipc.ts:49) |
| `IPC.invoke.fsWriteFile` | `'fs:write-file'` | [src/shared/ipc.ts:50](D:/dev/aether-code/src/shared/ipc.ts:50) |
| `IPC.invoke.fsCreateFile` | `'fs:create-file'` | [src/shared/ipc.ts:51](D:/dev/aether-code/src/shared/ipc.ts:51) |
| `IPC.invoke.fsCreateFolder` | `'fs:create-folder'` | [src/shared/ipc.ts:52](D:/dev/aether-code/src/shared/ipc.ts:52) |
| `IPC.invoke.fsRename` | `'fs:rename'` | [src/shared/ipc.ts:53](D:/dev/aether-code/src/shared/ipc.ts:53) |
| `IPC.invoke.fsCopy` | `'fs:copy'` | [src/shared/ipc.ts:55](D:/dev/aether-code/src/shared/ipc.ts:55) |
| `IPC.invoke.fsTrash` | `'fs:trash'` | [src/shared/ipc.ts:56](D:/dev/aether-code/src/shared/ipc.ts:56) |
| `IPC.invoke.fsStat` | `'fs:stat'` | [src/shared/ipc.ts:57](D:/dev/aether-code/src/shared/ipc.ts:57) |
| `IPC.invoke.fsReveal` | `'fs:reveal'` | [src/shared/ipc.ts:58](D:/dev/aether-code/src/shared/ipc.ts:58) |
| `IPC.invoke.fsWatchDocuments` | `'fs:watch-documents'` | [src/shared/ipc.ts:59](D:/dev/aether-code/src/shared/ipc.ts:59) |
| `IPC.invoke.fsListAll` | `'fs:list-all'` | [src/shared/ipc.ts:61](D:/dev/aether-code/src/shared/ipc.ts:61) |
| `IPC.invoke.fsCopyIntoWorkspace` | `'fs:copy-into-workspace'` | [src/shared/ipc.ts:63](D:/dev/aether-code/src/shared/ipc.ts:63) |
| `IPC.invoke.gitInit` | `'git:init'` | [src/shared/ipc.ts:65](D:/dev/aether-code/src/shared/ipc.ts:65) |
| `IPC.invoke.gitStatus` | `'git:status'` | [src/shared/ipc.ts:66](D:/dev/aether-code/src/shared/ipc.ts:66) |
| `IPC.invoke.gitLeaseStatus` | `'git:lease-status'` | [src/shared/ipc.ts:67](D:/dev/aether-code/src/shared/ipc.ts:67) |
| `IPC.invoke.gitRecoverLease` | `'git:recover-lease'` | [src/shared/ipc.ts:68](D:/dev/aether-code/src/shared/ipc.ts:68) |
| `IPC.invoke.gitDiff` | `'git:diff'` | [src/shared/ipc.ts:69](D:/dev/aether-code/src/shared/ipc.ts:69) |
| `IPC.invoke.gitBranchInfo` | `'git:branch-info'` | [src/shared/ipc.ts:70](D:/dev/aether-code/src/shared/ipc.ts:70) |
| `IPC.invoke.gitStage` | `'git:stage'` | [src/shared/ipc.ts:71](D:/dev/aether-code/src/shared/ipc.ts:71) |
| `IPC.invoke.gitUnstage` | `'git:unstage'` | [src/shared/ipc.ts:72](D:/dev/aether-code/src/shared/ipc.ts:72) |
| `IPC.invoke.gitDiscardFile` | `'git:discard-file'` | [src/shared/ipc.ts:73](D:/dev/aether-code/src/shared/ipc.ts:73) |
| `IPC.invoke.gitDiscardWorktree` | `'git:discard-worktree'` | [src/shared/ipc.ts:74](D:/dev/aether-code/src/shared/ipc.ts:74) |
| `IPC.invoke.gitDiscardWorktreeFiles` | `'git:discard-worktree-files'` | [src/shared/ipc.ts:75](D:/dev/aether-code/src/shared/ipc.ts:75) |
| `IPC.invoke.gitStageFiles` | `'git:stage-files'` | [src/shared/ipc.ts:76](D:/dev/aether-code/src/shared/ipc.ts:76) |
| `IPC.invoke.gitCheckIgnored` | `'git:check-ignored'` | [src/shared/ipc.ts:77](D:/dev/aether-code/src/shared/ipc.ts:77) |
| `IPC.invoke.gitUnstageFiles` | `'git:unstage-files'` | [src/shared/ipc.ts:78](D:/dev/aether-code/src/shared/ipc.ts:78) |
| `IPC.invoke.gitDiscardFiles` | `'git:discard-files'` | [src/shared/ipc.ts:79](D:/dev/aether-code/src/shared/ipc.ts:79) |
| `IPC.invoke.gitHeadFile` | `'git:head-file'` | [src/shared/ipc.ts:80](D:/dev/aether-code/src/shared/ipc.ts:80) |
| `IPC.invoke.gitFetch` | `'git:fetch'` | [src/shared/ipc.ts:81](D:/dev/aether-code/src/shared/ipc.ts:81) |
| `IPC.invoke.gitPull` | `'git:pull'` | [src/shared/ipc.ts:82](D:/dev/aether-code/src/shared/ipc.ts:82) |
| `IPC.invoke.gitPush` | `'git:push'` | [src/shared/ipc.ts:83](D:/dev/aether-code/src/shared/ipc.ts:83) |
| `IPC.invoke.gitDivergence` | `'git:divergence'` | [src/shared/ipc.ts:84](D:/dev/aether-code/src/shared/ipc.ts:84) |
| `IPC.invoke.gitPullMerge` | `'git:pull-merge'` | [src/shared/ipc.ts:85](D:/dev/aether-code/src/shared/ipc.ts:85) |
| `IPC.invoke.gitPullRebaseChoice` | `'git:pull-rebase-choice'` | [src/shared/ipc.ts:86](D:/dev/aether-code/src/shared/ipc.ts:86) |
| `IPC.invoke.gitAddSshKey` | `'git:add-ssh-key'` | [src/shared/ipc.ts:87](D:/dev/aether-code/src/shared/ipc.ts:87) |
| `IPC.invoke.gitBranches` | `'git:branches'` | [src/shared/ipc.ts:88](D:/dev/aether-code/src/shared/ipc.ts:88) |
| `IPC.invoke.gitCheckout` | `'git:checkout'` | [src/shared/ipc.ts:89](D:/dev/aether-code/src/shared/ipc.ts:89) |
| `IPC.invoke.gitCreateBranch` | `'git:create-branch'` | [src/shared/ipc.ts:90](D:/dev/aether-code/src/shared/ipc.ts:90) |
| `IPC.invoke.gitDiscardHunk` | `'git:discard-hunk'` | [src/shared/ipc.ts:91](D:/dev/aether-code/src/shared/ipc.ts:91) |
| `IPC.invoke.gitCommit` | `'git:commit'` | [src/shared/ipc.ts:92](D:/dev/aether-code/src/shared/ipc.ts:92) |
| `IPC.invoke.gitStageAllAndCommit` | `'git:stage-all-and-commit'` | [src/shared/ipc.ts:93](D:/dev/aether-code/src/shared/ipc.ts:93) |
| `IPC.invoke.gitHeadFileContent` | `'git:head-file-content'` | [src/shared/ipc.ts:94](D:/dev/aether-code/src/shared/ipc.ts:94) |
| `IPC.invoke.gitAppendGitignore` | `'git:append-gitignore'` | [src/shared/ipc.ts:95](D:/dev/aether-code/src/shared/ipc.ts:95) |
| `IPC.invoke.gitSuggestMessage` | `'git:suggest-message'` | [src/shared/ipc.ts:97](D:/dev/aether-code/src/shared/ipc.ts:97) |
| `IPC.invoke.gitCommitAmend` | `'git:commit-amend'` | [src/shared/ipc.ts:98](D:/dev/aether-code/src/shared/ipc.ts:98) |
| `IPC.invoke.gitCommitAmendMessage` | `'git:commit-amend-message'` | [src/shared/ipc.ts:99](D:/dev/aether-code/src/shared/ipc.ts:99) |
| `IPC.invoke.gitUndoCommit` | `'git:undo-commit'` | [src/shared/ipc.ts:100](D:/dev/aether-code/src/shared/ipc.ts:100) |
| `IPC.invoke.gitCommitEmpty` | `'git:commit-empty'` | [src/shared/ipc.ts:101](D:/dev/aether-code/src/shared/ipc.ts:101) |
| `IPC.invoke.gitSync` | `'git:sync'` | [src/shared/ipc.ts:102](D:/dev/aether-code/src/shared/ipc.ts:102) |
| `IPC.invoke.gitPullRebase` | `'git:pull-rebase'` | [src/shared/ipc.ts:103](D:/dev/aether-code/src/shared/ipc.ts:103) |
| `IPC.invoke.gitPushForce` | `'git:push-force'` | [src/shared/ipc.ts:104](D:/dev/aether-code/src/shared/ipc.ts:104) |
| `IPC.invoke.gitPushTags` | `'git:push-tags'` | [src/shared/ipc.ts:105](D:/dev/aether-code/src/shared/ipc.ts:105) |
| `IPC.invoke.gitPushTag` | `'git:push-tag'` | [src/shared/ipc.ts:106](D:/dev/aether-code/src/shared/ipc.ts:106) |
| `IPC.invoke.gitPullFrom` | `'git:pull-from'` | [src/shared/ipc.ts:107](D:/dev/aether-code/src/shared/ipc.ts:107) |
| `IPC.invoke.gitPushTo` | `'git:push-to'` | [src/shared/ipc.ts:108](D:/dev/aether-code/src/shared/ipc.ts:108) |
| `IPC.invoke.gitRemoteBranches` | `'git:remote-branches'` | [src/shared/ipc.ts:109](D:/dev/aether-code/src/shared/ipc.ts:109) |
| `IPC.invoke.gitDeleteRemoteBranch` | `'git:delete-remote-branch'` | [src/shared/ipc.ts:110](D:/dev/aether-code/src/shared/ipc.ts:110) |
| `IPC.invoke.gitDeleteRemoteTag` | `'git:delete-remote-tag'` | [src/shared/ipc.ts:111](D:/dev/aether-code/src/shared/ipc.ts:111) |
| `IPC.invoke.gitDeleteBranch` | `'git:delete-branch'` | [src/shared/ipc.ts:112](D:/dev/aether-code/src/shared/ipc.ts:112) |
| `IPC.invoke.gitRenameBranch` | `'git:rename-branch'` | [src/shared/ipc.ts:113](D:/dev/aether-code/src/shared/ipc.ts:113) |
| `IPC.invoke.gitPublishBranch` | `'git:publish-branch'` | [src/shared/ipc.ts:114](D:/dev/aether-code/src/shared/ipc.ts:114) |
| `IPC.invoke.gitMerge` | `'git:merge'` | [src/shared/ipc.ts:115](D:/dev/aether-code/src/shared/ipc.ts:115) |
| `IPC.invoke.gitMergeAbort` | `'git:merge-abort'` | [src/shared/ipc.ts:116](D:/dev/aether-code/src/shared/ipc.ts:116) |
| `IPC.invoke.gitRebase` | `'git:rebase'` | [src/shared/ipc.ts:117](D:/dev/aether-code/src/shared/ipc.ts:117) |
| `IPC.invoke.gitRebaseAbort` | `'git:rebase-abort'` | [src/shared/ipc.ts:118](D:/dev/aether-code/src/shared/ipc.ts:118) |
| `IPC.invoke.gitCherryPick` | `'git:cherry-pick'` | [src/shared/ipc.ts:119](D:/dev/aether-code/src/shared/ipc.ts:119) |
| `IPC.invoke.gitCherryPickAbort` | `'git:cherry-pick-abort'` | [src/shared/ipc.ts:120](D:/dev/aether-code/src/shared/ipc.ts:120) |
| `IPC.invoke.gitRevertCommit` | `'git:revert-commit'` | [src/shared/ipc.ts:121](D:/dev/aether-code/src/shared/ipc.ts:121) |
| `IPC.invoke.gitRemotes` | `'git:remotes'` | [src/shared/ipc.ts:122](D:/dev/aether-code/src/shared/ipc.ts:122) |
| `IPC.invoke.gitAddRemote` | `'git:add-remote'` | [src/shared/ipc.ts:123](D:/dev/aether-code/src/shared/ipc.ts:123) |
| `IPC.invoke.gitRemoveRemote` | `'git:remove-remote'` | [src/shared/ipc.ts:124](D:/dev/aether-code/src/shared/ipc.ts:124) |
| `IPC.invoke.gitClone` | `'git:clone'` | [src/shared/ipc.ts:125](D:/dev/aether-code/src/shared/ipc.ts:125) |
| `IPC.invoke.gitCloneCancel` | `'git:clone-cancel'` | [src/shared/ipc.ts:126](D:/dev/aether-code/src/shared/ipc.ts:126) |
| `IPC.invoke.gitStashList` | `'git:stash-list'` | [src/shared/ipc.ts:127](D:/dev/aether-code/src/shared/ipc.ts:127) |
| `IPC.invoke.gitStashPush` | `'git:stash-push'` | [src/shared/ipc.ts:128](D:/dev/aether-code/src/shared/ipc.ts:128) |
| `IPC.invoke.gitStashPushStaged` | `'git:stash-push-staged'` | [src/shared/ipc.ts:129](D:/dev/aether-code/src/shared/ipc.ts:129) |
| `IPC.invoke.gitStashPop` | `'git:stash-pop'` | [src/shared/ipc.ts:130](D:/dev/aether-code/src/shared/ipc.ts:130) |
| `IPC.invoke.gitStashApply` | `'git:stash-apply'` | [src/shared/ipc.ts:131](D:/dev/aether-code/src/shared/ipc.ts:131) |
| `IPC.invoke.gitStashDrop` | `'git:stash-drop'` | [src/shared/ipc.ts:132](D:/dev/aether-code/src/shared/ipc.ts:132) |
| `IPC.invoke.gitStashDropBatch` | `'git:stash-drop-batch'` | [src/shared/ipc.ts:133](D:/dev/aether-code/src/shared/ipc.ts:133) |
| `IPC.invoke.gitStashClear` | `'git:stash-clear'` | [src/shared/ipc.ts:134](D:/dev/aether-code/src/shared/ipc.ts:134) |
| `IPC.invoke.gitStashShow` | `'git:stash-show'` | [src/shared/ipc.ts:135](D:/dev/aether-code/src/shared/ipc.ts:135) |
| `IPC.invoke.gitStashShowFiles` | `'git:stash-show-files'` | [src/shared/ipc.ts:136](D:/dev/aether-code/src/shared/ipc.ts:136) |
| `IPC.invoke.gitTags` | `'git:tags'` | [src/shared/ipc.ts:137](D:/dev/aether-code/src/shared/ipc.ts:137) |
| `IPC.invoke.gitCreateTag` | `'git:create-tag'` | [src/shared/ipc.ts:138](D:/dev/aether-code/src/shared/ipc.ts:138) |
| `IPC.invoke.gitDeleteTag` | `'git:delete-tag'` | [src/shared/ipc.ts:139](D:/dev/aether-code/src/shared/ipc.ts:139) |
| `IPC.invoke.gitLog` | `'git:log'` | [src/shared/ipc.ts:140](D:/dev/aether-code/src/shared/ipc.ts:140) |
| `IPC.invoke.gitIncoming` | `'git:incoming'` | [src/shared/ipc.ts:141](D:/dev/aether-code/src/shared/ipc.ts:141) |
| `IPC.invoke.gitCommitShow` | `'git:commit-show'` | [src/shared/ipc.ts:142](D:/dev/aether-code/src/shared/ipc.ts:142) |
| `IPC.invoke.gitShowCommitFile` | `'git:show-commit-file'` | [src/shared/ipc.ts:143](D:/dev/aether-code/src/shared/ipc.ts:143) |
| `IPC.invoke.gitFileHistory` | `'git:file-history'` | [src/shared/ipc.ts:144](D:/dev/aether-code/src/shared/ipc.ts:144) |
| `IPC.invoke.gitBlame` | `'git:blame'` | [src/shared/ipc.ts:145](D:/dev/aether-code/src/shared/ipc.ts:145) |
| `IPC.invoke.gitUserName` | `'git:user-name'` | [src/shared/ipc.ts:146](D:/dev/aether-code/src/shared/ipc.ts:146) |
| `IPC.invoke.gitListAuthors` | `'git:list-authors'` | [src/shared/ipc.ts:147](D:/dev/aether-code/src/shared/ipc.ts:147) |
| `IPC.invoke.searchQuery` | `'search:query'` | [src/shared/ipc.ts:149](D:/dev/aether-code/src/shared/ipc.ts:149) |
| `IPC.invoke.searchReplace` | `'search:replace'` | [src/shared/ipc.ts:151](D:/dev/aether-code/src/shared/ipc.ts:151) |
| `IPC.invoke.searchReplacePreview` | `'search:replace-preview'` | [src/shared/ipc.ts:153](D:/dev/aether-code/src/shared/ipc.ts:153) |
| `IPC.invoke.terminalCreate` | `'terminal:create'` | [src/shared/ipc.ts:155](D:/dev/aether-code/src/shared/ipc.ts:155) |
| `IPC.invoke.terminalWrite` | `'terminal:write'` | [src/shared/ipc.ts:156](D:/dev/aether-code/src/shared/ipc.ts:156) |
| `IPC.invoke.terminalResize` | `'terminal:resize'` | [src/shared/ipc.ts:157](D:/dev/aether-code/src/shared/ipc.ts:157) |
| `IPC.invoke.terminalReconnect` | `'terminal:reconnect'` | [src/shared/ipc.ts:158](D:/dev/aether-code/src/shared/ipc.ts:158) |
| `IPC.invoke.terminalDispose` | `'terminal:dispose'` | [src/shared/ipc.ts:159](D:/dev/aether-code/src/shared/ipc.ts:159) |
| `IPC.invoke.lspStart` | `'lsp:start'` | [src/shared/ipc.ts:161](D:/dev/aether-code/src/shared/ipc.ts:161) |
| `IPC.invoke.lspStop` | `'lsp:stop'` | [src/shared/ipc.ts:162](D:/dev/aether-code/src/shared/ipc.ts:162) |
| `IPC.invoke.lspSend` | `'lsp:send'` | [src/shared/ipc.ts:164](D:/dev/aether-code/src/shared/ipc.ts:164) |
| `IPC.invoke.windowMinimize` | `'window:minimize'` | [src/shared/ipc.ts:166](D:/dev/aether-code/src/shared/ipc.ts:166) |
| `IPC.invoke.windowToggleMaximize` | `'window:toggle-maximize'` | [src/shared/ipc.ts:167](D:/dev/aether-code/src/shared/ipc.ts:167) |
| `IPC.invoke.windowClose` | `'window:close'` | [src/shared/ipc.ts:168](D:/dev/aether-code/src/shared/ipc.ts:168) |
| `IPC.invoke.windowIsMaximized` | `'window:is-maximized'` | [src/shared/ipc.ts:169](D:/dev/aether-code/src/shared/ipc.ts:169) |
| `IPC.invoke.windowGetVisibility` | `'window:get-visibility'` | [src/shared/ipc.ts:170](D:/dev/aether-code/src/shared/ipc.ts:170) |
| `IPC.event.accountChanged` | `'account:changed'` | [src/shared/ipc.ts:174](D:/dev/aether-code/src/shared/ipc.ts:174) |
| `IPC.event.fsDocumentsChanged` | `'fs:documents-changed'` | [src/shared/ipc.ts:175](D:/dev/aether-code/src/shared/ipc.ts:175) |
| `IPC.event.engineSnapshot` | `'engine:snapshot'` | [src/shared/ipc.ts:176](D:/dev/aether-code/src/shared/ipc.ts:176) |
| `IPC.event.engineLog` | `'engine:log'` | [src/shared/ipc.ts:177](D:/dev/aether-code/src/shared/ipc.ts:177) |
| `IPC.event.engineLogs` | `'engine:logs'` | [src/shared/ipc.ts:178](D:/dev/aether-code/src/shared/ipc.ts:178) |
| `IPC.event.graphicsChanged` | `'graphics:changed'` | [src/shared/ipc.ts:179](D:/dev/aether-code/src/shared/ipc.ts:179) |
| `IPC.event.engineImportProgress` | `'engine:import-progress'` | [src/shared/ipc.ts:180](D:/dev/aether-code/src/shared/ipc.ts:180) |
| `IPC.event.streamEvent` | `'engine:stream:event'` | [src/shared/ipc.ts:181](D:/dev/aether-code/src/shared/ipc.ts:181) |
| `IPC.event.terminalData` | `'terminal:data'` | [src/shared/ipc.ts:182](D:/dev/aether-code/src/shared/ipc.ts:182) |
| `IPC.event.terminalExit` | `'terminal:exit'` | [src/shared/ipc.ts:183](D:/dev/aether-code/src/shared/ipc.ts:183) |
| `IPC.event.gitCloneProgress` | `'git:clone-progress'` | [src/shared/ipc.ts:185](D:/dev/aether-code/src/shared/ipc.ts:185) |
| `IPC.event.lspMessage` | `'lsp:message'` | [src/shared/ipc.ts:187](D:/dev/aether-code/src/shared/ipc.ts:187) |
| `IPC.event.lspExit` | `'lsp:exit'` | [src/shared/ipc.ts:189](D:/dev/aether-code/src/shared/ipc.ts:189) |
| `IPC.event.windowVisibility` | `'window:visibility'` | [src/shared/ipc.ts:190](D:/dev/aether-code/src/shared/ipc.ts:190) |
| `WORK_QUEUE_IPC.invoke` | `'work:next-turn-queue'` | [src/shared/work-next-turn-api.ts:3](D:/dev/aether-code/src/shared/work-next-turn-api.ts:3) |
| `WORK_QUEUE_IPC.changed` | `'work:next-turn-queue:changed'` | [src/shared/work-next-turn-api.ts:3](D:/dev/aether-code/src/shared/work-next-turn-api.ts:3) |

## 应用命令、视图与入口全量清单

| 命令 ID | 显示名 | 分类/条件 | 证据 |
| --- | --- | --- | --- |
| `'aether.browser.open'` | '打开内置浏览器' | '浏览器' | [src/renderer/src/contrib/browser/index.ts:23](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:23) |
| `'aether.browser.openToSide'` | '在右侧打开浏览器' | '浏览器' | [src/renderer/src/contrib/browser/index.ts:29](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:29) |
| `'aether.browser.settings'` | '打开浏览器设置' | '浏览器' | [src/renderer/src/contrib/browser/index.ts:38](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:38) |
| `'aether.browser.newTab'` | '新建网页标签' | '浏览器' | [src/renderer/src/contrib/browser/index.ts:44](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:44) |
| `'aether.editor.addSelectionToChat'` | '添加选区到对话' | '编辑器' | [src/renderer/src/contrib/editor/editor-commands.ts:159](D:/dev/aether-code/src/renderer/src/contrib/editor/editor-commands.ts:159) |
| `'aether.editor.addFileToChat'` | '添加当前文件到对话' | '编辑器' | [src/renderer/src/contrib/editor/editor-commands.ts:163](D:/dev/aether-code/src/renderer/src/contrib/editor/editor-commands.ts:163) |
| `'aether.editor.toggleWordWrap'` | '切换自动换行' | '编辑器' | [src/renderer/src/contrib/editor/editor-commands.ts:194](D:/dev/aether-code/src/renderer/src/contrib/editor/editor-commands.ts:194) |
| `'aether.editor.toggleMinimap'` | '切换小地图' | '编辑器' | [src/renderer/src/contrib/editor/editor-commands.ts:204](D:/dev/aether-code/src/renderer/src/contrib/editor/editor-commands.ts:204) |
| `'aether.workspace.openFolder'` | '打开文件夹' | '文件' | [src/renderer/src/contrib/index.ts:150](D:/dev/aether-code/src/renderer/src/contrib/index.ts:150) |
| `'aether.file.save'` | '保存文件' | '文件' | [src/renderer/src/contrib/index.ts:156](D:/dev/aether-code/src/renderer/src/contrib/index.ts:156) |
| `'aether.file.saveAll'` | '保存全部文件' | '文件' | [src/renderer/src/contrib/index.ts:162](D:/dev/aether-code/src/renderer/src/contrib/index.ts:162) |
| `'aether.file.undo'` | '撤销文件操作' | '文件' / 'fileOpUndoable' | [src/renderer/src/contrib/index.ts:168](D:/dev/aether-code/src/renderer/src/contrib/index.ts:168) |
| `'aether.explorer.deleteSelected'` | '删除选中的文件' | '文件' / 'explorerHasSelection' | [src/renderer/src/contrib/index.ts:176](D:/dev/aether-code/src/renderer/src/contrib/index.ts:176) |
| `'aether.explorer.cut'` | '剪切选中的文件' | '文件' / 'explorerHasSelection' | [src/renderer/src/contrib/index.ts:198](D:/dev/aether-code/src/renderer/src/contrib/index.ts:198) |
| `'aether.explorer.copy'` | '复制选中的文件' | '文件' / 'explorerHasSelection' | [src/renderer/src/contrib/index.ts:208](D:/dev/aether-code/src/renderer/src/contrib/index.ts:208) |
| `'aether.explorer.paste'` | '粘贴文件' | '文件' / 'explorerClipboardReady' | [src/renderer/src/contrib/index.ts:218](D:/dev/aether-code/src/renderer/src/contrib/index.ts:218) |
| `'aether.engine.start'` | '启动引擎' | '引擎' / '!engineBusy' | [src/renderer/src/contrib/index.ts:228](D:/dev/aether-code/src/renderer/src/contrib/index.ts:228) |
| `'aether.engine.stop'` | '停止引擎' | '引擎' / 'engineReady' | [src/renderer/src/contrib/index.ts:235](D:/dev/aether-code/src/renderer/src/contrib/index.ts:235) |
| `'aether.engine.restart'` | '重启引擎' | '引擎' / '!engineBusy' | [src/renderer/src/contrib/index.ts:242](D:/dev/aether-code/src/renderer/src/contrib/index.ts:242) |
| `'aether.terminal.newLocal'` | '新建终端' | '终端' | [src/renderer/src/contrib/index.ts:250](D:/dev/aether-code/src/renderer/src/contrib/index.ts:250) |
| `'aether.lsp.diagnose'` | '诊断当前文件' | 'LSP' / 'engineReady' | [src/renderer/src/contrib/index.ts:260](D:/dev/aether-code/src/renderer/src/contrib/index.ts:260) |
| `'aether.editor.closeTab'` | '关闭编辑器' | '编辑器' / 'editorTabsCount > 0' | [src/renderer/src/contrib/index.ts:276](D:/dev/aether-code/src/renderer/src/contrib/index.ts:276) |
| `'aether.editor.closeOthers'` | '关闭其他编辑器' | '编辑器' / 'editorTabsCount > 1' | [src/renderer/src/contrib/index.ts:283](D:/dev/aether-code/src/renderer/src/contrib/index.ts:283) |
| `'aether.editor.closeToRight'` | '关闭右侧编辑器' | '编辑器' / 'editorTabsCount > 1' | [src/renderer/src/contrib/index.ts:294](D:/dev/aether-code/src/renderer/src/contrib/index.ts:294) |
| `'aether.editor.closeAll'` | '全部关闭编辑器' | '编辑器' / 'editorTabsCount > 0' | [src/renderer/src/contrib/index.ts:301](D:/dev/aether-code/src/renderer/src/contrib/index.ts:301) |
| `'aether.editor.splitRight'` | '向右拆分编辑器' | '编辑器' / 'activeEditorIsFile' | [src/renderer/src/contrib/index.ts:308](D:/dev/aether-code/src/renderer/src/contrib/index.ts:308) |
| `'aether.editor.focusOtherGroup'` | '切换到另一编辑组' | '编辑器' / 'editorGroupCount > 1' | [src/renderer/src/contrib/index.ts:318](D:/dev/aether-code/src/renderer/src/contrib/index.ts:318) |
| `'aether.editor.closeGroup'` | '关闭编辑组' | '编辑器' | [src/renderer/src/contrib/index.ts:329](D:/dev/aether-code/src/renderer/src/contrib/index.ts:329) |
| `'aether.editor.reopenClosed'` | '重新打开已关闭的编辑器' | '编辑器' | [src/renderer/src/contrib/index.ts:335](D:/dev/aether-code/src/renderer/src/contrib/index.ts:335) |
| `'aether.editor.nextTab'` | '切换到下一个编辑器' | '编辑器' / 'editorTabsCount > 1' | [src/renderer/src/contrib/index.ts:341](D:/dev/aether-code/src/renderer/src/contrib/index.ts:341) |
| `'aether.editor.previousTab'` | '切换到上一个编辑器' | '编辑器' / 'editorTabsCount > 1' | [src/renderer/src/contrib/index.ts:348](D:/dev/aether-code/src/renderer/src/contrib/index.ts:348) |
| `'aether.view.toggleSidebar'` | '切换侧边栏可见性' | '视图' | [src/renderer/src/contrib/index.ts:356](D:/dev/aether-code/src/renderer/src/contrib/index.ts:356) |
| `'aether.view.explorer'` | '显示资源管理器' | '视图' | [src/renderer/src/contrib/index.ts:362](D:/dev/aether-code/src/renderer/src/contrib/index.ts:362) |
| `'aether.view.sessionHistory'` | '显示会话历史' | '视图' | [src/renderer/src/contrib/index.ts:368](D:/dev/aether-code/src/renderer/src/contrib/index.ts:368) |
| `'aether.chat.newSession'` | '新建会话' | '对话' | [src/renderer/src/contrib/index.ts:374](D:/dev/aether-code/src/renderer/src/contrib/index.ts:374) |
| `'aether.view.search'` | '全局搜索' | '视图' | [src/renderer/src/contrib/index.ts:386](D:/dev/aether-code/src/renderer/src/contrib/index.ts:386) |
| `'aether.view.chat'` | '切换对话面板' | '视图' | [src/renderer/src/contrib/index.ts:393](D:/dev/aether-code/src/renderer/src/contrib/index.ts:393) |
| `'aether.view.models'` | '管理模型' | '视图' | [src/renderer/src/contrib/index.ts:399](D:/dev/aether-code/src/renderer/src/contrib/index.ts:399) |
| `'aether.view.security'` | '安全策略' | '视图' | [src/renderer/src/contrib/index.ts:405](D:/dev/aether-code/src/renderer/src/contrib/index.ts:405) |
| `'aether.view.git'` | '版本控制' | '视图' | [src/renderer/src/contrib/index.ts:411](D:/dev/aether-code/src/renderer/src/contrib/index.ts:411) |
| `'aether.view.appSettings'` | '打开设置' | '视图' | [src/renderer/src/contrib/index.ts:417](D:/dev/aether-code/src/renderer/src/contrib/index.ts:417) |
| `'aether.view.codegraph'` | '代码图索引' | '视图' | [src/renderer/src/contrib/index.ts:423](D:/dev/aether-code/src/renderer/src/contrib/index.ts:423) |
| `'aether.preferences.openKeybindings'` | '打开键盘快捷方式' | '首选项' | [src/renderer/src/contrib/index.ts:429](D:/dev/aether-code/src/renderer/src/contrib/index.ts:429) |
| `'aether.panel.problems'` | '切换问题面板' | '视图' | [src/renderer/src/contrib/index.ts:435](D:/dev/aether-code/src/renderer/src/contrib/index.ts:435) |
| `'aether.panel.terminal'` | '切换终端面板' | '视图' | [src/renderer/src/contrib/index.ts:441](D:/dev/aether-code/src/renderer/src/contrib/index.ts:441) |
| `'aether.panel.output'` | '切换输出面板' | '视图' | [src/renderer/src/contrib/index.ts:447](D:/dev/aether-code/src/renderer/src/contrib/index.ts:447) |
| `'aether.output.show'` | '显示输出面板' | '视图' | [src/renderer/src/contrib/index.ts:453](D:/dev/aether-code/src/renderer/src/contrib/index.ts:453) |
| `'aether.work.new'` | '新建 Work 任务' | 'Work' | [src/renderer/src/contrib/work/WorkView.tsx:449](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:449) |
| `'aether.commandPalette.toggle'` | '命令面板' | '视图' | [src/renderer/src/workbench/CommandPalette.tsx:35](D:/dev/aether-code/src/renderer/src/workbench/CommandPalette.tsx:35) |
| `'aether.mode.code'` | '切换到 Code 开发' | '工作台' | [src/renderer/src/workbench/MenuBar.tsx:112](D:/dev/aether-code/src/renderer/src/workbench/MenuBar.tsx:112) |
| `'aether.mode.work'` | '切换到 Work 办公' | '工作台' | [src/renderer/src/workbench/MenuBar.tsx:118](D:/dev/aether-code/src/renderer/src/workbench/MenuBar.tsx:118) |
| `'aether.quickOpen.toggle'` | '转到文件…' | '文件' | [src/renderer/src/workbench/QuickOpen.tsx:92](D:/dev/aether-code/src/renderer/src/workbench/QuickOpen.tsx:92) |

Monaco 自定义命令：

| ID | 证据 |
| --- | --- |
| `'aether.lsp.executeCommand'` | [src/renderer/src/core/lsp/code-actions.ts:209](D:/dev/aether-code/src/renderer/src/core/lsp/code-actions.ts:209) |
| `'aether.lsp.applyCodeAction'` | [src/renderer/src/core/lsp/code-actions.ts:216](D:/dev/aether-code/src/renderer/src/core/lsp/code-actions.ts:216) |

视图登记：

| ID | 名称 | 位置 | 组件 | 证据 |
| --- | --- | --- | --- | --- |
| `'browser'` | '浏览器' | `'editor'` | `BrowserView` | [src/renderer/src/contrib/browser/index.ts:13](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:13) |
| `'git-file-diff'` | '文件差异' | `'editor'` | `GitDiffView` | [src/renderer/src/contrib/git/GitDiffView.tsx:30](D:/dev/aether-code/src/renderer/src/contrib/git/GitDiffView.tsx:30) |
| `'session-history'` | '会话历史' | `'sidebar'` | `SessionHistoryView` | [src/renderer/src/contrib/index.ts:73](D:/dev/aether-code/src/renderer/src/contrib/index.ts:73) |
| `'explorer'` | '资源管理器' | `'sidebar'` | `ExplorerView` | [src/renderer/src/contrib/index.ts:81](D:/dev/aether-code/src/renderer/src/contrib/index.ts:81) |
| `'search'` | '搜索' | `'sidebar'` | `SearchView` | [src/renderer/src/contrib/index.ts:89](D:/dev/aether-code/src/renderer/src/contrib/index.ts:89) |
| `'git'` | '版本控制' | `'sidebar'` | `GitView` | [src/renderer/src/contrib/index.ts:97](D:/dev/aether-code/src/renderer/src/contrib/index.ts:97) |
| `'chat'` | '对话' | `'right'` | `ChatView` | [src/renderer/src/contrib/index.ts:105](D:/dev/aether-code/src/renderer/src/contrib/index.ts:105) |
| `'app-settings'` | '设置' | `'editor'` | `AppSettingsView` | [src/renderer/src/contrib/index.ts:113](D:/dev/aether-code/src/renderer/src/contrib/index.ts:113) |
| `'problems'` | '问题' | `'panel'` | `ProblemsView` | [src/renderer/src/contrib/index.ts:122](D:/dev/aether-code/src/renderer/src/contrib/index.ts:122) |
| `'terminal'` | '终端' | `'panel'` | `TerminalView` | [src/renderer/src/contrib/index.ts:130](D:/dev/aether-code/src/renderer/src/contrib/index.ts:130) |
| `'output'` | '输出' | `'panel'` | `OutputView` | [src/renderer/src/contrib/index.ts:138](D:/dev/aether-code/src/renderer/src/contrib/index.ts:138) |

文档渲染器：`DocumentView` [src/renderer/src/contrib/index.ts:68](D:/dev/aether-code/src/renderer/src/contrib/index.ts:68)。

Work 一级入口：

| ID | 名称 | 证据 |
| --- | --- | --- |
| `'home'` | '工作台' | [src/renderer/src/contrib/work/WorkView.tsx:142](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:142) |
| `'projects'` | '项目' | [src/renderer/src/contrib/work/WorkView.tsx:143](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:143) |
| `'agents'` | 'Agent' | [src/renderer/src/contrib/work/WorkView.tsx:144](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:144) |
| `'artifacts'` | '成果' | [src/renderer/src/contrib/work/WorkView.tsx:145](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:145) |
| `'browser'` | '浏览器' | [src/renderer/src/contrib/work/WorkView.tsx:146](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:146) |
| `'automations'` | '自动化' | [src/renderer/src/contrib/work/WorkView.tsx:147](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:147) |
| `'connections'` | '连接' | [src/renderer/src/contrib/work/WorkView.tsx:148](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:148) |
| `'monitor'` | '引擎监控' | [src/renderer/src/contrib/work/WorkView.tsx:149](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:149) |

## 设置分区与可搜索设置元数据

| ID | 名称 | 分组 | 证据 |
| --- | --- | --- | --- |
| `'account'` | '个人账号' | '基础' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:66](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:66) |
| `'general'` | '引擎管理' | '基础' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:74](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:74) |
| `'appearance'` | '外观' | '基础' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:82](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:82) |
| `'editor'` | '文本编辑器' | '文本编辑器' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:90](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:90) |
| `'terminal'` | '终端' | '文本编辑器' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:98](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:98) |
| `'models'` | '模型' | '工作区' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:106](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:106) |
| `'files'` | '文件' | '工作区' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:114](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:114) |
| `'search'` | '搜索' | '工作区' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:122](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:122) |
| `'keybindings'` | '键盘' | '工作区' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:130](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:130) |
| `'git'` | '源代码管理' | '功能' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:138](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:138) |
| `'workbench'` | '工作台' | '功能' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:146](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:146) |
| `'browser'` | '浏览器' | '功能' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:154](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:154) |
| `'security'` | '安全' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:159](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:159) |
| `'codegraph'` | '代码图' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:167](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:167) |
| `'mcp'` | 'MCP' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:175](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:175) |
| `'skills'` | '技能' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:183](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:183) |
| `'knowledge'` | '知识库' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:191](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:191) |
| `'memory'` | '记忆' | '高级' | [src/renderer/src/contrib/settings/AppSettingsView.tsx:199](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:199) |

元数据不是全部设置页面控件，也不是模型工具声明。

| 设置 key | 名称 | 说明 | 作用域 | 证据 |
| --- | --- | --- | --- | --- |
| `'browser.homeUrl'` | '浏览器默认地址' | '新建网页标签的默认地址，可填写项目开发服务地址。' | 'user' | [src/renderer/src/contrib/browser/index.ts:58](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:58) |
| `'browser.zoomFactor'` | '默认网页缩放' | '设置新建网页的显示缩放比例。' | 'user' | [src/renderer/src/contrib/browser/index.ts:67](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:67) |
| `'browser.defaultViewport'` | '默认浏览器视口' | '选择桌面、手机或自适应网页视口。' | 'user' | [src/renderer/src/contrib/browser/index.ts:76](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:76) |
| `'browser.persistSession'` | '保存网页登录状态' | '保留浏览器的 Cookie、登录和站点存储。' | 'user' | [src/renderer/src/contrib/browser/index.ts:85](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:85) |
| `'browser.aiEnabled'` | '允许 AI 使用内置浏览器' | '让当前对话的 AI 读取与操作内置网页。' | 'user' | [src/renderer/src/contrib/browser/index.ts:94](D:/dev/aether-code/src/renderer/src/contrib/browser/index.ts:94) |
| `'aether.graphicsMode'` | '图形加速' | '选择自动、硬件加速或软件渲染；下次启动时生效。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:24](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:24) |
| `'aether.visualEffects'` | '视觉效果' | '选择自动、完整、精简或实色材质。软件渲染自动减少透明效果。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:28](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:28) |
| `'aether.account.profile'` | '个人账号与登录' | '管理姓名、邮箱、简介、第三方账号绑定、恢复凭证和登录设备。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:32](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:32) |
| `'editor.fontFamily'` | '字体' | '编辑器使用的等宽字体族。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:38](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:38) |
| `'editor.fontSize'` | '字号' | '编辑器文字的显示字号。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:47](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:47) |
| `'editor.lineHeight'` | '行高' | '编辑器每行的像素高度。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:56](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:56) |
| `'editor.tabSize'` | '缩进空格数' | '一个缩进使用的空格数量。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:65](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:65) |
| `'editor.fontLigatures'` | '字体连字' | '是否启用字体连字显示。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:74](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:74) |
| `'terminal.integrated.fontFamily'` | '终端字体' | '集成终端使用的等宽字体族。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:83](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:83) |
| `'terminal.integrated.fontSize'` | '终端字号' | '集成终端文字的显示字号。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:92](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:92) |
| `'terminal.integrated.lineHeight'` | '终端行高' | '集成终端的行高倍率。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:101](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:101) |
| `'terminal.integrated.cursorBlinking'` | '终端光标闪烁' | '终端获得焦点时显示闪烁光标。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:110](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:110) |
| `'terminal.integrated.scrollback'` | '终端滚动缓冲' | '终端保留的历史行数。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:119](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:119) |
| `'editor.wordWrap'` | '自动换行' | '长行超出编辑器宽度时自动换行。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:128](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:128) |
| `'editor.minimap.enabled'` | '显示小地图' | '在编辑器右侧显示代码缩略图。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:137](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:137) |
| `'files.exclude'` | '资源管理器排除规则' | '控制哪些文件和目录不显示在资源管理器中。' | 'workspace' | [src/renderer/src/contrib/settings/settings-registry.ts:146](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:146) |
| `'search.exclude'` | '搜索排除规则' | '控制全文搜索跳过哪些文件和目录。' | 'workspace' | [src/renderer/src/contrib/settings/settings-registry.ts:155](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:155) |
| `'aether.engine.mode'` | '引擎运行方式' | '选择本地内置引擎或远程引擎连接。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:164](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:164) |
| `'aether.engine.autoStart'` | '启动时自动连接引擎' | '应用启动时自动启动或连接配置好的引擎。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:173](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:173) |
| `'aether.appearance.theme'` | '颜色主题' | '选择浅色、深色或跟随系统外观。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:182](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:182) |
| `'aether.appearance.accent'` | '强调色' | '选择预设或自定义颜色，设置选中态、焦点环和交互控件使用的强调色。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:191](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:191) |
| `'aether.models.default'` | '默认模型' | '设置新会话使用的默认模型。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:200](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:200) |
| `'aether.security.mode'` | '安全模式' | '控制引擎工具调用的权限策略。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:209](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:209) |
| `'aether.mcp.servers'` | 'MCP 服务' | '管理可供智能体使用的 MCP 服务。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:218](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:218) |
| `'aether.skills.registry'` | '技能注册表' | '导入、创建和启用可复用的技能。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:227](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:227) |
| `'aether.knowledge.bases'` | '知识库' | '管理文档索引和检索知识库。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:236](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:236) |
| `'aether.memory.scope'` | '记忆范围' | '管理全局记忆和会话记忆的作用范围。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:245](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:245) |
| `'aether.keybindings'` | '键盘快捷键' | '查看和调整 Aether 的操作快捷键。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:254](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:254) |
| `'git.autofetch'` | '自动获取远端更新' | '按固定间隔在后台静默执行 git fetch。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:263](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:263) |
| `'git.autofetchInterval'` | '自动获取间隔' | '后台检查远端更新的时间间隔。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:272](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:272) |
| `'workbench.sidebar.visible'` | '显示侧边栏' | '显示资源管理器、搜索和源代码管理等侧边栏视图。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:281](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:281) |
| `'workbench.panel.visible'` | '显示底部面板' | '显示终端、输出和问题等底部面板。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:290](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:290) |
| `'workbench.chatPanel.visible'` | '显示对话面板' | '显示 Aether 对话侧栏。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:299](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:299) |
| `'workbench.chatPanel.position'` | '对话面板位置' | '选择对话面板位于编辑区左侧或右侧。' | 'user' | [src/renderer/src/contrib/settings/settings-registry.ts:308](D:/dev/aether-code/src/renderer/src/contrib/settings/settings-registry.ts:308) |

## 引擎 HTTP 请求对象全量清单

以下保存的是源码中的 method/path/query/body 表达式。动态变量不伪装成确定 URL；同一路径不同调用者都保留，便于排查 Work/Code 差异。多数引擎业务路径由主进程加 /api/v1 前缀；SSE 和 multipart 已按真实传输方式标注。

| 方式 | 路径表达式 | query | body / 传输 | 证据 |
| --- | --- | --- | --- | --- |
| `'GET'` | `'/cron/capabilities'` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:35](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:35) |
| `'GET'` | `'/cron'` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:43](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:43) |
| `'GET'` | `/cron/${encodeURIComponent(id)}` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:44](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:44) |
| `id ? 'PUT' : 'POST'` | `id ? /cron/${encodeURIComponent(id)} : '/cron'` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:45](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:45) |
| `'POST'` | `/cron/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}` | `—` | `{}` | [src/renderer/src/contrib/automations/automation-client.ts:46](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:46) |
| `'DELETE'` | `/cron/${encodeURIComponent(id)}` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:47](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:47) |
| `'POST'` | `'/cron/preview'` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:48](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:48) |
| `'GET'` | `/cron/${encodeURIComponent(id)}/runs` | `{ limit: 24, ...(cursor ? { cursor } : {}) }` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:49](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:49) |
| `'GET'` | `/cron/runs/${encodeURIComponent(id)}` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:50](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:50) |
| `'POST'` | `/cron/runs/${encodeURIComponent(id)}/cancel` | `—` | `{}` | [src/renderer/src/contrib/automations/automation-client.ts:51](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:51) |
| `'GET'` | `'/cron/notifications'` | `{ limit: 24, ...(cursor ? { cursor } : {}) }` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:52](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:52) |
| `'POST'` | `/cron/notifications/${encodeURIComponent(id)}/read` | `—` | `{}` | [src/renderer/src/contrib/automations/automation-client.ts:53](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:53) |
| `'GET'` | `/sessions/${encodeURIComponent(id)}/binding` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:54](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:54) |
| `'GET'` | `'/agents'` | `—` | `—` | [src/renderer/src/contrib/automations/automation-client.ts:55](D:/dev/aether-code/src/renderer/src/contrib/automations/automation-client.ts:55) |
| `'GET'` | `'/agents'` | `—` | `—` | [src/renderer/src/contrib/chat/AgentRefPicker.tsx:23](D:/dev/aether-code/src/renderer/src/contrib/chat/AgentRefPicker.tsx:23) |
| `'GET'` | `'/changes'` | `{ sessionId, status: 'pending', view: 'net' }` | `—` | [src/renderer/src/contrib/chat/ChangesPanel.tsx:136](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:136) |
| `'POST'` | `'/changes/keep-all'` | `—` | `{ sessionId }` | [src/renderer/src/contrib/chat/ChangesPanel.tsx:255](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:255) |
| `'GET'` | `'/codegraph/status'` | `{ sessionId, path: codegraphRoot }` | `—` | [src/renderer/src/contrib/chat/ChatView.tsx:1145](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:1145) |
| `'GET'` | `'/codegraph/status'` | `{ sessionId, path: codegraphRoot }` | `—` | [src/renderer/src/contrib/chat/ChatView.tsx:1177](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:1177) |
| `'POST'` | `'/codegraph/index'` | `—` | `{ sessionId, path: codegraphRoot }` | [src/renderer/src/contrib/chat/ChatView.tsx:1222](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:1222) |
| `'GET'` | `'/skills'` | `{ reload: 1, path: projectPath \|\| undefined }` | `—` | [src/renderer/src/contrib/chat/ResourcePicker.tsx:36](D:/dev/aether-code/src/renderer/src/contrib/chat/ResourcePicker.tsx:36) |
| `'GET'` | `'/mcp/servers'` | `projectPath ? { path: projectPath } : undefined` | `—` | [src/renderer/src/contrib/chat/ResourcePicker.tsx:37](D:/dev/aether-code/src/renderer/src/contrib/chat/ResourcePicker.tsx:37) |
| `'GET'` | `'/conversation/sessions'` | `—` | `—` | [src/renderer/src/contrib/history/SessionHistoryView.tsx:159](D:/dev/aether-code/src/renderer/src/contrib/history/SessionHistoryView.tsx:159) |
| `'DELETE'` | `/sessions/${encodeURIComponent(sessionId)}` | `{ keepWorkspace: 'true' }` | `—` | [src/renderer/src/contrib/history/SessionHistoryView.tsx:301](D:/dev/aether-code/src/renderer/src/contrib/history/SessionHistoryView.tsx:301) |
| `'GET'` | `'/workspace/file/content'` | `{ sessionId: context.sessionId, path }` | `—` | [src/renderer/src/contrib/search/search-store.ts:62](D:/dev/aether-code/src/renderer/src/contrib/search/search-store.ts:62) |
| `'POST'` | `'/workspace/file'` | `—` | `{ sessionId: context.sessionId, path, content }` | [src/renderer/src/contrib/search/search-store.ts:63](D:/dev/aether-code/src/renderer/src/contrib/search/search-store.ts:63) |
| `'GET'` | `'/codegraph/status'` | `{ path: projectRoot \|\| undefined, sessionId }` | `—` | [src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:82](D:/dev/aether-code/src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:82) |
| `'GET'` | `'/codegraph/status'` | `{ path: projectRoot \|\| undefined, sessionId }` | `—` | [src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:100](D:/dev/aether-code/src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:100) |
| `'POST'` | `'/codegraph/index'` | `—` | `{ path: projectRoot \|\| undefined, sessionId, force: true }` | [src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:140](D:/dev/aether-code/src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:140) |
| `'GET'` | `'/mcp/servers'` | `—` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:42](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:42) |
| `editing ? 'PATCH' : 'POST'` | `editing ? /mcp/servers/${encodeURIComponent(editing)} : '/mcp/servers'` | `editing ? { ...(query ?? {}), scope: form.scope } : query` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:71](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:71) |
| `'POST'` | `/mcp/servers/${encodeURIComponent(server.id)}/${enabled ? 'enable' : 'disable'}` | `{ ...(query ?? {}), scope: server.scope ?? 'project' }` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:76](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:76) |
| `'DELETE'` | `/mcp/servers/${encodeURIComponent(server.id)}` | `{ ...(query ?? {}), scope: server.scope ?? 'project' }` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:77](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:77) |
| `'POST'` | `/mcp/servers/${encodeURIComponent(server.id)}/test` | `{ ...(query ?? {}), scope: server.scope ?? 'project' }` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:78](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:78) |
| `'PATCH'` | `/mcp/servers/${encodeURIComponent(server.id)}` | `{ ...(query ?? {}), scope: server.scope ?? 'project' }` | `{ disabledTools: [...disabled] }` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:88](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:88) |
| `'GET'` | `'/mcp/config/export'` | `{ ...(query ?? {}), scope: jsonScope }` | `—` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:93](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:93) |
| `'POST'` | `'/mcp/config/import'` | `—` | `{ scope: jsonScope, config }` | [src/renderer/src/contrib/settings/McpSettingsView.tsx:101](D:/dev/aether-code/src/renderer/src/contrib/settings/McpSettingsView.tsx:101) |
| `'GET'` | `'/skills'` | `{ reload: 1, all: 1, path: projectRoot \|\| undefined }` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:134](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:134) |
| `'GET'` | `'/skills/imports'` | `{ limit: 20, scope, projectRoot: scope === 'global' ? undefined : projectRoot \|\| undefined }` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:145](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:145) |
| `'GET'` | `/skills/${encodeURIComponent(skillKey(skill))}` | `{ path: projectRoot \|\| undefined, scope: skill.scope }` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:166](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:166) |
| `'PATCH'` | `/skills/${encodeURIComponent(skillKey(skill))}` | `{ path: projectRoot \|\| undefined, scope: skill.scope }` | `{ enabled }` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:175](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:175) |
| `'DELETE'` | `/skills/${encodeURIComponent(skillKey(skill))}` | `{ path: projectRoot \|\| undefined, scope: skill.scope }` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:193](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:193) |
| `'GET'` | `/skills/imports/${encodeURIComponent(importId)}` | `—` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:204](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:204) |
| `'POST'` | `'/skills/imports'` | `—` | `—；multipart upload` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:241](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:241) |
| `'POST'` | `'/skills/imports/chunks'` | `—` | `—；multipart upload` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:256](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:256) |
| `'POST'` | `'/skills/imports/chunks/merge'` | `—` | `{ importId }` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:280](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:280) |
| `'DELETE'` | `/skills/imports/${encodeURIComponent(item.importId)}` | `—` | `—` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:300](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:300) |
| `'POST'` | `'/skills'` | `—` | `{ name, description: createDescription.trim() \|\| name, content, scope, overwrite: createOverwrite, ...(projectRoot && scope === 'project' ? { projectRoot } : {}) }` | [src/renderer/src/contrib/settings/SkillsSettingsView.tsx:324](D:/dev/aether-code/src/renderer/src/contrib/settings/SkillsSettingsView.tsx:324) |
| `'GET'` | `'/performance/runtime'` | `—` | `—` | [src/renderer/src/contrib/work/EngineRuntimeHealth.tsx:24](D:/dev/aether-code/src/renderer/src/contrib/work/EngineRuntimeHealth.tsx:24) |
| `'GET'` | `/agents/${encodeURIComponent(id)}` | `—` | `—` | [src/renderer/src/contrib/work/work-agent-identity.ts:39](D:/dev/aether-code/src/renderer/src/contrib/work/work-agent-identity.ts:39) |
| `'GET'` | `'/chat/status'` | `{ sessionId: id }` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:263](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:263) |
| `'GET'` | `'/chat/status'` | `{ sessionId: activeTask.id }` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:846](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:846) |
| `'POST'` | `'/chat/cancel'` | `—` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:847](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:847) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(run.runId)}` | `—` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:866](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:866) |
| `'GET'` | `'/chat/status'` | `{ sessionId: id }` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:893](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:893) |
| `'POST'` | `'/chat/cancel'` | `—` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:894](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:894) |
| `'GET'` | `'/chat/snapshot'` | `{ sessionId: id }` | `—` | [src/renderer/src/contrib/work/work-runtime.ts:914](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:914) |
| `'POST'` | `'/workspace/file'` | `—` | `{ sessionId, path: relativePath, content: encodeBase64(data), encoding: 'base64' }` | [src/renderer/src/contrib/work/work-runtime.ts:1076](D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:1076) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(identity.runId)}` | `—` | `—` | [src/renderer/src/contrib/work/work-subagent-transcript.ts:57](D:/dev/aether-code/src/renderer/src/contrib/work/work-subagent-transcript.ts:57) |
| `'GET'` | `endpoint → /conversation/archive / /conversation/history` | `{ sessionId: run.childSessionId, current: String(current), pageSize: String(pageSize) }` | `—` | [src/renderer/src/contrib/work/work-subagent-transcript.ts:64](D:/dev/aether-code/src/renderer/src/contrib/work/work-subagent-transcript.ts:64) |
| `'GET'` | `'/agents'` | `—` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:272](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:272) |
| `'GET'` | `'/skills'` | `workspacePath ? { path: workspacePath } : undefined` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:340](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:340) |
| `'GET'` | `'/mcp/servers'` | `workspacePath ? { path: workspacePath } : undefined` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:355](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:355) |
| `'GET'` | `'/tools'` | `workspacePath ? { path: workspacePath } : undefined` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:391](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:391) |
| `'GET'` | `/agents/${encodeURIComponent(agent.id)}` | `—` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:414](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:414) |
| `draft.id ? 'PUT' : 'POST'` | `draft.id ? /agents/${encodeURIComponent(draft.id)} : '/agents'` | `—` | `{ name: draft.name.trim(), description: draft.description.trim(), systemPrompt: draft.systemPrompt, model: draft.model, temperature, skills: draft.skills, mcpServers: draft.mcpServers, knowledgeBases: draft.knowledgeBases, allowedTools: draft.allowedTools }` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:469](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:469) |
| `'DELETE'` | `/agents/${encodeURIComponent(deleting.id)}` | `—` | `—` | [src/renderer/src/contrib/work/WorkAgentManager.tsx:500](D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:500) |
| `'GET'` | `'/chat/snapshot'` | `{ sessionId: run.sessionId }` | `—` | [src/renderer/src/contrib/work/WorkView.tsx:409](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:409) |
| `'GET'` | `'/changes'` | `{ sessionId, status: 'pending', view: 'net' }` | `—` | [src/renderer/src/contrib/work/WorkView.tsx:2291](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:2291) |
| `'GET'` | `'/changes'` | `{ sessionId: targetSessionId, status: 'pending', view: 'net' }` | `—` | [src/renderer/src/contrib/work/WorkView.tsx:2680](D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:2680) |
| `'POST'` | `'/changes/keep-many'` | `—` | `{ sessionId, ids }` | [src/renderer/src/core/engine/change-actions.ts:13](D:/dev/aether-code/src/renderer/src/core/engine/change-actions.ts:13) |
| `'POST'` | `'/changes/revert-batch'` | `—` | `intent` | [src/renderer/src/core/engine/change-revert.ts:121](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:121) |
| `'GET'` | `'/conversation/history'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/change-revert.ts:149](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:149) |
| `'POST'` | `'/conversation/truncate'` | `—` | `{ sessionId, messageId: row.id }` | [src/renderer/src/core/engine/change-revert.ts:159](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:159) |
| `'POST'` | `'/subagent/cancel'` | `—` | `input` | [src/renderer/src/core/engine/client.ts:105](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:105) |
| `'GET'` | `'/subagent/capabilities'` | `—` | `—` | [src/renderer/src/core/engine/client.ts:152](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:152) |
| `'GET'` | `'/subagent/discovery'` | `{ ...scope, ...options }` | `—` | [src/renderer/src/core/engine/client.ts:205](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:205) |
| `'GET'` | `'/subagent/runs'` | `{ parentSessionId, view: protocol === 2 ? 'summary' : 'legacy', ...options }` | `—` | [src/renderer/src/core/engine/client.ts:262](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:262) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(runId)}` | `{ view: protocol === 2 ? 'summary' : 'legacy', ...query }` | `—` | [src/renderer/src/core/engine/client.ts:285](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:285) |
| `'POST'` | `/subagent/runs/${encodeURIComponent(runId)}/cancel` | `{ view: protocol === 2 ? 'summary' : 'legacy', ...query }` | `{}` | [src/renderer/src/core/engine/client.ts:304](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:304) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(runId)}/tools` | `options` | `—` | [src/renderer/src/core/engine/client.ts:316](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:316) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(toolCallId)}` | `options` | `—` | [src/renderer/src/core/engine/client.ts:329](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:329) |
| `'GET'` | `/subagent/runs/${encodeURIComponent(runId)}/events` | `{ format: 'delta', ...options }` | `—` | [src/renderer/src/core/engine/client.ts:348](D:/dev/aether-code/src/renderer/src/core/engine/client.ts:348) |
| `'GET'` | `'/collaboration/capabilities'` | `—` | `—` | [src/renderer/src/core/engine/collaboration-controller-core.ts:82](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:82) |
| `'GET'` | `/collaboration/roots/${encodeURIComponent(target.rootRunId)}/controller-context` | `{ rootSessionId: target.rootSessionId, recipientParticipantId: child:${target.childSessionId} }` | `—` | [src/renderer/src/core/engine/collaboration-controller-core.ts:94](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:94) |
| `'POST'` | `/collaboration/roots/${encodeURIComponent(pending.rootRunId)}/messages` | `{ rootAttemptId: pending.rootAttemptId, rootSessionId: pending.rootSessionId }` | `{ recipientParticipantId: pending.recipientParticipantId, recipientInvocationRunId: pending.recipientInvocationRunId, message: pending.message, requestKey: pending.requestKey }` | [src/renderer/src/core/engine/collaboration-controller-core.ts:142](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:142) |
| `'GET'` | `/collaboration/roots/${encodeURIComponent(pending.rootRunId)}/controller-receipts/${encodeURIComponent(pending.requestKey)}` | `{ rootAttemptId: pending.rootAttemptId, rootSessionId: pending.rootSessionId }` | `—` | [src/renderer/src/core/engine/collaboration-controller-core.ts:173](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:173) |
| `'GET'` | `/collaboration/roots/${encodeURIComponent(saved.rootRunId)}/controller-receipts/${encodeURIComponent(saved.requestKey)}` | `{ rootAttemptId: saved.rootAttemptId, rootSessionId: saved.rootSessionId }` | `—` | [src/renderer/src/core/engine/collaboration-controller-core.ts:202](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-controller-core.ts:202) |
| `'GET'` | `'/collaboration/capabilities'` | `—` | `—` | [src/renderer/src/core/engine/collaboration-inspection.ts:53](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-inspection.ts:53) |
| `'GET'` | `/collaboration/roots/${encodeURIComponent(target.rootRunId)}/controller-context` | `{ rootSessionId: target.rootSessionId, recipientParticipantId: child:${target.childSessionId} }` | `—` | [src/renderer/src/core/engine/collaboration-inspection.ts:57](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-inspection.ts:57) |
| `'GET'` | `/collaboration/roots/${encodeURIComponent(scope.rootRunId)}/participants/${encodeURIComponent(child:${target.childSessionId})}/receipts` | `{ rootAttemptId: scope.rootAttemptId, rootSessionId: scope.rootSessionId, limit: COLLABORATION_RECEIPT_PAGE_SIZE, ...(previous?.page.nextCursor ? { cursor: previous.page.nextCursor } : {}) }` | `—` | [src/renderer/src/core/engine/collaboration-inspection.ts:63](D:/dev/aether-code/src/renderer/src/core/engine/collaboration-inspection.ts:63) |
| `'GET'` | `'/command-jobs'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/command-job-store.ts:75](D:/dev/aether-code/src/renderer/src/core/engine/command-job-store.ts:75) |
| `'GET'` | `/command-jobs/${encodeURIComponent(jobId)}/output` | `{ sessionId, cursor: previous?.output.cursor ?? 0, maxBytes: 65536 }` | `—` | [src/renderer/src/core/engine/command-job-store.ts:92](D:/dev/aether-code/src/renderer/src/core/engine/command-job-store.ts:92) |
| `'POST'` | `/command-jobs/${encodeURIComponent(jobId)}/cancel` | `—` | `{ sessionId }` | [src/renderer/src/core/engine/command-job-store.ts:113](D:/dev/aether-code/src/renderer/src/core/engine/command-job-store.ts:113) |
| `'GET'` | `'/knowledge/bases'` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:58](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:58) |
| `'POST'` | `'/knowledge/bases'` | `—` | `input` | [src/renderer/src/core/engine/knowledge.ts:61](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:61) |
| `'GET'` | `'/knowledge/bases/' + encode(id)` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:64](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:64) |
| `'PUT'` | `'/knowledge/bases/' + encode(id)` | `—` | `input` | [src/renderer/src/core/engine/knowledge.ts:67](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:67) |
| `'DELETE'` | `'/knowledge/bases/' + encode(id)` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:70](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:70) |
| `'GET'` | `'/knowledge/documents'` | `knowledgeBaseId ? { knowledgeBaseId } : undefined` | `—` | [src/renderer/src/core/engine/knowledge.ts:73](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:73) |
| `'GET'` | `'/knowledge/documents/' + encode(id)` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:79](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:79) |
| `'POST'` | `'/knowledge/documents'` | `—` | `input` | [src/renderer/src/core/engine/knowledge.ts:82](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:82) |
| `'POST'` | `'/knowledge/documents'` | `—` | `—；multipart upload` | [src/renderer/src/core/engine/knowledge.ts:85](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:85) |
| `'GET'` | `'/knowledge/formats'` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:93](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:93) |
| `'PUT'` | `'/knowledge/documents/' + encode(id)` | `—` | `input` | [src/renderer/src/core/engine/knowledge.ts:96](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:96) |
| `'DELETE'` | `'/knowledge/documents/' + encode(id)` | `—` | `—` | [src/renderer/src/core/engine/knowledge.ts:99](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:99) |
| `'POST'` | `'/knowledge/search'` | `—` | `{ query: normalized, limit, knowledgeBaseIds: knowledgeBaseIds?.length ? [...new Set(knowledgeBaseIds)] : undefined }` | [src/renderer/src/core/engine/knowledge.ts:104](D:/dev/aether-code/src/renderer/src/core/engine/knowledge.ts:104) |
| `'GET'` | `'/memory/list'` | `{ ...scopeQuery(input.scope, input.sessionId), keyword: input.keyword?.trim() \|\| undefined, type: input.type \|\| undefined, current: input.current ?? 1, pageSize: input.pageSize ?? 20 }` | `—` | [src/renderer/src/core/engine/memory-records.ts:57](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:57) |
| `'GET'` | `/memory/${encodeURIComponent(id)}` | `scopeQuery(scope, sessionId)` | `—` | [src/renderer/src/core/engine/memory-records.ts:77](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:77) |
| `'POST'` | `'/memory/nodes'` | `scopeQuery(scope, sessionId)` | `{ ...input, type: input.type ?? 'fact', importance: input.importance ?? 0.5 }` | [src/renderer/src/core/engine/memory-records.ts:83](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:83) |
| `'PUT'` | `/memory/${encodeURIComponent(id)}` | `scopeQuery(scope, sessionId)` | `input` | [src/renderer/src/core/engine/memory-records.ts:89](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:89) |
| `'DELETE'` | `/memory/${encodeURIComponent(id)}` | `scopeQuery(scope, sessionId)` | `—` | [src/renderer/src/core/engine/memory-records.ts:95](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:95) |
| `'GET'` | `'/conversation/sessions'` | `—` | `—` | [src/renderer/src/core/engine/memory-records.ts:103](D:/dev/aether-code/src/renderer/src/core/engine/memory-records.ts:103) |
| `'GET'` | `'/memory/settings'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/memory.ts:99](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:99) |
| `'PUT'` | `'/memory/settings'` | `—` | `{ sessionId, memoryScope }` | [src/renderer/src/core/engine/memory.ts:109](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:109) |
| `'GET'` | `'/memory/preferences'` | `—` | `—` | [src/renderer/src/core/engine/memory.ts:154](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:154) |
| `'PUT'` | `'/memory/preferences'` | `—` | `patch` | [src/renderer/src/core/engine/memory.ts:168](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:168) |
| `'PUT'` | `'/memory/settings'` | `—` | `{ sessionId, sessionEnabled }` | [src/renderer/src/core/engine/memory.ts:178](D:/dev/aether-code/src/renderer/src/core/engine/memory.ts:178) |
| `'GET'` | `'/models'` | `—` | `—` | [src/renderer/src/core/engine/models.ts:126](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:126) |
| `'POST'` | `'/models'` | `—` | `input` | [src/renderer/src/core/engine/models.ts:134](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:134) |
| `'PUT'` | `/models/${created.id}` | `—` | `{ isEnabled: true }` | [src/renderer/src/core/engine/models.ts:144](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:144) |
| `'PUT'` | `/models/${id}` | `—` | `patch` | [src/renderer/src/core/engine/models.ts:152](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:152) |
| `'DELETE'` | `/models/${id}` | `—` | `—` | [src/renderer/src/core/engine/models.ts:158](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:158) |
| `'POST'` | `/models/${id}/test` | `—` | `temp ?? {}` | [src/renderer/src/core/engine/models.ts:174](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:174) |
| `'POST'` | `'/models/detect-capabilities'` | `—` | `input` | [src/renderer/src/core/engine/models.ts:190](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:190) |
| `'GET'` | `'/models/capability-defs'` | `—` | `—` | [src/renderer/src/core/engine/models.ts:200](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:200) |
| `'GET'` | `'/chat/snapshot/children/' + encodeURIComponent(reference.identity.runId)` | `{ sessionId: reference.sessionId, childRecoveryProtocol: 1, snapshotId: reference.snapshotId }` | `—` | [src/renderer/src/core/engine/published-snapshot-client.ts:170](D:/dev/aether-code/src/renderer/src/core/engine/published-snapshot-client.ts:170) |
| `'GET'` | `'/security/mode'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/security.ts:121](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:121) |
| `'PUT'` | `'/security/mode'` | `—` | `buildModePayload(sessionId, mode)` | [src/renderer/src/core/engine/security.ts:132](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:132) |
| `'GET'` | `'/security/policies'` | `{ current: 1, pageSize: 200 }` | `—` | [src/renderer/src/core/engine/security.ts:143](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:143) |
| `'PUT'` | `/security/policies/${id}` | `—` | `patch` | [src/renderer/src/core/engine/security.ts:157](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:157) |
| `'DELETE'` | `/security/policies/${id}` | `—` | `—` | [src/renderer/src/core/engine/security.ts:162](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:162) |
| `'POST'` | `'/security/policies/reset'` | `—` | `—` | [src/renderer/src/core/engine/security.ts:168](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:168) |
| `'GET'` | `'/chat/snapshot'` | `{ sessionId: scope.sessionId, childRecoveryProtocol: 1 }` | `—` | [src/renderer/src/core/engine/useChat.ts:512](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:512) |
| `'GET'` | `'/chat/status'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/useChat.ts:775](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:775) |
| `'POST'` | `'/chat'` | `—` | `dispatchChatRequest serialization: message/sessionId/agentId/collaborators/model/knowledgeBases/skills/mcpServers/workspacePaths/thinkingMode/subagentModel/utilityModel/memoryScope/attachments；SSE streamStart` | [src/renderer/src/core/engine/useChat.ts:1011](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1011) |
| `'GET'` | `'/chat/snapshot'` | `{ sessionId, ...(capabilities.childRecovery ? { childRecoveryProtocol: 1 } : {}) }` | `—` | [src/renderer/src/core/engine/useChat.ts:1289](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1289) |
| `'GET'` | `'/conversation/archive'` | `{ sessionId, current: String(page), pageSize: String(pageSize) }` | `—` | [src/renderer/src/core/engine/useChat.ts:1365](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1365) |
| `'GET'` | `'/chat/snapshot'` | `{ sessionId, ...(capabilities.childRecovery ? { childRecoveryProtocol: 1 } : {}) }` | `—` | [src/renderer/src/core/engine/useChat.ts:1372](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1372) |
| `'GET'` | `'/chat/stream'` | `{ sessionId, lastEventId: snapshot.eventId! }` | `undefined` | [src/renderer/src/core/engine/useChat.ts:1433](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1433) |
| `'POST'` | `'/chat/cancel'` | `—` | `—` | [src/renderer/src/core/engine/useChat.ts:1546](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1546) |
| `'DELETE'` | `'/conversation/history'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/useChat.ts:1609](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1609) |
| `'GET'` | `'/conversation/history'` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/useChat.ts:1648](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1648) |
| `'DELETE'` | `/conversation/turns/${encodeURIComponent(turnId)}` | `{ sessionId }` | `—` | [src/renderer/src/core/engine/useChat.ts:1676](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1676) |
| `'POST'` | `'/conversation/truncate'` | `—` | `{ sessionId, messageId: row.id }` | [src/renderer/src/core/engine/useChat.ts:1710](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1710) |
| `'POST'` | `'/conversation/truncate'` | `—` | `{ sessionId: options.sessionId, messageId: row.id }` | [src/renderer/src/core/engine/useChat.ts:1746](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1746) |
| `'POST'` | `'/utility/chat'` | `—` | `{ model: input.model?.trim() \|\| undefined, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt, temperature: input.temperature, maxTokens: input.maxTokens }` | [src/renderer/src/core/engine/utility-chat.ts:22](D:/dev/aether-code/src/renderer/src/core/engine/utility-chat.ts:22) |
| `'GET'` | `'/git/binding'` | `{ sessionId }` | `—` | [src/renderer/src/core/git/git-target.ts:111](D:/dev/aether-code/src/renderer/src/core/git/git-target.ts:111) |
| `'GET'` | `/git/${op}` | `{ ...query, sessionId: target.sessionId, cwd: target.cwd, expectedRoot: target.root, bindingEpoch: target.bindingEpoch }` | `—` | [src/renderer/src/core/git/git-target.ts:204](D:/dev/aether-code/src/renderer/src/core/git/git-target.ts:204) |
| `'POST'` | `'/git/action'` | `—` | `{ ...normalized, sessionId: target.sessionId, cwd: target.cwd, expectedRoot: target.root, bindingEpoch: target.bindingEpoch, op }` | [src/renderer/src/core/git/git-target.ts:219](D:/dev/aether-code/src/renderer/src/core/git/git-target.ts:219) |
| `'POST'` | `'/lsp/diagnose'` | `—` | `—` | [src/renderer/src/core/lsp/diagnostics.ts:81](D:/dev/aether-code/src/renderer/src/core/lsp/diagnostics.ts:81) |
| `'POST'` | `'/lsp/request'` | `—` | `{ sessionId: context.sessionId, workspaceRoot: context.root, method: String(message.method ?? ''), params: message.params ?? {} }` | [src/renderer/src/core/lsp/ts-client.ts:73](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:73) |
| `'DELETE'` | `'/lsp/session'` | `{ sessionId: sessionContext.sessionId }` | `—` | [src/renderer/src/core/lsp/ts-client.ts:317](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:317) |
| `'POST'` | `'/workspace/bind'` | `—` | `{ sessionId: id, workspaceRoot: root }` | [src/renderer/src/core/workspace/fs-client.ts:83](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:83) |
| `'GET'` | `'/workspace/directory'` | `{ sessionId: id, path: '.' }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:144](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:144) |
| `'GET'` | `'/workspace/file/content'` | `readQuery(target, relative)` | `—` | [src/renderer/src/core/workspace/fs-client.ts:291](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:291) |
| `'POST'` | `'/workspace/bind'` | `—` | `{ sessionId: target.sessionId, workspaceRoot: target.workspaceRoot }` | [src/renderer/src/core/workspace/fs-client.ts:351](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:351) |
| `'GET'` | `'/workspace/directory'` | `{ ...scope(target), path: '.' }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:355](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:355) |
| `'GET'` | `'/workspace/directory'` | `{ sessionId: target.sessionId, path: relative }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:413](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:413) |
| `'GET'` | `'/workspace/directory'` | `{ ...scope(context.target), path: remoteWorkspaceRelativePath(context, dir) \|\| '.' }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:422](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:422) |
| `'GET'` | `'/workspace/file/content'` | `readQuery(target, relative)` | `—` | [src/renderer/src/core/workspace/fs-client.ts:475](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:475) |
| `'GET'` | `'/workspace/file/content'` | `{ ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:482](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:482) |
| `'GET'` | `'/workspace/file/info'` | `{ ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) \|\| '.' }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:679](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:679) |
| `'GET'` | `'/workspace/file/info'` | `{ sessionId: target.sessionId, path: relative }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:691](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:691) |
| `'POST'` | `'/workspace/file'` | `—` | `{ sessionId: target.sessionId, path: relative, content }` | [src/renderer/src/core/workspace/fs-client.ts:704](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:704) |
| `'GET'` | `'/workspace/file/info'` | `{ sessionId: target.sessionId, path: relative }` | `—` | [src/renderer/src/core/workspace/fs-client.ts:707](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:707) |
| `'POST'` | `'/workspace/file'` | `—` | `{ ...scope(context.target), path: remoteWorkspaceRelativePath(context, path), content }` | [src/renderer/src/core/workspace/fs-client.ts:715](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:715) |
| `'POST'` | `route` | `—` | `{ ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) }` | [src/renderer/src/core/workspace/fs-client.ts:723](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:723) |
| `'POST'` | `route` | `—` | `{ ...scope(context.target), srcPath: remoteWorkspaceRelativePath(context, src), destPath: remoteWorkspaceRelativePath(context, dest) }` | [src/renderer/src/core/workspace/fs-client.ts:737](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:737) |
| `'POST'` | `'/workspace/file'` | `—` | `{ ...scope(context.target), path: relative, content: encodeBase64(input.data), encoding: 'base64' }` | [src/renderer/src/core/workspace/fs-client.ts:786](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:786) |

动态工作区路由补充：

| 方式 | 路径 | 参数 | 证据 |
| --- | --- | --- | --- |
| POST | `/workspace/file/create`<br>`/workspace/folder/create`<br>`/workspace/file/trash` | `{sessionId,path}` | [src/renderer/src/core/workspace/fs-client.ts:721](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:721) |
| POST | `/workspace/file/move`<br>`/workspace/file/copy` | `{sessionId,srcPath,destPath}` | [src/renderer/src/core/workspace/fs-client.ts:735](D:/dev/aether-code/src/renderer/src/core/workspace/fs-client.ts:735) |

## 主进程直接网络调用补充

包含账号路由、健康检查、文件上传下载、下一轮调度、浏览器/PTY 通用传输。通用 fetch 与具体账号调用会重叠计数，不能与上表相加得到唯一接口数。这里仅展示源码字段名称，未读取任何真实凭证。完整 options 在 JSON mainHttpCalls 中。

| 传输 | 方式 / URL | 参数 | 证据 |
| --- | --- | --- | --- |
| fetch | `${t.url}/auth/account${path}` | `{ method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) }` | [src/main/account/service.ts:65](D:/dev/aether-code/src/main/account/service.ts:65) |
| account-request | `'POST' /auth/account'/refresh'` | `{ refreshToken: credential.refreshToken, requestId: refreshRequestId }` | [src/main/account/service.ts:163](D:/dev/aether-code/src/main/account/service.ts:163) |
| account-request | `'GET' /auth/account'/providers'` | `—` | [src/main/account/service.ts:192](D:/dev/aether-code/src/main/account/service.ts:192) |
| account-request | `'GET' /auth/account'/me'` | `undefined` | [src/main/account/service.ts:203](D:/dev/aether-code/src/main/account/service.ts:203) |
| account-request | `'POST' /auth/account'/register'` | `{}` | [src/main/account/service.ts:252](D:/dev/aether-code/src/main/account/service.ts:252) |
| account-request | `'POST' /auth/account'/login'` | `{ recoveryKey: recoveryKey.trim() }` | [src/main/account/service.ts:256](D:/dev/aether-code/src/main/account/service.ts:256) |
| account-request | `'PATCH' /auth/account'/profile'` | `input` | [src/main/account/service.ts:260](D:/dev/aether-code/src/main/account/service.ts:260) |
| account-request | `'POST' /auth/account'/logout'` | `{ all: all === true }` | [src/main/account/service.ts:275](D:/dev/aether-code/src/main/account/service.ts:275) |
| account-request | `'GET' /auth/account'/sessions'` | `undefined` | [src/main/account/service.ts:286](D:/dev/aether-code/src/main/account/service.ts:286) |
| account-request | `'DELETE' /auth/account/sessions/${encodeURIComponent(id)}` | `undefined` | [src/main/account/service.ts:289](D:/dev/aether-code/src/main/account/service.ts:289) |
| account-request | `'POST' /auth/account'/recovery'` | `{}` | [src/main/account/service.ts:299](D:/dev/aether-code/src/main/account/service.ts:299) |
| account-request | `'POST' /auth/account'/external/credential'` | `{ providerId, mode, credential }` | [src/main/account/service.ts:335](D:/dev/aether-code/src/main/account/service.ts:335) |
| account-request | `'POST' /auth/account'/external/start'` | `{ providerId, mode }` | [src/main/account/service.ts:340](D:/dev/aether-code/src/main/account/service.ts:340) |
| account-request | `'POST' /auth/account'/external/poll'` | `{ flowId: started.flowId, pollToken: started.pollToken }` | [src/main/account/service.ts:348](D:/dev/aether-code/src/main/account/service.ts:348) |
| account-request | `'DELETE' /auth/account/identities/${encodeURIComponent(providerId)}` | `undefined` | [src/main/account/service.ts:362](D:/dev/aether-code/src/main/account/service.ts:362) |
| fetch | `${baseUrl}/api/v1${path}` | `{ method, headers: { ...headers, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSi …（完整见 JSON）` | [src/main/browser-bridge.ts:316](D:/dev/aether-code/src/main/browser-bridge.ts:316) |
| fetch | `url` | `{ redirect: 'error', method: input.method, headers, body: requestBody === undefined ? undefined : JSON.stringify(requestBody), signal }` | [src/main/engine/client.ts:62](D:/dev/aether-code/src/main/engine/client.ts:62) |
| fetch | `${baseUrl}${path}` | `{ method: 'POST', headers: await engineHost.prepareRequestHeaders(baseUrl), body: form, signal, redirect: 'error' }` | [src/main/engine/client.ts:138](D:/dev/aether-code/src/main/engine/client.ts:138) |
| fetch | `${baseUrl}/health` | `options` | [src/main/engine/host.ts:464](D:/dev/aether-code/src/main/engine/host.ts:464) |
| fetch | `${baseUrl}/meta` | `options` | [src/main/engine/host.ts:467](D:/dev/aether-code/src/main/engine/host.ts:467) |
| fetch | `${baseUrl}/api/v1/tools` | `{ ...options, headers: await this.prepareRequestHeaders(baseUrl) }` | [src/main/engine/host.ts:471](D:/dev/aether-code/src/main/engine/host.ts:471) |
| fetch | `${baseUrl}/health` | `{ signal, redirect: 'error' }` | [src/main/engine/host.ts:629](D:/dev/aether-code/src/main/engine/host.ts:629) |
| fetch | `${baseUrl}/meta` | `{ signal, redirect: 'error' }` | [src/main/engine/host.ts:632](D:/dev/aether-code/src/main/engine/host.ts:632) |
| fetch | `url` | `{ redirect: 'error', method, headers, body: method === 'POST' ? JSON.stringify(requestBody ?? {}) : undefined, signal: requestSignal }` | [src/main/engine/host.ts:721](D:/dev/aether-code/src/main/engine/host.ts:721) |
| fetch | `${context.baseUrl}/api/v1/chat/runs?${new URLSearchParams({ sessionId: input.sessionId })}` | `{ redirect: 'error', headers: { ...context.headers, Accept: 'application/json' }, signal: context.signal }` | [src/main/engine/remote-workspace.ts:101](D:/dev/aether-code/src/main/engine/remote-workspace.ts:101) |
| fetch | `healthUrl` | `{ method: 'GET', signal: AbortSignal.timeout(intervalMs * 3) }` | [src/main/engine/sdk/readiness-probe.ts:67](D:/dev/aether-code/src/main/engine/sdk/readiness-probe.ts:67) |
| fetch | `${target.baseUrl}/api/v1/workspace/upload` | `{ method: 'POST', headers, body: form, signal, redirect: 'error' }` | [src/main/engine/upload-remote-attachment.ts:60](D:/dev/aether-code/src/main/engine/upload-remote-attachment.ts:60) |
| fetch | `${target.baseUrl}/api/v1/workspace/file/info?${new URLSearchParams({ sessionId: input.sessionId, path: serverPath })}` | `{ headers, signal, redirect: 'error' }` | [src/main/engine/upload-remote-attachment.ts:64](D:/dev/aether-code/src/main/engine/upload-remote-attachment.ts:64) |
| fetch | `${options.baseUrl}/api/v1/workspace/directory?${query}` | `{ headers: options.headers, redirect: 'error', signal }` | [src/main/engine/workspace-download.ts:46](D:/dev/aether-code/src/main/engine/workspace-download.ts:46) |
| fetch | `${options.baseUrl}/api/v1/workspace/file/download?${query}` | `{ headers: options.headers, redirect: 'error', signal }` | [src/main/engine/workspace-download.ts:62](D:/dev/aether-code/src/main/engine/workspace-download.ts:62) |
| fetch | `input` | `init` | [src/main/next-turn-engine-gateway.ts:32](D:/dev/aether-code/src/main/next-turn-engine-gateway.ts:32) |
| fetch | `${facts.target.baseUrl}/api/v1/workspace/file/download?${new URLSearchParams({ sessionId: scope.taskId, path: name })}` | `{ headers, signal: AbortSignal.any([facts.signal, this.controller.signal, AbortSignal.timeout(30000)]), redirect: 'error' }` | [src/main/next-turn-engine-gateway.ts:104](D:/dev/aether-code/src/main/next-turn-engine-gateway.ts:104) |
| fetch | `${facts.target.baseUrl}/api/v1/chat` | `{ method: 'POST', redirect: 'error', body: wireBody, headers: { ...headers, ...subagentProtocolHeaders(2), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: AbortSignal.any([facts.signal, this.controller.signal, …（完整见 JSON）` | [src/main/next-turn-engine-gateway.ts:207](D:/dev/aether-code/src/main/next-turn-engine-gateway.ts:207) |
| fetch | `${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/create` | `{ method: 'POST', headers: { 'Content-Type': 'application/json', ...target.headers }, body: JSON.stringify({ sessionId, cols: input.cols, rows: input.rows }), signal: AbortSignal.any([target.signal, AbortSignal.timeout(120_000)]) …（完整见 JSON）` | [src/main/terminal/remote-terminal.ts:41](D:/dev/aether-code/src/main/terminal/remote-terminal.ts:41) |
| fetch | `${target.snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/terminal/${encodeURIComponent(remoteId)}` | `{ method: 'DELETE', headers: target.headers, signal: AbortSignal.timeout(15_000), redirect: 'error' }` | [src/main/terminal/remote-terminal.ts:192](D:/dev/aether-code/src/main/terminal/remote-terminal.ts:192) |

Native host 通用网络出口（已计入 36 个主进程调用点）：`${host.transport.baseUrl.replace(/\/+$/, '')}/api/v1${route}`，[src/main/browser/native-host-manager.ts:124](D:/dev/aether-code/src/main/browser/native-host-manager.ts:124)。

## 共享数据契约索引

每个声明的完整字段、联合类型、参数/返回值已经保存在 JSON typeContracts[].contract，以下提供定位索引，避免把类型遗漏成只有名称的工具表。

| 契约名 | 证据 |
| --- | --- |
| `AccountData` | [src/shared/account.ts:2](D:/dev/aether-code/src/shared/account.ts:2) |
| `AccountIdentity` | [src/shared/account.ts:3](D:/dev/aether-code/src/shared/account.ts:3) |
| `AccountUser` | [src/shared/account.ts:12](D:/dev/aether-code/src/shared/account.ts:12) |
| `AccountProvider` | [src/shared/account.ts:24](D:/dev/aether-code/src/shared/account.ts:24) |
| `AccountState` | [src/shared/account.ts:29](D:/dev/aether-code/src/shared/account.ts:29) |
| `AccountProfileInput` | [src/shared/account.ts:39](D:/dev/aether-code/src/shared/account.ts:39) |
| `AccountSession` | [src/shared/account.ts:46](D:/dev/aether-code/src/shared/account.ts:46) |
| `AccountApi` | [src/shared/account.ts:53](D:/dev/aether-code/src/shared/account.ts:53) |
| `CronThinkingMode` | [src/shared/automation.ts:2](D:/dev/aether-code/src/shared/automation.ts:2) |
| `CronSchedule` | [src/shared/automation.ts:3](D:/dev/aether-code/src/shared/automation.ts:3) |
| `CronConfigurationV2` | [src/shared/automation.ts:7](D:/dev/aether-code/src/shared/automation.ts:7) |
| `CronJobV2` | [src/shared/automation.ts:17](D:/dev/aether-code/src/shared/automation.ts:17) |
| `CreateCronJobV2` | [src/shared/automation.ts:37](D:/dev/aether-code/src/shared/automation.ts:37) |
| `UpdateCronJobV2` | [src/shared/automation.ts:47](D:/dev/aether-code/src/shared/automation.ts:47) |
| `CronCapabilities` | [src/shared/automation.ts:48](D:/dev/aether-code/src/shared/automation.ts:48) |
| `CronPreviewRequest` | [src/shared/automation.ts:63](D:/dev/aether-code/src/shared/automation.ts:63) |
| `CronPreviewResponse` | [src/shared/automation.ts:64](D:/dev/aether-code/src/shared/automation.ts:64) |
| `CronRunStatus` | [src/shared/automation.ts:65](D:/dev/aether-code/src/shared/automation.ts:65) |
| `CronRunSnapshot` | [src/shared/automation.ts:66](D:/dev/aether-code/src/shared/automation.ts:66) |
| `CronAutomationRun` | [src/shared/automation.ts:78](D:/dev/aether-code/src/shared/automation.ts:78) |
| `CronNotificationPayload` | [src/shared/automation.ts:95](D:/dev/aether-code/src/shared/automation.ts:95) |
| `CronNotification` | [src/shared/automation.ts:103](D:/dev/aether-code/src/shared/automation.ts:103) |
| `CronPage` | [src/shared/automation.ts:112](D:/dev/aether-code/src/shared/automation.ts:112) |
| `CronNotificationPage` | [src/shared/automation.ts:113](D:/dev/aether-code/src/shared/automation.ts:113) |
| `AutomationReceipt` | [src/shared/automation.ts:116](D:/dev/aether-code/src/shared/automation.ts:116) |
| `BrowserConnectInput` | [src/shared/browser-api.ts:10](D:/dev/aether-code/src/shared/browser-api.ts:10) |
| `BrowserConnectionState` | [src/shared/browser-api.ts:15](D:/dev/aether-code/src/shared/browser-api.ts:15) |
| `BrowserApi` | [src/shared/browser-api.ts:22](D:/dev/aether-code/src/shared/browser-api.ts:22) |
| `BrowserNetworkQuery` | [src/shared/browser-network.ts:4](D:/dev/aether-code/src/shared/browser-network.ts:4) |
| `BrowserNetworkList` | [src/shared/browser-network.ts:15](D:/dev/aether-code/src/shared/browser-network.ts:15) |
| `BrowserNetworkHeader` | [src/shared/browser-network.ts:28](D:/dev/aether-code/src/shared/browser-network.ts:28) |
| `BrowserNetworkBody` | [src/shared/browser-network.ts:30](D:/dev/aether-code/src/shared/browser-network.ts:30) |
| `BrowserNetworkDetailOptions` | [src/shared/browser-network.ts:44](D:/dev/aether-code/src/shared/browser-network.ts:44) |
| `BrowserNetworkDetail` | [src/shared/browser-network.ts:50](D:/dev/aether-code/src/shared/browser-network.ts:50) |
| `BrowserContext` | [src/shared/browser.ts:4](D:/dev/aether-code/src/shared/browser.ts:4) |
| `BrowserViewport` | [src/shared/browser.ts:9](D:/dev/aether-code/src/shared/browser.ts:9) |
| `BrowserSettings` | [src/shared/browser.ts:16](D:/dev/aether-code/src/shared/browser.ts:16) |
| `BrowserTabState` | [src/shared/browser.ts:32](D:/dev/aether-code/src/shared/browser.ts:32) |
| `BrowserCreateInput` | [src/shared/browser.ts:46](D:/dev/aether-code/src/shared/browser.ts:46) |
| `BrowserEvent` | [src/shared/browser.ts:51](D:/dev/aether-code/src/shared/browser.ts:51) |
| `BrowserBoundsInput` | [src/shared/browser.ts:58](D:/dev/aether-code/src/shared/browser.ts:58) |
| `BrowserAction` | [src/shared/browser.ts:66](D:/dev/aether-code/src/shared/browser.ts:66) |
| `BrowserReadKind` | [src/shared/browser.ts:72](D:/dev/aether-code/src/shared/browser.ts:72) |
| `BrowserToolRequest` | [src/shared/browser.ts:74](D:/dev/aether-code/src/shared/browser.ts:74) |
| `BrowserToolResult` | [src/shared/browser.ts:96](D:/dev/aether-code/src/shared/browser.ts:96) |
| `BrowserExecutionIdentity` | [src/shared/browser.ts:104](D:/dev/aether-code/src/shared/browser.ts:104) |
| `BrowserConsoleEntry` | [src/shared/browser.ts:110](D:/dev/aether-code/src/shared/browser.ts:110) |
| `BrowserNetworkEntry` | [src/shared/browser.ts:119](D:/dev/aether-code/src/shared/browser.ts:119) |
| `BrowserElement` | [src/shared/browser.ts:134](D:/dev/aether-code/src/shared/browser.ts:134) |
| `BrowserViewportScreenshot` | [src/shared/browser.ts:144](D:/dev/aether-code/src/shared/browser.ts:144) |
| `BrowserClickInteraction` | [src/shared/browser.ts:151](D:/dev/aether-code/src/shared/browser.ts:151) |
| `BrowserSnapshot` | [src/shared/browser.ts:169](D:/dev/aether-code/src/shared/browser.ts:169) |
| `BrowserUnavailableSnapshot` | [src/shared/browser.ts:180](D:/dev/aether-code/src/shared/browser.ts:180) |
| `BrowserScreenshot` | [src/shared/browser.ts:189](D:/dev/aether-code/src/shared/browser.ts:189) |
| `CommandJobStatus` | [src/shared/command-job.ts:1](D:/dev/aether-code/src/shared/command-job.ts:1) |
| `CommandJobSnapshot` | [src/shared/command-job.ts:4](D:/dev/aether-code/src/shared/command-job.ts:4) |
| `CommandOutputEntry` | [src/shared/command-job.ts:29](D:/dev/aether-code/src/shared/command-job.ts:29) |
| `CommandJobOutput` | [src/shared/command-job.ts:30](D:/dev/aether-code/src/shared/command-job.ts:30) |
| `EngineResourceSnapshot` | [src/shared/engine-diagnostics.ts:2](D:/dev/aether-code/src/shared/engine-diagnostics.ts:2) |
| `EngineProcessDetail` | [src/shared/engine-diagnostics.ts:28](D:/dev/aether-code/src/shared/engine-diagnostics.ts:28) |
| `EngineProcessTreeSnapshot` | [src/shared/engine-diagnostics.ts:48](D:/dev/aether-code/src/shared/engine-diagnostics.ts:48) |
| `EngineStorageSnapshot` | [src/shared/engine-diagnostics.ts:71](D:/dev/aether-code/src/shared/engine-diagnostics.ts:71) |
| `EngineHealthDiagnostics` | [src/shared/engine-diagnostics.ts:84](D:/dev/aether-code/src/shared/engine-diagnostics.ts:84) |
| `EngineDiagnosticsInput` | [src/shared/engine-diagnostics.ts:98](D:/dev/aether-code/src/shared/engine-diagnostics.ts:98) |
| `EngineDiagnostics` | [src/shared/engine-diagnostics.ts:102](D:/dev/aether-code/src/shared/engine-diagnostics.ts:102) |
| `EngineRuntimeInfo` | [src/shared/engine-import.ts:2](D:/dev/aether-code/src/shared/engine-import.ts:2) |
| `EngineImportPhase` | [src/shared/engine-import.ts:13](D:/dev/aether-code/src/shared/engine-import.ts:13) |
| `EngineImportProgress` | [src/shared/engine-import.ts:15](D:/dev/aether-code/src/shared/engine-import.ts:15) |
| `EngineRuntimeCatalog` | [src/shared/engine-import.ts:22](D:/dev/aether-code/src/shared/engine-import.ts:22) |
| `GitChangeType` | [src/shared/git-types.ts:16](D:/dev/aether-code/src/shared/git-types.ts:16) |
| `GitFileChange` | [src/shared/git-types.ts:19](D:/dev/aether-code/src/shared/git-types.ts:19) |
| `GitDiffLineType` | [src/shared/git-types.ts:56](D:/dev/aether-code/src/shared/git-types.ts:56) |
| `GitDiffLine` | [src/shared/git-types.ts:59](D:/dev/aether-code/src/shared/git-types.ts:59) |
| `GitHunk` | [src/shared/git-types.ts:70](D:/dev/aether-code/src/shared/git-types.ts:70) |
| `GitFileDiff` | [src/shared/git-types.ts:85](D:/dev/aether-code/src/shared/git-types.ts:85) |
| `GitBranchInfo` | [src/shared/git-types.ts:100](D:/dev/aether-code/src/shared/git-types.ts:100) |
| `GitErrorCode` | [src/shared/git-types.ts:113](D:/dev/aether-code/src/shared/git-types.ts:113) |
| `GitLeaseState` | [src/shared/git-types.ts:114](D:/dev/aether-code/src/shared/git-types.ts:114) |
| `GitLeaseResult` | [src/shared/git-types.ts:115](D:/dev/aether-code/src/shared/git-types.ts:115) |
| `GitExecutionDisposition` | [src/shared/git-types.ts:118](D:/dev/aether-code/src/shared/git-types.ts:118) |
| `GitResult` | [src/shared/git-types.ts:119](D:/dev/aether-code/src/shared/git-types.ts:119) |
| `GitDivergenceResult` | [src/shared/git-types.ts:139](D:/dev/aether-code/src/shared/git-types.ts:139) |
| `GitStatusResult` | [src/shared/git-types.ts:146](D:/dev/aether-code/src/shared/git-types.ts:146) |
| `GitIgnoreCheckResult` | [src/shared/git-types.ts:157](D:/dev/aether-code/src/shared/git-types.ts:157) |
| `GitDiffResult` | [src/shared/git-types.ts:165](D:/dev/aether-code/src/shared/git-types.ts:165) |
| `GitBranchInfoResult` | [src/shared/git-types.ts:169](D:/dev/aether-code/src/shared/git-types.ts:169) |
| `GitHeadFileResult` | [src/shared/git-types.ts:175](D:/dev/aether-code/src/shared/git-types.ts:175) |
| `GitBranchListResult` | [src/shared/git-types.ts:181](D:/dev/aether-code/src/shared/git-types.ts:181) |
| `GitSuggestMessageResult` | [src/shared/git-types.ts:189](D:/dev/aether-code/src/shared/git-types.ts:189) |
| `GitStashEntry` | [src/shared/git-types.ts:198](D:/dev/aether-code/src/shared/git-types.ts:198) |
| `GitStashListResult` | [src/shared/git-types.ts:209](D:/dev/aether-code/src/shared/git-types.ts:209) |
| `GitTagListResult` | [src/shared/git-types.ts:215](D:/dev/aether-code/src/shared/git-types.ts:215) |
| `GitRemote` | [src/shared/git-types.ts:222](D:/dev/aether-code/src/shared/git-types.ts:222) |
| `GitRemoteListResult` | [src/shared/git-types.ts:227](D:/dev/aether-code/src/shared/git-types.ts:227) |
| `GitRemoteBranchInfo` | [src/shared/git-types.ts:232](D:/dev/aether-code/src/shared/git-types.ts:232) |
| `GitRemoteBranchListResult` | [src/shared/git-types.ts:246](D:/dev/aether-code/src/shared/git-types.ts:246) |
| `GitCloneOptions` | [src/shared/git-types.ts:255](D:/dev/aether-code/src/shared/git-types.ts:255) |
| `GitCloneProgressPayload` | [src/shared/git-types.ts:262](D:/dev/aether-code/src/shared/git-types.ts:262) |
| `GitCloneResult` | [src/shared/git-types.ts:271](D:/dev/aether-code/src/shared/git-types.ts:271) |
| `GitCommitRef` | [src/shared/git-types.ts:279](D:/dev/aether-code/src/shared/git-types.ts:279) |
| `GitCommitFileChange` | [src/shared/git-types.ts:287](D:/dev/aether-code/src/shared/git-types.ts:287) |
| `GitLogEntry` | [src/shared/git-types.ts:294](D:/dev/aether-code/src/shared/git-types.ts:294) |
| `GitLogResult` | [src/shared/git-types.ts:312](D:/dev/aether-code/src/shared/git-types.ts:312) |
| `GitLogQuery` | [src/shared/git-types.ts:317](D:/dev/aether-code/src/shared/git-types.ts:317) |
| `GitFileHistoryEntry` | [src/shared/git-types.ts:335](D:/dev/aether-code/src/shared/git-types.ts:335) |
| `GitFileHistoryResult` | [src/shared/git-types.ts:356](D:/dev/aether-code/src/shared/git-types.ts:356) |
| `GitBlameLine` | [src/shared/git-types.ts:367](D:/dev/aether-code/src/shared/git-types.ts:367) |
| `GitBlameResult` | [src/shared/git-types.ts:381](D:/dev/aether-code/src/shared/git-types.ts:381) |
| `GitUserResult` | [src/shared/git-types.ts:389](D:/dev/aether-code/src/shared/git-types.ts:389) |
| `GitUserListResult` | [src/shared/git-types.ts:395](D:/dev/aether-code/src/shared/git-types.ts:395) |
| `GitCommitInfo` | [src/shared/git-types.ts:400](D:/dev/aether-code/src/shared/git-types.ts:400) |
| `GitCommitInfoResult` | [src/shared/git-types.ts:417](D:/dev/aether-code/src/shared/git-types.ts:417) |
| `GraphicsMode` | [src/shared/graphics.ts:1](D:/dev/aether-code/src/shared/graphics.ts:1) |
| `VisualEffects` | [src/shared/graphics.ts:2](D:/dev/aether-code/src/shared/graphics.ts:2) |
| `EffectiveEffects` | [src/shared/graphics.ts:3](D:/dev/aether-code/src/shared/graphics.ts:3) |
| `GraphicsRecovery` | [src/shared/graphics.ts:5](D:/dev/aether-code/src/shared/graphics.ts:5) |
| `GraphicsSnapshot` | [src/shared/graphics.ts:11](D:/dev/aether-code/src/shared/graphics.ts:11) |
| `LaunchInstanceRequest` | [src/shared/instance-profile.ts:1](D:/dev/aether-code/src/shared/instance-profile.ts:1) |
| `TerminalCreateInput` | [src/shared/ipc.ts:197](D:/dev/aether-code/src/shared/ipc.ts:197) |
| `TerminalExitInfo` | [src/shared/ipc.ts:205](D:/dev/aether-code/src/shared/ipc.ts:205) |
| `TerminalCleanupError` | [src/shared/ipc.ts:216](D:/dev/aether-code/src/shared/ipc.ts:216) |
| `TerminalDataEvent` | [src/shared/ipc.ts:228](D:/dev/aether-code/src/shared/ipc.ts:228) |
| `SearchHit` | [src/shared/ipc.ts:235](D:/dev/aether-code/src/shared/ipc.ts:235) |
| `SearchOptions` | [src/shared/ipc.ts:245](D:/dev/aether-code/src/shared/ipc.ts:245) |
| `SearchOutcome` | [src/shared/ipc.ts:258](D:/dev/aether-code/src/shared/ipc.ts:258) |
| `ReplaceOutcome` | [src/shared/ipc.ts:268](D:/dev/aether-code/src/shared/ipc.ts:268) |
| `ReplacePreviewLine` | [src/shared/ipc.ts:277](D:/dev/aether-code/src/shared/ipc.ts:277) |
| `ReplacePreviewFile` | [src/shared/ipc.ts:283](D:/dev/aether-code/src/shared/ipc.ts:283) |
| `ReplacePreviewOutcome` | [src/shared/ipc.ts:289](D:/dev/aether-code/src/shared/ipc.ts:289) |
| `EngineMode` | [src/shared/ipc.ts:301](D:/dev/aether-code/src/shared/ipc.ts:301) |
| `EnginePhase` | [src/shared/ipc.ts:304](D:/dev/aether-code/src/shared/ipc.ts:304) |
| `EngineSnapshot` | [src/shared/ipc.ts:312](D:/dev/aether-code/src/shared/ipc.ts:312) |
| `EngineLogEntry` | [src/shared/ipc.ts:342](D:/dev/aether-code/src/shared/ipc.ts:342) |
| `EngineLogBatch` | [src/shared/ipc.ts:350](D:/dev/aether-code/src/shared/ipc.ts:350) |
| `Appearance` | [src/shared/ipc.ts:361](D:/dev/aether-code/src/shared/ipc.ts:361) |
| `AccentColor` | [src/shared/ipc.ts:364](D:/dev/aether-code/src/shared/ipc.ts:364) |
| `FilesExclude` | [src/shared/ipc.ts:375](D:/dev/aether-code/src/shared/ipc.ts:375) |
| `AppSettings` | [src/shared/ipc.ts:403](D:/dev/aether-code/src/shared/ipc.ts:403) |
| `RemoteTokenSource` | [src/shared/ipc.ts:470](D:/dev/aether-code/src/shared/ipc.ts:470) |
| `RemoteTokenStatus` | [src/shared/ipc.ts:471](D:/dev/aether-code/src/shared/ipc.ts:471) |
| `RemoteAuthCredential` | [src/shared/ipc.ts:477](D:/dev/aether-code/src/shared/ipc.ts:477) |
| `RemoteAuthStatus` | [src/shared/ipc.ts:482](D:/dev/aether-code/src/shared/ipc.ts:482) |
| `StandardResponse` | [src/shared/ipc.ts:518](D:/dev/aether-code/src/shared/ipc.ts:518) |
| `EngineRequestInput` | [src/shared/ipc.ts:532](D:/dev/aether-code/src/shared/ipc.ts:532) |
| `RemoteAttachmentInput` | [src/shared/ipc.ts:549](D:/dev/aether-code/src/shared/ipc.ts:549) |
| `RemoteAttachmentResult` | [src/shared/ipc.ts:559](D:/dev/aether-code/src/shared/ipc.ts:559) |
| `EngineFileSaveInput` | [src/shared/ipc.ts:568](D:/dev/aether-code/src/shared/ipc.ts:568) |
| `EngineFileSaveResult` | [src/shared/ipc.ts:575](D:/dev/aether-code/src/shared/ipc.ts:575) |
| `EngineUploadInput` | [src/shared/ipc.ts:583](D:/dev/aether-code/src/shared/ipc.ts:583) |
| `EngineRequestResult` | [src/shared/ipc.ts:592](D:/dev/aether-code/src/shared/ipc.ts:592) |
| `EngineTodo` | [src/shared/ipc.ts:608](D:/dev/aether-code/src/shared/ipc.ts:608) |
| `ChatSsePayload` | [src/shared/ipc.ts:621](D:/dev/aether-code/src/shared/ipc.ts:621) |
| `EngineFileChange` | [src/shared/ipc.ts:650](D:/dev/aether-code/src/shared/ipc.ts:650) |
| `StreamStartInput` | [src/shared/ipc.ts:683](D:/dev/aether-code/src/shared/ipc.ts:683) |
| `LspMessage` | [src/shared/ipc.ts:705](D:/dev/aether-code/src/shared/ipc.ts:705) |
| `LspStartInput` | [src/shared/ipc.ts:708](D:/dev/aether-code/src/shared/ipc.ts:708) |
| `LspStartResult` | [src/shared/ipc.ts:717](D:/dev/aether-code/src/shared/ipc.ts:717) |
| `LspExitInfo` | [src/shared/ipc.ts:722](D:/dev/aether-code/src/shared/ipc.ts:722) |
| `FsEntry` | [src/shared/ipc.ts:736](D:/dev/aether-code/src/shared/ipc.ts:736) |
| `FsFileContent` | [src/shared/ipc.ts:750](D:/dev/aether-code/src/shared/ipc.ts:750) |
| `FsStat` | [src/shared/ipc.ts:771](D:/dev/aether-code/src/shared/ipc.ts:771) |
| `CopyIntoWorkspaceInput` | [src/shared/ipc.ts:785](D:/dev/aether-code/src/shared/ipc.ts:785) |
| `CopyIntoWorkspaceResult` | [src/shared/ipc.ts:794](D:/dev/aether-code/src/shared/ipc.ts:794) |
| `GitStatus` | [src/shared/ipc.ts:825](D:/dev/aether-code/src/shared/ipc.ts:825) |
| `GitCommit` | [src/shared/ipc.ts:838](D:/dev/aether-code/src/shared/ipc.ts:838) |
| `NextTurnQueueScope` | [src/shared/next-turn-queue.ts:2](D:/dev/aether-code/src/shared/next-turn-queue.ts:2) |
| `QueueResourceSelection` | [src/shared/next-turn-queue.ts:10](D:/dev/aether-code/src/shared/next-turn-queue.ts:10) |
| `QueueModelSelection` | [src/shared/next-turn-queue.ts:12](D:/dev/aether-code/src/shared/next-turn-queue.ts:12) |
| `QueueMemorySelection` | [src/shared/next-turn-queue.ts:15](D:/dev/aether-code/src/shared/next-turn-queue.ts:15) |
| `QueueMention` | [src/shared/next-turn-queue.ts:17](D:/dev/aether-code/src/shared/next-turn-queue.ts:17) |
| `QueueAttachmentReceipt` | [src/shared/next-turn-queue.ts:28](D:/dev/aether-code/src/shared/next-turn-queue.ts:28) |
| `NextTurnQueueEnvelope` | [src/shared/next-turn-queue.ts:38](D:/dev/aether-code/src/shared/next-turn-queue.ts:38) |
| `FrozenQueueSubmission` | [src/shared/next-turn-queue.ts:60](D:/dev/aether-code/src/shared/next-turn-queue.ts:60) |
| `QueueEntryBase` | [src/shared/next-turn-queue.ts:68](D:/dev/aether-code/src/shared/next-turn-queue.ts:68) |
| `NextTurnQueueEntry` | [src/shared/next-turn-queue.ts:75](D:/dev/aether-code/src/shared/next-turn-queue.ts:75) |
| `NextTurnQueueState` | [src/shared/next-turn-queue.ts:89](D:/dev/aether-code/src/shared/next-turn-queue.ts:89) |
| `NextTurnQueueUserMutation` | [src/shared/next-turn-queue.ts:99](D:/dev/aether-code/src/shared/next-turn-queue.ts:99) |
| `NextTurnQueueMutation` | [src/shared/next-turn-queue.ts:107](D:/dev/aether-code/src/shared/next-turn-queue.ts:107) |
| `NextTurnQueueOwnerMutation` | [src/shared/next-turn-queue.ts:109](D:/dev/aether-code/src/shared/next-turn-queue.ts:109) |
| `NextTurnQueueLimits` | [src/shared/next-turn-queue.ts:117](D:/dev/aether-code/src/shared/next-turn-queue.ts:117) |
| `QueueCommitReceipt` | [src/shared/next-turn-queue.ts:143](D:/dev/aether-code/src/shared/next-turn-queue.ts:143) |
| `QueueCommitResult` | [src/shared/next-turn-queue.ts:150](D:/dev/aether-code/src/shared/next-turn-queue.ts:150) |
| `PublishedChildFence` | [src/shared/published-child.ts:3](D:/dev/aether-code/src/shared/published-child.ts:3) |
| `PublishedChildIdentity` | [src/shared/published-child.ts:20](D:/dev/aether-code/src/shared/published-child.ts:20) |
| `PublishedChildReference` | [src/shared/published-child.ts:25](D:/dev/aether-code/src/shared/published-child.ts:25) |
| `PublishedChildUsage` | [src/shared/published-child.ts:36](D:/dev/aether-code/src/shared/published-child.ts:36) |
| `RootRunStatus` | [src/shared/root-run.ts:2](D:/dev/aether-code/src/shared/root-run.ts:2) |
| `RootPending` | [src/shared/root-run.ts:3](D:/dev/aether-code/src/shared/root-run.ts:3) |
| `RootRunRequestConfig` | [src/shared/root-run.ts:17](D:/dev/aether-code/src/shared/root-run.ts:17) |
| `RootRunCompaction` | [src/shared/root-run.ts:51](D:/dev/aether-code/src/shared/root-run.ts:51) |
| `RootRun` | [src/shared/root-run.ts:76](D:/dev/aether-code/src/shared/root-run.ts:76) |
| `EngineStreamCursor` | [src/shared/stream-event.ts:4](D:/dev/aether-code/src/shared/stream-event.ts:4) |
| `StreamRecoveryReason` | [src/shared/stream-event.ts:5](D:/dev/aether-code/src/shared/stream-event.ts:5) |
| `StreamEventBody` | [src/shared/stream-event.ts:7](D:/dev/aether-code/src/shared/stream-event.ts:7) |
| `StreamRequestRejection` | [src/shared/stream-event.ts:14](D:/dev/aether-code/src/shared/stream-event.ts:14) |
| `StreamStartResult` | [src/shared/stream-event.ts:15](D:/dev/aether-code/src/shared/stream-event.ts:15) |
| `StreamEvent` | [src/shared/stream-event.ts:26](D:/dev/aether-code/src/shared/stream-event.ts:26) |
| `StreamCursorDisposition` | [src/shared/stream-event.ts:38](D:/dev/aether-code/src/shared/stream-event.ts:38) |
| `SubagentRunStatus` | [src/shared/subagent.ts:2](D:/dev/aether-code/src/shared/subagent.ts:2) |
| `SubagentError` | [src/shared/subagent.ts:12](D:/dev/aether-code/src/shared/subagent.ts:12) |
| `SubagentUsage` | [src/shared/subagent.ts:18](D:/dev/aether-code/src/shared/subagent.ts:18) |
| `SubagentToolCall` | [src/shared/subagent.ts:28](D:/dev/aether-code/src/shared/subagent.ts:28) |
| `SubagentRunV1` | [src/shared/subagent.ts:40](D:/dev/aether-code/src/shared/subagent.ts:40) |
| `AgentCollaborator` | [src/shared/subagent.ts:77](D:/dev/aether-code/src/shared/subagent.ts:77) |
| `SubagentEvent` | [src/shared/subagent.ts:82](D:/dev/aether-code/src/shared/subagent.ts:82) |
| `SubagentToolSummary` | [src/shared/subagent.ts:91](D:/dev/aether-code/src/shared/subagent.ts:91) |
| `SubagentCoverage` | [src/shared/subagent.ts:100](D:/dev/aether-code/src/shared/subagent.ts:100) |
| `SubagentRunView` | [src/shared/subagent.ts:113](D:/dev/aether-code/src/shared/subagent.ts:113) |
| `SubagentRun` | [src/shared/subagent.ts:127](D:/dev/aether-code/src/shared/subagent.ts:127) |
| `SubagentIdentity` | [src/shared/subagent.ts:129](D:/dev/aether-code/src/shared/subagent.ts:129) |
| `SubagentViewHeader` | [src/shared/subagent.ts:140](D:/dev/aether-code/src/shared/subagent.ts:140) |
| `SubagentDeltaEvent` | [src/shared/subagent.ts:142](D:/dev/aether-code/src/shared/subagent.ts:142) |
| `SubagentViewEvent` | [src/shared/subagent.ts:156](D:/dev/aether-code/src/shared/subagent.ts:156) |
| `SubagentWireEvent` | [src/shared/subagent.ts:164](D:/dev/aether-code/src/shared/subagent.ts:164) |
| `SubagentRunsPage` | [src/shared/subagent.ts:166](D:/dev/aether-code/src/shared/subagent.ts:166) |
| `SubagentToolsPage` | [src/shared/subagent.ts:175](D:/dev/aether-code/src/shared/subagent.ts:175) |
| `SubagentToolDetailPage` | [src/shared/subagent.ts:185](D:/dev/aether-code/src/shared/subagent.ts:185) |
| `SubagentEventsPage` | [src/shared/subagent.ts:200](D:/dev/aether-code/src/shared/subagent.ts:200) |
| `SubagentCapabilities` | [src/shared/subagent.ts:210](D:/dev/aether-code/src/shared/subagent.ts:210) |
| `SubagentDiscoveryScope` | [src/shared/subagent.ts:216](D:/dev/aether-code/src/shared/subagent.ts:216) |
| `SubagentDiscoveryRef` | [src/shared/subagent.ts:222](D:/dev/aether-code/src/shared/subagent.ts:222) |
| `SubagentDiscoveryPage` | [src/shared/subagent.ts:231](D:/dev/aether-code/src/shared/subagent.ts:231) |
| `WorkQueueTarget` | [src/shared/work-next-turn-api.ts:4](D:/dev/aether-code/src/shared/work-next-turn-api.ts:4) |
| `WorkQueueDraft` | [src/shared/work-next-turn-api.ts:5](D:/dev/aether-code/src/shared/work-next-turn-api.ts:5) |
| `WorkQueueAction` | [src/shared/work-next-turn-api.ts:10](D:/dev/aether-code/src/shared/work-next-turn-api.ts:10) |
| `WorkQueueRequest` | [src/shared/work-next-turn-api.ts:15](D:/dev/aether-code/src/shared/work-next-turn-api.ts:15) |
| `WorkQueueRead` | [src/shared/work-next-turn-api.ts:16](D:/dev/aether-code/src/shared/work-next-turn-api.ts:16) |
| `WorkNextTurnApi` | [src/shared/work-next-turn-api.ts:17](D:/dev/aether-code/src/shared/work-next-turn-api.ts:17) |
| `WorkQueueInvokeResult` | [src/shared/work-next-turn-api.ts:22](D:/dev/aether-code/src/shared/work-next-turn-api.ts:22) |

## 对下一步方案的约束

- 必须用“当前会话实际可见工具 + 当前资源 + 客户端就绪状态”生成能力说明，不能只把整份菜单清单贴入系统提示。
- 文件创建、文件预览、在客户端打开、交付用户，应该有明确区分的契约；不能假设写出文件后模型自然知道如何展示。
- 浏览器现成桥值得复用：当前问题要检查 general profile 暴露、桥注册状态、tool schema/说明，以及运行快照是否真正进入上下文。
- 用户 PTY 与 AI 命令任务需要明确产品关系；若要 AI 受控管理用户终端，应该有单独可授权的桥和运行归属，不能把两个不同 ID 当成一个终端。
- 大量管理 API 应保持用户控制面身份。账号、凭证、引擎生命周期等不应仅因“生态完整”就自动开放给模型。
- 本报告仅确认客户端静态事实。事故会话的实际工具表、系统提示、skill 加载、浏览器桥就绪与错误处理，需要由会话记录和后端日志/源码共同证实。
