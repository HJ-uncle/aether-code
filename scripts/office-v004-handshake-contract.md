# v004 从 v002 恢复的严格校验合同

`verify-office-v003-handshake.mjs` 保留原函数名与默认 v003 行为。新参数仅允许 targetRevision 为 v003/v004，sourceRevision 与 baseRevision 都必须为 v002。v004 跳过被拒 v003，从六角色的 v002 原始字节输入建立新链路；这不代表 v002 业务已验收，也不撤销 v003 已发生的不可变性失败。

```powershell
node scripts/verify-office-v003-handshake.mjs --company <company目录> --target-revision v004 --source-revision v002 --base-revision v002 --rejected-identities <冻结ledger.json> --output <公司目录外的新G2报告.json>
node scripts/verify-office-v003-handshake.mjs --company <company目录> --target-revision v004 --rejected-identities <同一冻结ledger.json> --baseline <v004原始G2报告.json> --output <公司目录外的新终验报告.json>
```

首次未提供独立 v004 基线、或尚无下游产物时仍为 incomplete。不得为变绿临时重建过去的原始发布基线。输出用 `wx` 创建新文件，不覆盖旧审计报告。CLI 未知/重复选项直接拒绝；目标版本不会自动从文件名推断。

固定业务路径仍为 `published/<role>/v004/manifest.json`、`published/pmo/v004/decisions.json`、`published/<role>/messages/*.json`、`published/<author>/closures/v004/*.json`。**v003/messages 这种嵌套布局只用于发现拒用身份，不会被认可为新的决议投递布局。** 每个 target manifest、decision、decision envelope、ACK 的 baseRevision 均为 v002；receiverBaseRevision、sourceRevisions、conflict proposals 的来源也只能为 v002。应用文件只能绑定同角色 v004 manifest；closure 的 subjectRevision/appliedManifest.revision 都只能为 v004。

原有所有数值 schemaVersion、精确路径/作用域、非空应用、收件者、nonce、原消息正文 SHA、决议 SHA、manifest SHA、五个真实 ACK、两份收口及审计前后字节复核全部保留。v004 closure 的独立 schema 是 `office-v004-closure.schema.json`；旧 v003 schema 的 const 不变。

## 冻结拒用身份清单

API 的 `rejectedIdentityLedger` 必须为实际文件路径；CLI 是 `--rejected-identities`。v004 缺省该项不能通过；v003 显式传入该项也会拒绝，避免以为默认调用审了恢复流程。ledger 的真实文件及所在目录必须位于 company 外，目录也不能是 company 的祖先；链接不能把业务文件伪装成外部 ledger。

ledger 顶层精确字段如下，未知字段同样拒绝。四个数组都必须非空、无重复、最多 4096 项；身份不自动修剪或转小写。messageId/decisionId 为 1–256 字符、无控制字符和首尾空白；nonce 为 22–128 个 `A-Za-z0-9_-` 字符。

```json
{
  "schemaVersion": 1,
  "kind": "office-rejected-identities",
  "rejectedRevision": "v003",
  "targetRevision": "v004",
  "sourceRevision": "v002",
  "evidenceSet": { "path": "v004-rejected-identity-evidence-set.json", "sha256": "实际原字节的64位SHA" },
  "messageIds": ["从原件提取的已知messageId"],
  "messageNonces": ["从原件提取的已知nonce"],
  "decisionIds": ["从原件提取的已知decisionId"],
  "decisionNonces": ["从原件提取的已知decisionNonce"]
}
```

示例中的说明文字不是合法身份/SHA，必须用实际原件值。机器定义见 `office-rejected-identities.schema.json`。

authority evidence set 也必须为冻结文件，路径相对 ledger 目录并由 SHA 钉住。其固定合同是：

```json
{
  "schemaVersion": 1,
  "kind": "office-rejected-identity-evidence-set",
  "rejectedRevision": "v003",
  "coverage": "known-v003-identities",
  "sources": [
    { "scope": "ledger", "path": "rejected-v003-snapshot/v003/decisions.json", "sha256": "实际原件SHA", "kind": "decision" },
    { "scope": "ledger", "path": "rejected-v003-snapshot/v003/messages/实际消息.json", "sha256": "实际原件SHA", "kind": "message" }
  ]
}
```

机器定义见 `office-rejected-identity-evidence-set.schema.json`。source 的四字段不可省略，也不接受任意 JSONPointer、basename 替代或重新构造的旧正文：

- `scope=ledger`：相对 ledger 所在目录，适合保存真正原字节的审计副本。
- `scope=publication`：相对 company/published，只允许公开文件；不能读取其他角色的私有工作区。
- `kind=message`：包含原始 messageId 的 v003 消息。`kind=decision`：带 decisionId/decisionNonce 的原决议，不能用消息 envelope 冒充。
- `kind=supporting`：保全 index、SUPERSEDES、manifest 等 v003 JSON。其顶层及 `messages`/`supersededMessages` 索引行中显式出现的四种身份也纳入集合，不能用该 kind 隐藏实际消息。

至少有一份真正 message 和 decision 来源。必须保留首次消息、重发/替代消息、superseded 副本及已掌握的旧原件；重复身份可以出现在不同原件里，ledger 最终数组必须是全部来源提取身份的精确并集。缺来源、错误 SHA、空集合、凭空加入身份、漏身份、重复来源路径、未知字段或越界都不能通过。源 JSON 上限 4 MiB，总读取文件上限 1024，来源上限 512；目录每层最多 512 项、最大深度 8。

校验器还扫描当前六角色的 `messages/` 与 `v003/messages/`（含 superseded 子目录），以及 PMO v003 decisions；发现清单未包含的已知身份就拒绝。目录成员及不存在状态会固定，结束时新增/移除成员也会使审计失败；嵌套目录链接会明确拒绝，不会跳过后宣称已覆盖。读取期间与审计结束时会再次核 ledger、authority 及所读来源的字节。新 v004 的四类身份不得复用四个拒用集合中的任意值，包括换字段复用；五个新决议消息正常共享其本轮新 decisionId/decisionNonce 不受影响。

`rejectedIdentityLedger.ledgerSha256`、evidenceSetSha256、来源路径/SHA/字节数与集合计数写入报告。**这只证明冻结集合与当前可见 v003 文件中已知身份的覆盖，不能证明每个中间正文都有备份，也不能证明 v003 过去没有改写。** 已有失败报告和初始原件基线仍必须保留。

首次 v004 G2 门禁必须将报告 ledgerSha256 与 root 在业务派发前独立冻结的 SHA 比对。文件内部对自己来源的引用，不能独立证明它从最初批准时起未被整体替换；后续则由原始 v004 baseline 的 ledger 指纹继续约束。

## v004 原始基线与现场观测

v004 基线仍须覆盖七个原件：PMO decisions、manifest、五份真正投递到收件者的原始决议消息。每次按基线 SHA 比较，不因后来文件自洽而放行。报告的 observedSnapshot 另钉 targetRevision/sourceRevision/baseRevision 和 rejectedIdentityLedgerSha256；后续更换 ledger、传旧 v003 基线或缺 ledger 指纹均不能通过。

准备好的 `.e2e-tmp/start-owned-office-ui-load-probe-v004.mjs` 只绑定 `v004-sequenced-20261024-<role>` 六个实际 admission；PMO staging root 不能代替最终发布 root。它未执行，也不会启动新应用。仍是“五角色应用并发、六会话切换”：PMO 完成后，五应用角色运行。查询沿用 `.e2e-tmp/query-owned-office-ui-load-probe.mjs`。
