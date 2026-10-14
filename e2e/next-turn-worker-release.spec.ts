import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, sep } from 'node:path'
import { buildSync } from 'esbuild'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { NextTurnQueueSqliteWorker, QueueWorkerCommitUnknownError } from '../src/main/next-turn-queue-sqlite-worker'
import type { NextTurnQueueScope } from '../src/shared/next-turn-queue'
import type { QueueWorkerPhase } from '../src/main/next-turn-queue-worker-protocol'

/** Actual native Worker COMMIT/revoke races, repeated release ACKs, and close
 * joins. No Electron, provider, sockets or public application files are used. */
const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'release-review' }, tenantId: 'release-review', namespace: { id: 'release-review', generation: 'one' }, owner: 'work', taskId: 'release-review' }
const { taskId: _, ...identity } = scope
let bundleDirectory: string, fixture: string, bundle: { path: string; sha256: string }
async function cleanup(directory: string) {
  const absolute = await fs.realpath(directory), relation = relative(resolve('.e2e-tmp'), absolute)
  if (!relation || relation === '..' || relation.startsWith('..' + sep)) throw new Error('Release fixture escaped its owned boundary')
  await fs.rm(absolute, { recursive: true, force: true })
}
test.beforeAll(async () => {
  await fs.mkdir(resolve('.e2e-tmp'), { recursive: true })
  bundleDirectory = await fs.mkdtemp(resolve('.e2e-tmp/release-worker-bundle-'))
  const path = join(bundleDirectory, 'worker.cjs')
  buildSync({ entryPoints: [resolve('src/main/next-turn-queue-sqlite-worker-entry.ts')], outfile: path, bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
  bundle = { path, sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') }
})
test.afterAll(async () => { await cleanup(bundleDirectory) })
test.beforeEach(async () => { fixture = await fs.mkdtemp(resolve('.e2e-tmp/release-native-owned-')) })
test.afterEach(async () => { await cleanup(fixture) })
const tick = () => new Promise<void>(done => setImmediate(done))
function setup(phase?: QueueWorkerPhase) {
  let signal!: () => void
  const reached = new Promise<void>(done => { signal = done })
  const worker = new NextTurnQueueSqliteWorker(join(fixture, 'queue.sqlite'), { nativeExperimentOnly: true, workerBundle: bundle, identity, generation: 'one', assertGeneration: () => {}, requireCapabilityFence: true,
    ...(phase ? { test: { holdAt: phase, onBarrier: () => signal() } } : {}) })
  const service = new NextTurnQueueMutationService(worker, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'one' }), assertCurrent: () => {} })
  return { worker, service, reached }
}

for (const phase of ['after-commit-grant', 'commit-acquired'] as const) test('repeated release and service close join the same held native outcome at ' + phase, async () => {
  const { worker, service, reached } = setup(phase), capability = await service.bind(scope.taskId)
  const mutation = service.mutate(capability, 0, 'held-release', { kind: 'pause', reason: 'held original' }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
  try {
    await reached
    const first = service.release(capability), releases = Array.from({ length: 64 }, () => service.release(capability))
    let firstSettled = false, repeatedSettled = false, closeSettled = false
    void first.then(() => { firstSettled = true })
    void releases[0].then(() => { repeatedSettled = true })
    const closing = service.close().then(() => { closeSettled = true })
    await tick()
    expect(firstSettled).toBe(false)
    expect(repeatedSettled).toBe(false)
    expect(closeSettled).toBe(false)
    for (const released of releases) expect(released).toBe(first)
    expect(service.release(capability)).toBe(first)
    worker.releaseTestBarrier()
    const result = await mutation
    await Promise.all([first, ...releases, closing])
    expect(service.release(capability)).toBe(first)
    const exact = await worker.queryExact(scope, 0, 'held-release', { kind: 'pause', reason: 'held original' })
    if (phase === 'after-commit-grant') {
      expect(result.error).toMatchObject({ code: 'AUTHORITY' })
      expect(exact).toEqual({ status: 'absent' })
    } else {
      expect(result.error).toBeInstanceOf(QueueWorkerCommitUnknownError)
      expect(exact).toMatchObject({ status: 'committed', state: { revision: 1 }, receipt: { operationId: 'held-release', revision: 1 } })
    }
    expect(service.diagnostics()).toMatchObject({ bindings: 0, mutationBuckets: 0, ownedOperations: 0, pendingMutationBytes: 0, closing: true })
  } finally {
    worker.releaseTestBarrier()
    await mutation
    await service.close()
    await worker.close()
    expect(await worker.waitForExit()).toBe(0)
    expect(worker.statistics()).toMatchObject({ pendingRequests: 0, pendingBytes: 0, nativeCloseAcknowledged: true, stopDeadlineExceeded: false, workerExitCode: 0 })
  }
})

test('settled repeated release retains its promise and cannot revoke a different capability', async () => {
  const { worker, service } = setup(), a = await service.bind('a'), b = await service.bind('b')
  try {
    await service.mutate(a, 0, 'original-a', { kind: 'pause', reason: 'a' })
    const released = service.release(a)
    await released
    for (let index = 0; index < 128; index++) expect(service.release(a)).toBe(released)
    await expect(service.mutate(a, 1, 'late-a', { kind: 'resume' })).rejects.toMatchObject({ code: 'AUTHORITY' })
    expect((await service.mutate(b, 0, 'original-b', { kind: 'pause', reason: 'b' })).receipt).toMatchObject({ operationId: 'original-b', revision: 1 })
    expect((await worker.findReceipt({ ...scope, taskId: 'a' }, 'original-a'))?.revision).toBe(1)
    await service.release(b)
    expect(service.diagnostics()).toMatchObject({ bindings: 0, ownedOperations: 0 })
  } finally { await service.close(); await worker.close(); expect(await worker.waitForExit()).toBe(0) }
})

test('release before a queued mutation starts joins rejection and preserves exact absence', async () => {
  const { worker, service } = setup(), capability = await service.bind(scope.taskId)
  try {
    const mutation = service.mutate(capability, 0, 'pre-start', { kind: 'pause', reason: 'must not publish' })
    const rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
    const release = service.release(capability)
    expect(service.release(capability)).toBe(release)
    await rejected
    await release
    expect(await worker.queryExact(scope, 0, 'pre-start', { kind: 'pause', reason: 'must not publish' })).toEqual({ status: 'absent' })
    expect(service.diagnostics()).toMatchObject({ bindings: 0, ownedOperations: 0, mutationBuckets: 0, pendingMutationBytes: 0 })
  } finally { await service.close(); await worker.close(); expect(await worker.waitForExit()).toBe(0) }
})
