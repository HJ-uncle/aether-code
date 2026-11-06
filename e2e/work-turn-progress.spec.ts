/** Pure turn-progress ownership: stable turn/run/tool/receipt links, late arrivals,
 * ambiguous and unloaded owners, session isolation and retained review decisions. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { workProgressChanges } from '../src/renderer/src/contrib/work/work-progress-state'
import { workProgressTurnScope, workTurnProgressChanges, type WorkTurnProgressGroup } from '../src/renderer/src/contrib/work/work-turn-progress'

const session = 'session'
const change = (id: string, patch: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id, sessionId: session, path: 'D:/work/report.md', kind: 'write', oldContent: null,
  newContent: id, truncated: false, status: 'pending', createdAt: 1, ...patch
})
const run = (turnId: string, patch: Partial<RootRun> = {}): RootRun => ({
  schemaVersion: 1, sessionId: session, runId: `run-${turnId}`, turnId,
  userMessageId: `user-${turnId}`, assistantMessageId: `assistant-${turnId}`,
  version: 1, seq: 1, status: 'succeeded', createdAt: 1, updatedAt: 1, pending: [], ...patch
})
const tool = (id: string, patch: Partial<ToolActivity> = {}): ToolActivity => ({
  id, name: 'write_file', args: '{}', result: '', state: 'done', ...patch
})
const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch
})
const group = (id: string, ...messages: ChatMessage[]): WorkTurnProgressGroup => ({ id, messages })
const files = (...changes: EngineFileChange[]) => workProgressChanges(session, [], changes, 'D:/work')
const ids = (result: ReturnType<typeof workTurnProgressChanges>, id: string): string[] =>
  (result.get(id) ?? []).flatMap(file => file.records.map(record => record.id))

test('显式轮次优先，同路径跨轮独立分组，迟到回执仍回原轮', () => {
  const groups = [group('first', message('one', { conversationId: 'turn-1', runId: 'run-1' })),
    group('second', message('two', { conversationId: 'turn-2', runId: 'run-2', tools: [tool('new-tool')] }))]
  const records = files(change('first', { turnId: 'turn-1', createdAt: 5, status: 'kept' }),
    change('second', { turnId: 'turn-2', createdAt: 2, status: 'reverted' }),
    change('late', { turnId: 'turn-1', runId: 'run-2', toolCallId: 'new-tool', createdAt: 100 }))
  const result = workTurnProgressChanges(session, groups, records, 'D:/work')
  expect(ids(result, 'first')).toEqual(['first', 'late'])
  expect(ids(result, 'second')).toEqual(['second'])
  expect(result.get('first')?.[0].latest.id).toBe('late')
  expect(result.get('first')?.[0].records[0].status).toBe('kept')
  expect(result.get('second')?.[0].latest.status).toBe('reverted')
  expect(records).toHaveLength(1)
})

test('未加载的显式轮次和重复映射不退回 run、tool 或最近一轮', () => {
  const groups = [group('one', message('one', { conversationId: 'duplicate', runId: 'run', tools: [tool('tool')] })),
    group('two', message('two', { conversationId: 'duplicate' })), group('latest', message('latest'))]
  const result = workTurnProgressChanges(session, groups, files(
    change('unloaded', { turnId: 'not-loaded', runId: 'run', toolCallId: 'tool' }),
    change('ambiguous', { turnId: 'duplicate', runId: 'run' }), change('unknown')
  ))
  expect([...result]).toEqual([])
})

test('缺少 turnId 时可用 run、工具调用和同 ID 的消息回执分别定位', () => {
  const legacy = change('receipt', { sessionId: undefined })
  const groups = [group('one', message('one', { run: run('turn-1') })),
    group('two', message('two', { tools: [tool('call-2')] })),
    group('three', message('three', { tools: [tool('call-3', { change: legacy })] }))]
  const result = workTurnProgressChanges(session, groups, files(change('run', { runId: 'run-turn-1' }),
    change('tool', { toolCallId: 'call-2' }), change('receipt', { status: 'kept' })))
  expect(ids(result, 'one')).toEqual(['run'])
  expect(ids(result, 'two')).toEqual(['tool'])
  expect(ids(result, 'three')).toEqual(['receipt'])
  expect(result.get('three')?.[0].latest.status).toBe('kept')
  expect(legacy).toMatchObject({ sessionId: undefined, status: 'pending' })
})

test('同一标识跨组歧义以及不同标识指向不同组均不推测归属', () => {
  const duplicated = change('duplicate-receipt')
  const groups = [group('one', message('one', { runId: 'run-1', tools: [tool('same-tool'), tool('first', { change: duplicated })] })),
    group('two', message('two', { runId: 'run-2', tools: [tool('same-tool'), tool('second', { change: duplicated })] }))]
  const result = workTurnProgressChanges(session, groups, files(
    change('duplicate-tool', { toolCallId: 'same-tool' }), duplicated,
    change('conflicting', { runId: 'run-1', toolCallId: 'second' }),
    change('duplicate-receipt', { runId: 'run-1' })
  ))
  expect([...result]).toEqual([])
})

test('外会话消息、回执与命令快照均不参与归属', () => {
  const foreign = change('foreign', { sessionId: 'other', turnId: 'same-turn' })
  const job: NonNullable<ToolActivity['commandJob']> = {
    schemaVersion: 1, jobId: 'job', sessionId: 'other', ownerSessionId: 'other',
    version: 1, command: 'node', args: [], cwd: 'D:/work', background: true, status: 'succeeded',
    createdAt: 1, updatedAt: 2, cursor: 0, earliestCursor: 0, exitCode: 0, signal: null,
    changes: [change('foreign-job', { sessionId: undefined })]
  }
  const groups = [group('foreign', message('foreign', { conversationId: 'same-turn', runId: 'foreign-run',
    run: run('same-turn', { sessionId: 'other' }), tools: [tool('foreign-tool', { change: change('foreign-id') })] })),
    group('mine', message('mine', { tools: [tool('mine', { changes: [foreign], commandJob: job })] }))]
  const result = workTurnProgressChanges(session, groups, [
    ...files(change('turn', { turnId: 'same-turn' }), change('run', { runId: 'foreign-run' }),
      change('tool', { toolCallId: 'foreign-tool' }), change('foreign-id'), change('foreign-job')),
    { key: 'foreign', latest: foreign, records: [foreign] }
  ])
  expect([...result]).toEqual([])
  expect([...workTurnProgressChanges('', groups, files(change('turn', { turnId: 'same-turn' })))]).toEqual([])
})

test('已合并的确认状态保留，重复回执去重且输入保持不变', () => {
  const streamed = change('same', { sessionId: undefined })
  const groups = [group('legacy', message('legacy', { tools: [tool('legacy', { change: streamed })] }))]
  const progress = workProgressChanges(session, groups[0].messages[0].tools, [change('same', { status: 'reverted' })])
  const before = JSON.stringify({ groups, progress })
  const result = workTurnProgressChanges(session, groups, [...progress, ...progress])
  expect(ids(result, 'legacy')).toEqual(['same'])
  expect(result.get('legacy')?.[0].latest.status).toBe('reverted')
  expect(JSON.stringify({ groups, progress })).toBe(before)
})

test('相同 ID 的不同路径或类型不构成归属，重复组 ID 不合并不同轮', () => {
  const groups = [group('one', message('one', { tools: [tool('one', { change: change('same') })] }))]
  expect([...workTurnProgressChanges(session, groups, files(change('same', { path: 'D:/else/report.md' })))]).toEqual([])
  expect([...workTurnProgressChanges(session, groups, files(change('same', { kind: 'delete' })))]).toEqual([])
  expect([...workTurnProgressChanges(session, [group('duplicate', message('a', { conversationId: 'a' })),
    group('duplicate', message('b', { conversationId: 'b' }))], files(change('a', { turnId: 'a' })))]).toEqual([])
})

test('后续消息再次携带旧回执时用原始身份，未加载的来源不成为观察轮的改动', () => {
  const earlier = change('earlier', { turnId: 'turn-1', runId: 'run-1' })
  const unloaded = change('unloaded', { turnId: 'unloaded' })
  const groups = [group('first', message('first', { conversationId: 'turn-1', runId: 'run-1' })),
    group('later', message('later', { conversationId: 'turn-2', tools: [tool('observe', { changes: [earlier, unloaded] })] }))]
  const result = workTurnProgressChanges(session, groups, files(change('earlier'), change('unloaded')))
  expect(ids(result, 'first')).toEqual(['earlier'])
  expect(ids(result, 'later')).toEqual([])
})

test('成果导航只承诺组内一致的可靠轮次，旧记录与冲突返回未关联范围', () => {
  expect(workProgressTurnScope(session, group('one', message('u', { conversationId: 'turn' }),
    message('a', { run: run('turn') })))).toEqual({ kind: 'turn', turnId: 'turn' })
  expect(workProgressTurnScope(session, group('run', message('a', { run: run('run-only') })))).toEqual({ kind: 'turn', turnId: 'run-only' })
  expect(workProgressTurnScope(session, group('legacy', message('legacy', { runId: 'run-only' })))).toEqual({ kind: 'unassociated' })
  expect(workProgressTurnScope(session, group('conflict', message('a', { conversationId: 'first', run: run('second') })))).toEqual({ kind: 'unassociated' })
  expect(workProgressTurnScope(session, group('foreign', message('a', { conversationId: 'foreign', run: run('foreign', { sessionId: 'other' }) })))).toEqual({ kind: 'unassociated' })
  expect(workProgressTurnScope('', group('one', message('one', { conversationId: 'turn' })))).toEqual({ kind: 'unassociated' })
})

test('未加载的显式 run 或 tool 身份不能降级到后来携带回执的观察消息', () => {
  const unloadedRun = change('unloaded-run', { runId: 'not-loaded' })
  const unloadedTool = change('unloaded-tool', { toolCallId: 'not-loaded' })
  const partial = change('partially-known', { runId: 'not-loaded', toolCallId: 'observe' })
  const groups = [group('later', message('later', { conversationId: 'new-turn', tools: [
    tool('observe', { changes: [unloadedRun, unloadedTool, partial] })
  ] }))]
  expect([...workTurnProgressChanges(session, groups, files(unloadedRun, unloadedTool, partial))]).toEqual([])
  expect([...workTurnProgressChanges(session, groups, files(change('unloaded-run'), change('unloaded-tool'), change('partially-known')))]).toEqual([])
})
