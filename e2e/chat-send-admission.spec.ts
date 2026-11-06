/** Production send + composer callbacks: admission unlocks editing while the stream remains owned. No Electron/provider. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ChatRequestRejectedError, dispatchChatRequest } from '../src/renderer/src/core/engine/chat-send-request'
import { normalizeRootRun, mergeRootRun, applyRootRun, finishTransport } from '../src/renderer/src/core/engine/root-run-state'
import { codeQueueSubmission } from '../src/renderer/src/core/engine/code-queue-entry'
import { sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { StreamEvent, StreamStartResult } from '../src/shared/stream-event'

function extract(path: string, name: string, kind: 'callback' | 'function'): string {
  const file = ts.createSourceFile(path, readFileSync(resolve(__dirname, path), 'utf8'), ts.ScriptTarget.Latest, true)
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if ((kind === 'callback' && ts.isVariableDeclaration(node) || kind === 'function' && ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!found) throw new Error('Missing production callback ' + name)
  if (ts.isVariableDeclaration(found) && found.initializer && ts.isCallExpression(found.initializer)) return `const ${name} = ${found.initializer.arguments[0].getText(file)};`
  return found.getText(file)
}
const chat = '../src/renderer/src/core/engine/useChat.ts', view = '../src/renderer/src/contrib/chat/ChatView.tsx'
const callbacks = ts.transpileModule([
  ...['rejectOutgoingSend', 'acknowledgeOutgoingSend', 'runStream', 'send', 'sendInternal'].map(name => extract(chat, name, 'callback')),
  ...['patchLastAssistant', 'isApprovalConflict', 'applyEvent'].map(name => extract(chat, name, 'function')),
  extract(view, 'submit', 'callback'),
  'sendInternalRef.current = sendInternal; globalThis.submit = submit; globalThis.applyEvent = applyEvent; globalThis.sendExecution = send;'
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const run = (runId = 'new-run', sessionId = 'A'): RootRun => ({ schemaVersion: 1, runId, sessionId, turnId: 'turn-' + runId,
  userMessageId: 'user-' + runId, assistantMessageId: 'assistant-' + runId, version: 1, seq: 1, status: 'running', createdAt: 3, updatedAt: 3, pending: [] })
function harness() {
  const completion = deferred<StreamStartResult>(), queued = deferred<void>(), started = deferred<void>()
  let epoch = 0, ids = 0, source = 1, submitting = false, historyError: string | null = null
  let messages: ChatMessage[] = [], rejected: Record<string, unknown> = {}
  const calls: Array<{ streamId: string }> = [], recoveries: string[] = [], toasts: string[] = []
  const submittedFile = { path: 'old.txt', name: 'old.txt', type: 'text/plain', size: 1 }
  const refs = {
    sourceRef: { current: 1 }, activeStreamRef: { current: null as string | null }, consumedEventIdRef: { current: null },
    activeSessionRef: { current: 'A' as string | null }, viewSessionRef: { current: 'A' as string | null }, activeRunIdRef: { current: null as string | null },
    rootRunsRef: { current: new Map<string, RootRun>([['old-run', run('old-run')]]) }, optimisticIdsRef: { current: {} },
    outgoingSendRef: { current: null }, rejectedSendScopeRef: { current: null }, sendInternalRef: { current: null },
    recoverRef: { current: async (sessionId: string) => { recoveries.push(sessionId); return true } },
    submissionFlight: { current: null as object | null }, draftScopeRef: { current: { key: 'scope', root: '/workspace' } },
    displayedSessionRef: { current: 'scope' }, draftEditRevision: { current: 100 }, inputValueRef: { current: 'initial task' },
    mentionsRef: { current: [] }, draftTimerRef: { current: 0 }, pendingDraftSaveRef: { current: null },
    suppressResourceReconcileRef: { current: false }, resourceTextRef: { current: '' }, historyEditRef: { current: null }
  }
  const context = {
    ...refs, Error, Date, Set, ChatRequestRejectedError, dispatchChatRequest, normalizeRootRun, mergeRootRun, applyRootRun, finishTransport, codeQueueSubmission,
    renderSource: 1, commandOwner: 'code', queueSessionId: 'A', sourceEpoch: 1, sourceSessionKey: 'scope', sessionId: 'A', storageSource: 'local', draftRecoveryKey: 'draft',
    resourceQuery: null, mentionQuery: null, manualPalette: false, stopping: false, canExecute: true, immediateIntent: false, attachmentRoot: '/workspace',
    rootFollowup: { busy: false, pending: false }, input: 'initial task',
    attach: { attachments: [submittedFile], uploading: false, removeSubmitted: (files: unknown[]) => { context.attach.attachments = context.attach.attachments.filter(file => !files.includes(file)) } },
    inputRef: { current: { clear: () => { refs.inputValueRef.current = ''; refs.draftEditRevision.current++ } } },
    getEngineSource: () => source, assertEngineSource: (value: number) => { if (value !== source) throw new Error('source changed') }, isRemoteEngine: () => true,
    invalidateRecovery: () => { epoch++; refs.outgoingSendRef.current = null },
    recoveryScope: (sessionId: string): RecoveryScope => ({ source, sessionId, viewEpoch: epoch }),
    scopeIsCurrent: (scope: RecoveryScope) => sameRecoveryScope(scope, context.recoveryScope(refs.viewSessionRef.current ?? '')),
    newId: () => 'local-' + (++ids), selectView: () => {}, hasSessionWork: () => !!refs.activeStreamRef.current,
    setMessages: (update: (rows: ChatMessage[]) => ChatMessage[]) => { messages = update(messages) }, setStreaming: () => {}, setSessionModel: () => {},
    flushStreamPatches: () => {}, scheduleStreamPatch: () => {}, recoveryLoop: { retry: () => {}, cancel: () => {} },
    setHistoryError: (value: string) => { historyError = value },
    setSubmitting: (value: boolean) => { submitting = value }, setInput: (value: string) => { context.input = value },
    setRejectedDrafts: (update: (value: Record<string, unknown>) => Record<string, unknown>) => { rejected = update(rejected) }, setToast: (value: string) => toasts.push(value),
    queuedDraft: (text: string, mentions: unknown[], revision: number) => ({ text, mentions, revision }),
    saveChatDraftForSubmission: () => {}, saveChatDraft: () => ++refs.draftEditRevision.current,
    buildAgentMentionMessage: (message: string) => ({ message, collaborators: [] }), buildSendOptions: () => ({ sessionId: 'A' }),
    touchPendingSession: () => {}, resumeFollowBottom: () => {}, scrollToBottom: () => {}, window: { clearTimeout: () => {} },
    durableQueue: { refresh: async () => ({ state: { entries: [] } }), consumeConfirmedEnqueue: () => false, enqueue: () => queued.promise },
    engine: { getSubagentProtocol: async () => 2, startStream: async (input: { streamId: string }) => { calls.push(input); started.resolve(); return completion.promise } },
    submit: undefined as unknown as () => void, applyEvent: undefined as unknown as (event: StreamEvent) => void,
    sendExecution: undefined as unknown as (text: string, options: { sessionId: string }, onAdmitted?: () => void) => Promise<void>
  }
  runInNewContext(callbacks, context)
  return { ...refs, calls, completion, queued, started: started.promise, submittedFile,
    submit: () => context.submit(), event: (root: RootRun, streamId = calls[0].streamId) => context.applyEvent({ streamId, type: 'payload', payload: { run: root } }),
    execute: (onAdmitted: () => void) => context.sendExecution('initial task', { sessionId: 'A' }, onAdmitted),
    progress: () => context.applyEvent({ streamId: calls[0].streamId, type: 'payload', payload: { content: 'progress is not admission' } }),
    edit: (text: string) => { context.input = text; refs.inputValueRef.current = text; refs.draftEditRevision.current++ },
    changeSource: () => { source++ }, setScope: () => { refs.draftScopeRef.current = { key: 'new-visit', root: '/workspace' } },
    addFile: () => { context.attach.attachments = [...context.attach.attachments, { path: 'new.txt', name: 'new.txt', type: 'text/plain', size: 1 }] },
    text: () => context.input, files: () => context.attach.attachments, submitting: () => submitting, rejected: () => rejected, historyError: () => historyError, toasts, recoveries }
}

test('admission notification leaves the returned send promise pending until the owned stream ends', async () => {
  const state = harness(); let accepted = 0, finished = false
  const running = state.execute(() => { accepted++ }).then(() => { finished = true })
  await state.started; state.event(run()); await Promise.resolve()
  expect(accepted).toBe(1); expect(finished).toBe(false)
  state.completion.resolve({ ok: true }); await running; expect(finished).toBe(true)
})

test('first direct root admission clears composer and permits followups before the stream completes', async () => {
  const state = harness(); state.submit(); await state.started
  expect(state.text()).toBe('initial task'); expect(state.submitting()).toBe(true)
  state.event(run()); expect(state.text()).toBe(''); expect(state.submitting()).toBe(false); expect(state.files()).toEqual([])
  state.edit('next draft'); state.event({ ...run(), version: 2 })
  expect(state.text()).toBe('next draft')
  state.completion.resolve({ ok: true }); await expect.poll(() => state.submissionFlight.current).toBeNull()
})

test('known root, another session/stream, and progress cannot acknowledge a new submission', async () => {
  const state = harness(); state.submit(); await state.started
  state.progress(); state.event(run('old-run')); state.event(run('foreign', 'B')); state.event(run('unrelated'), 'another-stream')
  expect(state.text()).toBe('initial task'); expect(state.submitting()).toBe(true)
  state.completion.resolve({ ok: true })
  await expect.poll(state.submitting).toBe(false); expect(state.text()).toBe('initial task'); expect(state.toasts).toHaveLength(1)
})

for (const change of ['edit', 'retype', 'scope', 'source'] as const) test(`admission preserves later ${change} and never clears an unrelated authored draft`, async () => {
  const state = harness(); state.submit(); await state.started
  if (change === 'edit') state.edit('newly authored')
  if (change === 'retype') state.edit('initial task')
  if (change === 'scope') state.setScope()
  if (change === 'source') state.changeSource()
  state.event(run()); state.completion.resolve({ ok: true })
  await expect.poll(state.submitting).toBe(false)
  expect(state.text()).toBe(change === 'edit' ? 'newly authored' : 'initial task'); expect(state.files()).toEqual([state.submittedFile])
})

test('admission removes only submitted attachment objects and keeps later additions', async () => {
  const state = harness(); state.submit(); await state.started; state.addFile(); state.event(run())
  expect(state.text()).toBe(''); expect(state.files().map(file => file.path)).toEqual(['new.txt'])
  state.completion.resolve({ ok: true })
})

for (const failure of ['refused', 'unknown'] as const) test(`pre-admission ${failure} keeps the original composer and attachments`, async () => {
  const state = harness(); state.submit(); await state.started
  if (failure === 'refused') state.completion.resolve({ ok: false, rejection: { message: 'request refused' } })
  else state.completion.reject(new Error('connection lost'))
  await expect.poll(state.submitting).toBe(false)
  expect(state.text()).toBe('initial task'); expect(state.files()).toEqual([state.submittedFile]); expect(state.toasts).toHaveLength(1)
})

test('late stream failure remains in recovery without restoring accepted text or unlocking a newer queued submission', async () => {
  const state = harness(); state.submit(); await state.started; state.event(run())
  state.edit('second queued task'); state.submit()
  const second = state.submissionFlight.current; expect(second).not.toBeNull()
  state.completion.reject(new Error('late stream disconnect'))
  await expect.poll(state.historyError).toBe('late stream disconnect')
  expect(state.recoveries).toEqual(['A']); expect(state.rejected()).toEqual({}); expect(state.toasts).toEqual([])
  expect(state.submissionFlight.current).toBe(second); expect(state.submitting()).toBe(true); expect(state.text()).toBe('second queued task')
  state.queued.resolve(); await expect.poll(state.submitting).toBe(false); expect(state.text()).toBe('')
})
