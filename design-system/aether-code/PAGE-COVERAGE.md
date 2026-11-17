# 当前前端页面与视觉来源

源码核对日期：2026-11-17。本表替代早期按旧 Work／Code 组件编写的页面列表，只记录当前默认界面可达入口及样式来源。完整的 26 个功能目录、主进程与 IPC 覆盖见[功能覆盖表](../../docs/feature-map.md)，用户操作见[使用指南](../../docs/user-guide.md)。

## 页面与工作区

| 当前功能面 | 可达组件与装配 | 视觉来源 |
| --- | --- | --- |
| 应用壳与导航 | [ApplicationShell.tsx](../../src/renderer/src/app/ApplicationShell.tsx)、[ApplicationView.tsx](../../src/renderer/src/app/ApplicationView.tsx)、[navigation.tsx](../../src/renderer/src/app/navigation.tsx) | `app/application.css`、共享菜单／状态栏／布局组件 |
| 工作台与会话列表 | [sessions](../../src/renderer/src/features/sessions/) 的 Home、SidebarHistory、任务状态与菜单 | 会话与侧栏功能 CSS、通用列表／控件 |
| 对话与输入 | [conversation](../../src/renderer/src/features/conversation/)、[composer](../../src/renderer/src/features/composer/)、[interactions](../../src/renderer/src/features/interactions/) | 消息、过程、附件、输入、审批和提问样式 |
| 项目页 | [Projects.tsx](../../src/renderer/src/features/projects/Projects.tsx) | 项目功能 CSS、任务状态及动作复用 |
| 工作区与资料 | [WorkspaceView.tsx](../../src/renderer/src/features/workspace/WorkspaceView.tsx)、[WorkspacePanel.tsx](../../src/renderer/src/features/workspace/WorkspacePanel.tsx)、[ResourceTabs.tsx](../../src/renderer/src/features/workspace/ResourceTabs.tsx) | 工作区、资源标签、文件树与共享控件 |
| 成果与变更 | [artifacts](../../src/renderer/src/features/artifacts/) | 成果、最终结果、文件变更和回退操作样式 |
| 文件与文档预览 | [FilePreview.tsx](../../src/renderer/src/features/editor/FilePreview.tsx)、[CodePreview.tsx](../../src/renderer/src/features/workspace/CodePreview.tsx)、[documents](../../src/renderer/src/features/documents/) | 文本／代码、图片及 PDF／Office 专属预览样式 |
| Agent 与子代理 | [AgentManager.tsx](../../src/renderer/src/features/agents/AgentManager.tsx)、[SubagentsPanel.tsx](../../src/renderer/src/features/collaboration/SubagentsPanel.tsx) | Agent 卡片、子代理列表／记录／补充区域 |
| 自动化 | [AutomationsView.tsx](../../src/renderer/src/features/automations/AutomationsView.tsx)、[AutomationEditor.tsx](../../src/renderer/src/features/automations/AutomationEditor.tsx) | 自动化功能样式与共享表单 |
| 引擎监控 | [EngineMonitorView.tsx](../../src/renderer/src/features/monitoring/EngineMonitorView.tsx) | 监控卡片、状态、表格与手动刷新 |
| 浏览器 | [BrowserView.tsx](../../src/renderer/src/features/browser/BrowserView.tsx)、[BrowserSettingsView.tsx](../../src/renderer/src/features/browser/BrowserSettingsView.tsx) | 标签／地址／视口／检查器；普通网页与插件隔离页分别承载 |
| 搜索 | [WorkspaceSearch.tsx](../../src/renderer/src/features/workspace/WorkspaceSearch.tsx)、[SearchView.tsx](../../src/renderer/src/features/search/SearchView.tsx) | 工作区内搜索、结果和替换预览 |
| Git | [GitPanel.tsx](../../src/renderer/src/features/git/GitPanel.tsx) | Git 面板、差异、仓库与确认弹窗样式 |
| 终端与服务 | [terminal](../../src/renderer/src/features/terminal/)、[ServiceTray.tsx](../../src/renderer/src/features/services/ServiceTray.tsx) | xterm 主题、会话终端、服务菜单和状态栏通知 |
| 设置与账号 | [AppSettingsView.tsx](../../src/renderer/src/features/settings/AppSettingsView.tsx)、[AccountSettingsView.tsx](../../src/renderer/src/features/account/AccountSettingsView.tsx) | 共享设置分组及各领域 CSS；账号引导与重新验证 |
| 插件管理与扩展页面 | [plugins](../../src/renderer/src/features/plugins/)、[extensions](../../src/renderer/src/features/extensions/) | 宿主管理界面及受限主题桥；自定义页面不能当作普通网页能力 |

默认页面由 `app/pages.tsx` 按需加载；工作区页签在 `features/workspace/workspace-tabs.ts` 定义。历史 `EditorArea`、`ChatView`、`Workbench` 等名字不再作为当前页面装配依据。工作区当前提供只读代码／文本预览，不能把保留的底层编辑器文件当作已开放页面。

## 共用视觉与交互

- [MASTER.md](MASTER.md)：当前主题、字体、间距、圆角、材质与动效实现说明。
- [tokens.css](../../src/renderer/src/assets/tokens.css)：唯一令牌来源。
- [ui-primitives.tsx](../../src/renderer/src/ui/ui-primitives.tsx)：表面、标题、图标按钮与 Spinner。
- [ui](../../src/renderer/src/ui/)：图标、菜单、选择器、弹窗、overlay、分隔条与动效生命周期。
- [page-surfaces.css](../../src/renderer/src/assets/page-surfaces.css)：共享页面材质；具体业务布局仍归对应功能域。
- [palette.ts](../../src/renderer/src/core/theme/palette.ts)：Monaco／xterm 与动态主题的取色桥。

## 覆盖含义

表中“覆盖”表示已核对入口与源码归属，不表示本次重新运行了全部页面的视觉或交互验收。外部网站、插件自定义 HTML、Office 文件排版、远端服务和系统字体仍需相应环境验证。历史问题记录见 [QA-ISSUES.md](QA-ISSUES.md)，它不覆盖现行入口与实现说明。
