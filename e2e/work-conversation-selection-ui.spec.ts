/** Real Electron Work selection: native checkbox keyboard/mixed states, exact
 * selected-turn clipboard text, actual Markdown downloads, body hit targets,
 * and compact selection chrome in narrow light/dark windows. Three complete
 * authenticated history turns; no model calls or conversation mutations. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-selection-fixture-token', sessionId = 'work-conversation-selection', modelId = 'work-selection-model'
const title = '完整对话多选核对', remoteRoot = '/remote/selection-fixture', now = Date.now() - 30_000
const prompts = ['SELECT_REQUEST_1：确认第一项方案。', 'SELECT_REQUEST_2：读取备注并核对第二项方案。',
  'SELECT_REQUEST_3：整理第三项的完整长篇说明，保留所有细节用于复核。']
const answers = ['SELECT_ANSWER_1：第一项方案已确认。', 'SELECT_ANSWER_2：备注读取完成，第二项结论已确认。',
  Array.from({ length: 8 }, (_, index) => `SELECT_LONG_3_${index + 1}：这是第三轮保留的完整说明。勾选时正文仍按原来的阅读布局显示，不能整轮铺满选中色或绘制大边框。`).join('\n\n')]
const processSource = Array.from({ length: 18 }, (_, index) => `PROCESS_SOURCE_${index + 1}：本次读取的原始备注。`).join('\n')
const runs: RootRun[] = prompts.map((_, index) => ({ schemaVersion: 1, sessionId, runId: `selection-run-${index + 1}`,
  turnId: `selection-turn-${index + 1}`, userMessageId: `selection-user-${index + 1}`, assistantMessageId: `selection-answer-${index + 1}`,
  seq: index + 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [],
  createdAt: now + index * 1000, updatedAt: now + index * 1000 + 20, finishedAt: now + index * 1000 + 20 }))
const rows: EngineHistoryRow[] = runs.flatMap((run, index) => {
  const metadata = { rootRunId: run.runId, turnId: run.turnId }, conversationId = run.turnId
  const messages: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: prompts[index], createdAt: run.createdAt, conversationId, metadata }]
  if (index === 1) messages.push(
    { id: 'selection-call', role: 'assistant', content: '', createdAt: run.createdAt + 1, conversationId, metadata,
      toolCall: { id: 'selection-read', name: 'read_file', args: { path: `${remoteRoot}/notes.txt` } } },
    { id: 'selection-result', role: 'tool', toolCallId: 'selection-read', content: processSource, success: true,
      createdAt: run.createdAt + 2, conversationId, metadata: { ...metadata, success: true } })
  messages.push({ id: run.assistantMessageId, role: 'assistant', content: answers[index], createdAt: run.updatedAt, conversationId, metadata })
  return messages
})
const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', downloadPath = ''
let originalClipboard: { text: string; html: string; rtf: string; imageDataUrl: string } | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Conversation selection must not mutate: ${path}`)
  }
  const history = id === sessionId ? rows : [], matching = id === sessionId ? runs : [], current = matching.at(-1)
  if (path === '/api/v1/conversation/display') {
    const users = history.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: history,
      loadedTurnIds: users.map(row => row.id), revision: 'selection-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'selection-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '多选核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history, projection: [], run: current, runs: matching, subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching }
    : path === '/api/v1/conversation/history' ? history
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: runs.at(-1)!.updatedAt, messageCount: rows.length }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'selection-fixture', sessionId: id,
      namespace: { id: 'selection-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const toolbar = (): Locator => conversation().getByRole('toolbar', { name: '对话选择工具栏', exact: true })
const checkbox = (index: number): Locator => conversation().getByRole('checkbox', { name: `选择第 ${index + 1} 轮对话`, exact: true })
const turn = (index: number): Locator => conversation().locator('.work-conversation-turn').filter({ has: page.locator(`[data-message-id="${runs[index].userMessageId}"]`) })
const all = (): Locator => toolbar().getByRole('checkbox', { name: '全选对话', exact: true })
const action = (name: string): Locator => toolbar().getByRole('button', { name, exact: true })
const normalize = (text: string): string => text.replace(/\r\n/g, '\n')

async function beginSelection(): Promise<void> {
  if (await toolbar().isVisible()) await action('完成').click()
  await expect(toolbar()).toHaveCount(0)
  await work().getByRole('button', { name: '任务更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '选择对话', exact: true }).click()
  await expect(toolbar()).toBeVisible()
  await expect(toolbar()).toContainText('已选 0 轮')
  for (let index = 0; index < 3; index++) await expect(checkbox(index)).not.toBeChecked()
}

async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}

async function settleLayout(width?: number, height?: number): Promise<void> {
  let previous = ''
  await expect.poll(async () => {
    const layout = await conversation().evaluate(element => ({ width: innerWidth, height: innerHeight,
      animating: document.getAnimations().some(animation => (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().endTime !== Infinity),
      geometry: JSON.stringify([element, ...element.querySelectorAll('.work-conversation__select-bar, .work-conversation-turn__header')].map(item => {
        const rect = item.getBoundingClientRect(); return [rect.left, rect.top, rect.width, rect.height]
      })) }))
    const stable = previous === layout.geometry; previous = layout.geometry
    return stable && !layout.animating && (width === undefined || layout.width === width) && (height === undefined || layout.height === height)
  }, { message: 'Wait for selection layout and viewport to settle' }).toBe(true)
}

async function bodyDecoration(index: number): Promise<Record<string, string>> {
  return turn(index).evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow, outline: style.outlineWidth }
  })
}

test.describe.serial('Work 对话多选', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'selection-profile-'))
    const downloads = join(fixture, 'downloads'); mkdirSync(downloads); downloadPath = join(downloads, 'selected-conversation.md')
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: remoteRoot, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    originalClipboard = await app.evaluate(({ clipboard }) => {
      const image = clipboard.readImage()
      return { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), imageDataUrl: image.isEmpty() ? '' : image.toDataURL() }
    })
    await app.evaluate(({ BrowserWindow, session }, destination) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(1440, 1000); window.show(); window.focus()
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(destination))
    }, downloadPath)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
        updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(conversation().locator('.work-conversation-turn')).toHaveCount(3)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot('selection-failure', info)
    await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try {
      try {
        if (app && originalClipboard) await app.evaluate(({ clipboard, nativeImage }, saved) => {
          clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
            ...(saved.imageDataUrl ? { image: nativeImage.createFromDataURL(saved.imageDataUrl) } : {}) })
        }, originalClipboard)
      } finally { await app?.close() }
    } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('selection-profile-')) throw new Error('Unsafe selection fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('原生复选框支持键盘和部分全选，正文与摘要点击不改变选择', async () => {
    await beginSelection()
    await expect(action('复制')).toBeDisabled(); await expect(action('导出')).toBeDisabled()
    await expect(all()).toHaveAttribute('type', 'checkbox')
    await expect(checkbox(0)).toHaveAttribute('type', 'checkbox')
    await checkbox(0).focus(); await page.keyboard.press('Space')
    await expect(checkbox(0)).toBeChecked(); await expect(toolbar()).toContainText('已选 1 轮')
    await expect.poll(() => all().evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true)
    await expect(action('复制')).toBeEnabled(); await expect(action('导出')).toBeEnabled()
    await all().focus(); await page.keyboard.press('Tab'); await expect(action('复制')).toBeFocused()
    await page.keyboard.press('Shift+Tab'); await expect(all()).toBeFocused(); await page.keyboard.press('Space')
    await expect(all()).toBeChecked(); await expect(toolbar()).toContainText('已选 3 轮')
    await expect.poll(() => all().evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(false)
    for (let index = 0; index < 3; index++) await expect(checkbox(index)).toBeChecked()
    await page.keyboard.press('Space'); await expect(toolbar()).toContainText('已选 0 轮')
    for (let index = 0; index < 3; index++) await expect(checkbox(index)).not.toBeChecked()
    await turn(0).locator('.work-conversation-turn__summary').click()
    await turn(0).getByText(answers[0], { exact: true }).click()
    await expect(checkbox(0)).not.toBeChecked(); await expect(toolbar()).toContainText('已选 0 轮')
    await turn(0).locator('.work-conversation-turn__pick').getByText('第 1 轮', { exact: true }).click()
    await expect(checkbox(0)).toBeChecked()
    const process = turn(1).locator('.work-message__process-toggle')
    if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
    const receipt = turn(1).locator('[data-work-tool-id="selection-read"] button.logline')
    if (await receipt.getAttribute('aria-expanded') !== 'true') await receipt.click()
    await expect(turn(1).locator('.logline__detail')).toContainText('PROCESS_SOURCE_18')
    await expect(checkbox(1)).not.toBeChecked()
    await action('完成').focus(); await page.keyboard.press('Escape')
    await expect(toolbar()).toHaveCount(0)
    await beginSelection(); await expect(action('复制')).toBeDisabled()
    await action('完成').click(); await expect(toolbar()).toHaveCount(0)
  })

  test('复制只包含勾选的完整轮次并写入真实剪贴板', async () => {
    await beginSelection(); await checkbox(0).check(); await checkbox(2).check()
    await app!.evaluate(({ clipboard }) => clipboard.writeText('SELECTION_CLIPBOARD_SENTINEL'))
    await action('复制').click()
    const expected = [0, 2].flatMap(index => [`## 用户\n\n${prompts[index]}`, `## Agent\n\n${answers[index]}`]).join('\n\n---\n\n')
    await expect.poll(async () => normalize(await app!.evaluate(({ clipboard }) => clipboard.readText()))).toBe(expected)
    await expect(toolbar()).toHaveCount(0)
    const text = normalize(await app!.evaluate(({ clipboard }) => clipboard.readText()))
    expect(text).not.toContain(prompts[1]); expect(text).not.toContain(answers[1]); expect(text).not.toContain('PROCESS_SOURCE_')
  })

  test('导出实际Markdown文件保留所选轮次和工具信息，且不退出选择', async () => {
    await beginSelection(); await checkbox(1).check()
    expect(existsSync(downloadPath)).toBe(false)
    await action('导出').click()
    await expect.poll(() => existsSync(downloadPath) ? normalize(readFileSync(downloadPath, 'utf8')) : '').toContain(answers[1])
    const exported = normalize(readFileSync(downloadPath, 'utf8'))
    expect(exported).toContain(`## 用户\n\n${prompts[1]}`); expect(exported).toContain('## Agent')
    expect(exported).toContain('**工具调用**'); expect(exported).toContain('notes.txt')
    expect(exported).not.toContain(prompts[0]); expect(exported).not.toContain(answers[0]); expect(exported).not.toContain('SELECT_LONG_3_')
    await expect(toolbar()).toBeVisible(); await expect(checkbox(1)).toBeChecked(); await expect(toolbar()).toContainText('已选 1 轮')
    // Copy and download must preserve the same complete selection, including
    // hidden process records; compare their real external results.
    await action('复制').click()
    await expect.poll(async () => normalize(await app!.evaluate(({ clipboard }) => clipboard.readText()))).toBe(exported)
    await expect(toolbar()).toHaveCount(0)
  })

  test('760和560窄窗深浅色保持紧凑工具栏，选中只标记轮次头部', async ({}, info) => {
    for (const width of [760, 560]) for (const appearance of ['light', 'dark']) {
      await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1000), width)
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), appearance)
      await beginSelection(); await settleLayout(width, 1000)
      const before = await bodyDecoration(2), header = turn(2).locator('.work-conversation-turn__header')
      const headerBefore = await header.evaluate(element => getComputedStyle(element).backgroundColor)
      await checkbox(2).check(); await settleLayout(width, 1000)
      expect(await bodyDecoration(2)).toEqual(before)
      await expect(header).not.toHaveCSS('background-color', headerBefore)
      await expect(toolbar().locator('.work-conversation__selection-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(toolbar()).toContainText('已选 1 轮')
      await checkbox(2).scrollIntoViewIfNeeded(); await settleLayout(width, 1000)
      const geometry = await conversation().evaluate(element => {
        const toolbar = element.querySelector('.work-conversation__select-bar')!, header = element.querySelector('.work-conversation-turn.is-selected .work-conversation-turn__header')!
        const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height } }
        return { width: innerWidth, toolbar: rect(toolbar), header: rect(header), overflow: toolbar.scrollWidth - toolbar.clientWidth,
          controls: [...toolbar.querySelectorAll('button, input')].map(rect) }
      })
      expect(geometry.toolbar.height).toBeLessThanOrEqual(48); expect(geometry.header.height).toBeLessThanOrEqual(36)
      expect(geometry.overflow).toBeLessThanOrEqual(1)
      for (const control of geometry.controls) {
        expect(control.left).toBeGreaterThanOrEqual(geometry.toolbar.left); expect(control.right).toBeLessThanOrEqual(geometry.toolbar.right + 1)
        expect(control.top).toBeGreaterThanOrEqual(geometry.toolbar.top); expect(control.bottom).toBeLessThanOrEqual(geometry.toolbar.bottom + 1)
      }
      expect(geometry.header.left).toBeGreaterThanOrEqual(0); expect(geometry.header.right).toBeLessThanOrEqual(geometry.width)
      await screenshot(`selection-${appearance}-${width}`, info)
      await action('完成').click(); await expect(toolbar()).toHaveCount(0)
    }
  })
})
