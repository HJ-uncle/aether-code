# PMO 私有 staging 的只读不变量观察器

辅助测试已经准备，**尚未在真实 runner 启动**。不改产品，不请求引擎或 UI，不连接新实例，不暂停模型。使用现有 runner PID **9080**、当前 PMO root **b459b097-fc3b-432f-aba4-8bfaf442e18e**。

由 root 决定启动时，通过既有 `.e2e-tmp/recover-owned-office-runner.mjs` 加载下面三个自包含 `recover(c)` 入口；不要直接运行 campaign 主程序：

| 操作 | 准备好的入口 |
|---|---|
| 启动 | `D:/dev/aether-code/.e2e-tmp/start-owned-office-invariant-observer-v004.mjs` |
| 查询 | `D:/dev/aether-code/.e2e-tmp/query-owned-office-invariant-observer.mjs` |
| 停止 | `D:/dev/aether-code/.e2e-tmp/stop-owned-office-invariant-observer.mjs` |

启动固定本轮 campaign、PID 和真实 admission；立即返回 preparing，不等待文件核验。查询只读内存摘要，看到 watching 才表示初始化已完成。停止立即返回 stopping，后台完成终验后查询返回 stopped 和最终报告路径。重复启动被拒绝；停止幂等，不修改 runner 的命令队列、UI 选择或既有监控。

**在私有 staging 结束、root 授权正式发布之前停止本观察器。** 本观察策略不允许 published/inputs 任何新增或改写，授权发布也会被如实记录为该策略的变化。它不自动判断授权、不自动停止模型，也不会把后续发布排除为“预期变化”。

仅创建两个 `fs.watch({recursive:true,persistent:false})`，分别监听 `company/published` 与 `company/inputs`；不监听整个 company、磁盘或大目录，不做周期全树轮询。200 ms 短去抖合并同路径事件，串行读取真正有通知的路径，记录新增、删除、字节改写、metadata 变化及实际 SHA/mtime。空文件名、路径越界、未知瞬态事件、读取中变化或能力错误均记录覆盖缺口，不猜测成功。符号链接/目录别名不跟随。

以 `evidence/independent-audit/rejected-v003-preservation.json` 为保全基线，记录其真实 SHA。在初始化和停止各完整核验一次全部 **444** 个受保护文件（本轮合计 **25,229,909** 字节，含私有历史文件）。初始化/停止各枚举一次两个监听树，停止时发现没有收到通知的新增文件仍记录并核 SHA。新私有 staging 文件允许存在，但旧私有保护文件在终验时不得改变。

上限：2,048 条明细、512 条待处理路径、4,096 个跟踪路径、8,192 个目录条目、4,096 次事件触发读取；事件触发总 hash 字节 256 MiB，每次完整审计 512 MiB，单文件 64 MiB。计数聚合不复制业务正文；超过上限保留 dropped/error 信号，不能判完整。只有一个事件处理 drain，无并行文件哈希或不断排队的 drain Promise。默认运行 **60 分钟**后自动停止；最大允许 2 小时。显式停止、自动期限、初始化失败与 watcher 错误均关闭 watchers/timers。

只写当前 campaign 的新 `evidence/invariant-watch-<时间>-<随机值>/`：

- `events.jsonl`：有界变化明细，保留预期/实测 SHA、字节数、mtime、事件合并计数。
- `result.json`：初始化报告及最终报告；运行中最新计数使用 query，变化明细查看 journal。

最终状态只有 `violation-observed`、`incomplete`、`no-change-observed`，没有“安全隔离通过”。明确标注 watcher 启用/关闭时间；观察开始晚于模型根启动，无法证明前段没有变化。`fs.watch` 可能丢事件，终验能捕获仍存在的字节/目录差异，不能重建已经恢复原状的瞬态写入。整个过程不是原子文件系统快照或 OS 防护。

验证：`node --test scripts/__tests__/office-invariant-observer.test.mjs`，**13/13 通过，无跳过**。仅在 `.e2e-tmp/invariant-observer-*` 临时夹具运行，涵盖真实 recursive fs.watch、增删改、私有 staging、丢事件终验、1000 次通知合并、上限、空/越界路径、baseline 改写、watcher 初始化/运行错误、自动期限、资源清理和 admission 拒绝。未启动真实 company 观察器，未运行 npm typecheck/build，避免与父任务整体构建并发。
