# Work 一小时真实引擎工程压力测试

`scripts/work-soak-runner.mjs` 是一个真实引擎 API 长测 runner。它不依赖 Electron UI，不会占用桌面单实例，适合在 UI 验收之外单独运行。默认只做引擎发现和计划生成；只有显式传入 `--execute` 才会调用模型。它会记录模型 provider/base URL（不记录密钥），并拒绝把指向本机回环地址的 `qwen3.8-flash` 当作真实模型执行；只有明确进行受控 fixture 测试时才使用 `--allow-local-model`。

## 覆盖范围

当前目标是一小时。一次完整运行包含 15 个会话和 3 个由 runner 创建、绑定模型并在结束时清理的自定义 Agent：

- 5 个共享项目会话：共用 `shared-project`，分别实现订单数据的 normalize、select、price、summarize、rank 阶段，每个任务拥有业务模块、服务适配层和 `node:test` 回归测试。每轮读取相邻任务规格，全部完成后独立执行完整五阶段集成验证。
- 5 个独立工作台会话：各自拥有 `independent-N` 工程、模块、服务和测试，覆盖相同业务阶段的隔离实现。
- 5 个真实 Cron：各自拥有工程目录及自定义 Agent，默认每 10 分钟错峰触发。一小时验收要求每个至少 5 次带新 runId、代码/命令/磁盘证据的成功触发。每次验证后生成下一轮规格和 nonce。

Cron 通过 `--cron-timeout-seconds` 显式设置每任务预算，runner 默认 600 秒、合法范围 1..86400 整秒。创建与消息更新响应必须保留该值；实际根运行必须持久化 `requestConfig.cronTimeoutSeconds` 和相同的 `cronJobId`。缺省仍为 120 秒的旧引擎不能静默通过。运行整体一小时硬截止不因此延长。

10 个常规会话每轮显式轮换 `qwen3.8-flash` 和另一个启用模型；有多个候选时用 `--alternate-model` 指定。每个会话必须至少完成两轮，并且两个实际模型都出现。只有 `run.actualModelId` 与请求模型完全一致才接受，缺失或不符都判失败。Cron API 没有模型字段，模型通过其绑定的自定义 Agent 指定。每次工程任务都必须实际调用 `subagent` 做只读审查；`task` 不是引擎的委派工具。

第 2 轮起必须通过 `resumeRunId` 继续上轮子代理。验收核对新子运行的 `resumeFromRunId`、同一个 `childSessionId`、本轮成功读取 spec 的工具记录，以及子代理最终结果中的新 nonce；只新建另一个子代理不能通过。Cron 每轮验证后同步更新调度消息携带新规格、nonce 和续跑 id。

常规任务和 Cron 默认 `--thinking off`（请求 `thinkingMode:false`），子代理从父配置继承关闭；可选 `--thinking auto`。续跑时显式传入本轮子模型，同时要求子代理回忆上轮 nonce，验证真实上下文连续性。runner 核对 Cron 创建响应持久化 false，并核对每个父/Cron 根运行 `requestConfig.thinkingMode=false`，不能以 prompt 声称关闭。旧引擎不支持该 Cron 字段时会明确失败并清理已创建资源。

常规任务出现单个 `execute_cmd` 权限等待时，runner 通过与 UI 相同的真实 pending API 发送字面值 `rejected`，每个根运行最多两次，绝不自动批准。实时状态必须与等待流的 session/run/turn/model、requestId、toolCallId 完全匹配；恢复必须保留同一个根运行，原总超时不重置。拒绝必须在 durable pending 中落为 `answered/rejected`，被拒工具必须 `success=false`。随后合并真实工具/子代理证据，仍执行全部工程验收。等待、提交拒绝、确认拒绝、恢复分别记录事件，metrics 单列 `permissionWaits`、`permissionDenials`、`permissionRecoveredTurns`，不能隐藏中断。其他待交互、重复/过期身份、第三次权限等待或恢复失败均判红。引擎拒绝回执只允许 approved/rejected，恢复指引预先写在原任务中。

Cron 属于无人值守自动化：当前调度器会将等待态判为失败并精准取消它拥有的根运行。runner 不会重新启动或复活这种运行，继续如实失败。这是自动化遇到安全权限边界时的明确限制。

正式压力运行使用 `--continue-on-task-error`。普通工程验证错误先记录原始 run 和原因，精准取消或确认该会话终态，其他任务继续；同一会话下一轮收到具体错误反馈并完成新规格。Cron 失败按 runId 去重记录，更新下一轮规格/反馈后继续观察未来真实调度，不复活已失败运行。出现过任何任务、Cron 或集成错误，最终严格质量结论仍是 `not-passed`、退出码仍为 1；`durationCompleted` 单独说明负载是否达到约定时长。引擎死亡、协议/身份错乱、权限恢复越界、规格夹具篡改、无法取消或清理等全局问题会立即停止。默认未启用此参数时仍采用首错停止，历史预检结论不变。

会话 ID 采用 `work-soak-` 前缀，以便 Work UI 识别。资源 ID 和目录写入 `manifest.json`。信号或失败先停止新请求，等待同批兄弟请求结束，再禁用/删除本次 Cron，取消并等待本次会话终止，最后删除本次 Agent。禁用失败仍尝试删除；无法停止的会话对应 Agent 被保留供检查。任何清理错误都使验收失败。工作区和会话历史保留用于审计；既有用户资源不参与清理。

## 先发现，再执行

```powershell
node scripts/work-soak-runner.mjs --discover `
  --base-url http://127.0.0.1:12323
```

默认只发现和生成计划，不执行模型调用：

```powershell
node scripts/work-soak-runner.mjs --dry-run
```

`discovery.json` 和 `plan.json` 包含脱敏的引擎、模型 endpoint、已有资源数量和隔离目录。认证建议通过 token 文件传入：

```powershell
$env:AETHER_SOAK_TOKEN_FILE = "D:/path/to/.instance-token"
node scripts/work-soak-runner.mjs --dry-run --base-url http://127.0.0.1:12323
```

也支持 `AETHER_SOAK_INSTANCE_TOKEN` 和远端认证用的 `AETHER_SOAK_AUTH_TOKEN`。URL 不允许凭据、query 或 fragment；模型 endpoint 报告移除用户信息与查询参数。`--help` 不读凭据、磁盘或网络。

## 建议执行方式

正式一小时运行（实际端口和 run-root 应匹配已准备的隔离引擎）：

```powershell
node scripts/work-soak-runner.mjs --execute `
  --duration-hours 1 `
  --interval-minutes 5 `
  --cron-interval-minutes 10 `
  --cron-timeout-seconds 600 `
  --continue-on-task-error `
  --alternate-model deepseek-v4.1-flash `
  --engine-pid <已确认的隔离引擎PID> `
  --engine-start-ticks <该进程StartTime.ToUniversalTime().Ticks> `
  --base-url http://127.0.0.1:12519 `
  --run-root D:/dev/aether-code/.ae/soak/real-20261012/workspaces/engineering-one-hour
```

短 smoke 默认硬截止 9 分钟、最多两轮常规任务，以便五个错峰 Cron 都有机会执行。两轮完成后继续观察 Cron。它执行相同工程验收，不能代表一小时稳定性结果：

```powershell
node scripts/work-soak-runner.mjs --execute --smoke --base-url http://127.0.0.1:12519 `
  --alternate-model deepseek-v4.1-flash `
  --run-root D:/dev/aether-code/.ae/soak/real-20261012/workspaces/engineering-smoke-new
```

仅在受控本地 fixture 上执行时，显式允许回环模型地址：

```powershell
node scripts/work-soak-runner.mjs --execute --allow-local-model --smoke
```

运行根应位于 `AETHER_ALLOWED_WORKSPACE_ROOTS` 已允许的目录下。已有 manifest 的目录不能复用；runner 使用排他锁避免同根双启动。`--allow-local-model` 的成功报告仅标为 `local-test-only`，不算真实 Provider 验收。

时长对模型工作为硬截止，超时仍有未完成批次会标为失败并取消，不延长工作负载。清理过程可略晚结束，分别记录 `workloadFinishedAt` 和 `finishedAt`。常规批次运行时也每 15 秒观察 Cron，调度失败无需等慢批次结束才被发现。子代理审查限制为 8 步，要求读取当前规格/模块/服务后直接给出结论。

## 产物与验收

每次运行目录包含：

- `discovery.json`：脱敏引擎元信息、模型 ID/provider/endpoint/启用状态、已有 Agent/Cron 数量。
- `plan.json`：15 个会话/自动化计划和隔离路径。
- `manifest.json`：实际资源、状态、计数、每会话实际模型集合、Cron 新 runId、清理错误和验收结论。
- `events.jsonl`：状态、请求/实际模型、SSE 字节数、工具 ID/名字/路径/命令、子 Agent runId、磁盘哈希、独立验证结果、错误摘要。失败流也保留实际模型与待交互摘要。
- `heartbeat.json`：10 秒更新，包含轮次、状态、计数、runner 自身内存；这不是 Electron 或引擎内存。
- `engine-process-events.jsonl` / `engine-process-summary.json`：传入成对的 `--engine-pid` 和 `--engine-start-ticks` 时，每 30 秒记录已确认隔离引擎根进程的 WorkingSet、PrivateMemory、累计 CPU 秒和句柄数，固定 PID 与 UTC 创建时间。进程退出、PID 复用或采样失败使正式运行失败；不会记录命令行或扫描其他引擎。子进程和 Electron 不包含在这些指标内，不能将根进程统计冒充整个进程树。
- `state.json`：退出时的最终原子快照。业务模块、服务、测试和带 nonce 的 receipt 留在各自工程目录。

每轮必须有：成功终止帧和根 runId/turnId、精确实际模型、成功 list/read/write/subagent/execute_cmd 记录、成功子 Agent、当前规格读取、两个前台 Node 命令完成、源码哈希变化、新 nonce receipt、未改动的测试夹具，以及 runner 独立生成的额外用例验证。共享任务另需读取相邻规格、通过五阶段集成。未成功、空/stale Cron、缺实际模型、漏工具/子 Agent、失败/未恢复等待运行和清理失败均不能得到 `api-engineering-passed`。

隔离回归：`node --test scripts/work-soak-runner.test.mjs`。32 条覆盖包括真实磁盘/Node 验证的完整继续模式夹具：单任务错误后兄弟任务继续、同会话下一轮纠正、Cron 新失败观察与去重、达到时长但严格质量仍红。缺少根 runId/turnId、durable 身份替换或缺失时不能恢复/取消任务；到期信号不覆盖独立 API/配置错误。测试替身只验证 harness 分支，不作为模型证据。

若运行已经开始，可用 `node scripts/work-soak-process.mjs --run-root <当前运行目录> --engine-pid <PID> --engine-start-ticks <UTC创建ticks>` 单独挂接同一监测；它在 manifest 进入终态后退出，起止时间与覆盖窗口单独记录。此模式的监测失败只反映在监测进程退出码和 telemetry summary，不会反向停止已运行的 runner；正式测试应使用 runner 内置参数。既有监测产物不可覆盖。

## 当前限制

runner 不启动 Electron，也不自行创建模型或推测 API key。UI 连续切任务、成果/活动/子代理、自动化、主题和窗口尺寸等交互由单实例 Electron observer/driver 独立记录，并与同一 manifest 的 `work-soak-` 会话关联。API 成功不能替代 UI 成功。模型 endpoint 和 actualModelId 是配置及引擎回报证据，不单独证明远端服务商身份。引擎 Cron 仍使用调度器的工具 profile，显式预算及根运行来源由真实专项验证。

