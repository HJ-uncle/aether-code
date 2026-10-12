# Work 性能优化实施与验证

2026-10-12，依据 [调研方案](work-performance-investigation-2026-10-12.md) 实施。源码和开发构建已更新；没有修改实际用户配置、重启实际用户实例或发布安装包。工作树中的既有改动保留，本文只记录本次性能工作。

## 实测结果

同一台 i9-14900KF / 128GB / RTX 4080 SUPER，1800×1200 CSS 像素、DPR 1.5。每次运行冻结 `out/`，使用独立配置、关闭引擎、无对话历史；每组 16 次已打开设置窗口的导航点击。

| 路径与默认材质 | 优化前中位数 | 优化后中位数 | 优化前 P95 | 优化后 P95 |
| --- | ---: | ---: | ---: | ---: |
| 强制软件合成，应用实际样式 | 221.4ms | 29.5ms | 439.9ms | 30.9ms |
| 硬件合成，应用实际样式 | 29.0ms | 31.0ms | 29.7ms | 32.5ms |
| Windows 默认启动，应用实际样式 | 原先同软件路径 | 29.0ms | 原先同软件路径 | 30.2ms |

软件路径 P95 降低约 **93%**；这次收益不依赖强制开启 GPU。硬件路径保持相近的帧调度量级，本次硬件采样的 rAF 周期约 17.6ms，软件约 16.7ms，不能把数毫秒差值归因为单一代码变更。

输入 135 个 ASCII 字符的观察窗口，Work 状态写入从 **135–136 次降到 1 次**。新旧样本都没有观察到超过 50ms 的主线程 longtask，说明本次主因是软件合成成本，不能用“没有 longtask”否定原有卡顿。

指标是点击事件捕获到第二次 `requestAnimationFrame` 回调，属于调度代理指标；不是 INP、实际屏幕呈现时间，也不覆盖设置窗口首次打开、中文输入法或所有生产负载。完整构建哈希、GPU 状态、逐次采样与统计方法在 [验证证据](work-performance-verification-evidence-2026-10-12.json)。原始基线未覆盖。

## 已实施的改动

### 材质与图形策略

- 设置面板、设置导航、工具栏和大面积遮罩取消模糊；通过已有实色令牌保持明暗外观。
- `<html data-visual-effects>` 管理所有当前材质表面，包括 body portal、浏览器 chrome、资源候选与路径选择器。软件合成、未知能力和系统减少透明度使用实色；自动效果在硬件合成时采用精简模式。小浮层模糊半径统一为 12px；减少动态效果继续独立控制动画。
- 外观设置增加 `auto / enabled / software` 图形模式及 `auto / full / reduced / solid` 视觉偏好。视觉变化立即生效；图形模式下次启动生效，并显示当前实际合成路径与重启状态。
- Windows 新配置及旧配置缺少图形字段时，保留软件渲染兼容默认值。明确选择自动模式后才尝试硬件，避免把已知企业环境回退一次性删除。此机正常桌面 GPU 路径已验证，仍不能据此证明所有驱动和企业策略兼容。
- 只有获得单实例锁的进程写启动标记；窗口健康确认 5 秒后清理。正常退出清理标记；明确 GPU 故障与未完成启动分别记录，自动模式在下一次冷启动持久回退。用户清除记录或明确启用可重试；成功健康确认后清除旧故障。运行中 `gpu-info-update` 更新材质能力，防止 UI 留在旧硬件状态。
- 回退发生在下一次冷启动，不会主动中断现有任务。`enabled` 是明确尝试加速；常规灰度建议使用 `auto`。保留 `AETHER_ENABLE_GPU=0/1` 诊断覆盖入口，不更改 Windows 安全策略。

主要文件：`src/main/graphics.ts`、`src/shared/graphics.ts`、`settings-store.ts`、IPC/preload、`core/useVisualEffects.ts`、`AppearanceSettingsView.tsx`、`assets/visual-effects.css`、`tokens.css`。

### 日志与 React 更新

- 引擎生命周期不再携带日志，稳定共享返回对象；日志不会逐行触发应用级 Context 更新。
- 主进程日志每 100ms 合并一次；每批至多 128 行、64Ki UTF16 字符，单行至多 32Ki 字符。达到预算提前发送；终态和退出前发送末批，保留顺序及截断提示。
- renderer 环形缓冲最多 500 行、512Ki UTF16 字符，采用稳定递增 ID 和独立订阅。输出面板只有在 Code、该页签和窗口可见时订阅；隐藏时继续缓存，保留已渲染 DOM，重新显示读取最新状态。
- preload 保留原 `onLog` 调用接口与旧事件兼容。普通日志显示延迟最多约 200ms（传输和可见 UI 各合并 100ms）。这是有界批次与缓存，不是完整 ACK 背压协议。

主要文件：`main/engine/log-batch.ts`、`core/engine/log-buffer.ts`、`log-store.ts`、`useEngine.ts`、`OutputView.tsx`。

### 草稿与任务状态

- 草稿按引擎来源和任务独立订阅，即时字符只更新当前输入组件。暂停 300ms 保存，连续输入最多等待 2 秒；发送、切换、失焦、模式切换、卸载、隐藏和退出显式 flush。
- 结构性保存合并最新草稿，no-op 不写盘；保留 v1 存储格式及引用、附件、模型和资源恢复，避免异步提交覆盖发送期间的新内容。
- 后台任务由 `/chat/snapshot` 改为 `/chat/status`，最多并发 2 个；选中任务有有效 SSE 时跳过重复探测。前台兜底 1.5 秒，后台/隐藏 5 秒；每轮完成后再计时。状态相同不更新，操作 revision、来源、更新时间和停止期保护拒绝迟到响应。
- 仅 `GET /chat/status` 使用 5 秒桥接 deadline，其它管理/历史请求保持原有超时策略。
- 同级引擎 `D:/dev/ai-agent-engine`：`StreamBus.currentRunId` 从当前 run 槽 O(1) 读取不可变 ID；`RootRunStore.latest` 通过已有索引 `ORDER BY seq DESC LIMIT 1` 获取最新公开 run。状态接口不再复制整轮消息投影或反序列化所有运行记录，保持既有响应契约、租户隔离及凭据过滤。

主要文件：`work-state.ts`、`work-draft-persistence.ts`、`work-status-poller.ts`、`work-runtime.ts`、`WorkComposer.tsx`、`main/engine/request-timeout.ts`；同级引擎 `stream-bus.ts`、`storage/root-runs/index.ts`、`routes/chat.ts`。

### 消息、隐藏页签与拖动

- 完成消息 memo，稳定 Markdown 文件上下文及事件回调；工具派生和 diff 按对象身份缓存。
- Workspace 首次访问才挂载，隐藏后冻结父级派生；子代理隐藏时解绑 store，激活后读最新，保留继续执行的草稿。文件改动页重激活刷新，不会漏掉隐藏期间的完成状态。按引擎身份和任务 ID 隔离。
- 最近任务每批 40 条，对话初始最近 60 条，活动每页 80 条。查看更早消息保留锚点，上滚及复制时不自动裁掉已读内容；回到最新恢复窗口。活动保持跨页键盘操作。
- 分栏拖动仅在 rAF 更新局部 CSS，释放指针后一次提交并保存布局，保留键盘调整与取消行为。

## 验证与复跑

- 主仓库 `npm run typecheck`、`npm run build` 通过。构建仍有已有 Monaco/Git 静态与动态导入提示。
- 正常 Windows 桌面权限、单 worker、隔离 Electron 配置：**69 passed / 0 failed**。覆盖 `graphics-ui`、`engine-log-ui`、`work-mode`、`work-timeline-ui`、`settings-responsive-layout`、`smoke`。长历史、分页/拖动、并行任务、输入引用、终端和输出均通过；新增原生健康检查的实例正常退出，无 GPU/renderer 崩溃信号。
- 整页软件材质断言增强后，`graphics-ui` 再次 **3 passed**，当前挂载 DOM 的过滤器均为 none。
- 主仓库相关策略、生命周期、数据、传输、身份和请求契约专项：**91 passed / 0 failed / 1 skipped**。跳过为沙箱缺少 OS safeStorage 的加密凭据验收。第一次组合运行发现纯测夹具继承了其它 spec 的不完整 window，已让新增草稿用例自持生命周期适配器并复跑通过，同时增加退出最后字符的断言。
- 同级引擎 StreamBus/HTTP recovery 专项：**57 passed**；typecheck/build 通过。引擎 build ID：`sha256:42929926b0d61154e35d474b4173a4cdc5c5511a911df1d6c6528ba7477be393`。
- 性能探针：软件、硬件和默认路径三组，实际样式/临时禁用过滤交错测量；120ms P95 调度回归门禁通过。冻结输出 SHA256 随证据保存。
- baseline 和本轮孤立性能探针都捕获过 `node-pty` console-list 辅助进程的 `AttachConsole failed` stderr；这不属于测量阶段的 renderer/GPU 错误。性能门禁只证明延迟预算，不以它替代真实窗口与原生健康验收。

性能复跑：`npm run perf:work`，会先自动 build，再使用隔离配置。需在能正常启用 GPU 的桌面测试机运行。相关真实窗口复跑：

```powershell
npm run build
npx playwright test e2e/graphics-ui.spec.ts e2e/engine-log-ui.spec.ts e2e/work-mode.spec.ts e2e/work-timeline-ui.spec.ts e2e/settings-responsive-layout.spec.ts e2e/smoke.spec.ts --workers=1
```

这是定向验证，不是当前全部一千余条用例的全量验收。不会把其它任务的 soak/模型质量记录归入本次已完成结果。

## 交付与后续边界

本次落实 P0、主要 UI P1、引擎轻量读取和可复跑性能门禁。Windows 默认的软件兼容路径已经获得主要收益；以最新构建启动即可使用新材质策略，在外观中选择图形模式后需重启。

仍需后续独立工程与验收：按任务异步数据库持久化及迁移、按消息外部 store 订阅、服务端归档 loadOlder 接入、账号级汇总 SSE/批量状态及 capability 协商、完整日志 ACK 背压、多驱动/低配/触控/中文 IME 验证、持续长时间资源 soak 与生产灰度。当前草稿仍通过防抖后的同步 v1 localStorage 保存；消息 DOM 分页只覆盖已加载消息，显式展开会增加 DOM。这些边界没有被本轮小样本性能数字证明完成。

## 后续输入错误修复与验证补充（2026-10-12）

后续真实 Work 交互测试发现草稿输入会报 `Illegal invocation`：默认 clock 保存了裸 `setTimeout` / `clearTimeout`，通过 clock 对象调用时违反 Chromium 原生 timer 的接收者要求。协调聊天已把两者改为箭头函数包装。本轮确认修复进入共享源码及当前 `out/`，保留原有 300ms 防抖、2s 保存上限和 flush/cancel 行为。

- 新增 `e2e/work-draft-timer-receiver.spec.ts`：在隔离 VM 中加载真实模块，省略 clock 参数，用严格普通函数模拟浏览器 timer 接收者检查，不修改 Node 全局 timer。覆盖重复调度、防抖、连续输入 deadline、幂等 flush/cancel 和无迟到写入；本轮 **1 passed**、定向 eslint 无错误。一次性内存变异分别恢复裸 set/clear 引用，均被 `Illegal invocation` 检出；这些实现耦合的变异未加入永久测试。
- 本轮独立执行 `npm run typecheck` 通过，原有 `work-performance-state.spec.ts` **4/4 passed**。输出分别使用 `.e2e-tmp/work-timer-receiver-results-20261012/` 和 `.e2e-tmp/work-draft-state-correction-results-20261012/`，未覆盖正式窗口测试目录。
- 独立核对 `.ae/soak/real-20261012/frozen-app-20261012c/`：`buildExitCode=0`、`sourceVerified=true`；sourceHash 为 `49c01c31175d0c2de3b5b7f0e5e92986df3201b75088c98eba35cfc4c5ffcf1c`，outputHash 为 `12854ac626f5b0b0ba558565e53f851990668cb9bea00010f35d1043bb4f652f`。timer 当前源码、冻结副本及源码清单的 SHA256 一致；当前 main、preload、renderer 主入口也与冻结构建一致，因此未再次重建。
- 协调聊天报告修复后的真实 Electron Work 时间线 **8/8 passed**。本轮检查 `test-results/.last-run.json` 为 passed、失败列表为空，窗口健康记录 `failures=[]`、退出码 0；复用已有窗口回归，没有重复启动 Electron。其 stderr 包含假引擎的 `terminal:create: Error: ok`，不能称为全部 stderr 干净。
- 独立读取修复版历史 UI 复查 `ui-history-review/result.json`：61.898 秒、1,043 次操作、76 次任务访问，`failure=null`、`pageErrors=[]`、原生退出码 0。这是历史会话预检，不是完整一小时实时 UI 压测通过证明。

此次补充不重测点击性能，也不把旧性能数字归到修复后的 renderer。前文性能证据使用 renderer SHA256 `3271f2957501e73823991b7e5da403305d71edda92cc6fb1433c6d7899826a82`；修复版入口 `index-C3NRpL0o.js` 为 `2f58d6e72a2045a92f4c95a551545a479a2ac6f86c5f0ccebf674ca490efffe1`。两份旧性能 JSON 保持原样，补充来源与核验值见 [timer 验证记录](work-draft-timer-verification-2026-10-12.json)。
