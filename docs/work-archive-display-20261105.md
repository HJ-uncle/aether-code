# Work 完整对话与归档导航专项验收

日期：2026-11-05

## 问题及修复

原来的会话恢复直接显示模型压缩上下文；归档按 200 条原始行分页，长工具轮次会被切开，用户问题和导航锚点可能不在当前页。运行时禁止加载归档，进一步造成无法查看早期内容。

本次将 Work 展示记录与模型上下文分离。引擎新增只读 `/conversation/display`，一次固定读取同时返回完整用户轮次索引及选中的完整轮次正文。默认读取最近两轮，点击导航或历史缺口后按需加载整轮。导航以用户消息 ID 为稳定标识。

历史缓存只参与展示，不写回实时消息状态、todo、用量、root run 或 SSE 游标。正在运行的压缩轮次只补已观察到的工具锚点之前的历史前缀，实时尾部保持原样。切换会话、清空、删除和回退使相应读取失效。

真实窗口首轮验证发现远端请求白名单遗漏新端点；补充 GET 允许规则后重新构建，最终全部通过。

## 本轮新用例

| 层级 | 用例文件 | 结果 | 重点 |
| --- | --- | --- | --- |
| 引擎存储与 HTTP | `../ai-agent-engine/src/api/http/routes/__tests__/conversation-display.test.ts` | 10/10 | 完整长轮、summary、删改版本、固定读取窗口、并发追加、文件替换、租户/会话隔离、SQLite 压缩状态、multipart 预览 |
| 前端展示协议与合并 | `e2e/work-display-history-contract.spec.ts` | 10/10 | 严格校验、完整轮缓存、实时尾部优先、工具原文恢复、实时第 130–135 步补齐第 1–129 步、不提前显示未来结果、删改失效 |
| 真实 Electron UI | `e2e/work-archive-display-ui.spec.ts` | 5/5 | 274 原始行与 135 工具步骤首尾结果、全部四轮导航、未加载轮次跳转、SSE 并发、迟到响应隔离、503 重试与重新进入会话 |

前后端 typecheck、build 均通过。Electron 正常退出，没有 pageerror、原生崩溃或测试触发的模型写请求。已检查长轮与运行中导航截图。

## 复现命令

IDE 独立产物构建：

```powershell
npm run build -- --outDir .e2e-tmp/archive-display-20261105-build --logLevel warn
$env:AETHER_E2E_APP_ENTRY = 'D:/dev/aether-code/.e2e-tmp/archive-display-20261105-build/main/index.js'
npx playwright test e2e/work-archive-display-ui.spec.ts --output=.e2e-tmp/archive-display-20261105-results
npx playwright test e2e/work-display-history-contract.spec.ts
```

引擎仓库：

```powershell
npx vitest run src/api/http/routes/__tests__/conversation-display.test.ts
npm run typecheck
npm run build
```

最终引擎 build ID：`sha256:b420a75bb89670d0abfe06a6b725e983ba9bb36e70f21268f97b5fc2cfe3f469`。

UI 截图与健康记录：`.e2e-tmp/archive-display-20261105-results/`。

## 范围与保留限制

- 本轮为新建的专项回归；未运行旧 E2E、导出测试或重新做 12 小时压力验收。
- UI 使用认证 HTTP 夹具验证真实 Electron；引擎测试单独验证实际存储及路由，不向生产模型发起会话。
- 已被旧版 SQLite 压缩物理删除的记录无法还原，界面会明确提示仍有历史缺失；JSONL 保留的原始记录可恢复。
- 本次未扩大旧归档的编辑、删除、截断能力；无法定位于当前执行上下文的较早归档保留只读限制并给出明确提示。
- 变更涉及 IDE 主进程/渲染进程及同级引擎仓库，实际运行实例需一起加载新版。测试未重启用户正在运行的会话。
