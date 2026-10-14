import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createWorkNextTurnOwner, type WorkQueueOwnerEvent, type WorkQueueOwnerPorts } from '../src/main/work-next-turn-owner'
import { EngineQueueGateway, type QueueEnginePort } from '../src/main/next-turn-engine-gateway'
import { NextTurnQueueWorkerFactory } from '../src/main/next-turn-queue-worker-factory'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'
import { engineHost } from '../src/main/engine/host'
import { WORK_QUEUE_TRANSPORT } from '../src/main/next-turn-admission-protocol'
import type { EngineSnapshot, EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import { WORK_QUEUE_IPC, type WorkQueueDraft, type WorkQueueRequest, type WorkQueueInvokeResult } from '../src/shared/work-next-turn-api'

/** Actual IPC controller, gateway, dispatcher, service and native factory/Worker. Synthetic external IPC/transport ports; no Electron/provider/socket. */
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
const gates: (() => void)[] = []
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
let fixture: string, bundleRoot: string, bundle: { path: string; sha256: string }
const stores: NextTurnQueueWorkerFactory[] = []
test.beforeAll(async () => { await fs.mkdir(resolve('.e2e-tmp'), { recursive: true }); bundleRoot = await fs.mkdtemp(resolve('.e2e-tmp/native-owner-bundle-')); const path = join(bundleRoot, 'worker.cjs'); buildSync({ entryPoints: [resolve('src/main/next-turn-queue-sqlite-worker-entry.ts')], outfile: path, bundle: true, platform: 'node', format: 'cjs', target: 'node22' }); bundle = { path, sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') } })
test.afterAll(async () => { if (!resolve(bundleRoot).startsWith(resolve('.e2e-tmp') + sep)) throw new Error('bundle boundary'); await fs.rm(bundleRoot, { recursive: true, force: true }) })
const owners: ReturnType<typeof createWorkNextTurnOwner>[] = []
test.beforeEach(async ({}, info) => { fixture = join(process.cwd(), '.e2e-tmp', 'wq4-owner-' + info.testId.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(fixture, { recursive: true }) })
test.afterEach(async () => { for (const release of gates.splice(0)) release(); for (const owner of owners.splice(0)) await owner.close(); for (const store of stores.splice(0)) await store.close(); const boundary = resolve(process.cwd(), '.e2e-tmp'); if (!resolve(fixture).startsWith(boundary + sep)) throw new Error('fixture boundary'); await fs.rm(fixture, { recursive: true, force: true }) })
function install(env: ReturnType<typeof environment>) {
  const store = new NextTurnQueueWorkerFactory(join(fixture, 'catalogs'), { enabled: true, workerBundle: bundle, captureEpoch: () => ({ generation: env.snapshot.instanceId!, signal: env.engine.signal(), source: { mode: env.snapshot.mode, endpoint: env.snapshot.mode === 'embedded' ? '' : new URL(env.snapshot.baseUrl).href.replace(/\/+$/, ''), accountId: env.snapshot.accountId ?? null } }) }); stores.push(store)
  const clock = new Clock(), ipc = new Ipc(), reports: string[] = [], gateway = new EngineQueueGateway(env.port)
  const owner = createWorkNextTurnOwner({ engine: env.engine, store, gateway, ipc, clock, report: message => reports.push(message) }); owners.push(owner)
  return { owner, clock, ipc, store, reports }
}
const request = (env: ReturnType<typeof environment>, taskId: string, action: WorkQueueRequest['action']): WorkQueueRequest => ({ taskId, expectedEngine: { mode: env.snapshot.mode, baseUrl: env.snapshot.baseUrl,
  instanceId: env.snapshot.instanceId, accountId: env.snapshot.accountId }, action })

test('real native IPC enqueue persists unopened task and restart dispatcher submits exactly once', async () => {
  const env = environment(), first = install(env), taskId = 'native-unopened'
  const enqueued = await first.ipc.invoke(request(env, taskId, { kind: 'enqueue', expectedRevision: 0, operationId: 'original-enqueue', id: 'original-entry', submission: env.draft }))
  expect(enqueued).toMatchObject({ ok: true }); expect(env.posts).toHaveLength(0)
  await first.owner.close(); expect(first.store.diagnostics()).toMatchObject({ owners: 0, retiring: 0, operations: 0 })
  env.roots.set(taskId, 'succeeded')
  const second = install(env)
  await expect.poll(() => env.posts.length).toBe(1)
  const read = await second.ipc.invoke(request(env, taskId, { kind: 'read' }))
  expect(read).toMatchObject({ ok: true, value: { state: { entries: [{ phase: 'accepted' }] } } })
  const body = JSON.parse(env.posts[0].wire); expect(body.message).toContain('owned synthetic next turn'); expect(body.sessionId).toBe(taskId)
  second.clock.advance(10000); await expect.poll(() => second.owner.dispatcher.diagnostics().dispatches).toBe(0); expect(env.posts).toHaveLength(1)
  await second.owner.close(); expect(second.store.diagnostics()).toMatchObject({ owners: 0, retiring: 0, operations: 0, retainedStopFailures: [] })
})
test('native IPC pending edit and pause survive restart until a real resume enables dispatch', async () => {
  const env = environment(), first = install(env), taskId = 'native-edit'
  expect(await first.ipc.invoke(request(env, taskId, { kind: 'enqueue', expectedRevision: 0, operationId: 'enqueue', id: 'entry', submission: env.draft }))).toMatchObject({ ok: true })
  const edited = await first.ipc.invoke(request(env, taskId, { kind: 'edit-draft', expectedRevision: 1, operationId: 'edit', id: 'entry', entryRevision: 1, draft: { text: 'edited native message', revision: 2, mentions: [] } }))
  expect(edited).toMatchObject({ ok: true })
  expect(await first.ipc.invoke(request(env, taskId, { kind: 'mutate', expectedRevision: 2, operationId: 'pause', operation: { kind: 'pause', reason: 'paused intentionally' } }))).toMatchObject({ ok: true })
  await first.owner.close(); env.roots.set(taskId, 'succeeded')
  const second = install(env)
  const read = await second.ipc.invoke(request(env, taskId, { kind: 'read' }))
  expect(read).toMatchObject({ ok: true, value: { state: { revision: 3, paused: true } } }); expect(env.posts).toHaveLength(0)
  expect(await second.ipc.invoke(request(env, taskId, { kind: 'mutate', expectedRevision: 3, operationId: 'resume', operation: { kind: 'resume' } }))).toMatchObject({ ok: true })
  await expect.poll(() => env.posts.length).toBe(1); expect(JSON.parse(env.posts[0].wire).message).toContain('edited native message')
})
test('five native IPC tasks restore independently and keep unique admission keys', async () => {
  const env = environment(), first = install(env)
  for (let index = 0; index < 5; index++) expect(await first.ipc.invoke(request(env, 'parallel-' + index, { kind: 'enqueue', expectedRevision: 0, operationId: 'enqueue-' + index, id: 'entry-' + index, submission: { ...env.draft, draft: { text: 'task-' + index, revision: 1, mentions: [] } } }))).toMatchObject({ ok: true })
  await first.owner.close(); for (let index = 0; index < 5; index++) env.roots.set('parallel-' + index, 'succeeded')
  const second = install(env)
  await expect.poll(() => { second.clock.advance(2000); return env.posts.length }).toBe(5)
  expect(new Set(env.posts.map(post => post.taskId)).size).toBe(5)
  expect(new Set(env.posts.map(post => JSON.parse(post.wire).admission.requestKey)).size).toBe(5)
  for (let index = 0; index < 5; index++) expect(await second.ipc.invoke(request(env, 'parallel-' + index, { kind: 'read' }))).toMatchObject({ ok: true, value: { state: { entries: [{ phase: 'accepted' }] } } })
})
test('source change retains old native pending scope and cannot dispatch it under a different account', async () => {
  const env = environment(), first = install(env), taskId = 'owned-old-account'
  expect(await first.ipc.invoke(request(env, taskId, { kind: 'enqueue', expectedRevision: 0, operationId: 'old-enqueue', id: 'old-entry', submission: env.draft }))).toMatchObject({ ok: true })
  await expect.poll(() => first.owner.diagnostics().restores).toBe(0)
  env.change({ instanceId: 'replacement-instance', accountId: 'other-account' }); env.roots.set(taskId, 'succeeded')
  await expect.poll(() => first.owner.diagnostics().restoration?.items.some(item => item.status === 'blocked')).toBe(true)
  expect(env.posts).toHaveLength(0)
  expect(await first.ipc.invoke({ taskId, expectedEngine: { mode: 'embedded', baseUrl: env.snapshot.baseUrl, instanceId: 'owned-instance', accountId: 'owned-account' }, action: { kind: 'read' } })).toMatchObject({ ok: false, code: 'AUTHORITY' })
  expect((await first.store.listScopes()).some(scope => scope.source.accountId === 'owned-account' && scope.taskId === taskId)).toBe(true)
})
test('native owned IPC refuses destroyed sender and removes handler only after joined close', async () => {
  const env = environment(), current = install(env)
  expect(await current.ipc.invoke(request(env, 'destroyed', { kind: 'read' }), true)).toMatchObject({ ok: false, code: 'AUTHORITY' })
  await current.owner.close(); expect(current.ipc.listener).toBeUndefined(); expect(current.store.diagnostics()).toMatchObject({ owners: 0, operations: 0, retiring: 0 })
})
