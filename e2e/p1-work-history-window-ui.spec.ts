/** Current P1 Work history acceptance, independent of legacy conversation
 * suites: 540 persisted messages, bounded 180-message browsing, bidirectional
 * paging, draft durability, and real held SSE while an older page is read. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..')
const fixtureRoot = resolve(root, '.e2e-tmp')
const sessionId = 'work-p1-long-history'
const modelId = 'p1-long-history-model'
const token = 'p1-long-history-synthetic-token'
const historySize = 540
const pageSize = 60
const renderLimit = 180
let app: ElectronApplication | undefined
let page: Page
let fixture = ''
let remoteUrl = ''
let storageKey = ''
let heldStream: ServerResponse | undefined
let activeRun: RootRun | undefined
let sequence = 0
let output = ''
const errors: string[] = []
const sentBodies: Record<string, unknown>[] = []
const projection: ChatSsePayload[] = []
const history: EngineHistoryRow[] = Array.from({ length: historySize }, (_, index) => ({
  id: `p1-history-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  conversationId: `p1-history-turn-${Math.floor(index / 2)}`,
  content: `P1_HISTORY_MESSAGE_${index}\n\n这是第 ${index + 1} 条已完成消息，历史翻页与实时输出必须保持独立。`,
  modelId,
  createdAt: 1_700_000_000_000 + index
}))

const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data, timestamp: Date.now() })
function frame(payload: ChatSsePayload): void {
  if (!activeRun || !heldStream || heldStream.writableEnded) throw new Error('P1 held stream is not open')
  if (typeof payload.content === 'string') output += payload.content
  projection.push(payload)
  heldStream.write(`id: ${activeRun.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null))
      return
    }
    // Negotiate the supported legacy contract explicitly; an empty successful
    // capability response would be a protocol error in the current client.
    if (path === '/api/v1/subagent/capabilities') {
      response.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 40400, data: null, message: 'Not provided by this peer' }))
      return
    }
    let raw = ''
    for await (const part of request) raw += part.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>
      sentBodies.push(body)
      const now = Date.now()
      activeRun = { schemaVersion: 1, runId: 'p1-live-history-run', sessionId,
        turnId: 'p1-live-history-turn', userMessageId: 'p1-live-history-user',
        assistantMessageId: 'p1-live-history-assistant', seq: 1, version: 1,
        status: 'running', modelId, pending: [], createdAt: now, updatedAt: now }
      const user: EngineHistoryRow = { id: activeRun.userMessageId, role: 'user',
        conversationId: activeRun.turnId, content: String(body.message), createdAt: now }
      history.push(user)
      sequence = 0
      output = ''
      projection.length = 0
      heldStream = response
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      frame({ run: activeRun })
      frame({ userMessage: user })
      frame({ content: 'P1_LIVE_TAIL_START\n\n实时任务正在持续输出。' })
      return
    }
    const id = url.searchParams.get('sessionId') || ''
    const ownSession = id === sessionId
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1,
        toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'p1-long-history-peer' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'P1 history model',
        isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200_000 } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id,
        source: ownSession && activeRun?.status === 'running' ? 'live' : 'persisted',
        eventId: ownSession && activeRun ? `${activeRun.runId}:${sequence}` : null,
        finished: !ownSession || activeRun?.status !== 'running',
        projection: ownSession ? projection : [], history: ownSession ? history : [],
        run: ownSession ? activeRun : undefined, runs: ownSession && activeRun ? [activeRun] : [],
        todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/runs' ? { runs: ownSession && activeRun ? [activeRun] : [] }
      : path === '/api/v1/chat/status' ? { running: ownSession && activeRun?.status === 'running',
        finished: !ownSession || activeRun?.status !== 'running', run: ownSession ? activeRun : undefined }
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: 'P1 长历史任务', lastAt: Date.now(), messageCount: history.length }]
      : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/p1-history', entries: [] }
      : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/p1-history' }
      : []
    response.writeHead(200, { 'content-type': 'application/json' }).end(envelope(data))
  })().catch(error => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

const conversation = (): Locator => page.getByRole('region', { name: '协作对话', exact: true })
const messages = (): Locator => conversation().locator('.work-message')
const content = (): Locator => conversation().locator('.work-conversation__content')
const scroll = (): Locator => conversation().locator('.work-conversation__scroll')
const composer = (): Locator => conversation().getByRole('textbox', { name: '继续对话', exact: true })

async function historyRange(): Promise<{ start: number; end: number; count: number }> {
  return content().evaluate(element => ({ start: Number(element.getAttribute('data-history-start')),
    end: Number(element.getAttribute('data-history-end')), count: element.querySelectorAll('.work-message').length }))
}

async function expectRange(start: number, end: number): Promise<void> {
  await expect(content()).toHaveAttribute('data-history-start', String(start))
  await expect(content()).toHaveAttribute('data-history-end', String(end))
  await expect(messages()).toHaveCount(end - start)
  expect(end - start).toBeLessThanOrEqual(renderLimit)
  const firstId = start < historySize ? `p1-history-${start}` : 'p1-live-history-user'
  await expect(messages().first()).toHaveAttribute('data-message-id', firstId)
}

async function persistedDraft(): Promise<string> {
  return page.evaluate(({ key, id }) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}') as { tasks?: Array<{ id: string; draft: string }> }
    return state.tasks?.find(task => task.id === id)?.draft || ''
  }, { key: storageKey, id: sessionId })
}

test.describe.serial('P1 Work 长历史固定渲染窗口', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('P1 peer has no TCP address')
    remoteUrl = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent('remote:' + remoteUrl)
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'p1-work-history-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl,
      autoStartEngine: true, lastModelId: modelId, lastFolder: '', appearance: 'light' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token } })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 45_000 }).toBe('ready')
    await page.evaluate(({ key, sessionId, modelId }) => {
      const now = Date.now()
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title: 'P1 长历史任务',
        draft: '', status: 'done', createdAt: now, updatedAt: now, workspacePath: null, modelId,
        attachments: [], sources: [], mentions: [], resources: { skills: [], mcpServers: [], knowledgeBases: [] } }],
      activeTaskId: sessionId, homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: modelId,
      homeSessionId: 'work-p1-history-home', homeAgentId: '', homeMentions: [],
      homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
      localStorage.setItem('aether.app.mode', 'work')
    }, { key: storageKey, sessionId, modelId })
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(conversation()).toBeVisible()
    await expectRange(historySize - pageSize, historySize)
    await expect(composer()).toBeEditable()
  })

  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    heldStream?.destroy()
    try { await app?.close() }
    finally {
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      const target = resolve(fixture)
      if (fixture && target.startsWith(fixtureRoot + '\\') && target.split(/[\\/]/).at(-1)?.startsWith('p1-work-history-'))
        rmSync(target, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('540 条历史连续双向翻页，DOM 固定上限且草稿保留', async ({}, testInfo) => {
    const draft = 'P1_DRAFT_SURVIVES_ALL_HISTORY_PAGES'
    await composer().fill(draft)
    await expect.poll(persistedDraft).toBe(draft)
    // Repeated navigation must move the window instead of continually adding
    // rows. This passes the third page and reaches the first persisted record.
    for (let start = historySize - 2 * pageSize; start >= 0; start -= pageSize) {
      await conversation().getByRole('button', { name: /^查看更早消息/ }).click()
      await expectRange(start, Math.min(historySize, start + renderLimit))
      await expect(composer()).toHaveText(draft)
    }
    await expect(messages().first()).toContainText('P1_HISTORY_MESSAGE_0')
    await expect(conversation().getByRole('button', { name: /^查看更早消息/ })).toHaveCount(0)
    for (let start = pageSize; start <= historySize - renderLimit; start += pageSize) {
      await conversation().getByRole('button', { name: /^查看较新消息/ }).click()
      await expectRange(start, Math.min(historySize, start + renderLimit))
      await expect(composer()).toHaveText(draft)
    }
    await conversation().getByRole('button', { name: '回到最新', exact: true }).click()
    await expectRange(historySize - pageSize, historySize)
    await expect(messages().last()).toContainText(`P1_HISTORY_MESSAGE_${historySize - 1}`)
    await expect.poll(() => scroll().evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2)
    await expect(composer()).toHaveText(draft)
    await expect.poll(persistedDraft).toBe(draft)
    await page.screenshot({ path: testInfo.outputPath('p1-history-latest-540.png'), fullPage: true })
  })

  test('阅读旧窗口时连续 SSE 追加不扩展 DOM、不跳走、不清掉未发送草稿', async ({}, testInfo) => {
    await composer().fill('P1_START_REAL_HELD_STREAM')
    const send = conversation().getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => sentBodies.length).toBe(1)
    await expect(messages().last()).toContainText('P1_LIVE_TAIL_START')
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    const draft = 'P1_UNSENT_DRAFT_WHILE_READING_AND_STREAMING'
    await composer().fill(draft)
    await expect.poll(persistedDraft).toBe(draft)
    // Four older pages place the running assistant beyond the mounted window.
    for (let index = 0; index < 4; index += 1)
      await conversation().getByRole('button', { name: /^查看更早消息/ }).click()
    const before = await historyRange()
    expect(before.count).toBe(renderLimit)
    expect(before.end).toBeLessThan(historySize)
    await messages().nth(12).evaluate(element => element.scrollIntoView({ block: 'start' }))
    const anchor = await messages().nth(12).getAttribute('data-message-id')
    if (!anchor) throw new Error('P1 reading anchor has no message identity')
    const initial = await scroll().evaluate((element, id) => {
      const message = element.querySelector(`[data-message-id="${id}"]`)
      if (!message) throw new Error('P1 reading anchor is missing')
      return { top: element.scrollTop, anchorTop: message.getBoundingClientRect().top }
    }, anchor)
    await page.evaluate(() => {
      const target = window as Window & { __p1HistoryFrames?: number; __p1HistoryOff?: () => void }
      target.__p1HistoryFrames = 0
      target.__p1HistoryOff = window.aether.engine.onStreamEvent(event => {
        if (event.type === 'payload' && event.payload.content?.includes('P1_LIVE_APPEND_'))
          target.__p1HistoryFrames = (target.__p1HistoryFrames || 0) + 1
      })
    })
    for (let group = 0; group < 6; group += 1) {
      for (let index = group * 4; index < group * 4 + 4; index += 1)
        frame({ content: `\n\nP1_LIVE_APPEND_${index}: ${'实时输出持续进行，历史阅读不应被打断。'.repeat(8)}` })
      await expect.poll(() => page.evaluate(() => (window as Window & { __p1HistoryFrames?: number }).__p1HistoryFrames)).toBe((group + 1) * 4)
      // Wait for committed layout, not a fixed elapsed delay. All six batches
      // must preserve the same old message ids and physical reading position.
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      expect(await historyRange()).toEqual(before)
      const current = await scroll().evaluate((element, id) => ({ top: element.scrollTop,
        anchorTop: element.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect().top ?? null }), anchor)
      expect(current.anchorTop).not.toBeNull()
      expect(Math.abs(current.top - initial.top)).toBeLessThanOrEqual(2)
      expect(Math.abs(current.anchorTop! - initial.anchorTop)).toBeLessThanOrEqual(2)
      await expect(composer()).toHaveText(draft)
    }
    activeRun = { ...activeRun!, status: 'succeeded', version: activeRun!.version + 1,
      seq: sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
    history.push({ id: activeRun.assistantMessageId, role: 'assistant', conversationId: activeRun.turnId,
      content: output, modelId, createdAt: Date.now() })
    frame({ run: activeRun })
    heldStream!.end('data: [DONE]\n\n')
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    await expect(conversation().getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    expect(await historyRange()).toEqual(before)
    await expect(composer()).toHaveText(draft)
    await conversation().getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(messages()).toHaveCount(pageSize)
    await expect(messages().last()).toContainText('P1_LIVE_APPEND_23')
    await expect.poll(() => scroll().evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2)
    await expect.poll(persistedDraft).toBe(draft)
    await page.evaluate(() => (window as Window & { __p1HistoryOff?: () => void }).__p1HistoryOff?.())
    await page.screenshot({ path: testInfo.outputPath('p1-history-stream-return-latest.png'), fullPage: true })
  })
})
