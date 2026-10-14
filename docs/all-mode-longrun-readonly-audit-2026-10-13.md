# 全模式持续运行与子代理事件只读审计（2026-10-13）

## 结论与范围

目标是所有模式中的有效任务不因人为规定的总时长、步数、累计 Token 或等待次数提前结束。当前源码的产品默认路径已基本取消这些总量上限，但仍有配置可恢复硬停止，以及连接恢复、调度等待、历史传输与快照完整性问题。不能宣称“所有限制全部清除”或“已达到 7×24 稳定运行”。

本轮检查客户端与同级引擎源码、既有失败轮证据，并在内存中加载生产纯函数复现快照缺陷。未修改产品代码、冻结候选、测试驱动或失败记录；未构建，未启动 Electron、引擎或新压力测试，未占用测试端口。本文件是报告。

## 默认运行上限已经取消的路径

| 入口 | 当前源码行为 | 位置 |
| --- | --- | --- |
| 主 Chat / Code / Work | 默认迭代 Infinity；主请求累计预算为 Infinity | `D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:391`；`src/api/http/routes/chat.ts:845` |
| 旧环境设置 | `MAX_ITERATIONS`、`TOKEN_BUDGET`、`CMD_TIMEOUT_MS` 不再作为默认运行上限；设置 API 明确标记忽略 | `D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:130` |
| 子代理 | 旧 `maxSteps` 不再启用步数截断；默认无十分钟截止；fallback 预算 Infinity | `D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts`；`src/core/subagent/runner.ts:77` |
| 自动化 | 新任务默认不限时；引擎的 null / 0 不创建截止计时器 | `D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:1536`；`D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:58` |
| 客户端流 | Code / Work 均发送 durable；SSE 没有固定总超时 | `D:/dev/aether-code/src/main/engine/tool-profile.ts:10`；`src/main/engine/host.ts:541` |
| 旧客户端断线 | 未指定生命周期时，所有 profile 默认 durable | `D:/dev/ai-agent-engine/src/api/http/tool-profile.ts:16` |
| Flow | 上下文和策略不注入默认 tokenBudget / maxIterations | `D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-executor.ts:121` |

这些结论针对已读取的源码。旧远端部署不会因为客户端更新而自动采用新版引擎行为。

## 仍存在的限制与持续运行风险

以下除明确标注的独立复现外，均为源码路径核验，不是本轮新跑出的真实窗口或服务器故障复现。

| 项目 | 行为与影响 | 位置 |
| --- | --- | --- |
| 正值失败次数环境配置 | `MAX_CONSECUTIVE_FAILURES` 仍可恢复整任务次数硬停止，缺省为 Infinity | `D:/dev/ai-agent-engine/src/core/agent-loop/tool-progress.ts:7`；`src/core/agent-loop/react.ts:1506` |
| SSE 恢复最多三次 | 连续恢复失败超过三次后要求重开会话；没有 POST cancel，但界面停止自动跟随任务 | `D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:549` |
| 本地健康失败 | 连续三次失败后停止探测、中断客户端传输并进入 error，没有自动重新检查；远端已有无限退避重连 | `D:/dev/aether-code/src/main/engine/host.ts:475` |
| 本地进程退出 | 意外退出后仅设置 error，没有监督重启；不能将重启简单视为未完成操作可以重跑 | `D:/dev/aether-code/src/main/engine/host.ts:364` |
| 自动化仍可有限时 | 仍可选有限 timeoutSeconds；编辑旧任务的其他字段时会保留旧的正值 | `D:/dev/aether-code/src/renderer/src/contrib/work/WorkView.tsx:1578`；`D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:156` |
| Cron 正常等待被取消 | SSE 末状态为 waiting 时，消费器要求 succeeded 而抛错；调度器随后取消所属 run | `D:/dev/ai-agent-engine/src/scheduler/cron-stream.ts:41`；`src/scheduler/cron-scheduler.ts:169` |
| Flow 断线失去注册 | SSE finally 删除 activeFlows；执行器是独立异步任务，后续 stop 查不到该 run。属于静态生命周期风险，未在本轮网络复现 | `D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-routes.ts:108` |
| 队列恢复没有所有者筛选 | 构造时将全部 running 标 failed；多实例共享数据库时可能误判他人的活跃任务。单实例重启后的执行恢复也未提供续跑机制 | `D:/dev/ai-agent-engine/src/storage/task-queue/sqlite-queue.ts:39` |
| 非 Code 子代理窗口 | 使用父/子已知窗口的较小值作为本地 budget，可能压低具有更大窗口的子模型空间；这是请求上下文容量，不是累计用量 | `D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:248` |
| 管理请求 | 通用 HTTP 桥默认 120 秒，包含 utility/chat；会中断该调用，没有在此取消主任务 | `D:/dev/aether-code/src/main/engine/request-timeout.ts:4` |

内部显式 maxIterations、有限 RequestBudget、tokenBudget、子代理 deadline 和 attached 生命周期仍然有效；当前产品默认路径未启用全部这些控制，不能把“默认不限”写成“参数已全部失效”。

模型单次上下文与输出容量、权限、显式停止、连接故障探测、内存缓存和并发调度需要单独处理。思考输出触顶后仅允许一次无进展安全再生成，第二次仍无正文/工具会 OUTPUT_LIMIT；这是真实失败处理，不是正常任务的总运行时限。持续运行应依靠压缩、可恢复状态和有证据的继续执行，不能靠删除校验把异常循环标成成功。

## 子代理完整快照产生数据放大

`D:/dev/ai-agent-engine/src/core/subagent/store.ts:46` 每个事件保存整个 run；`runner.ts:107` 在工具开始、完成与 usage 更新时继续追加完整累计 toolCalls；`src/api/http/routes/chat.ts:837` 完整广播给父 SSE。旧工具参数、输出与不变的 task / continuation 因而反复传输、序列化和落盘。

审计现场：`D:/dev/aether-code/.ae/qa/all-mode-stress/six-20261013T040524055Z-zJKUUi`。

| 量化项目 | Work A | Code A |
| --- | ---: | ---: |
| stream 文件实际字节 | 118,977,043 | 99,033,797 |
| subagentEvent 数 | 749 | 686 |
| 最终工具数 | 248 | 227 |
| 事件中完整 snapshot 累计 UTF-8 字节 | 118,833,949 | 98,408,972 |
| 最后一份完整 snapshot UTF-8 字节 | 263,398 | 238,123 |
| SQLite 对应 run 的完整 event UTF-8 字节 | 118,916,962 | 98,484,992 |

Work A 累计 snapshot 约为最后一份的 451 倍，其中重复累计 toolCalls 占 107,995,456 字节，约 90.9%。这是近似二次增长风险，不是同等数量的新工具内容。

SQLite 的 subagent_events 共 3,128 行，event 的 UTF-8 总字节为 338,926,439；整个 agent.db 文件为 346,267,648 字节。数据库字节统计使用 `length(CAST(event AS BLOB))`，不是 `length(event)` 的字符数。snapshot、完整 event、日志包装与数据库文件是不同口径，不能互换。

现有 StreamBus replay 和每个 subscriber 均有 8 MiB / 2048 事件边界；内存 projection 每个 child 仅保留最新快照；outbox 只投影终态并逐条恢复。因此 119 MB 累计日志不等于 119 MB 常驻内存，也尚不能认定数据放大就是该轮预热超时根因。累计网络、磁盘、序列化成本已经确认。

## 前端计算与历史恢复

- `D:/dev/aether-code/src/renderer/src/core/engine/subagent-state.ts:217` 对完整 incoming toolCalls 逐个 findIndex；单次全量合并近似 O(n²)。每个事件又归一化完整工具列表，可能在 store、消息挂载和 Work 分组中重复处理。
- `SubagentCard.tsx` 每次变动重新过滤统计，展开列表没有虚拟化；活跃子代理与 Work panel 仍定期拉取完整 run。未进行 UI CPU / GC / 帧率实测。
- `D:/dev/ai-agent-engine/src/core/subagent/store.ts:189` 的 listEvents 无分页，一次读取 afterSeq 后全部完整事件；`src/api/http/routes/subagent.ts:23` 未提供 page / limit。
- `/subagent/runs` 与 `/chat/snapshot` 返回完整工具列表；subagent_events 没有增量检查点或生命周期清理。长时后的首次恢复可能瞬时读取大档案。

## 超过 4096 工具后的最新活动遗漏：已独立复现

生产函数 `CurrentTurnProjection.boundValue` 对数组只取头部 4096 项，数组截断未设置 truncated。chat snapshot 先采用这个快照，再追加数据库在相同 watermark 的完整版本，但 `sessionSubagentRunsAtWatermark` 只有更大 lastSeq 才替换；前端 merge 同样拒绝相同 seq。

位置：

- `D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-projection.ts:195`
- `D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:1580`、`:1619`
- `D:/dev/ai-agent-engine/src/api/http/chat-usage.ts:38`
- `D:/dev/aether-code/src/renderer/src/core/engine/subagent-state.ts:193`

本轮使用 4100 条合成工具记录、最后一条 running，在内存中加载上述生产纯函数，不启动服务、不写文件。实际结果：

```json
{"readOnly":true,"inputTools":4100,"projectedTools":4096,"truncationFlag":false,"sameSeqFullSnapshotTools":4096,"latestRunningToolPresent":false,"newerSeqTools":4100,"defectReproduced":true}
```

相同 seq 的完整快照没有补回最后四条；较新 seq 才恢复完整列表。这证实函数组合缺陷，但当前 248 / 227 工具的失败轮尚未达到 4096，不能宣称该现场已经触发。

首次 tsx 加载因沙箱 `os.userInfo` 的 ENOMEM 错误未运行目标函数；随后使用 TypeScript 的内存转译加载三个纯模块完成复现，没有覆盖 dist / out 或调整产品源码。

## 模型工具目录

ReAct 每次物理模型请求仍发送全部 effectiveTools；OpenAI / Anthropic adapter 没有工具目录增量协议。这是相对固定的 schema / token 成本，不是累计 toolCalls 放大的来源，不能用来解释约 119 MB 的子代理 SSE。后续可评估供应商缓存或网关协议，不能直接删除授权工具定义。

## 建议修复顺序与验证

1. 清理会恢复整任务上限的配置入口；移除 SSE 自动恢复次数天花板，采用可取消退避。自动化旧有限时配置需要明确迁移，避免 UI 显示不限而后端仍有限。
2. 修 Cron waiting 生命周期、Flow 运行注册与重新附着；为本地进程和队列建立所有权、心跳及恢复策略。重启前后的副作用必须据证据结算，不能盲目重跑命令。
3. 修相同 seq 完整快照的优先级；有界活动投影保留最新/正在执行工具并标明可从持久历史补全。保留内存边界，不能将所有工具永久放进内存。
4. 按 runId + seq + toolCallId 发送版本化增量事件，不变字段仅创建时传输；工具正文通过分页/详情获取，SQLite 使用可重建检查点，并兼容既有完整事件。
5. 前端按 ID 用 Map 合并、局部更新，长列表虚拟化；验证重复、乱序、丢帧、相同 seq、断线、权限等待、取消和重启，不复活已终态任务。
6. 修复后单独冻结新候选，跑类型检查、必要真实窗口回归和正式持续压力测试。冻结旧失败轮与其记录，不能改写为通过。

已有短回归与模拟长任务证据不能替代耐久测试。本文审计的六任务失败轮 result.json 明确：预热失败、正式计时 0 分钟、durationSatisfied=false、engineAcceptance=false、cleanup.clean=true。协调聊天正在准备新的 60 分钟轮，其当前进度与新结果不由本文替代；目前没有完整 7×24 通过证据。
