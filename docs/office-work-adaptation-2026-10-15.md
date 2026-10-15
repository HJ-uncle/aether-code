# Work 办公 Skill 与文档交付适配记录

日期：2026-10-15（Asia/Shanghai）。本轮范围是 Word/Excel 的统一办公入口、可靠生成与定点编辑，以及 Work 成果原文件交付。已完成当前配套构建、定向检查和真实 Electron Work 链路验收。

## 参考来源与适配选择

参考了 `D:\web\wuzu-client` 当前未提交的办公相关变更，主要是 `lobster-core/SKILLs/wuzu-office-routing`、`wuzu-doc-writer`、`wuzu-sheet`，以及对应办公提示词调整。参考对象是该工作区的当前实现，不能据此宣称已获得其生产验收或长期稳定性证明。

保留的有效设计是：办公任务有统一入口；Word 按周报、会议纪要、通知、方案等文体安排内容；已有文件先读后改；表格显式区分文本、数字、日期和百分比，保留编码前导零；导出失败如实说明，真实文件生成后才提供交付回执。用户素材不足时标注待补，不编造事实和数据。

执行方式针对 Aether 重做，未直接照搬 Python 脚本：

- Aether 已有 Node 运行时及 `docx`、`exceljs`、`fflate` 依赖，但安装包不保证宿主 Python、Bash、pip 或首次联网安装能力。
- 现有 `run_skill_script` 的工作目录是技能根目录，严格绑定路径只允许单条脚本调用。Wuzu 的相对路径、heredoc 和输出到 cwd 假设不能直接成立。
- 办公脚本自行写盘不会自然产生现有 ChangeStore 回执，容易出现“文件已写但 Work 成果缺失”，也不能复用统一版本保护。
- 通过统一 Node 原生 `office_document` 工具，将生成、结构检查、文件锁、版本检查、发布和改动记录放进同一条执行路径。已有办公读取能力继续保留。

## 统一入口与工具选择

内置 [`aether-office`](../../ai-agent-engine/src/skills/builtin/aether-office/SKILL.md) 是自包含技能，不依赖另一个办公技能才能完成任务。Word 与 Excel 的细节通过 `get_skill` 的 `resource` 参数按需读取：

- [`references/documents.md`](../../ai-agent-engine/src/skills/builtin/aether-office/references/documents.md)：文体、结构、Markdown 创建、精确文本替换和交付核对。
- [`references/spreadsheets.md`](../../ai-agent-engine/src/skills/builtin/aether-office/references/spreadsheets.md)：列类型、显式公式、创建与定点编辑、缓存状态与限制。

引用读取仅允许所选技能目录内的 `references/*.md` 普通文件，校验真实路径，限制为 128 KiB。内联说明不能冒充本地资源目录。内置技能资源随引擎构建进入 `dist/skills/builtin`，不要求另装 Python 运行时。

[`office-prompt.ts`](../../ai-agent-engine/src/core/office-prompt.ts) 只在本次 general 工具注册表确实提供 `office_document` 时注入办公能力；技能被过滤或 `get_skill` 不可用时，不承诺读取不存在的指南。办公工具属于 general/Work 能力，保持串行调度；Code profile 不自动增加此工具。

旧 `write_file` 继续提供兼容写入，但已移除“报告强制 DOCX”“万能美化”等抢占式描述。有可用的 `office_document` 时，Word/Excel 优先走版本保护和结构化办公路径。用户已经要求生成或修改时，不额外等待一次“确认导出”。

## DOCX：真实结构与有限范围编辑

实现位置：[`src/tools/office/docx.ts`](../../ai-agent-engine/src/tools/office/docx.ts)。

创建使用真实 DOCX 包，支持 Markdown 标题、段落、基础行内强调、真实编号/项目列表及简单表格。提供 A4 页面、中文正文和标题字体设置、分级标题、行距、表格格式及页脚页码。`title` 可选，作为独立可见标题及文档属性；不需要与 Markdown 首标题重复。

编辑使用 `oldText/newText` 精确替换。每个原文片段必须在正文中唯一，所有编辑基于同一原始版本，拒绝歧义、未命中、重叠和跨段落替换。可以跨同一段落内因样式切分的文本节点定位；插入文字继承匹配起始节点的样式。只修改主文档中的目标文本，不用抽取纯文本后全文重建的方式宣称保留格式。

未修改的 ZIP parts 保持内容字节；测试覆盖图片、页眉页脚和样式 parts 的保留。涉及字段、修订、超链接、内容控件、图片或不支持文本边界的目标段落会拒绝编辑。检查器提供正文、段落/表格/图片等摘要，并对字段缓存、修订和图片未做视觉核验等情况给出警告。它不接受或拒绝修订，不编辑页眉页脚正文，不提供任意复杂图文排版。

## XLSX：类型、公式与局部修改

实现位置：[`src/tools/office/xlsx.ts`](../../ai-agent-engine/src/tools/office/xlsx.ts)。

新建工作簿显式定义 sheet、列头、列 key、列类型和数据行，提供表头样式、冻结首行、筛选、边框与交替背景、列宽、数字格式和打印设置。编号等文本保留 `00123`；日期列使用有效 ISO 日期；百分比支持小数或明确的百分数字符串。对列定义、未知 key、非法日期/数值、工作表命名、行列数量、文本和总单元格数量设限。

普通字符串 `"=SUM(B2:B3)"` 保持文本。公式需要显式 `{ "formula": "SUM(B2:B3)" }`，用户提供的普通文本不会自动提升为公式。

本地仅尝试计算同表简单引用的 `SUM/AVERAGE/MIN/MAX/COUNT`，有循环与计算预算保护。复杂、跨表、循环或超出预算的公式保留公式表达式，清除旧缓存，通过 `pendingFormulas` 和 warnings 显示待重算，不能当作结果 0。编辑后对公式缓存重新处理，设置自动/完整重算，并清除过期 calcChain 及相关关系。文件原有缓存与独立验证的当前结果是不同事实。

已有工作簿使用原 OOXML 包局部 patch，不做 ExcelJS 全包 roundtrip。目标以外的非计算 parts、单元格及样式按实际实现保留；公式缓存和计算属性可能因依赖更新而变化。拒绝合并区域从属单元格、共享/数组公式区域、目标富数据元信息，以及含结构化表格或数据透视的目标工作表。复杂对象 parts 被保留不代表图表或外部数据缓存已刷新。

inspect 对整体及长单元格预览设限，明确给出截断标记和警告；实际文件不因此截断。预览不足以证明模型读完全文或核对了整本工作簿。

## 版本、发布与成果回执

统一入口：[`src/tools/office/index.ts`](../../ai-agent-engine/src/tools/office/index.ts)。

`inspect` 返回真实内容摘要与完整文件字节的 `expectedHash`。`create` 必须传 `expectedHash="missing"`；`edit` 必须使用同文件最近一次工具返回的 `sha256` 版本，不允许猜 hash 或盲目覆盖。

执行时校验工作区路径，在规范化路径的共享文件锁内读取原版本；先在内存生成并重新检查输出，再创建目标目录内的自有临时目录。发布前重新核对工作区、路径及文件版本。新文件通过硬链接提供 create-only 发布，已有文件使用同目录 rename 替换；没有通过完整检查或执行已取消时，不发布半个文件。ZIP 层同时检查路径、重复 entry、CRC、声明大小及实际解压上限，并拒绝不支持的签名、DTD 等输入。

这套机制协调引擎进程内遵守同一锁的写入。已有文件的“最后检查后 rename”不是操作系统提供的跨进程 compare-and-swap，不能声称绝对阻止任意外部程序在最后窗口修改目标。

发布后写入 ChangeStore，产生现有 Work 成果可识别的真实 `write` change、完整字节 hash 和二进制撤回快照。生成或校验失败与“文件已发布但改动记录保存失败”分别报告；后一种明确标记 `fileMutationApplied=true`，不会以失败状态掩盖实际写入，也不会虚构可撤回性。回执区分 `validation="structure-checked"` 与 `visualValidation="not-performed"`。

## Work 原文件下载

客户端新增 [`save-workspace-file.ts`](../src/main/engine/save-workspace-file.ts) 和 [`workspace-download.ts`](../src/main/engine/workspace-download.ts)，通过窄 IPC 在主进程完成认证下载。原生保存对话框授权一个实际目标文件，渲染层不能自行传入任意本地保存路径；凭证和二进制字节保留在主进程。

下载保留原引擎/账号/实例身份及 session 工作区绑定，开始和传输结束均核对；拒绝路径穿越和迟到的旧连接，关闭所属窗口或引擎连接失效时取消。数据流写入同目录临时文件，限制 50 MiB，检查声明长度，计算实际 SHA256；核对身份、绑定和另存目标未变化后才发布。新目标只创建，已有目标在最终检查后替换；仍存在与任意外部进程竞态的系统边界，不把进程内最后检查称为全局文件锁。

[`WorkArtifactPanel.tsx`](../src/renderer/src/contrib/work/WorkArtifactPanel.tsx) 对 DOCX/XLSX 等二进制显示“下载原文件”，不再用文本 Blob 代替原始 Office 字节。未提供原版式预览时正常解释能力范围，不显示为文件损坏；可继续将真实文件引用到对话。文本片段与历史回执的下载语义保持可区分。

## 验证记录

引擎定向检查 **167 项通过**，客户端 **10 项通过**（9 项合同检查、1 项真实 Electron Work 验收），另有独立 Agent 按 Skill 原样示例生成 DOCX 的前向验收通过。此集合覆盖办公格式、版本与发布边界、技能资源/工具权限和原文件交付，不代表完整历史 E2E 基线或外部模型成功率。

| 项目 | 当前记录 |
| --- | --- |
| 引擎定向检查 | 12 个 Vitest 文件，167 passed，0 failed；最终使用单 worker 避免 Windows 转译临时缓存 EBUSY |
| 引擎/客户端 typecheck 与 build | 两个仓库均通过；最终引擎 buildId 为 `sha256:2e1f1da5316f9d24661141668519b18ebf5a387e9d57dd5ce657b72b54a96afa` |
| 受控模型 + 真实 Electron Work 链路 | 通过：隔离数据库模型、Skill 及 references、Word/Excel 创建与编辑、成果展示、原文件另存；11 次受控模型请求 |
| 原文件下载、身份/工作区变化、取消与目标竞争 | 通过：4 项真实 HTTP 合同测试；真窗口还验证路径穿越拒绝、旧实例拒绝和保存对话框取消 |
| 下载文件独立重开 | mammoth 核对 Word 更新文字及单标题；ExcelJS 核对编码 `00123`、金额 `1200`、比例、真实日期以及 SUM 缓存 `3200` |
| 深浅主题成果区域截图 | 两个格式共 4 张截图已实际查看；二进制能力提示和原文件下载正常，无渲染进程 pageerror |
| 真实外部 LLM 的自由工具选择与内容质量 | 本轮未完成此项验收 |
| Word/Excel/WPS 实际打开、真实分页与视觉排版 | 本轮未完成此项验收 |

[`e2e/office-work-live.spec.ts`](../e2e/office-work-live.spec.ts) 的模型端是**本地受控 OpenAI-compatible SSE 夹具**，模型记录写入隔离测试数据库。客户端、预加载/IPC、内置引擎执行、文件生成/编辑、Work 成果和原文件另存走实际链路；工具调用序列由夹具固定。这验证链路合同与页面交互，不能证明真实外部 LLM 会自主选择正确技能、遵循写作指南或稳定产出高质量内容。不得将其表述为生产数据库模型的一轮外部真实会话。

[`e2e/office-download-contract.spec.ts`](../e2e/office-download-contract.spec.ts) 使用真实本地流式 HTTP 对端，覆盖原始二进制一致性、中文路径、大小/hash、绑定与身份变化、取消、大小超限和另存目标竞争；它与真实窗口验收相互补充。

本轮验收产物保存在 `.e2e-tmp/office-acceptance/`，该目录为本机验证证据，不进入版本库：

- [真实中文周报](../.e2e-tmp/office-acceptance/办公验收周报.docx)与[真实预算表](../.e2e-tmp/office-acceptance/办公验收预算.xlsx)：从 Work 原生另存链路取得，与引擎最终文件逐字节一致。
- [链路证据 JSON](../.e2e-tmp/office-acceptance/office-chain-evidence.json)：模型性质、步骤、完整字节 hash、独立重开结果、结构/视觉校验状态；原 session 夹具已经清理，回执中的源路径仅作历史证据。
- [浅色 Word 成果页](../.e2e-tmp/office-acceptance/中文周报.docx.light.png)与[深色 Excel 成果页](../.e2e-tmp/office-acceptance/项目预算.xlsx.dark.png)：截图验证客户端展示，不是 Office 分页渲染。

首次使用审查实际复现并修复了示例重复标题、旧提示强制调用不存在脚本、旧写入提示争夺路由、截断预览说明不足，以及写入后记录失败状态仅在 metadata、模型不可见的问题。统一了列宽、表头与作者长度的公开参数限制，避免合法 schema 输入在格式层才失败。一个既有 SDK 部署路径测试因本机未安装对应旧 Wuzu SDK而提前返回，不能算作该 SDK 部署环境的实际验证。

## 尚未覆盖的能力

- 本轮统一写入工具只支持 DOCX/XLSX。没有补齐 PPT/PPTX、PDF 写入，也没有新增实时控制 Word/Excel 的能力。
- 已有 PDF、旧版 Office、CSV 等内置读取路径继续可用，不代表这些格式已经有同等级写入支持。
- 未集成 Office/WPS/LibreOffice 渲染或计算运行时。没有真实页面渲染、字体可用性和分页验收，不能承诺无跨页、无遮挡或视觉质量已达生产标准。
- 格式结构检查不等于公式全面计算、宏/外部链接运行、图表刷新、复杂文档保真或数字签名有效性验证。
- 本轮不计作先前一小时多任务/子 Agent/定时任务高强度测试的完成证据。
