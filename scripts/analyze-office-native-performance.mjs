#!/usr/bin/env node
// Read-only, bounded-source campaign audit. Never connects to the app, reads credentials, or treats setup as load.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createHash } from 'node:crypto'

const input = path.resolve(process.argv[2] ?? '.ae/work-office-native-20261024164939')
const evidence = path.basename(input) === 'evidence' ? input : path.join(input, 'evidence')
const warnings = [], sources = {}
const finite = value => typeof value === 'number' && Number.isFinite(value)
const iso = value => finite(value) ? new Date(value).toISOString() : null
const local = value => finite(value) ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '未知'
const round = value => finite(value) ? Math.round(value * 100) / 100 : null
const duration = ms => `${round(ms / 1000)} 秒`
async function lines(name, onLine) {
  const target = path.join(evidence, name), info = fs.statSync(target)
  sources[name] = { sizeBytesAtOpen: info.size, modifiedAt: info.mtime.toISOString() }
  const stream = fs.createReadStream(target, { encoding: 'utf8', end: Math.max(0, info.size - 1) })
  let line = 0
  for await (const text of readline.createInterface({ input: stream, crlfDelay: Infinity })) { line++; await onLine(text, line) }
}
async function jsonl(name) {
  const rows = []
  await lines(name, (text, line) => { if (!text.trim()) return; try { rows.push(JSON.parse(text)) } catch { warnings.push(`${name}:${line} 未完整解析，可能为正在追加的末行，已排除`) } })
  return rows
}
function stats(values) {
  const all = values.filter(finite).sort((a, b) => a - b)
  return all.length ? { count: all.length, min: all[0], median: all[Math.ceil(all.length * .5) - 1], p95: all[Math.ceil(all.length * .95) - 1], max: all.at(-1), mean: all.reduce((a, b) => a + b, 0) / all.length } : { count: 0 }
}
function mergeIntervals(intervals) {
  const result = []
  for (const [start, end] of intervals.filter(([a, b]) => finite(a) && finite(b) && b > a).sort((a, b) => a[0] - b[0])) {
    if (result.length && result.at(-1)[1] >= start) result.at(-1)[1] = Math.max(end, result.at(-1)[1])
    else result.push([start, end])
  }
  return result
}
function concurrency(records) {
  const times = [...new Set(records.flatMap(run => [run.activeStart, run.observedEnd]))].filter(finite).sort((a,b) => a-b)
  const segments = times.slice(0, -1).map((from, index) => {
    const active = records.filter(run => run.activeStart <= from && run.observedEnd > from)
    return { from, to: times[index + 1], roots: active.length, roles: [...new Set(active.map(run => run.role))], rounds: [...new Set(active.map(run => run.round))], runIds: active.map(run => run.runId) }
  }).filter(segment => segment.roots)
  const sixRoleSegments = segments.filter(segment => segment.roles.length >= 6)
  return { peakRoots: Math.max(0, ...segments.map(segment => segment.roots)), peakRoles: Math.max(0, ...segments.map(segment => segment.roles.length)),
    sixRoleDurationMs: sixRoleSegments.reduce((sum, segment) => sum + segment.to - segment.from, 0), sixRoleSegments }
}
const metricIdentity = sample => `${sample.diagnostics?.resources?.pid ?? 'unknown'}:${createHash('sha256').update(String(sample.diagnostics?.identity ?? '')).digest('hex').slice(0,12)}`
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'])
const [metrics, statuses, events] = await Promise.all(['metrics.jsonl', 'status.jsonl', 'events.jsonl'].map(jsonl))
metrics.sort((a, b) => a.at - b.at); statuses.sort((a, b) => a.at - b.at)
let cutoff = statuses.at(-1)?.at ?? Date.now()
const statusCutoff = cutoff, runs = new Map(), children = new Map(), recovery = [], tools = new Map()
for (const event of events.filter(event => event.type === 'admitted' && event.runId)) runs.set(event.runId, { role: event.id, round: event.round, runId: event.runId, submittedAt: Date.parse(event.at), observations: 0, lastEventId: null, progressChanges: 0 })
// A recovered role may move to a new session. Keep every admission and let the
// prior-session entry override a duplicated admission's current-session guess.
const statePath = path.join(path.dirname(evidence), 'state.json')
if (fs.existsSync(statePath)) {
  const info = fs.statSync(statePath), state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  sources['../state.json'] = { sizeBytesAtOpen: info.size, modifiedAt: info.mtime.toISOString() }
  for (const [role, value] of Object.entries(state.roles ?? {})) {
    for (const session of [value, ...(value.priorSessions ?? [])]) for (const admission of session.submissions ?? []) {
      if (!admission.runId) continue
      const run = runs.get(admission.runId) ?? { role, round: admission.round, runId: admission.runId, submittedAt: Date.parse(admission.at), observations: 0, lastEventId: null, progressChanges: 0 }
      run.submissionSessions ??= []
      if (!run.submissionSessions.some(candidate => candidate.sessionId === session.sessionId)) run.submissionSessions.push({ sessionId: session.sessionId, priorSession: session !== value })
      if (!run.priorSession) Object.assign(run, { submissionSessionId: session.sessionId, priorSession: session !== value })
      run.submissionTerminalStatus = admission.terminalStatus ?? run.submissionTerminalStatus ?? null
      runs.set(run.runId, run)
    }
  }
}
function absorb(run, observedAt, row) {
  const value = runs.get(run?.runId)
  if (!value) return
  // Later files can hold older progress snapshots; never regress a terminal run.
  const version = run.version ?? 0, updatedAt = run.updatedAt ?? run.finishedAt ?? run.createdAt ?? 0
  const newer = version > (value.version ?? -1) || version === (value.version ?? -1) && updatedAt >= (value.updatedAt ?? 0)
  if (newer && (!terminal.has(value.status) || terminal.has(run.status))) {
    for (const key of ['sessionId', 'turnId', 'createdAt', 'updatedAt', 'finishedAt', 'status', 'stopReason', 'actualModelId', 'version']) if (run[key] !== undefined) value[key] = run[key]
    if (run.error) value.errorCode = run.error.code
  }
  if (row) {
    value.observations++; value.lastObservedAt = observedAt
    if (run.status === 'running' && !value.runningAt) value.runningAt = Math.min(observedAt, run.updatedAt ?? observedAt)
    if (row.lastEventId && row.lastEventId !== value.lastEventId) { value.lastEventId = row.lastEventId; value.lastProgressObservedAt = observedAt; value.progressChanges++ }
    if (run.status === 'running') value.maxObservedProgressSilenceMs = Math.max(value.maxObservedProgressSilenceMs ?? 0, observedAt - (value.lastProgressObservedAt ?? observedAt))
    if (terminal.has(run.status) && !value.firstTerminalObservedAt) value.firstTerminalObservedAt = observedAt
  }
}
for (const sample of statuses) for (const row of sample.rows ?? []) absorb(row.run, sample.at, row)
const snapshots = fs.readdirSync(evidence).filter(name => /^(operations|finance|people|sales|product|legal)-.*-snapshot\.json$/.test(name) && !name.includes('-subagent-'))
const snapshotData = []
for (const name of snapshots) {
  const target = path.join(evidence, name), info = fs.statSync(target)
  sources[name] = { sizeBytesAtOpen: info.size, modifiedAt: info.mtime.toISOString() }
  const value = JSON.parse(fs.readFileSync(target, 'utf8'))
  const records = [...(value.runs ?? []), ...(value.run ? [value.run] : [])]
  for (const run of records) {
    absorb(run, info.mtimeMs)
    const root = runs.get(run.runId)
    if (root) root.lastSnapshotObservedAt = Math.max(root.lastSnapshotObservedAt ?? 0, info.mtimeMs)
  }
  cutoff = Math.max(cutoff, info.mtimeMs)
  snapshotData.push({ name, value, info })
}
for (const { name, value, info } of snapshotData) {
  for (const message of value.history ?? []) {
    const root = runs.get(message.metadata?.rootRunId)
    if (message.role !== 'tool' || !root || !message.toolCallId) continue
    const elapsed = message.metadata?.durationMs
    const item = { runId: root.runId, role: root.role, round: root.round, kind: 'root', callId: message.toolCallId, name: message.toolName,
      success: message.metadata?.success === true || message.metadata?.status === 'succeeded', durationMs: finite(elapsed) ? elapsed : null,
      finishedAt: message.createdAt, startedAt: finite(elapsed) ? message.createdAt - elapsed : null, source: name,
      timing: 'Root start estimated from persisted result createdAt minus reported durationMs; not CPU occupancy.' }
    tools.set(`${root.runId}:${message.toolCallId}`, item)
  }
  for (const root of runs.values()) {
    const history = (value.history ?? []).filter(message => message.metadata?.rootRunId === root.runId)
    if (!history.length || info.mtimeMs < (root.historyEvidence?.observedAt ?? 0)) continue
    root.historyEvidence = { source: name, messages: history.length, assistantMessages: history.filter(message => message.role === 'assistant').length,
      assistantToolCallMessages: history.filter(message => message.role === 'assistant' && message.toolCall).length, toolResultMessages: history.filter(message => message.role === 'tool').length,
      truncated: value.historyCompacted === true, observedAt: info.mtimeMs }
  }
  for (const child of value.subagentRuns ?? []) {
    const parent = [...runs.values()].find(run => run.turnId === child.parentConversationId)
    const record = { runId: child.runId, childSessionId: child.childSessionId, parentRunId: parent?.runId ?? null, role: parent?.role ?? null, round: parent?.round ?? null,
      status: child.status, startedAt: child.startedAt ?? child.createdAt, createdAt: child.createdAt, finishedAt: child.finishedAt ?? null, stopReason: child.stopReason ?? null, errorCode: child.error?.code ?? null, toolCalls: child.toolCalls?.length ?? null, source: name, observedAt: info.mtimeMs }
    const previous = children.get(child.runId)
    if (!previous || child.updatedAt >= (previous.updatedAt ?? 0)) {
      children.set(child.runId, { ...record, updatedAt: child.updatedAt })
      for (const call of child.toolCalls ?? []) tools.set(`${child.runId}:${call.id}`, { runId: child.runId, parentRunId: parent?.runId,
        role: parent?.role ?? null, round: parent?.round ?? null, kind: 'child', callId: call.id, name: call.name, success: call.status === 'succeeded',
        startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, source: name, timing: 'Persisted child tool startedAt/finishedAt; not CPU occupancy.' })
    }
  }
  if (name === 'operations-v1-snapshot.json') for (const [index, message] of (value.history ?? []).entries()) {
    const meta = message.metadata
    if (meta?.stopReason !== 'empty_output' && !meta?.emptyOutputRecovery) continue
    recovery.push({ source: `${name}#/history/${index}`, messageId: message.id, createdAt: message.createdAt, runId: meta.rootRunId, recoveryIndex: meta.recoveryIndex ?? null,
      emptyOutputRecovery: meta.emptyOutputRecovery === true, requestInputTokenEstimate: meta.requestInputTokenEstimate ?? null, responseDiagnostics: meta.responseDiagnostics ?? null })
  }
}

// Desktop log records are reduced to a small allowlist; no prompts, bodies, URLs, headers or credentials enter reports.
const logRecords = []; let current
const permitted = new Set(['requestId', 'requestAttemptId', 'sessionId', 'rootRunId', 'iteration', 'wireMessageCount', 'requestStage', 'availability', 'event'])
await lines('desktop.log', (raw, line) => {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, ''), head = /^\[engine\] \[([\d:.]+)\] (INFO|WARN|ERROR|FATAL) \((\d+)\): (.+)$/.exec(text)
  if (head) {
    if (current) logRecords.push(current)
    current = { line, time: head[1], level: head[2], message: head[4], fields: {} }
  } else if (current) {
    const field = /^\[engine\]\s+([A-Za-z]+):\s+(.+)$/.exec(text)
    if (field && permitted.has(field[1])) { try { current.fields[field[1]] = JSON.parse(field[2]) } catch { /* Not a scalar field. */ } }
  }
})
if (current) logRecords.push(current)
const emptyRecords = logRecords.filter(row => /Model response had no final answer|Regenerating once after empty terminal/.test(row.message))
const operationId = [...runs.values()].find(run => run.role === 'operations' && run.round === 'v1')?.runId
const operationLogs = emptyRecords.filter(row => row.fields.rootRunId === operationId)
const requestIds = new Set(operationLogs.map(row => row.fields.requestId))
const dispatches = logRecords.filter(row => row.message.startsWith('Local adapter request start') && requestIds.has(row.fields.requestId))
const relevantDispatches = operationLogs.filter(row => row.message.startsWith('Model response')).map(error => dispatches.filter(dispatch => dispatch.line < error.line).at(-1)).filter(Boolean)

for (const run of runs.values()) {
  // Migrated sessions may retain the entire earlier submissions array. The
  // persisted run's own sessionId disambiguates those copied admission lists.
  const owningSubmission = run.submissionSessions?.find(candidate => candidate.sessionId === run.sessionId)
  if (owningSubmission) Object.assign(run, { submissionSessionId: owningSubmission.sessionId, priorSession: owningSubmission.priorSession })
  run.activeStart = run.runningAt ?? run.createdAt ?? run.submittedAt
  run.observedEnd = run.finishedAt ?? Math.max(run.lastObservedAt ?? run.activeStart, run.lastSnapshotObservedAt ?? 0)
  run.durationMs = Math.max(0, run.observedEnd - run.activeStart)
  run.terminal = terminal.has(run.status)
  run.progressSilentMs = run.terminal ? 0 : Math.max(0, run.observedEnd - (run.lastProgressObservedAt ?? run.activeStart))
}
function phaseMetrics(start, end) {
  const selected = metrics.filter(sample => sample.at >= start && sample.at <= end)
  const resources = selected.map(sample => sample.diagnostics?.resources).filter(Boolean)
  const cpu = resources.filter(resource => finite(resource.cpu?.percent) && finite(resource.cpu?.intervalMs) && resource.sampledAt - resource.cpu.intervalMs >= start && resource.sampledAt <= end)
  const cpuTime = cpu.reduce((sum, item) => sum + item.cpu.intervalMs, 0)
  const ios = resources.filter(resource => finite(resource.io?.readBytes) && finite(resource.io?.writeBytes))
  const storages = [...new Map(selected.map(sample => sample.diagnostics?.storage).filter(value => value?.state === 'available').map(value => [value.scannedAt, value])).values()]
  const first = ios[0], last = ios.at(-1), firstStorage = storages[0], lastStorage = storages.at(-1)
  const uiBefore = metrics.filter(sample => sample.at < start && sample.ui).at(-1), uiLast = selected.filter(sample => sample.ui).at(-1)
  const identities = [...new Set(selected.map(metricIdentity))]
  const reset = identities.length > 1 || uiBefore && uiLast && metricIdentity(uiBefore) !== metricIdentity(uiLast)
    || selected.some((sample, i) => i && sample.ui && selected[i - 1].ui && sample.ui.count < selected[i - 1].ui.count)
  return { metricSamples: selected.length, firstSampleAt: selected[0]?.at ?? null, lastSampleAt: selected.at(-1)?.at ?? null, identities,
    cpuPercentOneLogicalCore: { ...stats(cpu.map(value => value.cpu.percent)), weightedMean: cpuTime ? cpu.reduce((sum, item) => sum + item.cpu.percent * item.cpu.intervalMs, 0) / cpuTime : null, includedIntervalMs: cpuTime },
    rssBytes: stats(resources.map(resource => resource.memory?.rssBytes)), privateBytes: stats(resources.map(resource => resource.memory?.privateBytes)),
    ioReadBytesPerSecond: stats(resources.map(resource => resource.io?.readBytesPerSecond)), ioWriteBytesPerSecond: stats(resources.map(resource => resource.io?.writeBytesPerSecond)),
    ioCumulative: identities.length === 1 && first && last && first.sampledAt < last.sampledAt && first.pid === last.pid ? { from: first.sampledAt, to: last.sampledAt, readBytes: last.io.readBytes - first.io.readBytes, writeBytes: last.io.writeBytes - first.io.writeBytes } : null,
    diskAvailableBytes: stats(resources.map(resource => resource.disk?.availableBytes)), diskFreeDeltaBytes: first && last ? last.disk.availableBytes - first.disk.availableBytes : null,
    storage: firstStorage && lastStorage ? { uniqueScans: storages.length, from: firstStorage.scannedAt, to: lastStorage.scannedAt, firstBytes: firstStorage.totalBytes, lastBytes: lastStorage.totalBytes, deltaBytes: lastStorage.totalBytes - firstStorage.totalBytes, latestCategories: lastStorage.categories, partial: storages.some(value => value.partial) } : null,
    health: { latencyMs: stats(selected.map(sample => sample.diagnostics?.health?.lastLatencyMs)), consecutiveFailures: stats(selected.map(sample => sample.diagnostics?.health?.consecutiveFailures)), lastProbeSuccessGapMs: stats(selected.map(sample => sample.diagnostics?.health ? sample.diagnostics.health.lastCheckedAt - sample.diagnostics.health.lastSuccessAt : null)) },
    processTree: { partialSamples: resources.filter(value => value.processTree?.partial).length, cachedSamples: resources.filter(value => value.processTree?.collection?.cached).length, reportedCounts: [...new Set(resources.map(value => value.processTree?.totals?.count))] },
    collectorDurationMs: stats(resources.map(resource => resource.collection?.durationMs)),
    ui: { observedSamples: selected.filter(sample => sample.ui).length, latest: uiLast?.ui ? { count: uiLast.ui.count, totalMs: uiLast.ui.totalMs, maxMs: uiLast.ui.maxMs } : null,
      deltaCount: uiBefore && uiLast && !reset ? uiLast.ui.count - uiBefore.ui.count : null, deltaTotalMs: uiBefore && uiLast && !reset ? uiLast.ui.totalMs - uiBefore.ui.totalMs : null,
      reset, attribution: 'Cumulative-counter difference between sampled boundaries only; no performance.timeOrigin, cannot assign recent[] exact wall-clock times.' } }
}
const phases = [...new Set([...runs.values()].map(run => run.round))].map(name => {
  const roots = [...runs.values()].filter(run => run.round === name), childRuns = [...children.values()].filter(child => child.round === name)
  const start = Math.min(...roots.map(run => run.activeStart)), end = Math.max(...roots.map(run => run.observedEnd))
  const overlapStart = Math.max(...roots.map(run => run.activeStart)), overlapEnd = Math.min(...roots.map(run => run.observedEnd))
  const intervals = mergeIntervals(roots.map(run => [run.activeStart, run.observedEnd]))
  const observedAll = statuses.filter(sample => sample.rows?.filter(row => roots.some(run => run.runId === row.run?.runId) && row.run.status === 'running').length === roots.length)
  let peakChildren = 0
  for (const child of childRuns) peakChildren = Math.max(peakChildren, childRuns.filter(other => other.startedAt <= child.startedAt && (other.finishedAt ?? cutoff) > child.startedAt).length)
  const overlappingRounds = [...new Set([...runs.values()].filter(run => run.round !== name && run.activeStart < end && run.observedEnd > start).map(run => run.round))]
  return { name, startedAt: start, endedOrObservedAt: end, complete: roots.every(run => run.terminal), rootCount: roots.length, roleCount: new Set(roots.map(run => run.role)).size,
    rootStates: Object.fromEntries(roots.map(run => [roots.filter(value => value.role === run.role).length > 1 ? `${run.role}/${run.runId}` : run.role, run.status])), activeUnionMs: intervals.reduce((sum, [a, b]) => sum + b - a, 0),
    sixRootOverlap: roots.length === 6 && overlapEnd > overlapStart ? { from: overlapStart, to: overlapEnd, durationMs: overlapEnd - overlapStart } : null,
    concurrency: concurrency(roots), sampledAllRunning: { samples: observedAll.length, first: observedAll[0]?.at ?? null, last: observedAll.at(-1)?.at ?? null },
    children: { runs: childRuns.length, uniqueSessions: new Set(childRuns.map(child => child.childSessionId)).size, peakConcurrent: peakChildren,
      states: childRuns.reduce((counts, child) => ({ ...counts, [child.status]: (counts[child.status] ?? 0) + 1 }), {}), coverage: 'Only available root snapshots; absent snapshots mean missing evidence, not zero children.' },
    metricAttribution: 'Shared-engine measurements during this phase window; overlapping phases cannot be charged separately or added together.', overlappingRounds,
    metrics: phaseMetrics(start, end) }
})
const activeIntervals = mergeIntervals([...runs.values()].map(run => [run.activeStart, run.observedEnd]))
const combinedLifecycles = [...runs.values()].map(run => ({ ...run, kind: 'root' })).concat([...children.values()].map(child => ({ ...child, kind: 'child', activeStart: child.startedAt, observedEnd: child.finishedAt ?? Math.min(cutoff, child.observedAt) })))
function lifecyclePeak(records) {
  const times = [...new Set(records.flatMap(run => [run.activeStart, run.observedEnd]))].filter(finite).sort((a,b) => a-b)
  let peak = { count: 0, roots: 0, children: 0, from: null, to: null, runIds: [] }
  for (let index = 0; index < times.length - 1; index++) {
    const active = records.filter(run => run.activeStart <= times[index] && run.observedEnd > times[index])
    if (active.length > peak.count) peak = { count: active.length, roots: active.filter(run => run.kind === 'root').length,
      children: active.filter(run => run.kind === 'child').length, from: times[index], to: times[index+1], runIds: active.map(run => run.runId) }
  }
  return peak
}
const successfulWorkTools = [...tools.values()].filter(tool => tool.success && !/^(subagent(?:_|$)|plan_update$|todo_)/.test(tool.name ?? ''))
const toolActivity = { totalRecorded: tools.size, successfulRecorded: [...tools.values()].filter(tool => tool.success).length, successfulWorkTools: successfulWorkTools.length,
  excludedFromWorkTools: 'subagent orchestration, plan_update, todo_*; successful tool receipts do not prove business correctness or visual acceptance.',
  byPhase: phases.map(phase => ({ name: phase.name, rootSuccessfulWorkTools: successfulWorkTools.filter(tool => tool.round === phase.name && tool.kind === 'root').length,
    childSuccessfulWorkTools: successfulWorkTools.filter(tool => tool.round === phase.name && tool.kind === 'child').length })),
  timedSuccessfulTools: successfulWorkTools.filter(tool => finite(tool.startedAt) && finite(tool.finishedAt) && tool.finishedAt > tool.startedAt).length }
const enginePeriods = []
for (const sample of metrics) {
  const identity = metricIdentity(sample)
  if (enginePeriods.at(-1)?.identity === identity) { enginePeriods.at(-1).to = sample.at; enginePeriods.at(-1).samples++ }
  else enginePeriods.push({ identity, pid: sample.diagnostics?.resources?.pid, from: sample.at, to: sample.at, samples: 1 })
}
for (const phase of phases) if (phase.metrics.identities.length > 1) {
  phase.metrics.byInstance = enginePeriods.filter(period => period.from <= phase.endedOrObservedAt && period.to >= phase.startedAt).map(period => ({ identity: period.identity, metrics: phaseMetrics(Math.max(phase.startedAt, period.from), Math.min(phase.endedOrObservedAt, period.to)) }))
  phase.metrics.cpuPercentOneLogicalCore = { count: 0, excluded: 'Multiple engine identities; use byInstance to avoid averaging across restarts.' }
}
const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), evidence, observedUntil: iso(cutoff), statusObservedUntil: iso(statusCutoff), metricsObservedUntil: iso(metrics.at(-1)?.at), sources, warnings, enginePeriods, concurrency: concurrency([...runs.values()]),
  combinedLifecyclePeak: lifecyclePeak(combinedLifecycles), combinedLifecycleByPhase: phases.map(phase => ({ name: phase.name, ...lifecyclePeak(combinedLifecycles.filter(run => run.round === phase.name)) })), toolActivity,
  sampling: { statusGapMs: stats(statuses.slice(1).map((value, index) => value.at - statuses[index].at)), metricsGapMs: stats(metrics.slice(1).map((value, index) => value.at - metrics[index].at)), statusSamples: statuses.length, metricsSamples: metrics.length,
    initialIdleMsExcluded: Math.max(0, activeIntervals[0]?.[0] - (metrics[0]?.at ?? cutoff)), betweenPhaseIdleMsExcluded: activeIntervals.slice(1).reduce((sum, interval, index) => sum + interval[0] - activeIntervals[index][1], 0),
    postLoadObservedMsExcluded: Math.max(0, cutoff - (activeIntervals.at(-1)?.[1] ?? cutoff)), activeUnionMs: activeIntervals.reduce((sum, [a, b]) => sum + b - a, 0), enginePids: [...new Set(metrics.map(value => value.diagnostics?.resources?.pid).filter(finite))] },
  phases, roots: [...runs.values()], children: [...children.values()], toolReceipts: [...tools.values()],
  emptyOutput: { rootRunId: operationId, records: recovery, desktopEvents: operationLogs, nearestDispatches: relevantDispatches, observedRecoveryCount: operationLogs.filter(row => row.message.startsWith('Regenerating')).length,
    limitation: 'requestId/requestAttemptId are local request/adapter-dispatch correlation, not provider receipt IDs. No provider raw response body is required or copied.' },
  unavailable: ['未采集 V8 heap used/total/limit', '未采集引擎事件循环延迟或利用率', '未采集服务端 heartbeat，仅有桌面 HTTP 健康探测', '未采集 UI FPS、输入响应延迟', '未记录 UI performance.timeOrigin，长任务分段只能依赖采样边界累计差', '进程树 partial=true，未取得完整桌面/浏览器/辅助进程的 CPU/RSS 合计', '磁盘剩余量为全机指标，变化不能归因于引擎', '缺少持续 7×24 压测与重复负载后回归空闲的内存泄漏证据'] }
fs.writeFileSync(path.join(evidence, 'performance-audit.json'), JSON.stringify(report, null, 2))
const mb = bytes => finite(bytes) ? round(bytes / 1024 ** 2) : '缺失'
const md = ['# 六角色原生办公性能审计', '', `数据截至：${local(cutoff)}（Asia/Shanghai）；生成：${new Date().toISOString()}。`, '',
  `状态流截至 ${local(statusCutoff)}，资源指标截至 ${local(metrics.at(-1)?.at)}；各文件按打开时大小读取，实时追加期间不是原子快照。`, '',
  '只计服务器进入 running 后至 finishedAt 的真实任务生命周期。该时长包含模型/工具等待，不代表 CPU 连续满载；未终止任务按本 run 最后状态或快照观察截断。启动空闲与阶段间空闲不计负载。未采到 running 时使用 createdAt，并在 JSON 保留来源字段。根 succeeded 仅为引擎终态，不等于业务产物验收通过。', '',
  `状态样本 ${statuses.length}，指标样本 ${metrics.length}；排除初始空闲 ${duration(report.sampling.initialIdleMsExcluded)}、阶段间空闲 ${duration(report.sampling.betweenPhaseIdleMsExcluded)}、末尾观察 ${duration(report.sampling.postLoadObservedMsExcluded)}；全部 ${report.roots.length} 根任务活动并集 ${duration(report.sampling.activeUnionMs)}。引擎 PID：${report.sampling.enginePids.join(', ')}。`, '',
  '| 阶段 | 实际起止（北京时间） | 活跃时长 | 六根并发交集 | 根状态 | 子任务（已采集快照） |', '|---|---|---:|---:|---|---|',
  ...phases.map(phase => `| ${phase.name}${phase.complete ? '' : '（仍在运行/不完整）'} | ${local(phase.startedAt)} — ${local(phase.endedOrObservedAt)} | ${duration(phase.activeUnionMs)} | ${duration(phase.sixRootOverlap?.durationMs ?? 0)} | ${Object.entries(phase.rootStates).map(([k,v]) => `${k}:${v}`).join('；')} | ${phase.children.runs} 次 / ${phase.children.uniqueSessions} 会话，${JSON.stringify(phase.children.states)}；峰值 ${phase.children.peakConcurrent} |`), '',
  `跨全部阶段的生命周期峰值：${report.concurrency.peakRoots} 根、${report.concurrency.peakRoles} 个不同角色；六角色生命周期重叠总计 ${duration(report.concurrency.sixRoleDurationMs)}。这不等于六角色同时有工具/业务产出。`, '',
  `根与子任务生命周期合计峰值：${report.combinedLifecyclePeak.count} 个（${report.combinedLifecyclePeak.roots} 根 + ${report.combinedLifecyclePeak.children} 子），首次峰值区间 ${local(report.combinedLifecyclePeak.from)} — ${local(report.combinedLifecyclePeak.to)}；子任务按 runId 去重并使用 startedAt/finishedAt，缺 startedAt 时才回退 createdAt。父任务等待子任务也处于生命周期内，不能把此数当成并行 CPU 工作线程数。`, '',
  '| 阶段 | 根 + 子生命周期峰值 | 成功普通工具回执（根 / 子） |', '|---|---|---|',
  ...report.combinedLifecycleByPhase.map(phase => { const activity = toolActivity.byPhase.find(value => value.name === phase.name); return `| ${phase.name} | ${phase.count}（${phase.roots} + ${phase.children}） | ${activity.rootSuccessfulWorkTools} / ${activity.childSuccessfulWorkTools} |` }), '',
  `共保存 ${toolActivity.totalRecorded} 条去重工具回执，其中 ${toolActivity.successfulRecorded} 条标记成功；排除子任务编排、plan_update、todo_* 后为 ${toolActivity.successfulWorkTools} 条普通成功工具回执。包含真实读取、计算、浏览器观察与文件操作，仍不等于全部业务产物正确；JSON 保留 callId/runId 与时间证据。模型等待期间 CPU 低不能据此称 CPU 高压测试通过。`, '',
  '| 阶段 | 根数 / 不同角色数 | 本阶段并发峰值 | 同时运行的其他阶段 |', '|---|---|---|---|',
  ...phases.map(phase => `| ${phase.name} | ${phase.rootCount} / ${phase.roleCount} | ${phase.concurrency.peakRoots} | ${phase.overlappingRounds.join('、') || '无'} |`), '',
  '以下各阶段指标是该时间窗口的共享引擎测量值。重叠阶段不可分别归因、相加成总成本；一个阶段不满六根并不代表遗漏任务，阶段完整性按该阶段实际接纳的 runId 判断。', '',
  '| 阶段 | CPU 单逻辑核 % 均值 / P95 / 峰值 | RSS MiB 中位 / 峰值 | Private MiB 中位 / 峰值 | 读 / 写 MiB（样本差） | 存储净增 MiB | HTTP 健康延迟 P95 / 最大 ms | UI 新增长任务 |', '|---|---|---|---|---|---|---|---|',
  ...phases.map(({ name, metrics: m }) => `| ${name} | ${round(m.cpuPercentOneLogicalCore.weightedMean)} / ${round(m.cpuPercentOneLogicalCore.p95)} / ${round(m.cpuPercentOneLogicalCore.max)} | ${mb(m.rssBytes.median)} / ${mb(m.rssBytes.max)} | ${mb(m.privateBytes.median)} / ${mb(m.privateBytes.max)} | ${mb(m.ioCumulative?.readBytes)} / ${mb(m.ioCumulative?.writeBytes)} | ${mb(m.storage?.deltaBytes)} | ${round(m.health.latencyMs.p95)} / ${round(m.health.latencyMs.max)} | ${m.ui.deltaCount ?? '边界证据不足'} / ${m.ui.deltaTotalMs ?? '未知'} ms |`), '',
  'CPU 均值按完整落在阶段内的采样区间加权；P95 为样本分位。I/O 为首尾同 PID、同引擎 identity 的累计计数差，边缘未采到的流量不在差值内。跨引擎重启不做 I/O/UI 累计差或 CPU 均值，JSON 按实例分段。存储扫描可能带缓存，JSON 保留扫描时间。采样到的健康失败不等于所有 5 秒探测均被保存。', '',
  '| 引擎采样实例 | 首次 / 末次采样（北京时间） | 样本数 |', '|---|---|---|',
  ...enginePeriods.map(period => `| ${period.identity} | ${local(period.from)} — ${local(period.to)} | ${period.samples} |`), '',
  '| 阶段 | 进程读 / 写峰值 MiB/s | D 盘可用空间最小 GiB | D 盘可用空间变化 MiB（全机） | 资源采样耗时均值 / 最大 ms | 保存样本中的健康失败最大值 |', '|---|---|---|---|---|---|',
  ...phases.map(({ name, metrics: m }) => `| ${name} | ${mb(m.ioReadBytesPerSecond.max)} / ${mb(m.ioWriteBytesPerSecond.max)} | ${round(m.diskAvailableBytes.min / 1024 ** 3)} | ${mb(m.diskFreeDeltaBytes)} | ${round(m.collectorDurationMs.mean)} / ${round(m.collectorDurationMs.max)} | ${m.health.consecutiveFailures.max ?? '缺失'} |`), '',
  `状态采样间隔中位 ${round(report.sampling.statusGapMs.median)} ms、最大 ${round(report.sampling.statusGapMs.max)} ms；资源采样中位 ${round(report.sampling.metricsGapMs.median)} ms、最大 ${round(report.sampling.metricsGapMs.max)} ms。资源采样耗时是调用墙钟时间，不能当作监控 CPU 开销。JSON 的 at 在采集前记录，健康探测状态可在采集中更新，因此不使用 at−lastSuccessAt 伪造精确心跳年龄。`, '',
  'Windows 进程 I/O 计数包含进程传输量，不能当作物理磁盘读写吞吐。D 盘空间变化包含测试夹具及其他进程写入，不能全部归因于引擎。进程树样本全部标为 partial，且只列出根 PID；不代表没有浏览器/桌面或其他辅助进程。', '',
  ...phases.map(({ name, metrics: m }) => `- ${name} 最后可得引擎状态目录分类：${(m.storage?.latestCategories ?? []).map(category => `${category.category} ${mb(category.bytes)} MiB/${category.files} 文件`).join('；')}。扫描水位 ${local(m.storage?.to)}。`), '',
  '## 每根任务与无进度信号', '', '| 阶段/角色 | 起止（北京时间） | 状态/原因 | Assistant 消息 / 工具调用消息 | 运行中采到的最长事件 ID 无变化 |', '|---|---|---|---|---|',
  ...report.roots.map(run => `| ${run.round}/${run.role} | ${local(run.activeStart)} — ${local(run.observedEnd)} | ${run.status}/${run.stopReason ?? '-'} | ${run.historyEvidence?.assistantMessages ?? '未采集'} / ${run.historyEvidence?.assistantToolCallMessages ?? '未采集'} | ${duration(run.maxObservedProgressSilenceMs ?? 0)} |`), '',
  '事件 ID 无变化只说明此观察通道未看到新事件，不能单独证明引擎挂起；应结合模型请求、子任务和实际文件活动。工具调用消息包含失败与内部控制请求，不代表成功的业务工具操作；计数按 rootRunId 归属，保留快照/压缩覆盖信息。', '',
  ...report.roots.filter(run => run.historyEvidence && run.historyEvidence.assistantMessages === 0).map(run => `- **${run.round}/${run.role} 没有已保存的 assistant 或工具调用消息，当前 ${run.status}/${run.stopReason ?? '-'}。六根交集只证明生命周期并发，不能称为六个角色同时有效办公或全部完成。**`), '',
  '旧运营会话与恢复会话按 runId 保留。state.priorSessions 的旧 v1/v2 不因 current session 替换而消失；每根任务的 sessionId、submissionSessionId、priorSession 可在 JSON 追溯。', '',
  '## operations v1 EMPTY_OUTPUT', '', `根任务 ${operationId} 最终失败；存在 ${report.emptyOutput.observedRecoveryCount} 次明确的空终态自动重生成记录。`, '',
  ...recovery.map(value => `- ${local(value.createdAt)}，${value.source}：recoveryIndex=${value.recoveryIndex ?? '无'}，emptyOutputRecovery=${value.emptyOutputRecovery}，内容 ${value.responseDiagnostics?.contentCharacters} 字、推理 ${value.responseDiagnostics?.reasoningCharacters} 字、chunk=${value.responseDiagnostics?.chunkCount}，prompt/completion=${value.responseDiagnostics?.promptTokens}/${value.responseDiagnostics?.completionTokens}，rawStopReason=${value.responseDiagnostics?.providerStream?.rawStopReason}。`),
  ...operationLogs.map(value => `- desktop.log:${value.line}，${value.time}，${value.message}；requestId=${value.fields.requestId}，iteration=${value.fields.iteration ?? '-'}。`),
  ...relevantDispatches.map(value => `- 请求派发证据 desktop.log:${value.line}，${value.time}，requestAttemptId=${value.fields.requestAttemptId}，wireMessageCount=${value.fields.wireMessageCount}；这是本地派发证据，不证明上游接收。`), '',
  '## 指标边界与缺口', '', ...report.unavailable.map(value => `- ${value}`), '',
  '已有：engine-process CPU、RSS/private、累计与速率 I/O、所在磁盘容量/剩余量、状态目录分类大小、桌面 HTTP 健康延迟与失败计数、部分进程树、UI 长任务累计。缺失项不得用零代替。', '',
  '## 复跑', '', `\`node scripts/analyze-office-native-performance.mjs "${path.dirname(evidence)}"\``, '',
  '脚本仅读取 state 的 submission/session 目录、events/status/metrics/desktop 日志与根 snapshot 文件，并输出 performance-audit.json/.md；不读取模型配置、数据库、凭据，不触碰 UI 或任务。运行中可复跑，报告只代表本次输入水位。', '', ...warnings.map(value => `- 警告：${value}`)]
fs.writeFileSync(path.join(evidence, 'performance-audit.md'), md.join('\n'))
console.log(JSON.stringify({ report: path.join(evidence, 'performance-audit.md'), observedUntil: report.observedUntil, phases: phases.map(({name, complete, activeUnionMs, sixRootOverlap, rootStates}) => ({name, complete, activeUnionMs, sixRootOverlap, rootStates})), recoveryCount: report.emptyOutput.observedRecoveryCount }, null, 2))
