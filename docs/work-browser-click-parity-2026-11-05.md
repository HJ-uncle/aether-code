# Work 浏览器点击回执与 Code 对齐

用户指出 Work 的浏览器点击只显示普通截图。检查确认工具回执保留了点击前截图、CSS 视口、点位与目标框；Work 的 `BrowserSnapshotResult` 分支只选择最新截图，没有调用 Code 使用的 `BrowserClickPosition`。

本次仅修改前端展示：

- Work 复用 Code 点击位置组件，显示点击前画面、点位、目标框、目标名称及坐标，放大后保留标注。
- Work 使用紧凑布局，隐藏选择器和完整分辨率说明。
- 不同的点击后截图放在“查看点击后页面”中，独立放大；不把点击前坐标叠在点击后的页面上。
- 缺少点击前截图时使用位置示意图，另行展示点击后截图；旧记录缺少位置时明确提示，损坏截图保留点位示意。
- 操作回执仍在过程内，不自动成为最终交付图片。

验证：

- `npm run build -- --outDir .e2e-tmp/browser-click-parity-build-20261105` 通过（包含 node/web typecheck），未覆盖运行中的 `out`。
- `browser-snapshot.spec.ts` 与 `tool-result.spec.ts`：122 项纯函数测试通过。
- `tool-result-images-ui.spec.ts`：7 项 Code 真机回归通过。
- `work-timeline-ui.spec.ts`：新点击回执用例和现有过程图片/最终交付用例各 1 项通过；真实 Electron 串行运行，应用健康诊断无错误。
- 新用例使用不同点击前后图片及不同图像/视口尺寸，检查原始图片来源、viewBox、坐标、目标框、键盘放大、Esc 焦点恢复、缺失与损坏回退。检查了深浅主题实际截图。

验收截图为带有 BEFORE CLICK 标识的测试样例，不是用户五子棋页面。

- [深色点击标注](assets/work-browser-click-parity-2026-11-05/work-browser-click-position-dark.png)
- [浅色点击标注](assets/work-browser-click-parity-2026-11-05/work-browser-click-position-light.png)
- [放大后保留点位和目标框](assets/work-browser-click-parity-2026-11-05/work-browser-click-position-enlarged.png)
