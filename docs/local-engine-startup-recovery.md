# 本地引擎启动失败：诊断与验证

日期：2026-10-12。

## 原因

当前开发客户端选择 `dev-sibling`，入口为 `D:/dev/ai-agent-engine/dist/main.js`，自动启动使用端口 12366。引擎程序、Electron 的 Node 模式和内置独立 Node 均能使用隔离新数据库正常启动。

真实状态数据库位于 `C:/Users/wb.xielin02/AppData/Roaming/aether-code/engine/state/agent.db`，大小为 11,676,123,136 字节，约 10.9 GiB。只读核验结果：

| 项目 | 数量 / 数据量 |
| --- | --- |
| 会话表 | 0 条 |
| 子代理事件 | 5,656 条，约 5.82 GB 完整快照 |
| 子代理 outbox | 5,656 条，同样重复保存约 5.82 GB |
| 未确认 outbox | 5,315 条，5,798,223,896 字节 |
| 真正需要投影的结束事件 | 4 条，6,231,333 字节 |

原实现将每次工具、输出和用量更新的完整快照同时写入事件表与 outbox。服务开始监听之前，`main.ts` 调用 `projectPendingSubagents()`；旧版一次取出全部未确认 JSON，经 SQLite 子进程 IPC 传入引擎，再逐条判断是否为结束事件。绝大多数记录仅为确认而读取，没有需要写入父会话的内容。

因此实际状态会使引擎在开放 HTTP 端口前处理约 5.8 GB 的数据，触发内存溢出或超过客户端 60 秒的启动时限。隔离合成测试重现了这一机制。未捕获原失败进程的完整崩溃栈，因此原实例最终表现为 OOM 还是启动超时，不能只凭数据库指标确定。

## 修复

- `src/core/subagent/store.ts`：新运行仅将 `finished` 且为结束状态的结果放入父会话同步队列；过程事件仍完整归档。
- 同一文件：使用 `(tenant_id, run_id, seq)` 联合键关联事件表，在 SQLite 内过滤旧过程记录，再读取有界分页。默认页大小为 32，投影调用每次只读取 1 条。页大小不限制任务数量或最终恢复数量。
- `src/core/subagent/projection.ts`：逐条持久化父会话，再确认队列；写入失败时保留待恢复结果，仍使用稳定消息 ID 防止重放重复。
- `002_add_message_id.ts` / `003_drop_deleted_at.ts`：停止启动时重复添加、删除已淘汰列，保持旧库升级和回滚兼容，并传播真实迁移错误。真实会话表为空，此项属于另一个缺陷，不是本次 5.8 GB 加载的原因。

未清空真实数据库，未删除或改写历史事件、旧过程 outbox，也未对真实数据库执行迁移或投影。对真实数据库采用 `mode=ro` 和 `query_only=ON` 复核新查询：4 条结束结果共 6,231,333 字节；单页 1 条、1,482,120 字节；读取及解析共 124 ms。

## 验证

| 验证 | 结果 |
| --- | --- |
| 引擎 `npm run typecheck` | 通过 |
| 引擎 `npm run build` | 通过 |
| 全部子代理与启动迁移 Vitest | 76 passed |
| command-jobs HTTP / 历史生命周期 Vitest | 17 passed |
| 客户端 `npm run build`，含 Node / Web typecheck | 通过 |
| 真实 Electron `engine-host-contract` 与 `lsp-diagnostics` | 13 passed / 0 failed / 1 skipped |
| 客户端 `npm run prepare:engine` | 内置运行时已同步修复版，验证通过 |

Electron 唯一跳过项是远端凭据的操作系统加密存储验收：测试环境无 `safeStorage` 能力，按用例约定跳过，与本地启动修复无关。

使用实际 libsql、SubagentStore、SQLite 历史和 Fastify 构造 256.3 MiB 的旧队列，并将 V8 堆限制为 128 MiB：

| 项目 | 旧版 | 修复版 |
| --- | --- | --- |
| 运行结果 | 1.168 s 后 OOM，退出码 134 | 正常退出 0 |
| 投影完成 | 未完成 | 2.198 s |
| 投影后内存 | — | RSS 70 MiB / V8 heap 9 MiB |
| 结束结果 | — | 3 条，二次重放无重复 |
| 实际 HTTP `/health` | 未到达 | 3.663 s，200 |
| 事件归档 | — | 518 条、268,777,224 字节完整保留 |
| 旧过程队列 | — | 515 条原样保留 |

旧版 OOM 栈包含 `ValueDeserializer::ReadValue`，与 SQLite IPC 全量结果进入 JavaScript 堆的路径一致。HTTP 服务初始化后修复版 RSS 为 235 MiB、V8 heap 为 94 MiB，不能将 RSS 与 V8 heap 限制混为一谈。

隔离探针、SQLite 子进程和测试窗口均已关闭，合成数据库夹具已删除。合成脚本、旧代码快照及 JSON 结果保留在 `.e2e-tmp/engine-outbox-repro/`。

## 使用与范围

修复构建 ID：`sha256:250b97a45ed12e00c79e61f87207629dd82e7439eface69754c54141942ddee9`。

`resources/engine/win32-x64` 已重新生成，并通过 SQLite 子进程/事务/重开与记忆库、CodeGraph 生命周期、PTY 原生模块加载、TypeScript、语言服务器和 7 个内置技能验证。开发同级引擎与客户端内置产物使用同一修复构建 ID。

开发客户端下次启动本地引擎将使用重新构建的同级入口。在设置的引擎管理中重试启动，或重新启动客户端即可。当前用户窗口未被强制关闭；真实用户数据库启动后的就绪状态尚需该实例重试确认。

已有旧 TGZ / 已安装客户端的不可变运行时不会因同级源码构建自动更新，需要从修复版重新生成、打包或导入引擎。

本次恢复修复不回收数据库文件空间。旧过程事件仍占磁盘；事件 HTTP 回放接口仍可能一次读取单个任务的全部历史。这两项与启动链路独立，本次保留数据和原 API 语义。
