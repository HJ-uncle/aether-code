import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { buildSync } from 'esbuild'
import { NextTurnQueueWorkerFactory } from '../src/main/next-turn-queue-worker-factory'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { createQueueCapabilityFence, type QueueAuthorityCheck } from '../src/main/next-turn-queue-authority-fence'
import { NextTurnQueueError, type NextTurnQueueScope } from '../src/shared/next-turn-queue'

/** Real SQLite worker factory/catalog/service contracts. This spec does not
 * start Electron, a provider or a listener; packaged gates are separate. */
const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'owned-account' }, tenantId: 'owned-tenant',
  namespace: { id: 'owned-db', generation: 'one' }, owner: 'work', taskId: 'owned-task' }
let bundleRoot: string, fixture: string, bundle: { path: string; sha256: string }, controller: AbortController, generation: string
const factories: NextTurnQueueWorkerFactory[] = [], services: NextTurnQueueMutationService[] = []
async function clean(directory: string) { const actual = await fs.realpath(directory), relation = relative(resolve('.e2e-tmp'), actual); if (!relation || relation === '..' || relation.startsWith('..' + sep)) throw new Error('Fixture escaped boundary'); await fs.rm(actual, { recursive: true, force: true }) }
test.beforeAll(async () => { await fs.mkdir(resolve('.e2e-tmp'), { recursive: true }); bundleRoot = await fs.mkdtemp(resolve('.e2e-tmp/native-factory-bundle-')); const path = join(bundleRoot, 'worker.cjs'); buildSync({ entryPoints: [resolve('src/main/next-turn-queue-sqlite-worker-entry.ts')], outfile: path, bundle: true, platform: 'node', format: 'cjs', target: 'node22' }); bundle = { path, sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') } })
test.afterAll(async () => { await clean(bundleRoot) })
test.beforeEach(async () => { fixture = await fs.mkdtemp(resolve('.e2e-tmp/native-factory-owned-')); controller = new AbortController(); generation = 'engine-one' })
test.afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const factory of factories.splice(0)) await factory.close(); await clean(fixture) })
function factory(options: { maxOwners?: number; maxCatalogs?: number } = {}) { const result = new NextTurnQueueWorkerFactory(join(fixture, 'catalogs'), { enabled: true, workerBundle: bundle, ...options,
  captureEpoch: () => ({ generation, signal: controller.signal, source: scope.source }) }); factories.push(result); return result }
function service(store: NextTurnQueueWorkerFactory, namespace = scope.namespace) { const result = new NextTurnQueueMutationService(store, {
  capture: async taskId => ({ scope: { ...scope, namespace, taskId }, generation }), assertCurrent: lease => { if (lease.generation !== generation || controller.signal.aborted) throw new NextTurnQueueError('AUTHORITY', 'Synthetic engine epoch changed') } }); services.push(result); return result }
const authority = (): QueueAuthorityCheck => Object.assign(() => {}, { capabilityFence: createQueueCapabilityFence() })

test('bounded one-owner factory evicts healthy idle workers and preserves original receipts across reopen', async () => {
  const store = factory({ maxOwners: 1 })
  for (let index = 0; index < 4; index++) { const current = service(store, { id: 'owned-db', generation: 'namespace-' + index }), capability = await current.bind('task-' + index)
    expect((await current.mutate(capability, 0, 'operation-' + index, { kind: 'pause', reason: 'bounded pool' })).state.revision).toBe(1)
    await current.release(capability); await current.close(); expect(store.diagnostics()).toMatchObject({ owners: 1, retiring: 0, operations: 0, retainedStopFailures: [] }) }
  await store.close(); expect(store.diagnostics()).toMatchObject({ owners: 0, retiring: 0, operations: 0 })
  const reopened = factory({ maxOwners: 1 })
  for (let index = 0; index < 4; index++) expect((await reopened.findReceipt({ ...scope, taskId: 'task-' + index, namespace: { id: 'owned-db', generation: 'namespace-' + index } }, 'operation-' + index))?.revision).toBe(1)
  expect(await reopened.listScopes()).toEqual([])
})
test('factory freezes task identity and mutation bytes before its first await', async () => {
  const store = factory(), mutableScope = structuredClone(scope), mutableMutation = { kind: 'pause' as const, reason: 'original' }
  const pending = store.mutate(mutableScope, 0, 'frozen', mutableMutation, authority())
  mutableScope.taskId = 'changed-after-call'; mutableMutation.reason = 'changed-after-call'
  const committed = await pending; expect(committed.state.scope.taskId).toBe(scope.taskId); expect(committed.state.pauseReason).toBe('original')
  expect((await store.read(scope)).state.revision).toBe(1); expect((await store.read(mutableScope)).state.revision).toBe(0)
})
test('an acknowledged catalog whose SQLite file disappears is never recreated as empty', async () => {
  const store = factory(), current = service(store), capability = await current.bind(scope.taskId)
  await current.mutate(capability, 0, 'original', { kind: 'pause', reason: 'retain proof' }); await current.close(); await store.close()
  const [catalog] = (await fs.readdir(join(fixture, 'catalogs'))).filter(name => !name.startsWith('.')), file = join(fixture, 'catalogs', catalog, 'queue.sqlite')
  await fs.rm(file)
  const reopened = factory(); await expect(reopened.read(scope)).rejects.toMatchObject({ code: 'IO' })
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.stat(join(fixture, 'catalogs', catalog, 'identity.json'))).isFile()).toBe(true)
})
test('source abort synchronously revokes workers and a new epoch cannot use an old capability', async () => {
  const store = factory(), current = service(store), old = await current.bind(scope.taskId)
  await current.mutate(old, 0, 'old', { kind: 'pause', reason: 'old epoch' })
  controller.abort(); expect(store.diagnostics().owners).toBe(0)
  controller = new AbortController(); generation = 'engine-two'; store.onEngineChanged()
  await expect(current.mutate(old, 1, 'late', { kind: 'resume' })).rejects.toMatchObject({ code: 'AUTHORITY' })
  const next = await current.bind('new-task'); expect((await current.mutate(next, 0, 'new', { kind: 'pause', reason: 'new epoch' })).state.revision).toBe(1)
  expect((await store.findReceipt(scope, 'old'))?.operationId).toBe('old')
  await current.release(next)
})
test('busy factory capacity fails explicitly before making another namespace catalog', async () => {
  const store = factory({ maxOwners: 1 }), a = store.read(scope), b = store.read({ ...scope, namespace: { ...scope.namespace, generation: 'second' } })
  const denied = expect(b).rejects.toMatchObject({ code: 'CAPACITY' }); expect((await a).state.revision).toBe(0); await denied
  expect((await fs.readdir(join(fixture, 'catalogs'))).filter(name => !name.startsWith('.')).length).toBe(1)
})
test('catalog capacity preserves existing evidence and does not silently discard an old namespace', async () => {
  const store = factory({ maxCatalogs: 1 }); await store.mutate(scope, 0, 'original', { kind: 'pause', reason: 'retain' }, authority())
  await expect(store.read({ ...scope, namespace: { ...scope.namespace, generation: 'second' } })).rejects.toMatchObject({ code: 'CAPACITY' })
  expect((await store.findReceipt(scope, 'original'))?.revision).toBe(1)
  expect((await fs.readdir(join(fixture, 'catalogs'))).filter(name => !name.startsWith('.')).length).toBe(1)
})
test('invalid catalog descriptor is rejected on reopen instead of being trusted as scope authority', async () => {
  const store = factory(); await store.read(scope); await store.close()
  const [catalog] = (await fs.readdir(join(fixture, 'catalogs'))).filter(name => !name.startsWith('.'))
  const descriptor = join(fixture, 'catalogs', catalog, 'identity.json'), value = JSON.parse(await fs.readFile(descriptor, 'utf8'))
  value.identity.tenantId = 'other-tenant'; await fs.writeFile(descriptor, JSON.stringify(value))
  expect(() => factory()).toThrow(NextTurnQueueError)
})
test('an entire missing catalog cannot become a fresh empty namespace on reopen', async () => {
  const store = factory(); await store.mutate(scope, 0, 'acknowledged', { kind: 'pause', reason: 'retained' }, authority()); await store.close()
  const root = join(fixture, 'catalogs'), [catalog] = (await fs.readdir(root)).filter(name => !name.startsWith('.'))
  await clean(join(root, catalog))
  expect(() => factory()).toThrow(/catalog is missing/)
  expect((await fs.readdir(root)).filter(name => !name.startsWith('.'))).toEqual([])
})
test('external root anchor rejects missing acknowledged root without creating a replacement', async () => {
  const store = factory(); await store.mutate(scope, 0, 'acknowledged', { kind: 'pause', reason: 'retained' }, authority()); await store.close()
  const root = join(fixture, 'catalogs'); await clean(root)
  expect(() => factory()).toThrow(/root or registry is missing/)
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.stat(root + '.anchor.json')).isFile()).toBe(true)
})
test('deleting acknowledged latest catalog and registry tail cannot reset original ACK into empty state', async () => {
  const store = factory(); await store.mutate(scope, 0, 'acknowledged-tail', { kind: 'pause', reason: 'retained' }, authority()); await store.close()
  const root = join(fixture, 'catalogs'), [catalog] = (await fs.readdir(root)).filter(name => !name.startsWith('.'))
  await clean(join(root, catalog)); await fs.rm(join(root, '.catalog-registry', '000001.json'))
  expect(() => factory()).toThrow(/tail differs/)
  expect((await fs.readdir(root)).filter(name => !name.startsWith('.'))).toEqual([])
  expect(JSON.parse(await fs.readFile(root + '.anchor.json', 'utf8')).committedRevision).toBe(1)
})
test('prepared registration slot without matching durable head blocks restart and preserves bytes', async () => {
  const store = factory(), root = join(fixture, 'catalogs'), originalHead = await fs.readFile(root + '.anchor.json')
  await store.mutate(scope, 0, 'acknowledged', { kind: 'pause', reason: 'prepared-test' }, authority()); await store.close()
  const slot = join(root, '.catalog-registry', '000001.json'), originalSlot = await fs.readFile(slot)
  await fs.writeFile(root + '.anchor.json', originalHead)
  expect(() => factory()).toThrow(/tail differs/)
  expect(await fs.readFile(slot)).toEqual(originalSlot)
})
test('a redirected parent directory cannot receive the native root or external anchor', async () => {
  const redirected = join(fixture, 'redirected'), outside = join(fixture, 'other-owned-project')
  await fs.mkdir(outside); await fs.symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => new NextTurnQueueWorkerFactory(join(redirected, 'native'), { enabled: true, workerBundle: bundle,
    captureEpoch: () => ({ generation, signal: controller.signal, source: scope.source }) })).toThrow(/ordinary owned path/)
  expect(await fs.readdir(outside)).toEqual([])
})
