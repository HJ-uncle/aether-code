#!/usr/bin/env node
// Saved receipt audit only: never connects to the running app or changes business outputs.
import fs from 'node:fs'
import path from 'node:path'

const input = path.resolve(process.argv[2] ?? '.ae/work-office-native-20261024164939')
const evidence = path.basename(input) === 'evidence' ? input : path.join(input, 'evidence')
const reportPath = path.join(evidence, 'readonly-calculate-audit.json')
const previous = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const state = JSON.parse(fs.readFileSync(path.join(path.dirname(evidence), 'state.json'), 'utf8'))
const admissions = new Map(), rootsByTurn = new Map(), children = new Map(), sources = {}
for (const [role, current] of Object.entries(state.roles ?? {})) {
  for (const session of [current, ...(current.priorSessions ?? [])]) {
    for (const admission of session.submissions ?? []) {
      if (admission.runId) admissions.set(admission.runId, { role, phase: admission.round })
    }
  }
}
const snapshots = fs.readdirSync(evidence)
  .filter(name => /^(operations|finance|people|sales|product|legal)-.*-snapshot\.json$/.test(name) && !name.includes('-subagent-'))
  .map(name => {
    const filename = path.join(evidence, name), stat = fs.statSync(filename)
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    sources[name] = { sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }
    for (const run of [...(value.runs ?? []), ...(value.run ? [value.run] : [])]) {
      const admission = admissions.get(run.runId)
      if (run.turnId && admission) rootsByTurn.set(run.turnId, { rootRunId: run.runId, ...admission })
    }
    return { name, value }
  })
for (const { name, value } of snapshots) {
  for (const child of value.subagentRuns ?? []) {
    const existing = children.get(child.runId)
    const calls = existing?.calls ?? new Map()
    // A later progress snapshot must not erase already persisted failed/successful receipts.
    for (const call of child.toolCalls ?? []) {
      const prior = calls.get(call.id)
      if (!prior || (call.finishedAt ?? call.startedAt ?? 0) >= (prior.finishedAt ?? prior.startedAt ?? 0)) calls.set(call.id, call)
    }
    if (!existing || (child.updatedAt ?? 0) >= (existing.child.updatedAt ?? 0)) children.set(child.runId, { child, source: name, calls })
  }
}
const failures = []
const calculations = [...children.values()].filter(({ child, calls }) => child.continuation?.readOnly === true && [...calls.values()].some(call => call.name === 'calculate'))
  .map(({ child, source, calls }) => {
    const root = rootsByTurn.get(child.parentConversationId)
    const calculateCalls = [...calls.values()].filter(call => call.name === 'calculate').map(call => {
      if (call.status !== 'succeeded') failures.push({ runId: child.runId, callId: call.id, role: root?.role ?? null,
        phase: root?.phase ?? null, reason: typeof call.output === 'string' && call.output.includes('disallowed characters')
          ? 'Math error: Invalid expression: contains disallowed characters' : 'See saved receipt; failure detail not copied to avoid including unrelated output.' })
      return { id: call.id, status: call.status, startedAt: call.startedAt, finishedAt: call.finishedAt }
    })
    return { source, runId: child.runId, childSessionId: child.childSessionId, rootRunId: root?.rootRunId ?? null,
      phase: root?.phase ?? null, role: root?.role ?? null, status: child.status, readOnly: true,
      toolNames: child.continuation.toolNames, calculateCalls, observedToolNames: [...new Set([...calls.values()].map(call => call.name))] }
  }).sort((a, b) => `${a.role}/${a.phase}/${a.runId}`.localeCompare(`${b.role}/${b.phase}/${b.runId}`))
// Keep original failures visible even after role/session migrations.
const knownCalls = new Set(calculations.flatMap(row => row.calculateCalls.map(call => `${row.runId}:${call.id}`)))
const missingHistoricalCalls = previous.calculations.flatMap(row => row.calculateCalls.filter(call => !knownCalls.has(`${row.runId}:${call.id}`)).map(call => `${row.runId}:${call.id}`))
if (missingHistoricalCalls.length) throw new Error(`Refusing to discard ${missingHistoricalCalls.length} historical calculation receipts`)
const total = calculations.reduce((sum, row) => sum + row.calculateCalls.length, 0)
const report = { ...previous, generatedAt: new Date().toISOString(), calculations,
  calculateResults: { total, successful: total - failures.length, failed: failures }, snapshotSources: sources }
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
const md = [
  '# Readonly calculate 授权边界复核', '', `生成：${report.generatedAt}`, '',
  '结论：本轮 calculate/get_time 授权绑定受信内置实现；未发现同名扩展可凭名字取得只读子代理权限。这是定向审查，不是完整安全认证。', '',
  '## 代码证据', '', ...report.sourceEvidence.map(item => `- ${item.path}:${item.line} — ${item.claim}`), '',
  '## 真实子任务回执', '', '| 角色 / 阶段 | 子 runId | calculate 成功 / 总数 | 子任务状态 |', '|---|---|---|---|',
  ...calculations.map(row => `| ${row.role} / ${row.phase} | ${row.runId} | ${row.calculateCalls.filter(call => call.status === 'succeeded').length} / ${row.calculateCalls.length} | ${row.status} |`), '',
  `共 ${calculations.length} 个只读子 run 调用 calculate ${total} 次，成功 ${total - failures.length} 次，失败 ${failures.length} 次。`, '',
  ...failures.map(item => `- ${item.role} / ${item.phase}，${item.callId}：${item.reason}`), '',
  '数字表达式只允许数字、运算符、括号、空白和小数点，并拒绝非有限数；get_time 只格式化当前时间。非法表达式被拒不代表授权缺失。历史失败按 runId 保留。', '',
  ...report.limitations.map(item => `- ${item}`), '',
  '复跑：node scripts/analyze-office-readonly-calculations.mjs .ae/work-office-native-20261024164939', ''
].join('\n')
fs.writeFileSync(path.join(evidence, 'readonly-calculate-audit.md'), md)
console.log(JSON.stringify({ reportPath, children: calculations.length, total, succeeded: total - failures.length, failed: failures.length }))
