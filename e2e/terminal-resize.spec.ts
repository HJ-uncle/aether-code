/** Real Electron/xterm/IPC/WebSocket regression: panel dragging, window resize,
 * hidden terminal tabs and font changes must refit both the screen and the PTY.
 * The remote engine/PTY alone is a protocol fixture; UI actions are not mocked. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

interface ResizeFrame { terminalId: string; cols: number; rows: number }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const resizeFrames: ResizeFrame[] = []
const pageErrors: string[] = []
const geometrySamples: unknown[] = []
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let sockets: WebSocketServer | undefined
let createCalls = 0

function latestResize(terminalId: string): ResizeFrame | undefined {
  return resizeFrames.filter(frame => frame.terminalId === terminalId).at(-1)
}

async function settleLayout(): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolveFrame => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
  }))
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.unmaximize()
    window.setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

async function dragPanel(deltaY: number): Promise<void> {
  const handle = page.getByRole('separator', { name: '调整面板高度', exact: true })
  const bounds = await handle.boundingBox()
  if (!bounds) throw new Error('Panel splitter is missing')
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 12 })
  await page.mouse.up()
}

async function recordGeometry(label: string): Promise<void> {
  const geometry = await page.locator('.terminal-view__session:visible').evaluate(container => {
    const screen = container.querySelector('.xterm-screen')
    const term = container.querySelector('.xterm')
    const rows = container.querySelector('.xterm-rows')
    const rect = (element: Element | null) => {
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      const css = getComputedStyle(element)
      return { width: bounds.width, height: bounds.height, top: bounds.top, bottom: bounds.bottom,
        fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight,
        paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, computedHeight: css.height,
        clientHeight: element.clientHeight, clientWidth: element.clientWidth, scrollTop: element.scrollTop }
    }
    const ancestors: unknown[] = []
    for (let node: Element | null = container.parentElement; node; node = node.parentElement) {
      const geometry = rect(node)
      if (geometry) ancestors.push({ className: node.className, ...geometry })
    }
    return { dpr: window.devicePixelRatio, fonts: document.fonts.status, ancestors, host: rect(container), term: rect(term),
      screen: rect(screen), firstRow: rect(rows?.firstElementChild ?? null), rowCount: rows?.childElementCount }
  })
  geometrySamples.push({ label, geometry, resizeFrames: [...resizeFrames] })
}

async function expectScreenFits(terminalId: string): Promise<void> {
  await expect.poll(async () => {
    const dimensions = latestResize(terminalId)
    if (!dimensions) return false
    return page.locator('.terminal-view__session:visible').evaluate((container, size) => {
      const screen = container.querySelector('.xterm-screen')
      const term = container.querySelector('.xterm')
      if (!screen || !term) return false
      const host = container.getBoundingClientRect()
      const rendered = screen.getBoundingClientRect()
      const style = getComputedStyle(term)
      const availableHeight = host.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      const availableWidth = host.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const cellHeight = rendered.height / size.rows
      const cellWidth = rendered.width / size.cols
      // An incomplete final cell and the scrollbar are normal; hundreds of
      // unused pixels below an old-size xterm screen are the reported defect.
      return screen.querySelector('.xterm-rows')?.childElementCount === size.rows &&
        rendered.height > 0 && rendered.width > 0 &&
        availableHeight - rendered.height >= -1 &&
        availableHeight - rendered.height < cellHeight + 2 &&
        availableWidth - rendered.width >= -1 &&
        availableWidth - rendered.width < cellWidth + 25
    }, dimensions)
  }, { message: 'xterm screen must fill the active host to within one cell, and match the last PTY resize' }).toBe(true)
}

test.describe.serial('终端尺寸跟随面板与窗口', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'terminal-resize-'))
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      for await (const _chunk of request) { /* consume the body before responding */ }
      const reply = (data: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, message: 'ok', data }))
      }
      if (path === '/health') return reply({ status: 'ok' })
      if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'terminal-resize-fixture' })
      if (path === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
      if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'terminal-session', finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (path === '/api/v1/chat/runs') return reply({ runs: [] })
      if (path === '/api/v1/workspace/directory') return reply({ root: '/terminal/workspace', entries: [] })
      if (path === '/api/v1/terminal/create') return reply({ terminalId: `fixture-${++createCalls}` })
      return reply([])
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets!.handleUpgrade(request, socket, head, client => sockets!.emit('connection', client, request))
    })
    sockets.on('connection', (client, request) => {
      const terminalId = decodeURIComponent(new URL(request.url ?? '/', 'http://fixture').pathname.split('/').at(-1) ?? '')
      let greeted = false
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; cols?: number; rows?: number; data?: string }
        if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
          resizeFrames.push({ terminalId, cols: message.cols, rows: message.rows })
          if (!greeted) {
            greeted = true
            client.send(JSON.stringify({ type: 'output', data: Array.from({ length: 60 }, (_, index) => `terminal resize output ${index + 1}\r\n`).join('') + '~ $ ' }))
          }
        }
        if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: message.data }))
      })
    })
    await new Promise<void>(resolveListen => server!.listen(0, '127.0.0.1', resolveListen))
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: 'terminal-session', lastFolder: '' }))
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: environment })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
    await setWindowSize(1280, 800)
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    await page.keyboard.press('Control+`')
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    await expect.poll(() => latestResize('fixture-1')?.rows ?? 0).toBeGreaterThan(0)
    await expect(page.locator('.terminal-view__session:visible')).toContainText('~ $')
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
      await recordGeometry('failure')
    }
    if (geometrySamples.length > 0) await testInfo.attach('terminal-geometry-diagnostics', {
      body: JSON.stringify({ geometrySamples, resizeFrames, pageErrors }, null, 2), contentType: 'application/json'
    })
  })

  test.afterAll(async () => {
    await app?.close()
    for (const client of sockets?.clients ?? []) client.terminate()
    sockets?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()))
    if (fixture) {
      if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('terminal-resize-')) throw new Error('Unsafe terminal resize fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('拖动面板放大和缩小后，画面填满容器且远端行数同步', async ({}, testInfo) => {
    await expectScreenFits('fixture-1')
    const initialRows = latestResize('fixture-1')!.rows
    await dragPanel(-240)
    await expect.poll(() => latestResize('fixture-1')?.rows ?? 0).toBeGreaterThan(initialRows + 8)
    await expectScreenFits('fixture-1')
    const grownRows = latestResize('fixture-1')!.rows
    const screenshot = testInfo.outputPath('terminal-expanded.png')
    await page.locator('.terminal-view').screenshot({ path: screenshot })
    await testInfo.attach('终端面板放大后', { path: screenshot, contentType: 'image/png' })
    await dragPanel(60)
    await expect.poll(() => latestResize('fixture-1')?.rows ?? Infinity).toBeLessThan(grownRows)
    await expectScreenFits('fixture-1')
  })

  test('窗口缩放、收起恢复和重复resize事件都保持正确尺寸', async () => {
    const wideCols = latestResize('fixture-1')!.cols
    await setWindowSize(1040, 760)
    await expect.poll(() => latestResize('fixture-1')?.cols ?? Infinity).toBeLessThan(wideCols)
    await expectScreenFits('fixture-1')
    await settleLayout()
    const beforeRepeated = resizeFrames.length
    await page.evaluate(() => {
      for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('resize'))
    })
    await settleLayout()
    expect(resizeFrames.length, '相同行列不应重复向远端发送尺寸').toBe(beforeRepeated)

    await page.getByRole('button', { name: '收起面板', exact: true }).click()
    await expect(page.locator('.terminal-view')).not.toBeVisible()
    await settleLayout()
    const whileHidden = resizeFrames.length
    await setWindowSize(1280, 800)
    await settleLayout()
    expect(resizeFrames.length, '隐藏容器不应发送零尺寸或伪造最小尺寸').toBe(whileHidden)
    await page.keyboard.press('Control+`')
    await expect(page.locator('.terminal-view')).toBeVisible()
    await expect.poll(() => latestResize('fixture-1')?.cols).toBe(wideCols)
    await expectScreenFits('fixture-1')
  })

  test('隐藏会话保持原尺寸，切回后补同步且没有零行零列', async () => {
    await page.getByRole('button', { name: '新建终端', exact: true }).click()
    await expect(page.locator('.terminal-view__item')).toHaveCount(2)
    await expect.poll(() => latestResize('fixture-2')?.rows ?? 0).toBeGreaterThan(0)
    await expectScreenFits('fixture-2')
    const hiddenFrameCount = resizeFrames.filter(frame => frame.terminalId === 'fixture-1').length
    const previousRows = latestResize('fixture-2')!.rows
    await dragPanel(-100)
    await expect.poll(() => latestResize('fixture-2')?.rows ?? 0).toBeGreaterThan(previousRows)
    await expectScreenFits('fixture-2')
    await settleLayout()
    expect(resizeFrames.filter(frame => frame.terminalId === 'fixture-1')).toHaveLength(hiddenFrameCount)

    const visibleRows = latestResize('fixture-2')!.rows
    await page.locator('.terminal-view__item').nth(0).click()
    await expect.poll(() => latestResize('fixture-1')?.rows).toBe(visibleRows)
    await expectScreenFits('fixture-1')
    expect(resizeFrames.every(frame => Number.isInteger(frame.cols) && Number.isInteger(frame.rows) && frame.cols > 0 && frame.rows > 0)).toBe(true)
    // Inactive tabs reveal their close button on hover, as in the real UI.
    await page.locator('.terminal-view__item').nth(1).hover()
    await page.getByRole('button', { name: '关闭 终端 2', exact: true }).click()
    await expect(page.locator('.terminal-view__item')).toHaveCount(1)
    expect(pageErrors).toEqual([])
  })

  test('修改终端字号时无需调整面板即可重新计算行列', async () => {
    // Leave enough editor space to operate the settings page above the panel.
    await dragPanel(220)
    await expectScreenFits('fixture-1')
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette__input').fill('打开设置')
    await page.locator('.palette__item').filter({ hasText: '打开设置' }).click()
    await page.locator('.app-settings__nav').getByRole('tab', { name: '终端', exact: true }).click()
    await expect(page.getByLabel('终端字号', { exact: true })).toBeVisible()
    await expectScreenFits('fixture-1')
    await recordGeometry('before-font-change')
    const before = latestResize('fixture-1')!
    const originalFontSize = await page.getByLabel('终端字号', { exact: true }).inputValue()
    await page.getByLabel('终端字号', { exact: true }).fill('20')
    await expect.poll(() => latestResize('fixture-1')?.rows ?? Infinity).toBeLessThan(before.rows)
    await expect.poll(() => latestResize('fixture-1')?.cols ?? Infinity).toBeLessThan(before.cols)
    await expectScreenFits('fixture-1')
    await recordGeometry('large-font')
    await page.getByLabel('终端字号', { exact: true }).fill(originalFontSize)
    await expect.poll(() => latestResize('fixture-1')?.rows).toBe(before.rows)
    await expectScreenFits('fixture-1')
    await recordGeometry('restored-font')
    expect(pageErrors).toEqual([])
  })
})
