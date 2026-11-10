/** Fresh real-file review: copy AETHER_PPT_REVIEW_SOURCE into an isolated Work
 * workspace, then capture every original page through the real Work bridge,
 * Office worker and Chromium IPC. No generated marker deck or export UI.
 * Build first; screenshots support human review and never prove good design.
 * Set AETHER_PPT_REVIEW_ALLOW_DUPLICATE_PAGES=1 for intentionally repeated pages. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { WorkbenchBridge, WorkbenchAction } from '../../ai-agent-engine/src/tools/workbench/bridge'
import type { AgentContext, ToolResult } from '../../ai-agent-engine/src/core/agent-context'
import type { BrowserExecutionIdentity } from '../../ai-agent-engine/src/core/browser-execution'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sourcePath = process.env.AETHER_PPT_REVIEW_SOURCE ? resolve(process.env.AETHER_PPT_REVIEW_SOURCE) : ''
const filename = 'composition-review.pptx', sessionId = 'work-ppt-composition-review'
const modelId = 'offline-page-review', token = 'ppt-composition-review-instance'
const title = '实际 PPT 成品逐页审查', now = Date.now(), identity = { tenantId: 'default' }
const ctx = { sessionId, rootSessionId: sessionId, rootRunId: 'ppt-composition-review-run' } as AgentContext
const importBuilt = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const errors: string[] = []
let bridge: WorkbenchBridge, app: ElectronApplication | undefined, page: Page
let fixture = '', workspace = '', deckPath = '', hash = '', deck: Buffer, pageCount = 0, connected = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
type BridgeBody = { sessionId: string; actions: WorkbenchAction[]; clientToken: string; requestId: string; execution: BrowserExecutionIdentity; result: ToolResult }

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated: ${path}`)
  if (path.startsWith('/api/v1/workbench/clients')) {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as BridgeBody
    if (path === '/api/v1/workbench/clients') {
      const client = bridge.register(identity, body.sessionId, body.actions)
      if (body.sessionId === sessionId) { expect(body.actions).toContain('artifact.render'); connected = true }
      response.end(envelope(client)); return
    }
    const match = /^\/api\/v1\/workbench\/clients\/([^/]+)\/(poll|state|results|disconnect)$/.exec(path)
    if (!match) throw new Error('Unknown bridge route')
    const [, id, action] = match
    if (action === 'poll') response.end(envelope({ commands: await bridge.poll(identity, id, body.clientToken) }))
    else if (action === 'state') response.end(envelope({ active: bridge.active(identity, id, body.clientToken, body.requestId, body.execution) }))
    else if (action === 'results') response.end(envelope({ accepted: bridge.result(identity, id, body.clientToken, body.requestId, body.execution, body.result) }))
    else { bridge.unregister(identity, id, body.clientToken); response.end(envelope({ removed: true })) }
    return
  }
  if (['/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const id = url.searchParams.get('sessionId') ?? ''
  if (path === '/api/v1/workspace/file/content') {
    if (id !== sessionId || url.searchParams.get('path') !== filename) throw new Error('Unexpected session file read')
    response.end(envelope({ content: deck.toString('base64'), isBinary: true, totalSize: deck.length, root: workspace, bindingEpoch: 'composition-one' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'ppt-composition-review-engine' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '离线画面审查桥', isEnabled: true, capabilities: { toolCalling: true, vision: true } }]
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'default', sessionId: id, namespace: { id: 'ppt-composition-review-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 0 }]
    : path === '/api/v1/subagent/runs' ? { runs: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'composition-one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => {
  const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
  // A renderer reload can briefly overlap the old bridge lease; the real client
  // retries 409, so retain other server failures as independent test evidence.
  if (status !== 409) errors.push(String(error))
  if (!response.headersSent) response.writeHead(status)
  response.end(JSON.stringify({ code: status, message: String(error), data: null }))
}) })

test.beforeAll(async () => {
  if (!sourcePath || !sourcePath.toLowerCase().endsWith('.pptx')) throw new Error('Set AETHER_PPT_REVIEW_SOURCE to an existing actual .pptx file.')
  deck = readFileSync(sourcePath); hash = sha256(deck)
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'ppt-composition-profile-'))
  workspace = join(fixture, 'workspace'); mkdirSync(workspace)
  deckPath = join(workspace, filename); writeFileSync(deckPath, deck)
  const engineDist = resolve(root, '../ai-agent-engine/dist')
  const { WorkbenchBridge } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/workbench/bridge')>(pathToFileURL(join(engineDist, 'tools/workbench/bridge.js')).href)
  const { inspectPptx } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/pptx')>(pathToFileURL(join(engineDist, 'tools/office/pptx.js')).href)
  const inspection = await inspectPptx(deck)
  pageCount = Number(inspection.summary.slides)
  expect(Number.isSafeInteger(pageCount) && pageCount > 0 && pageCount <= 40).toBe(true)
  bridge = new WorkbenchBridge()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect.poll(() => connected).toBe(true)
})

test.afterAll(async () => {
  try { await app?.close() } finally {
    bridge?.dispose(); server.closeAllConnections()
    if (server.listening) await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== tempRoot || !basename(target).startsWith('ppt-composition-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    if (sourcePath && hash) expect(sha256(readFileSync(sourcePath)), 'Source PPTX must remain unchanged').toBe(hash)
  }
})

test('renders every page of the supplied real deck for human composition review', async ({}, info) => {
  const images = new Set<string>(), receipts: unknown[] = []
  for (let number = 1; number <= pageCount; number++) {
    const result = await bridge.execute('artifact.render', { path: deckPath, page: number, expectedHash: hash }, ctx)
    expect(result.success, result.output.slice(0, 1500)).toBe(true)
    const { dataUrl, ...receipt } = JSON.parse(result.output) as { dataUrl: string; page: number; pageCount: number; sha256: string; visualVerification: boolean; width: number; height: number }
    expect(receipt).toMatchObject({ page: number, pageCount, sha256: hash, visualVerification: false, width: 960, height: 540 })
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    const png = Buffer.from(dataUrl.split(',')[1], 'base64')
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.length).toBeGreaterThan(1000)
    expect(png.readUInt32BE(16)).toBe(960); expect(png.readUInt32BE(20)).toBe(540)
    const imageHash = sha256(png); images.add(imageHash); receipts.push({ ...receipt, imageHash })
    const output = info.outputPath(`slide-${String(number).padStart(2, '0')}.png`)
    writeFileSync(output, png); await info.attach(`实际成品第 ${number} 页`, { path: output, contentType: 'image/png' })
  }
  if (process.env.AETHER_PPT_REVIEW_ALLOW_DUPLICATE_PAGES !== '1') expect(images.size, 'Set the explicit opt-out only for intentionally repeated slides').toBe(pageCount)
  const report = info.outputPath('render-receipts.json')
  writeFileSync(report, JSON.stringify({ sourcePath, expectedHash: `sha256:${hash}`, pageCount, distinctImages: images.size, visualAcceptance: 'requires-human-review', receipts }, null, 2))
  await info.attach('逐页版本与渲染回执', { path: report, contentType: 'application/json' })
  const opened = await bridge.execute('artifact.open', { path: deckPath }, ctx)
  expect(opened.success, opened.output).toBe(true)
  const preview = page.locator('.document-preview[data-document-preview="pptx"]:visible')
  await expect(preview.locator(`[data-document-pages="${pageCount}"]`)).toBeVisible()
  for (const number of [...new Set([1, pageCount])]) {
    const container = preview.locator(`[data-document-page="${number}"]`)
    await container.scrollIntoViewIfNeeded(); await expect(container.locator('iframe')).toBeVisible()
    const screenshot = info.outputPath(`work-preview-${number}.png`)
    await page.screenshot({ path: screenshot }); await info.attach(`Work 预览第 ${number} 页`, { path: screenshot, contentType: 'image/png' })
  }
  expect(sha256(readFileSync(deckPath))).toBe(hash)
  expect(sha256(readFileSync(sourcePath))).toBe(hash)
  expect(errors).toEqual([])
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith('data:')).length)).toBe(0)
})
