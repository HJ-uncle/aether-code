# 办公文档预览优化：从 Lino 验证到 Aether

日期：2026-11-03。修改目标是 `D:\dev\aether-code`；`D:\web\lino` 仅作只读参考。

## 已确认的原因

| 路径 | 原有问题 | 本次处理 |
| --- | --- | --- |
| Code 文件页签 | 只挂载当前文档，切换就销毁 iframe/预览组件 | 按编辑组保留已访问的最近文档，隐藏时传递 inactive；DOM 保持原文件顺序，避免移动 iframe 祖先引发导航 |
| Work 文件资源 | 只保留两个预览，切换工作台 surface/Code 模式又卸载整棵资源树 | 保留文件宿主，跨 surface 和模式切换复用；原生浏览器仍在隐藏时释放可见绑定 |
| Word/PPT 缩放 | `srcdoc` 包含缩放值，每次稳定宽度变化都导航子文档 | 保持内容不变，仅由父组件更新 scriptless sandbox 内的 zoom 样式 |
| Word/PPT 滚动 | 页面一离开预取区就销毁 iframe，回滚重新解析和解码图片 | 保留近端页面及最近三个离屏页面；统一观察器，隐藏时停止尺寸/交叉观察 |
| Office 内容缓存 | 只比较 ArrayBuffer 对象身份，同一内容重新解码也 miss；备注未缓存 | 同一会话/格式下完整比较字节，验证过的不可变 buffer 快速命中；缓存含备注并计入源文件体积 |
| Excel 滚动 | 每个 viewport 都访问 ExcelJS `Worksheet.model` 和 columnCount，间接遍历全表；快速滚动请求积压 | 解析后一次提取元数据，稳定区域缓冲、覆盖缓存、每个消费者只保留最新待处理区域，worker 只发一个在途请求 |
| Excel 尺寸 | 首次 loading 时 ref 为空，ResizeObserver 未重新挂载；rAF 读取旧滚动事件坐标 | 就绪后安装观察器，忽略隐藏零尺寸，回调读取最新滚动位置 |
| PDF 缩放/内存 | 固定比例仍随容器宽度重绘；只限制 12 张快照，没有像素预算 | 绘制身份由有效比例/尺寸/DPR 决定；快照同时限制 12 页和 64 MiB，LRU 淘汰立即释放画布 |
| 文件新版本 | 已打开二进制文件被自动刷新逻辑跳过 | Office/PDF 纳入磁盘刷新；普通焦点检查先 stat，真实变化事件强制读取并核对内容；旧异步响应不得覆盖新世代 |

保留机制有容量限制：每个 Code 编辑组、每个 Work 资源区域最多六个预览，输入字节预算 64 MiB，大小未知按 32 MiB 计。Office 派生缓存最多八项、合计 48 MiB、空闲 60 秒；PDF 快照全局 64 MiB。压缩输入与派生缓存限额不等于整个 Electron 进程的内存上限，解析器、实时画布、DOM 和图片解码仍占用额外内存。

此次沿用 Aether 当前 docx-preview、pptx-to-html、ExcelJS 和 PDF.js；移植的是 Lino 已验证的生命周期和缓存思路。没有复制 Lino 的官方私有运行时、账户数据或云端调用配置。

## 测量方法

真实文档来自 `D:\trust-test\办公文档测试`。探针只读取原件并复制到 `.e2e-tmp`，结束时核对原文件 SHA-256；每次使用冻结的 `out`、独立用户配置、关闭引擎的 Electron 实例。保持 Aether 默认的软件合成策略，未通过强制 GPU 改变对比条件。

打开测量等待真实表格单元格、PDF 已绘制画布、Word/PPT 子文档与解码完成的图片，再等待两次 rAF。页签切换计时从实际 click 事件开始；它是渲染调度和内容就绪的代理指标，不是操作系统呈现帧或 INP。缩放另验证 child Document 对象身份，不以 iframe 元素相同冒充“没有重载”。

可复跑：

```powershell
npm run build
node scripts/office-preview-probe.mjs --label=code
node scripts/office-preview-probe.mjs --label=work --work
node scripts/spreadsheet-viewport-probe.mjs
```

设置 `AETHER_OFFICE_FIXTURE_ROOT` 可更换真实文档来源目录。CPU 视口探针自建 12,000 行 × 20 列工作表，比较相同 45 个区域，逐个核对 21,600 个单元格；它不测 ZIP 解析、IPC、DOM 或窗口帧率。

## 本机结果

以下为两次巡回中的实际样本范围，非大样本统计。已打开九个文件，再对五个常用文件巡回切换；总共保留的重型预览始终不超过六个。

| 项目 | 优化前 | 优化后 |
| --- | ---: | ---: |
| Code：14.5 MB PPT 切回 | 829–865 ms | 46–47 ms |
| Work：14.5 MB PPT 切回 | 877–1180 ms | 48 ms |
| Work：中型图文 PPT 切回 | 263–410 ms | 44–45 ms |
| Work：8.6 MB PDF 切回 | 164–166 ms | 43–45 ms |
| Word/PPT 宽度变化 | 子文档重载一次，身份改变 | 零次重载，保留同一 Document |
| Excel：45 次区域读取的 CPU 总耗时 | 306.126 ms | 5.799 ms，另需一次 15.901 ms 准备 |

首次打开不应与缓存切换混淆。优化后 Code/Work 大型 XLSX 分别为 1994/1984 ms，大型 PPT 为 2079/2030 ms；未消除首次 ZIP、XML 和图片准备成本。中型 PPT 本次首次打开甚至从 598/637 ms 增到 996/981 ms，因此本轮不宣称冷启动全面变快。表格跳末行的窗口测量仍约 100 ms 量级，不能把局部 CPU 降幅当成整体窗口同倍率提升。

保留更多实例后的采样末端，renderer 工作集 Code 约 992 MiB、Work 约 1008 MiB。CPU 缓存与位图预算已受限，但这仍不是低内存运行时；本次短测也不能证明长期无泄漏。resize 计时包含固定 220 ms 的防抖观察窗口，仅用于确认没有导航，不能用作用户输入延迟。

完整原始样本、构建哈希、图形模式和内存记录见 [机器可读证据](office-preview-evidence-2026-11-03.json)。真实文档原件 SHA-256 核验未改变，探针没有 renderer pageerror。截图见 `.e2e-tmp/office-optimization-final-e2e-20261103/` 中的 `work-office-reuse.png`。

## 验证记录

- `npm run typecheck`、`npm run build` 通过。仍有原有 Monaco/Git 静态和动态导入提示。
- 文档合同测试 57 项通过（包含提供真实夹具后补跑的四项）；Work 保留策略与读取缓存测试 10 项通过；文档刷新及竞争条件测试 15 项通过。
- 21 项相关桌面验收最终通过：文档同步 5 项、Monaco 暖切换 1 项、真实 Office 首屏/resize 5 项、Code/Work 预览保留与更新 4 项、PDF 连续滚动 1 项、表格格式和交互 5 项。首轮发现旧测试还寻找已移除的分页控件/截断文件 Monaco，已改为当前连续滚动与只读文本表面；保留实际文件字节和显示内容断言。文档同步修正后的 5 项单独复跑通过，未将此前失败记录删除。
- 额外 session-document-scope 检查 6/7 通过；“任务绑定变化时显式重载应拒绝”的一项失败。只读载入 Git HEAD 的旧 editor-store 后同样失败，记录在 `.e2e-tmp/editor-reload-baseline/`，本轮未修改此既有文本会话问题。这不是全仓测试全部通过的声明。
- 测试实例已关闭。已有 Wuzu 用户进程没有被关闭、重启或改配置。

## 验收范围与后续

验收包括 Code/Work 五文件切换、模式切换、缩放、连续滚动、文件关闭、磁盘更新、工作表格式与多表切换、Monaco 的撤销/保存/分栏回归，以及缓存预算与异步响应竞争。

首次未缓存的压缩文件仍需要解析；不能承诺任意大小、任意数量文件始终秒开。大规模 PDF 的页尺寸请求调度、同一 PDF 并发加载去重、跨重启派生缓存和 Work 成果/工作区单文件面板的专门预热，留作后续单独测量。本次未验收远程引擎网络延迟、付费模型调用、所有 Office 复杂对象的版式保真或长期内存压力。
