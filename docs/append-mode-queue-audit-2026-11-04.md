# Code / Work 下一轮队列审计与修复记录

审计日期：2026-11-04。本文按当前源码和已完成的验证更新，保留原问题与修复证据。**r11 已通过 Work / Code 双模式真实模型追加与停止复测，以及最终确定性 Electron 队列 / 补充窗口回归。** Code 已接入主进程持久队列，不再使用旧的 React 内存队列派发路径。本文分别记录纯契约、确定性真实 Electron 和真实模型测试；三者不能互相替代。

## 当前状态与证据边界

- 已实现：Code 独立 owner / IPC、完整请求持久化、主进程调度、精确接纳回执、暂停 / 明确恢复、编辑 / 排序 / 删除 / 显式合并 / 模型调整、渲染层操作日志与已确认草稿去重。
- 最终纯回归已通过：Work / Code 队列 hook 与 SessionTray **48 / 48**，接纳 / 审批 / 停止 **49 / 49**。此前 Code dispatcher 与并发 / 关闭 / 准备容量回归 **8 / 8** 通过；完整 `npm run typecheck`、r11 build 及 `git diff --check` 通过。这些测试不启动 Electron、不调用模型。
- 已通过的开发入口专项：`scripts/dev.test.mjs` **7 / 7**；一次 `npm run dev -- --prepare-only` 完成隔离引擎快照准备。该证据证明单命令启动流程的构建路径，不等于最终版本的整机或模型验收。
- r6 确定性 Electron 发现的首条 commit 后输入框未清空问题，已修复字段顺序误判，并在 **r9 Code queue 真机完整用例通过**：连续三条入队、暂停、编辑、合并、renderer reload、应用重启、原回执恢复与重复 POST 校验均通过。
- r9 Work / Code 运行中补充与停止边界用例通过，记录 18 次受控补充 POST、模型调用 0；两模式待发后停止均保留要求与输入框草稿。r9 工作台客户端 UI **9 / 9** 通过。
- 真实模型 round 2 的 Code 首次直接发送未解锁问题在 r10 修复；round 3 / 4 暴露的终态队列版本竞争在 r11 修复。**最终 round 5 Work / Code 均 passed**：各五条本轮补充 integrated、下一轮独立 root、消费前重载持久、完成后重载无丢失 / 重复、独立停止 cancelled；完整历史分别 34 / 28 行，测试 phase=closed。
- r11 最终确定性 Electron 队列 `7IWdGr` 与 root-followup `XUjDQ7` 均 passed，构建 / 源码执行前后摘要相同；分别记录 2 次队列 POST、18 次受控补充 POST，模型调用均为 0。带待发项停止与草稿保护由后者覆盖，真实模型 round 5 的独立停止没有待发项。

## 当前 Code / Work 实现

| 项目 | 当前实现与边界 |
| --- | --- |
| owner 与 IPC | `owner: 'code' | 'work'`；分别使用 `code:next-turn-queue` / `work:next-turn-queue`。共享 repository / service / dispatcher，控制器与恢复筛选按 owner 区分。Code 不通过 Work channel 冒充调用。 |
| 存储后端 | 默认使用主进程不可变 JSON journal；`AETHER_NEXT_TURN_BACKEND=sqlite-worker-opt-in` 才使用 SQLite worker。不能将默认后端写成 SQLite。 |
| 完整提交内容 | 保存正文、mentions、草稿 revision、模型、资源继承 / 空选择 / 覆盖、thinking、Code 有序多工作区、主 Agent / 协作者 / resumeRunId、memory、子代理模型及附件持久回执等。配置变化不会由恢复时的当前界面设置替代。 |
| 作用域 | 包含 mode、规范化 endpoint、accountId、tenantId、数据库 namespace id / generation、owner、taskId。当前连接身份另作运行时 fence。 |
| 发送协议 | Code 使用 `toolProfile: 'code'`、`runLifetime: 'durable'`、subagentProtocol 2；Work 保留其 profile。派发前持久保存固定 requestKey、bodyDigest、predecessor 与 wireBody。 |
| 附件 | 准备时快照与校验；远端 upload token 只解析一次，已持久 receipt 不再冒充 upload token；Code 可从选定的次工作区接入附件。准备并发有界。 |
| capabilities | 派发时根据当前连接重新生成；Code 连接状态绑定 sender 与当前 engine scope，sender / epoch 失效后不能继续作为授权。能力按 Code / Work mode 隔离。 |
| 界面职责 | `useCodeNextTurnQueue.ts` 读取、订阅和修改主进程状态；不在 renderer 中自行 drain。托盘默认折叠为紧凑一行，只有 pending 项可编辑、排序或删除。 |
| 合并方式 | 串行队列 + 用户明确选择合并。不同模型 / 工作区 / 协作配置不能静默合并；旧自动 batch 模式已移除。 |
| 重载与后台 | reload / 重启按原作用域恢复；主进程负责未打开会话的调度。恢复不等于自动重发未知请求。 |

## 原问题 → 修复 → 验证证据

| 原问题 | 当前修复 | 已有证据与未覆盖部分 |
| --- | --- | --- |
| Code 待发仅在内存中，reload / 切源丢失 | 完整 envelope 与修订进入主进程 journal；渲染层仅订阅相应 owner / scope。切源隔离显示，保留原源磁盘记录。 | shared / main 契约通过；r9 Code 真机验证完整条目在 renderer reload、应用重启后保留，显式恢复后只执行一次。切源首帧隔离另有 hook 回归。 |
| 停止可能删除队列或在 idle 后自动接着发 | 停止流程使用持久暂停；cancelled / failed 前轮不能自然放行。用户明确“发送 / 恢复队列”调用 durable resume，即使前轮仍在运行也可以解除暂停，实际派发继续等待前轮状态。 | Code pause 重启与 resume 原 predecessor 契约通过；r9 root-followup 真机验证 Work / Code 带待发要求停止后保留队列与当前草稿，释放延迟响应不再补发，continuations 为 0。真实模型结果另行记录。 |
| 派发前移除内存项，ACK 丢失后不能关联原请求 | claim 先落盘；未知结果保留为 `admission-unknown` 并暂停，按原 scope / requestKey / digest 核对。明确 absent 重试仍使用原 frozen wireBody。 | dispatcher 故障边界契约通过；r9 真机后台 B 会话 unknown 经 reload 后核对原回执，最终仅 1 次 POST；A 明确恢复也仅 1 次 POST，合计 2 次。 |
| UI 操作已提交但 ACK 丢失，重新点击可能生成新操作 | renderer 在首次 IPC 前将原 operationId、expectedRevision、id 与完整 action 写入独立本地操作日志。恢复精确回放原 action；未知结果不覆盖，明确拒绝保留原稿。 | 丢失 enqueue ACK、编辑 / 模型 / 合并 / 暂停 / 恢复 / 排序 / 删除 / 清空的原操作回放测试通过。 |
| 正常 ACK 与输入框清空之间崩溃，恢复后重复发送同一草稿 | 普通与恢复 enqueue ACK 都保留 confirmed receipt；匹配确认不删除。ChatView 持久保存作者草稿 revision，提交前严格写入，成功清空生成新 revision。更高 revision 的新请求持久写入后才清理旧确认。 | 普通 ACK 后崩溃、主进程 changed 早于 ACK、重复 reload / 匹配、相同文案但新 revision 再发送，均有 hook 回归。 |
| 刷新恢复与原 enqueue 同时准备附件，第二次出现伪冲突 | 同 scope + operationId 的在途请求共用原准备 Promise；必须匹配 id、expectedRevision、输入摘要。 | held-envelope 并发合同通过：仅准备一次、相同回执、仅一个条目；不同正文被拒绝。 |
| 恢复暂停的 ACK 重放时，root 已经推进导致原操作被改写 | resume 重放读取原已提交的 resumeAnchor，repository 继续核对原操作身份与载荷。 | `Code resume ACK replay retains the original predecessor after the root has advanced` 通过。 |
| 来源切换首 render 仍显示或允许读取旧队列，A→B→A 的旧响应污染新视图 | read / state 绑定 taskId、source 的 owner 对象与 generation；UI、snapshot、commit 只消费匹配记录。invoke 调用前及响应后检查 owner / generation。 | 同 sessionId 切换 remote 首 render：queue=[]、ready=false、state=null，snapshot 拒绝旧状态；A→B→A 旧 revision 99 响应不能覆盖新 revision 0。 |
| r6 首 enqueue 已提交，客户端却拒绝 ACK | 无 journal 的初次 scope 保留构造顺序；首 commit 经 canonical JSON 后字段键序不同。原 `JSON.stringify(scope)` 比较误判身份变化；现使用 `sameQueueScope` 按字段含义比较。IPC 并未丢失 receipt。 | 真实 owner / store / dispatcher 到 hook 的契约回归通过；r9 Electron 连续三条提交均清空输入，并通过后续暂停、编辑、合并与重启完整链路。 |
| round 2 真实 Code 首次直接发送已执行，但输入框 20 秒仍未清空、无法继续补充 | 主进程 `engineStreamStart` 等待整条 SSE 结束；旧 `send → sendInternal → runStream` Promise 被 ChatView 当成接纳 ACK。r10 新增独立 `onAdmitted` 通知：同提交流中有效、同 session、发送前未知的新 root 才通知一次；完整流 Promise 仍等待执行生命周期。 | 新增 11 项真实生产回调回归，连同审批与停止回归共 49 / 49；完整 typecheck 与 r10 隔离 build 退出 0。真实 round 3 复测结果待填。 |
| 队列 UI 保存失败却关闭编辑器，或背景变化吞掉草稿 | 所有操作等待异步完成；失败保留编辑稿和中文错误；非 pending 项锁定；后台删除或阶段变化时仍保留未保存编辑稿供复制 / 取消。 | 8 项 SessionTray DOM / effects 测试通过，含异步失败、pending 子集排序、空队列错误、A→B→A、孤立编辑稿。 |
| 单命令开发启动仍可能载入旧引擎 dist | `npm run dev` 先准备同级引擎的唯一隔离快照，再启动 electron-vite。前后校验官方 build identity、依赖补丁和 manifest；不写共享 dist。显式引擎入口仍受验证。 | 7 项启动脚本测试与一次真实 prepare-only 成功；未自动停止用户常驻引擎。运行中的任务需结束后重新启动开发命令才载入新快照。 |

## 关键实现文件

| 模块 | 当前职责 |
| --- | --- |
| `src/shared/code-next-turn-api.ts`、`work-next-turn-api.ts`、`next-turn-queue.ts`、`next-turn-queue-state.ts` | 独立 Code API、完整数据契约、作用域比较与状态校验。 |
| `src/main/next-turn-queue-store.ts`、`next-turn-queue-service.ts`、`next-turn-dispatcher.ts` | 持久提交、CAS、回执查找、在途 enqueue 合并、冻结派发与 unknown 恢复。 |
| `src/main/next-turn-admission-protocol.ts`、`next-turn-engine-gateway.ts` | owner / transport、完整请求准备、当前能力、附件与精确接纳协议。 |
| `src/main/work-next-turn-owner.ts`、`work-next-turn-ipc.ts`、`src/preload/index.ts` | 分别注册 Code / Work owner，typed failure 与结果透传；恢复不依赖当前可见会话。 |
| `src/renderer/src/core/engine/useCodeNextTurnQueue.ts`、`code-queue-intent.ts`、`code-queue-entry.ts` | 受作用域约束的读写、持久操作日志、confirmed 去重、完整 Code 配置适配。 |
| `src/renderer/src/contrib/chat/draft-store.ts`、`ChatView.tsx`、`SessionTray.tsx`、`src/renderer/src/core/engine/useChat.ts` | 作者草稿 revision、提交 / 清空、队列托盘、停止 / 恢复与实时流衔接。 |
| `scripts/dev.mjs`、`src/main/engine/runtime-location.ts` | 单命令开发启动、隔离引擎快照、开发时显式入口优先级。 |

## 已执行的测试

```text
node --test scripts/code-queue-intent.test.mjs scripts/session-tray-durable.test.mjs
27 passed / 0 failed

npx playwright test e2e/next-turn-dispatcher.spec.ts \
  -g "Code|two preparations|close ACK|concurrent same-task" \
  --reporter=line --output=.e2e-tmp/code-intent-main-final-results
8 passed / 0 failed（纯主进程契约，不启动 Electron）

npm run typecheck
node + web 均退出 0

git diff --check -- src/renderer/src/core/engine/useCodeNextTurnQueue.ts scripts/code-queue-intent.test.mjs
退出 0
```

开发入口专项记录：`node --test scripts/dev.test.mjs` 为 7 / 7；`npm run dev -- --prepare-only` 曾生成 `.tmp/aether-code-dev/<唯一目录>/dist/main.js` 并通过 manifest / 补丁 / build identity 检查。该快照是当时源码的构建证据，不代表其后源码修改已经包含在该快照内。

### r6 真机失败证据

目录：`.e2e-tmp/work-next-turn-window-FsHDO6/`。

- `artifacts/work-queue-live-Code-queue-04a0e-sion-without-duplicate-POST/failure-details.json`：原文“队列第一条”仍在输入框，队列磁盘状态 revision 1，条目 phase 为 pending。
- 同目录 `failure.png`、`trace.zip` 及 Electron health 文件保存了窗口和执行记录。
- `result.json` 的 `posts` 为空；当时前轮仍运行，不能把“没有模型 POST”误写成队列数据未提交。
- `profile/next-turn-queue-v1/.../r0000000001.json` 保存了本次 durable commit，scope 使用 canonical 字段顺序。
- 此失败属于真实集成问题，已加入上表；修复后纯接口回归和下述 r9 Code 真机完整用例均通过。原失败证据仍保留。

## r9 确定性真实 Electron 验收

构建入口为 `.e2e-tmp/fixes-20261104-r9/main/index.js`。Code queue 与 root-followup 两份 runner 结果都记录 `passed: true`、`exit.code: 0`、`typecheckExit.code: 0`、`stable: true`、`models: 0`；执行前后构建与源码摘要一致：

| 标识 | 摘要 |
| --- | --- |
| 构建树（122 个文件） | `876abc180f9cfab35375f2090a19a2b0291f7d70857967015c6fb495bab50310` |
| 源码树（620 个文件） | `79754378e6206e206aaf4fd51a244d765c063c779a8eea666f06ce0fbd40749f` |

### Code queue 完整恢复链路

结果：`.e2e-tmp/work-next-turn-window-ACsJ50/result.json`；日志 `stdout.log` 为 **1 passed**，两次启动的 Electron health 均 `failures=0`。

- 通过真实 UI 连续提交三条，每次 ACK 后输入框清空；主进程队列保存三条独立正文。
- 暂停、编辑首条、renderer reload、显式合并、应用关闭再启动后，完整内容和暂停状态保持。
- 后台 B 会话接纳确认不明时保留原请求；renderer reload 后核对原 receipt，B 最终只有 **1 次 POST**。
- A 在用户明确恢复后发送合并正文，只有 **1 次 POST**。全部队列 POST 合计 **2**，均验证 Code profile 与 durable lifetime。
- 最终队列与 POST 证据：`artifacts/work-queue-live-Code-queue-04a0e-sion-without-duplicate-POST/durable-code-queue.json`；同目录 `durable-code-queue.png` 保存最终窗口。

### Work / Code 运行中补充、停止与界面

结果：`.e2e-tmp/collaboration-controller-window-5T5Nns/result.json`；日志为 **1 passed**，记录 **18 次受控补充 POST、0 次模型调用**。POST 包括受控拒绝、未知结果和原请求重试场景，不能解释为 18 次模型执行。

- Work / Code 均验证当前 root / attempt / session 归属；明确下一轮走独立队列；双击只新增一个请求；提交期间新写的草稿不会被旧 ACK 清除。
- 拒绝保留原文；未知结果锁定再次提交，核对后按原 requestKey 重试；root 更换和停止边界阻止旧要求发送。
- 两模式先追加待发项再停止，保留待发要求和停止边界输入原文；延迟 discovery 释放后不补发，continuations 保持 0。
- 补充记录折叠、展开、逐条详情、刷新、放回输入框、键盘关闭与焦点恢复通过；1440 / 940 宽度检查工具栏重叠、文字裁切、记录浮层范围和输入区高度。
- 证据目录 `artifacts/controller-Work-and-Code-s-c172e-urn-unknown-stop-boundaries/` 包含两模式、两宽度截图、停止截图、`electron-ui-trace.zip` 和 health 记录。

### 工作台客户端 UI

r9 `e2e/workbench-client-ui.spec.ts` **9 / 9 通过**。结果目录 `.e2e-tmp/fixes-20261104-r9-workbench-results/`，`.last-run.json` 为 `status: "passed"`、`failedTests: []`。

覆盖能力注册到结果回路、真实文本读取 / 更新 / 缺失失败、已取消命令不执行、会话切换后的延迟命令隔离、Code 真实编辑器与未保存内容保护、后台模式回执不冒充前台显示，以及新会话不能打开旧会话路径。此组是真实 UI 验证，不构成真实模型工具选择质量结论。

### 保留的 r9 定位器失败与修正

1. `.e2e-tmp/work-next-turn-window-RiPQlz/stdout.log`：reload 后未限定可见托盘，定位器同时匹配 3 个 hidden 元素，立即 strict violation；不是等待 20 秒后恢复超时。同次 `failure-details.json` 已显示“已暂停 · 3 条待发”，主进程状态为 revision 5、paused=true，三项及编辑正文完整保留。probe 改为 `.session-tray:visible`，并在 reload / relaunch 后等待唯一可见托盘再断言暂停。
2. `.e2e-tmp/collaboration-controller-window-HDQJfJ/stdout.log`：root-followup 的 Code 队列断言同时匹配 2 个 hidden 与 1 个实际可见托盘，strict violation。probe 同样限定当前模式中的可见托盘。

上述两项仅修正测试选择器和恢复等待；随后复用 r9 生产构建通过。未通过 `.first()` 忽略多可见控件，也未放宽实际内容、持久状态和 POST 次数断言。

## 真实模型验收状态

### round 2 发现的直接发送接纳问题

证据根目录：`D:/trust-test/append-mode-fixes-20261104/`。

- `evidence/round-2/append-validation/outcomes.json`：Work 为 `passed`；Code 为 `failed`，错误是初次发送后等待输入框清空超过 20 秒。该错误不能解释为模型没有执行请求。
- `round-2/workspace/append-validation/code-initial-started.json` 已存在；`evidence/round-2/append-validation/code-failed-ui.json` 与 `evidence/round-2/screenshots/append-code-failed.png` 显示命令运行中、原始正文仍在输入框、“立即补充”被禁用。
- 根因在客户端 Promise 边界：`src/main/ipc.ts` 的 `engineStreamStart` 等待 `engineHost.stream` 整条 SSE；`send → sendInternal → dispatchChatRequest → runStream` 继续等待该 Promise。ChatView 将清稿和解除 `submissionFlight` 放在发送 Promise 完成后，导致长任务必须结束才能继续编辑发送。这不是已证实的草稿 revision 或会话初始化变化问题。
- r9 的确定性队列与补充用例通过并不覆盖真实模型首次直接发送的长 SSE 接纳边界；本次失败补充了该覆盖缺口。

### r10 修复与纯测试

修改位于 `useChat.ts` 与 `ChatView.tsx`：`send` 增加独立的 `onAdmitted` 通知，回调不进入请求 wire body；正常返回的 Promise 仍拥有完整流生命周期，retry / undo 等调用不会将接纳误认为执行结束。

1. 接纳必须来自本次 stream、当前 source / view scope、同 session，且 root 不在本次发送前已知的 run 集合中。任意 progress、旧 root、其他会话或其他 stream 均不能清稿。
2. 通知触发后，只清除与原 scope、作者 revision、正文仍匹配的草稿；只移除本次提交的附件对象，后加附件保留。相同文案但新 revision 也保留。
3. composer 使用独立 flight 对象：接纳即可解锁继续输入，旧长流后来结束或失败不能解锁下一次提交。已接纳的旧正文不会在迟到错误后恢复成待发送草稿。
4. 接纳前明确拒绝或连接未知继续保留原稿和附件；未观察到有效 root 的流结束不伪造成功。接纳后的流错误仍进入原流的历史 / 恢复 UI，Promise rejection 有处理。
5. 持久队列仍在 durable commit / confirmed receipt 后发出接纳通知；既有 confirmed 草稿 revision 去重语义保留。

验证：

```text
npx playwright test e2e/chat-send-admission.spec.ts e2e/approval-session-race.spec.ts e2e/chat-stop-contract.spec.ts \
  --reporter=line --output=.e2e-tmp/chat-send-admission-final-results
49 passed / 0 failed（11 项接纳、22 项审批、16 项停止；不启动 Electron、不调用模型）

npm run typecheck
node + web 退出 0

npm run build -- --outDir .e2e-tmp/fixes-20261104-r10
退出 0
```

r10 入口：`D:/dev/aether-code/.e2e-tmp/fixes-20261104-r10/main/index.js`。定向 diff 检查通过，生产代码已冻结交由主任务跑真实 round 3；本文未宣称 r10 真机或真实模型复测已通过。

### round 3 / round 4：结束后的队列版本竞争

真实模型测试工作区：`D:/trust-test/append-mode-fixes-20261104`。两轮均保留失败，不能计为端到端通过。

- round 3 使用 r10，在 Work 运行中追加、下一轮与重载之后，新的停止验证任务未成功发出。`evidence/round-3/append-validation/outcomes.json` 为 `TIMEOUT:work-stop-window`；`work-queue-revision-ui.json` 记录 `Queue revision changed`，原稿保留。
- round 4 使用 r10 单独验证 Code，初次长流接纳后已能追加；之后同样在重载后发送新的停止验证任务时失败，`evidence/round-4/append-validation/outcomes.json` 为 `TIMEOUT:code-stop-window`。界面的“队列操作未完成”是托盘摘要，不能据此认定底层未知错误。
- 对 round 4 的只读磁盘核验确认：`round-4/profile/next-turn-queue-v1/` 中 r3 为 accepted、r4 为 terminal；`Local Storage/leveldb/000003.log` 留存停止验证 enqueue 的 rejected intent，`code=CAS`、`expectedRevision=3`，操作 id 为 `e991e2bd-49a6-47af-a684-9a3c2709d7fb`，entry id 为 `6324a283-48b5-40d3-bc0e-0b08337155fe`。journal 没有该新 entry。这是明确未提交的版本竞争，并非请求已经执行但显示失败。

根因：后台 accepted → terminal 推进队列版本，恰好与用户在当前渲染版本上追加下一条相遇。Work 在 CAS 后只刷新并抛错；Code 将该操作记为 rejected。两者都没有对独立 append 做安全的重读重试。

### r11 修复与回归

1. Work 与 Code 的独立 enqueue 仅在收到明确 `CAS` 后读取最新版本，最多重新定基两次。始终保留 entry id、operation id、完整 submission；不自动重试 IO、未知 transport、权限错误、冲突或容量错误。编辑、移动、删除、合并等操作仍保留原版本约束。
2. Work 的 saving 锁覆盖整个重读与重试过程；原 scope 保存到 pending attempt 中。新读到的 scope 必须与原 scope 完全一致，包含数据库 namespace、tenant、账号、任务等；任务切换或同源数据库身份更换都不能续发原 append。
3. Code 必须先把旧操作的明确 CAS 拒绝写入恢复记录，确认完整身份未变化，再将同一操作的新 expectedRevision 持久化，然后才能再次 IPC。若新版本提交的 ACK 丢失，重载会精确重放新版本和原身份，不能退回旧版本或另造请求。恢复记录写入失败时不发送。
4. 连续竞争耗尽预算时显示“队列已更新，原稿已保留，请重试”。输入清理仍只依赖成功提交回执，不能因 CAS 重读而清稿。

验证命令与结果：

```text
node --test scripts/work-queue-rebase.test.mjs scripts/code-queue-intent.test.mjs scripts/session-tray-durable.test.mjs
48 passed / 0 failed（15 Work、25 Code、8 托盘）

npx playwright test e2e/chat-send-admission.spec.ts e2e/approval-session-race.spec.ts e2e/chat-stop-contract.spec.ts \
  --reporter=line --output=.e2e-tmp/r11-admission-regression-results
49 passed / 0 failed

npm run typecheck
node + web 退出 0

npm run build -- --outDir .e2e-tmp/fixes-20261104-r11
退出 0；包含完整 namespace fence 的最终构建
```

上述回归加载实际 React hook 与真实主进程 owner / JSON journal，包含重定基后回执丢失、renderer 重挂载、持久化失败、重复点击、任务切换、数据库 namespace 改变，以及只发生一次 durable commit 的断言。均不启动 Electron、不调用真实模型。真实复测见下一节，不能由这些纯测试推定真实模型与产品流程已经验收通过。

r11 构建入口：`D:/dev/aether-code/.e2e-tmp/fixes-20261104-r11/main/index.js`。生产代码自该构建起保持冻结，随后由主任务完成以下真实 Electron 与模型复测。

## 最终结果：r11 / round 5

最终真实模型证据：`D:/trust-test/append-mode-fixes-20261104/evidence/round-5/append-validation/outcomes.json`。Work 与 Code 均为 `passed`；`round-5/state.json` 记录 `phase: closed`。本轮使用独立 profile / workspace 和 `deepseek-v4.1-flash`，覆盖追加、队列、重载与停止链路；不把本专项的通过扩大解释为全部办公格式、围棋产品质量或长期压力测试均已完成。

| 验收项 | Work | Code | 证据 |
| --- | --- | --- | --- |
| 完整历史归档 | 34 / 34 行，1 页 | 28 / 28 行，1 页 | `work-final-archive.json` / `code-final-archive.json`，均为 `rows.length=total` |
| 运行中五条补充 | 5 / 5 integrated | 5 / 5 integrated | `*-delivered-server-receipts.json`；五条独立 requestKey / historyMessageId |
| 执行顺序与次数 | current-1…5 各一次，在 original-complete 前；next 最后一次 | 同左 | outcomes 的执行 journal 与工作区 probe journal，均无重复标记 |
| 下一轮执行身份 | 新 root，succeeded | 新 root，succeeded | outcomes.next 的 admissionReceipt 与原 predecessor |
| 消费前 renderer reload | pending 条目完整保留 | pending 条目完整保留 | `*-pending-reload-queue.json`、`*-next-queue-observations.json` |
| 完成后 renderer reload | 原补充与历史保留，未重复派发 | 同左 | `*-final-archive.json`、`*-automatic-delivery-refresh.json`、outcomes |
| 独立停止任务 | cancelled；观察耗时 1,885 ms | cancelled；观察耗时 1,897 ms | outcomes.stopped 与 timings 中 `work-stopped` / `code-stopped` |

停止耗时为验收脚本从点击停止到观察到目标 cancelled 的端到端采样值，不是模型或服务的延迟分位数。本次真实停止之前的下一轮已经完成，**没有带待发项**；带待发项停止后仍保留队列、保留当前草稿且不自动续发的边界由下面的确定性 Electron 用例覆盖。

### 最终确定性 Electron 复测

| 结果文件 | 结果 | 明确覆盖 |
| --- | --- | --- |
| `.e2e-tmp/work-next-turn-window-7IWdGr/result.json` | passed，exit=0，typecheckExit=0，stable=true，models=0 | Code 连续三条入队、编辑、暂停、显式合并、renderer reload、应用重启、未知接纳原回执核对；A / B 各 1 次队列 POST，合计 2 次 |
| `.e2e-tmp/collaboration-controller-window-XUjDQ7/result.json` | passed，exit=0，typecheckExit=0，stable=true，models=0 | Work / Code 本轮补充、已知拒绝 / 未知结果、重复点击、原草稿保护、身份边界、带待发项停止、延迟响应后无续发，以及 1440 / 940 宽度交互；18 次受控补充 POST |

两份结果的 18 / 2 次 POST 属于不同受控请求，不能相加解释成模型任务数；两组都不调用真实模型。源码与构建树在执行前后保持一致：

| 身份 | 摘要 |
| --- | --- |
| r11 构建树（122 个文件） | `084e6711284b029536c484d1e6e87e3c1df5563360c3633bb99b551666844202` |
| 源码树（620 个文件） | `a25da1216f717ecd13a30b394e420c988e6dc8f9a8c307b3237e75b6f496b585` |
| round 5 app 入口 SHA-256 | `62a37e02808debc7a27233606ae28e1068e9d40e4d129211e2156fb63f56b4bb` |
| round 5 engine 入口 SHA-256 | `ec170114fd91e600c5d2f1d9e50ed2c8b515a43178bf0fb7b45991853a363111` |
| round 5 engine buildId | `sha256:129b50ac2ff3b8cd815dc23a0b3c9db7d7dea7c33b8370355e11886a660c9775` |

入口摘要来自 `D:/trust-test/append-mode-fixes-20261104/round-5/state.json`；构建树与源码树摘要来自两份确定性窗口 result。入口文件摘要与整棵构建树摘要的范围不同，不互相替代。最终生产代码保持 r11，收尾只更新报告，未再次修改代码或启动窗口。
