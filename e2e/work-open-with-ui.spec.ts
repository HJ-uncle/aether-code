/** Real Electron Work menus: discovered project tools, grouped keyboard navigation,
 * session-owned directories, draft restrictions and launch-error feedback.
 * Only app discovery/launch IPC is substituted to avoid opening external UI;
 * workspace resolution and filesystem authorization use production bridges. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { OpenWithApp } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'open-with-fixture', modelId = 'open-with-model', now = Date.now() - 10_000
const taskA = 'work-open-with-a', taskB = 'work-open-with-b', draft = 'work-open-with-draft'
const titles = new Map([[taskA, '打开方式任务 A'], [taskB, '打开方式任务 B'], [draft, '尚未选择目录的草稿']])
const manifest = { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 }
// A renderer hot update may briefly read the catalog from an older main process.
type DiscoveryApp = Omit<OpenWithApp, 'id'> & { id: OpenWithApp['id'] | 'terminal' | 'git-bash' }
const apps: DiscoveryApp[] = [
  { id: 'vscode', label: 'VS Code', available: true },
  { id: 'cursor', label: 'Cursor', available: true },
  { id: 'terminal', label: 'Terminal', available: true },
  { id: 'git-bash', label: 'Git Bash', available: true },
  { id: 'file-explorer', label: '项目目录', available: true }
]
type Launch = { path: string; app: string }
type ProbeState = { discoveries: number; launches: Launch[]; authorized: string[]; fail: boolean; hold: boolean; apps: DiscoveryApp[] }
type ProbeGlobal = typeof globalThis & { __openWithProbe: ProbeState; __releaseOpenWithDiscovery?: () => void }
const errors: string[] = [], workspaceReads: string[] = [], writes: string[] = []
const runs = new Map<string, RootRun>()
let app: ElectronApplication | undefined, page: Page, fixture = '', cwdA = '', cwdB = '', staleHint = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const workspace = (id: string): string => id === taskB ? cwdB : cwdA
function history(id: string): EngineHistoryRow[] {
  const run = runs.get(id)
  return run ? [{ id: run.userMessageId, role: 'user', content: titles.get(id), createdAt: now, conversationId: run.turnId,
    metadata: { rootRunId: run.runId } }, { id: run.assistantMessageId, role: 'assistant', content: `${titles.get(id)} 已完成。`,
    createdAt: now + 1, conversationId: run.turnId, metadata: { rootRunId: run.runId } }] : []
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') {
    writes.push(path)
    if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: cwdA })); return }
    throw new Error(`Unexpected mutation: ${path}`)
  }
  const rows = history(id), run = runs.get(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: 'one', mutationRevision: 'one', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/workspace/directory') workspaceReads.push(id)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { ...manifest, instanceId: 'open-with-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '打开方式测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [taskA, taskB].map(id => ({ sessionId: id, title: titles.get(id), lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'open-with', sessionId: id, namespace: { id: 'test', generation: 'one' },
      transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace(id), entries: [], bindingEpoch: id }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const openWith = (): Locator => page.getByRole('menuitem', { name: '打开方式', exact: true })
const parentMenu = (): Locator => page.locator('.context-menu:not(.context-menu--submenu):not([aria-hidden="true"])')
const item = (label: string): Locator => page.locator('.context-menu--submenu:not([aria-hidden="true"])').getByRole('menuitem', { name: label, exact: true })
async function probe(): Promise<ProbeState> { return app!.evaluate(() => (globalThis as ProbeGlobal).__openWithProbe) }
async function menuStructure(menu: Locator): Promise<string[]> {
  return menu.evaluate(element => [...element.children].flatMap(child => child.getAttribute('role') === 'separator' ? ['|']
    : child.getAttribute('role') === 'menuitem' ? [(child.textContent ?? '').replace(/\s*›\s*$/, '').trim()] : []))
}
async function releaseDiscovery(): Promise<void> {
  await app!.evaluate(() => {
    const fixture = globalThis as ProbeGlobal
    fixture.__openWithProbe.hold = false; fixture.__releaseOpenWithDiscovery?.(); delete fixture.__releaseOpenWithDiscovery
  })
}
async function checkMenuBounds(): Promise<void> {
  const box = await page.locator('.context-menu--submenu:not([aria-hidden="true"])').boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
}
async function sidebarMenu(id: string, entry: 'pointer' | 'keyboard' | 'context-key' = 'keyboard'): Promise<void> {
  const row = work().locator(`.work-sidebar__task-row[data-task-id="${id}"]`)
  const button = row.locator('.work-sidebar__task')
  await expect(row.locator('.action-menu__trigger')).toHaveCount(0)
  if (entry === 'pointer') await button.click({ button: 'right', position: { x: 18, y: 16 } })
  else { await button.focus(); await page.keyboard.press(entry === 'keyboard' ? 'Shift+F10' : 'ContextMenu') }
  await expect(openWith()).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
}
async function seed(): Promise<void> {
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: id === draft ? 'draft' : 'done', draft: '', createdAt: now, updatedAt: now,
    workspacePath: id === draft ? null : id === taskB ? staleHint : cwdA, modelId, attachments: [], sources: [] }))
  await page.evaluate(({ tasks, taskA }) => {
    localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks, activeTaskId: taskA }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { tasks, taskA })
  await page.reload(); await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
  await expect(work()).toContainText(`${titles.get(taskA)} 已完成。`)
}

test.describe.serial('Work 打开方式', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-open-with-profile-'))
    cwdA = join(fixture, '当前任务 A'); cwdB = join(fixture, "另一个任务 B & '目录'"); staleHint = join(fixture, '旧目录')
    for (const directory of [cwdA, cwdB, staleHint]) mkdirSync(directory, { recursive: true })
    for (const sessionId of [taskA, taskB]) runs.set(sessionId, { schemaVersion: 1, runId: `root-${sessionId}`, sessionId,
      turnId: `turn-${sessionId}`, userMessageId: `user-${sessionId}`, assistantMessageId: `answer-${sessionId}`, seq: 1, version: 2,
      status: 'succeeded', modelId, pending: [], workspacePaths: [workspace(sessionId)], createdAt: now, updatedAt: now + 1, finishedAt: now + 1 })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const runtime = join(fixture, 'engine'), entry = join(runtime, 'entry.cjs')
    mkdirSync(join(runtime, 'runtime'), { recursive: true })
    writeFileSync(join(runtime, 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
    writeFileSync(entry, `const http = require('node:http');
const upstream = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
const token = ${JSON.stringify(token)};
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') && req.headers['x-aether-instance-token'] !== process.env.AETHER_INSTANCE_TOKEN) {
    res.writeHead(401).end(JSON.stringify({code:401,message:'Invalid instance token'})); return;
  }
  const forwarded = http.request(upstream + req.url, { method: req.method, headers: { ...req.headers, 'x-aether-instance-token': token } }, remote => {
    res.writeHead(remote.statusCode || 500, remote.headers); remote.pipe(res);
  });
  forwarded.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
  req.pipe(forwarded);
});
server.listen(Number(process.env.AETHER_ENGINE_PORT), '127.0.0.1');
`)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12541,
      lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN',
      'AETHER_IDE_REMOTE_AUTH_URL', 'WORKSPACE_ROOT'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_ENGINE_ENTRY = entry; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    // Read the actual discovery handler before substituting machine-dependent availability.
    const discovered = await page.evaluate(() => window.aether.system.getOpenWithApps())
    expect(discovered.at(-1)).toEqual({ id: 'file-explorer', label: '项目目录', available: true })
    expect(discovered.map(app => app.id)).not.toContain('terminal')
    expect(discovered.map(app => app.id)).not.toContain('git-bash')
    expect(discovered.every(app => app.available && app.label.length > 0)).toBe(true)
    await app.evaluate(({ ipcMain }, apps) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const allowRoot = handlers.get('fs:allow-root')
      if (!allowRoot) throw new Error('Missing production fs:allow-root handler')
      const state: ProbeState = { discoveries: 0, launches: [], authorized: [], fail: false, hold: true, apps }
      ;(globalThis as ProbeGlobal).__openWithProbe = state
      ipcMain.removeHandler('fs:allow-root')
      ipcMain.handle('fs:allow-root', async (event, path: string) => { await allowRoot(event, path); state.authorized.push(path) })
      ipcMain.removeHandler('system:get-open-with-apps')
      ipcMain.handle('system:get-open-with-apps', async () => {
        state.discoveries++
        if (state.hold) await new Promise<void>(resolve => { (globalThis as ProbeGlobal).__releaseOpenWithDiscovery = resolve })
        return state.apps
      })
      ipcMain.removeHandler('system:open-with')
      ipcMain.handle('system:open-with', (_event, path: string, app: string) => {
        state.launches.push({ path, app })
        if (state.fail) throw new Error('OPEN_WITH_LAUNCH_FAILED：测试应用已被移除')
      })
    }, apps)
    await seed()
  })
  test.afterEach(async ({}, info) => {
    await releaseDiscovery()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('open-with-failure.png'); await page.screenshot({ path, animations: 'disabled' })
      await info.attach('failure', { path, contentType: 'image/png' })
    }
    await info.attach('app-errors', { body: JSON.stringify({ errors, workspaceReads, writes }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-open-with-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('右键菜单按需检测应用，并打开未选中任务的实际目录', async ({}, info) => {
    expect((await probe()).discoveries).toBe(0)
    await expect(work().locator('.work-sidebar__task-menu')).toHaveCount(0)
    const taskButton = work().locator(`.work-sidebar__task-row[data-task-id="${taskB}"] .work-sidebar__task`)
    const rowBounds = await taskButton.boundingBox()
    if (!rowBounds) throw new Error('Missing task row bounds')
    await sidebarMenu(taskB, 'pointer')
    await expect(parentMenu()).toHaveAttribute('data-motion-state', 'open')
    await expect(parentMenu()).toHaveCSS('opacity', '1')
    const menuBounds = await parentMenu().boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    if (!menuBounds) throw new Error('Missing task context-menu bounds')
    expect(Math.abs(menuBounds.x - Math.max(4, Math.min(rowBounds.x + 18, viewport.width - menuBounds.width - 4)))).toBeLessThanOrEqual(2)
    expect(Math.abs(menuBounds.y - Math.max(4, Math.min(rowBounds.y + 16, viewport.height - menuBounds.height - 4)))).toBeLessThanOrEqual(2)
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    expect((await probe()).discoveries).toBe(0)
    expect(await menuStructure(parentMenu())).toEqual(['重命名任务', '置顶', '颜色标记', '|', '添加到对话', '复制', '打开方式', '导出任务', '|', '归档任务'])
    await expect(parentMenu().getByRole('separator')).toHaveCount(2)
    await expect(parentMenu().getByRole('menuitem', { name: '继续任务', exact: true })).toHaveCount(0)
    await expect(parentMenu().getByRole('menuitem').first()).toHaveText('重命名任务')
    await expect(openWith().locator('.context-menu__icon')).toHaveCount(0)
    await parentMenu().getByRole('menuitem', { name: '颜色标记', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(parentMenu().getByRole('menuitem', { name: '添加到对话', exact: true })).toBeFocused()
    await openWith().focus(); await page.keyboard.press('ArrowRight')
    await expect(page.locator('.context-menu--submenu:not([aria-hidden="true"])')).toContainText('正在检测应用')
    await releaseDiscovery(); await expect(item('VS Code')).toBeFocused()
    expect(await menuStructure(page.locator('.context-menu--submenu:not([aria-hidden="true"])'))).toEqual(['VS Code', 'Cursor', '|', '项目目录'])
    await expect(page.locator('.context-menu--submenu .context-menu__icon')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /Terminal|Git Bash/ })).toHaveCount(0)
    expect((await probe()).discoveries).toBe(1)
    await checkMenuBounds()
    const path = info.outputPath('open-with-menu.png'); await page.screenshot({ path, animations: 'disabled' })
    await info.attach('打开方式菜单', { path, contentType: 'image/png' })
    const binds = writes.filter(path => path === '/api/v1/workspace/bind').length
    await item('VS Code').click()
    await expect.poll(async () => (await probe()).launches).toEqual([{ path: cwdB, app: 'vscode' }])
    expect((await probe()).authorized).toContain(cwdB); expect(workspaceReads).toContain(taskB)
    expect(writes.filter(path => path === '/api/v1/workspace/bind')).toHaveLength(binds)
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(taskButton).toBeFocused()
    await expect(taskButton).toHaveAttribute('aria-expanded', 'false')
  })

  test('顶栏子菜单支持键盘往返，启动失败有提示且无目录草稿不可用', async ({}, info) => {
    await work().getByRole('button', { name: '任务更多操作', exact: true }).click()
    expect(await menuStructure(parentMenu())).toEqual(['重命名任务', '|', '选择对话', '添加到对话', '复制', '打开方式', '导出任务', '|', '归档任务'])
    await expect(parentMenu().getByRole('separator')).toHaveCount(2)
    await expect(parentMenu().getByRole('menuitem', { name: '继续任务', exact: true })).toHaveCount(0)
    await expect(parentMenu().getByRole('menuitem').first()).toHaveText('重命名任务')
    await parentMenu().getByRole('menuitem', { name: '导出任务', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(parentMenu().getByRole('menuitem', { name: '归档任务', exact: true })).toBeFocused()
    const copy = page.getByRole('menuitem', { name: '复制', exact: true })
    await copy.focus(); await page.keyboard.press('ArrowRight')
    await expect(item('复制会话链接')).toBeFocused()
    await page.keyboard.press('ArrowLeft'); await expect(copy).toBeFocused()
    await openWith().focus(); await page.keyboard.press('ArrowRight')
    await expect(item('VS Code')).toBeFocused()
    await page.keyboard.press('ArrowLeft'); await expect(openWith()).toBeFocused()
    await page.keyboard.press('ArrowRight'); await expect(item('VS Code')).toBeFocused()
    await expect(page.locator('.context-menu--submenu:not([aria-hidden="true"])')).toHaveAttribute('data-motion-state', 'open')
    await expect(page.locator('.context-menu--submenu:not([aria-hidden="true"])')).toHaveCSS('opacity', '1')
    await checkMenuBounds()
    const path = info.outputPath('open-with-header-menu.png'); await page.screenshot({ path, animations: 'disabled' })
    await info.attach('顶栏打开方式菜单', { path, contentType: 'image/png' })
    await page.keyboard.press('ArrowDown'); await expect(item('Cursor')).toBeFocused()
    await page.keyboard.press('ArrowDown'); await expect(item('项目目录')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probe()).launches.at(-1)).toEqual({ path: cwdA, app: 'file-explorer' })
    await expect(page.getByRole('menu')).toHaveCount(0)

    await app!.evaluate(() => { (globalThis as ProbeGlobal).__openWithProbe.fail = true })
    await sidebarMenu(taskB)
    await openWith().hover(); await item('Cursor').click()
    await expect(page.getByText(/OPEN_WITH_LAUNCH_FAILED：测试应用已被移除/)).toBeVisible()
    await page.getByRole('button', { name: /OPEN_WITH_LAUNCH_FAILED：测试应用已被移除/ }).click()
    await expect(page.locator('.toast-host__item--error')).toHaveCount(0)
    await expect.poll(async () => (await probe()).launches.at(-1)).toEqual({ path: cwdB, app: 'cursor' })
    await expect(page.getByRole('menu')).toHaveCount(0)
    const before = (await probe()).discoveries
    await sidebarMenu(draft); await expect(openWith()).toBeDisabled()
    expect((await probe()).discoveries).toBe(before)
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(work().locator(`.work-sidebar__task-row[data-task-id="${draft}"] .work-sidebar__task`)).toBeFocused()
  })

  test('没有开发工具时仍可打开项目目录，且不留下多余分隔线', async ({}, info) => {
    await app!.evaluate(() => {
      const state = (globalThis as ProbeGlobal).__openWithProbe
      state.fail = false
      state.apps = state.apps.filter(app => app.id === 'file-explorer')
    })
    const before = (await probe()).discoveries
    await sidebarMenu(taskB, 'context-key')
    await openWith().hover()
    await expect.poll(async () => (await probe()).discoveries).toBeGreaterThan(before)
    await expect(page.locator('.context-menu--submenu:not([aria-hidden="true"])').getByRole('menuitem')).toHaveCount(1)
    await expect(item('项目目录')).toBeEnabled()
    await expect(page.locator('.context-menu--submenu:not([aria-hidden="true"])').getByRole('separator')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /VS Code|Cursor|Terminal|Git Bash/ })).toHaveCount(0)
    const path = info.outputPath('open-with-directory-only.png'); await page.screenshot({ path, animations: 'disabled' })
    await info.attach('仅项目目录', { path, contentType: 'image/png' })
    await item('项目目录').click()
    await expect.poll(async () => (await probe()).launches.at(-1)).toEqual({ path: cwdB, app: 'file-explorer' })
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('小窗口长工具列表可滚动，Home/End 保持菜单且跨过分隔线', async ({}, info) => {
    const tools: Array<[OpenWithApp['id'], string]> = [
      ['vscode', 'VS Code'], ['vscode-insiders', 'VS Code Insiders'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'],
      ['trae', 'Trae'], ['vscodium', 'VSCodium'], ['zed', 'Zed'], ['sublime-text', 'Sublime Text'],
      ['notepad-plus-plus', 'Notepad++'],
      ['intellij-idea', 'IntelliJ IDEA'], ['webstorm', 'WebStorm'], ['pycharm', 'PyCharm'], ['goland', 'GoLand'],
      ['rider', 'Rider'], ['clion', 'CLion'], ['rustrover', 'RustRover'], ['android-studio', 'Android Studio']
    ]
    const catalog: OpenWithApp[] = [...tools.map(([id, label]) => ({ id, label, available: true })),
      { id: 'file-explorer', label: '项目目录', available: true }]
    await app!.evaluate((_electron, catalog) => { (globalThis as ProbeGlobal).__openWithProbe.apps = catalog }, catalog)
    try {
      await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(980, 600); window.show(); window.focus() })
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 980, height: 600 })
      await work().getByRole('button', { name: '任务更多操作', exact: true }).click()
      await openWith().focus(); await page.keyboard.press('ArrowRight')
      const submenu = page.locator('.context-menu--submenu:not([aria-hidden="true"])')
      await expect(submenu.getByRole('menuitem')).toHaveCount(18)
      await expect(item('VS Code')).toBeFocused()
      await expect(submenu).toHaveAttribute('data-motion-state', 'open')
      await expect.poll(() => submenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      await checkMenuBounds()
      const fullyInMenu = (label: string): Promise<boolean> => item(label).evaluate(element => {
        const item = element.getBoundingClientRect(), menu = element.closest('[role="menu"]')!.getBoundingClientRect()
        return item.top >= menu.top - 1 && item.bottom <= menu.bottom + 1
      })

      await page.keyboard.press('End'); await expect(item('项目目录')).toBeFocused()
      await expect.poll(() => fullyInMenu('项目目录')).toBe(true)
      await expect(openWith()).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(() => submenu.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      const bottom = info.outputPath('open-with-small-window-bottom.png'); await page.screenshot({ path: bottom, animations: 'disabled' })
      await info.attach('小窗口长列表底部', { path: bottom, contentType: 'image/png' })
      await page.keyboard.press('ArrowUp'); await expect(item('Android Studio')).toBeFocused()
      await page.keyboard.press('ArrowDown'); await expect(item('项目目录')).toBeFocused()
      await expect(submenu.getByRole('separator')).toHaveCount(1)
      expect(await submenu.getByRole('separator').evaluate(element => element === document.activeElement || element.hasAttribute('tabindex'))).toBe(false)

      await page.keyboard.press('Home'); await expect(item('VS Code')).toBeFocused()
      await expect.poll(() => fullyInMenu('VS Code')).toBe(true)
      await expect(openWith()).toHaveAttribute('aria-expanded', 'true')
      const top = info.outputPath('open-with-small-window-top.png'); await page.screenshot({ path: top, animations: 'disabled' })
      await info.attach('小窗口长列表顶部', { path: top, contentType: 'image/png' })
      const beforeWheel = await submenu.evaluate(element => element.scrollTop)
      const box = await submenu.boundingBox()
      if (!box) throw new Error('Missing submenu bounds')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 300)
      await expect.poll(() => submenu.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel)
      await expect(openWith()).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('menu')).toHaveCount(2)
      await checkMenuBounds()
    } finally {
      await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    }
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1440, height: 900 })
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('侧栏左键选择任务，键盘菜单关闭后恢复任务焦点且不切换会话', async () => {
    const taskButton = (id: string): Locator => work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`)
    await taskButton(taskB).click()
    await expect(work().getByRole('heading', { name: titles.get(taskB)!, exact: true })).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await taskButton(taskA).click()
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    await sidebarMenu(taskB, 'keyboard')
    const firstMenuId = await parentMenu().getAttribute('data-overlay-id')
    // A keyboard event originating in the portal must not invoke the task row again.
    await parentMenu().getByRole('menuitem', { name: '重命名任务', exact: true }).press('Shift+F10')
    await expect(parentMenu()).toHaveAttribute('data-overlay-id', firstMenuId!)
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(taskButton(taskB)).toBeFocused()
    await expect(taskButton(taskB)).toHaveAttribute('aria-expanded', 'false')
    await expect(work().locator('.work-sidebar__task-row button')).toHaveCount(3)
  })
})
