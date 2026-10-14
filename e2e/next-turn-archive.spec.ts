import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { NextTurnQueueStore } from '../src/main/next-turn-queue-store'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, type NextTurnQueueEnvelope, type NextTurnQueueLimits, type NextTurnQueueMutation, type NextTurnQueueScope, type QueueCommitResult } from '../src/shared/next-turn-queue'

/** Module2: actual immutable disks, two Node owners, old schema writer fences, kill/restart, ACK and retained admission. No Electron/providers/listeners. */
const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'archive-account' }, tenantId: 'archive-tenant', namespace: { id: 'archive-db', generation: 'one' }, owner: 'work', taskId: 'archive-task' }
const limits = { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS, maxEntries: 2 }
const oldSource = 'D:/dev/aether-code/.ae/tmp/work-queue-binding-lifecycle-20261014/after'
const envelope = (id: string): NextTurnQueueEnvelope => ({ draft: { text: 'authored ' + id, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: 'synthetic-model' }, workspace: { kind: 'local-scratch', identity: 'owned-archive-workspace' }, agent: { primaryAgentId: null, collaborators: [] }, resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'none' } }, thinking: { kind: 'off' }, memory: { kind: 'override', scope: 'off', version: 'test' }, security: { policy: 'engine-session' }, attachments: [] })
const claim = (id: string, at: number): Extract<NextTurnQueueMutation, { kind: 'claim' }> => ({ kind: 'claim', id, entryRevision: 1, frozen: { requestKey: 'immutable-key-' + id, bodyDigest: 'a'.repeat(64), entryRevision: 1, anchor: null, wireBody: '{"synthetic":"exact-wire-' + id + '"}' }, at })
let fixture: string
const children: Array<{ child: ChildProcess; completion: Promise<void> }> = []
const services: NextTurnQueueMutationService[] = []
interface Message { type: string; ok?: boolean; result?: QueueCommitResult; error?: { code: string }; diagnostics?: { ownedOperations: number; bindings: number }; serviceClosed?: boolean }
function worker(config: Record<string, unknown>) {
  const child = fork(join(__dirname, 'fixtures/next-turn-archive-worker.cjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  const messages: Message[] = [], waiters: Array<{ type: string; resolve: (message: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  const completion = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => { for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('worker closed before ' + waiter.type + ': ' + stderr)) }; waiters.length = 0; done() }) })
  children.push({ child, completion })
  child.on('message', (message: Message) => { const index = waiters.findIndex(waiter => waiter.type === message.type); if (index < 0) messages.push(message); else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) } })
  const wait = (type: string): Promise<Message> => { const index = messages.findIndex(message => message.type === type); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]); return new Promise((resolveMessage, reject) => { const waiter = { type, resolve: resolveMessage, reject, timer: setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('worker timeout ' + type + ': ' + stderr)) }, 15000) }; waiters.push(waiter) }) }
  child.send({ type: 'start', root: fixture, scope, limits, ...config })
  return { child, completion, wait, release: () => child.send({ type: 'release' }) }
}
function owner(store: NextTurnQueueStore) { const service = new NextTurnQueueMutationService(store, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'archive-owner' }), assertCurrent: () => {} }); services.push(service); return service }
async function complete(store: NextTurnQueueStore, revision: number, id: string) {
  const enqueue = await store.mutate(scope, revision, 'enqueue-' + id, { kind: 'enqueue', id, envelope: envelope(id), at: 1 }, () => {})
  const claimed = await store.mutate(scope, enqueue.state.revision, 'claim-' + id, claim(id, 2), () => {})
  const accepted = await store.mutate(scope, claimed.state.revision, 'accepted-' + id, { kind: 'accepted', id, receipt: { runId: 'run-' + id, turnId: 'turn-' + id, userMessageId: 'user-' + id, assistantMessageId: 'anchor-' + id }, at: 3 }, () => {})
  const terminal = await store.mutate(scope, accepted.state.revision, 'terminal-' + id, { kind: 'terminal', id, outcome: 'succeeded', at: 4 }, () => {})
  return { enqueue, terminal }
}
async function full(custom: NextTurnQueueLimits = limits) { const store = new NextTurnQueueStore(fixture, { limits: custom }); const first = await complete(store, 0, 'first'); const second = await complete(store, first.terminal.state.revision, 'second'); return { store, first, second } }
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; const item = value as Record<string, unknown>; return '{' + Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}' }
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function rewrite(store: NextTurnQueueStore, revision: number, change: (record: Record<string, unknown>) => void) { const file = join(store.bucketPath(scope), 'r' + String(revision).padStart(10, '0') + '.json'); const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; change(record); const { snapshotDigest: _old, ...unsigned } = record; record.snapshotDigest = sha(canonical(unsigned)); await fs.writeFile(file, canonical(record)) }
test.beforeEach(async () => { const base = resolve('.e2e-tmp'); await fs.mkdir(base, { recursive: true }); fixture = await fs.mkdtemp(join(base, 'terminal-archive-')) })
test.afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  const joined: Array<{ pid: number | undefined; exitCode: number | null; signal: NodeJS.Signals | null; closeJoined: true }> = []
  for (const { child, completion } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await completion
    joined.push({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, closeJoined: true })
  }
  const actual = await fs.realpath(fixture), base = resolve('.e2e-tmp'), relation = relative(base, actual)
  if (!relation || relation === '..' || relation.startsWith('..' + sep) || resolve(actual) === base) throw new Error('owned cleanup boundary')
  await fs.rm(actual, { recursive: true, force: true })
  await expect(fs.stat(actual)).rejects.toMatchObject({ code: 'ENOENT' })
  test.info().annotations.push({ type: 'archive-owned-close', description: JSON.stringify({ root: actual, joined, removed: true }) })
})

test('terminal archive removes active in one commit and preserves exact earliest ACK/wire after actual restart', async () => {
  const { store, first, second } = await full()
  const preimages = await Promise.all((await fs.readdir(store.bucketPath(scope))).filter(name => /^r\d{10}\.json$/.test(name)).map(async name => [name, await fs.readFile(join(store.bucketPath(scope), name), 'utf8')] as const))
  const owner1 = owner(store), cap = await owner1.bind(scope.taskId)
  const op: NextTurnQueueMutation = { kind: 'enqueue', id: 'third', envelope: envelope('third'), at: 10 }
  const committed = await owner1.mutate(cap, second.terminal.state.revision, 'enqueue-third', op)
  expect(committed.state.revision).toBe(9); expect(committed.state.entries.map(entry => entry.id)).toEqual(['second', 'third'])
  await owner1.close()
  for (const [name, bytes] of preimages) expect(await fs.readFile(join(store.bucketPath(scope), name), 'utf8')).toBe(bytes)
  const restarted = new NextTurnQueueStore(fixture, { limits }), owner2 = owner(restarted), cap2 = await owner2.bind(scope.taskId)
  const archived = await restarted.findArchived(scope, 'first')
  expect(archived?.entry).toEqual(first.terminal.state.entries[0]); expect(archived?.archiveReceipt).toEqual(committed.receipt)
  expect(await owner2.findCommitted(cap2, 'enqueue-first')).toEqual({ state: first.enqueue.state, receipt: first.enqueue.receipt })
  const replay = await owner2.mutate(cap2, 0, 'enqueue-first', { kind: 'enqueue', id: 'first', envelope: envelope('first'), at: 1 })
  expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.enqueue.receipt); expect(replay.state).toEqual(committed.state)
  await expect(owner2.mutate(cap2, committed.state.revision, 'duplicate-id', { kind: 'enqueue', id: 'first', envelope: envelope('different'), at: 11 })).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(owner2.mutate(cap2, 0, 'enqueue-first', { kind: 'enqueue', id: 'first', envelope: envelope('different'), at: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
  await owner2.close(); expect(owner2.diagnostics().ownedOperations).toBe(0)
})

test('more than 100 real terminal turns keep active bounded without resetting revision or losing old identities', async () => {
  test.setTimeout(360000)
  // A tighter real active budget exercises many rotations without repeatedly loading 16 retained payloads.
  // The earlier 110/default-budget timeout stays preserved as a measured full-history performance obstacle.
  const store = new NextTurnQueueStore(fixture, { limits }), service = owner(store), cap = await service.bind(scope.taskId)
  let revision = 0
  const finish = async (id: string) => {
    const enqueue = await service.mutate(cap, revision, 'enqueue-' + id, { kind: 'enqueue', id, envelope: envelope(id), at: 1 })
    const claimed = await service.transition(cap, enqueue.state.revision, 'claim-' + id, claim(id, 2))
    const accepted = await service.transition(cap, claimed.state.revision, 'accepted-' + id, { kind: 'accepted', id, receipt: { runId: 'run-' + id, turnId: 'turn-' + id, userMessageId: 'user-' + id, assistantMessageId: 'anchor-' + id }, at: 3 })
    const terminal = await service.transition(cap, accepted.state.revision, 'terminal-' + id, { kind: 'terminal', id, outcome: 'succeeded', at: 4 })
    revision = terminal.state.revision
    return { enqueue, terminal }
  }
  const first = await finish('turn-0'); let state = first.terminal.state
  for (let index = 1; index < 101; index++) { state = (await finish('turn-' + index)).terminal.state; expect(state.entries.length).toBeLessThanOrEqual(2) }
  expect(state.revision).toBe(404); expect((await store.findArchived(scope, 'turn-0'))?.entry).toEqual(first.terminal.state.entries[0])
  await service.close()
  const restarted = new NextTurnQueueStore(fixture, { limits }); expect((await restarted.read(scope)).state).toEqual(state); expect(await restarted.findReceipt(scope, 'enqueue-turn-0')).toEqual(first.enqueue.receipt)
  await expect(restarted.mutate(scope, state.revision, 'new-operation-old-entry', { kind: 'enqueue', id: 'turn-0', envelope: envelope('reuse'), at: 20 }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' })
})

test('default active retention remains 16 recent terminal plus the just-finished entry', async () => {
  test.setTimeout(60000)
  const store = new NextTurnQueueStore(fixture)
  let state = (await complete(store, 0, 'default-0')).terminal.state
  for (let index = 1; index < 19; index++) state = (await complete(store, state.revision, 'default-' + index)).terminal.state
  expect(state.entries).toHaveLength(17); expect(state.entries[0].id).toBe('default-2')
  expect((await store.findArchived(scope, 'default-0'))?.entry.phase).toBe('terminal')
})

test('old reader rejects first archived format before attempting another mutation', async () => {
  const { store } = await full()
  await store.mutate(scope, 8, 'format-fence', { kind: 'pause', reason: 'archive' }, () => {})
  const old = worker({ sourceRoot: oldSource, readOnly: true })
  const read = await old.wait('result'); expect(read.ok).toBe(false); expect(read.error?.code).toBe('CORRUPT'); await old.completion
})

test('close joins owned held archival publication and preserves earlier active state', async () => {
  const { second } = await full()
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>(done => { reached = done }), held = new Promise<void>(done => { release = done })
  const store = new NextTurnQueueStore(fixture, { limits, testHook: async context => { if (context.phase === 'after-ready-rename') { reached(); await held } } })
  const service = owner(store), cap = await service.bind(scope.taskId)
  const mutation = service.mutate(cap, 8, 'held-archive', { kind: 'pause', reason: 'held' })
  const rejected = expect(mutation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await barrier
  let joined = false; const closing = service.close().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false)
  release(); await rejected; await closing
  expect(service.diagnostics().ownedOperations).toBe(0); expect(service.diagnostics().bindings).toBe(0)
  expect((await store.read(scope)).state).toEqual(second.terminal.state); expect(await store.findArchived(scope, 'first')).toBeNull()
})

for (const phase of ['after-stage-fsync', 'after-ready-rename', 'after-publish'] as const) {
  test('archive actual kill at ' + phase + ' keeps archive and active atomic', async () => {
    const { store, first, second } = await full()
    const held = worker({ expectedRevision: 8, operationId: 'archive-kill', operation: { kind: 'pause', reason: 'owned-pause' }, holdAt: phase })
    await held.wait('barrier'); held.child.kill('SIGKILL'); await held.completion
    const restarted = new NextTurnQueueStore(fixture, { limits }), state = (await restarted.read(scope)).state, archive = await restarted.findArchived(scope, 'first')
    if (phase === 'after-publish') { expect(state.revision).toBe(9); expect(state.entries.map(entry => entry.id)).toEqual(['second']); expect(archive?.entry).toEqual(first.terminal.state.entries[0]); expect(await restarted.findReceipt(scope, 'archive-kill')).not.toBeNull() }
    else { expect(state).toEqual(second.terminal.state); expect(archive).toBeNull(); expect(await restarted.findReceipt(scope, 'archive-kill')).toBeNull() }
    expect(await store.findReceipt(scope, 'enqueue-first')).toEqual(first.enqueue.receipt)
  })
}

for (const winner of ['old', 'new'] as const) {
  test('actual old/new writers arbitrate same archive revision with ' + winner + ' winning', async () => {
    const { store } = await full()
    const old = worker({ sourceRoot: oldSource, expectedRevision: 8, operationId: 'old-pause', operation: { kind: 'pause', reason: 'old' }, holdAt: 'after-ready-rename' })
    const newer = worker({ expectedRevision: 8, operationId: 'new-pause', operation: { kind: 'pause', reason: 'new' }, holdAt: 'after-ready-rename' })
    await Promise.all([old.wait('barrier'), newer.wait('barrier')])
    const first = winner === 'old' ? old : newer, loser = winner === 'old' ? newer : old
    first.release(); const won = await first.wait('result'); expect(won.ok).toBe(true); expect(won.serviceClosed).toBe(true); await first.completion
    loser.release(); const lost = await loser.wait('result'); expect(lost.ok).toBe(false); expect(lost.error?.code).toBe('CAS'); await loser.completion
    const head = (await store.read(scope)).state; expect(head.revision).toBe(9); expect(head.pauseReason).toBe(winner)
    if (winner === 'old') { expect(await store.findArchived(scope, 'first')).toBeNull(); await store.mutate(scope, 9, 'new-after-old', { kind: 'pause', reason: 'new-after-old' }, () => {}) }
    expect((await store.findArchived(scope, 'first'))?.entry.phase).toBe('terminal')
    const oldReader = worker({ sourceRoot: oldSource, readOnly: true }); const oldRead = await oldReader.wait('result'); expect(oldRead.ok).toBe(false); expect(oldRead.error?.code).toBe('CORRUPT'); await oldReader.completion
    const names = (await fs.readdir(store.bucketPath(scope))).filter(name => /^r\d{10}\.json$/.test(name)); expect(names.length).toBe(winner === 'old' ? 11 : 10)
  })
}

test('actual two new writers cannot duplicate archival removal or revision', async () => {
  const { store } = await full()
  const a = worker({ expectedRevision: 8, operationId: 'archive-a', operation: { kind: 'pause', reason: 'a' }, holdAt: 'after-ready-rename' }), b = worker({ expectedRevision: 8, operationId: 'archive-b', operation: { kind: 'pause', reason: 'b' }, holdAt: 'after-ready-rename' })
  await Promise.all([a.wait('barrier'), b.wait('barrier')]); a.release(); b.release(); const results = await Promise.all([a.wait('result'), b.wait('result')]); await Promise.all([a.completion, b.completion])
  expect(results.filter(result => result.ok)).toHaveLength(1); expect(results.filter(result => result.error?.code === 'CAS')).toHaveLength(1)
  expect((await store.read(scope)).state.revision).toBe(9); expect((await store.findArchived(scope, 'first'))?.archiveReceipt.revision).toBe(9)
})

for (const phase of ['admission-unknown', 'accepted'] as const) {
  test('archive never removes ' + phase + ' or invents durable abandon/reject', async () => {
    const custom = { ...limits, maxEntries: 3 }, { store, second } = await full(custom)
    let result = await store.mutate(scope, second.terminal.state.revision, 'enqueue-protected', { kind: 'enqueue', id: 'protected', envelope: envelope('protected'), at: 10 }, () => {})
    result = await store.mutate(scope, result.state.revision, 'claim-protected', claim('protected', 11), () => {})
    result = await store.mutate(scope, result.state.revision, 'protected-phase', phase === 'accepted' ? { kind: 'accepted', id: 'protected', receipt: { runId: 'protected-run', turnId: 'protected-turn', userMessageId: 'protected-user', assistantMessageId: 'protected-anchor' }, at: 12 } : { kind: 'admission-unknown', id: 'protected', reason: 'response uncertain', at: 12 }, () => {})
    const protectedEntry = result.state.entries.find(entry => entry.id === 'protected')
    result = await store.mutate(scope, result.state.revision, 'enqueue-after-protected', { kind: 'enqueue', id: 'next', envelope: envelope('next'), at: 13 }, () => {})
    expect(result.state.entries.find(entry => entry.id === 'protected')).toEqual(protectedEntry); expect(await store.findArchived(scope, 'protected')).toBeNull(); expect((await store.findArchived(scope, 'first'))?.entry.phase).toBe('terminal')
    const restart = new NextTurnQueueStore(fixture, { limits: custom }); expect((await restart.read(scope)).state).toEqual(result.state)
    if (phase === 'admission-unknown') await expect(restart.mutate(scope, result.state.revision, 'fake-terminal', { kind: 'terminal', id: 'protected', outcome: 'cancelled', at: 15 }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' })
  })
}

test('checksum-valid archive tampering and version downgrade fail closed without empty fallback', async () => {
  const { store } = await full(); await store.mutate(scope, 8, 'archive-pause', { kind: 'pause', reason: 'pause' }, () => {})
  const original = await fs.readFile(join(store.bucketPath(scope), 'r0000000009.json'), 'utf8')
  await rewrite(store, 9, record => { const archived = record.archived as Array<{ phase: string }>; archived[0].phase = 'accepted' })
  await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
  await fs.writeFile(join(store.bucketPath(scope), 'r0000000009.json'), original)
  await store.mutate(scope, 9, 'v2-successor', { kind: 'pause', reason: 'successor' }, () => {})
  await rewrite(store, 10, record => { record.schemaVersion = 1; delete record.archived; delete record.mutation })
  await expect(store.read(scope)).rejects.toMatchObject({ code: 'CORRUPT' })
})

test('archive IO failure preserves active and operation absent; journal hard budgets remain explicit', async () => {
  const { store, second } = await full()
  const failed = new NextTurnQueueStore(fixture, { limits, testHook: async context => { if (context.phase === 'after-stage-fsync') throw new Error('owned archival fault') } })
  await expect(failed.mutate(scope, 8, 'failed-archive', { kind: 'pause', reason: 'failed' }, () => {})).rejects.toMatchObject({ code: 'IO' })
  expect((await store.read(scope)).state).toEqual(second.terminal.state); expect(await store.findArchived(scope, 'first')).toBeNull(); expect(await store.findReceipt(scope, 'failed-archive')).toBeNull()
  const bounded = new NextTurnQueueStore(fixture, { limits: { ...limits, maxRevisions: 9 } })
  await expect(bounded.mutate(scope, 8, 'budget-archive', { kind: 'pause', reason: 'budget' }, () => {})).rejects.toMatchObject({ code: 'CAPACITY' }); expect((await store.read(scope)).state.revision).toBe(8)
})
