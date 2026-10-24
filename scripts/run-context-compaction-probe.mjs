/** Real-model, resumable context study inside the campaign's existing Electron.
 * All conversation input uses the normal Work composer. The harness never
 * edits history, tokens, summaries or model settings. Synthetic business data
 * is identified as such; answer oracles stay outside the model's workspace.
 */
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { readFile, realpath, stat, open } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, basename, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertProbeDefaultAssistant } from './office-context-probe-lifecycle.mjs'

const BUDGET = 268_000, TARGET = 10
const sha = value => createHash('sha256').update(value).digest('hex')
const normalized = path => resolve(path).toLowerCase()
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }
const terminal = run => ['succeeded', 'failed', 'interrupted', 'cancelled', 'blocked'].includes(run?.status)
const textOf = row => typeof row?.content === 'string' ? row.content : JSON.stringify(row?.content ?? '')
const values = data => Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null
const now = () => new Date().toISOString()
const fileIdentity = info => ({ dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs })
const answerKeys = ['vendorCode', 'settlementWeekday', 'refundLimitFen', 'owner', 'rawBankExportAllowed', 'pendingAction', 'fileRevision', 'approvalCode']

/** A planning estimate only; the experiment records server/provider usage too. */
export function estimatePacketTokens(text) {
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const textTokens = Math.ceil(chinese * 1.5 + (text.length - chinese) * 0.25)
  return { textTokens, modelInputTokens: Math.ceil(textTokens * 1.2), characters: text.length, bytes: Buffer.byteLength(text) }
}

export function compactionStudyCohorts() {
  const owners = ['陈澄', '周岚', '宋霁', '林原', '方沐', '赵宁', '许禾', '沈川', '魏青', '程砚']
  const pending = ['核对银行对账回执', '补齐供应商签收记录', '复核跨日结算批次', '检查退款冲正凭证', '核验双人审批回执']
  return Array.from({ length: TARGET }, (_, index) => {
    const id = `C${String(index + 1).padStart(2, '0')}`
    const owner = randomInt(owners.length)
    const original = { vendorCode: `SYN-${randomBytes(5).toString('hex').toUpperCase()}`, settlementWeekday: randomInt(1, 6),
      refundLimitFen: randomInt(130_000, 390_000), owner: owners[owner], rawBankExportAllowed: false,
      pendingAction: `P-${randomBytes(4).toString('hex').toUpperCase()}-${pending[randomInt(pending.length)]}`, fileRevision: 1, approvalCode: null }
    const current = { ...original, refundLimitFen: randomInt(450_000, 940_000), owner: owners[(owner + randomInt(1, owners.length)) % owners.length],
      pendingAction: `P-${randomBytes(4).toString('hex').toUpperCase()}-${pending[randomInt(pending.length)]}`, fileRevision: 2 }
    return { id, file: `state/${id}.json`, original, current }
  })
}

/** Once a prompt has been admitted, its oracle is irreplaceable evidence.
 * Randomness belongs to business facts, not the text used to fill context. */
export function loadCompactionOracle(path, { resume = false, expectedHash } = {}) {
  if (!existsSync(path)) {
    assert.equal(resume, false, 'A resumed probe is missing its original oracle; never regenerate answers')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, generatedAt: now(),
      factSource: 'crypto-random-synthetic-business-values', cohorts: compactionStudyCohorts() }, null, 2), { flag: 'wx' })
  }
  const source = readFileSync(path, 'utf8'), oracle = JSON.parse(source), digest = sha(source)
  if (expectedHash) assert.equal(digest, expectedHash, 'The original oracle changed after the experiment began')
  assert.equal(oracle.schemaVersion, 1); assert.equal(oracle.factSource, 'crypto-random-synthetic-business-values')
  assert.equal(oracle.cohorts?.length, TARGET)
  assert.equal(new Set(oracle.cohorts.map(cohort => cohort.original.vendorCode)).size, TARGET)
  oracle.cohorts.forEach((cohort, index) => {
    const id = `C${String(index + 1).padStart(2, '0')}`
    assert.equal(cohort.id, id); assert.equal(cohort.file, `state/${id}.json`)
    for (const value of [cohort.original, cohort.current]) {
      assert.deepEqual(Object.keys(value).sort(), [...answerKeys].sort())
      assert.match(value.vendorCode, /^SYN-[A-F0-9]{10}$/)
      assert.ok(Number.isInteger(value.settlementWeekday) && value.settlementWeekday >= 1 && value.settlementWeekday <= 5)
      assert.ok(Number.isInteger(value.refundLimitFen) && value.refundLimitFen > 0)
      assert.ok(typeof value.owner === 'string' && value.owner.length > 0)
      assert.match(value.pendingAction, /^P-[A-F0-9]{8}-.+/)
      assert.equal(value.rawBankExportAllowed, false); assert.equal(value.approvalCode, null)
    }
    assert.equal(cohort.original.fileRevision, 1); assert.equal(cohort.current.fileRevision, 2)
    assert.equal(cohort.original.vendorCode, cohort.current.vendorCode)
    assert.equal(cohort.original.settlementWeekday, cohort.current.settlementWeekday)
    for (const key of ['refundLimitFen', 'owner', 'pendingAction']) assert.notEqual(cohort.original[key], cohort.current[key])
  })
  return { cohorts: oracle.cohorts, sha256: digest, generatedAt: oracle.generatedAt }
}

export function assessProbeHeadroom(view, summary, prompt, effectiveRatio) {
  const usage = [...(view.history || []).map(row => row.usage), ...(view.projection || []).map(row => row.usage)].filter(Boolean).at(-1)
  const observations = [usage?.currentPromptTokens, usage?.requestInputTokenEstimate].filter(value => Number.isFinite(value) && value > 0)
  const lastAnswer = (view.history || []).findLast(row => row.role === 'assistant')
  const lastAnswerEstimate = lastAnswer ? estimatePacketTokens(textOf(lastAnswer)).modelInputTokens : 0
  const inputEstimate = estimatePacketTokens(prompt).modelInputTokens
  const reserve = 16_384
  const threshold = Number.isFinite(effectiveRatio) && effectiveRatio > 0 ? Math.floor(BUDGET * Math.min(0.95, effectiveRatio)) : null
  const upper = observations.length ? Math.max(...observations, summary.postTokens) + lastAnswerEstimate + inputEstimate + reserve : null
  return { sufficient: upper !== null && threshold !== null && upper < threshold,
    observedCurrentInput: usage?.currentPromptTokens ?? null, observedRequestInputEstimate: usage?.requestInputTokenEstimate ?? null,
    summaryPostTokens: summary.postTokens, lastAnswerEstimate, closedPromptEstimate: inputEstimate,
    reserveTokens: reserve, conservativeNextInput: upper, compressionThreshold: threshold,
    method: 'Latest actual/request input plus final answer, closed prompt and 16K reserve; same-summary checks remain authoritative.' }
}

/** A retrieval turn may compact too. Only a summary created during the scored
 * business packet can stand in for that packet's automatic compaction. */
export function summaryBelongsToPacket(summary, packet) {
  const started = Date.parse(packet?.dispatchAttemptedAt ?? '')
  const finished = Date.parse(packet?.finishedAt ?? '')
  return packet?.kind === 'business-review' && packet.outcome === 'succeeded' &&
    summary?.id === packet.summaryIdAtCompletion && Number.isFinite(summary?.committedAt) &&
    Number.isFinite(started) && Number.isFinite(finished) &&
    summary.committedAt >= started && summary.committedAt <= finished &&
    (!summary.progress || summary.progress.runId === packet.runId)
}

export function assertActiveSummaryMatches(summary, durable) {
  assert.ok(durable && summary.id === durable.id, 'Visible summary must have a real committed JSONL row')
  assert.equal(sha(textOf(summary).replace(/^【历史上下文摘要】/, '')), durable.summarySha256,
    'The active summary content must match its committed physical payload')
}

export function assessCohortArchival(view, cohort) {
  const raw = (view.history || []).filter(row => !row.metadata?.isCompactSummary)
  const originalRows = raw.filter(row => [cohort.seedMessageId, cohort.correctionMessageId].includes(row.id) ||
    [cohort.seedRunId, cohort.correctionRunId].includes(row.metadata?.rootRunId))
  const markers = [cohort.current.vendorCode, cohort.original.pendingAction, cohort.current.pendingAction]
  const resurfaced = raw.filter(row => markers.some(marker => textOf(row).includes(marker)))
  return { passed: originalRows.length === 0 && resurfaced.length === 0,
    retainedOriginalIds: originalRows.map(row => row.id), resurfacedFactIds: resurfaced.map(row => row.id) }
}

/** Each record has operational meaning and a reviewable anomaly. No random or
 * repeated padding is used to force a token counter. */
export function buildBusinessPacket(index, targetTokens = 60_000) {
  assert.ok(Number.isInteger(targetTokens) && targetTokens >= 48_000 && targetTokens <= 64_000)
  const topics = ['采购结算', '退款回放', '支付回调', '账本迁移', '发布审查', '争议处理']
  const topic = topics[(index - 1) % topics.length], packetId = `B${String(index).padStart(3, '0')}`
  const rows = [], anomalous = []
  const header = `[合成业务审查 ${packetId}]\n这是专为本地可靠性实验生成的合成业务资料，不是真实客户、交易或线上操作指令。当前批次主题：${topic}。金额统一为整数分。每条记录是独立审核样本，有票据、账户类别、校验条件和处置说明。只审核资料，不发起支付、外部通信或真实部署；不重写已保存合同状态。\n本轮请核验全部记录的一致性，挑出至少三个存在明确风险的 recordId，说明不同类别的原因。不要照抄长资料或早期合同事实。返回一个 JSON 对象：{\"packetId\":\"${packetId}\",\"reviewedRows\":记录数,\"criticalIds\":[至少三个确有异常的recordId],\"risk\":\"简短审核结论\"}。可以利用本目录临时计算，但不能读其他任务。资料如下：\n`
  let body = '', ordinal = 0
  while (estimatePacketTokens(header + body).modelInputTokens < targetTokens) {
    ordinal++
    const recordId = `${packetId}-R${String(ordinal).padStart(4, '0')}`
    const kind = ordinal % 37 === 11 ? 'duplicate' : ordinal % 53 === 7 ? 'currency' : ordinal % 71 === 13 ? 'amount' : 'valid'
    const expectedFen = 1200 + ((index * 719 + ordinal * 137) % 88700)
    const row = { recordId, synthetic: true, topic, purchaseOrder: `PO-${index}-${ordinal}`, merchantClass: ['教育', '零售', '物流', '医疗'][ordinal % 4],
      amountFen: kind === 'amount' ? expectedFen + 101 : expectedFen, expectedFen, currency: kind === 'currency' ? 'USD' : 'CNY',
      contractCurrency: 'CNY', idempotencyKey: `PAY-${index}-${ordinal}`, successfulCommitCount: kind === 'duplicate' ? 2 : 1,
      providerStatus: 'settled', ledgerStatus: 'posted', settlementDate: `2026-${String(1 + ordinal % 12).padStart(2, '0')}-${String(1 + ordinal % 27).padStart(2, '0')}`,
      verification: '核对币种是否与合同一致，核对整数分是否与原票据一致，并确保一个幂等键只成功入账一次；异常先隔离待审，禁止自动补扣款。',
      remediation: ['先核对来源票据，再检查回调重试链，保留原始回执，退款与原付款独立记账。', '复核相同业务单号跨日回调，避免把已完成支付再次记为新款；状态推进必须单调。',
        '迁移时保留事件序号和业务键，影子表先对比合计再切换；回滚不得删除审计证据。'][ordinal % 3] }
    rows.push(row); if (kind !== 'valid') anomalous.push({ recordId, kind })
    body += JSON.stringify(row) + '\n'
  }
  return { packetId, prompt: header + body.trimEnd(), rowCount: rows.length, anomalous, ...estimatePacketTokens(header + body.trimEnd()) }
}

export function parseProbeJSON(text) {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  return JSON.parse(normalized)
}

export function assessRecall(answer, cohort) {
  const returned = answer?.answers
  const checks = answerKeys.map(key => ({ key, expected: cohort.current[key], actual: returned?.[key] ?? null,
    passed: returned != null && Object.prototype.hasOwnProperty.call(returned, key) && returned[key] === cohort.current[key] }))
  return { passed: answer?.cohort === cohort.id && checks.every(item => item.passed), cohort: cohort.id, checks,
    supersededValuesRejected: returned?.refundLimitFen !== cohort.original.refundLimitFen && returned?.owner !== cohort.original.owner,
    unknownAnsweredUnknown: returned?.approvalCode === null }
}

export function renderCompactionReport(result) {
  const cell = value => String(value ?? '未观测').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
  const mark = value => value === true ? '通过' : value === false ? '失败' : '未评估'
  const number = value => Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '未观测'
  const cycles = result.cycles || [], summaries = result.durableSummaries || []
  const stats = result.performance?.statistics || {}
  const measured = (key, divisor = 1) => {
    const row = stats[key]
    return row ? [row.count, (row.min / divisor).toFixed(2), (row.sum / row.count / divisor).toFixed(2), (row.max / divisor).toFixed(2)].join(' | ') : '0 | — | — | —'
  }
  const lines = [
    '# 上下文压缩可靠性实验', '',
    `执行完成：**${result.completed ? '是' : '否'}**；验收通过：**${result.passed ? '是' : '否'}**。已完成流程不等同于可靠性通过。`, '',
    `会话：\`${cell(result.sessionId)}\`。本次耗时：${number(result.durationMsThisInvocation / 1000)} 秒。物理落盘摘要 ${result.durableSummaryCount ?? 0} 个，已完成闭卷及归档恢复检查 ${cycles.filter(cycle => cycle.closed && cycle.retrieval).length}/10 轮。`, '',
    '## 样本与预算口径', '',
    result.hostBoundary?.kind === 'office'
      ? '- 真实数据库模型、正常 Work 输入框、新建隔离目录；在六个办公根任务空闲后独立运行，不计入办公并发负载时长，也不代表办公产物已验收。'
      : '- 真实数据库模型、正常 Work 输入框、新建隔离目录；原游戏任务已结束，本实验不计入双模式连续活跃时长。',
    '- 十份合成合同包含随机供应商编号、金额、责任人、结算日、待办；各有原始值与正式修订。Oracle 首次创建后固定，续跑校验 SHA-256。',
    '- 每轮闭卷先于归档检索，禁止全部工具；十轮使用不同合同。随后仅允许 search_history，并核验原始用户消息 ID 与工具回执。',
    '- 十轮只使用物理 JSONL 摘要且与当前活动投影一致的独立 summary UUID，并要求对应业务轮次成功。额外物理行单列为落盘计数，不单凭它宣称 SQL maintenance 已提交；工具清理及未评估摘要不抵扣十轮要求。',
    `- 固定有效预算：${number(result.budget?.runtime?.effectiveBudget)} tokens；模型有效预算：${number(result.budget?.effectiveWindow)}；模型能力窗口：${number(result.budget?.providerWindow)}。`,
    `- 实际 usage.contextWindow 观测：${[...new Set((result.usageWindows || []).map(row => row.window))].map(number).join(', ') || '尚无'}；累计输入是规划估算，账单/实际 usage 独立保存在 JSON 中。`,
    `- Oracle SHA-256：\`${cell(result.oracleSha256)}\`。会话/全局记忆有效 scopes 必须为空。`, '',
    '服务端累计 sessionUsage（保留原字段语义，不把估算值推断成服务商账单）：', '',
    '| 字段 | 数值 |', '| --- | ---: |',
    ...Object.entries(result.sessionUsage || {}).filter(([, value]) => Number.isFinite(value)).map(([key, value]) => `| ${cell(key)} | ${number(value)} |`), '',
    `最大输入预检：${number(Math.max(...(result.inputTransportEvidence?.packetSizeSamples || []).map(row => row.serializedMessageBytes), 0))} bytes；admission 上限 ${number(result.inputTransportEvidence?.admissionBodyLimitBytes)} bytes。每次发送前核验输入框全文，并在接纳后比对持久化用户消息 SHA-256。`, '',
    '## 各轮结果', '',
    '| 轮次 | 摘要 UUID | 压缩前 | 压缩后 | 缩减比例 | 压缩耗时 | 闭卷 | 同一摘要 | 归档恢复 |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...cycles.map(cycle => {
      const summary = summaries.find(item => item.id === cycle.summaryId)
      const ratio = cycle.beforeTokens > 0 ? ((1 - cycle.afterTokens / cycle.beforeTokens) * 100).toFixed(1) + '%' : '未观测'
      return `| ${cycle.index} | ${cell(cycle.summaryId)} | ${number(cycle.beforeTokens)} | ${number(cycle.afterTokens)} | ${ratio} | ${summary?.elapsedMs != null ? (summary.elapsedMs / 1000).toFixed(1) + 's' : '未观测'} | ${mark(cycle.closed?.passed)} | ${mark(cycle.closed?.sameSummary)} | ${mark(cycle.retrieval?.passed)} |`
    }), '',
    '压缩耗时仅引用实际观测到的开始/完成事件；仅有落盘摘要时保留“未观测”，不推算服务商耗时。闭卷前检查原始事实已退出保留上下文，并检查距离压缩阈值的余量；回答后摘要变化会使该轮归因失败。', '',
    '## 闭卷字段与文件完整性', '',
    '| 轮次 | 供应商 | 结算日 | 修订限额 | 修订责任人 | 禁止导出 | 未完成事项 | 文件版本 | 未知审批 | 拒绝旧值 | 无工具 | 文件不变 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...cycles.map(cycle => `| ${cycle.index} | ${answerKeys.map(key => mark(cycle.closed?.checks?.find(check => check.key === key)?.passed)).join(' | ')} | ${mark(cycle.closed?.supersededValuesRejected)} | ${mark(cycle.closed?.noTools)} | ${mark(cycle.closed?.filesUnchanged)} |`), '',
    '表内审批检查要求显式 null，不能编造。每轮对全部十个真实 JSON 文件做前后 SHA-256 对照；详细字段断言和文件哈希保存在 JSON，报告不复述答案。', '',
    '## 归档检索证据', '',
    '| 轮次 | 原始消息 ID | 实际引用 | 回执包含原始 ID | 仅历史检索 |',
    '| --- | --- | --- | --- | --- |',
    ...cycles.map(cycle => `| ${cycle.index} | ${cell(cycle.retrieval?.expectedOriginalIds?.join(', '))} | ${cell(cycle.retrieval?.citations?.join(', '))} | ${mark(cycle.retrieval?.searchedOriginals)} | ${mark(cycle.retrieval?.onlyHistorySearch)} |`), '',
    '## 页面与进程', '',
    `压缩页面阶段观测：${[...new Set((result.uiSamples || []).map(row => row.phase).filter(Boolean))].join(', ') || '尚无'}。实际 UI 生命周期验收：${mark(result.uiLifecycleObserved)}。`,
    `新增 renderer 错误 ${(result.errorDeltas?.renderer || []).length} 条，桌面进程错误 ${(result.errorDeltas?.process || []).length} 条，renderer 崩溃 ${(result.errorDeltas?.rendererCrashes || []).length} 条。`, '',
    '## 资源采样', '',
    '| 指标 | 有效样本 | 最小 | 均值 | 最大 |', '| --- | ---: | ---: | ---: | ---: |',
    `| 引擎 CPU（单逻辑核 %） | ${measured('engineCpuPercentOneCore')} |`,
    `| 引擎 RSS（MiB） | ${measured('engineRssBytes', 1048576)} |`,
    `| 引擎 private（MiB） | ${measured('enginePrivateBytes', 1048576)} |`,
    `| 受限进程树 RSS（MiB） | ${measured('processTreeRssBytes', 1048576)} |`,
    `| V8 heap used（MiB） | ${measured('heapUsedBytes', 1048576)} |`,
    `| 读 I/O（MiB/s） | ${measured('readBytesPerSecond', 1048576)} |`,
    `| 写 I/O（MiB/s） | ${measured('writeBytesPerSecond', 1048576)} |`,
    `| 事件循环利用率（0–1） | ${measured('eventLoopUtilization')} |`,
    `| 各采样区间事件循环 p95（ms） | ${measured('eventLoopP95Ms')} |`,
    `| 诊断采集耗时（ms） | ${measured('diagnosticsCollectionMs')} |`, '',
    `OS 诊断 ${result.performance?.diagnosticSamples || 0} 次；runtime ${result.performance?.runtimeSamples || 0} 次，其中事件循环可用 ${result.performance?.eventLoopAvailable || 0} 次、预热 ${result.performance?.eventLoopWarming || 0} 次。`,
    `最近磁盘可用 ${number(result.performance?.latestDisk?.availableBytes)} bytes；缓存存储统计 ${number(result.performance?.latestStorage?.totalBytes)} bytes。`,
    'OS 诊断每 30 秒、runtime 每 10 秒按需读取；不强制磁盘全量扫描。JSONL 逐条保留采样间隔和 unavailable/warming；长请求造成的缺口不填成零。I/O 含文件、管道和设备，不能等同于纯磁盘 I/O；上表为样本统计，不是无间断监测。', '',
    '## 问题与限制', '',
    ...(result.issues || []).map(issue => `- ${cell(issue.at)} ${cell(issue.kind)}：${cell(issue.message || issue.context || issue.summaryId)}`),
    ...(result.error ? [`- 未完成原因：${cell(result.error.message || result.error)}`] : []),
    '- 合成业务资料仅用于本地可靠性验证；十次样本不能证明所有长会话均可靠。',
    '- 多页摘要可能产生更多服务商请求；不承诺一小时内完成，也不通过降低 268K 预算来制造压缩。',
    '- usage.contextWindow 表示引擎应用的有效上限，不表示服务商实测输入恰为 268K。sessionUsage 也不能证明已包含摘要子请求的完整费用。',
    '- 12 小时是本次观察/发送期限；到期保留未完成请求，不自动取消引擎中已经发出的模型调用。',
    '- 断线、未知发送、失败轮次及证据缺失均保留；不自动重发未知写操作、不把最终完成等同于通过。', ''
  ]
  return lines.join('\n')
}

function extractFinal(rows) {
  return rows.filter(row => row.role === 'assistant' && !row.toolCall && textOf(row).trim()).map(textOf).at(-1) || ''
}
function toolsIn(rows) { return rows.filter(row => row.role === 'assistant' && row.toolCall).map(row => row.toolCall) }
function seedPrompt(cohort) {
  return `[业务合同 ${cohort.id} 初始登记]\n这是合成采购与退款审查项目的独立合同，后续会持续审查其他资料，并检查你的跨轮上下文可靠性。当前事实：${JSON.stringify(cohort.original)}。星期数字按星期一=1。approvalCode 尚未提供，必须保留 null，不能编造。rawBankExportAllowed=false 是持续禁止约束，不得把完整银行账号导出或外传。pendingAction 尚未完成，不能写成已完成。\n在当前工作目录创建 ${cohort.file}，内容严格为上述对象（这是实际文件状态），用工具核对文件确实落盘。只回复已完成及相对路径，不重复所有事实。只能操作本任务目录，不读取其他项目、harness 文件或系统环境；不要把任何事实写入长期记忆。`
}
function correctionPrompt(cohort) {
  const patch = Object.fromEntries(['refundLimitFen', 'owner', 'pendingAction', 'fileRevision'].map(key => [key, cohort.current[key]]))
  return `[业务合同 ${cohort.id} 正式修订]\n本条明确替代初始登记中的同名字段：${JSON.stringify(patch)}。其余字段和禁止约束保持；旧限额、旧责任人不可继续作为当前值。更新并核对 ${cohort.file} 的真实内容。pendingAction 仍待完成，approvalCode 仍未被提供。只短答修订已落盘，禁止重复全部合同事实；不要写长期记忆。`
}
function recallPrompt(cohort, retrieval = false) {
  const shape = `返回且只返回一个 JSON 对象，cohort 为 ${cohort.id}，answers 的键为 ${answerKeys.join(', ')}；未知值使用 JSON null，数字/布尔值保持类型。`
  return retrieval
    ? `[归档可恢复性 ${cohort.id}]\n现在单独允许 search_history，只检索本会话中该合同的“初始登记”和“正式修订”原始用户消息。不得使用其他工具或读文件，也不要把先前闭卷回答当来源。${shape} 另增加 citations 数组，列出你本轮实际检索到的两条原始用户 messageId，按修订优先恢复当前事实。不要查询其他合同或任何评测答案。`
    : `[闭卷上下文复核 ${cohort.id}]\n这是压缩后的闭卷复核。本轮禁止所有工具调用，不得读取历史、文件、长期记忆、网络或环境；只根据目前已提供给模型的上下文回答。不要重做任务或改变文件。${shape} 请答当前供应商代码、结算星期、修订后退款限额与责任人、原始银行账号导出是否允许、尚未完成事项、当前已落盘文件版本，以及尚未告知的审批代码。不确定就回答 null，禁止猜测。`
}

export function probeFolderPickerOverride(app, workspace) {
  const token = randomBytes(16).toString('hex')
  return {
    install: () => app.evaluate(({ dialog }, { workspace, token }) => {
      const key = Symbol.for('aether.context-probe.folder-picker')
      if (globalThis[key]) throw new Error('Another probe owns the folder picker')
      const original = dialog.showOpenDialog
      const wrapper = async () => {
        dialog.showOpenDialog = original; delete globalThis[key]
        return { canceled: false, filePaths: [workspace] }
      }
      globalThis[key] = { token, original, wrapper }; dialog.showOpenDialog = wrapper
    }, { workspace, token }),
    restore: () => app.evaluate(({ dialog }, token) => {
      const key = Symbol.for('aether.context-probe.folder-picker'), slot = globalThis[key]
      if (!slot) return
      if (slot.token !== token || dialog.showOpenDialog !== slot.wrapper) throw new Error('Folder picker owner changed; cannot restore another owner')
      dialog.showOpenDialog = slot.original; delete globalThis[key]
    }, token),
  }
}

export async function runCompactionProbe({ app, page, state, request, artifact, log, options = {} }) {
  assert.ok(app && page && state?.runRoot && typeof request === 'function')
  const root = resolve(state.runRoot), probeRoot = join(root, 'context-compaction-probe')
  const workspace = join(probeRoot, 'workspace'), evidence = join(probeRoot, 'evidence'), stateFile = join(probeRoot, 'state.json')
  const packetTokens = Number(options.packetTokens ?? process.env.AETHER_COMPACTION_PACKET_TOKENS ?? 60_000)
  assert.ok(Number.isInteger(packetTokens) && packetTokens >= 48_000 && packetTokens <= 64_000)
  const duration = Number(options.maxDurationMs ?? 12 * 60 * 60_000)
  assert.ok(Number.isFinite(duration) && duration > 0)
  const enteredAt = Date.now(), deadline = enteredAt + duration
  const officeHost = options.hostContext === 'office'
  const originalTaskId = officeHost ? options.restoreTaskId : state.modes.work.sessionId
  assert.ok(typeof originalTaskId === 'string' && originalTaskId.length, 'The primary Work selection must be explicitly restorable')
  const originalMode = await page.locator('#mode-code').getAttribute('aria-hidden') === 'false' ? 'code' : 'work'
  for (const path of [probeRoot, workspace, evidence]) mkdirSync(path, { recursive: true })
  assert.ok(inside(root, await realpath(workspace)))
  const resuming = existsSync(stateFile)
  let probe = resuming ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
    schemaVersion: 1, createdAt: now(), workspace, modelId: state.modelId, targetBudget: BUDGET, targetCycles: TARGET, packetTokens,
    phase: 'preflight', sessionId: null, records: [], cycles: [], durableSummaries: [], compactionEvents: [], issues: [], segments: [],
    nextPacket: 1, transcript: null, observedUsageWindows: [], uiSamples: [], closedBookPolicy: 'no-tools; ten disjoint cohorts; oracle never sent back',
    fixtureKind: 'synthetic business records, not real financial data' }
  assert.equal(probe.schemaVersion, 1); assert.equal(normalized(probe.workspace), normalized(workspace))
  assert.equal(probe.modelId, state.modelId); assert.equal(probe.targetBudget, BUDGET); assert.equal(probe.targetCycles, TARGET)
  assert.equal(probe.packetTokens, packetTokens, 'Resume retains the original packet plan')
  const oracle = loadCompactionOracle(join(evidence, 'oracle.json'), { resume: resuming, expectedHash: probe.oracleSha256 })
  const cohorts = oracle.cohorts
  probe.oracleSha256 = oracle.sha256
  probe.oracleGeneratedAt = oracle.generatedAt
  const save = () => { writeFileSync(stateFile + '.tmp', JSON.stringify(probe, null, 2)); renameSync(stateFile + '.tmp', stateFile) }
  const write = (name, data) => { assert.match(name, /^[\w.-]+$/); writeFileSync(join(evidence, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2)) }
  const emit = (kind, data = {}) => log?.('compaction-probe-' + kind, data)
  const note = (kind, detail) => { probe.issues.push({ at: now(), kind, ...detail }); save(); emit(kind, detail) }
  save()
  const transient = error => /timeout|timed out|abort|请求超时|网络|ECONN|ETIMED|fetch failed|network|socket/i.test(String(error?.message || error)) || error?.httpStatus >= 500 || [408, 429].includes(error?.httpStatus)
  async function readRetry(label, read) {
    for (let attempt = 1; ; attempt++) {
      try { return await read() }
      catch (error) {
        if (!transient(error) || attempt >= 3 || Date.now() >= deadline) throw error
        note('read-gap', { context: label, attempt, message: String(error.message) })
        await delay(Math.min(attempt * 500, Math.max(0, deadline - Date.now())))
      }
    }
  }
  const api = (method, path, body, query) => method === 'GET'
    ? readRetry(method + ' ' + path, () => request(method, path, body, query, 'work'))
    : request(method, path, body, query, 'work')
  let lastMemoryProof = 0
  let lastMetrics = 0, lastRuntime = 0
  const errorBaseline = { renderer: state.rendererErrors?.length || 0, process: state.processErrors?.length || 0 }
  const rendererCrashes = []
  const onRendererCrash = () => rendererCrashes.push({ at: now(), message: 'probe Electron renderer crashed' })
  page.on('crash', onRendererCrash)
  const errorDelta = () => ({ renderer: (state.rendererErrors || []).slice(errorBaseline.renderer),
    process: (state.processErrors || []).slice(errorBaseline.process), rendererCrashes: [...rendererCrashes] })
  probe.performance ||= { diagnosticSamples: 0, runtimeSamples: 0, eventLoopAvailable: 0, eventLoopWarming: 0, peaks: {} }
  const peak = (key, value) => {
    if (!Number.isFinite(value)) return
    probe.performance.peaks[key] = Math.max(value, probe.performance.peaks[key] ?? value)
    probe.performance.statistics ||= {}
    const previous = probe.performance.statistics[key]
    probe.performance.statistics[key] = { count: (previous?.count || 0) + 1, sum: (previous?.sum || 0) + value,
      min: Math.min(previous?.min ?? value, value), max: Math.max(previous?.max ?? value, value) }
  }
  const sampleContext = () => ({ at: now(), phase: probe.phase, recordId: probe.records.at(-1)?.id ?? null,
    runId: probe.records.at(-1)?.runId ?? null, summaryId: probe.latestSummaryId ?? null,
    compaction: probe.compactionEvents.at(-1) ?? null })
  async function samplePerformance(force = false) {
    let changed = false
    if (force || Date.now() - lastMetrics >= 30_000) {
      changed = true
      const started = Date.now()
      try {
        const diagnostics = await readRetry('OS diagnostics', () => page.evaluate(() => window.aether.engine.diagnostics({ refreshStorage: false })))
        const resource = diagnostics.resources
        appendFileSync(join(evidence, 'metrics.jsonl'), JSON.stringify({ ...sampleContext(), observationGapMs: lastMetrics ? started - lastMetrics : null, diagnostics }) + '\n')
        probe.performance.diagnosticSamples++
        peak('engineCpuPercentOneCore', resource.cpu?.percent); peak('engineRssBytes', resource.memory?.rssBytes)
        peak('enginePrivateBytes', resource.memory?.privateBytes); peak('processTreeRssBytes', resource.processTree?.totals?.memory?.rssBytes)
        peak('readBytesPerSecond', resource.io?.readBytesPerSecond); peak('writeBytesPerSecond', resource.io?.writeBytesPerSecond)
        peak('processReadBytes', resource.io?.readBytes); peak('processWriteBytes', resource.io?.writeBytes)
        peak('diagnosticsCollectionMs', resource.collection?.durationMs)
        probe.performance.latestDisk = resource.disk; probe.performance.latestStorage = diagnostics.storage
      } catch (error) { note('metrics-unavailable', { message: String(error.message) }) }
      lastMetrics = Date.now()
    }
    // Runtime instrumentation idles after 15s; keep interested-client reads at
    // 10s and preserve warming/gap evidence when a slower operation intervenes.
    if (force || Date.now() - lastRuntime >= 10_000) {
      changed = true
      const started = Date.now()
      let runtime
      try { runtime = await api('GET', '/performance/runtime') }
      catch (error) { note('runtime-metrics-unavailable', { message: String(error.message) }) }
      if (runtime) {
        assert.equal(runtime.instanceId, probe.segments.at(-1)?.engine.instanceId, 'Metrics came from a different engine')
        appendFileSync(join(evidence, 'runtime.jsonl'), JSON.stringify({ ...sampleContext(), observationGapMs: lastRuntime ? started - lastRuntime : null, runtime }) + '\n')
        probe.performance.runtimeSamples++
        if (runtime.eventLoop.state === 'available') probe.performance.eventLoopAvailable++
        else probe.performance.eventLoopWarming++
        peak('heapUsedBytes', runtime.memory?.heapUsedBytes); peak('heapTotalBytes', runtime.memory?.heapTotalBytes)
        peak('externalBytes', runtime.memory?.externalBytes); peak('eventLoopUtilization', runtime.eventLoop?.utilization)
        peak('eventLoopP95Ms', runtime.eventLoop?.delay?.p95Ms); peak('eventLoopMaxMs', runtime.eventLoop?.delay?.maxMs)
      }
      lastRuntime = Date.now()
    }
    if (changed) save()
  }
  const snapshot = async () => {
    const value = await api('GET', '/chat/snapshot', undefined, { sessionId: probe.sessionId })
    assert.equal(value.sessionId, probe.sessionId)
    return value
  }
  const getRuns = async () => {
    const result = await api('GET', '/chat/runs', undefined, { sessionId: probe.sessionId })
    assert.ok(Array.isArray(result.runs))
    for (const run of result.runs) {
      assert.equal(run.sessionId, probe.sessionId)
      assert.equal(run.modelId, probe.modelId)
      assert.ok(run.actualModelId == null || run.actualModelId === probe.modelId, 'The admitted probe model changed')
      assert.equal(run.workspacePaths?.length, 1); assert.equal(normalized(run.workspacePaths[0]), normalized(workspace))
      assertProbeDefaultAssistant(run)
      const event = run.compaction
      if (event && !probe.compactionEvents.some(item => item.runId === run.runId && item.startedAt === event.startedAt && item.phase === event.phase)) {
        probe.compactionEvents.push({ runId: run.runId, ...event }); save(); emit('summary-progress', { runId: run.runId, ...event })
      }
    }
    const current = result.runs.at(-1)
    if (current) {
      const sample = await page.locator('#mode-work').evaluate(surface => {
        const ring = surface.querySelector('.context-ring')
        return { phase: ring?.getAttribute('data-compaction-phase') ?? null, label: ring?.getAttribute('aria-label') ?? null,
          source: ring?.getAttribute('data-context-source') ?? null }
      })
      const signature = JSON.stringify([current.runId, current.compaction?.startedAt, sample.phase, sample.source])
      probe.uiSamples ||= []
      if (!probe.uiSamples.some(item => item.signature === signature)) {
        probe.uiSamples.push({ signature, at: now(), runId: current.runId, backendPhase: current.compaction?.phase ?? null, ...sample })
        save()
        if (sample.phase === 'running') await page.screenshot({ path: join(evidence, `ui-compaction-${current.compaction?.startedAt || Date.now()}.png`) })
      }
    }
    return result.runs
  }
  const workState = () => page.evaluate(async () => {
    const engine = await window.aether.engine.getSnapshot()
    const endpoint = engine.mode === 'embedded' ? '' : 'remote:' + engine.baseUrl.replace(/\/+$/, '')
    const source = engine.accountId ? endpoint + ':account:' + engine.accountId : endpoint
    const key = 'aether.work.state.v1' + (source ? ':' + encodeURIComponent(source) : '')
    return JSON.parse(localStorage.getItem(key) || 'null')
  })
  async function selectWork() {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden', 'false')
  }
  async function activateTask(id) {
    await selectWork()
    const stored = await workState(), task = stored?.tasks.find(item => item.id === id)
    assert.ok(task, 'Existing Work task must be present in the current account')
    if (stored.activeTaskId !== id) {
      const expand = page.locator('#mode-work').getByRole('button', { name: '展开 Work 导航', exact: true })
      if (await expand.isVisible()) await expand.click()
      const candidate = page.locator('#mode-work .work-sidebar__task').filter({ has: page.locator('span').filter({ hasText: new RegExp('^' + task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) })
      if (await candidate.count() === 1) await candidate.click()
      else {
        await page.locator('#mode-work .work-new-task').click()
        const row = page.locator('#mode-work .work-task-row').filter({ hasText: task.title }).filter({ hasText: basename(task.workspacePath || '') })
        assert.equal(await row.count(), 1, 'Task selection must be unambiguous'); await row.click()
      }
    }
    await expect.poll(async () => (await workState())?.activeTaskId, { timeout: 30_000 }).toBe(id)
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId), { timeout: 30_000 }).toBe(id)
    return task
  }
  async function assertIdentity() {
    options.checkExclusive?.()
    const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
    assert.equal(engine.phase, 'ready'); assert.equal(engine.instanceId, probe.segments.at(-1).engine.instanceId)
    assert.equal(engine.accountId, state.engine.accountId); assert.equal(engine.baseUrl, state.engine.baseUrl)
    const errors = errorDelta()
    assert.equal(errors.renderer.length + errors.process.length + errors.rendererCrashes.length, 0, 'New desktop/renderer failure during the probe; error deltas are preserved')
    if (probe.sessionId && Date.now() - lastMemoryProof >= 30_000) {
      const memory = await api('GET', '/memory/settings', undefined, { sessionId: probe.sessionId })
      assert.equal(memory.sessionOverride, false); assert.equal(memory.sessionEnabled, false)
      assert.deepEqual(memory.effectiveScopes, [], 'No global/session memory injection may contaminate this study')
      lastMemoryProof = Date.now()
    }
  }
  async function readTurn(run) {
    const rows = []
    for (let current = 1; current <= 20; current++) {
      const result = values(await api('GET', '/conversations/' + encodeURIComponent(run.turnId), undefined, { current, pageSize: 100 }))
      assert.ok(result, 'Malformed turn history')
      rows.push(...result)
      if (result.length < 100) return rows
    }
    throw new Error('Turn exceeded bounded 2,000-message evidence read; cannot attest to all tool calls')
  }
  async function readPhysicalTurn(record) {
    assert.ok(record.physicalTurnStart && probe.transcript, 'Scored turns require a pre-dispatch physical transcript boundary')
    const path = await realpath(record.physicalTurnStart.path)
    assert.ok(inside(root, path)); assert.equal(normalized(path), normalized(probe.transcript.path))
    const file = await open(path, 'r'), rows = [], updates = [], destructive = []
    let info
    const start = record.physicalTurnStart.offset
    try {
      info = await file.stat()
      assert.deepEqual(fileIdentity(info), record.physicalTurnStart.identity, 'Transcript file was replaced after the scored question was prepared')
      assert.ok(info.size >= start, 'Transcript was truncated during a scored turn')
      let position = start, pending = Buffer.alloc(0)
      while (position < info.size) {
        const chunk = Buffer.alloc(Math.min(512 * 1024, info.size - position))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
        assert.ok(bytesRead > 0, 'Transcript changed while collecting scored-turn evidence')
        position += bytesRead; pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        let end
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end).toString('utf8').trim(); pending = pending.subarray(end + 1)
          if (!line) continue
          const row = JSON.parse(line)
          assert.equal(row.sessionId, probe.sessionId)
          assert.equal(row.tenantId, probe.transcript.tenantId)
          if (['clear', 'truncate', 'tombstone'].includes(row.type)) destructive.push({ type: row.type, uuid: row.uuid })
          if (row.type === 'update') updates.push(row)
          if (['user', 'assistant', 'tool', 'system'].includes(row.type) &&
            (row.conversationId === record.turnId || row.payload?.conversationId === record.turnId)) {
            assert.ok(row.payload && typeof row.payload === 'object')
            assert.equal(row.payload.id, row.uuid); assert.equal(row.payload.role, row.type)
            assert.equal(row.conversationId, row.payload.conversationId)
            rows.push({ ...row.payload, id: row.payload.id || row.uuid, role: row.payload.role || row.type, content: row.payload.content ?? '', dbId: row.dbSeq })
          }
        }
        assert.ok(pending.length < 8 * 1024 * 1024, 'Scored transcript row exceeds the bounded evidence reader')
        assert.ok(rows.length <= 2000, 'Scored turn exceeded bounded physical receipt count')
      }
      assert.equal(pending.length, 0, 'Terminal turn transcript has an incomplete final row')
      const after = await file.stat(), pathAfter = await stat(path)
      assert.deepEqual(fileIdentity(after), fileIdentity(info)); assert.deepEqual(fileIdentity(pathAfter), fileIdentity(info))
      assert.equal(after.size, info.size); assert.equal(after.mtimeMs, info.mtimeMs)
      assert.equal(pathAfter.size, info.size); assert.equal(pathAfter.mtimeMs, info.mtimeMs)
    } finally { await file.close() }
    assert.equal(destructive.length, 0, 'History deletion/truncation prevents a complete scored-turn proof')
    const unexpectedUpdates = updates.filter(row => row.content !== '[tool result cleared]' || row.archiveContent === undefined)
    assert.equal(unexpectedUpdates.length, 0, 'External history edits contaminate a scored turn')
    const user = rows.find(row => row.role === 'user' && row.id === record.userMessageId)
    assert.ok(user && sha(textOf(user)) === record.promptSha256, 'Physical turn must include the exact admitted user prompt')
    record.physicalTurnProof = { source: 'append-only JSONL suffix from pre-dispatch boundary', path,
      startOffset: start, endOffset: info.size, identity: fileIdentity(info), stableDuringRead: true, rowCount: rows.length, updatesObserved: updates.length,
      originalPayloads: true, destructiveRows: destructive.length }
    // Keep original tool output even if a later microcompact update replaces
    // its active projection. Updates are evidence too, never silently omitted.
    write(record.id + '-physical-updates.json', updates)
    return rows
  }
  async function observeSummaries() {
    const view = await snapshot()
    probe.sessionUsage = view.sessionUsage
    const summary = view.history?.find(row => row.role === 'system' && row.metadata?.isCompactSummary === true)
    if (!summary) { probe.latestSummaryId = null; save(); return view }
    assert.ok(summary.id && summary.metadata.transcriptPath, 'Durable JSONL provenance is required for the experiment')
    const path = await realpath(summary.metadata.transcriptPath)
    assert.ok(inside(root, path), 'Transcript must remain inside this campaign')
    if (!probe.transcript) probe.transcript = { path, offset: 0 }
    assert.equal(normalized(path), normalized(probe.transcript.path))
    const info = await stat(path)
    if (probe.transcript.identity) assert.deepEqual(fileIdentity(info), probe.transcript.identity, 'The physical summary transcript was replaced')
    else probe.transcript.identity = fileIdentity(info)
    assert.ok(info.size >= probe.transcript.offset, 'Transcript was truncated; previous evidence cannot be reused')
    const file = await open(path, 'r')
    try {
      let position = probe.transcript.offset, pending = Buffer.alloc(0), committed = position
      while (position < info.size) {
        const chunk = Buffer.alloc(Math.min(512 * 1024, info.size - position))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
        if (!bytesRead) break
        position += bytesRead; pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        let end
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end).toString('utf8').trim()
          committed += end + 1; pending = pending.subarray(end + 1)
          if (!line) continue
          const row = JSON.parse(line)
          assert.equal(row.sessionId, probe.sessionId)
          if (!probe.transcript.tenantId) probe.transcript.tenantId = row.tenantId
          assert.ok(typeof probe.transcript.tenantId === 'string' && probe.transcript.tenantId)
          assert.equal(row.tenantId, probe.transcript.tenantId)
          if (row.type !== 'summary') continue
          assert.equal(row.sessionId, probe.sessionId)
          assert.ok(typeof row.uuid === 'string' && typeof row.summary === 'string' && row.summary.trim())
          assert.ok(Number.isFinite(row.preTokens) && Number.isFinite(row.postTokens) && row.postTokens < row.preTokens)
          const previous = probe.durableSummaries.find(item => item.id === row.uuid)
          if (previous) { assert.equal(previous.summarySha256, sha(row.summary), 'A summary UUID was reused with different content'); continue }
          const committedAt = Date.parse(row.timestamp)
          const progress = probe.compactionEvents.findLast(item => item.phase === 'succeeded' && item.startedAt <= committedAt && item.finishedAt + 2000 >= committedAt)
          const entry = { id: row.uuid, committedAt, summarySha256: sha(row.summary), preTokens: row.preTokens, postTokens: row.postTokens,
            leafUuid: row.leafUuid, leafSeq: row.leafSeq, retainedUuids: row.retainedUuids || [],
            durableSource: 'persisted append-only JSONL summary row; active projection also required for tested cycles', progress: progress || null,
            elapsedMs: progress ? progress.finishedAt - progress.startedAt : null,
            progressObservation: progress ? 'observed-terminal-progress' : 'commit-only; duration not observed' }
          probe.durableSummaries.push(entry)
          write(`summary-${row.uuid}.json`, { ...entry, summary: row.summary }); emit('summary-committed', entry)
        }
        assert.ok(pending.length < 8 * 1024 * 1024, 'Transcript row exceeds the bounded evidence reader')
      }
      probe.transcript.offset = committed
    } finally { await file.close() }
    assertActiveSummaryMatches(summary, probe.durableSummaries.find(item => item.id === summary.id))
    probe.latestSummaryId = summary.id; save(); return view
  }
  async function settle(record) {
    let lastNotice = 0
    while (Date.now() < deadline) {
      await assertIdentity()
      await samplePerformance()
      const runs = await getRuns()
      let run = record.runId ? runs.find(item => item.runId === record.runId) : undefined
      if (!run) {
        const candidates = runs.filter(item => !record.beforeRunIds.includes(item.runId))
        if (candidates.length > 1) throw new Error(`${record.id}: ambiguous new admissions; no automatic resend`)
        if (candidates.length === 1) {
          const rows = await readTurn(candidates[0])
          const seed = rows.find(row => row.role === 'user' && row.id === candidates[0].userMessageId)
          if (seed && sha(textOf(seed)) === record.promptSha256) {
            run = candidates[0]; record.runId = run.runId; record.turnId = run.turnId; record.userMessageId = run.userMessageId
            record.admissionProof = { source: 'full-run-list-and-exact-active-durable-user-message', at: now() }; save()
          } else if (seed) throw new Error(`${record.id}: admitted user prompt does not match the persisted exact prompt`)
        }
      }
      if (run && terminal(run)) {
        const current = await api('GET', '/chat/status', undefined, { sessionId: probe.sessionId })
        if (current.running || run.compaction?.phase === 'running') { await delay(2000); continue }
        const scored = ['closed-book', 'archive-recovery'].includes(record.kind)
        const rows = scored ? await readPhysicalTurn(record) : await readTurn(run)
        write(record.id + '-turn.json', rows)
        // Terminal evidence must be persisted before the record can be reused
        // on resume; a transient archive read cannot create a false completion.
        record.outcome = run.status; record.finishedAt = now(); record.phase = 'collecting-evidence'
        record.finalText = extractFinal(rows); record.tools = toolsIn(rows).map(tool => ({ id: tool.id, name: tool.name }))
        record.usage = rows.filter(row => row.usage).map(row => ({ messageId: row.id, usage: row.usage }))
        for (const row of rows) if (row.usage?.contextWindow !== undefined) {
          probe.observedUsageWindows.push({ recordId: record.id, window: row.usage.contextWindow })
          assert.equal(row.usage.contextWindow, BUDGET, 'Actual model-input usage must use 268K')
        }
        save(); await observeSummaries()
        record.summaryIdAtCompletion = probe.latestSummaryId
        record.phase = 'terminal'; save()
        if (run.status !== 'succeeded') throw new Error(`${record.id} ended ${run.status}; original failure preserved`)
        return rows
      }
      if (Date.now() - lastNotice > 30_000) {
        emit('waiting', { recordId: record.id, runId: record.runId, state: run?.status || 'admission-unconfirmed', testedCycles: probe.cycles.length })
        lastNotice = Date.now()
      }
      if (!record.runId && record.phase === 'prepared') throw new Error(`${record.id}: prepared but no UI dispatch was attempted; preserved without an automatic send`)
      if (!record.runId && Date.now() - Date.parse(record.dispatchAttemptedAt || record.startedAt) > 120_000) throw new Error(`${record.id}: admission remains unknown; persisted for reconciliation, not resent`)
      await delay(2000)
    }
    throw new Error('Independent compaction study deadline reached; incomplete evidence is preserved for resume')
  }
  async function turn(key, body, kind) {
    let record = probe.records.find(item => item.key === key)
    if (record?.phase === 'terminal') {
      assert.equal(record.outcome, 'succeeded', `${key}: prior failed turn is immutable`)
      return { record, rows: JSON.parse(await readFile(join(evidence, record.id + '-turn.json'), 'utf8')) }
    }
    if (record) return { record, rows: await settle(record) }
    assert.ok(!probe.records.some(item => item.phase !== 'terminal'), 'Resolve the pending submission before creating another')
    await activateTask(probe.sessionId)
    await assertIdentity()
    const before = await getRuns(); assert.ok(before.every(terminal), 'Probe task must be idle before another UI send')
    const id = `CP-${String(probe.records.length + 1).padStart(4, '0')}`
    const prompt = `[${id}]\n${body}`
    record = { id, key, kind, startedAt: now(), phase: 'prepared', promptSha256: sha(prompt), beforeRunIds: before.map(run => run.runId),
      promptFile: id + '-prompt.txt', ...estimatePacketTokens(prompt) }
    if (['closed-book', 'archive-recovery'].includes(kind)) {
      assert.ok(probe.transcript, 'A scored question requires an existing committed summary transcript')
      const info = await stat(probe.transcript.path)
      record.physicalTurnStart = { path: probe.transcript.path, offset: info.size, identity: fileIdentity(info) }
    }
    probe.records.push(record); write(record.promptFile, prompt); save()
    const surface = page.locator('#mode-work')
    const modelPicker = surface.getByRole('button', { name: 'Work 使用的模型', exact: true })
    await expect(modelPicker).toBeEnabled({ timeout: 90_000 })
    const composer = surface.locator('.work-composer .input-composer__input[role="textbox"]').first()
    await expect(composer).toBeEditable({ timeout: 90_000 }); await composer.fill(prompt)
    await expect(composer).toHaveText(prompt)
    const send = surface.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).last()
    await expect(send).toBeEnabled({ timeout: 90_000 })
    record.phase = 'dispatching'; record.dispatchAttemptedAt = now(); save()
    await send.click()
    record.phase = 'dispatched'; record.dispatchedAt = now(); save()
    await expect(composer).toHaveText('', { timeout: 30_000 })
    emit('sent', { id, kind, estimatedInputTokens: record.modelInputTokens })
    return { record, rows: await settle(record) }
  }

  let completed = false, activeSegment, folderPicker
  try {
    if (officeHost) {
      // The user ended the unfinished game campaign and moved to office work.
      // This host boundary does not claim game or office artifact acceptance.
      const sessions = Object.values(state.roles || {}).map(role => role.sessionId)
      assert.equal(sessions.length, 6); assert.equal(new Set(sessions).size, 6)
      assert.ok(sessions.includes(originalTaskId))
      for (const sessionId of sessions) {
        const current = await api('GET', '/chat/status', undefined, { sessionId })
        assert.equal(current.running, false); assert.ok(terminal(current.run), 'Office roots must be idle before the independent context experiment')
      }
      probe.hostBoundary = { kind: 'office', primarySessions: sessions, priorGames: 'closed-at-user-request-with-incomplete-acceptance', artifactAcceptanceImplied: false }
    } else {
      assert.equal(state.latestAudit?.passed, true, 'Run the independent game acceptance before this separate experiment')
      for (const mode of ['code', 'work']) {
        const current = await request('GET', '/chat/status', undefined, { sessionId: state.modes[mode].sessionId }, mode)
        assert.equal(current.running, false); assert.ok(terminal(current.run), 'Primary game roots must already be idle')
      }
    }
    const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
    const settings = await api('GET', '/settings')
    assert.equal(settings.runtimeLimits?.contextWindow?.effectiveBudget, BUDGET)
    const catalog = values(await api('GET', '/models'))
    const model = catalog?.find(item => item.modelId === probe.modelId && item.isEnabled)
    assert.ok(model, 'Use the enabled existing database model'); assert.equal(model.effectiveContextWindow, BUDGET)
    const preferences = await api('GET', '/memory/preferences')
    assert.equal(preferences.globalEnabled, false, 'Global memory must already be off; the probe will not change global defaults')
    probe.budgetEvidence = { at: now(), runtime: settings.runtimeLimits.contextWindow, compression: settings.runtimeLimits.compression,
      modelId: model.modelId, providerWindow: model.resolvedCapabilities?.contextWindow ?? model.capabilities?.contextWindow, effectiveWindow: model.effectiveContextWindow,
      summarizeModelConfigured: settings.LLM_SUMMARIZE_MODEL || null,
      summarizeModelObservation: 'Configured route only; fallback and per-summary provider usage are not attested by this observer' }
    const packetSizeSamples = [1, 6, 90].map(index => {
      const packet = buildBusinessPacket(index, 64_000)
      return { index, estimatedTokens: packet.modelInputTokens, promptBytes: packet.bytes,
        serializedMessageBytes: Buffer.byteLength(JSON.stringify({ message: '[CP-9999]\n' + packet.prompt })) }
    })
    assert.ok(packetSizeSamples.every(sample => sample.serializedMessageBytes + 65_536 < 2 * 1024 * 1024), 'Leave admission-envelope space below the actual 2 MiB request limit')
    probe.inputTransportEvidence = { inspectedAt: now(), httpBodyLimitBytes: 100 * 1024 * 1024, admissionBodyLimitBytes: 2 * 1024 * 1024,
      envelopeReserveBytes: 65_536, packetSizeSamples, composer: 'MentionInput contenteditable serializer; no maxLength; complete DOM text checked before click',
      storage: 'Immutable admission seed TEXT plus append-only JSONL payload; no per-message truncation on this path',
      sourceReferences: ['src/renderer/src/contrib/chat/MentionInput.tsx:154', '../ai-agent-engine/src/api/http/server.ts:60',
        '../ai-agent-engine/src/storage/root-admission/index.ts:23', '../ai-agent-engine/src/storage/root-admission/index.ts:119',
        '../ai-agent-engine/src/storage/conversation/jsonl-history.ts:703'] }
    activeSegment = { startedAt: now(), engine: { instanceId: engine.instanceId, accountId: engine.accountId, baseUrl: engine.baseUrl, buildId: engine.buildId } }
    probe.segments.push(activeSegment)
    save(); await samplePerformance(true); emit('preflight', { workspace, budget: BUDGET, targetCycles: TARGET, packetTokens })
    if (!probe.sessionId || !probe.records.some(item => item.key === 'bootstrap')) {
      await selectWork()
      const expand = page.locator('#mode-work').getByRole('button', { name: '展开 Work 导航', exact: true })
      if (await expand.isVisible()) await expand.click()
      await page.locator('#mode-work .work-new-task').click()
      await expect.poll(async () => (await workState())?.activeTaskId).toBeNull()
      if (officeHost) {
        await page.locator('#mode-work .work-navigation').getByRole('button', { name: 'Agent', exact: true }).click()
        await page.locator('.work-agent-manager__choose').filter({ hasText: '默认助手' }).click()
      }
      assert.ok(!(await workState())?.homeAgentId, 'The new probe task must select the default assistant before admission')
      // Reuse the normal folder workflow, but return only this explicit new
      // directory from its OS picker so the experiment opens no extra window.
      folderPicker = probeFolderPickerOverride(app, workspace)
      await folderPicker.install()
      await page.locator('#mode-work .work-folder-button').click()
      await expect(page.locator('#mode-work .work-folder-button')).toContainText(basename(workspace))
      const picker = page.locator('#mode-work').getByRole('button', { name: 'Work 使用的模型', exact: true })
      await expect(picker).toBeEnabled({ timeout: 90_000 }); await picker.click()
      await page.getByRole('menuitem', { name: new RegExp('^' + (model.displayName || model.modelId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
      await expect.poll(async () => (await workState())?.homeSessionId, { timeout: 30_000 }).toMatch(/^work-/)
      const homeSessionId = (await workState()).homeSessionId
      if (probe.sessionId) assert.equal(homeSessionId, probe.sessionId, 'A prepared home owner must not silently change on resume')
      probe.sessionId = homeSessionId; probe.phase = 'creating'; save()
      // This is the supported session override API, never a history write.
      probe.memoryBefore = await api('GET', '/memory/settings', undefined, { sessionId: probe.sessionId })
      await api('PUT', '/memory/settings', { sessionId: probe.sessionId, sessionEnabled: false })
      probe.memoryOverride = await api('GET', '/memory/settings', undefined, { sessionId: probe.sessionId })
      assert.equal(probe.memoryOverride.sessionOverride, false); assert.deepEqual(probe.memoryOverride.effectiveScopes, [])
      const prompt = '[压缩可靠性独立实验]\n这是单独的合成采购/退款业务审查项目。当前目录只属于本测试。后续逐条登记合同事实、修订、审核资料并验证自动上下文压缩后的可靠性。不得访问其他任务、真实网络或外部业务服务，不得写长期记忆。现在只回复“已准备接收合成资料”，不要调用工具。'
      const record = { id: 'CP-0001', key: 'bootstrap', kind: 'bootstrap', startedAt: now(), phase: 'prepared', promptSha256: sha(prompt), beforeRunIds: [], promptFile: 'CP-0001-prompt.txt', ...estimatePacketTokens(prompt) }
      probe.records.push(record); write(record.promptFile, prompt); save()
      const composer = page.locator('#mode-work .input-composer__input[role="textbox"]').filter({ visible: true }).first()
      await composer.fill(prompt)
      await expect(composer).toHaveText(prompt)
      const start = page.locator('#mode-work').getByRole('button', { name: '开始任务', exact: true })
      await expect(start).toBeEnabled({ timeout: 90_000 })
      record.phase = 'dispatching'; record.dispatchAttemptedAt = now(); save()
      await start.click()
      record.phase = 'dispatched'; record.dispatchedAt = now(); save()
      await expect.poll(async () => (await workState())?.activeTaskId, { timeout: 30_000 }).toBe(probe.sessionId)
      await settle(record)
    } else {
      await activateTask(probe.sessionId); await assertIdentity()
      const pending = probe.records.find(item => item.phase !== 'terminal')
      if (pending) await settle(pending)
    }
    probe.phase = 'seeding'; save()
    for (const cohort of cohorts) {
      const first = await turn(`seed-${cohort.id}`, seedPrompt(cohort), 'seed')
      const initialFile = join(workspace, cohort.file)
      if (!probe.records.some(item => item.key === `correct-${cohort.id}`)) assert.deepEqual(JSON.parse(await readFile(initialFile, 'utf8')), cohort.original)
      cohort.seedMessageId = first.record.userMessageId
      cohort.seedRunId = first.record.runId
      const updated = await turn(`correct-${cohort.id}`, correctionPrompt(cohort), 'correction')
      assert.deepEqual(JSON.parse(await readFile(initialFile, 'utf8')), cohort.current)
      cohort.correctionMessageId = updated.record.userMessageId
      cohort.correctionRunId = updated.record.runId
    }
    probe.phase = 'pressure'; save()
    while (probe.cycles.length < TARGET || probe.cycles.some(cycle => !cycle.closed || !cycle.retrieval)) {
      if (Date.now() >= deadline) throw new Error('Compaction study deadline reached before ten fully assessed cycles')
      let cycle = probe.cycles.find(item => !item.closed || !item.retrieval)
      if (!cycle) {
        const view = await observeSummaries()
        const latest = probe.durableSummaries.find(item => item.id === probe.latestSummaryId)
        const sourcePacket = probe.records.filter(item => item.kind === 'business-review' && item.outcome === 'succeeded').at(-1)
        if (summaryBelongsToPacket(latest, sourcePacket) && !probe.cycles.some(item => item.summaryId === latest.id || item.sourcePacketId === sourcePacket.id)) {
          const cohort = cohorts[probe.cycles.length]
          const archival = assessCohortArchival(view, cohort)
          assert.ok(archival.passed, 'Original contract rows or unique fact markers remain in raw context; cannot attribute recall to compression')
          const headroom = assessProbeHeadroom(view, latest, recallPrompt(cohort), probe.budgetEvidence.compression.effectiveRatio)
          if (headroom.sufficient) {
            cycle = { index: probe.cycles.length + 1, cohortId: cohort.id, summaryId: latest.id, observedAt: now(),
              sourcePacketId: sourcePacket.id, sourceRunId: sourcePacket.runId, rawOriginalFactsArchived: true, archival,
              beforeTokens: latest.preTokens, afterTokens: latest.postTokens, headroom }
            probe.cycles.push(cycle); save()
          } else note('summary-insufficient-headroom', { summaryId: latest.id, ...headroom })
        }
        if (!cycle) {
          assert.ok(probe.nextPacket <= 90, 'Ninety substantial packets produced insufficient compaction; stop rather than burn unbounded input')
          const packet = buildBusinessPacket(probe.nextPacket, packetTokens)
          const result = await turn(`packet-${packet.packetId}`, packet.prompt, 'business-review')
          let assessment
          try {
            const answer = parseProbeJSON(result.record.finalText), ids = answer.criticalIds
            assessment = { passed: answer.packetId === packet.packetId && answer.reviewedRows === packet.rowCount && Array.isArray(ids) &&
              new Set(ids).size >= 3 && ids.every(id => packet.anomalous.some(row => row.recordId === id)), answer, rowCount: packet.rowCount }
          } catch (error) { assessment = { passed: false, error: String(error.message) } }
          result.record.review = assessment; result.record.packet = { id: packet.packetId, rows: packet.rowCount, anomalies: packet.anomalous }
          probe.nextPacket++; save(); continue
        }
      }
      const cohort = cohorts.find(item => item.id === cycle.cohortId)
      if (!cycle.closed) {
        if (!probe.records.some(record => record.key === `closed-${cycle.index}`)) {
          const view = await observeSummaries()
          assert.equal(probe.latestSummaryId, cycle.summaryId, 'Selected summary changed before the closed-book question; cannot attribute it to the old summary')
          const headroom = assessProbeHeadroom(view, probe.durableSummaries.find(summary => summary.id === cycle.summaryId),
            recallPrompt(cohort), probe.budgetEvidence.compression.effectiveRatio)
          assert.ok(headroom.sufficient, 'Closed-book question needs enough post-compaction headroom')
          cycle.closedAttempt = { at: now(), summaryIdBeforeQuestion: probe.latestSummaryId, headroom,
            filesBefore: await Promise.all(cohorts.map(async value => ({ id: value.id, sha256: sha(await readFile(join(workspace, value.file))) }))) }
          save()
        }
        const result = await turn(`closed-${cycle.index}`, recallPrompt(cohort), 'closed-book')
        let assessment
        try { assessment = assessRecall(parseProbeJSON(result.record.finalText), cohort) }
        catch (error) { assessment = { passed: false, error: String(error.message) } }
        const filesAfter = await Promise.all(cohorts.map(async value => ({ id: value.id, sha256: sha(await readFile(join(workspace, value.file))) })))
        const noTools = result.record.tools.length === 0, filesUnchanged = JSON.stringify(cycle.closedAttempt?.filesBefore) === JSON.stringify(filesAfter)
        const sameSummary = cycle.closedAttempt?.summaryIdBeforeQuestion === cycle.summaryId && result.record.summaryIdAtCompletion === cycle.summaryId
        cycle.closed = { recordId: result.record.id, ...assessment, passed: assessment.passed && noTools && filesUnchanged && sameSummary,
          noTools, filesUnchanged, filesAfter, summaryIdBeforeQuestion: cycle.closedAttempt?.summaryIdBeforeQuestion ?? null,
          summaryIdAfterAnswer: result.record.summaryIdAtCompletion ?? null, sameSummary,
          toolEvidence: result.record.physicalTurnProof,
          attribution: sameSummary ? 'same committed summary before and after the closed-book question' : 'ambiguous: summary changed or before/after evidence is missing' }
        write(`cycle-${cycle.index}-closed.json`, cycle.closed); save()
      }
      if (!cycle.retrieval) {
        const result = await turn(`retrieve-${cycle.index}`, recallPrompt(cohort, true), 'archive-recovery')
        let assessment
        try {
          const answer = parseProbeJSON(result.record.finalText), recalled = assessRecall(answer, cohort)
          const expected = [cohort.seedMessageId, cohort.correctionMessageId]
          const citations = Array.isArray(answer.citations) ? answer.citations : []
          const calls = toolsIn(result.rows)
          const toolMessages = result.rows.filter(row => row.role === 'tool' && calls.some(call => call.name === 'search_history' && call.id === row.toolCallId))
          const returnedIds = toolMessages.flatMap(row => { try { return JSON.parse(textOf(row)).messages?.map(value => value.messageId) || [] } catch { return [] } })
          const searchedOriginals = expected.every(id => id && citations.includes(id) && returnedIds.includes(id))
          const onlyHistorySearch = calls.length > 0 && calls.every(call => call.name === 'search_history')
          assessment = { ...recalled, passed: recalled.passed && searchedOriginals && onlyHistorySearch, citations, expectedOriginalIds: expected,
            returnedMessageIds: [...new Set(returnedIds)], searchedOriginals, onlyHistorySearch }
        } catch (error) { assessment = { passed: false, error: String(error.message) } }
        cycle.retrieval = { recordId: result.record.id, ...assessment, toolEvidence: result.record.physicalTurnProof }; write(`cycle-${cycle.index}-retrieval.json`, cycle.retrieval); save()
      }
      emit('cycle-assessed', { cycle: cycle.index, summaryId: cycle.summaryId, closed: cycle.closed.passed, retrieval: cycle.retrieval.passed })
      write('report-progress.md', renderCompactionReport({ completed: false, passed: false, phase: probe.phase,
        cycles: probe.cycles, budget: probe.budgetEvidence, usageWindows: probe.observedUsageWindows,
        hostBoundary: probe.hostBoundary,
        durableSummaryCount: probe.durableSummaries.length, durableSummaries: probe.durableSummaries, sessionId: probe.sessionId, performance: probe.performance,
        compactionEvents: probe.compactionEvents, uiSamples: probe.uiSamples, issues: probe.issues, errorDeltas: errorDelta(),
        sessionUsage: probe.sessionUsage, inputTransportEvidence: probe.inputTransportEvidence,
        oracleSha256: probe.oracleSha256, durationMsThisInvocation: Date.now() - enteredAt }))
    }
    assert.equal(new Set(probe.cycles.map(cycle => cycle.summaryId)).size, TARGET)
    assert.ok(probe.observedUsageWindows.some(item => item.window === BUDGET), 'Actual usage must confirm the configured 268K boundary')
    completed = true; probe.phase = 'completed'; probe.finishedAt = now()
  } catch (error) {
    probe.phase = 'incomplete'; probe.lastError = { at: now(), message: String(error.stack || error) }; save()
    emit('incomplete', { cycles: probe.cycles.length, error: String(error.message) })
  } finally {
    if (folderPicker) {
      try { await folderPicker.restore() }
      catch (error) { completed = false; note('folder-picker-restore-failed', { message: String(error.message) }) }
    }
    if (activeSegment) {
      try {
        await samplePerformance(true)
        if (completed) await assertIdentity()
      } catch (error) {
        completed = false; probe.phase = 'incomplete'; probe.lastError = { at: now(), message: String(error.stack || error) }
        note('final-identity-or-metrics-failed', { message: String(error.message) })
      }
      activeSegment.finishedAt = now()
    }
    try {
      // Selection changes must not conceal a still-running probe after timeout.
      // The office adapter checks roots, descendants, jobs and durable queues.
      if (officeHost) {
        assert.equal(typeof options.beforeSelectionRestore, 'function', 'Office probes require the terminal cleanup gate')
        await options.beforeSelectionRestore(probe)
      }
      await activateTask(originalTaskId)
      if (originalMode === 'code' && !officeHost) {
        await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
        await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId)).toBe(state.modes.code.sessionId)
      }
      probe.restoredPrimarySelection = true
    } catch (error) { probe.restoredPrimarySelection = false; note('restore-selection-failed', { message: String(error.message) }) }
    if (activeSegment) activeSegment.errorDeltas = errorDelta()
    probe.invocationErrors ||= []
    probe.invocationErrors.push({ startedAt: new Date(enteredAt).toISOString(), finishedAt: now(), ...errorDelta() })
    page.off('crash', onRendererCrash)
    save()
  }
  const uiLifecycleObserved = probe.uiSamples?.some(item => item.phase === 'running') === true &&
    probe.uiSamples?.some(item => /268[,.]?000/.test(item.label || '')) === true
  const errorDeltas = Object.fromEntries(['renderer', 'process', 'rendererCrashes'].map(key => [key, probe.invocationErrors.flatMap(item => item[key])]))
  const metricsCoverage = probe.performance.diagnosticSamples >= 2 && probe.performance.runtimeSamples >= 2 && probe.performance.eventLoopAvailable > 0 &&
    ['engineCpuPercentOneCore', 'engineRssBytes', 'enginePrivateBytes', 'heapUsedBytes', 'readBytesPerSecond', 'writeBytesPerSecond'].every(key => probe.performance.statistics?.[key]?.count > 0)
  const result = { completed, passed: completed && probe.cycles.every(cycle => cycle.closed?.passed && cycle.retrieval?.passed) &&
      probe.records.filter(item => item.kind === 'business-review').every(item => item.review?.passed) && probe.restoredPrimarySelection && uiLifecycleObserved &&
      metricsCoverage && Object.values(errorDeltas).every(rows => rows.length === 0),
    cycles: probe.cycles, durableSummaryCount: probe.durableSummaries.length, durableSummaries: probe.durableSummaries,
    testedSummaryCount: probe.cycles.filter(cycle => cycle.closed && cycle.retrieval).length,
    sessionId: probe.sessionId, workspace, stateFile, budget: probe.budgetEvidence, durationMsThisInvocation: Date.now() - enteredAt,
    sessionUsage: probe.sessionUsage, oracleSha256: probe.oracleSha256, inputTransportEvidence: probe.inputTransportEvidence,
    submittedInputEstimate: probe.records.reduce((sum, item) => sum + item.modelInputTokens, 0),
    primaryLoadAccounting: officeHost
      ? 'Excluded from office workload: this independent experiment starts after the six office roots settle. Prior game acceptance remains incomplete.'
      : 'Excluded: this independent experiment starts after both game roots settle.',
    hostBoundary: probe.hostBoundary || { kind: 'games' },
    memoryOverride: probe.memoryOverride, usageWindows: probe.observedUsageWindows, uiLifecycleObserved, uiSamples: probe.uiSamples,
    performance: probe.performance, metricsCoverage, errorDeltas, restoredPrimarySelection: probe.restoredPrimarySelection,
    metricsFiles: { os: join(evidence, 'metrics.jsonl'), runtime: join(evidence, 'runtime.jsonl') },
    compactionEvents: probe.compactionEvents, dataReviews: probe.records.filter(item => item.kind === 'business-review').map(item => ({ id: item.id, review: item.review })),
    pending: probe.records.filter(item => item.phase !== 'terminal').map(item => ({ id: item.id, runId: item.runId, phase: item.phase })),
    issues: probe.issues, error: completed ? null : probe.lastError,
    limitations: ['Synthetic business data; not a financial-system certification.',
      'No summary-only claim if a closed-book turn calls any tool; that cycle fails.',
      'Committed summaries without an immediate assessed question are recorded but do not increase tested cycle coverage.',
      'Archive recovery follows each closed-book result, using disjoint fact cohorts to avoid teaching later test answers.'] }
  write('report.json', result); artifact?.('context-compaction-probe-report.json', result)
  write('report.md', renderCompactionReport(result))
  return result
}
