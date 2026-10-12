# Work 长测证据审计

本审计只读检查了 `scripts/work-soak-runner.mjs`、`.ae/soak/long-run-20261012/` 产物、`.ae/soak/mock-openai.mjs` 和引擎配置脚本。没有启动第二轮、删除运行产物或读取凭据。

被审计运行是 `work-20261011180059-8b14ddae`，时间为 2026-10-11 18:00:59Z 至 2026-10-12 00:00:59Z。

## 可验证的结果

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| 六小时循环 | `manifest.json` 的 `durationHours=6`、`intervalMinutes=1`、`round=354`；`events.jsonl` 有 3,540 条 `turn-finished`（10 个初始会话 × 354 轮），另有 353 条轮次快照 | 真实执行了六小时级别的 API 循环；这不是 UI 压测 |
| SSE 终止 | 旧运行产物中的 3,540 条 stream 都有 `events>0`、`terminal=succeeded`；字节数约 5.4–12.3KB | 本轮流在引擎侧正常结束；旧 runner 对“有事件但没有终止帧”的流会错误接受，源码现已改为缺终止帧即失败 |
| 工作台集合 | `manifest.json` 声明 5 个 shared、5 个 independent、5 个 cron；每个目录均存在，shared 有 `shared-task-1..5.md`，independent 有 5 个对应文件 | 目录和任务数量达到计划值 |
| Cron 重复触发 | 每个 `cron-N.jsonl` 有 6 条 user 记录，时间分布在连续小时的相同分钟（18:02…23:02 等）；因此确实发生了重复调度 | 旧产物证明重复触发，而不是只有初始 succeeded 快照 |
| 结束清理 | `events.jsonl`：`cron-cleaned=5`、`session-cancelled=15`、`cleanup-error=0`；结束后的 `/api/v1/cron` 返回空 data | 本轮结束时资源清理成功 |

## 与验收目标的差距

### 真实 qwen3.8-flash 未被证明

`discovery.json` 只能证明引擎列出了 `qwen3.8-flash`，JSONL 的 `modelId` 只能证明请求/会话标签。`.ae/soak/configure-engine.mjs:6` 把 `OPENAI_BASE_URL` 配到了本机 `127.0.0.1:12498/v1`；`.ae/soak/mock-openai.mjs:59-74` 会直接读取请求中的 `model`，生成固定的 `soak evidence ...` / `soak-ok ...` 响应。因此本轮没有真实外部 Provider 或真实 qwen 能力证据，不能把这些标签当成外部模型验证。

### 没有同会话模型切换

10 个初始会话各有 354 条 user 记录，但每个会话 JSONL 的 assistant `modelId` 只有一个值：shared 为 qwen、gpt、qwen、gpt、qwen；independent 为 gpt、qwen、gpt、qwen、gpt。也就是说发生的是跨会话分配，同一会话内没有切换。runner 现已按轮次旋转请求模型，并在新事件中记录 `requestedModel` 和 `actualModel`；`actualModel=null` 时仍不能证明 Provider 实际采用了请求模型。

5 个 Cron JSONL 的 assistant `modelId` 全部是 `qwen3.8-flash`，即使绑定的两个 Agent ID 交替出现。这是因为 Cron 创建请求没有模型字段，调度器使用全局主模型；Cron 本身没有模型轮换证据。

### 共享协作和复杂多 Agent 未被证明

发现阶段有两个已有 Agent ID，但 `manifest.json` 顶层 `agentIds` 为空，runner 没有创建或管理临时 Agent，也没有建立子 Agent/父 Agent 协作关系。15 个会话的引擎 JSONL 总共只有 15 次工具调用，全部是每个会话第一次的 `write_file`；`read_file` 和 `list_files` 为 0。shared prompt 虽要求读取其他任务文件，实际没有读操作或跨文件事实。独立会话只证明了各自目录的首次写入。

### Cron 的“重复执行”仍有 stale 风险

每个 Cron 会话虽有 6 次 user 触发，但每个 JSONL 只有一次 `write_file`，后续触发由 mock 直接返回固定文本，未再次写入健康检查文件。旧 runner 只检查 `snapshot.run.status` 与 `finished`，353 轮快照中有 23 条 `status=unknown, finished=true`，没有比较新的 `runId/turnId/finishedAt`，因此单看旧状态可能把 stale succeeded 当成新触发。旧运行还通过 `.ae/soak/reschedule-cron1.mjs` 在 18:17Z 手动把 cron-1 调到 :19；`events.jsonl` 留有 `cron-rescheduled`，而停止时 runner 的内存 manifest 又覆盖了该表达式，造成最终 manifest 与实际历史不一致。

源码现在在每轮记录 Cron 的 `runId`/`turnId`、`fresh`、累计 `triggerCount` 和 `actualModel`，结束时写入 `manifest.cronEvidence`，可在下一轮运行中直接审计触发新鲜度。

### UI 压力完全不在本轮范围

runner 只调用引擎 HTTP/SSE，不启动 Electron 或 Playwright，不覆盖窗口切换、Work 结果布局、渲染错误、输入交互、CPU/内存/网络压力等目标。六小时 API 循环不能替代 UI 压测或真实 Provider 长测。

## runner 修复

本次审计同步修正了以下可复现的 runner 风险：

- `streamChat` 使用持续的 `TextDecoder`，并要求至少一个明确的终止状态；缺终止事件会失败。
- 主循环现在用 `try/catch/finally` 包住初始化和每轮执行；非初始化异常也会进入 `stop()` 清理路径，清理失败会写入 `cleanup-error`，而不是静默吞掉。
- 每轮按模型列表旋转请求模型，`turn-finished` / `turn-error` 记录 `requestedModel`、`actualModel` 和耗时。
- Cron 快照按 `runId`/`turnId` 识别新触发并记录累计计数，结束 manifest 保存触发证据。

以上历史六小时产物保留原样，不作为新增工程负载的验收。

## 后续一小时方案与真实预检

用户随后把正式时长改为一小时。runner 已改为模块/服务实现、Node 回归测试、每轮子 Agent 审查及同上下文续跑、工具与磁盘哈希、nonce receipt、额外独立用例、同会话实际模型切换；5 Cron 每 10 分钟错峰触发。协议解析、清理、证据判定拆成可导入模块，30 条隔离 Node 测试通过，包含未结束批次在硬截止时中止并标红、旧 Cron API 丢弃思考档位或显式预算时仍清理已接受资源，以及引擎 PID 复用时拒绝采集替代进程。兄弟任务取消现在保留原始失败原因，不再把运行级诊断覆盖为泛化的 AbortError；新增同根运行最多两次真实权限拒绝恢复和持续压力模式的正反例。新方案见 `docs/work-soak-plan.md`，这些代码修复不能追溯性地补足旧六小时证据。

2026-10-12 02:00Z 的真实预检 `engineering-smoke-20261012a` 使用隔离引擎 12519、已预检的 Qwen/DeepSeek 配置。首个 Qwen 父任务虽实际列目录/读规格，但发出 `ask_user` 的“占位（不应触发）”，根运行进入 `waiting/NEEDS_USER`。runner 判失败并取消兄弟任务，5 Cron、3 个临时 Agent 清理成功，`cleanupErrors=[]`；没有宣称 smoke 通过。证据在 `.ae/soak/real-20261012/workspaces/engineering-smoke-20261012a/` 与对应引擎会话 JSONL。

预检后补齐常规请求的 `X-Aether-Tool-Profile: code`，限制提示只使用实际提供的工具；失败流保留实际模型、工具和待交互摘要，主动取消的兄弟请求独立计数。后续是否通过应以新的运行产物为准。

预检 B（`engineering-smoke-20261012b`，02:15:14Z–02:16:25Z）在 Qwen 尝试 `node -e` 时遇到引擎命令审批，结果 `waiting`，1 个失败、9 个取消，清理成功。提示随后精确限定为两个前台 Node 文件命令，禁止内联脚本和 shell。

预检 C（`engineering-smoke-20261012c`，02:21:12Z–02:31:13Z）有 7 个工程任务通过磁盘、测试、真实模型和子代理证据检查；shared-1 Qwen 子代理耗时约 466 秒，成功后父流仅余约 21.7 秒即达到整个请求的 600 秒预算，使批次失败，另 2 个任务取消，清理成功。独立会话复审支持长模型分析耗尽总预算，不能据此判定死锁或无进展超时，详见 `docs/work-smoke-c-reaudit.md`。该轮没有完成模型轮换/续跑/五个 Cron 验收，不能称为完整通过。旧取消异常共享同一 Error 对象，导致两个取消事件的 evidence 被覆盖；这部分归属须查看各自引擎会话，不能据此推断引擎串会话。runner 已改为每个流新建异常并添加回归。

当前版本在批次执行中每 15 秒检查 Cron，实际模型不符立即失败；到时硬中止尚未完成的工作并标红，清理耗时另记 `workloadFinishedAt`/`finishedAt`。短 smoke 默认最多两轮，以免在固定截止前持续追加任务。下一次真实预检应先验证同一子代理续跑专项。

## 同一子代理续跑专项

`continuation-preflight-20261012a` 因 Qwen 把指定的 nonce JSON 读取任务改为读取不存在的 OpenSpec brief 而失败，子代理达到步数上限；已清理。没有将父根运行 succeeded 误当作子任务完成。

`continuation-preflight-20261012b` 于 02:49:04Z–02:49:37Z（约 32.5 秒）通过两轮真实调用：父实际模型 Qwen→DeepSeek；子代理使用同一个 `subagent-42c58b1a-7b03-4ec0-bbb7-d5f9b0114252` 会话，新 run `8923f834-7031-43b1-b908-e2b546538e67` 的 `resumeFromRunId` 指向 `980d11e8-3f64-455d-aaad-57a16385aa4d`。第二轮在读取新 nonce 后正确回忆旧 nonce。两轮根 `requestConfig.thinkingMode=false`；父 6 条、子 4 条 assistant 记录的 reasoningContent 字符总数均为 0，父子模型均发生 Qwen→DeepSeek 切换。清理错误为 0。该证据验证了关闭思考模式下的续跑/模型切换链路，不替代完整十五任务或一小时验收。

## 完整工程预检 D

`engineering-smoke-20261012d` 于 03:07:07Z–03:10:59Z 在新版隔离引擎完成首轮 10/10 工程任务、共享五阶段集成和 Cron 1 的真实工程触发。第二轮 independent-4 使用实际 DeepSeek，根运行和续跑子代理均 succeeded，子代理的同一会话、上轮 runId、新旧 nonce 均匹配；但父任务省略了本轮必需的 `list_files`，严格验收判失败，9 个兄弟任务取消，清理错误为 0。没有以根 succeeded 替代完整工具证据。后续提示明确要求每轮第一个工具调用成功列目录，未放宽断言。

该轮在 03:09:02Z 后独立挂接了隔离引擎根进程监测，固定 PID 51528 与 UTC 创建 ticks `639273711688335120`，共 6 个样本，覆盖至 03:11:03Z。采样峰值 RSS 520,957,952 字节、private 567,791,616 字节、429 句柄，累计 CPU 增量 8.078125 秒。监测没有覆盖运行最初约两分钟，不含 Electron 或子进程，不构成长时内存稳定性结论。后续 E 初始化同进程 RSS 已降至 277,024,768 字节，因此不能单凭 D 的短时负载上涨推断泄漏。正式 runner 已支持从初始化通过 `--engine-pid`/`--engine-start-ticks` 开启独立统计。

## 完整工程预检 E

`engineering-smoke-20261012e` 于 03:13:20Z–03:14:34Z 运行，首轮 3 个任务通过、1 个失败、6 个取消，未进入 Cron 首次调度，清理错误为 0。independent-3 实际 DeepSeek 的子审查已成功，但父任务为核对自写定价测试的算术发起禁止的 `node -e` 内联调用，安全策略转为 `waiting/permission`，runner 正确判失败；没有自动批准被拦截命令。该模型在测试中把 `1000 - 23 + 56` 的预期值误写为 `1010`。后续提示补充可操作的调试路径：在自己的测试文件中校验计算，仅重跑已许可的 Node 文件命令。

E 的引擎监测从初始化开始，4 个样本，根进程峰值 RSS 528,797,696 字节、private 610,390,016 字节、481 句柄，CPU 增量 7.21875 秒。样本仅约 74 秒，不能代表长期稳定性。D/E 都保留 `not-passed` 结论。

## 真实权限拒绝恢复专项

`permission-preflight-20261012a` 在最终硬化引擎（build `2478d34186cee38cdf701b848dbfe66e482138dad9c4a16cbc0e35e8ecac66e5`）于 03:25:11.839Z–03:25:23.385Z 通过。实际 DeepSeek、thinking=false；根 `71391984-cb8d-4903-bcc4-01b103da7fa4` 与 turn `a6ab40cd-24ed-4ade-b051-1c71e1fb4915` 在等待和恢复后保持一致。受控 `node -e` 算术命令被安全策略拦截，runner 使用真实 pending API 发送 `rejected`；持久化状态为 `answered/rejected`，同 toolCallId 的工具结果 `success=false`。模型随后用 `node safe-proof.mjs` 成功写入本次 nonce receipt，根运行 succeeded；等待、拒绝、恢复各 1 次，清理错误为 0。

这证明了在不批准内联命令、不新建替代根运行的前提下，普通任务可以从真实权限等待恢复。它不是完整工程验收，也不改变 Cron 等待态的失败边界。证据目录为 `.ae/soak/real-20261012/workspaces/permission-preflight-20261012a/`。

## 完整工程预检 F 与持续压力模式

`engineering-smoke-20261012f` 于 03:27:10Z–03:31:20Z 完成 15 个工程 turn（首轮 10 个、第二轮 5 个）、首轮共享集成及 Cron 1，无权限等待；第二轮 independent-3 子模型验证失败后取消 4 个兄弟任务，清理错误为 0。父实际 Qwen 且 `requestConfig.subagentModel=qwen3.8-flash`，但真实 subagent 工具调用 `toolu_f547d4e54fd441358f03ea9a` 只有 resumeRunId/description/maxSteps/task，遗漏 model。引擎原优先级为显式工具 model、旧 child model、用户子模型、父模型，因此子模型仍为 DeepSeek。续跑 childSession、新旧 nonce 和新规格读取都正确；不能把模型漏参与既有继承规则说成通信丢参数。

新引擎调整为显式工具 model > 用户子模型 > 旧 child model > 父模型。正式长测同时采用 `--continue-on-task-error`，保留原始失败并在同会话后续轮次给予具体反馈，任务/Cron 错误不取消其他独立任务；出现过任何质量错误的结论仍为 `not-passed`。30 条 harness 回归中，完整夹具验证首轮 1 个任务错误、其余 9 个继续、第二轮纠正后共 19 个成功/1 个失败/0 个取消，两个独立 Cron 失败按 runId 去重并继续观察，最终到达硬时长但严格质量仍红。夹具不是外部模型或一小时证据。

## 最终引擎合同专项

`final-contract-preflight-20261012a` 于 03:45:40Z–03:47:04Z 核对 build `b3714f163cfd8d9945145ce5cb03c589c75d837752b1fbdc8bfdecb2a20d2fd3`。子代理继承两轮通过：先 DeepSeek，随后父/用户子模型显式 Qwen，真实 subagent 调用省略 model；同一 childSession 的续跑实际使用 Qwen，并返回新旧 nonce。

同一专项的 Cron 创建响应成功保存 `timeoutSeconds=600`，实际任务也 succeeded，但根 `4183145c-1988-402c-bcf8-3562ee4cc632` 的 `/chat/runs` 与 `/chat/status` 都缺 `requestConfig.cronTimeoutSeconds`/`cronJobId`。所以整体专项判失败，清理错误为 0。源码核对发现调度器已传入字段，但根运行保存/公开配置白名单遗漏；没有用 job 配置代替实际运行来源证据。后续只重测 Cron 合同，已成功的子模型专项不重复。

`final-contract-preflight-20261012b` 于 03:57:18.600Z–03:58:03.905Z 在 build `bf07846259fa6f3844bb9b2d14a8e03fd3c475638a4f77d2fc075ebda3d13d09` 完成 Cron 专项。根运行 `a439bebb-a07c-4751-9272-50e1eda9e881` 实际 DeepSeek、成功读取本次 nonce 规格；公开根 `requestConfig` 包含 `cronJobId=4e94cc62-c7d7-4aad-96a2-19b91ea935d8`、`cronTimeoutSeconds=600`、`thinkingMode=false`。专项 passed，清理错误为 0。旧运行缺字段的历史证据未被回填。

正式前只读复审复现两个 harness 边界：缺 runId 的失败流曾被标为可隔离，取消逻辑回退当前 runId 可能误取消替代运行；独立配置错误若恰逢硬截止可能被截止审计覆盖。修复要求完整流身份与持久化身份匹配、取消禁止缺失 expectedRunId，且只有异常 cause 链包含自身截止信号原因才走正常截止审计。原误取消复现现在拒绝恢复/取消且 API 请求数为 0；32 条 harness 回归全部通过。

## 正式一小时运行

`engineering-one-hour-20261012a` 已于 03:58:50.746Z 启动，硬截止 04:58:50.746Z；runner PID 24540，隔离引擎 PID 53580、UTC 创建 ticks `639273739890046539`。覆盖五共享、五独立、五 Cron，常规间隔 5 分钟、Cron 间隔 10 分钟、预算 600 秒、关闭思考，普通质量错误继续施压并永久保留红色质量结论。UI 观察由独立 Electron driver 关联同一 manifest。运行中状态不是完成或通过证明，最终结论以停止后的 manifest 与独立 UI 报告为准。

该正式运行于 04:58:50.875Z 到达硬截止，04:58:51.873Z 完成清理并写入最终状态：70 个常规工程回合（7 轮×10）、30 个 Cron 触发均通过验收；`turnErrors=0`、`turnsAborted=0`、`cronErrors=0`、`integrationErrors=0`，权限等待/拒绝/恢复均为 0，`qualityFailures=[]`、`cleanupErrors=[]`，最终 `status=completed`、`acceptance=api-engineering-passed`。引擎根进程监测固定同一 PID/ticks，共 121 个样本；峰值 RSS 1,371,631,616 字节、private 1,610,842,112 字节、句柄 1,145、CPU 增量 194.21875 秒。上述资源指标仅覆盖引擎根进程，不含子进程或 Electron。


正式 UI 观察第一段因共享工作树被另一聊天重建 out 而主动停止，保留为构建不一致证据（285 次任务访问、3,575 次操作、Electron 原生退出正常）。冻结构建后，观察持续 1,842 秒并完成 2,520 次任务访问、2,515 次子代理详情、2,501 次成果查看、33 次重载；原生事件 0、页面错误 0，直到第 168 轮发现旧版本候选弹层在 Escape 后未卸载。根因是 Portal 未在捕获阶段接管 Escape；修复后独立冻结构建历史回归 61.9 秒通过（76 次任务访问、10 次候选菜单操作、页面错误 0），真实 Electron 时间线回归 8/8 通过。UI 观察与 API 正式验收分开计量。
