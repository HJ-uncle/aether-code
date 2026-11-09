/** Pure recovery regression: immutable published frames must not revive revoked assets. */
import { expect, test } from '@playwright/test'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { FinalResult } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import { cacheDisplayHistory, mergeDisplayHistory } from '../src/renderer/src/core/engine/display-history'
import { applyProjectedFinalResult } from '../src/renderer/src/core/engine/final-result'

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
