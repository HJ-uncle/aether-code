# Aether IDE

AI 原生的桌面 IDE。**编辑器、终端、版本控制、全局搜索都在本地**，AI agent 通过同级仓库的引擎接入。

基于 Electron + React + TypeScript 构建，界面与交互对齐 VS Code 的使用习惯。

> 截图占位：`docs/screenshot-main.png`（主界面：资源管理器 + 编辑器 + 终端 + 右侧对话面板）

## 功能

**工作台**
- 活动栏 + 侧边栏 + 编辑器组 + 底部面板 + 右侧对话面板，布局可切换、可持久化
- 命令面板（`Ctrl+Shift+P`）与快速打开（`Ctrl+P`），支持模糊匹配
- 键盘快捷方式可视化查看与自定义，命令统一走命令注册表，支持 `when` 条件

**编辑器**
- 基于 Monaco，内置 JS/TS/CSS/HTML/JSON 等语言 worker，含补全与语法高亮
- 多标签：关闭 / 关闭其他 / 关闭右侧 / 全部关闭 / 重开已关闭（`Ctrl+Shift+T`）
- 全部保存（`Ctrl+Shift+S`）、光标与滚动位置跨标签恢复、最近文件
- 二进制与图片预览（`FilePreview`）

**资源管理器**
- 新建 / 重命名 / 删除（回收站）/ 剪切 / 复制 / 粘贴，支持多选
- 文件操作可撤销；`files.exclude` 与 `search.exclude` 遵循 VS Code 语义
- 目录折叠链合并、虚拟滚动

**搜索**
- 全局搜索（仓库内优先走 `git grep`，非仓库退回文件遍历）
- 批量替换，执行前提供 before → after 预览

**版本控制**
- 内嵌只读 git：状态与提交历史，不改动仓库

**终端**
- 基于 xterm + node-pty，真实 PTY，支持多标签
- 主题跟随 IDE 配色（Monaco 与 xterm 取色经同一套归一化）

**AI Agent**
- 右侧对话面板，流式输出、思考模式、工具调用卡片、子任务卡片
- 会话历史持久化，支持跨重启回放
- 附件、模型管理（多模型切换）、安全策略模式

**LSP 诊断**
- 诊断结果汇入底部「问题」面板，可跳转到对应位置

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

渲染进程内部按 `core/`（无 UI 的状态与逻辑）、`workbench/`（布局骨架）、`contrib/`（各个功能视图）分层。

**AI agent 引擎在同级仓库 `../ai-agent-engine`**，IDE 通过 HTTP 与之通信（默认 `http://127.0.0.1:12323`）。
渲染层不直连引擎，一律经 `window.aether` 中转（引擎未开 CORS，且便于日后切远程模式）。

换目录布局前先看 [AGENTS.md](./AGENTS.md)。

## 快速开始

**前置**：Node.js（与 `electron-vite` 5 / Electron 39 兼容的版本）。

```bash
npm install
npm run dev
```

启动后：

1. 用命令面板（`Ctrl+Shift+P`）的「打开文件夹」选一个目录
2. 引擎需另行准备（同级仓库 `../ai-agent-engine`）；未启动时 IDE 的编辑、终端、搜索、git 等本地能力**不受影响**，仅 AI 对话不可用
3. 引擎启动较慢，就绪后可正常对话

## 打包发行

```bash
npm run build:win      # Windows
npm run build:mac      # macOS
npm run build:linux    # Linux
```

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

1. **E2E 加载的是 `out/` 产物，不是源码。** 手动跑 `playwright test` 前一定要先 `npm run build`，
   否则会拿旧产物跑测试，用一份假通过掩盖真实失败。走 `npm run test:e2e` 时由 `pretest:e2e` 自动 build。
2. **不能并行。** 应用用了 `requestSingleInstanceLock`（第二个实例直接退出），
   多实例还会争抢引擎端口，因此 `workers: 1`、`fullyParallel: false`。不要改。

其它跑法：

```bash
npm run test:e2e:headed                       # 看着窗口跑，调试用
npm run test:e2e:ui                           # Playwright UI 模式
npx playwright test e2e/smoke.spec.ts         # 单个文件（记得先 build）
npx playwright test -g "资源管理器"            # 按用例名过滤
npm run test:e2e -- --repeat-each=3           # 查偶发失败
```

用例分布（改哪块跑哪个）、写用例约定、代码约定（样式令牌、Monaco/xterm 取色归一化）、
已知环境差异，全部见 [AGENTS.md](./AGENTS.md)。**动手改代码前请先读它。**

## 相关文档

- [AGENTS.md](./AGENTS.md) — 工程约定与验证要求
- [.trae/documents/p2-terminal-lsp.md](./.trae/documents/p2-terminal-lsp.md) — 本地终端 + LSP 诊断
- [.trae/documents/p3-codegraph.md](./.trae/documents/p3-codegraph.md) — codegraph 代码图接入
- [.trae/documents/p4-editor-tabs.md](./.trae/documents/p4-editor-tabs.md) — 编辑器标签能力
