# Work 与全量 E2E 验证记录

本轮在完成 Work 修复后执行了构建和单 worker 全量 Playwright 回归。

## 结果

- `npm run typecheck`：通过（node + web）。
- `npm run build`：通过。
- Work 相关 25 条：25 passed。
- 全量 1170 条：1114 passed、10 failed、13 skipped，33 条因失败后的串行 fixture 未继续执行。
- 浏览器界面沙箱外复测 36 条：35 passed、1 failed（2.0 分钟）；失败为 Work 无任务首页缺少浏览器入口，详见下文。
- MCP 界面沙箱外整份复测 7 条：7 passed（33.1 秒）。
- `node --check scripts/work-soak-runner.mjs`：通过。
- `git diff --check`：通过。

## 失败分类

10 条失败集中在内置浏览器、编辑器重启恢复、MCP 错误诊断和 Monaco 首次快速打开。

- 首次全量的 7 条浏览器失败出现 Electron 页面关闭、`os_crypt` DPAPI 加密失败、Crashpad 未连接及 fixture 清理 `EPERM`。独立诊断排除了 `terminal:create` 夹具错误：该错误后窗口仍存活，调用 `browser.create({url:'about:blank'})` 才触发原生进程退出（`0xffff7003`）。随后用裸 Electron 对照定位到执行沙箱阻止 Chromium 子进程创建，见下文；DPAPI 日志本身不是此结论的依据。
- 编辑器重启恢复和 Monaco 用例单独重跑分别为 5/5、3/3 通过，但只能说明故障具有间歇性，尚未确认根因，不能靠一次重跑判定已修复。
- 首次全量的 MCP 错误诊断收到 Windows `Get-CimInstance Win32_Process` 权限拒绝，替代了用例预期的 stdio 退出码。完整 `mcp-ui.spec.ts` 在沙箱外复测 7/7 通过，包含准确展示 `MCP stdio exited with code 17`、编辑错误配置后恢复工具发现及磁盘清理。

首次全量结果保留不变。浏览器/MCP 的执行权限阻塞已有对照证据，但不能据此把新暴露的 Work 入口缺口或其他间歇性失败记为已修复；全量目前未通过。

## 浏览器原生进程对照（2026-10-12）

对照期间没有修改产品源码、测试源码或重新构建，所有复测使用同一份 `out/`。

1. 在隔离的远端引擎夹具中，`terminal:create` 返回 `fixture` 错误后，窗口连续存活 5 秒，DOM 显示“终端启动失败 / 重试”；仅在创建 `about:blank` 原生网页后退出。因此终端失败日志与原生退出并非因果关系。
2. 最小 Electron 脚本仅创建 `BrowserWindow`、`WebContentsView` 并加载 `about:blank`。在执行沙箱内，`sandbox: true` 的持久化与临时 partition 都返回 `ERR_FAILED (-2)`，`render-process-gone` 为 `reason: launch-failed / exitCode: 49`；同样例 `sandbox: false` 可以加载。默认 GPU 子进程则反复以 `-1073741515` 退出后触发 Chromium fatal。
3. 经 `require_escalated` 在执行沙箱外运行同一脚本，4 组配置（持久化/临时 partition、受保护网页、默认 GPU）均完成加载并以 0 退出。产品网页的 `sandbox: true` 保持不变。
4. 正式 `browser-ui.spec.ts` 沙箱外单独复跑 11/11 通过（10.6 秒），随后执行全部浏览器界面文件，结果如下。

诊断脚本与完整对照日志：`.ae/tmp/electron-native-fixture.cjs`、`.ae/tmp/electron-native-runner.cjs`、`.ae/tmp/electron-native-audit.log`、`.ae/tmp/electron-native-audit-unsandboxed.log`。

## 沙箱外定向回归（单 worker）

```powershell
npx playwright test e2e/browser-agent-ui.spec.ts e2e/browser-local-ui.spec.ts e2e/browser-multitab-ui.spec.ts e2e/browser-navigation-ui.spec.ts e2e/browser-network-ui.spec.ts e2e/browser-surface-ui.spec.ts e2e/browser-ui.spec.ts --workers=1 --reporter=line
npx playwright test e2e/mcp-ui.spec.ts --workers=1 --reporter=line
```

浏览器结果为 **35 passed / 1 failed / 0 skipped（36 条）**。Agent 真实工具闭环、截图像素、多标签隔离、导航生命周期、网络详情、反复拖动与缩放均通过；没有再次出现 Electron 原生退出或 fixture 清理 `EPERM`。

当时剩余失败：`browser-surface-ui.spec.ts:250` 的“切换 Work 后由 Work 浏览器继续显示同一原生网页实例”。切换到 Work 后，测试在第 263 行等待“浏览器”标签 30 秒超时。实际页面是 0 任务的 Work 首页，没有右侧工作区标签，且本地引擎未启动；并非网页崩溃。源码中工作区渲染及原生网页拥有权均要求 `activeTask`，因此该场景存在明确的无任务浏览器入口验收缺口。此缺口现已通过独立浏览器导航修复，见下面的集成回归记录。

MCP 结果为 **7 passed / 0 failed / 0 skipped**。本次运行整份文件，保留了 serial setup 依赖，没有通过 `-g` 跳过先决步骤。

完整日志：`.ae/tmp/browser-ui-unsandboxed-suite.log`、`.ae/tmp/mcp-ui-unsandboxed-suite.log`。剩余浏览器失败的快照与 trace 已复制到 `.ae/tmp/browser-ui-unsandboxed-failure/`，避免后续测试覆盖。

## Work 交互集成回归（2026-10-12）

修复了无任务浏览器入口、对话正文与工具的时间顺序、活动定位与独立滚动、子代理详情与继续执行、远端 Agent 管理 API 白名单、首页与任务输入区候选菜单的裁切、回车误发送和内部滚动误关闭。

重新执行 `npm run build`（包含 node/web typecheck）通过。在执行沙箱外使用单 worker 运行 Work、时间线、子代理、远端契约和浏览器表面共 11 份 spec，结果 **62 passed / 0 failed / 0 skipped，64.2 秒**。这不是首次全量 1170 条的重新运行，也不替代用户已调整为一小时的真实模型压力测试。

- `work-mode.spec.ts`：14 条，覆盖五任务同时运行、两任务共享目录、后台归档、权限/记忆/思考偏好、远端 Agent 实际 CRUD、跨任务润色和 940px 深浅主题。
- `work-timeline-ui.spec.ts`：5 条，真实 Electron + HTTP/SSE；940×760、940×640 候选菜单完整可见，标题/选项实际命中；31 项资源真实滚动到末项；回车选择与空结果回车均不产生聊天请求；正文顺序、活动精确定位与独立滚动、子代理延续且保留父草稿。
- `browser-surface-ui.spec.ts`：3 条，包含无任务 Code→Work→Code 保持同一原生网页 ID 与 URL，以及原生网页拖动/缩放回归。
- 另外 40 条纯函数与 HTTP 契约覆盖会话隔离、状态恢复、工具时间线、子代理、上传上下文和精确远端路由。Agent 仅开放引擎已实现的 POST 集合、PUT/DELETE 单项，未开放批量、PATCH 或嵌套路径。

构建日志 `.ae/tmp/work-integrated-build.log`；回归日志 `.ae/tmp/work-integrated.log`；实际窗口截图 `.ae/tmp/work-integrated/`。已人工打开新版首页资源菜单截图，确认标题不再被顶部区域裁掉。

## 原生健康监控与自动化交互复测（2026-10-12）

用户报告 `electron.exe` 的 `0x80000003` 弹窗后，发现此前用例只采集 `pageerror`、等待 `app.close()`，没有断言原生进程退出码。Playwright 的 Electron 关闭流程会吞掉 TargetClosed 错误，因此“DOM 测试通过”不足以排除关闭阶段的原生崩溃。

现在 `e2e/helpers/electron-health.ts` 在 Work、时间线、自动化与浏览器表面四类用例中采集宿主/启动器 PID、32KB 脱敏 stderr 尾部、所有已有/新建 WebContents 的 `render-process-gone`、`child-process-gone`、进程退出码。每个用例检查明确异常，suite 关闭时必须退出码为 0 且无异常信号。诊断 JSON 显式落盘并作为 Playwright 附件保留；夹具清理放在 finally 中。两条纯契约覆盖异常码、启动失败、OOM 和凭据脱敏。

- 11:06:21–11:07:16：重新构建后监控版 **27/27 通过**。浏览器、自动化、Work、时间线宿主 PID 分别为 15100、48344、55320、39296；4 个实例均 `exitCode=0 / signal=null / nativeEvents=0 / failures=0`。日志 `.ae/tmp/work-native-monitored.log`。
- 11:09:53–11:10:22：纳入自动化保存期间的输入保护后重新构建；自动化 3 条 + 完整 Work 14 条，**17/17 通过**。宿主 PID 41296、35532 均正常退出，没有原生异常信号。日志 `.ae/tmp/work-final-ui.log`；持久诊断 `.ae/tmp/work-final-ui/*/electron-health-*.json`。
- 自动化实测包含 POST 新增并关闭思考、切换其他任务后 PUT 编辑仍保留原 session、自动档位用 null 恢复默认、不覆盖 enabled、暂停/启用/删除的实际 HTTP 副作用，以及最近运行时间显示。
- 初版自动化/Agent 管理截图仅调用 `settings.update({appearance})`，渲染器并未切换主题，因此那些名为 light 的旧截图不作为浅色验收证据。新用例通过设置界面的深色/浅色 radio 切换，断言 `<html data-appearance>`，并已人工打开新版 940px 浅色自动化截图确认。有效截图位于 `.ae/tmp/work-final-ui/`。

这两轮未复现原生崩溃，但不能证明用户弹窗的根因已经消失。09:46:47 的最小原生诊断曾记录 GPU fatal，退出码 `2147483651` 等于 `0x80000003`；仅异常码一致不足以证明是用户看到的同一次弹窗。测试诊断中的 `terminal:create: Error: ok` 来自受控 HTTP 夹具未提供远端终端，不是本轮原生异常；本节不宣称远端终端验收完成。

## 长测边界

已有六小时级 API 长测产物记录在 `docs/work-soak-evidence-audit.md`。该轮使用本地 mock provider，不能证明真实外部 `qwen3.8-flash`，也未覆盖 Electron UI 压力。正式真实模型长测按用户最新要求使用 `scripts/work-soak-runner.mjs --execute --duration-hours 1`，在隔离真实引擎通过预检后执行。

## 10:58 用户报告的原生异常弹窗

用户截图显示 `electron.exe` 异常码 `0x80000003`。09:46:47 的最小 GPU 诊断进程 PID 53976 存在相同退出码：GPU 子进程连续以 `-1073741515` 退出，随后 `GPU process isn't usable`，主进程退出码 `2147483651`。错误码相同不能证明截图属于该次诊断。10:53–10:54 的 62 条通过结果只覆盖页面断言，当时没有完整采集主进程退出码和原生子进程事件，不能据此排除关闭阶段崩溃。

只读检查 Windows WER 后，最近的 Electron dump 为 10 月 10 日，没有 10 月 12 日同码的新报告；10:58 截图创建时间也不能代表异常发生时间。当前归因待定。

新增本地诊断：`logs/native-processes.jsonl` 按 512KB 轮转，记录启动、renderer/child 终止原因、退出码与关闭阶段；Crashpad 仅在本机保存，不上传。新的 E2E 和 UI observer 必须同时检查主进程退出码与原生异常，而不是只检查 pageerror。

用户随后明确回复：**“上午出现后一直留着”**。因此截图不代表后续监控期间又发生一次新崩溃；时间线与上午执行沙箱中的原生诊断异常相符。截图没有进程 ID，仍不将其断言为 PID 53976 的同一实例。11:27–11:31 的真实 Work observer（宿主 PID 21612）记录 4097 次操作、345 次任务访问，`pageErrors=[]`、原生异常事件为 0、退出码 0；该轮因子代理模型选择验收失败而停止，不能算一小时长测通过。

## 候选菜单滚动与子代理提交竞态回归（2026-10-12）

只读审查补充发现两处真实交互缺口：候选菜单的输入区滚出可视范围后，portal 仍存在并占用 Enter/Tab；子代理续跑等待期间仍可编辑文本，提交完成时会清空这段新输入。现已按实际裁切祖先计算输入区可见性，离开可视区域即关闭菜单并释放监听，靠近窗口边缘时菜单避开标题栏；子代理提交期间禁用续跑文本框。

重新执行 `npm run build`（含 node/web typecheck）通过；完整 `work-timeline-ui.spec.ts` **6/6 通过**，使用实际 HTTP/SSE 和 Electron 窗口。新增场景通过正常操作创建 10 个任务，在 940×640 首页实际滚动，验证菜单边界、滚出后消失、Tab 恢复焦点导航且不发送任务；延迟子代理请求期间验证输入和操作禁用、内容保留，随后继续原代理并保留父草稿。已人工查看 `work-agent-near-chrome.png`，候选标题、选项及应用标题栏均可见。

原生监控宿主 PID `54468`、启动器 PID `3888`，`exitCode=0 / signal=null / nativeEvents=0 / failures=0`。构建日志 `.ae/tmp/work-scroll-race-build.log`；回归日志 `.ae/tmp/work-scroll-race.log`；截图与原生诊断 JSON 位于 `.ae/tmp/work-scroll-race/`。本轮未重跑 1170 条全量，不消除原始 10 条失败及 33 条未执行的证据边界。

## 自动化运行时限与模块文件高亮（2026-10-12）

Work 自动化新增“单次最长运行时间”：2/10/30/60 分钟、3/6/24 小时及自定义整数秒数（1–86400），新建默认 30 分钟。已有非整分钟值精确显示和保留；旧记录的 null/缺省显示 2 分钟，在未修改时限时 PUT 省略该字段，不改变旧语义。界面说明运行中修改从下一次生效，同一自动化未结束时不会重复启动。编辑继续使用原 session，且不覆盖 enabled。

实际工程使用 `.mjs` 暴露成果预览未走代码高亮的问题，现将 `.mjs/.cjs/.mts/.cts` 纳入文本识别和语言别名。成果回归通过实际工具回执产生 `module.mjs`，选择后断言 `export` 和 `const` 均具有可见的高亮 span；原有文件切换、引用草稿、活动定位仍通过。已人工查看 `work-module-syntax-highlight.png`，关键字与数值存在明确的语法配色。

最终 `npm run build`（含 node/web typecheck）通过，完整自动化 5 条 + Work 14 条 **19/19 通过，28.4 秒**。自动化覆盖实际 POST 默认值、PUT 六小时时限、125 秒重新打开、4 类无效输入阻止保存、旧 null/undefined 无关编辑保持原语义，以及深浅主题 940×640 布局；此 HTTP 夹具不执行调度器，调度行为由真实引擎验证提供证据。

自动化宿主/启动器 PID `58300/47488`、Work `57144/17976`，均 `exitCode=0 / signal=null / nativeEvents=0 / failures=0`。日志 `.ae/tmp/work-final-timeout-highlight-build.log`、`.ae/tmp/work-final-timeout-highlight.log`；截图和原生诊断 JSON 在 `.ae/tmp/work-final-timeout-highlight/`。此前自动化独立 5/5 的日志为 `.ae/tmp/work-automation-timeout-final.log`。本轮不等同于全量 1170 条重跑或真实模型长测完成。
