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
  callbackDeclaration('resolveEngineRow') + '\n' + callbackDeclaration('truncateFrom') + '\nglobalThis.truncate = truncateFrom;',
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
} = {}) {
  let engineSource = 1, viewEpoch = 1
  const calls: Request[] = [], reloads: string[] = []
  const viewSessionRef = { current: 'session-a' }
  const guard = createHistoryMutationGuard()
  const scope = (): RecoveryScope => ({ source: engineSource, sessionId: viewSessionRef.current, viewEpoch })
  const context = {
    Error, renderSource: 1, viewSessionRef, historyMutationGuard: guard,
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
    truncate: undefined as unknown as (sessionId: string, message: Row) => Promise<void>
  }
  runInNewContext(callbacks, context)
  return { calls, reloads, guard, scope, truncate: (message = user) => context.truncate('session-a', message),
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
