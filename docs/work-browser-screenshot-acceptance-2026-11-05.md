# Work 浏览器截图展示与验收

2026-11-05。Work 沿用 Code 的图片能力，同时保留简洁的操作行。

> 后续展示规则已更新：工具调用及其图片统一收进「过程」，最终回复的图片直接展示。以下独立工具图片规则与对应界面截图仅记录当时的验收；当前行为见 [回复图片统一展示验收](reply-images-acceptance-2026-11-05.md)。捕获与传输修复仍有效。

## 展示规则

- 按返回内容识别图片：读取页面、导航、调整视口、点击等操作，只要带有有效截图，就作为独立图片记录默认展开。
- 任务结束或「过程」折叠时，图片继续可见；用户主动收起某张图片的选择仍保留。
- 支持点击放大、Escape 关闭和返回原按钮焦点。
- 优先展示操作后的截图；只有点击前截图可用时，明确标注「点击前的页面」。
- 没有图片时明确显示未附截图或捕获失败原因，页面文字放入「查看页面文字」折叠项。

## 捕获与传输

原生捕获与 CDP 后备捕获分别获得最多 3 秒，整体仍服从操作期限与取消信号。原生捕获失败或超时后，后备通道读取同一页面的真实像素，不重放点击，也不显示隐藏窗口。

两种捕获均失败时，保留已经成功执行的操作与页面文字，并返回 `screenshotUnavailable`。共享类型、引擎输出清洗和渲染解析均保留该说明，不覆盖真实图片。引擎改动在同级 `ai-agent-engine` 仓库。

## 验证

应用与引擎的 typecheck、build 均通过。定向验证通过：

| 范围 | 通过 | 内容 |
| --- | ---: | --- |
| 应用纯函数 | 134 | Work 图片分类、时间线顺序、浏览器快照解析、工具结果解析 |
| `browser-recovery-ui.spec.ts` | 6 | 原生失败/超时后的真实像素、双失败、取消、隐藏窗口、输入确认 |
| `browser-ui.spec.ts` | 11 | 中文输入、真实点击与网络副作用、视口变化、导航竞态、截图、关闭与清理 |
| `tool-result-images-ui.spec.ts` | 7 | Code 图片展示、放大、错误图片、历史回放、子代理图片 |
| Work 浏览器图片用例 | 1 | 内置浏览器真实截屏 → SSE 回执 → Work 预览、折叠、放大、焦点与主题 |
| 引擎浏览器输出 | 31 | 图片保留、文字与发布预算、失败说明传递 |

共 25 条真实 Electron 窗口测试通过，所监测的应用进程无异常。未运行全仓库 E2E。

最终窗口验证使用独立构建目录：常规 `out/renderer/index.html` 引用的 CSS 文件在验证期间缺失，导致浏览器内容区高度为零，显示确认因此超时。完整隔离构建后该问题消失，未修改显示确认保护逻辑。另将远端文件地址拒绝用例的旧文案断言更新为当前实现的明确错误，保留不创建页面的断言。

```powershell
npm run build -- --outDir .e2e-tmp/browser-images-build-20261105
$env:AETHER_E2E_APP_ENTRY = 'D:/dev/aether-code/.e2e-tmp/browser-images-build-20261105/main/index.js'
npx playwright test e2e/browser-ui.spec.ts e2e/browser-recovery-ui.spec.ts e2e/tool-result-images-ui.spec.ts --workers=1 --output=.e2e-tmp/browser-images-verification-20261105/native-code
npx playwright test e2e/work-timeline-ui.spec.ts --grep 'Work 浏览器操作保留实际截图' --workers=1 --output=.e2e-tmp/browser-images-verification-20261105/work
```

## 图片证据

以下为本地测试页面的真实捕获与 Electron 界面截图。回执通过测试 HTTP/SSE 夹具输入，不代表真实模型执行了这些操作；也不是用户历史围棋页面的截图。

- [内置浏览器捕获的原始 PNG](assets/browser-images-2026-11-05/captured-browser-page.png)
- [浅色列表局部](assets/browser-images-2026-11-05/work-browser-inline-light.png)（仅从下方完整截图裁切）
- [浅色列表完整截图](assets/browser-images-2026-11-05/work-browser-process-expanded-light.png)
- [深色列表](assets/browser-images-2026-11-05/work-browser-process-expanded-dark.png)
- [操作图片默认展示](assets/browser-images-2026-11-05/work-browser-operation-images.png)
- [放大查看](assets/browser-images-2026-11-05/work-browser-read-screenshot-enlarged.png)
- [过程折叠后保留图片](assets/browser-images-2026-11-05/work-browser-process-collapsed.png)

历史围棋记录已核对：两条红框中的导航/视口回执没有图片数据，两次显式截图都因显示表面不可用而失败。没有可恢复的历史截图，本次未修改历史记录。运行中的旧应用与引擎需加载新构建后，才能完整使用捕获修复。
