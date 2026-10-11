# 前端页面覆盖清单

本轮按渲染层注册入口和工作台面板逐页检查，所有页面继续使用现有业务组件、store、IPC 和引擎请求。新增的 `assets/page-surfaces.css` 是最后的视觉收口层，复用 `tokens.css` 的令牌，不改变数据或交互协议。

| 功能区 | 入口/组件 | 收口内容 |
| --- | --- | --- |
| 工作台外壳 | `Workbench`, `MenuBar`, `ActivityBar`, `Sidebar`, `PanelArea`, `StatusBar` | 玻璃 chrome、4/8 间距、选中/焦点态、窄屏收缩 |
| 资源管理器 | `ExplorerView` | 工具栏、树行、活动路径、滚动条与虚拟行高度保持 30px |
| 编辑器 | `EditorArea`, `DocumentView`, `EditorToolbar`, `EditorOutline`, Monaco 容器 | 标签基线、路径工具条、大纲层级、焦点环 |
| 对话 | `ChatView`, `SessionTray`, `ChangesPanel`, `TodoTray`, 工具结果与附件卡片 | 消息/托盘/输入区对齐、键盘可见动作、长内容收缩 |
| Git | `GitView`, `GitChangesPanel`, 历史/存储/提交行 | 行高、操作命中区、hover 与 focus-within、窄栏省略 |
| 搜索与问题 | `SearchView`, `ProblemsView` | 输入区、筛选、文件组、结果行、空态与滚动 |
| 终端与输出 | `TerminalView`, `OutputView` | 标签栏、状态条、输出日志行、空态与窄屏布局 |
| 内置浏览器 | `BrowserView`, `NetworkInspector`, `BrowserSettingsView` | 标签、地址栏、导航工具、检查器、状态条与毛玻璃 |
| 设置 | `AppSettingsView` 及外观、编辑器、终端、引擎、记忆、模型、安全、MCP、技能、知识库、Git、文件/搜索排除、快捷键、账户页 | 共享 `SettingsGroup`/`GlassSurface`，标题、卡片、控件高度、窄屏列布局 |
| 历史与账户 | `SessionHistoryView`, `AccountSettingsView` | 列表行、摘要卡、会话设备行、错误/空态和小屏堆叠 |

## 共用组件

- `workbench/ui-primitives.tsx`：`GlassSurface`、`SectionHeading`、`IconButton`。
- `assets/tokens.css`：颜色、字体、圆角、间距、材质、焦点和滚动条唯一事实来源。
- `assets/page-surfaces.css`：页面级材质、列表三态、空态和容器响应式规则。

页面专属 CSS 只保留语义布局；所有新增颜色均先进入令牌，再由页面引用。
