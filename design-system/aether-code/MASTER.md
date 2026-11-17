# Aether 当前设计实现

源码核对日期：2026-11-17。本文记录当前默认界面的设计令牌与组件接线，不另建一套覆盖产品的样式规则。实现的唯一令牌来源是 [tokens.css](../../src/renderer/src/assets/tokens.css)，工程约定见 [AGENTS.md](../../AGENTS.md)。修改视觉实现后，应同步本说明；不能用旧模板中的色值、字体或页面规则覆盖源码。

## 界面方向与层级

当前界面采用 Apple 风格的紧凑桌面布局：灰阶表面区分导航、内容与浮层，以留白、文字层次和轻量分隔组织信息。应用只有一个默认工作台，管理页面和会话工作区共享同一套控件与主题；旧 `work` 类名保留为实现标识。

[ApplicationShell.tsx](../../src/renderer/src/app/ApplicationShell.tsx) 装配菜单、内容、状态栏及弹窗；[ApplicationView.tsx](../../src/renderer/src/app/ApplicationView.tsx) 组织导航、会话与工作区。具体可达页面见 [PAGE-COVERAGE.md](PAGE-COVERAGE.md) 和[功能覆盖表](../../docs/feature-map.md)。

## 样式来源

| 层 | 当前源码 | 职责 |
| --- | --- | --- |
| 全局入口 | [app.css](../../src/renderer/src/assets/app.css) | 按顺序导入令牌、基础、共享组件，以及页面、菜单和输入控件样式 |
| 设计令牌 | [tokens.css](../../src/renderer/src/assets/tokens.css) | 字体、颜色、间距、圆角、尺寸、层级、材质和动效值 |
| 基础层 | [base.css](../../src/renderer/src/assets/base.css) | 重置、元素默认态、焦点环、选择区与滚动条 |
| 共享控件 | [components.css](../../src/renderer/src/assets/components.css)、[input-controls.css](../../src/renderer/src/assets/input-controls.css) | 按钮、输入、表单与跨页面组件 |
| 页面材质 | [page-surfaces.css](../../src/renderer/src/assets/page-surfaces.css) | 页面表面与共享布局收口；具体业务样式仍在功能域 |
| 动效 | [motion.css](../../src/renderer/src/assets/motion.css)、[MotionPresence.tsx](../../src/renderer/src/ui/MotionPresence.tsx) | 浮层进入／关闭、折叠、悬停反馈与减少动态效果 |
| 业务布局 | [features](../../src/renderer/src/features/)、[application.css](../../src/renderer/src/app/application.css) | 会话、成果、工作区、设置等实际布局 |

共享样式与业务 CSS 引用已有令牌。需要新颜色时先在令牌中定义深浅外观；不能复制一份独立调色板。本文的值是当前源码快照，实际优先级与例外以 CSS 级联为准。

## 主题与颜色

`html` 的 `data-appearance` 决定深色／浅色，`data-accent` 决定强调色，两者正交。系统外观会解析成当前有效明暗；CSS 未接到外观时以深色兜底，并不禁止用户选择浅色。

| 语义令牌 | 深色当前值 | 浅色当前值 |
| --- | --- | --- |
| `--bg-app` | `#1c1c1e` | `#f2f2f4` |
| `--bg-surface` | `#232325` | `#fafafa` |
| `--bg-elevated` | `#2c2c2e` | `#ffffff` |
| `--fg` | `#e5e5e7` | `#2b2b2e` |
| 默认蓝色 `--accent` | `#4b95f1` | `#0071e3` |

强调色还提供紫、粉、橙、绿、石墨与自定义颜色。文字前景、柔和底色、悬停色和焦点环从当前强调色及主题派生。当前不存在应由页面统一套用的旧 `--color-primary`／`--color-accent` 命名体系；也不应把所有按钮改成固定绿色。

状态色、语法色、图片／图表及身份颜色有各自语义。普通选中、悬停、失焦选中与键盘焦点分别表达不同状态，不能只靠一个高亮色混用。

## 字体、尺寸与间距

界面字体优先系统 San Francisco，其他平台使用打包的 Inter Variable，中文回退苹方或微软雅黑；入口 [main.tsx](../../src/renderer/src/main.tsx) 加载本地 Inter。代码使用 `--font-mono` 的系统等宽／SF Mono／JetBrains Mono／Cascadia Mono／Consolas 回退链。本文不要求加载外部 Google Fonts。

| 当前令牌 | 值与用途 |
| --- | --- |
| 基础正文 | `base.css` 为 13px、1.5 行高；标题与内容区域按组件调整 |
| `--radius` 及矩形表面别名 | 12px |
| `--radius-check`／`--radius-mark` | 4px／2px，供复选框与微小标记 |
| `--radius-pill`／`--radius-round` | 999px／50%，供胶囊与圆形控件 |
| `--space-1` 至 `--space-7` | 4、8、12、16、20、24、32px |
| `--control-h-compact`／`--control-h`／`--control-h-lg` | 24／28／34px 控件基线 |
| `--input-height` | 32px，输入组件可按多行或工具栏布局覆盖 |
| `--menu-row-height` | 32px |
| `--titlebar-h`／`--chrome-h` | 46／36px |
| `--status-bar-h` | 28px |

这些是基线，并不表示所有按钮最终高度相同。共享样式和业务页面可能设置更大的最小命中区域，判断实际布局需查看计算后样式；不要仅根据令牌表改变已验证的控件尺寸。

## 组件与交互

[ui-primitives.tsx](../../src/renderer/src/ui/ui-primitives.tsx) 提供 `GlassSurface`、`SectionHeading`、带可访问名称的 `IconButton` 以及 `Spinner`。业务状态由所属功能控制，视觉原语不读取引擎或业务数据。

[icons.tsx](../../src/renderer/src/ui/icons.tsx) 与 [outline-icons.ts](../../src/renderer/src/ui/outline-icons.ts) 提供当前图标体系；应用通过 `IconProvider variant="outline"` 使用轮廓图标，包括跨 portal 的菜单和弹窗。新增功能应复用此入口，而不是混用另一套图标库或 emoji。

刷新等明确动作可只显示图标，但必须保留可访问名称及必要提示。加载状态由独立 Spinner 表达，不能把按钮整体旋转当作唯一反馈。按钮禁用、运行中和操作成功／失败由真实状态驱动。

焦点使用 `--focus-ring`：当前为 3px、由强调色混合派生；通过 `:focus-visible` 提供键盘反馈。复合输入由一层外壳绘制焦点环，避免框中框；Monaco 和 xterm 使用自身焦点反馈，不再叠加通用表单环。

菜单、弹窗、选择器和命令面板复用 [ui](../../src/renderer/src/ui/) 的 overlay 与 portal 机制。按当前上下文管理焦点、关闭与层级，避免动画关闭期间仍拦截下一次输入。

## 材质、滚动与动效

浮层材质使用 `--material-*` 的背景、边框、高光、投影与模糊组合，当前统一模糊半径 12px；不支持模糊时退回实心背景。页面表面不应依靠重复重边框或大阴影分层。

垂直滚动条由基础层统一实现，常规轨道 6px；横向资源区采用可读的标签最小宽度、边缘渐隐与独立浮动滚动条，避免为了塞满一行把标题和操作挤到不可辨识。

动效令牌当前为进入 180ms、退出 120ms、悬停 100ms、位移 6px；业务布局调整和拖动分隔条保留直接反馈。`prefers-reduced-motion: reduce` 关闭相关非必要位移、过渡与动画。不要引入旧设计文件中的 GSAP 波浪式入场要求，当前产品并没有这一统一依赖。

## Monaco 与 xterm

它们不能直接依赖 CSS 级联取色，需要通过 [palette.ts](../../src/renderer/src/core/theme/palette.ts) 的 `cssColor` 和 `watchTheme` 接收颜色与主题变化。RGBA 应归一化成可解析颜色，避免 Monaco 失败后回退红色。自定义强调色和系统明暗变化也必须触发更新。

默认工作区文件为只读预览。视觉上有 Monaco 或编辑器偏好设置，不代表可写编辑器和语言服务已经挂载；能力说明见[编辑器与预览边界](../../docs/editor-code-oss.md)。

## 核对与验证范围

设计改动需要结合浅色／深色、当前强调色、键盘焦点、禁用／忙碌、长文字、窄窗口和减少动态效果检查。交互、IPC、Monaco 或 xterm 改动还须按工程约定进行真实窗口测试。

本文是实现核对结果，没有重新宣称所有页面已通过全量视觉验收。历史 [QA-ISSUES.md](QA-ISSUES.md) 记录当时的问题与观察，不能把其中旧页面或旧状态当作当前入口。
