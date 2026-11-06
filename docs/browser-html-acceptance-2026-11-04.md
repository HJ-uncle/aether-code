# 浏览器与 HTML 运行验收记录

验收日期：2026-11-04。项目：`D:\dev\aether-code`。

本轮已修复 Code / Work 浏览器展示归属、Work 原生页面尺寸、HTML 运行与本地标签复制，以及 Work 离线打开本地资料被引擎状态误拦截的问题。最终 **r9 的 HTML 完整链路 3/3、浏览器范围隔离 2/2、源码与实时预览 5/5 全部通过**，共 10 项真实 Electron 验收，分两次执行。下文保留 r7 的历史结果与失败证据，用于追踪问题修复。

本文仅记录浏览器与 HTML 专项。测试使用临时工作区与隔离用户目录，不调用真实模型；四角色协作、真实模型工具选择、队列与运行中追加要求的验收由总报告另行记录。

## 版本与结果

| 构建或源码状态 | 测试 | 结果 | 证明范围 |
| --- | --- | --- | --- |
| `fixes-20261104-r7/main/index.js` | `e2e/browser-work-scope-ui.spec.ts` | 2/2 通过 | Code、Work A、Work B 独立原生页面；模式与任务切换时显示隔离；返回后保留原 WebContents；Work 获得有效尺寸。 |
| 同一 r7 构建 | `e2e/editor-source-preview.spec.ts` | 5/5 通过 | Markdown 未保存文本与相对图片、双向滚动与缓冲区、HTML 单一运行入口、路径面包屑、编辑设置生效与保留。 |
| 同一 r7 构建 | `e2e/html-run-ui.spec.ts` | Code 运行与复制通过，Work 打开失败 | r7 联合验收整体仍失败，不能因前两组通过写成全通过。 |
| r7 诊断复跑 | 同上，补充真实错误提示采集 | 2 通过、1 失败 | Work 点击资料后出现“引擎连接已变化，请在当前会话重试”；确认缺陷位于打开本地文件阶段。 |
| 最终 `fixes-20261104-r9/main/index.js` | 同上，完整串行执行 | **3/3 通过，6.8 秒** | Code 保存运行、复制独立页面、Work 打开资料并运行，三段完整链路均通过。 |
| 同一最终 r9 构建 | `e2e/browser-work-scope-ui.spec.ts` 与 `e2e/editor-source-preview.spec.ts` | **7/7 通过，11.7 秒** | 范围隔离 2 项与源码预览 5 项在最终构建再次通过，覆盖上文两组完整行为。 |
| 与最终修复一致的源码 | `e2e/work-file-open-contract.spec.ts` | **10/10 通过，860 毫秒** | 离线恢复的任务目录边界、远端隔离、异步身份切换和失败路径；不启动 Electron。 |
| 最终 r9 | `npm run build -- --outDir .e2e-tmp/fixes-20261104-r9` | 通过 | 包含类型检查及 main / preload / renderer 构建；已有 Vite 静态与动态混合导入提示，不影响本次构建退出成功。 |

最终可复用入口为：

```text
D:\dev\aether-code\.e2e-tmp\fixes-20261104-r9\main\index.js
```

r9 完整 HTML 复跑是在最后一次本地恢复目录边界修复后重新构建执行的。随后主任务使用同一最终 r9 入口复跑范围隔离和源码预览，7/7 通过；本报告已核对该轮 `.last-run.json` 为 `passed`、失败列表为空。`.last-run.json` 只记录整次运行状态与失败 ID，不单独保存通过项数量；以上通过项数量与耗时来自当次 Playwright 控制台结果。历史 r7 结果不重复计入最终 r9 的 10 项。

## 问题、修复与边界

| 问题 | 最终处理 | 边界 |
| --- | --- | --- |
| 浏览器标签和原生显示区域可能跨 Code / Work 或任务串用 | 标签展示归属绑定模式、会话和引擎；每个范围独立保存选中标签与 reveal 状态。主进程校验展示归属及递增 generation。 | 后台任务的事件不能抢占前台原生表面；切换只改变显示，不销毁其他任务页面。 |
| 引擎尚未就绪时缺少稳定的展示身份 | 增加仅用于展示的 `pendingSourceId`，由选定运行方式、规范化远端地址和账号生成；就绪后仅经验证迁移为真实引擎身份。 | 不同来源与账号不会因“都未就绪”归为同一展示范围；展示归属不授予 AI 浏览器工具权限。 |
| Work 网页区域出现空白，原生视图没有有效高度 | 增加 Work 浏览器内容容器与 flex 尺寸链，使原生视图接收实际内容区域尺寸。 | 真机断言对应原生视图可见，宽高均大于 200，并读取实际页面内容。 |
| HTML 编辑、预览和运行入口重复；运行后未稳定显示目标页面 | HTML 保留统一运行入口；Code 先保存当前编辑，再打开实际本地 HTML；共享 `runHtmlFile` 捕获发起时的展示范围，接收并显示真实返回标签。Markdown 继续使用源码与实时预览。 | 保存或打开失败不能创建替代空白页；异步期间切换任务，不让旧操作抢占新任务界面。 |
| Work 运行使用的路径或根目录与实际文件不一致 | 使用已成功读取的文件路径，以及文件目标或当前任务的工作区根目录。 | `docs/围棋.html` 能解析 `../assets/` 下的 CSS、ES module 和图片。 |
| 本地网页“复制标签页”后副本依赖原标签授权 | 主进程提供受控 duplicate API，为本地页面副本建立独立授权来源，并保留会话归属、视口及缩放。 | 关闭原页不撤销副本；已导航到 HTTP 的本地标签复制当前 HTTP 地址，不复制旧文件授权。 |
| Work 离线资料可读，却在打开为文件标签前报连接变化 | `open-file.ts` 将来源身份检查与引擎就绪检查分开，仅本地 Work 可进入既有只读恢复路径。 | Code 与远端仍要求就绪；离线恢复根来自当前任务的真实 `workspacePath`，不信任调用方提示的工作区根。 |

最后一项的直接原因是：`getSnapshot()` 后的 `assertOpeningContext()` 调用了同时要求“来源未变”和“引擎已就绪”的检查，在进入会话文件读取的 `try/catch` 前就抛错，导致原有本地恢复流程无法运行。r7 诊断时资料预览已有真实 HTML，但点击打开文件标签失败，提示为：

```text
引擎连接已变化，请在当前会话重试
```

修复后，离线本地 Work 仍在每个异步边界检查来源、模式与任务身份，并额外过滤恢复候选路径，只允许当前任务工作区内的文件。文件先成功读取才建立资源。跨盘路径、`../` 越界、其他任务路径与伪造根提示均有拒绝回归。

## 真实操作与断言

HTML 的三项验收在一个隔离 Electron 实例中串行执行，按以下路径操作真实 UI：

1. **Code：**快速打开 `docs/围棋.html`，在 Monaco 输入未保存内容，点击“保存并在浏览器中运行”。验证磁盘已保存新增标记、运行标签被选中、页面标题由模块改写、CSS 颜色生效、图片具有真实尺寸，网页中不暴露 `window.aether`。
2. **复制：**打开本地网页，右键标签选择“复制标签页”。验证副本获得不同的本地授权来源、保留原归属；通过关闭按钮关闭原页，再刷新副本，页面仍能加载。
3. **Work：**点击“Work 办公”→“打开工作区”→“更多工作区”→“资料”→`围棋.html`→新增文件标签→“在浏览器中运行”。验证标签归属当前 Work 任务、原生页面显示且尺寸有效、相对资源全部加载，已有 Code 标签集合保持不变。

资料条目选中后仍显示资料预览，并在统一标签栏加入文件资源；测试随后显式点击文件标签。该行为与打开错误区分记录，不再将“尚未选择新增文件标签”误当作运行按钮缺失。

原生页面匹配使用唯一 URL 与 `tabId → WebContents.id` 对照，避免同一本地文件在多个范围打开时检查错页面。标签加载等待同时要求 `loading === false` 且 URL 不为 `about:blank`，避免把创建时的瞬态空页当作最终页面。

r7 的范围测试还验证：Code、Work A、Work B 的原生 ID 与授权 URL 均不同；切换时旧视图隐藏；回到 Work A 保留原生 ID；回到 Code 恢复 Code 页面。纯测试另外覆盖旧 generation、来源/账号不同、异步完成后归属变化、未绑定页面不得跨范围接管等条件。

## 隔离措施

- Electron 使用独立 `--user-data-dir`、`AETHER_GLOBAL_DIR` 和 `.e2e-tmp` 下新建工作区；设置 `autoStartEngine: false`，没有读取生产会话或调用真实模型。
- 初始草稿任务与工作区通过测试夹具建立；文件打开、编辑、运行和右键复制由真实 UI 完成，网页使用实际主进程及原生 WebContentsView。
- 每轮只运行一个测试实例；结束调用 `app.close()`。清理前校验临时目录的绝对父目录与固定前缀，仅删除本轮夹具。
- 浏览器 UI 展示范围与 AI 工具授权上下文分开。本地用户主动预览不等同于允许远端引擎或其他任务访问本机文件。
- 本报告编写阶段未再次启动窗口，也未改动生产代码或测试代码。

## 证据位置与截图限制

所有路径相对项目根目录。

| 证据 | 路径 |
| --- | --- |
| r7 联合验收记录及 Work 失败 trace | `.e2e-tmp/fixes-20261104-r7-browser-results/` |
| r7 离线故障诊断、真实错误提示与 trace | `.e2e-tmp/work-html-offline-before/` |
| r9 三项完整通过及 Code / Work 截图 | `.e2e-tmp/work-html-offline-after/` |
| r9 范围隔离 2 项与源码预览 5 项再次通过 | `.e2e-tmp/fixes-20261104-r9-browser-results/` |
| 离线文件边界 10 项通过记录 | `.e2e-tmp/inspect-file-open-pure/` |

Code 截图位于：

```text
.e2e-tmp/work-html-offline-after/html-run-ui-HTML-运行与本地标签菜单-a6155-前-HTML，展示真正的页面及相对-CSS-模块-图片/code-window.png
.e2e-tmp/work-html-offline-after/html-run-ui-HTML-运行与本地标签菜单-a6155-前-HTML，展示真正的页面及相对-CSS-模块-图片/code-native-html.png
```

Work 截图位于：

```text
.e2e-tmp/work-html-offline-after/html-run-ui-HTML-运行与本地标签菜单-Work-资料打开后点击运行，自动显示当前任务网页且加载父目录资源/work-window.png
.e2e-tmp/work-html-offline-after/html-run-ui-HTML-运行与本地标签菜单-Work-资料打开后点击运行，自动显示当前任务网页且加载父目录资源/work-native-html.png
```

四张截图均已目检。`*-window.png` 来自 `BrowserWindow.capturePage()`，本次捕获只包含宿主 UI，**没有合成子 WebContentsView 的网页层**，因此浏览器区域能看到宿主占位背景。这不是整台桌面的操作系统级截图，不能单靠它证明原生网页最终合成显示正确，也不能据此断言网页加载失败。

`*-native-html.png` 单独捕获目标网页，能看到“编辑后运行”“围棋模块加载成功”、预期蓝色标题和绿色图片。结合实际 DOM、原生 `getVisible()`、宽高检查，证明目标页面加载与布局链路已成功。仍未提供操作系统级整窗合成截图；若总验收需要此类视觉证据，应单独补充，不以拼接图片冒充实拍。

这些文件位于临时验收目录，后续清理会影响可追溯性；对外归档时应同时保留所需截图与 trace。

## 复现命令与后续验收边界

以下命令为已执行的最终 HTML、范围隔离、源码预览与文件边界验证。执行真实 UI 前需确保没有其他验收实例竞争窗口。

```powershell
$env:AETHER_E2E_MAIN='D:\dev\aether-code\.e2e-tmp\fixes-20261104-r9\main\index.js'
npx playwright test e2e/html-run-ui.spec.ts --reporter=line --output=.e2e-tmp/work-html-offline-after
npx playwright test e2e/browser-work-scope-ui.spec.ts e2e/editor-source-preview.spec.ts --reporter=line --output=.e2e-tmp/fixes-20261104-r9-browser-results
npx playwright test e2e/work-file-open-contract.spec.ts --reporter=list --output=.e2e-tmp/inspect-file-open-pure
```

关键实现文件包括 `core/browser/{scope,presentation,connection}.ts`、`contrib/browser/{browser-store,BrowserView}.tsx/ts`、Work 资源与浏览器组件、`main/browser/{service,surface-ownership,local-files}.ts`、`contrib/editor/run-html.ts` 及 `contrib/chat/open-file.ts`。真实回归入口为上文三份 UI 测试；补充契约包括 `browser-mode-scope`、`browser-surface-ownership`、`browser-presentation-contract`、`html-run-contract`、`browser-duplicate-contract` 与 `work-file-open-contract`。

本专项没有测量办公文件“秒开”性能，也没有以真实模型验证工具使用效率、H5 围棋业务质量或四角色协作效果。已通过的网页夹具是确定性 HTML 资源加载样例，不能代替完整围棋产品验收。最终 r9 构建与测试窗口已交还主任务继续整体验收。
