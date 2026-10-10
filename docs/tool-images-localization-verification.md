# Low 默认值、工具图片与中文名称验证

验证日期：2026-10-10。范围：Aether 客户端本轮修改及相关回归。

## 问题与修复

- 原工具详情直接用 `<pre>` 渲染结果，浏览器截图的 `dataUrl` 因而变成大段 Base64 文本。现在主会话、历史回放和子代理共用图片结果组件；含图片的主工具结果默认展开并保留在时间线中，不随过程块一起折叠。支持点击放大、Escape 关闭和焦点返回，结果元数据仍可查看。按后续界面要求，主工具与子代理均隐藏输出上方的原始参数 JSON，标题行保留必要摘要；只有参数的工具不再提供空白详情。
- 默认思考档位改为 Low，首次请求实际携带 `thinkingMode: 'low'`。已有全局偏好、明确的会话选择及服务端运行参数保持原语义；切换会话不会把别的会话档位带过来。
- 中文映射由共享模块提供，覆盖聊天状态、工具详情、历史文本导出、审批默认提示、子代理与 MCP 设置。只改显示名称，协议工具名、启停配置和审批回传仍用原始标识。
- 顺带修复共享 Dialog 先移入焦点、后记录原焦点的顺序问题；关闭放大图片后，焦点正确返回缩略图按钮。

## 中文名称审计

只读扫描同级引擎 `src/tools` 和 `src/skills` 中的工具声明，不导入引擎注册表，避免初始化数据库。共核对 **65 个内置工具**，这是跨工具配置的集合，不代表 Code 模式同时启用 65 个工具。

旧映射覆盖 42 个，本轮补齐 **23 个**：浏览器工具 15 个、代理执行工具 3 个、历史检索 1 个、记忆工具 2 个、技能工具 2 个。另保留 4 个旧工具别名。

未知第三方名称保留原名；MCP 服务和操作之间存在歧义的单下划线名称，不根据后缀猜测。已有明确服务标识或无歧义命名时，可映射已知操作。

## 图片支持边界

支持工具返回的自包含 PNG、JPEG、GIF、WebP、BMP、AVIF 数据，识别浏览器/文件图片结果、MCP image block、Anthropic base64 source、OpenAI image_url 数据，以及嵌套或多层 JSON 历史。相同图片去重，普通文本保持原格式。

换行 Base64 在明确图片字段和有效独立数据中归一化；损坏字段整体替换为中文提示。解码失败时显示“图片无法显示”。任意外部 HTTP URL、本地文件路径和 SVG 不会由该组件自动加载；仅返回地址而未携带图片数据的结果仍作为文本展示。未放宽 CSP。

## 图片与中文映射验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- 最终构建后串行执行以下 11 个 spec：**100 passed / 0 failed / 0 skipped**，79.8 秒。
- `git diff --check`：通过。

| Spec | 用例数 | 主要覆盖 |
|---|---:|---|
| `account-settings-ui.spec.ts` | 15 | 共享弹窗、键盘焦点及账号界面既有回归 |
| `browser-agent-ui.spec.ts` | 3 | 真实引擎调用可见浏览器、截图像素、放大、刷新回放 |
| `composer-defaults-ui.spec.ts` | 6 | 本地/远端 Low 默认值、手选偏好、新会话 |
| `mcp-ui.spec.ts` | 7 | 真实工具发现、启停、配置落盘与 HTTP MCP |
| `pending-interactions.spec.ts` | 12 | 审批与交互帧、原始协议值 |
| `session-request-config.spec.ts` | 6 | 会话参数恢复、作用域和精确请求值 |
| `subagent-state.spec.ts` | 15 | 子代理状态、回放、结果与导出 |
| `thinking-mode-ui.spec.ts` | 4 | 本地/远端档位透传与会话偏好恢复 |
| `tool-names.spec.ts` | 6 | 中文覆盖、MCP 歧义、历史别名、审批回传 |
| `tool-result-images-ui.spec.ts` | 5 | 真实 Electron SSE 图片、多模态历史、子代理及键盘预览 |
| `tool-result.spec.ts` | 21 | 图片协议、换行编码、损坏输入、文本保留与来源限制 |

测试使用独立用户目录、临时工作区及测试服务，Electron 单 worker 串行运行。真实截图与夹具图片均检查 `naturalWidth > 0`，不是只检查 `<img>` 标签存在；实际浏览器截图已人工检查布局。

完整本轮日志位于 `.e2e-tmp/tool-images-final-typecheck.log`、`.e2e-tmp/tool-images-final-build.log` 和 `.e2e-tmp/tool-images-final-verification.log`。这些临时日志不提交 Git。本报告记录相关回归结果，不代表执行了仓库全量测试。

复跑方式（PowerShell；先构建成功再执行测试）：

```powershell
npm run typecheck
npm run build
npx playwright test e2e/tool-result-images-ui.spec.ts e2e/tool-result.spec.ts e2e/tool-names.spec.ts e2e/pending-interactions.spec.ts e2e/subagent-state.spec.ts e2e/composer-defaults-ui.spec.ts e2e/browser-agent-ui.spec.ts e2e/thinking-mode-ui.spec.ts e2e/session-request-config.spec.ts e2e/account-settings-ui.spec.ts e2e/mcp-ui.spec.ts
```

## 后续：隐藏原始参数区域

按截图反馈，移除主工具与子代理输出上方的原始参数 JSON，不影响图片、输出、错误信息及标题行摘要；只有参数的条目不能展开空白详情。

类型检查与构建通过，相关 13 条现有 UI 回归最终全部通过：浏览器 3 条、工具结果图片 5 条、工具诊断 2 条、子代理生命周期 3 条。本轮校正了旧测试中仍期待英文工具名及旧上下文按钮文案的两处预期。

重跑期间 `out/renderer/index.html` 被其他构建重新生成，一条子代理测试刷新页面时遇到 `ERR_FILE_NOT_FOUND`，其后两条依赖用例未运行；其余 10 条通过。待产物恢复后单独补跑子代理 3 条，全部通过（11.8 秒）。没有跳过失败断言。

本轮记录：`.e2e-tmp/tool-args-hidden-typecheck.log`、`.e2e-tmp/tool-args-hidden-build.log`、`.e2e-tmp/tool-args-hidden-verification-final.log` 与 `.e2e-tmp/tool-args-hidden-subagent-final.log`。

## 后续：图片简化与浏览器快照可视化

图片下方的文件名及“点击放大”文字已移除，图片仍可点击放大，并保留无障碍名称与键盘操作。

浏览器点击、填写、导航等工具返回的页面快照，按真实字段结构识别并展示为卡片：页面标题、地址、加载状态、视口和元素数量；正文按正常换行展示，可切换到中文角色的元素列表查看名称及当前值。内容区最大高度 280px，内部滚动，不将滚轮事件传给聊天自动跟随逻辑。原始数据默认折叠。

兼容实时结果、嵌套 JSON、历史回放及子代理共用组件。错误结构继续按普通工具结果展示。页面内容仅渲染成文本，不执行 HTML，也不根据快照地址发起导航或额外请求。

`npm run typecheck`、`npm run build`、`git diff --check` 通过；最终 54 条相关回归全部通过，0 失败、0 跳过（15.6 秒）：`browser-agent-ui.spec.ts` 3 条、`tool-result-images-ui.spec.ts` 5 条、`browser-snapshot.spec.ts` 25 条、`tool-result.spec.ts` 21 条。真实浏览器用例验证正文/元素切换、原始数据折叠、历史不重跑工具、图片无 caption 及元素区自然溢出时的真实滚轮操作；实际卡片截图已检查。

日志：`.e2e-tmp/browser-snapshot-typecheck.log`、`.e2e-tmp/browser-snapshot-build.log`、`.e2e-tmp/browser-snapshot-verification.log`。

## 后续：点击位置可视化（2026-10-10）

展开“点击浏览器元素”结果后，显示点击位置示意图、X/Y 坐标、目标名称和定位符，图中以圆点、辅助线和元素边框标注位置。示意图依据点击前的真实 CSS 视口绘制，不是页面截图；不额外截图，也不增加图片数据传输。实际界面截图已检查。

主进程在同一次页面读取中采集点击点、目标边界、视口、滚动位置、页面地址和导航身份，选择器、元素引用、坐标点击共用该记录。页面跳转后仍保留点击前的位置；实时输出、历史回放和子代理结果共用组件。旧记录未保存坐标时明确提示，不根据工具参数猜测位置。标签不读取输入值，长标签折叠显示，完整内容保留在原始数据；异常几何只影响示意图显示，不限制工具执行。

回归发现并修复了设备模拟视口缩小显示时的既有点击偏移：Electron 的视口适配比例需要作用于鼠标派发坐标，不能把 CSS 坐标直接送入缩放后的原生视图。现在仅在派发时换算，记录与图示仍使用 CSS 坐标；关闭模拟时恢复比例 1。以真实可信鼠标事件核对坐标，允许 Chromium 不超过 1 CSS 像素的整数取整差异，验证实际按钮副作用及链接跳转。

最终类型检查、构建及 `git diff --check` 通过，以下 **102 条相关用例均已验证通过，无未解决失败或跳过**：

| Spec | 用例数 | 本轮覆盖 |
|---|---:|---|
| `browser-agent-ui.spec.ts` | 3 | 真实引擎到网页的点击、返回坐标与实际事件一致、图中标记、刷新回放 |
| `browser-ui.spec.ts` | 7 | 远端队列、选择器/引用/坐标点击、零坐标、密码保护、80%/125% 缩放、桌面/手机模拟视口、链接跳转及旧引用拒绝 |
| `tool-result-images-ui.spec.ts` | 6 | 长标签高度边界、原始信息保留、旧点击记录提示、图片与子代理既有回归 |
| `browser-snapshot.spec.ts` | 65 | 点击前视口、历史兼容、异常坐标与元素边界、嵌套结果和中文角色 |
| `tool-result.spec.ts` | 21 | 工具输出解析和图片兼容回归 |

最终构建后的组合运行有 98 条通过，新增标签 UI 用例漏掉了默认折叠卡片的展开步骤，导致 1 条失败、其后 3 条未运行；确认产品交互后修正测试操作，补跑该 UI spec 的 6 条全部通过（其中 2 条与组合运行重复）。没有为通过测试调整产品的默认展开行为。本节是相关功能回归，不代表仓库全量测试或长期稳定性验证。

日志：`.e2e-tmp/browser-click-position-final-typecheck.log`、`.e2e-tmp/browser-click-position-final-build.log`、`.e2e-tmp/browser-click-position-final-verification.log`、`.e2e-tmp/browser-click-position-label-final.log`。

## 后续：所有页面元素的位置与尺寸（2026-10-10）

用户截图为“调整浏览器视口”的结果。此前只保存了点击动作的位置，普通页面快照中的元素没有坐标，因此这类工具结果仍然只有名称。现在所有返回页面快照的工具统一携带元素位置；移除“页面文字/页面元素”切换，直接展示元素列表。

每个有布局框的元素显示相对于视口左上角的 X/Y 和宽高，单位为 CSS 像素。点击列表项只改变卡片中的元素位置示意图，不会操作真实网页。列表继续采用 280px 最大高度和内部滚动。位于视口外或没有尺寸的元素明确标记；旧历史未记录位置与已采集但没有布局位置的元素分别提示，不补零、不猜位置。原始页面文字仍保存在折叠数据中。

元素边界通过单次 `DOMSnapshot.captureSnapshot` 批量关联现有可访问元素及文本节点。Chromium 的布局快照使用物理布局单位：实测 Windows 150% 缩放、页面 125% 缩放以及手机模拟 DPR 2 的比例不同，不能直接使用 `devicePixelRatio`。现在使用 `Page.getLayoutMetrics` 中对应的物理/CSS 视口尺寸计算比例，并扣除同一次布局捕获的滚动位置；保留导航检查，滚动比较容忍浮点误差。iframe 宿主可提供主视口位置，无法确定主视口坐标的内部或虚拟节点显示“无布局位置”。密码输入值保护保持原有行为。

真实界面专项验收直接展开“调整浏览器视口”工具，断言没有文字页签、元素坐标可见，选择按钮后示意框与当时快照边界一致。实际截图已核对，并补齐截图中 `LabelText` 的中文名称“标签”。远端回归将按钮、具名画布及文本节点位置与真实 DOMRect/Range 比较，包含滚动后负坐标、离屏元素、80%/125% 页面缩放及桌面/手机模拟。

最终 `npm run typecheck`、`npm run build` 与改动格式检查通过。在最终构建上串行运行 **119 passed / 0 failed / 0 skipped**（23.0 秒）：真实引擎浏览器 3 条、远端浏览器 8 条、快照解析 81 条、工具图片 UI 6 条、工具结果解析 21 条。开发中发现的物理/CSS 单位差异已修复；滚动画布测试为夹具补上可访问名称，确保 Chromium 确实将其纳入现有 AX 元素列表，没有修改产品来强行让断言通过。

日志：`.e2e-tmp/browser-element-position-final-typecheck.log`、`.e2e-tmp/browser-element-position-final-build.log`、`.e2e-tmp/browser-element-position-final-verification.log`。最终视口卡片截图：`.e2e-tmp/browser-element-position-preview.png`。本轮仍为相关功能回归，不代表仓库全量测试。

### 现场排查：新界面配旧采集进程

2026-10-10 15:06 排查“点击坐标有值、元素位置全部缺失”：现场 Aether 主进程 PID 37992 于 14:37:20 启动，仍未重启；元素坐标修复源文件更新于 14:49，最终主进程产物构建于 14:54。运行实例早于修复，磁盘构建成功不会替换它已加载到内存中的代码。

项目 `npm run dev` 为 `electron-vite dev`，未启用 `--watch`，配置也未设置 `main.build.watch`。已核对本地 electron-vite 5.0.0：渲染进程可热更新，而主进程仅在显式监听模式下重建并重启。因此刷新界面后会看到新版元素列表，但旧主进程产生的快照仍不含 `elements[].bounds`。需完整退出当前开发实例并重新启动，再生成一次页面快照；已保存的旧记录仍保留历史原貌。此次未擅自关闭用户正在运行的 IDE 或终端。

## 后续：位置图显示真实页面截图（2026-10-10）

“元素位置”现在以保存的真实页面截图作为背景，叠加所选元素边框；“点击位置”使用鼠标派发之前的截图，叠加实际点击点和目标边框。两个区域均可点击放大，弹窗内保留同一套坐标，支持 Escape 关闭。选择列表元素不会操作真实网页。截图与图形共用 CSS 视口坐标，兼容页面缩放、滚动及手机模拟。旧历史没有截图时保留示意图并明确提示，损坏图片也会降级，不加载外部图片地址或放宽 CSP。

主进程保存整块可见页面的 PNG，读取 PNG 头中的实际像素尺寸，不把 Electron DIP 当作图片像素。预览最长边 1600 像素、单图不超过 1 MiB；图片缩小不改变保存的 CSS 坐标。采集前后核对导航、页面地址、滚动、视口、缩放及视图范围；点击还保留原 DOM 节点并在派发前核验位置与遮挡，避免截图等待期间误点。

本轮同时修复实际回归发现的导航竞态：点击已成功，但读取结果期间页面跳转，原先会把整个工具误报为失败。现在仅重新读取操作后的快照，绝不重放点击、输入或按键；读取受总时间预算约束。最终仍读不到时返回 `snapshotUnavailable`，界面明确显示操作已执行，模型也收到不要重复操作的提示，同时保留点击前的图像证据。

引擎 `D:/dev/ai-agent-engine` 同步修复图片传输：浏览器位置截图与文字预算分开，持久化历史和工具显示结果保存图片，模型输入与压缩摘要只保留图片元数据，显式 `browser_screenshot` 的原有模型视觉输入继续有效。实时恢复不会把图片 JSON 从中间截断；预览缓存有独立的总预算，仅在工具结果变化时统计，避免每个正文 token 都扫描工具列表。子任务在父会话中的概览保持原有文字预算并保留合法结构，完整像素保存在子会话历史中。

### 最终验证

- 客户端 `npm run typecheck`、`npm run build`：通过。
- 引擎 `npm run typecheck`、`npm run build`：通过。
- 最终客户端相关组合：**138 passed / 0 failed / 0 skipped**（28.8 秒）。包括真实引擎浏览器 3 条、远端浏览器 11 条、快照解析 96 条、工具图片 UI 7 条、工具结果解析 21 条。
- 远端浏览器专项重复 3 轮：**33 passed / 0 failed / 0 skipped**（31.3 秒），包括截图期间目标移动、滚动、操作后导航及 AX 读取故障注入，均验证点击实际次数不增加。
- 引擎 8 个相关 spec：**154 passed / 0 failed**。覆盖图片预算、显示/模型输入分离、持久化字段、流恢复、子任务概要和原有原生图片协议。
- 真实窗口验证图片实际解码及 SVG 中的像素，保存的截图来自历史工具结果；刷新后不重新执行工具。并验证损坏图片回退、弹窗与坐标一致。

开发过程中发现的导航失败已修复并通过稳定故障注入回归。测试另修正两处等待/数据来源问题：原生浏览器遮挡需等动画帧和 IPC 完成；展示图片应与持久化历史比对，不能与已经去除图片编码的模型输入比对。文案断言也更新为“点击前画面”。没有绕过失败断言或取消必要校验。

日志位于 `.e2e-tmp/browser-position-image-typecheck.log`、`browser-position-image-build.log`、`browser-position-image-engine-typecheck.log`、`browser-position-image-engine-build.log`、`browser-position-image-engine-tests.log`、`browser-position-image-final-verification.log` 和 `browser-position-image-browser-repeat.log`。效果截图为 `.e2e-tmp/browser-position-image-preview.png` 与 `.e2e-tmp/browser-position-image-click-preview.png`。

客户端和引擎都需要使用本轮构建并重启，随后新生成的记录才会包含截图。远端引擎也需要更新；本轮未部署远端或重启用户现有实例。上述结果为相关功能回归，不代表全项目测试或长期运行认证。

## 后续：移除前端元素展示（2026-10-10）

按用户确认，从前端移除“页面元素”列表、元素数量及额外的“元素位置”图，清理对应组件和样式。点击结果只显示实际点击前截图与点击标记；其他页面快照显示可放大的纯截图。原始数据仍默认折叠，后台采集、模型定位及历史中的元素数据保持不变，刷新历史也不会恢复已移除的区域。

`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。最终串行运行 `browser-agent-ui.spec.ts` 和 `tool-result-images-ui.spec.ts`：**10 passed / 0 failed / 0 skipped**（19.6 秒）。真实窗口核对了首次展示与历史刷新、纯截图放大、点击标记及图片像素，并验证模型输入和持久化历史仍有一致的元素数据。已有图片、子代理图片和损坏截图降级回归通过。

日志：`.e2e-tmp/browser-elements-hidden-typecheck.log`、`.e2e-tmp/browser-elements-hidden-build.log`、`.e2e-tmp/browser-elements-hidden-verification.log`。效果截图：`.e2e-tmp/browser-elements-hidden-preview.png`。本轮仅修改客户端显示，无需更新引擎。
