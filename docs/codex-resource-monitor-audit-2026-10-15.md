# Codex 资源监控审计与 Aether 对标

审计日期：2026-10-15。依据为用户提供的 `E:\rea\codex-src\` 解包文件。它包含打包后的 Electron / Webview 代码，不包含完整 Rust app-server 源码。本文只把能够从这些文件直接确认的行为写为事实；未检出某项指标不等于产品所有运行时均不支持该指标。

## 结论

用户截图中的 Aether 页面主要是引擎身份、连接状态和任务概况。这些信息有诊断价值，但不足以回答“引擎用了多少 CPU、内存、磁盘空间和 I/O”。健康状态、资源消耗、任务业务状态应分别展示，不能用 PID、端口、版本和任务数量代替资源指标。

Codex 的可对标实现已经确认有三层：

1. 侧栏 RAM 摘要：汇总 Codex、app-server 和后代工具进程的 RSS，悬浮显示分类。
2. Processes 明细面板：CPU、RSS、PID、存活时间，按进程组筛选和按命令合并。
3. Storage 设置页：真实扫描 Codex home 内的文件大小，按会话、子代理、归档、未分类会话、工作树和其它文件分组。

另有内部性能快照和 app-server stdio 吞吐计数。后者是引擎通信流量，不能标为操作系统磁盘 I/O。此次在解包 JS 中尚未定位到 OS 级磁盘读写字节 / IOPS 的实现证据，不能据此断言 Codex 完全没有该能力。

## 证据定位方式

下面的 offset 为使用 Node `String.indexOf()` 得到的 **0 起始 UTF-16 字符位置**，不是字节偏移。压缩文件一行往往包含数千至数百万字符，因此同时提供可搜索的锚点。

| 文件                                                                   | 行 / offset            | 搜索锚点                                             | 已确认用途                                          |
| ---------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `E:\rea\codex-src\webview\assets\app-initial-b8e1c8014bb4.js`          | 行 3654 / 7,217,977    | `function NNo()`、`toggle-ram-usage-indicator`       | RAM 入口，仅允许调试菜单的构建开启                  |
| 同上                                                                   | 行 3654 / 7,218,450    | `function FNo(e)`、`debug.sidebarRamUsageIndicator`  | RSS 总量和分类 tooltip                              |
| 同上                                                                   | 行 3654 / 7,223,018    | `function INo(e)`、`process-memory`                  | RAM 查询间隔与后台策略                              |
| `E:\rea\codex-src\webview\assets\panel-afbc3265e2df.js`                | offset 128,200–138,900 | `debug-child-processes`、`getChildProcessesSnapshot` | Processes 明细表、筛选、排序、详情                  |
| `E:\rea\codex-src\.vite\build\main-BklS_2Y2.js`                        | 行 1054 / 2,592,749    | `CHe=class`、`getChildProcessesSnapshot`             | 进程树 RSS 服务、缓存和请求合并                     |
| `E:\rea\codex-src\.vite\build\src-BJv5Mk7n.js`                         | 行 696 / 1,259,891     | `var xB=`、`function MB`、`function IB`              | 跨平台进程快照和后代关系                            |
| 同上                                                                   | 行 696 / 1,261,652     | `function VB(e,t)`                                   | Windows 进程 CPU 增量计算                           |
| 同上                                                                   | 行 698 / 1,263,941     | `function KB(e)`                                     | app-server / Electron / MCP / git / shell 分类      |
| `E:\rea\codex-src\.vite\build\main-BklS_2Y2.js`                        | 行 1021 / 2,018,850    | `Rje=class`、`collectSnapshotFields`                 | Electron 内存、CPU、系统和后代进程性能快照          |
| 同上                                                                   | 行 1021 / 2,030,492    | `Xje=class`、`requestAppStateSnapshot`               | 30 秒快照心跳、焦点检查和触发限流                   |
| `E:\rea\codex-src\.vite\build\application-network-startup-CfAQmSYg.js` | 行 23 / 108,563        | `var $a=3e4,eo=class`、`trackWritten`                | app-server stdio 30 秒窗口吞吐                      |
| `E:\rea\codex-src\.vite\build\main-BklS_2Y2.js`                        | 行 436 / 527,932       | `hue=class`、`Storage scan incomplete`               | 存储扫描服务                                        |
| 同上                                                                   | 行 1301 / 3,302,950    | `this.deviceStorage=new`                             | 服务接入执行目录、thread list/read 和 storage-cache |
| `E:\rea\codex-src\webview\assets\device-storage-c982655126d4.js`       | 行 1 / 17,806          | `function nt(e)`、`device-storage`                   | 存储页查询与刷新                                    |
| 同上                                                                   | 行 1 / 23,081          | `function rt(e)`                                     | 仅扫描进行时每秒读取进度                            |
| 同上                                                                   | 行 1 / 23,248          | `ot={threads:`                                       | 六类存储图例和语义                                  |

## RAM 与 Processes 的真实协议

主进程的 `processMemory` 服务暴露两个方法：

```ts
getSnapshot(): Promise<{
  mainProcess: { pid, command, ageSeconds, cpuPercent, rssKb },
  codexAppRssKb,
  appServerRssKb,
  rolloutChildProcessesRssKb,
  otherChildProcessesRssKb,
  processCount,
  totalRssKb
}>

getChildProcessesSnapshot(): Promise<上述摘要 & {
  childProcesses: Array<{
    pid, parentPid, depth, rootChildPid,
    command, kind, ageSeconds, cpuPercent, rssKb
  }>
}>
```

字段名和关系来自 bundle；此处为便于阅读的协议形状，省略了数字的完整 TypeScript 类型。CPU、RSS 或进程创建时间可能不可得。Codex 的表格把未知 CPU / RSS 显示为 `—`，没有伪造为零。

`totalRssKb` 由四部分相加：`codexAppRssKb + appServerRssKb + rolloutChildProcessesRssKb + otherChildProcessesRssKb`。`codexAppRssKb` 包括主进程和 Electron helpers。rollout 类通过沿 `parentPid` 追溯到 app-server 判断，不只根据进程名称判断。UI 明确说明“共享内存可能被多次计数”，因为相加 RSS 不是物理内存去重后的精确总量。

Processes 表的列为 `Command / Count / CPU / RSS / PID / Age`。按命令合并时显示 Count，逐进程时显示 PID 和 Age。默认按 RSS 降序，可点击列头改变排序，完整命令放入按需打开的详情对话框。筛选组为 Main、App windows and helpers、App Server、Rollout child processes、Other。

### CPU 计算与进程身份

Windows 进程列表通过 native provider 的 `listProcesses()` 取得；`bootstrap-487kJHw_.js` offset 443,077 的 `nk()` 注册该 provider，并加载 `native/windows-account.node`。本文未反编译该原生模块。

`src-BJv5Mk7n.js` 的 `VB()` 保存 `{cpuTimeMs, creationTimeMs, observedAtMs}`，用累计 CPU 时间差 / 墙钟时间差 × 100 计算百分比。同一个 PID 的创建时间改变时舍弃上一基线，避免 PID 复用造成错误增量；第一次观察返回未知，缓存上限 4,096 个 PID。这种百分比是单核时间口径，多核并行时可能超过 100%，产品必须明确口径，不能直接把超出 100% 当错误。

非 Windows 平台先用 `ps -ax -o pid=,ppid=` 发现后代，再按最多 200 个 PID 一批读取 CPU、RSS、启动时间和命令。命令设置 2 秒超时、输出上限，不是无边界逐进程 spawn。

### 性能边界

- RAM 摘要和明细都使用 5 秒刷新 / staleTime，`refetchIntervalInBackground: false`、`retry: false`。
- `CHe` 在主进程有 5 秒缓存；`snapshotPromise` 合并同时到达的采样请求。
- `getSnapshot()` 去掉完整 `childProcesses` 数组，摘要入口不传输整棵进程树。
- Processes 容器设置 `unmountChildrenWhenClosed: true`，收起后卸载采样子组件。
- 命令和单个进程详情按点击显示。这里的 Processes 表实现使用数组映射；本次没有发现该表采用虚拟列表，不能把其它历史列表的虚拟化归于这个表。

## 内部健康 / 性能快照

`Rje.collectSnapshotFields()` 同时读取：

- 主进程：`main_process_rss_bytes`、`main_process_heap_total_bytes`、`main_process_heap_used_bytes`、`main_process_external_bytes`、`main_process_array_buffers_bytes`、`main_process_cpu_percent`。
- 当前 renderer：`renderer_process_cpu_percent`、`renderer_process_working_set_kb`、peak / private / shared 相关字段。
- renderer 总量：进程数量、webContents 数量、working set 总量和相对上次变化；按内存列出 Top 5。
- 系统：可用 / 总内存、commit total/limit、paged/nonpaged pool、句柄 / 进程 / 线程数量、uptime，视原生能力可得性而定。
- 后代进程：数量、RSS 总量、直接子进程量、最大深度、分类与 Top 5。`collectSnapshotFields()` 中这条额外扫描在 Windows 被跳过；不要据此混同于独立 `processMemory` 服务不支持 Windows。
- 主线程卡顿：100ms 轻量 tick，只累计超过 900ms 的延迟，单次快照最多记 10 次，系统 suspend/resume 会重设基线。

`Xje` 每 30 秒请求应用状态快照；通常仅主窗口聚焦时发起心跳。非心跳触发有 5 秒最小间隔，request ID 有 60 秒 TTL，响应核对请求 ID 和 webContents，窗口销毁会停止对应采样。CPU span 通过前后累计值计算平均值，同时核对 renderer PID 与创建时间。

这些是诊断字段和内部遥测，不能仅凭它们推断 Codex 存在一个面向所有用户开放的“全部资源健康大屏”。已经确认可见的是前述调试 RAM 入口与 Processes 面板。

## I/O 证据及语义边界

Codex 的 `eo` 计数器在通信读写路径调用 `trackRead(bytes)` / `trackWritten(bytes)`，保留总量和最近 30 秒的按秒桶：

```ts
{
  ;(bytesReadTotal, bytesWrittenTotal, bytesReadLast30s, bytesWrittenLast30s)
}
```

快照输出字段为 `app_server_stdio_bytes_read_total`、`app_server_stdio_bytes_written_total`、`app_server_stdio_bytes_read_last_30s`、`app_server_stdio_bytes_written_last_30s`。按秒桶会修剪旧数据，内存不随运行时长持续增长。

这是 Electron 与 app-server 之间的 stdio 协议流量，不是 app-server 文件读写量，也不是网卡吞吐。Aether 若显示 HTTP / SSE 字节，应同样标注为“引擎通信”。用户要求的磁盘 I/O 应由操作系统进程计数器采样，显示累计读写和窗口速率；采样不可用时展示原因，不能拿通信字节补位。

此次对解包 JS 搜索 `resourceUsage / ioCounters / readTransferCount / ReadTransferCount / ioReadBytes / ioWriteBytes / io_read / io_write` 等未定位到 OS 级磁盘 I/O 实现。原生与 Rust 运行时未在此审计范围内，因此结论只限“当前已审计文件尚未找到”。

## Storage 页真实数据与成本控制

服务状态形状为：

```ts
{
  status: "scanning" | "ready" | "error",
  measuredAt: number | null,
  completedCategories: string[],
  usage: null | {
    codexHome: string,
    totalBytes: number,
    categories: Array<{ category, bytes }>,
    threadBytes: Record<string, number>
  }
}
```

分类是：

| 类别           | 依据与含义                                             |
| -------------- | ------------------------------------------------------ |
| `threads`      | 主会话的 rollout 文件；来源于 app-server thread 元信息 |
| `subagents`    | 未归档子代理的 rollout 文件，依据 `source.subAgent`    |
| `archived`     | `archived_sessions` 下 rollout 文件，包括已归档子代理  |
| `unclassified` | rollout 文件存在，但元信息不能确认会话 / 子代理身份    |
| `worktrees`    | Codex home 内 Git 工作副本目录                         |
| `other`        | 其它文件，包括数据库、日志、缓存等                     |

扫描的是 `stat.size` 汇总，不是磁盘分配簇大小、压缩后物理占用或整块磁盘容量。逻辑分类依据 rollout JSONL 与元信息，并不是把数据库内部逻辑记录大小拆分后相加。

存储服务 `read()` / `refresh()` 启动后台测量；正常 `read()` 触发受扫描结束后 60 秒冷却保护，显式 `refresh()` 会取消旧扫描并开始新扫描。存储页设置 60 秒 staleTime、不在窗口聚焦时自动 refetch；仅在 `scanning` 时每秒读一次状态，完成后停止此轮询。

磁盘遍历每批最多并发 32 个路径，不跟随符号链接 / reparse 到其它目录，忽略扫描过程中已经删除的 ENOENT，支持 AbortSignal。thread 元信息按 archived / 非 archived 两路 cursor 分页，每页 100；未知 rollout 身份恢复最多并发 8 个 thread/read。首扫增量显示节流到至少 250ms，已有缓存时保留旧总量直至分类完成，避免反复抖动。

缓存按 Codex home 哈希命名，schema version 为 3，存于 `userData/storage-cache`，使用临时文件 + rename 写入。UI 区分“已测量部分”“更新中”“不完整”“测量失败”，保留可用缓存，不把未完成扫描显示为完整正确总量。

清理旧会话另有安全流程：完整分页获取清单、包含后代、排除 active / ephemeral、删除前重新核对 updatedAt 和后代集合，发生变化的跳过。这个流程与资源监控分离，不能在打开监控页时自动触发清理。

## Aether 本轮应对齐的边界

当前 Aether 正在实现的范围是 **单个引擎 PID 资源采样 + 引擎健康 + 数据目录物理文件分类**，可以立即回答引擎进程的 CPU、RSS、进程 I/O，以及数据库 / 日志 / 缓存等文件占用。这是实际功能范围，不等于已经完成 Codex 全套资源能力。

| 维度           | Codex 已确认行为                                               | Aether 本轮范围与剩余差距                                              |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 引擎 CPU / RSS | app-server 与后代工具、Electron 分层，CPU 有进程身份基线       | 先覆盖当前引擎 PID；必须防 PID 复用、首采样未知、重启后重置            |
| 进程树总量     | parentPid 追踪、rollout 归组、摘要与详情两接口                 | 尚无完整后代 / 工具进程树总量，不能把单 PID 称为总引擎负载             |
| 客户端负载     | main / renderer 的 CPU、heap、working set、系统内存、jank      | 本轮不宣称已补齐 heap、事件循环 / 主线程延迟等内部诊断                 |
| 磁盘占用       | home 范围 stat.size、rollout 身份分类、缓存与渐进进度          | 先做物理目录 / 文件分类；尚无 SQLite 内部按会话 / 子代理的逻辑归属统计 |
| I/O            | 已确认 app-server stdio 吞吐；OS 磁盘 I/O 尚未在本次文件中定位 | 应明确进程 OS I/O 与 HTTP/SSE 通信口径；未采集字段不显示为零           |
| 健康状态       | 连接、请求快照、内存诊断、卡顿诊断分开                         | “连接就绪”只表示可响应；资源异常、采样失败、任务失败需分别表达         |
| 采样开销       | 5 秒缓存 / 合并、后台停刷、明细卸载、存储按需慢扫              | 资源可见才 5 秒采样；磁盘扫描与快照分开，不能每 5 秒递归扫描目录       |

建议资源页优先展示四项：引擎 CPU、驻留内存、数据目录占用、进程读写速率；其后是带采样时间与状态的健康摘要、存储分类条和按需进程诊断。PID、端口、运行时、目录、版本保留在可展开的身份详情中。阈值判定应基于真实能力、持续窗口与明确口径，避免用一个“绿色就绪”掩盖采样失败或资源压力。
