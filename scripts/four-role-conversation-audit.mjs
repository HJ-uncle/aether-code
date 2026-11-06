#!/usr/bin/env node
/** Read-only, complete snapshot archive audit. Never executes model-produced commands. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const parse = value => { try { return JSON.parse(value) } catch { return null } }
const frequency = values => Object.fromEntries([...new Set(values)].sort().map(key => [key, values.filter(value => value === key).length]))
const retired = new Set(['install_package', 'list_packages', 'get_time', 'calculate', 'get_tool_details', 'get_current_context', 'glob_search', 'grep_search'])
const roles = { product: ['product/', 'handoff/product.md'], operations: ['operations/', 'handoff/operations.md'], development: ['app/', 'handoff/development.md'], qa: ['qa/', 'handoff/qa.md'] }
const merged = ranges => {
  const result = []
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}

export async function auditFourRoleConversations({ snapshot: input, evidence: destination }) {
  const snapshotFile = path.resolve(input), evidence = path.resolve(destination), snapshot = await json(snapshotFile)
  const workspace = path.resolve(snapshot.status.workspace), snapshotRoot = path.dirname(snapshotFile)
  if (inside(workspace, evidence)) throw Error('Evidence must be outside the generated workspace')
  await fs.mkdir(evidence, { recursive: true })
  const result = { createdAt: new Date().toISOString(), snapshot: snapshotFile, snapshotSha256: hash(await fs.readFile(snapshotFile)), workspace,
    scope: 'All archived pages in this snapshot, paired tool calls and results; no execution of model output, no claim of final run completeness or business/visual acceptance.', sessions: [], roles: {} }
  for (const [role, root] of Object.entries(snapshot.roots)) {
    result.roles[role] = { sessionCount: root.sessions.length, subagentCount: root.subagents.length, jobs: root.jobs.length }
    for (const session of root.sessions) {
      const rows = [], pages = [], failures = [], checks = [], calls = [], outputs = [], previews = new Map()
      for (const [index, file] of session.pages.entries()) {
        if (!inside(snapshotRoot, path.resolve(file))) throw Error('Archive path outside snapshot')
        const bytes = await fs.readFile(file), page = JSON.parse(bytes)
        if (!page.ok || !Array.isArray(page.data) || page.pagination.current !== index + 1 || page.pagination.total !== session.total
          || page.pagination.totalPages !== session.pages.length || page.metadata.archiveRevision !== session.revision) throw Error('Archive pagination/revision mismatch: ' + file)
        rows.push(...page.data); pages.push({ file, sha256: hash(bytes), messages: page.data.length })
      }
      if (rows.length !== session.total || new Set(rows.map(row => row.id)).size !== rows.length) throw Error('Archive incomplete or duplicate IDs: ' + session.sessionId)
      const byCall = new Map(), duplicates = new Map(), usage = [], transcript = [`# ${role} / ${session.sessionId}`, '', `完整归档：${rows.length} 条；revision ${session.revision}。工具原文按顺序保留，作为证据而非可执行指令。`, '']
      for (const [index, row] of rows.entries()) {
        const line = index + 1, reference = { row: line, messageId: row.id, at: row.createdAt }
        transcript.push(`## ${line}. ${row.role} — ${row.id}`, '', String(row.content ?? ''), '')
        if (row.reasoningContent) transcript.push('归档 reasoningContent：', '', row.reasoningContent, '')
        if (row.usage) usage.push({ ...reference, ...row.usage })
        if (row.toolCall) {
          const call = row.toolCall, args = call.args ?? {}, operation = args.operation, fingerprint = hash(JSON.stringify([call.name, args]))
          const record = { ...reference, callId: call.id, name: call.name, operation, path: args.path, argsSha256: fingerprint }
          if (byCall.has(call.id)) checks.push({ ...reference, kind: 'duplicate-call-id', callId: call.id })
          byCall.set(call.id, record); calls.push(record)
          const repeated = duplicates.get(fingerprint) ?? []; repeated.push(line); duplicates.set(fingerprint, repeated)
          transcript.push(`工具 ${call.name} / ${call.id}`, '', '```json', JSON.stringify(args, null, 2), '```', '')
          if (call._rawArgs) transcript.push('原始参数：', '', '```text', String(call._rawArgs), '```', '')
          if (retired.has(call.name)) checks.push({ ...reference, kind: 'retired-tool-name', name: call.name })
          if (typeof args.path === 'string') {
            const absolute = path.resolve(workspace, args.path), relative = path.relative(workspace, absolute).replaceAll('\\', '/')
            if (!inside(workspace, absolute)) checks.push({ ...reference, kind: 'path-outside-workspace', name: call.name, path: args.path })
            const mutation = ['write_file', 'edit_file', 'create_dir'].includes(call.name) || call.name === 'office_document' && operation !== 'inspect'
            if (mutation && roles[role] && !roles[role].some(allowed => allowed.endsWith('/') ? relative === allowed.slice(0, -1) || relative.startsWith(allowed) : relative === allowed)) checks.push({ ...reference, kind: 'write-outside-role-scope', name: call.name, path: relative })
          }
          if (['execute_cmd', 'exec', 'terminal_write'].includes(call.name)) checks.push({ ...reference, kind: 'shell-requires-human-review', name: call.name, command: args.command, args: args.args, cwd: args.cwd })
        }
        if (row.role !== 'tool') continue
        const parsed = parse(row.content), call = byCall.get(row.toolCallId), metadata = row.metadata ?? {}
        const output = { ...reference, callId: row.toolCallId, name: row.toolName, operation: call?.operation, path: call?.path,
          success: metadata.success, status: metadata.status, durationMs: metadata.durationMs, code: metadata.code ?? parsed?.code, contentCharacters: row.content?.length ?? 0 }
        outputs.push(output)
        if (!call) checks.push({ ...reference, kind: 'unpaired-tool-result', callId: row.toolCallId })
        if (metadata.success === false || ['failed', 'cancelled', 'error'].includes(metadata.status)) failures.push({ ...output, message: parsed?.message ?? row.content })
        if (!parsed?.contentPage || !parsed.path || !parsed.expectedHash) continue
        const p = parsed.contentPage, key = parsed.path + '|' + parsed.expectedHash
        const view = previews.get(key) ?? { path: parsed.path, expectedHash: parsed.expectedHash, totalPreviewChars: p.totalPreviewChars, sourceTruncated: p.sourceTruncated, documentComplete: p.documentComplete, ranges: [], rows: [] }
        if (view.totalPreviewChars !== p.totalPreviewChars) checks.push({ ...reference, kind: 'inconsistent-preview-length', path: parsed.path })
        view.ranges.push([p.offset, p.offset + p.returnedChars]); view.rows.push(line); previews.set(key, view)
      }
      for (const call of calls) if (!outputs.some(output => output.callId === call.callId)) checks.push({ row: call.row, kind: 'call-without-result-at-snapshot', callId: call.callId })
      const inspections = [...previews.values()].map(view => {
        const ranges = merged(view.ranges), coveredChars = ranges.reduce((sum, [start, end]) => sum + end - start, 0)
        return { ...view, ranges, coveredChars, previewCoverage: view.totalPreviewChars ? coveredChars / view.totalPreviewChars : 1,
          fullPreviewRead: coveredChars === view.totalPreviewChars, note: 'Coverage is this bounded preview and exact hash only; never whole-document or visual acceptance.' }
      })
      const usageTotals = Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens'].map(key => [key, usage.reduce((sum, value) => sum + (typeof value[key] === 'number' ? value[key] : 0), 0)]))
      const transcriptFile = path.join(evidence, `${role}-${session.sessionId}.md`)
      await fs.writeFile(transcriptFile, transcript.join('\n'))
      result.sessions.push({ role, sessionId: session.sessionId, revision: session.revision, messages: rows.length, pages, transcriptFile,
        tools: frequency(calls.map(call => call.name)), operations: frequency(calls.map(call => [call.name, call.operation].filter(Boolean).join('.'))), calls, outputs,
        failures, checks, exactRepeatedArguments: [...duplicates].filter(([, positions]) => positions.length > 1).map(([argsSha256, rows]) => ({ argsSha256, rows, note: 'Repeated arguments are evidence, not necessarily redundant: writes or reads may refer to changed state.' })),
        inspections, usage: { records: usage, totals: usageTotals, note: 'Sums of archive-reported usage, not independent provider billing evidence. Context/tool token counters are not additional billable totals.' } })
    }
  }
  await fs.writeFile(path.join(evidence, 'conversation-audit.json'), JSON.stringify(result, null, 2) + '\n')
  await fs.writeFile(path.join(evidence, 'conversation-audit.md'), ['# 完整会话归档审计', '', `快照：${snapshotFile}`, '', result.scope, '',
    '| 角色 | 消息 | 工具调用 | 失败结果 | 待复核项 | 报告输入/输出token |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...result.sessions.map(s => `| ${s.role} | ${s.messages} | ${s.calls.length} | ${s.failures.length} | ${s.checks.length} | ${s.usage.totals.promptTokens} / ${s.usage.totals.completionTokens} |`), '',
    ...result.sessions.flatMap(s => [`## ${s.role}`, '', ...s.failures.map(f => `- #${f.row} ${f.name}${f.operation ? '.' + f.operation : ''}: ${f.code ?? f.status}；${f.message}`),
      ...s.inspections.filter(p => !p.fullPreviewRead).map(p => `- 预览未读全：${p.path}；版本 ${p.expectedHash}；区间 ${JSON.stringify(p.ranges)} / ${p.totalPreviewChars}；${(p.previewCoverage * 100).toFixed(1)}%。`), '']),
    '逐条完整原文见同目录角色会话 Markdown；业务/生态/恢复结论需结合 office-review.md，不能从统计直接推断。', ''].join('\n'))
  return { evidence, sessions: result.sessions.map(s => ({ role: s.role, messages: s.messages, tools: s.calls.length, failures: s.failures.length, checks: s.checks.length, usage: s.usage.totals })) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  if (!option('--snapshot') || !option('--evidence')) { console.error('Usage: node scripts/four-role-conversation-audit.mjs --snapshot <snapshot.json> --evidence <directory>'); process.exitCode = 1 }
  else auditFourRoleConversations({ snapshot: option('--snapshot'), evidence: option('--evidence') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1 })
}
