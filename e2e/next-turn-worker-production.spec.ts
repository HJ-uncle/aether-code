import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { join, relative, resolve, sep } from 'node:path'
import { buildSync } from 'esbuild'
import { NextTurnQueueSqliteWorker, QueueWorkerCommitUnknownError, type QueueSqliteWorkerOptions } from '../src/main/next-turn-queue-sqlite-worker'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { QUEUE_WORKER_RPC_LIMITS, type QueueWorkerPhase, type QueueWorkerBody, type QueueWorkerOutput, type QueueWorkerStart } from '../src/main/next-turn-queue-worker-protocol'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, type NextTurnQueueScope } from '../src/shared/next-turn-queue'

/** Actual native worker RPC/SQLite tests. No Electron packaging, migration,
 * provider, listener or production backend selection is claimed. */
const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'worker-owned' }, tenantId: 'worker-owned', namespace: { id: 'worker-owned', generation: 'one' }, owner: 'work', taskId: 'worker-owned' }
const identity = { source: scope.source, tenantId: scope.tenantId, namespace: scope.namespace, owner: scope.owner }
let bundleRoot: string, bundle: { path: string; sha256: string }, fixture: string, file: string
const owners: Array<{ owner: NextTurnQueueSqliteWorker; abnormal: boolean }> = []
const rawOwners: Array<{ worker: Worker; instanceId: string; exit: Promise<number> }> = []
function raw(holdAt?: QueueWorkerPhase, options: Pick<QueueWorkerStart, 'rpcLimits' | 'requireExisting'> = { requireExisting: false }) {
  const epoch = new Int32Array(new SharedArrayBuffer(8)); Atomics.store(epoch, 0, 1)
  const instanceId = randomUUID(), data: QueueWorkerStart = { instanceId, file, identity, limits: { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS }, epoch: epoch.buffer as SharedArrayBuffer, holdAt, ...options }
  const worker = new Worker(bundle.path, { workerData: data }), messages: QueueWorkerOutput[] = []
  const waiting: Array<{ kind: QueueWorkerOutput['kind']; id?: string; resolve: (message: QueueWorkerOutput) => void; timer: ReturnType<typeof setTimeout> }> = []
  const exit = new Promise<number>(done => worker.once('exit', done)); worker.on('error', () => {})
  rawOwners.push({ worker, instanceId, exit })
  worker.on('message', (message: QueueWorkerOutput) => {
    // Deliberately permissive main answers prove the worker's own fence remains effective.
    if (message.kind === 'authority') { worker.postMessage({ kind: 'authorize', instanceId, id: message.id, step: message.step, ok: true, message: '' }); return }
    const index = waiting.findIndex(item => item.kind === message.kind && (item.id === undefined || 'id' in message && message.id === item.id))
    if (index < 0) messages.push(message)
    else { const item = waiting.splice(index, 1)[0]; clearTimeout(item.timer); item.resolve(message) }
  })
  const wait = (kind: QueueWorkerOutput['kind'], id?: string) => {
    const index = messages.findIndex(message => message.kind === kind && (id === undefined || 'id' in message && message.id === id))
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
    return new Promise<QueueWorkerOutput>((done, reject) => { const item = { kind, id, resolve: done, timer: setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('Raw worker signal deadline')) }, 5000) }; waiting.push(item) })
  }
  return { worker, instanceId, epoch, wait, send: (body: QueueWorkerBody) => { const id = randomUUID(); worker.postMessage({ kind: 'request', instanceId, id, epoch: 1, body }); return id }, release: () => worker.postMessage({ kind: 'release-test', instanceId }) }
}
function create(options: Partial<QueueSqliteWorkerOptions> = {}) {
  const owner = new NextTurnQueueSqliteWorker(file, { nativeExperimentOnly: true, workerBundle: bundle, identity, generation: 'trusted-one', assertGeneration: () => {}, ...options })
  owners.push({ owner, abnormal: false }); return owner
}
function barrier(phase: QueueWorkerPhase) {
  let signal!: () => void
  const reached = new Promise<void>(done => { signal = done })
  return { reached, test: { holdAt: phase, onBarrier: () => signal() } }
}
async function cleanup(directory: string) {
  const actual = await fs.realpath(directory), boundary = resolve('.e2e-tmp'), relation = relative(boundary, actual)
  if (!relation || relation === '..' || relation.startsWith('..' + sep)) throw new Error('Worker fixture cleanup left owned boundary')
  await fs.rm(actual, { recursive: true, force: true })
}
test.beforeAll(async () => {
  await fs.mkdir(resolve('.e2e-tmp'), { recursive: true }); bundleRoot = await fs.mkdtemp(resolve('.e2e-tmp/queue-worker-bundle-'))
  const path = join(bundleRoot, 'queue-worker.cjs')
  buildSync({ entryPoints: [resolve('src/main/next-turn-queue-sqlite-worker-entry.ts')], outfile: path, bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false })
  bundle = { path, sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') }
})
test.afterAll(async () => { await cleanup(bundleRoot) })
test.beforeEach(async () => { fixture = await fs.mkdtemp(resolve('.e2e-tmp/queue-worker-owned-')); file = join(fixture, 'queue.sqlite') })
test.afterEach(async () => {
  for (const { owner, abnormal } of owners.splice(0)) {
    if (abnormal) await expect(owner.close()).rejects.toMatchObject({ code: 'IO' })
    else { await owner.close(); expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true }) }
    await owner.waitForExit()
  }
  for (const { worker, instanceId, exit } of rawOwners.splice(0)) { worker.postMessage({ kind: 'close', instanceId }); expect(await exit).toBe(0) }
  await cleanup(fixture)
})


test('release after main grant wins native commit CAS and joins a real rollback', async () => {
  const held = barrier('after-commit-grant'), owner = create({ requireCapabilityFence: true, test: held.test })
  const service = new NextTurnQueueMutationService(owner, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} })
  const capability = await service.bind(scope.taskId), mutation = service.mutate(capability, 0, 'release-first', { kind: 'pause', reason: 'must rollback' })
  const rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await held.reached
  let joined = false; const release = service.release(capability).then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false)
  owner.releaseTestBarrier(); await rejected; await release
  expect((await owner.read(scope)).state.revision).toBe(0)
  expect(await owner.queryExact(scope, 0, 'release-first', { kind: 'pause', reason: 'must rollback' })).toEqual({ status: 'absent' })
  expect(service.diagnostics()).toMatchObject({ bindings: 0, ownedOperations: 0, pendingMutationBytes: 0 })
  await service.close()
})
test('COMMIT authorization that wins release remains exact and release ACK waits for its outcome', async () => {
  const held = barrier('commit-acquired'), owner = create({ requireCapabilityFence: true, test: held.test })
  const service = new NextTurnQueueMutationService(owner, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} })
  const capability = await service.bind(scope.taskId), mutation = service.mutate(capability, 0, 'commit-first', { kind: 'pause', reason: 'linearized commit' })
  const rejected = expect(mutation).rejects.toBeInstanceOf(QueueWorkerCommitUnknownError)
  await held.reached
  let joined = false; const release = service.release(capability).then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false)
  owner.releaseTestBarrier(); await rejected; await release
  const exact = await owner.queryExact(scope, 0, 'commit-first', { kind: 'pause', reason: 'linearized commit' })
  expect(exact.status).toBe('committed')
  if (exact.status === 'committed') { expect(exact.state.revision).toBe(1); expect(exact.receipt.operationId).toBe('commit-first') }
  expect(service.diagnostics()).toMatchObject({ bindings: 0, ownedOperations: 0 })
  await expect(service.mutate(capability, 1, 'late', { kind: 'resume' })).rejects.toMatchObject({ code: 'AUTHORITY' })
  await service.close()
})
test('one released capability cannot revoke an independent capability on the same real native owner', async () => {
  let barriers = 0
  const owner = create({ requireCapabilityFence: true, test: { holdAt: 'after-commit-grant', onBarrier: () => { barriers++ } } })
  const service = new NextTurnQueueMutationService(owner, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} })
  const a = await service.bind('a'), b = await service.bind('b')
  const mutation = service.mutate(a, 0, 'a', { kind: 'pause', reason: 'a' }), rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await expect.poll(() => barriers).toBe(1); const released = service.release(a); owner.releaseTestBarrier(); await rejected; await released
  const second = service.mutate(b, 0, 'b', { kind: 'pause', reason: 'b' })
  await expect.poll(() => barriers).toBe(2)
  owner.releaseTestBarrier()
  expect((await second).state.revision).toBe(1)
  expect((await owner.read({ ...scope, taskId: 'a' })).state.revision).toBe(0)
  expect((await owner.read({ ...scope, taskId: 'b' })).state.revision).toBe(1)
  await service.release(b); await service.close()
})
test('production worker rejects mutation without an owned capability fence before database publication', async () => {
  const owner = create({ requireCapabilityFence: true })
  await expect(owner.mutate(scope, 0, 'no-capability', { kind: 'pause', reason: 'not owned' }, () => {})).rejects.toMatchObject({ code: 'AUTHORITY' })
  expect((await owner.read(scope)).state.revision).toBe(0)
})
test('capability commit slot is reusable for repeated mutations and an exact replay', async () => {
  const owner = create({ requireCapabilityFence: true }), service = new NextTurnQueueMutationService(owner, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} })
  const capability = await service.bind(scope.taskId)
  const first = await service.mutate(capability, 0, 'first', { kind: 'pause', reason: 'first' })
  await service.mutate(capability, 1, 'second', { kind: 'resume' })
  const replay = await service.mutate(capability, 0, 'first', { kind: 'pause', reason: 'first' })
  expect(replay.receipt).toEqual(first.receipt); expect(replay.replayed).toBe(true)
  expect((await owner.read(scope)).state.revision).toBe(2)
  await service.release(capability); await service.close()
})
test('native verified-scope LRU stays bounded while old original receipts remain verifiable', async () => {
  const owner = create({ maxVerifiedScopes: 2 })
  for (let index = 0; index < 7; index++) await owner.mutate({ ...scope, taskId: 'task-' + index }, 0, 'operation-' + index, { kind: 'pause', reason: 'bounded cache' }, () => {})
  const diagnostics = await owner.nativeDiagnostics({ ...scope, taskId: 'task-6' })
  expect(diagnostics).toMatchObject({ verifiedScopes: 2, maxVerifiedScopes: 2 })
  expect((await owner.findReceipt({ ...scope, taskId: 'task-0' }, 'operation-0'))?.revision).toBe(1)
  expect(await owner.nativeDiagnostics({ ...scope, taskId: 'task-0' })).toMatchObject({ verifiedScopes: 2 })
})
test('actual worker bounds malformed-request diagnostic and remains available for owned close', async () => {
  const direct = raw(undefined, { requireExisting: false, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, maxFrameBytes: 2048 } })
  await direct.wait('ready')
  direct.worker.postMessage({ kind: 'request', instanceId: direct.instanceId, id: 'x'.repeat(256), epoch: 1, body: { method: 'read', scope } })
  const failure = await direct.wait('fatal')
  expect(failure.kind).toBe('fatal'); expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThanOrEqual(2048)
  const id = direct.send({ method: 'read', scope }), result = await direct.wait('result', id)
  expect(result).toMatchObject({ ok: true, value: { state: { revision: 0 } } })
})
