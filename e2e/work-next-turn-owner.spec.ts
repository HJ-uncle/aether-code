import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createWorkNextTurnOwner, type WorkQueueOwnerEvent, type WorkQueueOwnerPorts } from '../src/main/work-next-turn-owner'
import { EngineQueueGateway, type QueueEnginePort } from '../src/main/next-turn-engine-gateway'
import { NextTurnQueueStore } from '../src/main/next-turn-queue-store'
import { engineHost } from '../src/main/engine/host'
import { WORK_QUEUE_TRANSPORT } from '../src/main/next-turn-admission-protocol'
import type { EngineSnapshot, EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import { WORK_QUEUE_IPC, type WorkQueueDraft, type WorkQueueRequest, type WorkQueueInvokeResult } from '../src/shared/work-next-turn-api'

/** Actual owned IPC/restart controller + real gateway/store/service/dispatcher. Synthetic ports only: no Electron/provider/socket. */
class Clock {
  time = 0; sequence = 0; jobs = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  schedule = (callback: () => void, delay: number) => { const id = ++this.sequence; this.jobs.set(id, { at: this.time + delay, callback }); return id }
  cancel = (handle: unknown) => { if (typeof handle === 'number') this.jobs.delete(handle) }
  advance(ms: number) {
    const target = this.time + ms
    while (true) {
      const next = [...this.jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at; this.jobs.delete(next[0]); next[1].callback()
    }
    this.time = target
  }
}
class Ipc {
  listener?: (event: WorkQueueOwnerEvent, input: WorkQueueRequest) => Promise<WorkQueueInvokeResult>
  handle = (channel: string, listener: NonNullable<Ipc['listener']>) => { expect(channel).toBe(WORK_QUEUE_IPC.invoke); expect(this.listener).toBeUndefined(); this.listener = listener }
  removeHandler = (channel: string) => { expect(channel).toBe(WORK_QUEUE_IPC.invoke); this.listener = undefined }
  invoke(input: WorkQueueRequest, destroyed = false) { if (!this.listener) throw new Error('owned IPC is not installed'); return this.listener({ sender: { isDestroyed: () => destroyed } }, input) }
}
class Store extends NextTurnQueueStore {
  listings = 0; failures = 0; gate?: Promise<void>
  override async listScopes(maximum?: number) { this.listings++; await this.gate; if (this.failures > 0) { this.failures--; throw new Error('synthetic temporary listing failure') }; return super.listScopes(maximum) }
}
class RecoverFailureStore extends Store {
  recoverFailures = 0; armed = false
  override async listScopes(maximum?: number) { const scopes = await super.listScopes(maximum); this.armed = true; return scopes }
  override async read(scope: Parameters<Store['read']>[0]) {
    if (this.armed && this.recoverFailures > 0) { this.recoverFailures--; throw new Error('synthetic temporary recovery disk failure') }
    return super.read(scope)
  }
}
const gates: (() => void)[] = []
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); gates.push(() => release()); return { promise, release } }
function environment() {
  let controller = new AbortController()
  const snapshot: EngineSnapshot = { ...engineHost.getSnapshot(), phase: 'ready', mode: 'embedded', baseUrl: 'https://synthetic.invalid', instanceId: 'owned-instance', accountId: 'owned-account' }
  const listeners = new Set<() => void>(), calls = new Map<string, number>(), failures = new Map<string, number>()
  const roots = new Map<string, string>(), namespaces = new Map<string, string>(), receipts = new Map<string, unknown>(), posts: { taskId: string; wire: string }[] = []
  let denyReceipt = false, hook: ((taskId: string, call: number) => Promise<void> | void) | undefined
  const engine: WorkQueueOwnerPorts['engine'] = { snapshot: () => snapshot, signal: () => controller.signal, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const port: QueueEnginePort = {
    snapshot: engine.snapshot, signal: engine.signal, headers: async () => ({ 'X-Aether-Tool-Profile': 'general', 'X-Aether-Run-Lifetime': 'durable' }),
    request: async <T>(input: EngineRequestInput): Promise<EngineRequestResult<T>> => {
      let data: unknown
      if (input.path === '/chat/admission/context') {
        const taskId = input.query?.sessionId
        if (typeof taskId !== 'string') throw new Error('synthetic context requires exact sessionId')
        const count = (calls.get(taskId) ?? 0) + 1; calls.set(taskId, count)
        await hook?.(taskId, count)
        if ((failures.get(taskId) ?? 0) > 0) { failures.set(taskId, failures.get(taskId)! - 1); throw new Error('synthetic temporary context failure') }
        const root = { runId: 'initial-' + taskId, attemptId: 'attempt-' + taskId, version: 1, status: roots.get(taskId) ?? 'running', workspacePaths: [], modelId: 'owned-model' }
        data = { protocolVersion: 1, tenantId: 'owned-tenant', sessionId: taskId, namespace: { id: 'owned-db', generation: namespaces.get(taskId) ?? 'one' }, transport: WORK_QUEUE_TRANSPORT,
          predecessor: { runId: root.runId, attemptId: root.attemptId, version: root.version }, root }
      } else if (input.path === '/models') data = [{ modelId: 'owned-model', isEnabled: true }]
      else if (input.path === '/chat/admission/receipt') {
        const body = input.body as { requestKey: string; namespace: unknown; sessionId: string }
        data = receipts.get(body.requestKey) ?? { protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey }
      } else throw new Error('unexpected synthetic route: ' + input.path)
      return { ok: true, code: 200, message: '', data: data as T }
    },
    fetch: async (_input, options) => {
      const wire = String(options!.body), body = JSON.parse(wire), taskId = body.sessionId
      posts.push({ taskId, wire }); roots.set(taskId, 'running')
      if (!denyReceipt) receipts.set(body.admission.requestKey, { protocolVersion: 1, status: 'accepted',
        receipt: { ...body.admission, sessionId: taskId, rootRunId: 'accepted-' + taskId, turnId: 'turn-' + taskId, userMessageId: 'user-' + taskId, assistantMessageId: 'anchor-' + taskId },
        run: { runId: 'accepted-' + taskId, version: 1, status: 'running', workspacePaths: [], modelId: 'owned-model', sessionId: taskId,
          turnId: 'turn-' + taskId, userMessageId: 'user-' + taskId, assistantMessageId: 'anchor-' + taskId },
        projection: { rootVersion: 1, rootAttemptId: 'accepted-attempt-' + taskId, user: { messageId: 'user-' + taskId, state: 'projected' }, assistant: { anchorMessageId: 'anchor-' + taskId, state: 'unwritten' } } })
      return new Response('', { status: 200 })
    }, remoteBody: async body => { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('synthetic body requires record'); return body as Record<string, unknown> }, allowed: value => value
  }
  const draft: WorkQueueDraft = { draft: { text: 'owned synthetic next turn', revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: 'owned-model' },
    resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } }, thinking: { kind: 'off' }, attachments: [] }
  return { engine, port, snapshot, calls, failures, roots, namespaces, receipts, posts, draft, listeners,
    setHook(value: typeof hook) { hook = value }, setDenyReceipt(value: boolean) { denyReceipt = value },
    change(next: Partial<EngineSnapshot> = {}, replaceSignal = true) { if (replaceSignal) { controller.abort(); controller = new AbortController() }; Object.assign(snapshot, next); for (const listener of listeners) listener() }
  }
}
let fixture: string
const owners: ReturnType<typeof createWorkNextTurnOwner>[] = []
test.beforeEach(async ({}, info) => { fixture = join(process.cwd(), '.e2e-tmp', 'wq4-owner-' + info.testId.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(fixture, { recursive: true }) })
test.afterEach(async () => { for (const release of gates.splice(0)) release(); for (const owner of owners.splice(0)) await owner.close(); const boundary = resolve(process.cwd(), '.e2e-tmp'); if (!resolve(fixture).startsWith(boundary + sep)) throw new Error('fixture boundary'); await fs.rm(fixture, { recursive: true, force: true }) })
function install(env: ReturnType<typeof environment>, store = new Store(fixture)) {
  const clock = new Clock(), ipc = new Ipc(), reports: string[] = [], gateway = new EngineQueueGateway(env.port)
  const owner = createWorkNextTurnOwner({ engine: env.engine, store, gateway, ipc, clock, report: message => reports.push(message) }); owners.push(owner)
  return { owner, clock, ipc, store, reports }
}
const request = (env: ReturnType<typeof environment>, taskId: string, action: WorkQueueRequest['action']): WorkQueueRequest => ({ taskId, expectedEngine: { mode: env.snapshot.mode, baseUrl: env.snapshot.baseUrl,
  instanceId: env.snapshot.instanceId, accountId: env.snapshot.accountId }, action })
async function seed(env: ReturnType<typeof environment>, taskIds = ['unopened-task']) {
  const first = install(env)
  for (const taskId of taskIds) {
    const result = await first.ipc.invoke(request(env, taskId, { kind: 'enqueue', expectedRevision: 0, operationId: 'enqueue-' + taskId, id: 'entry-' + taskId, submission: env.draft }))
    expect(result.ok).toBe(true)
  }
  await expect.poll(() => first.owner.dispatcher.diagnostics().dispatches).toBe(0)
  await first.owner.close(); env.calls.clear()
  return first.store.listScopes()
}
const state = async (store: Store, scope: Awaited<ReturnType<typeof seed>>[number]) => (await store.read(scope)).state

test('actual IPC restart retries first scope-listing failure in the same ready epoch without opening task', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded')
  const store = new Store(fixture); store.failures = 1; const second = install(env, store)
  await expect.poll(() => second.owner.diagnostics().restoration?.attempts).toBe(1)
  expect(second.owner.diagnostics().restoration?.enumerated).toBe(false); expect(env.posts).toHaveLength(0)
  second.clock.advance(1999); expect(store.listings).toBe(1)
  second.clock.advance(1); await expect.poll(() => env.posts.length).toBe(1)
  await expect.poll(async () => (await state(store, scope)).entries[0].phase).toBe('accepted')
  expect(second.owner.diagnostics().restoration?.items[0]?.status).toBe('bound'); expect(store.listings).toBe(2)
  expect(second.owner.diagnostics().requests).toBe(0)
})
test('actual IPC restart retries first context failure and automatically claims and sends an unopened task', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded'); env.failures.set(scope.taskId, 1)
  const second = install(env)
  await expect.poll(() => env.calls.get(scope.taskId)).toBe(1)
  await expect.poll(() => second.owner.diagnostics().restores).toBe(0)
  second.clock.advance(2000)
  await expect.poll(async () => (await state(second.store, scope)).entries[0].phase).toBe('accepted')
  expect(env.posts).toHaveLength(1); expect(env.posts[0].taskId).toBe(scope.taskId); expect(second.owner.diagnostics().requests).toBe(0)
})
test('restoration retries use capped backoff rather than snapshot storms or a tight loop', async () => {
  const env = environment(), [scope] = await seed(env); env.failures.set(scope.taskId, 100)
  const second = install(env)
  await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.attempts).toBe(1)
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    await expect.poll(() => second.owner.diagnostics().restores).toBe(0)
    const before = env.calls.get(scope.taskId)!, row = second.owner.diagnostics().restoration!.items[0]
    expect(row.nextAt - second.clock.time).toBe(delay)
    for (let event = 0; event < 20; event++) env.change({}, false)
    expect(env.calls.get(scope.taskId)).toBe(before)
    second.clock.advance(delay); await expect.poll(() => env.calls.get(scope.taskId)).toBe(before + 1)
  }
})
test('repeated actual binding recovery failures release every capability and later auto-dispatch successfully', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded')
  const store = new RecoverFailureStore(fixture); store.recoverFailures = 3
  const second = install(env, store)
  for (const [index, delay] of [2000, 4000, 8000].entries()) {
    await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.attempts).toBe(index + 1)
    expect(second.owner.dispatcher.diagnostics().capabilities).toBe(0)
    expect(second.owner.dispatcher.diagnostics().bindings).toBe(0)
    second.clock.advance(delay)
  }
  await expect.poll(async () => (await state(store, scope)).entries[0].phase).toBe('accepted')
  expect(second.owner.dispatcher.diagnostics().capabilities).toBe(1); expect(env.posts).toHaveLength(1)
})
test('two bounded restore slots release fairly for later tasks while a failing task waits for backoff', async () => {
  const env = environment(); await seed(env, ['work-A', 'work-B', 'work-C', 'work-D']); env.failures.set('work-A', 100)
  for (const taskId of ['work-B', 'work-C', 'work-D']) env.roots.set(taskId, 'succeeded')
  const held = deferred(); env.setHook(taskId => taskId === 'work-B' ? held.promise : undefined)
  const second = install(env)
  try {
    await expect.poll(() => env.posts.length).toBe(2)
    expect(env.posts.map(row => row.taskId).sort()).toEqual(['work-C', 'work-D']); expect(second.owner.diagnostics().restores).toBeLessThanOrEqual(2)
    expect(env.calls.get('work-A')).toBe(1)
  } finally { held.release() }
  await expect.poll(() => second.owner.diagnostics().restoration?.items.find(item => item.scope.taskId === 'work-B')?.status).toBe('bound')
  await expect.poll(() => second.owner.dispatcher.diagnostics().dispatches).toBe(0)
  // C/D may consume the first poll after B binds; advance actual joined fair rounds instead of assuming one tick.
  for (let round = 0; round < 3 && env.posts.length < 3; round++) {
    second.clock.advance(2000)
    await expect.poll(() => second.owner.dispatcher.diagnostics().dispatches).toBe(0)
  }
  await expect.poll(() => env.posts.length).toBe(3)
})
for (const point of ['listing', 'capture', 'bind'] as const) test('close joins held restoration ' + point + ' and removes owned timer/listener/IPC', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded')
  const held = deferred(), store = new Store(fixture)
  if (point === 'listing') store.gate = held.promise
  else env.setHook((_task, call) => call === (point === 'capture' ? 1 : 2) ? held.promise : undefined)
  const second = install(env, store)
  await expect.poll(() => point === 'listing' ? store.listings : env.calls.get(scope.taskId)).toBe(point === 'bind' ? 2 : 1)
  let ack = false; const close = second.owner.close().then(() => { ack = true })
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(ack).toBe(false); expect(second.ipc.listener).toBeUndefined(); expect(second.clock.jobs.size).toBe(0); expect(env.listeners.size).toBe(0) }
  finally { held.release() }
  await close; expect(ack).toBe(true); expect(env.posts).toHaveLength(0); expect((await state(store, scope)).entries[0].phase).toBe('pending')
})
for (const change of ['account', 'source', 'signal'] as const) test('held restore fails closed on ' + change + ' change and new epoch is independently recovered', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded')
  const held = deferred(); env.setHook((_task, call) => call === 1 ? held.promise : undefined)
  const second = install(env); await expect.poll(() => env.calls.get(scope.taskId)).toBe(1)
  env.change(change === 'account' ? { accountId: 'other-account' } : change === 'source' ? { mode: 'remote', baseUrl: 'https://other.invalid' } : {})
  held.release()
  if (change === 'signal') await expect.poll(() => env.posts.length).toBe(1)
  else {
    await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.status).toBe('blocked')
    second.clock.advance(60000); expect(env.posts).toHaveLength(0); expect(second.reports.some(message => message.includes('另一个引擎或账号'))).toBe(true)
    expect((await state(second.store, scope)).entries[0].phase).toBe('pending')
  }
})
test('permanent namespace mismatch is retained as an explicit read obstacle and never silently rebound', async () => {
  const env = environment(), [scope] = await seed(env); env.namespaces.set(scope.taskId, 'different'); env.roots.set(scope.taskId, 'succeeded')
  const second = install(env); await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.status).toBe('blocked')
  const before = env.calls.get(scope.taskId); second.clock.advance(60000); expect(env.calls.get(scope.taskId)).toBe(before)
  const result = await second.ipc.invoke(request(env, scope.taskId, { kind: 'read' }))
  expect(result.ok).toBe(true); if (result.ok && 'dispatchError' in result.value) expect(result.value.dispatchError).toContain('旧队列保留')
  else throw new Error('retained namespace obstacle must be visible through actual IPC')
  expect(env.posts).toHaveLength(0); expect((await state(second.store, scope)).entries[0].phase).toBe('pending')
})
test('namespace change between restoration capture and dispatcher binding never creates a successful wrong binding', async () => {
  const env = environment(), [scope] = await seed(env); env.roots.set(scope.taskId, 'succeeded')
  env.setHook((_task, call) => { if (call === 2) env.namespaces.set(scope.taskId, 'changed-during-bind') })
  const second = install(env); await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.attempts).toBe(1)
  expect(second.owner.dispatcher.diagnostics().bindings).toBe(0); expect(env.posts).toHaveLength(0)
  second.clock.advance(2000); await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.status).toBe('blocked')
  expect((await state(second.store, scope)).entries[0].phase).toBe('pending')
})
test('restored unknown admission is checked but never blindly resends the frozen message', async () => {
  const env = environment(); env.roots.set('unopened-task', 'succeeded'); env.setDenyReceipt(true)
  const [scope] = await seed(env), before = env.posts[0].wire
  const second = install(env); await expect.poll(() => second.owner.diagnostics().restoration?.items[0]?.status).toBe('bound')
  await expect.poll(() => second.owner.dispatcher.diagnostics().dispatches).toBe(0)
  second.clock.advance(60000); await expect.poll(() => second.owner.dispatcher.diagnostics().dispatches).toBe(0)
  const restored = (await state(second.store, scope)).entries[0]
  expect(restored.phase).toBe('admission-unknown'); if (restored.phase !== 'pending') expect(restored.frozen.wireBody).toBe(before)
  expect(env.posts).toHaveLength(1)
})
test('owned IPC rejects a stale expected engine and destroyed sender before any task capture', async () => {
  const env = environment(), second = install(env), input = request(env, 'fresh', { kind: 'read' }); input.expectedEngine.instanceId = 'stale'
  expect(await second.ipc.invoke(input)).toMatchObject({ ok: false, code: 'AUTHORITY' })
  expect(await second.ipc.invoke(request(env, 'fresh', { kind: 'read' }), true)).toMatchObject({ ok: false, code: 'AUTHORITY' })
  expect(env.calls.size).toBe(0)
})
test('owned IPC close joins a held foreground read and returns typed failure instead of an orphan operation', async () => {
  const env = environment(), held = deferred(); env.setHook(() => held.promise); const second = install(env)
  const result = second.ipc.invoke(request(env, 'fresh', { kind: 'read' })); await expect.poll(() => env.calls.get('fresh')).toBe(1)
  let ack = false; const close = second.owner.close().then(() => { ack = true })
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(ack).toBe(false) } finally { held.release() }
  expect(await result).toMatchObject({ ok: false, code: 'AUTHORITY' }); await close; expect(second.owner.diagnostics().requests).toBe(0)
})

test('actual owned IPC can browse 1000 empty Work tasks and accurately re-open an evicted task within 200 bindings', async () => {
  const env = environment(), second = install(env)
  for (let index = 0; index < 1000; index++) {
    const taskId = 'owned-empty-' + index, result = await second.ipc.invoke(request(env, taskId, { kind: 'read' }))
    expect(result.ok).toBe(true)
    if (result.ok) { expect(result.value.state.scope.taskId).toBe(taskId); expect(result.value.state.entries).toEqual([]) }
  }
  expect(second.owner.dispatcher.diagnostics()).toMatchObject({ bindings: 200, capabilities: 200, evictions: 800, retainedTasks: 0 })
  const result = await second.ipc.invoke(request(env, 'owned-empty-0', { kind: 'read' }))
  expect(result.ok).toBe(true); if (result.ok) expect(result.value.state.scope.taskId).toBe('owned-empty-0')
  expect(env.posts).toHaveLength(0)
})
