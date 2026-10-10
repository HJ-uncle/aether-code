# 新冻结引擎：R3 数据副本真实客户端回放

结果：完整回放 PASS，5 个会话各正反切换一次，共 10 次，刷新后恢复 PASS，rendererErrors=0。本轮使用完整验收，未启用 history-only。

## 固定身份与证据

- buildId：`sha256:1038e372195972f9a7277f14933d69e8b20fa56a958d91d4a28af9cb7f0f1fcb`
- TGZ SHA256：`904F3C09FAD300AA893940D2FB02F924E21C3C8BE9EAF9C58D2F8BE78F306CCD`
- 原始 R3：`D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T102756447Z-rkLZAC`
- 新回放：`D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T140101921Z-Tr3tPI`
- 真实 Electron 明细：`client-live-20261009T140202461Z/result.json`，同目录保存 10 张首末历史截图及 10 张会话截图。
- 引擎身份、复制身份、最终结果、进程清理、原数据保护分别保存于回放目录的 `replay-ready.json`、`state-copy-identity.json`、`replay-outcome.json`、`cleanup-processes.json`、`original-preservation.json`。

## 完整核对

每个会话实际读取 `/chat/snapshot`、`/subagent/runs`、`/command-jobs`、`/workspace/directory`、`/workspace/file/content` 及全部 `/conversation/archive` 页面，并通过真实历史列表选择和渲染层验证：

- 两个原项目 3+2 分组；资源管理器根路径和 package.json 内容与原项目一致。
- 3 个 qwen3.8-flash、2 个 deepseek-v4.1-flash；配置模型与实际 Provider 模型均精确匹配。
- 所有可见子 Agent 和命令任务属于当前选择会话。
- 全部五个会话逐条归档读取，无重复 UUID、无跨会话 ID、无遗漏；最新用户与最新 root 的 userMessageId/turnId 一致。
- 完整历史用户的 DOM 顺序与原归档顺序一致，每一条都精确核对 data-turn-id，首阶段与实际最后阶段文本均真实呈现。
- S2、S3 从无用户的压缩快照点击“上下文已压缩”入口，真实恢复全部保留归档用户。10 次切换后刷新，再核对最新用户和所属轮次。

| 会话 | 实际模型 | 归档消息 | 归档 API 分页 | 完整用户及逐条 turn | 原 root 终态 |
| --- | --- | ---: | --- | ---: | --- |
| S1 | qwen3.8-flash | 142 | 142 | 12 | succeeded |
| S2 | qwen3.8-flash | 1158 | 200 × 5 + 158 | 12 | cancelled |
| S3 | qwen3.8-flash | 404 | 200 + 200 + 4 | 13 | succeeded |
| S4 | deepseek-v4.1-flash | 124 | 124 | 11 | succeeded |
| S5 | deepseek-v4.1-flash | 246 | 200 + 46 | 13 | succeeded |

合计 2074 条归档消息、61 条完整用户消息，五个会话均通过原顺序、精确 ID 和每条 turn 的检查。历史验收 helper 的 4 项自检通过，能拒绝重复、缺页、跨会话、错误最新轮次和用户乱序。

## 原数据保护与边界

`cleanup-processes.json` 的 remaining=[]、errors=[]；回放引擎及其测试资源已按 PID+CreationDate 身份清理。原 484 个状态文件哈希全部未变，诊断文件变化为 0。两个保留项目只读访问，未重置项目或原测试数据库。

本结果证明新版本分页修复和复制库客户端恢复通过。原 R3 的 S2 开发任务超时/取消、原旧包完整回放失败证据仍保留；不能把本次恢复 PASS 改写为原压力任务全部 PASS。新冻结完整客户端套件、正式 R4 实际开发与终态验收单独记录。
