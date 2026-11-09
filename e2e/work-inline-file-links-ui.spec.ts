/** Real Electron + authenticated static history: Work inline code filenames
 * resolve from successful tool receipts without a final-result manifest or
 * discovery reads. Valid DOCX/XLSX/PPTX bytes exercise the existing preview;
 * ambiguity, explicit links, source Markdown and session ownership stay intact.
 * Build first and run with the dedicated workers: 1 configuration. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'inline-file-links-token', modelId = 'inline-file-links-model', now = Date.now() - 10_000
const taskA = 'work-inline-links-a', taskB = 'work-inline-links-b'
const names = ['2048-项目说明书.docx', '2048-项目台账与测试矩阵.xlsx', '2048-项目汇报.pptx']
const literalName = '#设计 50% 终版.xlsx'
const titles = new Map([[taskA, '工具记录中的项目文件'], [taskB, '另一个任务的同名文件']])
const roots = new Map([[taskA, '/remote/inline-links-a'], [taskB, '/remote/inline-links-b']])
const directories = new Map([[taskA, 'outputs'], [taskB, 'deliverables']])
const runs = new Map<string, RootRun>([taskA, taskB].map(sessionId => [sessionId, {
  schemaVersion: 1, runId: `${sessionId}-run`, sessionId, turnId: `${sessionId}-turn`, userMessageId: `${sessionId}-user`,
  assistantMessageId: `${sessionId}-answer`, seq: 1, version: 2, status: 'succeeded', modelId,
  pending: [], workspacePaths: [roots.get(sessionId)!], createdAt: now, updatedAt: now, finishedAt: now
}]))
const sourceMarkdown = new Map([taskA, taskB].map(id => [id, [
  '| 文件 | 说明 |', '| --- | --- |',
  ...names.map((name, index) => `| \`${name}\` | ${['项目说明', '台账与测试矩阵', '项目汇报'][index]} |`), '',
  `显式链接：[\`${names[0]}\`](/api/v1/workspace/file/download?sessionId=${id}&path=${encodeURIComponent(`${directories.get(id)}/${names[0]}`)})。`, '',
  '普通代码：`node --test`、`unknown.docx`、`report.docx`、`failed.docx`。', '',
  id === taskA ? `精确相对路径：\`draft/report.docx\`；精确完整路径：\`${roots.get(id)}/archive/report.docx\`。`
    : '本任务独有文件：`only-in-b.txt`。', '',
  id === taskA ? `特殊文件：\`${literalName}\`。\n\n其他会话证据不能使用：\`only-in-b.txt\`。` : '另一个会话的路径不能使用：`outputs/2048-项目说明书.docx`。'
].join('\n')]))
interface Asset { bytes: Buffer; marker: string; kind: 'docx' | 'xlsx' | 'pptx' | 'txt' }
const assets = new Map<string, Asset>()
const errors: string[] = [], mutations: string[] = [], scans: string[] = []
const contentReads: Array<{ sessionId: string; path: string; expectedRoot: string | null; bindingEpoch: string | null }> = []
const directoryReads: Array<{ sessionId: string; path: string }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', previewAllowed = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const assetKey = (id: string, path: string): string => JSON.stringify([id, path])

async function docx(marker: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function createAssets(): Promise<void> {
  for (const id of [taskA, taskB]) {
    const tag = id === taskA ? 'A' : 'B', directory = directories.get(id)!
    const wordMarker = `INLINE_WORD_${tag}`
    assets.set(assetKey(id, `${directory}/${names[0]}`), { bytes: await docx(wordMarker), marker: wordMarker, kind: 'docx' })
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('资料')
    const sheetMarker = `INLINE_SHEET_${tag}`
    sheet.getColumn(1).width = 32; sheet.getCell('A1').value = sheetMarker
    assets.set(assetKey(id, `${directory}/${names[1]}`), { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), marker: sheetMarker, kind: 'xlsx' })
    const deck = new PptxGenJS(), slideMarker = `INLINE_SLIDE_${tag}`
    deck.layout = 'LAYOUT_WIDE'; deck.addSlide().addText(slideMarker, { x: 1, y: 1, w: 9, h: 1, fontSize: 24, color: '222222' })
    assets.set(assetKey(id, `${directory}/${names[2]}`), { bytes: Buffer.from(await deck.write({ outputType: 'arraybuffer' }) as ArrayBuffer), marker: slideMarker, kind: 'pptx' })
  }
  for (const directory of ['archive', 'draft']) assets.set(assetKey(taskA, `${directory}/report.docx`), {
    bytes: await docx(`INLINE_${directory.toUpperCase()}`), marker: `INLINE_${directory.toUpperCase()}`, kind: 'docx'
  })
  assets.set(assetKey(taskB, 'notes/only-in-b.txt'), { bytes: Buffer.from('B_ONLY_FILE'), marker: 'B_ONLY_FILE', kind: 'txt' })
  assets.set(assetKey(taskA, literalName), assets.get(assetKey(taskA, `outputs/${names[1]}`))!)
}
function history(sessionId: string): EngineHistoryRow[] {
  const run = runs.get(sessionId)
  if (!run) return []
  const metadata = { rootRunId: run.runId, turnId: run.turnId }, conversationId = run.turnId
  const rows: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: titles.get(sessionId), createdAt: now - 100, conversationId, metadata }]
  const calls = names.map((name, index) => ({ name: index ? 'office_inspect' : 'read_file',
    args: { [index === 0 ? 'path' : index === 1 ? 'filePath' : 'file_path']: `${directories.get(sessionId)}/${name}` }, success: true }))
  if (sessionId === taskA) for (const directory of ['archive', 'draft']) calls.push({ name: 'read_file', args: { path: `${directory}/report.docx` }, success: true })
  else calls.push({ name: 'read_file', args: { file: 'notes/only-in-b.txt' }, success: true })
  if (sessionId === taskA) calls.push({ name: 'read_file', args: { path: literalName }, success: true })
  calls.push({ name: 'read_file', args: { path: 'failed.docx' }, success: false })
  for (const [index, call] of calls.entries()) {
    const toolCallId = `${sessionId}-tool-${index}`
    rows.push({ id: `call-${toolCallId}`, role: 'assistant', content: '', createdAt: now - 90 + index * 2,
      conversationId, metadata, toolCall: { id: toolCallId, name: call.name, args: call.args } },
    { id: `result-${toolCallId}`, role: 'tool', toolCallId, content: call.success ? '文件检查完成' : '文件不存在', success: call.success,
      createdAt: now - 89 + index * 2, conversationId, metadata: { ...metadata, success: call.success } })
  }
  // No finalResult metadata: successful file-tool arguments alone are the evidence.
  rows.push({ id: run.assistantMessageId, role: 'assistant', content: sourceMarkdown.get(sessionId), createdAt: now, conversationId, metadata })
  return rows
}
function directoryEntries(sessionId: string, requested: string) {
  const ownRoot = roots.get(sessionId) ?? '/remote/inline-default', path = requested === '.' ? '' : requested.replace(/^\/+|\/+$/g, '')
  const entries = new Map<string, { name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }>()
  for (const [key, asset] of assets) {
    const [owner, relative] = JSON.parse(key) as [string, string]
    if (owner !== sessionId || path && !relative.startsWith(`${path}/`)) continue
    const remaining = path ? relative.slice(path.length + 1) : relative, name = remaining.split('/')[0]
    entries.set(name, { name, path: `${ownRoot}/${path ? `${path}/` : ''}${name}`, isDirectory: remaining.includes('/'), size: remaining.includes('/') ? 0 : asset.bytes.length, mtimeMs: now })
  }
  return [...entries.values()]
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (path === '/api/v1/workspace/file/content') {
    const relative = url.searchParams.get('path') ?? '', asset = assets.get(assetKey(id, relative))
    const read = { sessionId: id, path: relative, expectedRoot: url.searchParams.get('expectedRoot'), bindingEpoch: url.searchParams.get('bindingEpoch') }
    contentReads.push(read)
    if (!previewAllowed) throw new Error('Rendering inline references must not read file contents')
    if (!asset || read.expectedRoot !== roots.get(id) || read.bindingEpoch !== `binding-${id}`) throw new Error(`Invalid file ownership ${JSON.stringify(read)}`)
    response.end(envelope({ content: asset.kind === 'txt' ? asset.bytes.toString() : asset.bytes.toString('base64'), isBinary: asset.kind !== 'txt',
      totalSize: asset.bytes.length, root: roots.get(id), bindingEpoch: `binding-${id}`, truncated: false, tooLarge: false })); return
  }
  if (path === '/api/v1/workspace/directory') {
    const relative = url.searchParams.get('path') ?? '.'
    directoryReads.push({ sessionId: id, path: relative })
    if (!previewAllowed && !['', '.'].includes(relative)) throw new Error(`Rendering inline references must not enumerate ${relative}`)
    response.end(envelope({ root: roots.get(id) ?? '/remote/inline-default', bindingEpoch: `binding-${id}`, entries: directoryEntries(id, relative) })); return
  }
  if (/\/(search|files)$/.test(path)) { scans.push(path); throw new Error('Inline reference lookup must not scan the workspace') }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') { mutations.push(`${request.method} ${path}`); throw new Error(`Preview must not mutate ${path}`) }
  const rows = history(id), run = runs.get(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-inline-history`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'inline-links-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '文件链接测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: history(sessionId).length }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'inline-links', sessionId: id,
      namespace: { id: 'inline-links-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(run), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/inline-default' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const answer = (): Locator => conversation().locator('.work-message--assistant')
const table = (): Locator => answer().getByRole('table')
async function verifyReferences(id: string): Promise<void> {
  await expect(table()).toBeVisible()
  for (const name of names) {
    const link = table().getByRole('link', { name, exact: true })
    await expect(link).toHaveCount(1); await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', `${directories.get(id)}/${name}`)
    const colors = await link.evaluate(element => {
      const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; document.body.append(probe)
      const accent = getComputedStyle(probe).color; probe.remove()
      return { link: getComputedStyle(element).color, code: getComputedStyle(element.querySelector('code')!).color, accent }
    })
    expect(colors.link).toBe(colors.accent); expect(colors.code).toBe(colors.accent)
  }
  const explicit = answer().locator('p').filter({ hasText: '显式链接：' })
  await expect(explicit.locator('a')).toHaveCount(1); await expect(explicit.locator('a code')).toHaveCount(1)
  await expect(explicit.locator('a')).toHaveAttribute('href', `/api/v1/workspace/file/download?sessionId=${id}&path=${encodeURIComponent(`${directories.get(id)}/${names[0]}`)}`)
  await expect(answer().locator('a a')).toHaveCount(0)
  for (const value of ['node --test', 'unknown.docx', 'report.docx', 'failed.docx']) {
    const code = answer().locator('code').filter({ hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    await expect(code).toHaveCount(1)
    expect(await code.evaluate(element => Boolean(element.closest('a'))), `${value} must remain code`).toBe(false)
  }
  const foreign = id === taskA ? 'only-in-b.txt' : `outputs/${names[0]}`
  await expect(answer().getByRole('link', { name: foreign, exact: true })).toHaveCount(0)
  if (id === taskA) for (const path of ['draft/report.docx', `${roots.get(id)}/archive/report.docx`])
    await expect(answer().getByRole('link', { name: path, exact: true })).toHaveCount(1)
}
async function openDocument(id: string, index: number): Promise<void> {
  const relative = `${directories.get(id)}/${names[index]}`, asset = assets.get(assetKey(id, relative))!, before = contentReads.length
  previewAllowed = true
  await table().getByRole('link', { name: names[index], exact: true }).click()
  await expect.poll(() => contentReads.slice(before).some(read => read.sessionId === id && read.path === relative)).toBe(true)
  const panel = work().locator('.work-artifact-panel-v2:visible')
  await expect(panel).toHaveAttribute('data-document-session', id)
  await expect(panel).toHaveAttribute('data-document-path', new RegExp(`${names[index].replace('.', '\\.')}$`))
  await expect(panel).toHaveAttribute('data-file-read-status', 'current')
  const preview = panel.locator(`.document-preview[data-document-preview="${asset.kind}"]`)
  await expect(preview).toBeVisible()
  if (asset.kind === 'xlsx') await expect(preview.getByRole('cell', { name: asset.marker, exact: true })).toBeVisible()
  else {
    await expect(preview.locator('[data-document-pages]')).toHaveAttribute('data-document-pages', /^[1-9]\d*$/)
    await expect(preview.frameLocator('iframe').first().getByText(asset.marker, { exact: true })).toBeVisible()
  }
  expect(contentReads.slice(before).every(read => read.sessionId === id)).toBe(true)
  await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
}

test.beforeAll(async () => {
  await createAssets()
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'inline-file-links-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
    remoteWorkspaceRoot: '/remote/inline-default', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
    workspacePath: roots.get(id), modelId, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), tasks, activeTaskId: taskA })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    const path = info.outputPath('inline-file-links-failure.png')
    await page.screenshot({ path }); await info.attach('文件链接失败窗口', { path, contentType: 'image/png' })
  }
  await info.attach('文件读取与会话归属', { body: JSON.stringify({ contentReads, directoryReads, scans, mutations, errors }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(scans).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('inline-file-links-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Work table inline filenames open real Office previews using only the current session’s evidence', async ({}, info) => {
  await verifyReferences(taskA)
  expect(contentReads).toEqual([])
  expect(directoryReads.every(read => ['', '.'].includes(read.path))).toBe(true)
  await answer().hover()
  await answer().getByRole('button', { name: '复制回复', exact: true }).click()
  await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(sourceMarkdown.get(taskA))

  await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600, 600); window.setContentSize(760, 900) })
  await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'dark'))
  await verifyReferences(taskA)
  const narrow = await conversation().evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth }))
  expect(narrow.overflow).toBeLessThanOrEqual(1)
  expect(contentReads).toEqual([])
  const narrowPath = info.outputPath('inline-links-narrow-dark.png')
  await page.screenshot({ path: narrowPath }); await info.attach('窄窗口文件链接', { path: narrowPath, contentType: 'image/png' })
  await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'light'))
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000))

  for (let index = 0; index < names.length; index++) await openDocument(taskA, index)
  const beforeLiteral = contentReads.length
  await answer().getByRole('link', { name: literalName, exact: true }).click()
  await expect.poll(() => contentReads.slice(beforeLiteral).some(read => read.sessionId === taskA && read.path === literalName)).toBe(true)
  const literalPanel = work().locator('.work-artifact-panel-v2:visible')
  await expect(literalPanel).toHaveAttribute('data-document-session', taskA)
  await expect(literalPanel).toHaveAttribute('data-file-read-status', 'current')
  await expect(literalPanel.getByRole('cell', { name: 'INLINE_SHEET_A', exact: true })).toBeVisible()
  const previewPath = info.outputPath('inline-links-office-preview.png')
  await page.screenshot({ path: previewPath }); await info.attach('文件链接打开右侧预览', { path: previewPath, contentType: 'image/png' })
  await work().getByRole('button', { name: '收起工作区', exact: true }).click()
  await expect(work().getByRole('region', { name: '任务工作区', exact: true })).toBeHidden()
  const beforeSwitch = contentReads.length
  previewAllowed = false
  await work().locator('.work-sidebar__task').filter({ hasText: titles.get(taskB)! }).click()
  await expect(work().getByRole('heading', { name: titles.get(taskB)!, exact: true })).toBeVisible()
  await verifyReferences(taskB)
  expect(contentReads).toHaveLength(beforeSwitch)
  await expect(answer().getByRole('link', { name: 'only-in-b.txt', exact: true })).toHaveAttribute('href', 'notes/only-in-b.txt')
  await openDocument(taskB, 0)
  expect(contentReads.filter(read => read.sessionId === taskB).map(read => read.path)).toEqual([`deliverables/${names[0]}`])
})
