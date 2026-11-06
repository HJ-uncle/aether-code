/** Current P1 acceptance against the freshly built sibling engine. Measurements
 * come from its real V8 process through Electron IPC; no metric fixture or LLM. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineRuntimeDiagnostics } from '../src/renderer/src/contrib/work/engine-runtime'

test('当前内置引擎真实 V8 与事件循环通过 IPC 显示，实例/PID 一致', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'p1-runtime-live-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12417, lastFolder: '', appearance: 'light' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'),
    AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
    const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(snapshot.pid).toBeGreaterThan(0)
    const read = () => page.evaluate(async () => {
      const expectedEngine = await window.aether.engine.getSnapshot()
      return window.aether.engine.request<EngineRuntimeDiagnostics>({ method: 'GET', path: '/performance/runtime?refresh=true', expectedEngine })
    })
    const first = await read()
    expect(first.ok, first.message).toBe(true)
    expect(first.data?.instanceId).toBe(snapshot.instanceId)
    expect(first.data?.pid).toBe(snapshot.pid)
    expect(first.data?.memory.heapUsedBytes).toBeGreaterThan(0)
    expect(first.data?.collection.sampleWindowMs).toBe(200)
    expect(first.data?.eventLoop.state).toBe('available')
    expect(first.data?.eventLoop.delay?.p95Ms).toBeGreaterThan(0)
    const latest = await read()
    expect(latest.data?.eventLoop.delay?.p95Ms).toBeGreaterThan(0)
    expect(latest.data?.eventLoop.utilization).toBeGreaterThanOrEqual(0)
    expect(latest.data?.sampledAt).toBeGreaterThan(first.data!.sampledAt)
    await testInfo.attach('actual-engine-runtime-samples', { body: JSON.stringify({ snapshot, first: first.data, latest: latest.data }, null, 2), contentType: 'application/json' })

    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('button.work-navigation__item[title="引擎监控"]').click()
    const panel = page.locator('details.engine-runtime')
    await panel.locator('summary').click()
    await expect(panel.locator('[data-runtime-state="sample"]')).toBeVisible()
    await expect(panel.getByText('引擎 V8 Heap', { exact: true })).toBeVisible()
    await expect(panel.getByText(`引擎自身读取，PID ${snapshot.pid}`, { exact: true })).toBeVisible()
    await expect(panel.getByText('事件循环延迟 P95', { exact: true })).toBeVisible()
    await expect(panel).toContainText('本次按需窗口 200 ms；采样结束即停止采集')
    const runtimeRefresh = panel.getByRole('button', { name: '刷新运行时指标', exact: true })
    const sampleTime = () => panel.locator('[data-sampled-at]').getAttribute('data-sampled-at').then(Number)
    const previousSample = await sampleTime()
    const resource = page.getByRole('region', { name: '引擎资源与健康监控', exact: true })
    const refreshAll = resource.getByRole('button', { name: '刷新监控数据', exact: true })
    await expect(refreshAll).toBeEnabled()
    const previousResource = await resource.locator('.engine-resource__footer').innerText()
    // Observe past the old 15s shutdown threshold without reading the engine.
    const quietStart = Date.now()
    await expect.poll(() => Date.now() - quietStart, { timeout: 20_000, intervals: [1000] }).toBeGreaterThan(15_000)
    expect(await sampleTime()).toBe(previousSample)
    await runtimeRefresh.click()
    await expect.poll(sampleTime).toBeGreaterThan(previousSample)
    await expect(runtimeRefresh).toBeEnabled()
    await expect(panel).toHaveAttribute('open', '')
    await expect(panel.locator('dt').filter({ hasText: /^事件循环利用率$/ }).locator('..').locator('dd')).toHaveText(/\d+\.\d%/)
    await expect(panel.locator('dt').filter({ hasText: /^事件循环延迟 P95$/ }).locator('..').locator('dd')).toHaveText(/\d+\.\d ms/)
    expect(await resource.locator('.engine-resource__footer').innerText()).toBe(previousResource)
    const localSample = await sampleTime()
    await refreshAll.click()
    await expect.poll(sampleTime).toBeGreaterThan(localSample)
    await expect(refreshAll).toBeEnabled()
    await expect(resource.locator('.engine-resource__footer')).not.toHaveText(previousResource)
    await panel.screenshot({ path: testInfo.outputPath('p1-runtime-live-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
    await panel.screenshot({ path: testInfo.outputPath('p1-runtime-live-dark.png') })
    await panel.locator('summary').click()
    await expect(panel).not.toHaveAttribute('open')
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('p1-runtime-live-')) throw new Error(`Unsafe cleanup: ${target}`)
    rmSync(target, { recursive: true, force: true, maxRetries: 5 })
  }
})
