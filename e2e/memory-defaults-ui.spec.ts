/** Real Electron + isolated HTTP/disk fixture: default-off memory preferences,
 * Code/Work session overrides, nested preference menus and responsive layout.
 * Reset and renderer reload retain their disk/HTTP checks. No model calls.
 * This verifies the client contract; engine default/storage tests remain separate.
 * AETHER_E2E_APP_ENTRY selects an independently built application snapshot. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const codeId = 'memory-default-code', sessionId = 'work-memory-default', modelId = 'memory-ui-fixture'
const token = 'disposable-memory-ui-token', remoteRoot = '/remote/memory-ui', now = Date.now() - 1000
const titles = new Map([[codeId, 'Code 记忆默认测试'], [sessionId, 'Work 记忆默认测试']])
type MemoryDisk = { globalEnabled: boolean; sessionDefaultEnabled: boolean; overrides: Record<string, boolean | null> }
const initial: MemoryDisk = { globalEnabled: false, sessionDefaultEnabled: false, overrides: {} }
const errors: string[] = [], forbidden: string[] = [], writes: Array<{ path: string; body: Record<string, unknown> }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', stateFile = ''
let holdPreferences = true
const heldPreferences: ServerResponse[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const disk = (): MemoryDisk => JSON.parse(readFileSync(stateFile, 'utf8'))
function settings(id: string) {
  const state = disk(), sessionOverride = state.overrides[id] ?? null
  const sessionEnabled = sessionOverride ?? state.sessionDefaultEnabled
  const effectiveScopes = [...(state.globalEnabled ? ['global'] : []), ...(sessionEnabled ? ['session'] : [])]
  const scope = sessionEnabled ? 'session' : state.globalEnabled ? 'global' : 'off'
  return { sessionId: id, memoryScope: scope, effectiveScope: scope, enabled: true,
    globalEnabled: state.globalEnabled, sessionDefaultEnabled: state.sessionDefaultEnabled,
    sessionOverride, sessionEnabled, effectiveScopes }
}
function preferences() { const { overrides: _overrides, ...value } = disk(); return { ...value, enabled: true } }
function releasePreferences(): void {
  holdPreferences = false
  for (const response of heldPreferences.splice(0)) if (!response.destroyed) response.end(envelope(preferences()))
}
const run = (id: string): RootRun | undefined => titles.has(id) ? {
  schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`,
  assistantMessageId: `assistant-${id}`, seq: 1, version: 2, status: 'succeeded', modelId,
  pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now
} : undefined
const history = (id: string) => titles.has(id) ? [
  { id: `user-${id}`, role: 'user', content: titles.get(id), createdAt: now, conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } },
  { id: `assistant-${id}`, role: 'assistant', content: '已有聊天历史仍然保留。', createdAt: now + 1, conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } }
] : []

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Unauthenticated fixture request')
  if (path === '/api/v1/memory/preferences') {
    if (request.method === 'PUT') {
      if (!Object.keys(body).length || Object.keys(body).some(key => !['globalEnabled', 'sessionDefaultEnabled'].includes(key) || typeof body[key] !== 'boolean')) throw new Error('Invalid preference patch')
      writeFileSync(stateFile, JSON.stringify({ ...disk(), ...body })); writes.push({ path, body })
    } else if (request.method !== 'GET') throw new Error('Unexpected preferences method')
    if (request.method === 'GET' && holdPreferences) { heldPreferences.push(response); return }
    response.end(envelope(preferences())); return
  }
  if (path === '/api/v1/memory/settings') {
    if (request.method === 'PUT') {
      if (!titles.has(String(body.sessionId)) || ![true, false, null].includes(body.sessionEnabled as boolean | null)
        || Object.keys(body).sort().join(',') !== 'sessionEnabled,sessionId') throw new Error('Invalid session memory mutation')
      const state = disk(); state.overrides[String(body.sessionId)] = body.sessionEnabled as boolean | null
      writeFileSync(stateFile, JSON.stringify(state)); writes.push({ path, body })
      response.end(envelope(settings(String(body.sessionId)))); return
    }
    response.end(envelope(settings(id))); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: remoteRoot })); return }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Memory UI must not execute tasks: ${path}`) }
  const rows = history(id), current = run(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-stable`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'memory-ui-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '不调用的测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'memory-fixture', sessionId: id,
      namespace: { id: 'memory-fixture-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(current), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Memory fixture request failed') }) })

async function selectMode(mode: 'work'): Promise<Locator> {
  const surface = page.locator('.work-view')
  await expect(surface.getByRole('button', { name: '对话偏好', exact: true })).toBeEnabled()
  return surface
}
async function openPreference(mode: 'work', label = '跟随默认 · 关闭'): Promise<Locator> {
  const surface = await selectMode(mode)
  await surface.getByRole('button', { name: '对话偏好', exact: true }).click()
  const choice = page.getByRole('button', { name: `本会话记忆：${label}`, exact: true })
  await expect(choice).toBeEnabled(); return choice
}
async function closePreference(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer-options-panel')).toHaveCount(0)
}
async function settingsDialog(): Promise<Locator> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '记忆', exact: true }).click(); return dialog
}
async function reload(): Promise<void> {
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '外观', exact: true }).click()
  await dialog.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
const preferencePanel = (): Locator => page.getByRole('dialog', { name: '对话偏好', exact: true })
const preferenceRow = (label: string): Locator => preferencePanel().locator('.composer-options__settings > .composer-options__row')
  .filter({ has: page.getByText(label, { exact: true }) })

test.describe.serial('记忆默认关闭与明确开启', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'memory-defaults-profile-'))
    stateFile = join(fixture, 'memory-fixture.json'); writeFileSync(stateFile, JSON.stringify(initial))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: remoteRoot,
      autoStartEngine: true, lastSessionId: sessionId, lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 960); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, now, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId, homeDraft: '' }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title: titles.get(sessionId)!, now, modelId })
    await reload()
    await expect(page.locator('.work-view')).toContainText('已有聊天历史仍然保留。')
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('memory-ui.png'); await page.screenshot({ path }); await info.attach('memory-ui', { path, contentType: 'image/png' })
    }
    await info.attach('memory-http-and-disk', { body: JSON.stringify({ writes, disk: stateFile ? disk() : null, errors, forbidden }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(forbidden).toEqual([])
  })
  test.afterAll(async () => {
    releasePreferences()
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtures || !basename(target).startsWith('memory-defaults-profile-')) throw new Error('Unsafe memory fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('Work 跟随默认关闭，打开偏好不会写设置或删除历史', async () => {
    for (const mode of ['work'] as const) {
      const choice = await openPreference(mode); await choice.click()
      await expect(page.getByRole('menuitem', { name: /^恢复默认/ })).toHaveAttribute('aria-current', 'true')
      await expect(page.getByRole('menuitem', { name: /^恢复默认/ })).toContainText('跟随默认关闭')
      await page.keyboard.press('Escape'); await closePreference()
      await expect(page.locator('.work-view')).toContainText('已有聊天历史仍然保留。')
    }
    expect(writes).toEqual([]); expect(disk()).toEqual(initial)
  })

  test('设置页未确认时也不闪现开启；全局与会话默认可显式开启再关闭并保持', async () => {
    const dialog = await settingsDialog()
    const global = dialog.getByRole('switch', { name: '全局记忆', exact: true })
    const session = dialog.getByRole('switch', { name: /会话记忆/ })
    await expect.poll(() => heldPreferences.length).toBeGreaterThan(0)
    for (const toggle of [global, session]) { await expect(toggle).toHaveAttribute('aria-checked', 'false'); await expect(toggle).toBeDisabled() }
    releasePreferences()
    for (const toggle of [global, session]) await expect(toggle).toBeEnabled()
    for (const [toggle, field] of [[global, 'globalEnabled'], [session, 'sessionDefaultEnabled']] as const) {
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => disk()[field]).toBe(true)
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect.poll(() => disk()[field]).toBe(false)
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await reload()
    const restored = await settingsDialog()
    await expect(restored.getByRole('switch', { name: '全局记忆', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(restored.getByRole('switch', { name: /会话记忆/ })).toHaveAttribute('aria-checked', 'false')
    await restored.getByRole('button', { name: '关闭', exact: true }).click()
    expect(writes).toEqual([
      { path: '/api/v1/memory/preferences', body: { globalEnabled: true } },
      { path: '/api/v1/memory/preferences', body: { globalEnabled: false } },
      { path: '/api/v1/memory/preferences', body: { sessionDefaultEnabled: true } },
      { path: '/api/v1/memory/preferences', body: { sessionDefaultEnabled: false } }
    ])
  })

  for (const mode of ['work'] as const) test(`${mode} 会话开启经重载保留，恢复默认后关闭`, async () => {
    const id = sessionId, other = codeId, start = writes.length
    await (await openPreference(mode)).click()
    await page.getByRole('menuitem', { name: /^本会话开启/ }).click()
    await expect(page.getByRole('button', { name: '本会话记忆：本会话开启', exact: true })).toBeEnabled()
    await expect.poll(() => disk().overrides[id]).toBe(true)
    expect(settings(other).sessionEnabled).toBe(false)
    await closePreference(); await reload()
    await (await openPreference(mode, '本会话开启')).click()
    await expect(page.getByRole('menuitem', { name: /^本会话开启/ })).toHaveAttribute('aria-current', 'true')
    await page.getByRole('menuitem', { name: /^恢复默认/ }).click()
    await expect(page.getByRole('button', { name: '本会话记忆：跟随默认 · 关闭', exact: true })).toBeEnabled()
    await expect.poll(() => disk().overrides[id]).toBeNull()
    expect(settings(id).effectiveScopes).toEqual([]); expect(settings(other).sessionEnabled).toBe(false)
    await closePreference(); await reload(); await openPreference(mode); await closePreference()
    await expect(page.locator('.work-view')).toContainText('已有聊天历史仍然保留。')
    expect(writes.slice(start)).toEqual([
      { path: '/api/v1/memory/settings', body: { sessionId: id, sessionEnabled: true } },
      { path: '/api/v1/memory/settings', body: { sessionId: id, sessionEnabled: null } }
    ])
  })

  test('Work 偏好仅保留三项设置，菜单逐层关闭，模型选择保留在输入框外侧', async () => {
    const previousWrites = structuredClone(writes), previousDisk = disk()
    for (const mode of ['work'] as const) {
      await openPreference(mode)
      const panel = preferencePanel(), surface = page.locator('.work-view')
      const model = surface.locator('.model-picker .select__trigger')
      await expect(panel.locator('.composer-options__header')).toContainText('对话偏好')
      await expect(panel.getByText('当前模型', { exact: true })).toHaveCount(0)
      await expect(panel.locator('.composer-options__model-summary, .model-picker')).toHaveCount(0)
      await expect(panel.locator('.composer-options__settings > .composer-options__row .composer-options__title'))
        .toHaveText(['本会话记忆', '思考档位', '安全模式'])
      await expect(model).toBeVisible(); await expect(model).toBeEnabled()
      if (mode === 'work') {
        await expect(panel.locator('.composer-options__workspace .composer-options__index')).toHaveCount(1)
        await expect(panel.locator('.composer-options__settings .composer-options__index')).toHaveCount(0)
      } else await expect(panel.locator('.composer-options__workspace')).toHaveCount(0)

      for (const [label, count] of [['本会话记忆', 3], ['思考档位', 4], ['安全模式', 3]] as const) {
        const trigger = preferenceRow(label).locator('.composer-options__dd-btn')
        await expect(trigger).toBeEnabled()
        await expect(trigger).toHaveAttribute('aria-label', new RegExp(`^${label}：`))
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        await trigger.click()
        const child = page.getByRole('dialog', { name: label, exact: true })
        await expect(child).toBeVisible()
        await expect(trigger).toHaveAttribute('aria-expanded', 'true')
        await expect(child.getByRole('menuitem')).toHaveCount(count)
        await expect(child.locator('[role="menuitem"][aria-current="true"]')).toHaveCount(1)
        await page.keyboard.press('Escape')
        await expect(child).toHaveCount(0)
        await expect(panel).toBeVisible()
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        await expect(trigger).toBeFocused()
      }
      // Opening and dismissing these menus must not silently choose a value.
      await closePreference()
      await expect(surface.getByRole('button', { name: '对话偏好', exact: true })).toBeFocused()
      await openPreference(mode)
      await preferencePanel().getByRole('button', { name: '关闭对话偏好', exact: true }).click()
      await expect(preferencePanel()).toHaveCount(0)
      await model.click()
      await expect(page.locator('.model-select-menu').getByRole('menuitem', { name: /^不调用的测试模型/ })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('.model-select-menu')).toHaveCount(0)
    }
    expect(writes).toEqual(previousWrites); expect(disk()).toEqual(previousDisk)
    expect(forbidden).toEqual([])
  })

  test('对话偏好在深浅色与宽窄窗口中保留完整摘要、对齐当前值并留在页面内', async ({}, info) => {
    const previousWrites = structuredClone(writes), previousDisk = disk()
    for (const appearance of ['light', 'dark'] as const) {
      await setWindow(1440, 960); await setAppearance(appearance)
      for (const [width, height] of [[1440, 960], [640, 700]] as const) {
        await setWindow(width, height)
        for (const mode of ['work'] as const) {
          await openPreference(mode)
          const panel = preferencePanel()
          await expect(preferenceRow('本会话记忆').locator('.composer-options__summary'))
            .toHaveText('使用设置中的默认值。聊天历史会继续保留。')
          await expect(preferenceRow('思考档位').locator('.composer-options__summary'))
            .toHaveText('下一次发送请求关闭推理；当前运行沿用原设置')
          await expect(preferenceRow('安全模式').locator('.composer-options__summary'))
            .toHaveText('风险命令需确认；可读写工作区外文件。')
          await expect(panel.getByRole('button', { name: '关闭对话偏好', exact: true })).toBeInViewport()
          const geometry = await panel.evaluate(element => {
            const rect = (node: Element) => { const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right,
              top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height } }
            return { panel: rect(element), width: innerWidth, height: innerHeight,
              overflow: element.scrollWidth - element.clientWidth,
              rows: [...element.querySelectorAll('.composer-options__settings > .composer-options__row')].map(row => {
                const summary = row.querySelector<HTMLElement>('.composer-options__summary')!
                const trigger = row.querySelector('.composer-options__dd-btn')!, title = row.querySelector('.composer-options__title')!
                const style = getComputedStyle(summary)
                return { row: rect(row), summary: rect(summary), trigger: rect(trigger), title: rect(title),
                  summaryOverflowX: summary.scrollWidth - summary.clientWidth, summaryOverflowY: summary.scrollHeight - summary.clientHeight,
                  whiteSpace: style.whiteSpace, ellipsis: style.textOverflow, lineClamp: style.webkitLineClamp }
              }) }
          })
          expect(geometry.rows).toHaveLength(3)
          expect(geometry.panel.left).toBeGreaterThanOrEqual(0)
          expect(geometry.panel.right).toBeLessThanOrEqual(geometry.width)
          expect(geometry.panel.top).toBeGreaterThanOrEqual(0)
          expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.height)
          expect(geometry.panel.width).toBeLessThanOrEqual(362)
          expect(geometry.overflow).toBeLessThanOrEqual(1)
          for (const row of geometry.rows) {
            expect(row.summaryOverflowX).toBeLessThanOrEqual(1); expect(row.summaryOverflowY).toBeLessThanOrEqual(1)
            expect(row.whiteSpace).not.toBe('nowrap'); expect(row.ellipsis).not.toBe('ellipsis'); expect(row.lineClamp).toBe('none')
            expect(row.summary.left).toBeGreaterThanOrEqual(row.row.left)
            expect(row.summary.right).toBeLessThanOrEqual(row.row.right + 1)
            expect(row.summary.top).toBeGreaterThanOrEqual(row.title.bottom - 1)
            expect(row.trigger.left).toBeGreaterThanOrEqual(row.title.right)
            expect(Math.abs(row.trigger.right - geometry.rows[0].trigger.right)).toBeLessThanOrEqual(1)
          }
          const screenshot = info.outputPath(`composer-options-${mode}-${appearance}-${width}.png`)
          await page.screenshot({ path: screenshot, animations: 'disabled' })
          await info.attach(`${mode}-${appearance}-${width}`, { path: screenshot, contentType: 'image/png' })
          for (const [label, name] of [['安全模式', 'security'], ['思考档位', 'thinking'], ['本会话记忆', 'memory']] as const) {
            await preferenceRow(label).locator('.composer-options__dd-btn').click()
            const menu = page.getByRole('dialog', { name: label, exact: true })
            const menuScreenshot = info.outputPath(`composer-${name}-${mode}-${appearance}-${width}.png`)
            await menu.screenshot({ path: menuScreenshot, animations: 'disabled' })
            await info.attach(`${name}-${mode}-${appearance}-${width}`, { path: menuScreenshot, contentType: 'image/png' })
            await page.keyboard.press('Escape')
          }
          await closePreference()
        }
      }
    }
    expect(writes).toEqual(previousWrites); expect(disk()).toEqual(previousDisk)
    expect(forbidden).toEqual([])
  })
})
