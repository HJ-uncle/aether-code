/** Pure child archive presentation and compaction transport; no Electron window or build. */
import { expect, test } from '@playwright/test'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { EngineFileChange } from '../src/shared/ipc'
import type { SubagentIdentity, SubagentRunV1 } from '../src/shared/subagent'
import { workSubagentFinalAnswer, workSubagentMessages } from '../src/renderer/src/contrib/work/work-subagent-messages'
import { workMessageTimeline } from '../src/renderer/src/contrib/work/work-message-timeline'
import { workTranscriptItems } from '../src/renderer/src/contrib/work/work-subagent-transcript-presentation'
import { workToolChanges } from '../src/renderer/src/contrib/work/work-tool-presentation'
import { workSubagentLiveMessage } from '../src/renderer/src/contrib/work/work-subagent-live'
import { normalizeSubagentRun, normalizeSubagentDeltaEvent, reduceSubagentDelta, reduceSubagentRun, toSubagentView } from '../src/renderer/src/core/engine/subagent-state'

const invocation = (id: string, toolId: string, runId = 'run-one', name: string | undefined = 'read_file'): EngineHistoryRow => ({
  id, role: 'assistant', createdAt: 100, conversationId: `turn-${runId}`, metadata: { runId },
  toolCall: { id: toolId, name, args: { path: 'notes.txt' } }
})
const receipt = (id: string, toolId: string, content: string, runId = 'run-one'): EngineHistoryRow => ({
  id, role: 'tool', createdAt: 200, conversationId: `turn-${runId}`, toolCallId: toolId, content,
  success: true, metadata: { runId, toolName: 'read_file' }
})

test('owned sidechain messages retain attachments and ordinary message order without mutating the archive', () => {
  const rows: EngineHistoryRow[] = [
    { id: 'system', role: 'system', content: 'private context' },
    { id: 'user-one', role: 'user', content: '检查材料', isSidechain: true,
      metadata: { runId: 'run-one', attachments: [{ name: '.attachments/材料.png', type: 'image/png', size: 128 }] } },
    { id: 'assistant-one', role: 'assistant', content: '已检查', reasoningContent: '读取附件内容', isSidechain: true, metadata: { runId: 'run-one' } }
  ]
  const original = structuredClone(rows)
  const messages = workSubagentMessages(rows)
  expect(messages.map(message => [message.role, message.content])).toEqual([['user', '检查材料'], ['assistant', '已检查']])
  expect(messages[0].attachments).toEqual([{ path: '.attachments/材料.png', name: '材料.png', type: 'image/png', size: 128 }])
  expect(messages[1].thinking).toBe('读取附件内容')
  expect(rows).toEqual(original)
})

test('an adjacent verified tool pair stays one real invocation with its complete output', () => {
  const messages = workSubagentMessages([invocation('call-row', 'provider-call'), receipt('result-row', 'provider-call', 'file contents')])
  expect(messages).toHaveLength(1)
  expect(messages[0].tools).toHaveLength(1)
  expect(messages[0].tools[0]).toMatchObject({ name: 'read_file', result: 'file contents', state: 'done' })
  expect(JSON.parse(messages[0].tools[0].args)).toEqual({ path: 'notes.txt' })
  expect(messages[0].tools[0].metadata?.archiveOutputOnly).not.toBe(true)
})

test('a partial-page output preserves the full failure and actual file change without inventing input', () => {
  const text = `原始工具输出\n${'材料😀'.repeat(2500)}`
  const change: EngineFileChange = { id: 'change-one', sessionId: 'child', path: 'D:/workspace/notes.txt', kind: 'write',
    oldContent: 'before', newContent: 'after', truncated: false, status: 'pending', createdAt: 200 }
  const row: EngineHistoryRow = { ...receipt('result-only', 'not-resident', text), success: false,
    error: { message: '后续操作失败' }, metadata: { runId: 'run-one', toolName: 'write_file', change } }
  const messages = workSubagentMessages([row])
  expect(messages).toHaveLength(1)
  expect(messages[0].tools).toHaveLength(1)
  expect(messages[0].tools[0]).toMatchObject({ name: 'write_file', args: '', result: text, state: 'error', error: '后续操作失败',
    change, metadata: { archiveOutputOnly: true } })
  expect(workSubagentFinalAnswer(messages[0], messages)).toBe(false)
})

test('verified child history displays parent-aggregated receipts without rewriting their ownership', () => {
  const parentChange: EngineFileChange = { id: 'parent-change', sessionId: 'parent', producerChildSessionId: 'child', producerRunId: 'child-run',
    path: 'D:/workspace/notes.txt', kind: 'write', oldContent: 'before', newContent: 'after', truncated: false, status: 'pending', createdAt: 200 }
  const ownChange: EngineFileChange = { ...parentChange, id: 'own-change', sessionId: 'child' }
  const legacyChange: EngineFileChange = { ...parentChange, id: 'legacy-change', sessionId: undefined, producerChildSessionId: undefined }
  const tool = { change: parentChange, changes: [ownChange, legacyChange] }
  const original = structuredClone(tool)
  expect(workToolChanges(tool, 'child').map(change => change.id)).toEqual(['own-change', 'legacy-change'])
  const displayed = workToolChanges(tool, 'child', 'parent')
  expect(displayed.map(change => change.id)).toEqual(['parent-change', 'own-change', 'legacy-change'])
  expect(displayed[0]).toMatchObject({ sessionId: 'parent', producerChildSessionId: 'child', producerRunId: 'child-run' })
  expect(tool).toEqual(original)
})

test('child receipt scope rejects other parents, other producers, and missing provenance', () => {
  const change: EngineFileChange = { id: 'receipt', sessionId: 'parent', producerChildSessionId: 'child',
    path: 'D:/workspace/notes.txt', kind: 'write', oldContent: null, newContent: 'after', truncated: false, status: 'pending', createdAt: 200 }
  const tool = { changes: [
    { ...change, id: 'foreign-parent', sessionId: 'other-parent' },
    { ...change, id: 'foreign-child', producerChildSessionId: 'other-child' },
    { ...change, id: 'missing-producer', producerChildSessionId: undefined }
  ] }
  expect(workToolChanges(tool, 'child', 'parent')).toEqual([])
  expect(workToolChanges({ change }, 'child', 'other-parent')).toEqual([])
  expect(workToolChanges({ change }, '', 'parent')).toEqual([])
})

test('duplicate provider IDs never overwrite another invocation or discard its result', () => {
  const messages = workSubagentMessages([
    invocation('call-one', 'reused'), receipt('result-one', 'reused', 'first result'),
    invocation('call-two', 'reused'), receipt('result-two', 'reused', 'second result')
  ])
  const tools = messages.flatMap(message => message.tools)
  expect(tools).toHaveLength(4)
  expect(new Set(tools.map(tool => tool.id)).size).toBe(4)
  expect(tools.filter(tool => tool.metadata?.archiveOutputOnly).map(tool => tool.result)).toEqual(['first result', 'second result'])
  expect(tools.filter(tool => !tool.metadata?.archiveOutputOnly).map(tool => [tool.state, tool.result])).toEqual([['unknown', ''], ['unknown', '']])
})

test('a late or foreign-turn result remains in chronology and cannot complete the other turn tool', () => {
  const messages = workSubagentMessages([
    invocation('old-call', 'tool-one'),
    { id: 'new-user', role: 'user', content: '补充要求', metadata: { runId: 'run-two' }, conversationId: 'turn-run-two' },
    receipt('late-result', 'tool-one', 'old result'),
    { id: 'new-answer', role: 'assistant', content: '新要求已完成', metadata: { runId: 'run-two' }, conversationId: 'turn-run-two' }
  ])
  expect(messages.map(message => [message.role, message.runId])).toEqual([
    ['assistant', 'run-one'], ['user', 'run-two'], ['assistant', 'run-one'], ['assistant', 'run-two']
  ])
  expect(messages[0].tools[0]).toMatchObject({ result: '', state: 'unknown' })
  expect(messages[2].tools[0]).toMatchObject({ result: 'old result', metadata: { archiveOutputOnly: true } })
  const mismatched = workSubagentMessages([invocation('call', 'shared'), receipt('foreign', 'shared', 'other run', 'run-two')])
  expect(mismatched[0].tools[0].state).toBe('unknown')
  expect(mismatched[1].tools[0]).toMatchObject({ result: 'other run', metadata: { archiveOutputOnly: true } })
})

test('a legacy invocation without a name does not consume and lose the adjacent result', () => {
  const call = invocation('unnamed-call', 'legacy-id')
  call.toolCall = { id: 'legacy-id' }
  const messages = workSubagentMessages([call, receipt('named-result', 'legacy-id', 'legacy output')])
  const tools = messages.flatMap(message => message.tools)
  expect(tools.some(tool => tool.name === 'read_file' && tool.result === 'legacy output')).toBe(true)
})

test('assistant failures remain attached to their own turn, including error-only rows', () => {
  const messages = workSubagentMessages([
    { id: 'first', role: 'assistant', content: '正在检查', metadata: { runId: 'run-one' }, conversationId: 'turn-one' },
    { id: 'failure', role: 'assistant', error: { message: '连接失败' }, metadata: { runId: 'run-one' }, conversationId: 'turn-one' },
    { id: 'next-user', role: 'user', content: '继续', metadata: { runId: 'run-two' }, conversationId: 'turn-two' },
    { id: 'next-answer', role: 'assistant', content: '已继续', metadata: { runId: 'run-two' }, conversationId: 'turn-two' },
    { id: 'last-error', role: 'assistant', metadata: { runId: 'run-three', error: { message: '上下文不足' } }, conversationId: 'turn-three' }
  ])
  expect(messages[0]).toMatchObject({ content: '正在检查', error: '连接失败', status: 'error' })
  expect(messages[2]).toMatchObject({ content: '已继续', status: 'done' })
  expect(messages[2].error).toBeUndefined()
  expect(messages[3]).toMatchObject({ error: '上下文不足', status: 'error' })
})

test('archived question receipts remain readable without acquiring live approval controls', () => {
  const question = invocation('question-call', 'ask', 'run-one', 'ask_user')
  question.toolCall = { id: 'ask', name: 'ask_user', args: { question: '使用哪个素材版本？', options: ['版本一', '版本二'] } }
  const result: EngineHistoryRow = { ...receipt('question-result', 'ask', '等待用户选择'),
    metadata: { runId: 'run-one', toolName: 'ask_user', status: 'waiting' } }
  const messages = workSubagentMessages([question, result])
  expect(messages[0].tools[0]).toMatchObject({ name: 'ask_user', hidden: false, state: 'waiting', result: '等待用户选择' })
  expect(JSON.parse(messages[0].tools[0].args)).toEqual({ question: '使用哪个素材版本？', options: ['版本一', '版本二'] })
  expect(messages[0].pending).toBeUndefined()
  expect(workMessageTimeline(messages[0]).map(segment => segment.kind)).toEqual(['tools'])
})

test('interrupted and cancelled assistant records do not inherit a later completed turn', () => {
  const messages = workSubagentMessages([
    { id: 'interrupted', role: 'assistant', content: '之前的进度', metadata: { runId: 'first', status: 'interrupted' } },
    { id: 'cancelled', role: 'assistant', content: '已停止的进度', metadata: { runId: 'second', status: 'cancelled' } },
    { id: 'completed', role: 'assistant', content: '后续结果', metadata: { runId: 'third' } }
  ])
  expect(messages.map(message => [message.id, message.status])).toEqual([
    ['interrupted', 'interrupted'], ['cancelled', 'aborted'], ['completed', 'done']
  ])
})

test('only the last prose of a turn can be an answer and an exact active run remains process', () => {
  const messages = workSubagentMessages([
    { id: 'progress', role: 'assistant', content: '检查文件', metadata: { runId: 'run-one' }, conversationId: 'turn-run-one' },
    invocation('call', 'tool'), receipt('result', 'tool', 'file output'),
    { id: 'answer', role: 'assistant', content: '检查完成', metadata: { runId: 'run-one' }, conversationId: 'turn-run-one' }
  ])
  expect(workMessageTimeline(messages[0]).map(segment => segment.kind)).toEqual(['content', 'tools', 'content'])
  expect(workSubagentFinalAnswer(messages[0], messages)).toEqual({ text: '检查完成' })
  expect(workSubagentFinalAnswer(messages[0], messages, 'run-one')).toBe(false)
  expect(workSubagentFinalAnswer(messages[0], messages, 'different-run')).toEqual({ text: '检查完成' })
  const unfinished = workSubagentMessages([invocation('call-only', 'tool')])
  expect(workSubagentFinalAnswer(unfinished[0], unfinished)).toBe(false)
})

test('new child invocation metadata separates runs sharing the same parent root and turn', () => {
  const rows: EngineHistoryRow[] = [
    { id: 'child-first', role: 'assistant', content: '第一轮完成', conversationId: 'parent-turn',
      metadata: { rootRunId: 'parent-root', subagentRunId: 'child-one' } },
    { id: 'child-second', role: 'assistant', content: '第二轮进度', conversationId: 'parent-turn',
      metadata: { rootRunId: 'parent-root', runId: 'parent-root', subagentRunId: 'child-two' } }
  ]
  const original = structuredClone(rows)
  const messages = workSubagentMessages(rows)
  expect(messages.map(message => [message.runId, message.conversationId, message.content])).toEqual([
    ['child-one', 'parent-turn', '第一轮完成'], ['child-two', 'parent-turn', '第二轮进度']
  ])
  expect(workSubagentFinalAnswer(messages[0], messages, 'child-two')).toEqual({ text: '第一轮完成' })
  expect(workSubagentFinalAnswer(messages[1], messages, 'child-two')).toBe(false)
  expect(rows).toEqual(original)
})

test('legacy child rows retain parent identity and are not relabeled as the current invocation', () => {
  const rows: EngineHistoryRow[] = [
    { id: 'legacy-one', role: 'assistant', content: '旧版记录', conversationId: 'parent-turn', metadata: { rootRunId: 'parent-root' } },
    { id: 'legacy-two', role: 'assistant', content: '旧版结果', conversationId: 'parent-turn', metadata: { rootRunId: 'parent-root', subagentRunId: '' } },
    { id: 'new-child', role: 'assistant', content: '新的执行', conversationId: 'parent-turn', metadata: { rootRunId: 'parent-root', subagentRunId: 'child-current' } }
  ]
  const messages = workSubagentMessages(rows)
  expect(messages.map(message => message.runId)).toEqual(['parent-root', 'child-current'])
  expect(messages[0].content).toBe('旧版记录\n\n旧版结果')
  expect(workSubagentFinalAnswer(messages[0], messages, 'child-current')).toEqual({ text: '旧版记录\n\n旧版结果' })
  expect(workSubagentFinalAnswer(messages[1], messages, 'child-current')).toBe(false)
  expect(rows[0].metadata).toEqual({ rootRunId: 'parent-root' })
})

test('archive pairing uses child invocation identity before a shared parent root ID', () => {
  const call: EngineHistoryRow = { ...invocation('child-call', 'provider-reused'), conversationId: 'parent-turn',
    metadata: { rootRunId: 'parent-root', subagentRunId: 'child-one' } }
  const result: EngineHistoryRow = { ...receipt('child-result', 'provider-reused', 'other invocation output'), conversationId: 'parent-turn',
    metadata: { rootRunId: 'parent-root', subagentRunId: 'child-two', toolName: 'read_file' } }
  expect(workTranscriptItems([call, result])).toHaveLength(2)
  const messages = workSubagentMessages([call, result])
  expect(messages.map(message => message.runId)).toEqual(['child-one', 'child-two'])
  expect(messages[0].tools[0]).toMatchObject({ state: 'unknown', result: '' })
  expect(messages[1].tools[0]).toMatchObject({ result: 'other invocation output', metadata: { archiveOutputOnly: true } })
  const sameInvocation = { ...result, metadata: { ...result.metadata, subagentRunId: 'child-one' } }
  expect(workTranscriptItems([call, sameInvocation])).toHaveLength(1)
  expect(workSubagentMessages([call, sameInvocation])[0].tools).toHaveLength(1)
})

function childRun(overrides: Partial<SubagentRunV1> = {}): SubagentRunV1 {
  return { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'parent-turn', parentMessageId: 'parent-message', parentToolCallId: 'dispatch-tool', childSessionId: 'child',
    task: '执行需求', description: '执行', modelId: 'model', status: 'running', lastSeq: 1, createdAt: 100, updatedAt: 100,
    usage: {}, toolCalls: [], ...overrides }
}
function identity(run: SubagentRunV1): SubagentIdentity {
  return { tenantId: run.tenantId, rootSessionId: run.rootSessionId, parentSessionId: run.parentSessionId,
    parentConversationId: run.parentConversationId, parentMessageId: run.parentMessageId,
    parentToolCallId: run.parentToolCallId, childSessionId: run.childSessionId }
}

test('live preview never displays a foreign child or a terminal invocation', () => {
  const run = childRun({ partialOutput: '临时进度', toolCalls: [{ id: 'active-tool', name: 'read_file', args: {}, status: 'running' }] })
  expect(workSubagentLiveMessage(undefined, 'child', [])).toBeUndefined()
  expect(workSubagentLiveMessage(run, 'another-child', [])).toBeUndefined()
  for (const status of ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'] as const) {
    expect(workSubagentLiveMessage({ ...run, status }, 'child', [])).toBeUndefined()
  }
})

test('exact current-run archive text and original tool IDs suppress duplicate live preview', () => {
  const messages = workSubagentMessages([
    invocation('persisted-call', 'active-tool', 'child-run'),
    { id: 'persisted-text', role: 'assistant', content: '前序正文\n临时进度', conversationId: 'turn-child-run', metadata: { subagentRunId: 'child-run' } }
  ])
  expect(messages[0].tools[0].metadata?.archiveToolCallId).toBe('active-tool')
  const run = childRun({ partialOutput: '临时进度', toolCalls: [{ id: 'active-tool', name: 'read_file', args: {}, status: 'running' }] })
  expect(workSubagentLiveMessage(run, 'child', messages)).toBeUndefined()
})

test('identical text and reused tool IDs in an earlier run cannot swallow current live preview', () => {
  const messages = workSubagentMessages([
    invocation('previous-call', 'reused-tool', 'previous-run'),
    { id: 'previous-text', role: 'assistant', content: '相同进度', conversationId: 'turn-previous-run', metadata: { subagentRunId: 'previous-run' } }
  ])
  const run = childRun({ partialOutput: '相同进度', toolCalls: [{ id: 'reused-tool', name: 'read_file', args: {}, status: 'running' }] })
  const preview = workSubagentLiveMessage(run, 'child', messages)
  expect(preview).toMatchObject({ id: 'live:child-run', runId: 'child-run', content: '相同进度', status: 'streaming' })
  expect(preview?.tools.map(tool => tool.id)).toEqual(['live:child-run:reused-tool'])
})

test('live preview retains at most eight active tools and the latest 4000 text characters', () => {
  const active = Array.from({ length: 12 }, (_, index) => ({ id: `active-${index}`, name: 'read_file', args: { path: `${index}.txt` }, status: 'running' as const }))
  const run = childRun({ partialOutput: `旧进度${'新'.repeat(4000)}`, toolCalls: [...active,
    { id: 'finished-tool', name: 'read_file', args: {}, status: 'succeeded' }] })
  const original = structuredClone(run)
  const preview = workSubagentLiveMessage(run, 'child', [])
  expect(preview?.content).toBe('新'.repeat(4000))
  expect(preview?.tools.map(tool => tool.id)).toEqual(active.slice(-8).map(tool => `live:child-run:${tool.id}`))
  expect(preview?.tools.every(tool => tool.state === 'running' && tool.metadata?.livePreview === true)).toBe(true)
  expect(preview?.items).toHaveLength(9)
  expect(run).toEqual(original)
})

test('compaction snapshots preserve real counters and bound Unicode errors to the engine 1024-byte limit', () => {
  const error = '上下文😀'.repeat(2000)
  const run = normalizeSubagentRun(childRun({ compaction: { phase: 'failed', startedAt: 110, finishedAt: 120,
    beforeTokens: 50000, afterTokens: 13000, error } }))
  expect(run?.compaction).toMatchObject({ phase: 'failed', startedAt: 110, finishedAt: 120, beforeTokens: 50000, afterTokens: 13000 })
  const text = run?.compaction?.error ?? ''
  expect(text.length).toBeGreaterThan(0)
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(1024)
  expect(error.startsWith(text)).toBe(true)
  expect(text.endsWith('\uD83D')).toBe(false)
  expect(normalizeSubagentRun(toSubagentView(run!))?.compaction).toEqual(run?.compaction)
  expect(normalizeSubagentRun({ ...childRun(), compaction: { phase: 'invented', startedAt: 100 } })?.compaction).toBeUndefined()
})

test('existing output.updated deltas carry compaction start and completion without a sequence gap', () => {
  const initial = childRun()
  const started = reduceSubagentDelta(initial, { schemaVersion: 2, kind: 'output.updated', runId: initial.runId,
    seq: 2, baseSeq: 1, identity: identity(initial), headerPatch: { updatedAt: 110, compaction: { phase: 'running', startedAt: 110, beforeTokens: 50000 } } })
  expect(started.status).toBe('applied')
  expect(started.run?.compaction).toEqual({ phase: 'running', startedAt: 110, beforeTokens: 50000 })
  const completed = reduceSubagentDelta(started.run, { schemaVersion: 2, kind: 'output.updated', runId: initial.runId,
    seq: 3, baseSeq: 2, identity: identity(initial), headerPatch: { updatedAt: 120,
      compaction: { phase: 'succeeded', startedAt: 110, finishedAt: 120, beforeTokens: 50000, afterTokens: 13000 } } })
  expect(completed.status).toBe('applied')
  expect(completed.run).toMatchObject({ lastSeq: 3, status: 'running', compaction: { phase: 'succeeded', afterTokens: 13000 } })
  const conflicting = { ...completed.run, compaction: { phase: 'failed', startedAt: 110, finishedAt: 120, error: 'conflicting snapshot' } }
  expect(reduceSubagentRun(completed.run, conflicting)).toMatchObject({ status: 'invalid', reason: 'same-seq scalar conflict' })
})

test('invalid compaction deltas cannot change the previous run or introduce a new event kind', () => {
  const initial = childRun()
  const delta = { schemaVersion: 2, kind: 'output.updated', runId: initial.runId, seq: 2, baseSeq: 1,
    identity: identity(initial), headerPatch: { compaction: { phase: 'invented', startedAt: 110 } } }
  expect(normalizeSubagentDeltaEvent(delta)).toBeUndefined()
  expect(reduceSubagentDelta(initial, delta).status).toBe('invalid')
  expect(initial.compaction).toBeUndefined()
  expect(normalizeSubagentDeltaEvent({ ...delta, kind: 'compaction.updated', headerPatch: {} })).toBeUndefined()
})
