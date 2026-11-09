/** Real Electron without engine/model calls: generated XLSX files use the
 * production Office worker and sheet tabs. DOM fixtures exercise simultaneous
 * edge hints, RTL, resize/mutations and preserved pointer/wheel behavior. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ExcelJS from 'exceljs'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const manyName = '多工作表渐变验收.xlsx', singleName = '单工作表渐变验收.xlsx'
const shortSheetNames = ['项目概览', '模块清单', '测试明细', '主题配置', '操作说明']
const sheetNames = Array.from({ length: 14 }, (_, index) => shortSheetNames[index] ?? `工作表${String(index + 1).padStart(2, '0')}－完整标题`)
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', workspace = ''
let exited = false, exitCode: number | null = null
const preview = () => page.locator('.document-preview[data-document-preview="xlsx"]:visible').last()
const sheets = () => preview().getByRole('tablist', { name: '工作表', exact: true })

async function openWorkbook(name: string): Promise<void> {
  await page.locator('input.work-resource-tabs__file-input').setInputFiles(join(workspace, name))
  await expect(preview()).toBeVisible()
  await expect(sheets().getByRole('tab')).toHaveCount(name === manyName ? sheetNames.length : 1)
  await expect(preview().getByRole('cell', { name: name === manyName ? 'SHEET_CONTENT_1' : 'ONLY_SHEET_CONTENT', exact: true })).toBeVisible()
}

async function expectEdges(target: Locator, edges: 'left' | 'right' | 'both' | null): Promise<void> {
  if (edges === null) {
    await expect(target).not.toHaveAttribute('data-scroll-edges')
    await expect(target).toHaveCSS('mask-image', 'none')
    return
  }
  await expect(target).toHaveAttribute('data-scroll-edges', edges)
  const paint = await target.evaluate(element => {
    const style = getComputedStyle(element)
    return { mask: style.maskImage, mode: style.maskMode, width: style.getPropertyValue('--horizontal-scroll-fade-width').trim(),
      left: style.getPropertyValue('--scroll-fade-left').trim(), right: style.getPropertyValue('--scroll-fade-right').trim() }
  })
  expect(paint.mask).toContain('linear-gradient(')
  expect(paint.mask).toContain('rgba(0, 0, 0, 0)')
  expect(paint.mode).toBe('alpha'); expect(paint.width).toBe('28px')
  expect(paint.left === '0px').toBe(edges === 'right')
  expect(paint.right === '0px').toBe(edges === 'left')
}

async function setPosition(target: Locator, position: 'start' | 'middle' | 'end'): Promise<void> {
  await target.evaluate((element, position) => {
    const max = element.scrollWidth - element.clientWidth
    const direction = getComputedStyle(element).direction === 'rtl' ? -1 : 1
    element.scrollLeft = direction * (position === 'start' ? 0 : position === 'middle' ? max / 2 : max)
  }, position)
}

async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}

async function createStrips(options: { widths?: number[]; rtl?: boolean[] } = {}): Promise<void> {
  await page.evaluate(options => {
    const host = document.createElement('section')
    host.id = 'scroll-hints-fixture'
    host.style.cssText = 'position:fixed;left:320px;top:160px;width:460px;padding:20px;z-index:10;background:var(--bg-surface);color:var(--fg)'
    for (let index = 0; index < (options.widths?.length ?? 2); index++) {
      const strip = document.createElement('div'), content = document.createElement('div')
      strip.id = `scroll-hints-strip-${index}`; strip.dataset.scrollAxis = 'x'
      strip.style.cssText = 'width:360px;height:48px;box-sizing:border-box;margin-block:12px;overflow-x:auto;overflow-y:hidden;border:1px solid var(--border)'
      if (options.rtl?.[index]) strip.dir = 'rtl'
      content.className = 'scroll-hints-content'
      content.style.cssText = `display:flex;width:${options.widths?.[index] ?? 1200}px;height:32px`
      for (let item = 0; item < 12; item++) {
        const button = document.createElement('button')
        button.type = 'button'; button.textContent = `区域${index} 标签${item}`
        button.style.cssText = 'flex:0 0 100px;height:28px;white-space:nowrap'
        button.addEventListener('click', () => { strip.dataset.clicked = String(item) })
        content.append(button)
      }
      // A small fixture must really fit; flex children otherwise create overflow.
      if ((options.widths?.[index] ?? 1200) <= 360) content.replaceChildren(content.firstElementChild!)
      strip.append(content); host.append(strip)
    }
    document.body.append(host)
  }, options)
}
const fixtureStrip = (index = 0) => page.locator(`#scroll-hints-strip-${index}`)

test.describe.serial('横向区域常驻渐变提示', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'horizontal-scroll-hints-'))
    workspace = join(fixture, 'workspace'); const profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    writeFileSync(join(workspace, 'binary-scroll.bin'), Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)))
    for (const [name, names] of [[manyName, sheetNames], [singleName, ['唯一工作表']]] as const) {
      const workbook = new ExcelJS.Workbook()
      names.forEach((sheetName, index) => { const sheet = workbook.addWorksheet(sheetName); sheet.getColumn(1).width = 30; sheet.getCell('A1').value = name === manyName ? `SHEET_CONTENT_${index + 1}` : 'ONLY_SHEET_CONTENT' })
      writeFileSync(join(workspace, name), Buffer.from(await workbook.xlsx.writeBuffer()))
    }
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'light' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
    app.process().once('exit', code => { exited = true; exitCode = code })
    await app.evaluate(({ app, webContents }) => {
      const state = globalThis as typeof globalThis & { __scrollHintsCrashes?: string[] }
      state.__scrollHintsCrashes = []
      const observe = (contents: Electron.WebContents): void => { contents.on('render-process-gone', (_event, details) => { state.__scrollHintsCrashes!.push(`${details.reason}:${details.exitCode}`) }) }
      webContents.getAllWebContents().forEach(observe); app.on('web-contents-created', (_event, contents) => observe(contents))
      app.on('child-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') state.__scrollHintsCrashes!.push(`${details.type}:${details.reason}:${details.exitCode}`) })
    })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await page.evaluate(workspace => {
      const task = { id: 'work-scroll-hints', title: '横向渐变提示验收', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [task], activeTaskId: task.id }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'files', pane: 'conversation', ratio: 44 }))
    }, workspace)
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
    await expect(page.locator('input.work-resource-tabs__file-input')).toBeAttached()
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      if (info.status !== info.expectedStatus) {
        const screenshot = info.outputPath('horizontal-scroll-hints-failure.png')
        await page.screenshot({ path: screenshot }); await info.attach('渐变提示失败窗口', { path: screenshot, contentType: 'image/png' })
      }
      await page.locator('#scroll-hints-fixture').evaluateAll(elements => elements.forEach(element => element.remove()))
    }
    expect(errors).toEqual([]); expect(exited).toBe(false)
    if (app) expect(await app.evaluate(() => (globalThis as typeof globalThis & { __scrollHintsCrashes?: string[] }).__scrollHintsCrashes)).toEqual([])
  })
  test.afterAll(async () => {
    try {
      await app?.close()
      if (app) { await expect.poll(() => exited).toBe(true); expect(exitCode).toBe(0) }
    } finally {
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('horizontal-scroll-hints-')) throw new Error('Unsafe scroll-hints fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('真实工作表标签在起点、中间和终点显示正确边缘，离开鼠标后仍可见', async ({}, info) => {
    await openWorkbook(manyName)
    await expect.poll(() => sheets().evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(200)
    await page.mouse.move(24, 80)
    await setPosition(sheets(), 'start'); await expectEdges(sheets(), 'right')
    await setPosition(sheets(), 'middle'); await expectEdges(sheets(), 'both')
    expect(await sheets().evaluate(element => element.matches(':hover'))).toBe(false)
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await setPosition(sheets(), 'start'); await page.mouse.move(24, 80)
      await expectEdges(sheets(), 'right')
      const startScreenshot = info.outputPath(`sheet-tabs-hints-start-${appearance}.png`)
      await preview().locator('.document-preview__toolbar--sheets').screenshot({ path: startScreenshot })
      await info.attach(`工作表短标题-${appearance}`, { path: startScreenshot, contentType: 'image/png' })
      await setPosition(sheets(), 'middle'); await page.mouse.move(24, 80)
      await expectEdges(sheets(), 'both')
      const screenshot = info.outputPath(`sheet-tabs-hints-${appearance}.png`)
      await preview().locator('.document-preview__toolbar--sheets').screenshot({ path: screenshot })
      await info.attach(`工作表渐变-${appearance}`, { path: screenshot, contentType: 'image/png' })
    }
    await setPosition(sheets(), 'end'); await expectEdges(sheets(), 'left')
    const last = sheets().getByRole('tab', { name: sheetNames.at(-1)!, exact: true })
    await last.click()
    await expect(last).toHaveAttribute('aria-selected', 'true')
    await expect(preview().getByRole('cell', { name: 'SHEET_CONTENT_14', exact: true })).toBeVisible()
    await setPosition(sheets(), 'start'); await sheets().hover(); await page.mouse.wheel(0, 120)
    await expect.poll(() => sheets().evaluate(element => element.scrollLeft)).toBeGreaterThan(50)
    await expectEdges(sheets(), 'both')
    await expect(last).toHaveAttribute('aria-selected', 'true')
    await expect(preview().getByRole('cell', { name: 'SHEET_CONTENT_14', exact: true })).toBeVisible()
  })

  test('真实单工作表没有溢出时不显示渐变或预留滚动条高度', async () => {
    await openWorkbook(singleName)
    expect(await sheets().evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
    await expectEdges(sheets(), null)
    const reserved = await sheets().evaluate(element => {
      const node = element as HTMLElement, style = getComputedStyle(element)
      return node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
    })
    expect(Math.abs(reserved)).toBeLessThanOrEqual(1)
  })

  test('多个单轴区域同时保持各自提示，RTL 使用物理左右边缘', async () => {
    await page.mouse.move(24, 80)
    await createStrips({ rtl: [false, true] })
    await expectEdges(fixtureStrip(0), 'right'); await expectEdges(fixtureStrip(1), 'left')
    await setPosition(fixtureStrip(0), 'middle'); await setPosition(fixtureStrip(1), 'middle')
    await expectEdges(fixtureStrip(0), 'both'); await expectEdges(fixtureStrip(1), 'both')
    await setPosition(fixtureStrip(0), 'end'); await setPosition(fixtureStrip(1), 'end')
    await expectEdges(fixtureStrip(0), 'left'); await expectEdges(fixtureStrip(1), 'right')
    await setPosition(fixtureStrip(0), 'start')
    await expectEdges(fixtureStrip(0), 'right'); await expectEdges(fixtureStrip(1), 'right')
    expect(await page.locator('#scroll-hints-fixture').evaluate(element => element.matches(':hover'))).toBe(false)
  })

  test('新增删除内容、子项尺寸和容器宽度变化会更新提示，内容纵向位置不移动', async () => {
    await createStrips({ widths: [180] })
    const strip = fixtureStrip(), content = strip.locator('.scroll-hints-content')
    const geometry = () => strip.evaluate(element => {
      const bounds = element.getBoundingClientRect(), child = element.querySelector('button')!.getBoundingClientRect()
      return { height: bounds.height, innerHeight: element.clientHeight, top: child.top - bounds.top, childHeight: child.height }
    })
    await expectEdges(strip, null)
    const before = await geometry()
    await content.evaluate(element => {
      (element as HTMLElement).style.width = 'max-content'
      for (let index = 1; index < 8; index++) { const button = element.firstElementChild!.cloneNode(true); element.append(button) }
    })
    await expectEdges(strip, 'right'); expect(await geometry()).toEqual(before)
    await strip.evaluate(element => { (element as HTMLElement).style.width = '900px' })
    await expectEdges(strip, null)
    await strip.evaluate(element => { (element as HTMLElement).style.width = '360px' })
    await expectEdges(strip, 'right')
    await content.evaluate(element => element.replaceChildren(element.firstElementChild!))
    await expectEdges(strip, null); expect(await geometry()).toEqual(before)
    await content.locator('button').evaluate(element => { (element as HTMLElement).style.flexBasis = '800px' })
    await expectEdges(strip, 'right')
    await setPosition(strip, 'middle'); await expectEdges(strip, 'both')
    await content.locator('button').evaluate(element => { (element as HTMLElement).style.flexBasis = '100px' })
    await expectEdges(strip, null)
  })

  test('双轴、隐藏和撤去单轴标记会清除渐变，再次可见或标记后恢复', async () => {
    await createStrips({ widths: [1200] })
    const strip = fixtureStrip()
    await expectEdges(strip, 'right')
    await strip.evaluate(element => { (element as HTMLElement).style.overflowY = 'auto' })
    await expectEdges(strip, null)
    await strip.evaluate(element => { (element as HTMLElement).style.overflowY = 'hidden' })
    await expectEdges(strip, 'right')
    await page.locator('#scroll-hints-fixture').evaluate(element => { (element as HTMLElement).hidden = true })
    await expectEdges(strip, null)
    await page.locator('#scroll-hints-fixture').evaluate(element => { (element as HTMLElement).hidden = false })
    await expectEdges(strip, 'right')
    await strip.evaluate(element => element.removeAttribute('data-scroll-axis'))
    await expectEdges(strip, null)
    await strip.evaluate(element => element.setAttribute('data-scroll-axis', 'x'))
    await expectEdges(strip, 'right')
  })

  test('渐隐区域保留点击命中与原生横向滚轮，普通滚轮仍可横移', async () => {
    await createStrips({ widths: [1200] })
    const strip = fixtureStrip()
    await setPosition(strip, 'middle'); await expectEdges(strip, 'both')
    const clicked = await strip.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const point = { x: bounds.left + 12, y: bounds.top + 14 }
      const target = document.elementFromPoint(point.x, point.y)
      return { ...point, index: target instanceof HTMLButtonElement ? [...element.querySelectorAll('button')].indexOf(target) : -1 }
    })
    expect(clicked.index).toBeGreaterThanOrEqual(0)
    await page.mouse.click(clicked.x, clicked.y)
    await expect(strip).toHaveAttribute('data-clicked', String(clicked.index))
    await setPosition(strip, 'start'); await strip.hover(); await page.mouse.wheel(0, 120)
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(50)
    await expectEdges(strip, 'both')
    const before = await strip.evaluate(element => element.scrollLeft)
    await page.mouse.wheel(100, 0)
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(before + 40)
    expect(await strip.evaluate(element => element.scrollTop)).toBe(0)
  })

  test('真实二进制预览的文本横移保留外层纵滚，到横向边缘继续浏览后续行', async () => {
    await page.locator('input.work-resource-tabs__file-input').setInputFiles(join(workspace, 'binary-scroll.bin'))
    const binary = page.locator('.preview:visible').last(), hex = binary.locator('.preview__hex')
    await expect(hex).toContainText('00000000')
    // 单独约束真实预览组件，稳定覆盖窄且矮的分栏，而不依赖桌面窗口的DPR。
    await binary.evaluate(element => { Object.assign((element as HTMLElement).style, { flex: 'none', width: '320px', height: '240px' }) })
    const body = binary.locator('.preview__body')
    await expect.poll(() => hex.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(50)
    await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
    await expectEdges(hex, 'right')
    const box = await body.boundingBox()
    if (!box) throw new Error('Missing binary preview bounds')
    await page.mouse.move(box.x + box.width / 2, box.y + 40)
    await page.mouse.wheel(0, 80)
    await expect.poll(() => hex.evaluate(element => element.scrollLeft)).toBeGreaterThan(30)
    expect(await body.evaluate(element => element.scrollTop)).toBe(0)
    await setPosition(hex, 'end'); await expectEdges(hex, 'left')
    await page.mouse.wheel(0, 160)
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(50)
    expect(await hex.evaluate(element => element.scrollTop)).toBe(0)
  })
})
