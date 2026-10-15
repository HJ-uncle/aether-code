/** Fresh Electron scenario for the current P1 performance panel. Uses native
 * Chromium longtask signals, checks opt-in/cleanup and captures both themes. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

test('页面性能按需采集真实长任务，收起与离开后释放观察者和定时器', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'p1-page-performance-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: '', appearance: 'dark' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('button.work-navigation__item').filter({ hasText: '引擎监控' }).click()
    const panel = page.getByRole('region', { name: '客户端性能', exact: true })
    await expect(panel.getByRole('button', { name: '按需采集页面性能' })).toHaveAttribute('aria-expanded', 'false')
    await expect(panel.locator('dl')).toHaveCount(0)
    await page.evaluate(() => {
      const observers = new Set<PerformanceObserver>(), timers = new Set<number>()
      const observe = PerformanceObserver.prototype.observe, disconnect = PerformanceObserver.prototype.disconnect
      PerformanceObserver.prototype.observe = function(options) { if (options?.type === 'longtask') observers.add(this); return observe.call(this, options) }
      PerformanceObserver.prototype.disconnect = function() { observers.delete(this); return disconnect.call(this) }
      const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, interval?: number, ...args: unknown[]) => { const id = set(handler, interval, ...args); if (interval === 2000) timers.add(id); return id }) as typeof window.setInterval
      window.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); return clear(id) }
      Object.assign(window, { __p1PerformanceProbe: { observers, timers } })
    })
    const counts = () => page.evaluate(() => {
      const probe = (window as Window & { __p1PerformanceProbe?: { observers: Set<unknown>; timers: Set<number> } }).__p1PerformanceProbe!
      return [probe.observers.size, probe.timers.size]
    })
    await panel.getByRole('button', { name: '按需采集页面性能' }).click()
    await expect.poll(counts).toEqual([1, 1])
    // This deliberately occupies this test renderer's main thread; the panel
    // must receive a native entry, rather than a fixture-injected fake count.
    await page.evaluate(() => {
      // CDP evaluate itself is not a web task in Chromium's Long Tasks API.
      // Queue actual page work so the browser observer measures the same kind
      // of main-thread task a slow event handler would create.
      window.setTimeout(() => { const end = performance.now() + 120; while (performance.now() < end) { /* bounded workload */ } }, 0)
    })
    await expect.poll(() => panel.locator('dl > div').first().locator('dd').innerText()).toMatch(/^[1-9]\d* 次$/)
    await expect(panel.getByText('页面 JS 堆估计', { exact: true })).toBeVisible()
    await panel.screenshot({ path: testInfo.outputPath('p1-performance-dark.png') })
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
    await panel.screenshot({ path: testInfo.outputPath('p1-performance-light.png') })
    await panel.getByRole('button', { name: '停止采集' }).click()
    await expect.poll(counts).toEqual([0, 0])
    await panel.getByRole('button', { name: '按需采集页面性能' }).click()
    await expect.poll(counts).toEqual([1, 1])
    await page.locator('button.work-navigation__item').filter({ hasText: '工作台' }).click()
    await expect.poll(counts).toEqual([0, 0])
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('p1-page-performance-')) throw new Error(`Unsafe cleanup: ${target}`)
    rmSync(target, { recursive: true, force: true, maxRetries: 5 })
  }
})
