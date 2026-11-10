/** Fresh isolated Electron acceptance for Work's document preview toolbar.
 * A generated DOCX crosses real IPC, archive worker and iframe rendering.
 * Covers version menus, zoom, keyboard focus and theme/narrow layout. No model,
 * export/save dialog, production profile, or existing E2E suite is used. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sessionId = 'work-document-toolbar', modelId = 'document-toolbar-fixture', token = 'document-toolbar-token'
const title = '文档预览工具栏验收', workspace = '/remote/document-toolbar', now = Date.now() - 10_000
const filename = '2048 项目说明与技术方案-需要完整显示提示的长文件名称.docx', filePath = `${workspace}/${filename}`
const run: RootRun = { schemaVersion: 1, runId: 'document-toolbar-run', sessionId, turnId: 'document-toolbar-turn',
  userMessageId: 'document-toolbar-user', assistantMessageId: 'document-toolbar-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [workspace], createdAt: now, updatedAt: now + 1000, finishedAt: now + 1000 }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const history = [{ id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata },
  { id: run.assistantMessageId, role: 'assistant', content: '已生成文档，请检查文件预览。', createdAt: now + 1000, conversationId: run.turnId, metadata }]
const changes: EngineFileChange[] = [{ id: 'document-toolbar-change', sessionId, runId: run.runId, turnId: run.turnId,
  path: filePath, kind: 'write', oldContent: null, newContent: null, isNew: true, oldHash: 'missing', newHash: 'a'.repeat(64),
  truncated: false, status: 'pending', createdAt: now + 500 }]
let app: ElectronApplication | undefined, page: Page, fixture = '', bytes = Buffer.alloc(0)
const errors: string[] = [], mutations: string[] = [], reads: string[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  const owned = id === sessionId
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Read-only toolbar must not mutate ${path}`)
  }
  if (path === '/api/v1/workspace/file/content') {
    const target = url.searchParams.get('path') ?? ''
    if (!owned || ![filename, filePath].includes(target)) throw new Error(`Unexpected file read ${target}`)
    reads.push(target); response.end(envelope({ content: bytes.toString('base64'), isBinary: true, totalSize: bytes.length, root: workspace, bindingEpoch: 'toolbar' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'document-toolbar-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '文档工具栏夹具', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: owned ? history : [], projection: [], run: owned ? run : undefined, runs: owned ? [run] : [], subagentRuns: [], todos: [], changes: owned ? changes : [], commandJobs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: owned ? [{ userMessageId: run.userMessageId, conversationId: run.turnId, preview: title, createdAt: now }] : [],
      messages: owned ? history : [], loadedTurnIds: owned ? [run.userMessageId] : [], revision: 'toolbar', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: owned ? run : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: owned ? [run] : [] }
    : path === '/api/v1/conversation/history' ? owned ? history : []
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/changes' ? owned ? changes : []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'toolbar', sessionId: id, namespace: { id: 'toolbar-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'toolbar' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const detail = () => page.locator('.work-session-artifacts__detail:visible')
const scope = () => detail().getByRole('button', { name: '差异范围', exact: true })
const zoom = () => detail().getByRole('button', { name: '缩放', exact: true })
async function choose(control: Locator, label: string): Promise<void> {
  await control.click(); await page.getByRole('menuitem', { name: label, exact: false }).click()
  await expect(control).toContainText(label)
}
async function expectDocument(): Promise<void> {
  await expect(detail().locator('iframe.document-preview__frame').first().contentFrame().getByText('DOCUMENT_TOOLBAR_REAL_CONTENT')).toBeVisible()
  await expect(detail().locator('[data-document-capability="docx"]')).toContainText('只读预览')
}

test.beforeAll(async () => {
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'document-toolbar-profile-'))
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCUMENT_TOOLBAR_REAL_CONTENT</w:t></w:r></w:p><w:p><w:r><w:t>真实 DOCX 预览，验证缩放和范围切换后仍可阅读。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>')
  bytes = await zip.generateAsync({ type: 'nodebuffer' })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1500, 1000); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, modelId, now }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, modelId, now })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await page.locator('.work-progress-panel__review-summary').click()
  await expect(scope()).toContainText('当前内容'); await expectDocument()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath(`${info.status}.png`), animations: 'allow' })
  await info.attach('fixture-audit', { body: JSON.stringify({ errors, mutations, reads }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) { const target = resolve(fixture); if (dirname(target) !== tempRoot || !basename(target).startsWith('document-toolbar-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

test('当前内容、待确认改动、修改记录保留真实文档预览；缩放改变文档而非仅更新标签', async () => {
  await expect(detail().locator('.work-session-artifacts__file-header').getByRole('button', { name: '差异范围', exact: true })).toBeVisible()
  await expect(detail().locator('.work-session-artifacts__scope')).toHaveCount(0)
  await expect(detail().locator('.document-preview__header > .document-preview__format-note')).toBeVisible()
  await expect(detail().locator('.document-preview__header > .document-preview__toolbar--zoom')).toBeVisible()
  for (const label of ['待确认改动', '修改记录', '当前内容']) {
    await choose(scope(), label); await expectDocument()
    if (label !== '当前内容') await expect(detail().locator('.work-session-artifacts__notice')).toContainText('不代表所选历史版本')
  }
  const frame = detail().locator('iframe.document-preview__frame').first().contentFrame()
  const initialScale = await frame.locator('main.document-page').evaluate(element => Number(element.style.zoom))
  await choose(zoom(), '100%')
  await expect.poll(() => frame.locator('main.document-page').evaluate(element => Number(element.style.zoom))).toBe(1)
  await choose(zoom(), '适应宽度')
  await expect.poll(() => frame.locator('main.document-page').evaluate(element => Number(element.style.zoom))).toBeCloseTo(initialScale, 2)
  expect(initialScale).toBeLessThan(1)
  await expectDocument(); expect(reads.length).toBeGreaterThan(0)
})

test('深浅主题两个下拉无底色边框，键盘焦点与菜单选择仍可用', async () => {
  for (const appearance of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
    for (const control of [scope(), zoom()]) {
      await page.mouse.move(1, 1)
      await expect.poll(() => control.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: parseFloat(style.borderTopWidth) } })).toEqual({ background: 'rgba(0, 0, 0, 0)', border: 0 })
      await control.hover()
      await expect.poll(() => control.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      await page.mouse.down()
      expect(await control.evaluate(element => ({ active: element.matches(':active'), background: getComputedStyle(element).backgroundColor, border: parseFloat(getComputedStyle(element).borderTopWidth) }))).toEqual({ active: true, background: 'rgba(0, 0, 0, 0)', border: 0 })
      await page.mouse.up(); await page.keyboard.press('Escape')
      await page.keyboard.press('Tab'); await control.focus()
      await expect(control).toBeFocused()
      expect(await control.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      expect(await control.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
      await page.keyboard.press('Enter'); await expect(page.getByRole('menu', { name: await control.getAttribute('aria-label') ?? '' })).toBeVisible()
      await page.keyboard.press('Escape'); await expect(control).toBeFocused()
    }
  }
})

test('窄面板保留完整说明与长文件标题提示，工具栏没有横向溢出', async () => {
  if (!app) throw new Error('Missing Electron application')
  // Below 990px Work intentionally switches to one full-width surface. Keep
  // the real split layout and use its keyboard divider to constrain preview.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900))
  const divider = page.getByRole('separator', { name: '调整对话与工作区宽度', exact: true })
  await expect(divider).toBeVisible(); await divider.focus()
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => detail().evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(500)
  await expect(scope()).toBeVisible(); await expect(zoom()).toBeVisible(); await expectDocument()
  await expect(detail().locator('.work-session-artifacts__file-header strong')).toHaveAttribute('title', filePath)
  const geometry = await detail().locator('.work-session-artifacts__file-header, .document-preview__header').evaluateAll(elements => elements.map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth })))
  expect(geometry.length).toBeGreaterThanOrEqual(2)
  for (const item of geometry) expect(item.scroll - item.client, item.name).toBeLessThanOrEqual(1)
  await expect(detail().locator('[data-document-capability="docx"]')).toContainText('分页以 Word 为准')
})
