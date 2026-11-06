# 本轮成果卡片撤回

## 交互

在用户截图对应的本轮成果摘要卡右上角、待确认数量之前增加轻量“撤回”按钮。收起卡片时也可操作；有可靠轮次归属且包含尚未撤回的改动时显示。

点击后打开“撤回本轮成果”确认弹窗，列出文件和改动数量，说明新建文件删除、修改和删除的文件按快照恢复，包含已经保留的改动。取消或 Escape 不发撤回请求。对话历史不删除。命令观察快照可能包含同期手动编辑时，沿用明确提示。

任务运行、启动、等待交互或成果同步失败时禁用入口。确认期间目标记录、归属、风险标记、任务或引擎变化时拒绝继续。处理中复用会话锁，避免多个卡片或审核面板同时提交。

## 实现范围

- 复用 `WorkChangeReviewActions`，增加仅撤回的 `turn` 模式。
- 使用本轮原始记录 ID，包含卡片省略的文件与同文件的多次修改；不展开可能横跨其他轮次的净变化 `changeIds`。
- 调用现有 `/changes/revert-batch`，始终显式提供 `sessionId`、`ids`、`scope: all`。不使用代表“本轮及之后”的 `fromTurnId`，不修改引擎接口。
- 引擎根据磁盘版本、后续改动及快照完整性逐项决定是否恢复。冲突文件保留，卡片展示逐文件结果。
- 保留提交 ID，使已恢复新增文件从列表消失后仍出现在部分完成报告中；不完整回执保留请求总数且不显示全部成功。
- 本次入口对应 `WorkProgressPanel` 文件改动摘要；独立最终交付清单 `WorkFinalDeliverables` 没有在本次变更中加入该操作。

## 验证记录

- `npm run build -- --outDir .e2e-tmp/work-turn-revert-final-build-20261106` 通过，包含 node/web 类型检查。
- `work-change-review.spec.ts` 和 `work-turn-progress.spec.ts` 共 18 项纯测试通过。
- 引擎现有 `changes-revert.test.ts` 25 项实际回退测试通过，涵盖版本冲突、跨会话后续修改、批量及重复请求。
- 相关真实 Electron 回归共 28 项通过：原有文件审核及成果卡 22 项，本轮新增 6 项。使用受控 HTTP 和 `.e2e-tmp` 内真实文件，验证取消 / Escape 无写入、精确请求 ID、恢复/删除副作用、冲突保护、运行中禁用与完成后恢复、确认失效，以及不完整回执不误报成功；深浅主题和窄宽窗口均验收。
- 运行状态夹具原先错误递增 `run.seq`（根任务顺序），已改为保持它稳定，单独递增 SSE 水位并更新 `run.version`。最后串行复跑新增 6 项及原有运行状态 1 项，7 项全部通过，Electron 健康检查无错误，输出位于 `.e2e-tmp/work-turn-revert-final-seven`。其余 21 项已在此前回归通过；该修正没有改动生产代码。

## 截图与产物

- [深色卡片](assets/work-turn-revert-2026-11-06/turn-revert-card-dark-680.png)
- [二次确认](assets/work-turn-revert-2026-11-06/turn-revert-confirm-dark-1440.png)
- [浅色确认](assets/work-turn-revert-2026-11-06/turn-revert-confirm-light-1440.png)
- [部分冲突结果](assets/work-turn-revert-2026-11-06/turn-revert-conflict-report.png)

图片来自测试夹具。验证入口为 `D:/dev/aether-code/.e2e-tmp/work-turn-revert-final-build-20261106/main/index.js`。未替换用户正在使用的 `out/`，未重启用户实例；无需重新构建引擎。
