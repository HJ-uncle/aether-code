# Code 模式与公共页面性能优化记录

日期：2026-10-12。本文补充 [Work 模式调研报告](D:/dev/aether-code/docs/work-performance-investigation-2026-10-12.md)，覆盖公共图形与日志策略、Code 分栏和消息渲染边界，并列出浏览器与设置页的后续工作。原始测量、排除样本、构建完整性与逐项回归记录汇总于 [验证证据 JSON](D:/dev/aether-code/docs/code-performance-verification-evidence-2026-10-12.json)。

## 1. 当前可以确认的结论

毛玻璃会影响整个 Electron 宿主的合成成本，影响大小取决于硬件加速、过滤面积、层数和更新频率。此前 Work 设置弹窗的实机对照已确认软件合成叠加大面积、嵌套过滤会显著延迟调度；该结论和数字见 Work 报告。公共材质策略已经覆盖 Code、设置和浏览器工具栏，不能把它描述为只优化 Work。

Code 专项改动前的有效基线已经使用软件渲染与 `solid` 材质：16 次设置切换的 click→第二次 rAF 代理 P95 为 **29.9ms**，未出现大于 34ms 的 rAF 间隔或 Renderer Long Task。因此，本轮数据没有显示该空白 Code 设置场景仍存在 Work 原始弹窗那样的卡顿。

同一基线中，侧栏和右侧对话面板每次 60 步拖动均触发 **60 次同步布局写入**。源码确认每步更新全局布局、序列化并通知所有布局消费者，属于可消除的放大路径。本轮改为局部 rAF 预览、松手一次提交，实测两种拖动均为拖动中 **0 次**、全程 **1 次**写入，减少 **98.3%**。优化前后拖动 rAF P95 均约 16.7–16.8ms，说明这台高性能机器上的空白场景原本已接近 60Hz；此次可确认的是消除反复同步写入及相应发布路径，**没有证明 FPS 提升，也没有证明它是用户 Code 卡顿的现场根因**。

Code 消息组件还补齐了稳定 props、文件上下文和派生对象引用。这有助于现有 `memo` 避免重渲染历史消息，但本轮没有在长历史和高频 SSE 下测量 React commit 或呈现收益。浏览器后台节流、隐藏消息投影和 Markdown 算法属于后续范围。

## 2. 测量版本与证据归属

### 2.1 有效的 Code 专项改动前基线

证据：[code-performance-before-6ad4ed7a-dda1-423b-9407-b6334ea937e3.json](D:/dev/aether-code/.e2e-tmp/code-performance-before-6ad4ed7a-dda1-423b-9407-b6334ea937e3.json)。生成时间 `2026-10-12T05:54:51.874Z`。

输入构建目录为 `D:\dev\aether-code\.ae\soak\real-20261012\frozen-app-20261012c`。该构建保留旧版 Code `Resizer`，但已含此前公共图形/材质等改动；这是 **Code 专项改动前** 的基线，不是整个性能优化项目的原始版本。

| 产物 | SHA256 |
|---|---|
| `out/main/index.js` | `9c232db7c07418be4ccd34d32ef0ba320a53028d4b811a3e9fecf2c4fe1b6d79` |
| `out/preload/index.js` | `76d800def489ff8d4454cf3bff7d9cbdeb94a0de08a1d243bc34aa3d8c051341` |
| `out/renderer/index.html` | `4a863f4883a4501332f0fcd1a64d8f4d5dbee8b674afaea46a3b065a0054bd1f` |
| `out/renderer/assets/index-C3NRpL0o.js` | `2f58d6e72a2045a92f4c95a551545a479a2ac6f86c5f0ccebf674ca490efffe1` |
| `out/renderer/assets/index-ClfWOwI6.css` | `22de0c669cf4d65a51da5434879f6f56ad5b6e1c105d2ebbd36c0b44dc529778` |

### 2.2 保留但排除的版本失配样本

证据：[code-performance-before-1ecb35d7-bc97-4fd4-bee7-c3a3b9205f72.json](D:/dev/aether-code/.e2e-tmp/code-performance-before-1ecb35d7-bc97-4fd4-bee7-c3a3b9205f72.json)。生成时间 `2026-10-12T05:46:58.702Z`。

该报告名称标为 `before`，实际从共享 `out/` 复制到的 renderer 已包含新版 `Resizer`：`index-CW_TP8BH.js` SHA256 为 `9755673609e14ae06e6bd1d4d6c989de0013ac3bc8eec186e0b682a0a6db16a4`，两次拖动均为拖动中 0 次、全程 1 次布局写入。它的 `passed: true` 只说明探针交互与进程健康检查通过，不能证明“修改前”归属正确。

原因是共享工作树被其他工作重建。该报告保留原名称和全部原始记录，**排除于修改前/后收益计算**；也不把它重新命名为正式 `after`。探针已增加 `--build-root=<绝对路径>`，将输入路径写入 `buildInput`，复制为独立快照后记录哈希，再运行。

### 2.3 已测的新版冻结构建

新版 `npm run build` 已通过，输入目录为 `D:\dev\aether-code\.e2e-tmp\code-frozen-20261012`。冻结清单：[manifest.json](D:/dev/aether-code/.e2e-tmp/code-frozen-20261012/manifest.json)，生成时间 `2026-10-12T05:57:52.525Z`，同时记录源码、测试与产物哈希。

E2E 在共享工作树加载同一份 `out/` 运行，测试结束后校验其与冻结产物完全一致。Playwright teardown 声明和浏览器窗口准备在冻结后修正；清单中的测试文件是冻结时版本，最终执行测试源的哈希见验证 JSON 的 `integrity.testSources`，不可混用。

| 产物 | SHA256 |
|---|---|
| `out/main/index.js` | `9c232db7c07418be4ccd34d32ef0ba320a53028d4b811a3e9fecf2c4fe1b6d79` |
| `out/preload/index.js` | `76d800def489ff8d4454cf3bff7d9cbdeb94a0de08a1d243bc34aa3d8c051341` |
| `out/renderer/index.html` | `6a2bfcfd60167e56e98e364dd56205c13a62235f0eca5e948029b9cf6351333b` |
| `out/renderer/assets/index-BMgiPmgB.js` | `0870f3cdf14b986a4d0881b2eef708c36db8c53d36758e454cb203b28844b7bf` |
| `out/renderer/assets/index-BtLeFw66.css` | `e747321f5380feedc79e7f89a9d38f161172e9cab8eaca02600c9369c1d35064` |

优化后证据：[code-performance-after-d05ba70f-3563-4426-bc53-79fce6758c33.json](D:/dev/aether-code/.e2e-tmp/code-performance-after-d05ba70f-3563-4426-bc53-79fce6758c33.json)，生成时间 `2026-10-12T06:04:43.224Z`。它的 `buildInput` 与上述目录一致，所有主探针产物哈希匹配。汇总证据在 `2026-10-12T06:06:34.486Z` 另校验了 107 个冻结 `out/` 文件，并保留完整清单。`unchangedSharedOutput` 仅表示该时间点的完整性检查通过，不代表之后当前工作树的 `out/`；测量归属以各报告的冻结来源和哈希为准。

有效旧、新构建的 main/preload 哈希相同，renderer 与样式不同。两版还有并行工作的其他 renderer 源码变化，新版同时包含 Code 分栏和消息边界改动，不能用设置总延迟差异分别归因每一个改动；单一模块归因需要单变量实验或组件级观测。

## 3. Code 实测结果

机器为 Windows `10.0.26300`、i9-14900KF、32 逻辑核、128GiB 内存；Electron `39.8.10`、Chromium `142.0.7444.265`、Node `22.22.1`。窗口内部尺寸为 1800×1200 CSS px，DPR 1.5。探针确认 `document.hasFocus() === true`、页面可见、Code tab 激活。

隔离设置为 `graphicsMode: software`、`autoStartEngine: false`、浅色；清除继承的 `AETHER_ENABLE_GPU` 和 `ELECTRON_RUN_AS_NODE`。实际 GPU 状态为 `hardwareAcceleration: false`、`gpuCompositing: disabled_software`、无环境覆盖，材质档位为 `solid`。

| 观察项 | 有效旧版基线 | 新版结果 |
|---|---:|---|
| 设置导航点击数 | 16 | 16 |
| click→第二次 rAF P50 / P95 | 28.4 / 29.9ms | 28.0 / 29.6ms |
| 设置段 rAF P95 / >34ms 间隔 | 16.8ms / 0 | 16.8ms / 0 |
| 设置段 Long Task | 0 | 0 |
| 侧栏：60 步拖动中 / 全程布局写入 | 60 / 60 | 0 / 1 |
| 右对话面板：60 步拖动中 / 全程布局写入 | 60 / 60 | 0 / 1 |
| 侧栏 / 右对话面板拖动 rAF P95 | 16.7 / 16.8ms | 16.8 / 16.8ms |
| 拖动段 >34ms 间隔 / Long Task | 两种拖动均 0 / 0 | 两种拖动均 0 / 0 |
| 单次同步 `setItem` P95，两种拖动 | 约 0.1ms | 约 0.1ms（每段只有一次写入） |
| 侧栏最终宽度 | 280→400px，落盘一致 | 280→400px，落盘一致 |
| 右对话面板最终宽度 | 380→500px，落盘一致 | 380→500px，落盘一致 |
| Code→Work→Code | 同 DOM、同设置分区、同布局和尺寸；隐藏 Code inert | 同 DOM、同设置分区、同布局和尺寸；隐藏 Code inert |
| pageerror / native failure / 实际退出 | 0 / 0 / code 0、signal null | 0 / 0 / code 0、signal null |

这里的 P95 算法为排序后 `floor(n×0.95)` 对应项，16 次点击时实际取最大样本。原始每次点击、rAF、Event Timing、Long Task、存储写入及尺寸都保存在 JSON 中。29.9→29.6ms 的差别很小，只有一轮且包含其他 renderer 改动，不认为是显著点击优化收益。

两轮原始 stderr 均含 node-pty 的 `AttachConsole failed` 环境诊断，已经保留；这里的健康通过指 pageerror 为 0、未捕获原生崩溃信号、Electron 实际 exit 0，并非日志完全无报错，也不验证本机 shell 可正常启动。

### 测量边界

- click→第二次 rAF 从 DOM click 捕获阶段开始，不包含 Playwright 等待元素可操作或输入派发之前的时间；它是调度代理，**不是 INP，也不确认屏幕实际呈现**。
- Event Timing 使用 16ms 阈值，可能包含一次点击链中的多个鼠标事件，事件数不是独立点击数。未观测到 Long Task 也不能排除短 JS 工作、布局、栅格或合成瓶颈。
- `setItem` 计时仅覆盖同步存储调用，不包含调用前的 `JSON.stringify`、订阅广播、React commit 与后续绘制。0.1ms 的单次值说明本机小状态的写盘调用很短，不能把所有成本归于磁盘。
- 60 步是固定 Playwright 输入序列，报告另记实际收到的 pointermove 数。本轮不是用户高速拖动、低配 CPU、长历史或复杂浏览器页面的压力实验。
- 没有引擎、真实工作区、会话历史或 guest 网页；设置无需打开弹窗。这些结果不能推导 Monaco 首次打开、终端输入、SSE 长对话、浏览器页面本身都已流畅。
- 每个有效构建目前只有一轮。稳定 P95 和放量决策需要重复 warm/cold 场景、数百次交互、多硬件、固定负载，并结合 Chrome trace 的 raster/compositor/present 观测。

## 4. 已实现的范围

下表描述当前源码和冻结清单中已实现的行为，功能回归状态见第 6 节。除第 3 节的有效旧版观察之外，不将结构改进直接表述为已测得的速度提升。

| 作用域 | 当前行为 | 准确源码入口 |
|---|---|---|
| 全应用 Chromium 图形启动 | ready 前配置图形路径；显式软件策略保留 Windows 兼容路径；GPU 实际能力与故障恢复独立记录 | [index.ts:16](D:/dev/aether-code/src/main/index.ts:16)、[graphics.ts:58](D:/dev/aether-code/src/main/graphics.ts:58)、[graphics.ts:97](D:/dev/aether-code/src/main/graphics.ts:97) |
| 全应用宿主材质 | `<html>` 上统一档位；软件/系统低透明度降为 solid；大遮罩和设置嵌套表面取消过滤；Code 与浏览器工具栏、资源浮层在策略中 | [main.tsx:8](D:/dev/aether-code/src/renderer/src/main.tsx:8)、[useVisualEffects.ts:43](D:/dev/aether-code/src/renderer/src/core/useVisualEffects.ts:43)、[visual-effects.css:1](D:/dev/aether-code/src/renderer/src/assets/visual-effects.css:1) |
| 全应用日志传输 | 主进程普通流量 100ms 批次；达到条数/字符预算提前 flush；renderer 使用有界 ring 和稳定 ID | [ipc.ts:124](D:/dev/aether-code/src/main/ipc.ts:124)、[log-batch.ts:7](D:/dev/aether-code/src/main/engine/log-batch.ts:7)、[log-buffer.ts:14](D:/dev/aether-code/src/renderer/src/core/engine/log-buffer.ts:14) |
| 全应用 React 日志边界 | 日志移出 engine 生命周期返回对象与 AppContext 更新路径；应用拥有日志采集，输出页只拥有显示订阅 | [useEngine.ts:24](D:/dev/aether-code/src/renderer/src/core/engine/useEngine.ts:24)、[log-store.ts:12](D:/dev/aether-code/src/renderer/src/core/engine/log-store.ts:12) |
| Code 输出面板 | 只有 Code 可见、输出 panel 激活、document 可见时订阅日志；隐藏时冻结呈现快照、保留日志缓存与滚动 DOM | [OutputView.tsx:8](D:/dev/aether-code/src/renderer/src/contrib/output/OutputView.tsx:8)、[log-store.ts:42](D:/dev/aether-code/src/renderer/src/core/engine/log-store.ts:42) |
| Code 工作台分栏 | rAF 修改目标区域的局部 width/height；pointerup 提交一次最终布局；取消还原，不写旧预览；保留 separator 语义、键盘调整与边界 | [Resizer.tsx:47](D:/dev/aether-code/src/renderer/src/workbench/Resizer.tsx:47)、[Resizer.tsx:55](D:/dev/aether-code/src/renderer/src/workbench/Resizer.tsx:55)、[Workbench.tsx:93](D:/dev/aether-code/src/renderer/src/workbench/Workbench.tsx:93) |
| Code 消息渲染边界 | 历史消息操作回调、usage 和文件上下文引用稳定，使现有 `MessageItem`/`Markdown` memo 生效；点击仍读取最新已提交权限和会话，异步来源守卫保留 | [ChatView.tsx:71](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:71)、[ChatView.tsx:486](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:486)、[ChatView.tsx:2448](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:2448) |
| Code Monaco 冲突扫描 | 全文冲突扫描合入已有 100ms 内容变更计时器，连续输入先取消旧排期；初始扫描、键盘实时扫描、操作前模型版本校验和卸载清理保留 | [source-git-features.ts:328](D:/dev/aether-code/src/renderer/src/core/editor/source-git-features.ts:328)、[source-git-features.ts:284](D:/dev/aether-code/src/renderer/src/core/editor/source-git-features.ts:284) |
| 公共弹出层 | Popover 属性观察缩到锚点祖先，避免全页面属性变化反复触发位置同步；相关滚动和尺寸监听保留 | [Popover.tsx:164](D:/dev/aether-code/src/renderer/src/workbench/Popover.tsx:164) |

图形启动策略作用于 Electron Chromium 进程，公共 CSS 只覆盖 IDE 宿主界面。它不会改写 guest 网页的 JS、DOM、canvas 或 CSS。软件回退下取消宿主毛玻璃也不能保证任意网站不卡。

分栏取消处理包含 Escape、pointercancel、lost capture、窗口 blur、切换 Work、布局外部重置与卸载。实现还保留 `role="separator"`，使原生浏览器在拖动过程中隐藏、结束后重新匹配最终尺寸的现有协调逻辑继续工作。

## 5. 已审查但尚未实施或未定量测量

| 候选热点 | 当前已存在的保护 | 尚未实施的优化与验证 |
|---|---|---|
| 隐藏 native 浏览器标签仍不节流：[service.ts:165](D:/dev/aether-code/src/main/browser/service.ts:165) | 页面有独立 WebContentsView，AI 工具依赖真实页面持续工作 | 按“可见 / AI 任务拥有 / 空闲”分类暂停非必要定时器或调整节流；先测 CPU 与自动化语义，不能统一打开后台节流 |
| Console inspector 1500ms 全量读取：[BrowserView.tsx:242](D:/dev/aether-code/src/renderer/src/contrib/browser/BrowserView.tsx:242)；主进程克隆快照：[service.ts:626](D:/dev/aether-code/src/main/browser/service.ts:626) | console 容量已有上限，卸载时停止 timer，迟到数据有 alive 检查 | 可见性门控、请求互斥/取消、按 id 增量；先记录轮询条数/字节与 commit 数 |
| Network inspector 1500ms 轮询：[NetworkInspector.tsx:125](D:/dev/aether-code/src/renderer/src/contrib/browser/NetworkInspector.tsx:125) | 已有 reading 防重入、50 行分页，导航清旧结果；不是无限历史列表 | 补 Code/Work 模式和窗口可见性门控；评估增量事件，不重复建设已有分页或读锁 |
| 浏览器区域与遮挡检测：[BrowserView.tsx:138](D:/dev/aether-code/src/renderer/src/contrib/browser/BrowserView.tsx:138) | 已有一帧合并、同 bounds key IPC 去重、非当前模式提前返回、ResizeObserver | body subtree MutationObserver 的通知/扫描成本仍需 trace；先测回调频率再收窄观测范围 |
| 设置只需 browser settings 却订阅整个 browser store：[AppSettingsView.tsx:226](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:226)、[browser-store.ts:33](D:/dev/aether-code/src/renderer/src/contrib/browser/browser-store.ts:33) | 设置仅渲染当前分区，查询与候选列表已有 useMemo | 增加 settings 专用稳定 snapshot/selector，避免导航/loading 事件更新设置；量化变化前后 commit |
| 隐藏 Code/Work 保持 mounted：[ModeSurface.tsx:31](D:/dev/aether-code/src/renderer/src/workbench/ModeSurface.tsx:31) | hidden/inert 已阻止绘制/交互；Output 日志显示订阅已单独冻结 | 其余业务订阅与消息派生仍可能运行；服务继续接收任务事件，UI 投影按可见性冻结/恢复；不能卸载任务 runtime 或终端会话 |
| CodeGraph 进度轮询：[CodeGraphSettingsView.tsx:97](D:/dev/aether-code/src/renderer/src/contrib/settings/CodeGraphSettingsView.tsx:97) | **只在 indexing 时**每 1500ms 轮询，完成与卸载停止；不是常驻全时段开销 | 在索引中补模式隐藏门控和请求互斥；恢复时立即读取最新状态 |
| Code SSE/长消息 | [useChat.ts:303](D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:303) 已 80ms 合并、终态立即 flush；历史已有分段显示；[Markdown.tsx:376](D:/dev/aether-code/src/renderer/src/contrib/chat/Markdown.tsx:376) 有词法缓存、组件 memo 和代码高亮 useMemo | 隐藏投影尚未冻结，Markdown 解析/高亮策略本轮未改；先测活跃消息 vs 历史消息 commit，考虑消息 store、长结果摘要和预算化高亮 |
| 文件树和搜索 | 文件树已按视口及缓冲行窗口化；搜索已有 300ms 防抖、迟到结果隔离和 500 条显示上限 | 大工程文件服务与搜索主进程仍需测量；显示上限不等于底层 IO/输出有界，后续考虑流式限额与请求取消 |
| 终端、Monaco、LSP | xterm 依赖已暂停不可见绘制，并分时间片处理写入；Monaco 已使用 ResizeObserver 自动布局；真实窗口 E2E 覆盖部分正确性 | 高输出率 PTY 流控、打开大文件、多个模型和诊断响应仍待专项性能曲线。远端 PTY 尺寸夹具回归不等于本机 ConPTY 吞吐验收 |

这些候选项是源码风险路径，不是用户现场卡顿的已证实比例。记录实际 CPU、事件循环、IPC payload、React commit 与 Chrome trace 后，再确定优先级。

## 6. 功能验证记录

`npm run typecheck`、`npm run build`（含 node/web typecheck）、分栏/新增用例/探针的定向 ESLint 和范围内 `git diff --check` 已通过，并冻结新版构建。更广范围的 lint 仍有 `ChatView` 原有 purity/refs/set-state-in-effect 与 `Workbench` 原有 set-state-in-effect 报错，详情写在汇总证据；**不声称全项目 lint 通过**。测试保持 `workers: 1`，Electron 窗口和性能探针串行运行。

首轮 Code 定向回归覆盖 12 个 spec、53 个用例：**51 passed、1 failed、1 后续用例未运行**。原始 JSON：[code-regression-first.json](D:/dev/aether-code/.e2e-tmp/code-regression-first.json)；失败现场与附件保留于 `D:\dev\aether-code\.e2e-tmp\code-regression-first-results`。Reporter 的 skipped 数为 1，该项是前置失败后的未运行，不能当作环境能力 skip。

失败为新增“Code 工作台侧栏拖动及取消后，原生网页重新匹配最终区域”用例：前序用例留下 125% 工作台缩放与 1400px 窗口，CSS `max-width:1280px` 的设置页规则按缩放后的 viewport 隐藏侧栏，导致 separator 不可见、boundingBox 等待超时。`app-errors` 为空，原生健康记录 nativeEvents 0。修正只恢复测试准备的 zoom 1 与 1800×1200 窗口，browser-surface 4 条补跑均通过，不修改产品侧栏策略。

随后 `subagent-lifecycle` 3 条补跑通过，涵盖真实引擎/IPC 生命周期与消息多选、Markdown 导出正确性。按文件/用例标题合并，最终为 **13 个 spec、56 个唯一用例全部通过，其中 48 个真实 Electron 用例、8 个纯函数用例**。首轮失败记录仍保留；这里的结论是最后一次执行的唯一用例覆盖通过，并非同一轮原始报告全绿，也不是全仓库 E2E 通过。

| spec | 最终通过的唯一用例数 |
|---|---:|
| browser-surface-ui | 4 |
| change-revert-ui | 3 |
| chat-artifact-link-ui | 4 |
| chat-recovery-ui | 3 |
| chat-stream-stability-ui | 5 |
| code-workbench-performance | 4 |
| context-usage-ui | 3 |
| editor-groups | 6 |
| editor-source-git-utils（纯函数） | 8 |
| editor-source-git | 3 |
| session-usage-ui | 6 |
| terminal-resize | 4 |
| subagent-lifecycle | 3 |

补跑原始记录：[code-browser-recheck.json](D:/dev/aether-code/.e2e-tmp/code-browser-recheck.json)、[code-selection-recheck.json](D:/dev/aether-code/.e2e-tmp/code-selection-recheck.json)。证据汇总含每个用例的最终状态和原始报告哈希，避免把重跑重复项计入总数。

这些用例验证分栏、取消/重载、原生浏览器、聊天、编辑器、用量和终端边界等正确性，不构成这些页面的性能验收。有效 before/after 探针均通过交互与健康检查，临时 profile 和复制构建已安全清理，来源与哈希见第 2 节。

## 7. 企业级后续方案与验收

### 第一阶段：稳定当前收益与证据

新版冻结构建的 `after` 探针与最终 56 个唯一用例回归已经完成。分栏的结构目标为拖动中不发布全局布局、不写 `aether.ide.layout`，成功结束一次提交；取消不持久化预览，重启保留最终尺寸，原生浏览器准确恢复。本轮探针与定向用例已覆盖这些行为；下一步是固定负载和多硬件的长期观察，确认在复杂页面与低配环境中的收益和兼容性。

图形与材质单独灰度，软件兼容入口保留，系统低透明度覆盖所有宿主浮层。启动恢复区分“确认 GPU 故障”与“疑似中断”，收集结构化能力/崩溃数据，避免把所有异常退出当作显卡故障。已有 Windows 老配置兼容迁移不改变为强制硬件路径。

### 第二阶段：后台与订阅预算

对 Browser inspectors、Settings 和隐藏 Code 消息增加可见性或 selector 边界。任务服务、SSE、命令执行、终端进程继续运行，只暂停不必要的呈现和派生工作；恢复时一次读取最新稳定快照。对异步读加入取消、去重与 source/session/navigation epoch，避免迟到响应覆盖新页面。

对 guest 页面按任务所有权建立后台策略；页面被 AI 使用时保留执行语义，空闲隐藏页才尝试节流。先在动态网页、network capture、AI screenshot/DOM 操作中验证，再逐步放量。

### 第三阶段：长历史与低配硬件

使用固定引擎 fixture 比较 0/100/500 轮消息、1MiB/10MiB 工具结果、50/200 日志每秒、持续流式正文与 4 个后台任务。记录可见/隐藏模式和前台/后台窗口，加入 1080p/高分屏、DPR 1/1.5/2、软件/硬件和材质档位。历史消息按稳定 key 订阅，长列表保留滚动锚点、复制、查找、键盘和无障碍访问；代码块高亮按文本长度、语言与流式状态控制预算。

### 建议预算与发布门槛

以下为后续建议目标，**尚未验收**。正常桌面、同机同刷新率、数百次交互统计 P95；cold 与 warm、host 与 guest 单独汇报。

| 指标 | 建议目标与口径 |
|---|---|
| 常规 Code 输入/导航到呈现 | 实际呈现 P95 ≤50ms，压力场景 ≤100ms；需 trace/呈现观测，不能用本探针的第二次 rAF 替代 |
| 60Hz 拖动 | 帧间隔 P95 ≤20ms，同时报告 >50ms 次数、占比与累计超预算时长 |
| 普通 UI React commit | P95 ≤8ms；输入和日志不触发无变化的已完成历史消息 commit |
| Main 事件循环 | event-loop delay P95 ≤20ms；单独记录 IPC 条数、字节与同步处理时间 |
| 空闲隐藏模式 | 无不必要 inspector 轮询和呈现 commit；后台必要任务继续正确运行 |
| 两小时 soak | 热身后内存无持续线性增长；停止/恢复/重启状态与草稿正确；统计 GPU/Renderer/native helper 退出 |

固定机器基线、生产 profiling 构建和 Chrome trace 先行；诊断包只收数值、版本、hash 与脱敏崩溃信号，不收提示词、文件内容或密钥。发布从内部固定机器开始，再按硬件/驱动/企业策略分组扩大；每阶段可分别回退材质、图形与呈现策略，避免恢复旧版高频同步写入作为唯一整体回滚手段。

## 8. 复现

探针：[code-performance-probe.mjs](D:/dev/aether-code/scripts/code-performance-probe.mjs)。已有构建时使用明确的冻结目录；不要同时运行 build、Electron E2E 或另一性能探针。

```powershell
node scripts/code-performance-probe.mjs --stage=before --build-root=D:\dev\aether-code\.ae\soak\real-20261012\frozen-app-20261012c
node scripts/code-performance-probe.mjs --stage=after --build-root=D:\dev\aether-code\.e2e-tmp\code-frozen-20261012
```

每次写入唯一 `.e2e-tmp/code-performance-{stage}-{UUID}.json`，保留原始数据与构建哈希。探针只使用新建隔离 profile 和复制的 `out/`；递归清理前检查路径为 `.e2e-tmp` 直接子目录且前缀正确，真实用户配置不参与。若 Electron 未确认退出，保留夹具并以失败状态报告，避免删除仍由进程使用的文件。
