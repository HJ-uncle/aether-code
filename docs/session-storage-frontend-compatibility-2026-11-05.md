# 会话存储优化：桌面诊断与消费者兼容审计

日期：2026-11-05。基于本工作树增量实现，保留既有用户修改；不读取真实会话数据库，不重启真实应用。引擎的正文外置、审计归档与清空备份冷档由同级引擎仓库负责。

## 1. 桌面改动与 IPC 契约

继续使用 `engine:diagnostics`，没有增加轮询通道。`EngineStorageSnapshot` 保留原有 state/path/totalBytes/files/categories/partial/scannedAt/durationMs/cached；只增加可选 `partialReasons` 和 `sqlite`。

`sqlite` 提供：

- state/reason、sampledAt/durationMs、partial/partialReasons；不可用值为 null，不伪装成零。
- pageSize/pageCount/freelistPages/freeBytes。
- 分配页占用最大的 12 个表/索引；记录 name、kind、tableName、bytes、payloadBytes、unusedBytes。
- collaboration_history_maintenance 的 pending/committed/invalidated/other 行数；没有表时为 null 并解释原因，兼容尚未创建该表的旧数据库。

旧桌面/旧 runtime 只有原字段时，界面仍显示文件统计，并说明未提供内部统计。远端连接仍不读取本机数据库以冒充远端占用。

源码：`src/shared/engine-diagnostics.ts`、`src/main/engine/diagnostics.ts`、`src/main/engine/storage-sqlite-diagnostics.ts`、`src/renderer/src/contrib/work/EngineResourceHealth.tsx`。

## 2. 统计口径

| 分类 | 口径 |
|---|---|
| database | DATA_DIR 指定的主数据库文件 |
| database-wal / database-shm | 主数据库 WAL / SHM，分别计数 |
| history-jsonl | sessions 下的活动 JSONL 文件 |
| history-backups | sessions 下以 .bak 结尾的历史备份 |
| history-markers | sessions 下的 .migrated / .cleared 标记 |
| history-other | sessions 下未匹配以上类型的其他文件 |
| blobs | dirname(DATA_DIR)/blobs，按租户隔离的正文/附件内容存储 |
| audit-archive | dirname(DATA_DIR)/audit-archive，审计冷档 |
| history-cold | dirname(DATA_DIR)/history-cold，已清空的历史备份冷档 |
| memory | memory 子目录，包括长期记忆数据库及其配套文件；属于磁盘存储 |
| snapshots | change-snapshots，中文显示“文件变更快照” |
| backups/logs/cache/other | 保持现有物理目录分类 |

totalBytes 是扫描到的文件逻辑字节数（lstat.size），不是文件系统实际分配块数。文件数不是 session 数。扫描不跟随符号链接/junction；不推测外部工作区、子代理或租户的独立磁盘份额。

SQLite 内部页分配与目录文件大小是两种观察，不相加。freelist 是数据库内可复用空闲页，不能当成已经归还操作系统的空间，也不能承诺等量压缩收益。dbstat 的表/索引行包含分配页开销，不是业务正文的字节总和。逻辑页样本包括 SQLite 一致读视图；目录扫描期间仍可能有正常并发写入，因此不声明跨文件的统一事务快照。

## 3. 采集成本与只读边界

文件扫描保留共享 in-flight、最多 20,000 条目、1.5 秒目录预算、24 层深度；被动读取保留 60 秒缓存，显式手动刷新绕过缓存。现在明确返回“条目上限/时间预算/目录层级/文件变化或不可读/目录不可读”的 partial 原因。

SQLite 采样与目录扫描并行，但在主进程之外的独立 Node 子进程执行：

- 只读取已确认的本地 DATA_DIR。文件必须是普通文件，校验 SQLite 16-byte header，避免把损坏或短文件当成空数据库。
- `node:sqlite` 的 `DatabaseSync(..., {readOnly:true})`；BEGIN/ROLLBACK 维持同一读取视图。
- 不导入引擎启动、schema、store、migration、recovery 模块；不执行 checkpoint、VACUUM、DELETE、DDL 或业务写入。
- 只查询 PRAGMA 页元数据、sqlite_schema 元数据、dbstat 页统计和维护状态计数。不读取 conversation body、metadata、seed、payload_json 等业务内容。
- 2.5 秒总超时、128 KiB 输出上限、windowsHide。启动环境不继承 API keys、令牌、NODE_OPTIONS 等配置，只保留系统路径/临时目录和 Electron-as-Node 开关。
- 分阶段输出已完成元数据；超时/退出保留最后完整样本并标记 partial，不把不完整 JSON 解释为成功。
- 不向 IPC 返回 stderr、SQL 文本、异常原文或命令行。旧 Node 缺 node:sqlite/dbstat 时明确降级；文件统计仍正常。

缓存键包含连接模式、地址、实例、账号、PID、数据文件、runtime 入口和来源；切换引擎、账号或运行时不复用先前来源的统计。UI 显示采样时间、耗时、缓存/新采样、partial 原因。SQLite 详情默认折叠，使用原生 details/summary 和可聚焦控件；表有 caption/列标题，沿用现有深浅主题令牌。

UX 指引：使用 ui-ux-pro-max 对 `loading feedback` 的 ux 查询，命中 Loading Indicators（All，High）；采用稳定布局、采集反馈、禁用重复刷新和 aria-busy。首个 stale data 查询匹配不适用，未采纳。详情按需展开；采样节奏按用户后续要求改为进入一次、之后手动刷新，见第 6 节。

## 4. 消费者协议逐项核对

后端约定：顶层 JSONL 内部字段 `storageBlobs:{version:1,tenant,refs:[{path,hash,bytes,codec:'gzip'}]}` 只用于持久存储；还原后移除该字段。`archiveReference:{version:1,messageId,contentHash}` 只用于 JSONL microcompact update。它们都不是 Message API 类型。

| 消费者 | 现有输入与要求 | 本次结论 |
|---|---|---|
| Code history | `EngineHistoryRow`；replayMessages 接受字符串或 multipart content、toolCall.args、reasoningContent、metadata | 无需改变；后端必须先还原完整字段 |
| Code archive | useChat 请求 `/conversation/archive`；checkHistoryPage 校验消息 ID、分页、revision、数量 | 外置不应改变 Message/分页契约；不得把 blob ref 当页消息 |
| Work 子代理 transcript | work-subagent-transcript 优先 archive，旧后端可回退 history | 继续相同 history display row；不增加 blob 下载接口 |
| Work 主任务恢复/导出 | work-runtime 与 WorkView 从 `/chat/snapshot` 恢复 | snapshot.history 必须是已还原的 Message；不能要求 UI 读取服务器文件路径 |
| 实时 SSE | Shared ChatSsePayload 接受 content/reasoning/toolResult/toolEnd/usage；已有 reducer/owner 做顺序与恢复控制 | 物理外置不改变流事件、ID 或状态；不得发送 storageBlobs/archiveReference |
| 原文搜索 | search_history 是工具，结果经通用 tool result 路径展示 | 后端搜索必须对还原正文做匹配；UI 不猜测引用指向的内容 |
| 图片工具输出 | parseToolResult 处理 dataUrl、MCP base64、Anthropic source、OpenAI image_url、嵌套JSON | 必须收到现有实际图片数据或既有省略标志；blob path/hash 不能冒充图片 URL |
| browser screenshot | parseBrowserSnapshot / viewportScreenshot 解析几何和原图；恢复省略标记独立处理 | 保留现有协议，不能把“未还原”当成图片省略 |
| 工具参数/工具结果 | replayMessages 按 toolCallId 配对；保留 args 与 content | 外置/还原不能改变 toolCallId、消息锚点或把 args 变为引用对象 |
| 发布恢复 protocol | published-snapshot-client 校验签名 snapshot/子引用/分块body digest，恢复旧投影位置 | 这是公开恢复协议，与 storageBlobs 内部引用不同；不能为了隐藏内部引用而删除合法 public child refs |
| 附件上传 | remote-attachments 与 Work 文件输入沿用上传/内容传输协议 | 原始用户附件和存储内部 blob 不合并命名空间，不向渲染层暴露 DATA_DIR |
| 安全审计 | 全目录检索未发现 `/security/audit-log` 的桌面查询/清空消费者 | 无需改清空按钮；新增 archives/下载接口不影响当前客户端 |

定位：`core/engine/chat-history.ts`、`history-page.ts`、`archive-pages.ts`、`useChat.ts`、`published-snapshot-client.ts`、`contrib/work/work-subagent-transcript.ts`、`work-runtime.ts`、`contrib/chat/tool-result.ts`、`browser-snapshot.ts`、`src/shared/ipc.ts`。

界面 `extractText` 对未知对象可能得到 `[object Object]`，图片解析器也不会自动解析磁盘引用。因此真正的透明性必须在引擎所有公开读取出口验证，不能靠 UI 兜底。建议后端测试对 history/archive/search/snapshot/tool/SSE 的结构断言不存在内部顶层 `storageBlobs` 信封和 update 的 `archiveReference`，并比较压缩/重开前后的原文字节、图片、metadata 与 tool args。用户 metadata 内合法的同名字段仍应原样保留，不做全文关键词删除。桌面不新增读取任意 blob/path 的能力。

安全审计的新契约为：DELETE `/security/audit-log` 先归档再迁出在线，兼容 removed 并新增 archived；GET `/security/audit-log/archives` 返回分页清单，GET `/security/audit-log/archives/:archiveId` 下载 gzip。默认 allow 30 天、重要记录 180 天仅表示迁出在线，冷档不自动删除。桌面当前只有安全模式说明，没有审计数量或清空页面；未来接入应使用“在线审计/归档”，不能称为永久删除。

## 5. 兼容与验证记录

- `npm run typecheck`：node/web 通过。
- 首次普通 `npm run build`：main/preload 通过；清空既有 out/renderer/assets 时 Windows EPERM。没有为此结束或重启用户应用。
- `npm run build -- --outDir .e2e-tmp/storage-diagnostics-build-20261105`：完整 main/preload/renderer 构建通过；后续 E2E 指向该新产物，不使用旧 out。
- 6 个定向契约文件共 55 tests：初轮 54 pass，1 个合成短文件被 SQLite 当空库的用例失败；增加 header 检查后相关 4 tests 全部通过。其余 51 项不受该 header 路径修改影响。
- SQLite 合成 fixture 验证：table/index Top、freelist、pending/committed/invalidated，DB 哈希与目录文件清单前后不变，输出不含 PRIVATE-CONTENT/PRIVATE-SEED。
- 旧 runtime 缺可执行文件、不支持诊断、截断子进程输出、扫描预算、旧字段渲染均保留“不可用/部分统计”语义。
- archive 分页/同数编辑/跨页 ID、工具普通文本精确保留、多个图片适配格式、published hydration 的取消/换源边界继续通过。

真实 Electron IPC/监控页面验证使用单 worker、隔离 `.e2e-tmp` 用户目录和专用端口：最终一轮 2 tests 通过（11.6 秒），覆盖实际 PID、目录统计、SQLite明细/兼容降级、IPC缓存、原生详情展开、深浅主题截图和离开页面后采样释放。实际 fixture 的 SQLite 状态为 available，完整显示逻辑页、空闲页和 Top12 表/索引；fixture 缺少历史维护表时如实显示部分统计原因。初轮命中了既有 CPU 选择器同时匹配卡片与表头，已限定到资源卡区域后通过；没有为断言改产品行为。已目视核对存储区域的完整明暗截图，测试实例均正常关闭。不针对真实用户数据执行维护或诊断探针，不启动并行测试应用。

## 6. 后续调整：手动监控采样与来源排查

用户要求减少采样：资源/进程树/磁盘/存储诊断在进入监控页且引擎就绪后读取一次，之后由页面的刷新按钮触发。删除原 5 秒资源轮询、存储倒计时和概览 30 秒时间 ticker。隐藏后恢复同一页面不补读；切换引擎身份或 runtime 来源创建新读取生命周期；隐藏、换源或离开后的晚到结果不会覆盖当前页面。首次 CPU/I/O 没有增量时显示“需再次刷新”，不会补发第二次自动请求。

按钮加载时禁用，前端合并同一个进行中的请求，主进程也共享 in-flight。新的可选 `refresh:true`（兼容原 `refreshStorage:true`）绕过资源 5 秒、进程树 15 秒和存储 60 秒缓存，实际重新采样；普通读取仍可复用缓存，界面显示缓存状态和原时间。缓存键补齐地址、实例、账号、PID 和 runtime 信息，避免换源后拿到先前来源的存储样本。

引擎自身运行时指标保留首次展开读取一次的按需行为，删除其 5 秒客户端轮询；展开后的后续刷新统一复用页面刷新动作。隐藏恢复、收起后再展开、404/权限失败均不自动重试。引擎接口自身短期缓存仍保留，说明“短间隔刷新可能返回同一时间的缓存样本”，不声称产生了新样本。主进程连接 `/health` 和实例校验职责未改动；页面只在本次诊断中读取已有健康检查结果，并标明“采样时心跳新鲜度”。

用户截图和另一时点只读统计不一致的审查结论：

- `runtime.ts` 的 `engineDataFile()` 从 Electron `app.getPath('userData')` 构造 `engine/state/agent.db`；host 把同一个 dataDir 注入引擎并写入 snapshot。
- IPC 捕获同一份 host snapshot 后同时调用资源和存储采集，返回前复核身份。文件扫描返回的 storage.path 是该 snapshot.dataDir 的 dirname，SQLite 子进程 argv 直接传该 dataDir，没有另一个数据库默认值或回退。
- 原缓存把 path、分类、SQLite 明细作为完整对象保存，没有“新路径 + 旧容量”的字段拼接。原 60 秒缓存可解释同一路径被替换后的短时旧样本，但仅凭源码不能确认用户截图来自哪个已加载产物，也不足以解释 15:55:43 与 15:58 两组差异。
- 对 src/e2e/scripts 的入口检索未发现生产诊断 mock 替换入口或截图中的固定数字。我方前一轮 E2E 的实际结果为隔离 `.e2e-tmp/engine-resource-live-*` 路径、2.9 MiB/7 files/268 pages/free 0，无历史维护表，和用户 220 MiB/57 files/16868 pages/free 11179 的截图不同；未改写真实用户数据来生成截图。

同次协作的主代理随后补充了运行中进程句柄证据：SQLite worker PID 64876 的数据库句柄经 GetFinalPathName 得到同一个 `C:\Users\wb.xielin02\AppData\Roaming\aether-code\engine\state\agent.db` 路径，但 GetFileSizeEx 为 69,091,328 bytes（65.890625 MiB），WAL 为 8,619,072 bytes（8.2197876 MiB），与用户截图吻合。该活动句柄 file ID 为 `0x0002000000076167`，普通路径 fs.stat/open 得到的 ino 为 `562949953582657`，对应不同文件对象。因此不能把普通路径读到的 87.29 MiB 当作活动实例当前持有的数据；截图的核心容量得到活动句柄验证。这里只记录可确认事实，不据此改写 UI 数据或猜测文件对象为何分叉。

本次手动采样验证：`npm run build -- --outDir .e2e-tmp/manual-monitor-build-20261105` 完整通过（包含 node/web typecheck）；6 个定向契约文件共 37 tests 全通过。以该新产物运行 3 个 Electron spec，单 worker，最终 4/4 通过（76.3 秒），涵盖真实 PID/SQLite、首次 CPU 无增量、手动刷新后真实新增 2 MiB 文件立即计入、无 5 秒定时器、窗口隐藏恢复不刷新、运行时首次展开与手动刷新、404 不循环、真实 V8/ELU 和明暗截图。首轮旧 health 测试在启动握手后、首次定时健康探针完成前检查 latency，改为等待真实 latency 后通过；没有为测试修改主进程 health 行为。所有隔离测试实例正常关闭。

## 7. 可发现的刷新图标入口

按用户后续要求，顶部“刷新监控数据”、运行时详情右上、存储标题旁、页底“手动刷新”均提供可点击的圆形刷新箭头，统一使用已有 `Icon(name='restart')`，复用同一刷新动作和进行中状态。运行时入口通过阻止 summary 默认点击行为保持面板展开；所有按钮有固定的可访问名称、title、键盘焦点及 aria-busy。加载时禁用并使用既有 Spinner，沿用全局 prefers-reduced-motion 静止降级。没有重新加入任何轮询。

UI 技能定向查询 `icon button accessible label --domain icons` 命中 `icon-context-accessibility`，采用“装饰图标 aria-hidden + 控件有可访问名称”，沿用项目现有图标体系。

验证：`npm run build -- --outDir .e2e-tmp/manual-monitor-icons-build-20261105` 包含 typecheck 的完整构建通过；18 项相关契约测试通过；单 worker 的 3 项 Electron 测试通过（67.1 秒），验证四处入口、存储真实刷新、运行时按钮 Enter 操作不折叠、全入口加载禁用、Spinner 在 reduced motion 下 animationName 为 none、无自动轮询以及隐藏恢复不采样。测试仅用 `.e2e-tmp` 隔离用户目录和专用引擎/HTTP 端口，实例已全部关闭；已目视核对顶部、运行时、存储和页底截图。

用户最终要求刷新入口只显示图标：共享按钮已移除 text 属性和可见文字节点，空闲仅显示 restart Icon，加载仅显示 Spinner；title、aria-label、aria-busy、禁用和键盘行为保留。按钮使用 `--control-h` 的 28×28 尺寸，局部选择器显式覆盖 Work 通用按钮的 30px 最小高度，不改动全局按钮。页底“不自动轮询”独立说明保留。

纯图标版本最终完整 build/typecheck 通过，产物为 `.e2e-tmp/manual-monitor-icon-only-build-20261105`；18 项契约测试通过。3 个受影响真实用例分批覆盖通过：真实 PID、runtime 纯图标/键盘/加载/reduced-motion 首轮通过；资源页发现 Work 通用最小高度覆盖后修正，再以最新产物重跑 1/1 通过（13.2 秒）。资源页验证顶部、存储、页脚无可见按钮文字、title 等于 aria-label、28×28 方形、真实手动刷新及无轮询。测试全部使用程序化隔离实例，未使用 CUA/sky 或操作用户窗口，实例均已关闭；已目视核对纯图标顶部与页底截图。

## 8. 独立运行时刷新与按需测量

用户反馈运行时局部刷新不明显、顶部图标分散。源码确认顶部 heading 使用 space-between 排列标题、图标、状态三个直属项，因而图标落在中间；现在把状态和刷新归入右侧 actions，刷新放最右端，使用 `--control-h-lg` 的 34px 尺寸和 accent/accent-soft 令牌，继续只显示图标。

原局部运行时按钮实际有显式 onClick，经过父级 collect.current 读取全页，并非漏绑事件；但其调用与禁用状态都耦合全页采集。现在局部按钮直接调用自己的 sampler.retry，busy 只取 runtimeCollecting；顶部通过同一个 sampler 的 refreshRef 协调全部数据。运行时已完成、其他诊断仍在读取时，局部入口仍可再读运行时。summary 默认行为仍被阻止，点击和键盘不收起面板。存储入口继续读取真实目录统计。

引擎侧另已确认旧机制至少缓存 5 秒、15 秒空闲后清除增量基线：短间隔点击可能返回同一 sample，长间隔手动点击则反复 warming。因此桌面每次运行时读取（首次展开和手动）均请求 `GET /performance/runtime?refresh=true`。当前引擎返回可选 `collection.sampleWindowMs=200`，桌面验证其为有限正数并显示“本次按需窗口 200 ms；采样结束即停止采集，无后台轮询”。老引擎缺少字段仍兼容，保留缓存/空闲说明；重复 sampledAt 明确标为缓存。本次时间显示毫秒，避免两次 200ms 窗口的刷新落在同一秒而看似没有变化。客户端未增加任何自动轮询。

回归用例同时检查 HTTP 请求次数、refresh query、sampledAt 与实际展示字段变化；鼠标和 Enter 均覆盖。受控 HTTP/Electron 用例仅在隔离应用中通过公开 ipcMain API 暂缓全页 diagnostics，以证明局部 runtime 可独立更新；真实引擎用例则静置超过 15 秒（期间只观察本地时钟，不读取引擎），验证一次局部点击仍得到可用 ELU/延迟，再检查顶部同时更新全页。存储用例继续通过新增实际 2 MiB 文件验证刷新结果。

最终验证：20 项契约测试通过；3 个 Electron spec 的 4 项用例分批全部通过。真实引擎完整覆盖 200ms 窗口、长于 15 秒静默后的一次局部刷新、采样时间前进与顶部全页刷新。受控 HTTP 用例覆盖局部鼠标/Enter、缓存兼容和全页诊断未完成时仍可独立刷新运行时。两项旧测试先因已移除的页脚文字断言、过早记录“尚未采样”作为资源基线失败；仅修正测试后，以同一新产品产物重跑 2/2 通过。没有为测试改回并发编辑已经删除的页脚文案，也没有恢复自动轮询。

`electron-vite build --outDir .e2e-tmp/runtime-refresh-actions-build-20261105` 已生成完整新产物供真实 E2E 使用；完整 `npm run build` / typecheck 在本轮验证时被并发浏览器接口错误阻塞（preload 缺 openLocalDirectory/openLocalEntry，BrowserLocalPreview 对目录/文件联合类型直接访问 size），不能记为通过。我方未修改这些无关文件。完整证据索引见 [verification.md](assets/runtime-refresh-20261105/verification.md)，构建/typecheck 输出摘录见 [build-typecheck.log](assets/runtime-refresh-20261105/build-typecheck.log)，复验原始输出见 [live-rerun.log](assets/runtime-refresh-20261105/live-rerun.log)。

截图优先使用真实引擎的 [顶部布局](assets/runtime-refresh-20261105/monitor-heading.png) 和 [运行时指标](assets/runtime-refresh-20261105/runtime-live-dark.png)。`runtime-ui-dark.png` 是受控 HTTP 合成样本，不能作为真实 200ms 测量证据。所有测试实例已关闭，未操作当前用户窗口或数据库。
