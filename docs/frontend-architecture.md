# 前端结构与插件承载约定

应用只有一个默认界面。产品代码不再按 Code / Work 模式分目录；浏览器协议和已保存的数据键中保留的 `work` 是既有身份，不代表第二套界面。

| 目录 | 职责 |
| --- | --- |
| `src/renderer/src/app` | 应用壳、页面装配、导航、内置命令注册、管理页按需加载 |
| `src/renderer/src/features/sessions` | 会话状态、草稿、控制器、首页和会话列表 |
| `src/renderer/src/features/conversation` | 对话、运行反馈、消息和工具活动；`shared` 为输入、附件和 Markdown 共享组件 |
| `src/renderer/src/features/composer` | 默认输入区、附件和工作区选择 |
| `src/renderer/src/features/workspace` | 工作区页签、文件树、资源预览、资料 |
| `src/renderer/src/features/artifacts` | 成果、交付文件、变更审阅和回退 |
| `src/renderer/src/features/agents` / `collaboration` | Agent 管理、子代理交互与运行详情 |
| `src/renderer/src/features/plugins` | 插件项目 CRUD、导入、编辑、发布、工具运行表单 |
| `src/renderer/src/features/extensions` | 插件前端贡献注册、启停生命周期、自定义页面桥接 |
| `src/renderer/src/features/services` | 服务托盘、通知摘要、已读状态、服务动作菜单 |
| `src/renderer/src/features/*` | 浏览器、终端、Git、设置、项目、监控等独立功能域 |
| `src/renderer/src/ui` | 无业务归属的按钮、图标、菜单、弹窗、浮层、分栏和动效 |
| `src/renderer/src/core` | 引擎通信、文件服务、平台适配、主题和共享状态设施 |
| `src/shared` | 主进程、预加载、渲染层共同使用的 IPC 与协议类型 |

`ApplicationView` 负责页面装配、导航和前台会话桥接。对话正文、运行反馈和工作区分别由 `ConversationView`、`SessionFeedback`、`WorkspaceView` 管理。管理页首次打开才加载；自定义插件页只在打开时挂载，关闭释放 iframe 和事件监听。

## 插件贡献

已发布并启用的插件通过 manifest 的 `contributes` 声明 `pages`、`navigation`、`workspaceTabs`、`services`。前后端校验和创建模板提供同一套协议目录。导航和页签由宿主绘制；页面支持宿主工具表单以及真实自定义 HTML。

贡献以插件 ID、发布 revision、hash、引擎来源和实例身份归属。替换版本时撤销旧贡献；旧清理函数不能删除新实例。停用移除入口、页面、服务视图和定时回调。`scope` 与 `when` 控制会话、工作区、引擎就绪条件。

外部 HTML 位于无同源权限的 sandbox iframe。它没有 Electron preload，不能直接访问宿主状态和 IPC；使用 `window.aetherPlugin` 调用当前页面声明的工具、读取受限上下文、导航至自身页面和操作自身服务。工具仍在引擎运行，使用固定发布版本。页面加载不把所有插件工具加入 Agent 请求。

当前服务截止时间由桌面宿主维护；这不是系统级持久任务调度器，应用退出不承诺后台触发。跨重启定时任务应使用引擎自动化服务。插件代码、业务数据和会话事实仍由各自引擎存储负责。

## 服务与通知

会话页使用左侧图标入口；其他页面在导航底部提供入口。同屏只出现一个入口。托盘合并当前会话后台命令与可见插件服务，右键菜单调用真实的打开、停止、复制与已读动作。

托盘不读取命令输出，也不增加日志轮询。通知只保存有界摘要，历史终态首次读取为已读；新状态变化产生未读。全局插件通知跨页面共享，会话通知按引擎和会话隔离。删除历史或卸载插件会撤销对应记录。

## 后续扩展规则

- 新功能落入所属 `features` 域；不要恢复 `contrib/work` 或复制第二套默认界面。
- 跨进程类型放 `src/shared`；插件宿主契约集中在 `plugin-contributions` 与 `features/extensions`，不要散落字符串注册。
- UI 组件复用 `ui`，颜色使用 `assets/tokens.css` 的既有令牌，图标操作保留可访问名称和键盘入口。
- 保留会话、来源、版本边界；不得把界面显示状态当作引擎运行事实。
- 删除代码先查实际入口、静态/动态导入以及 worker/CSS 引用；编辑器、终端和预览仍是默认应用功能。
- 修改后执行 `npm run typecheck` 和 `npm run build`，再串行运行相关 Electron E2E。测试使用独立 profile、端口和数据目录。

重点回归：`extension-host-ui.spec.ts`、`service-tray-ui.spec.ts`、`work-terminal-ui.spec.ts`、`work-home-ui.spec.ts`、插件管理、成果/附件/子代理交互。测试文件中的历史 `work` 名称及已有持久键不会创建新的产品模式。
