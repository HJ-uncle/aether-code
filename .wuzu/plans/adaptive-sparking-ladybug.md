<!-- wuzu-plan:begin
session: sess-00rptzkp-mum1wfzl
mirroredAt: 2026-09-29 11:21:28
path: D:\dev\aether-code\.wuzu\plans\adaptive-sparking-ladybug.md
wuzu-plan:end -->

# 引擎会话存储迁移：SQLite → JSONL（Claude Code 格式）+ 压缩机制照抄 Claude Code

## Context

当前引擎（D:\dev\ai-agent-engine）把会话消息存在 SQLite 的 `conversations` 表里，长期使用的顾虑是单库膨胀与运维复杂度；同时现有压缩机制（无结构 prompt、keepRecent=6、无回滚、物理删除）与 Claude Code 差距明显。目标：**会话消息存储换成 Claude Code 的 JSONL 追加式格式（旧行永不删除、压缩以 summary 行追加），压缩机制照抄 Claude Code（6 段式 prompt、92% 阈值、token 预算回溯保留）**。Claude Code 格式已从 2.1.266 二进制逆向确认，引擎侧接缝（ConversationHistory 接口）已盘点清楚。

非目标：sessions/todos/file_changes/缓存等其它表**继续留在 SQLite 不动**；IDE 侧（aether-code）无需改动（HTTP 接口不变）。

## 关键设计决策

| 决策点 | 选择 |
|---|---|
| 存储布局 | `<DATA_DIR目录>/sessions/<tenantId>/<sessionId>.jsonl`（sessionId 全局唯一，不按 cwd 分桶） |
| 写入方式 | 追加写（appendFile），每行一个 JSON；旧行永不物理删除 |
| 行格式 | 公共字段对齐 Claude Code：`type/uuid/parentUuid/timestamp/sessionId/cwd/gitBranch/version/isSidechain`；引擎特有字段（conversationId/toolCall/usage/reasoningContent/modelId/metadata）放 payload；加 `dbSeq` 单调递增序号替代 SQLite rowid |
| 行类型 | `user / assistant / tool / system / summary / update / tombstone`（引擎子集） |
| 编辑消息 | 追加 `type:"update"` 更正行，读取时折叠（后写覆盖先写），不重写文件 |
| 删除/截断 | 追加 `type:"tombstone"` 行（scope: message/conversation/truncate/clear），读取时过滤；truncate 取 max(afterSeq) 避免「复活」 |
| 压缩 | 追加 `{type:"summary", summary, leafUuid, leafSeq, preTokens, postTokens, transcriptPath}` 行；读取时跳到 leafSeq 之后；旧行保留 |
| 压缩 prompt | 照抄 6 段结构（Primary Request and Intent / Key Technical Concepts / Files and Code Sections 含完整代码片段 / Errors and fixes / Problem Solving / All user messages verbatim），输出包 `<summary>...</summary>` |
| 触发阈值 | `COMPRESS_THRESHOLD_RATIO` 默认 0.5 → **0.92**（相对 tokenBudget，env 可调） |
| 保留策略 | 从尾部按 token 预算回溯（预算 = tokenBudget×0.2），保底 floor(n/2) 条原文 |
| 数据迁移 | **懒迁移**：首次读某会话时若 jsonl 不存在 → 从 SQLite 读出 → 原子写入 jsonl（临时文件+rename）→ 写 `.migrated` 标记；SQLite 旧行保留不删 |
| 灰度 | 工厂 `createConversationHistory()` + env `HISTORY_BACKEND=sqlite\|jsonl`，先默认 sqlite 灰度，稳定后切 jsonl |

## 实施阶段

### Phase 0 — 准备（纯加法，零风险）

新建（引擎仓库）：
- `src/storage/conversation/jsonl-history.ts` — `JSONLConversationHistory` 完整实现 ConversationHistory 接口：
  - `append`：构造行（uuid/parentUuid 链/dbSeq）→ appendFile；per-session Promise 队列串行化写入
  - 私有 `loadSession`：读全文 → 逐行 JSON.parse（坏行 try/catch 跳过+warn）→ 折叠 tombstone/update/summary → 内存缓存（mtime+size 失效）
  - `getHistory`：loadSession → 复用现有 applyTokenWindow 滑窗（纯函数照搬）
  - `getRawTokenCount`：缓存的折叠视图求和；`getSessionUsage`：JS 遍历累加替代 json_extract
  - `getMessageById`：内存反向索引 messageId→sessionKey，未命中扫 tenant 目录（逐行流式读，命中即停）；dbId 返回 dbSeq
  - `deleteMessage` / `deleteByConversationId` / `deleteMessagesAfterId`：追加对应 scope 的 tombstone
  - `updateMessageContent`：追加 update 行
  - `clear`：墓碑 + append clear tombstone + 文件 rename 为 `.jsonl.<ts>.bak`
  - `listSessions`：扫 jsonl（首条 user 做 title，全量做 count/usage/lastAt）+ SQLite sessions 表补 agentId/metadata + 未迁移旧会话并集（sessionId 去重，JSONL 优先）
  - `compress(ctx, summarizeFn, opts)`：token 预算回溯切分 → summarizeFn(older) → 追加 summary 行，**不删旧行**；返回 `{preTokens, postTokens}`
  - 懒迁移：jsonl 不存在且无 `.migrated` 标记 → 从 SQLite 转换写入
- `src/storage/conversation/factory.ts` — `createConversationHistory(maxTokens?)` 按 env 返回两种实现
- `src/core/agent-loop/compact-prompt.ts` — 6 段式 prompt 模板 + `buildCompactSummarizeFn(llm)`（含 `<summary>` 正则提取、temperature 0.3、超长输入截断）

接口扩展（`src/core/agent-context/types.ts`，全部可选参数、非破坏）：
- `compress` 返回值 `void` → `{preTokens, postTokens}`
- `compress` 第三参 `keepRecent` → `opts?: { keepRecentTokens?: number }`
- 新增 `deleteMessageCascade(messageId, tenantId)`（把 messages.ts:75-115 直写 SQL 的级联删除下沉进接口）
- `getMessageById` 加可选 sessionId hint

验证：新增 `jsonl-history.test.ts`（append/滑窗/tombstone 折叠/update 折叠/summary 跳跃/坏行跳过/迁移 mock）；现有测试全绿（默认 sqlite 后端）。

### Phase 1 — 压缩机制先落地（独立于存储后端，两套后端都受益）

- `src/core/agent-loop/react.ts:288-331`：换用 `buildCompactSummarizeFn(this.llm)`；阈值 0.92；`compress` 传 `keepRecentTokens = tokenBudget×0.2`
- `src/storage/conversation/history.ts` `SQLiteConversationHistory.compress`：保留策略改 token 预算回溯 + floor(n/2)；补事务（clear+重写包在事务里，失败回滚——顺带修掉现有「半重建」风险）
- `src/api/http/routes/conversation.ts:202-275` 手动端点：统一用 `buildCompactSummarizeFn`；改为调 `history.compress`；stats 用返回值；压缩反馈消息 metadata 带 transcriptPath

验证：改造 `compress.test.ts` / `compress-perf.test.ts` / `history-compress-tombstone.test.ts`（断言 6 段 prompt、`<summary>` 解析、保底一半、pre/post tokens）；`react.test.ts` 不受影响。

### Phase 2 — JSONL 后端灰度上线

- 5 处实例化点换工厂：`chat.ts:582`、`flow-executor.ts:116`、`subagent-tool.ts:301`、`conversation.ts:13/57`、`messages.ts:42`
- `messages.ts:75-115` 直写 SQL 段改调 `deleteMessageCascade`
- 懒迁移 + listSessions 两步拼接
- 默认 `HISTORY_BACKEND=sqlite`，灰度环境切 jsonl 观察

验证：新增 `jsonl-migration.test.ts`（SQLite 造数据 → 触发迁移 → 内容一致 + 标记存在 + 旧行仍在）；`history-maxTokens.test.ts` 参数化跑两套后端；手工 E2E：发消息→查文件→重启→历史在→删除/编辑/截断/压缩全链路。

### Phase 3 — 默认切换 + 清理

- 默认 backend 改 jsonl；sqlite 保留一个版本作逃生门
- `scripts/migrate-history-to-jsonl.ts` 全量迁移脚本（可选）
- .bak 清理任务（clear 备份保留 7 天）

验证：两套后端全量测试；compress-perf 基准对比（JSONL listSessions 冷启动 ≤ SQLite 2 倍为可接受）。

### Phase 4（可选增强）— 后台预生成摘要

照抄 Claude Code 两阶段：92% 时后台预生成摘要暂存，prompt-too-long 时换入。独立迭代。

## 主要风险与缓解

- **deleteMessagesAfterId 语义变化**（rowid 物理删 → dbSeq 逻辑删）：truncate tombstone 取 max(afterSeq)；接口注释写明
- **updateMessageContent 追加行导致文件膨胀**：编辑低频；后续可加 vacuum 物理合并
- **listSessions 扫全部 jsonl 冷启动慢**：mtime+size 缓存 + 异步预热；必要时 Phase 3 加 `.index.json` 落盘索引
- **多进程部署不支持**（JSONL 无跨进程锁）：文档注明；多进程场景留 sqlite 后端
- **阈值 0.92 压缩输入更长可能超模型窗口**：buildCompactSummarizeFn 内做总输入 cap 截断；监控压缩失败率
- **Windows 文件锁导致 clear 的 rename 失败**：append 队列排空后 rename，失败退化为只写 clear tombstone
