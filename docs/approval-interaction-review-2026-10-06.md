# 审批交互优化与验收（2026-10-06）

截图中的常驻问题来自展示层：引擎为审计及重复应答保护保存了已回答记录，界面又逐条展示这些记录，导致完成的操作不断占用对话空间。

## 已完成

- 仅当前运行处于 `waiting`、具有有效 `requestId` 的请求显示操作卡。
- 已处理及失效请求合并为默认关闭的“确认记录 N 项”。展开仍可查看批准、拒绝、应答及未执行的历史，不删除引擎记录。
- 历史不再重复“已允许/允许执行”文案；旧记录未保存授权结果时明确显示未知，不猜测已批准。
- 多问题历史显示全部问题；自由回答保留逗号等原文。长命令及长回答自动换行。
- 原生展开控件支持 Enter/Space，具有焦点描边；问题选项提供选中状态语义，自由输入与问题关联。
- 切会话后旧审批回调不再起流；以最新运行及请求身份校验应答。IPC 启动失败释放本次流锁，允许重试。
- 请求被另一端回答或取消后，应答冲突会恢复最新快照；兼容 HTTP 404/409、HTTP 200 JSON 业务错误和旧 SSE 错误。临时网络失败保留可重试请求。
- 移除模式切换失败时“本次已放行”的未确认表述。
- 修复窄设置栏快捷键按钮被导航遮挡，以及紧凑目录第一次展开反而隐藏末端的问题。目录点击、方向键和拖拽悬停共用展开逻辑。

## 验收结果

本次相关范围共 **94 项通过**，按串行、独立输出目录运行，避免不同 Electron 实例争抢资源。

| 范围 | 通过 | 证据 |
| --- | ---: | --- |
| 审批会话竞态与异常恢复 | 22 | 执行实际回调的 VM 测试，覆盖旧回调、已失效请求、重复点击、IPC 重试及不同错误信封 |
| 根运行与审批真实 UI | 9 | 批准前无磁盘副作用、批准后写入、拒绝、刷新、重开、连续审批、多问题历史、外部取消后旧按钮自动同步 |
| 思考过程与滚动 | 1 | 追加内容贴底、用户上翻时不抢位置 |
| 工作台完整 smoke | 40 | 资源管理器、拖拽撤销、紧凑目录三种展开手势、编辑器、搜索替换、终端、快捷键和预览 |
| MCP / 技能 / 知识库 | 17 | 创建、读取、编辑、删除、启停、JSON 导入、SKILL.md/ZIP 导入、文档上传与会话绑定 |
| Agent 资源对话 | 1 | skills + stdio MCP + KB/RAG，含短暂失败重试、刷新及历史恢复 |
| 编辑器引用与文件监听 | 4 | 引用未保存内容、重开引用、菜单入口及监听生命周期 |

原工作目录 `npm run typecheck` 通过；隔离副本 `npm run build`（含 node/web 类型检查）通过。已检查深色、浅色和 280px 对话面板截图。构建仍有现存静态/动态 import 分包提示，无构建错误。

远端验收使用独立 Node 引擎进程及 Electron 的 `remote` 模式，通过 HTTP 与实例令牌通信，包含未授权请求拒绝、客户端刷新和重开；两个进程在本机运行。未将此结果表述为跨机器公网网络验收，也未调用付费生产模型；对话使用确定性的 HTTP provider 夹具。

## 复跑命令

先构建，再执行 UI 用例；全部使用 `workers: 1`。

```powershell
npm run build
npx playwright test e2e/root-run-ui.spec.ts e2e/approval-session-race.spec.ts e2e/thinking-scroll-ui.spec.ts --reporter=list
npx playwright test e2e/smoke.spec.ts --reporter=list
npx playwright test e2e/mcp-ui.spec.ts e2e/skill-import-ui.spec.ts e2e/knowledge-ui.spec.ts e2e/agent-resource-dialogue.spec.ts e2e/editor-chat-context.spec.ts e2e/editor-document-watch.spec.ts --reporter=list
```

本轮修正了测试自身的两类问题：紧凑目录不能假定每一级目录都有单独行；VM 返回的 Promise 需转为测试运行上下文后进行异常断言。保留实际展开、文件副作用、请求拒绝及不重复执行断言，没有强制点击或跳过失败用例。

## 截图

- [深色：完成后折叠](approval-review-2026-10-06/approval-history-dark.png)
- [浅色：完成后折叠](approval-review-2026-10-06/approval-history-light.png)
- [窄面板：键盘展开、内容换行](approval-review-2026-10-06/approval-history-narrow.png)
- [Remote 模式：仅当前审批显示按钮](approval-review-2026-10-06/active-remote-approval.png)

## 范围说明

工作区存在其他会话同时进行的远端工作区和响应式布局修改，因此本次使用独立构建副本验收，未覆盖或回退他人修改。本任务的审批区域和相关修复已写回原项目。测试期间新增的远端文件引用改动不属于本轮审批验收内容。

94 项是本轮相关测试范围，不是整个项目全部功能或其他并行改动已经通过全量验收的声明。较早全量运行的失败结果仍需结合后续远端契约改动独立复核，不能用本轮定向通过替代。
