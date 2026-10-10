# R4 最终客户端终态恢复验收

2026-10-09T15:20:17.125Z 至 15:20:34.320Z，真实 Electron 连接认证 remote 引擎 http://127.0.0.1:12499；最终客户端 bundle 为 index-DDqvcJ92.js。

结果：客户端恢复 PASS。正序、倒序共 10 次选择及刷新；5 个会话完整 archive、原始用户消息顺序、每条 ID/turn、requested/actual/输入栏模型、两个项目与子 Agent/命令任务归属全部核对。rendererErrors=[]，正常关闭 Electron。

这是客户端终态恢复结果。正式开发 driver exit2，S2 最新 rootStatus=failed 原样保留；不能据此将 R4 正式开发记为全部通过。

## 真实终态统计

| 会话 | requested/actual/输入栏 | 最新 root | archive 消息 | 用户消息 | archive 分页 | 实际 UI 历史操作 | 子 Agent | 命令任务 |
| --- | --- | --- | ---: | ---: | --- | --- | ---: | ---: |
| S1 | qwen3.8-flash | succeeded | 128 | 10 | 128 | 不需翻页 | 16 | 21 |
| S2 | qwen3.8-flash | failed | 214 | 13 | 200 + 14 | 不需 UI 翻页 | 17 | 20 |
| S3 | qwen3.8-flash | succeeded | 178 | 10 | 178 | 点击 1 次上下文已压缩归档入口 | 15 | 21 |
| S4 | deepseek-v4.1-flash | succeeded | 106 | 10 | 106 | 不需翻页 | 15 | 21 |
| S5 | deepseek-v4.1-flash | succeeded | 168 | 11 | 168 | 不需翻页 | 16 | 23 |
| 合计 | 3 Qwen + 2 DeepSeek | 保留真实状态 | 794 | 54 | 全部实际存在页已读取 | 以本次实际操作为准 | 79 | 106 |

S1/S2/S3 均属于保留项目 ops-board，S4/S5 属于 ledger-api。workspace/directory 根目录、package.json 内容和资源管理器项目显示与所选会话匹配。所有实际显示的子任务卡片 ID 也与所选会话的服务端归属匹配。

首条 S1 阶段与最新实际阶段均定位到原始用户消息，完整用户 ID 顺序精确匹配 archive，全部 turn 属性一致。不能称所有会话都有多页 UI 历史；S2 发生实际 API 两页，S3 发生实际压缩归档恢复。

## 冻结身份

buildId：sha256:1038e372195972f9a7277f14933d69e8b20fa56a958d91d4a28af9cb7f0f1fcb。

TGZ：D:/dev/ai-agent-engine/release/agent-engine-2.0.0-win32-x64.tgz；SHA256：904F3C09FAD300AA893940D2FB02F924E21C3C8BE9EAF9C58D2F8BE78F306CCD。正式运行期间未修改 engine dist、TGZ 或客户端 stage。

本轮公开快照不能完整回读外部 thinkingMode/subagentModel/utilityModel 等参数。这里证明的是 requested 模型的权威恢复；客户端手动思考选择隔离见专项报告，正式外部参数见 driver 请求与预检证据。

## 原始证据

- [终态汇总](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T140435168Z-Qy9TUP/client-acceptance.json)
- [完整 JSON 与截图目录](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T140435168Z-Qy9TUP/client-live-20261009T152017124Z/result.json)
- [会话输入配置修复与专项](D:/dev/aether-code/docs/test-reports/2026-10-09-client-session-composer-fix.md)

最终客户端 789 项全量回归另行记录，不与此恢复结果合并推断。