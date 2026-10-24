# 现有 Office runner 的界面与性能复核

这是**准备好的 helper，尚未在真实 runner 执行**。导入模块只定义函数，不启动 Electron、不连接另一个页面、不发模型请求。

本阶段报告固定标为 **“五角色应用并发、六会话切换”**。G2 必须等待 PMO 完成后才允许第二波，因此 PMO 是预期已完成的第六会话；活跃负载只要求 finance、people、sales、operations、compliance 的五个实际固定根。

由持有现有 `globalThis.__officeCampaign` 的 root 在第二波五个角色完成 admission 后调用。必须在同一 runner 的既有控制上下文中导入；不要直接运行 `run-office-company-campaign.mjs`，那会新开应用。也不要在另一个 Node 进程伪造控制器。

当前 runner 的 inspector `Runtime.evaluate` 没有 dynamic-import callback，应使用同步 ESM bridge。现成的两个注入文件是 `.e2e-tmp/start-owned-office-ui-load-probe.mjs` 和 `.e2e-tmp/query-owned-office-ui-load-probe.mjs`，均导出自包含 `recover(c)`；前者固定本轮 `v003-sequenced-20261024-<role>` 六个 ID，后者只返回有界摘要。由现有 `.e2e-tmp/recover-owned-office-runner.mjs` 按其已验证的 runner PID/根目录校验载入；不要绕过身份校验，也不要直接启动新 runner。

v004 恢复轮使用独立准备入口 `.e2e-tmp/start-owned-office-ui-load-probe-v004.mjs`，固定 `v004-sequenced-20261024-<role>`。旧 v003 启动入口保留。v004 staging root 不属于这里的六个实际发布/应用 root，不能替代最终 admission。

```js
const { createRequire } = process.getBuiltinModule('node:module')
const requireOwned = createRequire('D:/dev/aether-code/scripts/run-office-company-campaign.mjs')
const { startOfficeUiLoadProbe } = requireOwned('./office-ui-load-probe.mjs')
const c = globalThis.__officeCampaign
const expectedEngine = await c.page.evaluate(() => window.aether.engine.getSnapshot())
// 下列值须逐一取自本轮六条实际 state.roles[role].submissions，不能用旧 v002。
const requiredSubmissionIds = {
  finance: '实际 finance v003 command ID',
  people: '实际 people v003 command ID',
  sales: '实际 sales v003 command ID',
  operations: '实际 operations v003 command ID',
  pmo: '实际 pmo v003 command ID',
  compliance: '实际 compliance v003 command ID'
}
const acknowledgement = startOfficeUiLoadProbe(c, {
  expectedRoot: 'D:/dev/aether-code/.ae/office-company-20261023163242581',
  expectedEngine,
  expectedInstanceId: expectedEngine.instanceId,
  expectedActiveRoles: ['finance', 'people', 'sales', 'operations', 'compliance'],
  requiredSubmissionIds
})
// 立即返回输出目录与本次固定 run/session 绑定，不阻塞 runner 的检查通道。
// 读取 c.uiLoadProbePromise 获取结果；不要为获取结果重启或再次调用 helper。
const resultPromise = c.uiLoadProbePromise
```

调用前必须满足：

- `commands.json` 的全部命令已有 terminal 执行记录，没有 started/processing；历史 failed 会保留，不冒充成功。指定六条 v003 命令本身必须 completed。
- 六条 submission 都为 admitted，具有相符的 actualAdmittedRun/serverAdmissionReceipt/runId/sessionId；同一会话内的旧根不能代替新根。
- 显式指定上述五个 expectedActiveRoles。PMO 的固定根必须 succeeded 且 running=false，切换时继续检查其身份、完成状态和 UI 对应。
- 现有 Work 页面处于可见状态、已有一个公司任务选中，六个任务均在当前侧栏。helper 不激活或创建操作系统窗口，不翻到 Code。
- 没有 context probe 或另一个 UI load probe，现有引擎 ready 且 instanceId 一致。
- 执行期间不追加 commands，不手动切换当前窗口。后端模型/子代理继续运行，原 runner 只读监控也继续。

现有 runner 的 main loop 没有锁。helper 同步建立临时 lease：`submit/createAndStart/selectTask` 的后续调用等待释放，而不是把命令标失败。任何竞争调用、队列字节变化或引擎身份变化都会结束复核并释放；不继续抢 UI。完成或异常都会恢复方法。请求固定新取的 live snapshot，不能依赖可能陈旧的 `c.state.engine`。内部导航使用当前组件的精确标题与当前状态进行二次确认，不使用旧 E2E 选择器。没有调用发送、停止、刷新任务、模型/安全/记忆设置等动作。

90 秒中按六角色循环，约每 5 秒访问一次，最多 24 次。观察任务标题与 activeTaskId、最新根 API 前后状态、可见消息 ID 是否跨角色、子代理 summary API 的真实 parent/child 身份，以及正在运行/已结束两个固定分区内持续存在成员的相对顺序。自然完成、恢复运行、新增和分页成员变化不算乱序。API/DOM 不是原子快照，状态边界没有匹配时会标 incomplete；看不到当前根消息或子代理不在有界 API 页中也不冒充隔离通过。只抓取最多 128 个可见消息 ID、64 个子代理行，不复制消息/工具全文。

性能采样：

- 采样窗口为 90 秒，PerformanceObserver、RAF、定时器和可见性监听届时自动清理；finally 还会重复安全清理。
- RAF 最多 18,000 个间隔；longtask 明细最多 1,024 个，但总次数/最大值/总时长持续汇总；heap 最多 100 次；可见性变更最多 128 条。丢弃计数写入报告。
- RAF 按可见/隐藏分别计算 p50/p95/p99/max；heap 记录 used/total/limit，标注 hidden 与 focus。未支持的指标为 null/unsupported，不能当作 0。
- 页面隐藏使结果不完整，独立累计标记不受可见性明细上限影响；缺少真实帧样本或可用 heap 样本、帧或 heap 数据达到上限后丢样，也不能通过。RAF 是调度间隔代理指标，不是 INP、帧呈现保证或 UI 性能 SLO。JS heap 也不是引擎 RSS/系统总内存。

结果写入现有 campaign 的新 `evidence/ui-load-<时间>-<随机片段>/`，不写 company 业务目录。`result.json` 包含有界原始字段和统计，每个角色首访保存一张截图。报告按访问更新，异常证据保留。不打印完整报告或上传内容；root 只需查看路径/status/errors/coverage/统计摘要。

会尽力恢复原任务与工作区 tab/开关；遇到新派发竞争则直接交还，由新命令选择其目标。子代理详情会返回列表以测布局，不保证恢复之前选中的子代理详情页。至少每角色两次访问且各有真实子代理行、有稳定顺序可比的成员对、真实 active/completed 行、90 秒可见指标和身份检查齐备才可 passed；缺覆盖为 incomplete，不能只看“没报错”。

负载覆盖要求五个指定根分别在其某次 UI 访问前后均为真实 running/preparing；PMO 则必须保持已完成。`coverage.rootActivity` 记录 expectedActiveRoles、observedRunningRoles、missingActiveRoles、completedPmoVerified 和 peak。五个角色中任何一个缺少真实运行覆盖，或 PMO 未完成，均不能 passed。历史 active 子代理不能替代根运行证据。

初始和每完成一轮六会话访问后，各用一次新鲜六根 API 并发读取来记录 activity sample，不使用陈旧缓存拼接并发。`peak` 是这些同批 API 观测中处于 running/preparing 的固定根数量最大值；每批保留开始/结束时间，属于有界非原子采样，不能宣称每毫秒的真实峰值或六根并发。至少一批覆盖五个指定活跃根才满足并发覆盖；五个互不重叠的运行片段不能拼成五根并发。此额外采样最多五批、每批六个轻量状态请求。

`failed` 也可能是脚本、互斥、能力或断言失败，须先看 errors，不能直接当作产品缺陷。

离线检查（不启动应用）：

```powershell
node --check scripts/office-ui-load-probe.mjs
node --test scripts/__tests__/office-ui-load-probe.test.mjs
```

离线测试验证统计、稳定序列以及五活跃根/一完成根的验收合同；真实 UI 适配、窗口能力和性能结果须由 root 安排上述现场调用后确认。
