# 回复图片统一展示验证记录

2026-11-05。最终回复内的图片直接展示；工具调用与其图片收进 Work「过程」。图片来源不影响这套规则，覆盖浏览器截图、生成图片及正文引用的图片文件。

## 实现行为

- 最终正文使用共享 `ChatImage`：按原有图文顺序展示缩略图，点击或 Enter 放大，Escape 关闭并恢复焦点。普通段落、带链接图片和嵌套列表均可显示。
- 普通工具和图片默认收进「过程」，展开工具详情后可查看、放大图片。原有协作代理与持久命令卡片保持其专用呈现。
- 同一工具同时返回文件改动和图片时，两者都保留，不再因文件行分支丢失图片。
- Code、Work 与子代理正文使用同一 Markdown 图片组件。
- 文件图片通过消息所属会话读取，兼容本地与远端、相对与绝对路径、引擎交付链接、中文和特殊字符文件名。来源变化会阻止旧请求回写，不回退到任意本机文件读取。
- 加载中、读取失败和解码失败有明确状态；文件读取失败可重试。支持现有栅格图片格式及作为 `img` 加载的 SVG。正文图片上限为 20 MiB。
- 任意外部 HTTP 图片 URL 暂不自动加载；当前支持会话文件、同源且同会话的交付链接及内嵌图片数据，CSP 没有放宽。

## 验证结果

`npm run typecheck` 与隔离目录 `npm run build` 通过。相关纯函数 **27 passed**。真实 Electron 窗口 **13 passed / 1 failed**，未运行全仓库 E2E。

| 范围 | 结果 | 覆盖 |
| --- | --- | --- |
| `chat-image-source.spec.ts` | 8 passed | 路径、协议、会话归属、图片字节、SVG、真实体积限制 |
| Work 展示与分组纯函数 | 19 passed | 工具归入过程、图片保留、时间顺序、协作分组 |
| `chat-artifact-link-ui.spec.ts` | 6 passed | 真实本地/远端 PNG、特殊字符、嵌套列表、带链接图片、放大键盘、历史重载、读取边界 |
| `work-timeline-ui.spec.ts` 定向 | 3 passed | Work 截图、Code 共享组件、正文图文、非浏览器生成工具的图片＋文件改动、过程收放、放大与焦点 |
| `chat-stream-stability-ui.spec.ts` 定向 | 4 passed | 上翻阅读、恢复跟随、迟到图片布局、流式淡入、减少动态效果、历史回放 |
| 同套流式测试第 1 条 | 1 failed | 工具过程展开期间，rAF 采样底部间距 10 px，断言要求 ≤2 px |

失败项已复现，未修改或放宽断言。最终采样为 99 个 rAF、28 个 ResizeObserver 回调；后者最大底部间距 0.334 px，正文节点没有卸载，宽度没有变化。偏差集中于工具过程的高度动画阶段，该用例不含图片；同轮后续布局回调恢复贴底。现有证据还不足以判断用户实际绘制是否出现跳动，不能将整套流式测试标为通过。

原有测试夹具同时按当前协议更新：可选子代理能力返回明确的 404、补齐队列接纳上下文、按会话隔离恢复数据；本地历史夹具通过真实 WorkspaceManager 建立绑定。HTML 交付链接测试改为点击当前「运行」入口并检查真实浏览器 DOM；图片与文件边界断言均保留。

```powershell
npm run build -- --outDir .e2e-tmp/reply-images-build-20261105 --logLevel warn
$env:AETHER_E2E_APP_ENTRY = 'D:/dev/aether-code/.e2e-tmp/reply-images-build-20261105/main/index.js'
npx playwright test e2e/chat-artifact-link-ui.spec.ts --workers=1 --output=.e2e-tmp/reply-images-verification-20261105/artifacts-complete
npx playwright test e2e/work-timeline-ui.spec.ts -g 'Work 截图可放大|Work 工具图片收进过程|Code 共享组件回归' --workers=1 --output=.e2e-tmp/reply-images-verification-20261105/work-final
npx playwright test e2e/chat-stream-stability-ui.spec.ts --workers=1 --output=.e2e-tmp/reply-images-verification-20261105/stream-final
npx playwright test e2e/chat-stream-stability-ui.spec.ts -g '上翻阅读历史|没有新增SSE|新文字在|浅色主题' --workers=1 --output=.e2e-tmp/reply-images-verification-20261105/stream-image-regressions
```

使用隔离构建，避免常驻开发实例更新共享 `out/` 干扰验证。没有重启用户正在运行的应用或引擎。

## 图片证据

以下均来自真实 Electron 窗口。生成图片为固定 PNG 测试样例；网页图片为内置浏览器实际捕获的本地测试页面。工具回执与最终正文由受控 HTTP/SSE 夹具提供，不代表真实模型生成了这些内容，也不是用户历史围棋页面的截图。

- [最终图文局部](assets/reply-images-2026-11-05/work-final-markdown-inline.png)：仅从完整截图裁切。
- [最终图文完整截图](assets/reply-images-2026-11-05/work-final-markdown-images.png)。
- [正文图片放大](assets/reply-images-2026-11-05/work-final-markdown-image-enlarged.png)。
- [非浏览器图片与文件改动混合回执](assets/reply-images-2026-11-05/work-generated-tool-image-with-change.png)。
- [过程展开：浅色](assets/reply-images-2026-11-05/work-browser-process-expanded-light.png)、[深色](assets/reply-images-2026-11-05/work-browser-process-expanded-dark.png)。
- [过程收起后正文图片保留](assets/reply-images-2026-11-05/work-browser-process-collapsed.png)。

本记录替代先前「工具图片独立且默认展开」的展示规则；之前的浏览器真实截图捕获与后备通道修复继续有效。
