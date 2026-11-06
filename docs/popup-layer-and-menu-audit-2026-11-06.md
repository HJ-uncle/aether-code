# 弹层遮挡与菜单样式调研 · 2026-11-06

后续实现与验收见 [弹层与菜单统一实现](./popup-layer-and-menu-implementation-2026-11-06.md)。以下保留修改前的调查证据。

本轮按“先调研”执行，未修改产品代码。检查设置的 18 个分类、共享弹层组件和全局菜单调用；另用独立临时配置与模拟接口启动现有 Electron 构建，实测层级、点击命中、Esc 和 Tab。未使用或修改真实用户设置，也未调用真实模型服务。

## 结论

图一是共享弹层的层级和归属缺陷。Work 设置的 Dialog 与其内部 Select/Popover 都通过 portal 挂到 `document.body`，但前者层级是 200，后者是 100。菜单虽然已打开，仍被设置遮罩和内容盖住；焦点甚至可以进入这个看不见的菜单。

图三的左右贴边也来自共享 Select：列表只有上下 4px 留白，左右为 0；选项行圆角为 0。图二的方向适合全局菜单：四周留白、独立圆角选项、克制的悬停背景、清晰的标题/说明/状态。真正的设置、编辑表单与确认对话框保留自己的结构，内部菜单采用同一规范。

## 真实窗口证据

| 抽查场景 | 结果 |
|---|---|
| Work 设置 → 模型 → 子代理并发数量 | 菜单 100、设置遮罩 200；选项中心 `elementFromPoint` 命中设置内容，菜单被遮挡 |
| Work 设置 → 模型 → 子代理使用的模型 | 同样被遮挡 |
| Work 设置 → 外观 → 自定义颜色 | 同样被遮挡，说明不限于 Select |
| Work 设置 → 添加模型 → 服务商菜单 | 局部补丁将菜单设为 201，当前能正确命中 |
| 服务商菜单打开后 Esc | 仅关闭菜单，父表单与设置保留；Select 已有局部事件处理 |
| 添加模型表单内 Esc | 同时关闭添加模型与父设置，已复现 |
| 添加模型表单内 Tab | 焦点从子表单跳到父设置的关闭按钮，已复现 |

记录：[observations.json](D:/dev/aether-code/.e2e-tmp/popover-research-AXvRoX/observations.json)。截图：[并发菜单遮挡](D:/dev/aether-code/.e2e-tmp/popover-research-AXvRoX/settings-concurrency.png)、[模型分配](D:/dev/aether-code/.e2e-tmp/popover-research-AXvRoX/settings-model-assignment.png)、[主题色遮挡](D:/dev/aether-code/.e2e-tmp/popover-research-AXvRoX/settings-accent-color.png)、[已有局部补丁](D:/dev/aether-code/.e2e-tmp/popover-research-AXvRoX/nested-provider-patched.png)。

实测只代表上述场景；其余范围来自源码盘点。现有构建抽查无 renderer pageerror，但没有报错不代表层级和键盘行为正确。

## 设置范围

设置导航包含个人账号、引擎管理、外观、文本编辑器、终端、模型、文件、搜索、键盘、源代码管理、工作台、浏览器、安全、代码图、MCP、技能、知识库、记忆，共 18 类。

| 分类 | 需处理的弹出内容 | 归属 |
|---|---|---|
| 引擎管理 | 运行版本、远端认证方式 | 2 个共享 Select，缺少模态层归属 |
| 模型 | 子代理模型、轻任务模型、子代理并发数量 | 3 个共享 Select；并发和子代理模型已实测 |
| 外观 | 自定义强调色 | 1 个 Popover，已实测 |
| 浏览器 | 默认缩放、默认视口 | 2 个共享 Select |
| 安全 | 命中规则后的动作 | 1 个 Select 调用点，每条规则可生成实例 |
| 技能 | 导入层级、冲突策略 | 2 个共享 Select |
| MCP | 保存层级、传输类型、配置范围 | 3 个原生 select；不属于 body portal 遮挡，视觉需迁移 |
| 知识库 | 知识库选择 | 1 个原生 select，视觉需迁移 |
| 记忆 | 会话、类型筛选、编辑类型 | 3 个原生 select，视觉需迁移 |
| 其余 9 类 | 内联控件、表单、确认及原生文件窗口 | 不与上述 10 个 Select/1 个 Popover 混计；嵌套确认与表单纳入共享 Dialog 行为检查 |

模型新增/编辑属于第二层 Dialog；其中服务商/API 格式已有 `model-form__popover` 局部层级补丁。账号、导入/导出等触发的系统文件对话框，需要单独检查所属 Electron 窗口，不能用网页 CSS 解决。

## 共享实现的问题

- [tokens.css:94](D:/dev/aether-code/src/renderer/src/assets/tokens.css:94) 定义 `--z-popover:100` 与 `--z-overlay:200`。[Popover.tsx:234](D:/dev/aether-code/src/renderer/src/workbench/Popover.tsx:234) 和 [Dialog.tsx:128](D:/dev/aether-code/src/renderer/src/workbench/Dialog.tsx:128) 都 portal 到 body，子弹层不再继承父模态绘制层级。不是 overflow 裁剪，也未发现 HTML top layer API 导致此问题。
- [Dialog.tsx:58](D:/dev/aether-code/src/renderer/src/workbench/Dialog.tsx:58) 给每个实例注册 document Escape，未判断最上层，所以嵌套对话框会一起关闭。
- [Dialog.tsx:92](D:/dev/aether-code/src/renderer/src/workbench/Dialog.tsx:92) 的 Tab 约束只认识 DOM 后代。子 Dialog portal 是 DOM 兄弟，但 React 事件仍冒泡到父组件，父层误把子层焦点当作离开对话框。
- [Popover.tsx:193](D:/dev/aether-code/src/renderer/src/workbench/Popover.tsx:193) 把所有 `.popover__panel` 都视为内部点击，缺少父子归属。ContextMenu 也有同类规则。ActionMenu、Select 和其他自绘弹层的 Escape 消费策略不一致。
- 模型表单、Agent 编辑、自动化分别使用 `--z-overlay + 1`。这些局部补丁无法表达多层父子关系，也可能让旧菜单覆盖后打开的模态。
- [components.css:6472](D:/dev/aether-code/src/renderer/src/assets/components.css:6472) 的 `.select__panel` 为 `padding:var(--space-1) 0`；选项行没有圆角。真实窗口计算结果为 `4px 0px` 和 `0px`。

## 全局统一范围

以下是 TypeScript AST 统计的 JSX 静态调用点，不是可见入口数或运行实例数；数量会随其他并行开发变化。

| 组件 | 调用点 / 文件数 | 迁移方式 |
|---|---:|---|
| Select | 39 / 18 | 统一菜单表面、选项行、状态与可选图标 |
| ActionMenu | 9 / 8 | 已有四周留白和圆角行，收敛尺寸与状态规范 |
| ContextMenu | 17 / 12 | 统一右键与二级菜单，保留快捷键、色板和子菜单箭头 |
| 原生 select | 8 / 4 | 设置中的 7 处加办公预览缩放；迁移共享选择器才可统一弹出列表 |
| Popover | 17 / 13 | 原始总数包含 Select/ActionMenu 内部两处；作为容器不能整体套菜单行样式 |
| Dialog | 25 / 24 | 统一层级和交互，保留设置、表单、确认、预览的结构 |
| CompletionPopover | 3 / 2 | 保留补全行为，列表内部适配视觉规范 |

前三种共享菜单共 65 个静态调用点。独立 MenuBar、ComposerOptions 的 3 个子菜单、Git 分支菜单、上下文窗口预设、文件/Agent/资源补全、编辑器路径选择、Work 运行列表、命令面板与快速打开也需纳入。

ActionMenu、ContextMenu、ComposerOptions 子菜单已经有四周 4px 留白与圆角；发送方式与工作区菜单分别有局部 5px/6px 覆盖，不能再叠加一套 padding。GitPickDialog/GitMultiPickDialog 的内部列表也是贴边来源，但其搜索、多选与确认结构需要保留。`SecurityModePicker`、`KnowledgePicker` 当前没有 JSX 调用者，属于留存实现，不当作已展示入口。

## 图二对应的建议规范

这些尺寸是本项目提案，不是 Apple 强制像素标准。

| 部位 | 建议 |
|---|---|
| 菜单外框 | 四边统一 6–8px 内边距，使用现有明暗材质、边框、阴影令牌 |
| 选项 | 独立 8–10px 圆角，悬停/键盘高亮不贴外边框 |
| 密度 | 普通项保持紧凑单行；有说明的选项按内容增高，避免强行统一大高度 |
| 左侧 | 可选 16px 图标；图标有意义时使用，无图标菜单不强塞装饰 |
| 中间 | 主标题与弱化说明对齐；说明尽量简短，必要含义不截断 |
| 右侧 | 已选值显示勾；操作项按需显示快捷键或子菜单箭头；固定预留位置避免跳动 |
| 状态 | 已选、鼠标悬停、键盘活动、禁用、风险操作分开表达；不可只靠颜色识别 |
| 边界 | 锚定触发器，空间不足翻转，四周保留窗口安全距离；长菜单内部滚动 |

图三的安全模式菜单实际复用通用 Select，因此应修共享层；文案与授权含义保留，样式调整不改变权限语义。

## 建议实施顺序与验收

1. 先建立共享弹层归属与栈：登记父层、触发器、类型、面板、关闭动作；保证父层低于子层，后打开的模态高于原有菜单。仅最上层处理 Escape、外部点击和焦点约束，焦点范围包含所属 portal。
2. 让 Dialog、Popover、菜单、全局确认窗口接入同一机制，处理焦点返回、下层交互隔离、退出动画和快速重开。逐步移除业务级 201 补丁。
3. 提取限定于菜单的表面与行样式，覆盖 Select/ActionMenu/ContextMenu；再迁移原生 select 与独立列表。不使用 `.popover__panel button` 之类宽泛选择器，以免破坏调色器、服务详情和表单。
4. 补全真机验收：Code/Work 设置、设置→表单→菜单、设置→确认；鼠标必须实际命中选项，Esc 一次只关一层，Tab/Shift+Tab 不进入父窗口或背景，关闭后焦点正确返回。
5. 覆盖明暗、窄窗、缩放、靠边翻转、滚动、搜索长列表、中文输入、模式切换，以及内置浏览器原生表面的遮挡协作。

不建议直接把所有菜单改成极大 z-index：那会让后台旧菜单跑到后来打开的弹窗上方。也不建议只更换 `showModal()`，而不同时调整子 portal 的容器和焦点归属。

另有待实机核对的独立风险：普通文件选择与部分账号原生窗口未一致传入 BrowserWindow owner；这是系统窗口归属问题，尚未在本轮复现。[browser-occlusion.ts:62](D:/dev/aether-code/src/renderer/src/contrib/browser/browser-occlusion.ts:62) 当前按 DOM 选择器探测弹层遮挡，新共享层要保留兼容或接入统一登记。
