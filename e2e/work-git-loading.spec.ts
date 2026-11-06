/** Real Electron + authenticated engine + disposable repositories: Work Git
 * mounts before renderer readiness, loads an untouched ready task, and recovers
 * from first status/history failures. Collapsed history loads independently,
 * caches its first page, and refreshes explicitly. Footer totals include real
 * untracked, staged and unstaged line changes. Snapshot delivery and selected
 * read-only HTTP routes are gated in the main process; Git data and workspace
 * binding use the real engine. No session is prebound or Code Git prewarmed. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC, type EngineSnapshot } from '../src/shared/ipc'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '../ai-agent-engine')
const token = `git-loading-${randomUUID()}`
const failureMessage = '首次 Git 状态读取失败（测试注入）'
const logFailureMessage = '首次提交历史读取失败（测试注入）'
const benchmarkRepo = process.env.AETHER_GIT_LOADING_REPO
let fixture = '', workspaceRoot = '', baseUrl = ''
let engine: ChildProcess | undefined
let engineClosed: Promise<void> | undefined
let app: ElectronApplication | undefined
let page: Page
let health: Awaited<ReturnType<typeof monitorElectronHealth>> | undefined
let errors: string[] = []

interface LoadingMetrics {
  statusCalls: number
  bindingCalls: number
  injectedFailures: number
  holdingReady: boolean
  failingStatus: boolean
  logCalls: number
  logLimits: string[]
  activeLogCalls: number
  completedLogCalls: number
  injectedLogFailures: number
  holdingLog: boolean
  failingLog: boolean
}
type LoadingGlobal = typeof globalThis & { __workGitLoadingProbe?: {
  snapshot: () => LoadingMetrics
  ready: () => void
  allowStatus: () => void
  holdLog: () => void
  releaseLog: () => void
  allowLog: () => void
  restore: () => void
} }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}
function environment(): NodeJS.ProcessEnv {
  const result = { ...process.env }
  for (const key of Object.keys(result)) {
    if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL',
      'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase())) delete result[key]
  }
  return result
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(done => server.close(() => done()))
  return port
}
const panel = () => page.locator('.work-view .git-panel')
const historyHeader = () => panel().getByRole('button', { name: '提交历史', exact: true })
const historyCount = () => historyHeader().locator('.git-panel__count')

async function showWorkspaceTab(name: '工作区' | 'Git'): Promise<void> {
  const workspace = page.getByRole('region', { name: '任务工作区', exact: true })
  const tab = workspace.getByRole('tab', { name, exact: true })
  if (await tab.count()) await tab.click()
  else {
    await workspace.getByRole('button', { name: '更多工作区', exact: true }).press('ArrowDown')
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  await expect(workspace.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
}

async function metrics(): Promise<LoadingMetrics> {
  return app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.snapshot())
}
async function attachMetrics(info: TestInfo, name: string, elapsedMs: number): Promise<void> {
  const path = info.outputPath(`${name}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ elapsedMs, ...(await metrics()) }, null, 2))
  await info.attach(name, { path, contentType: 'application/json' })
}

async function startTask(options: { holdReady?: boolean; failStatus?: boolean; holdLog?: boolean; failLog?: boolean; emptyRepo?: boolean; repository?: string } = {}): Promise<{ repo: string; startedAt: number }> {
  const sessionId = `work-git-loading-${randomUUID()}`
  const repo = options.repository || join(workspaceRoot, sessionId)
  if (!options.repository) {
  mkdirSync(repo)
  git(repo, 'init', '-b', 'loading-main')
  git(repo, 'config', 'user.name', 'Work Git Loading Fixture')
  git(repo, 'config', 'user.email', 'work-git-loading@example.invalid')
  git(repo, 'config', 'commit.gpgSign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'tracked.txt'), 'baseline\n')
  if (!options.emptyRepo) {
    git(repo, 'add', '--', 'tracked.txt')
    git(repo, 'commit', '-m', 'initial loading fixture')
  }
  writeFileSync(join(repo, 'tracked.txt'), 'pending task change\n')
  }
  const profile = join(fixture, `desktop-${sessionId}`)
  mkdirSync(profile)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '',
    autoStartEngine: true, lastSessionId: '', appearance: 'dark'
  }))
  errors = []
  app = await electron.launch({
    args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root,
    env: { ...environment(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, `global-${sessionId}`) }
  })
  health = await monitorElectronHealth(app, 'work-git-loading', [token])
  page = await app.firstWindow()
  page.on('pageerror', error => { errors.push(error.stack || error.message); console.error('Work Git loading renderer:', error.stack || error.message) })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
  // Obtain transport identity only. There is no task yet, no Code repository,
  // and no fixture binding/status request before the measured navigation.
  let actualSnapshot: EngineSnapshot | undefined
  await expect.poll(async () => {
    actualSnapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    return actualSnapshot.phase
  }, { timeout: 30_000 }).toBe('ready')
  await app.evaluate(({ BrowserWindow, ipcMain }, input) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const originalSend = contents.send
    const originalFetch = globalThis.fetch
    let actual = input.actual
    const state: LoadingMetrics = { statusCalls: 0, bindingCalls: 0, injectedFailures: 0,
      holdingReady: input.holdReady, failingStatus: input.failStatus,
      logCalls: 0, logLimits: [], activeLogCalls: 0, completedLogCalls: 0, injectedLogFailures: 0,
      holdingLog: input.holdLog, failingLog: input.failLog }
    const logWaiters = new Set<() => void>()
    const releaseLog = (): void => {
      state.holdingLog = false
      for (const release of logWaiters) release()
      logWaiters.clear()
    }
    const delivered = (): EngineSnapshot => state.holdingReady ? { ...actual, phase: 'starting', error: null } : actual
    contents.send = (channel, ...args) => {
      if (channel === input.snapshotChannel && args[0] && typeof args[0] === 'object') {
        actual = args[0] as EngineSnapshot
        originalSend.call(contents, channel, delivered())
      } else originalSend.call(contents, channel, ...args)
    }
    ipcMain.removeHandler(input.getSnapshotChannel)
    ipcMain.handle(input.getSnapshotChannel, () => delivered())
    globalThis.fetch = async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : 'url' in request ? request.url : String(request))
      if (url.pathname === '/api/v1/workspace/bind' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { sessionId?: string }
        if (body.sessionId === input.sessionId) state.bindingCalls++
      }
      if (url.pathname === '/api/v1/git/status' && url.searchParams.get('sessionId') === input.sessionId) {
        state.statusCalls++
        if (state.failingStatus) {
          state.injectedFailures++
          return new Response(JSON.stringify({ code: 50300, message: input.failureMessage,
            data: { success: false, error: input.failureMessage, executionDisposition: 'not_started' } }),
            { status: 503, headers: { 'content-type': 'application/json' } })
        }
      }
      if (url.pathname === '/api/v1/git/log' && url.searchParams.get('sessionId') === input.sessionId) {
        state.logCalls++
        state.logLimits.push(url.searchParams.get('limit') ?? '')
        state.activeLogCalls++
        try {
          // Hold admission rather than the native Git lease, so a slow history
          // transport cannot prevent the independently requested status read.
          if (state.holdingLog) await new Promise<void>(release => logWaiters.add(release))
          if (state.failingLog) {
            state.injectedLogFailures++
            return new Response(JSON.stringify({ code: 50300, message: input.logFailureMessage,
              data: { success: false, error: input.logFailureMessage, executionDisposition: 'not_started' } }),
              { status: 503, headers: { 'content-type': 'application/json' } })
          }
          return await originalFetch(request, init)
        } finally { state.activeLogCalls--; state.completedLogCalls++ }
      }
      return originalFetch(request, init)
    }
    ;(globalThis as LoadingGlobal).__workGitLoadingProbe = {
      snapshot: () => ({ ...state, logLimits: [...state.logLimits] }),
      ready: () => { state.holdingReady = false; originalSend.call(contents, input.snapshotChannel, actual) },
      allowStatus: () => { state.failingStatus = false },
      holdLog: () => { state.holdingLog = true },
      releaseLog,
      allowLog: () => { state.failingLog = false },
      restore: () => { releaseLog(); contents.send = originalSend; globalThis.fetch = originalFetch }
    }
  }, { actual: actualSnapshot!, holdReady: options.holdReady === true, failStatus: options.failStatus === true,
    holdLog: options.holdLog === true, failLog: options.failLog === true,
    sessionId, failureMessage, logFailureMessage, snapshotChannel: IPC.event.engineSnapshot, getSnapshotChannel: IPC.invoke.engineGetSnapshot })
  const sourceKey = engineStorageKey({ mode: 'remote', baseUrl })
  await page.evaluate(({ taskKey, sessionId, repo }) => {
    const now = Date.now()
    const value = JSON.stringify({ activeTaskId: sessionId, tasks: [{ id: sessionId, title: 'Git 首屏加载任务',
      workspacePath: repo, status: 'draft', draft: '', createdAt: now, updatedAt: now, modelId: '', attachments: [], sources: [] }] })
    // Until ready, engine/source keeps the initial storage namespace. Seeding
    // both namespaces preserves the same task across the actual ready transition.
    localStorage.setItem('aether.work.state.v1', value)
    localStorage.setItem(taskKey, value)
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether:git:autoFetch:enabled', '0')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: true, tab: 'git', pane: 'workspace', ratio: 40 }))
  }, { taskKey: sessionStorageKey('aether.work.state.v1', sourceKey), sessionId, repo })
  const startedAt = Date.now()
  await page.reload()
  await expect(page.locator('.work-view').getByRole('heading', { name: 'Git 首屏加载任务', exact: true })).toBeVisible()
  await expect(panel()).toBeVisible()
  return { repo, startedAt }
}

test.describe.serial('Work Git 首屏加载', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'work-git-loading-'))
    workspaceRoot = join(fixture, 'repositories')
    mkdirSync(workspaceRoot)
    baseUrl = `http://127.0.0.1:${await freePort()}`
    const log: string[] = []
    engine = spawn(process.execPath, [join(engineRoot, 'dist', 'main.js')], {
      cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment(), AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, ENCRYPTION_KEY: 'd'.repeat(64),
        HOST: '127.0.0.1', PORT: new URL(baseUrl).port, DATA_DIR: join(fixture, 'engine.db'),
        MEMORY_DB_PATH: join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: join(fixture, 'engine-global'),
        WORKSPACE_ROOT: workspaceRoot, AETHER_ALLOWED_WORKSPACE_ROOTS: [workspaceRoot, benchmarkRepo].filter(Boolean).join(delimiter),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
    })
    engineClosed = new Promise<void>(done => engine!.once('close', () => done()))
    const record = (chunk: Buffer): void => { log.push(String(chunk)); if (log.length > 50) log.shift() }
    engine.stdout?.on('data', record)
    engine.stderr?.on('data', record)
    await expect.poll(async () => {
      if (engine?.exitCode !== null) throw new Error(`Loading fixture engine exited: ${log.join('').slice(-2500)}`)
      return fetch(baseUrl + '/health').then(response => response.status).catch(() => 0)
    }, { timeout: 90_000 }).toBe(200)
  })
  test.afterEach(async ({}, info) => {
    try {
      if (info.status !== info.expectedStatus && page && !page.isClosed()) {
        await page.screenshot({ path: info.outputPath('loading-failure.png') })
        console.error('Work Git loading UI:', await page.locator('body').innerText())
      }
      if (app) await app.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe?.restore())
      if (health) await health.closeAndAssert(info)
      else await app?.close()
      expect(errors).toEqual([])
    } finally { app = undefined; health = undefined }
  })
  test.afterAll(async () => {
    if (engine && engineClosed) {
      const child = engine
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5_000)
      try { if (child.exitCode === null) child.kill('SIGTERM'); await engineClosed }
      finally { clearTimeout(timer) }
    }
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-git-loading-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    }
  })

  test('引擎尚未就绪时已挂载 Git，收到 ready 后无需切页或刷新即可加载', async ({}, info) => {
    const { repo } = await startTask({ holdReady: true })
    await expect(panel().locator('.git-commitbar__input')).toHaveCount(0)
    expect(await page.evaluate(() => window.aether.engine.getSnapshot().then(snapshot => snapshot.phase))).toBe('starting')
    expect((await metrics()).statusCalls).toBe(0)
    await expect(panel()).toContainText('等待引擎就绪后读取 Git 状态')
    await expect(panel()).not.toContainText('工作空间干净')
    const readyAt = Date.now()
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.ready())
    await expect(panel().locator('.git-branchbar__name')).toHaveText('loading-main', { timeout: 15_000 })
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
    const elapsed = Date.now() - readyAt
    expect(elapsed).toBeLessThan(15_000)
    expect((await metrics()).statusCalls).toBeGreaterThan(0)
    expect((await metrics()).bindingCalls).toBeGreaterThan(0)
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('pending task change\n')
    await attachMetrics(info, 'work-git-ready-transition', elapsed)
  })

  test('已就绪引擎中的新任务首屏自动读取，初始 loading 不阻塞请求', async ({}, info) => {
    const { startedAt } = await startTask()
    await expect(panel().locator('.git-branchbar__name')).toHaveText('loading-main', { timeout: 15_000 })
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(15_000)
    expect((await metrics()).statusCalls).toBeGreaterThan(0)
    await attachMetrics(info, 'work-git-first-ready-load', elapsed)
  })

  test('首次状态读取失败会退出转圈并允许重试，重试后读取真实仓库', async ({}, info) => {
    const { startedAt } = await startTask({ failStatus: true })
    await expect(panel()).toContainText(failureMessage, { timeout: 15_000 })
    const retry = panel().getByRole('button', { name: '重试', exact: true })
    await expect(retry).toBeEnabled()
    await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
    await expect(panel().getByRole('status')).toHaveCount(0)
    await expect(panel()).not.toContainText('工作空间干净')
    const failed = await metrics()
    expect(failed.injectedFailures).toBeGreaterThan(0)
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.allowStatus())
    await retry.click()
    await expect(panel().locator('.git-branchbar__name')).toHaveText('loading-main', { timeout: 15_000 })
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(panel()).not.toContainText(failureMessage)
    expect((await metrics()).statusCalls).toBeGreaterThan(failed.statusCalls)
    await attachMetrics(info, 'work-git-initial-failure-retry', Date.now() - startedAt)
  })

  test('折叠历史默认异步读取且不阻塞文件区，展开和切页复用缓存，手动刷新读取新提交', async ({}, info) => {
    const { repo, startedAt } = await startTask({ holdLog: true })
    await expect(historyHeader()).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await metrics()).logCalls, { timeout: 15_000 }).toBe(1)
    await expect(historyCount().getByRole('status', { name: '正在加载提交历史', exact: true })).toBeVisible()
    await expect(historyCount()).not.toHaveText('0')
    await expect(panel().locator('.git-panel__history')).toHaveCount(0)
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    const refresh = panel().getByTitle('刷新', { exact: true })
    await expect(refresh).toBeEnabled()
    const blocked = await metrics()
    expect(blocked.logLimits).toEqual(['50'])
    expect(blocked.activeLogCalls).toBe(1)
    expect(blocked.statusCalls).toBeGreaterThan(0)
    expect(blocked.completedLogCalls).toBe(0)

    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.releaseLog())
    await expect(historyCount()).toHaveText('1', { timeout: 15_000 })
    await expect(historyHeader()).toHaveAttribute('aria-expanded', 'false')
    const cached = await metrics()
    expect(cached.completedLogCalls).toBe(1)
    expect(cached.activeLogCalls).toBe(0)
    // Any accidental cache miss now remains pending, making a hidden reload
    // observable instead of allowing a quick second response to hide it.
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.holdLog())
    for (let index = 0; index < 2; index++) {
      await historyHeader().click()
      await expect(historyHeader()).toHaveAttribute('aria-expanded', 'true')
      await expect(panel().locator('.git-panel__commit-subject')).toHaveText(['initial loading fixture'])
      await expect(panel().getByRole('status', { name: '正在加载提交历史', exact: true })).toHaveCount(0)
      expect((await metrics()).logCalls).toBe(cached.logCalls)
      await historyHeader().click()
      await expect(historyHeader()).toHaveAttribute('aria-expanded', 'false')
      await expect(panel().locator('.git-panel__history')).toHaveCount(0)
    }
    await showWorkspaceTab('工作区')
    await expect(page.getByRole('region', { name: '工作区文件', exact: true })).toBeVisible()
    await expect(panel()).not.toBeVisible()
    await showWorkspaceTab('Git')
    await expect(panel()).toBeVisible()
    await expect(historyCount()).toHaveText('1')
    await expect(refresh).toBeEnabled()
    await historyHeader().click()
    await expect(panel().locator('.git-panel__commit-subject')).toHaveText(['initial loading fixture'])
    expect((await metrics()).logCalls).toBe(cached.logCalls)
    expect((await metrics()).activeLogCalls).toBe(0)

    git(repo, 'add', '--', 'tracked.txt')
    git(repo, 'commit', '-m', 'history refreshed after cached load')
    const refreshedHead = git(repo, 'rev-parse', 'HEAD').trim()
    const refreshHistory = panel().getByTitle('刷新历史', { exact: true })
    await expect(refreshHistory).toBeEnabled()
    await refreshHistory.click()
    await expect.poll(async () => (await metrics()).logCalls).toBe(cached.logCalls + 1)
    await expect(refreshHistory).toBeDisabled()
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.releaseLog())
    await expect(historyCount()).toHaveText('2', { timeout: 15_000 })
    await expect(panel().locator('.git-panel__commit-subject')).toHaveText([
      'history refreshed after cached load', 'initial loading fixture'
    ])
    await expect(refreshHistory).toBeEnabled()
    expect((await metrics()).logCalls).toBe(cached.logCalls + 1)
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(refreshedHead)
    await attachMetrics(info, 'work-git-history-async-cache-refresh', Date.now() - startedAt)
  })

  test('折叠历史首次失败显示独立错误并可重试，不把未加载状态当作零条', async ({}, info) => {
    const { startedAt } = await startTask({ failLog: true })
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(historyHeader()).toHaveAttribute('aria-expanded', 'false')
    await expect(historyCount()).toHaveText('!', { timeout: 15_000 })
    await expect(panel().getByRole('alert').filter({ hasText: logFailureMessage })).toBeVisible()
    await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
    await expect(panel().getByRole('status', { name: '正在加载提交历史', exact: true })).toHaveCount(0)
    const retry = panel().getByRole('button', { name: '重试加载提交历史', exact: true })
    await expect(retry).toBeEnabled()
    const failed = await metrics()
    expect(failed.logCalls).toBe(1)
    expect(failed.injectedLogFailures).toBe(1)
    await app!.evaluate(() => {
      const probe = (globalThis as LoadingGlobal).__workGitLoadingProbe!
      probe.allowLog()
      probe.holdLog()
    })
    await retry.click()
    await expect.poll(async () => (await metrics()).logCalls).toBe(failed.logCalls + 1)
    await historyHeader().click()
    await expect(panel().locator('.git-panel__history').getByRole('status')).toHaveText('正在加载提交历史…')
    await expect(panel().locator('.git-panel__history')).not.toContainText('暂无提交记录')
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.releaseLog())
    await expect(historyCount()).toHaveText('1', { timeout: 15_000 })
    await expect(panel().locator('.git-panel__commit-subject')).toHaveText(['initial loading fixture'])
    await expect(panel()).not.toContainText(logFailureMessage)
    await expect(retry).toHaveCount(0)
    expect((await metrics()).injectedLogFailures).toBe(1)
    await attachMetrics(info, 'work-git-history-failure-retry', Date.now() - startedAt)
  })

  test('没有提交的真实仓库加载完成后显示零条和空态，重复展开复用空结果', async ({}, info) => {
    const { repo, startedAt } = await startTask({ emptyRepo: true })
    await expect(historyCount()).toHaveText('0', { timeout: 15_000 })
    await expect(panel().locator('.git-tree__file[data-path="tracked.txt"]')).toBeVisible()
    await expect(panel().getByRole('alert')).toHaveCount(0)
    await expect(panel().getByTitle('刷新历史', { exact: true })).toBeEnabled()
    await expect(historyHeader()).toHaveAttribute('aria-expanded', 'false')
    const loaded = await metrics()
    expect(loaded.logCalls).toBe(1)
    expect(loaded.completedLogCalls).toBe(1)
    await app!.evaluate(() => (globalThis as LoadingGlobal).__workGitLoadingProbe!.holdLog())
    for (let index = 0; index < 2; index++) {
      await historyHeader().click()
      await expect(panel().locator('.git-panel__history')).toContainText('暂无提交记录')
      await expect(panel().locator('.git-panel__commit-row')).toHaveCount(0)
      await expect(panel().getByRole('status', { name: '正在加载提交历史', exact: true })).toHaveCount(0)
      expect((await metrics()).logCalls).toBe(loaded.logCalls)
      await historyHeader().click()
      await expect(panel().locator('.git-panel__history')).toHaveCount(0)
    }
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim()).toBe('')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('pending task change\n')
    await attachMetrics(info, 'work-git-history-empty-cache', Date.now() - startedAt)
  })

  test('底部增删统计包含未跟踪三行新文件，并准确合计同一文件的暂存与未暂存差异', async ({}, info) => {
    const { repo, startedAt } = await startTask()
    await expect(panel().locator('.git-branchbar__name')).toHaveText('loading-main', { timeout: 15_000 })
    const refresh = panel().getByTitle('刷新', { exact: true })
    await expect(refresh).toBeEnabled()
    // Remove this fixture's original one-line edit so +3 is exactly the new
    // file's contribution, independent of the shared loading-case setup.
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\n')
    const original = 'first line\nsecond line\nthird line\n'
    writeFileSync(join(repo, 'three-lines.txt'), original)
    await refresh.click()
    const footer = panel().locator('.git-panel__footer')
    const additions = footer.locator('.git-panel__stat--add')
    const deletions = footer.locator('.git-panel__stat--del')
    const rows = panel().locator('.git-tree__file[data-path="three-lines.txt"]')
    await expect(footer).toBeVisible()
    await expect(additions).toHaveText('+3')
    await expect(deletions).toHaveText('-0')
    await expect(panel().locator('.git-panel__summary')).toHaveText('1 个变更')
    await expect(rows).toHaveCount(1)
    await expect(rows.locator('.git-row__add')).toHaveText('+3')
    expect(git(repo, 'status', '--porcelain=v1').trim()).toBe('?? three-lines.txt')

    await rows.hover()
    await rows.getByTitle('暂存', { exact: true }).click()
    await expect.poll(() => git(repo, 'diff', '--cached', '--numstat').trim()).toBe('3\t0\tthree-lines.txt')
    await expect(rows.getByTitle('取消暂存', { exact: true })).toBeVisible()
    await expect(additions).toHaveText('+3')
    await expect(deletions).toHaveText('-0')
    expect(git(repo, 'show', ':three-lines.txt')).toBe(original)

    const working = 'first line\nreplacement line\nthird line\nfourth line\n'
    writeFileSync(join(repo, 'three-lines.txt'), working)
    await expect(refresh).toBeEnabled()
    await refresh.click()
    // Status deliberately sums HEAD→index (+3/-0) and index→worktree (+2/-1),
    // rather than reporting the net HEAD→worktree (+4/-0) or double-counting rows.
    await expect(additions).toHaveText('+5')
    await expect(deletions).toHaveText('-1')
    await expect(panel().locator('.git-panel__summary')).toHaveText('1 个变更')
    await expect(rows).toHaveCount(2)
    const staged = rows.filter({ has: page.getByTitle('取消暂存', { exact: true }) })
    const unstaged = rows.filter({ has: page.getByTitle('暂存', { exact: true }) })
    await expect(staged.locator('.git-row__add')).toHaveText('+3')
    await expect(staged.locator('.git-row__del')).toHaveCount(0)
    await expect(unstaged.locator('.git-row__add')).toHaveText('+2')
    await expect(unstaged.locator('.git-row__del')).toHaveText('-1')
    expect(git(repo, 'diff', '--cached', '--numstat').trim()).toBe('3\t0\tthree-lines.txt')
    expect(git(repo, 'diff', '--numstat').trim()).toBe('2\t1\tthree-lines.txt')
    expect(git(repo, 'show', ':three-lines.txt')).toBe(original)
    expect(readFileSync(join(repo, 'three-lines.txt'), 'utf8')).toBe(working)
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    const screenshot = info.outputPath('work-git-footer-staged-unstaged.png')
    await page.screenshot({ path: screenshot })
    await info.attach('work-git-footer-staged-unstaged', { path: screenshot, contentType: 'image/png' })
    await attachMetrics(info, 'work-git-footer-line-totals', Date.now() - startedAt)
  })

  test('指定真实仓库的首屏读取耗时及变更数', async ({}, info) => {
    test.skip(!benchmarkRepo, '用 AETHER_GIT_LOADING_REPO 指定只读性能对比仓库')
    const repo = resolve(benchmarkRepo!)
    const baseline = git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all')
    const changes = baseline.trim().split('\n').filter(Boolean).length
    const branch = git(repo, 'branch', '--show-current').trim()
    const indexPath = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const originalIndex = readFileSync(indexPath)
    const { startedAt } = await startTask({ repository: repo })
    await expect(panel().locator('.git-panel__summary')).toHaveText(`${changes} 个变更`, { timeout: 15_000 })
    await expect(panel().locator('.git-tree__file').first()).toBeVisible()
    const filesVisibleMs = Date.now() - startedAt
    await expect(panel().locator('.git-branchbar__name')).toHaveText(branch, { timeout: 15_000 })
    await expect(panel().getByTitle('刷新', { exact: true })).toBeEnabled()
    const branchVisibleMs = Date.now() - startedAt
    expect(readFileSync(indexPath).equals(originalIndex)).toBe(true)
    await page.screenshot({ path: join(fixtureRoot, 'work-git-live-repo.png') })
    const path = info.outputPath('work-git-real-repo-load.json')
    writeFileSync(path, JSON.stringify({ repository: repo, changes, filesVisibleMs, branchVisibleMs, ...await metrics() }, null, 2))
    await info.attach('work-git-real-repo-load', { path, contentType: 'application/json' })
  })
})
