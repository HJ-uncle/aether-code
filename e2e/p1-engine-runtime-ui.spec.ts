/** Fresh current Electron scenario for runtime opt-in, warming, visibility and
 * old-engine capability absence. A controlled authenticated peer supplies real
 * HTTP responses; the companion live-engine test validates actual Node values. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

test('引擎 runtime 默认不请求，展开采样并在隐藏收起后停采，404不循环探测', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp'), token = 'p1-runtime-ui-token'
  let app: ElectronApplication | undefined, fixture = '', reads = 0, cronReads = 0, missing = false
  let holdNextCron = false, heldCron: ServerResponse | undefined
  const errors: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      errors.push(`Unauthenticated runtime request: ${path}`)
      response.writeHead(401).end(JSON.stringify({ code: 401, message: 'Invalid or missing instance token' })); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/cron') {
      cronReads++
      if (holdNextCron) { holdNextCron = false; heldCron = response; return }
    }
    if (path === '/api/v1/performance/runtime') {
      reads++
      if (missing) { response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Route not found' })); return }
      const warming = reads === 1
      response.end(JSON.stringify({ code: 200, message: 'OK', data: {
        schemaVersion: 1, instanceId: 'p1-runtime-ui', pid: 6789, sampledAt: Date.now(), uptimeMs: 120000,
        collection: { minIntervalMs: 5000, idleTimeoutMs: 15000, delayResolutionMs: 20 },
        memory: { rssBytes: 128 * 1024 ** 2, heapUsedBytes: 32 * 1024 ** 2, heapTotalBytes: 64 * 1024 ** 2, heapLimitBytes: 2048 * 1024 ** 2, externalBytes: 8 * 1024 ** 2, arrayBuffersBytes: 4 * 1024 ** 2 },
        eventLoop: { state: warming ? 'warming' : 'available', intervalMs: warming ? null : 5000, utilization: warming ? null : 0.125,
          delay: warming ? null : { meanMs: 21, p95Ms: 24, maxMs: 40 } }
      } })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'p1-runtime-ui' }
        : path === '/api/v1/chat/status' ? { running: false, finished: false }
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: 'persisted', sessionId: new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId'), eventId: null, finished: true, history: [], projection: [], runs: [], todos: [], changes: [] }
            : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
              : path === '/api/v1/security/mode' ? { mode: 'safe' } : []
    response.end(JSON.stringify({ code: 200, message: 'OK', data }))
  })
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing runtime UI port')
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'p1-runtime-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, lastFolder: '', lastSessionId: '', appearance: 'dark' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    const mainWindow = await app.browserWindow(page)
    // Release Playwright's default focus override. Native visibility remains
    // authoritative even when Chromium/CDP keeps document.hidden false.
    const nativeSession = await page.context().newCDPSession(page)
    await nativeSession.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await page.evaluate(() => {
      const observers = new Set<PerformanceObserver>(), timers = new Set<number>()
      const observe = PerformanceObserver.prototype.observe, disconnect = PerformanceObserver.prototype.disconnect
      PerformanceObserver.prototype.observe = function(options) { if (options?.type === 'longtask') observers.add(this); return observe.call(this, options) }
      PerformanceObserver.prototype.disconnect = function() { observers.delete(this); return disconnect.call(this) }
      const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, interval?: number, ...args: unknown[]) => { const id = set(handler, interval, ...args); if (interval === 2000) timers.add(id); return id }) as typeof window.setInterval
      window.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); return clear(id) }
      Object.assign(window, { __p1NativeProbe: { observers, timers } })
    })
    await mainWindow.evaluate(window => window.setSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('button.work-navigation__item').filter({ hasText: '引擎监控' }).click()
    const panel = page.locator('details.engine-runtime'), summary = panel.locator('summary')
    const pagePerformance = page.getByRole('region', { name: '客户端性能', exact: true })
    const pageCounts = () => page.evaluate(() => {
      const probe = (window as Window & { __p1NativeProbe?: { observers: Set<unknown>; timers: Set<number> } }).__p1NativeProbe!
      return [probe.observers.size, probe.timers.size]
    })
    await pagePerformance.getByRole('button', { name: '按需采集页面性能', exact: true }).click()
    await expect.poll(pageCounts).toEqual([1, 1])
    await expect.poll(() => cronReads).toBe(1)
    const resource = page.getByRole('region', { name: '引擎资源与健康监控', exact: true })
    const checked = resource.locator('.engine-resource__health-facts > div').filter({ has: page.getByText('最近心跳检查', { exact: true }) }).locator('strong')
    await expect(checked).not.toHaveText('未提供')
    await expect(summary).toContainText('运行时指标能力')
    await expect(panel).not.toHaveAttribute('open', '')
    const quietForInterval = async (expectedReads: number, duration = 5500): Promise<void> => {
      // A bounded observation window spans the actual five-second poll period.
      const started = Date.now()
      await expect.poll(() => Date.now() - started, { timeout: duration + 4000 }).toBeGreaterThanOrEqual(duration)
      expect(reads).toBe(expectedReads)
    }
    await quietForInterval(0)
    await summary.click()
    await expect.poll(() => reads).toBe(1)
    const value = (label: string) => panel.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('dd')
    await expect(value('引擎 V8 Heap')).toHaveText('32 MiB')
    await expect(value('事件循环利用率')).toHaveText('建立采样基线')
    await expect(value('事件循环延迟 P95')).toHaveText('建立采样基线')
    await expect.poll(() => reads).toBe(2)
    await expect(value('事件循环利用率')).toHaveText('12.5%')
    await expect(value('事件循环延迟 P95')).toHaveText('24.0 ms')
    await expect(panel).toContainText('读数包含约 20 ms 的采样基线')
    await expect(panel).toContainText('15 秒无读取后自动停用采集')
    await expect(panel).toContainText('PID 6789')
    await panel.screenshot({ path: testInfo.outputPath('p1-runtime-ui-dark.png') })

    // Exercise the actual browser service's unthrottled WebContentsView too.
    const guestId = await page.evaluate(async () => (await window.aether.browser.create({ url: 'about:blank' })).tabId)
    expect(await mainWindow.evaluate(window => window.contentView.children.length)).toBeGreaterThan(0)
    await mainWindow.evaluate(window => window.hide())
    await testInfo.attach('hidden-window-native-state.json', { contentType: 'application/json', body: JSON.stringify({
      native: await mainWindow.evaluate(window => ({ id: window.id, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(),
        webContents: window.webContents.id, preferences: window.webContents.getLastWebPreferences(), children: window.contentView.children.map(view => ({
          bounds: view.getBounds(), webContents: 'webContents' in view ? (view.webContents as import('electron').WebContents).id : null })) })),
      document: await page.evaluate(() => ({ hidden: document.hidden, visibilityState: document.visibilityState, hasFocus: document.hasFocus() })), reads
    }, null, 2) })
    await expect.poll(() => mainWindow.evaluate(window => window.isVisible())).toBe(false)
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(false)
    await expect(panel.locator('[data-runtime-state]')).toHaveAttribute('data-runtime-state', 'paused')
    await expect(pagePerformance.locator('[data-performance-state]')).toHaveAttribute('data-performance-state', 'paused')
    await expect.poll(pageCounts).toEqual([0, 0])
    const beforeHidden = reads, beforeCron = cronReads, beforeChecked = await checked.innerText()
    // Span the longest monitor interval, proving runtime/OS/page/cron collectors
    // all pause while the real native window is hidden.
    await quietForInterval(beforeHidden, 32000)
    expect(cronReads).toBe(beforeCron)
    expect(await checked.innerText()).toBe(beforeChecked)
    expect(await pageCounts()).toEqual([0, 0])
    await mainWindow.evaluate(window => window.show())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
    await expect.poll(() => reads).toBe(beforeHidden + 1)
    await expect.poll(() => cronReads).toBe(beforeCron + 1)
    await expect.poll(() => checked.innerText()).not.toBe(beforeChecked)
    await expect.poll(pageCounts).toEqual([1, 1])
    await page.evaluate(id => window.aether.browser.close(id), guestId)
    await summary.click(); const beforeClosed = reads; await quietForInterval(beforeClosed)

    // A response owned by the previous visible effect can remain in flight
    // across two native visibility cycles. The current effect must stay single
    // flight, then resume immediately when that old response finally settles.
    await mainWindow.evaluate(window => window.hide())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(false)
    await expect(pagePerformance.locator('[data-performance-state]')).toHaveAttribute('data-performance-state', 'paused')
    await expect.poll(pageCounts).toEqual([0, 0])
    const beforeHeldCron = cronReads
    holdNextCron = true
    await mainWindow.evaluate(window => window.show())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
    await expect(pagePerformance.locator('[data-performance-state]')).toHaveAttribute('data-performance-state', 'sampling')
    await expect.poll(() => cronReads).toBe(beforeHeldCron + 1)
    expect(heldCron).toBeDefined()
    await mainWindow.evaluate(window => window.hide())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(false)
    await expect(pagePerformance.locator('[data-performance-state]')).toHaveAttribute('data-performance-state', 'paused')
    await expect.poll(pageCounts).toEqual([0, 0])
    await mainWindow.evaluate(window => window.show())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
    await expect(pagePerformance.locator('[data-performance-state]')).toHaveAttribute('data-performance-state', 'sampling')
    await expect.poll(pageCounts).toEqual([1, 1])
    expect(cronReads).toBe(beforeHeldCron + 1)
    const releasedAt = Date.now()
    heldCron!.end(JSON.stringify({ code: 200, message: 'OK', data: [] })); heldCron = undefined
    await expect.poll(() => cronReads, { timeout: 5000 }).toBe(beforeHeldCron + 2)
    expect(Date.now() - releasedAt).toBeLessThan(5000)
    expect(reads).toBe(beforeClosed)

    missing = true; await summary.click()
    await expect.poll(() => reads).toBe(beforeClosed + 1)
    await expect(panel).toContainText('此引擎未提供运行时指标接口。')
    await expect(panel.locator('[data-runtime-state]')).toHaveAttribute('data-runtime-state', 'unsupported')
    await quietForInterval(beforeClosed + 1)
    await summary.click(); await summary.click(); await quietForInterval(beforeClosed + 1)
    await panel.getByRole('button', { name: '重新检测运行时指标', exact: true }).click()
    await expect.poll(() => reads).toBe(beforeClosed + 2)
    expect(errors).toEqual([])
  } finally {
    heldCron?.end(JSON.stringify({ code: 200, message: 'OK', data: [] }))
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('p1-runtime-ui-')) throw new Error(`Unsafe cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
