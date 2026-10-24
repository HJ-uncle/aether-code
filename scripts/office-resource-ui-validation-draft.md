# Work 资源与 Office UI 验证草稿

> 已退役，仅保留历史设计。执行请使用 `office-resource-ui-validation.md` 和 `office-resource-ui-validation.mjs`；本草稿模块会导入旧提交适配器，不应在 live runner 新加载。

本文件是 root 使用唯一现有 runner 的离线准备，不代表真实 UI 已通过。

## 可先使用的只读入口

`.e2e-tmp/prepare-office-resource-ui-validation.mjs` 导出 `recover(c)`，显式调用才读取现有 runner；导入不做任何事情。它调用 `prepareOfficeResourceUiValidation(c, { samples: [] })`：

- 固定 owned runner / engine / 6 个真实角色身份；6 根终态、严格只读磁盘队列排空、命令队列排空。
- 记录现 Work 任务、资源列表、选中工具、原页面 URL、原窗口 ID 与 WebContents ID、现有 Worker URL。
- 不新开窗口、不读公司文档内容、不操作资源、不启动 HTTP 服务、不发送模型需求。
- 新 UI 必须已经 build 并由 root 刷新。资源 tablist 为 `aria-label="打开的资源"`，工具栏为 `aria-label="工作区工具"`。

## 最终样本与真实 UI hooks

执行骨架 `runOfficeResourceUiValidation` 需要 4 个实际样本，格式各一：`docx / xlsx / pptx / pdf`。每个样本传 `{ kind, role, path, entry }`，路径必须为 campaign/company 内的普通文件；entry 为 `artifact` 或 `conversation`，四样本合起来必须覆盖两种入口。单文件最多 32 MiB、总计最多 64 MiB，只哈希指定文件，不递归扫描公司目录。

必须提供最终版本的以下 hooks，否则触碰 live controller 前就拒绝：

| Hook | 要求 |
| --- | --- |
| `openSampleByUi({page,sample})` | 点击现有成果入口或对话链接，不能直接调用 open-file IPC，也不能把文本注入成伪造对话。 |
| `assertPreview({page,sample,expectedSessionId})` | 等真实渲染标记和尺寸，返回 `ready/sessionId/path` 及可复核的观察值；不要把传入参数原样回填当作观测。 |
| `exercisePdfPages` | 读取初始页、点下一页、等 canvas 的 rendered page 更新，返回 beforePage/afterPage/totalPages。 |
| `exerciseWorkbookPagesAndSheets` | 切实际第二工作表、回到有 101 行以上的表并翻页，返回 beforeSheet/afterSheet/beforeRowStart/afterRowStart/renderedRows/renderedColumns。 |
| `exercisePreviewError` | 实际错误 UI、诊断与释放证据；不得修改公司原文件制造错误。 |
| `exerciseResourceAndSessionSwitching` | 文档→新建内置网页→另一现有会话→返回原会话；核对同级标签、顺序和 session 隔离；通过传入 created Map 登记本测试新建网页，以便清理。 |

Documents agent 当前提供的预览合同（待 root 最终 build 核对）：

- 外层 `[data-document-preview="pdf|docx|xlsx|pptx"]`。
- PDF `canvas[data-document-page="N"][data-rendered-page="N"]`。
- DOCX/PPTX `iframe[data-document-page="N"]`，`sandbox=""` 与 `srcdoc`。
- XLSX `[data-document-sheet="0"][data-document-row-start="1|101..."]`、`[data-document-column-range]`。
- 工作表 select 的 aria-label 为 `工作表`；页码 input 为 `页码`；按钮 `上一页 / 下一页 / 上一组列 / 下一组列`。
- 新 Worker 名为 `aether-document-pdf / aether-document-spreadsheet`，隐藏组件卸载并 terminate。脚本使用现 Playwright page 的 worker/close 事件独立记录生命周期，不建立额外 CDP/Inspector 连接。

运行时 session/file 的证据需要从真实 DOM descriptor 或现组件 controller 读出；若只有静态鉴权代码与测试，不要宣称抓到了实际 IPC 鉴权调用。

## 执行骨架的恢复边界：还需 root 收口后才可执行

骨架捕获截图与 JSON、原 SHA 前后，记录创建资源，恢复原会话/资源/工作区工具，并重新核对窗口、6 根 runId、队列 SHA 与引擎身份。submit/createAndStart/selectTask 在测试期间受独占 guard 保护。

当前 `runOfficeResourceUiValidation` **仍是草稿，不要直接用于 live**：

1. 接入最终 DOM 断言以及 4 个实际样本，确保 PDF 多页和 XLSX 多表、101 行以上，不以返回布尔值替代观察。
2. 为错误场景和文档→网页→会话完整切换加入最终 UI 断言。
3. 把 timeout 后持有 guard 的显式恢复入口与测试收口。目前骨架只记录 `needs-reconciliation`，不会在未知迟到操作期间盲目恢复。
4. 将资源登记移动至点击后立即执行，并覆盖点击部分成功/预览失败的清理；恢复应核对各个访问会话的原标签，不能误关已存在的用户资源。
5. 最终结果写入失败时也要保留可查询恢复状态。当前骨架是预备实现，不能据此声称端到端覆盖完成。

初始离线验证：4 项契约/读取完整字节/拒绝越界测试通过，两个 JS 文件 `node --check` 通过。没有执行 live、没有修改公司原件，也没有修改现有 harness 核心。
