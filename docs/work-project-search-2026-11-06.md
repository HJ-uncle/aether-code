# Work 项目全文搜索迁移验收

2026-11-06。替代原 `work-workspace-search-acceptance-2026-11-06.md` 中的前端目录遍历方案。

## 问题与参考

旧 Work 搜索先逐目录请求 `/workspace/directory` 建完整文件树，再逐文件请求全文。即使填写包含条件，也要先完成枚举。目录超过 2000、文件超过 20000 或层级超过 48 时会直接失败并清空结果，用户无法在未知位置搜索。

参考项目 `D:/web/wuzu-client` 的 `src/main/codeSearch/index.ts`、`service.ts`、`codeSearchWorker.ts`、`src/types/codeSearchMatcher.ts` 与 `CodeSearchPanel.vue`：采用 Git 批量枚举、统一 JavaScript 匹配、后台搜索和取消机制。参考仓库仅阅读，未修改。

## 当前行为

- 包含路径默认为空，输入关键词即可搜索整个会话工作区；过滤条件作为可选项。
- 工作区所在引擎执行 `/workspace/search`。Git 项目批量枚举已跟踪与未跟踪文件；非 Git 项目直接并发扫描，按包含/排除和忽略文件过滤。取消使用独立请求 ID。
- 独立 Worker 执行文件读取与正则匹配。输入变化、关闭面板、切换会话和点击“停止搜索”会取消当前请求。迟到结果不会替换新查询。
- 移除了前端 2000 目录、20000 文件、48 层遍历上限，也不再通过 HTTP 拉取整个项目正文。
- 保留大小写、全字、正则、包含/排除、结果折叠、鼠标/键盘定位与替换预览。搜索、预览和替换继续使用逐行 JavaScript 正则语义。
- 替换预览只读取服务器命中的文件。文件集固定；预览后内容发生变化则拒绝覆盖。未完整返回的搜索不能直接全部替换。
- 引擎身份、会话、工作区绑定代次及路径边界均受校验。符号链接不跟随，不会借搜索扩大 Code 的本地文件授权。

## 容量与性能

搜索展示最多 500 条命中，达到上限或 30 秒执行期限时保留已获得结果并说明不完整。二进制文件正常跳过，超过 1 MiB 的文本文件或读取失败会提示部分结果。这些限制不再让整个目录搜索直接失败。

参考项目只读实测，未输出文件正文：

| 查询 | 耗时 | 返回 |
| --- | --- | --- |
| `test` | 484 ms | 前 500 条，达到命中上限 |
| `workspaceSearch` | 970 ms | 64 条，发布态 JS Worker |
| 无匹配关键词 | 951 ms | 0 条 |

这些为本机单次测量，受磁盘缓存、文件规模影响。项目有 4 个超过 1 MiB 的文本文件，所以全范围查询同时提示结果不完整；大型图片、视频、字体和模型文件不会误报为搜索失败。

## 验证

- Aether `npm run build -- --outDir .e2e-tmp/work-project-search-final-build-20261106 --logLevel warn` 通过，包含 Node/Web 类型检查。
- 引擎 `npx tsc --outDir .e2e-tmp/work-project-search-build-20261106 --noEmitOnError` 通过。验证编译后的 `service.js` 能实际启动 `worker.js` 并读取参考项目。
- 前端纯逻辑 36 项通过：API 16、固定文件集/替换 17、远端匹配契约 3。
- 远端请求协议 18 项通过：包括新搜索与取消路由的精确方法范围。期间同步了旧测试对既有 `/command-jobs/:jobId` DELETE 的过时拒绝断言；没有因此修改产品行为。
- 引擎新增 33 项通过：真实磁盘搜索 2005 个目录不漏尾、Git/非 Git、忽略规则、过滤、原始位置、二进制/大文本、路径越界、绑定变化、精确取消、同会话并发请求、非终止正则的 Worker 超时保护与 HTTP 路由。
- Work Electron 共 15 个不同用例通过：包括 2050 个目录及 52 层未知位置、请求数量不随目录增长、取消和迟到响应、完整/不完整预览、实际替换写盘、会话隔离、空排除表时忽略开关仍触发重搜，以及深浅主题和窄栏。
- Code Electron 搜索回归 4 项通过：分组打开、键盘/定位/状态、替换写盘、排除设置。
- 共 106 个相关用例通过。Electron 串行执行，健康检查无错误。首次 UI 文案断言未包含“未完整返回”，修正测试后相应用例通过。

测试输出：`.e2e-tmp/work-project-search-ui-20261106`、`work-project-search-ui-tail-20261106`、`work-project-search-ignore-ui-20261106`、`work-project-search-code-regression-20261106` 和 `work-project-search-protocol-results-final`。

## 界面记录与生效

- [搜索结果（浅色）](assets/work-project-search-2026-11-06/search-light.png)
- [筛选、替换和命中定位（深色窄栏）](assets/work-project-search-2026-11-06/search-dark-narrow.png)

图片来自受控测试任务。验证没有替换正在运行应用的 `out/` 或引擎 `dist/`。本次新增了引擎接口，实际使用需要同时重新构建并重启 Aether 前端与 `ai-agent-engine`；仅重建前端会提示引擎尚不支持项目全文搜索。
