/** Production host/useChat callbacks: explicit non-admission is recoverable, unknown outcomes are never replayed. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ChatRequestRejectedError } from '../src/renderer/src/core/engine/chat-send-request'
import { finishTransport } from '../src/renderer/src/core/engine/root-run-state'
import { sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { isExplicitRequestRejection, type StreamEvent, type StreamStartResult } from '../src/shared/stream-event'
import { parseSseBlock } from '../src/main/engine/sse'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { takeSessionQueue, restoreSessionQueue } from '../src/renderer/src/core/engine/chat-session-queue'

function sourceFile(path: string) {
  const filename = resolve(__dirname, path)
  return ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
}
function extract(source: ts.SourceFile, name: string, kind: 'variable' | 'function' | 'method'): string {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if ((kind === 'variable' && ts.isVariableDeclaration(node) || kind === 'function' && ts.isFunctionDeclaration(node) ||
      kind === 'method' && ts.isMethodDeclaration(node)) && node.name?.getText(source) === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`Missing production ${name}`)
  return kind === 'variable' ? `const ${found.getText(source)};` : found.getText(source)
}
function compile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
}
const hostSource = sourceFile('../src/main/engine/host.ts')
const hostCallback = compile(`class Host { ${extract(hostSource, 'stream', 'method')} }; globalThis.Host = Host;`)
async function hostStream(response: Response | Error | (() => Response), preparationError?: Error,
  abortTiming?: 'before-dispatch' | 'after-dispatch'): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  const controller = new AbortController()
  const context = {
    Error, AbortSignal, isExplicitRequestRejection, parseSseBlock, TextDecoder,
    isAccountRequestPath: () => false,
    engineIdentityOf: () => ({}), engineTargetError: () => null, remoteRequestError: () => null,
    remoteWorkspacePathError: () => null, normalizeEnginePath: (path: string) => path,
    subagentProtocolHeaders: () => ({}), logger: { error: () => {} },
    fetch: async () => {
      if (abortTiming === 'after-dispatch') controller.abort()
      if (response instanceof Error) throw response
      return typeof response === 'function' ? response() : response
    },
    Host: undefined as unknown as new () => { stream: (id: string, path: string, body: unknown, signal: AbortSignal) => Promise<void> }
  }
  runInNewContext(hostCallback, context)
  const host = new context.Host()
  Object.assign(host, {
    snapshot: { mode: 'embedded' }, baseUrl: 'http://synthetic.invalid', requestSignal: new AbortController().signal,
    prepareRequestHeaders: async () => {
      if (abortTiming === 'before-dispatch') controller.abort()
      if (preparationError) throw preparationError
      return {}
    },
    emit: (_name: string, event: StreamEvent) => events.push(event)
  })
  await host.stream('stream', '/chat', { sessionId: 'A', message: 'retain me' }, controller.signal)
  return events
}

test('HTTP and JSON admission refusals carry explicit rejection; 5xx and disconnect remain unknown', async () => {
  for (const [status, code] of [[400, 40001], [403, 40300], [200, 42900], [409, 40900]]) {
    const events = await hostStream(new Response(JSON.stringify({ code, message: 'synthetic refusal' }), { status, headers: { 'content-type': 'application/json' } }))
    expect(events).toEqual([{ streamId: 'stream', type: 'error', status, code, message: 'synthetic refusal', requestRejected: true }])
  }
  for (const [status, code] of [[500, 50000], [503, 40001], [200, 50000], [200, 200]]) {
    const events = await hostStream(new Response(JSON.stringify({ code, message: 'unknown execution outcome' }), { status, headers: { 'content-type': 'application/json' } }))
    expect(events[0]).toMatchObject({ type: 'error', requestRejected: false })
  }
  expect((await hostStream(new Error('connection reset')))[0]).toMatchObject({ type: 'error', requestRejected: false })
})

test('local preparation failure is rejected before request dispatch', async () => {
  const events = await hostStream(new Response('unused'), new Error('attachment cannot be prepared'))
  expect(events[0]).toMatchObject({ type: 'error', message: 'attachment cannot be prepared', requestRejected: true })
})

test('detaching during host preparation reports non-admission without issuing fetch', async () => {
  let fetched = false
  const events = await hostStream(() => { fetched = true; return new Response('unused') }, undefined, 'before-dispatch')
  expect(fetched).toBe(false)
  expect(events).toEqual([{ streamId: 'stream', type: 'error', message: '发送已取消，消息尚未发出', requestRejected: true }])
})

test('detaching after host dispatch remains an unknown execution outcome', async () => {
  const events = await hostStream(new Error('request aborted'), undefined, 'after-dispatch')
  expect(events).toEqual([{ streamId: 'stream', type: 'done' }])
})

test('IPC invocation retains a preflight refusal after its renderer route was detached', () => {
  const source = sourceFile('../src/main/ipc.ts')
  let listener: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'engineHost.on' &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'stream') listener = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!listener) throw new Error('Missing production stream router')
  const sent: unknown[] = []
  const owner: { rejection?: { message: string }; sender: { send: (...args: unknown[]) => void; isDestroyed: () => boolean } } = {
    sender: { send: (...args) => { sent.push(args) }, isDestroyed: () => false }
  }
  const context = {
    streamResults: new Map([['private-route', owner]]), streamRoutes: new Map(),
    IPC: { event: { streamEvent: 'stream' } },
    routeEvent: undefined as unknown as (event: StreamEvent) => void
  }
  runInNewContext(compile(`const routeEvent = ${listener.getText(source)}; globalThis.routeEvent = routeEvent;`), context)
  context.routeEvent({ streamId: 'private-route', type: 'error', message: 'not dispatched', requestRejected: true })
  expect(owner.rejection).toMatchObject({ message: 'not dispatched' })
  expect(sent).toEqual([])
})

const chatSource = sourceFile('../src/renderer/src/core/engine/useChat.ts')
const chatCallbacks = compile([
  extract(chatSource, 'patchLastAssistant', 'function'),
  extract(chatSource, 'rejectOutgoingSend', 'variable'),
  extract(chatSource, 'runStream', 'variable'),
  extract(chatSource, 'applyEvent', 'function'),
  'globalThis.runStream = runStream; globalThis.applyEvent = applyEvent;'
].join('\n'))
function chatHarness(options: { event?: boolean; rejection?: string; failure?: Error; preflight?: Error } = {}) {
  let epoch = 0
  let ids = 0
  let streaming = true
  let error: string | null = null
  const recoveries: string[] = []
  const calls: unknown[] = []
  let messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'retain me', thinking: '', tools: [], items: [], status: 'done', createdAt: 1 },
    { id: 'a', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'streaming', createdAt: 2 }
  ]
  const refs = {
    activeStreamRef: { current: null as string | null }, activeSessionRef: { current: 'A' as string | null },
    viewSessionRef: { current: 'A' as string | null }, activeRunIdRef: { current: null as string | null },
    consumedEventIdRef: { current: null }, outgoingSendRef: { current: null as { scope: RecoveryScope; streamId: string } | null },
    rejectedSendScopeRef: { current: null as RecoveryScope | null },
    recoverRef: { current: async (sessionId: string) => { recoveries.push(sessionId); return true } }
  }
  const context = {
    ...refs, Error, Date, ChatRequestRejectedError, finishTransport, renderSource: 1, commandOwner: 'code',
    useCallback: <T>(callback: T): T => callback,
    assertEngineSource: () => {}, newId: () => `stream-${++ids}`,
    recoveryScope: (sessionId: string): RecoveryScope => ({ source: 1, sessionId, viewEpoch: epoch }),
    scopeIsCurrent: (scope: RecoveryScope) => sameRecoveryScope(scope, context.recoveryScope(refs.viewSessionRef.current ?? '')),
    invalidateRecovery: () => { epoch++; refs.outgoingSendRef.current = null; refs.rejectedSendScopeRef.current = null },
    recoveryLoop: { retry: () => {} },
    flushStreamPatches: () => {},
    setStreaming: (value: boolean) => { streaming = value },
    setHistoryError: (value: string) => { error = value },
    setMessages: (update: (previous: ChatMessage[]) => ChatMessage[]) => { messages = update(messages) },
    engine: {
      getSubagentProtocol: async () => { if (options.preflight) throw options.preflight; return 1 },
      startStream: async (input: { streamId: string }): Promise<StreamStartResult> => {
        calls.push(input)
        if (options.failure) throw options.failure
        if (!options.rejection) return { ok: true }
        if (options.event) context.applyEvent({ streamId: input.streamId, type: 'error', message: options.rejection, requestRejected: true })
        return { ok: false, rejection: { message: options.rejection } }
      }
    },
    runStream: undefined as unknown as (body: Record<string, unknown>) => Promise<void>,
    applyEvent: undefined as unknown as (event: StreamEvent) => void
  }
  runInNewContext(chatCallbacks, context)
  return { ...refs, calls, recoveries, messages: () => messages, streaming: () => streaming, error: () => error,
    send: async () => await context.runStream({ sessionId: 'A', message: 'retain me' }) }
}

for (const event of [false, true]) {
  test(`explicit rejection preserves the failed input and rejects send with${event ? '' : 'out'} prior IPC event`, async () => {
    const state = chatHarness({ rejection: 'model not allowed', event })
    await expect(state.send()).rejects.toBeInstanceOf(ChatRequestRejectedError)
    expect(state.messages()).toHaveLength(2)
    expect(state.messages()[0].content).toBe('retain me')
    expect(state.messages()[1]).toMatchObject({ status: 'error', error: 'model not allowed' })
    expect(state.streaming()).toBe(false)
    expect(state.error()).toBe('model not allowed')
    expect(state.rejectedSendScopeRef.current?.sessionId).toBe('A')
    expect(state.recoveries).toEqual([])
    expect(state.calls).toHaveLength(1)
  })
}

test('capability/preflight failure is rejected without submitting a task', async () => {
  const state = chatHarness({ preflight: new Error('capabilities unavailable') })
  await expect(state.send()).rejects.toBeInstanceOf(ChatRequestRejectedError)
  expect(state.calls).toEqual([])
  expect(state.messages()[0].content).toBe('retain me')
  expect(state.messages()[1].status).toBe('error')
  expect(state.recoveries).toEqual([])
})

test('unknown connection loss only recovers observation, without marking rejection or reposting', async () => {
  const failure = new Error('connection lost after dispatch')
  const state = chatHarness({ failure })
  await expect(state.send()).rejects.toBe(failure)
  expect(state.rejectedSendScopeRef.current).toBeNull()
  expect(state.recoveries).toEqual(['A'])
  expect(state.calls).toHaveLength(1)
})

const queueCallback = compile(`${extract(chatSource, 'dispatchQueued', 'variable')}
${extract(chatSource, 'drainQueue', 'variable')}
${extract(chatSource, 'flushQueue', 'variable')}
${extract(chatSource, 'mergeAndSend', 'variable')}
globalThis.dispatchQueued = dispatchQueued; globalThis.drainQueue = drainQueue;
globalThis.flushQueue = flushQueue; globalThis.mergeAndSend = mergeAndSend;`)
type Entry = { id: string; text: string; options: { sessionId: string; model?: string }; attachments: [] }
const queued = (id: string, sessionId: string): Entry => ({ id, text: id, options: { sessionId }, attachments: [] })
function queueHarness(failure?: Error | (() => Promise<void>), mode = 'batch', activeSession = 'B') {
  const queueRef = { current: [queued('A1', 'A'), queued('B1', 'B'), queued('A2', 'A'), queued('B2', 'B')] }
  const calls: { text: string; options: Entry['options'] }[] = []
  let source = 1
  let working = false
  const context = {
    Error, ChatRequestRejectedError, takeSessionQueue, restoreSessionQueue, queueRef,
    viewSessionRef: { current: activeSession }, queueSendModeRef: { current: mode },
    sourceRef: { current: 1 }, mountedRef: { current: true }, getEngineSource: () => source, isEngineReady: () => true,
    pausedQueueSessionsRef: { current: new Set<string>() },
    renderSource: 1, assertEngineSource: () => {},
    hasSessionWork: () => working, rejectedSendScopeRef: { current: null as RecoveryScope | null },
    useCallback: <T>(callback: T): T => callback,
    syncQueue: (entries: Entry[]) => { queueRef.current = entries },
    recoveryScope: (sessionId: string) => ({ source: 1, sessionId, viewEpoch: 1 }),
    scopeIsCurrent: (scope: RecoveryScope) => scope.source === source && scope.sessionId === context.viewSessionRef.current,
    sendInternalRef: { current: async (text: string, options: Entry['options']) => {
      calls.push({ text, options })
      if (typeof failure === 'function') { await failure(); return }
      if (failure) throw failure
    } },
    dispatchQueued: undefined as unknown as () => Promise<void>,
    drainQueue: undefined as unknown as () => Promise<void>,
    flushQueue: undefined as unknown as () => Promise<void>,
    mergeAndSend: undefined as unknown as (text: string, options: Entry['options']) => Promise<void>
  }
  runInNewContext(queueCallback, context)
  return { queueRef, calls, send: async () => await context.dispatchQueued(), drain: async () => await context.drainQueue(),
    flush: async () => await context.flushQueue(), paused: context.pausedQueueSessionsRef.current,
    merge: async () => await context.mergeAndSend('fresh input', { sessionId: context.viewSessionRef.current }),
    changeSource: () => { source++ }, select: (sessionId: string) => { context.viewSessionRef.current = sessionId },
    setWorking: (value: boolean) => { working = value } }
}

test('queue dispatch only sends the active session and preserves the other session order', async () => {
  const state = queueHarness()
  await state.send()
  expect(state.calls).toEqual([{ text: '1. B1\n\n2. B2', options: { sessionId: 'B', model: undefined, attachments: [] } }])
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['A1', 'A2'])
})

test('explicit queued rejection restores only the selected entries without another send', async () => {
  const failure = new ChatRequestRejectedError('not admitted')
  const state = queueHarness(failure)
  await expect(state.send()).rejects.toBe(failure)
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['A1', 'B1', 'A2', 'B2'])
  expect(state.calls).toHaveLength(1)
})

test('unknown queued send outcome is not re-enqueued for duplicate execution', async () => {
  const failure = new Error('connection lost')
  const state = queueHarness(failure)
  await expect(state.send()).rejects.toBe(failure)
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['A1', 'A2'])
  expect(state.calls).toHaveLength(1)
})

test('queue rejection after an engine change cannot restore items into the new source', async () => {
  const failure = new ChatRequestRejectedError('not admitted')
  const state = queueHarness(failure)
  const sending = state.send()
  state.changeSource()
  state.queueRef.current = [queued('new-source', 'B')]
  await expect(sending).rejects.toBe(failure)
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['new-source'])
})

test('B completion never drains A; returning to active A waits for its authoritative terminal state', async () => {
  const state = queueHarness()
  await state.drain()
  await state.drain()
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0].options.sessionId).toBe('B')
  state.select('A')
  state.setWorking(true)
  await state.drain()
  expect(state.calls).toHaveLength(1)
  state.setWorking(false)
  await state.drain()
  expect(state.calls).toHaveLength(2)
  expect(state.calls[1]).toMatchObject({ text: '1. A1\n\n2. A2', options: { sessionId: 'A' } })
  expect(state.queueRef.current).toEqual([])
})

for (const operation of ['send', 'merge'] as const) {
  test(`${operation}: a late explicit refusal restores A's queue while B is selected`, async () => {
    let reject!: (error: Error) => void
    const response = new Promise<void>((_resolve, fail) => { reject = fail })
    const state = queueHarness(() => response, 'batch', 'A')
    const sending = state[operation]()
    expect(state.queueRef.current.map(entry => entry.id)).toEqual(['B1', 'B2'])
    state.select('B')
    const failure = new ChatRequestRejectedError('explicit refusal after navigation')
    reject(failure)
    await expect(sending).rejects.toBe(failure)
    expect(state.queueRef.current.map(entry => entry.id)).toEqual(['A1', 'B1', 'A2', 'B2'])
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].options.sessionId).toBe('A')
  })

  test(`${operation}: a late refusal never restores old-source items into a new engine queue`, async () => {
    let reject!: (error: Error) => void
    const response = new Promise<void>((_resolve, fail) => { reject = fail })
    const state = queueHarness(() => response, 'batch', 'A')
    const sending = state[operation]()
    state.changeSource()
    state.queueRef.current = [queued('new-source', 'B')]
    const failure = new ChatRequestRejectedError('old source refusal')
    reject(failure)
    await expect(sending).rejects.toBe(failure)
    expect(state.queueRef.current.map(entry => entry.id)).toEqual(['new-source'])
  })
}

for (const retry of ['flush', 'merge'] as const) {
  test(`rejected A queue stays paused across view switches until explicit ${retry}`, async () => {
    let attempts = 0
    const state = queueHarness(async () => {
      if (++attempts === 1) throw new ChatRequestRejectedError('not admitted')
    }, 'batch', 'A')
    await expect(state.send()).rejects.toBeInstanceOf(ChatRequestRejectedError)
    expect(state.paused.has('A')).toBe(true)
    state.select('B')
    state.select('A')
    await state.drain()
    expect(state.calls).toHaveLength(1)
    await state[retry]()
    expect(state.paused.has('A')).toBe(false)
    expect(state.calls).toHaveLength(2)
    expect(state.calls.every(call => call.options.sessionId === 'A')).toBe(true)
    expect(state.queueRef.current.map(entry => entry.id)).toEqual(['B1', 'B2'])
  })
}
