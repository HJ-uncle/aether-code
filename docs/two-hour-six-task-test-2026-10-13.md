# 两小时六任务测试：2026-10-13

## 当前结论

本轮已准备，真实模型准入失败，正式持续时间为 **0 分钟**。不能宣称完成两小时压力测试。不存在本轮后台压力任务。

- runId：`4da28fe7-7f2c-44a4-b01e-0d9ff6d0b008`
- 证据目录：`.ae/qa/all-mode-stress/six-20261013T120MIN-20261013T093226Z`
- 时长：120 分钟；独立端口：12551。
- 冻结引擎候选：`../ai-agent-engine/.tmp/plan-six-hour-candidate-20261013-0107`
- buildId：`sha256:78e1e136efc1f44efd065625e682afd0befc68b325d748dfadaa02440d7f196f`
- 数据库模型：`deepseek-v4.1-flash`、`qwen3.8-flash`。

## 已完成检查

`npm run typecheck`、`npm run build` 通过。

`npx playwright test e2e/work-agent-collaboration.spec.ts e2e/work-subagent-groups.spec.ts e2e/work-mode.spec.ts e2e/work-automation-ui.spec.ts`：43 passed，49.7 秒。Work 与自动化 Electron 均正常退出，nativeEvents=0、failures=0。页面用例使用受控提供器，自动化页面用例不执行真实定时调度，不能替代真实模型压力测试。

`node scripts/all-mode-stress-runner.mjs --contract-test` 通过。320 个确定性案例、720 个模块案例、320 个独立组合案例、320 个命令组合案例及 121 次真实引擎读文件/持久化读取检查（41 次分页）。模型调用和引擎启动数均为 0；协作身份场景为合成档案，不能作为真实 AI 协作证据。

两位子 Agent 完成独立只读审计；未修改代码或启动冲突测试实例。

## 运行方案

六条并发 lane：Code A/B、Work A/B、真实 Cron A/B；每条有实现和审查子 Agent。四条独立执行；Code A 与 Work A 同项目各写专属模块，通过真实 AI notes、受保护源码快照、完整读取与双向 ACK 异步协作，再验证组合流水线。两条 Cron 必须由真实调度器触发。

六会话均有实际模型输出后开始计时，持续供应多轮实现、审查和独立 80 案例验收。不是单次模型请求不间断运行两小时。进入 active 后启动 `scripts/verify-live-six-session-client.mjs <run-root>`，持续观察模式切换、任务归属、子 Agent、工具详情、计划、成果、自动化及刷新恢复。记录页面实际开始时间和覆盖缺口；结束时联合核验真实时长、引擎、页面、协作与清理，任何单份 passed 不代表全场景通过。

已知限制：跨根任务采用驱动转交异步协议，没有原生即时 send_message。write_file/edit_file 有归属审计，execute_cmd 任意写盘没有完整的逐 lane 硬隔离证明，不能宣称绝对无冲突。发现失败保留原记录；修复后重新冻结并复测，不改写失败轮历史。

## 阻断与清理

首次沙箱真实模型准入报 `PROVIDER_ERROR: Connection error`，没有成功准入。`workload-started.json` 不存在。`cleanup.json` 为 clean=true，两条 Cron 已禁用，根/子/命令无 active 残留，引擎 exit=0 且 shutdown ACK。

随后申请外网执行，被自动审批拒绝，理由为用户未明确授权具体阿里云目标及发送范围；未创建重试进程，未绕过拒绝。

待确认目标：`https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`。发送测试指令、工具定义、隔离测试路径、合成算法/案例、测试输出和模型/子 Agent 回复；不发送用户项目源码、业务数据、历史、记忆、知识库、MCP、skills 或模型数据库内容。已有凭据仅用于 API 鉴权。具体范围见本轮 `egress-review.json`。

确认后新建运行目录，重新完成模型准入与冻结，实际执行完整 120 分钟，再汇总修复、未解决问题与联合验收结论。

## 用户指定模型核验

用户随后指定数据库获取 `MiniMax-M2.5`、`glm-5.3`、`kimi-k2.6`，并提供当前引擎截图。只读核验截图中的 `C:/Users/wb.xielin02/AppData/Roaming/aether-code/engine/state/agent.db`：models 表仅一条启用的 `deepseek-v4.1-flash`；三个指定模型无记录。开发引擎 `D:/dev/ai-agent-engine/data/agent.db` 也仅两条 DeepSeek 记录，无三个指定模型。应用目录另有会话、记忆和知识库数据库，未将这些内容作为模型配置读取。没有输出密钥、修改数据库、伪造三个模型的配置或执行新模型请求。需要定位实际保存三个模型的数据库，或明确获准在隔离测试库使用现有网关配置探测三个模型的实际支持情况。
