/** Real Electron + controlled HTTP: result-card keyboard disclosure, binary
 * U/M/D, exact file navigation, long-path containment, collapsed task plans and
 * light/dark appearance. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineFileChange, EngineTodo } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-progress-card-fixture-token', model = 'work-progress-card-model'
const sessionId = 'work-progress-card', title = '移动端主题成果', now = Date.now() - 5000
const folder = '/remote/card/web-2048/test/shots/very-long-project-directory/visual-regression/mobile-theme-variants'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
const errors: string[] = [], writes: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = ''
const run: RootRun = { schemaVersion: 1, sessionId, runId: 'card-run', turnId: 'card-turn', userMessageId: 'card-user',
  assistantMessageId: 'card-assistant', status: 'succeeded', version: 1, seq: 1, pending: [], modelId: model,
  workspacePaths: [], createdAt: now, updatedAt: now + 100, finishedAt: now + 100 }
const runs = [run]
const imageChanges: Pick<EngineFileChange, 'id' | 'path' | 'kind' | 'isNew' | 'oldHash' | 'newHash'>[] = [
  { id: 'card-new', path: `${folder}/mobile-daylight.png`, kind: 'write', isNew: true, oldHash: null, newHash: 'new-image' },
  { id: 'card-modified', path: `${folder}/mobile-saline.png`, kind: 'write', isNew: false, oldHash: 'old-image', newHash: 'changed-image' },
  { id: 'card-deleted', path: `${folder}/mobile-neon.png`, kind: 'delete', isNew: false, oldHash: 'removed-image', newHash: null }
]
const changes = imageChanges.map((change, index): EngineFileChange => ({ ...change, sessionId, turnId: run.turnId,
  runId: run.runId, oldContent: null, newContent: null, truncated: true, status: 'pending', createdAt: now + 3 - index, seq: 3 - index }))
changes.push(
  { id: 'card-temporary-created', sessionId, turnId: run.turnId, runId: run.runId, path: `${folder}/temporary.png`,
    kind: 'write', isNew: true, oldHash: 'missing', newHash: 'tmpVersion', oldContent: null, newContent: null,
    truncated: true, status: 'pending', createdAt: now + 10, seq: 10 },
  { id: 'card-temporary-deleted', sessionId, turnId: run.turnId, runId: run.runId, path: `${folder}/temporary.png`,
    kind: 'delete', isNew: false, oldHash: 'tmpVersion', newHash: 'missing', oldContent: null, newContent: null,
    truncated: true, status: 'pending', createdAt: now + 11, seq: 11 }
)
const todos: EngineTodo[] = ['检查现有主题', '调整日间配色', '完善移动端布局', '生成主题截图', '验证交互与预览'].map((title, index) => ({
  id: `card-todo-${index}`, title, priority: 'medium', status: 'done'
}))
const history: EngineHistoryRow[] = [
  { id: run.userMessageId, role: 'user', content: '请更新移动端主题并保存截图。', conversationId: run.turnId, createdAt: now, metadata: { rootRunId: run.runId } },
  { id: run.assistantMessageId, role: 'assistant', content: '已更新主题，生成的文件如下。', conversationId: run.turnId, createdAt: now + 1, metadata: { rootRunId: run.runId } }
]
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    if (request.method !== 'GET') writes.push(path)
    if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    if (path === '/api/v1/chat/admission/context') {
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId,
        namespace: { id: 'work-progress-card-db', generation: 'one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })); return
    }
    if (path === '/api/v1/workspace/file/content' || path === '/api/v1/workspace/file/info') {
      const relative = url.searchParams.get('path') ?? ''
      if (relative.endsWith('mobile-neon.png') || relative.endsWith('temporary.png')) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '文件已删除' })); return }
      response.end(envelope(path.endsWith('/content') ? { content: png, isBinary: true, totalSize: Buffer.from(png, 'base64').length }
        : { workspacePath: '/remote/card', size: Buffer.from(png, 'base64').length, isDirectory: false, mtimeMs: now })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-progress-card' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '成果卡片测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', finished: true, eventId: null, run: runs.at(-1), runs, history, projection: [], todos, changes: [], commandJobs: [] }
      : path === '/api/v1/chat/status' ? { run: runs.at(-1), running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs }
      : path === '/api/v1/conversation/history' ? history
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
      : path === '/api/v1/changes' ? changes
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/card', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = () => page.locator('.work-view')
const card = () => work().getByRole('region', { name: '本轮成果摘要', exact: true })
async function setAppearance(appearance: 'dark' | 'light'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  // Dialog retains its overlay during exit; resizing and screenshot capture
  // must wait for dismissal rather than race that retained surface.
  await expect(page.locator('.work-settings-dialog')).toHaveCount(0)
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
}

test.describe('Work 成果卡片', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-progress-card-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-progress-card', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(600, 600)
      window.setSize(1440, 1000)
    })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const task = { id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
      workspacePath: null, modelId: model, attachments: [], sources: [] }
    await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(card()).toContainText('3 个文件')
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-progress-card-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('键盘展开、二进制状态与窄宽度布局在明暗主题均可用，文件行导航保持精确', async () => {
    const disclosure = card().locator('.work-progress-panel__changes-toggle')
    const panel = work().getByRole('region', { name: '本会话成果与改动', exact: true })
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await card().getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-turn-scope]')).toHaveAttribute('data-turn-scope', 'turn:card-turn')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(card().locator('.work-progress-panel__file').first()).toBeHidden()
    await disclosure.focus(); await page.keyboard.press('Enter')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(card().locator('.work-progress-panel__file')).toHaveCount(3)
    await expect(card()).not.toContainText('temporary.png')
    await expect(card().locator('[data-change-id^="card-temporary-"]')).toHaveCount(0)
    await expect(card()).not.toContainText(/行数未知|无法计算/)
    for (const [id, code] of [['card-new', 'U'], ['card-modified', 'M'], ['card-deleted', 'D']]) {
      await expect(card().locator(`[data-change-id="${id}"]`)).toContainText(code)
    }
    await disclosure.press('Space')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(card().locator('.work-progress-panel__file').first()).toBeHidden()
    await disclosure.press('Enter')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const width of [1440, 680]) {
        await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1000), width)
        await expect.poll(() => page.evaluate(() => window.innerWidth), { message: `测试窗口必须实际缩到 ${width}px 内` }).toBeLessThanOrEqual(width)
        const conversationTab = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await conversationTab.isVisible()) await conversationTab.click()
        await card().scrollIntoViewIfNeeded()
        await expect.poll(() => card().evaluate(element => {
          const rect = element.getBoundingClientRect()
          const rows = [...element.querySelectorAll<HTMLElement>('.work-progress-panel__file')]
          return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1
            && rows.every(row => row.scrollWidth <= row.clientWidth + 1)
        }), { message: `成果卡片 ${appearance}/${width} 的长目录不能撑出窗口` }).toBe(true)
        await card().screenshot({ path: join(fixtureRoot, `artifact-card-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await disclosure.press('Space'); await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await disclosure.press('Enter'); await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await card().locator('[data-change-id="card-modified"] button').click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('.work-session-artifacts__file-header strong')).toHaveText('mobile-saline.png')
    await expect(panel.getByRole('treeitem', { selected: true })).toContainText('mobile-saline.png')
    await card().locator('.work-progress-panel__footer').getByRole('button', { name: '查看本轮成果', exact: true }).click()
    await expect(panel.locator('[data-turn-scope]')).toHaveAttribute('data-turn-scope', 'turn:card-turn')
    expect(writes.filter(path => path === '/api/v1/chat' || path.startsWith('/api/v1/changes/'))).toEqual([])
    expect(errors).toEqual([])
    health?.assertHealthy()
  })

  test('完成的任务清单默认精简为摘要，键盘展开保留所有步骤及取消状态', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    const feedback = work().getByRole('region', { name: '执行反馈', exact: true })
    const toggle = feedback.locator('.work-progress-panel__todo-toggle')
    const list = feedback.locator('.work-progress-panel__todos')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('5 / 5 已完成')
    await expect(list).toBeHidden()
    await expect(feedback.getByRole('progressbar')).toHaveCount(0)
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await feedback.screenshot({ path: join(fixtureRoot, `todo-card-${appearance}.png`), animations: 'disabled' })
      await toggle.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(list).toBeVisible()
      await expect(list.getByRole('listitem')).toHaveCount(5)
      for (const todo of todos) {
        await expect(list.locator(`[data-todo-id="${todo.id}"]`)).toBeVisible()
        await expect(list.locator(`[data-todo-id="${todo.id}"]`)).toContainText(todo.title)
      }
      await feedback.screenshot({ path: join(fixtureRoot, `todo-card-${appearance}-expanded.png`), animations: 'disabled' })
      await toggle.press('Space')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(list).toBeHidden()
    }
    // A restored cancellation must retain its distinct meaning after the
    // visual summary is compacted; it is not another completed step.
    todos[4] = { ...todos[4], status: 'cancelled' }
    await page.reload()
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('4 / 5 已完成')
    await expect(toggle).toContainText('1 已取消')
    await toggle.press('Enter')
    const cancelled = list.locator('[data-todo-id="card-todo-4"]')
    await expect(cancelled).toBeVisible()
    await expect(cancelled).toHaveAttribute('data-status', 'cancelled')
    await expect(cancelled).toContainText('已取消')
    expect(errors).toEqual([])
    health?.assertHealthy()
  })

  test('无发布清单的持久成果按轮恢复，跨轮删除不抹去早期成果且显式文字交付不伪造文件', async () => {
    const later: RootRun = { ...run, runId: 'card-run-later', turnId: 'card-turn-later', userMessageId: 'later-user', assistantMessageId: 'later-assistant',
      createdAt: now + 1000, updatedAt: now + 1100, finishedAt: now + 1100 }
    const textOnly: RootRun = { ...later, runId: 'card-run-text', turnId: 'card-turn-text', userMessageId: 'text-user', assistantMessageId: 'text-assistant',
      createdAt: now + 2000, updatedAt: now + 2100, finishedAt: now + 2100 }
    runs.push(later, textOnly)
    history.push(
      { id: later.userMessageId, role: 'user', content: '删除第一轮截图', conversationId: later.turnId, createdAt: later.createdAt },
      { id: later.assistantMessageId, role: 'assistant', content: '旧截图已删除。', conversationId: later.turnId, createdAt: later.updatedAt },
      { id: textOnly.userMessageId, role: 'user', content: '只说明结果', conversationId: textOnly.turnId, createdAt: textOnly.createdAt },
      { id: textOnly.assistantMessageId, role: 'assistant', content: '本轮仅文字说明。', conversationId: textOnly.turnId, createdAt: textOnly.updatedAt,
        metadata: { rootRunId: textOnly.runId, finalResult: { schemaVersion: 1, sessionId, runId: textOnly.runId, turnId: textOnly.turnId,
          assistantMessageId: textOnly.assistantMessageId, publishedAt: textOnly.updatedAt, text: '本轮仅文字说明。', items: [] } } }
    )
    changes.push({ ...changes[0], id: 'later-delete', turnId: later.turnId, runId: later.runId, kind: 'delete', isNew: false,
      oldHash: 'new-image', newHash: 'missing', seq: 20, createdAt: later.updatedAt })
    changes.push({ ...changes[0], id: 'text-only-internal-change', path: `${folder}/internal.png`, turnId: textOnly.turnId,
      runId: textOnly.runId, seq: 21, createdAt: textOnly.updatedAt })
    for (let replay = 0; replay < 2; replay++) {
      await page.reload()
      await expect(card()).toHaveCount(2)
      const first = work().locator('.work-conversation-turn').filter({ has: page.getByText('请更新移动端主题并保存截图。', { exact: true }) })
      const second = work().locator('.work-conversation-turn').filter({ has: page.getByText('删除第一轮截图', { exact: true }) })
      await expect(first.locator('.work-progress-panel__count')).toHaveText('3 个文件')
      await expect(second.locator('.work-progress-panel__count')).toHaveText('1 个文件')
      await expect(first.locator('[data-change-id="card-new"]')).toContainText('U')
      await expect(second.locator('[data-change-id="later-delete"]')).toContainText('D')
      await expect(work().getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
      await second.getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
      const panel = work().getByRole('region', { name: '本会话成果与改动', exact: true })
      await expect(panel.locator('[data-turn-scope]')).toHaveAttribute('data-turn-scope', 'turn:card-turn-later')
      await first.getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
      await expect(panel.locator('[data-turn-scope]')).toHaveAttribute('data-turn-scope', 'turn:card-turn')
    }
    expect(errors).toEqual([])
  })
})
