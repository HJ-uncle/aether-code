# Aether 引擎监控页设计

## 已落地的 MVP

Work 模式新增「引擎监控」页。它复用现有 `EngineSnapshot` 推送和 Work 本地任务状态，展示引擎 phase、PID、端口、版本/build、实例、数据目录、运行时来源、错误，以及 Work/定时会话两条 lane。任务行是可键盘访问的按钮，可以回到任务并继续查看现有的子 Agent 面板；每条 lane 最多渲染前 24 项。

监控页还会在页面可见且引擎就绪时低频读取实际 `/cron` 计划，单次只保留前 64 项、界面展示前 24 项，并将计划启用状态、计划表达式、上次/下次运行时间与本地会话分开显示。计划读取每 30 秒最多发起一次，页面隐藏或离开监控页时停止；引擎切换和迟到响应由 source generation 丢弃。当前 `/cron` 接口没有分页，超过 64 项时界面会明确标记为截断。

资源与健康卡片通过主进程 IPC 读取真实引擎数据：嵌入式引擎每 5 秒按需采样单个引擎 PID 的 CPU、RSS/private memory、进程读写计数与速率，同时显示宿主内存、数据磁盘容量、健康探针延迟/连续失败和桌面活动流。进程区块按 Codex Processes 面板的语义显示引擎主进程及可确认的后代进程，提供稳定的父子层级、PID、年龄、CPU、RSS 和合计 I/O；Windows 进程表枚举单独采用 15 秒冷却，最多保留 256 个候选、界面最多渲染 24 行，排除命令行参数以避免把凭据带入 IPC。PID 创建时间不一致时丢弃缓存，防止 PID 复用把旧子进程挂到新引擎上。存储目录按 60 秒冷却扫描，限制文件数、深度和耗时，并按数据库、会话、memory、snapshots、备份、日志、缓存和其他文件分类。远端引擎或系统拒绝进程读取时显示不可用原因，不把未知值写成 0。

请求数、Token 总量和工具耗时/成功率仍通过用户点击读取 `/metrics`，现在标为“业务统计”，不与 OS 资源健康混为一谈。

页面不订阅原始引擎日志、不保存事件历史；已有引擎快照推送和 Work 状态探测继续由全局单例负责。页面采用浅色/深色各自定义的 Apple 系统灰阶，卡片使用令牌化圆角、细描边、层叠阴影和可降级的毛玻璃材质；列表保留键盘焦点、悬停反馈、窄屏横向滚动和 `prefers-reduced-motion` 边界。引擎的 `updatedAt` 表示最近一次状态变化，不等同于健康探针心跳，界面按此语义标注。

入口和实现：

- `src/renderer/src/contrib/work/EngineMonitorView.tsx`
- `src/renderer/src/contrib/work/EngineResourceHealth.tsx`
- `src/main/engine/diagnostics.ts`
- `src/shared/engine-diagnostics.ts`
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
2. 压力：V8 heap/external、active streams、replay bytes、projection slots、event-loop lag 和固定窗口斜率/峰值。当前 UI 已聚合可确认的引擎后代进程，后续再接入引擎自身的运行时指标。
3. 任务：root/child、model、workspace、pending interaction、最后工具和 elapsed/idle 时间。
4. 协作：消息/ACK、nonce mismatch、错误 peer、版本冲突、重叠写入和未解决证据。
5. 资源：数据库、JSONL、replay、workspace、artifact、diagnostic 占用及可审查清理候选。
6. UI：renderer crash、long task、timer lag、导航耗时和最近一次审计结果。

原始事件、请求体和凭据不应进入监控快照；需要诊断时保留在轮转文件中并以分页详情按需读取。这样监控本身不会成为长任务的额外内存保留链。
