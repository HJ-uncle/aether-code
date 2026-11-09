/** Real Work delivery previews + authenticated asset HTTP + Office/PDF workers.
 * Covers original worksheet colors and shared menus, selection/clipboard,
 * scriptless Office focus and inactive previews. Build first; one Electron lane. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'document-paper-theme-token', sessionId = 'work-document-paper', modelId = 'document-paper-model'
const title = '文档原始纸面与主题回归', now = Date.now() - 10_000
const sheetName = '原始单元格样式', otherSheet = '第二张工作表', xlsxName = '纸面颜色测试.xlsx'
const docxName = '菜单文档.docx', pdfName = '菜单文档.pdf', textName = '菜单文本.txt', imageName = '菜单图片.png'
const docxText = 'DOCX_MENU_SELECTED', pdfText = 'PDF_MENU_SELECTED', plainText = 'TEXT_MENU_SELECTED\nTEXT_SECOND_LINE\n'
const assets = new Map<string, { name: string; bytes: Buffer; mimeType: string; kind?: 'file' | 'image' }>()
const errors: string[] = [], reads: string[] = [], mutations: string[] = [], workerUrls: string[] = []
const observations: Array<Record<string, unknown>> = []
const run: RootRun = { schemaVersion: 1, runId: 'document-paper-run', sessionId, turnId: 'document-paper-turn',
  userMessageId: 'document-paper-user', assistantMessageId: 'document-paper-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
let result: FinalResult, app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

async function createDocuments(): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(sheetName)
  sheet.getColumn(1).width = 31; sheet.getColumn(2).width = 26
  sheet.getCell('A1').value = 'DEFAULT_NO_STYLE'
  sheet.getCell('A2').value = 'DARK_TEXT_NO_FILL'; sheet.getCell('A2').font = { color: { argb: 'FF222222' } }
  sheet.getCell('A3').value = 'LIGHT_FILL_ORIGINAL'; sheet.getCell('A3').font = { color: { argb: 'FF123456' } }
  sheet.getCell('A3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
  sheet.getCell('A4').value = 'DARK_FILL_WHITE_TEXT'; sheet.getCell('A4').font = { color: { argb: 'FFFFFFFF' }, bold: true }
  sheet.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF203864' } }
  sheet.getCell('A4').border = { bottom: { style: 'medium', color: { argb: 'FFCC5500' } } }
  sheet.getCell('B1').value = 123
  sheet.getCell('B2').value = { formula: 'B1*2', result: 246 }
  const second = workbook.addWorksheet(otherSheet)
  second.getColumn(1).width = 31
  second.getCell('A1').value = 'SECOND_SHEET_DEFAULT'
  second.getCell('A2').value = 'SECOND_SHEET_ORIGINAL'; second.getCell('A2').font = { color: { argb: 'FF004400' } }
  second.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0D9' } }
  assets.set('paper-xlsx', { name: xlsxName, bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${docxText}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
  assets.set('menu-docx', { name: docxName, bytes: await zip.generateAsync({ type: 'nodebuffer' }),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([600, 800]).drawText(pdfText, { x: 50, y: 720, size: 18, font })
  assets.set('menu-pdf', { name: pdfName, bytes: Buffer.from(await pdf.save()), mimeType: 'application/pdf' })
  assets.set('menu-text', { name: textName, bytes: Buffer.from(plainText), mimeType: 'text/plain' })
  assets.set('menu-image', { name: imageName, bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png', kind: 'image' })
  result = { schemaVersion: 1, sessionId, runId: run.runId, turnId: run.turnId, assistantMessageId: run.assistantMessageId,
    text: '已生成用于验证原始文件颜色的工作簿。', publishedAt: now,
    items: [...assets].map(([assetId, asset]) => ({ id: assetId, assetId, name: asset.name, path: asset.name,
      mimeType: asset.mimeType, size: asset.bytes.length, sha256: createHash('sha256').update(asset.bytes).digest('hex'), kind: asset.kind ?? 'file' })) }
}
function history(id: string): EngineHistoryRow[] {
  return id !== sessionId ? [] : [
    { id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: result.text, createdAt: now + 1,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, finalResult: result } }
  ]
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Preview must not submit or change files: ${path}`)
  }
  if (path === '/api/v1/conversation/result-asset') {
    const assetId = url.searchParams.get('assetId') ?? '', asset = assets.get(assetId)
    if (!asset || id !== sessionId || url.searchParams.get('runId') !== run.runId) throw new Error('Foreign or unknown result asset')
    reads.push(assetId)
    const isBinary = !asset.mimeType.startsWith('text/'), encoding = isBinary ? 'base64' : 'utf8'
    response.end(envelope({ content: asset.bytes.toString(encoding), isBinary, encoding, totalSize: asset.bytes.length,
      mimeType: asset.mimeType, tooLarge: false, truncated: false })); return
  }
  const rows = history(id), matching = id === sessionId ? run : undefined
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'document-paper-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'document-paper-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '文档测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'document-paper', sessionId: id,
      namespace: { id: 'document-paper-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/document-paper', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/document-paper' } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const preview = (kind: 'xlsx' | 'docx' | 'pdf'): Locator => page.locator(`.document-preview[data-document-preview="${kind}"]:visible`)
const cell = (text: string): Locator => preview('xlsx').getByRole('cell', { name: text, exact: true })
const menu = (): Locator => page.locator('.context-menu:not(.context-menu--submenu):not([aria-hidden="true"])')
const copyItem = (): Locator => menu().getByRole('menuitem', { name: /^复制\s+Ctrl\+C$/ })
const allItem = (): Locator => menu().getByRole('menuitem', { name: /^全选\s+Ctrl\+A$/ })
async function openAsset(name: string): Promise<void> {
  await page.locator('.work-view').getByRole('button', { name: `预览 ${name}`, exact: true }).click()
}
async function selectText(target: Locator): Promise<void> {
  await target.evaluate(element => {
    const range = element.ownerDocument.createRange(); range.selectNodeContents(element)
    const selection = element.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  })
}
async function verifyCopy(text: string): Promise<void> {
  await app!.evaluate(({ clipboard }) => clipboard.writeText('DOCUMENT_COPY_SENTINEL'))
  await expect(copyItem()).toBeEnabled(); await copyItem().click(); await expect(menu()).toHaveCount(0)
  await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toBe(text)
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}
async function style(target: Locator) {
  return target.evaluate(element => {
    const computed = getComputedStyle(element)
    let effectiveBackground = 'rgba(0, 0, 0, 0)'
    for (let node: Element | null = element; node; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor
      if (background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') { effectiveBackground = background; break }
    }
    return { color: computed.color, background: computed.backgroundColor, effectiveBackground,
      border: computed.borderBottomColor, inlineColor: (element as HTMLElement).style.color, inlineBackground: (element as HTMLElement).style.backgroundColor }
  })
}
function luminance(color: string): number {
  const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!values || values.length !== 3) throw new Error(`Unexpected computed color: ${color}`)
  const linear = values.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}
async function verifySheet(appearance: 'light' | 'dark'): Promise<void> {
  await expect(preview('xlsx').getByRole('table', { name: sheetName, exact: true })).toBeVisible()
  await expect(cell('DEFAULT_NO_STYLE')).toBeVisible()
  const defaults = await style(cell('DEFAULT_NO_STYLE')), dark = await style(cell('DARK_TEXT_NO_FILL'))
  expect(defaults.background).toBe('rgb(255, 255, 255)')
  expect(luminance(defaults.color)).toBeLessThan(0.08)
  expect(dark).toMatchObject({ background: 'rgb(255, 255, 255)', color: 'rgb(34, 34, 34)', inlineBackground: '' })
  await expect(preview('xlsx').locator('.document-preview__body--sheet')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(preview('xlsx').locator('.document-preview__body--sheet')).toHaveCSS('color-scheme', 'light')
  await expect(preview('xlsx').locator('thead th').first()).toHaveCSS('background-color', 'rgb(245, 245, 247)')
  await expect(cell('DEFAULT_NO_STYLE')).toHaveCSS('border-bottom-color', 'rgb(222, 222, 227)')
  await expect(cell('LIGHT_FILL_ORIGINAL')).toHaveCSS('background-color', 'rgb(255, 242, 204)')
  await expect(cell('LIGHT_FILL_ORIGINAL')).toHaveCSS('color', 'rgb(18, 52, 86)')
  await expect(cell('DARK_FILL_WHITE_TEXT')).toHaveCSS('background-color', 'rgb(32, 56, 100)')
  await expect(cell('DARK_FILL_WHITE_TEXT')).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(cell('DARK_FILL_WHITE_TEXT')).toHaveCSS('border-bottom-color', 'rgb(204, 85, 0)')
  await cell('DARK_FILL_WHITE_TEXT').hover()
  await expect(cell('DARK_FILL_WHITE_TEXT')).toHaveCSS('background-color', 'rgb(32, 56, 100)')
  await expect(cell('DARK_FILL_WHITE_TEXT')).toHaveCSS('background-image', 'none')
  await cell('DEFAULT_NO_STYLE').hover()
  await expect(cell('DEFAULT_NO_STYLE')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(cell('DEFAULT_NO_STYLE')).toHaveCSS('background-image', 'none')
  const toolbar = await style(preview('xlsx').locator('.document-preview__toolbar--sheets'))
  if (appearance === 'dark') expect(luminance(toolbar.effectiveBackground)).toBeLessThan(0.15)
  else expect(luminance(toolbar.effectiveBackground)).toBeGreaterThan(0.7)
  observations.push({ appearance, defaults, dark, toolbar, authorLight: await style(cell('LIGHT_FILL_ORIGINAL')), authorDark: await style(cell('DARK_FILL_WHITE_TEXT')) })
}

test.beforeAll(async () => {
  await createDocuments()
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'document-paper-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: '/remote/document-paper', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  page.on('worker', worker => workerUrls.push(worker.url()))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 44 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    const path = info.outputPath('document-paper-failure.png')
    await page.screenshot({ path }); await info.attach('失败时文档预览', { path, contentType: 'image/png' })
  }
  const path = info.outputPath('document-paper-observations.json')
  writeFileSync(path, JSON.stringify({ reads, mutations, workerUrls, observations, errors }, null, 2))
  await info.attach('文档颜色与加载回执', { path, contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('document-paper-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('real spreadsheet preview retains paper and author colors across app themes and sheet navigation', async ({}, info) => {
  await page.locator('.work-view').getByRole('button', { name: `预览 ${xlsxName}`, exact: true }).click()
  await expect(cell('DEFAULT_NO_STYLE')).toBeVisible({ timeout: 60_000 })
  expect(reads).toContain('paper-xlsx')
  await expect.poll(() => workerUrls.some(url => url.includes('spreadsheet-preview.worker'))).toBe(true)
  for (const appearance of ['dark', 'light', 'dark'] as const) {
    if (await page.locator('html').getAttribute('data-appearance') !== appearance) await setAppearance(appearance)
    await verifySheet(appearance)
    const tabs = preview('xlsx').getByRole('tablist', { name: '工作表', exact: true })
    await tabs.getByRole('tab', { name: otherSheet, exact: true }).click()
    await expect(tabs.getByRole('tab', { name: otherSheet, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(cell('SECOND_SHEET_DEFAULT')).toBeVisible()
    await expect(cell('SECOND_SHEET_DEFAULT')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(cell('SECOND_SHEET_ORIGINAL')).toHaveCSS('background-color', 'rgb(226, 240, 217)')
    await expect(cell('SECOND_SHEET_ORIGINAL')).toHaveCSS('color', 'rgb(0, 68, 0)')
    await tabs.getByRole('tab', { name: otherSheet, exact: true }).press('ArrowLeft')
    await expect(tabs.getByRole('tab', { name: sheetName, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(cell('DARK_FILL_WHITE_TEXT')).toBeVisible()
    const path = info.outputPath(`document-paper-${appearance}-${observations.length}.png`)
    await page.screenshot({ path }); await info.attach(`工作簿纸面 ${appearance}`, { path, contentType: 'image/png' })
  }
  await selectText(cell('DEFAULT_NO_STYLE'))
  await cell('DEFAULT_NO_STYLE').click({ button: 'right' })
  await expect(menu().getByRole('menuitem', { name: '下载', exact: true })).toBeEnabled()
  await verifyCopy('DEFAULT_NO_STYLE')
  await page.keyboard.press('Control+A')
  const worksheetSelection = await preview('xlsx').locator('.document-preview__body').evaluate(element => {
    const selection = element.ownerDocument.getSelection()
    return { text: selection?.toString() ?? '', inside: Boolean(selection?.anchorNode && selection.focusNode &&
      element.contains(selection.anchorNode) && element.contains(selection.focusNode)) }
  })
  expect(worksheetSelection.inside).toBe(true)
  expect(worksheetSelection.text).toContain('DEFAULT_NO_STYLE')
  expect(worksheetSelection.text).toContain('DARK_FILL_WHITE_TEXT')
  expect(worksheetSelection.text).not.toContain(title)
  expect(worksheetSelection.text).not.toContain(xlsxName)
})

test('Office scriptless iframe uses the shared menu, preserves exact copy and restores keyboard focus', async ({}, info) => {
  await openAsset(docxName)
  const frame = preview('docx').locator('.document-preview__frame').first()
  const text = frame.contentFrame().getByText(docxText, { exact: true })
  await expect(text).toBeVisible({ timeout: 60_000 })
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
  await text.evaluate(element => element.ownerDocument.getSelection()?.removeAllRanges())
  await text.click({ button: 'right' })
  await expect(copyItem()).toBeDisabled(); await expect(allItem()).toBeEnabled()
  await expect(menu().getByRole('menuitem', { name: '复制文件路径', exact: true })).toBeEnabled()
  await expect(menu().getByRole('menuitem', { name: /添加.*对话/ })).toHaveCount(0)
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0)
  await expect(frame).toBeFocused()
  await selectText(text); await text.click({ button: 'right' })
  await expect(copyItem()).toBeEnabled()
  await expect(menu()).toHaveAttribute('data-motion-state', 'open')
  const screenshot = info.outputPath('office-shared-document-menu.png')
  await page.screenshot({ path: screenshot }); await info.attach('Office 文档菜单', { path: screenshot, contentType: 'image/png' })
  await verifyCopy(docxText)
  await expect(frame).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(copyItem()).toBeEnabled()
  await page.keyboard.press('Escape'); await expect(frame).toBeFocused()

  await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
  const hiddenFrame = page.locator('.document-preview[data-document-preview="docx"] .document-preview__frame').first()
  await expect(hiddenFrame).toHaveCount(1); await expect(hiddenFrame).toBeHidden()
  await hiddenFrame.evaluate(element => {
    const child = (element as HTMLIFrameElement).contentDocument
    child?.querySelector('main.document-page')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
  })
  await expect(menu()).toHaveCount(0)
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await expect(text).toBeVisible()
  await text.click({ button: 'right' }); await expect(menu()).toBeVisible()
  await page.keyboard.press('Escape')
})

test('PDF text, complete text preview and image use shared document actions without stale selection', async ({}, info) => {
  await openAsset(pdfName)
  const pdfLayer = preview('pdf').locator('.document-preview__pdf-text').first()
  const pdfSpan = pdfLayer.locator('span').filter({ hasText: pdfText }).first()
  await expect(pdfLayer).toHaveAttribute('data-text-status', 'ready', { timeout: 60_000 })
  await expect(pdfSpan).toBeVisible()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await pdfSpan.click({ button: 'right' }); await expect(copyItem()).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(preview('pdf').locator('..')).toBeFocused()
  await selectText(pdfSpan); await pdfSpan.click({ button: 'right' }); await verifyCopy(pdfText)

  await openAsset(textName)
  const textView = page.getByRole('grid', { name: `${textName} 文本预览`, exact: true })
  const firstLine = textView.getByRole('gridcell', { name: 'TEXT_MENU_SELECTED', exact: true })
  await expect(firstLine).toBeVisible()
  await selectText(firstLine); await firstLine.click({ button: 'right' }); await verifyCopy('TEXT_MENU_SELECTED')
  await expect(textView).toBeFocused()
  await page.keyboard.press('Shift+F10'); await allItem().click()
  await page.keyboard.press('Shift+F10'); await verifyCopy(plainText)
  await page.keyboard.press('Shift+F10')
  await menu().getByRole('menuitem', { name: '复制文件路径', exact: true }).click()
  await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(textName)

  await openAsset(imageName)
  const imagePreview = page.locator('.work-final-result:visible .work-final-result__image')
  await expect(imagePreview.locator('img')).toBeVisible()
  await expect.poll(() => imagePreview.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await imagePreview.getByRole('button', { name: `放大查看 ${imageName}`, exact: true }).focus()
  await page.keyboard.press('Control+A')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await imagePreview.locator('img').click({ button: 'right' })
  await expect(copyItem()).toBeDisabled(); await expect(allItem()).toBeDisabled()
  await expect(menu().getByRole('menuitem', { name: '下载', exact: true })).toBeEnabled()
  await expect(menu()).toHaveAttribute('data-motion-state', 'open')
  const screenshot = info.outputPath('image-shared-document-menu.png')
  await page.screenshot({ path: screenshot }); await info.attach('图片文档菜单', { path: screenshot, contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await imagePreview.getByRole('button', { name: `放大查看 ${imageName}`, exact: true }).click()
  const expanded = page.getByRole('dialog', { name: imageName, exact: true })
  await expanded.getByRole('img', { name: imageName, exact: true }).click({ button: 'right' })
  await expect(copyItem()).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await expanded.getByRole('button', { name: '关闭', exact: true }).click()
})
