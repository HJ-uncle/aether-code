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
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12419, lastFolder: '', appearance: 'light' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'),
    AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
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
      return window.aether.engine.request<EngineRuntimeDiagnostics>({ method: 'GET', path: '/performance/runtime', expectedEngine })
    })
    const first = await read()
    expect(first.ok, first.message).toBe(true)
    expect(first.data?.instanceId).toBe(snapshot.instanceId)
    expect(first.data?.pid).toBe(snapshot.pid)
    expect(first.data?.memory.heapUsedBytes).toBeGreaterThan(0)
    expect(first.data?.eventLoop.delay).toBeNull()
    const cached = await read()
    expect(cached.data).toEqual(first.data)
    let latest = first
    await expect.poll(async () => { latest = await read(); return latest.data?.eventLoop.state }, { timeout: 15_000, intervals: [1000] }).toBe('available')
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
