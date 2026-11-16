import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { RootRun } from '../src/shared/root-run'
import type { ControllerPending, ControllerSavedRecord } from '../src/renderer/src/core/engine/collaboration-contract'
import { projectRootFollowupDisplay } from '../src/renderer/src/core/engine/root-followup-display'

const run: RootRun = { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant',
  seq: 1, version: 1, status: 'running', modelId: 'model', workspacePaths: [], createdAt: 1, updatedAt: 1, pending: [] }
const assistant: ChatMessage = { id: 'assistant', role: 'assistant', content: 'Still generating', thinking: '', tools: [], items: [],
  status: 'streaming', createdAt: 1, runId: run.runId, conversationId: run.turnId, run }
const pending: ControllerPending = { version: 1, expectedEngine: { mode: 'embedded', baseUrl: '', instanceId: 'instance' }, storageIdentity: 'account',
  rootRunId: run.runId, rootAttemptId: 'attempt', rootSessionId: run.sessionId, targetKind: 'root', recipientParticipantId: 'root:root', recipientInvocationRunId: 'root',
  requestKey: 'request', message: 'Please adjust the current work', payloadBytes: 30, createdAt: 10 }
const accepted: ControllerSavedRecord = { ...pending, kind: 'accepted', receipt: { messageId: 'mail', rootRunId: run.runId, rootAttemptId: 'attempt',
  senderParticipantId: 'user', senderInvocationRunId: run.runId, recipientParticipantId: pending.recipientParticipantId, requestKey: pending.requestKey,
  payloadHash: 'hash', payloadBytes: 30, acceptedSeq: 1, acceptedAt: 11, state: 'queued', delivery: { state: 'pending' } } }
const project = (history: ControllerSavedRecord[], messages: ChatMessage[] = [assistant], outbox: ControllerPending[] = []) =>
  projectRootFollowupDisplay({ storageIdentity: 'account', sessionId: run.sessionId, history, pending: outbox, messages })

test('accepted supplement appears immediately without changing assistant stream or model transcript', () => {
  const messages = [structuredClone(assistant)], original = structuredClone(messages)
  const displays = project([accepted], messages)
  expect(displays).toHaveLength(1)
  expect(displays[0]).toMatchObject({ rootRunId: run.runId, state: 'pending', label: '已送达，等待读取',
    message: { role: 'user', content: pending.message, runId: run.runId, conversationId: run.turnId } })
  expect(displays[0].message.rootFollowup).toBeUndefined()
  expect(messages).toEqual(original)
  expect(messages[0]).toBe(messages.at(-1))
})

test('receipt/SSE ordering never duplicates an integrated supplement and never matches body text', () => {
  const integrated: ControllerSavedRecord = { ...accepted, receipt: { ...accepted.receipt,
    delivery: { state: 'integrated', historyMessageId: 'controller:history', integratedAt: 20 } } }
  expect(project([integrated])[0]).toMatchObject({ state: 'integrated', label: '已加入上下文' })
  const delivered: ChatMessage = { ...assistant, role: 'user', id: 'controller:history', content: pending.message,
    rootFollowup: { messageId: 'mail', rootRunId: run.runId, turnId: run.turnId } }
  expect(project([accepted], [assistant, delivered])).toEqual([])
  expect(project([integrated], [assistant, delivered])).toEqual([])
  expect(project([integrated], [assistant, { ...delivered, id: 'another', rootFollowup: undefined }])).toHaveLength(1)
  expect(project([accepted], [assistant, { ...delivered, rootFollowup: { ...delivered.rootFollowup!, turnId: 'other-turn' } }])).toHaveLength(1)
  const repeated: ControllerSavedRecord = { ...accepted, requestKey: 'request-2', receipt: { ...accepted.receipt, requestKey: 'request-2', messageId: 'mail-2' } }
  expect(project([accepted, repeated])).toHaveLength(2)
  expect(project([accepted, repeated], [assistant, delivered]).map(item => item.requestKey)).toEqual(['request-2'])
})

test('unknown, rejected and stopped states preserve the text without claiming that AI read it', () => {
  expect(project([], [assistant], [pending])[0]).toMatchObject({ state: 'unknown', label: '发送状态待确认，原文已保留' })
  expect(project([accepted], [assistant], [pending])).toHaveLength(1)
  expect(project([{ ...pending, kind: 'refused', rejection: { code: 409, message: 'closed', recordedAt: 20 } }])[0].state).toBe('refused')
  expect(project([{ ...accepted, receipt: { ...accepted.receipt, state: 'interrupted' } }])[0]).toMatchObject({ state: 'unread' })
  expect(project([accepted], [{ ...assistant, run: { ...run, status: 'cancelled', version: 2 } }])[0])
    .toMatchObject({ state: 'unknown', label: '运行已结束，投递状态待核对' })
})

test('other accounts, sessions, roots and child messages cannot enter this conversation', () => {
  for (const wrong of [{ storageIdentity: 'other-account' }, { rootSessionId: 'other-session' }, { rootRunId: 'other-run' },
    { targetKind: 'child' as const, childSessionId: 'child' }]) {
    expect(project([{ ...accepted, ...wrong }])).toEqual([])
  }
  expect(project([accepted], [])).toEqual([])
})

test('suppressed or compacted authoritative history never reappears through local receipts', () => {
  expect(project([{ ...accepted, receipt: { ...accepted.receipt,
    delivery: { state: 'suppressed', historyMessageId: 'removed', integratedAt: 20, reason: 'history_compacted' } } }])).toEqual([])
  expect(project([{ ...accepted, receipt: { ...accepted.receipt,
    delivery: { state: 'suppressed', historyMessageId: 'unread' } } }])[0].state).toBe('unread')
})
