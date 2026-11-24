# Aether

基于 Electron、React 与 TypeScript 的 AI 桌面工作台，以会话为中心组织需求、Agent 协作、工作区、交付成果、浏览器、终端与 Git。AI 运行时位于同级仓库 `../ai-agent-engine`，前端使用统一的默认界面。

## 文档入口

| 需要了解什么 | 文档 |
| --- | --- |
| 第一次使用、会话、补充、队列、工作区、回退、子代理、自动化与设置 | [使用指南](docs/user-guide.md) |
| 登录、新建账号、恢复凭据、第三方绑定、过期与退出 | [账号与登录](docs/accounts-and-login.md) |
| 当前功能 → 源码 → 文档覆盖，以及尚未开放的能力 | [功能覆盖表](docs/feature-map.md) |
| 页面、进程、IPC、数据身份与插件挂载 | [前端结构](docs/frontend-architecture.md) |
| Agent、工具配置、技能、MCP、知识库、记忆与权限 | [工具配置与资源](docs/tool-profiles.md) |
| 浏览器操作、AI 归属、停止与故障恢复 | [浏览器工作流](docs/browser-workflow-reliability.md) |
| 默认只读预览、Office 限制与编辑器基础设施 | [编辑器与预览边界](docs/editor-code-oss.md) |
| 插件公开能力与例子 | [插件 HTML 参考](docs/plugin-api/content/overview.html) |
| 开发约定、测试和临时文件管理 | [AGENTS.md](AGENTS.md) |

## 当前功能

- 会话：流式输出、附件与引用、即时补充、持久下一轮队列、历史、归档、状态标记、复制／导出及回退。
- 协作：Agent 与模型配置，调研／执行／通用子代理，运行中补充、停止和已有上下文续跑。
- 工作区：默认或指定任务目录、项目分组、资料与资源页签、成果及文件变化审阅、本地／远端会话文件操作。
- 阅读与执行：只读代码／文本、图片、视频、PDF／Office 预览，浏览器、搜索、Git、本地或远端终端和后台命令。
- 资源与调度：记忆、技能、MCP、知识库、代码图、自动化计划与运行历史。
- 管理与扩展：个人账号、服务连接、手动诊断采样、插件开发／授权／发布、全局通知与会话服务。
- 外观：深色／浅色、强调色、可调整分栏、命令面板与键盘设置。

默认文件页为只读预览。仓库保留的 Monaco 编辑存储、保存命令及语言服务代码，不代表默认界面已经提供完整可写 IDE；PDF 和 Office 预览也不等于原应用编辑或无损排版。

主导航为工作台、项目、Agent、插件、自动化和引擎监控。协议中的 `work`／`code` 或自动化工具配置文案不代表两套前端界面。功能边界与可达入口见功能覆盖表。

## 架构

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 引擎宿主与连接、账号、文件、浏览器、PTY、Git、搜索和系统能力 |
| `src/preload/` | `window.aether` 具名 IPC 桥 |
| `src/shared/` | 进程间契约、领域数据与身份类型 |
| `src/renderer/src/app/` | 应用壳、导航、页面装配与内置命令 |
| `src/renderer/src/features/` | 26 个功能域 |
| `src/renderer/src/core/` | 引擎客户端、文件目标、状态、主题及共享基础设施 |
| `src/renderer/src/ui/` | 共享控件、菜单、弹窗、布局 |
| `e2e/`、`e2e/config/` | 测试源码与集中配置 |

内置与远端服务的 HTTP／SSE 均由主进程代理，统一处理凭据、实例身份和连接生命周期。渲染层不直连引擎。会话文件操作按来源、账号、会话及工作区绑定路由，不把远端路径解释成同名本地文件。

## 开发启动

前置：兼容当前 Electron 39／electron-vite 5 的 Node.js、同级 `../ai-agent-engine` 源码及其已安装依赖。

```bash
npm install
npm run dev
```

`npm run dev` 调用 [scripts/dev.mjs](scripts/dev.mjs)，把当前引擎源码构建到 `../ai-agent-engine/.tmp/aether-code-dev/` 下的新目录，验证构建标识后启动客户端。不会覆盖同级引擎的共享 `dist/` 或重启已有引擎；编译失败或编译期间源码变化会停止启动。

前端使用开发热更新；引擎在本次运行中固定使用启动时快照。修改引擎后，等任务结束，再停止并重新运行开发命令。快照不会在其他实例运行时自动清理。

| 选项 | 用途 |
| --- | --- |
| `AETHER_ENGINE_SOURCE` | 指定另一份引擎源码 |
| `AETHER_IDE_ENGINE_ENTRY` | 显式入口，跳过源码构建；入口需有有效构建清单 |
| `npm run dev -- --prepare-only` | 只准备并核对引擎，不打开客户端 |

开发时显式入口优先于已导入引擎；安装版使用所选运行时。默认内置模式自动启动引擎，首选端口为 12323，实际端口以连接状态为准。

### 独立实例

默认启动保持单实例。需要独立的设置、凭据和内置引擎数据时，可显式创建隔离 profile：

```powershell
npx electron . --new-instance
npx electron . --aether-instance=work-2
```

命名实例可重复使用，同名仍保持单实例；打包应用接受相同参数。内置实例独立分配端口。连接同一远端服务时，数据仍由远端账号与租户决定，不能仅靠本地 profile 名称推断远端数据隔离。

## 首次配置与远端服务

启动后打开「设置 → 引擎管理」选择引擎；需要登录时进入「设置 → 个人账号」，模型供应商的密钥填在「设置 → 模型」。桌面不提供第三方模型密钥或额度。

本地内置支持启动、停止、重启、导入并选择 Windows 引擎包及恢复默认运行时。导入不停止当前引擎；选择新版本并重启会影响正在运行的任务。导入版本保存在当前用户数据目录的 `engine/runtimes/`，业务数据继续使用当前实例目录。

连接已有服务时，在「引擎管理 → 连接其他引擎」填写地址，在高级设置中按需填写该服务的实例令牌，再点「应用并连接」。如果管理员提供了服务 API Key 或 JWT，请在「个人账号 → 高级认证 → 服务访问凭据」核对当前服务后填写，点「应用凭据」。选择工作区在新建任务时进行；已有会话沿用其工作区。

远端会话已接入附件上传、历史操作、会话工作区文件、搜索、成果与变更审阅，以及对应的 Git／终端链路。能力仍受引擎版本与权限约束；本机系统打开方式、本地 HTML 预览和本机语言服务不会因此自动作用于远端磁盘。请以具体能力状态为准，不沿用早期“远端仅支持聊天”的限制清单。

## 本地使用 Python、Node.js 和 Git

Windows x64 完整安装包自带 Python、Node.js、npm、npx 和 Git。在 Aether 的本地终端可直接运行 `python hello.py` 或 `node hello.js`；标准库脚本不需要联网，也不用把解释器加进系统 PATH。需要 Python 依赖时，建议装到项目自己的环境里：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

本地终端和本机引擎启动的项目命令优先使用已激活的虚拟环境，以及 PATH 上已有的安装或版本管理器。仅打开含 `.venv` 或版本声明的项目不会自动执行其中的程序或下载新版本。引擎本身仍由配套的 Node 启动。远端引擎、容器和要求 Bash 的脚本需在各自的执行环境准备相应工具；离线安装第三方包也需要先备好依赖。

Git 面板、本地终端和本机引擎也可以使用安装包里的 Git。已在 PATH 选定 Git 时，优先使用该版本；没有可用的本机 Git 时，回退到随包的 MinGit。可离线建仓、查看差异、暂存和提交；访问远端时仍使用自己的账号或 SSH 密钥。Aether 不会修改系统 PATH。

## 插件文档

公开 API 唯一内容源是 `docs/plugin-api/content/*.html`，导航是 `docs/plugin-api/pages.mjs`。插件可贡献页面、导航、工作区、服务、命令、菜单、视图、状态栏、设置等；支持范围、权限和限制以 HTML 参考为准。

```bash
npm run docs:dev
npm run docs:check
npm run docs:build
npm run docs:test
```

构建后可离线打开 `docs/plugin-api/dist/index.html`，不要手改生成产物。修改受监控实现后先人工审阅文档与实际行为，再运行 `npm run docs:review`；不能以自动更新快照代替审阅。详见[维护说明](docs/plugin-api/maintenance.html)。

## 构建与测试

```bash
npm run typecheck
npm run build
npm run lint
npm run test:e2e
```

`build` 依次执行插件文档检查、HTML 构建、Node／Web 类型检查和 electron-vite 构建，产物在 `out/`。`test:e2e` 通过 `pretest:e2e` 先构建，再运行 `e2e/config/playwright.config.ts`。

手动筛选测试时必须先构建，真实 Electron 用例读取 `out/`，不会自动使用最新源码：

```bash
npx playwright test --config e2e/config/playwright.config.ts e2e/account-simplify-ui.spec.ts
npx playwright test --config e2e/config/playwright.config.ts -g "资源管理器"
```

真实窗口测试串行运行，使用隔离 profile、端口和引擎数据，不连接用户生产数据。测试报告、日志、截图、夹具和一次性脚本统一放入已忽略的 `.e2e-tmp/<任务名>/`；不要放在根目录。测试总数随代码变化，应以当前 `--list` 和实际结果为准，不把历史通过数字当作当前基线。

## Windows 打包

```bash
npm run build:win
npm run build:unpack
```

Windows 打包会构建桌面端，把配对引擎和本机工具一起放进安装包。默认读取已构建的同级引擎，也可用 `AETHER_ENGINE_TGZ` 指向 Windows x64 引擎发布包。Node（含匹配的 npm/npx）取自 Node.js 官方 Windows 发行包，CPython 取自 Astral 的 python-build-standalone，MinGit 取自 Git for Windows 官方 Windows x64 发行包；精确版本、上游地址和 SHA-256 均在 [运行时锁文件](scripts/windows-toolchains.lock.json)。

首次 `npm run prepare:engine` 会在构建机下载并校验这些归档，后续构建可复用 `.e2e-tmp/toolchains/downloads/`。离线构建可将 `AETHER_NODE_ARCHIVE`、`AETHER_PYTHON_ARCHIVE` 和 `AETHER_GIT_ARCHIVE` 分别指向与锁文件一致的本地归档。安装后使用这些工具不需要再次下载。

`npm run verify:toolchains` 验证已准备的 Python、venv、pip、Node、npm、npx 和 Git；也可运行 `node scripts/verify-windows-toolchains.mjs <解包应用的resources目录>` 检查实际发行产物。`npm run verify:engine` 单独检查引擎原生依赖与语言服务。

要验证实际 Windows 发行包，可让端到端用例直接启动解包后的程序。用例覆盖没有系统工具和已选项目工具两种环境，检查本地终端、Git 仓库操作和离线 MCP 服务。

```powershell
$env:AETHER_E2E_PACKAGED_EXE = (Resolve-Path '.\dist\win-unpacked\aether-code.exe').Path
npx --no-install playwright test --config e2e/config/playwright.config.ts e2e/windows-bundled-toolchains.spec.ts --output .e2e-tmp/windows-toolchain-qa/e2e
```

仓库也有 `build:mac` 与 `build:linux`，当前脚本直接运行 electron-vite 和 electron-builder，不包含与 Windows 相同的完整文档／类型校验及引擎 staging 流程。脚本存在不等于对应平台发行链已通过验收。

开发前阅读 [AGENTS.md](AGENTS.md)。当前说明依据 2026-11-17 源码核对；历史调查和验证报告用于追溯，不覆盖现行指南。
