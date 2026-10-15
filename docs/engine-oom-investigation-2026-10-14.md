# 2026-10-14 引擎 OOM 排查与复测

## 已确认的故障

第一轮正式测试目录：`.e2e-tmp/hour-campaign-rUn6D9`。

- 正式窗口从北京时间 21:09:04.758 开始。
- 22:01:20.773，引擎 PID 20660 报 `FATAL ERROR: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory`。
- 22:01:21.070，引擎以 code=134 退出。正式窗口内连续运行约 52.27 分钟，未达到一小时。
- 最后一次 GC 约 3735.0 → 3723.8 MB，随后对象晋升失败。操作系统采样中该进程 private bytes 峰值为 4,697,948,160，working set 峰值为 4,538,413,056。
- Electron/renderer 没有对应崩溃；引擎端口随后拒绝连接。页面存活、持久化任务仍为 running 均不能证明引擎继续执行。
- 退出后的 `ECONNREFUSED`、清理阶段 `ProcessStopError` 与 PTY `AttachConsole failed` 是后续现象，不能作为此次 OOM 的初始原因。

原始证据：`events.jsonl:298397`（FATAL）、`events.jsonl:298557`（异常退出）、`process-metrics.jsonl:50`（内存峰值）；完整证据及独立验收位于该目录的 `independent-report.md`、`independent-report.json` 和 `evidence-independent.json`。

## 内存增长的证据边界

协作请求估算上下文从约 64k 增至 443k tokens，Work B 从约 11k 增至 260k tokens；配置的模型窗口为 1,000,000，尚未触及自动压缩阈值。这与持续增长相关，但不能据此证明对象保留原因。

当时的 JSONL 历史与 SQLite 事件总量远小于多 GB；若干流、历史缓存已有单实例上限。没有取得原崩溃进程的 heap snapshot，不能单凭“历史增长”认定唯一根因。后续独立复现已经确认下面的具体请求间保留链。

## 已复现的 SDK 内存保留链

当前 Anthropic SDK 0.20.9 在 `MessageStream._createMessage` 为传入 signal 注册匿名 abort 回调，但正常完成后不移除。该回调捕获 MessageStream；MessageStream.messages 保存完整请求历史。引擎此前直接将长期 root/child 的 signal 传入每次 SDK 请求，所以同一任务的每次模型调用都会再保留一份历史：

`长期任务 AbortSignal → SDK abort listener → MessageStream → messages → 请求历史内容`

独立诊断使用真实 SDK 和冻结的实际 AnthropicAdapter，以纯内存 fetch/SSE 响应完成 20 次请求，没有外部模型调用或监听端口。跨事件循环强制 GC 后：

- 父 signal 的 abort 监听器逐次 0 → 20。
- 20 个 SDK MessageStream、20 个 messages 数组、20 个请求 Message 均仍存活。
- 父 controller.abort() 后仍保留 20；释放父 controller 后三项均归零。
- 请求级 signal 桥接的对照中，父监听器完成后始终为 0，三项存活数也全部为 0。

诊断的 `--expose-gc` 只用于独立无网络复现，不用于正式压力测试。该复现确认了代码中的真实保留链；原崩溃进程中各原因占比仍无法从已保存日志精确还原。修复采用请求级取消信号桥接，保持取消传播，并在每次请求结束时解除父监听器；不修改 SDK/vendor 或 heap 限制。

2026-10-15 北京时间 00:04，新构建已通过独立复验：真实 SDK 的 stream/complete 共 80 次内存 fetch，各场景父监听器均为 0，跨事件循环 GC 后 SDK 流、请求 messages 数组、请求对象或 controller 均为 0。另有 22/22 聚焦回归通过，覆盖成功、网络异常、取消、observer/factory 异常、提前停止迭代、terminal yield 悬停与并行取消隔离。新引擎 typecheck、标准 build 均成功；buildId 为 `sha256:a0976fb490f46dc12238d9e44097b73fc58407de2af74fddc6a130764ee267df`。证据为 `.e2e-tmp/campaign-sdk-signal-fixed-probe.json`、`.e2e-tmp/anthropic-request-signal-fixed-regression.json`；方法和限制见 `.e2e-tmp/campaign-sdk-signal-investigation.md`。

## 已完成的修复与验证

引擎同级仓库 `../ai-agent-engine` 有两项最小修复：

1. `src/api/http/routes/chat.ts`：producer 异常路径在真实终态成功持久化后也调用 `releaseRoot`。原条件 `!producerFailed` 会保留已关闭 owner 及关联能力。现有 release 安全检查继续阻止未完成的 owner 被释放。该生命周期缺口已确认；尚未证明它解释全部 OOM 增长。
2. `src/core/agent-loop/tool-progress.ts`：仅归一化成功 builtin `read_file` 合法监控头中的耗时，避免同一文件仅耗时变化就被误判为新进展；不改变模型看到的工具结果。

客户端构建、引擎 typecheck 与标准 build 已成功。修复后引擎 buildId 为 `sha256:13f3e373cfbef5c507375b90dd68e20b67717973285f2e4884817f38aa6cc19d`。已有聚焦回归 37/37 通过；producer 故障注入及旧条件反例另行保留于 `.e2e-tmp/producer-owner-release-*`。

客户端另已修复两项崩溃后的表现：Work 的 running/waiting 行离线时显示“连接中断，等待恢复确认”并停止转圈，不伪造持久化终态；首次显式启动允许在旧 owned handles 已全部确认关闭后恢复，同时保留旧异常 receipt/日志、继续禁止未关闭进程和自动重连绕过守卫。新写的真实 Electron 故障回归 8/8 通过，证据 `.e2e-tmp/work-disconnect-gC3SdN/report.json`；旧版准确复现持续显示“进行中”。

## 复测状态

复测仍使用数据库配置的真实 `deepseek-v4.1-flash`，范围为 3 个独立 Work、额外第 4 个协作 Work、2 个原生 Cron。每轮隔离 profile、数据库、工作区并冻结构建产物；不提高 heap 限制，不改失败预算。

- `.e2e-tmp/hour-campaign-8VdBKk`：沙箱内真实模型请求立即返回 `Connection error`，已停止并保留失败证据，不能算成功负载。
- `.e2e-tmp/hour-campaign-s9fhL6`：在允许网络的环境运行显式 5 分钟预检；北京时间 23:34:02.093 开始观察窗口。已完成，独立报告为 `preflight-completed-with-issues`：引擎存活、无 renderer 异常，但协作子任务重复验证空转；独立审核角色的只读权限与交接文件要求冲突，导致父任务写入子目录。下一版已修正任务指令和角色配置，失败证据保留。
- `.e2e-tmp/hour-campaign-9xULrT`：历史正式 60 分钟复测，结果和 postflight 见下文；“仍在运行”是旧记录，已不再适用。
- `.e2e-tmp/hour-campaign-uVMkT5`：允许网络环境下的高权限预检，engine `ready`、renderer error/crash 为 0；默认沙箱里的 provider `EACCES` 是外网 TCP/443 策略，不能归因于引擎或模型。该轮保留 4 条协作/版本审计问题。
- `.e2e-tmp/hour-campaign-W9cz0b`：最新正式一小时窗口，使用同一真实模型和冻结 build，已完成并写入完整证据；最终验收为 `completed-with-issues`，不是引擎崩溃。

测试专用 bootstrap 每 30 秒采集 process/V8/流计数，每 120 秒保存统计分配调用栈。它不开放 inspector 网络端口、不主动 GC、不保存对象快照；统计分配栈不等于保留路径，也不覆盖 native/external 内存。采样本身有观察开销，验收需保留这一限制。

## 历史正式复测：`hour-campaign-9xULrT`

`.e2e-tmp/hour-campaign-9xULrT` 使用冻结构建 `sha256:a0976fb490f46dc12238d9e44097b73fc58407de2af74fddc6a130764ee267df`、数据库中的真实 `deepseek-v4.1-flash`，完成了 60 分钟正式窗口。4 个 Work（A/B/C 独立、D 协作）和 2 个 Cron 都成功取得真实 root admission；引擎 PID 77296 在窗口内没有异常退出，renderer error/crash 为 0，OOM 为 0。进程私有字节峰值约 865 MiB，V8 heap 峰值约 470 MiB（heap limit 4 GiB）；窗口末端仍有高位波动，不能据此证明增长已经解决。

验收状态是 `completed-with-issues`。drain 阶段仍运行的最后长任务被安全取消，留下 5 条 `unfinished-after-drain`，所以独立输出不能标记为完全验证；协作线完成 23 轮、69 个子任务、168 条通信并收到 46 次 ACK，但出现 9 次首次目标/nonce 不匹配，重试后均成功。文件版本冲突 48 次只落在各角色自己的 handoff 文件，没有 ownership violation 或重叠写入。UI 审计 119 轮中约 103 轮通过；失败主要是高负载下 2.5 秒导航/面板等待，另有一次模型编辑 modal 遮挡约 20 秒，之后恢复且没有 renderer 错误。长任务观测到 3214 个 long tasks、总计约 355 秒、最大约 777 ms，最大 timer lag 约 1620 ms，这说明监控页必须低频采样并避免渲染原始事件历史。

## 最新正式窗口：`hour-campaign-W9cz0b`

该轮使用数据库中的真实 `deepseek-v4.1-flash`、冻结客户端/引擎 build `sha256:a0976fb490f46dc12238d9e44097b73fc58407de2af74fddc6a130764ee267df`，独立 profile、SQLite 和六个工作区。3 个独立 Work、1 个协作 Work 和 2 个 Cron 均进入真实负载；协作线完成 27 个正式 round，另有 3 个角色子 Agent 持续完成通信与 ACK。

- 正式观察窗内对引擎 PID `57828` 的连续采样保持 `phase=ready`，端口 `12661`；独立证据标记为 `sampled-continuity-observed`，未发现 engine `ERROR`/`FATAL`/crash，`rendererErrors=0`，Electron/renderer crash 为 0。
- 窗口完整运行 60 分钟。结束时 4 个仍在 drain 的长任务由 runner 按清理策略取消；这解释了 `completed-with-issues` 和 `unfinished-after-drain`，不表示引擎挂掉。
- 证据共保留 79 条审计问题：`collaboration-wire` 22、`file-version-conflict` 46、`milestone-not-verified` 1、`native-delegation` 1、`ui-audit` 5、`unfinished-after-drain` 4。没有 ownership violation、重叠写入或运行时崩溃。
- UI 采样继续证明高负载下要限制监控开销：7095 个 long tasks、累计约 1017 秒、最大约 1660 ms，最大 timer lag 约 1425 ms。引擎监控因此只读取紧凑快照、固定任务上限和 30 秒低频时钟，不订阅原始事件历史。
- 进程峰值为 engine private `1,586,462,720` B（约 1.48 GiB）、working set `1,575,391,232` B（约 1.47 GiB）、handles 505；renderer working set 约 0.91 GiB。这里是采样到的进程指标，不等同于 V8 保留路径，也没有证明模型服务端的计算状态。
- 独立验收的 `passed=false` 只表示协作 nonce、审计归类、drain 和 UI 等严格检查未全部满足；`engineIncidents=0`、`engineAbnormalTerminationDetected=false`、`rendererCrashEvents=0`、`electronUnexpectedExitEvents=0` 均为零。

完整原始证据位于 `.e2e-tmp/hour-campaign-W9cz0b/`，其中 `state.json`、`evidence-final.json`、`process-metrics.jsonl` 和 `ui-audit-*.json` 可逐项复核。

## 历史复测 `hour-campaign-9xULrT` 的 Postflight 重启失败

正式窗口结束后，原引擎和 Electron 进程都以退出码 0 停止，Cron 也在重启前验证为 disabled。重启检查在 90 秒内没有进入 `ready`，直接读取快照得到：

```text
phase=error
error=无法读取引擎密钥（...\profile\engine\secrets\engine-secrets.json），原文件已保留。请恢复系统密钥存储或显式重置开发数据。
```

独立诊断还确认 Windows Electron `safeStorage.isEncryptionAvailable()` 为 false，`decryptString` 报 `Decryption is not available`，Chromium `os_crypt_win` 报系统找不到指定文件（0x2）。`agent.db` 的 SQLite `PRAGMA integrity_check` 为 `ok`，WAL 为正常空状态；冻结的 `campaign-entry.cjs` 也能在新隔离 profile 启动到 `ready`，因此这次不是端口、SQLite 锁/损坏、运行时入口或 renderer crash。应用按设计保留了原密钥文件，没有自动覆盖或重置数据库。脱敏证据见 `.e2e-tmp/postflight-diagnosis.json`。要复用这份隔离数据库，先恢复当前 Windows 用户的系统密钥存储，再重试；显式重置开发数据会丢失该隔离 profile 的历史，不应作为无提示的恢复路径。
