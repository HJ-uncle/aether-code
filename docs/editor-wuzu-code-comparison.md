# Aether 与 Wuzu Code 模式源码编辑器深度比较

审阅日期：2026-09-30。对象是两个仓库的**当前工作树**，包含尚未提交的修改。

| 对象 | 路径 | HEAD（不代表工作树无修改） |
|---|---|---|
| Aether | `D:/dev/aether-code` | `f3aa70e51d055bc00fd19c17631c2e0e056e8eb5` |
| Wuzu Client | `D:/web/wuzu-client` | `6c5f3e66fbaad7ab7956ef1734ca5f151d48c528` |

本报告比较源码编辑器、文档状态、语言服务及与 Git/AI 的衔接，不评价两个产品全部聊天、终端或 Agent 运行能力。架构前提沿用用户决定：**保留 Aether 当前界面，在其中整合编辑能力。**

本轮为源码审计：追踪真实入口、组件挂载、事件处理、状态变更、IPC、主进程文件操作、LSP provider，以及相关测试和打包脚本。没有启动 Wuzu/Aether 窗口，没有运行新的 build、E2E 或性能测试，没有修改产品代码。下文“已接入”表示调用链存在；风险场景为静态推导，不能当作本轮真机复现。行号随后续修改可能变化。

## 1. 总体结论

**Wuzu 的源码编辑工作流明显更丰富；Aether 的主要差距集中在功能集成，而非编辑内核。** 两边都是独立 Monaco 加自建工作台，Wuzu 没有直接运行完整 VS Code 工作台。它的双栏、大纲、面包屑、差异编辑、文件监听和预览，来自外壳与服务之间的额外实现。

Aether 当前已经拥有真正的项目 TS/JS 服务、定义/引用/重命名/格式化、官方中文 Monaco、命令系统和搜索替换，不能再按旧截图把它描述为“只有高亮的文本框”。Wuzu 的实现范围更广，也不意味着每项更可靠：双方均有未保存文档保护缺口，Wuzu 的文档回灌和跨文件编辑尤其不适合整体照搬。

| 维度 | 当前判断 | 对 Aether 的直接启示 |
|---|---|---|
| 编辑布局与上下文 | Wuzu 领先：真实双栏、路径/符号面包屑、常驻大纲 | 整合进现有界面；先建立明确的编辑组与焦点模型 |
| Git 与源码联动 | Wuzu 领先：完整 diff、行边变更、块操作、冲突动作 | 优先接通 Aether 已有 Git 后端和编辑区 |
| 文件与 AI 变更刷新 | Wuzu 领先：监听、clean 文档刷新、AI/revert 后同步 | 是日常可信度问题，应早于外观功能解决 |
| 文档保存保护 | Aether 部分领先，但双方有高风险缺口 | 保留 current/saved 分离和保存冲突检查，先补统一关闭与大文件保护 |
| 语言功能广度 | Wuzu 多自动导入 resolve、代码操作、Vue 接入 | 移植协议能力，继续使用 Aether 的版本校验和显式保存 |
| TS/JS 服务可靠性 | Aether 超时、取消、退出通知、TSX/JSX、格式化更完整 | 加强现有实现，无需换成 Wuzu 客户端 |
| 命令、快速打开、搜索替换 | Aether 多项更完整 | 保留，补齐与新编辑功能的连接 |
| 设置、恢复、预览 | Wuzu 领先 | 借鉴配置持久化、懒加载标签与预览交互 |
| 完整 VS Code 能力 | 双方都有明显边界 | 不把 Monaco 原生能力或安装的依赖包算作完整 IDE 功能 |

## 2. 实际架构与入口

### 2.1 Aether

```text
Workbench → EditorArea → DocumentSlot
                         → 文档 Renderer（以文件路径为 key）
                         → DocumentView → MonacoEditor
editor-store：当前内容 / 已保存内容 / dirty / 文档顺序
monaco-setup：按文件身份缓存模型
monaco-workspace：跨文件编辑与打开文件桥
window.aether → preload IPC → 文件服务 / Git / LSP 主进程
```

当前只有一个源码编辑组。切标签时 `DocumentSlot` 内文档渲染器的 key 改变，会卸载并重建编辑器宿主；模型和视图状态另行缓存。因此“组件注释说只切 model”不等于真实宿主生命周期。

证据：[编辑区入口](D:/dev/aether-code/src/renderer/src/workbench/EditorArea.tsx:306)、[按路径创建文档渲染器](D:/dev/aether-code/src/renderer/src/workbench/EditorArea.tsx:333)、[文档视图](D:/dev/aether-code/src/renderer/src/contrib/editor/DocumentView.tsx:71)、[模型与视图恢复](D:/dev/aether-code/src/renderer/src/contrib/editor/MonacoEditor.tsx:147)。

### 2.2 Wuzu Code

```text
Cowork/index.vue → CodeWorkspacePanel → WorkspacePanel
                                        ├─ 左 CodeEditorPane → MonacoHost / DiffHost
                                        └─ 右 CodeEditorPane → MonacoHost / DiffHost
codeWorkspace（Pinia）：共享 openedFiles、左右 active path、dirtyMap
monacoModels：模型与视图缓存
window.api → preload IPC → fileExplorer / Git / codeLsp
```

这里有真实的左右两个编辑器实例，不能因为旧 `CodeRightPane` 的结构而漏判。两侧共享一份 `openedFiles`，分别保存活动路径；这与 VS Code 每组独立标签、可任意拆分的编辑器组不同。

证据：[Code 工作区入口](D:/web/wuzu-client/src/renderer/src/views/Cowork/CodePanel/CodeWorkspacePanel.vue)、[实际双栏挂载](D:/web/wuzu-client/src/renderer/src/components/workspace/WorkspacePanel.vue:109)、[编辑与差异宿主](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorPane.vue:41)、[共享标签列表](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorTabs.vue:17)。

### 2.3 技术与版本

| 项目 | Aether | Wuzu |
|---|---|---|
| UI / 状态 | React / 外部 store、useSyncExternalStore | Vue / Pinia |
| Monaco，本地安装版本 | 0.56.0 | 0.55.1 |
| TypeScript | 5.9.3 | 5.8.3 |
| typescript-language-server | 6.0.1 | 5.3.0 |
| Vue language server | 当前编辑链未接入 | 3.3.11，另有 TS Vue 插件 |
| 渲染进程桥 | `window.aether` | `window.api` |
| 编辑服务形态 | 独立 Monaco + 自建 LSP 客户端 | 独立 Monaco + 自建 LSP 客户端 |

版本差不能解释 Wuzu 的功能优势。Vue 组件、Pinia store 和 IPC 类型也不能直接放进 React 工程使用；可借鉴的是纯逻辑、协议处理、交互设计和验收场景。

## 3. 编辑、导航和布局比较

以下“未发现”均限定于本次检索的当前源码编辑器调用链，不表示无法开发。

| 能力 | Aether 当前 | Wuzu Code 当前 | 比较 |
|---|---|---|---|
| 基本文本编辑 | Monaco 多光标、折叠、查找替换等 | 同类 Monaco 能力 | 共同基础，不能记为 Wuzu 独有 |
| 中文体验 | 官方 Monaco 中文，自建菜单中文，TS 诊断配置 zh-CN | 官方 Monaco 中文，自建 Code UI 中文 | Aether 基础中文已补齐；第三方输出不保证全中文 |
| 左右分栏 | 单编辑组 | 两个真实源码 Pane，可调比例 | Wuzu 领先；尚非独立多组系统 |
| 标签操作 | 单关、其他、右侧、全部、中键、键盘切换、重开关闭标签 | 关闭类操作、中键、路径复制、系统定位、加入聊天、Git 状态色 | Aether 重开/键盘较完整，Wuzu 上下文入口更多 |
| 标签拖排、固定、临时预览标签 | 未发现完整工作链 | 未发现完整工作链 | 双方缺口 |
| 快速打开 | 模糊评分、最近文件、`>` 命令、`:行:列`、`?` 帮助 | 主要 substring 匹配，目录扫描上限 5000、结果前 50 | Aether 更完整；上限是 Wuzu 此入口的实现，不是建议照搬 |
| 命令与快捷键 | 命令注册表、when 上下文、命令面板、持久化自定义快捷键 | 少量工作台 action 和全局键盘分派；另有 Monaco 内置 F1 | Aether 应保留现有底座 |
| 当前文件符号 | Ctrl+Shift+O | 同类符号能力并接常驻大纲 | 不是 Aether 完全没有符号能力 |
| 面包屑 | 未挂载源码面包屑 | 文件路径、光标所在符号链、目录/符号选择器 | Wuzu 领先 |
| 常驻大纲 | 未挂载 | 筛选、跟随光标、展开/折叠、诊断提示 | Wuzu 领先，主要面向 TS/JS/Vue |
| 跨文件位置后退/前进 | 未找到真实位置栈 | 未找到真实位置栈 | 最近文件、Git 历史不能替代位置导航 |
| 项目搜索替换 | 大小写、全字、正则、include/exclude、替换预览、精确列定位 | 同类基础过滤与替换确认，选区可作为搜索词 | Aether 预览和定位更完整；Wuzu 选区衔接可借鉴 |
| 文件树操作 | 新建文件/目录及现有右键操作已接通 | 新建、重命名、移动等已接通 | 不能把 Aether 描述成只有只读文件树 |
| 编辑器设置 | 字体/字号/缩进主要固定；wrap/minimap 可切但仅内存 | 字体、字号、行高、连字、缩进、wrap 可配置并持久化 | Wuzu 领先 |

证据：[Aether Quick Open](D:/dev/aether-code/src/renderer/src/workbench/QuickOpen.tsx)、[命令注册](D:/dev/aether-code/src/renderer/src/contrib/index.ts)、[搜索](D:/dev/aether-code/src/renderer/src/contrib/search/SearchView.tsx:104)、[内存显示设置](D:/dev/aether-code/src/renderer/src/core/editor/editor-display-options.ts:7)；[Wuzu 快速打开](D:/web/wuzu-client/src/renderer/src/components/code/CodeQuickOpen.vue:73)、[面包屑](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorPane.vue:67)、[大纲实际挂载](D:/web/wuzu-client/src/renderer/src/components/code/CodeSidePane.vue:136)、[设置 UI](D:/web/wuzu-client/src/renderer/src/components/code/CodeSettingsTab.vue:301)。

## 4. 文档状态、保存和生命周期比较

| 能力 | Aether 当前 | Wuzu Code 当前 | 影响 |
|---|---|---|---|
| draft 的权威来源 | store 区分 `content` 与 `savedContent`，模型同步 | store 的 `file.content` 是保存基线，draft 主要在 Monaco，dirtyMap 独立 | Wuzu 必须格外避免把基线灌回 draft |
| 文件身份 | Windows/UNC 分隔符与大小写归一，文档和模型共同使用 | watcher 局部归一，打开/dirty 等多处仍按原始路径 | Aether 更一致，应沿用 |
| 首次打开 | 先放 loading 占位再读取 | 先读取再加入标签；懒加载存根另有合并 | 双方仍需检查打开/关闭竞态 |
| 单文件保存 | 快照写盘，成功仅更新保存基线；校验磁盘内容 | 写盘后同步模型为保存快照并清 dirty | Aether 更能保护保存期间继续输入 |
| 外部版本冲突 | 保存前比较磁盘与 savedContent | 没有同等保存基线比较，主进程直接 writeFile | Aether 较好，但 read-then-write 不是原子 CAS |
| 保存全部 | 有，逐个处理 dirty 文档 | 当前 Code 链未发现 saveAll | Aether 领先 |
| 正常自动保存 | 未发现完整源码自动保存 | 未发现完整源码自动保存 | 重命名后台自动写盘不是一致的自动保存模式 |
| 单标签关闭 | 保存并关闭 / 不保存 / 取消；失败保持文档 | 鼠标提供丢弃/取消；Ctrl+W 另走直接关闭 | Aether 更完整 |
| 批量关闭 | 绕过单标签 dirty 确认 | 同类绕过 | 双方必须优先修复 |
| 外部改盘监听 | 缺少全局文件事件通道；reload 仅搜索替换主动调用 | chokidar + mtime/size 判定 + clean 文件重载 | Wuzu 更完整，但 dirty 外部变化没有冲突状态 |
| AI / Git 回滚后的源码刷新 | 缺少统一编辑缓冲区刷新连接 | 多处显式 reloadOpenedFiles，并有文件监听 | Aether 会有磁盘已变、打开源码仍旧的风险 |
| 外部删除 | reload 失败保留内存内容，后续保存暴露错误 | clean 文件发现不存在会关标签；dirty 跳过 | 两边都需要明确的“磁盘文件已删除”交互 |
| 程序化全文替换与撤销 | 多处 setValue，会清 undo | pushEditOperations，替换可撤销 | 可借鉴 Wuzu API 使用，但须先确定替换合法性 |
| 标签恢复 | 最近文件持久化，打开文档列表主要内存 | 每项目保存路径/活动文件/展开目录，懒加载 | Wuzu 领先；恢复路径不等于恢复 draft |
| 未保存内容崩溃恢复 | 未见源码 draft journal | 未见源码 draft journal | 双方缺口 |
| 切换项目 | root 与 docs 解耦，可保留原标签 | setCwd 会清标签、dirtyMap、split | Wuzu 路径需纳入统一 dirty 关闭流程 |
| 大文件 | 前 4 MB 截断读取，提示但仍可保存 | 全量读；部分入口超过 2 MB 拒绝，Quick Open 未带 size | 双方策略存在问题，Aether 涉及截断落盘风险 |
| 编码 | 主要 UTF-8；NUL 检查会影响 UTF-16 识别 | 能识别 UTF-16 LE/BE BOM、UTF-8 BOM | Wuzu 读取范围更广 |
| 编码保存 | UTF-8 | 固定 UTF-8 | 双方都不是保留源编码/BOM的完整 roundtrip |

证据：[Aether 文档状态与保存](D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:308)、[身份归一](D:/dev/aether-code/src/renderer/src/core/editor/file-identity.ts:2)、[关闭入口](D:/dev/aether-code/src/renderer/src/workbench/EditorArea.tsx:145)、[文件读取](D:/dev/aether-code/src/main/fs/file-service.ts:172)；[Wuzu 恢复与设置](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:553)、[监听处理](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:904)、[保存与 draft](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:1721)、[保留撤销的替换](D:/web/wuzu-client/src/renderer/src/components/code/monacoModels.ts:26)、[编码读取](D:/web/wuzu-client/src/main/fileExplorer/index.ts:296)。

## 5. 项目语言服务比较

语法高亮、服务器安装、服务能力声明、实际 provider、端到端验证是不同层次。下表按产品当前接入情况比较。

| 能力 | Aether | Wuzu Code | 判断 |
|---|---|---|---|
| 项目 TS/JS | 主进程 TLS/tsserver，实际项目语义 | 同类实现 | 两边都有，不是只靠 Monaco 内存 worker |
| TSX/JSX | 按扩展名发送 typescriptreact/javascriptreact | 发送普通 typescript/javascript | Aether 正确；Wuzu 存在解析模式风险 |
| 本地 HTML/CSS/JSON worker | 有 | 有 | 不等于框架项目完整能力 |
| completion / hover / signature | 有真实 LSP provider | 有真实 LSP provider | 双方已接入 |
| 自动导入 | 初始 additionalTextEdits 有映射；resolve 漏合并 | resolve 合并 textEdit/additionalTextEdits | Wuzu 更完整 |
| 定义跳转 | provider + 文件 opener | provider + 提前加载模型 + opener | 双方已接入 |
| 引用 / peek | 返回位置，未完整解决未打开文件的模型解析 | 为目标提前 ensureModel | Wuzu 链路更完整，但后台模型生命周期需改进 |
| 重命名 | 已开/后台/未开文件统一文档状态，版本校验，显式保存 | 有 prepareRename；后台模型在 rename 后延迟自动保存 | Aether 保存一致性较好，Wuzu 多 prepareRename |
| TS 整篇/选区格式化 | 真正项目 LSP provider | 未注册项目 formatting/rangeFormatting | Aether 更完整，不能默认把 Wuzu worker 算成等价实现 |
| quickfix / refactor / organize imports | 未接完整 codeAction/executeCommand/applyEdit | 已有请求、resolve、命令桥与应用编辑 | Wuzu 功能领先，但 WorkspaceEdit 有协议问题 |
| 文件符号 | documentSymbol + Monaco 符号跳转 | 再接大纲、面包屑和缓存 | Wuzu 产品化更完整 |
| 项目引用高亮 | DocumentHighlight provider | 未注册对应 LSP provider | Aether 更完整 |
| 项目 inlay hints / semantic tokens | 未接项目 LSP provider | 未接项目 LSP provider | 不把局部 worker 能力外推成项目级支持 |
| 工作区符号、调用/类型层级、类型定义/实现 | 本链未见完整 provider | 本链未见完整 provider | 双方缺口 |
| 诊断 | 项目 markers + problems 状态，过滤旧版本，TS 中文 | markers 聚合，手工刷新项目诊断；缺版本过滤 | Aether 防过期更好；可借鉴手工刷新入口 |
| 默认超时 | 常规 15 秒、初始化 30 秒、关闭 2 秒 | 普通请求/init/shutdown 默认无超时；手工诊断刷新例外为 30 秒 | Aether 更完整 |
| 取消 / 服务退出 | 取消通知，进程退出通知 renderer 并拒绝 pending | 缺取消路由和 renderer 退出通知 | Aether 更完整 |
| 服务故障后的 worker 恢复 | 有恢复配置，但 provider 初始化时序仍有风险 | 恢复配置不完整且可能被 pending 阻塞 | 双方需真机退出回归，不能判定自动降级已可靠 |
| Python/Go/Rust/C++ 等 | 高亮不等于该语言项目 LSP | 同样 | 都没有完整通用编辑器语言生态 |

证据：[Aether TS 客户端](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:84)、[跨文件模型桥](D:/dev/aether-code/src/renderer/src/core/editor/monaco-workspace.ts:29)、[主进程 LSP 接入](D:/dev/aether-code/src/main/ipc.ts:465)；[Wuzu provider](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:630)、[resolve 编辑合并](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:990)、[后台模型](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:458)。

### Vue 能力应如何准确描述

Wuzu 比 Aether 多了一条 Vue 服务链，但“启动 Volar”不能直接写成“完整支持 Vue”。

| 路径 | Wuzu 的实际执行者 | 能确认的边界 |
|---|---|---|
| `.vue` 文本与同步 | Monaco HTML 基底；TS 和 Vue 客户端都同步文档 | 不等于 VS Code Vue 的完整高亮/语义体系 |
| 补全、hover、定义、引用、签名 | TS 客户端 provider + `@vue/typescript-plugin` | 有接入；模板专属补全和组件提示仍需逐项验证 |
| rename / codeAction | 同一 TS 插件路径 | 继承当前 WorkspaceEdit 和后台落盘风险 |
| 诊断 | TS 插件；Vue 客户端也能接收对应通知 | 不以源码注释中“为空/可用”替代实际诊断回归 |
| 常驻大纲、符号面包屑 | `.vue` 时向就绪的 Volar 查询符号 | Volar 确有用途，并非闲置进程 |
| Volar 通用 provider | `registersProviders:false` | 不能把 Volar 自带的全部能力算作已接入 |
| Vue 格式化、inlay、semantic tokens 等 | 无对应完整项目 provider | 不列为已完成能力 |

证据：[TS 插件与路由](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:1212)、[Volar 初始化](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:1301)、[Vue 自定义符号查询](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:1495)。Aether 当前 TS 服务未接 `.vue` 插件和对应路由。

## 6. Git、AI、预览与编辑器的连接

| 能力 | Aether 当前 | Wuzu Code 当前 | 差距的实质 |
|---|---|---|---|
| 编辑区完整 diff | Git 面板能取 diff，但打开动作退化为打开源码 | 实际挂载 Monaco DiffHost，可 inline/side-by-side | Aether 缺“差异文档 + 差异宿主”连接 |
| 行边修改标记、块预览 | 有 GitInlineDiffWidget 文件，但源码宿主未接入 | gutter 点击打开块 widget，F7 巡览、块回滚 | 有组件不等于产品已提供 |
| 冲突解决 | 有后端/解析和部分 UI 基础，源码 Monaco 未挂冲突动作 | 冲突 CodeLens，操作编辑缓冲区 | 值得接入现有 Aether Git 服务 |
| blame | 源码宿主未接 | 光标行归属显示在底部，能关联提交/历史 | Wuzu 有已接功能，但行尾 blame prop 未传，不能算已启用 |
| AI 变更审阅 | 已有行 diff 卡片、保留/撤回/批量/暂存保留及冲突报告 | 已有 review，并能打开编辑区 diff | Aether 不是没有 AI review；缺少与源码宿主的连续交互 |
| AI 改盘 / 撤回后同步 | 当前打开模型没有统一刷新链 | watcher + 显式 reload | Aether 应优先补齐，否则界面与磁盘会分离 |
| 选区加入对话 | 文件路径和行范围进入聊天上下文 | 同类能力，入口和选区末行边界处理更细 | 两边均需明确未保存选区文本如何传给 AI |
| Markdown / HTML 预览 | 文本走 Monaco，没有对应源码同步预览宿主 | 编辑/分屏/预览，使用未保存文本，滚动同步 | Wuzu 领先 |
| 媒体 | 图片缩放/平移、视频、hex fallback | 图片、视频、音频、PDF | 各有能力，不做“一方全有”的判断 |

证据：[Aether Git 打开源码分支](D:/dev/aether-code/src/renderer/src/contrib/git/GitChangesPanel.tsx:483)、[现有块差异组件](D:/dev/aether-code/src/renderer/src/contrib/git/GitInlineDiffWidget.tsx)、[AI 审阅](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:150)、[撤回请求](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:89)；[Wuzu DiffHost](D:/web/wuzu-client/src/renderer/src/components/code/DiffHost.vue:169)、[冲突动作](D:/web/wuzu-client/src/renderer/src/components/code/MonacoHost.vue:492)、[行边点击](D:/web/wuzu-client/src/renderer/src/components/code/MonacoHost.vue:787)、[底部 blame 与块 widget](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorPane.vue:216)、[源码预览](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorPane.vue:129)、[AI 撤回后刷新](D:/web/wuzu-client/src/renderer/src/stores/codeChanges.ts:508)。

Wuzu HTML 预览使用 `srcdoc`，sandbox 同时允许 scripts 和 same-origin。迁移时需要结合 Aether 资源协议与来源重新设计隔离，不能直接继承这组权限；本轮没有进行预览安全运行测试。参考：[CodeHtmlPreview](D:/web/wuzu-client/src/renderer/src/components/code/CodeHtmlPreview.vue)。

## 7. 需要优先处理的源码风险

下面均未做本轮窗口复现。“链路明确”指读写/关闭操作可在代码中连续追踪；“需运行确认”指实际焦点、时序或服务返回形状会影响触发。

### R1：Aether 截断读取后仍允许覆盖保存——高，链路明确

触发：打开超过 4 MB 的文本，编辑前部并保存。

主进程只返回前 4 MB；编辑区展示警告却仍可编辑。保存只排除 binary/loading，没有拒绝 truncated。保存前重新读取也得到同样的前缀，因此基线比较可通过，最终整文件写入已加载的前缀，尾部存在被截掉的路径。界面已经有风险提示，但提示不能替代保存保护。

证据：[读取上限](D:/dev/aether-code/src/main/fs/file-service.ts:24)、[截断读取](D:/dev/aether-code/src/main/fs/file-service.ts:198)、[提示横幅](D:/dev/aether-code/src/renderer/src/contrib/editor/DocumentView.tsx:66)、[保存入口](D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:308)。

处理：将截断预览定义为不可覆盖保存的文档状态，统一所有打开入口；若用户选择完整编辑，必须先完整读取并建立新基线。

### R2：双方批量关闭绕过 dirty 确认——高，链路明确

触发：修改两个文件不保存，右键“关闭全部/其他/右侧”。双方批量入口直接删除文档/释放模型，没有沿用单文件确认。Wuzu Ctrl+W 还绕过鼠标关闭确认。

证据：[Aether 菜单](D:/dev/aether-code/src/renderer/src/workbench/EditorArea.tsx:197)、[Aether 批量关闭](D:/dev/aether-code/src/renderer/src/workbench/EditorArea.tsx:351)、[Wuzu 菜单](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorTabs.vue:338)、[Wuzu store 关闭](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:1609)、[Wuzu Ctrl+W](D:/web/wuzu-client/src/renderer/src/views/Cowork/CodePanel/useCodeModeLifecycle.ts:135)。

处理：单关、批关、快捷键、项目切换、正常退出共用一个关闭决策服务。先处理全部 dirty 文档，再释放视图和模型；任一保存失败或用户取消不能继续丢弃。

### R3：Aether AI/外部改盘后，已打开源码可能停留旧版本——高，缺失连接明确

`reloadDocuments` 的产品调用只找到搜索替换；Git store 明确没有全局 fs-change 通道。AI 撤回请求更新结果报告，没有更新打开文档；再次 openFile 对已打开文件直接返回缓存。

证据：[缺少事件通道的现状](D:/dev/aether-code/src/renderer/src/core/git/git-store.ts:16)、[搜索替换主动刷新](D:/dev/aether-code/src/renderer/src/contrib/search/search-store.ts:401)、[AI 撤回](D:/dev/aether-code/src/renderer/src/core/engine/change-revert.ts:89)、[打开缓存](D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:165)。

处理：文件监听作为通用入口，AI/Git 完成事件提供明确刷新提示；clean 文档更新基线和模型，dirty 文档记录外部版本并展示冲突，不能直接覆盖。

### R4：Wuzu 切标签可能把旧保存基线灌回未保存 draft——高，静态推导

触发：打开 A/B，在 A 输入未保存内容，切 B 再切 A；开启分栏也涉及同类模型取得过程。

`CodeEditorPane` 传给 MonacoHost 的是 `activeFile.content`；`updateDraft` 只改 dirtyMap。切路径后 `getOrCreateModel(path, content)` 发现模型已存在，仍会用传入的保存基线替换模型。因此可能出现未保存文本突然回退。此替换使用可撤销编辑，**不应描述为必然不可恢复的删除**；但误保存/误关闭仍会造成实际损失风险。

证据：[传入保存基线](D:/web/wuzu-client/src/renderer/src/components/code/CodeEditorPane.vue:179)、[仅标 dirty](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:1758)、[切路径](D:/web/wuzu-client/src/renderer/src/components/code/MonacoHost.vue:892)、[已有模型回灌](D:/web/wuzu-client/src/renderer/src/components/code/monacoModels.ts:45)。

处理：获取已有文档模型不得隐式覆盖它。加载磁盘、切视图、应用外部版本应是不同操作；Aether 当前 current/saved 分离应保留。

### R5：Wuzu 保存回包可能覆盖保存期间输入；dirty 外部变化被忽略——高，静态推导

触发一：Ctrl+S 后，在 IPC 返回前继续输入。成功回包会把旧快照同步回模型，再设 dirty=false，未检查期间是否产生新版本。

触发二：本地有 dirty 内容时，AI/外部编辑器修改磁盘，再保存。watcher 对 dirty 文件直接跳过，没有记录冲突；主进程写入又没有基线检查。

证据：[保存后的模型同步](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:1721)、[dirty 跳过事件](D:/web/wuzu-client/src/renderer/src/stores/codeWorkspace.ts:914)、[直接写盘](D:/web/wuzu-client/src/main/fileExplorer/index.ts:592)。

Aether 保存成功只推进已提交快照的 savedContent，较好地保护新输入，但仍缺每文件保存串行化；读取基线与写入之间的竞争窗口也未彻底消除。

### R6：Wuzu 双栏全局快捷键可能操作左侧文件——中，需运行确认

工作区右侧 CodeEditorPane 没有注册同样的 editorPaneRef；全局 capture 键盘监听先拦截 Ctrl+S 等，再调用单个主 ref。右侧获得焦点时仍可能保存/关闭主侧文档。两边不同文件、不同 dirty 状态时应做专门真机回归。

证据：[左右 ref 挂载](D:/web/wuzu-client/src/renderer/src/components/workspace/WorkspacePanel.vue:115)、[全局快捷键路由](D:/web/wuzu-client/src/renderer/src/views/Cowork/CodePanel/useCodeModeLifecycle.ts:91)。

处理：命令目标取自 focusedEditor/group，而不是固定组件 ref；视图状态也应按 group+document 保存。

### R7：双方 LSP 适配存在具体缺口——功能与可靠性风险

| 对象 | 源码问题 | 后果与修复方向 |
|---|---|---|
| Aether | completion triggerKind 直接传 Monaco 0/1/2，LSP 是 1/2/3 | 转换枚举并覆盖字符触发/续请求 |
| Aether | resolveCompletionItem 未合并 resolved textEdit/additionalTextEdits | 自动导入可能只有符号没有 import；合并最终编辑 |
| Aether | 未有真实 executeCommand/applyEdit 桥，直接映射 LSP command 不足 | 代码操作要从协议到文档事务完整接入 |
| Aether | 引用位置未配完整未打开模型解析；声明 prepareRename 却未实现对应 provider | 补引用预览模型服务与 rename 预检 |
| Wuzu | documentChanges 要求 `kind === 'edit'` | 标准 TextDocumentEdit 只有 textDocument+edits，会被漏掉；按协议区分文本/资源操作 |
| Wuzu | 文本编辑没有版本校验；rename 后后台模型 300ms 自动落盘 | 可能应用旧结果；后台文件绕过统一 dirty/显式保存 |
| Wuzu | codeAction 编辑未与 rename 后台持久化/文档状态统一 | 裸模型编辑可能不可见，后续开文件又被磁盘基线覆盖 |
| Wuzu | 多数请求和 init/shutdown 没超时，退出不通知 renderer | 服务异常可能留下 pending，stop 等 starting 阻塞恢复 |
| Wuzu | worker mode 配置误用 `hover` 而非 `hovers`，整体替换时漏字段 | 内置 hover/format/diagnostics 等不能默认视为可用 fallback |
| 双方 | 恢复 modeConfiguration 不保证已初始化的 provider 重注册 | 必须实际验证初始化失败、运行中退出和关闭超时后的编辑能力 |

证据：[Aether 补全转换](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:179)、[Wuzu WorkspaceEdit](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:530)、[后台自动保存](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:605)、[请求超时默认值](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:195)、[worker 配置](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.ts:1404)、[服务退出处理](D:/web/wuzu-client/src/main/codeLsp/server.ts:215)。

### 其它应纳入回归的边界

- Aether 打开后立即关闭，读取回包缺少完整的请求代数/存活判断，可能写回没有标签的文档状态。
- Wuzu 首次重复 openFile 在读取完成前可能各自追加标签；存根懒加载的合并机制不覆盖这个入口。
- Wuzu 引用预览创建后台裸模型，关闭标签的释放机制不覆盖所有这类模型；未做长会话内存测试。
- 双方没有可依赖的源码未保存缓冲区崩溃恢复；Wuzu 恢复标签路径和聊天草稿都不能证明源码 draft 可恢复。

## 8. 打包、测试与性能证据

### 打包与离线能力

双方都配置本地 editor/json/css/html/ts worker。Aether 的 TLS 虽列在开发依赖，打包路径会从 engine runtime 获取 server 与 Node，准备脚本明确复制 TS/TLS，不能据 devDependencies 就断言发布包缺语言服务。当前准备脚本目标为 Windows x64，未据此验证其它平台。

Wuzu 主进程处理 `app.asar.unpacked`，为 Vue 的 `--tsdk` 优先寻找工作区 TypeScript；TS 服务器自身负责其版本选择。electron-builder 列出 LSP 解包依赖，另有闭包检查脚本。可借鉴它的依赖完整性检查；打包配置存在仍不等于干净机器安装已验证。

证据：[Aether runtime 准备](D:/dev/aether-code/scripts/prepare-engine-runtime.mjs:95)、[运行时解析](D:/dev/aether-code/src/main/ipc.ts:465)、[Wuzu server 解析](D:/web/wuzu-client/src/main/codeLsp/server.ts:47)、[解包配置](D:/web/wuzu-client/electron-builder.yml:106)、[依赖检查](D:/web/wuzu-client/scripts/check-lsp-unpack.cjs)。

### 测试覆盖的实际含义

| 对象 | 当前仓库证据 | 不能推出的结论 |
|---|---|---|
| Aether | 有真实 F12、F2 跨文件、格式化、TSX/JSX、路径映射、中文和保存冲突用例 | 不代表新发现的批量关闭/大文件/AI 刷新问题已通过 |
| Aether 历史结果 | 上轮定向 50 passed，其中 35 条真机、15 条纯函数 | 不是全项目 50 条覆盖，更不是本轮重新执行 |
| Wuzu | 有真实 Monaco undo 测试、LSP 刷新 mock、store/history/review 测试 | 单元/mock 不能证明 Electron 跨进程编辑流程可靠 |
| Wuzu E2E | 当前仅 smoke 文件内 4 条启动/登录/单实例等用例 | 不能作为 Code 编辑、Vue、分栏、保存安全验收 |

测试入口：[Aether 语言动作](D:/dev/aether-code/e2e/editor-language-actions.spec.ts)、[项目语言](D:/dev/aether-code/e2e/editor-project-language.spec.ts)、[中文与保存冲突](D:/dev/aether-code/e2e/monaco-localization.spec.ts)、[Wuzu 模型撤销](D:/web/wuzu-client/test/renderer/codeMonacoUndoStack.test.ts)、[Wuzu LSP mock](D:/web/wuzu-client/src/renderer/src/components/code/codeLspClient.test.ts)、[Wuzu smoke](D:/web/wuzu-client/e2e/smoke.spec.ts)。

### 性能：本轮只能指出测量对象

Wuzu 有 Monaco vendor 分块；Aether 当前构建没有同类手工分块。Wuzu 切换同一 Host，Aether 重建 Host 但复用 model；Wuzu 标签恢复懒加载。双方 LSP didChange 都发送全文，可能有大文件输入开销。

这些是设计事实，**不能据此给出启动速度、输入延迟或内存排名**。应以同一机器、同一项目、同一文件和冷/热状态分别测量：首个可输入时间、连续切 100 个文件、编辑大文本、引用返回大量文件、反复开关 diff/分栏、服务重启前后模型/进程数量。不要用源码行数或组件数打分。

## 9. Aether 的整合方案与顺序

### 应保留、应借鉴、应重做

| 处理 | 内容 |
|---|---|
| 保留 Aether | 现有 UI、命令注册与 when、Quick Open、搜索替换预览、Windows 文件身份、current/saved 状态、保存基线保护、显式跨文件保存、TS 格式化及超时/取消/退出通知 |
| 借鉴 Wuzu | 文件监听与 clean 重载、DiffHost 交互、gutter/viewZone、冲突 CodeLens、符号缓存及大纲/面包屑、编辑设置持久化、标签懒恢复、未保存文本预览、自动导入 resolve 和代码操作链 |
| 在 Aether 重做适配 | React 视图、window.aether IPC、共享文档事务、focused editor、真正的 EditorGroup、引用模型生命周期、Vue provider 路由 |
| 不沿用的实现 | 已有模型自动灌保存基线、保存回包覆盖新输入、裸模型 300ms 自动落盘、批量关闭绕过确认、共享标签冒充独立组、dirty 外部变化直接丢弃、无超时 pending、错误 WorkspaceEdit 分支 |

### P0：先保证文件内容不会丢、不会显示旧版本

1. 截断文档禁止覆盖保存，统一文件树/快速打开/跳转的大文件策略。
2. 所有关闭入口共用 dirty 决策，保存失败不得关闭；项目切换和正常退出也纳入。
3. 建立文件变化服务，连接磁盘监听、AI 编辑和 Git/revert；clean 刷新，dirty 进入明确冲突状态。
4. 保留文件身份归一，建立每文件保存顺序与版本检查；程序化更新与用户输入共享一致的状态事务。

验收：大文件尾部不被截断；任何批关都不能静默丢 draft；AI 改写/撤回后 clean 编辑器及时反映磁盘；dirty 文档和外部版本均保留；保存等待期间输入不回退。

### P1：接通已有后端，让日常编辑能力可见

| 工作包 | 实现范围 | 可观察的验收 |
|---|---|---|
| 源码与 Git diff | 差异文档类型、Monaco DiffHost、gutter 块预览、F7、冲突动作 | 点 Git 文件进入真实双版本比较；回滚块只改目标范围、Ctrl+Z 可恢复、保存后磁盘正确 |
| 补全与重构 | triggerKind、resolve 编辑、prepareRename、codeAction/resolve/executeCommand/applyEdit | 选自动导入项生成 import；重构目标完整、版本过期拒绝、未开文件进入可见 dirty 状态 |
| 引用预览 | 文档/模型解析服务，受控加载与释放 | peek 展示未打开目标源码；关闭预览后模型数量不持续增长 |
| 符号与编辑设置 | 共享版本化符号缓存、大纲、面包屑、编辑设置 schema 与持久化 | 光标与大纲同步；点击符号准确跳转；重启后字体/缩进/wrap 等保持 |

Git 与语言服务工作包可在 P0 文档边界明确后并行，避免各自实现一套保存/dirty 状态。

### P2：编辑组、工作区恢复和预览

建议引入以下职责划分；它是设计建议，不是当前已经存在的功能：

```text
Document：共享文件身份、模型、当前版本、保存基线、外部冲突
EditorGroup：独立 tabIds、activeTabId、视图状态
FocusedEditor：命令目标及当前选择/光标
WorkspaceSnapshot：可恢复布局和标签路径
DraftJournal：单独保存未落盘内容及其磁盘基线
```

先实现双栏，再扩展布局；同一文档可在两组显示，各组标签和滚动独立。关闭一个视图不等于销毁仍被另一组使用的文档。source/diff/preview 都应使用这套文档所有权：工作区修改侧共享实时文档，历史和暂存比较侧使用不可变快照模型。

标签恢复采用 Wuzu 的懒加载思路，未保存恢复另做 draft journal。Markdown/HTML 预览读取内存当前文本并同步滚动；HTML 资源访问和脚本隔离按 Aether 的协议设计。

### P2/P3：语言扩展和剩余编辑流程

先完善 TS/JS 的协议与故障处理，再引入 Vue 插件及准确路由，逐项验收模板诊断、跨 ts/vue 跳转、补全和重构。后续通用 LSP 应有 server registry、能力适配、工作区生命周期和服务状态，不能只增加安装包名。

位置导航历史、标签拖排/固定/临时预览、编码选择与保留源编码、自动保存策略可在上述状态模型稳定后补齐。扩展宿主、调试器、Notebook 属于更大的 IDE 平台能力，不在本次“参考 Wuzu 源码编辑器”中承诺自动获得。

## 10. 落地时的最小回归清单

本清单是后续实施验收要求，**本轮未执行**。交互、IPC、Monaco 改动须按仓库 AGENTS.md 完成 typecheck、build 和相应真机 E2E，E2E 单 worker。

| 场景 | 应验证的结果 |
|---|---|
| A 编辑未保存 → B → A；切设置/预览；打开/关闭分栏 | 文本、dirty、undo 与光标保持正确 |
| 两侧打开不同 dirty 文件 | Ctrl+S/Ctrl+W/格式化/块导航只作用于焦点组 |
| 保存 IPC 延迟期间继续输入；快速连续保存 | 新输入保留，最终基线和磁盘版本一致 |
| 本地 dirty + 外部/AI 改写同文件 | 不覆盖任一版本，有明确冲突决策 |
| AI 改写、撤回，Git 切换/回滚 | clean 已开源码和 diff 都更新，dirty 不被强制重载 |
| 单关、批关、快捷键、切项目、正常退出 | dirty 决策一致，取消/写盘失败保留内容 |
| 超过读取上限，通过树/Quick Open/跳转打开 | 各入口策略一致，不能把预览前缀写成全文 |
| UTF-8 BOM、UTF-16LE/BE、CRLF/LF | 明确编码/EOL行为；保留模式下磁盘往返正确 |
| Windows 大小写/斜杠/UNC 别名；快速开关文件 | 单一文档身份，无重复或幽灵标签 |
| 自动导入、跨文件 rename/refactor、引用 peek | 实际编辑正确；未开文件可见可保存；过期结果拒绝 |
| LSP 初始化中、运行中、关闭时退出/卡住 | 请求有界结束，状态可见，实际 fallback 功能能用 |
| draft 崩溃恢复；重启后磁盘也被外部修改 | 能取回未保存文本，并识别它与当前磁盘的冲突 |

这条整合路线能直接改善 Aether 现有界面的编辑体验，同时保留目前较好的命令、搜索、文档保护与 TS 服务基础。优先衡量的是文件正确性和完整工作流，而不是复制了多少 Wuzu 组件。
