# 子代理 P0/P1 交付记录

日期：2026-09-29。依据 [decision.md](./decision.md) 实施，保留现有多模型 ReAct；P2 不在本次交付范围。

同日后续发现累计预算默认值与搜索参数问题，原因、用户纠正和修复边界见 [incident-2026-09-29.md](./incident-2026-09-29.md)。以下配置说明已按该次纠正更新。

## 执行与状态

- `subagent` 向 ReAct 传任务文本；边界拒绝误传的 Message[]，避免原来的嵌套 user.content 请求。
- 新增 `SubagentRunner`，明确 queued/running/cancelling/succeeded/failed/cancelled/blocked/interrupted。400、部分流失败、空输出、模型截断、步数、预算和权限受阻均不再由“正文非空”判成功。
- 父工具调用在启动 child 前持久化；每个工具使用独立 invocation context。并行结果按调用 ID 配对后发给模型，快任务的事件与父结果持久化不等待慢兄弟。
- 同模型继承已解析连接、凭证、headers 和能力的内存引用；换模型重新解析配置。事件和历史不保存凭证。
- 区分项目 cwd/projectRoot 与会话 scratch。工具目录、相对文件路径和项目说明读取当前项目。
- 子工具集合为父能力与角色能力交集；默认只读，reviewer 即使传 access=inherit 也保持只读。首期不允许递归子代理或独立 ask_user；需要授权结束为 blocked。
- 派发规模遵守用户要求的深度：简单、快速、概览类调研默认派一个只读子代理，先看目录、入口和少量关键文件，不自行升级成多份深度审计。子任务默认仍为 24 步，没有靠降低默认步数处理本次故障。
- 子任务到最后一步，或显式预算模式下接近预算边界时，尝试不再调用工具、整理已有证据后交回。未完成任务的收尾文本保留为 partialOutput，仍报告真实限制原因，不因生成了总结就改成成功。
- `grep_search` 使用合法的 ripgrep 参数，流式读取结果并执行跨文件的全局 maxResults 截断；不再把不存在的 `--max-results` 传给 rg。

## 持久化、事件与回放

- SQLite migration `019_subagent_runs` 建立 runs、events、outbox 和 usage invocation 表；快照、序列事件和 outbox 同事务提交，提交后广播。
- `runId`、父会话/轮次/消息/工具调用 ID 与 childSessionId 分开保存。相同父工具调用幂等创建。
- 父结果使用稳定 ID `subagent-result:<runId>`。JSONL/SQLite append 均幂等，outbox 可以在父落盘前后崩溃时恢复；删除父记录后不重新造父消息。
- SSE 子事件带 `schemaVersion/runId/seq/snapshot`；IDE reducer 拒绝旧序号、重复和错误归属，终态不被迟到进度覆盖。
- 根历史列表同时过滤实际 child 索引与 legacy `subagent-*`。旧失败记录保留，不根据时间猜测归属；缺少结构化状态的旧任务显示未知。
- 详情、历史和 Markdown 导出使用同一运行状态。子转录保存对话与工具结果（工具结果沿用既有输出限长），并保存完整最终回答及失败时已收到的部分模型输出；卡片和父上下文使用有界内容。
- 启动时把未终结运行标记 interrupted，不自动重跑；清空/删除会话会取消并等待子任务，然后清理其运行记录与子历史。

## 取消、资源与用量

- 单独取消返回当前快照，先显示 cancelling，执行停止后才 cancelled；取消 CAS 先成功时，迟到成功不能覆盖取消。
- Signal 接通 OpenAI/Anthropic/Ollama、命令进程、MCP 请求和队列。取消一个子任务不影响兄弟；父取消级联子任务。
- 已开始外部工具的取消会标记 externalEffectStatus=unknown，明确本地停止不代表远端操作回滚。
- 子任务池独立于普通工具池，默认每父会话并发 3；排队可取消，不占用内部工具执行槽。
- 模型上下文窗口、单次输出上限、累计请求用量和 deadline 分开。默认不设累计 token 上限；这不取消模型上下文、单次输出、步数与时限约束。每个真实网络 attempt 独立记账，重复 usage 不重复计账；未知 usage 保留估计占用并标未知。
- 显式配置有限正数的总预算时，请求预占不足才阻止新请求；该模式同时为 child 分配独立额度、为父任务保留收尾余量。默认无限模式仍记账，但不自动分配子额度，也不因历史累计消耗较大而阻断。
- 输入预估覆盖实际发往模型的 messages、tools、system，且保留调用方更保守的预估；API key 与 headers 不参与输入 token 估算。
- 429/临时连接错误只在尚未输出任何流内容时有界重试；400、已输出部分内容、用户取消不重放。SDK 隐式重试关闭，参数兼容重试也逐次计账。

| 配置 | 默认值与含义 |
| --- | --- |
| `AGENT_TOTAL_TOKEN_LIMIT` | 默认无限（Infinity）；只有显式有限正数才限制本次父请求及子任务的输入+输出累计额度 |
| `SUBAGENT_TOKEN_LIMIT` | 默认无限；显式有限正数约束子任务，包括父账本无限时。无父账本直调时作为共享后备累计上限 |
| `SUBAGENT_REQUEST_RESERVE_TOKENS` | 默认 8192，后备账本在缺少请求估算时使用的预占量；不是默认累计上限 |
| `SUBAGENT_CONCURRENCY_LIMIT` | 3，子任务并发上限 |
| `SUBAGENT_DEADLINE_MS` | 600000，子任务时限，包含排队 |
| 子任务 maxSteps | 默认 24，可设 1–64，不被 OSM 倍率放大 |
| 子任务输出上限 | 8192 tokens |
| 父摘要/部分结果 | 约 8000 字符；完整内容保留在子转录 |

正常 HTTP chat 使用父共享账本；仅显式预算配置才分配 child 额度，显式总预算模式同时保留父余量。累计上限配置缺失、无效或非正数时按无限处理，不恢复隐藏的默认 500000 上限。子代理工具仍遵循项目现有 OSM 注册开关，验收夹具使用 methodology。

## 接口与主要文件

- `GET /api/v1/subagent/runs?parentSessionId=...`
- `GET /api/v1/subagent/runs/:runId`
- `GET /api/v1/subagent/runs/:runId/events?afterSeq=...`
- `POST /api/v1/subagent/runs/:runId/cancel`
- 兼容 `POST /api/v1/subagent/cancel`，按 tenant/session/toolCallId 定位。

接口全部按认证租户隔离；不存在和其他租户记录统一返回现有 `40400` 业务包。

引擎入口：`D:/dev/ai-agent-engine/src/core/subagent/`、`src/tools/subagent/subagent-tool.ts`、`src/core/agent-loop/react.ts`、`src/api/http/routes/subagent.ts`。

IDE 入口：`src/shared/subagent.ts`、`src/renderer/src/core/engine/subagent-state.ts`、`subagent-store.ts`、`chat-history.ts`、`useChat.ts`、`src/renderer/src/contrib/chat/SubagentCard.tsx`。

## 验证

确定性验收只替换远端 LLM HTTP 服务，经过真实 ReAct、read_file、SQLite/JSONL、SSE、IPC 和 Electron。未用伪造的 subagent 工具结果替代执行链。

本次累计预算纠正后的验证：

- 两仓 typecheck/build 均通过，Electron 使用新构建的同级引擎 `dist/main.js`。
- 引擎 10 文件、**112/112** 相关测试通过，覆盖真实 rg（14 条）、物理请求参数和记账、默认无限额、显式预算、无工具收尾、持久化与角色权限。
- 最后补充 1 条“父无限、子显式限额”回归；受影响 runtime + 实际搜索集成共 17/17 复跑通过，随后重新构建引擎。本轮相关通过用例合计 **113 条**。
- 新增真实 `subagent → ReAct → grep_search → read_file → 摘要 → SQLite/JSONL` 集成：本地脚本 adapter 模拟累计 **600000 tokens**，任务仍成功且账本与运行快照一致。
- IDE **18/18** 通过：15 条状态测试，以及 3 条真实 Electron 生命周期测试。HTTP provider 模拟成功 child 超过 600000 tokens，父任务继续完成；单独取消、刷新重连、历史重启与导出仍通过。
- Electron 首轮发现测试在刷新首帧就枚举分组，导致漏展开；已改为等待历史分组可见后操作，最终整组 18/18 通过。未为测试改动产品行为。
- 上述大用量均为本地可控 provider/adapter 的 usage 数据，不是实际消耗的真实模型 tokens；本轮未重新跑付费模型冒烟。

以下保留此前 P0/P1 验收记录；它们属于此前产物，不代表本轮重新运行了全部用例。

- 引擎 typecheck/build 通过；13 文件、**110/110 测试通过**，覆盖主循环、runtime/store/outbox、物理请求、模型继承、工作目录、命令/MCP/队列取消、权限、HTTP tenant 隔离。
- IDE typecheck/build 通过；新增子任务状态、回放和导出纯函数测试 **15/15 通过**。
- Electron `e2e/subagent-lifecycle.spec.ts` **3/3 通过**：同轮真实文件读取成功+400失败、运行中刷新重连、真实断开单个 provider 连接且兄弟继续、切换历史/重启/Markdown 实际落盘。
- Electron `e2e/lsp-diagnostics.spec.ts` **3/3 通过**：引擎就绪、保存诊断与问题跳转、渲染无未捕获错误。最终 IDE 相关回归共 **21/21 通过**。
- 真实 `deepseek-v4.1-flash` 最小只读冒烟成功：调用 read_file 读取独立 probe.txt，输出标记一致，run=succeeded；本次 usage 1540 tokens。没有把用户项目文件发送给模型，也没有改动真实会话历史。

真机验收发现已有 Monaco 0.56 API 兼容错误：`monaco.languages.typescript` 运行时为空。已在 `src/renderer/src/core/lsp/ts-client.ts` 改为正式 `monaco.typescript` API，删除掩盖问题的强转；LSP 真机用例通过。LSP 测试夹具缩到 `.e2e-tmp/lsp-diagnostics`，避免删除其他任务的夹具。

额外扩大 IDE 纯函数回归时发现 3 条与本次子代理变更无关的现有失败：pending-interactions 的无选项断言、两条 git 旧字段夹具断言。它们及相应产品行为未为本次任务修改；不能据此宣称全仓测试全绿。

开发模式的 dev-sibling 解析已改为优先同级 `dist/main.js`，缺失才回退 sdk-package/bin，避免修好源码后继续启动旧 SDK 副本。已安装/打包引擎及显式覆盖的优先级保持不变。运行真机测试需先构建两个仓库；子任务 fixture 显式设置 `AETHER_IDE_ENGINE_ENTRY=D:/dev/ai-agent-engine/dist/main.js` 并核对实际入口。新建 fixture 使用独立端口和数据目录，workers=1。
