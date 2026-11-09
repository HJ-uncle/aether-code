# 横向滚动覆盖检查（2026-11-09）

## 范围与方法

扫描整个 `src/renderer/src` 的 CSS、TS/TSX 内联样式、`scrollLeft` / `scrollBy` 使用，以及 `@media` / `@container` 中的布局切换。逐项核对 `overflow-x:auto/scroll` 与 `overflow:auto/scroll`，再追到实际渲染组件，避免只搜索已有的 `data-scroll-axis` 标记。

增强范围是应用自身的横向单轴区域：滚轮横移、2px 底部悬浮滚动条、按左右剩余内容显示渐变。不改变纵向列表、双轴编辑器和文档画布的滚动语义。

## 发现与修复

1. **成果文件列表的窄窗分支漏接。** `WorkArtifactsWorkspace.tsx` 的 `.work-artifacts-workspace__files` 在宽窗是纵向文件列表，在 520px 以下变为横排，却仍继承 `overflow:auto`，且没有单轴增强标记。
   - 补上标记；宽窗明确 `overflow-x:hidden; overflow-y:auto; scrollbar-width:auto`，保留纵向原生条。
   - 窄窗明确 `overflow-x:auto; overflow-y:hidden; scrollbar-width:none`，接入既有增强。
   - 文件项按名称展开，保留 160px 下限和 220px 上限，图标不收缩、长名称省略。
2. **十六进制预览的内层横轴漏接。** `FilePreview.tsx` 的 `.preview__hex` 没有自身高度上限，纵向由外层 `.preview__body` 承担，不能笼统视为双轴区域。给内层补上标记并明确 `overflow-y:hidden`，保留外层纵向浏览；横移到边缘后滚轮仍能继续向下浏览。
3. **工作表短标签过宽。** 纯文字页签误用了文件标签的 160px 下限，四字名称周围空白过多。改用 80px 下限，保留按内容增长、180px 上限和不收缩规则。

静态检查未发现除此之外的应用单轴滚动遗漏。此结论限定于当前代码和已核验布局，不把网页内容或第三方编辑器内部滚动区视为应用标签栏。

## 已接入区域

| 区域 | 渲染入口 |
| --- | --- |
| Work 工作区标签 | `contrib/work/WorkView.tsx` |
| 成果文件列表（窄窗） | `contrib/work/WorkArtifactsWorkspace.tsx` |
| Code 文件标签 | `workbench/EditorArea.tsx` |
| 浏览器网页标签、选项栏 | `contrib/browser/BrowserView.tsx` |
| 网络请求详情页签 | `contrib/browser/NetworkRequestDetails.tsx` |
| 终端标签 | `contrib/terminal/TerminalView.tsx` |
| 工作表页签 | `contrib/documents/SpreadsheetDocumentPreview.tsx` |
| 问题严重级筛选 | `contrib/problems/ProblemsView.tsx` |
| Markdown 代码块、表格 | `contrib/chat/Markdown.tsx` |
| 编辑器设置代码示例 | `contrib/editor/EditorSettings.tsx` |
| 二进制预览的十六进制文本 | `contrib/editor/FilePreview.tsx` |
| 引擎进程、SQLite 表格 | `contrib/work/EngineResourceHealth.tsx` |
| Monaco Git 修改、冲突操作栏 | `core/editor/source-git-features.ts` |

## 检查后保留原有滚动的区域

| 区域 | 原因 |
| --- | --- |
| Work / Chat / 子代理附件、资源芯片 | 使用 `flex-wrap:wrap`；限高时需要纵向滚动 |
| 过程文件树、后台运行列表 | 窄窗只是移动到上方，内部仍为纵向列表 |
| 文件批量操作、模型和路径选择列表 | 换行或纵向列表，无单轴横排遗漏 |
| 网络请求列表、详情、目录、控制台 | 多行内容，需要纵向或双轴滚动 |
| 表格正文、PDF / Office 正文 | 双轴网格，或文档缩放后的双轴画布 |
| Office 备注、限高工具详情代码 | 需要纵向滚动；已有代码块标记通过实际 overflow 判定排除 |
| Monaco / xterm、文本 / 差异预览 | 编辑、虚拟化或受限正文需要原有双轴语义 |
| 图片缩放预览 | 平移与缩放交互，不接管纵向滚轮 |
| 独立 Markdown 预览 iframe、网页内容 | 独立文档拥有自己的滚动与隔离边界，不注入应用交互脚本 |

## 验证

先执行 `npm run build`（包含 Node/Web 类型检查），再执行 `npx playwright test --config=playwright.horizontal-scroll.config.ts`，保持 Electron 单实例串行。

既有用例覆盖真实 XLSX 页签、深浅主题、边缘提示、RTL、动态内容/尺寸、点击与两种滚轮；新增真实二进制预览的内层横移与外层纵滚衔接验证。响应式用例覆盖真实成果文件列表的窄宽切换、窄窗横移/选文件、宽窗纵滚，并检查实际窗口内可见单轴横向溢出区域的标记覆盖。

本轮结果：构建及类型检查通过，**9 passed / 0 failed**；宽/窄窗口、深/浅主题和再次收窄五组实际 DOM 扫描均未发现未标记的可见单轴横向滚动区。已人工检查成果列表与紧凑工作表标签截图。结果保存在 `.e2e-tmp/horizontal-scroll-hints-results/`。
