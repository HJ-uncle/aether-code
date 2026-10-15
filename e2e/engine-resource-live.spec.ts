/**
 * Fresh resource-monitor acceptance against a real embedded engine. No legacy
 * fixtures or mocked metrics: verifies OS PID measurements, physical bytes,
 * collection cooldown and monitor teardown in a real Electron window.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EngineDiagnostics } from '../src/shared/engine-diagnostics'

const root = resolve(__dirname, '..')
let app: ElectronApplication | undefined
let page: Page
let fixture = ''
const pageErrors: string[] = []

test.beforeAll(async () => {
  const temporaryRoot = join(root, '.e2e-tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  fixture = mkdtempSync(join(temporaryRoot, 'engine-resource-live-'))
  mkdirSync(join(fixture, 'engine', 'state', 'cache'), { recursive: true })
  writeFileSync(
    join(fixture, 'engine', 'state', 'cache', 'resource-monitor.bin'),
    Buffer.alloc(8192)
  )
  writeFileSync(
    join(fixture, 'settings.json'),
    JSON.stringify({
      engineMode: 'embedded',
      autoStartEngine: true,
      preferredPort: 12417,
      lastFolder: '',
      appearance: 'light'
    })
  )
  app = await electron.launch({
    args: ['.', `--user-data-dir=${fixture}`],
    cwd: root,
    env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
  await expect
    .poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then((s) => s.phase), {
      timeout: 90_000,
      message: 'fresh embedded engine must become ready'
    })
    .toBe('ready')
})

test.afterAll(async () => {
  try {
    await app?.close()
  } finally {
    if (fixture && resolve(fixture).startsWith(resolve(root, '.e2e-tmp') + '\\')) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
    }
  }
})

const diagnostics = (): Promise<EngineDiagnostics> =>
  page.evaluate(() => window.aether.engine.diagnostics())

test('真实 PID 资源、存储分类、采样缓存与健康探针', async ({}, testInfo) => {
  const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
  expect(snapshot.pid).toBeGreaterThan(0)
  const first = await diagnostics()
  if (first.resources.state === 'available') {
    expect(first.resources.pid).toBe(snapshot.pid)
    expect(first.resources.memory.rssBytes).toBeGreaterThan(0)
    expect(first.resources.memory.privateBytes).toBeGreaterThan(0)
    if (first.resources.io.readBytes !== null)
      expect(first.resources.io.readBytes).toBeGreaterThanOrEqual(0)
    if (first.resources.io.writeBytes !== null)
      expect(first.resources.io.writeBytes).toBeGreaterThanOrEqual(0)
  } else {
    // Windows CIM can be denied in a sandbox. The product must expose that
    // limitation instead of turning it into zero-valued fake measurements.
    expect(first.resources.reason).toBeTruthy()
  }
  expect(first.resources.disk.totalBytes).toBeGreaterThan(0)
  expect(first.resources.disk.availableBytes).toBeGreaterThan(0)
  expect(first.storage.state, first.storage.reason).toBe('available')
  expect(first.storage.partial).toBe(false)
  expect(
    first.storage.categories.find((item) => item.category === 'cache')?.bytes
  ).toBeGreaterThanOrEqual(8192)
  expect(first.storage.categories.reduce((sum, item) => sum + item.bytes, 0)).toBe(
    first.storage.totalBytes
  )
  const cached = await diagnostics()
  expect(cached.resources.sampledAt).toBe(first.resources.sampledAt)
  expect(cached.resources.collection.cached).toBe(true)
  expect(cached.storage.scannedAt).toBe(first.storage.scannedAt)
  expect(cached.storage.cached).toBe(true)
  const refreshed = await page.evaluate(() =>
    window.aether.engine.diagnostics({ refreshStorage: true })
  )
  expect(refreshed.storage.scannedAt).toBe(first.storage.scannedAt)
  expect(refreshed.storage.cached).toBe(true)

  let second = first
  if (first.resources.state === 'available') {
    await expect
      .poll(
        async () => {
          second = await diagnostics()
          return second.resources.cpu.intervalMs
        },
        { timeout: 20_000, intervals: [1000] }
      )
      .toBeGreaterThan(0)
    expect(second.resources.cpu.percent).toBeGreaterThanOrEqual(0)
    if (second.resources.io.readBytesPerSecond !== null)
      expect(second.resources.io.readBytesPerSecond).toBeGreaterThanOrEqual(0)
  }
  await expect
    .poll(
      async () => {
        second = await diagnostics()
        return second.health.lastCheckedAt
      },
      { timeout: 15_000, intervals: [1000] }
    )
    .toBeGreaterThan(0)
  expect(second.health.lastSuccessAt).toBeGreaterThan(0)
  expect(second.health.lastLatencyMs).toBeGreaterThanOrEqual(0)
  expect(second.health.consecutiveFailures).toBe(0)
  await testInfo.attach('real-engine-resource-samples', {
    body: JSON.stringify({ first, second }, null, 2),
    contentType: 'application/json'
  })
})

test('资源页面可见、离开后释放采样、浅色与深色显示', async ({}, testInfo) => {
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await page.evaluate(() => {
    const target = window as Window & { __resourceTimers?: Set<number> }
    const active = new Set<number>()
    target.__resourceTimers = active
    const originalSet = window.setTimeout.bind(window)
    const originalClear = window.clearTimeout.bind(window)
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = originalSet(handler, ms, ...args)
      if (ms === 5000) active.add(id)
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) active.delete(id)
      originalClear(id)
    }) as typeof window.clearTimeout
  })
  await page.locator('button.work-navigation__item[title="引擎监控"]').click()
  const monitor = page.locator('.work-page--monitor')
  await expect(monitor).toBeVisible()
  await expect(monitor.getByText('CPU', { exact: true })).toBeVisible()
  await expect(monitor.getByText('工作集 RSS', { exact: false })).toBeVisible()
  await expect(monitor.getByText('私有内存', { exact: false })).toBeVisible()
  await expect(monitor.getByLabel('引擎进程树')).toBeVisible()
  await expect(monitor.getByText('最多显示 24 项', { exact: false })).toBeVisible()
  await expect(monitor.locator('section[aria-label="引擎数据存储"] button')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('engine-resource-light.png'), fullPage: true })
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = 'dark'
  })
  await page.screenshot({ path: testInfo.outputPath('engine-resource-dark.png'), fullPage: true })
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __resourceTimers?: Set<number> }).__resourceTimers?.size
      )
    )
    .toBe(1)
  await page.locator('button.work-navigation__item[title="工作台"]').click()
  await expect(monitor).toBeHidden()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __resourceTimers?: Set<number> }).__resourceTimers?.size
      )
    )
    .toBe(0)
  expect(pageErrors).toEqual([])
})
