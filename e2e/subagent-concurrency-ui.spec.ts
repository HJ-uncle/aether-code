/** Real Electron + preload/IPC + HTTP settings: effective concurrency, persisted
 * rereads, server errors, managed/legacy engines, search and dark/light layout.
 * The controlled engine never calls an LLM or touches production settings. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp'), token = 'subagent-concurrency-ui-fixture'
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page, server: Server | undefined, fixture = ''
let limit = 5, legacy = false, managed = false, failSave = false
const writes: unknown[] = []
const control = () => page.getByRole('button', { name: '子代理并发数量', exact: true })

async function reopen(): Promise<void> {
  await page.getByRole('tab', { name: '外观', exact: true }).click()
  await page.getByRole('tab', { name: '模型', exact: true }).click()
  await expect(page.locator('.settings-view--models')).toBeVisible()
}

test.describe.serial('子代理并发设置真实界面', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'subagent-concurrency-ui-'))
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      const reply = (data: unknown, status = 200, code = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code, message, data }))
      }
      if (path === '/health') return reply({ status: 'ok' })
      if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1,
        toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'subagent-concurrency-ui' })
      if (request.headers['x-aether-instance-token'] !== token) return reply(null, 401, 40100, 'invalid fixture token')
      if (path === '/api/v1/settings') {
        if (request.method === 'PUT') {
          let raw = ''; for await (const chunk of request) raw += chunk.toString()
          const body = JSON.parse(raw) as { SUBAGENT_CONCURRENCY_LIMIT: number }; writes.push(body)
          if (failSave) return reply(null, 403, 40300, '当前账号没有修改引擎设置的权限')
          limit = body.SUBAGENT_CONCURRENCY_LIMIT
          return reply({ updated: true })
        }
        return reply(legacy ? {} : { SUBAGENT_CONCURRENCY_LIMIT: limit, managedKeys: managed ? ['SUBAGENT_CONCURRENCY_LIMIT'] : [],
          subagentConcurrency: { defaultLimit: 5, min: 1, max: 16, effectiveLimit: limit, scope: 'parent-session', hotReload: true } })
      }
      if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'concurrency-session',
        finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (path === '/api/v1/chat/runs') return reply({ runs: [] })
      return reply([])
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote',
      remoteBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, autoStartEngine: true,
      appearance: 'dark', lastFolder: '', lastSessionId: 'concurrency-session' }))
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(name.toUpperCase())) delete env[name]
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token } })
    health = await monitorElectronHealth(app, 'subagent-concurrency-ui', [token])
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '模型', exact: true }).click()
    await expect(control()).toBeEnabled()
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, testInfo) => {
    try { if (health) await health.closeAndAssert(testInfo); else await app?.close() }
    finally {
      server?.closeAllConnections()
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
      if (fixture) {
        if (dirname(resolve(fixture)) !== resolve(fixtureRoot) || !basename(fixture).startsWith('subagent-concurrency-ui-')) throw new Error('Unsafe fixture cleanup')
        rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('默认5，选择后保存到当前引擎并核对实际生效数量，重新打开保留', async ({}, testInfo) => {
    await expect(control()).toHaveText('5 个（默认）')
    await control().click()
    await page.getByRole('menuitem', { name: '7 个', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '已生效 · 每个主会话最多同时运行 7 个子代理' })).toBeVisible()
    expect(writes).toEqual([{ SUBAGENT_CONCURRENCY_LIMIT: 7 }])
    expect(limit).toBe(7)
    await reopen()
    await expect(control()).toHaveText('7 个')
    const group = page.locator('.sg').filter({ has: page.getByRole('heading', { name: '子代理执行', exact: true }) })
    await group.scrollIntoViewIfNeeded()
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-appearance', value), appearance)
      await expect(group).toContainText('适用于当前远程引擎')
      await group.screenshot({ path: testInfo.outputPath(`concurrency-${appearance}.png`) })
    }
  })

  test('权限拒绝保留已确认的数量，旧引擎与受管设置不允许假保存', async () => {
    failSave = true
    await control().click()
    await page.getByRole('menuitem', { name: '8 个', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('当前账号没有修改引擎设置的权限')
    await expect(control()).toHaveText('7 个')
    expect(limit).toBe(7)
    failSave = false; legacy = true
    await reopen()
    await expect(control()).toBeDisabled()
    await expect(page.locator('.settings-view--models')).toContainText('当前引擎尚不支持调整，请先更新引擎')
    legacy = false; managed = true
    await reopen()
    await expect(control()).toBeDisabled()
    await expect(control()).toHaveText('7 个')
    await expect(page.locator('.settings-view--models')).toContainText('此数量由引擎管理员统一管理')
    expect(writes).toHaveLength(2)
  })

  test('搜索排队可直接发现并发设置', async () => {
    managed = false
    await page.getByRole('textbox', { name: '搜索设置' }).fill('排队')
    await page.getByRole('option').filter({ hasText: '子代理并发数量' }).click()
    await expect(page.locator('.settings-view--models')).toBeVisible()
  })
})
