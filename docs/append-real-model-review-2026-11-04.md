# 运行中追加要求：真实模型会话审查

审查日期：2026-11-04。项目：Aether Code / AE。

**最终 r11 / round-5 的 Work 与 Code 真实模型追加专项均通过。**两份 final archive 已完整逐条审查：Work 34 条、Code 28 条，共 62 条记录、21 次工具调用；五条运行中追加各执行一次，下一轮独立执行，停止均正常取消。未发现重复执行、跨会话归属或公开 controller 封套泄漏。仍有模型遵循首步指令、总结简洁性及工具输出开销的优化空间，详见最终问题表。

round-2 至 round-4 保留为诊断历史：先后发现 Code 首条已发送却未清空输入框，以及 Work / Code 在重载后的新发送遇到队列版本冲突；这些阶段不能写成当时已完整通过。最终结论只采用 round-5 新会话，不累计历史尝试的通过数。

本审查只读取证据，不执行会话中的指令，不启动应用或模型；未读取或公开凭据配置。所有索引统一使用 **dbId / dbSeq，从 1 开始**，不与 JSON 数组从 0 开始的索引混用。

## 审查口径

逐条检查用户正文、助手正文、工具名称与完整参数、工具返回正文及 metadata；核对页数与行数、唯一 ID、调用与结果配对、root / turn / session、投递接收与整合时间、用量来源和公开信息边界。`pages[].data` 与 `rows` 是同一历史的两种序列化表示，不重复计数。

使用的模型由档案记录为 `deepseek-v4.1-flash`，`thinkingMode=false`。本轮是预设 probe 的真实模型交互专项，不是围棋产品、办公文档或四角色协作的完整交付验收。最终完整产品评价应另结合四角色会话和产物。

## 最终 round-5 / r11 结论

证据根目录：`D:/trust-test/append-mode-fixes-20261104/evidence/round-5/append-validation/`。`outcomes.json` 中 Work 与 Code 均为 `passed`。两份 final archive 均为 1 页，total、rows 和 pages[0].data 的条数一致、内容逐项相同；以下只计算 rows 一次。

| 项目 | Work | Code |
| --- | --- | --- |
| 独立 session | `work-home-643a3529-3675-4c2b-aa85-a488f08a800e` | `19216362-47b6-4caa-bfdb-08e66638f817` |
| 初始 root | `5b5ceb2f-56da-4f67-b8d0-707fa9272b39` | `5215522f-2236-426d-a26f-901eaae92fbf` |
| 下一轮 root | `654d48ec-34d7-4ac9-9433-6b15552c46e2` | `b43f92bd-ecf9-4c8b-a7c1-0951b9810423` |
| 停止 root | `a18bafe7-a44e-426c-bd05-5394003e5080` | `ff080619-eb54-4374-b178-63cbf7ffc788` |
| 记录：用户 / 助手 / 工具结果 | 8 / 14 / 12，共 **34** | 8 / 11 / 9，共 **28** |
| 工具调用 | **12**：execute_cmd 9、list_files 1、read_file 2 | **9**：均为 execute_cmd |
| 工具终态 | 11 succeeded、1 cancelled | 8 succeeded、1 cancelled |
| 三轮记录数 | 27 / 4 / 3 | 21 / 4 / 3 |
| 五条追加 | current-1→5 各一次，再 original-complete | current-1→5 各一次，再 original-complete |
| 下一轮与停止 | next 一次；独立停止轮 cancelled | next 一次；独立停止轮 cancelled |
| 停止耗时：测试计时 | 1885ms | 1897ms |
| 停止耗时：工具 durationMs | 2019ms | 1951ms |
| 首条用户到首次 execute_cmd | 3850ms，之前另有 list / read | 1301ms，首步即执行命令 |

以上 session 与各 root 均为 round-5 新身份，与 round-2、round-3、round-4 诊断会话不同。两种模式的第一次运行包含五条追加，第二次运行只执行 next，第三次运行验证主动取消；没有把追加误建为新 root，也没有把下一轮并入当前轮。停止的不同耗时取自不同计时起点，仅作事实记录，不视为矛盾或严格性能基准。

### 最终每条记录审查

| Work dbId | 角色、内容与结果 |
| --- | --- |
| 1 | 用户要求先执行 initial 等待命令，再处理五条追加，最后 original-complete；正文完整。 |
| 2–3 | list_files 调用与成功结果；多出的前置检查。 |
| 4–5 | read_file 读取 probe，成功；没有修改脚本，但未遵循首步执行命令。 |
| 6–7 | execute_cmd initial 调用与成功结果；真实等待 release，返回 released:true。 |
| 8 / 9 / 10 / 11 / 12 | 五条用户追加 current-1 / 2 / 3 / 4 / 5，各有独立正文与投递身份，均属首轮。 |
| 13–14 / 15–16 / 17–18 / 19–20 / 21–22 | 对应 current-1 / 2 / 3 / 4 / 5 的五组 execute_cmd 与成功结果，顺序正确、各一次。 |
| 23–24 | original-complete 调用与成功结果，在五条追加之后。 |
| 25–26 | read_file 读取 work.jsonl，实际日志核验已执行的步骤。 |
| 27 | 第一轮总结：标记、released / created 与 PID 和日志一致；未重现 round-2 的 release 文件作者误归因，但“全部步骤按顺序”没有说明先进行了额外检查。 |
| 28 | 独立下一轮用户消息，不重复前轮要求。 |
| 29–30 | execute_cmd next 与成功结果，仅一次。 |
| 31 | 下一轮总结，与 created:true 结果一致。 |
| 32 | 独立停止测试用户消息。 |
| 33–34 | execute_cmd stop 与取消结果，COMMAND_CANCELLED；没有生成伪成功终答。 |

| Code dbId | 角色、内容与结果 |
| --- | --- |
| 1 | 用户初始要求完整，明确五条追加须在 original-complete 前执行。 |
| 2–3 | 首步直接 execute_cmd initial，调用与成功结果一致，released:true。 |
| 4 / 5 / 6 / 7 / 8 | 五条用户追加 current-1 / 2 / 3 / 4 / 5，正文完整、身份独立，均属首轮。 |
| 9–10 / 11–12 / 13–14 / 15–16 / 17–18 | 对应五条追加的五组 execute_cmd 与成功结果，顺序正确、各一次。 |
| 19–20 | original-complete 调用与成功结果，在追加全部执行后。 |
| 21 | 第一轮总结准确区分 initial 窗口释放与随后六个 created:true 命令；文件清单把外部 release 文件写成“对应生成”，创建者表述仍不够严谨；内容偏长。 |
| 22 | 下一轮独立用户消息。 |
| 23–24 | execute_cmd next 与成功结果，仅一次。 |
| 25 | next 总结与返回一致，包含可省略的哈希和约束复述。 |
| 26 | 停止测试独立用户消息。 |
| 27–28 | execute_cmd stop 与正常取消结果，没有伪成功回复。 |

21 组调用与结果一一匹配，名称、toolCallId、完整参数与 rawArgs 一致，唯一 ID 无重复；所有 `metadata.turnId` 与 `conversationId` 一致。命令 job 的 session / root / turn 与所属记录一致，调用与结果携带的最终 job 快照一致。无失配工具结果、重复标记、额外子代理或安装依赖操作。两模式各有一次取消工具，属于预期主动停止，不计作执行故障。

### 最终时间线、持久队列与信息边界

Work dbId 7→8 的 createdAt 回退 3487ms，Code dbId 3→4 回退 3896ms；原因仍是追加保留接收时间、长工具返回后才整合。五条回执的 acceptedAt 与各用户消息 createdAt 完全一致，delivery 均为 integrated，整合早于下一次模型响应。Work 投递等待 2204–3552ms，Code 2408–3955ms。Code 的 acceptedSeq 为 6–10，是跨记录单调序列，不能强制每个会话都从 1 重新编号。

下一轮 pending 队列经 renderer reload 后仍保留，两模式 next 均只启动一次；执行完成后再 reload，独立 stop 探针也正常接纳。`work-stop-draft-accepted` 为 292ms，`code-stop-draft-accepted` 为 266ms；此前导致阶段中断的首条输入清空与发送 CAS 冲突未在本轮重现。弹层检查包含默认折叠、输入框高度稳定、视口边界、全文、Escape、焦点返回、Enter 打开和切模式关闭，两模式均记录通过。

公开 final archive 与公开用户消息没有发现 modelInputContent、provider / controller 私有正文或凭据；delivery 溯源 ID 保留在 metadata，未混入用户内容。两模式内部 DB evidence 的投递记录可能保留私有模型封套，不能直接作为公开附件。报告只使用公开历史和必要计数，不复制这些封套或认证配置。

`outcomes.first` 仍是最初运行快照，其中 running 不能当作最后状态；完成判定结合最终历史、工具结果、数据库终态与 outcomes 的整体 passed。取消轮的 admission anchor 不一定成为历史最终助手文本，不据此认定少一条消息。

### 最终用量与仍待改进的问题

| round-5 用量记录 | Work | Code | 合计 |
| --- | ---: | ---: | ---: |
| 助手 usage 条数 | 14 | 11 | 25 |
| 输入 promptTokens | 299,276 | 189,923 | 489,199 |
| 输出 completionTokens | 1,465 | 1,406 | 2,871 |
| totalTokens | 300,741 | 191,329 | 492,070 |
| cacheHitTokens | 37,632 | 36,608 | 74,240 |
| systemToolsTokens 分项估算 | 182,697 | 101,640 | 284,337 |
| 工具定义估算占输入 | 61.05% | 53.52% | 58.12% |
| 最高上下文 | 24,091 / 268,000（8.99%） | 19,296 / 268,000（7.20%） | 不相加 |

两模式 usageEstimated / contextUsageEstimated / contextUsageProvisional 均为 false。供应商返回的总量与引擎按比例归因的分项必须区别：工具占比仍是估算，不是供应商独立计量。cacheMissTokens 记录为 0，但缺少价格和账单，无法确证费用金额或零未缓存成本。两份档案均 compressed=false，未覆盖自动压缩。不能把 Work 与 Code 的 token 差异直接解释为修复节省：本轮工具集合、模型步骤数及回答内容不同，不是受控 A/B 实验。

| 剩余问题 | 最终证据与影响 | 建议 |
| --- | --- | --- |
| Work 仍未遵循明确首步 | dbId 2 / 4 先 list_files / read_file，6 才 execute_cmd，多两次调用；Code 本轮已直接执行，但不能据一次成功宣称所有模型都会遵循 | 提示规则优先执行已明确步骤，避免固定先巡视；用不同真实任务复测指令遵循。 |
| 总结归因与简洁性 | Work 532 字、Code 633 字的首轮总结，后续分别 158 / 188 字；Code 将变化观察中外部创建的 release 文件写为“对应生成”，容易误导作者归因 | 只列请求的完成标记和异常；文件观察只说明检测到变化，不把并发编辑归为 Agent 创建。 |
| 小文件读取反而膨胀 | Work read_file 输出记录 1200B→1325B、553B→637B，显示 -10.42% / -15.19%；另有读取监控、版本和编辑提示包装 | 小文件直接返回紧凑内容；编辑版本信息按需提供，避免把“压缩后更大”作为常态。 |
| 工具定义仍占较大输入 | Work 61.05%、Code 53.52% 的引擎分项估算 | 按任务选择工具集合、精简说明，保留参数约束；不能仅为短名牺牲含义。 |
| 覆盖仍有限 | 无自动压缩触发、无本轮新增办公格式 / 围棋功能质量结论 | 将专项通过与完整产品验收分开；本报告不替代四角色产物和长上下文压力测试。 |

上述模型质量与 token 优化项已记录，未在本只读审查中修改生产实现；不能声称全部改进项已经修复。最终认定为“本轮追加交互与持久队列链路通过，内容质量及开销仍有明确改进空间”。

## round-2 数据与结果

| 项目 | Work | Code 失败轮 |
| --- | --- | --- |
| 档案完整度 | `work-final-archive.json`：1 页，total / rows / page.data 均为 34，逐项一致 | 无 final archive；只读已关闭实例的会话 JSONL，现存 4 条，不能称为完整终态档案 |
| 用户 / 助手 / 工具结果 | 8 / 14 / 12 | 1 / 2 / 1 |
| 实际发起工具调用 | 12 次 | 2 次 |
| 工具分布 | `execute_cmd` 9、`list_files` 2、`read_file` 1 | `list_files` 1、`execute_cmd` 1 |
| 结果 | 11 成功、1 用户取消 | 列目录成功；命令已开始，现存历史无该命令结果 |
| root / turn 数 | 3 / 3 | 1 / 1 |
| 运行中追加 | 5 条各执行一次，同原 root / turn | 首条输入框清空断言失败，未进入追加阶段 |
| 下一轮 | 新 root / turn，执行一次 | 未覆盖 |
| 停止 | 独立第三轮被取消 | 未覆盖正式停止验收 |
| 最终判定 | 功能链路通过，另有模型遵循指令与总结准确性缺点 | 客户端交互失败，不能视为通过 |

### Work 每条记录复核

| dbId | 角色与动作 | 复核结果 |
| --- | --- | --- |
| 1 | 用户：明确要求先执行等待命令，再按顺序处理新增要求，最后标记原任务完成 | 正文完整；禁止子代理、安装依赖、修改 probe 或伪造标记。 |
| 2–3 | 助手 `list_files` → 工具结果 | 调用与结果匹配、成功；但先列目录违背“第一步调用 execute_cmd”的明确顺序。 |
| 4–5 | 助手 `read_file` → probe 源码 | 调用与结果匹配、成功；仅读取未修改；再次增加非必要前置步骤。 |
| 6–7 | 助手 `execute_cmd`：`window work initial` → 返回 | 参数符合要求；等待监督者 release 后返回 `released:true`。 |
| 8 | 用户追加 current-1 | 正文未被 controller 封套替换；保留接收时间及原 root / turn。 |
| 9 | 用户追加 current-2 | 同上；独立投递身份，未与 current-1 混淆。 |
| 10 | 用户追加 current-3 | 同上。 |
| 11 | 用户追加 current-4 | 同上。 |
| 12 | 用户追加 current-5 | 同上。 |
| 13–14 | `execute_cmd`：`mark work current-1` → 成功 | 一次执行；参数、结果及命令记录匹配。 |
| 15–16 | `execute_cmd`：`mark work current-2` → 成功 | 一次执行，顺序正确。 |
| 17–18 | `execute_cmd`：`mark work current-3` → 成功 | 一次执行，顺序正确。 |
| 19–20 | `execute_cmd`：`mark work current-4` → 成功 | 一次执行，顺序正确。 |
| 21–22 | `execute_cmd`：`mark work current-5` → 成功 | 一次执行，顺序正确。 |
| 23–24 | `execute_cmd`：`mark work original-complete` → 成功 | 在全部五条追加后执行。 |
| 25–26 | `list_files` → 最终目录清单 | 成功，可用于复核实际文件；不是重复执行标记。 |
| 27 | 助手总结第一轮 | 标记顺序正确，但错误归因 release 文件生成者，并把所有命令概括为 `created:true`；详见问题表。 |
| 28 | 用户下一轮指令 | 独立 root / turn；不混入第一轮追加正文。 |
| 29–30 | `execute_cmd`：`mark work next` → 成功 | 仅一次；上一轮工具没有重跑。 |
| 31 | 助手下一轮总结 | 与成功结果相符；仍包含本可省略的 hash 描述。 |
| 32 | 用户停止测试指令 | 独立第三轮；要求执行等待命令。 |
| 33–34 | `execute_cmd`：`window work stop` → 取消 | 结果为 `Tool execution cancelled`，状态 cancelled，错误码为取消语义；不是环境故障。 |

12 个调用全部有对应结果，ID、dbId、toolCallId 无重复；所有记录 `metadata.turnId === conversationId`。命令任务的 root / turn / session 与所在会话一致，助手调用与工具结果的最终状态一致。三轮分别为 27、4、3 条记录；第一轮的五条追加属于原 root / turn，下一轮和停止轮各自独立。

### Code 失败轮现存四条记录

| dbSeq | 角色与动作 | 复核结果 |
| --- | --- | --- |
| 1 | 用户初始测试要求 | 与 Work 同类要求，目标为 code；正文完整。 |
| 2–3 | 助手 `list_files` → 成功 | 已有真实模型回复和工具结果；同样未遵循明确首步执行命令的顺序。 |
| 4 | 助手 `execute_cmd`：`window code initial` | 参数正确；现存会话没有结果行，工作区 `code.jsonl` 有 `initial` 的 `started` 事件。 |

`code-failed-ui.json` 记录已有用户与助手消息、执行命令运行中、输入框仍保留 391 字原稿；`outcomes.code` 显示等待输入框清空 20 秒后失败。**该问题是“已接纳并执行，但输入框未清空”，不是未发送、未调用模型或工具不存在。**现存 JSONL 与 UI 展示的助手消息 ID 不完全等同：UI 可使用运行接纳锚点，而持久历史保存模型步骤 ID，不能仅凭 ID 不同认定重复消息。

没有 Code 最终 archive、追加回执或完整终态历史，不把等待中的 execute_cmd 算作成功或失败结果；也不据其缺少结果行推断模型漏执行。

## round-2 时间线、重复与状态解释

Work 存储顺序存在一个 `createdAt` 倒退点：dbId 7 的工具结束时间晚于 dbId 8 的追加接收时间，相差 3707 毫秒。五条追加是在长工具执行期间收到，工具返回后才整合进模型历史；公开用户消息保留 acceptedAt。因此，**存储顺序与墙钟接收时间不同是预期语义**，不能直接按 createdAt 全量排序，否则会破坏工具调用 / 结果关系。

五条服务器回执均确认：用户消息 createdAt 与 acceptedAt 一致，投递按 acceptedSeq 1→5 排列，integratedAt 早于 dbId 13 的下一次模型响应；从接受到整合等待约 2648–3761 毫秒。`state: queued` 是接纳记录本身状态，最终应结合 `delivery.state: integrated` 判断已送达，不能仅看前者写成“仍未消费”。

Work 下一轮在第一轮完成后派发，主进程 journal 中 pending 项经过 renderer reload 后保留。`timings.json` 记录停止从控制点击到取消完成约 2126 毫秒，取消工具的 durationMs 为 2464 毫秒，两者测量起点不同，不能混为单一响应时间。

`outcomes.work.first.status` 是较早的 running 快照，不能当作最终状态；应结合最终数据库与历史结果。停止轮的 assistantMessageId 可为接纳锚点，因为取消时没有生成独立最终总结，它不一定出现在公开历史正文中。这与会话丢失或重复不是同一问题。

## round-2 Token、费用与上下文证据

| round-2 统计 | Work 完整 14 条助手 usage | Code 现存 2 条助手 usage |
| --- | ---: | ---: |
| promptTokens 合计 | 297,461 | 28,907 |
| completionTokens 合计 | 1,566 | 175 |
| totalTokens 合计 | 299,027 | 29,082 |
| cacheHitTokens 合计 | 37,632 | 3,840 |
| cacheMissTokens 记录 | 均为 0 | 均为 0 |
| systemToolsTokens 分项估算合计 | 182,539 | 18,118 |
| 工具定义估算 / 输入总量 | 61.37% | 62.68% |

以上按单条助手调用的 usage 相加，不重复累计 pages / rows，也不把 user / tool 的本地 tokens 再加到供应商 usage。所有现存助手行的 `usageEstimated`、`contextUsageEstimated`、`contextUsageProvisional` 均为 false，表示引擎记录了供应商返回的总量；本报告没有独立请求供应商账单验证。

`systemToolsTokens` 必须标注为**分项估算**。引擎 `src/core/agent-loop/react.ts` 对实际 effectiveTools 的名称、说明和 schema 本地估算，再按供应商 prompt 总量等比分摊；`usageEstimated=false` 并不使分项变成供应商独立计量。因此 61.37% 表示引擎归因估算，不是可直接核销的工具费用。

档案没有价格、金额、币种或账单字段；`cacheMissTokens=0` 不能证明未命中输入免费，也不能据此得出本次费用为零。上述 token 合计只覆盖持久化的助手调用，不证明重试、失败请求或会话之外的模型请求已全部纳入账单。

Work 单次工具定义估算约 12,924–13,155 tokens，而本次只用到三种工具，说明仍有按任务选择工具集、减少说明重复的优化空间。累计输入是每次请求重复发送上下文后的合计，不是单次上下文长度。Work 最高上下文占比约 8.83%，档案 `compressed=false`，**本专项未验证自动压缩触发或压缩后的指令保持**。

## round-2 历史问题与改进方向

| 级别 | 证据与问题 | 当前判断 / 后续验收 |
| --- | --- | --- |
| P1 | Code 首条已发送并进入工具执行，输入框仍保留原文，真实 UI 测试超时 | 主任务确认发送 Promise 等待整条 SSE；修复后必须以新会话验证输入即时清空、途中可继续补充及停止。round-2 不通过。 |
| P2 | Work 明确要求第一步 execute_cmd，模型却先 list_files / read_file；Code 也先 list_files | Work 增加 2 次模型工具步骤，原始用户消息到真正 execute_cmd 约 4.13 秒；优先让模型按已明确的执行步骤开展任务，避免固定“先巡视”惯性。不是工具接口调用失败。 |
| P2 | Work dbId 27 声称生成了 initial-release 文件，且“每条命令都返回 created:true” | probe 实际只等待外部 release 文件；初始结果是 released:true。工具 changes 可能包含执行期间监督者的并发改动，不能据变化清单推断创建者。总结应以具体结果字段为准。 |
| P2 | 工具定义估算占 Work 输入约六成，Code 失败轮也类似 | 应按任务提供最小有效工具集、缩短说明并保留约束；需要同类真实任务 A/B 复测，不把估算占比直接转换成账单节省比例。 |
| P3 | Work 第一轮总结 599 字并含截断 hash，用户只要求简洁标记清单 | 最终回答可只列完成项与异常，减少冗余摘要和对用户没有决策价值的实现细节。 |
| 证据限制 | 当时缺少 Code 最终档案；Work 仅轻量上下文，未触发压缩 | 后续已在 round-5 补齐两种模式最终档案；压缩专项仍未覆盖，不宣称全生态已验证。 |

本阶段只审查并记录上述问题，没有在审查任务中更改生产代码；不能将“已记录优化方向”写成“已完成修复”。

## round-2 公开信息与内部封套

Work 公开 final archive 与 `work-public-user-messages.json` 中没有发现 `modelInputContent`、provider 私有正文或 controller 封套正文，也没有发现凭据。公开用户正文是用户输入，delivery 溯源 ID 仅位于 metadata 中。Code 当前 JSONL 的四条业务 payload 也未发现此类封套正文。

内部 `work-db.json` 的 deliveries `encoded_row` 仍保留 5 份 `modelInputContent`，这属于内部投递记录，不是公开会话泄漏。它不应直接作为可公开分享的报告附件。本文不抄录该私有封套、不披露账号配置与认证材料。

## round-2 证据索引

round-2 基目录：

```text
D:/trust-test/append-mode-fixes-20261104/evidence/round-2/append-validation/
```

- `work-final-archive.json`：本次 34 条完整公开会话，主要审查对象。
- `work-public-user-messages.json`、`work-delivered-server-receipts.json`：5 条追加的公开正文、接收和整合回执。
- `work-pending-reload-queue.json`、`work-next-queue.json`、`work-automatic-delivery-refresh.json`：下一轮持久队列和自动刷新证据。
- `work-popover.json`：5 条追加默认折叠、输入框高度稳定、弹层在视口内、全文 / Escape / 焦点返回 / Enter / 切模式关闭的检查结果。
- `operations.json`、`timings.json`、`outcomes.json`：操作、耗时和各模式运行结果；注意区分初始快照与最终状态。
- `code-failed-ui.json`：Code 已运行但输入框未清空的真实 UI 证据。
- Code 只读历史：`round-2/profile/engine/state/sessions/<隔离账号>/2fc35949-d999-47fe-ab8c-8b1cf21bccf4.jsonl`；仅读业务 payload，不发布账号配置。
- Code 已启动证据：`round-2/workspace/append-validation/code.jsonl`。

## round-3 诊断历史（r10）

r10 包含首次 Code 长流接纳通知修复，主任务确认 49 项纯测试及构建通过。真实 round-3 已结束，但没有 final archive：Work 初始任务、五条追加、下一轮和 pending 队列 reload 成功；随后独立停止探针的发送遭遇 `Queue revision changed`，没有创建新的 root，测试最终报 `TIMEOUT:work-stop-window`。这是发起停止探针前的队列提交失败，不能表述成“已运行的 Agent 无法取消”。Code 阶段未开始。

本审查仅核对其失败结果与档案边界，按主任务要求不重复深入审查此未完成轮的全部内容。现存 `work-archive.json` 为 29 条（用户 7、助手 12、工具结果 10，10 次调用）；它是停止阶段前的快照，不能当作 final。证据位于 `evidence/round-3/append-validation/` 的 `outcomes.json`、`work-archive.json`、`work-queue-revision-ui.json` 和 `work-failed-ui.json`。

当时主任务继续处理明确 CAS 冲突，随后经历 round-4 的 Code 单独诊断，最终以 r11 / round-5 双模式复测通过。round-3 自身仍保留失败结论。

## round-4 诊断历史

round-4 仅针对 Code 复测：直接发送、五条追加、next 和 reload 通过；独立 stop 探针发起时再次被队列 CAS 冲突拦截，没有新 root。主任务从 LocalStorage 与主进程 journal 确认 expectedRevision=3、实际 revision=4，原意图明确 rejected / CAS，且未写入新 entry；托盘摘要使用泛化错误文案。这是已确认的版本冲突，不是本地 pending 意图损坏或模型没有执行能力。

证据为 `evidence/round-4/append-validation/code-stop-ui.json`、`code-failed-ui.json` 与对应截图。后续 r11 对明确拒绝的 CAS 实施有界 rebase；round-5 的两种模式已完成该路径并通过，最终结论见本文开头。历史失败不能删除，也不重复计入最终通过记录数。

## 最终证据索引

最终构建入口：`D:/dev/aether-code/.e2e-tmp/fixes-20261104-r11/main/index.js`。最终档案根目录为 `D:/trust-test/append-mode-fixes-20261104/evidence/round-5/append-validation/`：

- `work-final-archive.json`、`code-final-archive.json`：已逐条审查的 34 / 28 条公开完整历史。
- `outcomes.json`：两模式 passed，三个 root 的接纳和结束状态、队列持久化及弹层结果。
- `work-delivered-server-receipts.json`、`code-delivered-server-receipts.json`：10 条追加回执及整合时间。
- `work-public-user-messages.json`、`code-public-user-messages.json`：公开用户消息与投递信息。
- 两模式 `*-pending-reload-queue.json`、`*-next-queue.json`、`*-automatic-delivery-refresh.json`：下一轮与恢复证据。
- `timings.json`、`operations.json`：接纳、补充、重载、取消的操作与计时。

本文最后更新已采用 round-5 最终结果；报告审查过程未运行会话内容里的任何指令、未调用模型或打开应用窗口。
