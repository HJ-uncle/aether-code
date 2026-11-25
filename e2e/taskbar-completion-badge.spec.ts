/**
 * Work completion notifications must reach the native application icon. This
 * suite patches Electron's platform badge seam, then drives the real renderer
 * through the same completion-read path a user uses in the sidebar.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { normalizeTaskbarBadgeCount, taskbarBadgeText, unreadCompletedTaskCount } from '../src/shared/taskbar'
import type { SessionTask } from '../src/renderer/src/features/sessions/state'

test.describe('Work 完成任务栏标记', () => {
  test('只统计未归档且未查看的已完成任务', () => {
    expect(unreadCompletedTaskCount([
      { status: 'done', completionUnread: true, archived: false },
      { status: 'done', completionUnread: true, archived: true },
      { status: 'done', completionUnread: false, archived: false },
      { status: 'running', completionUnread: true, archived: false }
    ])).toBe(1)
  })

  test('只显示非负整数，超过 99 个时收敛为 99+', () => {
    expect(normalizeTaskbarBadgeCount(-1)).toBe(0)
    expect(normalizeTaskbarBadgeCount(Number.NaN)).toBe(0)
    expect(normalizeTaskbarBadgeCount(2.9)).toBe(2)
    expect(normalizeTaskbarBadgeCount(99)).toBe(99)
    expect(normalizeTaskbarBadgeCount(120)).toBe(99)
    expect(taskbarBadgeText(0)).toBe('0')
    expect(taskbarBadgeText(4)).toBe('4')
    expect(taskbarBadgeText(120)).toBe('99+')
  })

  test.describe.serial('真实 Electron 任务栏同步', () => {
    const root = resolve(__dirname, '..')
    const temporaryRoot = join(root, '.e2e-tmp', 'taskbar-completion-badge')
    const now = Date.now()
    const tasks: SessionTask[] = [
      { id: 'work-taskbar-badge-a', title: '任务栏标记 A', draft: '', status: 'done', completionUnread: true,
        createdAt: now, updatedAt: now, workspacePath: null, modelId: '', attachments: [], sources: [] },
      { id: 'work-taskbar-badge-b', title: '任务栏标记 B', draft: '', status: 'done', completionUnread: true,
        createdAt: now + 1, updatedAt: now + 1, workspacePath: null, modelId: '', attachments: [], sources: [] }
    ]
    let app: ElectronApplication | undefined
    let page: Page
    let fixture = ''
    const pageErrors: string[] = []

    const badgeCalls = (): Promise<Array<{ kind: string; value: string | number; description?: string }>> =>
      app!.evaluate(() => (globalThis as typeof globalThis & {
        __taskbarBadge?: { calls: Array<{ kind: string; value: string | number; description?: string }> }
      }).__taskbarBadge?.calls ?? [])

    const lastBadge = async (): Promise<{ kind: string; value: string | number; description?: string } | undefined> => {
      const calls = await badgeCalls()
      return calls.at(-1)
    }

    test.beforeAll(async () => {
      mkdirSync(temporaryRoot, { recursive: true })
      fixture = mkdtempSync(join(temporaryRoot, 'profile-'))
      const profile = join(fixture, 'user-data')
      mkdirSync(profile)
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: '', lastSessionId: '', appearance: 'dark' }))
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
      for (const key of Object.keys(env)) {
        if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN',
          'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
      }
      env.AETHER_GLOBAL_DIR = join(fixture, 'global')
      app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
      page = await app.firstWindow()
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('crash', () => pageErrors.push('Renderer crashed'))
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(1440, 900)
        window.show()
        window.focus()
      })
      await expect(page.locator('.workbench')).toBeVisible()
      await app.evaluate(async ({ BrowserWindow, app: electronApp, ipcMain }) => {
        const globals = globalThis as typeof globalThis & {
          __taskbarBadge: { calls: Array<{ kind: string; value: string | number; description?: string }> }
          __taskbarOriginalHandler?: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
          __taskbarThemeCalls: Array<{ count: number; appearance: string }>
        }
        globals.__taskbarBadge = { calls: [] }
        globals.__taskbarThemeCalls = []
        const channel = 'window:set-completion-badge'
        const original = ipcMain._invokeHandlers.get(channel)
        globals.__taskbarOriginalHandler = original
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, count: number, appearance: string) => {
          if (globals.__taskbarThemeCalls) globals.__taskbarThemeCalls.push({ count, appearance })
          globals.__taskbarBadge.calls.push({ kind: 'overlay', value: count > 0 ? 'set' : 'clear', description: `${count}` })
          return original?.(event, count, appearance)
        })
        if (process.platform === 'win32') {
          Object.defineProperty(BrowserWindow.prototype, 'setOverlayIcon', {
            configurable: true,
            value: () => undefined
          })
        } else if (process.platform === 'darwin' && electronApp.dock) {
          Object.defineProperty(electronApp.dock, 'setBadge', {
            configurable: true,
            value: (label: string) => globals.__taskbarBadge.calls.push({ kind: 'dock', value: label })
          })
        } else if (process.platform === 'linux') {
          Object.defineProperty(electronApp, 'setBadgeCount', {
            configurable: true,
            value: (count: number) => {
              globals.__taskbarBadge.calls.push({ kind: 'linux', value: count })
              return true
            }
          })
        }
      })
      await page.evaluate(seed => {
        localStorage.setItem('aether.app.mode', 'work')
        localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: seed, activeTaskId: null }))
        localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
      }, tasks)
      await page.reload()
      await expect(page.locator('.work-view')).toBeVisible()
      await expect(page.locator('.work-sidebar__task-row[data-task-id="work-taskbar-badge-a"]')).toBeVisible()
    })

    test.afterEach(async ({}, info) => {
      if (info.status !== info.expectedStatus && page && !page.isClosed()) {
        const path = info.outputPath('taskbar-completion-badge-failure.png')
        await page.screenshot({ path })
        await info.attach('任务栏完成标记失败窗口', { path, contentType: 'image/png' })
      }
      expect(pageErrors).toEqual([])
    })

    test.afterAll(async () => {
      try { await app?.close() }
      finally {
        if (fixture) {
          const target = resolve(fixture)
          if (dirname(target) !== temporaryRoot || !basename(target).startsWith('profile-')) throw new Error(`Unsafe taskbar badge cleanup: ${target}`)
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      }
    })

    test('未读数不变时，切换深浅主题仍重新提交角标', async () => {
      await expect.poll(async () => (await lastBadge())?.description).toBe('2')
      await page.getByRole('complementary', { name: '应用导航', exact: true }).getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      for (const appearance of ['light', 'dark', 'light']) {
        await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
        await expect.poll(async () => app!.evaluate(() => (globalThis as typeof globalThis & {
          __taskbarThemeCalls: Array<{ count: number; appearance: string }>
        }).__taskbarThemeCalls.at(-1))).toEqual({ count: 2, appearance })
      }
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
    })

    test('未读完成数显示在原生应用图标，打开会话后同步减少并清空', async () => {
      await expect.poll(async () => (await lastBadge())?.value).toBe(process.platform === 'win32' ? 'set' : process.platform === 'darwin' ? '2' : 2)
      const initial = await lastBadge()
      if (process.platform === 'win32') expect(initial?.description ?? '').toContain('2')

      await page.locator('.work-sidebar__task-row[data-task-id="work-taskbar-badge-a"] > button.work-sidebar__task').click()
      await expect.poll(async () => (await lastBadge())?.value).toBe(process.platform === 'win32' ? 'set' : process.platform === 'darwin' ? '1' : 1)

      await page.locator('.work-sidebar__task-row[data-task-id="work-taskbar-badge-b"] > button.work-sidebar__task').click()
      await expect.poll(async () => (await lastBadge())?.value).toBe(process.platform === 'win32' ? 'clear' : process.platform === 'darwin' ? '' : 0)
    })
  })
})



