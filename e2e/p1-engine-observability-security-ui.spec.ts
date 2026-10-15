/** Fresh P1 acceptance against real Electron IPC and two real workbench
 * windows. A controlled HTTP/SSE peer verifies remote heartbeat freshness,
 * unavailable runtime telemetry, stream ownership, and connection switching. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { StreamEvent } from '../src/shared/ipc'

const root = resolve(__dirname, '..')
let app: ElectronApplication | undefined
let page: Page
let secondPage: Page
let server: Server | undefined
let fixture = ''
let baseUrl = ''
let instanceId = 'p1-identity-one'
let healthRequests = 0
const peerRequests: string[] = []
const peerStreams = new Map<string, ServerResponse>()
const pageErrors: string[] = []
const manifest = JSON.parse(readFileSync(resolve(root, '..', 'ai-agent-engine', 'dist/runtime/build-manifest.json'), 'utf8'))

interface StreamProbe {
  events: StreamEvent[]
  settled: boolean
  error: string
  off: () => void
}
type ProbeWindow = Window & {
  __p1StreamProbe?: StreamProbe
  __p1VisibilityProbe?: { events: boolean[]; off: () => void }
}

async function installStreamProbe(target: Page, streamId: string): Promise<void> {
  await target.evaluate((id) => {
    const owner = window as ProbeWindow
    owner.__p1StreamProbe?.off()
    const probe: StreamProbe = { events: [], settled: false, error: '', off: () => {} }
    probe.off = window.aether.engine.onStreamEvent(event => {
      if (event.streamId === id) probe.events.push(event)
    })
    owner.__p1StreamProbe = probe
  }, streamId)
}

async function startStream(target: Page, streamId: string, sessionId: string): Promise<void> {
  await target.evaluate(async ({ id, session }) => {
    const probe = (window as ProbeWindow).__p1StreamProbe
    if (!probe) throw new Error('stream probe is missing')
    const expectedEngine = await window.aether.engine.getSnapshot()
    void window.aether.engine.stream.start({ streamId: id, path: '/chat', expectedEngine,
      body: { sessionId: session, message: 'P1 ownership acceptance', modelId: 'p1-model' }
    }).then(() => { probe.settled = true }).catch(error => { probe.error = String(error); probe.settled = true })
  }, { id: streamId, session: sessionId })
}

async function contents(target: Page): Promise<string[]> {
  return target.evaluate(() => ((window as ProbeWindow).__p1StreamProbe?.events ?? [])
    .flatMap(event => event.type === 'payload' && event.payload.content ? [event.payload.content] : []))
}

test.describe.serial('P1 引擎心跳与窗口隔离', () => {
  test.beforeAll(async () => {
    server = createServer(async (request, response) => {
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname
      peerRequests.push(path)
      const json = (data: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, data, message: 'ok', timestamp: Date.now() }))
      }
      if (path === '/health') { healthRequests += 1; json({ status: 'ok' }); return }
      if (path === '/meta') { json({ ...manifest, instanceId }); return }
      if (path === '/models') { json({ models: [{ id: 'p1-model', name: 'P1 model' }] }); return }
      if (path === '/api/v1/chat' && request.method === 'POST') {
        let raw = ''
        for await (const chunk of request) raw += chunk.toString()
        const body = JSON.parse(raw) as { sessionId: string }
        peerStreams.set(body.sessionId, response)
        response.on('close', () => { if (peerStreams.get(body.sessionId) === response) peerStreams.delete(body.sessionId) })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write(`id: ${instanceId}:1\ndata: ${JSON.stringify({ content: `${body.sessionId}:initial` })}\n\n`)
        return
      }
      if (path === '/api/v1/chat/runs') { json({ runs: [] }); return }
      if (path === '/api/v1/performance/runtime') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 404, data: null, message: 'Runtime diagnostics are not supported by this peer' }))
        return
      }
      json([])
    })
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const temporaryRoot = resolve(root, '.e2e-tmp')
    mkdirSync(temporaryRoot, { recursive: true })
    fixture = mkdtempSync(join(temporaryRoot, 'p1-engine-isolation-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, autoStartEngine: true, lastFolder: '', appearance: 'light' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'), AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'p1-synthetic-not-for-renderer' } })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 45_000 }).toBe('ready')
    const primaryWindow = await app.browserWindow(page)
    const primaryWindowId = await primaryWindow.evaluate(window => {
      window.setSize(1440, 1040)
      return window.id
    })
    const preloadPath = resolve(root, 'out/preload/index.js')
    expect(existsSync(preloadPath), 'Build the current workbench preload before this Electron acceptance test').toBe(true)
    const secondWindow = await app.evaluate(async ({ BrowserWindow }, { primaryId, preloadPath }) => {
      // The browser panel also owns native windows; array order does not
      // identify the workbench whose trusted preload this fixture needs.
      const first = BrowserWindow.fromId(primaryId)
      if (!first) throw new Error('primary workbench window is missing')
      // Use the production entry point rather than Electron's normalized
      // getLastWebPreferences(), which need not preserve its preload input.
      const child = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: false,
        contextIsolation: true, nodeIntegration: false, spellcheck: false } })
      const preloadErrors: string[] = []
      child.webContents.on('preload-error', (_event, path, error) => preloadErrors.push(`${path}: ${error.message}`))
      await child.loadURL(first.webContents.getURL())
      const preferences = child.webContents.getLastWebPreferences()
      return { id: child.id, preloadErrors, preferences: { preload: preferences.preload, sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }, url: child.webContents.getURL() }
    }, { primaryId: primaryWindowId, preloadPath })
    await primaryWindow.dispose()
    expect(secondWindow.preloadErrors, JSON.stringify(secondWindow)).toEqual([])
    await expect.poll(async () => {
      for (const candidate of app!.windows()) {
        const owner = await app!.browserWindow(candidate)
        const matches = await owner.evaluate((window, id) => window?.id === id, secondWindow.id)
        await owner.dispose()
        if (matches) { secondPage = candidate; return true }
      }
      return false
    }).toBe(true)
    secondPage.on('pageerror', error => pageErrors.push(error.message))
    await expect.poll(() => secondPage.evaluate(() => typeof window.aether?.engine?.getSnapshot), { message: JSON.stringify(secondWindow) }).toBe('function')
  })

  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      for (const response of peerStreams.values()) response.destroy()
      server?.closeAllConnections()
      if (server) await new Promise<void>(done => server!.close(() => done()))
      const allowed = resolve(root, '.e2e-tmp') + '\\'
      if (fixture && resolve(fixture).startsWith(allowed)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('原生窗口可见性只向各自工作台发送，双窗口显隐互不覆盖', async () => {
    for (const target of [page, secondPage]) {
      await target.evaluate(() => {
        const owner = window as ProbeWindow
        owner.__p1VisibilityProbe?.off()
        const probe = { events: [] as boolean[], off: () => {} }
        probe.off = window.aether.window.onVisibility(visible => probe.events.push(visible))
        owner.__p1VisibilityProbe = probe
      })
    }
    const primary = await app!.browserWindow(page)
    const secondary = await app!.browserWindow(secondPage)
    const events = (target: Page) => target.evaluate(() => (window as ProbeWindow).__p1VisibilityProbe?.events ?? [])
    try {
      expect(await page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
      expect(await secondPage.evaluate(() => window.aether.window.getVisibility())).toBe(false)
      await primary.evaluate(window => window.hide())
      await expect.poll(() => events(page)).toEqual([false])
      expect(await secondPage.evaluate(() => window.aether.window.getVisibility())).toBe(false)
      expect(await events(secondPage)).toEqual([])
      await primary.evaluate(window => window.show())
      await expect.poll(() => events(page)).toEqual([false, true])
      expect(await events(secondPage)).toEqual([])
      await secondary.evaluate(window => window.show())
      await expect.poll(() => events(secondPage)).toEqual([true])
      expect(await page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
      expect(await events(page)).toEqual([false, true])
      await secondary.evaluate(window => window.hide())
      await expect.poll(() => events(secondPage)).toEqual([true, false])
      expect(await page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
      expect(await events(page)).toEqual([false, true])
    } finally {
      await primary.evaluate(window => window.show())
      await secondary.evaluate(window => window.hide())
      await primary.dispose()
      await secondary.dispose()
      for (const target of [page, secondPage]) await target.evaluate(() => (window as ProbeWindow).__p1VisibilityProbe?.off())
    }
    expect(pageErrors).toEqual([])
  })

  test('远端心跳持续刷新，未知 V8 与事件循环不显示假数值', async ({}, testInfo) => {
    const diagnostics = await page.evaluate(() => window.aether.engine.diagnostics())
    expect(diagnostics.health.source).toBe('desktop-http-probe')
    expect(diagnostics.health.lastCheckedAt).toBeGreaterThan(0)
    expect(diagnostics.resources.state).toBe('unavailable')
    expect(diagnostics.resources.pid).toBeNull()
    expect(diagnostics.resources.memory.rssBytes).toBeNull()
    expect(JSON.stringify(diagnostics)).not.toContain('p1-synthetic-not-for-renderer')
    const before = healthRequests
    await page.evaluate(async () => {
      await window.aether.engine.diagnostics()
      await window.aether.engine.diagnostics()
      await window.aether.engine.diagnostics()
    })
    // The one existing 5s heartbeat may cross this fast IPC batch; opening
    // the monitor and reading diagnostics must not issue extra HTTP probes.
    expect(healthRequests - before).toBeLessThanOrEqual(1)
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('button.work-navigation__item[title="引擎监控"]').click()
    const resource = page.locator('.engine-resource')
    await expect(resource.getByText('远端连接心跳 · 每 5 秒同步', { exact: true })).toBeVisible()
    await expect(resource.locator('strong[data-freshness="fresh"]')).toBeVisible()
    const checked = resource.locator('.engine-resource__health-facts > div').filter({ has: page.getByText('最近心跳检查', { exact: true }) }).locator('strong')
    const initial = await checked.innerText()
    await expect.poll(() => checked.innerText(), { timeout: 15_000 }).not.toBe(initial)
    await resource.getByText('运行时指标能力', { exact: true }).click()
    const capabilities = resource.locator('.engine-runtime__body')
    await expect(capabilities).toHaveAttribute('data-runtime-state', 'unsupported')
    await expect(capabilities.getByRole('status')).toHaveText('此引擎未提供运行时指标接口。')
    await expect(capabilities.getByText('引擎 V8 Heap', { exact: true })).toBeVisible()
    await expect(capabilities.getByText('引擎事件循环延迟', { exact: true })).toBeVisible()
    await expect(capabilities.locator('dd')).toHaveText(['未提供', '未提供'])
    await expect(capabilities.locator('.engine-runtime__stats')).toHaveCount(0)
    await expect(capabilities.getByRole('button', { name: '重新检测运行时指标' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('p1-remote-monitor.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  })

  test('双窗口相同 streamId 可独立运行、取消并且不会互收内容', async () => {
    const id = 'same-public-stream-id'
    await installStreamProbe(page, id)
    await installStreamProbe(secondPage, id)
    await startStream(page, id, 'window-a')
    await expect.poll(() => contents(page)).toEqual(['window-a:initial'])
    await startStream(secondPage, id, 'window-b')
    await expect.poll(() => contents(secondPage)).toEqual(['window-b:initial'])
    expect(await contents(page)).toEqual(['window-a:initial'])
    expect(peerStreams.has('window-a')).toBe(true)
    expect(peerStreams.has('window-b')).toBe(true)
    const aborted = await page.evaluate(id => window.aether.engine.stream.abort(id), id)
    expect(aborted.ok).toBe(true)
    await expect.poll(() => peerStreams.has('window-a')).toBe(false)
    expect((await page.evaluate(id => window.aether.engine.stream.abort(id), id)).ok).toBe(false)
    expect(peerStreams.has('window-b')).toBe(true)
    peerStreams.get('window-b')!.write(`id: ${instanceId}:2\ndata: {"content":"window-b:after-a-abort"}\n\n`)
    await expect.poll(() => contents(secondPage)).toEqual(['window-b:initial', 'window-b:after-a-abort'])
    expect(await contents(page)).toEqual(['window-a:initial'])
    await secondPage.evaluate(id => window.aether.engine.stream.abort(id), id)
    await expect.poll(() => peerStreams.has('window-b')).toBe(false)
    expect(pageErrors).toEqual([])
  })

  test('同窗口替换相同 streamId 后，旧请求清理不会移除新流', async () => {
    const id = 'replaced-public-stream-id'
    await installStreamProbe(page, id)
    await installStreamProbe(secondPage, id)
    await startStream(page, id, 'old-generation')
    await expect.poll(() => contents(page)).toEqual(['old-generation:initial'])
    await startStream(page, id, 'new-generation')
    await expect.poll(() => contents(page)).toEqual(['old-generation:initial', 'new-generation:initial'])
    await expect.poll(() => peerStreams.has('old-generation')).toBe(false)
    expect(peerStreams.has('new-generation')).toBe(true)
    peerStreams.get('new-generation')!.write(`id: ${instanceId}:2\ndata: {"content":"new-generation:after-old-cleanup"}\n\n`)
    await expect.poll(() => contents(page)).toEqual(['old-generation:initial', 'new-generation:initial', 'new-generation:after-old-cleanup'])
    expect(await contents(secondPage)).toEqual([])
    expect((await page.evaluate(id => window.aether.engine.stream.abort(id), id)).ok).toBe(true)
    await expect.poll(() => peerStreams.has('new-generation')).toBe(false)
    expect(pageErrors).toEqual([])
  })

  test('连接身份切换后，另一窗口的旧请求被拦截且错误仅回原窗口', async () => {
    const old = await secondPage.evaluate(() => window.aether.engine.getSnapshot())
    instanceId = 'p1-identity-two'
    const current = await page.evaluate(() => window.aether.engine.restart())
    expect(current.phase, current.error || '').toBe('ready')
    expect(current.instanceId).toBe(instanceId)
    const before = peerRequests.length
    const rejected = await secondPage.evaluate(expectedEngine => window.aether.engine.request({ method: 'GET', path: '/p1-stale-identity', expectedEngine }), old)
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe(409)
    expect(peerRequests.slice(before)).not.toContain('/api/v1/p1-stale-identity')
    const id = 'same-rejected-stream-id'
    await installStreamProbe(page, id)
    await installStreamProbe(secondPage, id)
    await secondPage.evaluate(async ({ id, expectedEngine }) => {
      await window.aether.engine.stream.start({ streamId: id, path: '/chat', expectedEngine,
        body: { sessionId: 'rejected-after-switch', message: 'must not dispatch' } })
    }, { id, expectedEngine: old })
    await expect.poll(() => secondPage.evaluate(() => (window as ProbeWindow).__p1StreamProbe?.events.map(event => event.type))).toEqual(['error'])
    expect(await page.evaluate(() => (window as ProbeWindow).__p1StreamProbe?.events)).toEqual([])
    expect(peerStreams.has('rejected-after-switch')).toBe(false)
    expect((await secondPage.evaluate(() => window.aether.engine.getSnapshot())).instanceId).toBe(instanceId)
    expect(pageErrors).toEqual([])
  })

  // A prevented real location.assign can leave Playwright's navigation intent
  // pending even though Electron kept the original document. Probe it last so
  // later UI clicks cannot be gated by that automation bookkeeping.
  test('两可信主窗口仅提供窄桥且无环境泄露，外部导航被原生事件阻止', async () => {
    for (const target of [page, secondPage]) {
      expect(await target.evaluate(() => ({
        engineBridge: typeof window.aether?.engine?.getSnapshot,
        legacyBridge: typeof Reflect.get(window, 'electron'),
        processBridge: typeof Reflect.get(window, 'process')
      }))).toEqual({ engineBridge: 'function', legacyBridge: 'undefined', processBridge: 'undefined' })
      expect((await target.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
    }
    const nativeWindow = await app!.browserWindow(page)
    const originalUrl = page.url()
    const externalUrl = `${baseUrl}/p1-untrusted-document`
    const before = peerRequests.length
    await nativeWindow.evaluate(window => {
      const evidence: { url: string; prevented: boolean }[] = []
      const listener = (event: Electron.Event, url: string): void => { evidence.push({ url, prevented: event.defaultPrevented }) }
      Reflect.set(window, '__p1NavigationEvidence', evidence)
      Reflect.set(window, '__p1NavigationListener', listener)
      window.webContents.on('will-navigate', listener)
    })
    try {
      await page.evaluate(url => window.location.assign(url), externalUrl)
      await expect.poll(() => nativeWindow.evaluate(window => Reflect.get(window, '__p1NavigationEvidence')))
        .toEqual([{ url: externalUrl, prevented: true }])
      expect(page.url()).toBe(originalUrl)
      expect(peerRequests.slice(before)).not.toContain('/p1-untrusted-document')
      expect((await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
      expect(await page.evaluate(() => typeof Reflect.get(window, 'electron'))).toBe('undefined')
    } finally {
      await nativeWindow.evaluate(window => {
        const listener = Reflect.get(window, '__p1NavigationListener') as (event: Electron.Event, url: string) => void
        window.webContents.removeListener('will-navigate', listener)
        Reflect.deleteProperty(window, '__p1NavigationListener')
        Reflect.deleteProperty(window, '__p1NavigationEvidence')
      })
      await nativeWindow.dispose()
    }
    expect(pageErrors).toEqual([])
  })
})
