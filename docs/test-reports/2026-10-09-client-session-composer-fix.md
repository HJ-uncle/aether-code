# 会话模型、思考选择与队列隔离修复

实际问题：正式 R4 的 S2 服务端 configuredModel/actualModel 均为 qwen3.8-flash，原客户端输入栏却显示全局默认 DeepSeek。续聊会把 DeepSeek 明确写入请求，因此并非只影响显示。

## 最终行为

- useChat 仅在来源、会话和恢复请求 generation 一致时发布权威 requested 模型；恢复和 live root 帧均有身份守卫。消息中的 actual/fallback 模型仍按实际用量显示。
- 模型手动选择按引擎来源/账号与会话保存，并记录当时 root run。刷新、切回仍保留下轮选择；外部新 run 请求不同模型时以服务端 requested 为准。新会话使用默认配置。
- 恢复完成前，快速 Enter 不清草稿、不发送全局默认模型。模型恢复不会写全局选择，也不会修改别的会话待发请求；用户手选只 retarget 当前会话队列。
- 已有会话或明确手选的模型，即使不在当前目录，也保留原 ID 并显示配置提示，发送时不静默替换成目录首项。仅新会话、无 run、无明确手选时允许默认选择。
- 目录不是全部调用权限。当前引擎可以使用环境配置的模型，isEnabled 也未在主 chat 中真正禁止调用；本轮客户端保留这两端既有语义，不新增单方阻塞。未知 ID 由引擎按原请求处理并显示真实错误。
- 引擎默认占位“当前配置 of AI”或空 requested 不被猜测成目录/全局模型；未手选时发送省略 model，保留引擎默认语义。当前默认真实模型的完整回读属于另一个接口缺口。
- 思考档位的用户手动选择按来源和会话保存，刷新和切回恢复；新会话使用全局默认。思考说明基于当前输入栏模型的能力。

## 配置审计边界

memoryScope 已有 source/session/generation 保护，未加载时省略字段以免覆盖服务端范围，本轮保持。agentId 已在服务端首次发送时绑定；既有会话请求其他全局 agentId 不会改绑。temperature 由已绑定 Agent 配置，主会话客户端没有 temperature 输入项。

当前 1038 快照不公开外部请求的 thinkingMode、subagentModel、utilityModel 等完整配置。本轮仅证明客户端手动思考选择恢复，不能称从 R4 外部 API 请求恢复了全部参数。正式五会话的不同 body 参数由 driver 请求记录、预检及实际 Provider 模型证据核对。冻结引擎包未改动。

## 构建与专项证据

最终 build（含 node/web typecheck）通过：`.e2e-tmp/session-composer-catalog-build-20261009.log`。之前基础整合构建亦保留于 `session-composer-build-20261009.log`。

专项原始证据：

- 存储 16/16：`.e2e-tmp/session-composer-stores-20261009.json`。
- 真实引擎/Provider 10/10：`.e2e-tmp/session-composer-real-converged-20261009.json`。覆盖 requested 续聊、actual fallback 仍真实显示、手选刷新保留、跨会话队列实际 Provider 请求保持原模型、embedded/remote 思考开关及跨会话恢复。
- 初版受控延迟快照快速发送 1/1：`.e2e-tmp/session-composer-hydration-20261009.json`。真实 Electron 在恢复前不发请求且草稿仍在，恢复后实际 HTTP 使用对应 requested，未误用 global 或 actual fallback。
- 最终补齐目录/默认边界的 31 项汇总专项 31/31 PASS（50.9 秒），原始结果为 `.e2e-tmp/session-composer-final-special-20261009.json` 为准。

正式 R4 修复后真实客户端运行中验收：10 次选择+刷新，全部五会话完整输入栏 title 精确匹配对应 requested，rendererErrors=0。独立结果为 R4 目录的 `client-active-acceptance-composer-fixed.json`，明细和截图在 `client-live-20261009T142740712Z`。原首轮 `client-active-acceptance.json` 和 `client-live-20261009T140809172Z` 均保留；原 helper 仅核对 API 模型，未覆盖输入栏显示，不能代替此次修复后的验收。

## 中间失败与保留范围

新增专项第一次因拼接用例缺换行而语法失败，未执行产品测试，日志 `session-composer-real-20261009.log` 保留。第二次跨会话队列用例直接写主进程设置，没有通过渲染层历史入口选择会话，模型仍为原会话；失败 JSON 和独立 trace 保留在 `session-composer-real-fixed-20261009.*`。改用真实历史列表后原断言通过，未放宽 Provider 模型、消息或队列断言。

中间全套 11937 和 15361 在发现模型缺陷后主动中断，不能记为全套 PASS。原日志分别为 `client-r4-frozen-full-20261009.log` 和 `client-r4-frozen-final-full-20261009.log`，独立 trace 目录保留；按精确 PID+CreationDate 清理，两个 cleanup 证据 remaining=[]、errors=[]，正式 R4 实例未动。最终全套将另用独立文件，避免混合旧 out 与新 source。

## 最终构建的正式运行中复验

目录边界修复后的最终 out 再次通过正式 R4 运行中客户端验收。开始于 2026-10-09T14:54:23.303Z，结束于 14:54:34.752Z；10 次正反会话选择及刷新恢复通过，全部五个会话的输入栏完整 title 与 requested 模型精确匹配，rendererErrors=[]。

独立汇总：R4 的 `client-active-acceptance-composer-catalog-final.json`；明细与截图：`client-live-20261009T145423302Z/result.json`。客户端连接的是真实认证远端实例 `http://127.0.0.1:12499`，buildId 为 `sha256:1038e372195972f9a7277f14933d69e8b20fa56a958d91d4a28af9cb7f0f1fcb`。

此结果为运行中验收，不替代正式任务结束后的全部历史验收或最终客户端全量套件。最终套件枚举为 789 项、121 文件，完整结果另行记录。
## 验收身份与脚本审计

本轮冻结引擎 TGZ：`D:/dev/ai-agent-engine/release/agent-engine-2.0.0-win32-x64.tgz`；SHA256：`904F3C09FAD300AA893940D2FB02F924E21C3C8BE9EAF9C58D2F8BE78F306CCD`。客户端 stage 为 `resources/engine/win32-x64`。最终 renderer bundle 为 `index-DDqvcJ92.js`，更新时间 2026-10-09T14:49:05Z，晚于最近产品源码修改 14:48:26Z。

独立只读审计确认 terminal helper 强制核对全部五会话的完整 archive 和全部实际可用 UI 历史页、用户消息原顺序、每条 ID/turn，并要求最终全部五会话均完成检查。新增每个 manifest 模型必填及精确三个 qwen3.8-flash 前置断言，避免缺失字段绕过模型核对。脚本语法检查和历史 helper 四项测试通过。每个会话是否实际发生分页须依据 archivePages/pages，不能把未翻页的会话计为分页覆盖。actual 等于 requested 是本次正式 Provider 模型约束；合法 fallback 或尚未交付输出导致该断言失败时，需与输入栏恢复缺陷区分。

终态完整恢复验收于 2026-10-09T15:20:34Z 通过：5 会话 794 消息、54 用户消息，10 次选择与刷新，rendererErrors=[]。S2 正式开发 failed 状态保持；详细统计与原始证据见 [R4 终态恢复报告](D:/dev/aether-code/docs/test-reports/2026-10-09-client-r4-final-terminal.md)。最终全量回归运行中。


789 项首轮最终全量已完整结束：743 通过、4 失败、42 serial 未运行、0 显式跳过，不能称全套通过。三处旧全局偏好契约冲突及一个已证实 smoke 测试 profile 锁定失败的根因与修复，见 [本轮完整失败报告](D:/dev/aether-code/docs/test-reports/2026-10-09-client-r4-first-final-full.md)。产品源码和最终 out 未改，50 项专项与新的完整轮将另存独立证据。

## 旧契约收敛专项

首轮完整 789 项失败证据已完整保留（743 PASS、4 FAIL、42 serial 未运行、0 显式跳过）。在冻结产品 src/out 和 1038 引擎身份不变的条件下，只修改 `chat-artifact-link-ui.spec.ts`、`composer-defaults-ui.spec.ts`、`smoke.spec.ts` 三个测试文件，修复冲突的旧全局偏好断言与固定临时 profile 隔离。

受影响 50 项专项全部 PASS，82.6 秒，workers1/retries0，0 失败、跳过、未运行、flaky；原 JSON/log 为 `.e2e-tmp/client-r4-contract-special-20261009.*`。包括真实认证远端交付请求、会话与全局默认隔离、刷新恢复、两模式 memory/security 原全部 CRUD 状态断言，以及40项工作台smoke。新增远端 pageerror 收集未报错。

最终完整复验使用新的 `.e2e-tmp/client-r4-contract-converged-full-20261009.*`，启动前校验 engine dist manifest 为 1038 和 TGZ SHA256 为 904F3C09...；原失败和中断文件未覆盖。此条写入时最终完整复验运行中，不代表完整 PASS。