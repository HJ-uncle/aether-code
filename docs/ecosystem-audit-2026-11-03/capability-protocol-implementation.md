# 能力发现、执行协议与 Code 工作台回执实现

日期：2026-11-03。范围：本文件记录本次能力协议子任务已经实现并验证的内容；主报告负责浏览器恢复、命令变更管理和整体端到端验收。

最新结果见 [主实施报告](ecosystem-implementation.md)：Code/Work 工作台的 8 项真实 Electron 验收已通过，包含下文建议的文件激活、未保存内容保护、同路径刷新和会话隔离。

## 实现结果

| 模块 | 已实现行为 | 主要代码 |
| --- | --- | --- |
| 客户端能力声明 | 版本化有限枚举；过滤任意字段与未知操作；声明不授予执行权限 | `ai-agent-engine/src/core/client-capabilities.ts` |
| 本轮能力快照 | 从真实工具注册表生成名称、来源、schema 版本；区分引擎 Node、客户端平台和未探测 shell；报告实际安全模式与记忆范围 | `ai-agent-engine/src/core/runtime-capabilities.ts` |
| 工作台可用性 | 查询同身份、同根会话的实际 bridge 连接与动作；不把客户端 `connected` 自报当成连接证据；`executionBound` 表达是否有当前执行身份，已连接但无身份时标记 `requires-run` | 同上，以及主任务实现的 `tools/workbench/bridge.ts` |
| 工具详情发现 | `get_tool_details` 只查询当前工具集，提供完整 description、parameters、outputSchema、执行类型、前置条件和恢复方式；支持精确名称与分页搜索 | `tools/get-context/tool-details-tool.ts` |
| 当前上下文 | `get_current_context` 支持 JSON，返回能力快照与注册表版本；完整工具简介不再截断为 50 个字符 | `tools/get-context/get-context-tool.ts` |
| 公共执行协议 | Work、Code、legacy edit/regenerate、子代理共享环境发现、命令、版本冲突、浏览器恢复、办公文件、产物回执和历史回查规则；具体 API 指引只对当前已注册工具生成 | `core/execution-protocol.ts`；chat/messages/subagent 接入点 |
| 子代理 | 继承规范化客户端声明；按子代理真实工具集重新生成协议与能力快照；研究角色可用只读发现和工作台上下文 | `tools/subagent/subagent-tool.ts` |
| Profile 一致性 | Code 注册发现/工作台工具；显式 allowlist 仍生效；`office_document` 未注册时不展示依赖它的内建 `aether-office` 技能 | `tools/registry-factory.ts`、`tools/tool-profile.ts` |
| 历史参数 | JSON schema 明确至少需要 query/messageId，拒绝空白；imageIndex 必须带 messageId | `tools/get-context/search-history-tool.ts` |
| 依赖检查 | `list_packages` 准确说明只读取 package.json 声明、不证明安装；拒绝 global=true；通过真实工作区解析与 canonical path 边界检查读取 | `tools/install-package/install-package-tool.ts` |
| MCP 传输 | JSON-RPC/REST 都保留 structuredContent 和非文本内容 envelope，传播 isError；工具目录保留 MCP 来源和 outputSchema | `tools/mcp/result.ts`、`tools/mcp/client.ts`、`api/http/routes/tools.ts` |
| Code 工作台打开 | 激活真实编辑器标签后才回 opened；复用普通 Code 文档 owner，保留未保存内容；已有 loading 文档等待读取完成；关闭重开时拒绝旧实例的回执 | `aether-code/src/renderer/src/core/workbench/client.ts` |
| Code 工作台范围 | 只返回当前会话真实工作区根内、当前连接有效的文档；session-owned 文档还需 binding key 精确一致；旧项目、旧绑定、其他会话文件不进入上下文 | 同上 |

## 验证记录

以下为独立运行记录，有重复文件，不应直接相加称为唯一测试总数。

1. 引擎首轮：8 个文件、91 条测试通过。覆盖 runtime-capabilities、mcp-result、tool-profile、get-context、search-history、tool-profile-routes、messages-memory-policy、office-prompt。
2. 引擎增量：tool-profile 26 条、tool-profile-routes 24 条、history-schema 1 条、mcp-deadlines 7 条通过。list-packages 最初测试未绑定真实认证工作区而失败；修正隔离夹具后单独验证通过，没有放宽产品工作区限制。
3. 最终夹具修正复跑：runtime-capabilities 6 条 + list-packages 1 条全部通过。
4. Code adapter 运行行为测试：`node --test src/renderer/src/core/workbench/code-workbench.contract.test.mjs`，6 条通过。覆盖 dirty 文档复用和激活、新文件 owner、loading 延迟回执、根/会话/绑定过滤、越界拒绝、关闭重开实例竞态。
5. 引擎早期两次 typecheck 通过；后续新增夹具缺 history/logger 的类型问题已修。最终统一 typecheck/build 由主任务执行，以主报告为准。
6. 补上工作台执行身份就绪状态后复跑：runtime-capabilities 6 条 + get-context 9 条全部通过。

Code adapter 测试执行真实适配器代码，但编辑器与文件边界受控，不等同于 Electron 界面端到端测试。建议界面验收：编辑 A 后激活 B，AI 打开 A 必须切到 A 并保留未保存内容；延迟读取时不能提前回 ready；切项目后保留的旧标签不得被当前会话枚举。

## 回执评审与明确边界

- 已只读检查主任务的 workbench bridge、HTTP routes 和客户端 hook。后端使用 tenant + user + session + 随机 token 隔离连接；回执还匹配 rootRun/ownerRun；取消后晚到成功回执不再被接受。
- 已投递操作取消会返回 `operationPerformed: unknown`。这是正确的不确定性表达；不能承诺已投递的客户端动作完全撤销，也不能自动重放。客户端本地停止与打开前的再次有效性检查由主任务补强。
- Code 的 opened 表示目标编辑器已激活，readStatus 表示文档缓冲区读取状态。`renderStatus: preview-requested`、`visualVerification: false` 明确没有把登记或读盘成功当作视觉验收。
- MCP 图片、音频与资源现在作为完整结构数据保留，并标记 `contentDelivery: structured-data-not-native-media`；尚未完成所有模型提供方原生多模态工具结果通道。
- MCP resources/prompts 的完整发现与执行生态不在本次实现内。
- legacy messages edit/regenerate 本轮统一了公共协议，但原执行链没有主 `/chat` 的 rootRunId、执行 owner 和 browser principal 准入。不能声称其工作台操作与主聊天链完全等价；缺少执行身份时仍安全拒绝。
- 未调用真实模型提供方验证模型是否在真实任务中正确选择工具；工具契约和提示改进不等于模型端到端行为保证。

## 后续重点

优先以真实任务回归验证完整链路：创建项目 → 启动服务 → 浏览器验收 → 交付文件 → 客户端打开回执。然后将 legacy 路由迁移到统一准入运行链，补全 MCP 多模态、resources/prompts，避免通过伪造执行身份或扩大工具权限填补接口缺口。
