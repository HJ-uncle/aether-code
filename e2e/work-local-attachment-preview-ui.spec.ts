/** Embedded Electron regression: native clipboard images in unsent Work home
 * and Code drafts must read the same local project that copyIntoWorkspace wrote;
 * home inline image/directory references open their real viewer and local files.
 * The mock engine resolves unbound sessions to a different real scratch root;
 * local filesystem IPC remains production code throughout this test.
 * Build first; run serially with playwright.work-local-attachment-preview.config.ts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-local-attachment-fixture', modelId = 'local-attachment-model'
const homeId = 'work-home-692a5914-8bdb-4613-9801-051398088ede'
const manifest = { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 }
interface StoredFile { path: string; name: string; type: string; size: number; attachmentId?: string }
interface HomeState { homeSessionId: string; homeWorkspacePath: string | null; homeDraft: string; homeAttachments: StoredFile[]; homeMentions: Array<{ attachmentId?: string; displayText: string; source?: string; path?: string }> }
interface ClipboardSnapshot { text: string; html: string; rtf: string; image: string | null }
const errors: string[] = [], directories: Array<{ sessionId: string; root: string }> = []
const contentReads: Array<{ sessionId: string; path: string; root: string }> = []
const fileWrites: Array<{ sessionId: string; path: string; root: string }> = []
const missingReads: string[] = [], bindings = new Map<string, string>()
let app: ElectronApplication | undefined, page: Page, fixture = '', project = '', savedClipboard: ClipboardSnapshot | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function scratch(owner: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(owner)) throw new Error(`Invalid scratch session: ${owner}`)
  const path = join(fixture, 'scratch', owner); mkdirSync(path, { recursive: true }); return path
}
function sessionRoot(owner: string): string { return bindings.get(owner) ?? scratch(owner) }
function inside(directory: string, candidate: string): string {
  const target = resolve(directory, candidate), rel = relative(directory, target)
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`Unsafe fixture file: ${target}`)
  return target
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, owner = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (path === '/api/v1/workspace/bind') {
    const id = String(input.sessionId), workspaceRoot = String(input.workspaceRoot)
    if (id === homeId) throw new Error('Preview must not bind the unsent home draft to its selected local project')
    bindings.set(id, workspaceRoot); response.end(envelope({ workspaceRoot })); return
  }
  if (path === '/api/v1/workspace/file' && request.method === 'POST') {
    const id = String(input.sessionId), directory = sessionRoot(id), candidate = String(input.path), target = inside(directory, candidate)
    if (id !== homeId || directory === project || input.encoding !== 'base64' || typeof input.content !== 'string') throw new Error('Invalid scratch image write')
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(input.content, 'base64'))
    fileWrites.push({ sessionId: id, path: candidate, root: directory }); response.end(envelope({ path: target })); return
  }
  if (path === '/api/v1/workspace/file/content' || path === '/api/v1/workspace/file/info') {
    const directory = sessionRoot(owner), candidate = url.searchParams.get('path') ?? '', target = inside(directory, candidate)
    contentReads.push({ sessionId: owner, path: candidate, root: directory })
    if (!existsSync(target)) { missingReads.push(target); response.writeHead(404).end(JSON.stringify({ code: 404, message: 'File not found in session scratch', data: null })); return }
    const data = readFileSync(target)
    response.end(envelope(path.endsWith('/info') ? { workspacePath: target, size: data.length, isDirectory: false }
      : { content: data.toString('base64'), isBinary: true, totalSize: data.length, root: directory, bindingEpoch: `local-preview-${owner}` })); return
  }
  if (path === '/api/v1/workspace/directory') {
    // Never return project merely because the renderer hints at it. This is
    // the distinction that the original remote-only preview tests omitted.
    const directory = sessionRoot(owner)
    directories.push({ sessionId: owner, root: directory })
    response.end(envelope({ root: directory, entries: [], bindingEpoch: `local-preview-${owner}` })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/chat/admission/receipt') { response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { ...manifest, instanceId: 'local-attachment-preview' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '本地附件测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: owner, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'local-preview', sessionId: owner, namespace: { id: 'test', generation: 'one' },
      transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'empty', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: false, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: owner }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: owner }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const composer = (): Locator => work().getByRole('textbox', { name: '任务目标', exact: true })
const thumbnail = (): Locator => work().locator('.attachment-strip .attach-chip__thumb')
async function home(): Promise<HomeState> {
  return page.evaluate(() => { window.dispatchEvent(new Event('blur')); return JSON.parse(localStorage.getItem('aether.work.state.v1') ?? '{}') as HomeState })
}
async function writeClipboardImage(width: number, height: number, color: string): Promise<void> {
  const dataUrl = await page.evaluate(({ width, height, color }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Fixture canvas unavailable')
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#ffffff'; ctx.fillRect(10, 10, 14, 14)
    return canvas.toDataURL('image/png')
  }, { width, height, color })
  await app!.evaluate(({ clipboard, nativeImage }, src) => { clipboard.writeImage(nativeImage.createFromDataURL(src)) }, dataUrl)
}
async function nativePasteImage(width: number, height: number, color: string): Promise<void> {
  await writeClipboardImage(width, height, color)
  await composer().focus(); await page.keyboard.press('Control+V')
  await expect(thumbnail()).toHaveCount(1); await expect(thumbnail()).toHaveJSProperty('naturalWidth', width)
  await expect(thumbnail()).toHaveJSProperty('naturalHeight', height)
  await expect.poll(async () => (await home()).homeAttachments.length).toBe(1)
}
async function inspectPreview(width: number, height: number): Promise<void> {
  await work().locator('.attachment-strip .attach-chip__image-btn').click()
  const canvas = page.locator('.image-editor__canvas')
  await expect(canvas).toBeVisible(); await expect(canvas).toHaveJSProperty('width', width); await expect(canvas).toHaveJSProperty('height', height)
  await expect(page.locator('.image-editor').getByRole('button', { name: '复制图片', exact: true })).toBeEnabled()
  await page.locator('.modal--image-editor').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(canvas).toHaveCount(0)
}
async function inspectInlinePreview(width: number, height: number, pixel: number[], input = composer()): Promise<void> {
  await input.locator('.mention-chip--attachment').click()
  const dialog = page.locator('.modal--image-editor'), editor = dialog.locator('.image-editor')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.modal-overlay').filter({ has: dialog })).toHaveAttribute('data-motion-state', 'open')
  await expect(editor.getByRole('toolbar', { name: '图片标注工具', exact: true })).toBeVisible()
  for (const name of ['画笔', '箭头', '矩形', '椭圆', '文字', '橡皮擦', '复制图片', '引用到会话']) {
    await expect(editor.getByRole('button', { name, exact: true })).toBeEnabled()
  }
  const image = editor.locator('.image-editor__surface > img')
  await expect(image).toHaveJSProperty('naturalWidth', width); await expect(image).toHaveJSProperty('naturalHeight', height)
  await expect(editor.locator('.image-editor__canvas')).toHaveJSProperty('width', width)
  await expect(editor.locator('.image-editor__canvas')).toHaveJSProperty('height', height)
  const pixels = await image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight
    const context = canvas.getContext('2d'); if (!context) throw new Error('Inline preview pixel probe unavailable')
    context.drawImage(element, 0, 0)
    return [[2, 2], [12, 12]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data])
  })
  expect(pixels).toEqual([pixel, [255, 255, 255, 255]])
  const bounds = await dialog.evaluate(element => ({ width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height, viewportWidth: innerWidth, viewportHeight: innerHeight }))
  expect(bounds.width).toBeGreaterThanOrEqual(bounds.viewportWidth - 2)
  expect(bounds.height).toBeGreaterThanOrEqual(bounds.viewportHeight - 2)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0)
}
async function expectInlineImage(input: Locator, width: number): Promise<void> {
  const reference = input.locator('.mention-chip--attachment'), image = reference.locator('img.mention-chip__thumbnail')
  await expect(reference).toHaveCount(1); await expect(image).toHaveCount(1)
  await expect(image).toHaveJSProperty('naturalWidth', width)
  const layout = await reference.evaluate(element => {
    const image = element.querySelector('img.mention-chip__thumbnail'), label = element.querySelector('.mention-chip__label')
    if (!image || !label) throw new Error('Missing inline image reference content')
    const bounds = image.getBoundingClientRect(), text = label.getBoundingClientRect()
    return { width: bounds.width, height: bounds.height, before: Boolean(image.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING), right: bounds.right, labelLeft: text.left }
  })
  expect(layout.before).toBe(true); expect(layout.right).toBeLessThanOrEqual(layout.labelLeft + 1)
  expect(layout.width).toBeGreaterThan(0); expect(layout.width).toBeLessThanOrEqual(22)
  expect(layout.height).toBeGreaterThan(0); expect(layout.height).toBeLessThanOrEqual(22)
}
async function inspectPicker(width: number): Promise<void> {
  await composer().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('@')
  const picker = page.locator('.mention-ref-picker:visible')
  await expect(picker.getByRole('group', { name: '当前附件', exact: true })).toBeVisible()
  await expect(picker.locator('.attachment-ref-picker__preview img')).toHaveJSProperty('naturalWidth', width)
  await picker.getByRole('group', { name: '当前附件', exact: true }).getByRole('option').click(); await expect(picker).toHaveCount(0)
  await expectInlineImage(composer(), width)
}

test.describe.serial('Work 与 Code 本地图片及会话沙箱预览', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-local-attachment-profile-'))
    project = join(fixture, '已选择的本地项目'); mkdirSync(project, { recursive: true })
    mkdirSync(join(project, 'icons', 'nested'), { recursive: true })
    writeFileSync(join(project, 'icons', 'manifest.json'), '{"name":"local-reference-icons","count":2}\n')
    writeFileSync(join(project, 'icons', 'nested', 'sample.ts'), 'export const icon = "local-reference-nested";\n')
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing upstream port')
    const runtime = join(fixture, 'engine'), entry = join(runtime, 'entry.cjs')
    mkdirSync(join(runtime, 'runtime'), { recursive: true }); writeFileSync(join(runtime, 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
    writeFileSync(entry, `const http = require('node:http');
const upstream = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
const token = ${JSON.stringify(token)};
http.createServer((req, res) => {
  if (req.url.startsWith('/api/') && req.headers['x-aether-instance-token'] !== process.env.AETHER_INSTANCE_TOKEN) {
    res.writeHead(401).end(JSON.stringify({ code: 401, message: 'Invalid instance token' })); return;
  }
  const forwarded = http.request(upstream + req.url, { method: req.method, headers: { ...req.headers, 'x-aether-instance-token': token } }, remote => {
    res.writeHead(remote.statusCode || 500, remote.headers); remote.pipe(res);
  });
  forwarded.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
  req.pipe(forwarded);
}).listen(Number(process.env.AETHER_ENGINE_PORT), '127.0.0.1');
`)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12563,
      lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'WORKSPACE_ROOT'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_ENGINE_ENTRY = entry; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    savedClipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL() }))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ project, homeId }) => {
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [], activeTaskId: null, homeWorkspacePath: project, homeSessionId: homeId,
        homeDraft: '首页本地图片验证 ', homeMentions: [], homeAttachments: [], homeSources: [] }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
    }, { project, homeId })
    await page.reload(); await expect(composer()).toBeVisible(); await expect(work().getByRole('button', { name: `当前工作区：${project}`, exact: true })).toHaveAttribute('title', project)
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) { const path = info.outputPath('local-attachment-preview.png'); await page.screenshot({ path, animations: 'disabled' }); await info.attach('本地图片与沙箱预览', { path, contentType: 'image/png' }) }
    await info.attach('workspace-file-receipts', { body: JSON.stringify({ errors, directories, contentReads, missingReads, fileWrites, bindings: [...bindings] }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(missingReads).toEqual([])
  })
  test.afterAll(async () => {
    try {
      if (app && savedClipboard) await app.evaluate(({ clipboard, nativeImage }, saved) => clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
        ...(saved.image ? { image: nativeImage.createFromDataURL(saved.image) } : {}) }), savedClipboard)
      await app?.close()
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-local-attachment-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('本地项目粘贴图片在缩略图、大图、@和刷新后可读，清除项目后只读会话沙箱', async ({}, info) => {
    const beforeSelection = await home()
    await work().getByRole('button', { name: `当前工作区：${project}`, exact: true }).click()
    const workspacePicker = page.getByRole('dialog', { name: '选择工作区', exact: true })
    await workspacePicker.getByRole('button', { name: `使用工作区：${project}`, exact: true }).click()
    await expect(workspacePicker).toHaveCount(0)
    expect(await home()).toEqual(beforeSelection); expect(bindings.has(homeId)).toBe(false)
    await nativePasteImage(96, 64, '#cf4242')
    const localState = await home(), localFile = localState.homeAttachments[0], localPath = inside(project, localFile.path)
    expect(localState.homeSessionId).toBe(homeId); expect(localState.homeWorkspacePath).toBe(project)
    expect(existsSync(localPath)).toBe(true); const localBytes = readFileSync(localPath)
    expect([...localBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(localBytes.readUInt32BE(16)).toBe(96); expect(localBytes.readUInt32BE(20)).toBe(64)
    expect(existsSync(inside(scratch(homeId), localFile.path))).toBe(false)
    await inspectPreview(96, 64); await inspectPicker(96); await inspectInlinePreview(96, 64, [207, 66, 66, 255])
    await expect.poll(async () => (await home()).homeMentions.length).toBe(1)
    await page.reload(); await expect(thumbnail()).toHaveJSProperty('naturalWidth', 96)
    await expectInlineImage(composer(), 96)
    expect((await home()).homeAttachments[0]).toEqual(localFile); await inspectPreview(96, 64); await inspectInlinePreview(96, 64, [207, 66, 66, 255])
    expect(contentReads.filter(read => read.sessionId === homeId)).toEqual([])
    expect(fileWrites).toEqual([]); expect(bindings.has(homeId)).toBe(false)
    const screenshot = info.outputPath('selected-local-project-restored.png'); await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('本地项目图片刷新恢复', { path: screenshot, contentType: 'image/png' })
    await work().getByRole('button', { name: `移除附件 ${localFile.name}`, exact: true }).click()
    await expect(thumbnail()).toHaveCount(0); await expect(composer().locator('.mention-chip--attachment')).toHaveCount(0)
    await work().getByRole('button', { name: '清除工作区选择，使用默认工作区', exact: true }).click()
    await expect.poll(async () => (await home()).homeWorkspacePath).toBeNull()
    await nativePasteImage(72, 48, '#245fd8')
    const scratchState = await home(), scratchFile = scratchState.homeAttachments[0], scratchPath = inside(scratch(homeId), scratchFile.path)
    expect(scratchState.homeSessionId).toBe(homeId); expect(existsSync(scratchPath)).toBe(true)
    const scratchBytes = readFileSync(scratchPath)
    expect(scratchBytes.readUInt32BE(16)).toBe(72); expect(scratchBytes.readUInt32BE(20)).toBe(48)
    expect(existsSync(inside(project, scratchFile.path))).toBe(false); expect(readFileSync(localPath).equals(localBytes)).toBe(true)
    await inspectPreview(72, 48); await inspectPicker(72)
    expect(fileWrites).toEqual([{ sessionId: homeId, path: scratchFile.path, root: scratch(homeId) }])
    expect(contentReads.some(read => read.sessionId === homeId && read.path === scratchFile.path && read.root === scratch(homeId))).toBe(true)
    expect(directories.filter(item => item.sessionId === homeId).every(item => item.root === scratch(homeId))).toBe(true)
    await page.reload(); await expect(thumbnail()).toHaveJSProperty('naturalWidth', 72); await expectInlineImage(composer(), 72); await inspectPreview(72, 48)
    await inspectInlinePreview(72, 48, [36, 95, 216, 255])
    expect((await home()).homeAttachments[0]).toEqual(scratchFile); expect(bindings.has(homeId)).toBe(false)
  })

  test('首页 @ 目录引用显示本地目录列表，可进入子目录、返回上级并打开真实文件', async ({}, info) => {
    await page.evaluate(({ project, homeId }) => {
      const state = JSON.parse(localStorage.getItem('aether.work.state.v1') ?? '{}')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ ...state, homeWorkspacePath: project, homeSessionId: homeId,
        homeDraft: '检查图标目录 ', homeMentions: [], homeAttachments: [], homeSources: [] }))
    }, { project, homeId })
    await page.reload(); await expect(composer()).toBeVisible()
    await expect(work().getByRole('button', { name: `当前工作区：${project}`, exact: true })).toHaveAttribute('title', project)
    const priorReads = contentReads.length, priorWrites = fileWrites.length
    await composer().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('@icons')
    const picker = page.locator('.mention-ref-picker:visible')
    await expect(picker.getByRole('group', { name: '文件与目录', exact: true })).toBeVisible()
    const directoryOption = picker.getByRole('option').filter({ has: page.locator('.file-palette__path', { hasText: /^icons$/ }) })
    await expect(directoryOption).toHaveCount(1); await directoryOption.click(); await expect(picker).toHaveCount(0)
    const reference = composer().locator('.mention-chip--dir')
    await expect(reference).toHaveText('icons'); await expect(reference.locator('img')).toHaveCount(0)
    await expect.poll(async () => (await home()).homeMentions.map(mention => ({ source: mention.source, path: mention.path })))
      .toEqual([{ source: 'dir', path: 'icons' }])
    await reference.click()
    const dialog = page.getByRole('dialog', { name: 'icons', exact: true }), listing = dialog.getByRole('region', { name: '目录内容', exact: true })
    await expect(listing).toBeVisible(); await expect(dialog.locator('.monaco-editor')).toHaveCount(0)
    await expect(listing.getByRole('button', { name: '打开文件 manifest.json', exact: true })).toBeVisible()
    await listing.getByRole('button', { name: '打开目录 nested', exact: true }).click()
    await expect(dialog.getByLabel('当前目录', { exact: true })).toContainText('icons/nested')
    await expect(listing.getByRole('button', { name: '打开文件 sample.ts', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '返回上级目录', exact: true }).click()
    await expect(listing.getByRole('button', { name: '打开文件 manifest.json', exact: true })).toBeVisible()
    await listing.getByRole('button', { name: '打开目录 nested', exact: true }).click()
    await listing.getByRole('button', { name: '打开文件 sample.ts', exact: true }).click()
    const fileDialog = page.getByRole('dialog', { name: 'sample.ts', exact: true })
    await expect(fileDialog).toBeVisible(); await expect(fileDialog).toContainText('local-reference-nested')
    await fileDialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(fileDialog).toHaveCount(0)
    await expect(reference).toHaveText('icons')
    expect(readFileSync(join(project, 'icons', 'nested', 'sample.ts'), 'utf8')).toBe('export const icon = "local-reference-nested";\n')
    expect(contentReads).toHaveLength(priorReads); expect(fileWrites).toHaveLength(priorWrites); expect(bindings.has(homeId)).toBe(false)
    const screenshot = info.outputPath('home-directory-reference.png'); await reference.click(); await expect(listing).toBeVisible()
    await expect(page.locator('.modal-overlay').filter({ has: dialog })).toHaveAttribute('data-motion-state', 'open')
    await page.screenshot({ path: screenshot, animations: 'disabled' }); await info.attach('首页目录引用列表', { path: screenshot, contentType: 'image/png' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  })

  test('Code 新会话从实际文件夹入口选择项目后，粘贴图片与 @ 预览从本地项目恢复', async ({}, info) => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const code = page.locator('#mode-code'), input = code.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeVisible()
    // Only the OS chooser result is controlled. The real menu command,
    // fs:pick-folder authorization, openFolderAt and all file IPC stay intact.
    await app!.evaluate(({ dialog }, selected) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = (async () => {
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: [selected] }
      }) as typeof dialog.showOpenDialog
    }, project)
    await page.locator('.menu-bar').getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('menuitem', { name: /打开文件夹/ }).click()
    await expect(code.locator('.chat__workspace')).toHaveAttribute('title', `Agent 的工作区：${project}`)
    const priorSession = await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)
    await code.getByRole('button', { name: '新建', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)).not.toBe(priorSession)
    const sessionId = await page.evaluate(async () => (await window.aether.settings.get()).lastSessionId)
    expect(sessionId).not.toBe(homeId); expect(bindings.has(sessionId)).toBe(false)
    const beforeWrites = fileWrites.length
    await writeClipboardImage(120, 80, '#8252c7')
    await input.focus(); await page.keyboard.press('Control+V')
    const thumb = code.locator('.attachment-strip .attach-chip__thumb')
    await expect(thumb).toHaveCount(1); await expect(thumb).toHaveJSProperty('naturalWidth', 120)
    await expect(thumb).toHaveJSProperty('naturalHeight', 80)
    const readDraft = (): Promise<{ text: string; attachments?: StoredFile[]; mentions?: Array<{ attachmentId?: string }> }> => page.evaluate(id => {
      window.dispatchEvent(new Event('blur'))
      const table = JSON.parse(localStorage.getItem('aether:chatDrafts') ?? '{}') as Record<string, { text: string; attachments?: StoredFile[]; mentions?: Array<{ attachmentId?: string }> }>
      return table[id] ?? { text: '' }
    }, sessionId)
    await expect.poll(async () => (await readDraft()).attachments?.length ?? 0).toBe(1)
    const file = (await readDraft()).attachments![0], localPath = inside(project, file.path)
    expect(existsSync(localPath)).toBe(true)
    const bytes = readFileSync(localPath)
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(bytes.readUInt32BE(16)).toBe(120); expect(bytes.readUInt32BE(20)).toBe(80)
    expect(existsSync(inside(scratch(sessionId), file.path))).toBe(false)
    await code.locator('.attachment-strip .attach-chip__image-btn').click()
    await expect(page.locator('.image-editor__canvas')).toHaveJSProperty('width', 120)
    await expect(page.locator('.image-editor__canvas')).toHaveJSProperty('height', 80)
    await page.locator('.modal--image-editor').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('.image-editor__canvas')).toHaveCount(0)
    await input.focus(); await page.keyboard.insertText('@')
    const picker = page.locator('.mention-ref-picker:visible')
    await expect(picker.getByRole('group', { name: '当前附件', exact: true })).toBeVisible()
    await expect(picker.locator('.attachment-ref-picker__preview img')).toHaveJSProperty('naturalWidth', 120)
    await picker.getByRole('group', { name: '当前附件', exact: true }).getByRole('option').click(); await expect(picker).toHaveCount(0)
    await expectInlineImage(input, 120)
    await expect.poll(async () => (await readDraft()).mentions?.length ?? 0).toBe(1)
    await page.reload(); await expect(thumb).toHaveJSProperty('naturalWidth', 120)
    await expectInlineImage(input, 120)
    await inspectInlinePreview(120, 80, [130, 82, 199, 255], input)
    expect((await readDraft()).attachments).toEqual([file])
    expect(contentReads.filter(read => read.sessionId === sessionId)).toEqual([])
    expect(fileWrites).toHaveLength(beforeWrites); expect(bindings.has(sessionId)).toBe(false)
    const screenshot = info.outputPath('code-local-project-restored.png'); await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('Code 本地项目图片刷新恢复', { path: screenshot, contentType: 'image/png' })
  })
})
