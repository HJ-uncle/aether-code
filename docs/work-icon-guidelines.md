# 默认界面的图标约定

源码核对日期：2026-11-17。保留旧文档文件名，但 Aether 当前只有一个默认界面。图标来源为 [ui/outline-icons.ts](../src/renderer/src/ui/outline-icons.ts) 与 [ui/icons.tsx](../src/renderer/src/ui/icons.tsx)，不再使用旧 `workbench/outline-icons.ts` 路径或按 Work／Code 切换图标体系。

## 当前接线

[App.tsx](../src/renderer/src/App.tsx) 用 `IconProvider variant="outline"` 包含应用、确认弹窗、Git 分歧策略弹窗与通知宿主；[ApplicationShell.tsx](../src/renderer/src/app/ApplicationShell.tsx) 的内容子树也明确使用相同轮廓样式。React portal 继承 Provider，因此菜单和浮层不依赖 `.work-view svg` 等 DOM 后代选择器。

普通轮廓图标采用 24×24 画布、1.5 描边、圆端点和圆连接，颜色继承所在控件。`Icon` 的通用目录仍保留部分品牌及特殊图形，不意味着还存在第二套产品界面。

## 语义来源

| 当前用途 | 图标 |
| --- | --- |
| 工作台／工作区首页 | `dashboard` |
| 项目／工作区目录 | `folder-outline` |
| Agent 管理／子代理集合 | `account-outline`／`users` |
| 调研／执行／通用角色 | `agent-research`／`agent-executor`／`agent-general` |
| 插件／内置插件管理工具包 | `puzzle`／`extensions` |
| 浏览器／搜索 | `globe`／`search` |
| 自动化／引擎监控 | `clock-outline`／`activity` |
| 成果／资料 | `file-check`／`library` |
| 技能／知识库／MCP | `package-variant-closed`／`book-open`／`plug` |
| 刷新数据／重新执行 | `refresh`／`restart` |
| 下载、导出／上传 | `download`／`upload-outline` |
| 会话服务／消息历史 | `terminal`／`clock-outline` |

导航的事实来源是 [navigation.tsx](../src/renderer/src/app/navigation.tsx)，工作区为 [workspace-tabs.ts](../src/renderer/src/features/workspace/workspace-tabs.ts)。通知入口随自身状态选择图形，不把旧“全局运行列表”名称当作当前服务入口。子代理图标根据 [builtin-agents.ts](../src/shared/builtin-agents.ts) 的角色身份选择，不能根据显示名称猜测身份。

运行中的任务使用独立 Spinner；等待审批、等待补充、失败、中断与完成使用实际状态对应的图形和可访问文案。断开连接仅表示需要恢复确认，不能绘制为已完成。状态实现见 [TaskStatus.tsx](../src/renderer/src/features/sessions/TaskStatus.tsx) 与[侧栏任务模型](../src/renderer/src/features/sessions/sidebar-task.ts)。

## 尺寸、可访问性与例外

常见尺寸为导航 18px、普通操作 16px、紧凑状态 12–14px、空态 24–28px，实际尺寸以相应组件为准；图标大小与按钮命中区域分别设置。

图标在已有文字时作为装饰，`Icon` 使用 `aria-hidden`。只显示图标的按钮仍须有稳定可访问名称，必要时有提示和键盘焦点；[IconButton](../src/renderer/src/ui/ui-primitives.tsx) 提供共享入口。手动刷新无需重复显示“刷新”文字，但不能因此丢失动作名称或忙碌反馈。

文件类型、品牌、图像标注、图表和坐标可视化按自身语义保留。进度圆环不等于刷新动作，不把按钮整体旋转作为所有加载状态的通用实现。颜色和焦点来自 [tokens.css](../src/renderer/src/assets/tokens.css)，不为某个菜单复制新色板。

## 当前验证入口

先构建新产物，再选择现有集中配置：

```sh
npm run build
npx playwright test --config e2e/config/playwright.work-icons.config.ts
npx playwright test --config e2e/config/playwright.mention-toolkit.config.ts
```

图标配置当前选择 [work-home-ui.spec.ts](../e2e/work-home-ui.spec.ts) 和 [task-status-icons-ui.spec.ts](../e2e/task-status-icons-ui.spec.ts) 中的相应断言，覆盖导航、portal、主题、SVG 目录边界和任务状态；资源菜单配置选择 [attachment-references-ui.spec.ts](../e2e/attachment-references-ui.spec.ts)。测试文件保留的 `work` 名字不代表需要切换产品模式。产物路径由配置固定在 `.e2e-tmp/`。

本次文档更新没有重新运行这些测试，也不宣称全部图标已完成当次视觉验收。验证应检查语义、可访问名称、实际状态与边界，不用固定 SVG 子节点数量替代功能断言。整体视觉实现见[设计说明](../design-system/aether-code/MASTER.md)。
