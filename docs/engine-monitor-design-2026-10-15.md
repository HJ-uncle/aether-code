# Aether 引擎监控页设计

## 已落地的 MVP

Work 模式新增「引擎监控」页。它复用现有 `EngineSnapshot` 推送和 Work 本地任务状态，展示引擎 phase、PID、端口、版本/build、实例、数据目录、运行时来源、错误，以及 Work/定时任务两条 lane。任务列表最多渲染 24 项；页面不订阅原始引擎日志、不保存事件历史，只用已有快照和 30 秒时间刷新，因此可以长时间打开。

入口和实现：

- `src/renderer/src/contrib/work/EngineMonitorView.tsx`
- `src/renderer/src/contrib/work/WorkView.tsx`
- `src/renderer/src/contrib/work/work.css`

## 从 Codex 拆出的可复用原则

这次对照的是解包产物 `E:\rea\codex-src\webview\assets\app-initial-b8e1c8014bb4.js`。虽然变量名已经压缩，仍能确认几条具体边界：任务列表查询使用一分钟级 `staleTime`；任务详情、turn 和 log 使用五秒级 stale time；归档任务使用 `useInfiniteQuery` 按 cursor 分页、每页 20 项，并在 `queryFn` 中转发 `AbortSignal`；搜索最多读取有限页数，遇到 401/403/404 转为空页而不是缓存无界历史。创建和变更请求带 `assertRequestCurrent` 与 expected identity，避免旧响应覆盖新引擎/账号。

Aether 采用同一类边界，但将刷新频率再降到 30 秒，因为监控页同时展示本地 Work 状态和引擎身份。后续若增加详情扫描，应保持“摘要快照常驻、按需分页读取原始数据、请求带 AbortSignal 和 generation/identity 校验”的结构；不要把 JSONL、replay 或整段事件历史放进 renderer 状态。

还可以直接借鉴两个性能细节：Codex 的 usage 查询默认关闭窗口聚焦重取、限制重试，并在 `select` 阶段把按日数据整理成连续序列；load metric 只有存在 observer 时才激活，最后一个 observer 释放后在 microtask 中停采集。长历史则按 viewport 附近边界加载，队列去重并用 generation 防止旧页面回写。Aether 的后续内存、事件和协作详情应采用同样的 observer 生命周期、固定 ring buffer、viewport 分页和 generation 守卫。

Aether 后续扩展应沿用这些边界：主进程维护紧凑快照，渲染层只接收摘要；进程/V8 指标按 30–60 秒采样并保留固定 ring buffer；昂贵的数据库、JSONL、replay 和 workspace 扫描只在用户刷新或扫描进行中运行；列表分页/虚拟化；所有异步读取绑定 AbortSignal、请求序列和 engine generation；默认只读，清理动作必须再次验证引擎身份、时间戳和归属。

## 下一阶段的扩展面

在不改变 MVP 更新频率的前提下，可以把下面的摘要挂到主进程 observability service：

1. 健康：最近探测时间、连续失败次数、restart generation、owned/adopted 状态。
2. 压力：RSS/private/heap/external、active streams、replay bytes、projection slots、event-loop lag 和固定窗口斜率/峰值。
3. 任务：root/child、model、workspace、pending interaction、最后工具和 elapsed/idle 时间。
4. 协作：消息/ACK、nonce mismatch、错误 peer、版本冲突、重叠写入和未解决证据。
5. 资源：数据库、JSONL、replay、workspace、artifact、diagnostic 占用及可审查清理候选。
6. UI：renderer crash、long task、timer lag、导航耗时和最近一次审计结果。

原始事件、请求体和凭据不应进入监控快照；需要诊断时保留在轮转文件中并以分页详情按需读取。这样监控本身不会成为长任务的额外内存保留链。
