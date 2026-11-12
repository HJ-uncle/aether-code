// Actual React hook + owned IPC/journal contracts; synthetic engine, no live window or provider.
import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), boundary = join(root, '.e2e-tmp')
mkdirSync(boundary, { recursive: true })
const folder = mkdtempSync(join(boundary, 'work-queue-rebase-')), bundle = join(folder, 'contracts.cjs')
await build({ stdin: { contents: [
  'src/renderer/src/features/conversation/next-turn-queue.ts', 'src/renderer/src/core/engine/source.ts',
  'src/main/session-next-turn-owner.ts', 'src/main/next-turn-queue-store.ts'
].map(path => `export * from ${JSON.stringify(join(root, path))}`).join('\n'), resolveDir: root, loader: 'ts' }, outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', external: ['react'], alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') } })
const require = createRequire(import.meta.url), module = require(bundle), { act, createElement } = require('react')
const { JSDOM } = createRequire(join(root, '../ai-agent-engine/package.json'))('jsdom')
const scope = { source: { mode: 'embedded', endpoint: '', accountId: 'test-account' }, tenantId: 'test-tenant', namespace: { id: 'test-db', generation: 'one' }, owner: 'work', taskId: 'work-session' }
const empty = (revision = 0) => ({ schemaVersion: 1, scope: structuredClone(scope), revision, paused: false, entries: [], removed: [] })
const submission = () => ({ draft: { text: 'same authored request', revision: 3, mentions: [] }, model: { kind: 'explicit', modelId: 'model' },
  resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'inherit' } }, thinking: { kind: 'off' },
  attachments: [{ path: '/fixture.pdf', name: 'fixture.pdf', type: 'application/pdf', size: 5 }] })
const ok = revision => ({ ok: true, value: { state: empty(revision) } })
const cas = () => ({ ok: false, code: 'CAS', message: 'Queue revision changed' })
let dom, mounted, hook, originalGlobals
function Probe({ taskId = scope.taskId } = {}) { hook = module.useSessionNextTurnQueue(taskId, module.getEngineSource(), true); return null }
async function mount(invoke) {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid' }); originalGlobals = new Map()
  dom.window.aether = { workQueue: { invoke, onChanged: () => () => {} } }
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  module.publishEngineSource({ mode: 'embedded', baseUrl: 'http://localhost:12345', instanceId: 'test-instance', phase: 'ready', accountId: 'test-account' })
  const { createRoot } = require('react-dom/client'); mounted = createRoot(document.getElementById('root'))
  await act(async () => mounted.render(createElement(Probe)))
}
afterEach(async () => {
  if (mounted) await act(async () => mounted.unmount()); mounted = null; dom?.window.close(); dom = null
  for (const [name, descriptor] of originalGlobals ?? []) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  originalGlobals = null
})
after(() => { if (dirname(folder) !== boundary || !basename(folder).startsWith('work-queue-rebase-')) throw new Error('fixture boundary'); rmSync(folder, { recursive: true, force: true }) })

test('terminal revision race rebases only the same append and its complete submission', async () => {
  const actions = []; let revision = 0, committed = 0
  await mount(async ({ action }) => {
    actions.push(structuredClone(action))
    if (action.kind === 'read') return ok(revision)
    if (revision === 0) { revision = 4; return cas() }
    assert.equal(action.expectedRevision, 4); committed++; return ok(++revision)
  })
  const draft = submission()
  await act(async () => { await hook.enqueue(draft) })
  const appends = actions.filter(action => action.kind === 'enqueue')
  assert.equal(committed, 1); assert.equal(appends.length, 2); assert.equal(hook.state.revision, 5)
  assert.deepEqual(appends[1], { ...appends[0], expectedRevision: 4 }); assert.deepEqual(appends[0].submission, draft)
  assert.equal(hook.error, null); assert.equal(hook.saving, false)
})

test('repeated contention stops after two rebases and keeps a Chinese actionable error', async () => {
  const actions = []; let revision = 0
  await mount(async ({ action }) => { actions.push(structuredClone(action)); if (action.kind === 'read') return ok(revision); revision++; return cas() })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), { code: 'CAS', message: '队列已更新，原稿已保留，请重试' }) })
  const appends = actions.filter(action => action.kind === 'enqueue')
  assert.deepEqual(appends.map(action => action.expectedRevision), [0, 1, 2])
  assert.equal(new Set(appends.map(action => action.id)).size, 1); assert.equal(new Set(appends.map(action => action.operationId)).size, 1)
  assert.equal(hook.error, '队列已更新，原稿已保留，请重试'); assert.equal(hook.saving, false)
})

for (const rebased of [false, true]) test(`unknown ACK ${rebased ? 'after a rebase' : 'on first append'} never retries automatically and manual replay keeps exact identity`, async () => {
  const appends = []; let revision = 0, lost = true
  await mount(async ({ action }) => {
    if (action.kind === 'read') return ok(revision)
    appends.push(structuredClone(action))
    if (rebased && appends.length === 1) { revision = 3; return cas() }
    if (lost) { lost = false; revision++; throw new Error('transport response lost') }
    return ok(revision)
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /transport response lost/) })
  const before = appends.length
  assert.equal(before, rebased ? 2 : 1)
  await act(async () => { await assert.rejects(hook.enqueue({ ...submission(), draft: { text: 'changed', revision: 4, mentions: [] } }), /上次入队回执未确认/) })
  assert.equal(appends.length, before)
  await act(async () => { await hook.enqueue(submission()) })
  assert.equal(appends.length, before + 1); assert.deepEqual(appends.at(-1), appends.at(-2)); assert.equal(hook.error, null)
})

for (const code of ['INVALID', 'CAPACITY', 'CONFLICT', 'SCOPE', 'AUTHORITY']) test(`${code} is not auto-rebased`, async () => {
  let appends = 0
  await mount(async ({ action }) => action.kind === 'read' ? ok(0) : (appends++, { ok: false, code, message: 'specific failure' }))
  await act(async () => { await assert.rejects(hook.enqueue(submission()), { code, message: 'specific failure' }) })
  assert.equal(appends, 1)
})

test('saving lock covers rebase reads and prevents a second overlapping append', async () => {
  let finishRead, attempts = 0, reads = 0
  await mount(async ({ action }) => {
    if (action.kind === 'read') { if (++reads === 2) return new Promise(resolve => { finishRead = resolve }); return ok(0) }
    attempts++; return attempts === 1 ? cas() : ok(2)
  })
  let flight
  await act(async () => { flight = hook.enqueue(submission()); await Promise.resolve() })
  assert.equal(hook.saving, true)
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /正在保存队列/) })
  assert.equal(attempts, 1)
  await act(async () => { finishRead(ok(1)); await flight })
  assert.equal(attempts, 2); assert.equal(hook.saving, false)
})

test('read failure after a definite CAS does not trigger another append', async () => {
  let reads = 0; const appends = []
  await mount(async ({ action }) => {
    if (action.kind === 'read') { if (++reads === 2) throw new Error('read unavailable'); return ok(reads === 1 ? 0 : 2) }
    appends.push(structuredClone(action)); return appends.length < 3 ? cas() : ok(3)
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /read unavailable/) })
  assert.equal(appends.length, 1)
  await act(async () => { await hook.enqueue(submission()) })
  assert.deepEqual(appends[1], appends[0]); assert.deepEqual(appends[2], { ...appends[0], expectedRevision: 2 })
})

test('switching tasks during the rebase read never appends into a later task', async () => {
  let finishRead, reads = 0, attempts = 0
  await mount(async ({ taskId, action }) => {
    if (taskId !== scope.taskId) return { ok: true, value: { state: { ...empty(), scope: { ...scope, taskId } } } }
    if (action.kind === 'read') { if (++reads === 2) return new Promise(resolve => { finishRead = resolve }); return ok(0) }
    attempts++; return cas()
  })
  let flight
  await act(async () => { flight = hook.enqueue(submission()); flight.catch(() => {}); await Promise.resolve() })
  await act(async () => mounted.render(createElement(Probe, { taskId: 'second-task' })))
  await act(async () => { finishRead(ok(1)); await assert.rejects(flight, /任务已切换/) })
  assert.equal(attempts, 1); assert.equal(hook.state.scope.taskId, 'second-task')
})

test('same task and source with a changed database namespace cannot rebase the original append', async () => {
  let reads = 0, attempts = 0
  await mount(async ({ action }) => {
    if (action.kind === 'read') {
      if (++reads === 1) return ok(0)
      return { ok: true, value: { state: { ...empty(1), scope: { ...scope, namespace: { id: 'replacement-db', generation: 'two' } } } } }
    }
    attempts++; return cas()
  })
  await act(async () => { await assert.rejects(hook.enqueue(submission()), /队列所属会话已变化/) })
  assert.equal(attempts, 1)
})

test('edit and reorder remain revision-sensitive and never auto-rebase', async () => {
  const actions = []
  await mount(async ({ action }) => { actions.push(structuredClone(action)); return action.kind === 'read' ? ok(0) : cas() })
  await act(async () => { await assert.rejects(hook.editDraft('existing', 1, submission().draft), { code: 'CAS' }) })
  await act(async () => { await assert.rejects(hook.mutate({ kind: 'reorder', ids: ['existing'] }), { code: 'CAS' }) })
  assert.deepEqual(actions.map(action => action.kind), ['read', 'edit-draft', 'mutate'])
})

test('real owned journal preserves an intervening pause and replays lost ACK at the rebased revision without a duplicate', async () => {
  let handler, raced = false, loseAck = true, envelopeCount = 0
  const appends = [], controller = new AbortController(), snapshot = { mode: 'embedded', baseUrl: 'http://localhost:12345', instanceId: 'test-instance', phase: 'ready', accountId: 'test-account' }
  const owner = module.createSessionNextTurnOwner({
    store: new module.NextTurnQueueStore(join(folder, 'real-owned-journal')),
    engine: { snapshot: () => snapshot, signal: () => controller.signal, subscribe: () => () => {} },
    ipc: { handle: (channel, listener) => { assert.equal(channel, 'work:next-turn-queue'); handler = listener }, removeHandler: () => {} },
    clock: { now: () => 0, schedule: () => 1, cancel: () => {} },
    gateway: {
      capture: async taskId => ({ scope: { ...structuredClone(scope), taskId }, generation: 'one' }), assertCurrent: () => {},
      context: async () => ({ root: { status: 'running' } }),
      envelope: async (target, draft) => { envelopeCount++; return { ...draft, workspace: { kind: 'local-scratch', identity: 'session:' + target.taskId },
        agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] } },
      prepare: async () => { throw new Error('running root must not dispatch') }, submit: async () => { throw new Error('running root must not dispatch') }
    }
  })
  const call = input => handler({ sender: { isDestroyed: () => false } }, structuredClone(input))
  try {
    await mount(async input => {
      if (input.action.kind === 'enqueue') {
        appends.push(structuredClone(input.action))
        if (!raced) { raced = true; const paused = await call({ ...input, action: { kind: 'mutate', expectedRevision: 0, operationId: 'background-pause', operation: { kind: 'pause', reason: 'operator paused during preparation' } } }); assert.equal(paused.ok, true, JSON.stringify(paused)) }
      }
      const reply = structuredClone(await call(input))
      if (input.action.kind === 'enqueue' && reply.ok && loseAck) { loseAck = false; throw new Error('committed ACK lost') }
      return reply
    })
    await act(async () => { await hook.refresh() })
    await act(async () => { await assert.rejects(hook.enqueue(submission()), /committed ACK lost/) })
    assert.equal(appends.length, 2); assert.equal(envelopeCount, 2)
    await act(async () => { await hook.enqueue(submission()) })
    assert.equal(envelopeCount, 2, 'exact replay must not reread attachments or prepare a second envelope')
    assert.deepEqual(appends[2], appends[1]); assert.equal(hook.state.entries.length, 1); assert.equal(hook.state.paused, true)
    assert.equal(hook.state.revision, 2); assert.equal(hook.state.entries[0].envelope.draft.text, submission().draft.text)
  } finally { await owner.close() }
})
