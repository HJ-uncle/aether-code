# 现有窗口内的 Work 文档与资源验证

本工具只由 root 在现有 runner 的 `recover(c)` 调用。导入本身不访问 live；不启动应用、窗口、服务器或模型任务，也不导入 verified-submit adapter。它不替代产品 build 或真实截图检查。

## 执行入口

| 场景 | `.e2e-tmp/` 下入口 |
| --- | --- |
| build/reload 前，只读 idle 与窗口检查，不需要新 UI | `preflight-office-resource-refresh.mjs` |
| build/reload 后，只读 UI/identity 检查 | `prepare-office-resource-ui-validation.mjs` |
| 启动真实 UI 场景，立即返回 ACK | `start-office-resource-ui-validation.mjs` |
| 查询运行、证据目录与 pending 状态 | `query-office-resource-ui-validation.mjs` |
| 停止后续场景并恢复已稳定的界面 | `cancel-office-resource-ui-validation.mjs` |
| 超时操作实际结束后，显式补做恢复 | `reconcile-office-resource-ui-validation.mjs` |

入口都只导出 `recover(c)`。root 必须先阅读固定样本配置 `.e2e-tmp/office-resource-ui-fixtures.json`。start 不等待长任务；用 query 获取状态。`needs-reconciliation` 时不能重试 start；等 `pendingOperations === 0` 后调用 reconcile。cancel 不取消模型任务。已稳定的 UI 失败会恢复 runner 方法并返回失败，原错误与恢复错误分别保留。

不要再加载 `office-resource-ui-validation-draft.mjs`。旧 prepare 入口已改为新 final 模块；它现在不再导入 draft 或 submit adapter。已加载的 final 模块不可在执行中改写，因为同一 Node 进程会缓存 ESM。

## 当前真实样本与覆盖限制

默认配置是 root 已独立核对与 repair3 一致的四份当前 PMO 原件，均为 `role: pmo`，在 `company/pmo/deliverables/v004/` 下：

- `decision-minutes.docx`
- `management-dashboard.xlsx`
- `management-review.pptx`
- `management-review.pdf`

成果入口根据实际 UI 的 title 路径做 Windows 大小写、斜线归一化匹配；要求唯一匹配。不会自动创建或注入对话链接。若希望覆盖真实历史链接，可将对应样本 `entry` 设为 `conversation` 并提供实际的 `linkTitle`、`linkHref` 或限定在 Work 页面内的 `linkSelector`。未提供的入口会记录 `notExercised`，不声称覆盖。

2026-10-24 只读 ZIP 元数据检查：当前 workbook 有 16 个工作表，最大实际行号 28，没有超过 100 行的表。因此它可检验多工作表渲染，但不能检验第二页数据；脚本会记录 `xlsx-row-pagination` 未覆盖。不会修改业务原件或增造行数。此信息只读取 XML 行标签元数据，没有输出单元格内容。

默认 `injectSpreadsheetWorkerError: true`：只对唯一实际 `aether-document-spreadsheet` worker 发送一次人工错误响应，验证错误页面和 worker 释放。证据明确标记为故障注入；它不等同于损坏文件兼容性测试，不写原文件。

## 实际断言与恢复

执行前后检查现有唯一窗口、完整 engine identity、六个角色 runId/终态、tenant/namespace、严格只读队列摘要与命令队列。原件仅对四个指定文件做分块 SHA256，单个最多 32 MiB、总量最多 64 MiB。

打开文件必须点击真实成果或对话入口。目标 session、path、format 必须从真实 DOM 一致确认。PDF 要等指定页的渲染 canvas；Office 要等待隔离 iframe 的实际 body；工作表要等指定 sheet/row 的 table，不能把上一帧当成功。可翻页的工作表实际检查 DOM 不超过 100 行、20 列。截图留给 root 视觉复核。

隐藏文档后检查组件卸载及本轮记录的文档 worker 结束。随后通过内置浏览器新建一个空白网页，验证同级资源标签、顺序、另一个真实会话隔离及返回原文档；不访问外部站点。

清理只关闭这次指定样本中新开的文件和已归属的新网页；部分创建但唯一可归属的网页也能清理。未知新增资源保留并使恢复一致性断言失败，不自动删除。恢复每个访问角色的原标签顺序、选中资源、工具、成果选择、预览页/工作表/列范围/缩放及可识别滚动位置，再返回原角色。原件 SHA、窗口和只读 idle 证据再次核对。

每轮证据写入 campaign 的 `evidence/resource-ui-<timestamp>/`，JSON/PNG 使用新文件名，不覆盖旧证据。最终 `passed-with-unexercised-scenarios` 表示已执行项成功、仍存在明确列出的覆盖空白，不能当成全部场景通过。

## 离线验证

`node --test scripts/__tests__/office-resource-ui-validation.test.mjs scripts/__tests__/work-resource-navigation.test.mjs`

final helper 18 项离线测试，另有直接编译实际 `work-resource-store.ts` 的 9 项测试；合计 27 项。包含错误 runner 拒绝、取消释放、原件只读边界、旧帧拒绝、相对工作区路径匹配、部分创建清理、跨 engine/session 过滤、真实 store 稳定顺序和上限。没有在离线测试里调用 live，也没有据此宣称实际 UI 已通过。
