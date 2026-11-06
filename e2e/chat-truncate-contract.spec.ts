/** Production useChat truncation callback: exact identity, no implicit send/revert, and stale-view safety. */
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createHistoryMutationGuard } from '../src/renderer/src/core/engine/history-mutation'
import { sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'

const filename = resolve(__dirname, '../src/renderer/src/core/engine/useChat.ts')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
function callbackDeclaration(name: string): string {
  let declaration: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!declaration) throw new Error(`Missing useChat callback: ${name}`)
  return `const ${declaration.getText(source)};`
}
const callbacks = ts.transpileModule(
  ['resolveEngineRow', 'truncateFrom', 'deleteTurn', 'retryFrom', 'revertFrom'].map(callbackDeclaration).join('\n') +
    '\nglobalThis.truncate = truncateFrom; globalThis.remove = deleteTurn; globalThis.retry = retryFrom; globalThis.revert = revertFrom;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText
type Row = { id: string; role: string; content: string; conversationId: string }
type Request = { method: string; path: string; query?: { sessionId: string }; body?: { sessionId: string; messageId: string } }
type Response = { ok: boolean; data?: Row[]; message?: string }
const user: Row = { id: 'user-a', role: 'user', content: 'same original text', conversationId: 'turn-a' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(options: {
  running?: boolean
  rows?: Row[]
  request?: (request: Request) => Promise<Response>
  restore?: () => Promise<{ kind: string }>
  send?: () => Promise<void>
  revert?: () => Promise<void>
} = {}) {
  let engineSource = 1, viewEpoch = 1
  const calls: Request[] = [], reloads: string[] = [], modelChanges: unknown[] = []
  const viewSessionRef = { current: 'session-a' }
  const guard = createHistoryMutationGuard()
  const scope = (): RecoveryScope => ({ source: engineSource, sessionId: viewSessionRef.current, viewEpoch })
  const context = {
    Error, renderSource: 1, viewSessionRef, historyMutationGuard: guard,
    commandOwner: 'work', displayHistoryRef: { current: null },
    setSessionModel: (value: unknown) => { modelChanges.push(value) },
    resetDisplayHistory: () => {}, setDisplayRefreshVersion: () => {},
    useCallback: <T>(value: T): T => value,
    getEngineSource: () => engineSource,
    assertEngineSource: (expected: number) => { if (engineSource !== expected) throw new Error('Engine changed') },
    hasSessionWork: () => options.running === true,
    invalidateRecovery: () => { viewEpoch++ },
    recoveryScope: (sessionId: string): RecoveryScope => ({ source: engineSource, sessionId, viewEpoch }),
    scopeIsCurrent: (expected: RecoveryScope) => sameRecoveryScope(expected, scope()),
    engine: { request: async (request: Request) => {
      calls.push(request)
      if (options.request) return options.request(request)
      return request.method === 'GET' ? { ok: true, data: options.rows ?? [{ ...user, id: 'same-text-other-turn' }, user] } : { ok: true }
    } },
    restoreSession: async (sessionId: string) => { reloads.push(sessionId); return options.restore ? options.restore() : { kind: 'restored' } },
    send: async () => { await options.send?.() },
    revertConversationFrom: async () => { await options.revert?.() },
    truncate: undefined as unknown as (sessionId: string, message: Row, onHistoryChanged?: () => void) => Promise<void>,
    remove: undefined as unknown as (sessionId: string, message: Row, onHistoryChanged?: () => void) => Promise<void>,
    retry: undefined as unknown as (message: Row, options: { sessionId: string }, onHistoryChanged?: () => void) => Promise<void>,
    revert: undefined as unknown as (sessionId: string, message: Row, onHistoryChanged?: () => void) => Promise<void>
  }
  runInNewContext(callbacks, context)
  return { calls, reloads, modelChanges, guard, scope, truncate: (message = user, onHistoryChanged?: () => void) => context.truncate('session-a', message, onHistoryChanged),
    mutate: (action: 'truncate' | 'remove' | 'retry' | 'revert', onHistoryChanged: () => void) => action === 'retry'
      ? context.retry(user, { sessionId: 'session-a' }, onHistoryChanged) : context[action]('session-a', user, onHistoryChanged),
    switchView: (sessionId: string, source = engineSource) => { viewEpoch++; viewSessionRef.current = sessionId; engineSource = source } }
}

test('re-edit truncates the exact user ID then restores authoritative history without model or file calls', async () => {
  const f = harness()
  await f.truncate()
  expect(f.calls).toEqual([
    { method: 'GET', path: '/conversation/history', query: { sessionId: 'session-a' } },
    { method: 'POST', path: '/conversation/truncate', body: { sessionId: 'session-a', messageId: user.id } }
  ])
  expect(f.reloads).toEqual(['session-a'])
  expect(f.guard.blocked(f.scope())).toBe(false)
})

test('same text cannot substitute for a missing stable user message', async () => {
  const f = harness({ rows: [{ ...user, id: 'another-id' }] })
  await assert.rejects(f.truncate(), /稳定记录/)
  expect(f.calls).toHaveLength(1)
  expect(f.reloads).toEqual([])
  expect(f.guard.blocked(f.scope())).toBe(false)
})

test('running sessions and non-user messages reject before touching history', async () => {
  const active = harness({ running: true })
  await assert.rejects(active.truncate(), /会话运行中/)
  expect(active.calls).toEqual([])
  const assistant = harness()
  await assert.rejects(assistant.truncate({ ...user, role: 'assistant' }), /只能从用户消息/)
  expect(assistant.calls).toEqual([])
})

test('failed truncation preserves the current history and releases its mutation guard', async () => {
  const f = harness({ request: async request => request.method === 'GET' ? { ok: true, data: [user] } : { ok: false, message: 'Denied by fixture' } })
  await assert.rejects(f.truncate(), /Denied by fixture/)
  expect(f.reloads).toEqual([])
  expect(f.guard.blocked(f.scope())).toBe(false)
})

test('navigation during identity lookup prevents deletion and a second click cannot race that lookup', async () => {
  const response = deferred<Response>()
  const f = harness({ request: () => response.promise })
  const pending = f.truncate()
  await assert.rejects(f.truncate(), /历史正在更新/)
  expect(f.calls).toHaveLength(1)
  f.switchView('session-b')
  response.resolve({ ok: true, data: [user] })
  await assert.rejects(pending, /会话状态已变化/)
  expect(f.calls).toHaveLength(1)
  expect(f.reloads).toEqual([])
})

test('navigation after deletion was dispatched does not reload the new session', async () => {
  const response = deferred<Response>(), dispatched = deferred<void>()
  const f = harness({ request: async request => {
    if (request.method === 'GET') return { ok: true, data: [user] }
    dispatched.resolve(); return response.promise
  } })
  const pending = f.truncate()
  await dispatched.promise
  f.switchView('session-b')
  response.resolve({ ok: true })
  await assert.rejects(pending, /会话状态已变化/)
  expect(f.calls).toHaveLength(2)
  expect(f.reloads).toEqual([])
})

test('changing engines during lookup cannot send the old ID to the new engine', async () => {
  const response = deferred<Response>()
  const f = harness({ request: () => response.promise })
  const pending = f.truncate()
  f.switchView('session-a', 2)
  response.resolve({ ok: true, data: [user] })
  await assert.rejects(pending, /Engine changed/)
  expect(f.calls).toHaveLength(1)
  expect(f.reloads).toEqual([])
})

test('a failed reload reports that history changed instead of pretending recovery completed', async () => {
  const f = harness({ restore: async () => ({ kind: 'failed' }) })
  await assert.rejects(f.truncate(), /历史已截断/)
  expect(f.reloads).toEqual(['session-a'])
  expect(f.guard.blocked(f.scope())).toBe(false)
})

for (const action of ['truncate', 'remove', 'retry', 'revert'] as const) {
  test(`${action} commits the history callback before recovery, including a recovery failure`, async () => {
    const events: string[] = []
    const f = harness({ restore: async () => { events.push('restore'); return { kind: 'failed' } } })
    await assert.rejects(f.mutate(action, () => {
      expect(f.modelChanges).toEqual([null])
      events.push('changed')
    }), /重新加载/)
    expect(events).toEqual(['changed', 'restore'])
    expect(f.guard.blocked(f.scope())).toBe(false)
  })

  test(`${action} rejects an engine mutation without clearing the caller's history baseline`, async () => {
    let changed = 0
    const f = harness({ request: async request => request.method === 'GET' ? { ok: true, data: [user] } : { ok: false, message: 'Denied' },
      revert: async () => { throw new Error('Denied') } })
    await assert.rejects(f.mutate(action, () => { changed++ }), /Denied/)
    expect(changed).toBe(0)
    expect(f.reloads).toEqual([])
    expect(f.modelChanges).toEqual([])
  })
}

test('retry clears the previous baseline before starting a long stream and keeps it cleared if sending fails', async () => {
  const started = deferred<void>(), finish = deferred<void>(), events: string[] = []
  const f = harness({ restore: async () => { events.push('restore'); return { kind: 'restored' } },
    send: async () => { events.push('send'); started.resolve(); await finish.promise; throw new Error('Provider failed') } })
  const result = f.mutate('retry', () => events.push('changed'))
  await started.promise
  expect(events).toEqual(['changed', 'restore', 'send'])
  finish.resolve()
  await assert.rejects(result, /Provider failed/)
  expect(events.filter(event => event === 'changed')).toHaveLength(1)
})

test('committed history still notifies its original task after navigation, but never across an engine switch', async () => {
  for (const source of [1, 2]) {
    const response = deferred<Response>(), dispatched = deferred<void>()
    let changed = 0
    const f = harness({ request: async request => {
      if (request.method === 'GET') return { ok: true, data: [user] }
      dispatched.resolve(); return response.promise
    } })
    const result = f.truncate(user, () => { changed++ })
    await dispatched.promise
    f.switchView('session-b', source)
    response.resolve({ ok: true })
    await assert.rejects(result, source === 1 ? /会话状态已变化/ : /Engine changed/)
    expect(changed).toBe(source === 1 ? 1 : 0)
    expect(f.reloads).toEqual([])
    expect(f.modelChanges).toEqual([])
  }
})
