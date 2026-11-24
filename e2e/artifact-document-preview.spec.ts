/** New regression for document clicks in a turn's file changes. Uses real
 * Electron IPC and DOCX rendering with an isolated read-only engine fixture.
 * Covers both entry points, text history, explicit history and current-file
 * labeling. No model requests, exports, downloads or production profile. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import ExcelJS from 'exceljs'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), output = join(root, '.e2e-tmp/artifact-document-preview')
const sessionId = 'work-artifact-document-preview', modelId = 'preview-fixture', token = 'preview-fixture-token'
const title = '文档点击预览专项验收', workspace = '/remote/artifact-document-preview', now = Date.now() - 10_000
const filename = '2048-项目深度调研报告.docx', filePath = `${workspace}/${filename}`, textName = '说明.txt'
const run: RootRun = { schemaVersion: 1, runId: 'preview-run', sessionId, turnId: 'preview-turn', userMessageId: 'preview-user',
  assistantMessageId: 'preview-answer', seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [workspace],
  createdAt: now, updatedAt: now + 1000, finishedAt: now + 1000 }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const history = [{ id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata },
  { id: run.assistantMessageId, role: 'assistant', content: '已生成报告与说明。', createdAt: now + 1000, conversationId: run.turnId, metadata }]
const changes: EngineFileChange[] = [
  { id: 'preview-docx', sessionId, runId: run.runId, turnId: run.turnId, path: filePath, kind: 'write', oldContent: null, newContent: null,
    isNew: true, oldHash: 'missing', newHash: 'a'.repeat(64), truncated: true, status: 'pending', createdAt: now + 500 },
  { id: 'preview-text', sessionId, runId: run.runId, turnId: run.turnId, path: `${workspace}/${textName}`, kind: 'write', oldContent: null,
    newContent: 'TURN_ORIGINAL_TEXT', isNew: true, oldHash: 'missing', newHash: 'b'.repeat(64), truncated: false, status: 'pending', createdAt: now + 600 }
]
let app: ElectronApplication | undefined, page: Page, profile = '', bytes: Buffer = Buffer.alloc(0)
const formatFiles = new Map<string, Buffer>()
const errors: string[] = [], mutations: string[] = [], reads: string[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? '', owned = id === sessionId
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Unexpected mutation ${path}`)
  }
  if (path === '/api/v1/workspace/file/content') {
    const target = url.searchParams.get('path') ?? ''
    const binary = [filename, filePath].includes(target) ? bytes : formatFiles.get(target.startsWith(`${workspace}/`) ? target.slice(workspace.length + 1) : target)
    if (!owned || !binary && ![textName, `${workspace}/${textName}`].includes(target)) throw new Error(`Unexpected file read ${target}`)
    reads.push(target)
    response.end(envelope({ content: binary ? binary.toString('base64') : 'CURRENT_WORKSPACE_TEXT', isBinary: Boolean(binary),
      totalSize: binary ? binary.length : 22, root: workspace, bindingEpoch: 'preview' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'preview-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '预览夹具', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: owned ? history : [], projection: [], run: owned ? run : undefined, runs: owned ? [run] : [], subagentRuns: [], todos: [], changes: owned ? changes : [], commandJobs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: owned ? [{ userMessageId: run.userMessageId, conversationId: run.turnId, preview: title, createdAt: now }] : [],
      messages: owned ? history : [], loadedTurnIds: owned ? [run.userMessageId] : [], revision: 'preview', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: owned ? run : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: owned ? [run] : [] }
    : path === '/api/v1/conversation/history' ? owned ? history : []
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/changes' ? owned ? changes : []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'preview', sessionId: id, namespace: { id: 'preview-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'preview' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const artifacts = () => page.locator('.work-session-artifacts:visible')
const detail = () => artifacts().locator('.work-session-artifacts__detail')
const scope = () => detail().getByRole('button', { name: '差异范围', exact: true })
const header = () => detail().locator('.work-session-artifacts__file-header')
const zoom = () => detail().getByRole('button', { name: '缩放', exact: true })
const fileMenu = () => detail().getByRole('button', { name: '文件操作', exact: true })
async function chooseScope(label: string): Promise<void> {
  await scope().click(); await page.getByRole('menuitem', { name: label, exact: false }).click()
  await expect(scope()).toContainText(label)
}
async function expectDocument(): Promise<void> {
  await expect(scope()).toContainText('当前内容')
  await expect(detail().locator('iframe.document-preview__frame').first().contentFrame().getByText('CURRENT_DOCX_BODY')).toBeVisible()
  await expect(detail().locator('.work-session-artifacts__notice')).toHaveCount(0)
}
async function selectFile(name: string): Promise<void> {
  await artifacts().getByRole('treeitem').filter({ hasText: name }).click()
  await expect(detail().locator('.work-session-artifacts__identity strong')).toHaveText(name)
}

async function expectUnifiedHeader(hasZoom = true): Promise<void> {
  await expect(detail().locator('.work-session-artifacts__preview .work-artifact-panel-v2__toolbar')).toHaveCount(0)
  await expect(detail().locator('.document-preview__header')).toHaveCount(0)
  const controls = [...(hasZoom ? [zoom()] : []), fileMenu(), detail().getByRole('button', { name: '添加到对话', exact: true })]
  if (!hasZoom) await expect(zoom()).toHaveCount(0)
  const titleBox = await header().locator('strong').boundingBox()
  expect(titleBox).not.toBeNull()
  const headerBox = await header().boundingBox()
  expect(headerBox).not.toBeNull()
  for (const control of controls) {
    await expect(control).toBeVisible()
    await expect(header().getByRole('button', { name: await control.getAttribute('aria-label') ?? '', exact: true })).toHaveCount(1)
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.y + box!.height / 2 - titleBox!.y - titleBox!.height / 2)).toBeLessThanOrEqual(2)
    expect(box!.x).toBeGreaterThanOrEqual(headerBox!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 1)
  }
  expect(await header().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeAll(async () => {
  mkdirSync(output, { recursive: true }); profile = mkdtempSync(join(output, 'profile-'))
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>CURRENT_DOCX_BODY</w:t></w:r></w:p><w:p><w:r><w:t>2048 项目深度调研报告：点击文件应直接阅读。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>')
  bytes = await zip.generateAsync({ type: 'nodebuffer' })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL = origin; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  page.on('download', download => { errors.push('Unexpected download'); void download.cancel() })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1600, 1000); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, modelId, now }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
      workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 35 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, modelId, now })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
})
test.beforeEach(async () => {
  await page.getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
  await selectFile(filename)
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath(`${info.status}.png`), animations: 'disabled' })
  await info.attach('fixture-audit', { body: JSON.stringify({ errors, mutations, reads }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (profile) { const target = resolve(profile); if (dirname(target) !== output || !basename(target).startsWith('profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

test('显式选择当前内容能够读取并渲染真实 Word', async () => {
  await chooseScope('当前内容')
  await expectDocument()
})

test('本轮成果文件树点击 Word 直接显示正文', async () => {
  await expect(artifacts().locator('.work-session-artifacts__turn')).toHaveAttribute('data-turn-scope', `turn:${run.turnId}`)
  await expectDocument()
  expect(reads.some(path => path.endsWith(filename))).toBe(true)
})

test('文档操作与缩放合并到文件标题同一行', async () => {
  await expectDocument()
  await expectUnifiedHeader()
})

test('统一缩放菜单改变真实文档比例，文件操作菜单刷新实际内容', async () => {
  await expectDocument()
  await expectUnifiedHeader()
  const frame = detail().locator('iframe.document-preview__frame').first().contentFrame()
  const scale = () => frame.locator('main.document-page').evaluate(element => Number(element.style.zoom))
  await zoom().click(); await page.getByRole('menuitem', { name: '100%', exact: true }).click()
  await expect.poll(scale).toBe(1)
  await zoom().click(); await page.getByRole('menuitem', { name: '适应宽度', exact: true }).click()
  await expect.poll(scale).toBeGreaterThan(0)
  await expect.poll(scale).toBeLessThan(1)
  const count = reads.length
  await fileMenu().click()
  await expect(page.getByRole('menuitem', { name: /保存/ })).toHaveCount(1)
  await page.getByRole('menuitem', { name: /刷新/ }).click()
  await expect.poll(() => reads.length).toBeGreaterThan(count)
  await expectDocument(); await expectUnifiedHeader()
  await fileMenu().focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: /刷新/ })).toBeVisible()
  await page.keyboard.press('Escape'); await expect(fileMenu()).toBeFocused()
})

test('Word 和 PPT 首屏即适应宽度，刷新重开不闪回原始比例，手动缩放保留文档', async ({}, info) => {
  const pptxName = '首帧比例验收.pptx', marker = 'FIRST_FRAME_PPTX_BODY'
  const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE'
  presentation.addSlide().addText(marker, { x: 0.5, y: 1, w: 10, h: 1, fontSize: 28 })
  const pptxBytes = await presentation.write({ outputType: 'arraybuffer' })
  if (!(pptxBytes instanceof ArrayBuffer)) throw new Error('Expected PowerPoint fixture bytes')
  formatFiles.set(pptxName, Buffer.from(pptxBytes))
  changes.push({ id: 'preview-first-frame-pptx', sessionId, runId: run.runId, turnId: run.turnId, path: `${workspace}/${pptxName}`,
    kind: 'write', oldContent: null, newContent: null, isNew: true, oldHash: 'missing', newHash: 'e'.repeat(64),
    truncated: true, status: 'pending', createdAt: now + 900 })
  const records: Array<{ file: string; action: string; initialZoom: number; samples: Array<{ zoom: number; width: number; viewportWidth: number }> }> = []
  try {
    await artifacts().getByRole('button', { name: '刷新', exact: true }).click()
    for (const [name, body] of [[filename, 'CURRENT_DOCX_BODY'], [pptxName, marker]]) {
      await selectFile(textName)
      for (const action of ['打开', '刷新', '重开']) {
        await test.step(`${name} · ${action}`, async () => {
          if (action === '刷新') {
            const count = reads.length
            await fileMenu().click(); await page.getByRole('menuitem', { name: /刷新/ }).click()
            await expect.poll(() => reads.length).toBeGreaterThan(count)
          } else {
            if (action === '重开') await selectFile(textName)
            await selectFile(name)
          }
          const iframe = detail().locator('iframe.document-preview__frame').first(), frame = iframe.contentFrame()
          await expect(frame.getByText(body, { exact: true })).toBeVisible()
          // Inspect the actual initial document handed to the sandbox. Reading
          // srcdoc proves its initial CSS; it does not claim pixel-first-paint timing.
          const source = await iframe.getAttribute('srcdoc')
          const initial = source?.match(/\.document-page\s*\{[^}]*\bzoom\s*:\s*([\d.]+)/)
          expect(initial, '实际 iframe 初始文档必须明确设置正文比例').not.toBeNull()
          const initialZoom = Number(initial?.[1])
          // Read several real frames from the parent test process. Keeping each
          // evaluation synchronous avoids holding a frame execution context over
          // navigation while still catching a visible ratio jump.
          const samples: Array<{ zoom: number; width: number; viewportWidth: number }> = []
          const readLayout = (): Promise<{ zoom: number; width: number; viewportWidth: number }> =>
            frame.locator('main.document-page').evaluate(element => ({
              zoom: Number(getComputedStyle(element).zoom),
              width: element.getBoundingClientRect().width,
              viewportWidth: innerWidth
            }))
          for (let index = 0; index < 6; index += 1) {
            samples.push(await readLayout())
            if (index < 5) await page.waitForTimeout(70)
          }
          records.push({ file: name, action, initialZoom, samples })
          const final = samples.at(-1)!
          expect(final.zoom).toBeGreaterThan(0)
          expect(final.zoom, '此夹具必须在窄面板中进入缩小后的适应宽度').toBeLessThan(0.95)
          expect(initialZoom, `${name} ${action} 交付 iframe 的初始正文不应使用 100% 比例`).toBeLessThan(0.95)
          expect(Math.abs(initialZoom - final.zoom), `${name} ${action} 初始文档比例与稳定比例应一致`).toBeLessThanOrEqual(0.005)
          expect(samples.length).toBeGreaterThan(1)
          for (const sample of samples) {
            expect(sample.zoom, `${name} ${action} 可见正文不应闪回 100%：${JSON.stringify(sample)}`).toBeLessThan(0.95)
            expect(Math.abs(sample.zoom - final.zoom), `${name} ${action} 初始比例与稳定比例应一致`).toBeLessThanOrEqual(0.005)
            expect(Math.abs(sample.width - final.width), `${name} ${action} 初始正文宽度不应跳变`).toBeLessThanOrEqual(2)
          }
        })
      }
      const iframe = detail().locator('iframe.document-preview__frame').first()
      const frame = iframe.contentFrame(), source = await iframe.getAttribute('srcdoc')
      const documentHandle = await frame.locator('main.document-page').evaluateHandle(element => element.ownerDocument)
      try {
        for (const [label, expectedScale] of [['100%', 1], ['75%', 0.75]] as const) {
          await zoom().click(); await page.getByRole('menuitem', { name: label, exact: true }).click()
          await expect.poll(() => frame.locator('main.document-page').evaluate(element => Number(getComputedStyle(element).zoom))).toBe(expectedScale)
          expect(await frame.locator('main.document-page').evaluate((element, original) => element.ownerDocument === original, documentHandle), '手动缩放必须保留同一 iframe 文档').toBe(true)
          expect(await iframe.getAttribute('srcdoc'), '手动缩放不能重新导航 srcdoc').toBe(source)
          await expect(frame.getByText(body, { exact: true })).toBeVisible()
        }
        await zoom().click(); await page.getByRole('menuitem', { name: '适应宽度', exact: true }).click()
        await expect.poll(() => frame.locator('main.document-page').evaluate(element => Number(getComputedStyle(element).zoom))).toBeLessThan(0.95)
        expect(await frame.locator('main.document-page').evaluate((element, original) => element.ownerDocument === original, documentHandle)).toBe(true)
      } finally {
        await documentHandle.dispose()
      }
    }
  } finally {
    await info.attach('office-first-frame-layout', { body: JSON.stringify(records, null, 2), contentType: 'application/json' })
    for (let index = changes.length - 1; index >= 0; index--) if (changes[index].id === 'preview-first-frame-pptx') changes.splice(index, 1)
    formatFiles.delete(pptxName)
    await selectFile(filename); await expectDocument()
  }
})

test('深浅主题和窄面板保持单行工具栏，历史与文本不残留缩放', async ({}, info) => {
  if (!app) throw new Error('Missing Electron application')
  try {
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      for (const width of [1600, 1240]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expectDocument(); await expectUnifiedHeader()
        await page.screenshot({ path: info.outputPath(`toolbar-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await chooseScope('修改记录')
    await expect(zoom()).toHaveCount(0)
    await expect(fileMenu()).toHaveCount(0)
    await selectFile(textName)
    await expect(scope()).toContainText('本轮改动')
    await expect(zoom()).toHaveCount(0)
    await chooseScope('当前内容')
    await expect(detail().locator('.work-artifact-panel-v2')).toHaveAttribute('data-file-read-status', 'current')
    await expect(zoom()).toHaveCount(0)
    await expect(fileMenu()).toBeVisible()
    await selectFile(filename); await expectDocument(); await expectUnifiedHeader()
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
  }
})

test('工作区独立文件页签复用统一工具栏，改动入口进入同一菜单', async () => {
  await expectDocument()
  await fileMenu().click()
  await page.getByRole('menuitem', { name: '在工作区打开', exact: true }).click()
  const workspacePreview = page.locator('.work-files-workspace__preview:visible')
  const workspaceHeader = workspacePreview.locator('.work-artifact-panel-v2__header')
  await expect(workspacePreview).toBeVisible()
  await expect(workspaceHeader).toContainText(filename)
  await expect(workspacePreview.locator('iframe.document-preview__frame').first().contentFrame().getByText('CURRENT_DOCX_BODY')).toBeVisible()
  await expect(workspacePreview.locator('.document-preview__header')).toHaveCount(0)
  await expect(workspacePreview.locator('.work-artifact-panel-v2__toolbar')).toHaveCount(0)
  for (const name of ['缩放', '添加到对话', '文件操作']) {
    await expect(workspaceHeader.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '任务工作区', exact: true }).getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  await workspaceHeader.getByRole('button', { name: '文件操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '在新标签页打开', exact: true }).click()
  const resource = page.locator('.work-resource-file:visible')
  const resourceHeader = resource.locator('.work-artifact-panel-v2__header')
  await expect(resource).toBeVisible()
  await expect(resourceHeader).toContainText(filename)
  await expect(resource.locator('iframe.document-preview__frame').first().contentFrame().getByText('CURRENT_DOCX_BODY')).toBeVisible()
  await expect(resource.locator('.document-preview__header')).toHaveCount(0)
  await expect(resource.locator('.work-artifact-panel-v2__toolbar')).toHaveCount(0)
  await expect(resource.locator('.work-artifacts-shell__tabs')).toHaveCount(0)
  for (const name of ['缩放', '添加到对话', '文件操作']) {
    await expect(resourceHeader.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '任务工作区', exact: true }).getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  await resourceHeader.getByRole('button', { name: '文件操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '在成果中查看改动', exact: true }).click()
  await expect(scope()).toContainText('修改记录')
  await expect(zoom()).toHaveCount(0)
  await expect(page.getByRole('button', { name: '缩放', exact: true })).toHaveCount(0)
  await chooseScope('当前内容'); await expectDocument(); await expectUnifiedHeader()
  await expect(page.getByRole('button', { name: '缩放', exact: true })).toHaveCount(1)
})

test('PDF 演示文稿和表格复用同一标题行，PDF 页数紧挨文件名', async ({}, info) => {
  const pdfName = '统一菜单验收.pdf', pptxName = '统一菜单验收.pptx', xlsxName = '统一菜单验收.xlsx'
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= 2; index++) pdf.addPage([595, 842]).drawText(`UNIFIED_PDF_BODY_${index}`, { x: 40, y: 780, font, size: 20 })
  formatFiles.set(pdfName, Buffer.from(await pdf.save()))
  const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE'
  presentation.addSlide().addText('UNIFIED_PPTX_BODY', { x: 0.5, y: 1, w: 10, h: 1, fontSize: 28 })
  const pptxBytes = await presentation.write({ outputType: 'arraybuffer' })
  if (!(pptxBytes instanceof ArrayBuffer)) throw new Error('Expected PowerPoint fixture bytes')
  formatFiles.set(pptxName, Buffer.from(pptxBytes))
  const spreadsheet = new ExcelJS.Workbook()
  const worksheet = spreadsheet.addWorksheet('验收'); worksheet.addRow(['UNIFIED_XLSX_BODY', 'Amount']); worksheet.addRow(['Actual workbook', 2048])
  formatFiles.set(xlsxName, Buffer.from(await spreadsheet.xlsx.writeBuffer()))
  const ids = new Set(['preview-pdf', 'preview-pptx', 'preview-xlsx'])
  for (const [index, name] of [pdfName, pptxName, xlsxName].entries()) changes.push({ id: `preview-${name.split('.').at(-1)}`,
    sessionId, runId: run.runId, turnId: run.turnId, path: `${workspace}/${name}`, kind: 'write', oldContent: null, newContent: null,
    isNew: true, oldHash: 'missing', newHash: String(index + 3).repeat(64), truncated: true, status: 'pending', createdAt: now + 800 + index })
  try {
    await artifacts().getByRole('button', { name: '刷新', exact: true }).click()
    for (const name of [pdfName, pptxName, xlsxName]) {
      await selectFile(name)
      await expect(scope()).toContainText('当前内容')
      if (name === pdfName) {
        await expect(detail().locator('.document-preview__body--pdf canvas').first()).toBeVisible()
        const count = header().locator('.document-preview__page-label')
        await expect(count).toHaveText('2 页')
        const titleBox = await header().locator('strong').boundingBox(), countBox = await count.boundingBox()
        expect(titleBox).not.toBeNull(); expect(countBox).not.toBeNull()
        expect(countBox!.x - titleBox!.x - titleBox!.width).toBeGreaterThanOrEqual(-1)
        expect(countBox!.x - titleBox!.x - titleBox!.width).toBeLessThanOrEqual(24)
        expect(Math.abs(countBox!.y + countBox!.height / 2 - titleBox!.y - titleBox!.height / 2)).toBeLessThanOrEqual(2)
      } else if (name === pptxName) {
        await expect(detail().locator('iframe.document-preview__frame').first().contentFrame().getByText('UNIFIED_PPTX_BODY')).toBeVisible()
        await expect(header().locator('.document-preview__page-label')).toHaveCount(0)
      } else {
        await expect(detail().locator('.document-preview__body--sheet')).toContainText('UNIFIED_XLSX_BODY')
        await expect(header().locator('.document-preview__page-label')).toHaveCount(0)
      }
      await expectUnifiedHeader(name !== xlsxName)
      await page.screenshot({ path: info.outputPath(`toolbar-${name.split('.').at(-1)}.png`), animations: 'disabled' })
    }
    await selectFile(filename); await expectDocument(); await expectUnifiedHeader()
    await expect(header().locator('.document-preview__page-label')).toHaveCount(0)
  } finally {
    for (let index = changes.length - 1; index >= 0; index--) if (ids.has(changes[index].id)) changes.splice(index, 1)
  }
})

test('文本保持本轮历史差异，切回 Word 不继承文本视图', async () => {
  await selectFile(textName)
  await expect(scope()).toContainText('本轮改动')
  await expect(detail().locator('[data-diff-scope="turn"]')).toContainText('TURN_ORIGINAL_TEXT')
  await expect(detail()).not.toContainText('CURRENT_WORKSPACE_TEXT')
  await selectFile(filename); await expectDocument()
})

test('主动查看历史不读取当前文件，并可一键返回预览', async () => {
  await expectDocument()
  for (const label of ['本轮改动', '修改记录', '待确认改动']) {
    const count = reads.length
    await chooseScope(label)
    await expect(detail().locator('iframe.document-preview__frame')).toHaveCount(0)
    await expect(detail().getByRole('button', { name: '预览当前文件', exact: true })).toBeVisible()
    expect(reads).toHaveLength(count)
    await detail().getByRole('button', { name: '预览当前文件', exact: true }).click()
    await expectDocument()
  }
})

test('从对话的单个成果文件直接打开 Word，不进入空白历史页', async () => {
  await chooseScope('修改记录')
  const panel = page.getByRole('region', { name: '本轮成果摘要', exact: true })
  const toggle = panel.locator('.work-progress-panel__changes-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await panel.locator('.work-progress-panel__file').filter({ hasText: filename }).click()
  await expectDocument()
  await expect(artifacts().locator('.work-session-artifacts__turn')).toHaveAttribute('data-turn-scope', `turn:${run.turnId}`)
})

test('已删除的文档显示删除状态，历史页不提供无效预览入口', async () => {
  await expectDocument()
  const deletedName = '已删除报告.docx'
  changes.push({ id: 'deleted-document', sessionId, runId: run.runId, turnId: run.turnId,
    path: `${workspace}/${deletedName}`, kind: 'delete', oldContent: null, newContent: null,
    oldHash: 'c'.repeat(64), newHash: 'missing', truncated: true, status: 'pending', createdAt: now + 700 })
  try {
    await artifacts().getByRole('button', { name: '刷新', exact: true }).click()
    await selectFile(deletedName)
    const count = reads.length
    await expect(detail().getByRole('status')).toContainText('已删除')
    await expect(detail().locator('iframe.document-preview__frame')).toHaveCount(0)
    await chooseScope('修改记录')
    await expect(detail().getByRole('note')).toContainText('此修改记录不含可预览的文件内容')
    await expect(detail().getByRole('button', { name: '预览当前文件', exact: true })).toHaveCount(0)
    expect(reads).toHaveLength(count)
  } finally { changes.splice(changes.findIndex(change => change.id === 'deleted-document'), 1) }
})
