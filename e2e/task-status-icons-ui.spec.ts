/** Task status semantics and real Electron sidebar/home rendering in both themes.
 * An isolated profile keeps the engine stopped; seeded local tasks cannot issue
 * model calls or modify a user's account, workspace or task history. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { sessionSidebarStatus } from '../src/renderer/src/features/sessions/sidebar-task'
import type { SessionTask, TaskStatus } from '../src/renderer/src/features/sessions/state'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const now = Date.now()
const task = (status: TaskStatus, patch: Partial<SessionTask> = {}): SessionTask => ({
  id: `work-status-icon-${status}`, title: `图标核对 ${status}`, draft: '', status, createdAt: now, updatedAt: now,
  workspacePath: null, modelId: '', attachments: [], sources: [], ...patch
})
const tasks = (['error', 'interrupted', 'done', 'running', 'waiting', 'stopped', 'draft'] as const).map(status => task(status))

test('异常状态保留警示语义，完成状态保持独立', () => {
  for (const status of ['error', 'interrupted'] as const) {
    for (const ready of [false, true]) expect(sessionSidebarStatus(task(status), ready)).toMatchObject({ kind: status, icon: 'alert-circle' })
  }
  for (const status of ['running', 'waiting'] as const) {
    expect(sessionSidebarStatus(task(status), false)).toMatchObject({ kind: 'disconnected', icon: 'alert-circle', label: '连接中断，等待恢复确认' })
  }
  for (const ready of [false, true]) expect(sessionSidebarStatus(task('done'), ready)).toEqual({ kind: 'done', label: '已完成' })
})

test('运行、等待回答、等待授权和停止的状态表达保持独立', () => {
  expect(sessionSidebarStatus(task('running'), true)).toEqual({ kind: 'running', label: '运行中', active: true })
  expect(sessionSidebarStatus(task('running'), false, true)).toEqual({ kind: 'stopping', label: '正在停止', active: true })
  expect(sessionSidebarStatus(task('waiting'), true)).toMatchObject({ kind: 'question', icon: 'chat' })
  expect(sessionSidebarStatus(task('waiting', { activity: { runId: 'permission-run', seq: 1, version: 1,
    status: 'waiting', updatedAt: now, pendingAsk: 0, pendingPermission: 1 } }), true)).toMatchObject({ kind: 'permission', icon: 'shield' })
  expect(sessionSidebarStatus(task('stopped'), true)).toEqual({ kind: 'stopped', label: '已停止' })
})

async function expectStatusGlyph(status: Locator, name: 'alert-circle' | 'check'): Promise<void> {
  const icon = status.locator('svg[data-icon]')
  await expect(icon).toHaveCount(1)
  await expect(icon).toHaveAttribute('data-icon', name)
  await expect(icon).toHaveAttribute('data-icon-style', 'outline')
  await expect(icon).toHaveAttribute('aria-hidden', 'true')
  const shapes = await icon.locator('path, circle, line, polyline').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element)
    return { fill: style.fill, stroke: style.stroke, width: Number.parseFloat(style.strokeWidth), cap: style.strokeLinecap, join: style.strokeLinejoin }
  }))
  expect(shapes.length).toBeGreaterThan(0)
  for (const shape of shapes) {
    expect(shape.fill).toBe('none'); expect(shape.stroke).not.toBe('none')
    expect(shape.width).toBeCloseTo(1.5, 2); expect(shape.cap).toBe('round'); expect(shape.join).toBe('round')
  }
}

test.describe.serial('任务状态图标真机回归', () => {
  const errors: string[] = []
  let app: ElectronApplication | undefined, page: Page, fixture = ''
  const work = () => page.locator('.work-view')
  const sidebarStatus = (status: TaskStatus) => work().locator(`[data-task-id="work-status-icon-${status}"] .work-sidebar__task-status`)
  const homeStatus = (status: TaskStatus) => work().locator('.work-task-row').filter({ hasText: `图标核对 ${status}` }).locator('.work-status')

  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'task-status-icons-profile-'))
    const profile = join(fixture, 'profile'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded',
      lastFolder: '', lastSessionId: '', appearance: 'dark' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.workbench')).toBeVisible()
    await page.evaluate(tasks => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks, activeTaskId: null }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false }))
    }, tasks)
    await page.reload(); await expect(work()).toBeVisible()
    await expect(sidebarStatus('error')).toBeVisible()
  })

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('task-status-icons-failure.png')
      await page.screenshot({ path }); await info.attach('任务状态图标失败窗口', { path, contentType: 'image/png' })
    }
    expect(errors).toEqual([])
  })

  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('task-status-icons-profile-')) throw new Error(`Unsafe task-status-icons cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  for (const appearance of ['dark', 'light'] as const) test(`${appearance}：侧栏和首页状态语义一致，异常与完成图标保持独立`, async ({}, info) => {
    await expect(page.locator('.work-settings-dialog')).toHaveCount(0)
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('tab', { name: '外观', exact: true }).click()
    await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    // Hidden/inert leaves the accessibility tree before the exit callback unmounts the dialog.
    await expect(page.locator('.modal-overlay')).toHaveCount(0)
    for (const status of ['error', 'interrupted', 'running', 'waiting'] as const) {
      const expected = status === 'running' || status === 'waiting' ? 'disconnected' : status
      await expect(sidebarStatus(status)).toHaveAttribute('data-task-status', expected)
      await expect(sidebarStatus(status)).toHaveAttribute('role', 'img')
      await expect(sidebarStatus(status)).toHaveAttribute('aria-label', expected === 'error' ? '执行失败'
        : expected === 'interrupted' ? '执行已中断' : '连接中断，等待恢复确认')
      await expect(sidebarStatus(status)).toHaveText(expected === 'error' ? '失败' : expected === 'interrupted' ? '已中断' : '连接中断')
      await expect(homeStatus(status)).toBeVisible()
      await expect(homeStatus(status)).toContainText(status === 'error' ? '执行失败' : '连接中断')
      await expectStatusGlyph(homeStatus(status), 'alert-circle')
    }
    // Read completions stay quiet in the compact sidebar; the home list carries the explicit result.
    await expect(sidebarStatus('done')).toHaveCount(0)
    await expect(homeStatus('done')).toContainText('已完成')
    await expectStatusGlyph(homeStatus('done'), 'check')
    const path = info.outputPath(`task-status-icons-${appearance}.png`)
    await page.screenshot({ path }); await info.attach(`任务状态图标-${appearance}`, { path, contentType: 'image/png' })
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('aether.work.state.v1') ?? '{}') as { tasks: SessionTask[] })
    expect(stored.tasks.map(({ id, status }) => ({ id, status }))).toEqual(tasks.map(({ id, status }) => ({ id, status })))
  })
})
