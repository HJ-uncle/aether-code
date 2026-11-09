/** Real Electron: compact final-delivery tiles, bounded PNG thumbnails, image
 * decode failures, shared image/Office/PDF previews and byte-exact downloads.
 * All assets belong to an authenticated immutable manifest in an isolated fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import pptxgen from 'pptxgenjs'
import mdiIcons from '@iconify-json/mdi/icons.json'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const token = 'disposable-final-delivery-token', sessionId = 'work-final-delivery-ui', modelId = 'final-delivery-fixture'
const title = '最终交付附件列表', now = Date.now() - 10_000
const names = { tiny: '透明像素.png', landscape: '横向设计稿.png', portrait: '竖向长图.png', broken: '损坏图片.png',
  xlsx: '项目明细.xlsx', docx: '项目说明.docx', pptx: '项目汇报.pptx', pdf: '交付摘要.pdf' }
type AssetId = keyof typeof names
type Asset = { name: string; bytes: Buffer; mimeType: string; kind: 'file' | 'image' }
const assets = new Map<AssetId, Asset>()
const errors: string[] = [], reads: string[] = [], mutations: string[] = []
const run: RootRun = { schemaVersion: 1, runId: 'final-delivery-run', sessionId, turnId: 'final-delivery-turn',
  userMessageId: 'final-delivery-user', assistantMessageId: 'final-delivery-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now + 100, finishedAt: now + 100 }
let result: FinalResult, app: ElectronApplication | undefined, page: Page, fixture = '', downloadDirectory = ''
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

// Generate real PNG pixels in Node so dimensions/transparency are independent
// of browser rendering, network images and any installed image tooling.
function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]), prefix = Buffer.alloc(4), suffix = Buffer.alloc(4)
    prefix.writeUInt32BE(data.length)
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([prefix, body, suffix])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const row = Buffer.alloc(1 + width * 4)
  for (let index = 1; index < row.length; index += 4) row.set(rgba, index)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
async function createAssets(): Promise<void> {
  const image = (id: AssetId, bytes: Buffer): void => { assets.set(id, { name: names[id], bytes, mimeType: 'image/png', kind: 'image' }) }
  image('tiny', png(1, 1, [0, 0, 0, 0])); image('landscape', png(640, 360, [90, 132, 156, 255])); image('portrait', png(240, 960, [128, 146, 114, 255]))
  image('broken', Buffer.from('This immutable asset has a valid checksum but is not a PNG.'))
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('交付明细')
  sheet.getCell('A1').value = 'DELIVERY_SHEET_READY'; sheet.getColumn(1).width = 32; sheet.getCell('B1').value = 2048
  assets.set('xlsx', { name: names.xlsx, bytes: Buffer.from(await workbook.xlsx.writeBuffer()), kind: 'file',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DELIVERY_DOCX_READY</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')
  assets.set('docx', { name: names.docx, bytes: await zip.generateAsync({ type: 'nodebuffer' }), kind: 'file',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const presentation = new pptxgen(); presentation.layout = 'LAYOUT_WIDE'
  presentation.addSlide().addText('DELIVERY_PPTX_READY', { x: 0.5, y: 0.5, w: 10, h: 1, fontSize: 24 })
  assets.set('pptx', { name: names.pptx, bytes: await presentation.write({ outputType: 'nodebuffer' }) as Buffer, kind: 'file',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([600, 800]).drawText('DELIVERY_PDF_READY', { x: 50, y: 720, size: 18, font })
  assets.set('pdf', { name: names.pdf, bytes: Buffer.from(await pdf.save()), mimeType: 'application/pdf', kind: 'file' })
  result = { schemaVersion: 1, sessionId, runId: run.runId, turnId: run.turnId, assistantMessageId: run.assistantMessageId,
    text: '文件已准备好，可直接预览或下载。', publishedAt: now + 100,
    items: [...assets].map(([id, asset]) => ({ id, assetId: id, name: asset.name, path: `交付/${asset.name}`,
      mimeType: asset.mimeType, size: asset.bytes.length, sha256: hash(asset.bytes), kind: asset.kind })) }
}
function history(id: string): EngineHistoryRow[] {
  return id !== sessionId ? [] : [
    { id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: result.text, createdAt: now + 100,
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
    mutations.push(`${request.method} ${path}`); throw new Error(`Preview must not mutate ${path}`)
  }
  if (path === '/api/v1/conversation/result-asset') {
    const assetId = url.searchParams.get('assetId') ?? '', asset = assets.get(assetId as AssetId)
    if (!asset || id !== sessionId || url.searchParams.get('runId') !== run.runId) throw new Error('Foreign or unknown result asset')
    reads.push(assetId)
    response.end(envelope({ content: asset.bytes.toString('base64'), isBinary: true, encoding: 'base64', totalSize: asset.bytes.length,
      mimeType: asset.mimeType, tooLarge: false, truncated: false })); return
  }
  if (path === '/api/v1/workspace/file/content') throw new Error('Published assets must not read mutable workspace files')
  const rows = history(id), matching = id === sessionId ? run : null
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'final-delivery-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'final-delivery-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '交付测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'final-delivery', sessionId: id,
      namespace: { id: 'final-delivery-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/final-delivery', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/final-delivery' }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const deliveries = (): Locator => page.locator('.work-view').getByRole('region', { name: '最终交付物', exact: true })
const row = (id: AssetId): Locator => deliveries().locator(`article[data-final-result-item="${id}"]`)
const preview = (): Locator => page.locator('.work-final-result:visible')
async function openAsset(id: AssetId, keyboard = false): Promise<void> {
  const button = row(id).getByRole('button', { name: `预览 ${names[id]}`, exact: true })
  if (keyboard) { await button.focus(); await expect(button).toBeFocused(); await button.press('Enter') }
  else await button.click()
  await expect(preview()).toHaveAttribute('data-final-result-item', id)
}
async function closeWorkspace(): Promise<void> {
  const close = page.locator('.work-view').getByRole('button', { name: '收起工作区', exact: true })
  if (await close.isVisible()) await close.click()
}
async function actionRects(id: AssetId): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return row(id).evaluate(element => {
    const card = element.getBoundingClientRect()
    return Array.from(element.querySelectorAll('.work-final-deliverable__actions > button')).map(button => {
      const rect = button.getBoundingClientRect()
      return { x: rect.left - card.left, y: rect.top - card.top, width: rect.width, height: rect.height }
    })
  })
}
async function verifyDocumentGlyphs(): Promise<void> {
  const generic = [...mdiIcons.icons['file-outline'].body.matchAll(/\bd="([^"]+)"/g)].map(match => match[1]).join('|')
  const paths: string[] = []
  for (const id of ['xlsx', 'docx', 'pptx', 'pdf'] as const) {
    const icon = row(id).locator('.work-final-deliverable__thumbnail svg')
    await expect(icon).toHaveCount(1)
    const glyph = await icon.evaluate(element => ({
      path: Array.from(element.querySelectorAll('path')).map(path => path.getAttribute('d')).join('|'),
      color: getComputedStyle(element).color,
      inherited: element.parentElement ? getComputedStyle(element.parentElement).color : ''
    }))
    expect(glyph.path.length).toBeGreaterThan(0); expect(glyph.path).not.toBe(generic)
    expect(glyph.color).not.toBe(glyph.inherited)
    paths.push(glyph.path)
  }
  expect(new Set(paths).size).toBe(4)
}
async function waitForTileLayout(viewport?: { width: number; height: number }): Promise<void> {
  let previous = ''
  // Electron's resize acknowledgement precedes renderer layout and sidebar
  // transitions. Wait for actual geometry, not an arbitrary resize delay.
  await expect.poll(async () => {
    const snapshot = await deliveries().evaluate(element => {
      const rectangles = [element, ...element.querySelectorAll('article')].map(item => {
        const rect = item.getBoundingClientRect()
        return [rect.left, rect.top, rect.width, rect.height]
      })
      const animating = document.getAnimations().some(animation =>
        (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().endTime !== Infinity)
      return { width: innerWidth, height: innerHeight, animating, signature: JSON.stringify(rectangles), count: rectangles.length - 1 }
    })
    const stable = snapshot.signature === previous
    previous = snapshot.signature
    return stable && !snapshot.animating && snapshot.count === assets.size && (!viewport ||
      snapshot.width === viewport.width && snapshot.height === viewport.height)
  }, { message: 'Wait for the requested viewport and settled attachment geometry' }).toBe(true)
}

async function verifyCompactTiles(viewport?: { width: number; height: number }): Promise<void> {
  await expect(deliveries().locator('article')).toHaveCount(assets.size)
  await waitForTileLayout(viewport)
  const heights: number[] = []
  for (const [id, asset] of assets) {
    for (const action of ['预览', '下载']) {
      const button = row(id).getByRole('button', { name: `${action} ${asset.name}`, exact: true })
      await expect(button).toBeEnabled(); await expect(button).toHaveText(action)
      await expect(button).toHaveCSS('border-radius', '0px')
    }
    const bar = row(id).locator('.work-final-deliverable__actions')
    await expect(bar.locator(':scope > button')).toHaveCount(2)
    await expect(bar).toHaveCSS('border-top-style', 'solid')
    // Every relative-edge assertion must use the same layout sample. Comparing
    // separate boundingBox calls can mistake moving cards for detached footers.
    const { border, rect, controls, bounds, overflow } = await row(id).evaluate(element => {
      const actions = element.querySelector('.work-final-deliverable__actions')
      if (!actions) throw new Error('Missing integrated action bar')
      const card = element.getBoundingClientRect(), bar = actions.getBoundingClientRect()
      return { border: parseFloat(getComputedStyle(actions).borderTopWidth),
        bounds: { x: card.left, y: card.top, width: card.width, height: card.height },
        rect: { x: bar.left, y: bar.top, width: bar.width, height: bar.height },
        controls: Array.from(actions.querySelectorAll(':scope > button')).map(button => {
          const bounds = button.getBoundingClientRect()
          return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width }
        }), overflow: element.scrollWidth - element.clientWidth }
    })
    expect(border).toBeGreaterThan(0); expect(border).toBeLessThanOrEqual(2)
    expect(controls).toHaveLength(2)
    expect(Math.abs(controls[0].left - rect.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(controls[0].right - controls[1].left)).toBeLessThanOrEqual(1)
    expect(Math.abs(controls[1].right - rect.x - rect.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(controls[0].width - controls[1].width)).toBeLessThanOrEqual(2)
    expect(Math.abs(controls[0].top - controls[1].top)).toBeLessThanOrEqual(1)
    if (id !== 'broken') {
      await expect(row(id)).toContainText(asset.name.split('.').at(-1)!.toUpperCase())
      await expect(row(id)).toContainText(/\b(?:B|KB|MB)\b/)
    }
    expect(Math.abs(rect.x - bounds.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(rect.width - bounds.width)).toBeLessThanOrEqual(4)
    expect(bounds.height).toBeGreaterThanOrEqual(48)
    expect(bounds.height).toBeLessThanOrEqual(104)
    heights.push(bounds.height)
    expect(overflow).toBeLessThanOrEqual(2)
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(4)
  for (const id of ['tiny', 'landscape', 'portrait'] as const) {
    // The thumbnail is decorative and belongs to the static file information.
    const thumbnail = row(id).locator('.work-final-deliverable__thumbnail img')
    await expect.poll(() => thumbnail.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const bounds = await thumbnail.boundingBox()
    if (!bounds) throw new Error(`Missing thumbnail ${id}`)
    expect(bounds.width).toBeLessThanOrEqual(34); expect(bounds.height).toBeLessThanOrEqual(34)
  }
  await expect.poll(() => row('tiny').locator('.work-final-deliverable__thumbnail img').evaluate(element => {
    const image = element as HTMLImageElement
    return [image.naturalWidth, image.naturalHeight]
  })).toEqual([1, 1])
  await verifyDocumentGlyphs()
}

test.describe.serial('Work 最终交付附件列表', () => {
  test.beforeAll(async () => {
    await createAssets()
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'final-deliverables-profile-'))
    downloadDirectory = join(fixture, 'downloads'); mkdirSync(downloadDirectory)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/final-delivery', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow, session }, downloads) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus()
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${downloads}/${item.getFilename()}`))
    }, downloadDirectory)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
        updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 44 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
    await page.reload(); await expect(deliveries()).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('final-deliverables-failure.png'); await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('delivery-http', { body: JSON.stringify({ errors, reads, mutations }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtures || !basename(target).startsWith('final-deliverables-profile-')) throw new Error(`Unsafe cleanup ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('附件卡片紧凑同高，静态名称和缩略图不会误触预览，右键操作保持可用', async ({}, info) => {
    await expect(row('broken').getByRole('alert')).toContainText('缩略图暂不可用')
    await verifyCompactTiles()
    const first = await row('tiny').boundingBox(), second = await row('landscape').boundingBox(), third = await row('portrait').boundingBox()
    if (!first || !second || !third) throw new Error('Missing attachment tile geometry')
    expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(2)
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.width)
    expect(third.y).toBeGreaterThanOrEqual(first.y + first.height)
    for (const target of [row('landscape').locator('strong'), row('landscape').locator('.work-final-deliverable__thumbnail')]) {
      await target.click(); await expect(preview()).toHaveCount(0)
      await target.dblclick(); await expect(preview()).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: names.landscape, exact: true })).toHaveCount(0)
    }
    const count = reads.filter(id => id === 'broken').length
    const priorControls = await actionRects('broken')
    await row('broken').getByRole('button', { name: `重新加载 ${names.broken}`, exact: true }).click()
    await expect.poll(() => reads.filter(id => id === 'broken').length).toBeGreaterThan(count)
    await expect(row('broken').getByRole('alert')).toContainText('缩略图暂不可用')
    const nextControls = await actionRects('broken')
    expect(nextControls).toHaveLength(2)
    for (let index = 0; index < 2; index++) for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(nextControls[index][dimension] - priorControls[index][dimension])).toBeLessThanOrEqual(1)
    }
    const information = row('landscape').getByRole('group', { name: names.landscape, exact: true })
    const menu = page.locator('.context-menu:not(.context-menu--submenu):not([aria-hidden="true"])')
    await information.focus(); await information.press('Shift+F10')
    await expect(menu.getByRole('menuitem', { name: '复制文件路径', exact: true })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: '下载', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(information).toBeFocused()
    await information.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '下载', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
    const path = info.outputPath('final-deliverables-light-wide.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('浅色附件列表', { path, contentType: 'image/png' })
  })

  test('明确的预览按钮进入原有图片预览并可放大查看', async () => {
    for (const [id, dimensions] of [['tiny', [1, 1]], ['landscape', [640, 360]], ['portrait', [240, 960]]] as const) {
      await openAsset(id)
      const image = preview().getByRole('img', { name: names[id], exact: true })
      await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([...dimensions])
      await preview().getByRole('button', { name: `放大查看 ${names[id]}`, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: names[id], exact: true })
      await expect(dialog.getByRole('img', { name: names[id], exact: true })).toBeVisible()
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
    }
    await closeWorkspace()
  })

  test('办公附件进入共享Excel、Word、PowerPoint与PDF预览', async () => {
    await openAsset('xlsx')
    await expect(preview().getByRole('cell', { name: 'DELIVERY_SHEET_READY', exact: true })).toBeVisible({ timeout: 60_000 })
    for (const id of ['xlsx', 'docx', 'pptx', 'pdf'] as const) {
      const item = page.locator('.work-artifacts-workspace__files > button').filter({ hasText: names[id] })
      await expect(item).toHaveCount(1)
      const icon = item.locator('svg')
      await expect(icon).toHaveCount(1)
      const source = await row(id).locator('.work-final-deliverable__thumbnail svg').evaluate(element =>
        Array.from(element.querySelectorAll('path')).map(path => path.getAttribute('d')).join('|'))
      expect(source.length).toBeGreaterThan(0)
      expect(await icon.evaluate(element => Array.from(element.querySelectorAll('path')).map(path => path.getAttribute('d')).join('|'))).toBe(source)
    }
    for (const [id, content] of [['docx', 'DELIVERY_DOCX_READY'], ['pptx', 'DELIVERY_PPTX_READY']] as const) {
      await openAsset(id, id === 'docx')
      const frame = preview().locator(`.document-preview[data-document-preview="${id}"] iframe`).first()
      await expect(frame).toBeVisible({ timeout: 60_000 })
      await expect(frame.contentFrame().getByText(content, { exact: true })).toBeVisible({ timeout: 60_000 })
    }
    await openAsset('pdf')
    await expect(preview().locator('canvas[data-rendered-page="1"]')).toBeVisible({ timeout: 60_000 })
    await expect(preview().locator('.document-preview__pdf-text')).toContainText('DELIVERY_PDF_READY', { timeout: 60_000 })
    await closeWorkspace()
  })

  test('全部下载按钮只保存发布原件、不联动预览，包括无法解码的图片', async () => {
    await closeWorkspace()
    for (const [id, asset] of assets) {
      const target = join(downloadDirectory, asset.name)
      expect(existsSync(target)).toBe(false)
      await row(id).getByRole('button', { name: `下载 ${asset.name}`, exact: true }).click()
      await expect.poll(() => existsSync(target) ? hash(readFileSync(target)) : null).toBe(hash(asset.bytes))
      await expect(preview()).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: asset.name, exact: true })).toHaveCount(0)
    }
  })

  test('窄窗深浅色从双列收为单列，预览下载始终是明确的独立按钮', async ({}, info) => {
    await closeWorkspace()
    for (const width of [760, 560]) for (const appearance of ['light', 'dark']) {
      await app!.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(width, 1100) }, width)
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), appearance)
      await verifyCompactTiles({ width, height: 1100 })
      const { boxes, containerWidth, viewportWidth } = await deliveries().evaluate(element => ({
        containerWidth: element.clientWidth, viewportWidth: innerWidth,
        boxes: Array.from(element.querySelectorAll('article')).map(card => {
          const bounds = card.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
        })
      }))
      if (width === 560) {
        expect(containerWidth).toBeLessThanOrEqual(459)
        for (let index = 1; index < boxes.length; index++) {
          expect(Math.abs(boxes[index].left - boxes[0].left)).toBeLessThanOrEqual(2)
          expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 2)
        }
      } else {
        expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThanOrEqual(2)
        expect(boxes[1].left).toBeGreaterThanOrEqual(boxes[0].right)
      }
      expect(boxes[0].left).toBeGreaterThanOrEqual(0)
      for (const box of boxes) expect(box.right).toBeLessThanOrEqual(viewportWidth)
      const path = info.outputPath(`final-deliverables-${appearance}-${width}.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`窄窗-${appearance}-${width}`, { path, contentType: 'image/png' })
    }
  })
})
