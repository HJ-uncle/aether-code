/** Every case owns a new project and local bare remote. UI actions use the real
 * Electron/engine transport; CLI commands only arrange fixtures or verify disk.
 * Projects and evidence remain under .e2e-tmp for the requested manual review. */
import { _electron as electron, test as base, expect, type ElectronApplication, type Page, type Locator, type TestInfo } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { engineStorageKey, sessionStorageKey } from '../../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './electron-health'

export { expect }
const appRoot = resolve(__dirname, '../..')
const engineRoot = resolve(appRoot, '../ai-agent-engine')
const fixtureRoot = join(appRoot, '.e2e-tmp')

interface MenuProbe { active: number; actions: Array<Record<string, unknown>> }
type ProbeGlobal = typeof globalThis & { __gitMenuProbe: MenuProbe }
interface MenuWorker {
  root: string; baseUrl: string; app: ElectronApplication; page: Page
  health: ElectronHealthMonitor; errors: string[]; lastInfo?: TestInfo
  gitAt: (cwd: string, ...args: string[]) => string
}
export interface GitMenuHarness {
  root: string; repo: string; remote: string; peer: string; sessionId: string
  app: ElectronApplication; page: Page; panel: Locator
  git: (...args: string[]) => string
  gitAt: (cwd: string, ...args: string[]) => string
  write: (relative: string, content: string) => void
  commit: (relative: string, content: string, message: string) => string
  refresh: () => Promise<void>
  idle: () => Promise<void>
  action: (group: string, item: string) => Promise<void>
  prompt: (value: string) => Promise<void>
  pick: (label: string | RegExp) => Promise<void>
  confirm: (label?: string) => Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(done => server.close(() => done()))
  return port
}
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL',
    'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase()) || key.toUpperCase().startsWith('GIT_')) delete env[key]
  return env
}
async function stop(child: ChildProcess | undefined, closed: Promise<void> | undefined): Promise<void> {
  if (!child || !closed) return
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000)
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed }
  finally { clearTimeout(timer) }
}

export const test = base.extend<{ menu: GitMenuHarness }, { menuWorker: MenuWorker }>({
  menuWorker: [async ({}, use) => {
    mkdirSync(fixtureRoot, { recursive: true })
    const runRoot = process.env.AETHER_GIT_MENU_RUN_DIR || mkdtempSync(join(fixtureRoot, 'git-menu-acceptance-'))
    mkdirSync(runRoot, { recursive: true })
    const root = mkdtempSync(join(runRoot, 'worker-'))
    const gitConfig = join(root, 'gitconfig')
    writeFileSync(gitConfig, '')
    const env = { ...environment(), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git',
      ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args],
      { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
    const baseUrl = `http://127.0.0.1:${await freePort()}`
    const token = `menu-acceptance-${randomUUID()}`
    const logs: string[] = []
    let app: ElectronApplication | undefined
    let worker: MenuWorker | undefined
    const engine = spawn(process.execPath, [join(engineRoot, 'dist/main.js')], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, ENCRYPTION_KEY: 'e'.repeat(64),
        HOST: '127.0.0.1', PORT: new URL(baseUrl).port, DATA_DIR: join(root, 'engine.db'),
        MEMORY_DB_PATH: join(root, 'memory.db'), AETHER_GLOBAL_DIR: join(root, 'engine-global'),
        WORKSPACE_ROOT: root, AETHER_ALLOWED_WORKSPACE_ROOTS: root, MCP_CONFIG_PATH: join(root, 'mcp.json'),
        SKILLS_ROOT: join(root, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
    })
    const closed = new Promise<void>(done => engine.once('close', () => done()))
    const remember = (chunk: Buffer): void => { logs.push(String(chunk)); if (logs.length > 100) logs.shift() }
    engine.stdout?.on('data', remember); engine.stderr?.on('data', remember)
    try {
      await expect.poll(async () => {
        if (engine.exitCode !== null) throw new Error(`Menu fixture engine exited: ${logs.join('').slice(-3000)}`)
        return fetch(baseUrl + '/health').then(response => response.status).catch(() => 0)
      }, { timeout: 90_000 }).toBe(200)
      const profile = join(root, 'desktop')
      mkdirSync(profile)
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl,
        remoteWorkspaceRoot: '', autoStartEngine: true, lastSessionId: '', lastFolder: '', appearance: 'dark' }))
      app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: appRoot,
        env: { ...env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(root, 'desktop-global') } })
      const page = await app.firstWindow()
      const health = await monitorElectronHealth(app, 'git-menu-acceptance', [token])
      worker = { root, baseUrl, app, page, health, errors: [], gitAt }
      page.on('pageerror', error => { worker!.errors.push(error.stack || error.message) })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
      await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot().then(value => value.phase)), { timeout: 30_000 }).toBe('ready')
      await app.evaluate(() => {
        const global = globalThis as ProbeGlobal
        global.__gitMenuProbe = { active: 0, actions: [] }
        const original = globalThis.fetch
        globalThis.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input))
          const observed = url.pathname.startsWith('/api/v1/git/') || url.pathname === '/api/v1/workspace/bind'
          if (!observed) return original(input, init)
          global.__gitMenuProbe.active++
          let action: Record<string, unknown> | undefined
          if (url.pathname === '/api/v1/git/action' && typeof init?.body === 'string') {
            const body = JSON.parse(init.body) as Record<string, unknown>
            action = { ...body, startedAt: Date.now() }
            global.__gitMenuProbe.actions.push(action)
          }
          try {
            const result = await original(input, init)
            if (action) { action.httpStatus = result.status; action.finishedAt = Date.now() }
            return result
          } finally { global.__gitMenuProbe.active-- }
        }
      })
      console.log(`GIT_MENU_TEST_PROJECT ${root}`)
      await use(worker)
    } finally {
      try {
        if (worker?.lastInfo) await worker.health.closeAndAssert(worker.lastInfo)
        else await app?.close()
      } finally {
        await stop(engine, closed)
        writeFileSync(join(root, 'engine-tail.log'), logs.join('').replaceAll(token, '[REDACTED]'))
      }
    }
  }, { scope: 'worker', timeout: 120_000 }],

  menu: async ({ menuWorker: worker }, use, info) => {
    worker.lastInfo = info
    worker.errors.length = 0
    const slug = info.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 90)
    const root = mkdtempSync(join(worker.root, `${slug}-`))
    const repo = join(root, 'project'), remote = join(root, 'origin.git'), peer = join(root, 'peer')
    mkdirSync(repo); mkdirSync(remote)
    const gitAt = worker.gitAt, git = (...args: string[]): string => gitAt(repo, ...args)
    git('init', '-b', 'main'); git('config', 'user.name', 'Git Menu Acceptance'); git('config', 'user.email', 'git-menu@example.invalid')
    git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgSign', 'false')
    const write = (file: string, content: string): void => { const target = join(repo, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content) }
    const commit = (file: string, content: string, message: string): string => { write(file, content); git('add', '--', file); git('commit', '-m', message); return git('rev-parse', 'HEAD') }
    write('tracked.txt', 'baseline\n'); write('other.txt', 'second\n'); git('add', '.'); git('commit', '-m', 'Git menu baseline')
    gitAt(remote, 'init', '--bare', '-b', 'main'); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main')
    gitAt(root, 'clone', remote, peer); gitAt(peer, 'config', 'user.name', 'Git Menu Peer'); gitAt(peer, 'config', 'user.email', 'git-peer@example.invalid')
    const sessionId = `work-menu-${randomUUID()}`
    const { app, page } = worker
    const panel = page.locator('.work-view .git-panel')
    const key = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: worker.baseUrl }))
    await page.evaluate(({ key, sessionId, repo, title }) => {
      const now = Date.now()
      localStorage.setItem(key, JSON.stringify({ activeTaskId: sessionId, tasks: [{ id: sessionId, title, workspacePath: repo,
        status: 'draft', draft: '', createdAt: now, updatedAt: now, modelId: '', attachments: [], sources: [] }] }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether:git:autoFetch:enabled', '0')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: true, tab: 'git', pane: 'workspace', ratio: 40 }))
    }, { key, sessionId, repo, title: info.title })
    await page.reload()
    await expect(panel.locator('.git-branchbar__name')).toHaveText('main', { timeout: 20_000 })
    const idle = async (): Promise<void> => {
      await expect(panel.getByTitle('刷新', { exact: true })).toBeEnabled()
      await expect(panel.locator('.git-commitbar__input')).toBeEnabled()
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__gitMenuProbe.active)).toBe(0)
    }
    await idle()
    await app.evaluate(() => { (globalThis as ProbeGlobal).__gitMenuProbe.actions = [] })
    const entries: Array<{ group: string; item: string }> = []
    const menu: GitMenuHarness = {
      root, repo, remote, peer, sessionId, app, page, panel, git, gitAt, write, commit, idle,
      refresh: async () => { await idle(); await panel.getByTitle('刷新', { exact: true }).click(); await idle() },
      action: async (group, item) => {
        await idle()
        await panel.getByTitle('更多操作', { exact: true }).click()
        await page.getByRole('menuitem', { name: `${group} ›`, exact: true }).hover()
        const selected = page.getByRole('menuitem', { name: item, exact: true })
        await expect(selected).toBeEnabled()
        await expect(selected).toBeVisible()
        await expect(page.locator('.context-menu--submenu')).toHaveCSS('opacity', '1')
        await expect.poll(() => selected.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= -4 && rect.top >= -4 && rect.right <= innerWidth + 4 && rect.bottom <= innerHeight + 4
        })).toBe(true)
        await page.screenshot({ path: join(root, `menu-${entries.length + 1}.png`) })
        await selected.click()
        entries.push({ group, item })
      },
      prompt: async value => {
        const dialog = page.locator('[role="dialog"].modal--prompt:visible').last()
        await expect(dialog).toBeVisible()
        const input = dialog.locator('input')
        await input.fill(value)
        const original = await input.elementHandle()
        await dialog.locator('.modal__footer .btn--primary').click()
        // Prompts can immediately hand off to the next prompt; wait for this
        // instance to leave, without insisting every dialog has disappeared.
        try { await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false) }
        finally { await original?.dispose() }
      },
      pick: async label => {
        const dialog = page.locator('[role="dialog"].git-pickdlg:visible').last()
        await expect(dialog).toBeVisible()
        const pattern = typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : label
        await dialog.locator('.git-pickdlg__item-label').filter({ hasText: pattern }).click()
      },
      confirm: async (label = '删除') => {
        const dialog = page.getByRole('dialog').last()
        await expect(dialog).toBeVisible()
        await dialog.locator('.modal__footer').getByRole('button', { name: label, exact: true }).click()
      }
    }
    try { await use(menu) }
    finally {
      const actions = await app.evaluate(() => (globalThis as ProbeGlobal).__gitMenuProbe.actions)
      const evidence = { title: info.title, status: info.status, project: repo, remote, peer, sessionId, entries, actions,
        head: git('rev-parse', 'HEAD'), refs: git('show-ref'), statusText: git('status', '--porcelain=v1'),
        stashes: git('stash', 'list'), alerts: await panel.getByRole('alert').allTextContents(), rendererErrors: [...worker.errors] }
      const evidencePath = join(root, 'evidence.json')
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
      await page.screenshot({ path: join(root, 'result.png') })
      await info.attach('git-menu-evidence', { path: evidencePath, contentType: 'application/json' })
      await info.attach('git-menu-result', { path: join(root, 'result.png'), contentType: 'image/png' })
      if (info.status === 'passed') {
        expect(entries.length, 'the tested action must use the visible menu').toBeGreaterThan(0)
        if (entries.some(entry => entry.item !== '查看存储详情…'))
          expect(actions.length, 'menu mutations must use the real Work Git HTTP transport').toBeGreaterThan(0)
      }
      for (const action of actions) {
        expect(action.sessionId).toBe(sessionId)
        expect(String(action.expectedRoot).replace(/\\/g, '/').toLowerCase()).toBe(repo.replace(/\\/g, '/').toLowerCase())
        expect(action.bindingEpoch).toEqual(expect.any(String))
      }
      worker.health.assertHealthy()
      expect(worker.errors).toEqual([])
    }
  }
})
