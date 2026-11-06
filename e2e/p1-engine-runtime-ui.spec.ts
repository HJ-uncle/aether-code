/** Fresh current Electron scenario for runtime opt-in, warming, visibility and
 * old-engine capability absence. A controlled authenticated peer supplies real
 * HTTP responses; the companion live-engine test validates actual Node values. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

test('引擎 runtime 首次展开读取一次，后续只手动刷新，隐藏恢复与404均不轮询', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp'), token = 'p1-runtime-ui-token'
  let app: ElectronApplication | undefined, fixture = '', reads = 0, cronReads = 0, metricsReads = 0, missing = false
  let holdRuntime = false, releaseRuntime: (() => void) | undefined
  const runtimeQueries: Array<string | null> = []
  let sampleClock = Date.now()
  const errors: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      errors.push(`Unauthenticated runtime request: ${path}`)
      response.writeHead(401).end(JSON.stringify({ code: 401, message: 'Invalid or missing instance token' })); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/cron') cronReads++
    if (path === '/api/v1/metrics') metricsReads++
    if (path === '/api/v1/performance/runtime') {
      reads++
      runtimeQueries.push(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh'))
      if (missing) { response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Route not found' })); return }
      const warming = reads === 1
      sampleClock = Math.max(Date.now(), sampleClock + 1)
      const sendRuntime = (): void => { response.end(JSON.stringify({ code: 200, message: 'OK', data: {
        schemaVersion: 1, instanceId: 'p1-runtime-ui', pid: 6789, sampledAt: sampleClock, uptimeMs: 120000,
        collection: { minIntervalMs: 5000, idleTimeoutMs: 15000, delayResolutionMs: 20, ...(!warming ? { sampleWindowMs: 200 } : {}) },
        memory: { rssBytes: 128 * 1024 ** 2, heapUsedBytes: (31 + reads) * 1024 ** 2, heapTotalBytes: 64 * 1024 ** 2, heapLimitBytes: 2048 * 1024 ** 2, externalBytes: 8 * 1024 ** 2, arrayBuffersBytes: 4 * 1024 ** 2 },
        eventLoop: { state: warming ? 'warming' : 'available', intervalMs: warming ? null : 5000, utilization: warming ? null : 0.125,
          delay: warming ? null : { meanMs: 21, p95Ms: 24, maxMs: 40 } }
      } })) }
      if (holdRuntime) { holdRuntime = false; releaseRuntime = sendRuntime } else sendRuntime()
      return
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
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
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
    await expect(pagePerformance).toHaveCount(0)
    await expect.poll(pageCounts).toEqual([0, 0])
    expect(cronReads).toBe(0)
    expect(metricsReads).toBe(0)
    const resource = page.getByRole('region', { name: '引擎资源与健康监控', exact: true })
    const refresh = resource.getByRole('button', { name: '刷新监控数据', exact: true })
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
    await expect(value('事件循环利用率')).toHaveText('需再次刷新')
    await expect(value('事件循环延迟 P95')).toHaveText('需再次刷新')
    await expect(panel).toContainText('旧引擎至少缓存 5 秒')
    const sampleTime = () => panel.locator('[data-sampled-at]').getAttribute('data-sampled-at').then(Number)
    const firstSampleTime = await sampleTime()
    const outerSample = await resource.locator('.engine-resource__footer').innerText()
    await quietForInterval(1)
    const runtimeRefresh = panel.getByRole('button', { name: '刷新运行时指标', exact: true })
    await expect(runtimeRefresh.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    await expect(runtimeRefresh).toHaveText('')
    await expect(runtimeRefresh).toHaveAttribute('title', '刷新运行时指标')
    holdRuntime = true
    await runtimeRefresh.click()
    await expect.poll(() => reads).toBe(2)
    await expect(panel).toHaveAttribute('open', '')
    await expect(runtimeRefresh).toBeDisabled()
    await expect(refresh).toBeDisabled()
    await expect(runtimeRefresh.locator('.ui-spinner')).toBeVisible()
    await expect(runtimeRefresh).toHaveText('')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await runtimeRefresh.locator('.ui-spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await runtimeRefresh.locator('.ui-spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('ui-spinner-rotate')
    releaseRuntime!()
    await expect(runtimeRefresh).toBeEnabled()
    await expect.poll(sampleTime).toBeGreaterThan(firstSampleTime)
    await expect(value('引擎 V8 Heap')).toHaveText('33 MiB')
    expect(await resource.locator('.engine-resource__footer').innerText()).toBe(outerSample)
    await expect(value('事件循环利用率')).toHaveText('12.5%')
    await expect(value('事件循环延迟 P95')).toHaveText('24.0 ms')
    await expect(panel).toContainText('读数包含约 20 ms 的采样基线')
    await expect(panel).toContainText('本次按需窗口 200 ms；采样结束即停止采集')
    const mouseSampleTime = await sampleTime()
    await runtimeRefresh.focus()
    await runtimeRefresh.press('Enter')
    await expect.poll(() => reads).toBe(3)
    await expect.poll(sampleTime).toBeGreaterThan(mouseSampleTime)
    await expect(value('引擎 V8 Heap')).toHaveText('34 MiB')
    await expect(panel).toHaveAttribute('open', '')
    expect(await resource.locator('.engine-resource__footer').innerText()).toBe(outerSample)
    const keyboardSampleTime = await sampleTime()
    await refresh.click()
    await expect.poll(() => reads).toBe(4)
    await expect.poll(sampleTime).toBeGreaterThan(keyboardSampleTime)
    await expect(value('引擎 V8 Heap')).toHaveText('35 MiB')
    await expect(resource.locator('.engine-resource__footer')).not.toHaveText(outerSample)
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
    await expect.poll(pageCounts).toEqual([0, 0])
    const beforeHidden = reads, beforeChecked = await checked.innerText()
    // Span the existing age ticker interval: only resource/runtime collection
    // remains, and the removed panels must never issue their old requests.
    await quietForInterval(beforeHidden)
    expect(cronReads).toBe(0)
    expect(metricsReads).toBe(0)
    expect(await checked.innerText()).toBe(beforeChecked)
    expect(await pageCounts()).toEqual([0, 0])
    await mainWindow.evaluate(window => window.show())
    await expect.poll(() => page.evaluate(() => window.aether.window.getVisibility())).toBe(true)
    await quietForInterval(beforeHidden)
    expect(await checked.innerText()).toBe(beforeChecked)
    await resource.getByRole('button', { name: '手动刷新监控数据', exact: true }).click()
    await expect.poll(() => reads).toBe(beforeHidden + 1)
    await expect.poll(() => checked.innerText()).not.toBe(beforeChecked)
    await expect.poll(pageCounts).toEqual([0, 0])
    await page.evaluate(id => window.aether.browser.close(id), guestId)
    await summary.click(); const beforeClosed = reads; await quietForInterval(beforeClosed)

    missing = true; await summary.click()
    await quietForInterval(beforeClosed)
    await refresh.click()
    await expect.poll(() => reads).toBe(beforeClosed + 1)
    await expect(panel).toContainText('此引擎未提供运行时指标接口。')
    await expect(panel.locator('[data-runtime-state]')).toHaveAttribute('data-runtime-state', 'unsupported')
    await quietForInterval(beforeClosed + 1)
    await summary.click(); await summary.click(); await quietForInterval(beforeClosed + 1)
    await refresh.click()
    await expect.poll(() => reads).toBe(beforeClosed + 2)

    // Hold only the isolated app's diagnostics IPC. Runtime has its own real
    // HTTP reader and must stay usable after its part of Refresh All finishes.
    missing = false
    await expect(refresh).toBeEnabled()
    const heldDiagnostics = await page.evaluate(() => window.aether.engine.diagnostics())
    await app.evaluate(({ ipcMain }, diagnostics) => {
      const control = { reads: 0, release: undefined as (() => void) | undefined }
      Object.assign(globalThis, { __monitorDiagnosticsHold: control })
      ipcMain.removeHandler('engine:diagnostics')
      ipcMain.handle('engine:diagnostics', () => {
        control.reads++
        return new Promise(resolve => { control.release = () => resolve(diagnostics) })
      })
    }, heldDiagnostics)
    const beforeHold = reads
    await refresh.click()
    await expect.poll(() => reads).toBe(beforeHold + 1)
    await expect(panel.locator('[data-runtime-state]')).toHaveAttribute('data-runtime-state', 'sample')
    await expect(runtimeRefresh).toBeEnabled()
    await expect(refresh).toBeDisabled()
    const completedRuntimeTime = await sampleTime()
    await runtimeRefresh.click()
    await expect.poll(() => reads).toBe(beforeHold + 2)
    await expect.poll(sampleTime).toBeGreaterThan(completedRuntimeTime)
    await expect(panel).toHaveAttribute('open', '')
    await expect(refresh).toBeDisabled()
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __monitorDiagnosticsHold: { reads: number } }).__monitorDiagnosticsHold.reads)).toBe(1)
    await app.evaluate(() => (globalThis as typeof globalThis & { __monitorDiagnosticsHold: { release?: () => void } }).__monitorDiagnosticsHold.release?.())
    await expect(refresh).toBeEnabled()
    expect(cronReads).toBe(0)
    expect(metricsReads).toBe(0)
    expect(await pageCounts()).toEqual([0, 0])
    await expect(pagePerformance).toHaveCount(0)
    expect(errors).toEqual([])
    expect(runtimeQueries.every(value => value === 'true')).toBe(true)
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('p1-runtime-ui-')) throw new Error(`Unsafe cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
