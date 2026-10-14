import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { NextTurnQueueSqliteExperiment } from '../src/main/next-turn-queue-sqlite-experiment'
import { NextTurnQueueMutationService } from '../src/main/next-turn-queue-service'
import { applyNextTurnQueueMutation } from '../src/shared/next-turn-queue-state'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, type NextTurnQueueEnvelope, type NextTurnQueueScope } from '../src/shared/next-turn-queue'

/** Actual developer Node builtin SQLite: transaction/rotation/ACK/corruption/kill. Explicitly NOT Electron packaging or migration acceptance. */
const scope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'native-owned' }, tenantId: 'native-owned', namespace: { id: 'native-owned', generation: 'one' }, owner: 'work', taskId: 'native-owned' }
const envelope = (id: string): NextTurnQueueEnvelope => ({ draft: { text: 'synthetic ' + id, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: 'synthetic-model' }, workspace: { kind: 'local-scratch', identity: 'owned' }, agent: { primaryAgentId: null, collaborators: [] }, resources: { skills: { kind: 'none' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'none' } }, thinking: { kind: 'off' }, memory: { kind: 'override', scope: 'off', version: 'test' }, security: { policy: 'engine-session' }, attachments: [] })
let fixture: string, file: string
const stores: NextTurnQueueSqliteExperiment[] = [], children: Array<{ child: ChildProcess; completion: Promise<void> }> = []
function create() { const store = new NextTurnQueueSqliteExperiment(file, { nativeExperimentOnly: true }); stores.push(store); return store }
async function finish(store: NextTurnQueueSqliteExperiment, revision: number, id: string) {
  const enqueued = await store.mutate(scope, revision, 'enqueue-' + id, { kind: 'enqueue', id, envelope: envelope(id), at: 1 }, () => {})
  const claimed = await store.mutate(scope, revision + 1, 'claim-' + id, { kind: 'claim', id, entryRevision: 1, frozen: { requestKey: 'key-' + id, bodyDigest: 'a'.repeat(64), entryRevision: 1, anchor: null, wireBody: '{"synthetic":"wire-' + id + '"}' }, at: 2 }, () => {})
  const accepted = await store.mutate(scope, claimed.state.revision, 'accepted-' + id, { kind: 'accepted', id, receipt: { runId: 'run-' + id, turnId: 'turn-' + id, userMessageId: 'user-' + id, assistantMessageId: 'anchor-' + id }, at: 3 }, () => {})
  const mutation = { kind: 'terminal' as const, id, outcome: 'succeeded' as const, at: 4 }, exactTerminal = applyNextTurnQueueMutation(accepted.state, accepted.state.revision, mutation).entries[0]
  const terminal = await store.mutate(scope, accepted.state.revision, 'terminal-' + id, mutation, () => {})
  return { enqueued, terminal, exactTerminal }
}
interface Message { type: string; ok?: boolean; error?: { code: string }; result?: { state: { revision: number } }; closeJoined?: boolean }
function worker(config: Record<string, unknown>) {
  const child = fork(join(__dirname, 'fixtures/next-turn-sqlite-worker.cjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }), messages: Message[] = [], waiters: Array<{ type: string; resolve: (message: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  let stderr = ''; child.stderr?.on('data', data => { stderr += String(data) })
  const completion = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => { for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('closed before signal: ' + stderr)) }; waiters.length = 0; done() }) }); children.push({ child, completion })
  child.on('message', (message: Message) => { const index = waiters.findIndex(waiter => waiter.type === message.type); if (index < 0) messages.push(message); else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) } })
  const wait = (type: string): Promise<Message> => { const index = messages.findIndex(message => message.type === type); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]); return new Promise((done, reject) => { const waiter = { type, resolve: done, reject, timer: setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('worker signal timeout: ' + stderr)) }, 15000) }; waiters.push(waiter) }) }
  child.send({ type: 'start', file, scope, ...config }); return { child, completion, wait, release: () => child.send({ type: 'release' }) }
}
test.beforeEach(async () => { const base = resolve('.e2e-tmp'); await fs.mkdir(base, { recursive: true }); fixture = await fs.mkdtemp(join(base, 'native-sqlite-owned-')); file = join(fixture, 'queue.sqlite') })
test.afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const { child, completion } of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await completion }
  const actual = await fs.realpath(fixture), boundary = resolve('.e2e-tmp'), relation = relative(boundary, actual)
  if (!relation || relation === '..' || relation.startsWith('..' + sep) || resolve(actual) === boundary) throw new Error('native cleanup boundary')
  await fs.rm(actual, { recursive: true, force: true }); await expect(fs.stat(actual)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('native transactional archive and 5504 revisions preserve earliest exact ACK beyond former 5000 event ceiling', async () => {
  // This is a durability measurement; the separate 440-revision test asserts the original 120s gate.
  test.setTimeout(360000)
  const store = create(), started = performance.now(), first = await finish(store, 0, 'earliest')
  expect(first.terminal.state.entries).toEqual([]); expect((await store.findArchived(scope, 'earliest'))?.entry).toEqual(first.exactTerminal)
  for (let revision = 4; revision < 5504; revision++) await store.mutate(scope, revision, 'pause-' + revision, { kind: 'pause', reason: 'synthetic continued work' }, () => {})
  const writingMs = performance.now() - started, statistics = await store.diagnostics(scope)
  expect(statistics.revision).toBe(5504); expect(statistics.events).toBeLessThanOrEqual(512); expect(statistics.eventBytes).toBeLessThanOrEqual(8 * 1024 * 1024); expect(statistics.packagedRuntimeVerified).toBe(false)
  await store.close(); const restarting = performance.now(), restarted = create(), restartMs = performance.now() - restarting
  expect(await restarted.findCommitted(scope, 'enqueue-earliest')).toEqual({ state: first.enqueued.state, receipt: first.enqueued.receipt })
  const replay = await restarted.mutate(scope, 0, 'enqueue-earliest', { kind: 'enqueue', id: 'earliest', envelope: envelope('earliest'), at: 1 }, () => {})
  expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.enqueued.receipt); expect(replay.state.revision).toBe(5504)
  await expect(restarted.mutate(scope, 5504, 'reuse-id', { kind: 'enqueue', id: 'earliest', envelope: envelope('changed'), at: 5 }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' })
  console.log(JSON.stringify({ kind: 'owned-native-sqlite-measurement', runtime: process.versions.node, packaged: false, revisions: 5504, writingMs, restartMs, events: statistics.events, eventBytes: statistics.eventBytes }))
})

test('native 110 actual terminal turns complete within original 120 second gate with exact retained archive', async () => {
  test.setTimeout(120000)
  const store = create(), started = performance.now(), first = await finish(store, 0, 'turn-0'); let state = first.terminal.state
  for (let index = 1; index < 110; index++) { state = (await finish(store, state.revision, 'turn-' + index)).terminal.state; expect(state.entries).toEqual([]) }
  const elapsedMs = performance.now() - started
  expect(state.revision).toBe(440); expect(elapsedMs).toBeLessThan(120000); expect((await store.findArchived(scope, 'turn-0'))?.entry).toEqual(first.exactTerminal)
  await store.close(); const restarted = create(); expect((await restarted.read(scope)).state).toEqual(state); expect(await restarted.findReceipt(scope, 'enqueue-turn-0')).toEqual(first.enqueued.receipt)
  console.log(JSON.stringify({ kind: 'owned-native-terminal-measurement', packaged: false, turns: 110, revisions: 440, elapsedMs }))
})

test('storage port service lifecycle uses real native store and close remains explicit', async () => {
  const store = create(), service = new NextTurnQueueMutationService(store, { capture: async taskId => ({ scope: { ...scope, taskId }, generation: 'trusted' }), assertCurrent: () => {} }), cap = await service.bind(scope.taskId)
  const result = await service.mutate(cap, 0, 'port-enqueue', { kind: 'enqueue', id: 'port-entry', envelope: envelope('port-entry'), at: 1 })
  expect((await service.read(cap)).state).toEqual(result.state); await service.close(); expect(service.diagnostics().ownedOperations).toBe(0)
  await store.close(); await expect(store.read(scope)).rejects.toMatchObject({ code: 'AUTHORITY' })
})

for (const phase of ['before-commit', 'after-commit'] as const) {
  test('actual native child kill at ' + phase + ' preserves whole transaction and exact ACK', async () => {
    const store = create(); const initial = await store.mutate(scope, 0, 'initial-pause', { kind: 'pause', reason: 'initial' }, () => {}); await store.close()
    const held = worker({ expectedRevision: 1, operationId: 'kill-pause', operation: { kind: 'pause', reason: 'new' }, holdAt: phase }); await held.wait('barrier'); held.child.kill('SIGKILL'); await held.completion
    const restarted = create(), state = (await restarted.read(scope)).state
    if (phase === 'after-commit') { expect(state.revision).toBe(2); expect(state.pauseReason).toBe('new'); expect(await restarted.findReceipt(scope, 'kill-pause')).not.toBeNull() }
    else { expect(state).toEqual(initial.state); expect(await restarted.findReceipt(scope, 'kill-pause')).toBeNull() }
  })
}

test('two actual native owners arbitrate one revision and discover foreign committed prefix', async () => {
  const initial = create(); await initial.mutate(scope, 0, 'initial-pause', { kind: 'pause', reason: 'initial' }, () => {}); await initial.close()
  const a = worker({ expectedRevision: 1, operationId: 'a', operation: { kind: 'pause', reason: 'a' }, holdAt: 'before-transaction' }), b = worker({ expectedRevision: 1, operationId: 'b', operation: { kind: 'pause', reason: 'b' }, holdAt: 'before-transaction' })
  await Promise.all([a.wait('barrier'), b.wait('barrier')]); a.release(); const won = await a.wait('result'); await a.completion; b.release(); const lost = await b.wait('result'); await b.completion
  expect(won.ok).toBe(true); expect(won.closeJoined).toBe(true); expect(lost.ok).toBe(false); expect(lost.error?.code).toBe('CAS'); expect(lost.closeJoined).toBe(true)
  const owner1 = create(), owner2 = create(); await owner1.mutate(scope, 2, 'owner1-next', { kind: 'pause', reason: 'next' }, () => {}); expect((await owner2.read(scope)).state.revision).toBe(3)
})

test('unknown and accepted admission survive native rotation, clear and actual restart without abandonment shortcut', async () => {
  const store = create(), first = await finish(store, 0, 'done')
  let result = await store.mutate(scope, first.terminal.state.revision, 'enqueue-protected', { kind: 'enqueue', id: 'protected', envelope: envelope('protected'), at: 10 }, () => {})
  result = await store.mutate(scope, result.state.revision, 'claim-protected', { kind: 'claim', id: 'protected', entryRevision: 1, frozen: { requestKey: 'fixed-key', bodyDigest: 'b'.repeat(64), entryRevision: 1, anchor: null, wireBody: '{"synthetic":"fixed-wire"}' }, at: 11 }, () => {})
  result = await store.mutate(scope, result.state.revision, 'unknown-protected', { kind: 'admission-unknown', id: 'protected', reason: 'uncertain', at: 12 }, () => {})
  const unknown = result.state.entries[0]
  for (let i = 0; i < 20; i++) result = await store.mutate(scope, result.state.revision, 'unknown-rotate-' + i, { kind: 'clear-pending', at: 13 + i }, () => {})
  expect(result.state.entries[0]).toEqual(unknown); expect(await store.findArchived(scope, 'protected')).toBeNull(); await store.close()
  const restarted = create(); expect((await restarted.read(scope)).state).toEqual(result.state)
  await expect(restarted.mutate(scope, result.state.revision, 'fake-abandon', { kind: 'terminal', id: 'protected', outcome: 'cancelled', at: 40 }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' })
  result = await restarted.mutate(scope, result.state.revision, 'accept-protected', { kind: 'accepted', id: 'protected', receipt: { runId: 'run-protected', turnId: 'turn-protected', userMessageId: 'user-protected', assistantMessageId: 'anchor-protected' }, at: 41 }, () => {})
  const accepted = result.state.entries[0]; result = await restarted.mutate(scope, result.state.revision, 'clear-accepted', { kind: 'clear-pending', at: 42 }, () => {}); expect(result.state.entries[0]).toEqual(accepted); expect(await restarted.findArchived(scope, 'protected')).toBeNull()
})

test('native operation corruption fails real restart instead of empty state', async () => {
  const store = create(); await finish(store, 0, 'corrupt'); await store.close()
  const db = new DatabaseSync(file); db.exec("DROP TRIGGER immutable_operation_update; UPDATE operation SET record_json='{}' WHERE revision=1"); db.close()
  expect(() => create()).toThrow(/checksum|proof|prefix/)
})

test('native missing acknowledged operation fails real restart rather than reporting absent ACK', async () => {
  const store = create(); await finish(store, 0, 'missing'); await store.close()
  const db = new DatabaseSync(file); db.exec('DROP TRIGGER immutable_operation_delete; DELETE FROM operation WHERE revision=1'); db.close()
  expect(() => create()).toThrow(/gap|prefix|counts/)
})

test('native archive lookup verifies exact committed proof after checksum-valid receipt corruption', async () => {
  const store = create(); await finish(store, 0, 'archive-proof')
  const db = new DatabaseSync(file); db.exec('DROP TRIGGER immutable_archive_update')
  const row = db.prepare('SELECT receipt_json FROM archive').get(), bad = JSON.parse(String(row?.receipt_json)); bad.operationId = 'different-operation'
  const bytes = JSON.stringify(bad)
  const { createHash } = await import('node:crypto')
  db.prepare('UPDATE archive SET receipt_json=?,receipt_digest=?').run(bytes, createHash('sha256').update(bytes).digest('hex')); db.close()
  await expect(store.findArchived(scope, 'archive-proof')).rejects.toMatchObject({ code: 'CORRUPT' })
})

test('native recent byte window rotates while exact immutable ledger remains larger', async () => {
  const custom = { ...DEFAULT_NEXT_TURN_QUEUE_LIMITS, maxJournalBytes: 1024, maxRevisions: 10 }, store = new NextTurnQueueSqliteExperiment(file, { nativeExperimentOnly: true, limits: custom }); stores.push(store)
  const first = await store.mutate(scope, 0, 'earliest', { kind: 'pause', reason: 'one' }, () => {})
  for (let revision = 1; revision < 100; revision++) await store.mutate(scope, revision, 'op-' + revision, { kind: 'pause', reason: 'continued' }, () => {})
  const stats = await store.diagnostics(scope); expect(stats.events).toBeLessThanOrEqual(10); expect(stats.eventBytes).toBeLessThanOrEqual(1024); expect(await store.findReceipt(scope, 'earliest')).toEqual(first.receipt)
  await store.close(); const db = new DatabaseSync(file, { readOnly: true }); const ledger = db.prepare('SELECT COUNT(*) AS count,SUM(LENGTH(record_json)) AS bytes FROM operation').get(); expect(ledger?.count).toBe(100); expect(Number(ledger?.bytes)).toBeGreaterThan(1024); db.close()
})

test('owned native close joins held transaction and rolls back before connection close', async () => {
  let reached!: () => void, release!: () => void
  const barrier = new Promise<void>(done => { reached = done }), held = new Promise<void>(done => { release = done })
  const store = new NextTurnQueueSqliteExperiment(file, { nativeExperimentOnly: true, testHook: async phase => { if (phase === 'before-commit') { reached(); await held } } }); stores.push(store)
  const operation = store.mutate(scope, 0, 'held', { kind: 'pause', reason: 'held' }, () => {}), rejected = expect(operation).rejects.toMatchObject({ code: 'AUTHORITY' })
  await barrier; let joined = false; const closing = store.close().then(() => { joined = true }); await Promise.resolve(); expect(joined).toBe(false); release(); await rejected; await closing
  const restarted = create(); expect((await restarted.read(scope)).state.revision).toBe(0); expect(await restarted.findReceipt(scope, 'held')).toBeNull()
})
