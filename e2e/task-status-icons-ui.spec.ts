/** Task status semantics and real Electron sidebar/home rendering in both themes.
 * An isolated profile keeps the engine stopped; seeded local tasks cannot issue
 * model calls or modify a user's account, workspace or task history. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { workSidebarStatus } from '../src/renderer/src/contrib/work/work-sidebar-task'
import type { WorkTask, WorkTaskStatus } from '../src/renderer/src/contrib/work/work-state'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const now = Date.now()
const task = (status: WorkTaskStatus, patch: Partial<WorkTask> = {}): WorkTask => ({
  id: `work-status-icon-${status}`, title: `图标核对 ${status}`, draft: '', status, createdAt: now, updatedAt: now,
  workspacePath: null, modelId: '', attachments: [], sources: [], ...patch
})
const tasks = (['error', 'interrupted', 'done', 'running', 'waiting', 'stopped', 'draft'] as const).map(status => task(status))

test('异常状态使用圆圈感叹号，完成保留勾号', () => {
  for (const status of ['error', 'interrupted'] as const) {
    for (const ready of [false, true]) expect(workSidebarStatus(task(status), ready)).toMatchObject({ kind: status, icon: 'alert-circle' })
  }
  for (const status of ['running', 'waiting'] as const) {
    expect(workSidebarStatus(task(status), false)).toMatchObject({ kind: 'disconnected', icon: 'alert-circle', label: '连接中断，等待恢复确认' })
  }
  for (const ready of [false, true]) expect(workSidebarStatus(task('done'), ready)).toEqual({ kind: 'done', label: '已完成', icon: 'check' })
})

test('运行、等待回答、等待授权和停止的状态表达保持独立', () => {
  expect(workSidebarStatus(task('running'), true)).toEqual({ kind: 'running', label: '运行中', active: true })
  expect(workSidebarStatus(task('running'), false, true)).toEqual({ kind: 'stopping', label: '正在停止', active: true })
  expect(workSidebarStatus(task('waiting'), true)).toMatchObject({ kind: 'question', icon: 'chat' })
  expect(workSidebarStatus(task('waiting', { activity: { runId: 'permission-run', seq: 1, version: 1,
    status: 'waiting', updatedAt: now, pendingAsk: 0, pendingPermission: 1 } }), true)).toMatchObject({ kind: 'permission', icon: 'shield' })
  expect(workSidebarStatus(task('stopped'), true)).toMatchObject({ kind: 'stopped', icon: 'stop' })
})

test.describe.serial('任务状态图标真机回归', () => {
  const errors: string[] = []
  let app: ElectronApplication | undefined, page: Page, fixture = ''
  const work = () => page.locator('#mode-work')
  const sidebarStatus = (status: WorkTaskStatus) => work().locator(`[data-task-id="work-status-icon-${status}"] .work-sidebar__task-status`)
  const homeStatus = (status: WorkTaskStatus) => work().locator('.work-task-row').filter({ hasText: `图标核对 ${status}` }).locator('.work-status')

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

  for (const appearance of ['dark', 'light'] as const) test(`${appearance}：侧栏和首页异常为圆圈感叹号，完成仍为勾号`, async ({}, info) => {
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '外观', exact: true }).click()
    await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    for (const status of ['error', 'interrupted', 'running', 'waiting'] as const) {
      const expected = status === 'running' || status === 'waiting' ? 'disconnected' : status
      await expect(sidebarStatus(status)).toHaveAttribute('data-task-status', expected)
      for (const icon of [sidebarStatus(status), homeStatus(status)]) {
        await expect(icon).toBeVisible()
        await expect(icon.locator('svg circle')).toHaveCount(1)
        await expect(icon.locator('svg path')).toHaveCount(2)
      }
    }
    await expect(sidebarStatus('done')).toHaveAttribute('aria-label', '已完成')
    for (const icon of [sidebarStatus('done'), homeStatus('done')]) {
      await expect(icon.locator('svg circle')).toHaveCount(0)
      await expect(icon.locator('svg path')).toHaveAttribute('d', /^M9\.55 17\.05/)
    }
    const path = info.outputPath(`task-status-icons-${appearance}.png`)
    await page.screenshot({ path }); await info.attach(`任务状态图标-${appearance}`, { path, contentType: 'image/png' })
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('aether.work.state.v1') ?? '{}') as { tasks: WorkTask[] })
    expect(stored.tasks.map(({ id, status }) => ({ id, status }))).toEqual(tasks.map(({ id, status }) => ({ id, status })))
  })
})
