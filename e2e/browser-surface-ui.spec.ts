/** Native compositor regression: resize the network drawer, switch IDE tabs, and verify the visible guest pixels and bounds. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
let fixture = '',
  origin = '',
  app: ElectronApplication | undefined,
  page: Page
const errors: string[] = []
const server = createServer((request, response) =>
  response
    .writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    .end(
      request.url === '/fixed'
        ? '<!doctype html><meta charset="utf-8"><title>固定布局绘制验收</title><style>body{margin:0;width:1800px;height:1800px}h1{margin:0;padding:20px;font:22px sans-serif}</style><h1>带滚动条的固定布局</h1>'
        : '<!doctype html><meta charset="utf-8"><title>原生网页绘制验收</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(22,139,112)}h1{margin:0;padding:30px;color:white;font:22px sans-serif}</style><h1>网页真实内容 · 不应被占位遮挡</h1>'
    )
)

async function geometry() {
  const dom = await page.locator('.browser-surface').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      placeholders: document.querySelectorAll('.browser-surface__placeholder').length
    }
  })
  const native = await app!.evaluate(({ BrowserWindow, WebContentsView }, origin) => {
    const host = BrowserWindow.getAllWindows()[0]
    const views = host.contentView.children
      .filter((view) => view instanceof WebContentsView)
      .map((view) => ({
        bounds: view.getBounds(),
        visible: view.getVisible(),
        url: view instanceof WebContentsView ? view.webContents.getURL() : ''
      }))
    return {
      zoom: host.webContents.getZoomFactor(),
      views,
      guest: views.find((view) => view.url.startsWith(origin))
    }
  }, origin)
  return { dom, native }
}

async function capture(testInfo: TestInfo, name: string) {
  const result = await app!.evaluate(
    async ({ BrowserWindow, WebContentsView, desktopCapturer }, origin) => {
      const host = BrowserWindow.getAllWindows()[0]
      const guest = host.contentView.children.find(
        (view) => view instanceof WebContentsView && view.webContents.getURL().startsWith(origin)
      )
      if (!guest) throw new Error('Missing native guest')
      const beforeBounds = guest.getBounds(),
        beforeHostBounds = host.getBounds()
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: beforeHostBounds.width * 2, height: beforeHostBounds.height * 2 }
      })
      const source = sources.find((source) => source.id === host.getMediaSourceId())
      if (!source || source.thumbnail.isEmpty()) return null
      const bounds = guest.getBounds(), hostBounds = host.getBounds()
      const stable = JSON.stringify(bounds) === JSON.stringify(beforeBounds) &&
        JSON.stringify(hostBounds) === JSON.stringify(beforeHostBounds)
      const size = source.thumbnail.getSize(),
        bitmap = source.thumbnail.toBitmap()
      const samples = [0.55, 0.72, 0.87].flatMap((y) =>
        [0.2, 0.8].map((x) => {
          const px = Math.round(((bounds.x + bounds.width * x) * size.width) / hostBounds.width)
          const py = Math.round(((bounds.y + bounds.height * y) * size.height) / hostBounds.height)
          const offset = (py * size.width + px) * 4
          return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
        })
      )
      return {
        png: source.thumbnail.toPNG().toString('base64'),
        size,
        bounds,
        beforeBounds,
        hostBounds,
        beforeHostBounds,
        stable,
        visible: guest.getVisible(),
        samples
      }
    },
    origin
  )
  if (result) writeFileSync(testInfo.outputPath(`${name}.png`), Buffer.from(result.png, 'base64'))
  return result
}

async function verifySurface(testInfo: TestInfo, name: string, expected = [22, 139, 112]) {
  if ((await page.locator('.browser-surface').count()) !== 1)
    await capture(testInfo, `${name}-duplicate-surfaces`)
  await expect(page.locator('.browser-surface')).toHaveCount(1)
  await expect
    .poll(async () => {
      const state = await geometry()
      return (
        !!state.native.guest?.visible &&
        (['x', 'y', 'width', 'height'] as const).every(
          (key) =>
            Math.abs(state.native.guest!.bounds[key] - state.dom[key] * state.native.zoom) <= 2
        )
      )
    })
    .toBe(true)
    .catch(async (error) => {
      console.log('BROWSER_SURFACE_GEOMETRY', name, JSON.stringify(await geometry()))
      await capture(testInfo, `${name}-geometry-failure`)
      throw error
    })
  expect((await geometry()).dom.placeholders).toBeLessThanOrEqual(1)
  let actual = await capture(testInfo, name)
  test.skip(!actual, '当前桌面环境未提供原生窗口截图；DOM 和原生区域几何已验证')
  // Desktop capture can span a React/native resize. Sample only a stable frame,
  // and wait for actual guest paint; unchanged placeholder pixels still fail.
  const painted = () => Boolean(actual?.stable && actual.visible && actual.samples.every(sample =>
    Math.max(...sample.map((value, index) => Math.abs(value - expected[index]))) <= 4))
  if (!painted()) {
    await expect.poll(async () => { actual = await capture(testInfo, name); return painted() }, { timeout: 20_000 }).toBe(true)
  }
  if (actual) { const { png: _png, ...state } = actual; writeFileSync(testInfo.outputPath(name + '.json'), JSON.stringify(state, null, 2)) }
  // Desktop thumbnails are resampled at the display scale; tolerate rounding,
  // while a stale dark placeholder or missing page remains far outside this range.
  expect(actual!.samples).toHaveLength(6)
  for (const sample of actual!.samples) {
    expect(
      Math.max(...sample.map((value, index) => Math.abs(value - expected[index]))),
      JSON.stringify({ ...(await geometry()), samples: actual!.samples })
    ).toBeLessThanOrEqual(4)
  }
}

test.describe.serial('原生网页与调试面板绘制', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-surface-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({ autoStartEngine: false, engineMode: 'embedded' })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByLabel('网页地址', { exact: true })).toBeVisible()
    await page.getByLabel('网页地址', { exact: true }).fill(origin)
    await page.getByLabel('网页地址', { exact: true }).press('Enter')
    await expect
      .poll(() => page.evaluate(() => window.aether.browser.list()))
      .toContainEqual(expect.objectContaining({ title: '原生网页绘制验收', loading: false }))
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    if (
      dirname(resolve(fixture)) !== join(root, '.e2e-tmp') ||
      !basename(fixture).startsWith('browser-surface-')
    )
      throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('打开网络面板并反复拖动后，原生网页完整显示且没有占位残影', async ({}, testInfo) => {
    await verifySurface(testInfo, 'before-network')
    await page.getByRole('button', { name: '网络', exact: true }).click()
    await verifySurface(testInfo, 'open-network')
    const separator = page.getByRole('separator', { name: '调整网络面板高度', exact: true })
    for (const [index, delta] of [100, -80, 65, -60, 90, -110].entries()) {
      const bounds = await separator.boundingBox()
      if (!bounds) throw new Error('Missing network splitter')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + delta, {
        steps: 10
      })
      await page.mouse.up()
      await verifySurface(testInfo, `resize-${index}`)
    }
  })

  test('带滚动条网页在深色主题、工作台缩放和窗口连续缩放后没有原生绘制残留', async ({}, testInfo) => {
    const network = page.getByRole('button', { name: '网络', exact: true })
    if ((await network.getAttribute('aria-pressed')) !== 'true') await network.click()
    await page.evaluate(() => {
      document.documentElement.dataset.appearance = 'dark'
    })
    const tabId = (await page.evaluate(() => window.aether.browser.list()))[0].tabId
    await page.evaluate(
      ({ tabId, url }) => window.aether.browser.action({ tabId, action: 'navigate', url }),
      { tabId, url: `${origin}/fixed` }
    )
    await verifySurface(testInfo, 'fixed-before', [255, 255, 255])
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)
    )
    await verifySurface(testInfo, 'fixed-zoom', [255, 255, 255])
    for (const [index, size] of [
      [1300, 850],
      [1500, 920],
      [1100, 760],
      [1400, 1000]
    ].entries()) {
      await app!.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        size
      )
      await verifySurface(testInfo, `fixed-window-${index}`, [255, 255, 255])
    }
    const separator = page.getByRole('separator', { name: '调整网络面板高度', exact: true })
    for (const [index, delta] of [100, -80, 65, -60, 90, -110].entries()) {
      const bounds = await separator.boundingBox()
      if (!bounds) throw new Error('Missing network splitter')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + delta, {
        steps: 10
      })
      await page.mouse.up()
      await verifySurface(testInfo, `fixed-resize-${index}`, [255, 255, 255])
    }
  })
})
