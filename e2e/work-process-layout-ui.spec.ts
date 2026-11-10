/** Real Electron + authenticated history/SSE: long Work processes have a bounded
 * reader, repeated receipts disclose every original operation, large previews
 * stay opt-in, and activity navigation retains its one-request semantics.
 * Final answers and the existing collapsed lifecycle remain separate. Build first. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'process-layout-token', model = 'process-layout-model', now = Date.now() - 60_000
const settled = 'process-layout-settled', live = 'process-layout-live', workspaceRoot = '/remote/process-layout'
const titles = new Map([[settled, '核对完整文档处理过程'], [live, '继续检查文档处理过程']])
const finalText = 'PROCESS_LAYOUT_FINAL：文档检查已完成。\n\n所有页面均已核对，正文只保留交付结论。'
const noteText = 'PROCESS_LAYOUT_NOTE：正在核对页面尺寸和内容层次，下一步检查实际画面。'
const errors: string[] = [], mutations: string[] = [], streams = new Map<string, ServerResponse>()
const projections: ChatSsePayload[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', imageDataUrl = '', source = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const toolId = (sessionId: string, index: number): string => `${sessionId}-step-${index.toString().padStart(2, '0')}`
const ownedRun = (id: string): RootRun | undefined => titles.has(id) ? {
  schemaVersion: 1, runId: `${id}-root`, sessionId: id, turnId: `${id}-turn`, userMessageId: `${id}-user`,
  assistantMessageId: `${id}-answer`, seq: id === live ? 2 : 1, version: id === live ? 1 : 2, status: id === live ? 'running' : 'succeeded',
  pending: [], modelId: model, workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now + 38_000,
  startedAt: now, ...(id === live ? {} : { finishedAt: now + 38_000 })
} : undefined
const previousRun = (): RootRun => ({ ...ownedRun(live)!, runId: `${live}-previous-root`, turnId: `${live}-previous-turn`,
  userMessageId: `${live}-previous-user`, assistantMessageId: `${live}-previous-answer`, seq: 1, version: 2,
  status: 'succeeded', createdAt: now - 600_000, startedAt: now - 600_000, updatedAt: now - 570_000, finishedAt: now - 570_000 })

function history(id: string): EngineHistoryRow[] {
  const run = ownedRun(id)
  if (!run) return []
  const metadata = { rootRunId: run.runId, turnId: run.turnId }
  const row = (suffix: string, role: string, content: unknown, offset: number): EngineHistoryRow => ({
    id: `${id}-${suffix}`, role, content, createdAt: now + offset, conversationId: run.turnId, metadata
  })
  const rows: EngineHistoryRow[] = []
  if (id === live) {
    const previous = previousRun(), earlier = { rootRunId: previous.runId, turnId: previous.turnId }
    rows.push({ id: previous.userMessageId, role: 'user', content: '先保留完整的既有审阅记录。', createdAt: previous.createdAt,
      conversationId: previous.turnId, metadata: earlier },
    { id: previous.assistantMessageId, role: 'assistant', content: Array.from({ length: 32 }, (_, index) =>
      `EARLIER_REVIEW_${index}：既有检查记录保持完整，向上阅读时运行状态应只固定显示一份。`).join('\n\n'),
    createdAt: previous.finishedAt, conversationId: previous.turnId, metadata: earlier })
  }
  rows.push(row('user', 'user', titles.get(id), 0))
  for (let index = 0; index < 38; index++) {
    if (index === 0 || index === 13 || index === 36) rows.push({
      ...row(`note-${index}`, 'assistant', `${noteText}（阶段 ${index + 1}）`, index * 1000 + 1),
      ...(index === 0 ? { reasoningContent: 'PROCESS_LAYOUT_THINKING：先验证边界，再检查每个原始步骤。' } : {})
    })
    const wait = index >= 1 && index <= 6 || index >= 36
    const office = index >= 7 && index <= 12
    const image = index === 35
    const name = wait ? 'browser_wait' : office ? 'office_inspect' : image ? 'workbench_render' : 'read_file'
    const args = wait ? { url: 'https://example.test/review', timeout_ms: 1000 }
      : office ? { path: `${workspaceRoot}/delivery-review.docx` }
        : image ? { path: `${workspaceRoot}/delivery-review.pptx`, slide: 1 }
          : { path: `${workspaceRoot}/source-${index}.txt` }
    rows.push({ ...row(`call-${index}`, 'assistant', '', index * 1000 + 2), toolCall: { id: toolId(id, index), name, args } })
    if (id === live && index === 37) continue
    const output = image ? JSON.stringify({ type: 'image', mimeType: 'image/png', title: '文档检查完整画面', data: imageDataUrl.replace(/^data:image\/png;base64,/, '') })
      : `PROCESS_RECEIPT_${index.toString().padStart(2, '0')}：已完成该步骤，原始结果完整保留。`
    rows.push({ ...row(`result-${index}`, 'tool', output, index * 1000 + 3), toolCallId: toolId(id, index), success: true,
      metadata: { ...metadata, success: true } })
  }
  if (id === settled) rows.push({ ...row('answer', 'assistant', finalText, 38_000),
    metadata: { ...metadata, finalResult: { schemaVersion: 1, sessionId: id, turnId: run.turnId, runId: run.runId,
      assistantMessageId: run.assistantMessageId, text: finalText, publishedAt: now + 38_000, items: [] } } })
  return rows
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Process reading must not mutate: ${path}`)
  }
  const run = ownedRun(id), rows = history(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-layout-v1`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (id === live) {
      streams.set(id, response); response.flushHeaders()
      response.once('close', () => { if (streams.get(id) === response) streams.delete(id) })
    } else response.end('data: [DONE]\n\n')
    return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'9'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'process-layout-fixture' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '过程布局测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: id === live ? 'live' : 'persisted',
      eventId: id === live ? `${run!.runId}:${projections.length}` : null, finished: id !== live, history: rows,
      projection: id === live ? projections : [], run, runs: run ? id === live ? [previousRun(), run] : [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: id === live, finished: id !== live, run, lastEventId: id === live ? `${run!.runId}:${projections.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: run ? id === live ? [previousRun(), run] : [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: history(sessionId).length }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'process-layout-tenant', sessionId: id,
      namespace: { id: 'process-layout-db', generation: 'one' }, transport: {
        toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(run), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: `binding-${id}`, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const message = (): Locator => conversation().locator('.work-message--assistant[data-process-view="focused"]').filter({ has: page.locator('.work-message__process-toggle') })
const toggle = (): Locator => message().locator('.work-message__process-toggle')
const viewport = (): Locator => message().getByRole('region', { name: '执行过程', exact: true })
const receipt = (id: string, index: number): Locator => message().locator(`[data-work-tool-id="${toolId(id, index)}"]`)

async function selectTask(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设置', exact: true, includeHidden: true })).toHaveCount(0)
}
async function expectContainedReceipt(target: Locator): Promise<void> {
  await expect(target).toBeVisible()
  const bounds = await target.evaluate(element => {
    const row = element.getBoundingClientRect(), scroll = element.closest('.work-message__process-viewport')!.getBoundingClientRect()
    return { top: row.top - scroll.top, bottom: row.bottom - scroll.top, height: scroll.height }
  })
  expect(bounds.top).toBeGreaterThanOrEqual(-1)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1)
}

test.describe.serial('Work 展开过程阅读', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'process-layout-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    imageDataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 1440
      const context = canvas.getContext('2d'); if (!context) throw new Error('Fixture canvas unavailable')
      context.fillStyle = '#faf8f3'; context.fillRect(0, 0, 960, 1440)
      context.fillStyle = '#24344b'; context.font = '36px sans-serif'; context.fillText('DOCUMENT PREVIEW · 960 × 1440', 48, 90)
      context.fillStyle = '#ced7e4'; for (let index = 0; index < 12; index++) context.fillRect(48, 150 + index * 95, 864, 40)
      return canvas.toDataURL('image/png')
    })
    // A live snapshot replays the exact projection. History alone intentionally
    // marks unmatched calls unknown, so persist all real start/end frames here.
    const names = new Map<string, string>()
    for (const row of history(live).filter(row => row.metadata?.rootRunId === ownedRun(live)!.runId)) {
      if (row.role === 'user') projections.push({ userMessage: row })
      else if (row.role === 'assistant') {
        if (typeof row.reasoningContent === 'string') projections.push({ thinking: row.reasoningContent })
        if (typeof row.content === 'string' && row.content) projections.push({ content: row.content })
        if (row.toolCall?.id && row.toolCall.name) { names.set(row.toolCall.id, row.toolCall.name); projections.push({ toolStart: row.toolCall }) }
      } else if (typeof row.toolCallId === 'string') projections.push({ toolEnd: {
        id: row.toolCallId, name: names.get(row.toolCallId), output: row.content, success: row.success, finishedAt: row.createdAt
      } })
    }
    await page.evaluate(({ key, entries, selected, model, timestamp }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: entries.map(([id, title]) => ({ id, title, status: id === selected ? 'done' : 'running',
        draft: '', mentions: [], createdAt: timestamp, updatedAt: timestamp, workspacePath: '/remote/process-layout', modelId: model, attachments: [], sources: [] })), activeTaskId: selected }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), entries: [...titles], selected: settled, model, timestamp: now })
    await page.reload()
    await expect(work().getByRole('heading', { name: titles.get(settled)!, exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('work-process-layout-failure.png'); await page.screenshot({ path })
      await info.attach('展开过程失败窗口', { path, contentType: 'image/png' })
    }
    await info.attach('process-layout-fixture', { body: JSON.stringify({ errors, mutations, projections }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    for (const stream of streams.values()) stream.end('data: [DONE]\n\n')
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('process-layout-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('三十八步保持独立阅读，重复操作可完整展开，最终答复始终独立', async ({}, info) => {
    await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle()).toContainText('38 步')
    await expect(viewport()).toHaveCount(0)
    await expect(message().locator('.work-message__answer')).toContainText('PROCESS_LAYOUT_FINAL')
    await expect(message().locator('.work-message__answer')).not.toContainText('PROCESS_LAYOUT_NOTE')
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await toggle().click()
      await expect(viewport()).toBeVisible()
      const groups = viewport().locator('.work-activity-group')
      await expect(groups).toHaveCount(3)
      for (const group of await groups.all()) {
        const button = group.getByRole('button').first()
        await expect(button).toHaveAttribute('aria-expanded', 'false')
        await expect(button).toContainText(/\d+ 次/)
        await button.click(); await expect(button).toHaveAttribute('aria-expanded', 'true')
      }
      await expect(viewport().locator('[data-work-tool-id]')).toHaveCount(38)
      const ids = await viewport().locator('[data-work-tool-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-work-tool-id')))
      expect(ids).toEqual(Array.from({ length: 38 }, (_, index) => toolId(settled, index)))
      await expect(viewport().locator('.work-message__process-note')).toContainText([noteText, noteText, noteText])
      await expect(viewport().locator('img')).toHaveCount(0)
      await viewport().evaluate(element => { element.scrollTop = 0 })
      await toggle().scrollIntoViewIfNeeded()
      const initial = await viewport().evaluate(element => ({ scrollHeight: element.scrollHeight, height: element.clientHeight,
        outerTop: element.closest('.work-conversation__scroll')!.scrollTop, windowHeight: innerHeight,
        barTop: element.closest('.work-message')!.querySelector('.work-message__process-bar')!.getBoundingClientRect().top }))
      expect(initial.scrollHeight).toBeGreaterThan(initial.height + 100)
      expect(initial.height).toBeLessThanOrEqual(Math.min(400, initial.windowHeight * 0.48) + 1)
      await viewport().hover(); await page.mouse.wheel(0, 430)
      await expect.poll(() => viewport().evaluate(element => element.scrollTop)).toBeGreaterThan(100)
      const after = await viewport().evaluate(element => ({ outerTop: element.closest('.work-conversation__scroll')!.scrollTop,
        barTop: element.closest('.work-message')!.querySelector('.work-message__process-bar')!.getBoundingClientRect().top }))
      expect(Math.abs(after.outerTop - initial.outerTop)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.barTop - initial.barTop)).toBeLessThanOrEqual(1)
      // Latest-step navigation should preserve closed receipt choices. The
      // original operation remains available through its own explicit controls.
      await groups.last().getByRole('button').first().click()
      await message().getByRole('button', { name: '查看最新步骤', exact: true }).click()
      await expect(groups.last().getByRole('button').first()).toHaveAttribute('aria-expanded', 'false')
      await expectContainedReceipt(groups.last())
      await groups.last().getByRole('button').first().click()
      await expect(groups.last().getByRole('button').first()).toHaveAttribute('aria-expanded', 'true')
      const lastReceipt = receipt(settled, 37).locator('button.logline')
      if (await lastReceipt.getAttribute('aria-expanded') !== 'true') await lastReceipt.click()
      await expect(receipt(settled, 37).locator('button.logline')).toHaveAttribute('aria-expanded', 'true')
      await expect(receipt(settled, 37)).toContainText('PROCESS_RECEIPT_37')
      const preview = receipt(settled, 35), previewButton = preview.locator('button.logline')
      await expect(previewButton.locator('.logline__name')).toHaveText('检查幻灯片实际画面')
      await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
      await previewButton.click()
      await expect(preview.locator('img')).toHaveCount(1)
      await expect.poll(() => preview.locator('img').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth)).toBe(960)
      await expect(viewport()).toBeVisible()
      await previewButton.click(); await expect(preview.locator('img')).toHaveCount(0)
      await viewport().evaluate(element => { element.scrollTop = 0 })
      await toggle().scrollIntoViewIfNeeded()
      const path = info.outputPath(`work-process-focused-${appearance}.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`展开过程 ${appearance}`, { path, contentType: 'image/png' })
      // Reset only user choices made above before checking the second theme.
      for (const group of await groups.all()) if (await group.getByRole('button').first().getAttribute('aria-expanded') === 'true') await group.getByRole('button').first().click()
      await toggle().click(); await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      await expect(viewport()).toHaveCount(0)
      await expect(message().locator('.work-message__answer')).toContainText('正文只保留交付结论')
    }
  })

  test('运行时大图保持收起，活动定位可重复进入且不锁住用户的收起选择', async ({}, info) => {
    await selectTask(live)
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => streams.has(live)).toBe(true)
    const outer = conversation().locator('.work-conversation__scroll'), feedback = conversation().locator('.work-turn-feedback')
    await outer.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(feedback).toHaveAttribute('data-current-run-feedback', 'true')
    await expect(conversation().locator('.work-run-status')).toHaveCount(0)
    await expect(feedback.getByRole('button', { name: '停止任务', exact: true })).toBeEnabled()
    await expect(feedback.locator('.work-turn-feedback__elapsed')).toContainText(/秒|分/)
    await outer.evaluate(element => { element.scrollTop = 0 })
    await expect(conversation().locator('.work-run-status')).toHaveCount(1)
    await expect(conversation().locator('[data-current-run-feedback="true"]')).toHaveCount(1)
    await conversation().getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(feedback).toHaveAttribute('data-current-run-feedback', 'true')
    await expect(conversation().locator('.work-run-status')).toHaveCount(0)
    const preview = receipt(live, 35), previewButton = preview.locator('button.logline')
    await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
    await expect(preview.locator('img')).toHaveCount(0)
    await previewButton.click(); await expect(preview.locator('img')).toHaveCount(1)
    await previewButton.click(); await expect(preview.locator('img')).toHaveCount(0)
    for (let attempt = 0; attempt < 2; attempt++) {
      await toggle().click(); await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
      await conversation().getByRole('button', { name: '查看正在执行的活动', exact: true }).click()
      await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
      await expect(receipt(live, 37)).toBeFocused()
      await expectContainedReceipt(receipt(live, 37))
    }
    await toggle().click(); await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    for (const payload of [
      { content: 'PROCESS_STREAM_TICK：仍在等待页面状态。' },
      { toolStart: { id: toolId(live, 37), name: 'browser_wait', args: { url: 'https://process-stream-tick.example.test/review', timeout_ms: 1000 } } }
    ] satisfies ChatSsePayload[]) {
      projections.push(payload)
      streams.get(live)!.write(`id: ${ownedRun(live)!.runId}:${projections.length}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    // The updated target confirms the later frame was applied before checking
    // that the earlier reveal revision did not override the user's collapse.
    await expect(conversation().getByRole('button', { name: '查看正在执行的活动', exact: true })).toContainText('process-stream-tick.example.test')
    await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await toggle().click()
    await expect(viewport()).toContainText('PROCESS_STREAM_TICK')
    await expect(previewButton).toHaveAttribute('aria-expanded', 'false')
    const path = info.outputPath('work-process-focused-running.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('运行中的过程阅读', { path, contentType: 'image/png' })
  })
})
