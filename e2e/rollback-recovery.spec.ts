/** Pure recovery regression: immutable published frames must not revive revoked assets. */
import { expect, test } from '@playwright/test'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { FinalResult } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import { cacheDisplayHistory, mergeDisplayHistory } from '../src/renderer/src/core/engine/display-history'
import { applyProjectedFinalResult } from '../src/renderer/src/core/engine/final-result'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'

const run: RootRun = { schemaVersion: 1, runId: 'run', sessionId: 'work-revert', turnId: 'turn',
  userMessageId: 'user', assistantMessageId: 'answer', version: 2, seq: 1, status: 'succeeded',
  createdAt: 1, updatedAt: 3, pending: [] }
const published: FinalResult = { schemaVersion: 1, runId: run.runId, sessionId: run.sessionId,
  turnId: run.turnId, assistantMessageId: run.assistantMessageId, text: 'Delivered', publishedAt: 2,
  items: ['removed', 'remaining'].map(name => ({ id: name, assetId: name, name, path: `C:/project/${name}.xlsx`,
    mimeType: 'application/octet-stream', size: 10, kind: 'file', sha256: 'a'.repeat(64) })) }
function snapshot(items: FinalResult['items']): ChatRecoverySnapshot {
  return { schemaVersion: 1, source: 'persisted-published', sessionId: run.sessionId, eventId: null, finished: true,
    run, runs: [run], todos: [], changes: [],
    history: [{ id: 'user', role: 'user', content: 'Create documents', conversationId: run.turnId },
      { id: 'answer', role: 'assistant', content: 'Delivered', conversationId: run.turnId,
        metadata: { rootRunId: run.runId, finalResult: { ...published, items } } }],
    projection: [{ content: 'Delivered' }, { finalResult: published }] }
}

test('cold recovery retains only current non-reverted result cards without rewriting the checkpoint', () => {
  const input = snapshot([published.items[1]])
  const before = structuredClone(input.projection)
  const output = restoreChatSnapshot(input)
  expect(output.messages.find(message => message.id === 'answer')?.finalResult?.items.map(item => item.id)).toEqual(['remaining'])
  expect(input.projection).toEqual(before)
})

test('all withdrawn result cards stay absent on repeated restore, while retained transcript stays visible', () => {
  const input = snapshot([])
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = restoreChatSnapshot(input).messages.find(message => message.id === 'answer')
    expect(answer?.finalResult?.items).toEqual([])
    expect(answer?.content).toBe('Delivered')
  }
})

test('another session cannot replace the restored result manifest', () => {
  const input = snapshot([])
  input.history[1].metadata!.finalResult = { ...published, sessionId: 'foreign', items: [] }
  expect(restoreChatSnapshot(input).messages.find(message => message.id === 'answer')?.finalResult?.items).toHaveLength(2)
})

test('current display history withdraws equal-publication assets from a resident live projection', () => {
  const current = restoreChatSnapshot(snapshot(published.items)).messages
  const cache = cacheDisplayHistory(run.sessionId, { schemaVersion: 1, grouping: 'root',
    turns: [{ userMessageId: 'user', conversationId: 'turn', preview: 'Create documents' }],
    messages: snapshot([]).history, loadedTurnIds: ['user'], revision: 'same-history', mutationRevision: 'same-mutation',
    backend: 'jsonl', completeness: 'complete' })
  const merged = mergeDisplayHistory(cache, current, new Set(['user']), [run])
  expect(merged.find(message => message.id === 'answer')?.finalResult?.items).toEqual([])
  // Delayed replay of the old SSE publication remains a duplicate, not an undo of withdrawal.
  expect(applyProjectedFinalResult(merged, published).find(message => message.id === 'answer')?.finalResult?.items).toEqual([])
})

test('display response cannot downgrade a newer publication from the same run', () => {
  const current = restoreChatSnapshot(snapshot(published.items)).messages.map(message => message.finalResult
    ? { ...message, finalResult: { ...message.finalResult, publishedAt: 4 } } : message)
  const cache = cacheDisplayHistory(run.sessionId, { schemaVersion: 1, grouping: 'root',
    turns: [{ userMessageId: 'user', conversationId: 'turn', preview: 'Create documents' }],
    messages: snapshot([]).history, loadedTurnIds: ['user'], revision: 'same-history', mutationRevision: 'same-mutation',
    backend: 'jsonl', completeness: 'complete' })
  expect(mergeDisplayHistory(cache, current, new Set(['user']), [run])
    .find(message => message.id === 'answer')?.finalResult?.items).toHaveLength(2)
})

test('full display history binds shuffled run ledgers only to their own turns and keeps the newest version', () => {
  const ownRuns: RootRun[] = ['a', 'b', 'c'].map((id, index) => ({ ...run, runId: `run-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `answer-${id}`, turnId: `turn-${id}`,
    seq: index + 1, version: 3, status: id === 'b' ? 'failed' : id === 'c' ? 'interrupted' : 'succeeded',
    ...(id === 'b' ? { error: 'failure B' } : {}) }))
  const shuffled = [ownRuns[2], ownRuns[1], ownRuns[0], { ...ownRuns[1], version: 1, status: 'running' as const }]
  const cache = cacheDisplayHistory(run.sessionId, { schemaVersion: 1, grouping: 'root',
    turns: ownRuns.map(root => ({ userMessageId: root.userMessageId, conversationId: root.turnId, preview: root.turnId })),
    messages: ownRuns.flatMap(root => [{ id: root.userMessageId, role: 'user', content: root.turnId, conversationId: root.turnId },
      ...(root.runId === 'run-b' ? [] : [{ id: root.assistantMessageId, role: 'assistant', content: root.turnId, conversationId: root.turnId }])]),
    loadedTurnIds: ownRuns.map(root => root.userMessageId), revision: 'display-runs', mutationRevision: 'same',
    backend: 'jsonl', completeness: 'complete' })
  const merged = mergeDisplayHistory(cache, [], new Set(), shuffled)
  expect(merged.map(message => message.id)).toEqual(['user-a', 'answer-a', 'user-b', 'answer-b', 'user-c', 'answer-c'])
  expect(merged.filter(message => message.role === 'assistant').map(message => ({
    id: message.id, run: message.runId, status: message.status, version: message.run?.version
  }))).toEqual([
    { id: 'answer-a', run: 'run-a', status: 'done', version: 3 },
    { id: 'answer-b', run: 'run-b', status: 'error', version: 3 },
    { id: 'answer-c', run: 'run-c', status: 'interrupted', version: 3 }
  ])
  expect(merged.find(message => message.id === 'answer-b')?.error).toBe('failure B')
  expect(shuffled.map(root => `${root.runId}:${root.version}`)).toEqual(['run-c:3', 'run-b:3', 'run-a:3', 'run-b:1'])
})

test('legacy separately indexed supplements keep their live body only for the exact owning root', () => {
  const rows = [
    { id: 'user', role: 'user', content: 'root', conversationId: 'turn' },
    { id: 'answer', role: 'assistant', content: 'root reply', conversationId: 'turn' },
    { id: 'supplement', role: 'user', content: 'follow up', conversationId: 'turn' },
    { id: 'supplement-answer', role: 'assistant', content: 'cached supplement reply', conversationId: 'turn' }
  ]
  const cache = cacheDisplayHistory(run.sessionId, { schemaVersion: 1,
    turns: ['user', 'supplement'].map(userMessageId => ({ userMessageId, conversationId: 'turn', preview: userMessageId })),
    messages: rows, loadedTurnIds: ['user', 'supplement'], revision: 'legacy', mutationRevision: 'same',
    backend: 'jsonl', completeness: 'complete' })
  const current = replayMessages(rows).map(message => message.id === 'supplement'
    ? { ...message, runId: run.runId, rootFollowup: { messageId: 'delivery', rootRunId: run.runId, turnId: run.turnId } }
    : message.id === 'supplement-answer' ? { ...message, content: 'live supplement reply' } : message)
  const live = new Set(['user'])
  expect(mergeDisplayHistory(cache, current, live, [run]).find(message => message.id === 'supplement-answer')?.content)
    .toBe('live supplement reply')
  expect(mergeDisplayHistory(cache, current, live, [{ ...run, turnId: 'unrelated-turn' }])
    .find(message => message.id === 'supplement-answer')?.content).toBe('cached supplement reply')
})
