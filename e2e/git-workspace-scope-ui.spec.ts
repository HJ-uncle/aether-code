/**
 * Real Electron -> authenticated engine -> real nested Git repositories.
 * An empty tenant workspace must not discover the host's enclosing repository;
 * Explorer/Git must share the account/session root through init, stage and logout.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { GitStatusResult } from '../src/shared/git-types'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '../ai-agent-engine')
const instance = 'git-workspace-scope-instance'
const errors: string[] = []
let fixture = ''
let outer = ''
let originalRoot = ''
let originalAccount = ''
let originalTenant = ''
let outerStatus = ''
let outerIndex = ''
let engine: ChildProcess | undefined
let engineClosed: Promise<void> | undefined
let app: ElectronApplication | undefined
let page: Page

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(done => server.close(() => done()))
  return port
}

async function stopEngine(): Promise<void> {
  const child = engine
  if (!child || !engineClosed) return
  await new Promise<void>((done, reject) => {
    const hardStop = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 8_000)
    const deadline = setTimeout(() => { cleanup(); reject(new Error('Owned Git fixture engine did not close')) }, 15_000)
    const cleanup = (): void => { clearTimeout(hardStop); clearTimeout(deadline) }
    // close includes stdio/native handle release; exit alone races Windows rm.
    void engineClosed!.then(() => { cleanup(); done() }, error => { cleanup(); reject(error) })
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  })
}

function assertOuterUnchanged(): void {
  expect(git(outer, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(outerStatus)
  expect(git(outer, 'ls-files', '--stage')).toBe(outerIndex)
  expect(readFileSync(join(outer, 'outer-tracked.txt'), 'utf8')).toBe('host modification must remain outside the tenant\n')
  expect(readFileSync(join(outer, 'outer-untracked.txt'), 'utf8')).toBe('host untracked file must not be staged\n')
}

async function showExplorer(): Promise<void> {
  // The activity button toggles an already selected sidebar closed.
  if (!(await page.locator('.explorer').isVisible())) {
    await page.getByRole('button', { name: '资源管理器', exact: true }).click()
  }
  await expect(page.locator('.explorer__tree')).toBeVisible()
}

async function showGit(): Promise<void> {
  if (!(await page.locator('.git-panel').isVisible())) {
    await page.getByRole('button', { name: '版本控制', exact: true }).click()
  }
  await expect(page.locator('.git-panel')).toBeVisible()
}

async function tenantRoot(tenantId: string): Promise<string> {
  const row = page.locator('.explorer__tree [role="treeitem"][aria-level="1"]')
  await expect(row).toHaveCount(1)
  await expect.poll(() => row.getAttribute('data-path'), { timeout: 30_000 }).toContain(tenantId)
  const path = await row.getAttribute('data-path')
  if (!path) throw new Error('Explorer did not expose the mounted workspace root')
  const owned = relative(join(outer, 'workspaces'), path)
  if (!owned || owned.startsWith('..') || resolve(join(outer, 'workspaces'), owned) !== resolve(path)) {
    throw new Error('Tenant fixture escaped the owned workspace root')
  }
  return path
}

async function status(path: string): Promise<GitStatusResult> {
  const result = await page.evaluate(sessionId => window.aether.engine.request<GitStatusResult>({
    method: 'GET', path: '/git/status', query: { sessionId, cwd: '.' }
  }), basename(path))
  expect(result.ok, result.message).toBe(true)
  return result.data!
}

test.describe.serial('Git 与资源管理器共享账号工作区边界', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'git-workspace-scope-'))
    outer = join(fixture, 'outer')
    mkdirSync(outer)
    git(outer, 'init')
    git(outer, 'config', 'user.name', 'Git Scope Fixture')
    git(outer, 'config', 'user.email', 'git-scope@example.invalid')
    git(outer, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(outer, '.gitignore'), '/workspaces/\n')
    writeFileSync(join(outer, 'outer-tracked.txt'), 'host baseline\n')
    git(outer, 'add', '.')
    git(outer, 'commit', '-m', 'host repository fixture')
    writeFileSync(join(outer, 'outer-tracked.txt'), 'host modification must remain outside the tenant\n')
    writeFileSync(join(outer, 'outer-untracked.txt'), 'host untracked file must not be staged\n')
    outerStatus = git(outer, 'status', '--porcelain=v1', '--untracked-files=all')
    outerIndex = git(outer, 'ls-files', '--stage')
    expect(outerStatus).toBe(' M outer-tracked.txt\n?? outer-untracked.txt\n')

    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    const engineOutput: string[] = []
    engine = spawn(process.execPath, [join(engineRoot, 'dist/main.js')], {
      cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...environment, AUTH_ENABLED: 'true', AETHER_INSTANCE_TOKEN: instance,
        ENCRYPTION_KEY: 'd'.repeat(64), AETHER_ACCOUNT_REGISTRATION: 'true', AETHER_ACCOUNT_PROVIDERS_JSON: '[]',
        PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(fixture, 'engine.db'),
        MEMORY_DB_PATH: join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: join(fixture, 'global'),
        WORKSPACE_ROOT: join(outer, 'workspaces'), AETHER_ALLOWED_WORKSPACE_ROOTS: '',
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    engineClosed = new Promise<void>(done => engine!.once('close', () => done()))
    engine.stdout?.on('data', value => { engineOutput.push(String(value)); if (engineOutput.length > 100) engineOutput.shift() })
    engine.stderr?.on('data', value => { engineOutput.push(String(value)); if (engineOutput.length > 100) engineOutput.shift() })
    await expect.poll(async () => {
      if (engine?.exitCode !== null) throw new Error('Git fixture engine exited: ' + engineOutput.join('').slice(-3000))
      return fetch(url + '/health').then(response => response.status).catch(() => 0)
    }, { timeout: 90_000 }).toBe(200)

    const profile = join(fixture, 'desktop')
    mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: url, remoteWorkspaceRoot: '',
      autoStartEngine: false, lastFolder: '', lastSessionId: 'git-workspace-scope-session'
    }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...environment, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance } })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
  })

  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    try { await app?.close() } finally { await stopEngine() }
    if (!fixture) return
    const child = relative(fixtures, fixture)
    if (dirname(fixture) !== fixtures || !child.startsWith('git-workspace-scope-') || child.includes(sep)) {
      throw new Error('Unsafe Git scope fixture cleanup')
    }
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('一键登录的空资源树不会展示外层宿主仓库的变更', async () => {
    await page.getByRole('button', { name: '登录账号', exact: true }).click()
    await page.getByRole('button', { name: '一键登录', exact: true }).click()
    const onboarding = page.getByRole('dialog', { name: '完善个人资料', exact: true })
    await expect(onboarding).toBeVisible()
    await onboarding.getByRole('button', { name: '暂时跳过', exact: true }).click()
    const account = await page.evaluate(() => window.aether.account.getState())
    expect(account.status).toBe('authenticated')
    originalAccount = account.user!.id
    originalTenant = account.user!.tenantId
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
    await showExplorer()
    originalRoot = await tenantRoot(originalTenant)
    await expect(page.locator('.explorer__hint')).toContainText('目录为空')
    expect(await status(originalRoot)).toMatchObject({ success: true, isRepo: false, files: [] })
    await showGit()
    await expect(page.locator('.git-panel')).toContainText('当前目录不是 Git 仓库')
    await expect(page.locator('.git-row')).toHaveCount(0)
    expect(existsSync(join(originalRoot, '.git'))).toBe(false)
    assertOuterUnchanged()
  })

  test('初始化当前租户仓库后，远端新增文件在资源树和 Git 中一致', async () => {
    await page.getByRole('button', { name: '初始化 Git 仓库', exact: true }).click()
    await expect.poll(() => existsSync(join(originalRoot, '.git'))).toBe(true)
    expect(resolve(git(originalRoot, 'rev-parse', '--show-toplevel').trim())).toBe(resolve(originalRoot))
    writeFileSync(join(originalRoot, 'tenant-only.txt'), 'belongs to the first tenant\n')
    writeFileSync(join(originalRoot, 'still-untracked.txt'), 'not staged yet\n')
    await showExplorer()
    await expect.poll(() => page.locator('.explorer__tree .tree-row__name').allTextContents(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['tenant-only.txt', 'still-untracked.txt']))
    await expect(page.locator('.explorer__tree')).not.toContainText('outer-tracked.txt')
    await showGit()
    await expect(page.locator('.git-row[title="tenant-only.txt"]')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.git-row[title="still-untracked.txt"]')).toHaveCount(1)
    const beforeStage = await status(originalRoot)
    expect(beforeStage.files?.map(file => file.path).sort()).toEqual(['still-untracked.txt', 'tenant-only.txt'])
    for (const file of beforeStage.files!) expect(file).toMatchObject({ staged: false, stagedChange: null, unstagedChange: 'untracked' })
    await expect(page.locator('.git-panel__group-head').filter({ hasText: '暂存的更改' })).toHaveCount(0)
    assertOuterUnchanged()
  })

  test('暂存只修改租户 index，未跟踪文件不会同时重复进入暂存分组', async () => {
    const row = page.locator('.git-row[title="tenant-only.txt"]')
    await row.hover()
    await row.getByRole('button', { name: '暂存', exact: true }).click()
    await expect.poll(() => git(originalRoot, 'ls-files', '--cached')).toBe('tenant-only.txt\n')
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('button', { name: '取消暂存', exact: true })).toHaveCount(1)
    const staged = page.locator('.git-panel__section').filter({ has: page.locator('.git-panel__group-head').filter({ hasText: '暂存的更改' }) })
    await expect(staged.locator('.git-row__name')).toHaveText(['tenant-only.txt'])
    await expect(page.locator('.git-row[title="still-untracked.txt"]')).toHaveCount(1)
    const result = await status(originalRoot)
    expect(result.files?.find(file => file.path === 'tenant-only.txt')).toMatchObject({ staged: true, stagedChange: 'added', unstagedChange: null })
    expect(result.files?.find(file => file.path === 'still-untracked.txt')).toMatchObject({ staged: false, stagedChange: null, unstagedChange: 'untracked' })
    assertOuterUnchanged()
  })

  test('停留 Git 面板时外部新增和修改自动刷新，已有暂存状态保留', async () => {
    await expect(page.locator('.git-panel')).toBeVisible()
    writeFileSync(join(originalRoot, 'git-live.txt'), 'created while Git is visible\n')
    writeFileSync(join(originalRoot, 'tenant-only.txt'), 'modified after staging\n')
    await expect(page.locator('.git-row[title="git-live.txt"]')).toHaveCount(1, { timeout: 20_000 })
    // A staged file modified again legitimately appears once in each group;
    // the previous test distinguishes this from duplicating a ?? file.
    await expect(page.locator('.git-row[title="tenant-only.txt"]')).toHaveCount(2, { timeout: 20_000 })
    const result = await status(originalRoot)
    expect(result.files?.find(file => file.path === 'tenant-only.txt')).toMatchObject({ staged: true, stagedChange: 'added', unstagedChange: 'modified' })
    expect(git(originalRoot, 'show', ':0:tenant-only.txt')).toBe('belongs to the first tenant\n')
    await showExplorer()
    await expect.poll(() => page.locator('.explorer__tree .tree-row__name').allTextContents(), { timeout: 20_000 })
      .toContain('git-live.txt')
    await showGit()
    assertOuterUnchanged()
  })

  test('同一远端切换账号后，Git 和资源树清空旧账号文件并挂载新工作区', async () => {
    await page.evaluate(() => window.aether.account.logout())
    await expect(page.locator('.git-row')).toHaveCount(0)
    const account = await page.evaluate(() => window.aether.account.register())
    expect(account.status).toBe('authenticated')
    expect(account.user!.id).not.toBe(originalAccount)
    expect(account.user!.tenantId).not.toBe(originalTenant)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
    await showExplorer()
    const nextRoot = await tenantRoot(account.user!.tenantId)
    expect(nextRoot).not.toBe(originalRoot)
    await expect(page.locator('.explorer__hint')).toContainText('目录为空')
    await expect(page.locator('.explorer__tree')).not.toContainText('tenant-only.txt')
    expect(await status(nextRoot)).toMatchObject({ success: true, isRepo: false, files: [] })
    await showGit()
    await expect(page.locator('.git-panel')).toContainText('当前目录不是 Git 仓库')
    await expect(page.locator('.git-row')).toHaveCount(0)
    expect(git(originalRoot, 'ls-files', '--cached')).toBe('tenant-only.txt\n')
    assertOuterUnchanged()
  })
})
