import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), boundary = join(root, '.e2e-tmp')
mkdirSync(boundary, { recursive: true })
const folder = mkdtempSync(join(boundary, 'code-intent-contract-')), bundle = join(folder, 'contracts.cjs')
const modules = ['code-queue-intent', 'code-queue-entry', 'useCodeNextTurnQueue', 'source']
await build({ stdin: { contents: [...modules.map(name => `export * from ${JSON.stringify(join(root, 'src/renderer/src/core/engine', name + '.ts'))}`),
  `export * from ${JSON.stringify(join(root, 'src/renderer/src/contrib/chat/draft-store.ts'))}`,
  ...['work-next-turn-owner', 'next-turn-queue-store'].map(name => `export * from ${JSON.stringify(join(root, 'src/main', name + '.ts'))}`)].join('\n'), resolveDir: root, loader: 'ts' }, outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', external: ['react'], alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') } })
const require = createRequire(import.meta.url), module = require(bundle), { act, createElement } = require('react')
const { JSDOM } = createRequire(join(root, '../ai-agent-engine/package.json'))('jsdom')
const scope = { source: { mode: 'embedded', endpoint: '', accountId: 'test-account' }, tenantId: 'test-tenant', namespace: { id: 'test-db', generation: 'one' }, owner: 'code', taskId: 'code-session' }
const empty = () => ({ schemaVersion: 1, scope: structuredClone(scope), revision: 0, paused: false, entries: [], removed: [] })
const submission = (text = 'authored original') => ({ draft: { text, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: 'model' },
  resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'inherit' } }, thinking: { kind: 'on' }, code: { workspacePaths: [] }, attachments: [] })
const enqueue = (operationId = 'operation', text) => ({ kind: 'enqueue', expectedRevision: 0, operationId, id: 'item-' + operationId, submission: submission(text) })
const receipt = action => ({ operationId: action.operationId, revision: action.expectedRevision + 1 })
function memoryStorage() {
  const data = new Map()
  return { get length() { return data.size }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
let dom, mounted, hook, originalGlobals, ipc, listeners
function Probe({ taskId = scope.taskId, source = module.getEngineSource(), observe } = {}) {
  hook = module.useCodeNextTurnQueue(taskId, source, true)
  observe?.(hook)
  return null
}
async function mount(backend, storage = memoryStorage()) {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid' }); originalGlobals = new Map(); ipc = backend
  listeners = new Set()
  dom.window.aether = { codeQueue: { invoke: request => ipc(request), onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) } } }
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  module.publishEngineSource({ mode: 'embedded', baseUrl: 'http://localhost:12345', instanceId: 'test-instance', phase: 'ready', accountId: 'test-account' })
  await remount()
  return storage
}
async function remount() {
  if (mounted) await act(async () => mounted.unmount())
  const { createRoot } = require('react-dom/client'); mounted = createRoot(document.getElementById('root'))
  await act(async () => mounted.render(createElement(Probe)))
}
afterEach(async () => {
  if (mounted) await act(async () => mounted.unmount()); mounted = null; dom?.window.close(); dom = null
  for (const [name, descriptor] of originalGlobals ?? []) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  originalGlobals = null
})
after(() => { if (dirname(folder) !== boundary || !basename(folder).startsWith('code-intent-contract-')) throw new Error('fixture boundary'); rmSync(folder, { recursive: true, force: true }) })

test('real owned IPC and journal return a first enqueue ACK despite canonical scope key ordering', async () => {
  let handler
  const replies = [], controller = new AbortController(), stateDirectory = join(folder, 'real-owned-journal')
  const snapshot = { mode: 'embedded', baseUrl: 'http://localhost:12345', instanceId: 'test-instance', phase: 'ready', accountId: 'test-account' }
  const owner = module.createWorkNextTurnOwner({
    store: new module.NextTurnQueueStore(stateDirectory),
    engine: { snapshot: () => snapshot, signal: () => controller.signal, subscribe: () => () => {} },
    ipc: { handle: (channel, listener) => { assert.equal(channel, 'code:next-turn-queue'); handler = listener }, removeHandler: () => {} },
    clock: { now: () => 0, schedule: () => 1, cancel: () => {} },
    gateway: {
      capture: async taskId => ({ scope: { ...structuredClone(scope), taskId }, generation: 'one' }), assertCurrent: () => {},
      context: async () => ({ root: { status: 'running' } }),
      envelope: async (target, draft) => ({ ...draft, workspace: { kind: 'local-scratch', identity: 'session:' + target.taskId },
        agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' } }),
      prepare: async () => { throw new Error('running root must not dispatch') },
      submit: async () => { throw new Error('running root must not dispatch') }
    }
  }, 'code')
  try {
    const storage = await mount(async input => {
      // The preload is a transparent IPC result forwarder; clone both crossing values.
      const reply = structuredClone(await handler({ sender: { isDestroyed: () => false } }, structuredClone(input)))
      replies.push(reply); return reply
    })
    await act(async () => { await hook.refresh() })
    const beforeKeys = Object.keys(hook.state.scope)
    await act(async () => { await hook.enqueue(submission('first real journal commit')) })
    assert.equal(hook.error, null); assert.equal(hook.queue[0].text, 'first real journal commit')
    const reply = replies.find(value => value.ok && value.value.receipt)
    assert.ok(reply); assert.equal(reply.value.receipt.revision, 1)
    assert.notDeepEqual(Object.keys(reply.value.state.scope), beforeKeys, 'actual journal canonicalization changes insertion order')
    const confirmed = module.readCodeQueueIntents(storage, scope)
    assert.equal(confirmed.length, 1); assert.equal(confirmed[0].status, 'confirmed')
    assert.equal(confirmed[0].confirmation.operationId, reply.value.receipt.operationId)
    await act(async () => { await hook.refresh() })
    assert.equal(hook.state.revision, 1); assert.equal(hook.queue.length, 1)
  } finally { await owner.close() }
})

test('changing engine source with the same session hides old queue on the first render before effects', async () => {
  const original = { ...empty(), revision: 1, entries: [{ id: 'old-entry', phase: 'pending', revision: 1, createdAt: 1, updatedAt: 1,
    envelope: { ...submission('old source private draft'), workspace: { kind: 'local-scratch', identity: 'session:' + scope.taskId },
      agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' } } }] }
  let finishRemote
  await mount(async ({ expectedEngine }) => {
    if (expectedEngine.mode === 'embedded') return { ok: true, value: { state: original } }
    return new Promise(resolve => { finishRemote = resolve })
  })
  assert.equal(hook.queue[0].text, 'old source private draft')
  module.publishEngineSource({ mode: 'remote', baseUrl: 'https://second.invalid', instanceId: 'remote', phase: 'ready', accountId: 'remote-account' })
  const observed = []
  await act(async () => mounted.render(createElement(Probe, { observe: value => {
    let snapshotError = ''
    try { value.consumeConfirmedEnqueue(submission()) } catch (cause) { snapshotError = cause.message }
    observed.push({ queue: value.queue, ready: value.ready, state: value.state, snapshotError })
  } })))
  assert.deepEqual(observed[0].queue, []); assert.equal(observed[0].ready, false); assert.equal(observed[0].state, null)
  assert.match(observed[0].snapshotError, /队列正在恢复/)
  const remote = { ...empty(), scope: { ...scope, source: { mode: 'remote', endpoint: 'https://second.invalid', accountId: 'remote-account' } } }
  await act(async () => { finishRemote({ ok: true, value: { state: remote } }) })
  assert.equal(hook.ready, true); assert.deepEqual(hook.state.scope.source, remote.scope.source)
})

test('late A read cannot overwrite a fresh A visit after A to B to A', async () => {
  let finishOld, hold = false
  await mount(async ({ taskId }) => {
    if (hold) { hold = false; return new Promise(resolve => { finishOld = resolve }) }
    return { ok: true, value: { state: { ...empty(), scope: { ...scope, taskId } } } }
  })
  let oldRead
  await act(async () => { hold = true; oldRead = hook.refresh(); await Promise.resolve() })
  await act(async () => mounted.render(createElement(Probe, { taskId: 'session-B' })))
  assert.equal(hook.state.scope.taskId, 'session-B')
  await act(async () => mounted.render(createElement(Probe)))
  assert.equal(hook.state.revision, 0)
  await act(async () => { finishOld({ ok: true, value: { state: { ...empty(), revision: 99, paused: true } } }); await oldRead })
  assert.equal(hook.state.revision, 0); assert.equal(hook.paused, false); assert.equal(hook.error, null)
})

test('late ACK removes only its operation, never a newer intent from the same session', () => {
  const storage = memoryStorage(), old = module.saveCodeQueueIntent(storage, scope, enqueue('old'))
  module.rejectCodeQueueIntent(storage, old, Object.assign(new Error('版本冲突'), { code: 'CAS' }))
  const fresh = module.saveCodeQueueIntent(storage, scope, enqueue('new', 'new user request'))
  module.acknowledgeCodeQueueIntent(storage, old, { receipt: receipt(old.action) })
  assert.deepEqual(module.readCodeQueueIntents(storage, scope).find(item => item.status === 'pending'), fresh)
  assert.equal(module.readCodeQueueIntents(storage, scope).find(item => item.status === 'rejected').action.submission.draft.text, 'authored original')
})
test('unresolved intent and wrong ACK cannot silently permit a new operation', () => {
  const storage = memoryStorage(), saved = module.saveCodeQueueIntent(storage, scope, enqueue())
  assert.throws(() => module.saveCodeQueueIntent(storage, scope, enqueue('new')), /尚未确认/)
  assert.throws(() => module.acknowledgeCodeQueueIntent(storage, saved, { receipt: { operationId: 'another', revision: 1 } }), /回执不完整/)
  assert.equal(module.rejectCodeQueueIntent(storage, saved, Object.assign(new Error('未知写入结果'), { code: 'IO' })), false)
  assert.deepEqual(module.readCodeQueueIntents(storage, scope), [saved])
  assert.deepEqual(module.readCodeQueueIntents(storage, { ...scope, source: { ...scope.source, accountId: 'other-account' } }), [])
})

test('CAS append rebase persists the same identity with the latest revision before retrying IPC', async () => {
  const actions = []; let revision = 0, storage
  storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: { ...empty(), revision } } }
    actions.push(structuredClone(action))
    const pending = module.readCodeQueueIntents(storage, scope).find(intent => intent.status === 'pending')
    assert.deepEqual(pending.action, action, 'disk intent must precede every enqueue IPC, including rebase')
    if (actions.length === 1) { revision = 4; return { ok: false, code: 'CAS', message: 'Queue revision changed' } }
    return { ok: true, value: { state: { ...empty(), revision: ++revision }, receipt: receipt(action) } }
  })
  await act(async () => { await hook.enqueue(submission()) })
  assert.equal(actions.length, 2); assert.deepEqual(actions[1], { ...actions[0], expectedRevision: 4 })
  const intents = module.readCodeQueueIntents(storage, scope)
  assert.equal(intents.length, 1); assert.equal(intents[0].status, 'confirmed'); assert.equal(intents[0].confirmation.revision, 5)
  assert.equal(hook.error, null)
})

test('lost ACK after CAS rebase reloads the rebased intent exactly and commits only once', async () => {
  const actions = [], ledger = new Map(); let revision = 0, commits = 0
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: { ...empty(), revision } } }
    actions.push(structuredClone(action))
    if (actions.length === 1) { revision = 3; return { ok: false, code: 'CAS', message: 'Queue revision changed' } }
    if (!ledger.has(action.operationId)) { ledger.set(action.operationId, receipt(action)); revision++; commits++; throw new Error('lost rebased ACK') }
    return { ok: true, value: { state: { ...empty(), revision }, receipt: ledger.get(action.operationId) } }
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /原操作与草稿已保留/) })
  assert.equal(actions.length, 2); assert.equal(commits, 1)
  const pending = module.readCodeQueueIntents(storage, scope)[0]
  assert.equal(pending.status, 'pending'); assert.equal(pending.action.expectedRevision, 3)
  await remount()
  assert.equal(actions.length, 3); assert.deepEqual(actions[2], actions[1]); assert.equal(commits, 1)
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed')
  await act(async () => { await hook.enqueue(submission()) })
  assert.equal(commits, 1); assert.equal(actions.length, 3)
})

test('rebase storage failure sends no new IPC and keeps the definite rejection and authored draft', async () => {
  let revision = 0, appends = 0, storage
  storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: { ...empty(), revision } } }
    appends++; revision = 3; return { ok: false, code: 'CAS', message: 'Queue revision changed' }
  })
  const original = storage.setItem
  storage.setItem = (key, value) => {
    const intent = JSON.parse(value)
    if (intent.status === 'pending' && intent.action.expectedRevision === 3) throw new Error('quota exceeded')
    original(key, value)
  }
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /原操作与草稿已保留/) })
  assert.equal(appends, 1)
  const rejected = module.readCodeQueueIntents(storage, scope)[0]
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.rejection.code, 'CAS'); assert.equal(rejected.action.expectedRevision, 0)
  assert.deepEqual(rejected.action.submission, submission())
})

test('unknown, non-CAS, edits and late superseded intents cannot be rebased', () => {
  const storage = memoryStorage(), old = module.saveCodeQueueIntent(storage, scope, enqueue('old'))
  assert.throws(() => module.rebaseCodeQueueEnqueueIntent(storage, old, 3), /尚未确认未提交/)
  module.rejectCodeQueueIntent(storage, old, { code: 'INVALID' })
  assert.throws(() => module.rebaseCodeQueueEnqueueIntent(storage, old, 3), /尚未确认未提交/)
  const edit = module.saveCodeQueueIntent(storage, scope, { kind: 'mutate', operationId: 'edit', expectedRevision: 0, operation: { kind: 'pause', reason: 'test' } })
  module.rejectCodeQueueIntent(storage, edit, { code: 'CAS' })
  assert.throws(() => module.rebaseCodeQueueEnqueueIntent(storage, edit, 3), /尚未确认未提交/)
  const prior = module.saveCodeQueueIntent(storage, scope, enqueue('prior'))
  module.rejectCodeQueueIntent(storage, prior, { code: 'CAS' })
  const newer = module.saveCodeQueueIntent(storage, scope, enqueue('newer', 'new text'))
  assert.throws(() => module.rebaseCodeQueueEnqueueIntent(storage, prior, 3), /另一项队列操作尚未确认/)
  assert.deepEqual(module.readCodeQueueIntents(storage, scope).find(intent => intent.status === 'pending'), newer)
})

test('append CAS retry budget is bounded and other mutations are never rebased', async () => {
  const actions = []; let revision = 0
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: { ...empty(), revision } } }
    actions.push(structuredClone(action)); revision++; return { ok: false, code: 'CAS', message: 'Queue revision changed' }
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /队列已更新，原稿已保留，请重试/) })
  assert.deepEqual(actions.map(action => action.expectedRevision), [0, 1, 2]); assert.equal(new Set(actions.map(action => action.operationId)).size, 1)
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'rejected')
  await act(async () => { await assert.rejects(hook.pause(), { code: 'CAS' }) })
  assert.equal(actions.length, 4); assert.equal(actions[3].kind, 'mutate')
})

test('failed read after a definite CAS never resends and keeps original rejection', async () => {
  let reads = 0, appends = 0
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') { if (++reads === 2) throw new Error('read unavailable'); return { ok: true, value: { state: empty() } } }
    appends++; return { ok: false, code: 'CAS', message: 'Queue revision changed' }
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /原操作与草稿已保留/) })
  assert.equal(appends, 1); assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'rejected')
})
test('lost enqueue ACK is replayed on reload with original IDs/body and exactly one backend commit', async () => {
  let state = empty(), first = true, commits = 0; const actions = [], ledger = new Map()
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: structuredClone(state) } }
    actions.push(structuredClone(action))
    if (!ledger.has(action.operationId)) { commits++; state.revision++; ledger.set(action.operationId, receipt(action)) }
    if (first) { first = false; throw new Error('lost IPC acknowledgement') }
    return { ok: true, value: { state: structuredClone(state), receipt: ledger.get(action.operationId), replayed: true, durabilityWarnings: [] } }
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /原操作与草稿已保留/) })
  assert.equal(module.readCodeQueueIntents(storage, scope).filter(item => item.status === 'pending').length, 1)
  await remount()
  assert.equal(commits, 1); assert.equal(actions.length, 2); assert.deepEqual(actions[1], actions[0])
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed'); assert.equal(hook.ready, true)
  // useChat.send refreshes before retrying the still-visible composer draft.
  await act(async () => { await hook.refresh(); await hook.enqueue(submission()) })
  assert.equal(commits, 1); assert.equal(actions.length, 2); assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed')
  const edited = submission(); edited.draft.revision++
  await act(async () => { await hook.enqueue(edited) })
  assert.equal(commits, 2); assert.equal(actions.at(-1).submission.draft.text, 'authored original')
  assert.equal(module.readCodeQueueIntents(storage, scope).length, 1, 'new durable revision prunes older confirmed receipt')
})
test('reload after main commit notification but before IPC ACK retains a receipt through repeated composer matching', async () => {
  let state = empty(), finishFirst, commits = 0; const actions = [], ledger = new Map()
  const original = submission('same text deliberately retained'); original.draft.revision = 8675309
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: structuredClone(state) } }
    actions.push(structuredClone(action))
    if (!ledger.has(action.operationId)) {
      commits++; state.revision++; ledger.set(action.operationId, receipt(action))
      for (const listener of listeners) listener({ scope, revision: state.revision })
      if (commits === 1) await new Promise(resolve => { finishFirst = resolve })
    }
    return { ok: true, value: { state: structuredClone(state), receipt: ledger.get(action.operationId), replayed: true, durabilityWarnings: [] } }
  })
  module.saveChatDraftForSubmission(scope.taskId, original.draft.text, 'source', [], original.draft.revision)
  let pending
  await act(async () => { pending = hook.enqueue(original); await Promise.resolve() })
  assert.equal(commits, 1); assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'pending')
  await remount()
  const restored = module.loadChatDraftState(scope.taskId, 'source')
  assert.equal(restored.revision, original.draft.revision)
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed')
  await act(async () => { finishFirst(); await assert.rejects(pending, /会话已切换/) })
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed', 'old late ACK must not erase the recovery receipt')
  await act(async () => { await hook.refresh() })
  assert.equal(hook.consumeConfirmedEnqueue({ ...original, draft: { ...original.draft, revision: restored.revision } }), true)
  assert.equal(hook.consumeConfirmedEnqueue(original), true)
  assert.equal(commits, 1); assert.deepEqual(actions[1], actions[0])
  const clearedRevision = module.saveChatDraft(scope.taskId, '', 'source')
  const newRevision = module.saveChatDraft(scope.taskId, original.draft.text, 'source', [], clearedRevision + 1)
  const explicitNewDraft = { ...original, draft: { ...original.draft, revision: newRevision } }
  assert.equal(hook.consumeConfirmedEnqueue(explicitNewDraft), false)
  await act(async () => { await hook.enqueue(explicitNewDraft) })
  assert.equal(commits, 2)
})
test('normal enqueue ACK survives crash before composer clear and cannot duplicate the authored revision', async () => {
  let state = empty(), commits = 0
  const original = submission('normal acknowledged draft')
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: structuredClone(state) } }
    commits++; state.revision++
    return { ok: true, value: { state: structuredClone(state), receipt: receipt(action), replayed: false, durabilityWarnings: [] } }
  })
  await act(async () => { await hook.enqueue(original) })
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].status, 'confirmed')
  await remount()
  assert.equal(hook.consumeConfirmedEnqueue(original), true)
  await remount()
  await act(async () => { await hook.enqueue(original) })
  assert.equal(commits, 1)
  const newer = { ...original, draft: { ...original.draft, revision: original.draft.revision + 1 } }
  await act(async () => { await hook.enqueue(newer) })
  assert.equal(commits, 2)
  assert.equal(module.readCodeQueueIntents(storage, scope).length, 1)
  assert.equal(module.readCodeQueueIntents(storage, scope)[0].action.submission.draft.revision, newer.draft.revision)
})
for (const action of [
  { kind: 'replace-submission', id: 'pending', entryRevision: 2, submission: submission('edited') },
  { kind: 'retarget-model', entries: [{ id: 'pending', entryRevision: 2 }], model: { kind: 'explicit', modelId: 'new-model' } },
  { kind: 'merge-pending', entries: [{ id: 'a', entryRevision: 2 }, { id: 'b', entryRevision: 1 }], id: 'merged-original-id' },
  ...[{ kind: 'pause', reason: '用户暂停' }, { kind: 'resume' }, { kind: 'move', id: 'a', beforeId: 'b' }, { kind: 'remove', id: 'a', entryRevision: 2, at: 12345 }, { kind: 'clear-pending', at: 6789 }].map(operation => ({ kind: 'mutate', operation }))
]) test(`reload replays exact authorized ${action.kind}${action.operation ? '/' + action.operation.kind : ''} command`, async () => {
  const storage = memoryStorage(), command = { ...action, operationId: 'original-operation', expectedRevision: 4 }
  module.saveCodeQueueIntent(storage, scope, command)
  const actions = [], state = { ...empty(), revision: 5 }
  await mount(async ({ action: received }) => {
    if (received.kind === 'read') return { ok: true, value: { state } }
    actions.push(structuredClone(received)); return { ok: true, value: { state, receipt: receipt(received), replayed: true, durabilityWarnings: [] } }
  }, storage)
  assert.deepEqual(actions, [command]); assert.deepEqual(module.readCodeQueueIntents(storage, scope), [])
})
test('a new explicit request cannot replace unknown intent; a definite rejection retains original draft and permits the next request', async () => {
  const actions = []; let mode = 'unknown', state = empty()
  const storage = await mount(async ({ action }) => {
    if (action.kind === 'read') return { ok: true, value: { state: structuredClone(state) } }
    actions.push(structuredClone(action))
    if (mode === 'unknown') throw new Error('确认结果未知')
    if (mode === 'reject') return { ok: false, code: 'CAS', message: '队列已变化，本次未保存' }
    state.revision++; return { ok: true, value: { state: structuredClone(state), receipt: receipt(action), replayed: false, durabilityWarnings: [] } }
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission('old intent')), /未知/) })
  await act(async () => { await assert.rejects(hook.enqueue(submission('new intent')), /未知/) })
  assert.equal(new Set(actions.map(action => action.operationId)).size, 1)
  mode = 'reject'; await act(async () => { await hook.refresh() })
  const rejected = module.readCodeQueueIntents(storage, scope).find(item => item.status === 'rejected')
  assert.equal(rejected.action.submission.draft.text, 'old intent')
  mode = 'accept'; await act(async () => { await hook.enqueue(submission('new intent')) })
  assert.equal(actions.at(-1).submission.draft.text, 'new intent'); assert.notEqual(actions.at(-1).operationId, rejected.action.operationId)
  assert.equal(module.readCodeQueueIntents(storage, scope).filter(item => item.status === 'pending').length, 0)
  assert.equal(module.readCodeQueueIntents(storage, scope).find(item => item.status === 'rejected').action.submission.draft.text, 'old intent')
})
test('textarea edits retain provably unchanged chips without promoting newly typed matching tokens', () => {
  const entry = { id: 'entry', phase: 'pending', revision: 1, createdAt: 1, updatedAt: 1, envelope: { ...submission(),
    draft: { text: 'lead @a.txt tail', revision: 1, mentions: [{ source: 'file', path: 'a.txt', displayText: '@a.txt', textOffset: 5 }] },
    workspace: { kind: 'local-scratch', identity: 'session:code-session' }, agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' } } }
  assert.deepEqual(module.editCodeQueueDraft(entry, 'lead tail @a.txt', []).draft.mentions, [])
  assert.equal(module.editCodeQueueDraft(entry, '@a.txt lead @a.txt tail', []).draft.mentions[0].textOffset, 12)
  assert.equal(module.editCodeQueueDraft(entry, 'new lead @a.txt tail', []).draft.mentions[0].textOffset, 9)
  assert.deepEqual(module.editCodeQueueDraft(entry, 'lead @b.txt tail', []).draft.mentions, [])
  assert.deepEqual(module.editCodeQueueDraft(entry, 'lead @a.txt tail', []).draft.mentions, entry.envelope.draft.mentions)
})
test('draft store restores exact revision, gives cleared/retyped text a new identity, and strict submission refuses storage failure', async () => {
  const storage = await mount(async () => ({ ok: true, value: { state: empty() } }))
  module.saveChatDraftForSubmission('draft', 'same text', 'source', [], 12345)
  assert.deepEqual(module.loadChatDraftState('draft', 'source'), { text: 'same text', mentions: [], revision: 12345 })
  const cleared = module.saveChatDraft('draft', '', 'source', [], 12345)
  assert.ok(cleared > 12345); assert.equal(module.loadChatDraftState('draft', 'source').revision, cleared)
  const retyped = module.saveChatDraft('draft', 'same text', 'source', [], cleared + 1)
  assert.equal(retyped, cleared + 1); assert.equal(module.loadChatDraftState('draft', 'source').revision, retyped)
  const original = storage.setItem; storage.setItem = () => { throw new Error('quota exceeded') }
  assert.throws(() => module.saveChatDraftForSubmission('draft', 'new draft', 'source', [], retyped + 1), /尚未发送/)
  storage.setItem = original
  assert.equal(module.loadChatDraftState('draft', 'source').text, 'same text')
})
