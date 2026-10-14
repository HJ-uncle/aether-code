import { acquireQueueCommit, assertQueueCapability, finishQueueCommit } from './next-turn-queue-authority-fence'
import { parentPort, workerData } from 'node:worker_threads'
import { NextTurnQueueSqliteExperiment } from './next-turn-queue-sqlite-experiment'
import { NextTurnQueueError } from '../shared/next-turn-queue'
import { assertQueueJsonValue, assertQueueScope, sameQueueScope } from '../shared/next-turn-queue-state'
import { assertQueueWorkerInputFrame, assertWorkerEpoch, QUEUE_WORKER_RPC_LIMITS, type QueueWorkerStart, type QueueWorkerInput, type QueueWorkerOutput, type QueueWorkerRequest, type QueueWorkerPhase } from './next-turn-queue-worker-protocol'

const port = parentPort
if (!port) throw new Error('Queue SQLite entry requires an owned worker')
const start = workerData as QueueWorkerStart, shared = new Int32Array(start.epoch)
if (typeof start.instanceId !== 'string' || !start.instanceId || !(start.epoch instanceof SharedArrayBuffer) || start.epoch.byteLength !== 8) throw new Error('Queue worker bootstrap is invalid')
let store: NextTurnQueueSqliteExperiment | undefined, closing = false, serial: Promise<unknown> = Promise.resolve(), active: QueueWorkerRequest | undefined
const requests = new Set<string>()
let queuedBytes = 0, commitAcquired = false
let gate: { id: string; step: QueueWorkerPhase; resolve: (ok: boolean) => void } | undefined
let releaseHeld: (() => void) | undefined
const budgets = { ...(start.rpcLimits ?? QUEUE_WORKER_RPC_LIMITS) }
for (const key of ['maxRequests','maxRequestBytes','maxFrameBytes','deadlineMs'] as const)
  if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1 || budgets[key] > QUEUE_WORKER_RPC_LIMITS[key]) throw new Error('Queue worker RPC budgets differ')
const send = (message: QueueWorkerOutput): void => {
  let bounded = message
  if ('message' in message) bounded = { ...message, message: message.message.slice(0, 1024) }
  for (;;) {
    try { assertQueueJsonValue(bounded, budgets.maxFrameBytes); break }
    catch (error) {
      if (!('message' in bounded) || !bounded.message.length) throw error
      bounded = { ...bounded, message: bounded.message.slice(0, Math.floor(bounded.message.length / 2)) }
    }
  }
  port.postMessage(bounded)
}
const hold = async (step: QueueWorkerPhase): Promise<void> => {
  if (start.holdAt !== step) return
  const request = active!
  await new Promise<void>(resolve => { releaseHeld = resolve; send({ kind: 'test-barrier', instanceId: start.instanceId, id: request.id, step }) })
  releaseHeld = undefined
}
const authority = () => {
  if (!active || closing) throw new NextTurnQueueError('AUTHORITY', 'Queue worker owner is closing')
  if ('scope' in active.body) {
    const scope = active.body.scope; assertQueueScope(scope)
    if (!sameQueueScope(scope, { ...start.identity, taskId: scope.taskId })) throw new NextTurnQueueError('SCOPE', 'Native worker source/namespace differs from trusted construction')
  }
  if (active.body.method === 'mutate') {
    if (start.requireCapabilityFence && !active.capabilityFence) throw new NextTurnQueueError('AUTHORITY', 'Production worker mutation lacks capability fence')
    if (active.capabilityFence) assertQueueCapability(active.capabilityFence, commitAcquired)
  }
  try { assertWorkerEpoch(shared, active.epoch) } catch { throw new NextTurnQueueError('AUTHORITY', 'Queue worker source/epoch changed') }
}
const authorize = async (step: QueueWorkerPhase) => {
  authority()
  const request = active!
  const ok = await new Promise<boolean>(resolve => { gate = { id: request.id, step, resolve }; send({ kind: 'authority', instanceId: start.instanceId, id: request.id, step, epoch: request.epoch }) })
  gate = undefined
  if (!ok) throw new NextTurnQueueError('AUTHORITY', 'Main queue authority declined worker commit')
  if (step === 'before-commit' && active!.capabilityFence) {
    await hold('after-commit-grant')
    acquireQueueCommit(active!.capabilityFence!); commitAcquired = true
    await hold('commit-acquired')
  }
  authority()
}
const hook = async (step: QueueWorkerPhase) => {
  await hold(step)
  if (step !== 'after-commit') await authorize(step)
}
const dispatch = async (request: QueueWorkerRequest) => {
  const body = request.body, native = store!
  authority()
  switch (body.method) {
    case 'read': return native.read(body.scope)
    case 'mutate': return native.mutate(body.scope, body.expectedRevision, body.operationId, body.operation, authority)
    case 'findCommitted': return native.findCommitted(body.scope, body.operationId)
    case 'findReceipt': return native.findReceipt(body.scope, body.operationId)
    case 'findArchived': return native.findArchived(body.scope, body.id)
    case 'listScopes': return native.listScopes(body.maximum)
    case 'queryExact': return native.queryExact(body.scope, body.expectedRevision, body.operationId, body.operation)
    case 'diagnostics': return native.diagnostics(body.scope)
    default: throw new NextTurnQueueError('INVALID', 'Unknown queue worker method')
  }
}
port.on('message', (message: QueueWorkerInput) => {
  if (!message || message.instanceId !== start.instanceId) return
  if (message.kind === 'authorize') {
    if (gate?.id === message.id && gate.step === message.step) gate.resolve(message.ok === true)
    return
  }
  if (message.kind === 'release-test') { releaseHeld?.(); return }
  if (message.kind === 'close') {
    if (closing) return
    closing = true; Atomics.store(shared, 1, 1); gate?.resolve(false); releaseHeld?.()
    void serial.catch(() => {}).then(async () => {
      if (start.testHangAt === 'close') { send({ kind: 'test-barrier', instanceId: start.instanceId, id: 'owned-close', step: 'after-commit' }); Atomics.wait(shared, 0, 1) }
      await store?.close(); send({ kind: 'closed', instanceId: start.instanceId }); port.close()
    }).catch(error => { send({ kind: 'fatal', instanceId: start.instanceId, message: String(error) }); port.close() })
    return
  }
  if (message.kind !== 'request') return
  let size: number
  try {
    assertQueueWorkerInputFrame(message, budgets.maxFrameBytes)
    if (typeof message.id !== 'string' || message.id.length > 64 || !message.id) throw new NextTurnQueueError('INVALID', 'Worker request identity is invalid')
    size = Buffer.byteLength(JSON.stringify({ ...message, capabilityFence: undefined })) + (message.capabilityFence ? 4 : 0)
    if (closing) throw new NextTurnQueueError('AUTHORITY', 'Worker request arrived after close')
    if (requests.has(message.id) || requests.size >= budgets.maxRequests || queuedBytes + size > budgets.maxRequestBytes) throw new NextTurnQueueError('CAPACITY', 'Worker owned RPC budget exceeded')
    assertWorkerEpoch(shared, message.epoch)
  } catch (error) {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 64) { send({ kind: 'fatal', instanceId: start.instanceId, message: 'Worker request identity is invalid' }); return }
    send({ kind: 'result', instanceId: start.instanceId, id: message.id, ok: false, code: error instanceof NextTurnQueueError ? error.code : 'AUTHORITY', message: String(error), commitMayExist: false }); return
  }
  requests.add(message.id); queuedBytes += size
  const current = serial.catch(() => {}).then(async () => {
    active = message; commitAcquired = false
    let completedMutation = false
    try {
      const value = await dispatch(message)
      completedMutation = message.body.method === 'mutate'
      const response: QueueWorkerOutput = { kind: 'result', instanceId: start.instanceId, id: message.id, ok: true, value }
      assertQueueJsonValue(response, budgets.maxFrameBytes)
      send(response)
    } catch (error) {
      const uncertain = completedMutation || message.body.method === 'mutate' && !(error instanceof NextTurnQueueError && error.code !== 'IO')
      send({ kind: 'result', instanceId: start.instanceId, id: message.id, ok: false, code: error instanceof NextTurnQueueError ? error.code : 'IO', message: String(error), commitMayExist: uncertain })
    } finally { if (commitAcquired && message.capabilityFence) finishQueueCommit(message.capabilityFence); commitAcquired = false; active = undefined; requests.delete(message.id); queuedBytes -= size }
  })
  serial = current
})
try {
  if (start.testHangAt === 'startup') { send({ kind: 'test-barrier', instanceId: start.instanceId, id: 'owned-startup', step: 'before-transaction' }); Atomics.wait(shared, 0, 1) }
  assertWorkerEpoch(shared, 1)
  store = new NextTurnQueueSqliteExperiment(start.file, { nativeExperimentOnly: true, limits: start.limits, requireExisting: start.requireExisting, maxVerifiedScopes: start.maxVerifiedScopes, testHook: hook })
  send({ kind: 'ready', instanceId: start.instanceId, runtime: process.versions.node })
} catch (error) {
  closing = true
  if (Atomics.load(shared, 1) === 1) send({ kind: 'closed', instanceId: start.instanceId })
  else send({ kind: 'fatal', instanceId: start.instanceId, message: String(error) })
  port.close()
}
