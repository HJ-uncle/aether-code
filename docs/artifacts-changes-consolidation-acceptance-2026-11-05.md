**成果与改动合并验收 · 2026-11-05**

已按调研建议完成 Work 入口合并。会话中同一文件在成果树中占一项，修改属于该文件的记录；Work 不再提供独立「改动」标签。Code 的改动托盘和 Git 操作继续使用原入口。

**交互结果**

- 文件详情可切换「当前内容」「待确认改动」「修改记录」。当前内容读取实际文件；修改记录使用历史快照。待确认改动展示服务端仍待确认的连续修改，不表述为整个会话的累计差异。
- 聊天摘要的「查看全部成果」进入整个会话并清除旧搜索与轮次筛选；具体修改入口保留精确 changeId，持久记录尚未同步时显示同步状态，不借用其他版本。
- 保留、单项/批量撤回、冲突与部分失败报告仍可使用。保留只确认已写入的修改，不等同于 Git 提交。批量操作遵守当前轮次和文件筛选。
- 已保留、已撤回记录保留在历史中；资源文件可通过「在成果中查看改动」返回对应会话的文件历史。外部文件不会仅凭同名获得该入口。
- 旧布局中的 `changes` 标签恢复为成果。文件预览中的链接会打开并激活资源标签。
- 撤回完成按请求开始时的文件与会话更新预览缓存，即使期间切换文件、视角或会话也有效；完成事件不抢回新选择。大批量修改和私有工作区相对路径同样覆盖缓存刷新。

**验证结果**

`npm run typecheck`、`npm run build`、`git diff --check` 通过。构建只有现有静态/动态混合导入提示，无编译错误。

74 条纯函数/契约测试通过：

```powershell
npx playwright test e2e/work-session-artifacts.spec.ts e2e/work-change-review.spec.ts e2e/work-file-change-presentation.spec.ts e2e/work-progress-state.spec.ts e2e/work-artifact-coverage.spec.ts e2e/change-revert-contract.spec.ts e2e/change-actions.spec.ts e2e/work-preview-request.spec.ts --workers=1 --output=test-results/artifacts-pure
```

21 条不同的 Electron 交互用例最终均通过，使用真实 Electron 窗口和受控 HTTP/SSE 服务。覆盖精确 ID 请求、确认取消、跨会话确认防护、运行中禁用、冲突报告、当前文件复制/刷新/引用、精确记录延迟同步、资源历史导航、撤回期间三种切换，以及多轮筛选、浅/深色窄窗口、400 个成果和 1500 行差异的滚动与布局稳定性。健康监测未发现渲染进程/主进程错误或原生崩溃。

```powershell
npx playwright test e2e/work-change-review-ui.spec.ts e2e/work-timeline-ui.spec.ts e2e/work-file-tree-memory-ui.spec.ts --grep "Work 文件改动确认|成果按用户|13 文件多轮|密集工具过程|Work 截图可放大|窄窗隐藏对话|Work 多成果标签|Work 标签切换几何性能" --workers=1
npx playwright test e2e/work-change-review-ui.spec.ts --grep "撤回较早记录" --workers=1 --output=test-results/artifacts-cache-regression
```

最后一轮组合运行 20 通过、1 失败：跨会话用例将新会话正常预览首个已保留文件误判为串读。确认实现行为后，断言调整为禁止原操作读取另一会话的同名目标文件，并校验另一会话的文件内容与记录状态均不变；三个相关切换用例复跑全部通过。没有通过放宽原目标的内容刷新或写入边界断言掩盖失败。

本次为相关范围验证，未运行全仓库 E2E，也未以真实模型/线上引擎执行任务。工作区已有其他进行中的修改，本次未提交或重置它们。

**界面留档**

以下截图来自测试夹具，已人工查看当前内容、历史差异和窄窗口布局。

- [当前内容](assets/artifacts-consolidation-2026-11-05/current-content.png)
- [修改记录](assets/artifacts-consolidation-2026-11-05/change-history.png)
- [窄窗口待确认改动](assets/artifacts-consolidation-2026-11-05/pending-changes-narrow.png)

调研依据保留在 [原调研记录](artifacts-changes-consolidation-research-2026-11-05.md)；其中代码位置与「未实施」描述对应调研阶段，实施结果以本验收记录为准。
