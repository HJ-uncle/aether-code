# Codex 与 Aether 引擎/客户端多维度对比

日期：2026-10-15  
范围：Work/子 Agent、定时任务、引擎监控、历史回放和高并发长任务的可见性与一致性。

这份文档把 Codex 的解包产物作为**行为证据**，把 Aether 客户端和同级
`ai-agent-engine` 的 TypeScript 源码作为**实现证据**。`E:\rea\codex-src` 中的前端
bundle 已压缩且没有 sourcemap，因此可以确认协议边界和组件行为，但不能据此推断
Codex 的原始变量名、服务端实现或未出现在 bundle 中的功能。以下差距以当前工作区代码
为准；截图中显示旧 JSON 或跳动顺序的现象还需要用当前构建复现。

## 证据索引

| 范围                   | 证据                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex 任务事件         | `E:\rea\codex-src\webview\assets\task-events-95f1d6116c3c.js`：WebSocket 事件、`event_id` 去重、身份字段、订阅/断开状态和固定事件缓存                                                      |
| Codex 线程摘要/子代理  | `E:\rea\codex-src\webview\assets\thread-summary-panel-components-508d0e99665c.js`、`local-conversation-thread-70abb87ab9c8.js`：摘要分组、子任务入口、状态/错误/不可用提示                 |
| Codex 长列表           | `E:\rea\codex-src\webview\assets\virtualized-turn-list-93f4162a687b.js`：可视区渲染、`ResizeObserver` 和合帧布局；同一 bundle 还包含按 observer 生命周期启停采集的逻辑                     |
| Codex 读取策略         | `E:\rea\codex-src\webview\assets\app-initial-b8e1c8014bb4.js` 及相关 local-conversation bundle：cursor 分页、`useInfiniteQuery`、`AbortSignal`、有限重试和 stale time                      |
| Aether 子代理契约      | `src/shared/subagent.ts`、`src/renderer/src/core/engine/subagent-state.ts`：schema v1/v2、`seq/baseSeq`、identity、coverage、delta gap 和冲突校验                                          |
| Aether 子代理缓存/读取 | `src/renderer/src/core/engine/subagent-store.ts`、`src/renderer/src/contrib/work/work-subagent-transcript.ts`：generation/epoch、LRU、并发上限、游标分页和大小上限                         |
| Aether 稳定排序        | `src/renderer/src/contrib/work/work-subagents.ts`：按首次持久化时间、`childSessionId` 合并续跑、运行中/已结束状态                                                                          |
| Aether 错误展示        | `src/renderer/src/contrib/work/WorkErrorNotice.tsx`、`src/renderer/src/core/engine/root-run-state.ts`、`src/renderer/src/contrib/work/WorkView.tsx`                                        |
| Aether 监控页          | `src/renderer/src/contrib/work/EngineMonitorView.tsx`、`src/renderer/src/contrib/work/work.css`、`docs/engine-monitor-design-2026-10-15.md`                                                |
| Aether 引擎协议/协作   | `D:\dev\ai-agent-engine\src\api\http\routes\subagent.ts`、`routes\collaboration.ts`、`api\http\chat-subagent-protocol.ts`、`core\collaboration\{store,delivery-schema,execution-owner}.ts` |

## 总体判断

Aether 在**单个子代理的耐久状态正确性**上已经比解包可见的 Codex UI 更严格：它有
显式 sequence、身份字段、覆盖范围和 generation/epoch 护栏，并会拒绝序列间隙、同序列
冲突和迟到引擎响应。Codex 的优势更多体现在**统一的用户级事件流、成熟的消息界面、
可视区渲染和错误恢复体验**。

两边目前的主要差距不是“能否显示一个子代理”，而是：Aether 需要把已有的严格协议
投影成稳定、可解释且低开销的产品界面；Codex 式事件流、心跳、资源指标和协作健康摘要
还没有在 Aether 引擎端形成一个统一契约。监控页应继续只显示真实快照，不能用前端时间或
猜测值伪造 CPU、RSS、心跳和 ACK。

## 多维度对比

### 1. 事件流、顺序和状态一致性

**Codex 可观察到的做法。** `task-events` bundle 建立用户级 WebSocket 事件订阅，事件带
`accountId/userId` 边界和 `event_id`，客户端做去重，并保留固定大小的事件 ring buffer。
事件还区分订阅、断开和恢复状态，任务状态按 `emitted_at` 等时间字段整理，而不是按
React 收到消息的顺序直接覆盖。固定缓存避免长任务把整个事件历史留在 renderer 中。

**Aether 当前实现。** `subagent-state.ts` 的 v2 delta 只接受精确的
`baseSeq === previous.lastSeq` 和 `seq === previous.lastSeq + 1`；发现 gap 会返回可恢复
状态，发现 identity、同序列标量或工具 revision 冲突会拒绝事件。v1 完整快照可桥接旧协议，
`coverage` 表示视图是否完整。`subagent-store.ts` 另外以引擎 `source`、本地 generation、
server generation 和 epoch 丢弃过期响应。

**差距和风险。** Aether 的严格性目前集中在“每个子代理运行”，没有与 Codex 类似的统一
用户级事件 envelope、全局 event id 去重和带 cursor 的重连 ring buffer。引擎重启时可以
保护 renderer 不被旧响应污染，但用户看不到“丢了多少事件、从哪个序列重新同步、当前快照
是否完整”的统一说明。多个订阅方也缺少同一事件源的共享水位。

**建议。** P1 在引擎/客户端之间定义有限字段的事件 envelope：`eventId`、`emittedAt`、
`streamGeneration`、`runId`、`seq`、`kind` 和 `coverage`；服务端保留固定 ring buffer，
断线后按 cursor 重放，无法重放时返回 `retention_gap` 并要求完整快照。renderer 继续采用
现有 per-run 校验，不把原始事件无限追加到 React 状态。

### 2. 子 Agent 排序和信息层级

**Codex 可观察到的做法。** thread summary 以稳定的摘要区块组织任务，显示活跃/完成
状态、角色或入口，并把详情作为可展开或可导航内容。排序不会因为每一次工具事件而把
用户正在阅读的条目搬走。

**Aether 当前实现。** `workSubagentGroups()` 按 `childSessionId` 合并续跑记录；组内按
最近运行信息选取展示内容，但组外排序使用首次持久化的 `createdAt/startedAt`，没有把
变化频繁的 `updatedAt` 作为主键。组还提供模型、角色、active 状态、工具摘要和详情入口。

**差距和风险。** 源码逻辑已经具备稳定排序，截图中仍出现顺序变化时，应先排查旧的
`out/` 构建、历史消息投影或绕过 `WorkErrorNotice` 的路径。界面层目前还可以更接近 Codex
的紧凑层级：将 active/completed 分组固定在同一列表位置，并增加真实的模型、运行时长、
最后工具、工具数、pending interaction、workspace 和 diff 摘要。排序依据和显示依据需要
分开，避免“最后活动最热”被误解为导航顺序。

**建议。** P0 用当前构建验证“事件更新不改变组位置、续跑不产生重复组”；P1 增加固定的
active/completed 分组和信息字段；字段缺失时显示“未知”，不要使用前端推断替代引擎事实。

### 3. 错误语义和 Work 消息专业度

**Codex 可观察到的做法。** local conversation 中对任务不可用、恢复失败、写入冲突和
摘要面板渲染失败使用明确标题、说明和 Retry/Fork 等动作，错误不会把内部对象直接当作
主消息。错误恢复与“只读/不可交互”状态分开呈现。

**Aether 当前实现。** `WorkErrorNotice` 会解析 `[子任务状态]`，把状态、错误码、run ID
和原始诊断折叠到详情；`ENGINE_RESTARTED`、`EMPTY_OUTPUT`、上下文超限和输出超限有中文
解释，并限制诊断为 16KB。`WorkView` 已在消息、任务错误和工具详情使用该组件。

**差距和风险。** 旧历史记录或某个子代理投影路径仍可能直接显示 JSON，所以用户看到的
“错误消息”会像内部日志而不是可行动的产品错误。若错误码只存在旧记录文本中，解析失败时
应明确标为“诊断信息不完整”，不能误报为成功。错误还需要区分：引擎已重启、任务被取消、
用户需要授权、网络断开、模型无输出和真正的引擎故障。

**建议。** P0 对所有 Work 消息入口做统一错误投影审计，补一条当前 Electron 验证：原始
JSON 不出现在首屏，标题/摘要可读，详情可展开，状态为 interrupted/failed 时不能显示成功。
P1 为每类错误补可执行动作（重试、继续、重新发起、打开诊断），并保留 run/engine identity
作为排查依据。

### 4. 性能和长列表

**Codex 可观察到的做法。** `virtualized-turn-list` 只渲染可视区附近的 turn，使用
`ResizeObserver` 监测尺寸、`requestAnimationFrame` 合并布局变化，避免每条流式事件触发
完整列表重排。详情查询按 observer 是否存在启停，窗口失焦不盲目刷新；历史使用有限页和
`AbortSignal`，取消旧请求。

**Aether 当前实现。** 子代理视图有 `SUBAGENT_VIEW_MAX_TOOLS=64`、active 工具上限 32、
单视图 256KB 和缓存 4MB；store 限制目录数量、观察并发（2）和单轮刷新任务数。子代理
transcript 每页 50 条、最多 3 页窗口并限制 512KB；监控页每 lane 最多 24 项、计划最多
保留 64 项、指标只在用户点击时读取，页面隐藏时停止计划刷新。

**差距和风险。** 这些边界能控制内存，但还不是统一的 viewport virtualization 契约。
如果 Work 消息列表或工具详情在长任务中逐条挂载，事件越多，React reconciliation 和布局
成本仍会增长。频繁 timer、跨组件重复读取和没有 AbortSignal 的旧接口也可能让“监控”本身
拖慢任务。

**建议。** P1 对超过固定阈值的消息/工具列表采用 viewport 分页或虚拟化；所有读取接口
统一 `AbortSignal + source/generation + cursor`；只在页面可见且存在观察者时采样，保留固定
ring buffer。验收指标应包括 1 小时长任务的 renderer heap、长任务帧数、列表 DOM 节点数和
请求取消率。

### 5. 可观测性和监控页

**Codex 可观察到的做法。** 用户级 task event 状态、连接状态和有限事件缓存构成基础健康
信号；线程摘要把任务、子任务和详情入口放在同一上下文中。指标加载按需或在有 observer
时启用，避免后台采集无限增长。

**Aether 当前实现。** `EngineMonitorView` 显示 phase、PID、端口、版本/build、实例、
数据目录、运行时来源、Work/定时 lane 和任务状态；`EngineResourceHealth` 通过主进程 IPC
按需采样单个嵌入式引擎 PID 的 CPU、RSS/private、进程 I/O、宿主内存、数据磁盘和物理存储分类，
并以 Codex 风格的稳定进程表聚合可确认的后代进程、CPU/RSS/年龄/PID 和合计 I/O；进程表单独
使用 15 秒冷却、256 条候选上限和 PID 创建身份校验。健康卡片复用已有探针显示最近成功、
延迟与连续失败；`/cron` 低频按需刷新，`/metrics` 由用户点击读取业务统计，所有读取有
source/generation/identity 护栏。未知值仍显示不可用，不保存原始日志和无限事件历史。

**差距和风险。** 监控仍缺少 V8 heap、event-loop lag、root/child 最后活动、最后工具、idle duration、pending interaction、
协作消息/ACK 失败和 UI long-task。仅凭 `EngineSnapshot.updatedAt` 不能判断引擎健康，
它只表示最近一次状态变化。

**建议。** P1 在 engine observability service 提供固定字段、低频、无敏感正文的摘要：
`heartbeatAt`、连续失败、`eventLoopLagMs`、内存采样、active streams、任务最后活动和
工具摘要。P2 增加可见页面才订阅的短 ring buffer；原始请求体、凭据和全量日志只走轮转文件
和按需分页诊断。

### 6. 历史分页、回放和一致性

**Codex 可观察到的做法。** 归档/搜索使用 cursor 分页，单页数量有限；详情、turn 和 log
有不同的 stale time；查询传递 `AbortSignal`，401/403/404 等不可用结果变成有限空页，
不会无限重试或缓存无限历史。

**Aether 当前实现。** `work-subagent-transcript.ts` 使用 cursor，每页 50 条、最多 3 页，
并验证子代理归属和总字节数；`archive-pages.ts` 进行 revision 校验、消息 ID 去重、页大小
和总数一致性校验。`subagent-store.ts` 在读取期间检查 source/generation/epoch，旧引擎
响应不能覆盖新缓存。

**差距和风险。** Aether 目前存在多套分页形态（transcript、archive、subagent directory），
它们的 cursor、revision 和“无法继续读取”的错误语义并未完全统一。重启、压缩或 retention
gap 时，UI 需要明确显示“部分历史/需要重新同步”，不能把缺页拼成连续成功记录。

**建议。** P1 统一分页响应头：`items`、`nextCursor`、`revision`、`hasMore`、`coverage`、
`retentionGap`；客户端统一 AbortSignal、去重和 generation 检查。P2 对消息区实行 viewport
附近分页，详情只有用户展开时读取。

### 7. 安全、身份和请求隔离

**Codex 可观察到的做法。** 任务事件将 `accountId/userId` 与事件键绑定；线程使用
`hostId/threadId`，请求更新带 expected identity/assert-current 语义；作者冲突会显示只读、
重试或 fork，而不是让两个 writer 静默覆盖。

**Aether 当前实现。** 引擎 HTTP middleware 和 collaboration routes 对实例/账号做 admission；
认证层校验 JWT、OIDC state/nonce；子代理 identity 同时含 run、tenant、parent/root session、
conversation 和 child session。renderer store 在每次读取和写回前校验 expected engine、
source/generation/epoch，发现 identity 不一致或已删除运行会拒绝操作。

**差距和风险。** 现有 renderer→main `engineRequest` 仍应增加 sender/window 校验，避免只依赖
renderer 传入的 session/engine 字段。错误、日志和监控摘要还应确认不会泄露 token、完整请求体
或跨账号的任务标题。多窗口/远端引擎切换需要一条可见的 identity 变更信号，而不是静默清空。

**建议。** P0 为 engine IPC 加 sender/window 与当前实例绑定校验；P1 对所有任务、事件、历史
和协作请求执行同一 identity schema；P1 增加跨账号、重启、迟到响应、重复提交和 fork 冲突测试。

### 8. 独立任务、协作和冲突处理

**Codex 可观察到的做法。** local conversation 支持 background/side chat 入口；任务恢复失败、
writer conflict 和 fork 有单独界面语义。不同线程的读取和交互边界由 host/thread identity
隔离。

**Aether 当前实现。** engine 的 `core/collaboration` 已有 controller、delivery schema、
execution owner、SQLite/JSONL delivery 和 store；HTTP 有 collaboration route。子代理契约
使用 parent/root/child identity、continuation 和可恢复的 run，能够让独立 Work 任务各自运行，
同时为共享目标保留父子归属和续跑上下文。

**差距和风险。** “能并发运行”不等于“协作不会产生冲突”。当前监控页没有消息/ACK、nonce
mismatch、版本冲突、重叠写入、孤儿子任务和未解决证据等摘要；UI 也没有把独立任务和共同
目标的协作边界展示出来。定时任务应保持独立 lane，不能误并入人工协作链。

**建议。** P1 为协作消息定义 `messageId/peerId/parentRunId/nonce/revision/ack` 和幂等键，
对重复、乱序、过期和错误 peer 明确拒绝或重试；P1 在任务详情和监控页只显示计数、最后活动
和冲突摘要，不把完整协作正文长期驻留。P2 增加“独立任务 / 协作任务 / 定时触发”的过滤器
和冲突诊断入口。

## 引擎与客户端差距清单

| 领域          | Aether 已具备                                         | 尚需补齐                                           | 优先级 |
| ------------- | ----------------------------------------------------- | -------------------------------------------------- | ------ |
| 状态正确性    | seq/baseSeq、identity、coverage、gap/conflict 拒绝    | 统一事件 envelope、重连 cursor 和 retention gap UI | P1     |
| 子 Agent 列表 | childSession 合并、创建顺序稳定、按需详情             | Codex 式 active/completed 固定布局和更多真实属性   | P0/P1  |
| 错误体验      | 结构化 WorkErrorNotice、错误码和折叠诊断              | 清理所有绕过路径、可行动恢复按钮                   | P0     |
| 历史与内存    | 多层上限、LRU、cursor、revision 去重                  | 统一分页合同、viewport 虚拟化                      | P1/P2  |
| 引擎监控      | phase/identity/任务 lane、CPU/RSS/private/I/O、磁盘、存储分类、受限进程树、按需 metrics/cron | heartbeat、V8 heap、事件循环与 UI 性能信号         | P1     |
| 安全隔离      | engine generation、run identity、JWT/OIDC、协作 owner | IPC sender/window 校验、跨窗口身份切换测试         | P0/P1  |
| 协作          | parent/root/child、delivery/store、continuation       | ACK/nonce/revision 冲突摘要和可审查证据            | P1     |

## 建议的验证顺序

1. 先用当前源码执行 `npm run typecheck`、`npm run build`，确保验证的确是当前产物，不要用
   旧 `out/` 推断排序或错误展示。
2. 用一套新的 Electron/Playwright 场景建立 3 个独立 Work、1 个共同目标协作 Work 和 2 个
   定时任务；每个任务使用独立 session/workspace，协作任务只通过明确的 parent/child 和
   message id 通讯。
3. 在 1 小时运行期间注入工具事件乱序、重复事件、短暂断开、引擎重启、旧响应迟到、空输出、
   上下文超限和取消。验证：列表位置不跳、续跑不重复、错误首屏不显示原始 JSON、旧引擎响应
   不覆盖新引擎、定时任务不会混入协作链。
4. 同时采集 renderer heap、DOM 节点数、长任务帧、请求数量/取消数、引擎 RSS/heap（若引擎
   提供）和页面隐藏后的刷新次数；超过固定阈值时应截断、分页或停止观察，而不是继续增长。
5. 把问题分为协议/引擎、投影/客户端和测试环境三类。协议问题先记录 run/stream identity
   与 sequence，UI 问题记录可复现的当前构建和截图，环境问题（例如 pty 不可用）单列，不能
   用放宽断言掩盖真实失败。

## 结论

Aether 不需要照搬 Codex 的 UI bundle；应保留自身更严格的子代理状态协议，再补齐 Codex 已
验证有效的事件流、可视区渲染、稳定错误恢复和请求取消边界。短期先解决旧产物/绕过错误投影
导致的用户可见问题，并用当前构建完成长任务验证；中期把 heartbeat、资源、协作 ACK 和
分页 coverage 做成真实的引擎摘要；长期再扩展可见事件历史和更全面的监控详情。这样“更全面”
建立在可验证的状态与性能边界上，而不是把无限日志搬进页面。
