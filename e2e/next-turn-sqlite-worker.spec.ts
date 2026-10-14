import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { join, relative, resolve, sep } from 'node:path'
import { buildSync } from 'esbuild'
import { NextTurnQueueSqliteWorker, QueueWorkerCommitUnknownError, type QueueSqliteWorkerOptions } from '../src/main/next-turn-queue-sqlite-worker'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { QUEUE_WORKER_RPC_LIMITS, type QueueWorkerPhase, type QueueWorkerBody, type QueueWorkerOutput, type QueueWorkerStart } from '../src/main/next-turn-queue-worker-protocol'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, NextTurnQueueError, type NextTurnQueueMutation, type NextTurnQueueScope } from '../src/shared/next-turn-queue'
import { assertQueueJsonValue } from '../src/shared/next-turn-queue-state'

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
  return { worker, epoch, wait, send: (body: QueueWorkerBody) => { const id = randomUUID(); worker.postMessage({ kind: 'request', instanceId, id, epoch: 1, body }); return id }, release: () => worker.postMessage({ kind: 'release-test', instanceId }) }
}
function create(options: Partial<QueueSqliteWorkerOptions> = {}) {
  const owner = new NextTurnQueueSqliteWorker(file, { nativeExperimentOnly: true, workerBundle: bundle, identity, generation: 'trusted-one', assertGeneration: () => {}, ...options })
  owners.push({ owner, abnormal: false }); return owner
}
function expectAbnormal(owner: NextTurnQueueSqliteWorker) { owners.find(item => item.owner === owner)!.abnormal = true }
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

test('actual native worker supports storage service, exact original ACK and joined stop', async () => {
  const owner = create(), service = new NextTurnQueueMutationService(owner, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} }), capability = await service.bind(scope.taskId)
  const first = await service.mutate(capability, 0, 'first', { kind: 'pause', reason: 'synthetic first' })
  await service.mutate(capability, 1, 'second', { kind: 'resume' })
  expect(await owner.queryExact(scope, 0, 'first', { kind: 'pause', reason: 'synthetic first' })).toEqual({ status: 'committed', state: first.state, receipt: first.receipt })
  expect(await service.findReceipt(capability, 'first')).toEqual(first.receipt)
  await service.close(); await owner.close()
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true })
  await expect(owner.read(scope)).rejects.toMatchObject({ code: 'AUTHORITY' })
  const recovered = create({ requireExisting: true }); expect((await recovered.read(scope)).state.revision).toBe(2)
  expect(await recovered.queryExact(scope, 0, 'first', { kind: 'pause', reason: 'synthetic first' })).toEqual({ status: 'committed', state: first.state, receipt: first.receipt })
})

test('real native worker load keeps caller event loop responsive instead of executing SQLite on caller', async () => {
  test.setTimeout(60000)
  const owner = create(); await owner.read(scope)
  let ticks = 0, previous = performance.now(), maximumGap = 0
  const timer = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now; ticks++ }, 10)
  const started = performance.now()
  try { for (let revision = 0; revision < 300; revision++) await owner.mutate(scope, revision, 'load-' + revision, { kind: 'pause', reason: 'synthetic continuous load' }, () => {}) } finally { clearInterval(timer) }
  const elapsedMs = performance.now() - started
  expect((await owner.read(scope)).state.revision).toBe(300); expect(ticks).toBeGreaterThan(20); expect(maximumGap).toBeLessThan(500)
  expect(await owner.nativeDiagnostics(scope)).toMatchObject({ revision: 300, packagedRuntimeVerified: false })
  console.log(JSON.stringify({ kind: 'owned-real-worker-load', packaged: false, revisions: 300, elapsedMs, ticks, maximumGap }))
})

test('bounded RPC count rejects additional work while real transaction and queued reads are held', async () => {
  const held = barrier('before-transaction'), owner = create({ test: held.test, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, maxRequests: 3 } })
  const mutation = owner.mutate(scope, 0, 'held', { kind: 'pause', reason: 'held' }, () => {}); await held.reached
  const a = owner.read(scope), b = owner.read(scope)
  const excess = owner.read(scope); void excess.catch(() => {})
  expect(owner.statistics().pendingRequests).toBe(3); await expect(excess).rejects.toMatchObject({ code: 'CAPACITY' })
  owner.releaseTestBarrier(); await mutation; expect((await a).state.revision).toBe(1); expect((await b).state.revision).toBe(1)
  expect(owner.statistics().pendingRequests).toBe(0)
})

test('pending request byte budget is independent of request count and joins to zero', async () => {
  const held = barrier('before-transaction'), owner = create({ test: held.test, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, maxRequestBytes: 1500 } })
  const mutation = owner.mutate(scope, 0, 'large-held', { kind: 'pause', reason: 'a'.repeat(800) }, () => {}); await held.reached
  const excess = owner.mutate(scope, 1, 'large-second', { kind: 'pause', reason: 'b'.repeat(800) }, () => {}); void excess.catch(() => {})
  expect(owner.statistics().pendingBytes).toBeLessThanOrEqual(1500); await expect(excess).rejects.toMatchObject({ code: 'CAPACITY' }); owner.releaseTestBarrier(); await mutation
  expect(owner.statistics().pendingBytes).toBe(0)
})

test('worker source namespace fence rejects another scope before any request or database write', async () => {
  const owner = create(); await owner.read(scope)
  await expect(owner.mutate({ ...scope, namespace: { ...scope.namespace, generation: 'other' } }, 0, 'wrong', { kind: 'pause', reason: 'wrong' }, () => {})).rejects.toMatchObject({ code: 'SCOPE' })
  expect((await owner.read(scope)).state.revision).toBe(0); expect(owner.statistics().pendingRequests).toBe(0)
})

test('shared source epoch revocation fences held before-commit native transaction and retains exact absence', async () => {
  const held = barrier('before-commit'), owner = create({ test: held.test })
  const mutation = owner.mutate(scope, 0, 'revoked', { kind: 'pause', reason: 'must rollback' }, () => {}), rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await held.reached; owner.revoke(); owner.releaseTestBarrier(); await rejected; expect(await owner.waitForExit()).toBe(0); await owner.close()
  const recovered = create({ requireExisting: true }); expect((await recovered.read(scope)).state.revision).toBe(0)
  expect(await recovered.queryExact(scope, 0, 'revoked', { kind: 'pause', reason: 'must rollback' })).toEqual({ status: 'absent' })
})

test('main capability authority is rechecked after held worker transaction before COMMIT', async () => {
  const held = barrier('before-commit'), owner = create({ test: held.test }); let authorized = true
  const mutation = owner.mutate(scope, 0, 'capability', { kind: 'pause', reason: 'held' }, () => { if (!authorized) throw new NextTurnQueueError('AUTHORITY', 'Released capability') }), rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await held.reached; authorized = false; owner.releaseTestBarrier(); await rejected
  expect((await owner.read(scope)).state.revision).toBe(0); expect(await owner.queryExact(scope, 0, 'capability', { kind: 'pause', reason: 'held' })).toEqual({ status: 'absent' })
})

test('caller mutation after first await cannot change a frozen queued operation or exact query identity', async () => {
  const held = barrier('before-transaction'), owner = create({ test: held.test }), mutation: NextTurnQueueMutation = { kind: 'pause', reason: 'original' }
  const commit = owner.mutate(scope, 0, 'freeze', mutation, () => {}); await held.reached; mutation.reason = 'changed'; owner.releaseTestBarrier()
  const result = await commit; expect(result.state.pauseReason).toBe('original')
  expect(await owner.queryExact(scope, 0, 'freeze', { kind: 'pause', reason: 'original' })).toMatchObject({ status: 'committed', receipt: result.receipt })
  await expect(owner.queryExact(scope, 0, 'freeze', mutation)).rejects.toMatchObject({ code: 'CONFLICT' })
})

for (const phase of ['before-commit','after-commit'] as const) {
  test('actual worker terminate at ' + phase + ' preserves unknown ACK and exact durable query on fresh owner', async () => {
    const initial = create(); await initial.read(scope); await initial.close()
    const held = barrier(phase), owner = create({ requireExisting: true, test: held.test }), operation: NextTurnQueueMutation = { kind: 'pause', reason: 'synthetic crash' }
    const commit = owner.mutate(scope, 0, 'crash', operation, () => {}), rejected = expect(commit).rejects.toBeInstanceOf(QueueWorkerCommitUnknownError)
    await held.reached; expectAbnormal(owner); await owner.terminateForTest(); await rejected
    const recovered = create({ requireExisting: true }), exact = await recovered.queryExact(scope, 0, 'crash', operation)
    if (phase === 'after-commit') { expect(exact).toMatchObject({ status: 'committed', state: { revision: 1, pauseReason: 'synthetic crash' }, receipt: { operationId: 'crash', revision: 1 } }); await expect(recovered.queryExact(scope, 0, 'crash', { kind: 'pause', reason: 'changed' })).rejects.toMatchObject({ code: 'CONFLICT' }) }
    else expect(exact).toEqual({ status: 'absent' })
    expect((await recovered.read(scope)).state.revision).toBe(phase === 'after-commit' ? 1 : 0)
  })
}

test('RPC ACK deadline fences owner and joins close without automatically resending a committed operation', async () => {
  const held = barrier('after-commit'), owner = create({ test: held.test, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, deadlineMs: 1000 } }), operation: NextTurnQueueMutation = { kind: 'pause', reason: 'deadline' }
  const commit = owner.mutate(scope, 0, 'deadline', operation, () => {}), rejected = expect(commit).rejects.toBeInstanceOf(QueueWorkerCommitUnknownError)
  await held.reached; await rejected; await owner.close()
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true })
  const recovered = create({ requireExisting: true }); expect(await recovered.queryExact(scope, 0, 'deadline', operation)).toMatchObject({ status: 'committed', receipt: { revision: 1, operationId: 'deadline' } })
  expect((await recovered.read(scope)).state.revision).toBe(1)
})

test('close cancels held precommit and queued work then waits for native close ACK and worker exit', async () => {
  const held = barrier('before-commit'), owner = create({ test: held.test })
  const commit = owner.mutate(scope, 0, 'close-held', { kind: 'pause', reason: 'held' }, () => {}), rejected = expect(commit).rejects.toMatchObject({ code: 'AUTHORITY' })
  await held.reached; const read = owner.read(scope), readRejected = expect(read).rejects.toMatchObject({ code: 'AUTHORITY' })
  await owner.close(); await rejected; await readRejected
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true })
  const recovered = create({ requireExisting: true }); expect((await recovered.read(scope)).state.revision).toBe(0)
})

test('two actual native workers arbitrate one expected revision without duplicate commit', async () => {
  const initial = create(); await initial.read(scope); await initial.close()
  const a = create({ requireExisting: true }), b = create({ requireExisting: true }); await Promise.all([a.read(scope), b.read(scope)])
  const results = await Promise.allSettled([a.mutate(scope, 0, 'a', { kind: 'pause', reason: 'a' }, () => {}), b.mutate(scope, 0, 'b', { kind: 'pause', reason: 'b' }, () => {})])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const loser = results.find(result => result.status === 'rejected'); expect(loser?.status === 'rejected' && loser.reason.code).toBe('CAS')
  expect((await a.read(scope)).state.revision).toBe(1); expect((await b.read(scope)).state.revision).toBe(1)
})

test('missing acknowledged database fails recovery instead of creating an empty absent result', async () => {
  const initial = create(); await initial.mutate(scope, 0, 'acknowledged', { kind: 'pause', reason: 'retained' }, () => {}); await initial.close()
  await fs.unlink(file)
  const recovered = create({ requireExisting: true }); expectAbnormal(recovered)
  await expect(recovered.queryExact(scope, 0, 'acknowledged', { kind: 'pause', reason: 'retained' })).rejects.toMatchObject({ code: 'IO' })
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('close before worker startup joins without opening a lasting native owner', async () => {
  const owner = create(); await owner.close()
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true })
})

test('untrusted modified worker bundle is rejected before spawn', async () => {
  expect(() => create({ workerBundle: { ...bundle, sha256: '0'.repeat(64) } })).toThrow(/trusted build/)
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('exact unknown ACK query rejects invalid selector rather than reporting an absent commitment', async () => {
  const owner = create(); await owner.read(scope)
  await expect(owner.queryExact(scope, -1, 'invalid', { kind: 'pause', reason: 'synthetic' })).rejects.toMatchObject({ code: 'INVALID' })
  await expect(owner.queryExact(scope, 0, '__reserved', { kind: 'pause', reason: 'synthetic' })).rejects.toMatchObject({ code: 'INVALID' })
  expect((await owner.read(scope)).state.revision).toBe(0)
})

test('queued mutation is frozen synchronously while actual worker startup has not answered', async () => {
  const owner = create(), operation: NextTurnQueueMutation = { kind: 'pause', reason: 'original startup draft' }
  const commit = owner.mutate(scope, 0, 'startup-frozen', operation, () => {}); operation.reason = 'changed caller draft'
  expect((await commit).state.pauseReason).toBe('original startup draft')
  expect(await owner.queryExact(scope, 0, 'startup-frozen', { kind: 'pause', reason: 'original startup draft' })).toMatchObject({ status: 'committed' })
})

test('native worker independently rejects wrong namespace despite permissive main RPC answers', async () => {
  // A permissive mutant must produce an actual committed response. Holding its
  // COMMIT would merely turn a missing fence into a harness signal timeout.
  const native = raw(); await native.wait('ready')
  const id = native.send({ method: 'mutate', scope: { ...scope, namespace: { ...scope.namespace, generation: 'wrong' } }, expectedRevision: 0, operationId: 'wrong', operation: { kind: 'pause', reason: 'wrong' } })
  expect(await native.wait('result', id)).toMatchObject({ ok: false, code: 'SCOPE', commitMayExist: false })
})

test('native shared epoch fence is independent of permissive main authorization before COMMIT', async () => {
  const native = raw('before-commit'); await native.wait('ready')
  const id = native.send({ method: 'mutate', scope, expectedRevision: 0, operationId: 'raw-revoked', operation: { kind: 'pause', reason: 'revoked' } }); await native.wait('test-barrier', id)
  Atomics.store(native.epoch, 0, 2); native.release()
  expect(await native.wait('result', id)).toMatchObject({ ok: false, code: 'AUTHORITY', commitMayExist: false })
})

test('native request budget independently rejects flood while a transaction holds the serial queue', async () => {
  const native = raw('before-transaction'); await native.wait('ready')
  const held = native.send({ method: 'mutate', scope, expectedRevision: 0, operationId: 'raw-held', operation: { kind: 'pause', reason: 'held' } }); await native.wait('test-barrier', held)
  let excess = ''
  for (let index = 0; index < 32; index++) excess = native.send({ method: 'read', scope })
  // Requests and release are ordered on this same port. Both guarded rejection
  // and a permissive mutant's queued read now answer, so the assertion measures
  // the capacity boundary rather than a waiting helper's deadline.
  const result = native.wait('result', excess); native.release()
  expect(await native.wait('result', held)).toMatchObject({ ok: true })
  expect(await result).toMatchObject({ ok: false, code: 'CAPACITY', commitMayExist: false })
})

test('independent startup deadline fences an unused unresponsive worker and does not invent a native close ACK', async () => {
  const held = barrier('before-transaction'), owner = create({ deadlines: { startupMs: 300, stopMs: 200 }, test: { hangAt: 'startup', onBarrier: held.test.onBarrier } }); expectAbnormal(owner)
  await held.reached
  await expect.poll(() => owner.statistics().stopDeadlineExceeded, { timeout: 3000 }).toBe(true)
  expect(await owner.waitForExit()).toBe(1)
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, closing: true, nativeCloseAcknowledged: false })
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('startup timeout of an unsent mutation is a visible startup failure without a fabricated committed outcome', async () => {
  const held = barrier('before-transaction'), owner = create({ deadlines: { startupMs: 300, stopMs: 200 }, test: { hangAt: 'startup', onBarrier: held.test.onBarrier } }); expectAbnormal(owner)
  const outcome = owner.mutate(scope, 0, 'unsent', { kind: 'pause', reason: 'startup' }, () => {}).catch(error => error)
  await held.reached; const error = await outcome
  expect(error).toBeInstanceOf(NextTurnQueueError); expect(error.code).toBe('IO'); expect(error).not.toBeInstanceOf(QueueWorkerCommitUnknownError)
  expect(await owner.waitForExit()).toBe(1)
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('bounded close deadline reports unconfirmed stop and actual owned termination while durable ACK remains queryable', async () => {
  const held = barrier('after-commit'), owner = create({ deadlines: { startupMs: 5000, stopMs: 200 }, test: { hangAt: 'close', onBarrier: held.test.onBarrier } }); expectAbnormal(owner)
  const first = await owner.mutate(scope, 0, 'before-stop', { kind: 'pause', reason: 'durable' }, () => {})
  const stopping = owner.close(); void stopping.catch(() => {}); await held.reached
  await expect(stopping).rejects.toMatchObject({ code: 'IO' }); expect(await owner.waitForExit()).toBe(1)
  expect(owner.statistics()).toMatchObject({ stopDeadlineExceeded: true, nativeCloseAcknowledged: false, pendingRequests: 0 })
  const recovered = create({ requireExisting: true })
  expect(await recovered.queryExact(scope, 0, 'before-stop', { kind: 'pause', reason: 'durable' })).toEqual({ status: 'committed', state: first.state, receipt: first.receipt })
})

test('worker response budget reports committed mutation as unknown ACK and recovers original receipt without resubmitting', async () => {
  const operation: NextTurnQueueMutation = { kind: 'pause', reason: 'first' }, initial = create()
  const first = await initial.mutate(scope, 0, 'response-first', operation, () => {}); await initial.close()
  const maxFrameBytes = Buffer.byteLength(JSON.stringify(first)) + 64, owner = create({ requireExisting: true, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, maxFrameBytes } })
  // The same-size state/receipt payload fits, but its RPC envelope does not.
  // This is an ACK delivery failure after COMMIT, not an absent mutation.
  const error = await owner.mutate(scope, 1, 'response-next!', operation, () => {}).catch(failure => failure)
  expect(error).toBeInstanceOf(QueueWorkerCommitUnknownError)
  expect(error).toMatchObject({ commitMayExist: true, exactQuery: { method: 'queryExact', scope, expectedRevision: 1, operationId: 'response-next!', operation } })
  const receipt = await owner.findReceipt(scope, 'response-next!'); expect(receipt).toMatchObject({ revision: 2, operationId: 'response-next!' })
  expect(owner.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0 })
  await owner.close()
  const recovered = create({ requireExisting: true })
  const outcome = await recovered.queryExact(scope, 1, 'response-next!', operation)
  expect(outcome).toMatchObject({ status: 'committed', state: { revision: 2, paused: true, pauseReason: 'first' }, receipt })
  if (outcome.status !== 'committed') throw new Error('Original committed operation missing')
  expect(() => assertQueueJsonValue({ state: outcome.state, receipt: outcome.receipt, replayed: false, durabilityWarnings: [] }, maxFrameBytes)).not.toThrow()
  expect((await recovered.read(scope)).state.revision).toBe(2)
})

test('native response frame budget independently rejects committed envelope despite permissive main authorization', async () => {
  const operation: NextTurnQueueMutation = { kind: 'pause', reason: 'first' }, initial = create()
  const first = await initial.mutate(scope, 0, 'response-first', operation, () => {}); await initial.close()
  // The validator conservatively counts delimiters; explicit headroom ensures
  // rejection is caused by RPC metadata, not payload-only accounting.
  const maxFrameBytes = Buffer.byteLength(JSON.stringify(first)) + 64
  const native = raw(undefined, { requireExisting: true, rpcLimits: { ...QUEUE_WORKER_RPC_LIMITS, maxFrameBytes } }); await native.wait('ready')
  const id = native.send({ method: 'mutate', scope, expectedRevision: 1, operationId: 'response-next!', operation })
  // Raw RPC deliberately omits the main result validator. The worker must
  // enforce its complete response budget and retain post-COMMIT uncertainty.
  expect(await native.wait('result', id)).toMatchObject({ ok: false, code: 'CAPACITY', commitMayExist: true })
  const recovered = create({ requireExisting: true })
  const outcome = await recovered.queryExact(scope, 1, 'response-next!', operation)
  expect(outcome).toMatchObject({ status: 'committed', state: { revision: 2 }, receipt: { revision: 2, operationId: 'response-next!' } })
  if (outcome.status !== 'committed') throw new Error('Original committed operation missing')
  expect(() => assertQueueJsonValue({ state: outcome.state, receipt: outcome.receipt, replayed: false, durabilityWarnings: [] }, maxFrameBytes)).not.toThrow()
  expect((await recovered.read(scope)).state.revision).toBe(2)
})
