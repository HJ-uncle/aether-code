# Aether

基于 Electron + React + TypeScript 的 AI 桌面工作台，AI agent 通过同级仓库的引擎接入。应用使用统一的默认界面，以会话为中心，在工作区承载文件、成果、浏览器、终端与子代理详情。

## 功能

**会话与协作**
- 会话历史、归档、流式输出、附件与补充消息
- 子代理状态与独立详情，成果预览、交付文件和变更回退
- Agent、模型、安全策略与会话工具包管理

**工作区**
- 文件树、资料与资源页签，Monaco 代码预览和图片、PDF、Office 文件预览
- 浏览器、Git 变更审阅、xterm + node-pty 终端和后台命令输出
- 命令面板（`Ctrl+Shift+P`）、键盘快捷方式和可调整分栏

**插件与服务**
- 自定义插件创建、导入、编辑、测试、发布及版本固定
- 已发布插件可声明导航、页面、工作区标签与服务；页面支持工具表单和自定义 HTML
- 服务托盘汇总运行状态与通知，支持右键菜单、终端跳转、停止和已读管理
- 插件页面跟随应用外观，通过受限桥调用声明的工具；服务生命周期见 [插件前端贡献协议](../ai-agent-engine/docs/plugin-ui-contributions.md)

**主题**
- 深色 / 浅色、多套强调色，两者正交；令牌集中在 `tokens.css`

## 架构

| 目录 | 职责 | 运行在 |
|---|---|---|
| `src/main/` | 主进程：文件服务、PTY 终端、git、搜索、引擎宿主 | Node |
| `src/preload/` | IPC 桥（`window.aether`） | 桥接层 |
| `src/renderer/src/` | 渲染进程：整个 IDE 界面 | Chromium |
| `src/shared/ipc.ts` | IPC 契约类型，主/渲染两侧共享 | 类型 |
| `e2e/` | Playwright 端到端测试 | Node |

渲染进程按 `app/`（应用装配）、`features/`（功能域）、`ui/`（共享控件）与 `core/`（平台和状态设施）分层。目录、插件挂载点与扩展约定见 [前端结构](docs/frontend-architecture.md)。

**AI agent 引擎在同级仓库 `../ai-agent-engine`**，IDE 通过 HTTP 与之通信（默认 `http://127.0.0.1:12323`）。
渲染层不直连引擎，一律经 `window.aether` 中转；内置与远端模式的 HTTP/SSE 都由主进程代理，统一处理凭据、实例身份和连接生命周期。

换目录布局前先看 [AGENTS.md](./AGENTS.md)。

## 快速开始

**前置**：Node.js（与 `electron-vite` 5 / Electron 39 兼容的版本），同级 `../ai-agent-engine` 源码及已安装的依赖。

```bash
npm install
npm run dev
```

`npm run dev` 会先将当前引擎源码构建到 `../ai-agent-engine/.tmp/aether-code-dev/` 下的新目录，核对源码构建标识，再启动开发客户端。无需另开服务或手动构建引擎；旧的共享 `dist/` 和已运行的引擎保持原状。编译失败或编译期间源码变化时会停止启动，避免客户端静默使用旧能力。

前端继续使用开发服务器的热更新。引擎在本次运行中固定使用启动时的快照，修改引擎源码后，等运行中的任务结束，再停止并重新执行 `npm run dev`；不会监视源码并自动终止任务。旧快照保留在上述目录，不会在另一个实例运行期间自动清理。

可以设置 `AETHER_ENGINE_SOURCE` 指定另一份引擎源码；显式设置 `AETHER_IDE_ENGINE_ENTRY` 则使用该入口并跳过构建。开发态显式入口优先于设置中已导入的引擎，安装版仍使用所选导入版本。`npm run dev -- --prepare-only` 只编译并核对引擎，不打开客户端。

需要同时运行多个独立客户端时，显式启动隔离实例。默认启动仍保持单实例；每个隔离实例拥有自己的设置、会话数据库、凭据和窗口状态，内置引擎会从首选端口开始自动递增并避开其他实例：

```powershell
# 每次创建一个新的随机实例
npx electron . --new-instance

# 创建可重复使用的命名实例（同名实例仍保持单实例）
npx electron . --aether-instance=work-2
```

打包版使用同样的参数，例如 `Aether.exe --new-instance`。关闭实例不会影响其他实例正在运行的引擎。

启动后：

1. 在工作台新建会话，使用输入区的工作区入口选择目录，或使用默认工作区
2. 在 IDE「设置 → 引擎」选择“本地内置”。IDE 自动启动本次开发命令准备的配套产物、分配可用端口和实例凭据；无需单独启动另一个引擎。引擎未就绪时，编辑、终端、搜索、git 等本地能力**不受影响**。
3. 引擎启动较慢，就绪后可正常对话

### 手动地址连接与实例凭据

已打包的 Windows x64 引擎也可以在客户端中导入：打开「设置 → 通用 → 本地内置」，在「本地引擎」点击「导入引擎…」，选择 `agent-engine-2.0.0-win32-x64.tgz`。客户端会解包、补齐 Node 和语言服务并校验原生依赖；成功后点击「使用此引擎并重启」。导入期间不停止当前引擎，切换时会中断正在运行的任务。

导入版本保存在当前用户数据目录的 `engine/runtimes/`，选择会跨应用重启保存。会话数据库、模型配置和凭据继续使用原目录。可点「恢复默认引擎」切回安装包内置版本（开发环境回到开发引擎）。这用于更新当前机器；向其他用户分发时仍使用下面的安装包打包流程。

“远端服务”支持普通聊天、工具审批应答、停止、会话与历史恢复、压缩、润色、后台任务与子代理停止，以及模型新增、更新、连接测试和能力检测。远端记录与任务执行均使用引擎侧数据，不会把远端路径解释成同名本地文件。

在「设置 → 引擎」填写远端地址、令牌和可选的「远端工作目录」，然后「保存并重启」。目录必须是引擎所在机器上的绝对路径，例如 `/srv/project` 或 `D:\\project`；留空使用服务端会话沙箱。目录设置重连后对新会话生效，已有会话继承服务端记录目录。远端已有模型自动加载；缺少模型时可从聊天提示进入模型管理填写服务商、模型 ID、地址及自己的 API Key。产品提供服务商地址和模型预设，不提供第三方模型密钥或额度。

完整远端文件系统尚未接入本地编辑器、诊断、Git 和 CodeGraph。远端附件上传 UI、删除会话/历史、截断式重试、消息回退、改动保留/撤回和安全模式写入仍未开放。普通远端聊天可使用；这些功能不应理解为已全部对齐。

手动连接未配置实例 token 的本机独立开发引擎，可填写 `http://127.0.0.1:12323`（也支持 localhost / ::1）；前端仍验证引擎协议和业务认证。引擎已设置 `AETHER_INSTANCE_TOKEN` 时，在「设置 → 引擎 → 远端令牌」填写相同的值，然后「保存并重启」。非回环地址始终需要显式配置该凭据。它是引擎实例凭据，与模型 API Key 不同。

令牌通过专用输入 IPC 交给主进程，使用 Electron safeStorage 加密写入独立凭据文件，不回传明文，也不进入普通设置或引擎快照。系统加密不可用时拒绝保存；留空保留原值，「清除令牌」在保存后生效。仍兼容启动环境变量 `AETHER_IDE_REMOTE_INSTANCE_TOKEN`，已保存令牌优先，清除后会回退到环境变量。令牌目前是全局连接凭据，更换服务地址时应同时替换或清除；加密文件依赖当前操作系统用户的密钥，跨用户/机器迁移需要重新输入。

### Agent 后台命令

模型可用 `execute_cmd` 的 `background: true` 启动后台命令，再用 `command_output` 读输出、`cancel_command` 停止。前端卡片持续显示状态、输出和退出码；根对话完成不代表命令完成。子代理启动的命令也可从当前会话查看和停止。刷新只恢复状态，重启引擎不会自动重跑。

后台默认超时 10 分钟，每个任务保存最近 256 KiB 输出，截断会明确显示。引擎最多保留 7 天、全局 500 个、每会话 100 个终态记录。取消等待当前可追踪命令树退出；命令自行脱离父进程或系统崩溃后的未知进程不在自动接管范围。

## 打包发行

```bash
npm run build:win      # Windows
npm run build:mac      # macOS
npm run build:linux    # Linux
```

Windows 客户端也可以直接使用引擎发布包（`.tgz`）。先设置 `AETHER_ENGINE_TGZ`，再执行同一个打包命令；staging 会解包引擎、补齐独立 Node 与 IDE 的 TypeScript Language Server，并把完整运行时放入安装包的 `resources/engine/win32-x64`：

```powershell
$env:AETHER_ENGINE_TGZ = 'D:\dev\ai-agent-engine\release\agent-engine-2.0.0-win32-x64.tgz'
$env:AETHER_NODE_BINARY = 'C:\Program Files\nodejs\node.exe'
npm run build:win
```

只准备并验证内置运行时时：

```powershell
npm run prepare:engine
npm run verify:engine
```

`.tgz` 本身不包含客户端需要的独立 `runtime/node.exe` 和 `typescript-language-server`，不能只复制 `dist/main.js`；上述 staging 步骤会一并补齐这些文件。

## 开发

```bash
npm run typecheck      # node + web 两段
npm run build          # typecheck + electron-vite build（产出 out/）
npm run lint           # eslint
npm run format         # prettier
```

### 测试

```bash
npm run test           # 别名，等于 test:e2e
npm run test:e2e       # 跑全部。⚠️ 会先自动执行一次 build
```

两个必须知道的前提：

1. **E2E 加载的是 `out/` 产物，不是源码。** 手动跑 `playwright test --config e2e/config/playwright.config.ts` 前一定要先 `npm run build`，
   否则会拿旧产物跑测试，用一份假通过掩盖真实失败。走 `npm run test:e2e` 时由 `pretest:e2e` 自动 build。
2. **不能并行。** 应用用了 `requestSingleInstanceLock`（第二个实例直接退出），
   多实例还会争抢引擎端口，因此 `workers: 1`、`fullyParallel: false`。不要改。

其它跑法：

```bash
npm run test:e2e:headed                       # 看着窗口跑，调试用
npm run test:e2e:ui                           # Playwright UI 模式
npx playwright test --config e2e/config/playwright.config.ts e2e/smoke.spec.ts # 单个文件（记得先 build）
npx playwright test --config e2e/config/playwright.config.ts -g "资源管理器" # 按用例名过滤
npm run test:e2e -- --repeat-each=3           # 查偶发失败
```

用例分布（改哪块跑哪个）、写用例约定、代码约定（样式令牌、Monaco/xterm 取色归一化）、
已知环境差异，全部见 [AGENTS.md](./AGENTS.md)。**动手改代码前请先读它。**

## 相关文档

- [AGENTS.md](./AGENTS.md) — 工程约定与验证要求
