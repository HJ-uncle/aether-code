/** Per-turn file ownership and immutable before/after versions across later edits. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { sessionConversationGroups } from '../src/renderer/src/features/conversation/conversation-turns'
import { sessionProgressChanges, type SessionProgressChange } from '../src/renderer/src/features/conversation/progress-state'
import { sessionTurnProgressChanges } from '../src/renderer/src/features/conversation/turn-progress'
import { sessionFileChangeStats } from '../src/renderer/src/features/artifacts/file-change-presentation'
import { buildSessionArtifactFiles, scopeArtifactChanges, resolveArtifactChoice, filterSessionArtifactFiles } from '../src/renderer/src/features/artifacts/session-artifacts'
import { turnFileChangeSummaries } from '../src/renderer/src/features/artifacts/turn-file-changes'

const row = (id: string, turnId: string, before: string | null, after: string | null, seq: number): EngineFileChange => ({
  id, sessionId: 'session', turnId, runId: `run-${turnId}`, path: 'D:/project/game.html', kind: after === null ? 'delete' : 'write',
  oldContent: before, newContent: after, oldHash: before === null ? 'missing' : `hash:${before}`,
  newHash: after === null ? 'missing' : `hash:${after}`, isNew: before === null && after !== null,
  seq, createdAt: seq, status: 'pending', truncated: false
})
const message = (id: string, role: ChatMessage['role'], turnId: string): ChatMessage => ({
  id, role, content: id, thinking: '', tools: [], createdAt: 1, status: 'done', conversationId: turnId, runId: `run-${turnId}`
})
const first = [row('create', 'one', null, 'line1\nline2\nline3', 1), row('fix', 'one', 'line1\nline2\nline3', 'line1\nfixed\nline3', 2)]
const later = row('later', 'two', first[1].newContent, 'SECOND TURN', 3)
const messages = [message('user-one', 'user', 'one'), message('answer-one', 'assistant', 'one'), message('user-two', 'user', 'two'), message('answer-two', 'assistant', 'two')]
function grouped(rows: EngineFileChange[], transcript = messages) {
  return sessionTurnProgressChanges('session', sessionConversationGroups(transcript), sessionProgressChanges('session', [], rows))
}
const summary = (file: SessionProgressChange): EngineFileChange =>
  file.summaries?.[0] ?? file.latest

test('first-turn summary includes creation and its fixes instead of only the final micro-edit', () => {
  const file = grouped([...first, later]).get('message:user-one')![0]
  expect(file.records.map(change => change.id)).toEqual(['create', 'fix'])
  expect(summary(file)).toMatchObject({ oldContent: null, newContent: 'line1\nfixed\nline3', isNew: true })
  expect(sessionFileChangeStats(summary(file))).toMatchObject({ added: 3, removed: 0 })
})

test('turn inspector defaults to immutable endpoints while exact operation clicks keep their snapshot', () => {
  const scoped = scopeArtifactChanges('session', [...first, later], [{ ...later, changeIds: ['create', 'fix', 'later'] }], { kind: 'turn', turnId: 'one' })
  expect(scoped.net).toEqual([])
  const files = buildSessionArtifactFiles('session', scoped.records, scoped.net, 'D:/project', 'one')
  const current = resolveArtifactChoice(files, 'session', { kind: 'request', request: {
    sessionId: 'session', path: first[0].path, view: 'turn', turnScope: { kind: 'turn', turnId: 'one' }, revision: 1
  } })
  expect(current?.view).toMatchObject({ scope: 'turn', change: { oldContent: null, newContent: first[1].newContent, changeIds: ['create', 'fix'] } })
  const exact = resolveArtifactChoice(files, 'session', { kind: 'request', request: {
    sessionId: 'session', path: first[0].path, changeId: 'create', revision: 2
  } })
  expect(exact?.view).toMatchObject({ scope: 'operation', change: { id: 'create', newContent: first[0].newContent } })
})

test('reverted changes disappear from the turn outcome but retained operation snapshots never change', () => {
  const source = JSON.stringify(first)
  const reverted = { ...first[1], status: 'reverted' as const }
  const files = buildSessionArtifactFiles('session', [first[0], reverted], [], undefined, 'one')
  expect(files[0].turn?.[0]).toMatchObject({ oldContent: null, newContent: first[0].newContent, changeIds: ['create'] })
  expect(files[0].operations.find(change => change.id === 'fix')).toMatchObject({ oldContent: first[0].newContent, newContent: first[1].newContent, status: 'reverted' })
  expect(JSON.stringify(first)).toBe(source)
  expect(turnFileChangeSummaries('session', 'one', first.map(change => ({ ...change, status: 'reverted' })))).toEqual([])
})

test('non-contiguous edits stay separate and kept edits still belong to their turn summary', () => {
  const external = row('after-external-edit', 'one', 'EXTERNAL', 'FINAL', 3)
  const split = turnFileChangeSummaries('session', 'one', [...first, external])
  expect(split.map(change => change.changeIds)).toEqual([['after-external-edit'], ['create', 'fix']])
  expect(split.every(change => change.projectionIssue === 'discontinuous-history')).toBe(true)
  const kept = turnFileChangeSummaries('session', 'one', [{ ...first[0], status: 'kept' }, first[1]])
  expect(kept[0]).toMatchObject({ oldContent: null, newContent: first[1].newContent, status: 'pending' })
  expect(turnFileChangeSummaries('session', 'one', [...first, later])).toEqual([])
})

test('a fully reverted edit of an existing file is not an outcome but exact historical inspection remains available', () => {
  const reverted = { ...row('existing-edit', 'one', 'BASELINE', 'EDITED', 1), status: 'reverted' as const }
  expect(grouped([reverted]).get('message:user-one')).toEqual([])
  const files = buildSessionArtifactFiles('session', [reverted], [], undefined, 'one')
  expect(filterSessionArtifactFiles(files)).toEqual([])
  const preserved = filterSessionArtifactFiles(files, files[0].key)
  const selected = resolveArtifactChoice(preserved, 'session', { kind: 'request', request: {
    sessionId: 'session', path: reverted.path, changeId: reverted.id, revision: 1
  } })
  expect(selected?.view).toMatchObject({ scope: 'operation', change: { status: 'reverted', oldContent: 'BASELINE', newContent: 'EDITED' } })
})

test('multiple child producers never make an aggregate belong only to the last child', () => {
  const changes = first.map((change, index) => ({ ...change, producerChildSessionId: `child-${index}`, producerRunId: `child-run-${index}` }))
  expect(turnFileChangeSummaries('session', 'one', changes)[0]).toMatchObject({ producerChildSessionId: undefined, producerRunId: undefined })
  const same = changes.map(change => ({ ...change, producerChildSessionId: 'child', producerRunId: 'child-run' }))
  expect(turnFileChangeSummaries('session', 'one', same)[0]).toMatchObject({ producerChildSessionId: 'child', producerRunId: 'child-run' })
})

test('a normal later root cannot alter the prior turn records or summary', () => {
  const before = grouped(first).get('message:user-one')![0]
  const after = grouped([...first, later]).get('message:user-one')![0]
  expect(after).toEqual(before)
  expect(grouped([...first, later]).get('message:user-two')![0].records.map(change => change.id)).toEqual(['later'])
})

test('same-root follow-up and continuation belong to one logical turn, never the next root', () => {
  const supplement = { ...message('supplement', 'user', 'one'), rootFollowup: { messageId: 'delivery', rootRunId: 'run-one', turnId: 'one' } }
  const continued = { ...message('continued-answer', 'assistant', 'one'), attemptId: 'attempt-2' }
  const transcript = [messages[0], messages[1], supplement, continued, messages[2], messages[3]]
  expect(sessionConversationGroups(transcript).map(group => group.id)).toEqual(['message:user-one', 'message:user-two'])
  const afterFollowup = row('followup', 'one', first[1].newContent, 'FOLLOW-UP OUTPUT', 3)
  expect(grouped([...first, afterFollowup, { ...later, seq: 4, createdAt: 4 }], transcript).get('message:user-one')![0].records.map(change => change.id))
    .toEqual(['create', 'fix', 'followup'])
})
