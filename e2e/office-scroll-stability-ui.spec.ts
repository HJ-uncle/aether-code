/** Real Electron PPTX notes regression: real archive/IPC/iframe rendering, small wheel input and consecutive animation-frame geometry. Fixture engine only; no generated model calls or production configuration. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const sessionId = 'work-office-scroll-stability', modelId = 'office-scroll-stability-fixture', token = 'office-scroll-stability-token'
const title = '演示备注滚动稳定性', workspace = '/remote/office-scroll-stability', now = Date.now() - 10_000
const filename = 'notes-scroll-stability.pptx', filePath = `${workspace}/${filename}`
const run: RootRun = { schemaVersion: 1, runId: 'office-scroll-stability-run', sessionId, turnId: 'office-scroll-stability-turn',
  userMessageId: 'office-scroll-stability-user', assistantMessageId: 'office-scroll-stability-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [workspace], createdAt: now, updatedAt: now + 1000, finishedAt: now + 1000 }
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const history = [{ id: run.userMessageId, role: 'user', content: title, createdAt: now, conversationId: run.turnId, metadata },
  { id: run.assistantMessageId, role: 'assistant', content: '已生成文档，请检查文件预览。', createdAt: now + 1000, conversationId: run.turnId, metadata }]
const changes: EngineFileChange[] = [{ id: 'office-scroll-stability-change', sessionId, runId: run.runId, turnId: run.turnId,
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
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'office-scroll-stability-fixture' }
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
  await control.click(); await page.getByRole('menuitem', { name: label, exact: true }).click()
  await expect(control).toContainText(label)
}
async function expectDocument(): Promise<void> {
  await expect(detail().locator('[data-document-pages="5"]')).toBeVisible()
  await expect(detail().locator('iframe.document-preview__frame').first().contentFrame().getByText('OFFICE_SCROLL_SLIDE_1')).toBeVisible()
  await expect(detail().locator('.document-preview__notes summary')).toHaveText('备注 · 第 1 页')
}
test.beforeAll(async () => {
  mkdirSync(tempRoot, { recursive: true }); fixture = mkdtempSync(join(tempRoot, 'office-scroll-stability-profile-'))
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  const notes = ['第一页备注', '第二页备注', null, '倒数第二页只有一行备注。', Array.from({ length: 18 }, (_, index) => `末页备注第 ${index + 1} 行：核对滚动时备注与幻灯片保持稳定。`).join('\n')]
  for (const [index, note] of notes.entries()) {
    const slide = deck.addSlide()
    slide.addText(`OFFICE_SCROLL_SLIDE_${index + 1}`, { x: 0.5, y: 0.5, w: 11, h: 1, fontSize: 26, color: '222222' })
    if (note !== null) slide.addNotes(note)
  }
  bytes = Buffer.from(await deck.write({ outputType: 'arraybuffer' }) as ArrayBuffer)
  writeFileSync(join(fixture, filename), bytes)
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
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 1200); window.show(); window.focus() })
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
    if (fixture) { const target = resolve(fixture); if (dirname(target) !== tempRoot || !basename(target).startsWith('office-scroll-stability-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

interface ScrollFrame { top: number; height: number; scrollHeight: number; notesPage: number; notesHeight: number; open: boolean }
const body = (): Locator => detail().locator('.document-preview__body--continuous')
const notes = (): Locator => detail().locator('.document-preview__notes')
async function settledNotes(): Promise<void> {
  // Native ::details-content transitions do not appear in getAnimations on
  // every Chromium version. Wait for the actual expanded/collapsed geometry.
  await expect.poll(() => notes().evaluate(element => {
    const summary = element.querySelector('summary')!, content = element.querySelector('.document-preview__notes-content')!
    const style = getComputedStyle(element)
    const target = summary.getBoundingClientRect().height + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
      + (element.hasAttribute('open') ? content.getBoundingClientRect().height : 0)
    return Math.abs(element.getBoundingClientRect().height - target)
  })).toBeLessThanOrEqual(1)
}
async function goToSlide(number: number): Promise<void> {
  await settledNotes()
  await body().evaluate((element, number) => {
    const pages = [...element.querySelectorAll<HTMLElement>('[data-document-page]')]
    const target = pages[number - 1]
    if (!target) throw new Error(`Missing slide ${number}`)
    if (number === pages.length) element.scrollTop = element.scrollHeight
    else {
      const offset = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
      element.scrollTop = Math.max(0, offset + 12 - element.clientHeight * 0.35)
    }
  }, number)
  await expect(notes().locator('summary')).toHaveText(`备注 · 第 ${number} 页`)
}
async function frames(count: number): Promise<ScrollFrame[]> {
  return body().evaluate((element, count) => new Promise<ScrollFrame[]>(resolve => {
    const result: ScrollFrame[] = []
    const tick = (): void => {
      const notes = element.parentElement?.querySelector<HTMLDetailsElement>('.document-preview__notes')
      result.push({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight,
        notesPage: Number(notes?.querySelector<HTMLElement>('[data-presentation-notes]')?.dataset.presentationNotes ?? 0),
        notesHeight: notes?.getBoundingClientRect().height ?? 0, open: notes?.open ?? false })
      if (result.length < count) requestAnimationFrame(tick); else resolve(result)
    }
    requestAnimationFrame(tick)
  }), count)
}
function transitions(values: number[]): number[] { return values.filter((value, index) => index === 0 || value !== values[index - 1]) }
async function saveFrames(info: TestInfo, name: string, value: unknown): Promise<void> {
  const path = info.outputPath(`${name}.json`)
  writeFileSync(path, JSON.stringify(value, null, 2))
  await info.attach(name, { path, contentType: 'application/json' })
}

test('适应宽度时从短备注页向下滚至末页，备注高度和当前页不会来回跳变', async ({}, info) => {
  await expect(zoom()).toContainText('适应宽度')
  await goToSlide(4)
  await notes().locator('summary').click(); await expect(notes()).toHaveAttribute('open', '')
  await settledNotes()
  await goToSlide(4)
  await expect(notes().locator('[data-presentation-notes="4"]')).toContainText('倒数第二页只有一行备注')
  const before = await frames(12)
  const box = await body().boundingBox(); if (!box) throw new Error('Missing preview viewport')
  const slideHeight = await body().locator('[data-document-page="4"]').evaluate(element => element.getBoundingClientRect().height)
  expect(before.at(-1)!.height, 'Reproduction requires a viewport taller than one fitted slide').toBeGreaterThan(slideHeight * 1.5)
  // The padding targets the actual scrolling parent instead of an iframe's
  // inner document. Small wheel events recreate the near-bottom interaction.
  await page.mouse.move(box.x + 6, box.y + box.height / 2)
  const recording = frames(120)
  for (let index = 0; index < 28; index++) {
    await page.mouse.wheel(0, 24)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
  const moving = await recording, after = await frames(30)
  const samples = [...before, ...moving, ...after]
  await saveFrames(info, 'continuous-scroll-frames', { slideHeight, before, moving, after })
  const heightRange = Math.max(...samples.map(frame => frame.height)) - Math.min(...samples.map(frame => frame.height))
  expect(heightRange, 'Changing from a short note to a long note must not resize the slide viewport').toBeLessThanOrEqual(1)
  const pageChanges = transitions(moving.map(frame => frame.notesPage))
  expect(pageChanges.every((value, index) => index === 0 || value >= pageChanges[index - 1]), `Notes page reversed during downward wheel: ${pageChanges.join(' → ')}`).toBe(true)
  expect(new Set(after.map(frame => frame.notesPage))).toEqual(new Set([5]))
  expect(Math.max(...after.map(frame => frame.top)) - Math.min(...after.map(frame => frame.top))).toBeLessThanOrEqual(1)
  expect(after.every(frame => frame.open)).toBe(true)
  await expect(notes().locator('[data-presentation-notes="5"]')).toContainText('末页备注第 18 行')
  expect(reads.length).toBeGreaterThan(0)
})

test('空备注与长短备注保持同一视口，开合、内部滚动和缩放后末页仍稳定', async ({}, info) => {
  if (await notes().getAttribute('open') === null) await notes().locator('summary').click()
  await expect(notes()).toHaveAttribute('open', '')
  const byPage: Record<number, ScrollFrame[]> = {}
  for (const number of [3, 4, 5]) {
    await goToSlide(number)
    const content = notes().locator(`[data-presentation-notes="${number}"]`)
    await expect(content).toBeVisible()
    await expect(content).toContainText(number === 3 ? '本页暂无备注' : number === 4 ? '倒数第二页只有一行备注' : '末页备注第 18 行')
    byPage[number] = await frames(12)
  }
  await saveFrames(info, 'open-notes-page-geometry', byPage)
  const heights = Object.values(byPage).flat().map(frame => frame.height)
  expect(Math.max(...heights) - Math.min(...heights), 'An empty notes page must keep the same open notes slot').toBeLessThanOrEqual(1)
  const openHeight = byPage[5].at(-1)!.height

  await notes().locator('summary').click(); await expect(notes()).not.toHaveAttribute('open')
  await settledNotes()
  await expect.poll(() => body().evaluate(element => element.clientHeight)).toBeGreaterThan(openHeight)
  const closed = await frames(12)
  expect(closed.every(frame => !frame.open)).toBe(true)
  await notes().locator('summary').click(); await expect(notes()).toHaveAttribute('open', '')
  await settledNotes()
  await expect.poll(() => body().evaluate(element => element.clientHeight)).toBe(openHeight)
  await goToSlide(5)

  const content = notes().locator('[data-presentation-notes="5"]')
  await expect.poll(() => content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(50)
  const beforeInternalScroll = (await frames(12)).at(-1)!
  await content.hover(); await page.mouse.wheel(0, 500)
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const internalScroll = await frames(30)
  expect(internalScroll.every(frame => Math.abs(frame.top - beforeInternalScroll.top) <= 1 && frame.height === openHeight && frame.notesPage === 5)).toBe(true)

  const afterZoom: Record<string, ScrollFrame[]> = {}
  const fittedScale = await body().locator('[data-document-page="5"] iframe').contentFrame().locator('main.document-page').evaluate(element => Number(element.style.zoom))
  for (const label of ['50%', '适应宽度']) {
    await choose(zoom(), label)
    const lastFrame = body().locator('[data-document-page="5"] iframe').contentFrame().locator('main.document-page')
    if (label === '50%') await expect.poll(() => lastFrame.evaluate(element => Number(element.style.zoom))).toBe(0.5)
    else await expect.poll(() => lastFrame.evaluate(element => Number(element.style.zoom))).toBe(fittedScale)
    await goToSlide(5)
    afterZoom[label] = await frames(45)
  }
  await saveFrames(info, 'notes-toggle-internal-scroll-and-zoom', { closed, internalScroll, afterZoom })
  for (const [label, samples] of Object.entries(afterZoom)) {
    expect(new Set(samples.map(frame => frame.notesPage)), label).toEqual(new Set([5]))
    expect(samples.every(frame => frame.open && frame.height === openHeight), label).toBe(true)
    expect(Math.max(...samples.map(frame => frame.top)) - Math.min(...samples.map(frame => frame.top)), label).toBeLessThanOrEqual(1)
    const last = samples.at(-1)!
    expect(last.scrollHeight - last.height - last.top, `${label} must reach the final slide at the scrollbar end`).toBeLessThanOrEqual(2)
  }
})

