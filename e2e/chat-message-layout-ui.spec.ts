/** Real Electron chat regression: file-card defaults and keyboard toggles, long diff
 * rows, and task-tray/composer geometry across light/dark and narrow/wide panels.
 * History is served through the production remote snapshot API, not injected DOM. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import type { EngineFileChange, EngineTodo } from '../src/shared/ipc'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'chat-message-layout-fixture-token'
const sessionId = 'chat-message-layout-session'
const workspaceRoot = '/remote/chat-message-layout'
const longLine = `export const veryLongLine = '${'a'.repeat(240)}'`
const changes: EngineFileChange[] = [
  { id: 'new', path: `${workspaceRoot}/src/deeply/nested/new-file-with-a-long-name.ts`, displayPath: 'src/deeply/nested/new-file-with-a-long-name.ts', kind: 'write', oldContent: null, newContent: `${longLine}\nexport const second = 2\n`, isNew: true, truncated: false, status: 'kept', createdAt: 1 },
  { id: 'edit', path: `${workspaceRoot}/src/edit.ts`, displayPath: 'src/edit.ts', kind: 'write', oldContent: 'export const value = 1\n', newContent: 'export const value = 2\n', isNew: false, truncated: false, status: 'kept', createdAt: 2 },
  { id: 'delete', path: `${workspaceRoot}/src/deleted.ts`, displayPath: 'src/deleted.ts', kind: 'delete', oldContent: 'export const obsolete = true\n', newContent: null, isNew: false, truncated: false, status: 'kept', createdAt: 3 }
]
const todos: EngineTodo[] = [
  { id: 'todo-1', title: '完成消息列表样式', status: 'done', priority: 'medium' },
  { id: 'todo-2', title: '检查文件卡片与输入区对齐', status: 'done', priority: 'medium' }
]
const history: EngineHistoryRow[] = [
  { id: 'user', role: 'user', content: '聊天消息布局回归', conversationId: 'layout-turn' },
  ...changes.flatMap((change): EngineHistoryRow[] => [
    { id: `assistant-${change.id}`, role: 'assistant', conversationId: 'layout-turn', toolCall: { id: `tool-${change.id}`, name: change.kind === 'delete' ? 'delete_file' : 'write_file', args: { path: change.displayPath } } },
    { role: 'tool', toolCallId: `tool-${change.id}`, content: 'ok', metadata: { success: true, change } }
  ])
]
const snapshot: ChatRecoverySnapshot = {
  schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true,
  projection: [], runs: [], history, todos, changes, commandJobs: []
}
let fixture = ''
let server: Server | undefined
let app: ElectronApplication | undefined
let page: Page

function envelope(data: unknown): string { return JSON.stringify({ code: 200, message: 'ok', data }) }
function card(name: string) { return page.locator('.diff-card').filter({ has: page.locator('.diff-card__path', { hasText: name }) }) }

async function expectDefaultCards(): Promise<void> {
  await expect(page.locator('.diff-card')).toHaveCount(3)
  for (const name of ['new-file-with-a-long-name.ts', 'edit.ts']) {
    await expect(card(name).locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'true')
    await expect(card(name).locator('.diff-card__body')).toBeVisible()
  }
  await expect(card('deleted.ts').locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'false')
  await expect(card('deleted.ts').locator('.diff-card__body')).toHaveCount(0)
}

async function reloadPanel(width: number): Promise<void> {
  await page.evaluate(width => {
    const key = 'aether.ide.layout'
    const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...previous, chatPanelVisible: true, chatPanelWidth: width, sidebarVisible: false, panelVisible: false }))
    sessionStorage.removeItem('aether-chat-collapse-memory')
  }, width)
  await page.reload()
  await expectDefaultCards()
  await expect(page.getByRole('button', { name: '任务 2/2', exact: true })).toBeVisible()
  // 布局宽度包含工作台分隔边框；内部面板在 1.5x DPR 下会少 0.67px。
  await expect.poll(async () => Math.abs(await page.locator('.workbench__chat')
    .evaluate(element => element.getBoundingClientRect().width) - width)).toBeLessThanOrEqual(1)
}

async function expectTrayAlignment(): Promise<void> {
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout probe ${selector}`)
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
    }
    return { tray: rect('.session-tray'), surface: rect('.chat__surface'), composer: rect('.chat__composer') }
  })
  expect(Math.abs(metrics.tray.left - metrics.surface.left), '任务栏左边应与输入框对齐').toBeLessThanOrEqual(1)
  expect(Math.abs(metrics.tray.right - metrics.surface.right), '任务栏右边应与输入框对齐').toBeLessThanOrEqual(1)
  expect(metrics.tray.scrollWidth - metrics.tray.clientWidth, '任务栏不能横向溢出').toBeLessThanOrEqual(1)
  const gap = metrics.surface.top - metrics.tray.bottom
  const bottom = metrics.composer.bottom - metrics.surface.bottom
  expect(gap, '任务栏和输入框之间应有清晰留白').toBeGreaterThanOrEqual(8)
  expect(gap, '任务栏和输入框之间不应留出过大空白').toBeLessThanOrEqual(16)
  expect(Math.abs(gap - bottom), '输入区上下留白应平衡').toBeLessThanOrEqual(4)
}

test.describe.serial('消息文件卡片与任务托盘布局', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'chat-message-layout-ui-'))
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
        response.writeHead(401); response.end(envelope({ message: 'Invalid instance token' })); return
      }
      const data = path === '/health' ? { status: 'ok' }
        : path === '/meta' ? { version: '1.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'chat-message-layout-fixture' }
        : path === '/api/v1/chat/snapshot' ? snapshot
        : path === '/api/v1/conversation/history' ? history
        : path === '/api/v1/todos' ? todos
        : path === '/api/v1/changes' ? []
        : path === '/api/v1/chat/runs' ? { runs: [] }
        : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
        : []
      response.end(envelope(data))
    })
    await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolveListen) })
    const address = server.address() as AddressInfo
    const remoteUrl = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: '',
      autoStartEngine: true, lastFolder: '', lastSessionId: sessionId, appearance: 'dark'
    }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' } })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    // Remote selection belongs to its endpoint, so settings.json.lastSessionId
    // cannot select this fixture. Wait for bootstrap before replacing its slot.
    const selectionKey = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: remoteUrl }))
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) ?? '', selectionKey)).not.toBe('')
    await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: selectionKey, id: sessionId })
    await page.reload()
    await expect(page.locator('.message--user')).toContainText('聊天消息布局回归')
  })
  test.afterAll(async () => {
    await app?.close()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolveClose => server!.close(() => resolveClose())) }
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('chat-message-layout-ui-')) throw new Error('Unsafe chat layout fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('新建和修改默认展开，删除默认收起且支持鼠标与键盘，刷新保留手动选择', async () => {
    await expectDefaultCards()
    const deleted = card('deleted.ts')
    await deleted.locator('.diff-card__title').click()
    await expect(deleted.locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'true')
    await expect(deleted.locator('.diff-row--del')).toContainText('export const obsolete = true')
    await deleted.locator('.diff-card__head').focus()
    await page.keyboard.press('Space')
    await expect(deleted.locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    await expect(deleted.locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'true')
    await card('edit.ts').locator('.diff-card__title').click()
    await expect(card('edit.ts').locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await expect(card('deleted.ts').locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'true')
    await expect(card('deleted.ts').locator('.diff-row--del')).toContainText('export const obsolete = true')
    await expect(card('edit.ts').locator('.diff-card__head')).toHaveAttribute('aria-expanded', 'false')
    await expect(card('edit.ts').locator('.diff-card__body')).toHaveCount(0)
    await page.evaluate(() => sessionStorage.removeItem('aether-chat-collapse-memory'))
    await page.reload()
    await expectDefaultCards()
  })

  test('窄屏和宽屏下任务栏与输入框对齐，展开任务保持间距，标题和差异背景不越界', async ({}, testInfo) => {
    for (const [width, appearance] of [[280, 'dark'], [380, 'light'], [800, 'dark']] as const) {
      await app!.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 800), width === 800 ? 1600 : 940)
      await page.evaluate(appearance => window.aether.settings.update({ appearance }), appearance)
      await reloadPanel(width)
      await expectTrayAlignment()
      await page.getByRole('button', { name: '任务 2/2', exact: true }).click()
      await expect(page.locator('.todo-tray')).toBeVisible()
      await expectTrayAlignment()
      await page.getByRole('button', { name: '收起托盘', exact: true }).click()

      const overflow = await page.locator('.diff-card__head').evaluateAll(heads => heads.map(head => {
        const box = head.getBoundingClientRect()
        const children = [...head.children].filter(child => child.getBoundingClientRect().width > 0)
        return Math.max(0, ...children.map(child => Math.max(box.left - child.getBoundingClientRect().left, child.getBoundingClientRect().right - box.right)))
      }))
      for (const amount of overflow) expect(amount, `${width}px 面板的卡片标题内容越界`).toBeLessThanOrEqual(1)

      const body = card('new-file-with-a-long-name.ts').locator('.diff-card__body')
      const scrollbar = await body.evaluate(element => {
        const style = getComputedStyle(element)
        const track = getComputedStyle(element, '::-webkit-scrollbar')
        const buttons = getComputedStyle(element, '::-webkit-scrollbar-button')
        return {
          widthMode: style.scrollbarWidth,
          colorMode: style.scrollbarColor,
          height: Number.parseFloat(track.height),
          buttonsDisplay: buttons.display,
          buttonsWidth: Number.parseFloat(buttons.width),
          buttonsHeight: Number.parseFloat(buttons.height)
        }
      })
      // Chromium's standard thin/color declarations override WebKit scrollbar
      // parts and can restore platform arrows even when their CSS says hidden.
      expect(scrollbar.widthMode, '差异区域应使用无箭头的自定义滚动条').toBe('auto')
      expect(scrollbar.colorMode, '平台滚动条颜色不应覆盖精简滚动条样式').toBe('auto')
      expect(scrollbar.height, '水平滚动条应保留可拖动轨道').toBeGreaterThan(0)
      expect(scrollbar.height, '水平滚动条不应挤占代码区高度').toBeLessThanOrEqual(6)
      expect(scrollbar.buttonsDisplay, '水平滚动条不应显示两端箭头').toBe('none')
      expect(scrollbar.buttonsWidth).toBe(0)
      expect(scrollbar.buttonsHeight).toBe(0)
      const longRow = body.locator('.diff-row--add').first()
      const rowBackground = await longRow.evaluate(element => getComputedStyle(element).backgroundColor)
      expect(rowBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(rowBackground).not.toBe('transparent')
      await body.evaluate(element => { element.scrollLeft = element.scrollWidth })
      const edge = await body.evaluate(element => {
        const row = element.querySelector('.diff-row--add')
        if (!row) throw new Error('Missing added row')
        return { left: element.scrollLeft, right: row.getBoundingClientRect().right, viewportRight: element.getBoundingClientRect().right }
      })
      expect(edge.left, '长行必须在差异区域内部横向滚动').toBeGreaterThan(0)
      expect(edge.right, '滚动到长行末尾后差异背景仍覆盖可视区域').toBeGreaterThanOrEqual(edge.viewportRight - 2)
      await body.evaluate(element => { element.scrollLeft = 0 })
      const screenshot = testInfo.outputPath(`chat-message-${width}-${appearance}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`${width}px ${appearance}`, { path: screenshot, contentType: 'image/png' })
    }
  })
})
