import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), boundary = join(root, '.e2e-tmp')
mkdirSync(boundary, { recursive: true })
const folder = mkdtempSync(join(boundary, 'toolkit-selection-')), bundle = join(folder, 'contracts.cjs')
await build({ stdin: { contents: [
  'src/main/next-turn-engine-gateway.ts', 'src/main/next-turn-dispatcher.ts', 'src/main/next-turn-queue-service.ts', 'src/main/next-turn-queue-store.ts',
  'src/renderer/src/core/engine/toolkit-catalogue.ts', 'src/renderer/src/core/engine/source.ts'
].map(file => `export * from ${JSON.stringify(join(root, file))}`).join('\n'), resolveDir: root, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['react'],
  alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') },
  plugins: [{ name: 'unused-desktop-defaults', setup(builder) {
    builder.onLoad({ filter: /[/\\]engine[/\\]host\.ts$/ }, () => ({ contents: 'export const engineHost = {}', loader: 'ts' }))
    builder.onLoad({ filter: /[/\\]fs[/\\]file-service\.ts$/ }, () => ({ contents: 'export const assertAllowed = path => path', loader: 'ts' }))
  } }] })
const require = createRequire(import.meta.url), module = require(bundle), { act, createElement } = require('react')
const { JSDOM } = createRequire(join(root, '../ai-agent-engine/package.json'))('jsdom')
after(() => { if (dirname(folder) !== boundary || !basename(folder).startsWith('toolkit-selection-')) throw new Error('fixture boundary'); rmSync(folder, { recursive: true, force: true }) })

const scope = { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'test-tenant', namespace: { id: 'test-db', generation: 'one' }, owner: 'work', taskId: 'toolkit-session' }
const snapshot = { mode: 'embedded', baseUrl: 'http://localhost:12345', instanceId: 'test-instance', phase: 'ready' }
const token = '@toolkit:agent-management'
const envelope = () => ({ draft: { text: token, revision: 1, mentions: [{ source: 'toolkit', path: 'agent-management', displayText: 'Agent 管理', textOffset: 0 }] },
  model: { kind: 'engine-default' }, workspace: { kind: 'local-scratch', identity: 'session:' + scope.taskId }, agent: { primaryAgentId: null, collaborators: [] },
  resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'inherit' }, toolkits: { kind: 'inherit' } },
  thinking: { kind: 'inherit' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] })
const afterRemoval = { text: '继续完成任务', revision: 2, mentions: [] }
function gatewayFixture(resolveSelection = async () => ({ toolkits: ['agent-management', 'skill-management', 'automation'] }), owner = 'work') {
  let current = snapshot
  const controller = new AbortController(), calls = []
  const port = { snapshot: () => current, signal: () => controller.signal,
    request: async input => {
      calls.push(input)
      assert.equal(input.expectedEngine.instanceId, 'test-instance')
      assert.equal(input.toolProfile, owner === 'work' ? 'general' : 'code')
      if (input.path === '/chat/admission/context') return { ok: true, data: { protocolVersion: 1, tenantId: scope.tenantId, namespace: scope.namespace,
        sessionId: scope.taskId, root: { runId: 'root', attemptId: 'attempt', version: 1, status: 'running', workspacePaths: [] },
        predecessor: { runId: 'root', attemptId: 'attempt', version: 1 },
        transport: { toolProfile: owner === 'work' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 } } }
      assert.equal(input.path, '/sessions/toolkit-session/toolkits')
      return { ok: true, data: await resolveSelection() }
    }
  }
  return { gateway: new module.EngineQueueGateway(port, owner), calls, switchSource: () => { current = { ...snapshot, instanceId: 'replacement' } } }
}

test('main resolves inherited selection using trusted scope and only revokes the removed package', async () => {
  const fixture = gatewayFixture(), original = envelope()
  const edited = await fixture.gateway.editDraft(original, afterRemoval, scope)
  assert.deepEqual(edited.resources.toolkits, { kind: 'override', ids: ['skill-management', 'automation'] })
  assert.deepEqual(original.resources.toolkits, { kind: 'inherit' })
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.calls[0].query.sessionId, scope.taskId)
  fixture.gateway.close()
})

test('main never treats failed or late inherited lookup as empty and explicit edits need no fetch', async () => {
  for (const response of [{}, { toolkits: null }, { toolkits: [1] }]) {
    const fixture = gatewayFixture(async () => response)
    await assert.rejects(fixture.gateway.editDraft(envelope(), afterRemoval, scope))
    fixture.gateway.close()
  }
  let finish
  const fixture = gatewayFixture(() => new Promise(resolve => { finish = resolve }))
  const pending = fixture.gateway.editDraft(envelope(), afterRemoval, scope)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  fixture.switchSource(); finish({ toolkits: ['agent-management', 'automation'] })
  await assert.rejects(pending, /引擎或账号已变化/)
  fixture.gateway.close()
  const explicit = gatewayFixture()
  const original = envelope(); original.resources.toolkits = { kind: 'override', ids: ['agent-management', 'knowledge-management'] }
  assert.deepEqual((await explicit.gateway.editDraft(original, afterRemoval, scope)).resources.toolkits, { kind: 'override', ids: ['knowledge-management'] })
  assert.equal(explicit.calls.length, 0)
  await assert.rejects(explicit.gateway.editDraft(envelope(), afterRemoval), /可信会话范围/)
  explicit.gateway.close()
})

test('Code replacement persists resolved inherited revocation through the real main dispatcher and journal', async () => {
  const fixture = gatewayFixture(undefined, 'code'), directory = join(folder, 'code-journal')
  const store = new module.NextTurnQueueStore(directory)
  const service = new module.NextTurnQueueMutationService(store, fixture.gateway)
  const dispatcher = new module.NextTurnDispatcher(service, fixture.gateway)
  const original = envelope(), submission = { draft: original.draft, model: original.model, resources: original.resources,
    thinking: original.thinking, code: { workspacePaths: [] }, attachments: [] }
  try {
    const queued = await dispatcher.enqueue(scope.taskId, 0, 'enqueue', 'entry', submission)
    const entry = queued.state.entries[0]
    const edited = await dispatcher.changePending(scope.taskId, { kind: 'replace-submission', operationId: 'edit', id: entry.id,
      expectedRevision: queued.state.revision, entryRevision: entry.revision, submission: { ...submission, draft: afterRemoval } })
    assert.deepEqual(edited.state.entries[0].envelope.resources.toolkits, { kind: 'override', ids: ['skill-management', 'automation'] })
    const restored = await new module.NextTurnQueueStore(directory).read({ ...scope, owner: 'code' })
    assert.deepEqual(restored.state.entries[0].envelope.resources.toolkits, { kind: 'override', ids: ['skill-management', 'automation'] })
    assert.deepEqual(restored.state.entries[0].envelope.draft, afterRemoval)
    assert.equal(fixture.calls.filter(item => item.path.endsWith('/toolkits')).length, 1)
  } finally { await dispatcher.close() }
})

let dom, mounted, hook, savedGlobals
function Probe({ enabled = true, sessionId, agentId = 'home-agent', observe } = {}) {
  hook = module.useToolkitCatalogue(enabled, sessionId, agentId, '/project')
  observe?.(hook)
  return null
}
async function render(props) { await act(async () => mounted.render(createElement(Probe, props))) }
async function mount(request, props) {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid' }); savedGlobals = new Map()
  dom.window.aether = { engine: { request } }
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  module.publishEngineSource(snapshot)
  const { createRoot } = require('react-dom/client'); mounted = createRoot(document.getElementById('root'))
  await render(props)
}
afterEach(async () => {
  if (mounted) await act(async () => mounted.unmount()); mounted = null; dom?.window.close(); dom = null
  for (const [name, descriptor] of savedGlobals ?? []) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  savedGlobals = null
})
const supported = (id = 'skill-management') => ({ ok: true, data: { toolkits: [{ id, name: id, description: '', available: true, toolNames: ['skill_list'] }] } })

test('catalogue follows session binding, checks home agent and hides old engine support', async () => {
  const requests = []
  await mount(async input => { requests.push(input); return supported() }, { sessionId: 'session-A', agentId: 'ignored-agent' })
  assert.equal(requests[0].query.sessionId, 'session-A'); assert.equal(requests[0].query.agentId, undefined)
  assert.equal(requests[0].toolProfile, 'general'); assert.equal(hook.items[0].id, 'skill-management')
  await render({ agentId: 'home-agent' })
  assert.equal(requests.at(-1).query.agentId, 'home-agent'); assert.equal(requests.at(-1).query.sessionId, undefined)
  dom.window.aether.engine.request = async () => ({ ok: false, code: 404, message: 'unsupported' })
  await render({ sessionId: 'old-engine-session' })
  assert.deepEqual(hook.items, []); assert.equal(hook.loading, false)
})

test('late catalogue replies cannot cross session or engine source boundaries', async () => {
  const pending = []
  await mount(input => new Promise(resolve => pending.push({ input, resolve })), { sessionId: 'session-A' })
  await render({ sessionId: 'session-B' })
  await act(async () => pending[0].resolve(supported('agent-management')))
  assert.deepEqual(hook.items, [])
  await act(async () => pending[1].resolve(supported('knowledge-management')))
  assert.equal(hook.items[0].id, 'knowledge-management')
  const observed = []
  await act(async () => {
    module.publishEngineSource({ ...snapshot, instanceId: 'another-engine', accountId: 'other-account' })
    mounted.render(createElement(Probe, { sessionId: 'session-B', observe: value => observed.push(value.items.map(item => item.id)) }))
  })
  assert.deepEqual(observed[0], [])
  await act(async () => pending[2].resolve(supported('automation')))
  assert.equal(hook.items[0].id, 'automation')
  assert.equal(pending[2].input.expectedEngine.accountId, 'other-account')
})
