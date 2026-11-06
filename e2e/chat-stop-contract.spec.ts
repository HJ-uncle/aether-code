/** Execute production stop and queue callbacks without Electron or model calls. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { durableCancelBody, sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { ChatRequestRejectedError } from '../src/renderer/src/core/engine/chat-send-request'
import { codeQueueSubmission } from '../src/renderer/src/core/engine/code-queue-entry'
import type { RootRunStatus } from '../src/shared/root-run'

const filename = resolve(__dirname, '../src/renderer/src/core/engine/useChat.ts')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
const callbackNames = ['flushQueue', 'mergeAndSend', 'abort']
const declarations = new Map<string, ts.VariableDeclaration>()
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackNames.includes(node.name.text)) declarations.set(node.name.text, node)
  ts.forEachChild(node, visit)
}
visit(source)
const callback = ts.transpileModule(callbackNames.map(name => {
  const declaration = declarations.get(name)
  if (!declaration) throw new Error(`Missing production ${name} callback`)
  return `const ${declaration.getText(source)}; globalThis.${name} = ${name};`
}).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

type Run = { sessionId: string; runId: string; status: RootRunStatus }
type Entry = { id: string; text: string; options: { sessionId: string; model?: string }; attachments: [] }
const queued = (id: string, sessionId: string): Entry => ({ id, text: id, options: { sessionId }, attachments: [] })
const run = (status: RootRunStatus = 'running', runId = 'run-a'): Run => ({ sessionId: 'session-a', runId, status })
const snapshot = (root: Run, runs: Run[] = []) => ({ kind: 'restored', snapshot: { run: root, runs } })
const ack = (cancelled = true) => ({ sessionId: 'session-a', runId: 'run-a', cancelled, settled: cancelled })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(options: {
  cancel?: () => Promise<unknown>
  restore?: () => Promise<unknown>
  known?: Run | null
} = {}) {
  let epoch = 1
  let engineSource = 1
  let stopping = false
  let working = true
  let error: string | null = null
  const cancellations: unknown[] = []
  const detached: string[] = []
  const resumed: string[] = []
  const sends: { text: string; options: Entry['options'] }[] = []
  const refs = {
    activeStreamRef: { current: 'stream-a' as string | null },
    viewSessionRef: { current: 'session-a' as string | null },
    activeSessionRef: { current: 'session-a' as string | null },
    activeRunIdRef: { current: options.known === null ? null : 'run-a' as string | null },
    rootRunsRef: { current: new Map<string, Run>(options.known === null ? [] : [['run-a', options.known ?? run()]]) },
    stoppingRef: { current: null as RecoveryScope | null },
    stoppingFlightRef: { current: null as { scope: RecoveryScope; promise: Promise<void> } | null },
    queueRef: { current: [queued('queued-a', 'session-a'), queued('queued-b', 'session-b')] },
    pausedQueueSessionsRef: { current: new Set<string>() }
  }
  const context = {
    ...refs, Error, renderSource: 1, durableCancelBody, ChatRequestRejectedError, codeQueueSubmission,
    commandOwner: 'code', queueSessionId: 'session-a', durableQueue: {
      refresh: async () => { refs.pausedQueueSessionsRef.current.add('session-a'); return null },
      resume: async () => { refs.pausedQueueSessionsRef.current.delete('session-a'); sends.push({ text: 'resume', options: { sessionId: 'session-a' } }) },
      merge: async () => { sends.push({ text: 'merge', options: { sessionId: 'session-a' } }) }
    },
    sourceRef: { current: 1 }, mountedRef: { current: true },
    getEngineSource: () => engineSource, isEngineReady: () => true,
    queueSendModeRef: { current: 'serial' }, rejectedSendScopeRef: { current: null as RecoveryScope | null },
    sendInternalRef: { current: async (text: string, options: Entry['options']) => { sends.push({ text, options }) } },
    useCallback: <T>(value: T): T => value,
    assertEngineSource: (expected: number) => { if (engineSource !== expected) throw new Error('Engine changed') },
    recoveryScope: (sessionId: string): RecoveryScope => ({ source: engineSource, sessionId, viewEpoch: epoch }),
    scopeIsCurrent: (scope: RecoveryScope) => sameRecoveryScope(scope, context.recoveryScope(refs.viewSessionRef.current ?? '')),
    hasSessionWork: () => working,
    flushStreamPatches: () => {},
    invalidateRecovery: () => {
      epoch++
      refs.stoppingRef.current = null
      refs.stoppingFlightRef.current = null
      stopping = false
      error = null
    },
    setStopping: (value: boolean) => { stopping = value },
    setStopError: (value: string | null) => { error = value },
    syncQueue: (value: typeof refs.queueRef.current) => { refs.queueRef.current = value },
    restoreSession: async () => options.restore ? options.restore() : snapshot(run('cancelled')),
    resumeStream: async (sessionId: string) => { resumed.push(sessionId); return true },
    engine: {
      requestOrThrow: async (input: unknown) => { cancellations.push(input); return options.cancel ? options.cancel() : ack() },
      abortStream: async (streamId: string) => { detached.push(streamId); return { ok: true } }
    },
    abort: undefined as unknown as () => Promise<void>,
    drainQueue: undefined as unknown as () => Promise<void>,
    flushQueue: undefined as unknown as () => Promise<void>,
    mergeAndSend: undefined as unknown as (text: string, options: Entry['options']) => Promise<void>
  }
  runInNewContext(callback, context)
  return { ...refs, cancellations, detached, resumed, sends, abort: () => context.abort(),
    drain: () => context.drainQueue(), flush: () => context.flushQueue(),
    merge: () => context.mergeAndSend('补充要求', { sessionId: refs.viewSessionRef.current! }),
    setWorking: (value: boolean) => { working = value },
    stopping: () => stopping, error: () => error,
    switchView: (sessionId: string, source = engineSource) => {
      context.invalidateRecovery()
      refs.viewSessionRef.current = sessionId
      engineSource = source
    } }
}

test('stop is visible and single flight until owned cancellation and snapshot both settle', async () => {
  const response = deferred<unknown>()
  const restored = deferred<unknown>()
  const state = harness({ cancel: () => response.promise, restore: () => restored.promise })
  const first = state.abort(), second = state.abort()
  expect(second).toBe(first)
  expect(state.stopping()).toBe(true)
  expect(state.cancellations).toEqual([{ method: 'POST', path: '/chat/cancel', body: { sessionId: 'session-a', runId: 'run-a' } }])
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['queued-a', 'queued-b'])
  response.resolve(ack())
  await Promise.resolve()
  expect(state.stopping()).toBe(true)
  restored.resolve(snapshot(run('cancelled')))
  await first
  expect(state.stopping()).toBe(false)
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['queued-a', 'queued-b'])
  expect([...state.pausedQueueSessionsRef.current]).toEqual(['session-a'])
  expect(state.detached).toEqual(['stream-a'])
  expect(state.resumed).toEqual(['session-a'])
})

test('explicit queue send resumes the durable owner without renderer dispatch or deletion', async () => {
  const state = harness()
  await state.abort()
  state.setWorking(false)
  await state.flush()
  expect(state.sends.map(send => send.text)).toEqual(['resume'])
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['queued-a', 'queued-b'])
})

test('explicit resume during an active run delegates scheduling to the durable owner', async () => {
  const state = harness()
  await state.merge()
  expect(state.sends.map(send => send.text)).toEqual(['merge'])
  await state.flush()
  state.setWorking(false)
  await state.merge()
  expect(state.sends.map(send => send.text)).toEqual(['merge', 'resume', 'merge', 'resume'])
})

test('false cancel acknowledgement with running snapshot rejects visibly and retains queue', async () => {
  const state = harness({ cancel: async () => ack(false), restore: async () => snapshot(run()) })
  await expect(Promise.resolve(state.abort())).rejects.toThrow('停止未确认')
  expect(state.error()).toContain('停止未确认')
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.stopping()).toBe(false)
  expect(state.resumed).toEqual(['session-a'])
})

for (const status of ['succeeded', 'failed', 'interrupted'] satisfies RootRunStatus[]) {
  test(`naturally ${status} target is accepted without discarding queued user intent`, async () => {
    const state = harness({ cancel: async () => ack(false), restore: async () => snapshot(run(status)) })
    await state.abort()
    expect(state.error()).toBeNull()
    expect(state.queueRef.current).toHaveLength(2)
    expect(state.pausedQueueSessionsRef.current.size).toBe(0)
    expect(state.resumed).toEqual(['session-a'])
  })
}

test('cancel transport failure rejects once and resumes observation without reposting cancellation', async () => {
  const failure = new Error('permission denied')
  const state = harness({ cancel: async () => { throw failure } })
  await expect(Promise.resolve(state.abort())).rejects.toBe(failure)
  expect(state.error()).toBe('permission denied')
  expect(state.cancellations).toHaveLength(1)
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.resumed).toEqual(['session-a'])
})

test('a newer run cannot stand in for the target stop outcome', async () => {
  const state = harness({ cancel: async () => ack(false), restore: async () => snapshot(run('cancelled', 'run-new')) })
  await expect(Promise.resolve(state.abort())).rejects.toThrow('停止未确认')
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.cancellations).toHaveLength(1)
})

test('cancelled target preserves a newer active run and never posts another cancel', async () => {
  const state = harness({ restore: async () => snapshot(run('running', 'run-new'), [run('cancelled')]) })
  await state.abort()
  expect(state.cancellations).toHaveLength(1)
  expect(state.resumed).toEqual(['session-a'])
  expect(state.error()).toBeNull()
})

test('a stale stop completion cannot change the next session or clear its queue', async () => {
  const response = deferred<unknown>()
  const state = harness({ cancel: () => response.promise })
  const stopping = state.abort()
  state.switchView('session-b')
  response.reject(new Error('old cancellation failed'))
  await stopping
  expect(state.stopping()).toBe(false)
  expect(state.error()).toBeNull()
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.resumed).toEqual([])
})

test('missing admission identity does not issue a session-wide cancellation', async () => {
  const state = harness({ known: null, restore: async () => ({ kind: 'restored', snapshot: { runs: [] } }) })
  await expect(Promise.resolve(state.abort())).rejects.toThrow('尚未确认运行是否已接收')
  expect(state.cancellations).toEqual([])
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.resumed).toEqual(['session-a'])
})

test('mismatched acknowledgement is rejected and cannot consume queued intent', async () => {
  const state = harness({ cancel: async () => ({ ...ack(), runId: 'run-other' }) })
  await expect(Promise.resolve(state.abort())).rejects.toThrow('停止回执与当前运行不匹配')
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.resumed).toEqual(['session-a'])
})

test('legacy acknowledgement without runId still requires an exact terminal snapshot', async () => {
  const state = harness({ cancel: async () => ({ sessionId: 'session-a', cancelled: true }) })
  await state.abort()
  expect(state.error()).toBeNull()
  expect(state.queueRef.current.map(entry => entry.id)).toEqual(['queued-a', 'queued-b'])
  expect([...state.pausedQueueSessionsRef.current]).toEqual(['session-a'])
})

test('an accepted cancellation cannot manufacture a terminal status from a still-running snapshot', async () => {
  const state = harness({ restore: async () => snapshot(run()) })
  await expect(Promise.resolve(state.abort())).rejects.toThrow('运行状态尚未同步')
  expect(state.queueRef.current).toHaveLength(2)
  expect(state.resumed).toEqual(['session-a'])
})

test('same-session navigation isolates an old stop completion from the next stop flight', async () => {
  const oldResponse = deferred<unknown>(), nextResponse = deferred<unknown>()
  let calls = 0
  const state = harness({ cancel: () => ++calls === 1 ? oldResponse.promise : nextResponse.promise })
  const oldStop = state.abort()
  state.switchView('session-a')
  state.activeStreamRef.current = 'new-stream'
  const nextStop = state.abort()
  oldResponse.reject(new Error('stale failure'))
  await oldStop
  expect(state.stopping()).toBe(true)
  expect(state.stoppingFlightRef.current?.promise).toBe(nextStop)
  expect(state.error()).toBeNull()
  nextResponse.resolve(ack())
  await nextStop
  expect(state.stopping()).toBe(false)
  expect(state.resumed).toEqual(['session-a'])
})
