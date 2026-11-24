# 前端功能覆盖与源码地图

更新日期：2026-11-17。此表按当前默认界面的入口、组件接线与主进程边界盘点，不以目录存在或历史测试结果推定功能已经对用户开放。操作步骤集中在[使用指南](user-guide.md)，进程与身份关系见[前端结构](frontend-architecture.md)。

## 功能域覆盖

| 功能域 | 当前入口与覆盖范围 | 主要源码 | 对应文档 |
| --- | --- | --- | --- |
| app | 工作台、项目、Agent、插件、自动化、监控；管理页按需加载；命令、菜单、设置壳 | [navigation.tsx](../src/renderer/src/app/navigation.tsx)、[pages.tsx](../src/renderer/src/app/pages.tsx)、[ApplicationShell.tsx](../src/renderer/src/app/ApplicationShell.tsx)、[ApplicationView.tsx](../src/renderer/src/app/ApplicationView.tsx) | 使用指南；前端结构 |
| account | 新建／已有账号登录、外部服务 API Key/JWT、恢复文件、第三方登录、资料、重新验证、密钥更换、设备会话 | [AccountSettingsView.tsx](../src/renderer/src/features/account/AccountSettingsView.tsx)、[account/service.ts](../src/main/account/service.ts) | [账号与登录](accounts-and-login.md) |
| sessions | 首页、侧栏、分页历史、草稿、运行／等待／未读状态、会话菜单、回退和重发 | [sessions](../src/renderer/src/features/sessions/)、[useChat.ts](../src/renderer/src/core/engine/useChat.ts) | 使用指南「会话、补充与下一轮队列」 |
| composer | 输入、模型／Agent／工作区、附件、@ 引用、资源选择、立即补充／下一轮 | [Composer.tsx](../src/renderer/src/features/composer/Composer.tsx)、[ComposerWorkspace.tsx](../src/renderer/src/features/composer/ComposerWorkspace.tsx) | 使用指南；[工具配置](tool-profiles.md) |
| conversation | 轮次、过程折叠、工具活动、消息导航、完整历史、队列、用量 | [ConversationView.tsx](../src/renderer/src/features/conversation/ConversationView.tsx)、[NextTurnQueue.tsx](../src/renderer/src/features/conversation/NextTurnQueue.tsx) | 使用指南 |
| history | 列表使用的本地名称／置顶／颜色元数据与未落库会话占位；完整消息另由引擎历史适配负责 | [session-meta.ts](../src/renderer/src/features/history/session-meta.ts)、[pending-sessions.ts](../src/renderer/src/features/history/pending-sessions.ts)、[chat-history.ts](../src/renderer/src/core/engine/chat-history.ts)、[display-history.ts](../src/renderer/src/core/engine/display-history.ts) | 使用指南；前端结构 |
| interactions | 权限审批、提问与答案提交、等待状态 | [interactions](../src/renderer/src/features/interactions/) | 使用指南 |
| workspace | 会话目录、首页／资料／资源页签、文件树与只读预览、浏览器等工作区页签 | [workspace-tabs.ts](../src/renderer/src/features/workspace/workspace-tabs.ts)、[WorkspaceView.tsx](../src/renderer/src/features/workspace/WorkspaceView.tsx)、[fs-client.ts](../src/renderer/src/core/workspace/fs-client.ts) | 使用指南「工作区、项目与成果」 |
| explorer | 文件树操作、选择与共享文件管理逻辑 | [explorer](../src/renderer/src/features/explorer/)、[WorkspacePanel.tsx](../src/renderer/src/features/workspace/WorkspacePanel.tsx) | 使用指南 |
| projects | 按目录分组、独立会话、搜索、排序、置顶、显示名与归档 | [Projects.tsx](../src/renderer/src/features/projects/Projects.tsx) | 使用指南 |
| artifacts | 最终交付、文件变化、范围过滤、保留／回退、撤回本轮成果 | [SessionArtifacts.tsx](../src/renderer/src/features/artifacts/SessionArtifacts.tsx)、[ChangeReviewActions.tsx](../src/renderer/src/features/artifacts/ChangeReviewActions.tsx)、[UserMessageActions.tsx](../src/renderer/src/features/sessions/UserMessageActions.tsx) | 使用指南中的回退对照表 |
| agents | Agent 的指令、模型、技能／MCP／知识库／工具绑定 | [AgentManager.tsx](../src/renderer/src/features/agents/AgentManager.tsx)、[builtin-agents.ts](../src/shared/builtin-agents.ts) | 使用指南；工具配置 |
| collaboration | 子代理运行、历史、总结、停止、补充、复用与原任务续跑 | [SubagentsPanel.tsx](../src/renderer/src/features/collaboration/SubagentsPanel.tsx)、[SubagentInstruction.tsx](../src/renderer/src/features/collaboration/SubagentInstruction.tsx) | 使用指南「子代理协作与复用」 |
| models | 模型配置、连接测试、能力检测、上下文与并发设置 | [ModelsSettingsView.tsx](../src/renderer/src/features/models/ModelsSettingsView.tsx)、[SubagentConcurrencySetting.tsx](../src/renderer/src/features/models/SubagentConcurrencySetting.tsx) | 使用指南；工具配置 |
| security | 权限模式、会话安全设置与能力约束 | [security](../src/renderer/src/features/security/)、[security.ts](../src/renderer/src/core/engine/security.ts) | 使用指南；工具配置 |
| settings | 引擎、账号、外观、编辑显示、终端、模型、文件、搜索、键盘、Git、浏览器、安全、代码图、MCP、技能、知识库、记忆 | [AppSettingsView.tsx](../src/renderer/src/features/settings/AppSettingsView.tsx)、[settings](../src/renderer/src/features/settings/) | 使用指南；账号与登录；工具配置 |
| monitoring | 进入读取一次、手动刷新；资源／存储／连接／运行版本诊断 | [EngineMonitorView.tsx](../src/renderer/src/features/monitoring/EngineMonitorView.tsx)、[manual-diagnostics.ts](../src/renderer/src/features/monitoring/manual-diagnostics.ts) | 使用指南「设置、监控与插件」 |
| automations | 计划、目标会话／工作区、Agent 与工具、暂停、运行历史、收件箱 | [AutomationsView.tsx](../src/renderer/src/features/automations/AutomationsView.tsx)、[AutomationEditor.tsx](../src/renderer/src/features/automations/AutomationEditor.tsx) | 使用指南「自动化」 |
| browser | 网页多标签、导航、视口、网络／控制台、会话归属、AI 操作、插件标签 | [BrowserView.tsx](../src/renderer/src/features/browser/BrowserView.tsx)、[browser-ipc.ts](../src/main/browser-ipc.ts)、[browser-bridge.ts](../src/main/browser-bridge.ts) | [浏览器工作流](browser-workflow-reliability.md) |
| editor | 文件类型分发、图片／媒体预览、HTML 运行；默认代码与文本只读 | [FilePreview.tsx](../src/renderer/src/features/editor/FilePreview.tsx)、[CodePreview.tsx](../src/renderer/src/features/workspace/CodePreview.tsx)、[TextPreview.tsx](../src/renderer/src/core/editor/TextPreview.tsx) | [编辑器与预览边界](editor-code-oss.md) |
| documents | PDF／Office 只读预览、工作表／页面切换、格式与资源上限 | [documents](../src/renderer/src/features/documents/)、[document-kind.ts](../src/renderer/src/features/documents/document-kind.ts)、[office-render.ts](../src/main/office-render.ts) | 使用指南；编辑器与预览边界 |
| search | 当前工作区正文检索、过滤、取消、替换预览、路径身份保护 | [search](../src/renderer/src/features/search/)、[WorkspaceSearch.tsx](../src/renderer/src/features/workspace/WorkspaceSearch.tsx) | 使用指南 |
| git | 状态、差异、暂存、提交、分支、远端、冲突及仓库操作 | [GitPanel.tsx](../src/renderer/src/features/git/GitPanel.tsx)、[core/git](../src/renderer/src/core/git/)、[main/git](../src/main/git/) | 使用指南 |
| terminal | 会话终端、本地 PTY／远端终端、输出、偏好、导航 | [terminal](../src/renderer/src/features/terminal/)、[main/terminal](../src/main/terminal/) | 使用指南 |
| services | 当前会话运行／结束服务、终端跳转与停止；全局插件通知的未读／历史 | [ServiceTray.tsx](../src/renderer/src/features/services/ServiceTray.tsx)、[workspace-activity.ts](../src/renderer/src/features/services/workspace-activity.ts) | 使用指南；前端结构 |
| plugins | 插件管理、导入／编辑／测试／发布、授权、本地开发模式 | [plugins](../src/renderer/src/features/plugins/) | [插件 HTML 参考](plugin-api/content/overview.html) |
| extensions | 贡献注册、作用域、命令／菜单／视图、隔离页面与平台桥、版本失效 | [extensions](../src/renderer/src/features/extensions/)、[plugin-contributions.ts](../src/shared/plugin-contributions.ts) | 前端结构；插件 HTML 参考 |

表中覆盖当前 `features/` 下全部 26 个目录，另列 `app` 装配入口，共 27 行。资源功能中的记忆、MCP、知识库、技能和代码图位于 `settings`，不因没有独立目录而遗漏。

## 主进程、IPC 与持久化边界

| 链路 | 主要源码 | 文档归属与约束 |
| --- | --- | --- |
| 类型 → preload → IPC 注册 | [ipc.ts](../src/shared/ipc.ts)、[preload/index.ts](../src/preload/index.ts)、[main/ipc.ts](../src/main/ipc.ts)、[ipc-security.ts](../src/main/ipc-security.ts) | 前端结构；渲染层不自行持有通用 Node 权限 |
| 服务连接、内置引擎、HTTP／SSE、实例身份、导入运行时 | [main/engine](../src/main/engine/)、[EngineSettingsView.tsx](../src/renderer/src/features/settings/EngineSettingsView.tsx) | README、账号与登录、前端结构 |
| 账号认证与凭据保存 | [main/account](../src/main/account/)、[remote-auth.ts](../src/main/engine/remote-auth.ts) | 账号与登录；按服务地址隔离，不把模型密钥当账号凭据 |
| 下一轮队列持久化与派发 | [session-next-turn-ipc.ts](../src/main/session-next-turn-ipc.ts)、[next-turn-queue-service.ts](../src/main/next-turn-queue-service.ts)、[next-turn-dispatcher.ts](../src/main/next-turn-dispatcher.ts) | 使用指南；受会话／账号／来源身份与结果确认保护 |
| 文件、搜索、Git、终端 | [main/fs](../src/main/fs/)、[main/search](../src/main/search/)、[main/git](../src/main/git/)、[main/terminal](../src/main/terminal/) | 使用指南；会话远端资源通过引擎工作区链路，不能直接解释为本地路径 |
| 浏览器与本地预览 | [main/browser](../src/main/browser/)、[browser-preview.ts](../src/main/browser-preview.ts)、[browser-workspace-preview.ts](../src/main/browser-workspace-preview.ts) | 浏览器工作流；页面身份、选定文件、取消及真实可见性 |
| Office 解析 | [office-render.ts](../src/main/office-render.ts)、[shared/office-render.ts](../src/shared/office-render.ts) | 编辑器与预览边界；只读、资源限额、非原应用排版 |
| 系统打开方式与会话链接 | [open-with-ipc.ts](../src/main/open-with-ipc.ts)、[conversation-link.ts](../src/main/conversation-link.ts) | 使用指南；菜单由平台和目标类型决定 |
| 插件页面、宿主能力、下载与后台任务 | [plugin-ui.ts](../src/main/plugin-ui.ts)、[plugin-host.ts](../src/main/plugin-host.ts)、[plugin-download.ts](../src/main/plugin-download.ts)、[plugin-background.ts](../src/main/plugin-background.ts) | 前端结构及插件 HTML 唯一公开参考 |
| 本机设置、隔离实例与诊断 | [settings-store.ts](../src/main/settings-store.ts)、[instance-profile.ts](../src/main/instance-profile.ts)、[native-diagnostics.ts](../src/main/native-diagnostics.ts) | README；使用指南；前端结构 |
| 保留的语言服务与编辑宿主 | [main/lsp](../src/main/lsp/)、[core/lsp](../src/renderer/src/core/lsp/)、[core/editor](../src/renderer/src/core/editor/) | 编辑器与预览边界；底层实现不等于默认界面已提供可写编辑与完整 IDE |

## 已知边界与未覆盖验证

- 本轮为源码与文档覆盖审计；没有以全产品实机回归替代源码分析，也没有将旧报告中的通过数量作为当前版本结果。
- 完整可写代码编辑组、默认文件保存、已挂载的 TypeScript 项目语言操作、VS Code 扩展宿主、DAP 调试和 Notebook 不应作为当前默认界面既成能力宣传。旧 Code 的全局保存、格式化和重构命令已移除；共享文件状态、模型与语言服务基础设施继续保留。
- 远端系统、实际第三方账号提供方、外部模型质量、真实模型额度、任意 Office 文档排版和长时间后台运行，需要各自集成环境验证。
- 引擎内部的租户数据落盘、模型提示构造、上下文压缩、工具执行和调度不由前端文档完整定义；应结合配对引擎文档与服务能力。UI 无权绕过服务端限制。
- 插件公开 API 的逐项合同与例子只在 `docs/plugin-api/content/*.html` 维护；本表提供入口，不另建一份协议参考。
- 浏览器故障证据另见[保留调查](history/browser-workflow-reliability-before-2026-11-17.md)；当前编辑能力统一见[文件预览](editor-code-oss.md)。

