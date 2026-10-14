/** Actual Electron toolbar overflow, keyboard reachability and real command
 * execution. Remote HTTP is an authenticated no-model fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
declare global { interface Window { aether: AetherIdeApi } }

const appRoot = resolve(__dirname, '..'), token = 'owned-titlebar-no-model'
let server: Server, app: ElectronApplication, page: Page, fixture: string
const errors: string[] = [], consoleErrors: string[] = []
let hostExit: { code: number | null; signal: string | null } | undefined
const hash = (file: string): string | null => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
const sourceFiles = ['src/renderer/src/workbench/MenuBar.tsx', 'src/renderer/src/workbench/menu-bar.css']
let sourceHashes: (string | null)[] = []

test.beforeAll(async () => {
  sourceHashes = sourceFiles.map(file => hash(join(appRoot, file)))
  const tmp = join(appRoot, '.e2e-tmp'); mkdirSync(tmp, { recursive: true })
  fixture = mkdtempSync(join(tmp, 'titlebar-responsive-'))
  server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    response.setHeader('content-type', 'application/json')
    if (pathname.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401); response.end(JSON.stringify({ code: 401, message: 'unauthorized', data: null })); return
    }
    const data = pathname === '/health' ? { status: 'ok' }
      : pathname === '/meta' ? { version: '1.0.0', buildId: `sha256:${'7'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'owned-titlebar-instance' }
      : pathname === '/api/v1/chat/status' ? { active: false }
      : pathname === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: 'persisted', sessionId: 'titlebar-owned', eventId: null, finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] }
      : pathname === '/api/v1/workspace/directory' ? { root: '', entries: [] }
      : pathname === '/api/v1/chat/runs' ? { runs: [] } : []
    response.end(JSON.stringify({ code: 200, message: 'ok', data }))
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, autoStartEngine: true, appearance: 'dark', lastFolder: '', remoteWorkspaceRoot: '' }))
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: appRoot,
    env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' } })
  app.process().once('exit', (code, signal) => { hostExit = { code, signal } })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
})
test.afterAll(async () => {
  await app?.close()
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  const stable = sourceFiles.every((file, index) => hash(join(appRoot, file)) === sourceHashes[index])
  await test.info().attach('titlebar-window-receipt', { body: JSON.stringify({ at: new Date().toISOString(), appRoot, fixture, sourceFiles, sourceHashes, stable, hostExit, errors, consoleErrors, models: 0, publicOutputsTouched: false }, null, 2), contentType: 'application/json' })
  if (fixture) {
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(appRoot, '.e2e-tmp') || !basename(absolute).startsWith('titlebar-responsive-')) throw new Error('Unsafe toolbar fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  expect(stable).toBe(true)
  expect(errors).toEqual([])
  expect(hostExit?.code).toBe(0)
})
async function resize(width: number, height = 620): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed())!
    win.setMinimumSize(0, 0); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}
async function geometry(): Promise<void> {
  const metrics = await page.locator('.menu-bar').evaluate(header => {
    const box = header.getBoundingClientRect()
    const controls = [...header.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(button => {
      const rect = button.getBoundingClientRect()
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), rows = new Set<number>()
      while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode)
        for (const line of range.getClientRects()) if (line.width > 0) rows.add(Math.round(line.top * 10))
      }
      return { label: button.textContent || button.getAttribute('aria-label'), textual: Boolean(button.textContent?.trim()), inside: rect.left >= box.left && rect.right <= box.right + 1 && rect.top >= box.top && rect.bottom <= box.bottom + 1,
        textRows: rows.size }
    })
    return { overflow: header.scrollWidth - header.clientWidth, controls }
  })
  expect(metrics.overflow).toBeLessThanOrEqual(1)
  expect(metrics.controls.filter(control => !control.inside), 'each toolbar action stays within the title bar').toEqual([])
  expect(metrics.controls.filter(control => control.textRows > 1), 'text controls stay on one line').toEqual([])
}

test('Code/Work toolbar keeps readable labels and complete controls in four widths and both appearances', async () => {
  for (const appearance of ['light', 'dark'] as const) {
    await page.evaluate(value => window.aether.settings.update({ appearance: value }), appearance)
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    for (const mode of ['Code 开发', 'Work 办公']) {
      await page.getByRole('tab', { name: mode, exact: true }).click()
      for (const width of [1440, 1024, 760, 620]) {
        await resize(width, 520); await geometry()
        await expect(page.getByRole('button', { name: '最小化', exact: true })).toBeVisible()
        if (width <= 1080) await expect(page.getByRole('button', { name: '应用菜单', exact: true })).toBeVisible()
        else await expect(page.getByRole('button', { name: '文件', exact: true })).toBeVisible()
        if (width === 760 || width === 620) await page.screenshot({ path: test.info().outputPath(`titlebar-${mode.startsWith('Code') ? 'code' : 'work'}-${width}-${appearance}.png`) })
      }
    }
  }
})
test('compact menu preserves command groups, keyboard focus and the real settings action', async () => {
  await page.getByRole('tab', { name: 'Code 开发', exact: true }).click(); await resize(760, 520)
  const trigger = page.getByRole('button', { name: '应用菜单', exact: true })
  await trigger.focus(); await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu', { name: '应用菜单', exact: true })
  await expect(menu.getByRole('group')).toHaveCount(5)
  await expect(menu.getByRole('menuitem', { name: /^打开文件夹/ })).toBeFocused()
  await page.keyboard.press('End'); await expect(menu.getByRole('menuitem', { name: /^重启引擎/ })).toBeFocused()
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: /^快速打开文件/ })).toBeFocused()
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused()
  await trigger.click(); await menu.getByRole('menuitem', { name: /^设置/ }).click()
  await expect(menu).toHaveCount(0); await expect(page.locator('.app-settings')).toBeVisible()
  await trigger.click(); await resize(1440); await expect(menu).toHaveCount(0)
  await page.getByRole('button', { name: '文件', exact: true }).click()
  await expect(page.getByRole('menu', { name: '文件', exact: true }).getByRole('menuitem', { name: /^保存/ })).toBeVisible()
  await page.keyboard.press('Escape')
})
