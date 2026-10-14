# 子代理耐久性修复与验证（2026-10-13）

本报告记录当前源码与隔离夹具验证。正式候选由协调聊天统一构建和冻结。本聊天未执行公共构建、Electron、真实模型或新的正式持续压力轮；不能据此认定已经达到 7×24。旧失败目录与原数据库未改写。

## 修复内容

- canonical `SubagentRun` 继续表示完整 schema 1 归档；新 `SubagentRunView` 为明确的 schema 2 摘要，携带准确总数、活动数、覆盖范围和固定版本，不能将短数组冒充完整旧快照。
- 生产 runner 按工具 ID 更新，写增量事件、标量 checkpoint、单工具详情版本；不在每次工具开始或结束时读取并写回全部工具数组。私有 continuation 配置只在执行权限校验时读取，不通过显示摘要或 SSE 发出。
- chat producer 使用协议 2；旧 viewer 在边界转换，不能由第一个旧 viewer 决定共享总线的累计完整快照格式。能力握手与引擎 manifest 版本分别校验。
- 工具历史按 ordinal 分页，固定 `atSeq`；详情按 UTF-8 字节分段，最多 128 KiB；事件页固定捕获的上界。缺失准确 checkpoint 或工具详情版本返回恢复错误，不能用未来数据或旧版本伪造完整结果。
- 用量 invocation 去重、详情、事件、状态与 terminal outbox 在同一事务提交。终态取消活动工具；迟到工具或 running 事件不能复活已结束任务。
- 父 dispatch 校验使用可选 `getActiveToolCallAnchor`，固定 tenant/session/turn/message/tool，只返回三个身份字段。SQLite 不选择正文或工具参数；JSONL 用 64 KiB 正反读取和标量 control fold，避免加载整个父会话。不支持该 API 的旧 history 保留严格 turn 的 fallback。
- `getRunView` 和 `listToolsPage` 使用一致只读事务，防止 latest-index 探测与后续查询之间的并发提交泄漏未来版本。非法持久 UTF-8 明确拒绝，不能静默替换后仍宣称详情准确。
- 历史 expected-revision 查询使用工具 ID 表达式索引，并消除关联 TEXT 列的 affinity 对索引键匹配的影响。该查询曾对每个工具反复扫描事件 JSON，已经由实际 EXPLAIN 和读取测量定位。
- 客户端按 ID/revision 合并、检查来源与 generation，缓存总量有界；非完整子代理页面不能用于删除缺失任务。历史页和详情页不推进 root cursor。
- 界面使用权威调用总数；工具窗口最多 128 项／512 KiB；详情仅保留当前 32 KiB 块及 64 个 offset 元数据。对话最多 3 页／512 KiB；缓存淘汰保留未发送草稿。

## 已有准确验证

下表为各测试组的最新独立结果，重复执行不重复计数；不能将下表相加成一场全链测试。

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| 客户端 shared/reducer/store | 32 条通过 | 纯函数；来源/generation、缓存预算、部分页面不误删 |
| 客户端能力握手与数据方法 | 9 条通过 | 纯函数；认证错误与旧协议回退区分 |
| HTTP 路由、协议、SSE adapter | 44 条通过 | 隔离 SQLite／Fastify inject，不连接正式服务 |
| 生产适配器耐久性 | 12 条通过，另有查询计划回归 1 条通过 | 10000 工具主用例 126.824 s，全组 129.85 s；尚需最终合组确认 |
| 生产路由、协议与快速故障合组 | 56 条通过，1 项按筛选排除 | 44 协议项＋12 快速耐久项；10000 不无理由重复执行 |
| scoped active-anchor | 23 条通过 | SQLite／JSONL 16 条＋parent projection 7 条；租户/会话/轮次/工具归属、删除、压缩 |
| runner 工具集、续跑权限、无默认步数限制 | 28 条通过 | 脚本模型、独立数据库、真实文件工具；无真实 provider 请求 |
| 最终 production-adapter 核心合组 | 61 条通过，0 unhandled，exit 0 | runtime 26／projection 14／view 18／并发读取 3；16 个关键文件哈希前后不变 |
| view Unicode 快路径 | 18 条通过 | ASCII、中文、emoji 的 UTF-8 边界 |
| 一致只读事务与非法 UTF-8 | 3 条通过 | 两个真实 WAL 连接，在读取期间合法提交下一版本 |
| 客户端 UI helpers | 32 条通过 | 分页窗口、详情 chunk、LRU 草稿等；真实窗口另验 |
| 子代理历史真实 Electron 窗口 | 3 条全部通过 | 协调方串行执行；4100 权威总数、32 KiB 分段详情、切任务后旧响应不能回写 |
| engine typecheck | 通过 | 最新修复后的 `tsc --noEmit` |
| 客户端 typecheck／CSS token／限定 diff-check | 通过 | 客户端子代理 UI 源码已冻结 |

runner 边界测试另验证 80 个工具、164 个增量事件、热路径不读取完整归档，以及浏览器原始输出约 134 KiB 的分段重组。详情保留中文、emoji 和截图 data URL；live 事件只发送预览，不替换持久原文。

## 失败与诊断记录

1. 第一场 10000 工具测试约 455 秒后 worker 异常退出，没有最终用例结果。数据库已写到 seq 20043、10000 工具、succeeded，但恢复和收尾断言未知，**不能记为通过**。
2. 第二场直接 `@libsql/client.createClient` 夹具在约 16.69 秒、650 工具时退出。后续捕获 Windows 原生访问异常 `0xC0000005`，事务 open/close 计数相等仍不能证明 native 资源已释放。原日志和数据库保留。
3. 一次 61 条组合回归中 runtime worker 退出；日志显示 42 条已通过与 1 个 unhandled error，整场 exit 1。之后 runtime 单独 26 条通过不抵消这场失败。生产适配器组合回归正在重新验证。
4. 使用当前生产 `LocalSqliteProcessClient` 读取失败数据库的独立副本：最新摘要约 146 ms，但准确 4100 历史摘要耗时 **107141 ms**，确认为生产查询热点。仅强制索引仍不能匹配表达式键；第二条慢查询超过两分钟后仅终止其自有进程，记录为人工中断。
5. 修复表达式索引键匹配后，新进程读取独立副本：最新摘要 124 ms，完整准确 4100 摘要 **53 ms**；固定页 200 项、完整单工具详情和 terminal outbox 正确，全部约 187 ms。原失败数据库未修改。这是历史读取验证，不是新 10000 写入验收。
6. 新增真实 UI fixture 首轮在握手失败：测试 `/meta.subagentSchemaVersion` 误填 2，而基础 manifest 要求 1；增量协议 2 应由 capabilities 协商。已只修 fixture 的一行字段，保留产品和断言。协调方第二轮前两条通过；第三条因旧 button 选择器与实际 tab 角色不符失败，只修测试的 tab 角色和选中确认，旧页面不得回写的断言不变。最终协调方在新客户端 guarded build `uaAWyy`（sourceStable=true）上串行执行，三条全部通过，旧失败证据保留。
7. 新 anchor 接入后一次 production 核心组合为 54 passed／7 failed：JSONL 文件描述符重复关闭、runtime 重开夹具迁移遗漏、旧投影夹具缺 turn。文件读取改为 `handle.read`，重开使用生产适配器，夹具补真实轮次身份；最后同一核心组合 **61 passed／0 unhandled／exit 0**，保留之前失败日志。
8. 最后工具与 anchor 七文件合组首轮为 50 passed／1 failed：overview 测试手工追加的父 dispatch 缺少轮次，strict anchor 正确拒绝。读取生产 ReAct 确认 dispatch 实际携带 `ctx.conversationId`；只补该夹具 user／dispatch 的父轮次，原父结果落盘与 canonical 顺序断言不变，单项复跑 1／1 通过。不能将两轮拼成一场 51 条一次性通过。

最新生产适配器 10000 工具计数里程碑（旧 ordinal 1 尚未最后完成、terminal 尚未提交）：20041 条事件共 51447513 字节，最大单事件 3130 字节；checkpoint 共 25168338 字节，最大 1539 字节；19999 条单工具详情版本共 15249091 字节，摘要共 19124403 字节；immutable record 仅一份 9301 字节。随后旧 ordinal 1 最后完成和 terminal 提交到 seq 20043，resident 为 64 项／81230 字节，最近完成活动准确可见；重开后 4100 历史、terminal 和 outbox 断言通过。

fixture `QPVSMo` 已保留：`fixture.db` 为 188219392 字节，另有 WAL 4247752、SHM 32768 和 evidence 22418 字节；目录总量不是数据库主文件的口径。宿主峰值 RSS 259858432 字节，未包含 SQLite helper；序列化 1478817 次、累计 5278932973 字节。固定 64 项窗口的重复序列化仍存在，其增长近似线性，不能称为没有重复成本。

证据位于 `.ae/tmp/subagent-durable-first-worker-failure-20261013.md`、`subagent-durable-second-20261013.log`、`subagent-durable-worker-exits-20261013.jsonl`、`subagent-durable-copy-after-unary-20261013.log` 和 `subagent-projection-v2/`。这些是隔离测试的证据，不属于旧正式失败轮。

## 待完成与适用限制

- 使用当前生产适配器的新 10000 工具写入、固定历史恢复、故障、重启与收尾已完整执行通过；新增查询计划回归已单独通过。后续普通回归不无理由重写同一场 10000 夹具。
- 窄父 dispatch-anchor API 已完成并冻结，23 条新测试及最终生产适配器 61 条组合通过；61 之后全 engine typecheck 独立 exit 0，历史失败日志保留。
- 窄 anchor 仍受 JSONL 最大单行大小影响；summary 隐藏的旧 dispatch 维持既有不投影行为；anchor 查询后到 append 之间的删除竞态尚未跨后端事务化。不能将窄查询优化描述成上述问题全部解决。
- 真实 Electron 子代理历史三条用例已由协调方串行执行全部通过，证据目录为 `.ae/qa/post-soak-ui-electron-20261013-current/`；覆盖仅一项摘要仍显示 4100 总数、固定版本分页与最多 128 项窗口、32 KiB 分段详情、切任务后旧分页响应不得回写。协调方报告原生异常为 0。本聊天未运行第二场 Electron，不将 `--list` 或其他测试结果算入这三条，也不将整个 49 项组合称为全部通过。
- 单个非工具对话正文超过 512 KiB 尚无服务器分段 API，目前保留旧窗口并提示；不能声称所有巨型正文均可完整查看。
- 单 child/window 已有配额，但 `listRunViewsForParent`、`getViewsAtSequences` 的全 child 集合与 stream 的 `childSequences` 身份映射仍随整个会话 child 数增长。全会话总边界尚未封顶。
- 10000 工具测量中的 RSS/heap 首先是测试宿主数据；必须将 SQLite helper 的资源口径单列，不能据宿主平台值推断全部进程内存有界。
- 旧正式轮 `six-20261013T053618730Z-X1OiPw` 仅运行约 22.878666 分钟，包含清理取消超时、shutdown 无 ACK 和 forced exit 1，不能称为 60 分钟通过。源码汇合后需重新构建、冻结候选、串行 E2E，再正式持续测试。

## 冻结证据

核心最后合组于 16:16:52 开始，10.43 秒完成；日志为 `.ae/tmp/subagent-projection-v2/subagent-narrow61-production-final-20261013.log`。16 个关键源码与夹具的前后哈希完全相同，清单为 `sourcehash-final61-20261013.json`。本域产品源码、接口与 UI 已冻结，协调聊天可以在独立候选目录构建；本报告的文字更新不修改产品。

- store SHA256：`10D7D999D55BB26C9930E1DF25B5E2E27BFE6E04E655550E8097BF9E48FD962E`
- runner SHA256：`ADCB5D7AF060FC49A4B66FB6AE5DD2241889CC1A396EAAC4817062D23438ACC8`
- view SHA256：`0AB017E83E13490512836B91DCA7392C470C7F175470AE94DEF2DFF461859B3C`
