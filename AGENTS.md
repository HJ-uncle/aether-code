# AGENTS.md

给 AI agent 与协作者的工程约定。**读完这一页再动手改代码。**

---

## 项目速览

Aether：Electron + React + TypeScript 的桌面 IDE。

| 目录 | 职责 | 运行在 |
|---|---|---|
| `src/main/` | 主进程：文件服务、PTY 终端、git、搜索、引擎宿主 | Node |
| `src/preload/` | IPC 桥（`window.aether`） | 桥接层 |
| `src/renderer/src/` | 渲染进程：整个 IDE 界面 | Chromium |
| `src/shared/ipc.ts` | IPC 契约类型，主/渲染两侧共享 | 类型 |
| `e2e/` | Playwright 测试 | Node |

引擎（AI agent runtime）在**同级仓库** `../ai-agent-engine`，通过 HTTP 通信。

---

## 改完代码必须验证

```bash
npm run typecheck      # 必跑。node + web 两段
npm run build          # typecheck + electron-vite build

npm run test:e2e       # 端到端。⚠️ 会先自动执行一次 build
```

### 什么时候**必须**跑 E2E

不是每次都跑（真机用例慢，全套 180s 级超时），但下面这些改动**不能只靠 typecheck**：

- 改渲染进程的**交互逻辑**（点击、键盘、拖拽、多选、快捷键）
- 改**主进程 ↔ 渲染进程的 IPC**（新增/修改 channel 或数据结构）
- 改 **Monaco / xterm / 终端 PTY** 相关
- 改**引擎通信**（`core/engine/`、`src/main/engine/`）
- 修**只在真机上才复现的 bug**（渲染进程报错不进主进程日志）

原因：typecheck 只能证明类型对。渲染进程的运行时报错、Monaco worker/CSP 问题、
IPC 数据形状不匹配，**只有真实窗口里才暴露**。

### 为什么必须先 build

E2E 加载的是 `out/` 产物，不是源码。**忘了 build 就会拿旧产物跑测试，
用一份通不过来掩盖真实失败。** `test:e2e` 已挂 `pretest:e2e` 自动 build，
但手动跑 `playwright test` 时要自己先 build。

### 其它跑法

```bash
npm run test:e2e:headed                       # 看着窗口跑，调试用
npm run test:e2e:ui                           # Playwright UI 模式
npx playwright test e2e/smoke.spec.ts         # 单个文件（记得先 build）
npx playwright test -g "资源管理器"            # 按用例名过滤
npm run test:e2e -- --repeat-each=3           # 查偶发失败
```

E2E 强制 `workers: 1`：应用用了 `requestSingleInstanceLock`（第二个实例直接退出），
且多实例会争抢引擎端口。**不要试图并行化。**

### 当前基线

**全量 103 条用例，应为 102 passed / 0 failed / 1 skipped。** 若有红，先假定是自己改坏了。
（数字会随用例增删变动。核对方式：`npx playwright test --list` 看 Total，
或挑纯函数 spec 跑一遍——它们不依赖真机，秒级完成。）

唯一的 skip 是「内置终端多标签」：沙箱/CI 里 spawn 控制台进程被拒，
`node-pty` 报 `Cannot launch conpty`，pty 会话根本建不出来。属于**环境能力缺失**，
不是代码缺陷。终端相关用例已按此改造——探测到失败态就断言「失败被如实告知」或跳过，
不会留一条误导性的红。

### 失败时看 AGENT-SUMMARY

配置里挂了 `e2e/reporters/agent-diagnostics.ts`。它只在**有失败时**输出，
每轮结尾给出固定字段的块，字段名稳定、可直接 grep：

```
FAILURE #1
  title:    <用例名>
  file:     <相对路径>:<行号>
  status:   failed
  repro:    npx playwright test <file> -g "<用例名>" --reporter=list   ← 直接复跑这一条
  errors:   <截断后的断言差异>
  app-errors:  渲染进程/主进程侧报错（断言之外的独立信号，重复会折叠成 ×N）
  trace:    npx playwright show-trace ...
```

读法：**先看 `app-errors`**。有内容说明是应用真的报错了；为空、且 `errors:` 只与
选择器/文本有关，多半是 UI 结构变了而用例没跟上——这时**先确认实现侧意图，再改用例**，
不要为了让测试变绿而改产品。跳过的用例单列在 `ENV-CAPABILITY-SKIPS` 一节。

---

## E2E 用例分布

改哪块，就优先跑对应的 spec：

| 文件 | 覆盖 | 需要真机 |
|---|---|---|
| `e2e/smoke.spec.ts` | 骨架、资源管理器、编辑器、终端、搜索、命令面板、键位、预览 | 是 |
| `e2e/lsp-diagnostics.spec.ts` | 引擎就绪、LSP 诊断 → 问题面板 → 跳转 | 是 |
| `e2e/history-replay.spec.ts` | 跨重启的历史回放、清空历史 | 是（含重启） |
| `e2e/pending-interactions.spec.ts` | 交互帧归一化：`normalizePending` / `mergePending` / `buildToolResponse` | 否 |
| `e2e/security-client.spec.ts` | 安全模式校验与请求体构造 | 否 |
| `e2e/pure-functions.spec.ts` | 二进制预览、git 展示格式化 | 否 |
| `e2e/git-parsers.spec.ts` | `git status` / `git log` 输出解析 | 否 |

标"否"的是**纯函数测试**——目标模块只 `import type` 或不碰 `window.aether`，
因此由 Playwright 的 TS 加载器直接执行，秒级完成。**新增纯逻辑优先写成这类，
比真机用例快一个数量级。**

### 写用例的约定

- **断言要能失败**。不要写 `expect(x).toBeTruthy()` 这种永远通过的断言。
- **优先断言副作用**，而不是界面表象。例：拖拽后 `existsSync` 检查文件真的搬到了磁盘，
  搜索替换后 `readFileSync` 检查内容真的变了。
- **共享窗口，注意顺序污染**。真机 spec 用 `beforeAll` 起一个应用、多个用例共用。
  展开/收起目录要写成**幂等**（先读 `aria-expanded` 再决定点不点），
  虚拟滚动下先归零 `scrollTop`。
- **异步落盘要 `expect.poll`**。连续多次 IPC 写盘之间有间隙，同步断言会误报。
- **每个 spec 顶部写清覆盖范围**，方便定位。
- **夹具放 `.e2e-tmp/`**（已 gitignore），用完删掉，别污染仓库。
- **依赖环境能力的用例要探测，不要硬断言**。例：终端需要能 spawn pty，
  沙箱里会失败。先 `Promise.race` 探测能力，能跑就验交互，不能跑就断言
  「失败被如实告知」或 `test.skip`，别留一条与代码无关的红。
- **等就绪信号，不要盲等固定时长**。例：`Ctrl+P` 的首帧可能早于文件索引构建完，
  此时面板显示「没有匹配的文件。」。应先断言目标条目出现，再回车。

---

## 代码约定

### 样式：令牌，不是色值

`src/renderer/src/assets/tokens.css` 是**唯一事实来源**。
`components.css` / `app.css` **禁止写死颜色**，一律 `var(--token)`。

新增颜色 → 先在 tokens.css 定义（深色 + 浅色两块都要），再引用。

> 已踩过的坑：`var(--bg-selected)` 与 `var(--bg)` 引用了一个**从未定义**的令牌，
> CSS 变量未定义时整条声明静默失效（选中高亮变成透明），typecheck 与 build 都不报错。
> **改完 CSS 后，若不放心可用脚本核对：全项目 `var(--*)` 引用是否都有定义。**

主题通过 `<html>` 上的 `data-appearance`（dark/light）与 `data-accent` 驱动，两者正交。
`core/theme/palette.ts` 的 `watchTheme()` 是唯一接入点。

### Monaco / xterm 取色必须归一化

Monaco 与 xterm **不吃 CSS 级联**，必须用 JS 从 computed style 读色。
关键坑：**Monaco 的 `Color.fromHex` 解析失败会静默回退成纯红色**
（`parseHex(hex) || Color.red`），而 tokens 里很多值是 `rgba()` 字符串。

一律走 `core/theme/palette.ts`：

- `cssVar(name)` — 读原始值
- `cssColor(name)` — **归一化成 `#RRGGBBAA`**，喂 Monaco 必须用这个

不要在 `editor-theme.ts` / `terminal-theme.ts` 里直接用 `cssVar()` 取颜色。

### 其它

- 注释写**为什么**，不写"做了什么"。现有代码注释密度较高，保持一致。
- 不要为了让 typecheck 过而 `as any` 或 `@ts-ignore`。
- 修 bug 时**先读代码再改**，不要基于猜测改。本项目历史上有过连续三次误判根因的教训。

---

## 已知环境差异

- **沙箱内 pty 不可用**：`node-pty` 报 `Cannot launch conpty`，终端相关用例会走
  失败分支或 skip（见上文「当前基线」）。真机（非沙箱）上应能正常起 shell。
- 终端里 PowerShell 冷启动可能较慢，xterm 相关断言时限已放宽到 20s。
- 引擎默认端口 `12323`，开发机常驻实例会占着它。测试实例用独立端口
  （smoke 用 `12399`，lsp 用 `12401`）避免互相复用引擎。
- 引擎启动较慢，就绪断言时限是 90s。
- **断言描边/线宽不要写死像素值**：Electron 窗口 DPR 不保证是 1，
  Chromium 会按设备像素取整（1.5x 下 `1px` 算出来是 `0.666667px`）。
  改为断言区间（如 `0 < w <= 2`）或只断言 `outlineStyle`。
