# Work 紧凑工具列表验收（2026-10-12）

对应「消息中的活动内容太多，直接使用 Code 工具列表」反馈。本轮调整展示层，不修改工具执行、Agent 协作或引擎协议。

## 展示

- Code 与 Work 实际共用 `chat/CompactToolRow.tsx`，沿用同一组 `.logline` 样式。
- 普通操作为 24px 单行：状态圆点、工具名称、状态/耗时、目标摘要。长摘要省略，悬停保留完整摘要。
- Work 普通工具默认收起；展开只显示结果与失败原因。完整文本保留原文，长结果在限高区域独立滚动。
- 移除消息内重复的工具数量标题、用时段落、输入/输出标题、JSON 卡片及复制工具栏。详细参数和复制操作仍在活动侧栏。
- 活动继续原位展开，手动阅读期间新回复不会抢走滚动位置；活动侧栏入口位于列表底部。
- 文件改动、后台命令、子代理仍复用既有 Code 卡片；文件改动路径仍打开当前 Work 成果。Code 原有文件摘要动作和图片默认展示保留。
- 取消与未知状态使用中性圆点，等待应答使用强调色，减少动态效果时禁用运行圆点动画。保留实际状态文字，支持 Enter/Space 展开和收起。

沿用 ui-ux-pro-max 的可访问性、主题令牌及渐进展示原则。局部检索没有找到与工具折叠匹配的数据库条目，最终依据用户指定的现有 Code 实现及技能通用规范处理。

## 验证

`npm run typecheck`、`npm run build`、`git diff --check` 均通过；新增活动 CSS 没有未定义令牌。

独立用例 **52 passed**，重复运行不计入总数：

| 范围 | 结果 |
| --- | --- |
| Work 模式真实 Electron | 23/23 |
| Code 共享组件及文件卡片真实 Electron | 5/5 |
| 工具结果原文、图片/浏览器数据、异常载荷 | 21/21 |
| 活动实际状态及会话目标契约 | 3/3 |

覆盖运行→成功、失败、取消、超过 16K 的完整输出尾部、独立滚动、键盘折叠、阅读位置、文件打开、五任务切换及 Agent 续跑。检查 860×640 的 Work 窗口和 280/380px 的 Code 面板；深浅主题通过真实设置界面切换并断言背景颜色确实不同。截图已人工查看。Work Electron 健康记录：exit 0 / nativeEvents 0 / failures 0。

初轮新增 Code 主题用例误用了 Work 设置弹窗的选择器。读取窗口快照确认 Code 设置位于编辑器标签后，仅修正测试入口，Code 全文件复跑 5/5 通过；没有为测试修改产品行为。

```powershell
npm run test:e2e -- e2e/work-mode.spec.ts e2e/chat-message-layout-ui.spec.ts e2e/work-inline-activity-contract.spec.ts e2e/tool-result.spec.ts --output=.ae/qa/work-compact-tools-results
```

截图保存于 `.ae/qa/work-compact-tools-20261012/`，原始输出保留在 `.ae/qa/work-compact-tools-results/` 和 `.ae/qa/work-compact-tools-code-final/`。本轮是展示层回归，模型响应使用受控 HTTP 夹具，不代表完成外部模型的一小时压力测试。
