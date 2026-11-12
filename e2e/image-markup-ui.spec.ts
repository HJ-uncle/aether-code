/** Real Electron image markup: exported PNG/clipboard pixels, undo/redo branches,
 * rotation coordinates, whole-vector erasure, draft replacement, owned uploads,
 * and native attachment/reference dragging with persisted identities and offsets,
 * including distinct builtin Agent glyphs shared by the picker and inline chips,
 * and the shared color panel's preview/cancel ownership without changing the app theme.
 * Build first, then run with --config e2e/config/playwright.work-local-attachment-preview.config.ts (one window only). */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { RootRun } from '../src/shared/root-run'
import { ATTACHMENTS_DIRECTORY } from '../src/shared/attachments'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { ChatAttachment } from '../src/renderer/src/core/engine/useChat'
import { mentionToken, type Mention } from '../src/renderer/src/features/conversation/shared/mention-context'

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
    : path === '/api/v1/agents' ? [{ id: 'custom-reference-fixture', name: '自定义审阅', description: '验证自定义 Agent 的通用图标' }]
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

async function seedTask(seed?: { text: string; mentions: Mention[]; attachments: ChatAttachment[]; sources?: ChatAttachment[] }): Promise<void> {
  await page.evaluate(({ key, sessionId, title, now, modelId, workspaceRoot, seed }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: seed.text, mentions: seed.mentions, createdAt: now,
      updatedAt: now, workspacePath: workspaceRoot, modelId, attachments: seed.attachments, sources: seed.sources ?? [] }], activeTaskId: sessionId }))
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
  await chip.scrollIntoViewIfNeeded()
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
  const source = await chip.boundingBox(), target = await input.boundingBox()
  if (!source || !target) throw new Error('Reference drag has no visible layout')
  const x = source.x + source.width / 2, y = source.y + source.height / 2
  const to = { x: target.x + targetPosition.x, y: target.y + targetPosition.y }
  // The decorative image can delegate pointer events to its parent. Starting
  // at its real screen coordinates still exercises the user's native gesture.
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 8, y + 3, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 18 }); await page.mouse.move(to.x, to.y); await page.mouse.up()
}

async function expectInlineImage(reference: Locator): Promise<void> {
  const image = reference.locator('img.mention-chip__thumbnail')
  await expect(image).toHaveCount(1); await expect(image).toHaveJSProperty('naturalWidth', imageWidth)
  await expect(image).toHaveJSProperty('naturalHeight', imageHeight)
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

async function setInkColor(color = '#e11d48'): Promise<void> {
  const trigger = editor().getByRole('button', { name: '标注颜色', exact: true })
  await trigger.click()
  const picker = page.getByRole('dialog', { name: '选择标注颜色', exact: true })
  const hex = picker.getByRole('textbox', { name: 'HEX 色值', exact: true })
  await hex.fill(color); await hex.press('Enter')
  await picker.getByRole('button', { name: '完成颜色选择', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(trigger).toHaveAttribute('title', `标注颜色：${color}`)
}

async function setInk(): Promise<void> {
  await setInkColor()
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

  test('共享标注调色板支持预览确认与取消，键盘不切图且浅深主题均不改强调色', async ({}, info) => {
    const savedAccent = (): { accent: unknown; customAccentColor: unknown } => {
      const settings = JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8'))
      return { accent: settings.accent, customAccentColor: settings.customAccentColor }
    }
    const theme = (): Promise<{ appearance: string | undefined; accent: string | undefined; color: string }> => page.evaluate(() => ({
      appearance: document.documentElement.dataset.appearance,
      accent: document.documentElement.dataset.accent,
      color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    }))
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(settings).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      const beforeTheme = await theme(), beforeSavedAccent = savedAccent()
      await openToolImage()
      const trigger = editor().getByRole('button', { name: '标注颜色', exact: true })
      const picker = page.getByRole('dialog', { name: '选择标注颜色', exact: true })
      const originalTitle = await trigger.getAttribute('title')
      if (!originalTitle) throw new Error('The color well must expose its current color')
      const originalImage = await editor().locator('.image-editor__surface > img').getAttribute('src')
      const originalPosition = await editor().locator('.image-editor__position').innerText()
      await expect(editor().getByRole('button', { name: '下一张', exact: true })).toBeEnabled()
      await expect(editor().locator('input[type="color"]')).toHaveCount(0)
      await trigger.click()
      await expect(picker).toHaveAttribute('data-motion-state', 'open')
      const spectrum = picker.getByRole('slider', { name: '饱和度和亮度', exact: true })
      const hex = picker.getByRole('textbox', { name: 'HEX 色值', exact: true })
      await expect(spectrum).toBeFocused()
      const panelBox = await picker.boundingBox(), triggerBox = await trigger.boundingBox()
      if (!panelBox || !triggerBox) throw new Error('Color panel or trigger is not laid out')
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(triggerBox.y)
      expect(panelBox.x).toBeGreaterThanOrEqual(8)
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth - 8))
      expect(await spectrum.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      })).toBe(true)

      await hex.fill('#2384d1'); await hex.press('Enter')
      await expect(trigger).toHaveAttribute('title', '标注颜色：#2384d1')
      expect(await theme()).toEqual(beforeTheme); expect(savedAccent()).toEqual(beforeSavedAccent)
      await spectrum.focus(); await page.keyboard.press('ArrowRight')
      await expect(hex).not.toHaveValue('#2384d1')
      await expect(editor().locator('.image-editor__surface > img')).toHaveAttribute('src', originalImage!)
      await expect(editor().locator('.image-editor__position')).toHaveText(originalPosition)
      await picker.getByRole('button', { name: '完成颜色选择', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(picker.getByRole('button', { name: '还原', exact: true })).toBeFocused()
      await screenshot(`image-color-picker-${appearance}`, info)
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0); await expect(editor()).toBeVisible()
      await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute('title', originalTitle)

      // The existing six-tool PNG test uses this same confirmation path and
      // verifies the actual exported pixels, rather than just the well's label.
      await setInkColor()
      await expect(trigger).toBeFocused()
      await trigger.click(); await hex.fill('#34c759'); await hex.press('Enter')
      await expect(trigger).toHaveAttribute('title', '标注颜色：#34c759')
      await editor().getByRole('button', { name: '移动', exact: true }).click()
      await expect(picker).toHaveCount(0); await expect(editor()).toBeVisible()
      await expect(trigger).toHaveAttribute('title', '标注颜色：#e11d48')
      expect(await theme()).toEqual(beforeTheme); expect(savedAccent()).toEqual(beforeSavedAccent)
      if (appearance === 'dark') {
        const previousSize = await app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0], size = window.getContentSize()
          window.setContentSize(960, 680)
          return size
        })
        try {
          await trigger.click(); await expect(picker).toHaveAttribute('data-motion-state', 'open')
          const bounds = await picker.evaluate(element => {
            const box = element.getBoundingClientRect()
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight }
          })
          expect(bounds.left).toBeGreaterThanOrEqual(8); expect(bounds.top).toBeGreaterThanOrEqual(8)
          expect(bounds.right).toBeLessThanOrEqual(bounds.width - 8); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8)
          await hex.fill('#2384d1'); await hex.press('Enter')
          await picker.getByRole('button', { name: '完成颜色选择', exact: true }).click()
          await expect(picker).toHaveCount(0); await expect(trigger).toHaveAttribute('title', '标注颜色：#2384d1')
          await trigger.click(); await expect(hex).toHaveValue('#2384d1')
          await expect(picker).toHaveAttribute('data-motion-state', 'open')
          await expect(hex).toBeVisible()
          await screenshot('image-color-picker-narrow', info)
          await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
        } finally {
          await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), previousSize)
        }
      }
      await closeEditor()
    }
  })

  test('共享调色板仍支持设置页预览取消与确认持久化，重载后恢复原主题', async () => {
    const original = await page.evaluate(async () => {
      const settings = await window.aether.settings.get()
      return { accent: settings.accent, customAccentColor: settings.customAccentColor, appearance: settings.appearance }
    })
    const theme = (): Promise<{ accent: string | undefined; custom: string | undefined; appearance: string | undefined }> => page.evaluate(() => ({
      accent: document.documentElement.dataset.accent,
      custom: document.documentElement.dataset.customAccent,
      appearance: document.documentElement.dataset.appearance
    }))
    const beforeTheme = await theme()
    const savedAccent = (): { accent: unknown; customAccentColor: unknown } => {
      const settings = JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8'))
      return { accent: settings.accent, customAccentColor: settings.customAccentColor }
    }
    const beforeSavedAccent = savedAccent()
    try {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      const trigger = settings.getByRole('radio', { name: '自定义颜色', exact: true })
      const picker = page.getByRole('dialog', { name: '自定义强调色', exact: true })
      const hex = picker.getByRole('textbox', { name: '自定义强调色色值', exact: true })
      await trigger.click(); await expect(hex).toHaveValue(original.customAccentColor)
      await hex.fill('#c14681'); await hex.press('Enter')
      await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
      await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c14681')
      expect(savedAccent()).toEqual(beforeSavedAccent)
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0); await expect(settings).toBeVisible(); await expect(trigger).toBeFocused()
      expect(await theme()).toEqual(beforeTheme); expect(savedAccent()).toEqual(beforeSavedAccent)

      await trigger.click(); await expect(hex).toHaveValue(original.customAccentColor)
      await hex.fill('#316fbd'); await hex.press('Enter')
      await picker.getByRole('button', { name: '完成颜色选择', exact: true }).click()
      await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused()
      await expect.poll(savedAccent).toEqual({ accent: 'custom', customAccentColor: '#316fbd' })
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
      await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#316fbd')
    } finally {
      // Fixture cleanup bypasses the UI so a failed assertion cannot leak the
      // saved custom color into later specs sharing this Electron profile.
      await page.evaluate(patch => window.aether.settings.update(patch), original)
      await page.reload()
      await expect.poll(theme).toEqual(beforeTheme)
    }
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

    await setInkColor()
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

  test('标注新版与同身份历史原图可同时引用，附件栏只保留新版且缩略图拖拽可撤销', async ({}, info) => {
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    const cards = work().locator('.work-attachments .attachment-strip__item')
    // Restore through the actual history action. A second localStorage seed
    // races the mounted renderer's draft flush and history-source hydration.
    await work().locator('.work-message--user').getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(cards).toHaveCount(2)
    await work().getByRole('button', { name: '移除附件 duplicate-user-image.png', exact: true }).click()
    await expect(cards).toHaveCount(1)
    const id = await cards.getAttribute('data-attachment-id')
    expect(id).not.toBeNull()
    await expect.poll(async () => (await savedDraft()).attachments.length).toBe(1)
    const original: ChatAttachment = { ...(await savedDraft()).attachments[0], attachmentId: id! }
    expect(original.path).toBe(userImagePath)
    await input.fill('START_TARGET '); await page.keyboard.insertText('@')
    const picker = page.locator('.mention-ref-picker:visible')
    const attachmentGroup = picker.getByRole('group', { name: '当前附件', exact: true })
    await expect(attachmentGroup).toBeVisible()
    await expect(attachmentGroup.getByRole('option')).toHaveCount(1); await attachmentGroup.getByRole('option').click()
    await expect(picker).toHaveCount(0)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' END_TARGET')
    await expect.poll(async () => (await savedDraft()).mentions.map(item => item.path)).toEqual([original.path])
    const before = uploads.length
    await cards.locator('.attach-chip__image-btn').click(); await readyEditor(); await setInk()
    await draw('画笔', [80, 100], [240, 100])
    await editor().getByRole('button', { name: '应用编辑', exact: true }).click()
    await expect(editor()).toHaveCount(0); await expect.poll(() => uploads.length).toBe(before + 1)
    const edited = uploads[before], editedSrc = `data:image/png;base64,${edited.bytes.toString('base64')}`
    expect(edited.path).not.toBe(original.path)
    await expect.poll(async () => (await savedDraft()).attachments.map(file => ({ id: file.attachmentId, path: file.path })))
      .toEqual([{ id: original.attachmentId, path: edited.path }])
    await expect.poll(async () => (await savedDraft()).mentions.map(item => item.path)).toEqual([edited.path])

    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '资料', exact: true }).click()
    const source = work().locator('.work-source-row').filter({ has: page.locator(`.work-source-row__main[title="${original.path}"]`) })
    await expect(source).toHaveCount(1)
    await source.getByRole('button', { name: '添加到对话', exact: true }).click()
    await work().getByRole('button', { name: '收起工作区', exact: true }).click()
    const references = input.locator('.mention-chip--attachment')
    const imageFor = (label: string): Locator => references.filter({ has: page.locator('.mention-chip__label', { hasText: new RegExp(`^${label}$`) }) })
    const expectVersions = async (): Promise<void> => {
      await expect(cards).toHaveCount(1); await expect(cards).toHaveAttribute('data-attachment-id', original.attachmentId!)
      await expect(cards.locator('.attach-chip__thumb')).toHaveAttribute('src', editedSrc)
      await expect(references).toHaveCount(2)
      await expect.poll(() => references.evaluateAll(elements => elements.map(element => element.getAttribute('data-attachment-id'))))
        .toEqual([original.attachmentId, original.attachmentId])
      await expectInlineImage(imageFor('图1')); await expectInlineImage(imageFor('图2'))
      await expect(imageFor('图1').locator('img')).toHaveAttribute('src', editedSrc)
      await expect(imageFor('图2').locator('img')).toHaveAttribute('src', imageDataUrl)
    }
    await expect(references.locator('.mention-chip__label')).toHaveText(['图1', '图2']); await expectVersions()
    await expect.poll(async () => (await savedDraft()).mentions.map(item => item.path)).toEqual([edited.path, original.path])
    expect((await inspectPng(await imageFor('图1').locator('img').getAttribute('src') ?? '', [[160, 100]])).pixels[0]).toEqual([225, 29, 72, 255])
    expect((await inspectPng(await imageFor('图2').locator('img').getAttribute('src') ?? '', [[160, 100]])).pixels[0]).toEqual([255, 255, 255, 255])

    await dragToDraftText(imageFor('图2').locator('img'), input, 'START_TARGET', false)
    await expect(references.locator('.mention-chip__label')).toHaveText(['图2', '图1']); await expectVersions()
    await expect.poll(async () => (await savedDraft()).mentions.map(item => item.path)).toEqual([original.path, edited.path])
    await input.focus(); await page.keyboard.press('Control+Z')
    await expect(references.locator('.mention-chip__label')).toHaveText(['图1', '图2']); await expectVersions()
    await expect.poll(async () => (await savedDraft()).mentions.map(item => item.path)).toEqual([edited.path, original.path])
    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(references.locator('.mention-chip__label')).toHaveText(['图1', '图2']); await expectVersions()
    expect(uploads.length).toBe(before + 1); expect(files.get(original.path)!.bytes.equals(originalBytes)).toBe(true)
    await screenshot('edited-and-historical-reference', info)
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
    await expectInlineImage(reference)
    await expect(first.locator('.attach-chip__reference')).toHaveText('图2')
    await expect.poll(async () => (await savedDraft()).mentions.map(mention => ({ id: mention.attachmentId, label: mention.displayText })))
      .toEqual([{ id: firstId, label: '图2' }])
    expect(uploads.length).toBe(before + 2)

    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect.poll(() => items.evaluateAll(elements => elements.map(element => element.getAttribute('data-attachment-id')))).toEqual([secondId, firstId])
    await expect(reference).toHaveAttribute('data-attachment-id', firstId!)
    await expect(reference.locator('.mention-chip__label')).toHaveText('图2')
    await expectInlineImage(reference)
    await reference.click()
    await readyEditor(); await expect(editor()).toContainText('drag-first.png'); await closeEditor()
  })

  test('所有引用无下划线且保留轻量选中反馈，附件与文件一致并可拖动撤销', async ({}, info) => {
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
    await expectInlineImage(attachment)
    await expect(input.locator('.mention-chip:not(.mention-chip--attachment) img')).toHaveCount(0)
    await expect(attachment.locator('svg, button, .mention-chip__remove, .mention-chip__thumb')).toHaveCount(0)
    const appearance = await input.evaluate(element => {
      const style = (selector: string): object => {
        const chip = element.querySelector(selector); if (!chip) throw new Error(`Missing reference ${selector}`)
        const main = getComputedStyle(chip), after = getComputedStyle(chip, '::after')
        return { display: main.display, background: main.backgroundColor, border: main.borderWidth, padding: main.padding,
          align: main.verticalAlign, decoration: main.textDecorationLine, afterContent: after.content }
      }
      return { file: style('.mention-chip--file:not(.mention-chip--attachment)'), attachment: style('.mention-chip--attachment') }
    })
    expect(appearance.attachment).toEqual(appearance.file)
    const decorations = await chips.evaluateAll(elements => elements.map(element => {
      const label = element.querySelector('.mention-chip__label')!
      return { decoration: getComputedStyle(element).textDecorationLine, labelDecoration: getComputedStyle(label).textDecorationLine,
        afterContent: getComputedStyle(element, '::after').content }
    }))
    for (const style of decorations) {
      expect(style.decoration).not.toContain('underline'); expect(style.labelDecoration).not.toContain('underline')
      expect(['none', 'normal']).toContain(style.afterContent)
    }
    await dragToDraftText(input.locator('.mention-chip--code'), input, 'END_TARGET', true)
    const beforeImageDrag = ['文件', '目录', '终端', 'Agent', '网页', '会话', '图2', '源码']
    await expect(chips.locator('.mention-chip__label')).toHaveText(beforeImageDrag)
    // Starting on the miniature must move the atomic reference, not an image URL.
    await dragToDraftText(attachment.locator('img.mention-chip__thumbnail'), input, 'START_TARGET', false)
    const expectedLabels = ['图2', '文件', '目录', '终端', 'Agent', '网页', '会话', '源码']
    await expect(chips.locator('.mention-chip__label')).toHaveText(expectedLabels)
    await expect(attachment).toHaveAttribute('data-attachment-id', 'drag-image-second')
    await input.focus(); await page.keyboard.press('Control+Z')
    await expect(chips.locator('.mention-chip__label')).toHaveText(beforeImageDrag)
    await expect(attachment).toHaveAttribute('data-attachment-id', 'drag-image-second'); await expectInlineImage(attachment)
    await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.displayText)).toEqual(beforeImageDrag)
    await page.keyboard.press('Control+Y')
    await expect(chips.locator('.mention-chip__label')).toHaveText(expectedLabels)
    await expect(attachment).toHaveAttribute('data-attachment-id', 'drag-image-second'); await expectInlineImage(attachment)
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
    await expectInlineImage(attachment)
    await expect(input.locator('.mention-chip:not(.mention-chip--attachment) img')).toHaveCount(0)
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await page.mouse.move(0, 0)
      const focusAppearance = async (reference: Locator) => {
        await input.focus()
        for (let index = 0; index < mentions.length + 1; index++) {
          await page.keyboard.press('Tab')
          if (await reference.evaluate(element => document.activeElement === element)) break
        }
        await expect(reference).toBeFocused()
        const style = await reference.evaluate(element => {
          const main = getComputedStyle(element), sample = document.createElement('canvas'); sample.width = sample.height = 1
          const context = sample.getContext('2d'); if (!context) throw new Error('Focus color probe unavailable')
          context.fillStyle = main.backgroundColor; context.fillRect(0, 0, 1, 1)
          return { visible: element.matches(':focus-visible'), outline: main.outlineStyle, border: parseFloat(main.borderWidth), shadow: main.boxShadow,
            radius: parseFloat(main.borderTopLeftRadius), background: main.backgroundColor, pixel: [...context.getImageData(0, 0, 1, 1).data] }
        })
        expect(style.visible).toBe(true); expect(style.outline).toBe('none'); expect(style.border).toBe(0); expect(style.shadow).toBe('none')
        expect(style.radius).toBeGreaterThan(0); expect(style.pixel[3]).toBeGreaterThan(0); expect(style.pixel[3]).toBeLessThanOrEqual(64)
        return style
      }
      const fileFocus = await focusAppearance(input.locator('.mention-chip--file:not(.mention-chip--attachment)'))
      const imageFocus = await focusAppearance(attachment)
      expect(imageFocus).toEqual(fileFocus)
      await screenshot(`reference-labels-${appearance}`, info)
      await input.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+End')
      const selected = await input.evaluate(element => {
        const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null
        return { text: selection?.toString() ?? '', collapsed: selection?.isCollapsed ?? true,
          inside: Boolean(range && element.contains(range.commonAncestorContainer)), width: range?.getBoundingClientRect().width ?? 0 }
      })
      expect(selected.collapsed).toBe(false); expect(selected.inside).toBe(true); expect(selected.width).toBeGreaterThan(0)
      for (const label of ['START_TARGET', 'END_TARGET', '文件', '图2']) expect(selected.text).toContain(label)
      const selectionColors = await chips.locator('.mention-chip__label').evaluateAll(elements => elements.map(element => {
        const selected = getComputedStyle(element, '::selection'), sample = document.createElement('canvas'); sample.width = sample.height = 1
        const context = sample.getContext('2d'); if (!context) throw new Error('Selection color probe unavailable')
        context.fillStyle = selected.backgroundColor; context.fillRect(0, 0, 1, 1)
        return { background: selected.backgroundColor, pixel: [...context.getImageData(0, 0, 1, 1).data] }
      }))
      for (const selection of selectionColors) {
        expect(selection.pixel[3]).toBeGreaterThan(0); expect(selection.pixel[3]).toBeLessThanOrEqual(64)
        expect(selection.background).toBe(imageFocus.background)
      }
      await screenshot(`reference-native-selection-${appearance}`, info)
      await page.keyboard.press('Control+End')
    }
    await attachment.click()
    await readyEditor(); await expect(editor()).toContainText('duplicate-user-image.png'); await closeEditor()
  })

  test('引用右键菜单按类型打开和复制，只移除当前引用且支持撤销与键盘', async ({}, info) => {
    const image: ChatAttachment = { attachmentId: 'menu-image', path: userImagePath, name: 'original-user-image.png', type: 'image/png', size: originalBytes.length }
    const mentions: Mention[] = [
      { source: 'file', origin: 'attachment', attachmentId: image.attachmentId, path: image.path, displayText: '图1' },
      { source: 'file', origin: 'attachment', attachmentId: image.attachmentId, path: image.path, displayText: '图1' },
      { source: 'dir', origin: 'workspace', path: 'icons', displayText: 'icons' },
      { source: 'agent', path: 'builtin-agent:executor:menu-instance', displayText: '执行' },
      { source: 'code', path: 'sample.ts', displayText: 'sample.ts', content: 'const MENU_REFERENCE = 42;' }
    ]
    let text = 'MENU_START '
    for (const mention of mentions) { mention.textOffset = text.length; text += `${mentionToken(mention)} ` }
    text += 'MENU_END'
    await seedTask({ text, mentions, attachments: [image] })
    const input = work().getByRole('textbox', { name: '继续对话', exact: true }), menu = page.getByRole('menu')
    const chips = input.locator('[data-mention-key]'), images = input.locator('.mention-chip--attachment')
    await expect(chips).toHaveCount(5)
    await images.first().click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '预览图片', exact: true })).toBeVisible()
    await expect(menu).toHaveAttribute('data-motion-state', 'open')
    await screenshot('reference-context-menu', info)
    await menu.getByRole('menuitem', { name: '预览图片', exact: true }).click()
    await readyEditor(); await expect(editor().getByRole('toolbar', { name: '图片标注工具' })).toBeVisible(); await closeEditor()
    await input.locator('.mention-chip--dir').click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '打开文件夹', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('icons')
    await input.locator('.mention-chip--agent').click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '查看 Agent', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: '复制名称', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('执行')
    await input.locator('.mention-chip--code').focus(); await page.keyboard.press('Shift+F10')
    await menu.getByRole('menuitem', { name: '复制内容', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('const MENU_REFERENCE = 42;')
    const before = await savedDraft()
    await images.first().click({ button: 'right' })
    await menu.getByRole('menuitem', { name: '移除引用 Delete', exact: true }).click()
    await expect(images).toHaveCount(1); await expect(work().locator('.attachment-strip__item')).toHaveCount(1)
    await expect.poll(async () => (await savedDraft()).mentions.length).toBe(4)
    await input.focus(); await page.keyboard.press('Control+Z')
    await expect(images).toHaveCount(2)
    await expect.poll(async () => (await savedDraft()).mentions).toEqual(before.mentions)
    await input.locator('.mention-chip--agent').click({ button: 'right' })
    await menu.getByRole('menuitem', { name: '在后面继续输入', exact: true }).click()
    await page.keyboard.insertText('插入位置 ')
    await expect.poll(async () => (await savedDraft()).draft).toContain('@builtin-agent:executor:menu-instance 插入位置 @sample.ts')
    await expect(chips).toHaveCount(5)
  })

  test('内置Agent图标区分角色并与正文一致，多实例拖动撤销保留身份', async ({}, info) => {
    const input = work().getByRole('textbox', { name: '继续对话', exact: true })
    const chips = input.locator('.mention-chip--agent')
    const picker = page.getByRole('group', { name: '协作 Agent', exact: true })
    const roles = [{ role: 'research', name: '调研' }, { role: 'executor', name: '执行' }, { role: 'general', name: '通用' }]
    const pathsByName = new Map<string, string[]>()
    const svgPaths = (target: Locator): Promise<string[]> => target.locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d') ?? ''))
    const openPicker = async (): Promise<void> => {
      await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @agent')
      await expect(picker).toBeVisible()
      await expect(picker).toHaveAttribute('aria-busy', 'false')
    }
    await input.fill('START_AGENT ')
    await openPicker()
    for (const name of [...roles.map(item => item.name), '自定义审阅']) {
      const option = picker.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) })
      await expect(option).toBeVisible(); await expect(option.locator('svg')).toHaveCount(1)
      const paths = await svgPaths(option)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) expect(path.length).toBeGreaterThan(10)
      pathsByName.set(name, paths)
    }
    // Compare the rendered paths rather than duplicating the icon implementation
    // in the test; this still rejects a generic avatar reused for every role.
    expect(new Set(roles.map(item => JSON.stringify(pathsByName.get(item.name)))).size).toBe(3)
    expect(roles.every(item => JSON.stringify(pathsByName.get(item.name)) !== JSON.stringify(pathsByName.get('自定义审阅')))).toBe(true)
    await screenshot('builtin-agent-picker-icons', info)
    const labels = roles.flatMap(item => [item.name, item.name]).concat('自定义审阅')
    for (const [index, name] of labels.entries()) {
      if (index > 0) await openPicker()
      await picker.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
      await expect(picker).toHaveCount(0); await expect(chips).toHaveCount(index + 1)
      await expect.poll(() => svgPaths(chips.nth(index))).toEqual(pathsByName.get(name))
    }
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' END_AGENT')
    await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.displayText)).toEqual(labels)
    const inserted = (await savedDraft()).mentions
    const ids = inserted.map(mention => mention.path!)
    expect(new Set(ids.slice(0, 6)).size).toBe(6)
    for (const [index, item] of roles.entries()) {
      for (const id of ids.slice(index * 2, index * 2 + 2)) expect(id).toMatch(new RegExp(`^builtin-agent:${item.role}:[a-zA-Z0-9_-]+$`))
    }
    expect(ids.at(-1)).toBe('custom-reference-fixture')
    const expectIcons = async (): Promise<void> => {
      const draft = await savedDraft()
      await expect(chips.locator('.mention-chip__label')).toHaveText(draft.mentions.map(mention => mention.displayText))
      for (const [index, mention] of draft.mentions.entries()) await expect.poll(() => svgPaths(chips.nth(index))).toEqual(pathsByName.get(mention.displayText))
      for (const mention of draft.mentions) {
        const token = mentionToken(mention), offset = mention.textOffset!
        expect(draft.draft.slice(offset, offset + token.length)).toBe(token)
      }
    }
    let order = [...ids]
    for (const [index, item] of roles.entries()) {
      const movingId = ids[index * 2], before = [...order]
      const roleChips = chips.filter({ has: page.locator('.mention-chip__label', { hasText: new RegExp(`^${item.name}$`) }) })
      // Begin on the glyph itself, so native SVG dragging cannot copy a URL or
      // insert another instance instead of moving the existing atomic chip.
      await dragToDraftText(roleChips.first().locator('svg'), input, 'END_AGENT', true)
      order = [...order.filter(id => id !== movingId), movingId]
      await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.path)).toEqual(order)
      await expectIcons()
      await input.focus(); await page.keyboard.press('Control+Z')
      await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.path)).toEqual(before)
      await expectIcons()
      await page.keyboard.press('Control+Y')
      await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.path)).toEqual(order)
      await expectIcons()
      if (index < roles.length - 1) {
        // Restore the same text boundary before the next role: otherwise a
        // prior chip already after END_AGENT would change the next drop target.
        await page.keyboard.press('Control+Z'); order = before
        await expect.poll(async () => (await savedDraft()).mentions.map(mention => mention.path)).toEqual(order)
      }
    }
    await screenshot('builtin-agent-inline-icons', info)
    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(chips).toHaveCount(labels.length)
    expect((await savedDraft()).mentions.map(mention => mention.path)).toEqual(order)
    await expectIcons()
    const restored = await savedDraft()
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await openPicker(); await page.mouse.move(0, 0)
      await screenshot(`builtin-agent-picker-and-inline-${appearance}`, info)
      await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
      await input.focus(); await page.keyboard.press('Control+End')
      for (let index = 0; index < ' @agent'.length; index++) await page.keyboard.press('Backspace')
      await expect.poll(async () => (await savedDraft()).draft).toBe(restored.draft)
    }
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
