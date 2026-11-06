/** Real Electron + session-owned HTTP filesystem: Work toolbar/context actions,
 * keyboard multi-selection, actual create/copy/move/delete side effects, and
 * clipboard/dialog isolation, unavailable-root retry, and unified tab closing. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp'), workspace = '/remote/work-files'
const token = 'work-file-actions-token', model = 'work-file-actions-model'
const tasks = [{ id: 'work-file-actions-a', title: '文件操作 A' }, { id: 'work-file-actions-b', title: '文件操作 B' }, { id: 'work-file-actions-missing', title: '原目录恢复' }]
const unavailable = new Set([tasks[2].id]), directoryReads = new Map<string, number>(), bindings: string[] = []
const recoveredRoots = new Map<string, string>()
const rootFor = (sessionId: string): string => recoveredRoots.get(sessionId) ?? workspace
const epochFor = (sessionId: string): string => `epoch-${sessionId}${recoveredRoots.has(sessionId) ? '-recovered' : ''}`
const unavailableMessage = `ENOENT: no such file or directory, stat '${workspace}/${tasks[2].id}'`
type Entry = { directory: boolean; content: string }
const storage = new Map(tasks.map(task => [task.id, new Map<string, Entry>([
  ['existing.md', { directory: false, content: `ORIGINAL_${task.id}` }], ['destination', { directory: true, content: '' }]
])]))
const mutations: Array<{ sessionId: string; route: string; body: Record<string, unknown> }> = []
const errors: string[] = []
let fixture = '', page: Page, app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), route = url.pathname
  if (route.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
  let raw = ''; for await (const chunk of request) raw += String(chunk)
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), files = storage.get(sessionId)
  if (route === '/api/v1/chat') throw new Error('File operations must not send chat')
  if (route === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  response.setHeader('content-type', 'application/json')
  if (route === '/api/v1/chat/admission/context') {
    response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId,
      namespace: { id: 'work-files-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })); return
  }
  if (route === '/api/v1/chat/admission/receipt') { response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId, requestKey: body.requestKey })); return }
  if (route === '/api/v1/conversation/display') { response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'one', backend: 'jsonl', completeness: 'complete' })); return }
  if (route === '/api/v1/workspace/bind') { bindings.push(sessionId); response.end(envelope({ workspaceRoot: rootFor(sessionId) })); return }
  if (route === '/api/v1/workspace/directory') {
    directoryReads.set(sessionId, (directoryReads.get(sessionId) ?? 0) + 1)
    if (unavailable.has(sessionId)) { response.end(JSON.stringify({ code: 40400, message: unavailableMessage })); return }
    // Code also mounts in the background and owns an unrelated generated
    // session. It can read its empty root; mutations below still reject it.
    if (!files) { response.end(envelope({ root: '/remote/code-only', bindingEpoch: `epoch-${sessionId}`, entries: [] })); return }
    const directory = (url.searchParams.get('path') ?? '.').replace(/\/+/g, '/'), prefix = directory === '.' ? '' : `${directory}/`
    const entries = [...files].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(([path, entry]) => ({
      name: basename(path), path, isDirectory: entry.directory, size: entry.content.length, mtimeMs: 1
    }))
    response.end(envelope({ root: rootFor(sessionId), bindingEpoch: epochFor(sessionId), entries })); return
  }
  if (route === '/api/v1/workspace/file/info' || route === '/api/v1/workspace/file/content') {
    const path = url.searchParams.get('path') ?? '', entry = files?.get(path)
    if (!entry) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '文件不存在' })); return }
    response.end(envelope(route.endsWith('/info') ? { isDirectory: entry.directory, size: entry.content.length, mtimeMs: 1 }
      : { content: entry.content, isBinary: false, totalSize: entry.content.length })); return
  }
  if (request.method === 'POST' && /^\/api\/v1\/workspace\/(?:file\/(?:create|trash|move|copy)|folder\/create)$/.test(route)) {
    if (!files || body.expectedRoot !== rootFor(sessionId) || body.bindingEpoch !== epochFor(sessionId)) throw new Error('Mutation crossed its captured session binding')
    const path = String(body.path ?? ''), src = String(body.srcPath ?? ''), dest = String(body.destPath ?? '')
    for (const value of [path, src, dest].filter(Boolean)) if (value.startsWith('/') || value.includes('..')) throw new Error('Mutation path escaped its workspace')
    mutations.push({ sessionId, route, body: structuredClone(body) })
    if (route.endsWith('/create')) {
      if (files.has(path)) { response.writeHead(409).end(JSON.stringify({ code: 409, message: '文件已存在' })); return }
      files.set(path, { directory: route.includes('/folder/'), content: '' })
    } else if (route.endsWith('/trash')) {
      for (const candidate of [...files.keys()]) if (candidate === path || candidate.startsWith(`${path}/`)) files.delete(candidate)
    } else {
      if (!files.has(src) || files.has(dest)) throw new Error('Invalid transfer')
      const selected = [...files].filter(([path]) => path === src || path.startsWith(`${src}/`))
      for (const [path, entry] of selected) files.set(`${dest}${path.slice(src.length)}`, { ...entry })
      if (route.endsWith('/move')) for (const [path] of selected) files.delete(path)
    }
    response.end(envelope({ success: true })); return
  }
  const data = route === '/health' ? { status: 'ok' }
    : route === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-files' }
    : route === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '文件模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : route === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: [], runs: [], projection: [], todos: [], changes: [], commandJobs: [] }
    : route === '/api/v1/chat/status' ? { running: false, finished: true }
    : route === '/api/v1/chat/runs' ? { runs: [] }
    : route === '/api/v1/command-jobs' ? { jobs: [] }
    : route === '/api/v1/git/binding' ? { root: rootFor(sessionId), epoch: epochFor(sessionId), contractVersion: 2, mutationRequiresBinding: true }
    : route === '/api/v1/git/status' ? { success: true, isRepo: false, files: [] }
    : route === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : route === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
    : route === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = () => page.locator('.work-view')
const panel = () => work().getByRole('region', { name: '工作区文件', exact: true })
const tree = () => panel().getByRole('tree')
const row = (path: string) => tree().locator(`[role="treeitem"][data-path="${workspace}${path ? `/${path}` : ''}"]`)
async function openWorkspaceTab() {
  const tab = work().getByRole('tab', { name: '工作区', exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    const open = work().getByRole('button', { name: '打开工作区', exact: true })
    if (await open.isVisible()) await open.click()
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  }
}
async function chooseWorkspace() {
  await openWorkspaceTab()
  await expect(tree()).toHaveAttribute('aria-busy', 'false')
  const root = row(''); if (await root.getAttribute('aria-expanded') !== 'true') await root.click()
}
async function item(path: string, label: string) {
  await row(path).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(1)
  await page.getByRole('menuitem', { name: new RegExp(`^${label}(?: |$)`) }).click()
}
async function name(value: string, title: string) {
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.getByRole('textbox').fill(value)
  await dialog.getByRole('button', { name: title === '重命名' ? '重命名' : '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test.describe.serial('Work 工作区文件操作', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port')
    const baseUrl = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl })
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-file-actions-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-file-actions', [token]); page = await app.firstWindow()
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ source, tasks, workspace, model }) => {
      const now = Date.now()
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem(`aether.work.state.v1:${encodeURIComponent(source)}`, JSON.stringify({ tasks: tasks.map((task, index) => ({ ...task, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: index === 2 ? null : workspace, modelId: model, attachments: [], sources: [] })), activeTaskId: tasks[0].id }))
    }, { source, tasks, workspace, model })
    await page.reload(); await expect(work().getByRole('heading', { name: tasks[0].title, exact: true })).toBeVisible()
    await chooseWorkspace()
  })
  test.afterEach(() => {
    expect(errors).toEqual([]); health?.assertHealthy()
  })
  test.afterAll(async ({}, info) => {
    try {
      await app?.context().tracing.stop({ path: info.outputPath('workspace-files-electron-trace.zip') })
      if (health) await health.closeAndAssert(info); else await app?.close()
    }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      const owned = resolve(fixture)
      if (dirname(owned) !== parent || !basename(owned).startsWith('work-file-actions-')) throw new Error('Unsafe cleanup')
      rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('工具栏新建及右键重命名、复制、移动、删除实际修改当前会话文件', async ({}, info) => {
    const own = storage.get(tasks[0].id)!, other = [...storage.get(tasks[1].id)!]
    await panel().getByRole('button', { name: '新建文件夹', exact: true }).click(); await name('created', '新建文件夹')
    await expect.poll(() => own.get('created')?.directory).toBe(true)
    await item('created', '新建文件'); await name('note.md', '新建文件')
    await expect.poll(() => own.get('created/note.md')?.content).toBe('')
    await row('created/note.md').click()
    await expect(work().locator('[data-document-path="/remote/work-files/created/note.md"]')).toBeVisible()
    await item('created/note.md', '重命名'); await name('renamed.md', '重命名')
    await expect.poll(() => [own.has('created/note.md'), own.has('created/renamed.md')]).toEqual([false, true])
    await expect(work().getByRole('tab', { name: '工作区', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(work().locator('[data-document-path="/remote/work-files/created/renamed.md"]')).toBeVisible()
    await item('existing.md', '复制'); await item('created', '粘贴')
    await expect.poll(() => own.get('created/existing.md')?.content).toBe(`ORIGINAL_${tasks[0].id}`)
    await item('created/existing.md', '剪切'); await item('destination', '粘贴')
    await expect.poll(() => [own.has('created/existing.md'), own.get('destination/existing.md')?.content]).toEqual([false, `ORIGINAL_${tasks[0].id}`])
    await item('destination/existing.md', '复制相对路径')
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('destination/existing.md')
    await item('destination/existing.md', '删除')
    await page.getByRole('dialog', { name: '删除文件', exact: true }).getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => own.has('destination/existing.md')).toBe(false)
    await expect(page.getByRole('dialog', { name: '删除文件', exact: true })).toHaveCount(0)
    await expect(tree()).toHaveAttribute('aria-busy', 'false')
    expect([...storage.get(tasks[1].id)!]).toEqual(other)
    expect(new Set(mutations.map(call => call.sessionId))).toEqual(new Set([tasks[0].id]))
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      await row('existing.md').click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: /^重命名(?: |$)/ })).toBeVisible()
      await expect(page.getByRole('menu')).toHaveAttribute('data-motion-state', 'open')
      await page.screenshot({ path: info.outputPath(`workspace-file-actions-${appearance}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
  })

  test('多选复制与键盘粘贴生效，切换任务不允许使用上一任务剪贴板', async () => {
    await row('existing.md').click()
    await row('created/renamed.md').click({ modifiers: ['Control'] })
    await expect(tree().locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2)
    await tree().press('Control+c')
    await row('destination').click({ button: 'right' })
    await page.keyboard.press('Escape')
    await tree().press('Control+v')
    await expect.poll(() => [storage.get(tasks[0].id)!.get('destination/existing.md')?.content, storage.get(tasks[0].id)!.has('destination/renamed.md')]).toEqual([`ORIGINAL_${tasks[0].id}`, true])
    await row('existing.md').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^在文件资源管理器中显示(?: |$)/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await item('existing.md', '剪切')
    const before = mutations.length
    await work().locator('.work-sidebar__task').filter({ hasText: tasks[1].title }).click()
    await chooseWorkspace()
    await row('destination').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^粘贴(?: |$)/ })).toBeDisabled()
    await page.keyboard.press('Escape'); await tree().press('Control+v')
    expect(mutations.length).toBe(before)
    expect(storage.get(tasks[1].id)!.get('existing.md')?.content).toBe(`ORIGINAL_${tasks[1].id}`)
  })

  test('初次目录解析失败显示简短说明，重试读取原任务且不创建或重绑空目录', async () => {
    await work().locator('.work-sidebar__task').filter({ hasText: tasks[2].title }).click()
    await openWorkspaceTab()
    const alert = panel().getByRole('alert')
    await expect(alert).toContainText('工作区目录暂时不可用')
    await expect(tree()).toHaveAttribute('aria-busy', 'false')
    await expect(alert.locator('pre')).not.toBeVisible()
    await expect(panel().getByText('此目录为空', { exact: true })).toHaveCount(0)
    await expect(panel().getByRole('button', { name: '新建文件', exact: true })).toBeDisabled()
    await alert.getByText('详细信息', { exact: true }).click()
    await expect(alert.locator('pre')).toHaveText(unavailableMessage)
    const reads = directoryReads.get(tasks[2].id) ?? 0, writes = mutations.length
    unavailable.delete(tasks[2].id)
    await alert.getByRole('button', { name: '重试', exact: true }).click()
    await expect(row('existing.md')).toBeVisible()
    await expect(alert).toHaveCount(0)
    expect(directoryReads.get(tasks[2].id)).toBeGreaterThan(reads)
    expect(bindings.filter(id => id === tasks[2].id)).toEqual([])
    expect(mutations.length).toBe(writes)
    expect(storage.get(tasks[2].id)!.get('existing.md')?.content).toBe(`ORIGINAL_${tasks[2].id}`)
  })

  test('已缓存空目录的绑定恢复后，显式刷新读取原目录且不重绑或写文件', async () => {
    const sessionId = tasks[2].id, files = storage.get(sessionId)!, original = [...files]
    files.clear()
    await panel().getByRole('button', { name: '刷新工作区文件', exact: true }).click()
    await expect(panel().getByText('此目录为空', { exact: true })).toBeVisible()
    await expect(tree()).toHaveAttribute('aria-busy', 'false')
    const reads = directoryReads.get(sessionId) ?? 0, writes = mutations.length, binds = bindings.length
    const recoveredRoot = '/remote/recovered-original-work-files'
    recoveredRoots.set(sessionId, recoveredRoot)
    for (const [path, entry] of original) files.set(path, entry)
    await panel().getByRole('button', { name: '刷新工作区文件', exact: true }).click()
    await expect(tree().locator(`[role="treeitem"][data-path="${recoveredRoot}/existing.md"]`)).toBeVisible()
    await expect(row('existing.md')).toHaveCount(0)
    await expect(panel().getByRole('alert')).toHaveCount(0)
    expect(directoryReads.get(sessionId)).toBeGreaterThan(reads)
    expect(mutations.length).toBe(writes)
    expect(bindings.length).toBe(binds)
    expect([...files]).toEqual(original)
    expect(rootFor(tasks[0].id)).toBe(workspace)
    expect(rootFor(tasks[1].id)).toBe(workspace)
  })

  test('单个与多个标签都可关闭，图标标题和关闭按钮共用同一标签，最后关闭工作区', async ({}, info) => {
    const workspaceRegion = work().getByRole('region', { name: '任务工作区', exact: true })
    const strip = () => workspaceRegion.getByRole('tablist', { name: '已打开的工作区', exact: true })
    await expect(strip().getByRole('tab')).toHaveCount(1)
    await expect(strip().getByRole('button', { name: '关闭工作区', exact: true })).toBeVisible()
    await strip().getByRole('button', { name: '关闭工作区', exact: true }).click()
    await expect(workspaceRegion).toHaveCount(0)
    await expect(work().getByRole('button', { name: '打开工作区', exact: true })).toBeFocused()
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(strip().getByRole('tab', { name: '工作区', exact: true })).toBeVisible()
    for (const label of ['成果', '资料']) {
      await work().getByRole('button', { name: '更多工作区', exact: true }).click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }
    await expect(strip().getByRole('tab')).toHaveCount(3)
    for (const label of ['工作区', '成果', '资料']) {
      const tab = strip().locator('.work-workspace__tab').filter({ has: page.getByRole('tab', { name: label, exact: true }) })
      await expect(tab.getByRole('button', { name: `关闭${label}`, exact: true })).toBeVisible()
      expect(await tab.evaluate(element => {
        const outer = element.getBoundingClientRect(), close = element.querySelector('.work-workspace__tab-close')!.getBoundingClientRect()
        return close.left >= outer.left && close.right <= outer.right && close.top >= outer.top && close.bottom <= outer.bottom
      })).toBe(true)
    }
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      await page.screenshot({ path: info.outputPath(`workspace-unified-tabs-${appearance}.png`), animations: 'disabled' })
    }
    await strip().getByRole('button', { name: '关闭工作区', exact: true }).click()
    await expect(strip().getByRole('tab', { name: '资料', exact: true })).toHaveAttribute('aria-selected', 'true')
    await strip().getByRole('button', { name: '关闭资料', exact: true }).click()
    await expect(strip().getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true')
    await strip().getByRole('tab', { name: '成果', exact: true }).press('Delete')
    await expect(workspaceRegion).toHaveCount(0)
    await expect(work().getByRole('button', { name: '打开工作区', exact: true })).toBeFocused()
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(strip().getByRole('tab', { name: '成果', exact: true })).toBeVisible()

    const externalFile = join(fixture, 'last-resource.txt')
    writeFileSync(externalFile, 'LAST_RESOURCE_PRESERVED')
    await workspaceRegion.locator('input.work-resource-tabs__file-input').setInputFiles(externalFile)
    await expect(strip().getByRole('tab', { name: 'last-resource.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
    await strip().getByRole('button', { name: '关闭成果', exact: true }).click()
    await expect(strip().getByRole('tab')).toHaveCount(1)
    await strip().getByRole('button', { name: '关闭文档 last-resource.txt', exact: true }).click()
    await expect(workspaceRegion).toHaveCount(0)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(strip().getByRole('tab', { name: '成果', exact: true })).toBeVisible()
    await expect(strip().getByRole('tab')).toHaveCount(1)
  })
})
