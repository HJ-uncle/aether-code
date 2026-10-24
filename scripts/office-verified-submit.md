# Office campaign 准入协调器

`office-verified-submit.mjs` 是独立、尚未接入当前 runner 的 harness 模块。导入模块不会启动窗口、引擎、模型会话或定时器。它只负责一次 UI 提交与随后准入证据的核验，不改变产品 API。

## 接入边界

只在父协调者确认的空闲边界安装。禁止在 repair3 等当前任务中热替换，不要通过调用旧 `c.submit` 包一层来接入；旧闭包已经会提前写绑定。安装时需同时将 message/submit-stage 与 start-role 路由到同一个 coordinator：后者调用 `startRole`，不能继续走 `createAndStart` 中的词法 `submit`。

工厂接受 `{ports, journal, expectedTargets, evidenceDir, historyRoot, limits}`。`journal` 是同步持久化的 `{schemaVersion:1, submissions:[], lease:null}`，必须挂在现有 campaign 状态中。同进程使用同一 journal 对象；按 evidenceDir 共享的操作 owner 防止重新创建 factory 绕过 active/pendingOperations。进程确实退出后才可从磁盘恢复 journal。

`expectedTargets` 按角色提供独立于 UI 观测的预期身份：agentId、modelId、workspacePath、tenantId、namespace，以及 engine 的 mode/phase/adopted/instanceId/accountId/pid/buildId/baseUrl/dataDir/entryPath。既有角色还需固定 sessionId；新角色可留空，但必须在唯一点击之前从实际 homeSessionId 固定会话。不要由 accountId 拼 tenantId；tenant 必须来自实际已验证引擎上下文。

`historyRoot` 必须是当前实际 engine.dataDir（数据库文件）的同目录 `sessions`，其 tenant 子目录必须已经存在。模块拒绝路径重定向，不替用户创建历史目录。这个版本只接收本机 embedded 引擎、纯文本、空闲 Work 会话；多模态、远端、排队追加不是本轮接入范围。

## Ports 合约

| Port | 要求 |
| --- | --- |
| `prepareTarget(role, stage, {startRole})` | 只准备/选择目标 UI，返回真实 `{owner:'work', active:true, sessionId, agentId, tenantId, namespace, modelId, workspacePath, engine, newTask}`；不发送。新角色在 home 页配置 Agent/模型/目录并读取实际 homeSessionId。 |
| `readTarget(role, sessionId)` | 只读实际活动 composer 所属会话、持久化 Work 绑定和当前 engine snapshot。不能仅在 task 列表找任意同名项后称其 active。 |
| `prepareComposer(role, exactPrompt, target)` | 填入现有可见 composer，返回实际可见文字；必须与 exactPrompt 完全相同。需要的通用 footer 在调用 coordinator 前只拼一次。 |
| `clickSend(role, target)` | 只调用一次目标发送按钮点击；要求空闲状态的“开始任务/发送”，不能点击“排到下一轮”、重试或恢复按钮。点击响应异常也不能重做。 |
| `readStatus(sessionId)` | 使用身份固定的 GET `/chat/status`，返回真实状态。 |
| `readQueue(sessionId)` | 返回 `{state,dispatchError?}` 的严格观察快照。不能触发 enqueue、mutate、reconcile 或重试。 |
| `validateQueueState(state, scope)` | 必须同步调用产品 `src/shared/next-turn-queue-state.ts` 中的 `assertQueueState`（同一真实实现），失败抛出，成功返回 undefined。不能换成恒真或只校验投影的检查。 |
| `hasCommand(commandId)` | 同步检查旧角色 submissions 与已有提交身份，返回是否已经提交。不要用 runner 当前 command 的 `started` 状态误判本轮尚未点击的命令。 |
| `persist(journal)` | 同步、可报错、完整保存 journal 及 lease；禁止异步 fire-and-forget。原子替换与既有 campaign save 由安装者统一管理。 |

特别注意：Work queue IPC 的 action:`read` 在首次 dispatcher bind 时可能调用 `service.recover`，修改遗留 dispatching 记录，因此名称是 read 不代表无持久化副作用。需要经过实际 owner 状态证明的已绑定快照或受支持的只读存储读取。POST `/chat/admission/receipt` 内部也会投影用户消息，不能当本模块的只读协调途径。

## 成功与失败语义

提交前固定预期身份、beforeRunId、完整队列合同/摘要、历史追加起点与边界摘要、最终 prompt SHA。create-only dispatch 与 click-intent 写入并同步持久化后只点一次。

提交后保留首次新 root 候选，验证服务端 receipt 的租户、namespace、turn/user/assistant/attempt/seq、模型、Agent、工作区。追加历史范围完整读取，要求唯一 user 行且 root/turn/user 身份、原文 SHA 和重建 seed SHA 全部匹配。最终再读状态只检查身份，不能拿另一条响应覆盖候选。候选未证明前不会命名为 admitted。

成功绑定的完整 JSON 文本与 SHA 先保存到 journal 的 `bindingPublication`，然后以 `wx` 写文件。恢复时核对全文字节与冻结历史区，不修改首次发布的快照。captured/recorded/completed 时间分别保存，不能把 command 的 startedAt 当完成时间。

错误、取消、超时、未知状态、预算超限或身份改变都保留 lease。`reconcile(commandId, {limits?})` 只观察此前单次点击，不准备 UI、不补发。尚未结束的 port promise 会保留 pendingOperations，并阻止第二个 factory 协调。准备阶段失败同样需要人工/父协调者核查后处理，不会自动清理 lease。

任何旧 command 的 legacy prompt/binding 或 verified dispatch/click-intent/binding 存在，都在点击前拒绝再次提交。旧证据纠正应另写只读 correction 报告；本模块不把历史错绑当成重发许可。

默认历史新增区预算 4 MiB，每次观察/协调的累计历史读取预算 16 MiB，完整解析至该次打开文件的大小，绝不 slice 或过滤大型 base64 工具行来“凑通过”。累计预算也覆盖边界和冻结区复核，避免待投影时反复读取放大 I/O。超过预算返回 incomplete/uncertain；调用者只能显式指定更大的 `historyBytes`（上限 32 MiB）与 `historyReadBytes`（上限 128 MiB），不能自动扩展。文件替换、边界改变、双 user 与未完整换行也不能通过。

这是有界观测与单提交 owner 的证据，不是产品数据库事务或 OS 写锁。其他进程的后续操作仍可能改变状态；最终业务成功与子任务终态由独立终态采集器审计。

## 离线验证

`node --test scripts/__tests__/office-verified-submit.test.mjs` 使用合成 ports、临时 JSONL 与产品真实队列纯函数。它不接触 live campaign、company、窗口、模型或引擎。真正安装后仍需在安全边界运行新的单次 UI 准入验证，不能把纯测试说成已经完成真实接入。
