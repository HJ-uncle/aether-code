/** Fresh Word/PDF/Excel Work acceptance. Original binary files come from the
 * current built engine, then pass through real Work IPC, workers and previews.
 * Fixture engine is isolated; no production models, old E2E or export dialogs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ExcelJS from 'exceljs'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { WorkbenchBridge, WorkbenchAction } from '../../ai-agent-engine/src/tools/workbench/bridge'
import type { AgentContext, ToolResult } from '../../ai-agent-engine/src/core/agent-context'
import type { BrowserExecutionIdentity } from '../../ai-agent-engine/src/core/browser-execution'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sessionId = 'work-office-content-audit', modelId = 'office-audit-fixture', token = 'office-audit-instance-token'
const title = '办公文件内容与预览验收', now = Date.now(), identity = { tenantId: 'default' }
const ctx = { sessionId, rootSessionId: sessionId, rootRunId: 'office-audit-run' } as AgentContext
const importBuilt = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
const errors: string[] = [], files = new Map<string, Buffer>(), hashes = new Map<string, string>()
let bridge: WorkbenchBridge, app: ElectronApplication | undefined, page: Page
let fixture = '', workspace = '', connected = false, pdfPages = 0
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
      if (body.sessionId === sessionId) connected = true
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
    const relative = url.searchParams.get('path') ?? '', bytes = files.get(relative)
    if (id !== sessionId || !bytes) throw new Error(`Unexpected file read: ${relative}`)
    response.end(envelope({ content: bytes.toString('base64'), isBinary: true, totalSize: bytes.length, root: workspace, bindingEpoch: 'audit-one' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'office-audit-engine' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Office 验收夹具', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'default', sessionId: id, namespace: { id: 'office-audit-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 0 }]
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'audit-one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => {
  const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
  if (status !== 409) errors.push(String(error))
  if (!response.headersSent) response.writeHead(status)
  response.end(JSON.stringify({ code: status, message: String(error), data: null }))
}) })

test.beforeAll(async () => {
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'office-audit-profile-'))
  workspace = join(fixture, 'workspace'); mkdirSync(workspace)
  const engineDist = resolve(root, '../ai-agent-engine/dist')
  const { WorkbenchBridge } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/workbench/bridge')>(pathToFileURL(join(engineDist, 'tools/workbench/bridge.js')).href)
  bridge = new WorkbenchBridge()
  const { createDocx } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/docx')>(pathToFileURL(join(engineDist, 'tools/office/docx.js')).href)
  const { createPdf, inspectPdf } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/pdf')>(pathToFileURL(join(engineDist, 'tools/office/pdf.js')).href)
  const { createXlsx, appendXlsxSheets } = await importBuilt<typeof import('../../ai-agent-engine/src/tools/office/xlsx')>(pathToFileURL(join(engineDist, 'tools/office/xlsx.js')).href)
  const paragraphs = Array.from({ length: 100 }, (_, index) => `第${index + 1}段：${'长文档必须保留全部正文，区段不能当作实际页码。'.repeat(5)}`)
  files.set('content.docx', await createDocx({ title: 'Word 连续内容验收', markdown: '第一行  \n第二行\n\n1. 步骤甲\n\n1. 步骤乙\n\n' + paragraphs.join('\n\n') + '\n\nWORD_AUDIT_END' }))
  files.set('content.pdf', await createPdf({ title: 'PDF 内容验收', markdown: '# 中文正文与分页\n\n' + paragraphs.slice(0, 35).join('\n\n') + '\n\nPDF_AUDIT_END' }))
  pdfPages = Number((await inspectPdf(files.get('content.pdf')!)).summary.pages)
  let xlsx = await createXlsx({ sheets: [{ name: '长文本', columns: [
    { header: '事项', key: 'item', type: 'text', width: 30 }, { header: '数值', key: 'value', type: 'number', width: 18 }
  ], rows: Array.from({ length: 140 }, (_, index) => ({ item: index === 0 ? '第一行\n第二行\n第三行\n第四行\n第五行\n第六行' : `记录 ${index + 1}`, value: index === 0 ? 0.001 : index + 1 })) }] })
  xlsx = await appendXlsxSheets(xlsx, { sheets: [{ name: '字体', columns: [{ header: '标题字号', key: 'text', type: 'text', width: 45 }], rows: [{ text: '正文使用原文件字号' }] }] })
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx)
  const styleSheet = workbook.getWorksheet('字体')!
  styleSheet.getCell('A1').font = { name: 'Microsoft YaHei', size: 24, bold: true }
  styleSheet.getRow(1).height = 50
  styleSheet.getCell('A2').font = { name: 'Arial', size: 16 }
  styleSheet.getRow(2).height = 36
  files.set('content.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))
  for (const [name, bytes] of files) {
    writeFileSync(join(workspace, name), bytes)
    hashes.set(name, createHash('sha256').update(bytes).digest('hex'))
  }
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark', thinkingMode: 'off' }))
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
    bridge?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== tempRoot || !basename(target).startsWith('office-audit-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

async function open(name: string) {
  const result = await bridge.execute('artifact.open', { path: join(workspace, name) }, ctx)
  expect(result.success, result.output).toBe(true)
  return page.locator(`.document-preview[data-document-preview="${name.split('.').pop()}"]:visible`)
}

test('Word preserves hard breaks and long content without claiming section counts are page counts', async ({}, info) => {
  const preview = await open('content.docx')
  await expect(preview.getByText('连续内容预览 · 分页以 Word 为准')).toBeVisible()
  await expect(preview.locator('[data-document-sections="1"]')).toBeVisible()
  await expect(preview.locator('[data-document-pages]')).toHaveCount(0)
  const iframe = preview.locator('iframe[title="content.docx · 预览区段 1"]')
  await expect(iframe).toBeVisible()
  const frame = iframe.contentFrame()
  await expect(frame.getByText('WORD_AUDIT_END', { exact: true })).toBeAttached()
  await expect(frame.locator('p').filter({ hasText: '第一行' }).locator('br')).toHaveCount(1)
  await expect(frame.getByText('步骤甲', { exact: true })).toBeAttached()
  await expect(frame.getByText('步骤乙', { exact: true })).toBeAttached()
  await expect(frame.locator('p').filter({ hasText: /第\d+段：/ })).toHaveCount(100)
  await preview.screenshot({ path: info.outputPath('word-content-top.png') })
  const body = preview.locator('.document-preview__body')
  // Fit-to-width varies with the available Work pane; test reachability instead
  // of assuming a fixed pixel height for the same document on every monitor.
  await expect.poll(() => body.evaluate(element => element.scrollHeight / element.clientHeight)).toBeGreaterThan(3)
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => iframe.evaluate(element => {
    const target = element.contentDocument?.body.innerText.includes('WORD_AUDIT_END')
    const rect = element.contentDocument?.querySelector('main')?.getBoundingClientRect()
    return Boolean(target && rect && element.clientHeight >= rect.height - 2)
  })).toBe(true)
  await expect.poll(async () => {
    const end = await frame.getByText('WORD_AUDIT_END', { exact: true }).boundingBox(), viewport = await body.boundingBox()
    return Boolean(end && viewport && end.y >= viewport.y && end.y + end.height <= viewport.y + viewport.height + 1)
  }).toBe(true)
  await preview.screenshot({ path: info.outputPath('word-content-end.png') })
  expect(errors).toEqual([])
})

test('Excel shows all wrapped lines, small numbers and original typography after sheet navigation', async ({}, info) => {
  const preview = await open('content.xlsx')
  const table = preview.getByRole('table', { name: '长文本' })
  const cell = table.getByRole('cell', { name: '第一行 第二行 第三行 第四行 第五行 第六行', exact: true })
  await expect(cell).toBeVisible()
  await expect(table.getByRole('cell', { name: '0.001', exact: true })).toBeVisible()
  const metrics = await cell.evaluate(element => ({ height: element.getBoundingClientRect().height, scroll: element.scrollHeight, client: element.clientHeight, size: getComputedStyle(element).fontSize, family: getComputedStyle(element).fontFamily }))
  expect(metrics.height).toBeGreaterThan(100)
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1)
  expect(Number.parseFloat(metrics.size)).toBeCloseTo(10 * 4 / 3, 1)
  expect(metrics.family).toContain('Microsoft YaHei')
  await preview.screenshot({ path: info.outputPath('excel-wrapped-lines.png') })
  const body = preview.locator('.document-preview__body--sheet')
  await body.evaluate(element => { element.scrollLeft = element.scrollWidth })
  await expect.poll(async () => {
    const value = await table.getByRole('cell', { name: '0.001', exact: true }).boundingBox(), viewport = await body.boundingBox()
    return Boolean(value && viewport && value.x >= viewport.x && value.x + value.width <= viewport.x + viewport.width + 1)
  }).toBe(true)
  await preview.screenshot({ path: info.outputPath('excel-number-horizontal-scroll.png') })
  await body.evaluate(element => { element.scrollLeft = 0 })
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(table.getByRole('cell', { name: '记录 140', exact: true })).toBeVisible()
  await preview.getByRole('tab', { name: '字体', exact: true }).click()
  const heading = preview.getByRole('cell', { name: '标题字号', exact: true })
  await expect(heading).toBeVisible()
  expect(await heading.evaluate(element => getComputedStyle(element).fontSize)).toBe('32px')
  for (const appearance of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
    await preview.screenshot({ path: info.outputPath(`excel-font-${appearance}.png`) })
  }
  await preview.getByRole('tab', { name: '字体', exact: true }).press('ArrowLeft')
  await expect(preview.getByRole('tab', { name: '长文本', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(cell).toBeVisible()
  expect(errors).toEqual([])
})

test('PDF paints real pages and keeps final content available; all previews leave source bytes unchanged', async ({}, info) => {
  const preview = await open('content.pdf')
  expect(pdfPages).toBeGreaterThan(2)
  await expect(preview.locator(`[data-document-pages="${pdfPages}"]`)).toBeVisible()
  const canvas = preview.locator('canvas').first()
  await expect.poll(() => canvas.evaluate(element => element.width)).toBeGreaterThan(100)
  await expect(preview.locator('.document-preview__pdf-text').first()).toContainText('中文正文与分页')
  await preview.screenshot({ path: info.outputPath('pdf-first-page.png') })
  const last = preview.locator('.document-preview__pdf-shell').last()
  await last.scrollIntoViewIfNeeded()
  await expect(last.locator('.document-preview__pdf-text')).toContainText('PDF_AUDIT_END')
  await expect.poll(() => last.locator('canvas').evaluate(element => element.width)).toBeGreaterThan(100)
  await preview.screenshot({ path: info.outputPath('pdf-last-page.png') })
  for (const [name, hash] of hashes) expect(createHash('sha256').update(readFileSync(join(workspace, name))).digest('hex')).toBe(hash)
  expect(errors).toEqual([])
})
