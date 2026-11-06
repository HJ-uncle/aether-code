/** Pure contracts: authenticated supplement identity and opted-in complete root display bodies. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import { replayMessages, type EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { applyProjectedUserMessage } from '../src/renderer/src/core/engine/chat-timeline'
import { cacheDisplayHistory, checkDisplayHistory, mergeDisplayHistory, type DisplayHistoryPage } from '../src/renderer/src/core/engine/display-history'
import { isRootFollowupFor, normalizeRootFollowupMessage } from '../src/renderer/src/core/engine/root-followup-message'

const run: RootRun = { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'original',
  assistantMessageId: 'final', version: 1, seq: 1, status: 'running', createdAt: 100, updatedAt: 110, modelId: 'model', pending: [] }
const initial: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: 'Original task', conversationId: run.turnId,
  metadata: { rootRunId: run.runId, turnId: run.turnId }, createdAt: 100 }
const supplement = (index = 1): EngineHistoryRow => ({ id: `controller:${index}`, role: 'user', content: `Supplement ${index}`,
  conversationId: run.turnId, createdAt: 200 + index, metadata: { rootRunId: run.runId, turnId: run.turnId,
    collaborationDelivery: { version: 1, source: 'user-controller', messageId: `mail-${index}`, rootRunId: run.runId,
      recipientInvocationRunId: 'rootinv:attempt-hash' } } })
const assistant = (id: string, content: string): EngineHistoryRow => ({ id, role: 'assistant', content,
  conversationId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId }, createdAt: 210 })
function rootRows(count = 1): EngineHistoryRow[] {
  return [initial, ...Array.from({ length: count }, (_, index) => [assistant(`before-${index}`, `Step ${index}`), supplement(index + 1)]).flat(),
    assistant(run.assistantMessageId, 'Final output')]
}
const nextRows: EngineHistoryRow[] = [
  { id: 'next-user', role: 'user', content: 'Next task', conversationId: 'next-turn', metadata: { rootRunId: 'next-root', turnId: 'next-turn' } },
  { id: 'next-answer', role: 'assistant', content: 'Next answer', conversationId: 'next-turn', metadata: { rootRunId: 'next-root', turnId: 'next-turn' } }
]
function page(bodies: EngineHistoryRow[][], grouping: 'root' | null = 'root', selected = bodies): DisplayHistoryPage {
  return { schemaVersion: 1, ...(grouping ? { grouping } : {}),
    turns: bodies.map(rows => ({ userMessageId: rows[0].id!, conversationId: rows[0].conversationId, preview: String(rows[0].content) })),
    messages: selected.flat(), loadedTurnIds: selected.map(rows => rows[0].id!), revision: 'r1', mutationRevision: 'm1', backend: 'jsonl', completeness: 'complete' }
}

test('only a consistent controller delivery envelope marks a root supplement', () => {
  const row = supplement(), delivery = row.metadata!.collaborationDelivery as Record<string, unknown>
  const expected = { messageId: 'mail-1', rootRunId: run.runId, turnId: run.turnId }
  expect(normalizeRootFollowupMessage(row)).toEqual(expected)
  expect(normalizeRootFollowupMessage({ ...row, conversationId: undefined })).toEqual(expected)
  for (const patch of [{ version: 2 }, { source: 'peer' }, { rootRunId: 'foreign' }, { recipientInvocationRunId: '' }, { messageId: '' }])
    expect(normalizeRootFollowupMessage({ ...row, metadata: { ...row.metadata, collaborationDelivery: { ...delivery, ...patch } } })).toBeUndefined()
  for (const patch of [{ rootRunId: undefined }, { runId: 'foreign' }, { turnId: 'foreign' }, { turnId: undefined }])
    expect(normalizeRootFollowupMessage({ ...row, metadata: { ...row.metadata, ...patch } })).toBeUndefined()
  expect(normalizeRootFollowupMessage({ ...row, role: 'assistant' })).toBeUndefined()
  expect(normalizeRootFollowupMessage({ ...row, metadata: undefined, content: '[用户追加指令]' } as EngineHistoryRow)).toBeUndefined()
  const [owner, followup] = replayMessages([initial, row])
  expect(isRootFollowupFor(followup, owner)).toBe(true)
  expect(isRootFollowupFor(followup, { ...owner, runId: 'next-root' })).toBe(false)
  expect(isRootFollowupFor(followup, { ...owner, conversationId: 'next-turn' })).toBe(false)
  expect(isRootFollowupFor(followup, followup)).toBe(false)
})

test('live enrichment cannot turn incomplete metadata into supplement evidence', () => {
  const row = supplement()
  const malformed = { ...row, metadata: { ...row.metadata, rootRunId: undefined } }
  const messages = applyProjectedUserMessage(applyProjectedUserMessage([], initial, run), malformed, run)
  expect(messages.find(message => message.id === row.id)?.rootFollowup).toBeUndefined()
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
})

for (const source of ['live', 'persisted-published', 'persisted'] as const) {
  test(`${source} keeps five supplement markers and physical assistant segments`, () => {
    const history = rootRows(5)
    const snapshot: ChatRecoverySnapshot = { schemaVersion: 1, source, sessionId: run.sessionId, eventId: 'stream:20', finished: false,
      projection: source === 'persisted' ? [] : history.map(row => row.role === 'user' ? { userMessage: row } : { content: String(row.content) }),
      run, runs: [run], history, todos: [], changes: [] }
    const restored = restoreChatSnapshot(snapshot).messages
    expect(restored.filter(message => message.rootFollowup).map(message => message.rootFollowup?.messageId))
      .toEqual(Array.from({ length: 5 }, (_, index) => `mail-${index + 1}`))
    expect(restored.filter(message => message.role === 'assistant')).toHaveLength(6)
    expect(new Set(restored.map(message => message.id)).size).toBe(12)
    expect(restored.filter(message => message.status === 'streaming')).toHaveLength(1)
    expect(restored[0].rootFollowup).toBeUndefined()
    expect(restored.every(message => message.runId === run.runId && message.conversationId === run.turnId)).toBe(true)
  })
}

test('root display bodies keep supplements in their original admission while the next turn remains separate', () => {
  const rows = rootRows(5), checked = checkDisplayHistory(page([rows, nextRows]))
  const cache = cacheDisplayHistory(run.sessionId, checked)
  expect(checked.grouping).toBe('root')
  expect([...cache.bodies.keys()]).toEqual([run.userMessageId, 'next-user'])
  expect(cache.bodies.get(run.userMessageId)?.filter(message => message.role === 'user')).toHaveLength(6)
  expect(cache.bodies.get('next-user')?.map(message => message.content)).toEqual(['Next task', 'Next answer'])
  expect(mergeDisplayHistory(cache, [], new Set()).map(message => message.id)).toEqual(replayMessages([...rows, ...nextRows]).map(message => message.id))
})

test('root display rejects unmarked, foreign, out-of-order and non-negotiated extra user rows', () => {
  const rows = rootRows(), valid = page([rows, nextRows])
  const altered = (row: EngineHistoryRow) => ({ ...valid, messages: valid.messages.map(item => item.id === supplement().id ? row : item) })
  expect(() => checkDisplayHistory({ ...valid, grouping: undefined })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, grouping: 'future' })).toThrow('格式')
  expect(() => checkDisplayHistory(altered({ ...supplement(), metadata: initial.metadata }))).toThrow('格式')
  expect(() => checkDisplayHistory(altered({ ...supplement(), metadata: { ...supplement().metadata, rootRunId: 'foreign' } }))).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, messages: [supplement(), initial, ...rows.slice(1).filter(row => row.role !== 'user'), ...nextRows] })).toThrow('格式')
  expect(() => checkDisplayHistory({ ...valid, messages: [...rows.filter(row => row.role !== 'user' || row.id === initial.id), ...nextRows, supplement()] })).toThrow('格式')
})

test('a compacted orphan supplement remains a visible standalone anchor', () => {
  const orphan = [supplement(), assistant(run.assistantMessageId, 'Continuation')]
  const cache = cacheDisplayHistory(run.sessionId, checkDisplayHistory(page([orphan])))
  expect([...cache.bodies.keys()]).toEqual([supplement().id])
  expect(mergeDisplayHistory(cache, [], new Set()).map(message => message.content)).toEqual(['Supplement 1', 'Continuation'])
})

test('root live merge cannot replace cursor-bound output with later disk supplements', () => {
  const cache = cacheDisplayHistory(run.sessionId, checkDisplayHistory(page([rootRows(3)])))
  const current = replayMessages(rootRows())
  current.at(-1)!.content = 'Live only'; current.at(-1)!.status = 'streaming'
  const before = JSON.stringify(current)
  const merged = mergeDisplayHistory(cache, current, new Set([run.userMessageId]), [run])
  expect(merged.map(message => message.content)).toEqual(['Original task', 'Step 0', 'Supplement 1', 'Live only'])
  expect(merged.at(-1)?.status).toBe('streaming')
  expect(JSON.stringify(current)).toBe(before)
  const missingAdmission = mergeDisplayHistory(cache, current.slice(2), new Set([run.userMessageId]), [run])
  expect(missingAdmission.map(message => message.content)).toEqual(['Original task', 'Supplement 1', 'Live only'])
})

test('old engines retain split parsing and their live supplement is protected by the root live ID', () => {
  const rows = rootRows(), legacy = checkDisplayHistory(page([rows.slice(0, 2), rows.slice(2)], null))
  expect(legacy.grouping).toBeUndefined()
  const cache = cacheDisplayHistory(run.sessionId, legacy), current = replayMessages(rows)
  current.at(-1)!.content = 'Live legacy tail'; current.at(-1)!.status = 'streaming'
  expect([...cache.bodies.keys()]).toEqual([run.userMessageId, supplement().id])
  expect(mergeDisplayHistory(cache, current, new Set([run.userMessageId]), [run]).at(-1)?.content).toBe('Live legacy tail')
})

test('negotiating root grouping invalidates old half-turn bodies even with the same mutation revision', () => {
  const rows = rootRows()
  const legacy = cacheDisplayHistory(run.sessionId, checkDisplayHistory(page([rows.slice(0, 2), rows.slice(2)], null)))
  const grouped = checkDisplayHistory(page([rows, nextRows], 'root', [nextRows]), 'next-user', 1)
  const cache = cacheDisplayHistory(run.sessionId, grouped, legacy)
  expect([...cache.bodies.keys()]).toEqual(['next-user'])
  expect(cache.invalidatedTurnIds.has(run.userMessageId)).toBe(true)
  expect(mergeDisplayHistory(cache, replayMessages(rows), new Set()).map(message => message.id)).toEqual(['next-user', 'next-answer'])
})

test('an indexed late supplement stays its own anchor even when the original admission is cached', () => {
  const original = [initial, assistant('before', 'Before the next turn')]
  const late = [supplement(), assistant('late-answer', 'Late continuation')]
  const rows = [...original, ...nextRows, ...late]
  const cache = cacheDisplayHistory(run.sessionId, checkDisplayHistory(page([original, nextRows, late]), undefined, 3))
  for (const current of [replayMessages(rows), replayMessages(late)]) {
    const merged = mergeDisplayHistory(cache, current, new Set([run.userMessageId, supplement().id!]))
    expect(merged.map(message => message.id)).toEqual(rows.map(row => row.id))
    expect(new Set(merged.map(message => message.id)).size).toBe(merged.length)
  }
})

test('unindexed late mail cannot move backwards across a newer ordinary admission', () => {
  const original = [initial, assistant('before', 'Before the next turn')]
  const late = [supplement(), assistant('late-answer', 'Late continuation')]
  const cache = cacheDisplayHistory(run.sessionId, checkDisplayHistory(page([original, nextRows])))
  const current = replayMessages([...original, ...nextRows, ...late])
  expect(mergeDisplayHistory(cache, current, new Set([run.userMessageId])).map(message => message.id))
    .toEqual(current.map(message => message.id))
})
