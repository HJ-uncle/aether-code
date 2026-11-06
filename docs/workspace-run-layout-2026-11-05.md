# Work 工作区运行与截图布局修复

## 用户可见变化

- Work 普通截图与浏览器点击位置截图统一左对齐、等比缩放，预览高度上限 360 CSS px。
- 删除展开内容内重复的网页标题和眼睛图标，网页名称保留在外层工具行。
- 点击坐标、目标框、键盘放大与关闭、点击后页面的独立展开继续保留。
- 默认会话工作区中的 HTML 可以直接点击“运行”，包括子目录页面引用的父目录样式、模块与图片。

## 运行错误的原因与修复

Work 文件读取通过认证的会话工作区接口；原 HTML 预览却只检查 Code 打开目录的全局文件白名单。默认会话目录没有被 Code 打开，因而出现“可以看源码，但运行提示工作区外路径”。此外，回退到 HTML 所在子目录会丢失 `../assets` 的正确根目录。

运行请求现在携带发起时的浏览器归属与 Work 会话。主进程验证当前展示代次、会话、引擎身份，再通过认证的 `/workspace/directory` 获取真实根目录，为该次运行签发独立预览权限。文件读取前后复核绑定及引擎；目录重新绑定、引擎或账户变化后，旧 URL 不再返回文件。重新运行会取得独立权限，避免复用已撤销的服务器。

预览权限不加入 `allowRoot()`，Code 的文件读取范围保持独立。Code 已授权目录及离线资料运行仍沿用原有检查；远端文件仍需使用可访问的开发服务器地址。

## 验证

- `npm run typecheck`：通过。
- `npm run build -- --outDir .e2e-tmp/workspace-run-layout-build-20261105`：通过，包含 node/web 类型检查。
- 34 项逻辑与实际 HTTP 权限测试通过：`browser-session-preview-access` 18 项、`browser-workspace-preview` 7 项、`html-run-contract` 9 项。
- 14 项真实 Electron 用例通过：`html-run-ui` 3 项、`work-html-session-run-ui` 2 项、`work-timeline-ui` 相关图片用例 2 项、`tool-result-images-ui` 7 项。
- 布局用例比较普通图片与 SVG 实际图片的左边线、宽高，覆盖深浅主题及 940/680 两种窗口宽度。
- 私有工作区用例从真实工作区文件树点击运行；验证原生页面脚本、CSS、图片加载及页面无 IDE bridge，并验证 Code 运行前后均不能读取会话私有文件、重新绑定后旧页面及资源 URL 失效。
- Electron 健康记录无异常。未运行全量测试。

测试夹具初次验收修正了公开 `/meta` 握手、工作区树旁侧预览的实际交互路径及历史接口；旧图片断言同步更新为标题只出现于外层工具行。最后执行的上述用例全部通过。

## 验收截图与构建

下列图片来自测试夹具，不是用户的五子棋文件：

- [深色点击截图左对齐](assets/workspace-run-layout-2026-11-05/work-browser-click-position-dark-940.png)
- [浅色点击截图左对齐](assets/workspace-run-layout-2026-11-05/work-browser-click-position-light-940.png)
- [独立会话工作区运行 HTML](assets/workspace-run-layout-2026-11-05/work-session-html-run.png)

本次改动位于桌面端，无引擎代码变更。验证使用隔离构建入口 `D:/dev/aether-code/.e2e-tmp/workspace-run-layout-build-20261105/main/index.js`，未替换正在使用的 `out/` 产物、未重启用户实例。使用常规入口验收时需重新构建并重启桌面端。
