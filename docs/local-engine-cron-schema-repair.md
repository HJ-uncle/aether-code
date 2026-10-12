# 开发引擎 cron_jobs 启动错误修复

日期：2026-10-12。

用户日志中的致命错误为 `SQLITE_ERROR: error in table cron_jobs: no such column: integer`。`Active code page: 65001` 是编码设置输出，`ENCRYPTION_KEY is not set` 是已有开发密钥警告，两者不是本次退出原因。

## 原因与数据库范围

本次命令行开发启动使用 `D:/dev/ai-agent-engine/data/agent.db`，与客户端使用的 `AppData/Roaming/aether-code/engine/state/agent.db` 是不同数据库。

开发库约 79 MB，包含 198 条会话、0 条定时任务。只读检查确认其旧 `cron_jobs` 定义为：

```sql
timeout_seconds INTEGER CHECK (
  timeout_seconds IS NULL OR (
    typeof(timeout_seconds) = "integer"
    AND timeout_seconds BETWEEN 1 AND 86400
  )
)
```

这里的 `"integer"` 曾被旧建表/加列操作作为字符串接受；后续 SQLite `ALTER TABLE ... DROP COLUMN` / `RENAME` 严格重新解析整个数据库结构，将它识别为列名。当前会话表仍有淘汰的 `deleted_at` 列，启动移除它时触发了错误。不是缺少一列需要补 `integer`，也不能只修改当前 027 迁移：现存表定义早已写入数据库，必须先规范化它。

该问题已在真实开发库副本及实际 LocalSqliteProcessClient 中精确复现。客户端数据库的同一 CHECK 使用正确单引号，与此前子代理积压导致的启动问题属于两条不同故障链。

## 修复

新增 `src/storage/sqlite/schema-compatibility.ts`，并在 `db.ts` 的完整初始化和 `migrate.ts` 的命令行迁移执行其他迁移之前调用。

- 精准匹配已知旧 CHECK 的 SQL token，排除注释、默认字符串、不同大小写的引号值及真实 `integer` 列引用。
- 写事务取得锁后重新读取表定义，避免并发修复覆盖新 schema。
- 将原表定义、版本和修复时间保存在 `_aether_schema_repairs` 中，与修复在同一事务提交。
- 参数化更新这一条 `sqlite_schema` 记录，将 `"integer"` 改为 `'integer'`；递增 schema 版本并重载解析缓存。
- 校验表结构与已有定时任务约束后提交。失败时回滚、关闭 schema 写权限并重载缓存；不能确认安全关闭时丢弃连接。
- 不重建表，不删除任务、会话、索引或触发器，不全局放宽 SQLite 引号规则。已正确的数据库不变。

## 原库数据保护与结果

先用只读源连接创建了一致备份：

`D:/dev/ai-agent-engine/data/backups/agent-before-cron-schema-20261012-181343-f4fd9a93.db`

备份大小 79,372,288 字节，完整性检查为 `ok`。副本修复和完整初始化成功后，才对开发原库执行正常初始化修复。

开发原库已修复，198 条会话的 `(id, session_id, role, content)` 哈希在修复前后和备份完全一致；数据库完整性检查仍为 `ok`。哈希为 `ff319615bcb9a662c6a74eb9f761cbec198b1cbe768701e45d6d674f4c438a71`。

## 验证

| 检查 | 结果 |
| --- | --- |
| 真实旧开发库副本初始化，修复前 | 56 ms 内复现同一 `no such column: integer` |
| 副本预修复后完整初始化 | 129 ms，198 条会话内容保持，完整性 `ok` |
| 使用真实 `src/main.ts` 与修复后用户副本启动 | 3.669 s，`/health`、`/meta`、`/api/v1/tools` 全部 HTTP 200 |
| 开发原库修复 | 内容哈希与备份一致，完整性 `ok` |
| 存储、迁移、子代理相关 Vitest | 92 passed / 0 failed |
| 引擎 `npm run typecheck` | 通过 |
| 引擎 `npm run build` | 通过 |
| 客户端 `npm run build`，含 Node / Web typecheck | 通过 |
| 真实 Electron 启动、生命周期与 LSP 回归 | 13 passed / 0 failed / 1 skipped |
| 客户端内置引擎同步及运行时验证 | 通过，构建 ID 与同级引擎一致 |

新增 7 条真实 SQLite 子进程回归，覆盖数据/rootpage/索引/触发器/外键保留、约束继续有效、启动顺序、重复重开幂等、校验与提交故障的原子回滚、真实列引用及默认字符串不误修复。Electron 的唯一跳过项是测试环境无 OS safeStorage，无法验收远端凭据加密保存，与本地启动修复无关。原库没有启动诊断 HTTP 服务；完整服务检查使用其隔离副本，检查后已关闭自建服务。

修复引擎构建 ID：`sha256:0facf9f5276149d28ad5c4dfbb5e244a44af9d75a8b57cb46bda75eeba3b63b3`。

## 使用

重新运行之前使用的 `npm run dev:win`，或在客户端中重启本地引擎。旧开发数据库已修复；后续遇到同类旧库，启动兼容步骤会自动处理。保留数据库备份即可，不需要清空 `data/agent.db` 或重新配置已有会话。
