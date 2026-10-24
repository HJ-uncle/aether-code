/** Current monitor cleanup: removing the client-performance panel must also
 * remove its longtask observer and two-second sampling timer across navigation. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

test('资源监控不挂载客户端性能采集，反复进入离开均不创建观察者和采样计时器', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'p1-page-performance-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: '', appearance: 'dark' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960))
    await page.evaluate(() => {
      const observers = new Set<PerformanceObserver>(), timers = new Set<number>()
      const probe = { observers, timers, createdObservers: 0, createdTimers: 0 }
      const observe = PerformanceObserver.prototype.observe, disconnect = PerformanceObserver.prototype.disconnect
      PerformanceObserver.prototype.observe = function(options) {
        if (options?.type === 'longtask') { observers.add(this); probe.createdObservers++ }
        return observe.call(this, options)
      }
      PerformanceObserver.prototype.disconnect = function() { observers.delete(this); return disconnect.call(this) }
      const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, interval?: number, ...args: unknown[]) => {
        const id = set(handler, interval, ...args)
        if (interval === 2000) { timers.add(id); probe.createdTimers++ }
        return id
      }) as typeof window.setInterval
      window.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); return clear(id) }
      Object.assign(window, { __p1PerformanceProbe: probe })
    })
    const counts = () => page.evaluate(() => {
      const probe = (window as Window & { __p1PerformanceProbe?: { observers: Set<unknown>; timers: Set<number>; createdObservers: number; createdTimers: number } }).__p1PerformanceProbe!
      return [probe.observers.size, probe.timers.size, probe.createdObservers, probe.createdTimers]
    })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const monitor = page.locator('.work-page--monitor')
    for (let visit = 0; visit < 3; visit++) {
      await page.locator('button.work-navigation__item').filter({ hasText: '引擎监控' }).click()
      await expect(monitor).toBeVisible()
      await expect(monitor.getByRole('region', { name: '引擎资源与健康监控', exact: true })).toBeVisible()
      await expect(monitor.getByRole('region', { name: '引擎身份', exact: true })).toBeVisible()
      await expect(monitor.getByRole('region', { name: '客户端性能', exact: true })).toHaveCount(0)
      await expect(monitor.getByRole('button', { name: /采集页面性能|停止采集/ })).toHaveCount(0)
      expect(await counts()).toEqual([0, 0, 0, 0])
      if (visit === 0) {
        await monitor.screenshot({ path: testInfo.outputPath('monitor-resources-dark.png') })
        await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
        await monitor.screenshot({ path: testInfo.outputPath('monitor-resources-light.png') })
      }
      await page.locator('button.work-navigation__item[title="工作台"]').click()
      await expect(monitor).toBeHidden()
      expect(await counts()).toEqual([0, 0, 0, 0])
    }
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('p1-page-performance-')) throw new Error('Unsafe cleanup target')
    rmSync(target, { recursive: true, force: true, maxRetries: 5 })
  }
})
