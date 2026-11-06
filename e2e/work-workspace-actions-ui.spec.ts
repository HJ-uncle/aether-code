/** Real Electron with the engine disabled: workspace overflow actions use the
 * native file input/browser service, local browser files retain ownership and
 * file glyphs, and the shared menu leaves the full remaining width to tabs. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const taskId = 'work-resource-menu-test', readmeText = '# README_MENU_MARKER\n\n菜单打开的本地说明文件。'
const labels = ['成果', '工作区', '资料', '子代理', 'Git', '打开文件…', '新建网页']
const longNames = Array.from({ length: 9 }, (_, index) => `工作资料-${index + 1}-需要保留完整文件类型图标与标题.txt`)
const errors: string[] = []
let fixture = '', workspacePath = '', externalReadmeId = '', externalJsonId = ''
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page

const work = () => page.locator('.work-view')
const workspace = () => work().getByRole('region', { name: '任务工作区', exact: true })
const more = () => workspace().getByRole('button', { name: '更多工作区', exact: true })
const menu = () => page.locator('.work-workspace-menu').getByRole('menu')
const browser = () => workspace().getByRole('region', { name: '内置浏览器', exact: true })
const tabs = () => page.evaluate(() => window.aether.browser.list())
const browserTab = (tabId: string) => workspace().locator(`[id="work-resource-tab-${encodeURIComponent(`web:${tabId}`)}"]`)
const fileTab = (id: string) => workspace().locator(`[id="${id}"]`)

async function openMenu(): Promise<void> {
  if (await more().getAttribute('aria-expanded') !== 'true') await more().click()
  await expect(menu()).toBeVisible()
}

async function pickFile(name: string): Promise<Locator> {
  await openMenu()
  const choosing = page.waitForEvent('filechooser')
  await menu().getByRole('menuitem', { name: '打开文件…', exact: true }).click()
  const chooser = await choosing
  await chooser.setFiles(join(workspacePath, name))
  await expect(page.locator('.work-workspace-menu')).toHaveCount(0)
  const tab = workspace().getByRole('tab', { name, exact: true })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return tab
}

async function nextBrowserTab(previous: BrowserTabState[]): Promise<BrowserTabState> {
  let next: BrowserTabState | undefined
  await expect.poll(async () => {
    next = (await tabs()).find(tab => !previous.some(old => old.tabId === tab.tabId) && !tab.loading)
    return next?.tabId ?? null
  }).not.toBeNull()
  expect(next!.presentation).toMatchObject({ mode: 'work', sessionId: taskId })
  await expect(browserTab(next!.tabId)).toHaveAttribute('aria-selected', 'true')
  return next!
}

async function newWebpage(): Promise<BrowserTabState> {
  const previous = await tabs()
  await openMenu()
  await menu().getByRole('menuitem', { name: '新建网页', exact: true }).click()
  const next = await nextBrowserTab(previous)
  expect(next.url).toBe('about:blank')
  await expect(browser()).toBeVisible()
  await expect(browserTab(next.tabId).locator('.tree-row__glyph')).toHaveCount(0)
  return next
}

test.describe.serial('Work 工作区资源菜单', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-resource-menu-'))
    workspacePath = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(workspacePath); mkdirSync(profile)
    writeFileSync(join(workspacePath, 'README.md'), readmeText)
    writeFileSync(join(workspacePath, 'settings.json'), '{"menuFileMarker":"JSON_MENU_MARKER"}\n')
    for (const name of longNames) writeFileSync(join(workspacePath, name), `${name}\nWORKSPACE_MENU_LONG_TAB`)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspacePath, appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-resource-menu')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await page.evaluate(({ taskId, workspacePath }) => {
      const now = Date.now()
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: taskId, title: '工作区菜单验收',
        draft: 'MENU_DRAFT_PRESERVED', status: 'draft', createdAt: now, updatedAt: now, workspacePath,
        modelId: '', attachments: [], sources: [] }], activeTaskId: taskId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { taskId, workspacePath })
    await page.reload()
    await expect(work().getByRole('heading', { name: '工作区菜单验收', exact: true })).toBeVisible()
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(workspace()).toBeVisible()
    await expect(workspace().locator('input.work-resource-tabs__file-input')).toBeAttached()
  })

  test.afterEach(() => { expect(errors).toEqual([]); health?.assertHealthy() })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      if (!fixture) return
      const owned = resolve(fixture)
      if (dirname(owned) !== parent || !basename(owned).startsWith('work-resource-menu-')) throw new Error(`Unsafe resource-menu cleanup: ${owned}`)
      rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('资源菜单去除重复浏览器入口，打开文件与连续新建网页生效，本地 README 保持类型图标及关闭归属', async () => {
    await openMenu()
    await expect(menu().getByRole('menuitem')).toHaveText(labels)
    await expect(menu().getByRole('menuitem', { name: '浏览器', exact: true })).toHaveCount(0)
    await expect(menu().getByRole('separator')).toHaveCount(1)
    await page.keyboard.press('Escape')
    const readme = await pickFile('README.md')
    externalReadmeId = (await readme.getAttribute('id'))!
    await expect(workspace().locator('.work-artifact-panel-v2[data-document-active="true"]')).toContainText('README_MENU_MARKER')
    const readmeGlyph = await readme.locator('svg.tree-row__glyph').innerHTML()
    expect(readmeGlyph).toContain('<path')
    const json = await pickFile('settings.json')
    externalJsonId = (await json.getAttribute('id'))!
    await expect(workspace().locator('.work-artifact-panel-v2[data-document-active="true"]')).toContainText('JSON_MENU_MARKER')
    expect(await json.locator('svg.tree-row__glyph').innerHTML()).not.toBe(readmeGlyph)

    const firstWeb = await newWebpage()
    const secondWeb = await newWebpage()
    expect(secondWeb.tabId).not.toBe(firstWeb.tabId)
    const previous = await tabs()
    const address = browser().getByRole('textbox', { name: '网页地址', exact: true })
    await address.fill(join(workspacePath, 'README.md')); await address.press('Enter')
    const local = await nextBrowserTab(previous)
    expect(local.localFile).toMatchObject({ name: 'README.md', path: join(workspacePath, 'README.md'), kind: 'text' })
    await expect(browser().getByRole('region', { name: '本地文件预览', exact: true })).toContainText('README_MENU_MARKER')
    expect(await browserTab(local.tabId).locator('svg.tree-row__glyph').innerHTML()).toBe(readmeGlyph)
    await expect(fileTab(externalReadmeId)).toHaveCount(1)
    await browserTab(local.tabId).locator('..').getByRole('button', { name: '关闭网页 README.md', exact: true }).click()
    await expect.poll(async () => (await tabs()).some(tab => tab.tabId === local.tabId)).toBe(false)
    await expect(fileTab(externalReadmeId)).toHaveCount(1)
    expect((await tabs()).map(tab => tab.tabId)).toEqual(expect.arrayContaining([firstWeb.tabId, secondWeb.tabId]))

    const beforeDirectory = await tabs()
    await address.fill(workspacePath); await address.press('Enter')
    const directory = await nextBrowserTab(beforeDirectory)
    expect(directory.localFile?.kind).toBe('directory')
    await expect(browser().getByRole('table', { name: '目录内容', exact: true })).toContainText('README.md')
    await openMenu()
    await menu().getByRole('menuitem', { name: '工作区', exact: true }).click()
    const folderGlyph = await workspace().getByRole('tab', { name: '工作区', exact: true }).locator(':scope > svg').innerHTML()
    expect(await browserTab(directory.tabId).locator(':scope > svg').innerHTML()).toBe(folderGlyph)
    await fileTab(externalJsonId).click()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText('MENU_DRAFT_PRESERVED')
  })

  test('深浅主题窄宽窗口的菜单可键盘操作，标签占满剩余宽度且长标题仍可滚动', async ({}, info) => {
    for (const name of longNames) {
      await workspace().locator('input.work-resource-tabs__file-input').setInputFiles(join(workspacePath, name))
      await expect(workspace().getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    const strip = workspace().getByRole('tablist', { name: '已打开的工作区', exact: true })
    const toolbar = workspace().getByRole('toolbar', { name: '工作区标签', exact: true })
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      for (const width of [1500, 820]) {
        const contentWidth = await app!.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 1000); return window.getContentSize()[0]
        }, width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(contentWidth)
        const mobileWorkspace = work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ })
        if (await mobileWorkspace.isVisible()) await mobileWorkspace.click()
        await expect(workspace()).toBeVisible()
        await expect(toolbar.locator('.work-workspace__resource-actions, .work-resource-tabs__new')).toHaveCount(0)
        await expect.poll(() => toolbar.evaluate(element => {
          const bounds = element.getBoundingClientRect(), tabs = element.querySelector('[role="tablist"]')!.getBoundingClientRect()
          const actions = element.querySelector('.work-workspace__more')!.getBoundingClientRect(), style = getComputedStyle(element)
          return Math.max(Math.abs(tabs.left - actions.right), Math.abs(bounds.right - parseFloat(style.paddingRight) - tabs.right))
        })).toBeLessThanOrEqual(1)
        await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100)
        await expect.poll(() => strip.evaluate((element, names) => names.every(name => {
          const tab = Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]')).find(item => item.textContent?.trim() === name)
          const label = tab?.querySelector<HTMLElement>('.work-workspace__tab-label'), icon = tab?.querySelector(':scope > svg')
          const wrapper = tab?.closest('.work-workspace__tab')
          if (!label || !icon || !wrapper) return false
          const style = getComputedStyle(label)
          return Math.abs(wrapper.getBoundingClientRect().width - 180) <= 1 && Math.abs(icon.getBoundingClientRect().width - 16) <= 1 &&
            style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth
        }), longNames), { message: '长文件标签保留180 CSS px宽度与16 CSS px图标，文字在自己的区域省略而不挤压图标' }).toBe(true)
        const selected = await strip.getByRole('tab', { selected: true }).getAttribute('id')
        await more().press('ArrowDown')
        await expect(menu().getByRole('menuitem')).toHaveText(labels)
        await expect(menu().getByRole('menuitem', { name: '浏览器', exact: true })).toHaveCount(0)
        await expect(menu().getByRole('separator')).toHaveCount(1)
        await page.keyboard.press('Home')
        await expect(menu().getByRole('menuitem', { name: '成果', exact: true })).toBeFocused()
        await page.keyboard.press('End')
        await expect(menu().getByRole('menuitem', { name: '新建网页', exact: true })).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(menu().getByRole('menuitem', { name: '打开文件…', exact: true })).toBeFocused()
        await page.keyboard.press('Home')
        for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowDown')
        await expect(menu().getByRole('menuitem', { name: '打开文件…', exact: true })).toBeFocused()
        await expect.poll(() => menu().evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
        })).toBe(true)
        for (const item of await menu().getByRole('menuitem').all()) await expect(item).toBeInViewport()
        await page.screenshot({ path: info.outputPath(`work-workspace-menu-${appearance}-${width}.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await expect(page.locator('.work-workspace-menu')).toHaveCount(0)
        await expect(more()).toBeFocused()
        await expect(strip.getByRole('tab', { selected: true })).toHaveAttribute('id', selected!)
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
  })
})
