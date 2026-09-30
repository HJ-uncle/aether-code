# Aether 原生编辑器增强与 VS Code 能力差距

更新日期：2026-09-30。保留这个文档路径，使已有链接继续有效。

产品方向是**保留 Aether 现有界面，把需要的 VS Code 编辑能力逐项接入现有编辑器**。Aether 的菜单、资源管理器、文件标签、搜索、Git、终端、AI 对话和设置继续由现有 Electron + React 工作台承载。

当前已移除 Aether / Code OSS 双模式、独立 Code OSS 服务、独立工作台页面及相关 IPC 接线。运行 Aether 不需要额外启动或安装 Code OSS。本文不再提供旧方案的启动、部署或打包建议；旧方案的测试结果不能作为当前实现的验收证据。

## 复用范围

Aether 已依赖 **Monaco Editor 0.56.0**。Monaco 本身来自 VS Code 的编辑器组件，查找替换、多光标、折叠、缩进、注释、行操作、括号匹配、内置命令和部分语言支持无需另写一套实现。

VS Code 的完整工作台能力并不包含在 Monaco 中。跨文件打开、工作区编辑、文件保存、编辑组、扩展宿主、调试和 Notebook 依赖上层宿主及服务。接入时先确认现有 Monaco 能力，再补 Aether 的命令、文件和语言服务桥接，不将“菜单出现”视为功能完成。

目前结构：

```text
Aether Electron + React 工作台
├─ 原有菜单、Explorer、标签、搜索、Git、终端、AI 面板
├─ Monaco：文本模型、编辑行为、菜单、查找替换、语言 provider
├─ Aether 编辑器状态：文件内容、未保存修改、保存、视图位置
└─ TypeScript LSP 桥
   └─ 主进程 typescript-language-server / tsserver：项目语义与诊断
```

语言服务独立于 AI 引擎启动；普通编辑和 TypeScript 项目能力不应要求连接模型。

## 保留的项目能力与修复

| 能力 | 当前实现与边界 | 主要位置 |
|---|---|---|
| 模型和编辑状态 | 按文件 URI 缓存 Monaco 模型，文件切换保留撤销历史及视图状态；文件内容和保存基线分离 | [monaco-setup.ts](../src/renderer/src/core/editor/monaco-setup.ts)、[editor-store.ts](../src/renderer/src/core/editor/editor-store.ts) |
| 文件身份 | Windows 盘符路径和 UNC 路径统一分隔符与大小写比较，文档、模型缓存和工作区桥共用同一身份；保留首次打开的路径显示，POSIX 路径保留大小写区别 | [file-identity.ts](../src/renderer/src/core/editor/file-identity.ts) |
| TypeScript / JavaScript 项目语义 | 使用工作区的 tsconfig / jsconfig 和 tsserver；保留 TSX / JSX、React 类型、相对导入、`paths` 路径映射及未保存内容同步 | [ts-client.ts](../src/renderer/src/core/lsp/ts-client.ts)、[server.ts](../src/main/lsp/server.ts) |
| 诊断来源 | 项目 TypeScript 服务运行时，不让缺少项目配置的单文件引擎 TypeScript 诊断覆盖它；保留独立 ESLint 等来源 | [diagnostic-policy.ts](../src/renderer/src/core/lsp/diagnostic-policy.ts)、[diagnostics.ts](../src/renderer/src/core/lsp/diagnostics.ts) |
| 原有语言 provider | 已接入 hover、定义、引用、重命名、签名提示、文档符号、高亮、补全及补全详情；跨文件操作仍需要宿主配合 | [ts-client.ts](../src/renderer/src/core/lsp/ts-client.ts) |
| 保存冲突保护 | 保存前比较磁盘内容与保存基线；磁盘已被其他编辑器或工具更改时，保留内存修改并拒绝静默覆盖 | [editor-store.ts](../src/renderer/src/core/editor/editor-store.ts) |
| 聊天文件跳转 | Windows / UNC / POSIX 路径、行列后缀、中文、空格、`%` 和 `#` 按原文件名解析；本地路径进入原生编辑器 | [chat-file-path.ts](../src/renderer/src/contrib/chat/chat-file-path.ts)、[open-file.ts](../src/renderer/src/contrib/chat/open-file.ts) |

远程 AI 引擎返回的路径属于远端文件系统，仍不能直接当成本机文件路径打开。当前文档也不承诺完整远程编辑。

## 本轮增强范围

以下是当前实现范围；本轮重新构建后的真实窗口验收结果与未覆盖项列在文末。

### 官方中文资源

[renderer 入口](../src/renderer/src/main.tsx) 最先导入当前 `monaco-editor` 自带的 `monaco-editor/nls/lang/zh-cn`。该资源设置 Monaco 的消息表和语言标识，必须早于编辑器模块求值：菜单、命令及部分控件文案会在模块注册时读取译文，创建编辑器后再设置语言已经太晚。

所有运行时 Monaco 直接导入经 `monaco-setup.ts` 或 `ts-client.ts` 进入应用依赖图，均在入口语言包之后执行。这里使用与安装版本一致的官方消息索引，不替换 DOM，也不维护手写的英文到中文映射。Monaco 的 UI 译文与 tsserver 诊断语言分别配置；加载 UI 语言包本身不意味着任意语言服务器返回的错误、文档或第三方内容都能翻译。

### Aether 命令接入 Monaco 原生操作

由 Aether 的中文命令与菜单调用当前活动 Monaco 编辑器的原生 action，继续使用 Monaco 对选区、撤销栈和编辑上下文的处理。[active-editor.ts](../src/renderer/src/core/editor/active-editor.ts) 保存最后聚焦且尚未销毁的文本编辑器，使 Aether 命令面板拿走 DOM 焦点后，操作仍能作用于原文件；执行前恢复编辑器焦点，没有编辑器或 provider 时给出中文提示。

[editor-commands.ts](../src/renderer/src/contrib/editor/editor-commands.ts) 集中注册格式化文档/选区、重命名、定义/引用/符号/行跳转、折叠、查找替换、多光标和注释等命令，并提供自动换行、小地图切换。定义和引用在 Monaco 0.56 中属于 Action2，通过公开的 `addAction` / `trigger` 桥接，并保留 provider 前置条件；没有假定所有原生命令都可经 `getAction()` 取得。

[命令贡献注册](../src/renderer/src/contrib/index.ts)与[MonacoEditor.tsx](../src/renderer/src/contrib/editor/MonacoEditor.tsx)分别承担命令注册和实例生命周期。文本编辑器聚焦时，`Ctrl+Shift+O` 保留给原生符号跳转，不再误开安全设置。验收需要实际触发操作，检查文本、选择或文件结果；中文命令可见只是其中一个条件。

[QuickOpen.tsx](../src/renderer/src/workbench/QuickOpen.tsx) 关闭时立即设置 `closedRef = true`，让键盘捕获监听立刻让出按键；退出动画仍可继续。此前快速打开后的 160ms 关闭过渡可能吞掉编辑器方向键，导致光标定位错误。语言操作回归现在直接在打开文件后用方向键定位并执行 F12 / F2，不靠额外等待绕开这个问题。

自动换行和小地图由 [editor-display-options.ts](../src/renderer/src/core/editor/editor-display-options.ts) 在当前 renderer / 应用会话内共享，使切换文件、重建编辑器实例乃至同会话切换工作区后仍沿用用户刚才的选择；不跨重启持久化。相应用例在另一文件实际观察排版和小地图，再切回确认，不能只检查同一实例的切换结果。

### TypeScript 跨文件操作和格式化

在现有[TypeScript LSP 桥](../src/renderer/src/core/lsp/ts-client.ts)上，通过 [monaco-workspace.ts](../src/renderer/src/core/editor/monaco-workspace.ts) 补齐本地文件宿主能力：

- 定义跳转通过公开的 `registerEditorOpener` 交给 `openWorkspaceResource`；涉及尚未打开的文件时，由 Aether 文件/标签机制打开并定位。
- 跨文件重命名通过 `ensureWorkspaceModel` 预先准备目标文档和模型，并同步后台模型与 Aether 文件状态；修改应进入脏标记和显式保存流程，保留已有未保存内容。Windows 文件 URI 与路径别名必须复用同一模型，避免重复创建或保存旧内容。
- 将 document formatting 和 range formatting 接到项目语言服务，保留格式化选项、取消信号及编辑范围；不能把 TypeScript 格式化覆盖范围扩大成所有语言。
- 在 LSP `initialize` 的 `initializationOptions` 中设置 `locale: 'zh-CN'`；安装的 `typescript-language-server` 会将该值传给 tsserver 的 `--locale`。诊断译文来自 TypeScript 自带资源，与入口加载的 Monaco UI 语言包是两条链路。类型名、用户代码、项目文档和第三方 formatter / linter 内容不会因此自动翻译。

文件身份统一修复了 Windows 下 F12 与快速打开重复创建模型的问题：语言服务器返回的小写盘符路径和资源管理器保留的原大小写路径必须命中同一个文档和 Monaco 模型。验收从 F12 打开定义开始，先在该文件留下未保存内容，再经 Quick Open 打开同名文件，确认仍是单标签且修改保留；随后参与跨文件重命名与显式保存。这里只归一化用于比较的身份，不重写用户看到的 `doc.path`。

项目 TS provider 对本地文件使用独占 selector，避免内置 Monaco TypeScript provider 与项目服务同时返回结果；断开项目服务后恢复原有内置配置。未由项目桥替代的能力继续保留，不把所有内置语言模式一律关闭。

**引用速览仍有缺口：** reference provider 可以返回引用位置，但 Monaco 的 peek preview 还需要文本模型解析服务。仅注册编辑器 opener 不会补齐这条链路，因此尚未打开文件的引用预览、完整引用浏览体验仍未完成，不能把“转到引用”命令存在描述成等价于 VS Code 的 References 工作流。

这些功能需以真实项目中的跨文件修改、保存和撤销结果验收；provider 已注册并不能证明完整工作区操作已正确完成。最终验证章节单独列出实际覆盖范围。

## 与 VS Code 的实际差距

对照源码为同级 `vscode` 仓库，当前版本 **1.135.0**。它仅用于确认上游分层和行为，不是 Aether 运行时依赖。

| 领域 | 现有基础 / 本轮范围 | 尚未完成或不能据此承诺的部分 |
|---|---|---|
| 文本编辑 | 复用 Monaco 编辑能力、官方中文资源；Aether 命令接入原生操作 | 未逐项覆盖 VS Code 的所有编辑命令、设置与上下文行为 |
| 语言服务 | TypeScript / JavaScript 项目服务、TSX / JSX、跨文件操作和格式化接入 | 未打开文件的引用 peek preview 模型解析仍不完整；其他语言服务器、完整重构 / code action 集、自动导入与复杂工作区编辑需要分别接入和验收 |
| 编辑布局 | Aether 现有文件标签与预览 | 独立编辑组、分屏、跨组拖动、每组活动文档和焦点路由尚未形成完整实现 |
| 文件系统 | 本地文件读写、监视、搜索与保存冲突保护 | VS Code 的虚拟文件系统、远程工作区、完整多根工作区语义和通用文件操作参与者 |
| Git / SCM | Aether 自有 Git 状态、历史、暂存、提交等界面 | 通用 SCM 扩展 API 与其他 SCM provider；不能将现有 Git 功能描述成只读，也不能视为全部上游能力 |
| 终端 / 任务 | Aether 自有 xterm / node-pty 终端 | VS Code 的任务系统、完整 Shell Integration、任务与调试联动仍需独立工程工作 |
| 调试 | 当前编辑器可作为以后断点和源码定位的基础 | 通用调试工作台、DAP 适配器生命周期、调用栈、变量、监视和调试控制尚未补齐 |
| 扩展 | Aether 内部贡献模块和命令注册机制 | 没有 VS Code 通用扩展宿主、扩展 API、激活与生命周期管理；安装某个 VSIX 不能自然获得兼容性 |
| Notebook / 自定义编辑器 | 现有文本编辑与文件预览 | Notebook 文档模型、cell、kernel、renderer、输出持久化及 webview/custom-editor API 尚未完成 |
| AI | Aether 自有对话、引擎、工具、安全策略和会话 | 不自动包含 Copilot、VS Code Chat API 或其他专有服务 |

源码依据：[编辑组服务契约](../../vscode/src/vs/workbench/services/editor/common/editorGroupsService.ts)、[编辑器服务](../../vscode/src/vs/workbench/services/editor/browser/editorService.ts)、[调试服务](../../vscode/src/vs/workbench/contrib/debug/browser/debugService.ts)、[扩展服务](../../vscode/src/vs/workbench/services/extensions/browser/extensionService.ts)、[Notebook 服务](../../vscode/src/vs/workbench/contrib/notebook/browser/services/notebookServiceImpl.ts)。这些上层服务说明对应功能不是增加一个 Monaco 配置项即可得到。

后续优先补使用中能明确验收的原生编辑能力。独立编辑组需要先建立编辑组状态和活动编辑器路由；调试、扩展宿主、Notebook 则按独立子系统设计，不混入简单的编辑器命令接线。

## 本轮验证结果

`npm run build` 成功，包含 Node + Web 两段完整 typecheck 和 Electron / renderer 构建。随后针对最终 `out/` 产物串行运行 **35 条真机用例：35 passed / 0 failed / 0 skipped，耗时 35.3 秒**。另有 **15 条纯函数用例全部通过**，合计 **50 条定向测试通过**。这是本次编辑器改动的定向验收，不是项目全量测试或全部 VS Code 功能的覆盖结论。

| 用例 | 结果 | 实际覆盖的行为 |
|---|---|---|
| [monaco-localization.spec.ts](../e2e/monaco-localization.spec.ts) | 3 条真机通过 | 保留单窗口原生界面、首次中文菜单和命令面板、中文查找替换落盘、外部修改时保留未保存内容并拒绝覆盖 |
| [editor-commands.spec.ts](../e2e/editor-commands.spec.ts) | 8 条真机通过 | 命令面板焦点恢复、替换/JSON 格式化落盘、跳行、自动换行/小地图及其跨标签保持、符号快捷键与不可用操作反馈 |
| [editor-language-actions.spec.ts](../e2e/editor-language-actions.spec.ts) | 3 条真机通过 | F12 定位后留下脏内容，Quick Open 复用单标签并保留修改；F2 修改当前/后台脏/未打开文件且仅显式保存后写盘；TypeScript 文档格式化 |
| [editor-project-language.spec.ts](../e2e/editor-project-language.spec.ts) | 2 条真机通过 | TSX / JSX、React 类型、导入和 `paths`；真实错误出现，并在未保存修正后消失 |
| [lsp-diagnostics.spec.ts](../e2e/lsp-diagnostics.spec.ts) | 4 条真机通过 | 引擎与问题面板的现有诊断链路及文件定位 |
| [smoke.spec.ts](../e2e/smoke.spec.ts) | 选定 15 条真机通过 | 工作台骨架、编辑器、命令面板、快速打开、全局替换等相关回归；未运行此 spec 的全部用例 |
| [editor-file-identity.spec.ts](../e2e/editor-file-identity.spec.ts) | 4 条纯函数通过 | Windows 盘符/目录大小写、混合分隔符、UNC 别名统一，以及 POSIX 大小写区别 |
| [editor-diagnostic-policy.spec.ts](../e2e/editor-diagnostic-policy.spec.ts) | 2 条纯函数通过 | 项目 TypeScript 诊断优先级与独立 linter 来源保留 |
| [chat-file-path.spec.ts](../e2e/chat-file-path.spec.ts) | 9 条纯函数通过 | 路径、行列后缀、特殊字符和无效路径解析 |

本轮实际执行命令：

```powershell
npm run build
npx playwright test e2e/editor-file-identity.spec.ts e2e/chat-file-path.spec.ts e2e/editor-diagnostic-policy.spec.ts --reporter=list
npx playwright test e2e/editor-language-actions.spec.ts e2e/editor-commands.spec.ts e2e/monaco-localization.spec.ts e2e/editor-project-language.spec.ts e2e/lsp-diagnostics.spec.ts e2e/smoke.spec.ts --grep 'editor-commands|editor-language-actions|editor-project-language|lsp-diagnostics|monaco-localization|工作台骨架|编辑器|命令面板|快速打开|全局替换'
```

中文菜单用例保持真实鼠标点击路径，使用 `click({ delay: 150 })` 覆盖 Monaco 自带的 100ms 菜单 mouseup 防误触窗口；之后验证原生命令面板真正打开。查找替换、格式化、跨文件重命名均检查磁盘结果或显式保存前磁盘尚未变化，没有仅以控件可见代替成功。

引用速览、完整跨文件撤销、TypeScript 选区格式化及未列出的语言操作仍未由本轮验收覆盖，不能由文档格式化或 F12 用例替代。独立编辑组、DAP 调试、扩展宿主、Notebook 等缺口仍如上文所列。

验证遵循 [AGENTS.md](../AGENTS.md)：构建包含完整类型检查，E2E 使用新产物和单 worker，避免单实例锁与端口互相干扰。本节仅记录保留 Aether 原生界面后的最终实现，不沿用已删除 Code OSS 方案的测试结果。
