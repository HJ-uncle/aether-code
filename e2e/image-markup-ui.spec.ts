/** Real Electron image markup: exported PNG/clipboard pixels, undo/redo branches,
 * rotation coordinates, whole-vector erasure, draft replacement, owned uploads,
 * and native attachment/reference dragging with persisted identities and offsets.
 * Build first, then run with playwright.image-markup.config.ts (one window only). */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { RootRun } from '../src/shared/root-run'
import { ATTACHMENTS_DIRECTORY } from '../src/shared/attachments'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { ChatAttachment } from '../src/renderer/src/core/engine/useChat'
import { mentionToken, type Mention } from '../src/renderer/src/contrib/chat/mention-context'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'work-image-markup', title = '图片标注真实像素验证', token = 'image-markup-token', modelId = 'image-markup-model'
const workspaceRoot = '/remote/image-markup', userImagePath = `${ATTACHMENTS_DIRECTORY}/original-user-image.png`
const duplicateImagePath = `${ATTACHMENTS_DIRECTORY}/duplicate-user-image.png`
const now = Date.now() - 10_000, imageWidth = 800, imageHeight = 600
const run: RootRun = { schemaVersion: 1, runId: 'markup-root', sessionId, turnId: 'markup-turn', userMessageId: 'markup-user',
  assistantMessageId: 'markup-answer', seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [workspaceRoot],
  createdAt: now, updatedAt: now + 20, finishedAt: now + 20 }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
interface UploadedFile { sessionId: string; path: string; bytes: Buffer; type: string }
interface ClipboardSnapshot { text: string; html: string; rtf: string; image: string | null }
interface ImageProbe { width: number; height: number; pixels: number[][]; ink: number[] }
const files = new Map<string, UploadedFile>(), uploads: UploadedFile[] = [], errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', imageDataUrl = '', originalBytes = Buffer.alloc(0)
let secondPageDataUrl = '', thirdPageDataUrl = '', unrelatedPageDataUrl = ''
let clipboardSnapshot: ClipboardSnapshot | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

function history(id: string): EngineHistoryRow[] {
  if (id !== sessionId) return []
  const renders = [
    { id: 'markup-render', path: `${workspaceRoot}/review.pptx`, page: 1, count: 3, dataUrl: imageDataUrl },
    { id: 'markup-unrelated-render', path: `${workspaceRoot}/unrelated.pptx`, page: 1, count: 1, dataUrl: unrelatedPageDataUrl },
    { id: 'markup-render-second', path: `${workspaceRoot}/review.pptx`, page: 2, count: 3, dataUrl: secondPageDataUrl },
    { id: 'markup-render-third', path: `${workspaceRoot}/review.pptx`, page: 3, count: 3, dataUrl: thirdPageDataUrl }
  ]
  return [
    { id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId,
      metadata: { ...metadata, attachments: [userImagePath, duplicateImagePath].map(name => ({ name, type: 'image/png', size: originalBytes.length })) } },
    ...renders.flatMap((render, index): EngineHistoryRow[] => [
      { id: `${render.id}-call`, role: 'assistant', content: '', createdAt: now + 1 + index * 2, conversationId: run.turnId, metadata,
        toolCall: { id: render.id, name: 'workbench_render', args: { path: render.path, page: render.page } } },
      { id: `${render.id}-receipt`, role: 'tool', toolCallId: render.id, success: true, createdAt: now + 2 + index * 2, conversationId: run.turnId,
        // Persisted large-image receipts lost page/session/renderer metadata in
        // older engines; args + the verified file version must recover grouping.
        content: JSON.stringify({ filename: `${basename(render.path)} · 第 ${render.page}/${render.count} 页`,
          mimeType: 'image/png', description: `第 ${render.page} 页预览`, dataUrl: render.dataUrl, hasDataUrl: true,
          size: Buffer.from(render.dataUrl.split(',')[1] ?? '', 'base64').length,
          fileVersion: { path: render.path, expectedHash: `sha256:${'a'.repeat(64)}`,
            encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false } }), metadata: { ...metadata, success: true } }
    ]),
    { id: run.assistantMessageId, role: 'assistant', content: '图片已准备好，可继续标注。', createdAt: now + 20, conversationId: run.turnId, metadata }
  ]
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, owner = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (path === '/api/v1/workspace/upload' && request.method === 'POST') {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const form = await new Request('http://fixture/upload', { method: 'POST', headers: { 'content-type': String(request.headers['content-type']) },
      body: Uint8Array.from(Buffer.concat(chunks)) }).formData()
    const blob = form.get('file'), session = form.get('sessionId'), relative = form.get('path')
    if (!blob || typeof blob === 'string' || session !== sessionId || typeof relative !== 'string') throw new Error('Upload crossed image task ownership')
    const file: UploadedFile = { sessionId: session, path: relative, bytes: Buffer.from(await blob.arrayBuffer()), type: blob.type }
    uploads.push(file); files.set(relative, file); response.end(envelope({ path: relative, size: file.bytes.length })); return
  }
  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const relative = (url.searchParams.get('path') ?? '').replace(`${workspaceRoot}/`, ''), file = files.get(relative)
    if (!file || owner !== sessionId) throw new Error(`Unexpected image read ${owner}/${relative}`)
    response.end(envelope(path.endsWith('/info') ? { workspacePath: `${workspaceRoot}/${relative}`, size: file.bytes.length, isDirectory: false }
      : { content: file.bytes.toString('base64'), isBinary: true, totalSize: file.bytes.length, root: workspaceRoot, bindingEpoch: 'markup-binding' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Image editing unexpectedly mutated ${path}`)
  }
  const rows = history(owner), matching = owner === sessionId ? run : undefined
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: rows.filter(row => row.role === 'user').map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: matching ? [run.userMessageId] : [],
      revision: 'markup-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'8'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'image-markup' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '图片测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: owner, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history(sessionId).length }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'markup-tenant', sessionId: owner,
      namespace: { id: 'markup-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: owner }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: owner }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [], bindingEpoch: 'markup-binding' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const editor = (): Locator => page.locator('.image-editor')
const canvas = (): Locator => editor().locator('.image-editor__canvas')
const work = (): Locator => page.locator('.work-view')

async function seedTask(seed?: { text: string; mentions: Mention[]; attachments: ChatAttachment[] }): Promise<void> {
  await page.evaluate(({ key, sessionId, title, now, modelId, workspaceRoot, seed }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: seed.text, mentions: seed.mentions, createdAt: now,
      updatedAt: now, workspacePath: workspaceRoot, modelId, attachments: seed.attachments, sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: storageKey, sessionId, title, now, modelId, workspaceRoot, seed: seed ?? { text: '', mentions: [], attachments: [] } })
  await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
}

async function savedDraft(): Promise<{ draft: string; mentions: Mention[]; attachments: ChatAttachment[] }> {
  return page.evaluate(({ key, sessionId }) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    const task = stored.tasks?.find((item: { id: string }) => item.id === sessionId)
    if (!task) throw new Error('Fixture draft was not persisted')
    return { draft: task.draft, mentions: task.mentions ?? [], attachments: task.attachments ?? [] }
  }, { key: storageKey, sessionId })
}

/** Use native HTML drag/drop; the read-only Range locates a real text boundary. */
async function dragToDraftText(chip: Locator, input: Locator, marker: string, after: boolean): Promise<void> {
  const targetPosition = await input.evaluate((element, { marker, after }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf(marker) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index); range.setEnd(node, index + marker.length)
      const rect = range.getBoundingClientRect(), box = element.getBoundingClientRect()
      return { x: (after ? rect.right + 2 : rect.left + 1) - box.left, y: rect.top + rect.height / 2 - box.top }
    }
    throw new Error(`Draft boundary ${marker} is missing`)
  }, { marker, after })
  await chip.dragTo(input, { targetPosition })
}

async function openToolImage(toolId = 'markup-render'): Promise<void> {
  const process = work().locator('.work-message__process-toggle')
  if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
  const row = work().locator(`[data-work-tool-id="${toolId}"]`), disclosure = row.locator('button.logline')
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  await row.locator('.tool-result__preview').click()
  await readyEditor()
}

async function readyEditor(): Promise<void> {
  await expect(editor()).toBeVisible()
  await expect(page.locator('.modal-overlay').filter({ has: page.locator('.modal--image-editor') })).toHaveAttribute('data-motion-state', 'open')
  await expect(canvas()).toHaveJSProperty('width', imageWidth)
  await expect(canvas()).toHaveJSProperty('height', imageHeight)
  await expect(editor().getByRole('button', { name: '复制图片', exact: true })).toBeEnabled()
  // Pointer coordinates must come from the settled entrance/fit transform.
  // Visibility alone allows drawing during the modal's CSS translation.
  await canvas().evaluate(async (element: HTMLCanvasElement) => {
    const surface = element.parentElement!, deadline = performance.now() + 5000
    let previous: number[] | undefined, stableFrames = 0
    while (stableFrames < 4) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!element.isConnected) throw new Error('Image canvas changed while awaiting its layout')
      const rect = surface.getBoundingClientRect(), next = [rect.left, rect.top, rect.width, rect.height]
      stableFrames = previous && next.every((value, index) => value === previous![index]) ? stableFrames + 1 : 0
      previous = next
      if (performance.now() > deadline) throw new Error('Image surface did not settle before drawing')
    }
  })
}

async function sourcePoint(x: number, y: number): Promise<{ x: number; y: number }> {
  return canvas().evaluate((element: HTMLCanvasElement, point) => {
    const surface = element.parentElement!, bounds = surface.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(surface).transform)
    const x = point.x - element.width / 2, y = point.y - element.height / 2
    return { x: bounds.left + bounds.width / 2 + matrix.a * x + matrix.c * y,
      y: bounds.top + bounds.height / 2 + matrix.b * x + matrix.d * y }
  }, { x, y })
}

async function draw(tool: string, start: [number, number], end: [number, number]): Promise<void> {
  await readyEditor()
  await editor().getByRole('button', { name: tool, exact: true }).click()
  await expect(editor().getByRole('button', { name: tool, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const a = await sourcePoint(...start), b = await sourcePoint(...end)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 16 }); await page.mouse.up()
  await expect(editor().getByRole('button', { name: '撤销', exact: true })).toBeEnabled()
}

async function setInk(): Promise<void> {
  await editor().getByLabel('标注颜色', { exact: true }).fill('#e11d48')
  await editor().getByRole('button', { name: '标注粗细', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择标注粗细', exact: true })
  await picker.getByRole('menuitemradio', { name: '粗，8 px', exact: true }).click()
  await expect(picker).toHaveCount(0)
}

async function copiedPng(): Promise<string> {
  await app!.evaluate(({ clipboard }) => clipboard.clear())
  await editor().getByRole('button', { name: '复制图片', exact: true }).click()
  await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(false)
  return app!.evaluate(({ clipboard }) => clipboard.readImage().toDataURL())
}

async function inspectPng(src: string, points: Array<[number, number]> = [], regions: Array<[number, number, number, number]> = []): Promise<ImageProbe> {
  return page.evaluate(async ({ src, points, regions }) => {
    const image = new Image(); image.src = src; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Image probe canvas unavailable')
    ctx.drawImage(image, 0, 0)
    return { width: canvas.width, height: canvas.height,
      pixels: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]),
      ink: regions.map(([x, y, width, height]) => {
        const bytes = ctx.getImageData(x, y, width, height).data; let count = 0
        for (let index = 0; index < bytes.length; index += 4) if (bytes[index] > 160 && bytes[index + 1] < 90 && bytes[index + 2] < 130 && bytes[index + 3] > 200) count++
        return count
      }) }
  }, { src, points, regions })
}

async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`); await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}

async function expectFullscreenLayout(): Promise<void> {
  const modal = page.locator('.modal--image-editor')
  await expect(modal.locator(':scope > .modal__header')).toHaveCount(0)
  const layout = await modal.evaluate(element => {
    const rect = (selector: string): DOMRect => {
      const target = element.querySelector(selector); if (!target) throw new Error(`Missing image viewer region ${selector}`)
      return target.getBoundingClientRect()
    }
    const panel = element.getBoundingClientRect(), stage = rect('.image-editor__stage'), image = rect('.image-editor__surface')
    const toolbar = rect('.image-editor__toolbar'), footer = rect('.image-editor__footer'), dock = rect('.image-editor__dock')
    const style = getComputedStyle(element), backdrop = getComputedStyle(element.closest('.modal-overlay')!).backgroundColor
    return { viewport: { width: innerWidth, height: innerHeight }, panel: panel.toJSON(), stage: stage.toJSON(), image: image.toJSON(),
      toolbar: toolbar.toJSON(), footer: footer.toJSON(), dock: dock.toJSON(),
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(value => parseFloat(value)),
      radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow, background: style.backgroundColor,
      backdrop: (backdrop.match(/[\d.]+/g) ?? []).map(Number) }
  })
  expect(layout.panel.width).toBeGreaterThanOrEqual(layout.viewport.width - 1)
  expect(layout.panel.height).toBeGreaterThanOrEqual(layout.viewport.height - 1)
  expect(layout.borders).toEqual([0, 0, 0, 0]); expect(layout.radius).toBe(0)
  expect(layout.shadow).toBe('none'); expect(layout.background).toBe('rgba(0, 0, 0, 0)')
  expect(Math.max(...layout.backdrop.slice(0, 3))).toBeLessThanOrEqual(64)
  expect(layout.backdrop[3] ?? 1).toBeGreaterThanOrEqual(0.75)
  expect(Math.abs(layout.stage.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.stage.top)).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.stage.width - layout.viewport.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.stage.height - layout.viewport.height)).toBeLessThanOrEqual(1)
  expect(layout.image.width).toBeCloseTo(imageWidth, 1)
  expect(layout.image.height).toBeCloseTo(imageHeight, 1)
  await expect(editor().getByRole('button', { name: '实际大小', exact: true })).toHaveText('100%')
  expect(layout.image.width).toBeLessThanOrEqual(layout.stage.width + 1)
  expect(layout.image.height).toBeLessThanOrEqual(layout.stage.height + 1)
  expect(layout.dock.top).toBeGreaterThan(layout.stage.top)
  expect(layout.dock.bottom).toBeLessThan(layout.stage.bottom)
  expect(layout.dock.left - layout.stage.left).toBeGreaterThanOrEqual(8)
  expect(layout.stage.right - layout.dock.right).toBeGreaterThanOrEqual(8)
  expect(Math.abs((layout.dock.left + layout.dock.right) / 2 - layout.stage.width / 2)).toBeLessThanOrEqual(1)
  expect(layout.toolbar.top).toBeGreaterThanOrEqual(layout.viewport.height * 0.75)
  expect(layout.footer.top).toBeGreaterThanOrEqual(layout.toolbar.bottom)
  expect(layout.footer.bottom).toBeLessThanOrEqual(layout.dock.bottom)
  expect(layout.viewport.height - layout.footer.bottom).toBeGreaterThanOrEqual(8)
  expect(layout.viewport.height - layout.footer.bottom).toBeLessThanOrEqual(24)
}

async function closeEditor(): Promise<void> {
  if (!await editor().count()) return
  await page.locator('.modal--image-editor').getByRole('button', { name: '关闭', exact: true }).click()
  if (await editor().getByRole('button', { name: '放弃标注', exact: true }).isVisible()) await editor().getByRole('button', { name: '放弃标注', exact: true }).click()
  await expect(editor()).toHaveCount(0)
}

test.describe.serial('图片标注与真实导出', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'image-markup-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    clipboardSnapshot = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
      image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL() }))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const sources = await page.evaluate(({ width, height }) => {
      const makeImage = (corner: string): string => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Fixture image unavailable')
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height)
        ctx.fillStyle = corner; ctx.fillRect(0, 0, 24, 24)
        ctx.fillStyle = '#13a45d'; ctx.fillRect(width - 24, height - 24, 24, 24)
        return canvas.toDataURL('image/png')
      }
      return { original: makeImage('#1649d8'), second: makeImage('#6741d9'), third: makeImage('#e8a817'), unrelated: makeImage('#263238') }
    }, { width: imageWidth, height: imageHeight })
    imageDataUrl = sources.original; secondPageDataUrl = sources.second; thirdPageDataUrl = sources.third; unrelatedPageDataUrl = sources.unrelated
    originalBytes = Buffer.from(imageDataUrl.split(',')[1], 'base64')
    files.set(userImagePath, { sessionId, path: userImagePath, bytes: originalBytes, type: 'image/png' })
    files.set(duplicateImagePath, { sessionId, path: duplicateImagePath, bytes: originalBytes, type: 'image/png' })
  })
  test.beforeEach(async () => { await seedTask() })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot('image-markup-failure', info)
    await info.attach('image-markup-requests', { body: JSON.stringify({ errors, mutations, uploads: uploads.map(file => ({ sessionId: file.sessionId, path: file.path, size: file.bytes.length, type: file.type })) }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try {
      if (app && clipboardSnapshot) await app.evaluate(({ clipboard, nativeImage }, saved) => clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
        ...(saved.image ? { image: nativeImage.createFromDataURL(saved.image) } : {}) }), clipboardSnapshot)
      await app?.close()
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('image-markup-profile-')) throw new Error(`Unsafe image fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('六种标注工具生成真实PNG像素，副本包含标注且原图不变', async ({}, info) => {
    await openToolImage(); await setInk()
    for (const name of ['画笔', '箭头', '矩形', '椭圆', '文字', '橡皮擦']) await expect(editor().getByRole('button', { name, exact: true })).toBeVisible()
    await draw('画笔', [60, 70], [220, 70]); await draw('箭头', [300, 70], [460, 70])
    await draw('矩形', [60, 150], [220, 270]); await draw('椭圆', [300, 150], [460, 270])
    await editor().getByRole('button', { name: '文字', exact: true }).click()
    const textPoint = await sourcePoint(60, 350); await page.mouse.click(textPoint.x, textPoint.y)
    await editor().getByRole('textbox', { name: '标注文字', exact: true }).fill('第一行标注\n第二行说明')
    await page.keyboard.press('Control+Enter'); await expect(editor().getByRole('textbox', { name: '标注文字', exact: true })).toHaveCount(0)
    const exported = await copiedPng(), probe = await inspectPng(exported, [[140, 70], [380, 70], [140, 150], [380, 150], [140, 210], [380, 210]], [[50, 345, 330, 55], [50, 405, 330, 55]])
    expect([probe.width, probe.height]).toEqual([imageWidth, imageHeight])
    for (const pixel of probe.pixels.slice(0, 4)) expect(pixel).toEqual([225, 29, 72, 255])
    for (const pixel of probe.pixels.slice(4)) expect(pixel).toEqual([255, 255, 255, 255])
    for (const count of probe.ink) expect(count).toBeGreaterThan(100)
    const savedPath = info.outputPath('marked-copy.png')
    await app!.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => item.setSavePath(path))
    }, savedPath)
    await editor().getByRole('button', { name: '另存为', exact: true }).click()
    await expect.poll(() => existsSync(savedPath)).toBe(true)
    const saved = readFileSync(savedPath); expect(saved.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const savedProbe = await inspectPng(`data:image/png;base64,${saved.toString('base64')}`, [[140, 70], [140, 210]])
    expect(savedProbe.pixels).toEqual([[225, 29, 72, 255], [255, 255, 255, 255]])
    expect(files.get(userImagePath)!.bytes.equals(originalBytes)).toBe(true)
    await info.attach('marked-copy', { path: savedPath, contentType: 'image/png' })
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    expect((await inspectPng(await copiedPng(), [], [[50, 345, 330, 120]])).ink[0]).toBe(0)
    await editor().getByRole('button', { name: '重做', exact: true }).click()
    expect((await inspectPng(await copiedPng(), [], [[50, 345, 330, 120]])).ink[0]).toBeGreaterThan(100)
    await closeEditor()
  })

  test('默认100%保留清晰度，粗细菜单向上展开、支持键盘且PNG保留真实线宽', async ({}, info) => {
    await openToolImage()
    await expectFullscreenLayout()
    const zoom = editor().getByRole('button', { name: '实际大小', exact: true })
    await editor().getByRole('button', { name: '适应窗口', exact: true }).click(); await readyEditor()
    expect(Number((await zoom.innerText()).replace('%', ''))).toBeGreaterThan(100)
    const fitted = await editor().locator('.image-editor__surface').boundingBox()
    const stage = await editor().locator('.image-editor__stage').boundingBox()
    expect(fitted!.width).toBeLessThanOrEqual(stage!.width + 1)
    expect(fitted!.height).toBeLessThanOrEqual(stage!.height + 1)
    await zoom.click(); await readyEditor(); await expectFullscreenLayout()

    await editor().getByLabel('标注颜色', { exact: true }).fill('#e11d48')
    const trigger = editor().getByRole('button', { name: '标注粗细', exact: true })
    const picker = page.getByRole('dialog', { name: '选择标注粗细', exact: true })
    await expect(trigger).toHaveAttribute('title', '标注粗细：4 px')
    await trigger.click()
    await expect(picker).toHaveAttribute('data-motion-state', 'open')
    await expect(picker.getByRole('menuitemradio')).toHaveCount(4)
    for (const [label, width] of [['细', 2], ['中', 4], ['粗', 8], ['特粗', 12]] as const) {
      const option = picker.getByRole('menuitemradio', { name: `${label}，${width} px`, exact: true })
      await expect(option).toBeVisible()
      await expect(option).toHaveAttribute('aria-checked', String(width === 4))
      const line = await option.locator('.image-stroke-picker__sample > span').boundingBox()
      expect(line!.height).toBeCloseTo(width, 1)
    }
    const panelBox = await picker.boundingBox(), triggerBox = await trigger.boundingBox()
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(triggerBox!.y)
    const panelColor = await picker.evaluate(element => (getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? []).map(Number))
    expect(Math.max(...panelColor.slice(0, 3))).toBeLessThanOrEqual(64)
    await screenshot('stroke-picker-menu', info)
    await expect(picker.getByRole('menuitemradio', { name: '中，4 px', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter')
    await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('title', '标注粗细：2 px')
    await draw('画笔', [100, 100], [300, 100])

    await trigger.focus(); await page.keyboard.press('ArrowDown')
    await expect(picker.getByRole('menuitemradio', { name: '细，2 px', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0); await expect(editor()).toBeVisible(); await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('title', '标注粗细：2 px')
    await trigger.click()
    await picker.getByRole('menuitemradio', { name: '特粗，12 px', exact: true }).click()
    await expect(picker).toHaveCount(0)
    await draw('画笔', [100, 200], [300, 200])

    const png = await copiedPng()
    const widths = await page.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d'); if (!context) throw new Error('Stroke width probe unavailable')
      context.drawImage(image, 0, 0)
      // Sum red coverage on white instead of counting opaque pixels: fractional
      // pointer positions can antialias an edge while retaining the exact width.
      return [100, 200].map(y => {
        const pixels = context.getImageData(200, y - 20, 1, 40).data
        let coverage = 0
        for (let index = 0; index < pixels.length; index += 4) coverage += (255 - pixels[index + 1]) / (255 - 29)
        return coverage
      })
    }, png)
    expect(widths[0]).toBeCloseTo(2, 1); expect(widths[1]).toBeCloseTo(12, 1)
    await closeEditor()
  })

  test('画布延伸到底部，悬浮工具栏覆盖图片但点击不会新增标注', async ({}, info) => {
    await openToolImage(); await setInk(); await expectFullscreenLayout()
    const stage = await editor().locator('.image-editor__stage').boundingBox()
    const before = await editor().locator('.image-editor__surface').boundingBox()
    await editor().getByRole('button', { name: '移动', exact: true }).click()
    const start = await sourcePoint(400, 300)
    const deltaY = stage!.y + stage!.height - (before!.y + before!.height) + 40
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(start.x - 150, start.y + deltaY, { steps: 16 }); await page.mouse.up()
    await readyEditor()
    const surface = await editor().locator('.image-editor__surface').boundingBox()
    expect(surface!.x).toBeCloseTo(before!.x - 150, 0)
    expect(surface!.y + surface!.height).toBeGreaterThanOrEqual(stage!.y + stage!.height + 39)

    const bottomPoint = { x: surface!.x + 400, y: stage!.y + stage!.height - 5 }
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.matches('.image-editor__canvas') ?? false, bottomPoint)).toBe(true)
    // Draw in the strip beneath the floating dock. This area used to belong to
    // the toolbar's layout row and could not receive image pointer input.
    const sourceBottomY = bottomPoint.y - surface!.y
    await draw('画笔', [300, sourceBottomY], [500, sourceBottomY])
    const original = await copiedPng()
    expect((await inspectPng(original, [[400, Math.floor(sourceBottomY)]])).pixels[0]).toEqual([225, 29, 72, 255])
    const originalAnnotations = await canvas().evaluate((element: HTMLCanvasElement) => element.toDataURL())

    await editor().getByRole('button', { name: '文字', exact: true }).click()
    await page.mouse.click(bottomPoint.x, bottomPoint.y)
    const textInput = editor().getByRole('textbox', { name: '标注文字', exact: true })
    await textInput.fill('底部文字避让验证')
    const textBounds = await textInput.boundingBox(), dockBounds = await editor().locator('.image-editor__dock').boundingBox()
    expect(textBounds!.y + textBounds!.height).toBeLessThanOrEqual(dockBounds!.y)
    await page.keyboard.press('Escape')
    await expect(textInput).toHaveCount(0); await expect(editor()).toBeVisible()
    await expect.poll(() => canvas().evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(originalAnnotations)

    for (const name of ['矩形', '画笔', '标注粗细']) {
      const button = editor().getByRole('button', { name, exact: true })
      const hit = await button.evaluate(element => {
        const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
        return { toolbarOnTop: Boolean(document.elementFromPoint(x, y)?.closest('.image-editor__dock')),
          canvasUnderneath: document.elementsFromPoint(x, y).some(target => target.matches('.image-editor__canvas')) }
      })
      expect(hit).toEqual({ toolbarOnTop: true, canvasUnderneath: true })
      await button.click()
      if (name === '标注粗细') {
        const picker = page.getByRole('dialog', { name: '选择标注粗细', exact: true })
        await picker.getByRole('menuitemradio', { name: '特粗，12 px', exact: true }).click()
        await expect(picker).toHaveCount(0)
      } else await expect(button).toHaveAttribute('aria-pressed', 'true')
      expect(await canvas().evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(originalAnnotations)
    }
    expect(await copiedPng()).toBe(original)
    await screenshot('floating-image-toolbar', info)
    await closeEditor()
  })

  test('撤销重做保留像素且新分支清空重做，橡皮擦整条删除可撤销', async () => {
    await openToolImage(); await setInk(); await draw('矩形', [80, 100], [240, 240])
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    expect((await inspectPng(await copiedPng(), [[160, 100]])).pixels[0]).toEqual([255, 255, 255, 255])
    await editor().getByRole('button', { name: '重做', exact: true }).click()
    expect((await inspectPng(await copiedPng(), [[160, 100]])).pixels[0]).toEqual([225, 29, 72, 255])
    await editor().getByRole('button', { name: '橡皮擦', exact: true }).click()
    const edge = await sourcePoint(160, 100); await page.mouse.click(edge.x, edge.y)
    expect((await inspectPng(await copiedPng(), [[160, 100], [80, 170], [160, 240]])).pixels).toEqual(Array.from({ length: 3 }, () => [255, 255, 255, 255]))
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    expect((await inspectPng(await copiedPng(), [[80, 170]])).pixels[0]).toEqual([225, 29, 72, 255])
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    await draw('椭圆', [400, 220], [560, 340])
    await expect(editor().getByRole('button', { name: '重做', exact: true })).toBeDisabled()
    expect((await inspectPng(await copiedPng(), [[160, 100], [400, 280]])).pixels).toEqual([[255, 255, 255, 255], [225, 29, 72, 255]])
    await closeEditor()
  })

  test('旋转属于编辑历史，旋转后绘制仍落在原图坐标，Escape只取消文字', async () => {
    await openToolImage(); await setInk()
    await editor().getByRole('button', { name: '旋转 90°', exact: true }).click()
    await draw('画笔', [200, 300], [400, 300])
    let probe = await inspectPng(await copiedPng(), [[imageHeight - 12, 12]], [[297, 295, 6, 10]])
    expect([probe.width, probe.height]).toEqual([imageHeight, imageWidth]); expect(probe.pixels[0]).toEqual([22, 73, 216, 255]); expect(probe.ink[0]).toBeGreaterThan(20)
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    await editor().getByRole('button', { name: '撤销', exact: true }).click()
    probe = await inspectPng(await copiedPng(), [[300, 300]])
    expect([probe.width, probe.height]).toEqual([imageWidth, imageHeight]); expect(probe.pixels[0]).toEqual([255, 255, 255, 255])
    await editor().getByRole('button', { name: '文字', exact: true }).click()
    const point = await sourcePoint(100, 100); await page.mouse.click(point.x, point.y)
    await editor().getByRole('textbox', { name: '标注文字', exact: true }).fill('取消文字不关闭图片')
    await page.keyboard.press('Escape')
    await expect(editor()).toBeVisible(); await expect(editor().getByRole('textbox', { name: '标注文字', exact: true })).toHaveCount(0)
    await expect(editor().getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    await copiedPng(); await closeEditor()
  })

  test('历史图片引用生成新PNG附件，待发附件应用编辑替换原条目', async () => {
    const before = uploads.length
    await work().locator('.work-message--user .attach-chip__image-btn').first().click()
    await readyEditor(); await setInk(); await draw('画笔', [80, 100], [240, 100])
    await expect(editor().getByRole('button', { name: '应用编辑', exact: true })).toHaveCount(0)
    await editor().getByRole('button', { name: '引用到会话', exact: true }).click()
    await expect(editor()).toHaveCount(0); await expect.poll(() => uploads.length).toBe(before + 1)
    const reference = uploads[before]; expect(reference.sessionId).toBe(sessionId); expect(reference.type).toBe('image/png')
    expect((await inspectPng(`data:image/png;base64,${reference.bytes.toString('base64')}`, [[160, 100]])).pixels[0]).toEqual([225, 29, 72, 255])
    const draft = work().locator('.work-attachments .attach-chip--image')
    await expect(draft).toHaveCount(1); await draft.locator('.attach-chip__image-btn').click()
    await readyEditor()
    await expect(editor().getByRole('button', { name: '应用编辑', exact: true })).toBeDisabled()
    await setInk(); await draw('矩形', [300, 200], [450, 350])
    await editor().getByRole('button', { name: '应用编辑', exact: true }).click()
    await expect(editor()).toHaveCount(0); await expect.poll(() => uploads.length).toBe(before + 2)
    await expect(draft).toHaveCount(1)
    const applied = uploads[before + 1]; expect(applied.path).not.toBe(reference.path)
    expect((await inspectPng(`data:image/png;base64,${applied.bytes.toString('base64')}`, [[160, 100], [375, 200]])).pixels).toEqual([[225, 29, 72, 255], [225, 29, 72, 255]])
    expect(files.get(userImagePath)!.bytes.equals(originalBytes)).toBe(true)
  })

  test('相同字节的不同图片保持独立标注，关闭图库会提醒其它图片未导出的编辑', async () => {
    await work().locator('.work-message--user .attach-chip__image-btn').first().click()
    await readyEditor(); await setInk(); await draw('画笔', [80, 100], [240, 100])
    const inkAt = (): Promise<number[]> => canvas().evaluate((element: HTMLCanvasElement) => {
      const ctx = element.getContext('2d'); if (!ctx) throw new Error('Annotation canvas unavailable')
      return [...ctx.getImageData(160, 100, 1, 1).data]
    })
    await expect.poll(inkAt).toEqual([225, 29, 72, 255])
    await editor().getByRole('button', { name: '下一张', exact: true }).click()
    await expect(page.locator('.modal--image-editor')).toHaveAttribute('aria-label', /duplicate-user-image\.png/)
    await readyEditor()
    await expect.poll(inkAt).toEqual([0, 0, 0, 0])
    await expect(editor().getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    expect((await inspectPng(await copiedPng(), [[160, 100]])).pixels[0]).toEqual([255, 255, 255, 255])
    await editor().getByRole('button', { name: '上一张', exact: true }).click()
    await expect(page.locator('.modal--image-editor')).toHaveAttribute('aria-label', /original-user-image\.png/)
    await readyEditor()
    await expect.poll(inkAt).toEqual([225, 29, 72, 255])
    await editor().getByRole('button', { name: '下一张', exact: true }).click()
    await expect(page.locator('.modal--image-editor')).toHaveAttribute('aria-label', /duplicate-user-image\.png/)
    await readyEditor()
    await expect.poll(inkAt).toEqual([0, 0, 0, 0])
    // Do not copy/export A: its unread dirty state must protect it even when B is current.
    await page.locator('.modal--image-editor').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(editor().getByRole('alert')).toContainText('标注尚未导出')
    await expect(editor()).toBeVisible()
    await editor().getByRole('button', { name: '放弃标注', exact: true }).click()
    await expect(editor()).toHaveCount(0)
    expect(files.get(userImagePath)!.bytes.equals(originalBytes)).toBe(true)
    expect(files.get(duplicateImagePath)!.bytes.equals(originalBytes)).toBe(true)
  })

  test('同一PPT跨渲染步骤组成三页图库，鼠标键盘翻页有边界且各页标注独立', async ({}, info) => {
    await openToolImage('markup-render-second')
    const displayedImage = editor().locator('.image-editor__surface > img')
    const previous = editor().getByRole('button', { name: '上一张', exact: true }), next = editor().getByRole('button', { name: '下一张', exact: true })
    await expect(displayedImage).toHaveAttribute('src', secondPageDataUrl)
    await expect(editor().getByRole('button', { name: '实际大小', exact: true })).toHaveText('100%')
    await expect(editor().getByText('2 / 3', { exact: true })).toBeVisible()
    await expect(previous).toBeEnabled(); await expect(next).toBeEnabled()
    await setInk(); await draw('画笔', [80, 100], [240, 100])
    expect((await inspectPng(await copiedPng(), [[12, 12], [160, 100]])).pixels).toEqual([[103, 65, 217, 255], [225, 29, 72, 255]])

    await editor().getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(editor().getByRole('button', { name: '实际大小', exact: true })).not.toHaveText('100%')
    await next.click(); await readyEditor()
    await expect(displayedImage).toHaveAttribute('src', thirdPageDataUrl)
    await expect(editor().getByRole('button', { name: '实际大小', exact: true })).toHaveText('100%')
    await expect(editor().getByText('3 / 3', { exact: true })).toBeVisible()
    await expect(previous).toBeEnabled(); await expect(next).toBeDisabled()
    expect((await inspectPng(await copiedPng(), [[12, 12], [160, 100]])).pixels).toEqual([[232, 168, 23, 255], [255, 255, 255, 255]])
    await editor().locator('.image-editor__stage').focus(); await page.keyboard.press('ArrowRight')
    await expect(displayedImage).toHaveAttribute('src', thirdPageDataUrl)

    await page.keyboard.press('ArrowLeft'); await readyEditor()
    await expect(displayedImage).toHaveAttribute('src', secondPageDataUrl)
    await expect(editor().getByRole('button', { name: '实际大小', exact: true })).toHaveText('100%')
    await expect(editor().getByText('2 / 3', { exact: true })).toBeVisible()
    expect((await inspectPng(await copiedPng(), [[160, 100]])).pixels[0]).toEqual([225, 29, 72, 255])
    await editor().locator('.image-editor__stage').focus(); await page.keyboard.press('ArrowLeft'); await readyEditor()
    await expect(displayedImage).toHaveAttribute('src', imageDataUrl)
    await expect(editor().getByRole('button', { name: '实际大小', exact: true })).toHaveText('100%')
    await expect(editor().getByText('1 / 3', { exact: true })).toBeVisible()
    await expect(previous).toBeDisabled(); await expect(next).toBeEnabled()
    expect((await inspectPng(await copiedPng(), [[12, 12], [160, 100]])).pixels).toEqual([[22, 73, 216, 255], [255, 255, 255, 255]])
    await editor().locator('.image-editor__stage').focus(); await page.keyboard.press('ArrowLeft')
    await expect(displayedImage).toHaveAttribute('src', imageDataUrl)

    await next.click(); await readyEditor()
    await expect(displayedImage).toHaveAttribute('src', secondPageDataUrl)
    expect((await inspectPng(await copiedPng(), [[160, 100]])).pixels[0]).toEqual([225, 29, 72, 255])
    await expectFullscreenLayout()
    await screenshot('document-pages-gallery', info)
    await closeEditor()
  })

  test('附件仅通过拖拽排序，引用保持图片身份且重载后顺序不变', async () => {
    const before = uploads.length
    await work().locator('input.work-file-input').setInputFiles([
      { name: 'drag-first.png', mimeType: 'image/png', buffer: originalBytes },
      { name: 'drag-second.png', mimeType: 'image/png', buffer: originalBytes }
    ])
    const items = work().locator('.work-attachments .attachment-strip__item')
    await expect(items).toHaveCount(2)
    await expect.poll(() => uploads.length).toBe(before + 2)
    const first = items.filter({ has: page.locator('img[alt="drag-first.png"]') })
    const second = items.filter({ has: page.locator('img[alt="drag-second.png"]') })
    const firstId = await first.getAttribute('data-attachment-id'), secondId = await second.getAttribute('data-attachment-id')
    expect(firstId).toBeTruthy(); expect(secondId).toBeTruthy(); expect(secondId).not.toBe(firstId)
    await first.hover()
    await expect(work().locator('.attachment-strip__moves')).toHaveCount(0)
    await expect(work().getByRole('button', { name: /前移|后移/ })).toHaveCount(0)
    await second.dragTo(first, { targetPosition: { x: 3, y: 26 } })
    await expect.poll(() => items.evaluateAll(elements => elements.map(element => element.getAttribute('data-attachment-id')))).toEqual([secondId, firstId])
    await expect(second).toHaveAttribute('data-attachment-label', '图1')
    await expect(first).toHaveAttribute('data-attachment-label', '图2')
    await expect.poll(async () => (await savedDraft()).attachments.map(file => file.attachmentId)).toEqual([secondId, firstId])

    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    await first.dragTo(input, { targetPosition: { x: 20, y: 18 } })
    const reference = input.locator('.mention-chip--attachment')
    await expect(reference).toHaveAttribute('data-attachment-id', firstId!)
    await expect(reference.locator('.mention-chip__label')).toHaveText('图2')
    await expect(first.locator('.attach-chip__reference')).toHaveText('图2')
    await expect.poll(async () => (await savedDraft()).mentions.map(mention => ({ id: mention.attachmentId, label: mention.displayText })))
      .toEqual([{ id: firstId, label: '图2' }])
    expect(uploads.length).toBe(before + 2)

    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect.poll(() => items.evaluateAll(elements => elements.map(element => element.getAttribute('data-attachment-id')))).toEqual([secondId, firstId])
    await expect(reference).toHaveAttribute('data-attachment-id', firstId!)
    await expect(reference.locator('.mention-chip__label')).toHaveText('图2')
    await reference.click()
    const preview = work().locator('.work-sources__preview-image')
    await expect(preview).toHaveAttribute('alt', 'drag-first.png')
    await expect(preview).toHaveJSProperty('naturalWidth', imageWidth)
  })

  test('所有引用标签都可拖动，附件与文件共用下划线且拖后草稿保留元数据', async ({}, info) => {
    const attachments: ChatAttachment[] = [
      { attachmentId: 'drag-image-first', path: userImagePath, name: 'original-user-image.png', type: 'image/png', size: originalBytes.length },
      { attachmentId: 'drag-image-second', path: duplicateImagePath, name: 'duplicate-user-image.png', type: 'image/png', size: originalBytes.length }
    ]
    const mentions: Mention[] = [
      { source: 'file', origin: 'workspace', path: 'sample.ts', displayText: '文件' },
      { source: 'dir', origin: 'workspace', path: 'src', displayText: '目录' },
      { source: 'code', origin: 'workspace', path: 'sample.ts', displayText: '源码', startLine: 1, endLine: 2, content: 'const answer = 42;\nexport { answer };' },
      { source: 'terminal', path: 'terminal-output.txt', displayText: '终端', content: 'build passed' },
      { source: 'agent', path: 'reviewer', displayText: 'Agent' },
      { source: 'browser', path: 'https://example.com/preview', displayText: '网页', content: 'preview snapshot' },
      { source: 'conversation', path: 'aether://conversation/drag-fixture', displayText: '会话', content: 'previous discussion' },
      { source: 'file', origin: 'attachment', attachmentId: 'drag-image-second', path: duplicateImagePath, displayText: '图2' }
    ]
    let text = 'START_TARGET '
    for (const mention of mentions) { mention.textOffset = text.length; text += `${mentionToken(mention)} ` }
    text += 'END_TARGET'
    await seedTask({ text, mentions, attachments })
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    const chips = input.locator('[data-mention-key]'), attachment = input.locator('.mention-chip--attachment')
    await expect(chips).toHaveCount(mentions.length)
    await expect.poll(() => chips.evaluateAll(elements => elements.map(element => element.getAttribute('draggable')))).toEqual(mentions.map(() => 'true'))
    await expect(attachment.locator('img, svg, button, .mention-chip__remove, .mention-chip__thumb')).toHaveCount(0)
    const appearance = await input.evaluate(element => {
      const style = (selector: string): object => {
        const chip = element.querySelector(selector); if (!chip) throw new Error(`Missing reference ${selector}`)
        const main = getComputedStyle(chip), underline = getComputedStyle(chip, '::after')
        return { display: main.display, background: main.backgroundColor, border: main.borderWidth, padding: main.padding,
          align: main.verticalAlign, underlineContent: underline.content, underlineColor: underline.backgroundColor, underlineHeight: underline.height }
      }
      return { file: style('.mention-chip--file:not(.mention-chip--attachment)'), attachment: style('.mention-chip--attachment') }
    })
    expect(appearance.attachment).toEqual(appearance.file)
    await dragToDraftText(input.locator('.mention-chip--code'), input, 'END_TARGET', true)
    await dragToDraftText(attachment, input, 'START_TARGET', false)
    const expectedLabels = ['图2', '文件', '目录', '终端', 'Agent', '网页', '会话', '源码']
    await expect(chips.locator('.mention-chip__label')).toHaveText(expectedLabels)
    await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.displayText)).toEqual(expectedLabels)
    const saved = await savedDraft()
    expect(saved.attachments.map(file => file.attachmentId)).toEqual(['drag-image-first', 'drag-image-second'])
    expect(saved.mentions[0]).toMatchObject({ attachmentId: 'drag-image-second', origin: 'attachment', path: duplicateImagePath })
    expect(saved.mentions.at(-1)).toMatchObject({ source: 'code', path: 'sample.ts', startLine: 1, endLine: 2, content: mentions[2].content })
    let previousOffset = -1
    for (const mention of saved.mentions) {
      expect(mention.textOffset).toBeGreaterThan(previousOffset)
      const offset = mention.textOffset!, token = mentionToken(mention)
      expect(saved.draft.slice(offset, offset + token.length)).toBe(token)
      previousOffset = offset
    }
    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(chips.locator('.mention-chip__label')).toHaveText(expectedLabels)
    await expect(attachment).toHaveAttribute('data-attachment-id', 'drag-image-second')
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await page.mouse.move(0, 0)
      await screenshot(`reference-labels-${appearance}`, info)
    }
    await attachment.click()
    const preview = work().locator('.work-sources__preview-image')
    await expect(preview).toHaveAttribute('alt', 'duplicate-user-image.png')
    await expect(preview).toHaveJSProperty('naturalWidth', imageWidth)
  })

  test('浅深主题显示完整工具栏、画布与导出操作', async ({}, info) => {
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await openToolImage(); await setInk(); await draw('箭头', [180, 180], [480, 360])
      await expect(editor().getByRole('toolbar', { name: '图片标注工具' })).toBeVisible()
      await expect(editor().getByRole('button', { name: '引用到会话', exact: true })).toBeVisible()
      expect(await editor().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await expectFullscreenLayout()
      await screenshot(`image-markup-${appearance}`, info); await copiedPng(); await closeEditor()
    }
  })
})
