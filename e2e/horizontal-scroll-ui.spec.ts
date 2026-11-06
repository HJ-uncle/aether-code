/** Real Electron, no engine: Work/Code/browser tabs share a non-layout overlay
 * scrollbar, pointer/keyboard controls and trusted mouse wheel. Controlled DOM
 * checks geometry, clipping, wheel units and preservation of native dual-axis scroll. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const names = Array.from({ length: 16 }, (_, index) => `横向滚动验收-${String(index + 1).padStart(2, '0')}-完整文档标题.txt`)
const errors: string[] = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', workspace = ''
const overlay = () => page.locator('.horizontal-scrollbar')

async function expectOverlayAtBottom(strip: Locator): Promise<void> {
  await expect(overlay()).toBeVisible()
  await expect(overlay()).toHaveAttribute('role', 'scrollbar')
  await expect(overlay()).toHaveAttribute('aria-orientation', 'horizontal')
  await expect(overlay()).toHaveAttribute('tabindex', '0')
  await expect.poll(async () => {
    const track = await overlay().boundingBox(), bounds = await strip.boundingBox()
    return track && bounds ? Math.abs(track.y + track.height - bounds.y - bounds.height) : Infinity
  }).toBeLessThanOrEqual(2)
  const track = await overlay().boundingBox()
  expect(track!.height).toBeGreaterThan(0); expect(track!.height).toBeLessThanOrEqual(8)
  const thumb = overlay().locator('.horizontal-scrollbar__thumb')
  await expect(thumb).toBeVisible()
  const paint = await thumb.evaluate(element => {
    const style = getComputedStyle(element, '::after')
    return { content: style.content, height: parseFloat(style.height), background: style.backgroundColor }
  })
  expect(paint.content).not.toBe('none')
  expect(paint.height).toBeGreaterThan(0); expect(paint.height).toBeLessThanOrEqual(2)
  expect(paint.background).not.toBe('rgba(0, 0, 0, 0)')
}

async function expectSlimScrollbar(strip: Locator): Promise<void> {
  await expect(strip).toHaveAttribute('data-scroll-axis', 'x')
  const styles = await strip.evaluate(element => {
    const style = getComputedStyle(element)
    const node = element as HTMLElement
    return { overflowX: style.overflowX, overflowY: style.overflowY, width: style.scrollbarWidth,
      reserved: node.offsetHeight - node.clientHeight,
      borders: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }
  })
  expect(styles).toMatchObject({ overflowX: 'auto', overflowY: 'hidden', width: 'none' })
  expect(Math.abs(styles.reserved - styles.borders)).toBeLessThanOrEqual(1)
  await strip.hover()
  await expectOverlayAtBottom(strip)
}

async function expectOverlayControls(strip: Locator): Promise<void> {
  await strip.evaluate(element => { element.scrollLeft = 0 })
  await strip.hover()
  await expectOverlayAtBottom(strip)
  await overlay().hover()
  await page.mouse.wheel(0, 60)
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(30)
  const afterVerticalWheel = await strip.evaluate(element => element.scrollLeft)
  await page.mouse.wheel(70, 0)
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(afterVerticalWheel + 30)
  await strip.evaluate(element => { element.scrollLeft = 0 })
  await expect(overlay()).toHaveAttribute('aria-valuenow', '0')
  const track = (await overlay().boundingBox())!, thumb = (await overlay().locator('.horizontal-scrollbar__thumb').boundingBox())!
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  try { await page.mouse.move(track.x + track.width * 0.75, thumb.y + thumb.height / 2, { steps: 8 }) }
  finally { await page.mouse.up() }
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
  const dragged = await strip.evaluate(element => element.scrollLeft)
  await overlay().click({ position: { x: 5, y: track.height / 2 } })
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThan(dragged)
  await overlay().focus()
  await page.keyboard.press('Home')
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await page.keyboard.press('End')
  await expect.poll(() => strip.evaluate(element => Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)))).toBeLessThanOrEqual(1)
  const atEnd = await strip.evaluate(element => element.scrollLeft)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThan(atEnd)
  const now = Number(await overlay().getAttribute('aria-valuenow'))
  const max = Number(await overlay().getAttribute('aria-valuemax'))
  expect(now).toBeGreaterThan(0); expect(now).toBeLessThan(max)
}

async function expectMouseWheelScroll(strip: Locator): Promise<void> {
  await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(150)
  await strip.evaluate(element => { element.scrollLeft = 0 })
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0)
  const selectedIdentity = () => strip.locator('[role="tab"][aria-selected="true"]').evaluate(element =>
    element.id || element.getAttribute('data-tab-key') || element.closest('[data-browser-tab-id]')?.getAttribute('data-browser-tab-id'))
  const selected = await selectedIdentity()
  expect(typeof selected).toBe('string')
  expect(selected?.length).toBeGreaterThan(0)
  await strip.hover()
  await page.mouse.wheel(0, 210)
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
  const before = await strip.evaluate(element => element.scrollLeft)
  await page.mouse.wheel(0, -90)
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThan(before - 40)
  await strip.evaluate(element => { element.scrollLeft = 0 })
  await page.mouse.wheel(90, 0)
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(40)
  expect(await selectedIdentity()).toBe(selected)
  expect(await strip.evaluate(element => element.scrollTop)).toBe(0)
}

interface WheelFixtureOptions {
  deltaY: number
  deltaX?: number
  deltaMode?: number
  start?: number | 'end'
  rtl?: boolean
  marked?: boolean
  bidirectional?: boolean
  fits?: boolean
  nested?: 'vertical' | 'horizontal' | 'input' | 'textarea' | 'select' | 'editable'
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  prevented?: boolean
  cancelable?: boolean
}

async function wheelReceipt(options: WheelFixtureOptions) {
  // Synthetic events cannot exercise native default scrolling; their receipt
  // isolates the document delegate. The real strip tests use trusted input.
  return page.evaluate(options => {
    const host = document.createElement('section')
    host.style.cssText = 'position:fixed;left:320px;top:180px;width:400px;height:120px;z-index:999999'
    const strip = document.createElement('div')
    strip.style.cssText = 'width:240px;height:64px;overflow-x:auto;overflow-y:hidden;line-height:20px;font-size:16px'
    if (options.marked !== false) strip.dataset.scrollAxis = 'x'
    if (options.bidirectional) strip.style.overflowY = 'auto'
    if (options.rtl) strip.style.direction = 'rtl'
    const content = document.createElement('div')
    content.style.cssText = `width:${options.fits ? 180 : 1440}px;height:${options.bidirectional ? 240 : 40}px`
    const target = document.createElement(options.nested === 'input' || options.nested === 'textarea' || options.nested === 'select' ? options.nested : 'div')
    target.textContent = 'Wheel target'
    if (options.nested === 'editable') target.contentEditable = 'true'
    if (options.nested === 'vertical' || options.nested === 'horizontal') {
      target.style.cssText = 'width:120px;height:32px;overflow:auto'
      const nestedContent = document.createElement('div')
      nestedContent.style.cssText = options.nested === 'vertical' ? 'height:240px;width:80px' : 'height:20px;width:600px'
      target.append(nestedContent)
    }
    content.append(target); strip.append(content); host.append(strip); document.body.append(host)
    try {
      const max = strip.scrollWidth - strip.clientWidth
      strip.scrollLeft = options.start === 'end' ? options.rtl ? -max : max : options.start ?? 120
      const before = strip.scrollLeft
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: options.cancelable !== false,
        deltaY: options.deltaY, deltaX: options.deltaX ?? 0, deltaMode: options.deltaMode ?? 0,
        ctrlKey: options.ctrlKey, metaKey: options.metaKey, altKey: options.altKey, shiftKey: options.shiftKey })
      if (options.prevented) target.addEventListener('wheel', event => event.preventDefault(), { once: true })
      const dispatched = target.dispatchEvent(event)
      return { before, after: strip.scrollLeft, prevented: event.defaultPrevented, dispatched,
        max, width: strip.clientWidth, lineHeight: parseFloat(getComputedStyle(strip).lineHeight), nestedTop: target.scrollTop }
    } finally { host.remove() }
  }, options)
}

test.describe.serial('横向滚动统一交互', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'horizontal-scroll-ui-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    for (const name of names) writeFileSync(join(workspace, name), `${name}\n横向滚轮不应切换当前文档。`)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'light' }))
    const env: Record<string, string> = { AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'AETHER_GLOBAL_DIR') env[name] = value
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'horizontal-scroll')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: 'work-horizontal-test', title: '横向滚动验收', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: 'work-horizontal-test', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(page.locator('input.work-resource-tabs__file-input')).toBeAttached()
  })
  test.afterEach(() => { expect(errors).toEqual([]); health?.assertHealthy() })
  test.afterAll(async ({}, info) => {
    try {
      if (health) await health.closeAndAssert(info)
      else await app?.close()
    } finally {
      if (!fixture) return
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('horizontal-scroll-ui-')) throw new Error('Unsafe horizontal-scroll fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('Work 多文件标签以细底部滚动条横移，选中文档和操作按钮保持可用', async ({}, info) => {
    const strip = page.getByRole('tablist', { name: '已打开的工作区', exact: true })
    for (const name of names) {
      await page.locator('input.work-resource-tabs__file-input').setInputFiles(join(workspace, name))
      await expect(strip.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    await expect(page.locator('.work-artifact-panel-v2[data-document-active="true"]:visible').last()).toHaveAttribute('data-file-read-status', 'current')
    await expectSlimScrollbar(strip)
    await expectMouseWheelScroll(strip)
    await expectOverlayControls(strip)
    await expect(strip.getByRole('tab', { name: names.at(-1)!, exact: true })).toHaveAttribute('aria-selected', 'true')
    const more = page.getByRole('button', { name: '更多工作区', exact: true })
    await expect(more).toBeInViewport()
    await expect(page.locator('.work-workspace__resource-actions')).toHaveCount(0)
    await more.click()
    await expect(page.getByRole('menuitem', { name: '打开文件…', exact: true })).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()
    await strip.hover()
    await expectOverlayAtBottom(strip)
    const screenshot = info.outputPath('work-horizontal-tabs-light.png')
    await page.locator('.work-workspace__tab-strip').screenshot({ path: screenshot })
    await info.attach('work-horizontal-tabs-light', { path: screenshot, contentType: 'image/png' })
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await expectSlimScrollbar(strip)
    const darkScreenshot = info.outputPath('work-horizontal-tabs-dark.png')
    await page.locator('.work-workspace__tab-strip').screenshot({ path: darkScreenshot })
    await info.attach('work-horizontal-tabs-dark', { path: darkScreenshot, contentType: 'image/png' })
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
  })

  test('Code 文件标签复用横向滚轮，不改动当前编辑文件', async ({}, info) => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    for (const name of names) {
      await page.keyboard.press('Control+p')
      const picker = page.locator('.palette[aria-label="快速打开文件"]')
      await picker.locator('.palette__input').fill(name)
      await expect(picker.locator('.palette__item').first()).toContainText(name)
      await page.keyboard.press('Enter')
      await expect(page.locator('.editor-tab[aria-selected="true"]')).toContainText(name)
    }
    const strip = page.locator('.editor-tabs:visible').first()
    await expectSlimScrollbar(strip)
    await expectMouseWheelScroll(strip)
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toContainText(names.at(-1)!)
    await expect(page.locator('.monaco-editor:visible .view-lines').first()).toContainText(names.at(-1)!)
    const clipping = await strip.evaluate(element => {
      const top = element.getBoundingClientRect().top + element.clientTop
      return Array.from(element.querySelectorAll('.editor-tab'), tab => {
        const bounds = tab.getBoundingClientRect()
        return bounds.top < top || bounds.bottom > top + element.clientHeight + 1
      })
    })
    expect(clipping).not.toContain(true)
    await strip.screenshot({ path: info.outputPath('code-horizontal-tabs.png') })
  })

  test('Browser 网页标签使用相同滚轮与细滚动条，隐藏 Work 标签不跟着移动', async ({}, info) => {
    await page.keyboard.press('Control+Alt+b')
    const browser = page.getByRole('region', { name: '内置浏览器', exact: true })
    await expect(browser).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({ url: 'about:blank', loading: false }))
    for (let index = 1; index < 18; index++) {
      const count = await page.evaluate(async () => (await window.aether.browser.list()).length)
      await browser.getByRole('button', { name: '新建网页标签（Ctrl+T）', exact: true }).click()
      await expect.poll(() => page.evaluate(async () => (await window.aether.browser.list()).length)).toBe(count + 1)
    }
    const hiddenWork = page.locator('.work-workspace__tabs')
    const workBefore = await hiddenWork.evaluate(element => element.scrollLeft)
    const strip = browser.getByRole('tablist', { name: '网页标签', exact: true })
    await expectSlimScrollbar(strip)
    await expectMouseWheelScroll(strip)
    expect(await hiddenWork.evaluate(element => element.scrollLeft)).toBe(workBefore)
    const screenshot = info.outputPath('browser-horizontal-tabs.png')
    await strip.screenshot({ path: screenshot })
    await info.attach('browser-horizontal-tabs', { path: screenshot, contentType: 'image/png' })
    for (const tab of await page.evaluate(() => window.aether.browser.list())) await page.evaluate(id => window.aether.browser.close(id), tab.tabId)
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })

  test('浮动横条不挤压内容，随祖先滚动定位且在无溢出、裁剪和隐藏时消失', async () => {
    await page.evaluate(() => {
      const host = document.createElement('section')
      host.id = 'horizontal-overlay-geometry-fixture'
      host.style.cssText = 'position:fixed;left:320px;top:180px;width:400px;height:240px;overflow:auto;z-index:10;background:var(--bg-surface)'
      const above = document.createElement('div')
      above.style.height = '40px'
      const strip = document.createElement('div')
      strip.dataset.scrollAxis = 'x'
      strip.style.cssText = 'width:320px;height:48px;box-sizing:border-box;border:1px solid var(--border);overflow-x:auto;overflow-y:hidden'
      const content = document.createElement('div')
      content.className = 'geometry-content'
      content.style.cssText = 'width:180px;height:28px;line-height:28px'
      const label = document.createElement('span')
      label.style.cssText = 'display:inline-block;width:120px;height:20px;line-height:20px'
      label.textContent = '几何位置验收'
      content.append(label); strip.append(content)
      const below = document.createElement('div')
      below.className = 'geometry-below'
      below.style.height = '1000px'
      host.append(above, strip, below); document.body.append(host)
    })
    const host = page.locator('#horizontal-overlay-geometry-fixture'), strip = host.locator('[data-scroll-axis="x"]')
    const geometry = () => host.evaluate(element => {
      const strip = element.querySelector<HTMLElement>('[data-scroll-axis="x"]')!
      const bounds = strip.getBoundingClientRect(), label = strip.querySelector('span')!.getBoundingClientRect()
      return { height: bounds.height, innerHeight: strip.clientHeight, labelTop: label.top - bounds.top, labelHeight: label.height,
        nextTop: element.querySelector('.geometry-below')!.getBoundingClientRect().top - bounds.top }
    })
    try {
      await strip.hover()
      await expect(overlay()).toBeHidden()
      const before = await geometry()
      await host.locator('.geometry-content').evaluate(element => { (element as HTMLElement).style.width = '1200px' })
      await page.mouse.move(20, 20); await strip.hover()
      await expectSlimScrollbar(strip)
      expect(await geometry()).toEqual(before)
      await host.locator('.geometry-content').evaluate(element => { (element as HTMLElement).style.width = '180px' })
      await expect(overlay()).toBeHidden()
      expect(await geometry()).toEqual(before)
      await host.locator('.geometry-content').evaluate(element => { (element as HTMLElement).style.width = '1200px' })
      await page.mouse.move(20, 20); await strip.hover()
      await expectOverlayAtBottom(strip)
      await overlay().focus()
      const topBefore = (await overlay().boundingBox())!.y
      await host.evaluate(element => { element.scrollTop = 16 })
      await expectOverlayAtBottom(strip)
      await expect.poll(async () => Math.abs((await overlay().boundingBox())!.y - topBefore + 16)).toBeLessThanOrEqual(1)
      await host.evaluate(element => { element.scrollTop = 180 })
      await expect(overlay()).toBeHidden()
      await host.evaluate(element => { element.scrollTop = 0 })
      await page.mouse.move(20, 20); await strip.hover(); await expectOverlayAtBottom(strip)
      await host.evaluate(element => { (element as HTMLElement).style.display = 'none' })
      await expect(overlay()).toBeHidden()
      await host.evaluate(element => { (element as HTMLElement).style.display = '' })
      await page.mouse.move(20, 20); await strip.hover(); await expectOverlayAtBottom(strip)
      expect(await geometry()).toEqual(before)
    } finally { await host.evaluate(element => element.remove()) }
    await expect(overlay()).toBeHidden()
  })

  test('拖动后恢复原焦点并可悬停切换横条，拖动中失去溢出或隐藏会释放指针', async () => {
    await page.evaluate(() => {
      const host = document.createElement('section')
      host.id = 'horizontal-pointer-fixture'
      host.style.cssText = 'position:fixed;left:320px;top:180px;width:400px;height:220px;z-index:10;background:var(--bg-surface)'
      const focus = document.createElement('button')
      focus.id = 'horizontal-pointer-focus'; focus.textContent = '原焦点'
      host.append(focus)
      for (const suffix of ['first', 'second']) {
        const strip = document.createElement('div'), content = document.createElement('div')
        strip.id = `horizontal-pointer-${suffix}`; strip.dataset.scrollAxis = 'x'
        strip.style.cssText = 'width:320px;height:48px;overflow-x:auto;overflow-y:hidden;margin-top:16px'
        content.style.cssText = 'width:1200px;height:28px'
        content.textContent = suffix
        strip.append(content); host.append(strip)
      }
      document.body.append(host)
    })
    const host = page.locator('#horizontal-pointer-fixture'), focus = host.locator('#horizontal-pointer-focus')
    const first = host.locator('#horizontal-pointer-first'), second = host.locator('#horizontal-pointer-second')
    try {
      await focus.focus(); await first.hover(); await expectOverlayAtBottom(first)
      const grip = (await overlay().locator('.horizontal-scrollbar__thumb').boundingBox())!
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      try { await page.mouse.move(grip.x + grip.width / 2 + 70, grip.y + grip.height / 2, { steps: 4 }) }
      finally { await page.mouse.up() }
      await expect.poll(() => first.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
      await expect(focus).toBeFocused()
      await second.hover(); await expectOverlayAtBottom(second)
      await expect(overlay()).toHaveAttribute('aria-controls', 'horizontal-pointer-second')
      const firstAfterDrag = await first.evaluate(element => element.scrollLeft)
      await overlay().hover(); await page.mouse.wheel(0, 80)
      await expect.poll(() => second.evaluate(element => element.scrollLeft)).toBeGreaterThan(40)
      expect(await first.evaluate(element => element.scrollLeft)).toBe(firstAfterDrag)

      for (const reason of ['no-overflow', 'hidden'] as const) {
        await host.evaluate(element => { (element as HTMLElement).style.display = '' })
        await first.evaluate(element => {
          (element.firstElementChild as HTMLElement).style.width = '1200px'; element.scrollLeft = 0
        })
        await focus.focus(); await first.hover(); await expectOverlayAtBottom(first)
        await expect(overlay()).toHaveAttribute('aria-valuenow', '0')
        const bar = (await overlay().elementHandle())!
        await bar.evaluate(element => element.addEventListener('pointerdown', event => {
          if (event instanceof PointerEvent) (element as HTMLElement).dataset.e2ePointerId = String(event.pointerId)
        }, { once: true }))
        const thumb = (await overlay().locator('.horizontal-scrollbar__thumb').boundingBox())!
        await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
        await page.mouse.down()
        try {
          await expect.poll(() => bar.evaluate(element => element.hasPointerCapture(Number((element as HTMLElement).dataset.e2ePointerId)))).toBe(true)
          if (reason === 'no-overflow') await first.evaluate(element => { (element.firstElementChild as HTMLElement).style.width = '180px' })
          else await host.evaluate(element => { (element as HTMLElement).style.display = 'none' })
          await expect(overlay()).toBeHidden()
          await expect.poll(() => bar.evaluate(element => element.hasPointerCapture(Number((element as HTMLElement).dataset.e2ePointerId)))).toBe(false)
          expect(await bar.evaluate(element => element.classList.contains('is-dragging'))).toBe(false)
          expect(await bar.evaluate(element => document.activeElement === element)).toBe(false)
          if (reason === 'no-overflow') await expect(focus).toBeFocused()
        } finally { await page.mouse.up(); await bar.dispose() }
      }
    } finally { await host.evaluate(element => element.remove()) }
    await expect(overlay()).toBeHidden()
  })

  test('transform 居中模态中的横条留在模态内且准确贴底', async () => {
    await page.evaluate(() => {
      const dialog = document.createElement('section')
      dialog.id = 'horizontal-modal-fixture'
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '横条模态验收')
      dialog.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:480px;height:240px;padding:20px;box-sizing:border-box;overflow:hidden;z-index:30;background:var(--bg-surface)'
      const button = document.createElement('button')
      button.textContent = '模态焦点'
      const strip = document.createElement('div'), content = document.createElement('div')
      strip.dataset.scrollAxis = 'x'
      strip.style.cssText = 'width:360px;height:48px;margin-top:20px;overflow-x:auto;overflow-y:hidden;border:1px solid var(--border)'
      content.style.cssText = 'width:1200px;height:28px'
      content.textContent = '模态中的横向内容'
      strip.append(content); dialog.append(button, strip); document.body.append(dialog)
    })
    const dialog = page.getByRole('dialog', { name: '横条模态验收', exact: true }), strip = dialog.locator('[data-scroll-axis="x"]')
    try {
      await dialog.getByRole('button', { name: '模态焦点', exact: true }).focus()
      await expectSlimScrollbar(strip)
      expect(await overlay().evaluate(element => element.parentElement?.id)).toBe('horizontal-modal-fixture')
      expect(await overlay().evaluate(element => getComputedStyle(element).position)).toBe('absolute')
      await overlay().focus()
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('End')
      await expect.poll(() => strip.evaluate(element => Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)))).toBeLessThanOrEqual(1)
      await expectOverlayAtBottom(strip)
      const atEnd = await strip.evaluate(element => element.scrollLeft)
      await overlay().hover(); await page.mouse.wheel(-60, 0)
      await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThan(atEnd - 30)
    } finally { await dialog.evaluate(element => element.remove()) }
    await expect(overlay()).toBeHidden()
  })

  test('工具详情中的双轴代码区域保留原生横纵滚动条和滚轮', async () => {
    await page.evaluate(() => {
      const host = document.createElement('section')
      host.id = 'horizontal-native-detail-fixture'
      host.className = 'logline__detail'
      host.style.cssText = 'position:fixed;left:320px;top:180px;width:400px;z-index:10;background:var(--bg-surface)'
      const markdown = document.createElement('div'), block = document.createElement('div'), pre = document.createElement('pre'), code = document.createElement('code')
      markdown.className = 'md'; block.className = 'md-code'; pre.dataset.scrollAxis = 'x'
      pre.style.cssText = 'width:300px;height:160px;box-sizing:border-box'
      code.style.cssText = 'display:block;width:1000px;height:700px'
      code.textContent = Array.from({ length: 30 }, (_, index) => `${index + 1} tool detail preserves both native scroll directions`).join('\n')
      pre.append(code); block.append(pre); markdown.append(block); host.append(markdown); document.body.append(host)
    })
    const host = page.locator('#horizontal-native-detail-fixture'), pre = host.locator('pre')
    try {
      const styles = await pre.evaluate(element => {
        const style = getComputedStyle(element)
        return { overflowX: style.overflowX, overflowY: style.overflowY, width: style.scrollbarWidth,
          horizontalSize: parseFloat(getComputedStyle(element, '::-webkit-scrollbar').height),
          verticalSize: parseFloat(getComputedStyle(element, '::-webkit-scrollbar').width),
          xOverflow: element.scrollWidth - element.clientWidth, yOverflow: element.scrollHeight - element.clientHeight }
      })
      expect(styles).toMatchObject({ overflowX: 'auto', overflowY: 'auto', width: 'auto' })
      expect(styles.horizontalSize).toBeGreaterThan(0); expect(styles.verticalSize).toBeGreaterThan(0)
      expect(styles.xOverflow).toBeGreaterThan(100); expect(styles.yOverflow).toBeGreaterThan(100)
      await pre.hover(); await expect(overlay()).toBeHidden()
      await page.mouse.wheel(0, 100)
      await expect.poll(() => pre.evaluate(element => element.scrollTop)).toBeGreaterThan(40)
      expect(await pre.evaluate(element => element.scrollLeft)).toBe(0)
      await page.mouse.wheel(100, 0)
      await expect.poll(() => pre.evaluate(element => element.scrollLeft)).toBeGreaterThan(40)
      await expect(overlay()).toBeHidden()
    } finally { await host.evaluate(element => element.remove()) }
  })

  test('像素、行、页滚轮及 Shift、RTL 均按实际尺寸横移', async () => {
    const pixel = await wheelReceipt({ deltaY: 35 })
    expect(pixel).toMatchObject({ before: 120, prevented: true, dispatched: false })
    expect(pixel.after).toBeCloseTo(155, 0)
    const line = await wheelReceipt({ deltaY: 3, deltaMode: 1 })
    expect(line.after - line.before).toBeCloseTo(3 * line.lineHeight, 0)
    expect(line.prevented).toBe(true)
    const pageUnit = await wheelReceipt({ deltaY: 1, deltaMode: 2 })
    expect(pageUnit.after - pageUnit.before).toBeCloseTo(pageUnit.width, 0)
    expect(pageUnit.prevented).toBe(true)
    const shift = await wheelReceipt({ deltaY: 35, shiftKey: true })
    expect(shift.prevented).toBe(true); expect(shift.after).toBeCloseTo(155, 0)
    const rtl = await wheelReceipt({ deltaY: -35, rtl: true, start: 0 })
    expect(rtl).toMatchObject({ before: 0, prevented: true }); expect(rtl.after).toBeCloseTo(-35, 0)
    const rtlBack = await wheelReceipt({ deltaY: 35, rtl: true, start: -80 })
    expect(rtlBack).toMatchObject({ before: -80, prevented: true }); expect(rtlBack.after).toBeCloseTo(-45, 0)
  })

  test('原生横向手势、修饰键和滚动边缘保留默认行为', async () => {
    for (const gesture of [{ deltaX: 12 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(await wheelReceipt({ deltaY: 30, ...gesture })).toMatchObject({ before: 120, after: 120, prevented: false, dispatched: true })
    }
    expect(await wheelReceipt({ deltaY: 0 })).toMatchObject({ after: 120, prevented: false })
    expect(await wheelReceipt({ deltaY: -30, start: 0 })).toMatchObject({ after: 0, prevented: false, dispatched: true })
    const end = await wheelReceipt({ deltaY: 30, start: 'end' })
    expect(end.after).toBe(end.max); expect(end.prevented).toBe(false)
    const rtlEnd = await wheelReceipt({ deltaY: -30, start: 'end', rtl: true })
    expect(rtlEnd.after).toBe(-rtlEnd.max); expect(rtlEnd.prevented).toBe(false)
    expect(await wheelReceipt({ deltaY: 30, start: 0, rtl: true })).toMatchObject({ after: 0, prevented: false })
  })

  test('双向容器、嵌套滚动区、编辑控件和已处理事件不会被劫持', async () => {
    for (const nested of ['vertical', 'horizontal', 'input', 'textarea', 'select', 'editable'] as const) {
      expect(await wheelReceipt({ deltaY: 30, nested })).toMatchObject({ before: 120, after: 120, prevented: false })
    }
    expect(await wheelReceipt({ deltaY: 30, bidirectional: true })).toMatchObject({ after: 120, prevented: false })
    expect(await wheelReceipt({ deltaY: 30, fits: true })).toMatchObject({ before: 0, after: 0, max: 0, prevented: false, dispatched: true })
    expect(await wheelReceipt({ deltaY: 30, marked: false })).toMatchObject({ after: 120, prevented: false })
    expect(await wheelReceipt({ deltaY: 30, prevented: true })).toMatchObject({ after: 120, prevented: true })
    expect(await wheelReceipt({ deltaY: 30, cancelable: false })).toMatchObject({ after: 120, prevented: false })
  })

  test('真实滚轮在嵌套纵向区域保持纵滚，到横向边缘继续交给外层纵滚', async () => {
    await page.evaluate(() => {
      const host = document.createElement('section')
      host.id = 'horizontal-wheel-native-fixture'
      host.style.cssText = 'position:fixed;left:400px;top:180px;width:320px;height:200px;overflow:auto;z-index:10;background:var(--bg-surface)'
      const strip = document.createElement('div')
      strip.dataset.scrollAxis = 'x'
      strip.style.cssText = 'width:280px;height:110px;overflow-x:auto;overflow-y:hidden'
      const content = document.createElement('div')
      content.style.cssText = 'width:1000px;height:100px'
      const nested = document.createElement('div')
      nested.id = 'horizontal-wheel-native-child'
      nested.style.cssText = 'width:150px;height:80px;overflow:auto'
      const childContent = document.createElement('div')
      childContent.style.cssText = 'height:600px;width:100px'
      childContent.textContent = '原生纵向滚动'
      nested.append(childContent); content.append(nested); strip.append(content)
      const below = document.createElement('div')
      below.style.height = '1000px'
      host.append(strip, below); document.body.append(host)
    })
    const host = page.locator('#horizontal-wheel-native-fixture'), strip = host.locator('[data-scroll-axis="x"]')
    try {
      await page.locator('#horizontal-wheel-native-child').hover()
      await page.mouse.wheel(0, 120)
      await expect.poll(() => page.locator('#horizontal-wheel-native-child').evaluate(element => element.scrollTop)).toBeGreaterThan(50)
      expect(await strip.evaluate(element => element.scrollLeft)).toBe(0)
      expect(await host.evaluate(element => element.scrollTop)).toBe(0)
      await strip.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth })
      const end = await strip.evaluate(element => element.scrollLeft)
      await strip.hover({ position: { x: 240, y: 40 } })
      await page.mouse.wheel(0, 120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeGreaterThan(50)
      expect(await strip.evaluate(element => element.scrollLeft)).toBe(end)
      await host.evaluate(element => { element.scrollTop = 0 })
      await strip.hover(); await expectOverlayAtBottom(strip)
      await overlay().hover(); await page.mouse.wheel(0, 120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeGreaterThan(50)
      expect(await strip.evaluate(element => element.scrollLeft)).toBe(end)
    } finally { await host.evaluate(element => element.remove()) }
  })
})
