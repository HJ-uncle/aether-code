# Work 协作界面：简约布局与验证记录

2026-11-05。范围是用户截图中标出的协作对话与右侧代理目录。

## 设计规则

采用 macOS 常见的系统列表、渐进展开和清晰文字层级。沿用 Aether 现有系统字体与深浅主题令牌，内容通过留白和缩进分层。

| 区域 | 默认呈现 | 按需查看 |
| --- | --- | --- |
| 对话中的连续成功协作 | 一行「已完成 N 次协作」，N 按执行轮次计数 | 展开后每页最多 20 条，保留每条任务、结果和执行详情 |
| 正在运行或需关注的协作 | 保持直接可见，显示任务与状态 | 展开详情；运行中的代理可单独停止 |
| 右侧代理目录 | 52px 两行列表：名称、任务；右侧小状态标记 | 点击进入代理详情 |
| 模型、工具调用、耗时 | 从目录主列表移出 | 详情标题栏的「代理信息」浮层 |
| 大量代理的查找 | 至少 12 个已载入代理时显示搜索框 | 在已载入数据中先搜索，再分页；明确显示匹配数与已载入数 |

去掉对话卡片的重复边框、背景块和成功统计；目录去掉大型头像底块。成功状态采用中性文字，运行与需关注状态保留语义色。新样式均引用已有令牌。

## 信息与交互约束

- 只合并已确认成功且时间线上连续的协作；正文、截图和其他工具会分隔摘要。运行、等待、失败、中断、取消及未载入引用继续可见。
- 摘要折叠不删除记录，也不改变执行身份。关闭的摘要不挂载内部卡片订阅；按需展开与定位仍使用原始工具 ID。
- 用户开始操作一条消息后，保持该消息当前分组边界，避免邻近代理完成时卸载正在阅读的详情。实时内容和状态继续更新；消息组件下次重新挂载时可重新归并。
- 搜索只覆盖已经载入的代理，不暗示搜索了服务端尚未读取的分页。按子会话身份区分代理，同名代理不会合并。
- Escape 先关闭「代理信息」，再按一次才返回列表。列表搜索、返回焦点、草稿保留、继续执行和单代理停止保持可用。
- 浅色、深色与窄窗口使用相同的信息层级；动效遵循减少动画偏好。

## 验证

`npm run typecheck` 与 `npm run build` 均通过。最终构建后运行以下定向用例：**28 passed / 0 failed / 0 skipped**，其中 12 条运行真实 Electron 窗口，16 条为纯函数测试。

| 测试文件 | 通过 | 验证重点 |
| --- | ---: | --- |
| `work-subagent-directory-ui.spec.ts` | 5 | 129 轮跨页发现、搜索、草稿、精简布局、双 Escape、动态完成时的 DOM 与焦点保留、窄窗口、精确停止与续跑 |
| `subagent-history-ui.spec.ts` | 5 | 4100 条历史、128 项窗口上限、32KiB 分段、固定水位、失败恢复 |
| `work-streaming-interaction.spec.ts` | 2 | 持续事件中的真实点击、成果新鲜度、任务完成与停止范围 |
| `work-collaboration-presentation.spec.ts` | 6 | 成功归并、时间顺序、需关注状态可见、阅读时保持分组边界 |
| `work-subagent-list-presentation.spec.ts` | 4 | 任务摘要、续跑任务、已载入范围搜索、同名身份不混淆 |
| `work-timeline-contract.spec.ts` | 6 | 正文与工具顺序、旧历史、截图和浏览器操作呈现 |

```powershell
npm run build
npx playwright test e2e/work-subagent-directory-ui.spec.ts e2e/subagent-history-ui.spec.ts e2e/work-streaming-interaction.spec.ts e2e/work-collaboration-presentation.spec.ts e2e/work-subagent-list-presentation.spec.ts e2e/work-timeline-contract.spec.ts --workers=1 --output=test-results/collaboration-ui-final
```

三组 Electron 窗口健康检查均无进程异常。相关修改通过 `git diff --check`；三份协作样式文件的 CSS 令牌引用均有定义。未运行全仓库 E2E。

## 最终截图

截图为真实 Electron 渲染。主视图分别验证 1440 × 900、940 × 900 CSS 像素，详情另覆盖 940 × 640、1100 × 760、1440 × 900。当前机器 DPR 为 1.5，因此图片像素大于窗口的 CSS 尺寸。

- [用户提供的改版前截图](assets/collaboration-minimal-2026-11-05/before.png)
- [浅色主视图](assets/collaboration-minimal-2026-11-05/light-wide.png)
- [深色主视图](assets/collaboration-minimal-2026-11-05/dark-wide.png)
- [浅色窄窗口](assets/collaboration-minimal-2026-11-05/light-narrow.png)
- [深色窄窗口](assets/collaboration-minimal-2026-11-05/dark-narrow.png)
- [浅色小窗详情](assets/collaboration-minimal-2026-11-05/detail-light-narrow.png)
- [深色小窗详情](assets/collaboration-minimal-2026-11-05/detail-dark-narrow.png)
- [详情正文空间测量](assets/collaboration-minimal-2026-11-05/detail-geometry.json)

验收场景载入 127 个代理、128 轮执行。正文分隔前的 1 条成功记录保持原位；后续 125 条成功记录显示为 98 次与 27 次两条摘要，2 条运行记录直接可见。目录每页最多 64 行，实测行高 52px，无横向溢出；小窗详情正文至少保留 180px 可读空间。

真实窗口用例使用本地 HTTP 夹具驱动数据，覆盖真实 React 渲染、IPC、点击、键盘和分页，不代表真实模型任务已经执行。
