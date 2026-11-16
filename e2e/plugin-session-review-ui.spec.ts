/** Authenticated fixture engine + real Electron SDK iframe using the engine's authored
 * session-review HTML. Verifies UI/bridge contracts, not real model inference; separate
 * engine HTTP tests own capability implementation coverage. Never reads production data. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { sessionReviewHtml } from '../../ai-agent-engine/src/plugins/session-review-template'
import type { PluginApplication, PluginManifest } from '../src/renderer/src/core/engine/plugins'
import type { PluginPermissionRecord } from '../src/renderer/src/core/engine/plugin-permissions'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-session-review-ui-20261112')
const token = 'session-review-fixture-token', pluginId = 'session-review-fixture', pluginName = '会话质量校验'
const sessionId = 'work-session-review-fixture', taskTitle = '图片压缩插件验收', workspace = '/session-review-fixture/workspace'
const modelA = 'review-model-a', modelB = 'review-model-b', hash = 'sha256:' + '7'.repeat(64), now = Date.now() - 5000
const requested = ['session.read', 'models.read', 'ai.run', 'settings.read', 'settings.write', 'agents.manage']
const catalogue = requested.map(id => ({ id, title: ({ 'session.read': '读取当前会话', 'models.read': '查看可用模型', 'ai.run': '调用平台 AI', 'settings.read': '读取插件设置', 'settings.write': '修改插件设置', 'agents.manage': '运行平台 Agent' })[id],
  description: '隔离验收能力', category: id.split('.')[0], access: id === 'ai.run' ? 'execute' : id.endsWith('.write') ? 'write' : 'read', defaultGranted: false, bridge: [] }))
const manifest: PluginManifest & { permissions: { requested: string[] } } = {
  apiVersion: 1, id: pluginId, name: pluginName, version: '1.0.0', description: '读取当前会话消息并使用平台模型分析', runtime: 'node', permissions: { requested },
  tools: [{ name: 'prepare_review', description: '整理待分析文本', entry: 'main.mjs', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  contributes: { pages: [{ id: 'review', title: pluginName, kind: 'webview', entry: 'ui/index.html', tools: [] }],
    workspaceTabs: [{ id: 'review', title: '会话校验', page: 'review', icon: 'check-circle-outline', scope: 'session', when: { session: true } }] }
}
const messages = [
  { id: 'review-user', role: 'user', content: '请做图片压缩插件，保留透明通道，并提供压缩前后的大小对比。', conversationId: 'review-turn', createdAt: now, metadata: { attachments: [{ name: '透明图.png', path: '/fixture/透明图.png' }] } },
  { id: 'review-assistant', role: 'assistant', content: '已完成图片压缩，但当前没有提供测试证据。', conversationId: 'review-turn', createdAt: now + 1 },
  { id: 'review-tool', role: 'tool', content: '验证输出：原图 100 KB，压缩后 42 KB；<img src=x onerror="window.invalid=true">', conversationId: 'review-turn', createdAt: now + 2 },
]
type CapabilityCall = { capability: string; method: string; args: Record<string, unknown>; sessionId?: string; expectedRevision: number }
let holdStream = false, streamAborts = 0, releaseStream: (() => void) | undefined
let agentMode = false, rejectAgentAnswer = false, agentSourceWait = false
const agentResponses: Array<Record<string, unknown>> = [], agentCancels: string[] = []
const agentPermission = { requestId: 'permission-one', toolCallId: 'command-one', toolName: 'execute_cmd', kind: 'permission', status: 'pending', args: { command: 'echo', args: ['isolated fixture'] }, question: '执行隔离测试命令？' }
const sourcePermission = { ...agentPermission, question: '等待其他任务结束后，请重新检查源码。', options: ['pause', 'recheck'], sourceChangeWait: { mode: 'external-writer', startedAt: 1, pollMs: 1000, stableWindowMs: 1000, blockers: [{ kind: 'run', id: 'other-root', status: 'running' }] } }
const agentQuestion = { requestId: 'question-one', toolCallId: 'ask-one', toolName: 'ask_user', kind: 'ask', status: 'pending', args: { question: '选择分析报告格式', options: [{ label: '简洁摘要' }, { label: '详细报告' }], multiSelect: false } }
function agentSegment(response: ServerResponse, stage: 'permission' | 'question' | 'complete'): void {
  const runId = stage === 'permission' ? 'outer-initial' : stage === 'question' ? 'outer-question' : 'outer-complete'
  const pending = stage === 'permission' ? agentSourceWait ? sourcePermission : agentPermission : stage === 'question' ? agentQuestion : undefined
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (value: unknown): void => { response.write('data: ' + JSON.stringify(value) + '\n\n') }
  send({ type: 'started', runId, childSessionId: 'durable-child' })
  if (pending) send({ type: 'pending', runId, childSessionId: 'durable-child', pending })
  else send({ type: 'text-delta', runId, text: '已完成详细报告' })
  send({ type: 'complete', result: { runId, childSessionId: 'durable-child', status: pending ? 'blocked' : 'succeeded', ...(pending ? { pending: [pending] } : { result: '已完成详细报告' }) } }); response.end()
}
const errors: string[] = [], capabilityCalls: CapabilityCall[] = [], permissionUpdates: string[][] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', grants = new Set(requested)
let settings: Record<string, unknown> = {}, aiError = '', aiTextOverride: string | undefined, modelRuns = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const pluginRecord = (): PluginPermissionRecord => ({ id: pluginId, name: pluginName, description: manifest.description, enabled: true, revision: 1, publishedRevision: 1,
  manifest, permissionGrants: [...grants], permissionRevision: 1, files: { 'ui/index.html': sessionReviewHtml }, revisions: [{ revision: 1, hash, createdAt: now }], createdAt: now, updatedAt: now })
const application = (): PluginApplication => ({ id: pluginId, name: pluginName, description: manifest.description, revision: 1, hash, manifest, examples: [], execution: { allowed: true }, uiDocuments: { review: sessionReviewHtml } })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing fixture authentication: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const agentRespond = new RegExp(`^/api/v1/plugins/${pluginId}/agents/(outer-initial|outer-question)/respond$`).exec(path)
  if (agentRespond) {
    if (!agentMode || request.method !== 'POST' || body.expectedRevision !== 1 || body.sessionId !== sessionId || Object.keys(body).some(key => !['expectedRevision', 'sessionId', 'requestId', 'toolCallId', 'output'].includes(key))) throw new Error('Invalid trusted Agent response')
    const pending = agentRespond[1] === 'outer-initial' ? agentPermission : agentQuestion
    if (body.requestId !== pending.requestId || body.toolCallId !== pending.toolCallId || body.output !== (agentRespond[1] === 'outer-initial' ? agentSourceWait ? 'recheck' : 'approved' : '详细报告')) throw new Error('Wrong Agent decision identity or answer')
    if (rejectAgentAnswer) {
      rejectAgentAnswer = false
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'error', error: { code: 'HOST_RETRY', message: '确认尚未接受，请重试。' } }) + '\n\n'); return
    }
    agentResponses.push(body); agentSegment(response, agentRespond[1] === 'outer-initial' ? 'question' : 'complete'); return
  }
  if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
    response.end(envelope({ protocolVersion: 1, tenantId: 'session-review-fixture', sessionId: url.searchParams.get('sessionId'),
      namespace: { id: 'session-review-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })); return
  }
  if (path === '/api/v1/chat/admission/receipt' && request.method === 'POST') {
    response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey })); return
  }
  if ([`/api/v1/plugins/${pluginId}/capabilities/invoke`, `/api/v1/plugins/${pluginId}/capabilities/stream`].includes(path)) {
    if (request.method !== 'POST' || body.expectedRevision !== 1 || body.hash !== undefined || body.sessionId !== sessionId || !body.args || typeof body.args !== 'object') throw new Error('Invalid pinned capability request or session binding')
    const call = body as unknown as CapabilityCall; capabilityCalls.push(call)
    if (!grants.has(call.capability)) { response.writeHead(403).end(JSON.stringify({ code: 40300, message: `未授予插件能力：${call.capability}` })); return }
    if (agentMode && call.capability === 'agents.manage') {
      if (call.method === 'stream') { agentSegment(response, 'permission'); return }
      if (call.method === 'cancel') { agentCancels.push(String(call.args.runId)); response.end(envelope({ result: { cancelled: true } })); return }
      response.writeHead(403).end(JSON.stringify({ code: 40300, message: '确认操作仅限宿主用户界面' })); return
    }
    let result: unknown
    if (call.capability === 'session.read' && call.method === 'messages') {
      const offset = Number(call.args.offset ?? 0), limit = Number(call.args.limit ?? 50)
      result = { messages: messages.slice(offset, offset + limit), total: messages.length, nextOffset: offset + limit < messages.length ? offset + limit : null }
    } else if (call.capability === 'models.read' && call.method === 'list') result = { models: [{ id: modelA, name: '质量分析 A' }, { id: modelB, name: '质量分析 B' }] }
    else if (call.capability === 'settings.read' && call.method === 'get') result = { ...settings }
    else if (call.capability === 'settings.write' && call.method === 'set') {
      if (!call.args.value || typeof call.args.value !== 'object' || Array.isArray(call.args.value)) throw new Error('Invalid settings write')
      settings = { ...call.args.value as Record<string, unknown> }; result = { ...settings }
    } else if (call.capability === 'ai.run' && call.method === 'stream') {
      if (aiError) { response.writeHead(503).end(JSON.stringify({ code: 50300, message: aiError })); return }
      if (![modelA, modelB].includes(String(call.args.modelId)) || typeof call.args.prompt !== 'string' || typeof call.args.systemPrompt !== 'string') throw new Error('Invalid AI request')
      modelRuns++; result = { text: aiTextOverride ?? `校验报告 ${modelRuns}：已核对所选消息，仍需补充透明通道的测试证据。`, model: call.args.modelId, usage: { inputTokens: 213, outputTokens: 47 } }
    } else throw new Error(`Unexpected capability ${call.capability}:${call.method}`)
    if (call.method === 'stream') {
      const value = result as { text: string }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
      const send = (event: unknown): void => { response.write('data: ' + JSON.stringify(event) + '\n\n') }
      send({ type: 'started' })
      const split = holdStream ? Math.min(6, value.text.length) : value.text.length
      if (split) send({ type: 'text-delta', text: value.text.slice(0, split) })
      const finish = (): void => { if (!response.destroyed) { if (split < value.text.length) send({ type: 'text-delta', text: value.text.slice(split) }); send({ type: 'complete', result }); response.end() } }
      if (holdStream) releaseStream = finish
      else finish()
      response.once('close', () => { if (!response.writableEnded) streamAborts++; if (releaseStream === finish) releaseStream = undefined })
      return
    }
    response.end(envelope({ result })); return
  }
  if (path === `/api/v1/plugins/${pluginId}/permissions` && request.method === 'PUT') {
    const next = body.grants as string[]
    if (body.expectedRevision !== 1 || !Array.isArray(next) || next.some(id => !requested.includes(id))) throw new Error('Invalid permission update')
    grants = new Set(next); permissionUpdates.push(next); response.end(envelope({ plugin: pluginRecord() })); return
  }
  if (path === '/api/v1/plugins/project/capabilities') { response.end(envelope({ catalogue: { capabilities: catalogue } })); return }
  if (path === `/api/v1/plugins/${pluginId}` && request.method === 'GET') { response.end(envelope({ plugin: pluginRecord() })); return }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}`) { response.end(envelope({ application: application() })); return }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: messages[0].id, conversationId: 'review-turn', preview: taskTitle, createdAt: now }], messages,
      loadedTurnIds: [messages[0].id], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected write: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'6'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: modelA, modelId: modelA, provider: 'openai', displayName: '质量分析 A', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: messages, projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] } : path === '/api/v1/conversation/history' ? messages
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: taskTitle, lastAt: now, messageCount: messages.length }]
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: sessionId, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : path === '/api/v1/plugins' ? { plugins: [pluginRecord()] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })
const frame = (): ReturnType<Page['frameLocator']> => page.frameLocator(`iframe[title="${pluginName}"]`)
const selections = () => frame().locator('#messages input')
const analyses = (): CapabilityCall[] => capabilityCalls.filter(call => call.capability === 'ai.run')
const chosenMessages = (call: CapabilityCall): Array<{ id: string; attachments?: unknown[] }> => {
  const prompt = String(call.args.prompt)
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as Array<{ id: string; attachments?: unknown[] }>
}
async function openReview(): Promise<void> {
  await page.locator(`[data-task-id="${sessionId}"]`).getByRole('button').first().click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(taskTitle)
  await page.locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '会话校验', exact: true }).click()
  await expect(frame().getByRole('heading', { name: pluginName, exact: true })).toBeVisible()
  await expect(selections()).toHaveCount(messages.length)
  await expect(frame().getByRole('combobox', { name: '分析模型', exact: true })).toHaveValue(modelA)
  await expect(frame().locator('#rubric')).toHaveValue(String(settings.rubric))
  await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
}

test.describe.serial('会话分析模板真实 SDK iframe', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace, autoStartEngine: true,
      lastFolder: '', lastModelId: modelA, appearance: 'light', accent: 'blue', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, sessionId, taskTitle, workspace, now, modelA }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: [{ id: sessionId, title: taskTitle, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: workspace, modelId: modelA, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { stateKey, sessionId, taskTitle, workspace, now, modelA })
  })
  test.beforeEach(async () => {
    holdStream = false; releaseStream = undefined; streamAborts = 0
    agentMode = false; rejectAgentAnswer = false; agentSourceWait = false; agentResponses.length = 0; agentCancels.length = 0
    grants = new Set(requested); settings = { rubric: '检查需求覆盖、附件和测试证据；引用消息 ID。' }; aiError = ''; aiTextOverride = undefined; modelRuns = 0; capabilityCalls.length = 0; permissionUpdates.length = 0
    await page.reload(); await openReview()
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
      await page.screenshot({ path: info.outputPath('session-review.png') })
    }
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe session review cleanup'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('慢插件回调让真实主进程等待 ACK，大响应完整穿过 IPC 与 iframe', async () => {
    aiTextOverride = '中'.repeat(800_000)
    await page.evaluate(() => {
      const events: Array<{ streamId: string; ackId?: string }> = []
      const off = window.aether.engine.onStreamEvent(event => { if (event.streamId.startsWith('plugin-capability-') && event.type === 'payload') events.push({ streamId: event.streamId, ackId: event.ackId }) })
      Object.assign(window, { flowEvents: events, flowOff: off })
    })
    try {
      await frame().locator('body').evaluate((_, { modelA }) => {
        const sdk = (window as unknown as { $AE: { ai: { stream(args: unknown, options: { onEvent(event: { type: string }): Promise<void> }): Promise<{ text: string }> } } }).$AE
        void sdk.ai.stream({ modelId: modelA, prompt: 'review', systemPrompt: 'test' }, { onEvent: async event => {
          if (event.type === 'started') await new Promise<void>(resolve => { Object.assign(window, { releaseFlow: resolve }); document.getElementById('status')!.textContent = 'fixture waiting' })
        } }).then(result => { document.getElementById('status')!.textContent = `received ${result.text.length}` })
      }, { modelA })
      await expect(frame().locator('#status')).toHaveText('fixture waiting')
      expect(await page.evaluate(() => (window as unknown as { flowEvents: unknown[] }).flowEvents.length)).toBe(1)
      expect(await page.evaluate(async () => {
        const event = (window as unknown as { flowEvents: Array<{ streamId: string; ackId?: string }> }).flowEvents[0]
        if (!event.ackId) throw new Error('Missing main-process ACK identity')
        return window.aether.engine.stream.ack(event.streamId, 'foreign-ack')
      })).toEqual({ ok: false })
      expect(await page.evaluate(() => (window as unknown as { flowEvents: unknown[] }).flowEvents.length)).toBe(1)
      await frame().locator('body').evaluate(() => (window as unknown as { releaseFlow(): void }).releaseFlow())
      await expect(frame().locator('#status')).toHaveText('received 800000')
      expect(await page.evaluate(() => (window as unknown as { flowEvents: unknown[] }).flowEvents.length)).toBe(3)
    } finally { await page.evaluate(() => (window as unknown as { flowOff(): void }).flowOff()) }
  })

  async function startAgent(): Promise<void> {
    agentMode = true
    await frame().locator('body').evaluate(() => {
      const sdk = (window as unknown as { $AE: { agents: { stream(args: unknown, options: { onEvent(event: { type: string }): void }): Promise<{ status: string; result?: string }> } } }).$AE
      const events: string[] = []; Object.assign(window, { agentFixtureEvents: events })
      document.getElementById('status')!.textContent = 'agent running'
      void sdk.agents.stream({ task: '隔离执行并请求用户确认' }, { onEvent: event => { events.push(event.type) } }).then(result => {
        document.getElementById('status')!.textContent = `${result.status}:${result.result}`
      }).catch(() => { document.getElementById('status')!.textContent = 'agent cancelled' })
    })
    await expect(page.getByRole('form', { name: '插件操作确认', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: agentSourceWait ? '重新检查' : '允许执行', exact: true })).toBeEnabled()
  }

  test('Agent 在宿主确认与问答后继续同一插件流，iframe 不能自批，blocked 不伪装成完成', async ({}, info) => {
    await startAgent()
    const permission = page.getByRole('form', { name: '插件操作确认', exact: true })
    await expect(permission).toContainText('isolated fixture')
    await expect(permission.getByRole('button', { name: /完全访问/ })).toHaveCount(0)
    expect(await frame().locator('body').evaluate(() => (window as unknown as { agentFixtureEvents: string[] }).agentFixtureEvents)).toEqual(['started', 'pending'])
    await expect(frame().locator('#status')).toHaveText('agent running')
    const rejected = await frame().locator('body').evaluate(async () => {
      const sdk = (window as unknown as { $AE: { call(capability: string, method: string, args: unknown): Promise<unknown> } }).$AE
      return sdk.call('agents.manage', 'respond', { runId: 'outer-initial', requestId: 'permission-one', toolCallId: 'command-one', output: 'approved' }).then(() => 'unexpected', error => error.message)
    })
    expect(rejected).toBe('确认操作仅限宿主用户界面'); expect(agentResponses).toEqual([])
    await page.screenshot({ path: info.outputPath('agent-host-permission.png'), animations: 'disabled' })
    await permission.getByRole('button', { name: '允许执行', exact: true }).click()
    const question = page.getByRole('form', { name: '插件补充信息', exact: true })
    await expect(question).toContainText('选择分析报告格式')
    await expect(question.getByRole('button', { name: '提交回复', exact: true })).toBeDisabled()
    await question.getByRole('radio', { name: '详细报告', exact: true }).check()
    await page.screenshot({ path: info.outputPath('agent-host-question.png'), animations: 'disabled' })
    await question.getByRole('button', { name: '提交回复', exact: true }).click()
    await expect(page.locator('.extension-page__interaction')).toHaveCount(0)
    await expect(frame().locator('#status')).toHaveText('succeeded:已完成详细报告')
    expect(agentResponses.map(value => [value.requestId, value.toolCallId, value.output])).toEqual([['permission-one', 'command-one', 'approved'], ['question-one', 'ask-one', '详细报告']])
    expect(await frame().locator('body').evaluate(() => (window as unknown as { agentFixtureEvents: string[] }).agentFixtureEvents)).toEqual(['started', 'pending', 'started', 'pending', 'started', 'text-delta', 'complete'])
    expect(agentCancels).toEqual([])
  })

  test('宿主停止待确认 Agent 会取消最新真实运行，并拒绝逻辑流', async () => {
    await startAgent()
    await page.getByRole('button', { name: '允许执行', exact: true }).click()
    await expect(page.getByRole('form', { name: '插件补充信息', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(frame().locator('#status')).toHaveText('agent cancelled')
    await expect(page.locator('.extension-page__interaction')).toHaveCount(0)
    await expect.poll(() => agentCancels).toEqual(['outer-question'])
    expect(agentResponses).toHaveLength(1)
  })

  test('续跑前拒绝的宿主应答保留原卡重试，不结束插件逻辑流', async () => {
    await startAgent(); rejectAgentAnswer = true
    const permission = page.getByRole('form', { name: '插件操作确认', exact: true })
    await permission.getByRole('button', { name: '允许执行', exact: true }).click()
    await expect(permission.getByRole('alert')).toHaveText('确认尚未接受，请重试。')
    await expect(permission.getByRole('button', { name: '允许执行', exact: true })).toBeEnabled()
    await expect(frame().locator('#status')).toHaveText('agent running')
    expect(await frame().locator('body').evaluate(() => (window as unknown as { agentFixtureEvents: string[] }).agentFixtureEvents)).toEqual(['started', 'pending'])
    await permission.getByRole('button', { name: '允许执行', exact: true }).click()
    await expect(page.getByRole('form', { name: '插件补充信息', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(frame().locator('#status')).toHaveText('agent cancelled')
    await expect.poll(() => agentCancels).toEqual(['outer-question'])
  })

  test('源码冲突等待保留手动复核与停止选项，不显示未接入的自动继续', async () => {
    agentSourceWait = true; await startAgent()
    const permission = page.getByRole('form', { name: '插件操作确认', exact: true })
    await expect(permission).toContainText('其他任务可能仍在修改文件')
    await expect(permission).not.toContainText('自动继续')
    await permission.getByRole('button', { name: '重新检查', exact: true }).click()
    await expect(page.getByRole('form', { name: '插件补充信息', exact: true })).toBeVisible()
    expect(agentResponses[0]?.output).toBe('recheck')
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(frame().locator('#status')).toHaveText('agent cancelled')
    await expect.poll(() => agentCancels).toEqual(['outer-question'])
  })

  test('真实模板读取当前会话和模型，单选多选只把选中消息与附件提交给所选模型', async () => {
    const iframe = page.locator(`iframe[title="${pluginName}"]`)
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    await expect(iframe).toHaveAttribute('data-ready', 'true')
    await expect(iframe).toHaveAttribute('src', /^aether-plugin-ui:\/\/document\//)
    expect(await frame().locator('body').evaluate(() => ({ preload: 'aether' in window, sdk: '$AE' in window, origin: window.origin }))).toEqual({ preload: false, sdk: true, origin: 'null' })
    await expect(frame().locator('#messages')).toContainText('透明图.png')
    await expect(frame().locator('#messages img')).toHaveCount(0)
    await expect(frame().getByRole('button', { name: '分析', exact: true })).toBeDisabled()
    await selections().nth(0).check(); await selections().nth(2).check()
    await expect(frame().locator('#count')).toHaveText('已选 2 条 · 已载入 3 / 3')
    await frame().getByRole('combobox', { name: '分析模型', exact: true }).selectOption(modelB)
    holdStream = true
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toHaveText('校验报告 1')
    await expect(frame().getByRole('button', { name: '停止', exact: true })).toBeEnabled()
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
    await expect(frame().getByRole('status')).toHaveText('正在生成分析…')
    releaseStream!(); holdStream = false
    await expect(frame().locator('#report')).toContainText('校验报告 1')
    await expect(frame().getByRole('status')).toContainText(`分析完成 · ${modelB} · 输入 213 / 输出 47 tokens`)
    expect(analyses()).toHaveLength(1)
    expect(analyses()[0]).toMatchObject({ sessionId, expectedRevision: 1, args: { modelId: modelB, systemPrompt: settings.rubric } })
    expect(chosenMessages(analyses()[0]).map(item => item.id)).toEqual(['review-user', 'review-tool'])
    expect(chosenMessages(analyses()[0])[0].attachments).toEqual(messages[0].metadata?.attachments)
    await frame().getByRole('combobox', { name: '选择方式', exact: true }).selectOption('single')
    await expect(frame().getByRole('radio')).toHaveCount(3)
    await expect(frame().locator('#messages input:checked')).toHaveCount(1)
    await selections().nth(1).check()
    await expect(frame().getByRole('button', { name: '全选', exact: true })).toBeDisabled()
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 2')
    expect(chosenMessages(analyses()[1]).map(item => item.id)).toEqual(['review-assistant'])
    expect(modelRuns).toBe(2)
  })

  test('插件设置经过 SDK 保存并重新读取，模型错误清除旧报告且允许重试', async () => {
    await frame().locator('summary').click()
    await expect(frame().getByRole('textbox', { name: '校验要求', exact: true })).toHaveValue(String(settings.rubric))
    const rubric = '必须核对透明通道、体积统计和可复现步骤。\n缺少证据时明确说明。'
    await frame().getByRole('textbox', { name: '校验要求', exact: true }).fill(rubric)
    await frame().getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(frame().getByRole('status')).toHaveText('设置已保存')
    expect(settings).toEqual({ rubric })
    expect(capabilityCalls.filter(call => call.capability === 'settings.write')).toHaveLength(1)
    await page.reload(); await openReview(); await frame().locator('summary').click()
    await expect(frame().getByRole('textbox', { name: '校验要求', exact: true })).toHaveValue(rubric)
    await selections().first().check(); await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 1')
    aiError = '模型服务暂不可用，请重试。'
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().getByRole('status')).toHaveText(aiError)
    await expect(frame().locator('#report')).toBeEmpty()
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
    await expect(frame().getByRole('button', { name: '分析', exact: true })).toBeEnabled()
    aiError = ''; await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 2')
    expect(analyses().at(-1)?.args.systemPrompt).toBe(rubric)
  })

  test('停止流式分析会中止真实 HTTP 请求，保留未完成预览并禁止导出', async () => {
    holdStream = true
    await selections().first().check()
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toHaveText('校验报告 1')
    await frame().getByRole('button', { name: '停止', exact: true }).click()
    await expect(frame().getByRole('status')).toHaveText('已停止 · 当前内容未完成')
    await expect.poll(() => streamAborts).toBe(1)
    await expect(frame().locator('#report')).toHaveText('校验报告 1')
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
    await expect(frame().getByRole('button', { name: '分析', exact: true })).toBeEnabled()
    holdStream = false
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().getByRole('status')).toContainText('分析完成')
    await expect(frame().locator('#report')).toContainText('校验报告 2')
  })

  test('模型返回空或空白正文时清除旧报告，不显示分析完成且禁止导出，之后可以重试', async () => {
    await selections().first().check()
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 1')
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeEnabled()
    for (const empty of ['', ' \n\t ']) {
      aiTextOverride = empty
      await frame().getByRole('button', { name: '分析', exact: true }).click()
      await expect(frame().getByRole('status')).toHaveText('模型没有返回分析正文，请调整模型配置后重试。')
      await expect(frame().getByRole('status')).not.toContainText('分析完成')
      await expect(frame().locator('#report')).toBeEmpty()
      await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
      await expect(frame().getByRole('button', { name: '分析', exact: true })).toBeEnabled()
    }
    aiTextOverride = undefined
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 4')
    await expect(frame().getByRole('status')).toContainText('分析完成')
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeEnabled()
    expect(analyses()).toHaveLength(4)
  })

  test('在权限管理撤销 AI 授权后，模板下一次调用明确失败且不会产生分析', async () => {
    await selections().first().check(); await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().locator('#report')).toContainText('校验报告 1')
    await page.locator('.work-navigation').getByRole('button', { name: '插件', exact: true }).click()
    const manager = page.getByRole('region', { name: '插件管理', exact: true })
    await manager.getByRole('button', { name: `编辑插件 ${pluginName}`, exact: true }).click()
    await manager.getByRole('tab', { name: '权限', exact: true }).click()
    const control = manager.getByRole('switch', { name: '允许调用平台 AI', exact: true })
    await expect(control).toHaveAttribute('aria-checked', 'true'); await control.click()
    await expect(control).toHaveAttribute('aria-checked', 'false')
    expect(permissionUpdates).toEqual([requested.filter(id => id !== 'ai.run')])
    await openReview(); await selections().first().check()
    await frame().getByRole('button', { name: '分析', exact: true }).click()
    await expect(frame().getByRole('status')).toHaveText('未授予插件能力：ai.run')
    await expect(frame().locator('#report')).toBeEmpty()
    await expect(frame().getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
    expect(analyses()).toHaveLength(2); expect(modelRuns).toBe(1)
  })
})
