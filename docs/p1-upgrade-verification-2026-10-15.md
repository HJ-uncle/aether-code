# P1 第一轮引擎与客户端升级记录

范围：接续差距清单，覆盖事件恢复、历史边界、按需监控、窗口隔离与协作证据。UI 延续 Apple/macOS 的紧凑层级、原生折叠、键盘焦点、浅深主题和渐进展示；颜色使用现有令牌。

## 已实现

| 领域 | 本轮行为 | 性能与正确性边界 |
| --- | --- | --- |
| 事件恢复 | HTTP/SSE 归一为共享 envelope；校验 producer/cursor；坏帧和 retention gap 显式恢复，Code/Work 展示同步状态 | 不把过滤控制帧造成的合法 sequence 跳跃当丢帧；快照恢复不重发任务 |
| 长历史 | Work 正文固定最多 180 条，60 条步进，支持较新与回最新；统一 archive/child 页校验 | 阅读旧窗口时持续输出不扩大 DOM、不自动跳走；这仍是有界分页，不是 viewport virtualization |
| 连接心跳 | 展示主进程已有 /health + /meta 检查的新鲜度、延迟、失败数与来源 | 单飞；切账号/实例后忽略迟到结果；远端缺少 OS 计数不冒充连接故障 |
| 引擎运行时 | 新增认证 GET /api/v1/performance/runtime：真实 V8、RSS、external/ArrayBuffer、ELU、delay P95/mean/max | 默认折叠；可见展开才读；5 秒共享样本；15 秒无读取停用 histogram；不保留时间序列 |
| 客户端性能 | 显式启动 Chromium 长任务观察与页面 JS 堆估计 | 仅保留汇总；2 秒更新；隐藏、收起、离开释放 observer/timer；与引擎内存分别计量 |
| 窗口停采 | 合并 Electron 原生 show/hide/minimize/restore 与 Chromium 可见性；统一控制资源、运行时、页面与 cron 监控 | 每个页面共享一个订阅，无额外轮询；初值未知时暂停，拒绝迟到初值与旧订阅回调 |
| 定时监控恢复 | 旧请求跨隐藏/显示完成后立即唤醒当前监控；账号/实例切换立即隔离旧计划数据 | 保持单飞，不等待下一次 30 秒刷新；卸载后不再发请求 |
| 窗口隔离 | 流取消与回传绑定发起窗口；同一公共 streamId 可在不同窗口独立使用；移除通用 Electron 环境/IPC 桥 | 内部 route generation 防旧流清理新流；引擎 IPC 校验所属窗口、主帧与准确工作台入口；阻止外部文档携带工作台预加载桥 |
| 协作观测 | 按需只读能力/参与者上下文/持久回执，保留 attempt、seq、requestKey、hash 与回执及拒绝原因证据 | 每页 24 条，仅保留当前页；拒绝跨 root/attempt/recipient；queued 仅表示持久接纳 |

引擎实现位于同级 `D:\dev\ai-agent-engine`，客户端与引擎需配套使用。旧引擎无运行时接口时显示“未提供”，停止自动重探，允许手动重新检测。

## 证据与保留事项

- 引擎 delay 直方图分辨率为 20 ms，读数包含该采样基线，不能作为额外阻塞毫秒数。
- Chromium `performance.memory` 是页面粗略估计，可能包含共享上下文；不是引擎 V8 指标。
- 运行时采样首帧处于 warming；没有真实延迟/利用率样本时不显示健康零值。
- 引擎当前公开的协作能力仍为 `runtimeCommunication=false`、`mailboxConsumer=false`、`userControllerMutation=false`。本轮没有编造“已读/执行 ACK”、nonce 或无冲突完成证明。
- 客户端共享 envelope 没有改变服务端 wire 协议；用户级全局事件水位、服务端 emittedAt、精确缺帧数量仍需独立协议升级。
- 无 revision 的旧历史接口按单页替换导航，不能宣称多页是同一快照；真正 viewport virtualization 与 SQLite 版本化分页仍待后续实现。
- 本轮验证是定向契约与真实 Electron 场景，不代表已完成一小时真实模型并发压测。
- Chromium 的 `document.hidden` 在本机原生 hide 后仍可能为 false，单用页面信号无法保证停采；因此原生窗口事件也是采集开关的必要条件。引擎连接自身的存活心跳独立于监控页采集，仍按既有策略运行。
- 本轮收紧的是工作台预加载与引擎相关 IPC；其他业务 IPC 的完整安全审计仍需持续推进。

## 本轮验证

客户端 `npm run build` 已通过，其中包含 node/web 两段 `typecheck`；引擎自身的 typecheck、build 与 4 条原生运行时/路由鉴权测试通过。

定向纯契约共 101 条通过，覆盖恢复、游标、分页、回执、资源真实性、窗口权限、可见性竞态和监控请求单飞。不是全仓库 E2E 总数。

新写的 Electron 场景共 15 条通过：9 条业务与监控场景、6 条安全与窗口隔离场景。业务场景使用受控 HTTP/SSE 同伴验证异常路径；另有一条启动真正内置引擎，经真实 IPC 验证实例、PID、V8 和事件循环数值。额外探索的不透明子框架原生失败独立记录于下节，没有计入这 15 条，也没有通过 skip 隐藏。

- 真实浏览器 WebContentsView 与原生隐藏 32 秒：运行时、OS 资源显示刷新、页面 observer/timer、cron 读取均暂停；显示后恢复。
- 未完成的旧 cron 请求跨两轮隐藏/显示仍保持单飞，旧响应释放后 5 秒内恢复新读取。
- 540 条历史双向翻页与连续 SSE 追加，正文 DOM 至多 180 条，旧页不跳走、草稿不丢失。
- 坏 JSON 与过期回放分别恢复同一任务，不重复提交或追加正文。
- 无版本 root/child 单页导航、Code 过滤后空页仍可返回、24 条回执分页与跨身份拒绝。
- 双窗口同名流独立取消、同窗口替换流清理、窗口可见性互不串送，以及身份切换后的旧请求拒绝。

最后一次 `npm run build` 后，串行复测安全场景与页面性能场景，结果为 **7 passed（14.8 秒）**，覆盖最终的主文档导航守卫。客户端累计通过数仍为 15 个独立 Electron 场景，不重复累计复跑次数。

证据目录：

- `.e2e-tmp/p1-final-electron-results/`：9 条业务与监控场景，包括真实内置引擎运行时截图。
- `.e2e-tmp/p1-security-final-verified/`：6 条安全与窗口隔离场景。
- `.e2e-tmp/p1-last-window-results/`：最终构建后的 7 条复测，以及完整的页面性能卡片深浅主题截图。

运行时与页面性能卡片的深浅主题均已目视核对，未见内容裁剪或溢出；所有本轮新增颜色引用使用已有令牌；`git -c core.safecrlf=false diff --check` 通过。截图中的瞬时数值仅证明当前采集与展示链路，不代表长期性能基线。

## 新记录的原生边界问题

在 Electron **39.8.10** 的 `file://` 工作台中，测试直接注入 `sandbox="allow-scripts"` 的不透明 `data:` 子框架：初期子框架存在但 URL 未提交，固定在可见区域后捕获 Chromium 原生崩溃 `content/browser/site_info.cc:847 CHECK origin.GetTupleOrPrecursorTupleIfOpaque().IsValid()`。未确认上游根因，不能将其当作已修复或普通 CSP 拒绝；这是客户端原生进程退出证据，不是引擎退出证据。

该夹具不属于现有文件预览路径：`source-preview-document.ts` 会移除 iframe/frame 等嵌套元素，生成的文档设有 `frame-src 'none'`。随后尝试 HTTP 浏览器页面内的不透明子框架，也在 guest 创建阶段发生调试连接终止，但没有捕获同一 CHECK 或 renderer 退出事件，不能宣称同一根因。

这两项子框架场景不计入通过数，不放松 sandbox 或 CSP，也不通过 skip 隐藏失败。常规安全验收明确只覆盖工作台窄桥、主导航、双窗口路由/可见性与身份切换。原生子框架问题仍未解决，后续需独立最小复现，区分原生运行时、启动配置和自动化环境，再评估 Electron/Chromium 升级。

原生失败证据保存在 `.e2e-tmp/p1-native-failures/`：包括 file 场景的 stderr、进程事件、trace 和 crash dump，以及 HTTP guest 场景的 stderr、trace 和复现源码快照。HTTP guest 的调试连接关闭仍不足以证明其原生进程以同一方式崩溃。
