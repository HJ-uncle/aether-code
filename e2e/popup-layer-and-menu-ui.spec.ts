/** Real Electron regression for owned overlay layers and shared menu surfaces.
 * Exercises mouse hit testing, durable settings/API writes, nested Dialog focus,
 * one-level Escape, global confirmation, migrated MCP controls, and light/dark
 * viewport geometry. Only an authenticated fixture engine and temporary user data
 * are used. Build first and run serially; this suite never contacts a provider. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineModel } from '../src/renderer/src/core/engine/models'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'popup-layer-menu-fixture-token', sessionId = 'work-popup-layer-menu-session'
const modelId = 'popup-layer-menu-model', modelName = '弹层回归模型'
type Receipt = { method: string; path: string; body: Record<string, unknown> }
const receipts: Receipt[] = [], errors: string[] = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let server: Server | undefined, fixture = '', concurrency = 5, securityMode = 'standard'
let mcpServers: Record<string, unknown>[] = []
const model: EngineModel = { id: 'popup-model-record', tenantId: 'fixture', modelId,
  provider: 'openai', displayName: modelName, apiKey: '...test', baseUrl: 'https://example.com/v1',
  isEnabled: true, createdAt: 1, updatedAt: 1, capabilities: { toolCalling: true } }

const settings = () => page.locator('.work-settings-dialog')
const selectedMenu = (name: string) => page.getByRole('menu', { name, exact: true })
const savedSettings = (): Record<string, unknown> => JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8'))

function emptySnapshot(id: string): ChatRecoverySnapshot {
  // An empty persisted session has an explicit null cursor. Omitting eventId
  // makes the real recovery boundary reject it and leaves Code read-only.
  return { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
    projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
}

async function resize(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(580, 450)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

async function openWorkSettings(section: string): Promise<void> {
  if (!await settings().isVisible()) {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.getByRole('button', { name: '设置', exact: true }).first().click()
    await expect(settings()).toBeVisible()
  }
  await settings().getByRole('tab', { name: section, exact: true }).click()
}

async function closeWorkSettings(): Promise<void> {
  if (await settings().isVisible()) await settings().locator('.modal__header').getByRole('button').click()
  await expect(settings()).toHaveCount(0)
}

/** Visibility alone was a false positive: the old panel was rendered below the
 * modal. Test the actual hit target before allowing a normal Playwright click. */
async function expectHitTarget(target: Locator): Promise<void> {
  await expect(target).toBeVisible()
  await expect.poll(() => target.evaluate(element => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return Boolean(hit && element.contains(hit))
  }), 'The visible control must receive the pointer at its center').toBe(true)
}

async function expectFocusWithin(scope: Locator): Promise<void> {
  await expect.poll(() => scope.evaluate(element => element.contains(document.activeElement)),
    'Keyboard focus must stay in the foremost dialog').toBe(true)
}

async function expectMenuGeometry(menu: Locator): Promise<void> {
  const geometry = await menu.evaluate(element => {
    const panel = element.closest('.popover__panel') ?? element
    const panelBox = panel.getBoundingClientRect(), item = element.querySelector<HTMLElement>('[role="menuitem"]')
    if (!item) throw new Error('Menu has no items')
    const itemBox = item.getBoundingClientRect(), style = getComputedStyle(element)
    return { left: panelBox.left, top: panelBox.top, right: panelBox.right, bottom: panelBox.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      horizontalPadding: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
      itemInset: [itemBox.left - panelBox.left, panelBox.right - itemBox.right],
      itemRadius: parseFloat(getComputedStyle(item).borderTopLeftRadius),
      scrollOverflow: element.scrollWidth - element.clientWidth }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(4)
  expect(geometry.top).toBeGreaterThanOrEqual(4)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 4)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 4)
  for (const padding of geometry.horizontalPadding) expect(padding).toBeGreaterThanOrEqual(4)
  for (const inset of geometry.itemInset) expect(inset).toBeGreaterThanOrEqual(4)
  expect(geometry.itemRadius).toBeGreaterThanOrEqual(6)
  expect(geometry.scrollOverflow).toBeLessThanOrEqual(1)
}

async function settleMenuVisual(menu: Locator): Promise<void> {
  const panel = menu.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " popover__panel ")][1]')
  await expect(panel).toHaveAttribute('data-motion-state', 'open')
  await expect.poll(() => panel.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await expect.poll(() => panel.evaluate(element => new Promise<boolean>(done => {
    const before = element.getBoundingClientRect()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const after = element.getBoundingClientRect()
      done(Math.abs(before.x - after.x) < 0.1 && Math.abs(before.y - after.y) < 0.1 &&
        Math.abs(before.width - after.width) < 0.1 && Math.abs(before.height - after.height) < 0.1)
    }))
  })), 'Screenshot waits for final opacity and stable menu placement').toBe(true)
}

test.describe.serial('共享弹层归属与菜单真实窗口回归', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'popup-layer-menu-'))
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://fixture'), path = url.pathname
        const method = request.method ?? 'GET'
        let raw = ''; for await (const chunk of request) raw += chunk.toString()
        const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}
        const reply = (data: unknown, status = 200): void => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: status, message: status === 200 ? 'ok' : 'fixture unavailable', data }))
        }
        if (path === '/health') return reply({ status: 'ok' })
        if (path === '/meta') return reply({ version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`,
          protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'popup-layer-menu' })
        if (request.headers['x-aether-instance-token'] !== token) return reply(null, 401)
        if (method !== 'GET') receipts.push({ method, path, body })
        if (path === '/api/v1/settings') {
          if (method === 'PUT') concurrency = Number(body.SUBAGENT_CONCURRENCY_LIMIT)
          return reply({ SUBAGENT_CONCURRENCY_LIMIT: concurrency, subagentConcurrency: {
            defaultLimit: 5, min: 1, max: 16, effectiveLimit: concurrency, scope: 'parent-session', hotReload: true } })
        }
        if (path === '/api/v1/security/mode') {
          if (method === 'PUT') securityMode = String(body.mode)
          return reply({ sessionId: body.sessionId ?? url.searchParams.get('sessionId'), mode: securityMode })
        }
        if (path === '/api/v1/mcp/servers') {
          if (method === 'POST') mcpServers.push({ ...body })
          return reply(method === 'POST' ? body : mcpServers)
        }
        if (path === '/api/v1/models') return reply([model])
        if (path === '/api/v1/agents') return reply([
          { id: 'popup-reviewer', name: '弹层审查 Agent', description: '补全层键盘回归' },
          { id: 'popup-writer', name: '弹层写作 Agent', description: '补全列表第二项' }
        ])
        if (path === '/api/v1/skills') return reply({ list: [{ id: 'popup-skill', name: '弹层检查技能', enabled: true }] })
        if (path === '/api/v1/chat/admission/context') return reply({ protocolVersion: 1, tenantId: 'popup-fixture',
          sessionId: url.searchParams.get('sessionId') ?? sessionId, namespace: { id: 'popup-fixture-db', generation: 'one' },
          transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code',
            runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })
        if (path === '/api/v1/collaboration/capabilities') return reply({ protocolVersion: 1, durableQueueReceipts: false,
          receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false,
          userControllerMutation: false, rootUserControllerMutation: false })
        if (path === '/api/v1/subagent/capabilities') return reply({ schemaVersion: 2, eventVersions: [1, 2],
          views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })
        if (path === '/api/v1/subagent/runs') return reply({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'popup-fixture' })
        if (path === '/api/v1/cron/capabilities') return reply(null, 404)
        if (path === '/api/v1/memory/settings') return reply({ enabled: true, globalEnabled: false,
          sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true, memoryScope: 'session', effectiveScope: 'session' })
        if (path === '/api/v1/chat/snapshot') return reply(emptySnapshot(url.searchParams.get('sessionId') ?? sessionId))
        if (path === '/api/v1/chat/status') return reply({ running: false, finished: true })
        if (path === '/api/v1/chat/runs') return reply({ runs: [] })
        if (path === '/api/v1/command-jobs') return reply({ jobs: [] })
        if (path === '/api/v1/conversation/sessions') return reply([{ sessionId, title: '弹层回归任务', lastAt: 1, messageCount: 0 }])
        if (path === '/api/v1/workspace/directory') return reply({ root: '', entries: [] })
        return reply([])
      })().catch(error => {
        errors.push(String(error))
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 500, message: 'fixture request failed', data: null }))
      })
    })
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
    const remoteBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl,
      autoStartEngine: true, appearance: 'dark', lastFolder: '', lastModelId: modelId, lastSessionId: sessionId }))
    const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL',
      'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'popup-layer-menu', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await resize(1400)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const source = engineStorageKey({ mode: 'remote', baseUrl: remoteBaseUrl })
    await page.evaluate(({ key, sessionId, modelId }) => {
      localStorage.setItem(key, JSON.stringify({ activeTaskId: sessionId, tasks: [{ id: sessionId, title: '弹层回归任务',
        status: 'done', draft: '', createdAt: 1, updatedAt: 1, workspacePath: null, modelId, attachments: [], sources: [] }] }))
      localStorage.setItem('aether.app.mode', 'work')
    }, { key: `aether.work.state.v1:${encodeURIComponent(source)}`, sessionId, modelId })
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(page.locator('.work-view')).toBeVisible()
    await expect(page.locator('.work-view').getByRole('heading', { name: '弹层回归任务', exact: true })).toBeVisible()
  })

  test.afterEach(async ({}, info) => {
    await info.attach('popup-fixture-mutations', { body: JSON.stringify(receipts, null, 2), contentType: 'application/json' })
    health?.assertHealthy()
    expect(errors, 'No renderer exception or fixture protocol failure').toEqual([])
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server?.closeAllConnections()
      if (server) await new Promise<void>(done => server!.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== resolve(fixtureRoot) || !basename(target).startsWith('popup-layer-menu-')) throw new Error('Unsafe popup fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('Work设置菜单实际命中，改变并发后端与模型用途持久值', async () => {
    await openWorkSettings('模型')
    const concurrencyTrigger = settings().getByRole('button', { name: '子代理并发数量', exact: true })
    await expect(concurrencyTrigger).toBeEnabled()
    await concurrencyTrigger.click()
    const choice = selectedMenu('子代理并发数量').getByRole('menuitem', { name: '7 个', exact: true })
    await expectHitTarget(choice)
    await choice.click()
    await expect.poll(() => concurrency).toBe(7)
    await expect(concurrencyTrigger).toHaveText('7 个')
    expect(receipts.filter(item => item.path === '/api/v1/settings')).toEqual([
      { method: 'PUT', path: '/api/v1/settings', body: { SUBAGENT_CONCURRENCY_LIMIT: 7 } }
    ])
    for (const [name, key] of [['子代理使用的模型', 'subagentModelId'], ['轻任务使用的模型', 'utilityModelId']]) {
      const trigger = settings().getByRole('button', { name, exact: true })
      await trigger.click()
      const option = selectedMenu(name).getByRole('menuitem', { name: modelName, exact: true })
      await expectHitTarget(option)
      await option.click()
      await expect.poll(() => savedSettings()[key]).toBe(modelId)
      await expect(trigger).toHaveText(modelName)
    }
    await closeWorkSettings()
    await openWorkSettings('模型')
    await expect(concurrencyTrigger).toHaveText('7 个')
    await expect(settings().getByRole('button', { name: '子代理使用的模型', exact: true })).toHaveText(modelName)
  })

  test('主题色Popover在设置上方可操作，完成落盘且Esc只取消颜色层', async () => {
    await openWorkSettings('外观')
    const trigger = settings().getByRole('radio', { name: '自定义颜色', exact: true })
    await trigger.click()
    const picker = page.getByRole('dialog', { name: '自定义强调色', exact: true })
    const hex = picker.getByRole('textbox', { name: '自定义强调色色值', exact: true })
    await expectHitTarget(hex)
    await hex.fill('#4466cc'); await hex.press('Enter')
    const confirm = picker.getByRole('button', { name: '完成颜色选择', exact: true })
    await expectHitTarget(confirm); await confirm.click()
    await expect.poll(() => ({ accent: savedSettings().accent, customAccentColor: savedSettings().customAccentColor }))
      .toEqual({ accent: 'custom', customAccentColor: '#4466cc' })
    await expect(picker).toHaveCount(0)
    await expect(settings()).toBeVisible()
    await trigger.click()
    await hex.fill('#cc4455'); await hex.press('Enter')
    await hex.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(settings()).toBeVisible()
    await expect(trigger).toBeFocused()
    expect(savedSettings().customAccentColor).toBe('#4466cc')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#4466cc')
  })

  test('设置→模型表单→菜单逐层Esc，Tab与ShiftTab不回到父设置', async () => {
    await openWorkSettings('模型')
    const add = settings().getByRole('button', { name: '添加模型', exact: true })
    await add.click()
    const form = page.getByRole('dialog', { name: '添加模型', exact: true })
    const provider = form.getByRole('button', { name: '服务商', exact: true })
    await provider.click()
    const providerMenu = selectedMenu('服务商')
    const openai = providerMenu.getByRole('menuitem', { name: 'OpenAI 兼容', exact: true })
    await expectHitTarget(openai); await openai.click()
    await expect(provider).toHaveText('OpenAI 兼容')
    await provider.click(); await page.keyboard.press('Escape')
    await expect(providerMenu).toHaveCount(0)
    await expect(provider).toBeFocused()
    await expect(form).toBeVisible(); await expect(settings()).toBeVisible()
    const format = form.getByRole('button', { name: 'API 格式', exact: true })
    await format.click()
    const formatMenu = selectedMenu('API 格式')
    const anthropic = formatMenu.getByRole('menuitem', { name: /Anthropic.*Messages 格式/ })
    await expectHitTarget(anthropic); await anthropic.click()
    await expect(format).toHaveText('Anthropic')
    await format.click(); await page.keyboard.press('Escape')
    await expect(formatMenu).toHaveCount(0); await expect(format).toBeFocused()
    await provider.focus()
    for (const key of ['Tab', 'Shift+Tab', ...Array<string>(18).fill('Tab'), ...Array<string>(18).fill('Shift+Tab')]) {
      await page.keyboard.press(key)
      await expectFocusWithin(form)
    }
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(settings()).toBeVisible(); await expect(add).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(settings()).toHaveCount(0)
  })

  test('根部全局确认位于设置上方，取消或Esc都恢复触发器且不删除模型', async () => {
    await openWorkSettings('模型')
    const remove = settings().getByRole('button', { name: `删除模型 ${modelId}`, exact: true })
    for (const dismiss of ['cancel', 'escape']) {
      await remove.click()
      const confirm = page.getByRole('dialog', { name: '删除模型', exact: true })
      await expectHitTarget(confirm.getByRole('button', { name: '取消', exact: true }))
      for (let index = 0; index < 5; index++) { await page.keyboard.press('Tab'); await expectFocusWithin(confirm) }
      if (dismiss === 'cancel') await confirm.getByRole('button', { name: '取消', exact: true }).click()
      else await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(settings()).toBeVisible(); await expect(remove).toBeFocused()
    }
    expect(receipts.filter(item => item.path.startsWith('/api/v1/models') && item.method !== 'GET')).toEqual([])
  })

  test('迁移后的MCP菜单在设置内实际可选，表单保存到模拟后端', async () => {
    await openWorkSettings('MCP')
    const view = settings().locator('.settings-view--mcp')
    await view.getByRole('button', { name: 'MCP JSON 保存层级', exact: true }).click()
    const globalJson = selectedMenu('MCP JSON 保存层级').getByRole('menuitem', { name: '全局', exact: true })
    await expectHitTarget(globalJson); await globalJson.click()
    await expect(view.getByRole('button', { name: 'MCP JSON 保存层级', exact: true })).toHaveText('全局')
    await view.getByRole('button', { name: '新增服务器', exact: true }).click()
    await view.getByRole('textbox', { name: 'MCP id', exact: true }).fill('popup-test')
    await view.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('菜单回归服务')
    for (const [name, label] of [['MCP 传输类型', 'Streamable HTTP'], ['MCP 服务器保存层级', '全局']]) {
      await view.getByRole('button', { name, exact: true }).click()
      const choice = selectedMenu(name).getByRole('menuitem', { name: label, exact: true })
      await expectHitTarget(choice); await choice.click()
    }
    await view.getByRole('textbox', { name: 'MCP URL', exact: true }).fill('https://example.com/mcp')
    await view.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => mcpServers.length).toBe(1)
    expect(mcpServers[0]).toMatchObject({ id: 'popup-test', transportType: 'streamableHttp', scope: 'global', url: 'https://example.com/mcp' })
    await expect(view.getByRole('status')).toContainText('MCP 配置已保存')
  })

  test('明暗与窄窗口菜单保留四周留白圆角，长列表不溢出视口', async ({}, info) => {
    for (const appearance of ['light', 'dark']) {
      await openWorkSettings('外观')
      await settings().getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings().getByRole('tab', { name: '模型', exact: true }).click()
      for (const width of [1400, 760]) {
        await resize(width, width === 760 ? 640 : 900)
        await settings().getByRole('button', { name: '子代理并发数量', exact: true }).click()
        const menu = selectedMenu('子代理并发数量')
        await expectMenuGeometry(menu)
        await expectHitTarget(menu.getByRole('menuitem', { name: '7 个', exact: true }))
        await settleMenuVisual(menu)
        await page.screenshot({ path: info.outputPath(`settings-menu-${appearance}-${width}.png`) })
        await page.keyboard.press('End')
        const last = menu.getByRole('menuitem', { name: '16 个', exact: true })
        await expect(last).toBeFocused(); await expectHitTarget(last)
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0); await expect(settings()).toBeVisible()
      }
    }
    await resize(1400)
  })

  test('权限菜单保持图标说明右勾并提交会话值，Code普通菜单同样可点击', async ({}, info) => {
    await closeWorkSettings()
    const permission = page.locator('.work-view').getByRole('button', { name: '切换本会话访问权限：标准模式', exact: true })
    await expect(permission).toBeEnabled(); await permission.click()
    const menu = selectedMenu('切换本会话访问权限：标准模式')
    await expectMenuGeometry(menu)
    const rows = menu.locator('.select__item')
    await expect(rows).toHaveCount(3)
    await expect(rows.locator('.select__item-icon')).toHaveCount(3)
    await expect(rows.locator('.select__item-desc')).toHaveCount(3)
    await expect(menu.locator('.select__check')).toHaveCount(1)
    expect(await rows.evaluateAll(items => items.every(item => {
      const icon = item.querySelector('.select__item-icon')?.getBoundingClientRect()
      const copy = item.querySelector('.select__item-copy')?.getBoundingClientRect()
      const check = item.querySelector('.select__check-slot')?.getBoundingClientRect()
      return Boolean(icon && copy && check && icon.right <= copy.left + 1 && copy.right <= check.left + 1)
    }))).toBe(true)
    await settleMenuVisual(menu)
    await page.screenshot({ path: info.outputPath('permission-menu-icons-description-check.png') })
    const safe = menu.getByRole('menuitem', { name: /^安全模式/ })
    await expectHitTarget(safe); await safe.click()
    await expect.poll(() => securityMode).toBe('safe')
    expect(receipts.filter(item => item.path === '/api/v1/security/mode')).toEqual([
      { method: 'PUT', path: '/api/v1/security/mode', body: { sessionId, mode: 'safe' } }
    ])
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const viewTrigger = page.getByRole('button', { name: '查看', exact: true })
    await viewTrigger.click()
    const viewMenu = page.getByRole('menu', { name: '查看', exact: true })
    const openSettings = viewMenu.getByRole('menuitem', { name: /^设置/ })
    await expectHitTarget(openSettings)
    await expectMenuGeometry(viewMenu)
    await openSettings.click()
    await expect(viewMenu).toHaveCount(0)
    await expect(page.locator('.app-settings:visible')).toBeVisible()
    await expect(settings()).toHaveCount(0)
    await page.getByRole('button', { name: '文件', exact: true }).click()
    const fileMenu = page.getByRole('menu', { name: '文件', exact: true })
    await expectHitTarget(fileMenu.getByRole('menuitem', { name: /^快速打开文件/ }))
    await page.keyboard.press('Escape')
    await expect(fileMenu).toHaveCount(0)
    await expect(page.getByRole('button', { name: '文件', exact: true })).toBeFocused()
  })

  test('Code与Work补全都登记归属，后台补全不吞上层菜单键盘且Esc只关一层', async () => {
    const chatWritesBefore = receipts.filter(item => item.path === '/api/v1/chat').length
    for (const mode of ['code', 'work']) {
      await page.getByRole('tab', { name: mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click()
      const surface = page.locator(`.mode-surface[data-mode="${mode}"]`)
      const input = mode === 'code' ? surface.locator('.chat__input') : surface.locator('[contenteditable="true"]').first()
      await expect(input).toBeVisible()
      if (mode === 'code') {
        await expect(surface.getByRole('button', { name: '新建', exact: true }),
          'Code completion requires the real session snapshot to finish hydrating').toBeEnabled()
        // Compact composers move permissions into preferences. Widen the real
        // panel to exercise two independently owned menus through visible UI.
        await surface.getByRole('separator', { name: '调整对话面板宽度', exact: true }).press('End')
      }
      for (const kind of ['agent', 'resource']) {
        await input.fill(kind === 'agent' ? '@agent' : '/skill')
        const list = page.getByRole('listbox', { name: kind === 'agent' ? '选择自定义 Agent' : '选择 MCP、技能或知识库', exact: true })
        const completion = page.locator('.completion-popover').filter({ has: list })
        await expect(completion).toBeVisible()
        await expect(completion).toHaveAttribute('data-overlay-id', /.+/)
        await expect(list.getByRole('option').first()).toBeVisible()
        const initialSelection = await list.getByRole('option', { selected: true }).textContent()
        const permission = surface.getByRole('button', { name: /^切换本会话访问权限：/ })
        const menuName = await permission.getAttribute('aria-label')
        if (!menuName) throw new Error('Permission picker is missing its accessible name')
        // Space opens a second menu without an outside pointerdown dismissing
        // the completion first. This exercises the actual capture-order bug.
        await permission.focus(); await permission.press('Space')
        const menu = selectedMenu(menuName)
        await expect(menu).toBeVisible(); await expect(completion).toBeVisible()
        await page.keyboard.press('ArrowDown')
        await expect(list.getByRole('option', { selected: true })).toHaveText(initialSelection ?? '')
        await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter')
        await expect(menu).toHaveCount(0)
        await expect(completion).toBeVisible()
        await expect(input.locator('.mention-chip--agent')).toHaveCount(0)
        await permission.focus(); await permission.press('Space')
        await expect(menu).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0); await expect(completion).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(completion).toHaveCount(0)
        await expect(input).toHaveText(kind === 'agent' ? '@agent' : '/skill')
      }
      await input.fill('@agent')
      const agents = page.getByRole('listbox', { name: '选择自定义 Agent', exact: true })
      await expect(agents.getByRole('option').first()).toBeVisible()
      await input.press('Tab')
      await expect(agents).toHaveCount(0)
      await expect(input.locator('.mention-chip--agent')).toHaveText('弹层审查 Agent')
      await input.fill('')
    }
    expect(receipts.filter(item => item.path === '/api/v1/chat')).toHaveLength(chatWritesBefore)
  })
})
