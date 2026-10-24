# v003 决议、nonce、ACK 与收口核验

`verify-office-v003-handshake.mjs` 只读公司工作区。它验证通信与文件证据链，不计算财务结果、不渲染 Office、不声称 OS 隔离或业务全部通过。角色提示约束与继承整个 company 的真实读权限必须分别报告。

```powershell
node scripts/verify-office-v003-handshake.mjs --company <company目录> --output <公司目录外的新报告.json>
node scripts/verify-office-v003-handshake.mjs --company <company目录> --baseline <G2报告.json> --output <公司目录外的新终验报告.json>
node --test scripts/__tests__/office-v003-handshake.test.mjs
```

退出码：0 为证据链通过；2 为缺产物/未确认/缺基线等未完成；1 为已经观察到协议或哈希失败。两者同时存在时结果为 failed，并逐项保留 incomplete，不能误报全通过。报告只能写入 company 之外，且使用新路径，避免覆盖旧证据。

第一次在 G2（PMO v003 决议、manifest 和五条消息均已冻结，其他五角色未产出 v003）运行，缺下游为正常 incomplete；保存报告的 `observedSnapshot`，下轮通过 `--baseline` 传该完整报告或快照。基线必须覆盖这七个原文件。所有已观察引用文件均在审计结束前再次核 SHA，防止审计过程中被改写。

输入固定路径：`published/<role>/v002/manifest.json`、`published/<role>/v003/manifest.json`、`published/pmo/v003/decisions.json` 和各角色 `messages/*.json`。不为适配脚本重写旧 v001/v002。**v003** manifest、decision、消息、ACK、closure 的 schemaVersion 为数值 1。原合同的 artifact `path/relativePath` 默认相对角色发布版本；`scope="workspace"` 则相对本人角色目录。只支持这些明确的边界，不用遍历或 basename 搜索猜文件。

v002 仅作为历史身份与原始字节输入：固定位置、有效 JSON、role/v002/baseRevision=v001 和真实 SHA 必须正确。`history.<role>.v002.identity-bytes` 通过不等于历史业务或 schema 通过；报告明确保留 `historicalAcceptance="not-validated"`、`historicalInputs` 与 `legacyFindings`。旧 schema 字符串、错误 scope/path、缺文件或不匹配的 artifact 声明仅按原声明诊断，不作猜测修复；这些历史缺陷不会被改成“历史 manifest 已验收”。历史身份错误、读取期间改写或决议钉住的历史 SHA 不符仍然阻止新链路通过。原失败报告需保留，不能覆写。

决议保留既有 `conflicts:[{proposals:[{role,revision,amount,evidence}]}]`，每个冲突至少两方不同角色，proposal 必须是六角色之一的 v002，amount 为有限数值。proposal.evidence 非空，条目 `{path,sha256}`（或既有 relativePath），**path 相对 `published/<proposal.role>/<proposal.revision>/`**；可附 sheet/cell/section 定位。scope 省略或明确 publication/published。实际公开文件逐一精确核 SHA，禁止 workspace、未知 scope、路径越界、按 basename 找替代件；旧 manifest 缺陷不能豁免新提案引用。源文件缺失为 incomplete，实际 hash/路径合同错误为 failed。检查只验证证据身份，不判断提案金额是否正确。

上述提案引用作用域不改变 PMO 决议消息的 `message.evidence`（仍相对 `published/pmo/v003/`），也不推断 decisions 顶层 evidence 的跨角色含义；inputs 引用不在本次新增 proposal 检查合同内。完整业务事实、其他叙述证据与历史质量仍需独立业务审计。握手 passed 可以与未验收的 legacyFindings 并存，不能将其表述为所有旧产物已通过。G1 预跑若尚无 v003 决议、应用和收口，结果应为 incomplete，不能仅因历史兼容而变绿。

接收者 ACK 必须引用原消息的真实字节 SHA、原 nonce/decisionNonce、正确原决议与 PMO manifest SHA，以及自己冻结的 v002/v003 manifest 和已应用产物。空 ACK、未知原消息、串收件人、旧版本、旧 SHA、不同正文的重试都不能通过。无关部门间旧版本交接由原业务验收器处理，不将它们冒充 PMO 决议 ACK。

`nonce` 检查形状、作用域和唯一性；不能凭字符串证明随机源或真实作者身份。作者与 root/run 的认证证据仍来自真实引擎日志。完成回执也不能替代正式文件业务检查。

收口字段的精确补充约定（供尚未派发的 PMO/Compliance closure 提示追加；不要求改写既有业务格式）：

- 新文件写在 `published/<authorRole>/closures/v003/<唯一closureId>.json`，不可变；同内容可在本人 evidence 下保存。多个候选时必须由审查方用 `--closures <paths.json>` 选择精确文件，不按最新写入时间猜。paths.json 形如 `{ "pmo": "published/pmo/closures/v003/实际文件.json", "compliance": "published/compliance/closures/v003/实际文件.json" }`。
- 顶层：`schemaVersion:1, closureId, createdAt, authorRole, subjectRevision:"v003", status:"complete"|"incomplete", decisionId, decisionNonce, decisionSha256, pmoManifestSha256, acknowledgements, checks, unresolvedIssues`。
- `acknowledgements` 每项为 `{role,messageId,nonce,messageSha256,ackPath,ackSha256,appliedManifest,appliedArtifacts}`。messageId 指 PMO 给该角色的原决议；ackPath 指收件者真实 ACK，均按 company 根相对路径核验。
- `appliedManifest` 为 `{role,revision:"v003",manifestPath,manifestSha256}`；`appliedArtifacts` 为 `[{workspaceRelativePath,sha256}]`，与该 ACK 真正列出的应用文件一一对应，不能重复一份文件凑数。
- `checks` 每项为 `{id,status,evidence:[{workspaceRelativePath,sha256}]}`。文字写 passed 但无真实文件证据不能通过。引用仅限公开资料、公共输入与本人证据，不跨读别人的私有目录。
- Compliance 另含 `pmoClosure:{workspaceRelativePath,sha256}`，钉住真正检查的 PMO 收口文件。
- 完整收口要求五位不同收件者、全部真实 accepted、检查 passed 且无 unresolvedIssues。缺项应写 incomplete 并保留原因，不能填假 SHA/ACK 或降低问题严重性。

机器字段定义见 `office-v003-closure.schema.json`。schema 不替代真实文件读取；其宽松附加字段允许角色保留既有业务说明。默认调用仍严格验证 v003。本核验器另外支持显式 `--target-revision v004`，来源/base 固定 v002，并强制提供冻结的拒用身份清单；其独立合同见 `office-v004-handshake-contract.md`。不得把默认 v003 的结果、被拒 v003 的基线或重新计算 SHA 当成 v004 验收。
