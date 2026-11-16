/** Exact continuation admission and UI ownership, using isolated local journals only. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { canonicalAdmissionJson, freezeQueueRequest, assertFrozenQueueRequest, parseExactContinuation, type AdmissionContext, type ExactAdmission } from '../src/main/next-turn-admission-protocol'
import { NextTurnDispatcher, type QueueDispatchGateway } from '../src/main/next-turn-dispatcher'
import { NextTurnQueueStore } from '../src/main/next-turn-queue-store'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import type { NextTurnQueueEnvelope, NextTurnQueueScope, QueueContinuationTarget } from '../src/shared/next-turn-queue'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { applyRootRun, mergeRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { sessionConversationGroups, sessionConversationEntries } from '../src/renderer/src/features/conversation/conversation-turns'
import { continuationObserved, continuationTarget, sessionTaskRestart } from '../src/renderer/src/features/sessions/task-restart'

const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'tenant', namespace: { id: 'db', generation: 'one' }, owner: 'work', taskId: 'task' }
const target: QueueContinuationTarget = { runId: 'root', attemptId: 'attempt-1', version: 3, turnId: 'turn' }
const anchor = (source = target) => ({ runId: source.runId, attemptId: source.attemptId, version: source.version })
const body = (source = target) => ({ sessionId: scope.taskId, continuation: { protocolVersion: 1, namespace: scope.namespace, owner: 'work', predecessor: anchor(source), turnId: source.turnId, ...(source.childRunId ? { childRunId: source.childRunId } : {}) } })
const envelope = (source = target): NextTurnQueueEnvelope => ({ recovery: source, draft: { text: '', revision: 1, mentions: [] }, model: { kind: 'engine-default' }, workspace: { kind: 'local-workspace', identity: 'D:/isolated' }, agent: { primaryAgentId: null, collaborators: [] }, resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } }, thinking: { kind: 'inherit' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] })
const initial = (): RootRun => ({ schemaVersion: 1, runId: 'root', attemptId: 'attempt-1', sessionId: 'task', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'old-assistant', status: 'cancelled', seq: 1, version: 3, createdAt: 1, updatedAt: 3, finishedAt: 3, workspacePaths: ['D:/isolated'], pending: [] })
function resumed(): RootRun {
  const old = initial()
  return { ...old, attemptId: 'attempt-2', assistantMessageId: 'new-assistant', status: 'running', version: 4, updatedAt: 4, startedAt: 4, finishedAt: undefined,
    continuationReceipt: { protocolVersion: 1, rootRunId: old.runId, sessionId: old.sessionId, turnId: old.turnId, requestKey: 'continue-key', attemptId: 'attempt-2', previousAttemptId: old.attemptId!, rootVersion: 4, rootSequence: 1, acceptedAt: 4, assistantIdentityKind: 'continuation-segment', assistantAnchorId: old.assistantMessageId, assistantMessageId: 'new-assistant', userMessageId: old.userMessageId } }
}
function exactWire(frozen: ReturnType<typeof freezeQueueRequest>, run = resumed()) {
  const request = JSON.parse(frozen.wireBody!).continuation
  return { protocolVersion: 1, status: 'accepted', receipt: { ...request, ...run.continuationReceipt, requestKey: request.requestKey, bodyDigest: request.bodyDigest }, run }
}

test('continuation freezes only source authority, hashes child selection and rejects user replay or altered identities', () => {
  const frozen = freezeQueueRequest(scope, body(), 1, anchor())
  const wire = JSON.parse(assertFrozenQueueRequest(scope, frozen))
  expect(Object.keys(wire).sort()).toEqual(['continuation', 'sessionId'])
  expect(wire.message).toBeUndefined()
  expect(wire.admission).toBeUndefined()
  const selector = body().continuation
  expect(frozen.bodyDigest).toBe(createHash('sha256').update(canonicalAdmissionJson({ selector, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, body: { sessionId: 'task' } })).digest('hex'))
  expect(() => freezeQueueRequest(scope, { ...body(), message: 'continue' }, 1, anchor())).toThrow()
  expect(() => assertFrozenQueueRequest(scope, { ...frozen, wireBody: frozen.wireBody!.replace('attempt-1', 'attacker') })).toThrow()
  const child = freezeQueueRequest(scope, body({ ...target, childRunId: 'child' }), 1, anchor())
  expect(child.bodyDigest).not.toBe(frozen.bodyDigest)
  expect(JSON.parse(child.wireBody!).continuation.childRunId).toBe('child')
})

test('exact receipt accepts a new attempt on the same run and rejects latest-attempt substitution', () => {
  const frozen = freezeQueueRequest(scope, body(), 1, anchor()), accepted = exactWire(frozen)
  expect(parseExactContinuation(accepted, scope, frozen)).toMatchObject({ status: 'accepted', receipt: { runId: 'root', attemptId: 'attempt-2', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'new-assistant' } })
  expect(() => parseExactContinuation({ ...accepted, run: { ...accepted.run, attemptId: 'attempt-3' } }, scope, frozen)).toThrow()
  expect(() => parseExactContinuation({ ...accepted, receipt: { ...accepted.receipt, childRunId: 'foreign-child' } }, scope, frozen)).toThrow()
})

test('new attempt preserves partial output and user anchor; stale done cannot close the continued reply', () => {
  const messages: ChatMessage[] = replayMessages([
    { id: 'user', role: 'user', content: '原始任务', conversationId: 'turn', metadata: { rootRunId: 'root' } },
    { id: 'old-assistant', role: 'assistant', content: '已经完成的部分', reasoningContent: '已有思考', conversationId: 'turn', metadata: { rootRunId: 'root', attemptId: 'attempt-1' } }
  ])
  const stopped = applyRootRun(messages, initial()), continued = applyRootRun(stopped, resumed())
  expect(continued.filter(message => message.role === 'user').map(message => message.content)).toEqual(['原始任务'])
  expect(continued.map(message => message.id)).toEqual(['user', 'new-assistant'])
  expect(continued[1].content).toBe('已经完成的部分')
  expect(continued[1].thinking).toBe('已有思考')
  expect(continued[1].attemptId).toBe('attempt-2')
  expect(continued[1].status).toBe('streaming')
  expect(applyRootRun(continued, initial())).toBe(continued)
  expect(mergeRootRun(resumed(), initial()).attemptId).toBe('attempt-2')
  expect(applyRootRun(continued, resumed())).toHaveLength(2)
  expect(sessionConversationGroups(continued)).toHaveLength(1)
  expect(sessionConversationEntries(sessionConversationGroups(continued)[0])).toHaveLength(2)
  expect(continuationTarget(initial())).toEqual(target)
})

test('cold history keeps attempt segments and sums neither duplicate text nor usage', () => {
  const rows = [{ id: 'user', role: 'user', content: '原始任务', conversationId: 'turn', metadata: { rootRunId: 'root' } },
    { id: 'old-assistant', role: 'assistant', content: '同样正文', usage: { promptTokens: 10 }, conversationId: 'turn', metadata: { rootRunId: 'root', attemptId: 'attempt-1' } },
    { id: 'new-assistant', role: 'assistant', content: '同样正文', usage: { promptTokens: 20 }, conversationId: 'turn', metadata: { rootRunId: 'root', attemptId: 'attempt-2' } }]
  const messages = applyRootRun(replayMessages(rows), resumed())
  expect(messages).toHaveLength(2)
  expect(messages[1].content).toBe('同样正文同样正文')
  expect(messages[1].attemptId).toBe('attempt-2')
  expect(messages[1].usage).toMatchObject({ promptTokens: 30 })
})

test('snapshot segment boundaries win over the latest run frame stored before earlier prose', () => {
  const run = resumed()
  const snapshot: ChatRecoverySnapshot = { schemaVersion: 1, source: 'live', sessionId: 'task', eventId: 'stream:8', finished: false,
    run, runs: [run], todos: [], changes: [], history: [
      { id: 'user', role: 'user', content: '原始任务', conversationId: 'turn', metadata: { rootRunId: 'root' } },
      { id: 'old-assistant', role: 'assistant', content: '同样正文', usage: { promptTokens: 10 }, conversationId: 'turn', metadata: { rootRunId: 'root', attemptId: 'attempt-1' } },
      { id: 'new-assistant', role: 'assistant', content: '同样正文', usage: { promptTokens: 20 }, conversationId: 'turn', metadata: { rootRunId: 'root', attemptId: 'attempt-2' } }
    ], projection: [
      { run }, { assistantSegment: { runId: 'root', turnId: 'turn', attemptId: 'attempt-1', messageId: 'old-assistant', createdAt: 1 } },
      { thinking: '旧思考' }, { content: '同样正文' },
      { assistantSegment: { runId: 'root', turnId: 'turn', attemptId: 'attempt-2', messageId: 'new-assistant', createdAt: 4 } },
      { thinking: '新思考' }, { content: '同样正文' }, { usage: { promptTokens: 30 } }
    ] }
  const messages = restoreChatSnapshot(snapshot).messages
  expect(messages.map(message => message.id)).toEqual(['user', 'new-assistant'])
  expect(messages.slice(1).map(message => [message.content, message.thinking, message.attemptId])).toEqual([
    ['同样正文同样正文', '旧思考新思考', 'attempt-2']])
  expect(messages.slice(1).map(message => message.usage)).toMatchObject([{ promptTokens: 30 }])
  expect(sessionConversationGroups(messages)).toHaveLength(1)
})

test('cancelled pending still requires its real decision and cannot use ordinary continue', () => {
  const run = { ...initial(), pending: [{ requestId: 'permission', kind: 'permission' as const, toolCallId: 'write', toolName: 'write_file', args: {}, status: 'pending' as const }] }
  expect(continuationTarget(run)).toBeNull()
  expect(continuationTarget(run, 'child')).toBeNull()
  const messages = applyRootRun(replayMessages([{ id: 'user', role: 'user', content: '任务', conversationId: 'turn', metadata: { rootRunId: 'root' } }]), run)
  expect(messages.at(-1)?.pending).toMatchObject({ requestId: 'permission', status: 'pending' })
})

test('durable continue survives unknown ACK and restart; repeating source is observation, later source can continue again', async () => {
  const parent = resolve(__dirname, '../.e2e-tmp/continuation-journal')
  await mkdir(parent, { recursive: true }); const directory = await mkdtemp(join(parent, 'case-'))
  let current = initial(), posts = 0, loseAck = true
  const accepted = new Map<string, ExactAdmission>()
  const gateway: QueueDispatchGateway = {
    capture: async () => ({ scope, generation: 'one' }), assertCurrent: () => {},
    context: async (): Promise<AdmissionContext> => ({ protocolVersion: 1, tenantId: scope.tenantId, sessionId: scope.taskId, namespace: scope.namespace,
      predecessor: { runId: current.runId, attemptId: current.attemptId!, version: current.version }, root: { ...current, attemptId: current.attemptId!, workspacePaths: ['D:/isolated'] }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 } }),
    envelope: async () => { const normal = envelope(); delete normal.recovery; normal.draft.text = 'Later user task'; return normal }, editDraft: original => original,
    recoveryEnvelope: async (_scope, source) => envelope(source), prepare: async (_scope, source) => body(source.recovery as QueueContinuationTarget),
    submit: async (_scope, wire) => {
      const request = JSON.parse(wire).continuation; posts++
      current = { ...resumed(), attemptId: `attempt-${posts + 1}`, version: current.version + 1 }
      accepted.set(request.requestKey, { status: 'accepted', root: { ...current, workspacePaths: ['D:/isolated'] },
        receipt: { runId: current.runId, attemptId: current.attemptId, turnId: current.turnId, userMessageId: current.userMessageId, assistantMessageId: current.assistantMessageId } })
      if (loseAck) { loseAck = false; throw new Error('Lost response after durable acceptance') }
    }, receipt: async (_scope, entry) => accepted.get(entry.frozen.requestKey) ?? { status: 'absent' }
  }
  const create = () => new NextTurnDispatcher(new NextTurnQueueMutationService(new NextTurnQueueStore(directory), gateway), gateway)
  let dispatcher = create()
  try {
    const lost = await dispatcher.restart('task', target)
    expect(lost.state.entries[0].phase).toBe('admission-unknown'); expect(posts).toBe(1)
    await dispatcher.close(); dispatcher = create()
    const observed = await dispatcher.restart('task', target)
    expect(posts).toBe(1); expect(observed.state.entries[0].phase).toBe('accepted')
    expect(continuationObserved(observed.state.entries[0], [{ ...replayMessages([{ id: 'user', role: 'user', content: 'x' }])[0], run: initial() }])).toBe(false)
    const receipt = accepted.values().next().value!
    if (receipt.status !== 'accepted') throw new Error('Expected accepted fixture')
    const draft = { draft: { text: 'Later user task', revision: 1, mentions: [] }, model: { kind: 'engine-default' as const }, resources: envelope().resources, thinking: { kind: 'inherit' as const }, attachments: [] }
    await dispatcher.enqueue('task', observed.state.revision, 'queued-operation', 'queued-next', draft)
    current = { ...current, status: 'cancelled', version: current.version + 1 }
    receipt.root = { ...current, workspacePaths: ['D:/isolated'] }
    await dispatcher.reconcile('task')
    await dispatcher.restart('task', target); expect(posts).toBe(1)
    const nextTarget = continuationTarget(current)!
    const next = await dispatcher.restart('task', nextTarget)
    expect(posts).toBe(2); expect(next.state.entries).toHaveLength(3)
    expect(next.state.recoveryBarrier).toBeDefined()
    expect(next.state.entries.find(entry => entry.id === 'queued-next')?.phase).toBe('pending')
    expect(sessionTaskRestart('task', current, next, []).status).toBe('unavailable')
  } finally {
    await dispatcher.close()
    if (dirname(resolve(directory)) !== parent) throw new Error('Unsafe test cleanup')
    await rm(directory, { recursive: true, force: true })
  }
})

