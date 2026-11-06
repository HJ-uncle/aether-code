/** Real Electron, no engine: shared menu/popover/dialog/palette entry and exit,
 * Code layout retention, rapid reversals, hover tools, and reduced motion.
 * Sample real animation frames and app state; CSS declarations alone do not
 * prove that a parent has retained its child long enough to animate out. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
let fixture = '', workspace = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
const errors: string[] = []
const sidebar = '.workbench__sidebar', panel = '.workbench__panel'
const menu = '.menu-bar__dropdown', popover = '.popover__panel[aria-label="编辑器设置"]'
const palette = '.palette-overlay:has(.palette[aria-label="命令面板"])'
const toggleSidebar = '.menu-bar__action[aria-label="切换侧边栏"]'
const editorSettings = '.editor-toolbar button[aria-label="编辑器设置"]'

type Action = { kind: 'click' | 'contextmenu' | 'key'; selector?: string; text?: string; key?: string; ctrl?: boolean; shift?: boolean }
type Frame = { time: number; phase: string | null; present: boolean; visible: boolean; inert: boolean; hidden: string | null; opacity: number; x: number; y: number; display: string }
type MotionTrace = { samples: Frame[]; settled: boolean; reversed: boolean }

/** Dispatch inside the renderer so the first sample cannot miss a 120 ms exit
 * while an automation round trip is in flight. A MutationObserver catches the
 * initial state; RAFs capture actual intermediate position and opacity. */
async function traceMotion(selector: string, action: Action, end: 'open' | 'closed', options: { inner?: string; reverse?: Action; reduced?: boolean } = {}): Promise<MotionTrace> {
  return page.evaluate(async ({ selector, action, end, options }) => {
    const samples: Frame[] = [], started = performance.now()
    let reversed = false, stable = 0, lastState = '', changed = false, finished = false
    const dispatch = (value: Action): void => {
      const target = value.selector
        ? [...document.querySelectorAll<HTMLElement>(value.selector)].find(element => element.getClientRects().length > 0 && (!value.text || element.textContent?.trim() === value.text))
        : document.activeElement instanceof HTMLElement ? document.activeElement : document.body
      if (!target) throw new Error(`Missing motion action target: ${value.selector} ${value.text ?? ''}`)
      if (value.kind === 'click') target.click()
      else if (value.kind === 'contextmenu') {
        const box = target.getBoundingClientRect()
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + 20, clientY: box.y + box.height / 2 }))
      } else target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value.key, ctrlKey: value.ctrl, shiftKey: value.shift }))
    }
    const snapshot = (): Frame => {
      const element = document.querySelector<HTMLElement>(selector)
      const measured = options.inner ? element?.querySelector<HTMLElement>(options.inner) : element
      const style = element ? getComputedStyle(element) : null, box = measured?.getBoundingClientRect()
      const result = { time: performance.now() - started, phase: element?.dataset.motionState ?? null, present: Boolean(element),
        visible: Boolean(element?.getClientRects().length && style?.display !== 'none'), inert: Boolean(element?.inert), hidden: element?.getAttribute('aria-hidden') ?? null,
        opacity: style ? Number(style.opacity) : 0, x: box?.x ?? 0, y: box?.y ?? 0, display: style?.display ?? 'absent' }
      samples.push(result)
      return result
    }
    snapshot()
    const observer = new MutationObserver(() => { if (!finished) { changed = true; snapshot() } })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-motion-state', 'inert', 'aria-hidden', 'style'] })
    try {
      dispatch(action)
      return await new Promise<MotionTrace>(resolve => {
        const frame = (): void => {
          const sample = snapshot()
          if (options.reverse && !reversed && sample.phase === 'closing') {
            // Reverse on the first exit frame, before the old exit timer fires.
            reversed = true
            dispatch(options.reverse)
            stable = 0
          }
          const terminal = end === 'open'
            ? sample.visible && sample.phase === 'open' && sample.opacity >= 0.995 && !sample.inert
            : !sample.visible
          const state = `${sample.phase}:${sample.visible}:${sample.opacity.toFixed(3)}:${sample.x.toFixed(2)}:${sample.y.toFixed(2)}`
          stable = changed && terminal && state === lastState ? stable + 1 : 0
          lastState = state
          // A reversed overlay must remain alive beyond the abandoned deadline.
          const pastCancelledExit = !options.reverse || sample.time >= 240
          if ((stable >= 2 && pastCancelledExit) || sample.time > 5_000) {
            finished = true
            resolve({ samples, settled: stable >= 2 && pastCancelledExit, reversed })
          } else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
    } finally { finished = true; observer.disconnect() }
  }, { selector, action, end, options })
}

function expectEntry(trace: MotionTrace, axis: 'x' | 'y' = 'y'): void {
  expect(trace.settled, JSON.stringify(trace.samples)).toBe(true)
  expect(trace.samples.some(frame => frame.phase === 'entering' && frame.present)).toBe(true)
  const visible = trace.samples.filter(frame => frame.visible)
  expect(visible.some(frame => frame.opacity > 0.01 && frame.opacity < 0.99), 'entry must have intermediate opacity').toBe(true)
  expect(Math.max(...visible.map(frame => frame[axis])) - Math.min(...visible.map(frame => frame[axis])), 'entry must visibly slide').toBeGreaterThan(0.5)
  expect(visible.at(-1)?.opacity).toBeGreaterThanOrEqual(0.995)
}

function expectExit(trace: MotionTrace, axis: 'x' | 'y' = 'y'): void {
  expect(trace.settled, JSON.stringify(trace.samples)).toBe(true)
  const closing = trace.samples.filter(frame => frame.phase === 'closing' && frame.visible)
  expect(closing.length, 'exit must retain visible DOM').toBeGreaterThan(0)
  expect(closing.every(frame => frame.inert && frame.hidden === 'true'), 'retained exit is immediately noninteractive').toBe(true)
  expect(closing.some(frame => frame.opacity > 0.01 && frame.opacity < 0.99), 'exit must have intermediate opacity').toBe(true)
  expect(Math.max(...closing.map(frame => frame[axis])) - Math.min(...closing.map(frame => frame[axis])), 'exit must visibly slide').toBeGreaterThan(0.5)
  expect(trace.samples.at(-1)?.visible).toBe(false)
}

async function expectReversal(selector: string, close: Action, reopen: Action, inner?: string): Promise<void> {
  const trace = await traceMotion(selector, close, 'open', { reverse: reopen, inner })
  expect(trace.reversed).toBe(true)
  expect(trace.settled, JSON.stringify(trace.samples)).toBe(true)
  expect(trace.samples.some(frame => frame.phase === 'closing' && frame.inert && frame.hidden === 'true')).toBe(true)
  expect(trace.samples.at(-1)).toMatchObject({ present: true, visible: true, phase: 'open', inert: false })
}

test.describe.serial('共享显隐动效', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'motion-ui-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace)
    writeFileSync(join(workspace, 'alpha.txt'), 'alpha motion fixture\n')
    writeFileSync(join(workspace, 'beta.txt'), 'beta motion fixture\n')
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: false,
      lastFolder: workspace, lastSessionId: '', lastAgentId: '', lastModelId: '', appearance: 'dark' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'motion-ui')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.locator('.workbench')).toBeVisible()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(page.locator('.explorer [role="treeitem"]').filter({ hasText: 'alpha.txt' })).toBeVisible()
    await page.locator('.explorer [role="treeitem"]').filter({ hasText: 'alpha.txt' }).dblclick()
    await page.locator('.explorer [role="treeitem"]').filter({ hasText: 'beta.txt' }).dblclick()
    await expect(page.locator('.editor-tab.is-active')).toContainText('beta.txt')
    await expect(page.locator(editorSettings).last()).toBeVisible()
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('motion-ui-')) throw new Error(`Unsafe motion fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('顶部菜单保留退出内容，快速重开取消旧退出', async () => {
    const trigger: Action = { kind: 'click', selector: '.menu-bar__menus .menu-bar__trigger', text: '文件' }
    expectEntry(await traceMotion(menu, trigger, 'open'))
    await expect(page.locator(menu).getByRole('menuitem', { name: /快速打开文件/ })).toBeVisible()
    await expectReversal(menu, trigger, trigger)
    expectExit(await traceMotion(menu, { kind: 'key', key: 'Escape' }, 'closed'))
    await expect(page.locator(menu)).toHaveCount(0)
  })

  test('编辑器 Popover 双向滑入淡出，重开后仍能操作', async () => {
    const trigger: Action = { kind: 'click', selector: editorSettings }
    expectEntry(await traceMotion(popover, trigger, 'open'))
    await expectReversal(popover, trigger, trigger)
    await expect(page.locator(editorSettings).last()).toHaveAttribute('aria-expanded', 'true')
    expectExit(await traceMotion(popover, { kind: 'key', key: 'Escape' }, 'closed'))
    await expect(page.locator(popover)).toHaveCount(0)
    await expect(page.locator(editorSettings).last()).toHaveAttribute('aria-expanded', 'false')
  })

  test('右键菜单与创建文件 Dialog 退出时 inert，创建动作真实落盘', async () => {
    const row = `.explorer [role="treeitem"][data-path=${JSON.stringify(join(workspace, 'alpha.txt'))}]`
    const contextMenu = '.context-menu:not(.context-menu--submenu)'
    // A non-none settled translate would turn these ancestors into containing
    // blocks and add their own offsets to a viewport-positioned inline menu.
    await expect(page.locator('#mode-code')).toHaveAttribute('data-motion-state', 'open')
    await expect(page.locator('#mode-code')).toHaveCSS('translate', 'none')
    await expect(page.locator(sidebar)).toHaveCSS('translate', 'none')
    expectEntry(await traceMotion(contextMenu, { kind: 'contextmenu', selector: row }, 'open'))
    expectExit(await traceMotion(contextMenu, { kind: 'key', key: 'Escape' }, 'closed'))
    const point = await page.locator(row).evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: box.left + Math.min(20, box.width / 2), y: box.top + box.height / 2 }
    })
    // Use a native right-button input as well as the frame-sampled dispatch;
    // compare actual viewport geometry, not just the menu's CSS left/top.
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(page.locator(contextMenu)).toHaveCSS('opacity', '1')
    await expect(page.locator(contextMenu)).toHaveCSS('translate', 'none')
    const bounds = await page.locator(contextMenu).evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: box.left, y: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    const expectedX = Math.max(4, Math.min(point.x, bounds.viewportWidth - bounds.width - 4))
    const expectedY = Math.max(4, Math.min(point.y, bounds.viewportHeight - bounds.height - 4))
    expect(Math.abs(bounds.x - expectedX), 'menu must use the right-click viewport x').toBeLessThan(1.5)
    expect(Math.abs(bounds.y - expectedY), 'menu must use the right-click viewport y').toBeLessThan(1.5)
    expect(bounds.x).toBeGreaterThanOrEqual(3)
    expect(bounds.y).toBeGreaterThanOrEqual(3)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 3)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 3)
    expectEntry(await traceMotion('.modal-overlay', { kind: 'click', selector: '.context-menu__item', text: '新建文件' }, 'open', { inner: '.modal' }))
    await expect(page.locator('.context-menu')).toHaveCount(0)
    await page.locator('.modal--prompt input').fill('created-motion.txt')
    expectExit(await traceMotion('.modal-overlay', { kind: 'click', selector: '.modal__footer button', text: '创建' }, 'closed', { inner: '.modal' }))
    await expect.poll(() => existsSync(join(workspace, 'created-motion.txt'))).toBe(true)
    expect(readFileSync(join(workspace, 'created-motion.txt'), 'utf8')).toBe('')
    await expect(page.locator('.modal-overlay')).toHaveCount(0)
  })

  test('Code 侧栏与底部面板双向保留，快速反转不被旧 timer 关闭', async () => {
    const toggle: Action = { kind: 'click', selector: toggleSidebar }
    expectExit(await traceMotion(sidebar, toggle, 'closed'), 'x')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aether.ide.layout') ?? '{}').sidebarVisible)).toBe(false)
    expectEntry(await traceMotion(sidebar, toggle, 'open'), 'x')
    await expectReversal(sidebar, toggle, toggle)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aether.ide.layout') ?? '{}').sidebarVisible)).toBe(true)

    const output: Action = { kind: 'key', key: 'J', ctrl: true, shift: true }
    expectEntry(await traceMotion(panel, output, 'open'))
    await expect(page.locator('.panel__tab.is-active')).toHaveText('输出')
    await expectReversal(panel, { kind: 'click', selector: '.panel__action[aria-label="关闭面板"]' }, output)
    expectExit(await traceMotion(panel, { kind: 'click', selector: '.panel__action[aria-label="关闭面板"]' }, 'closed'))
    // The terminal and output views must remain mounted after panel collapse.
    await expect(page.locator(panel)).toHaveCount(1)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aether.ide.layout') ?? '{}').panelVisible)).toBe(false)
  })

  test('命令面板双向滑动，快速重新打开重置查询并恢复焦点', async () => {
    const toggle: Action = { kind: 'key', key: 'P', ctrl: true, shift: true }
    expectEntry(await traceMotion(palette, toggle, 'open', { inner: '.palette' }))
    await page.getByRole('textbox', { name: '过滤命令', exact: true }).fill('输出')
    await expectReversal(palette, { kind: 'key', selector: `${palette} input`, key: 'Escape' }, toggle, '.palette')
    await expect(page.getByRole('textbox', { name: '过滤命令', exact: true })).toHaveValue('')
    await expect(page.getByRole('textbox', { name: '过滤命令', exact: true })).toBeFocused()
    expectExit(await traceMotion(palette, { kind: 'key', selector: `${palette} input`, key: 'Escape' }, 'closed', { inner: '.palette' }))
    await expect(page.locator(palette)).toHaveCount(0)
  })

  test('非活动编辑器标签的关闭按钮随 hover 双向淡出滑动', async () => {
    const tab = page.locator('.editor-tab:not(.is-active)').filter({ hasText: 'alpha.txt' })
    const close = tab.locator('.editor-tab__close')
    await expect(tab).toBeVisible()
    await page.locator('.explorer__root').click()
    await page.mouse.move(5, 100)
    await expect(close).toHaveCSS('opacity', '0')
    const sampleHover = (opacity: number) => close.evaluate(async (element, target) => {
      const frames: Array<{ opacity: number; translate: number }> = [], start = performance.now()
      let stable = 0
      return new Promise<typeof frames>(resolve => {
        const sample = (): void => {
          const style = getComputedStyle(element), value = Number(style.opacity)
          frames.push({ opacity: value, translate: Number.parseFloat(style.translate) || 0 })
          stable = Math.abs(value - target) < 0.005 ? stable + 1 : 0
          if (stable >= 3 || performance.now() - start > 2_000) resolve(frames)
          else requestAnimationFrame(sample)
        }
        sample()
      })
    }, opacity)
    const entering = sampleHover(1)
    await tab.hover()
    const entry = await entering
    expect(entry.some(frame => frame.opacity > 0.01 && frame.opacity < 0.99)).toBe(true)
    expect(entry.at(-1)?.opacity).toBe(1)
    expect(Math.max(...entry.map(frame => frame.translate)) - Math.min(...entry.map(frame => frame.translate))).toBeGreaterThan(0.5)
    const leaving = sampleHover(0)
    await page.mouse.move(5, 100)
    const exit = await leaving
    expect(exit.some(frame => frame.opacity > 0.01 && frame.opacity < 0.99)).toBe(true)
    expect(exit.at(-1)?.opacity).toBe(0)
    expect(Math.max(...exit.map(frame => frame.translate)) - Math.min(...exit.map(frame => frame.translate))).toBeGreaterThan(0.5)
  })

  test('reduce-motion 立即进入和退出，没有滞留的可交互表面', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    try {
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
      const trigger: Action = { kind: 'click', selector: editorSettings }
      const entry = await traceMotion(popover, trigger, 'open', { reduced: true })
      expect(entry.settled).toBe(true)
      expect(entry.samples.filter(frame => frame.visible).every(frame => frame.phase === 'open' && frame.opacity === 1)).toBe(true)
      const exit = await traceMotion(popover, trigger, 'closed', { reduced: true })
      expect(exit.settled).toBe(true)
      expect(exit.samples.some(frame => frame.phase === 'closing' && frame.visible)).toBe(false)
      await expect(page.locator(popover)).toHaveCount(0)
      await page.locator(toggleSidebar).click()
      await expect(page.locator(sidebar)).toHaveCount(0)
      await page.locator(toggleSidebar).click()
      await expect(page.locator(sidebar)).toHaveAttribute('data-motion-state', 'open')
      await expect(page.locator(sidebar)).toHaveCSS('opacity', '1')
      await expect(page.locator(sidebar)).not.toHaveAttribute('inert')
    } finally { await page.emulateMedia({ reducedMotion: 'no-preference' }) }
  })
})
