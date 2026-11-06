/** Fresh Work workspace search coverage: shared search controls, scoped remote
 * file reads, in-place line navigation, file/search switching, task isolation,
 * and previewed replacements whose actual disk effects are checked. No legacy
 * suite, model request, or document export is needed by this fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const temporaryRoot = join(root, '.e2e-tmp')
const token = 'work-workspace-search-fixture-token'
const model = 'work-workspace-search-model'
const sessionA = 'work-search-session-a'
const sessionB = 'work-search-session-b'
const titleA = '搜索隔离任务 A'
const titleB = '搜索隔离任务 B'
const now = Date.now() - 5000
const roots: Record<string, string> = { [sessionA]: '/fixtures/work-search-a', [sessionB]: '/fixtures/work-search-b' }
const startupSessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const seedA = {
  'src/report.txt': 'ScopeAlpha only-A\nscopealpha lower\nScopeAlphabets extended\nfinal ScopeAlpha line\n',
  'notes.md': 'ScopeAlpha notes\nreplace-token notes\n',
  'src/replace.txt': 'replace-token one\nreplace-token two\n',
  'src/anchors.txt': 'before\r\nanchor\r\nanchor suffix\r\nanchor\r\nafter\r\n',
  'src/long-line.txt': `short heading\n${'x'.repeat(600)} FarTailMarker ${'z'.repeat(50)}\n`,
  'ignored/drop.txt': 'ScopeAlpha ignored\n',
  'node_modules/pkg.txt': 'ScopeAlpha dependency\n'
}
const seedB = { 'only-b.txt': 'ScopeBeta only-B\nreplace-token B\n' }
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const errors: string[] = []
const writes: { sessionId: string; path: string; content: string }[] = []
const reads: { sessionId: string; path: string }[] = []
let fixture = ''
let server: ReturnType<typeof createServer> | undefined
let app: ElectronApplication | undefined
let page: Page
let health: ElectronHealthMonitor | undefined

function diskPath(sessionId: string, path: string): string {
  if (!(sessionId in roots)) throw new Error(`Unknown search fixture session: ${sessionId}`)
  if (path !== '.' && (isAbsolute(path) || path.replace(/\\/g, '/').split('/').some(part => !part || part === '..' || part === '.'))) {
    throw new Error(`Unscoped search fixture path: ${path}`)
  }
  const directory = join(fixture, 'workspace', sessionId)
  const absolute = resolve(directory, path)
  const remaining = relative(directory, absolute)
  if (remaining.startsWith('..') || isAbsolute(remaining)) throw new Error('Search fixture path escaped its session')
  return absolute
}

function taskHistory(sessionId: string) {
  if (!Object.hasOwn(roots, sessionId)) return []
  return [
    { id: `${sessionId}-user`, role: 'user', content: '检查当前任务文件。', conversationId: `${sessionId}-turn`, createdAt: now },
    { id: `${sessionId}-assistant`, role: 'assistant', content: '当前任务文件已准备好。', conversationId: `${sessionId}-turn`, createdAt: now + 1 }
  ]
}

function displayHistory(sessionId: string, url: URL) {
  const history = taskHistory(sessionId)
  const users = history.filter(row => row.role === 'user')
  const anchor = url.searchParams.get('anchorMessageId')
  const limit = Number(url.searchParams.get('limit') ?? 2)
  const start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
  if (start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid display history fixture request')
  const selected = users.slice(start, start + limit)
  const selectedTurns = new Set(selected.map(row => row.conversationId))
  return { schemaVersion: 1, grouping: 'root',
    turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })),
    messages: history.filter(row => selectedTurns.has(row.conversationId)), loadedTurnIds: selected.map(row => row.id),
    revision: `${sessionId}:stable`, mutationRevision: `${sessionId}:unchanged`, backend: 'jsonl', completeness: 'complete' }
}

function panel(): Locator { return page.getByRole('region', { name: '工作区文件', exact: true }) }
function searchInput(): Locator { return panel().getByRole('textbox', { name: '搜索内容', exact: true }) }
function hits(): Locator { return panel().locator('.search-view__hit') }

async function setOption(name: string, enabled: boolean): Promise<void> {
  const button = panel().getByRole('button', { name, exact: true })
  if ((await button.getAttribute('aria-pressed')) !== String(enabled)) await button.click()
}

async function openSearch(): Promise<void> {
  const button = panel().getByRole('button', { name: '搜索工作区内容', exact: true })
  await expect(button).toBeEnabled()
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  await expect(searchInput()).toBeVisible()
}

async function showFilters(): Promise<void> {
  if (!(await panel().getByRole('textbox', { name: '包含', exact: true }).isVisible())) {
    await panel().getByRole('button', { name: '切换文件过滤', exact: true }).click()
  }
}

async function resetSearch(): Promise<void> {
  await openSearch()
  await searchInput().fill('')
  await setOption('区分大小写', false)
  await setOption('全字匹配', false)
  await setOption('使用正则表达式', false)
  await showFilters()
  await panel().getByRole('textbox', { name: '包含', exact: true }).fill('')
  await panel().getByRole('textbox', { name: '排除', exact: true }).fill('')
  await panel().getByRole('checkbox', { name: '使用排除设置', exact: true }).check()
}

async function searchFor(query: string, count: number): Promise<void> {
  await searchInput().fill(query)
  await expect(panel().locator('.search-view__summary')).toContainText(`${count} 处命中`)
  await expect(hits()).toHaveCount(count)
}

async function setAppearance(appearance: 'dark' | 'light'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).not.toBeVisible()
}

async function replacementPreview(): Promise<Locator> {
  await resetSearch()
  await panel().getByRole('textbox', { name: '包含', exact: true }).fill('src/replace.txt')
  await searchFor('replace-token', 2)
  if (!(await panel().getByRole('textbox', { name: '替换为', exact: true }).isVisible())) {
    await panel().getByRole('button', { name: '显示替换', exact: true }).click()
  }
  await panel().getByRole('textbox', { name: '替换为', exact: true }).fill('updated-token')
  await panel().getByRole('button', { name: '全部替换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '替换预览', exact: true })
  await expect(dialog).toContainText('将替换 2 处（1 个文件）')
  await expect(dialog).toContainText('src/replace.txt')
  return dialog
}

test.describe.serial('Work 工作区内搜索（全新专项）', () => {
  test.beforeAll(async () => {
    mkdirSync(temporaryRoot, { recursive: true })
    fixture = mkdtempSync(join(temporaryRoot, 'work-workspace-search-'))
    for (const [sessionId, files] of [[sessionA, seedA], [sessionB, seedB]] as const) {
      for (const [path, content] of Object.entries(files)) {
        const absolute = diskPath(sessionId, path)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, content)
      }
    }
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
          response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null))
          return
        }
        let raw = ''
        for await (const chunk of request) raw += String(chunk)
        const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}
        const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? sessionA)
        if (path === '/api/v1/chat/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
          return
        }
        response.setHeader('content-type', 'application/json')
        if (path.startsWith('/api/v1/workspace/')) {
          const scopedId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
          const relativePath = String(body.path ?? url.searchParams.get('path') ?? '.')
          // Electron opens Code before the test seeds Work localStorage. Its
          // generated UUID sessions own empty roots and must never inherit A
          // or B's files, even while the renderer reloads into Work mode.
          if (!Object.hasOwn(roots, scopedId)) {
            if (!startupSessionPattern.test(scopedId) || request.method !== 'GET' || relativePath !== '.') {
              throw new Error(`Unexpected startup workspace operation: ${request.method} ${path} ${scopedId} ${relativePath}`)
            }
            const codeRoot = `/fixtures/code-startup/${scopedId}`
            if (path === '/api/v1/workspace/directory') response.end(envelope({ root: codeRoot, bindingEpoch: 'code-startup', entries: [] }))
            else if (path === '/api/v1/workspace/file/info') response.end(envelope({ isDirectory: true, size: 0, mtimeMs: now }))
            else response.end(envelope({ success: true, isRepo: false, root: codeRoot, files: [] }))
            return
          }
          const absolute = diskPath(scopedId, relativePath)
          const workspaceRoot = roots[scopedId]
          if (path === '/api/v1/workspace/directory') {
            const entries = readdirSync(absolute, { withFileTypes: true }).map(entry => {
              const metadata = statSync(join(absolute, entry.name))
              return { name: entry.name, path: `${workspaceRoot}/${relativePath === '.' ? '' : relativePath + '/'}${entry.name}`,
                isDirectory: entry.isDirectory(), size: metadata.size, mtimeMs: metadata.mtimeMs }
            })
            response.end(envelope({ root: workspaceRoot, bindingEpoch: 'one', entries }))
          } else if (path === '/api/v1/workspace/file/content') {
            const content = readFileSync(absolute, 'utf8')
            reads.push({ sessionId: scopedId, path: relativePath })
            response.end(envelope({ content, isBinary: false, totalSize: Buffer.byteLength(content), originalLength: content.length,
              root: workspaceRoot, bindingEpoch: 'one' }))
          } else if (path === '/api/v1/workspace/file/info') {
            const metadata = statSync(absolute)
            response.end(envelope({ isDirectory: metadata.isDirectory(), size: metadata.size, mtimeMs: metadata.mtimeMs }))
          } else if (path === '/api/v1/workspace/file' && request.method === 'POST') {
            if (typeof body.content !== 'string') throw new Error('Search replacement omitted its text content')
            writeFileSync(absolute, body.content)
            writes.push({ sessionId: scopedId, path: relativePath, content: body.content })
            response.end(envelope({ success: true }))
          } else response.end(envelope({ success: true, isRepo: false, root: workspaceRoot, files: [] }))
          return
        }
        const data = path === '/health' ? { status: 'ok' }
          : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1,
            toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-workspace-search' }
          : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '工作区搜索测试模型',
            isEnabled: true, capabilities: { toolCalling: true } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', finished: true,
            eventId: null, projection: [], history: taskHistory(sessionId), runs: [], todos: [], changes: [], commandJobs: [] }
          : path === '/api/v1/chat/status' ? { running: false, finished: true }
          : path === '/api/v1/chat/runs' ? { runs: [] }
          : path === '/api/v1/conversation/display' ? displayHistory(sessionId, url)
          : path === '/api/v1/conversation/history' ? taskHistory(sessionId)
          : path === '/api/v1/conversation/sessions' ? [{ sessionId: sessionA, title: titleA, lastAt: now, messageCount: 2 },
            { sessionId: sessionB, title: titleB, lastAt: now, messageCount: 2 }]
          : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'fixture', sessionId,
            namespace: { id: 'work-workspace-search-db', generation: 'one' },
            transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
          : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
          : path === '/api/v1/memory/settings' ? { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: false }
          : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
            toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
          : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
          : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
            runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
          : path === '/api/v1/command-jobs' ? { jobs: [] }
          : []
        response.end(envelope(data))
      })().catch(error => {
        errors.push(String(error))
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end(envelope(null))
      })
    })
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing Work workspace search fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastSessionId: sessionA, lastModelId: model, appearance: 'light', lastFolder: '',
      filesExclude: {}, searchExclude: { '**/node_modules': true } }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-workspace-search', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const tasks = [[sessionA, titleA], [sessionB, titleB]].map(([id, title]) => ({ id, title, status: 'done', draft: '',
      createdAt: now, updatedAt: now, workspacePath: null, modelId: model, attachments: [], sources: [] }))
    await page.evaluate(({ key, tasks, activeTaskId }) => {
      localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true,
        tab: 'workspace', pane: 'workspace', ratio: 56 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), tasks, activeTaskId: sessionA })
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel()).toHaveAttribute('data-session-id', sessionA)
    await expect(panel().getByRole('button', { name: '搜索工作区内容', exact: true })).toBeEnabled()
  })

  test.afterEach(async () => {
    expect(errors).toEqual([])
    health?.assertHealthy()
    await expect(page.locator('.work-view')).not.toContainText('完整对话记录格式不正确')
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server?.closeAllConnections()
      if (server) await new Promise<void>(done => server!.close(() => done()))
      if (fixture) {
        const cleanup = resolve(fixture)
        const remaining = relative(resolve(temporaryRoot), cleanup)
        if (!remaining || remaining.startsWith('..') || isAbsolute(remaining)) throw new Error('Unsafe search fixture cleanup path')
        rmSync(cleanup, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  })

  test('工作区内展开内容搜索并只搜索当前任务文件', async ({}, info) => {
    await openSearch()
    await expect(searchInput()).toBeFocused()
    await searchFor('ScopeAlpha', 6)
    await expect(panel().locator('.search-view__group')).toHaveCount(3)
    expect(reads.some(read => read.sessionId === sessionA && read.path === 'src/report.txt')).toBe(true)
    expect(reads.filter(read => read.sessionId === sessionB)).toEqual([])
    expect(reads.filter(read => read.path.startsWith('node_modules/'))).toEqual([])
    await page.screenshot({ path: info.outputPath('work-workspace-search-light.png'), fullPage: true })
  })

  test('大小写、全字、正则选项生效且错误表达式可恢复', async () => {
    await setOption('区分大小写', true)
    await expect(hits()).toHaveCount(5)
    await setOption('全字匹配', true)
    await expect(hits()).toHaveCount(4)
    await setOption('全字匹配', false)
    await setOption('使用正则表达式', true)
    await searchFor('ScopeAlpha(?: only-A| notes)', 2)
    await searchInput().fill('[')
    await expect(panel().locator('.search-view__summary')).toContainText('正则表达式无效')
    await expect(hits()).toHaveCount(0)
    await resetSearch()
    await searchFor('ScopeAlpha', 6)
  })

  test('包含、排除、设置排除和结果折叠都在工作区内生效', async () => {
    await showFilters()
    await panel().getByRole('textbox', { name: '包含', exact: true }).fill('src')
    await expect(hits()).toHaveCount(4)
    await panel().getByRole('textbox', { name: '包含', exact: true }).fill('')
    await panel().getByRole('textbox', { name: '排除', exact: true }).fill('src')
    await expect(hits()).toHaveCount(2)
    await panel().getByRole('textbox', { name: '排除', exact: true }).fill('')
    await panel().getByRole('checkbox', { name: '使用排除设置', exact: true }).uncheck()
    await expect(hits()).toHaveCount(7)
    await expect(panel().locator('.search-view__group').filter({ hasText: 'pkg.txt' })).toContainText('ScopeAlpha dependency')
    await panel().getByRole('button', { name: '全部折叠', exact: true }).click()
    await expect(hits()).toHaveCount(0)
    await expect(panel().locator('.search-view__file')).toHaveCount(4)
    await panel().getByRole('button', { name: '全部展开', exact: true }).click()
    await expect(hits()).toHaveCount(7)
  })

  test('点击与键盘打开结果定位正文行，文件和搜索切换不丢状态', async () => {
    await resetSearch()
    await panel().getByRole('textbox', { name: '包含', exact: true }).fill('src/report.txt')
    await searchFor('ScopeAlpha', 4)
    await panel().locator('.search-view__hit[title="第 4 行"]').click()
    const preview = page.getByRole('grid', { name: 'report.txt 文本预览', exact: true })
    const fourthLine = preview.locator('[role="row"][aria-rowindex="4"]')
    await expect(fourthLine).toHaveAttribute('aria-selected', 'true')
    await expect(fourthLine.locator('mark')).toHaveText('ScopeAlpha')
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel().getByRole('button', { name: '搜索工作区内容', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await panel().getByRole('button', { name: '浏览工作区文件', exact: true }).click()
    await expect(panel().getByRole('textbox', { name: '筛选文件', exact: true })).toBeVisible()
    await expect(searchInput()).not.toBeVisible()
    await openSearch()
    await expect(searchInput()).toHaveValue('ScopeAlpha')
    await expect(panel().getByRole('textbox', { name: '包含', exact: true })).toHaveValue('src/report.txt')
    await expect(hits()).toHaveCount(4)
    const results = panel().locator('.search-view__results')
    await results.focus()
    await results.press('ArrowDown')
    await results.press('Enter')
    await expect(preview.locator('[role="row"][aria-rowindex="1"]')).toHaveAttribute('aria-selected', 'true')
  })

  test('长行末尾匹配在结果中可见，点击后水平定位到准确正文列', async () => {
    await resetSearch()
    await panel().getByRole('textbox', { name: '包含', exact: true }).fill('src/long-line.txt')
    await searchFor('FarTailMarker', 1)
    await expect(hits().first()).toContainText('FarTailMarker')
    await hits().first().click()
    const preview = page.getByRole('grid', { name: 'long-line.txt 文本预览', exact: true })
    const line = preview.locator('[role="row"][aria-rowindex="2"]')
    await expect(line).toHaveAttribute('aria-selected', 'true')
    await expect(line.locator('mark')).toHaveText('FarTailMarker')
    await expect.poll(() => preview.evaluate(element => {
      const match = element.querySelector('mark')?.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return Boolean(match && element.scrollLeft > 0 && match.left >= bounds.left && match.right <= bounds.left + element.clientWidth + 1)
    }), { message: '第 600 列后的匹配应自动滚入正文预览可视范围' }).toBe(true)
    await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel().getByRole('button', { name: '搜索工作区内容', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('行首行尾正则的替换预览与实际写盘一致并保留 CRLF', async () => {
    await resetSearch()
    await panel().getByRole('textbox', { name: '包含', exact: true }).fill('src/anchors.txt')
    await setOption('使用正则表达式', true)
    await searchFor('^anchor$', 2)
    await expect(hits().locator('.search-view__hit-line')).toHaveText(['2', '4'])
    if (!(await panel().getByRole('textbox', { name: '替换为', exact: true }).isVisible())) {
      await panel().getByRole('button', { name: '显示替换', exact: true }).click()
    }
    await panel().getByRole('textbox', { name: '替换为', exact: true }).fill('anchored-update')
    const initialWrites = writes.length
    await panel().getByRole('button', { name: '全部替换', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '替换预览', exact: true })
    await expect(dialog).toContainText('将替换 2 处（1 个文件）')
    expect(readFileSync(diskPath(sessionA, 'src/anchors.txt'), 'utf8')).toBe(seedA['src/anchors.txt'])
    expect(writes).toHaveLength(initialWrites)
    await dialog.getByRole('button', { name: '应用替换', exact: true }).click()
    const expected = 'before\r\nanchored-update\r\nanchor suffix\r\nanchored-update\r\nafter\r\n'
    await expect.poll(() => readFileSync(diskPath(sessionA, 'src/anchors.txt'), 'utf8')).toBe(expected)
    await expect(panel().locator('.search-view__replace-note')).toContainText('已替换 2 处（1 个文件）')
    await expect(hits()).toHaveCount(0)
    expect(writes.slice(initialWrites)).toEqual([{ sessionId: sessionA, path: 'src/anchors.txt', content: expected }])
    expect(readFileSync(diskPath(sessionA, 'src/replace.txt'), 'utf8')).toBe(seedA['src/replace.txt'])
    expect(readFileSync(diskPath(sessionB, 'only-b.txt'), 'utf8')).toBe(seedB['only-b.txt'])
  })

  test('替换预览可取消和按 Escape 关闭，磁盘完全不变', async () => {
    const initialWrites = writes.length
    const dialog = await replacementPreview()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(readFileSync(diskPath(sessionA, 'src/replace.txt'), 'utf8')).toBe(seedA['src/replace.txt'])
    expect(writes).toHaveLength(initialWrites)
    await panel().getByRole('button', { name: '全部替换', exact: true }).click()
    await expect(dialog).toContainText('将替换 2 处（1 个文件）')
    await dialog.press('Escape')
    await expect(dialog).not.toBeVisible()
    expect(writes).toHaveLength(initialWrites)
  })

  test('预览后文件被外部修改时拒绝覆盖并提示重新预览', async () => {
    const initialWrites = writes.length
    const dialog = await replacementPreview()
    const externalContent = 'replace-token externally changed\n'
    writeFileSync(diskPath(sessionA, 'src/replace.txt'), externalContent)
    try {
      await dialog.getByRole('button', { name: '应用替换', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(panel().locator('.search-view__replace-note')).toContainText('文件在预览后已变化')
      expect(readFileSync(diskPath(sessionA, 'src/replace.txt'), 'utf8')).toBe(externalContent)
      expect(writes).toHaveLength(initialWrites)
    } finally { writeFileSync(diskPath(sessionA, 'src/replace.txt'), seedA['src/replace.txt']) }
  })

  test('确认替换仅写入预览文件，任务外和筛选外文件不变', async () => {
    const initialWrites = writes.length
    const dialog = await replacementPreview()
    await dialog.getByRole('button', { name: '应用替换', exact: true }).click()
    await expect.poll(() => readFileSync(diskPath(sessionA, 'src/replace.txt'), 'utf8')).toBe('updated-token one\nupdated-token two\n')
    await expect(panel().locator('.search-view__replace-note')).toContainText('已替换 2 处（1 个文件）')
    await expect(hits()).toHaveCount(0)
    expect(writes.slice(initialWrites)).toEqual([{ sessionId: sessionA, path: 'src/replace.txt', content: 'updated-token one\nupdated-token two\n' }])
    expect(readFileSync(diskPath(sessionA, 'notes.md'), 'utf8')).toBe(seedA['notes.md'])
    expect(readFileSync(diskPath(sessionB, 'only-b.txt'), 'utf8')).toBe(seedB['only-b.txt'])
  })

  test('切换会话后只搜索新任务，旧搜索和替换状态不能泄漏', async ({}, info) => {
    await page.getByRole('complementary', { name: 'Work 导航', exact: true }).getByRole('button', { name: `${titleB} · 已完成`, exact: true }).click()
    await expect(panel()).toHaveAttribute('data-session-id', sessionB)
    await openSearch()
    await expect(searchInput()).toHaveValue('')
    await expect(panel().getByRole('textbox', { name: '替换为', exact: true })).not.toBeVisible()
    const readOffset = reads.length
    await searchFor('ScopeAlpha', 0)
    await expect(panel()).toContainText('没有匹配的内容')
    await searchFor('ScopeBeta', 1)
    expect(reads.slice(readOffset).every(read => read.sessionId === sessionB)).toBe(true)
    await expect(panel().locator('.search-view__group')).toContainText('only-b.txt')
    await expect(panel()).not.toContainText('report.txt')
    await setAppearance('dark')
    await expect(searchInput()).toHaveValue('ScopeBeta')
    await expect(hits()).toHaveCount(1)
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 850))
    await expect(panel()).toBeVisible()
    await expect.poll(() => panel().evaluate(element => element.scrollWidth - element.clientWidth),
      { message: '窄工作区搜索栏不能水平溢出' }).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath('work-workspace-search-dark-narrow.png'), fullPage: true })
    await setAppearance('light')
    await expect(searchInput()).toHaveValue('ScopeBeta')
    await expect(hits()).toHaveCount(1)
    await expect(panel().locator('.search-view__summary')).toContainText('1 处命中')
  })

  test('窄工作区展开替换和文件过滤后，每个控件与结果仍可操作', async ({}, info) => {
    const initialWrites = writes.length
    await showFilters()
    await panel().getByRole('button', { name: '显示替换', exact: true }).click()
    await panel().getByRole('textbox', { name: '替换为', exact: true }).fill('ScopeBetaPreview')
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await expect(searchInput()).toHaveValue('ScopeBeta')
      await expect(hits()).toHaveCount(1)
      const controls = [searchInput(),
        panel().getByRole('textbox', { name: '替换为', exact: true }),
        panel().getByRole('textbox', { name: '包含', exact: true }),
        panel().getByRole('textbox', { name: '排除', exact: true }),
        panel().getByRole('checkbox', { name: '使用排除设置', exact: true }),
        ...['清空搜索', '区分大小写', '全字匹配', '使用正则表达式', '隐藏替换', '全部替换', '切换文件过滤',
          '刷新搜索', '全部折叠', '清空搜索结果', '编辑搜索排除设置…'].map(name => panel().getByRole('button', { name, exact: true }))]
      for (const control of controls) {
        await expect(control).toBeVisible()
        // Trial clicks include real hit testing and scrolling but do not change
        // options or start replacement while checking the compact layout.
        await control.click({ trial: true })
        await expect(control).toBeInViewport()
        await expect.poll(() => control.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          const container = element.closest('.work-workspace-panel')!.getBoundingClientRect()
          return bounds.left >= container.left - 1 && bounds.right <= container.right + 1 &&
            (!element.matches('input[type="text"]') || bounds.width >= 32)
        }), { message: '窄工作区控件不能被横向裁切或压成不可输入的宽度' }).toBe(true)
      }
      await searchInput().scrollIntoViewIfNeeded()
      await page.screenshot({ path: info.outputPath(`work-workspace-search-${appearance}-expanded-narrow.png`), fullPage: true })
      await hits().first().click()
      const preview = page.getByRole('grid', { name: 'only-b.txt 文本预览', exact: true })
      await expect(preview.locator('[role="row"][aria-rowindex="1"]')).toHaveAttribute('aria-selected', 'true')
      await expect(preview.locator('mark')).toHaveText('ScopeBeta')
      await expect(preview).toBeInViewport()
      await page.screenshot({ path: info.outputPath(`work-workspace-search-${appearance}-result-narrow.png`), fullPage: true })
      await panel().getByRole('button', { name: '全部替换', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '替换预览', exact: true })
      await expect(dialog).toContainText('将替换 1 处（1 个文件）')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).not.toBeVisible()
    }
    expect(writes).toHaveLength(initialWrites)
    expect(readFileSync(diskPath(sessionB, 'only-b.txt'), 'utf8')).toBe(seedB['only-b.txt'])
  })
})
