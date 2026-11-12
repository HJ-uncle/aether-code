/** Real Electron with an isolated authenticated engine fixture: empty/duplicate
 * model lists, Code/Work selection, hover and keyboard details, management
 * entry points, and light/dark viewport geometry. No model calls or mutations.
 * AETHER_E2E_APP_ENTRY can select an independently built application snapshot. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineModel } from '../src/renderer/src/core/engine/models'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const codeId = 'picker-code', workId = 'work-picker', token = 'disposable-picker-ui-token'
const remoteRoot = '/remote/picker-ui', now = Date.now() - 1000
const titles = new Map([[codeId, 'Code 模型选择测试'], [workId, 'Work 模型选择测试']])
const alphaId = 'fixture-reasoner-v2', betaId = 'fixture-writer-v1'
const model = (id: string, modelId: string, displayName: string, provider: string): EngineModel => ({
  id, modelId, displayName, provider, tenantId: 'picker-fixture', apiKey: '...fixture-secret',
  baseUrl: 'https://fixture.example.invalid/v1', isEnabled: true, createdAt: now, updatedAt: now
})
const configuredModels: EngineModel[] = [
  { ...model('record-alpha', alphaId, '深度推理', 'deepseek'), apiFormat: 'openai', version: '2026-11',
    capabilities: { contextWindow: 200_000, thinking: true, vision: true, toolCalling: true },
    resolvedCapabilities: { contextWindow: 200_000, thinking: true, vision: false, toolCalling: true }, effectiveContextWindow: 128_000 },
  { ...model('record-beta', betaId, '轻快写作', 'openai'), capabilities: { contextWindow: 64_000, thinking: false, toolCalling: true } },
  model('record-alpha-duplicate', alphaId, '不应重复出现的记录', 'custom'),
  model('record-unknown', 'fixture-unreported', '能力待确认', 'custom')
]
let catalog: EngineModel[] = []
const errors: string[] = [], forbidden: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageSource = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const run = (id: string): RootRun | undefined => titles.has(id) ? {
  schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`,
  assistantMessageId: `assistant-${id}`, seq: 1, version: 2, status: 'succeeded', modelId: '',
  pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now
} : undefined
const history = (id: string) => titles.has(id) ? [
  { id: `user-${id}`, role: 'user', content: titles.get(id), createdAt: now, conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } },
  { id: `assistant-${id}`, role: 'assistant', content: '模型选择不会发送新请求。', createdAt: now + 1, conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } }
] : []
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  for await (const chunk of request) void chunk
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Unauthenticated fixture request')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: remoteRoot })); return }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Picker must not execute tasks or mutate engine configuration: ${path}`) }
  const rows = history(id), current = run(id)
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-stable`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'picker-ui-fixture' }
    : path === '/api/v1/models' ? catalog
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'picker-fixture', sessionId: id,
      namespace: { id: 'picker-fixture-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(current), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'off', effectiveScope: 'off', enabled: true, globalEnabled: false, sessionDefaultEnabled: false, sessionOverride: null, sessionEnabled: false, effectiveScopes: [] }
    : path === '/api/v1/memory/preferences' ? { enabled: true, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Picker fixture request failed') }) })

type Mode = 'work'
const menu = (): Locator => page.locator('.model-select-menu')
const options = (): Locator => menu().locator('.select__item:not([data-select-action])')
const detail = (name: string): Locator => page.getByRole('tooltip', { name: `${name}详情`, exact: true })
async function selectMode(mode: Mode): Promise<Locator> {
  const trigger = page.locator('.work-view .model-picker .select__trigger')
  await expect(trigger).toBeEnabled(); return trigger
}
async function openPicker(mode: Mode): Promise<Locator> {
  const trigger = await selectMode(mode); await trigger.click()
  await expect(menu()).toBeVisible(); return trigger
}
async function closePicker(): Promise<void> {
  if (await page.locator('.hover-detail').count()) {
    await page.keyboard.press('Escape'); await expect(page.locator('.hover-detail')).toHaveCount(0)
    await expect(menu()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  if (await menu().count()) await page.mouse.click(4, 4)
  await expect(menu()).toHaveCount(0)
  await page.locator('.work-view .model-picker .select__trigger').focus()
}
const settingsSurface = (_mode: Mode): Locator => page.getByRole('dialog', { name: '设置', exact: true })
async function closeSettings(mode: Mode): Promise<void> {
  await settingsSurface(mode).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settingsSurface(mode)).toHaveCount(0)
}
async function manageModels(mode: Mode): Promise<Locator> {
  await openPicker(mode); await menu().locator('[data-select-action="manage"]').click()
  await expect(menu()).toHaveCount(0)
  const settings = settingsSurface(mode)
  await expect(settings.getByRole('tab', { name: '模型', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(settings.locator('.settings-view--models')).toBeVisible(); return settings
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function setAppearance(appearance: 'light' | 'dark', mode: Mode): Promise<void> {
  await selectMode(mode)
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = settingsSurface(mode)
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await closeSettings(mode)
}
async function assertFooter(): Promise<void> {
  const add = menu().locator('[data-select-action="add"]'), manage = menu().locator('[data-select-action="manage"]')
  await expect(add).toHaveText('添加模型'); await expect(manage).toHaveText('管理模型')
  const a = await add.boundingBox(), b = await manage.boundingBox()
  if (!a || !b) throw new Error('Missing footer geometry')
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1); expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1)
}
async function selection(id: string): Promise<unknown> {
  return page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], {
    key: sessionStorageKey('aether:sessionModelSelections', storageSource), id
  })
}

test.describe.serial('模型选择器', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'model-picker-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageSource = engineStorageKey({ mode: 'remote', baseUrl: origin })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: remoteRoot,
      autoStartEngine: true, lastSessionId: workId, lastFolder: '', lastModelId: '', appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 960); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, workId, title, now }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: workId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: null, modelId: '', attachments: [], sources: [] }], activeTaskId: workId, homeDraft: '' }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(storageSource), workId, title: titles.get(workId)!, now })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(page.locator('.work-view')).toContainText('模型选择不会发送新请求。')
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('model-picker.png'); await page.screenshot({ path }); await info.attach('model-picker', { path, contentType: 'image/png' })
    }
    await info.attach('model-picker-requests', { body: JSON.stringify({ errors, forbidden }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(forbidden).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtures || !basename(target).startsWith('model-picker-profile-')) throw new Error('Unsafe model-picker fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('空列表和空选择不生成默认项，Work 可打开添加及管理', async () => {
    for (const mode of ['work'] as const) {
      const trigger = await openPicker(mode)
      await expect(trigger.locator('.select__value')).toHaveText('选择模型')
      await expect(options()).toHaveCount(0)
      await expect(menu().getByRole('status')).toContainText('还没有配置模型')
      await assertFooter()
      await menu().locator('[data-select-action="add"]').click(); await expect(menu()).toHaveCount(0)
      const form = page.getByRole('dialog', { name: '添加模型', exact: true })
      await expect(form.getByRole('textbox', { name: '模型 ID', exact: true })).toBeVisible()
      await expect(form.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      await form.getByRole('button', { name: '取消', exact: true }).click(); await expect(form).toHaveCount(0)
      const settings = await manageModels(mode)
      await expect(settings.locator('.settings-view--models')).toContainText('尚未配置模型')
      await closeSettings(mode)
    }
  })

  test('列表仅显示名称与服务商，重复 modelId 合并且 Work 能选择', async () => {
    catalog = configuredModels
    const settings = await manageModels('work')
    await settings.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(settings.getByRole('button', { name: '编辑', exact: true })).toHaveCount(4)
    await closeSettings('work')
    for (const mode of ['work'] as const) {
      const trigger = await openPicker(mode)
      await expect(trigger.locator('.select__value')).toHaveText('选择模型')
      await expect(options()).toHaveCount(3)
      await expect(menu().locator('.select__item[aria-current="true"]')).toHaveCount(0)
      await expect(options().locator('.select__item-head')).toHaveText(['深度推理', '轻快写作', '能力待确认'])
      await expect(options().locator('.select__item-desc')).toHaveText(['DeepSeek', 'OpenAI 兼容', '自定义'])
      await expect(options().filter({ hasText: /默认|不应重复出现|fixture-/ })).toHaveCount(0)
      await assertFooter()
      await closePicker()
    }
    for (const mode of ['work'] as const) {
      const trigger = await openPicker(mode)
      await options().filter({ has: page.getByText('深度推理', { exact: true }) }).click()
      await expect(menu()).toHaveCount(0); await expect(trigger.locator('.select__value')).toHaveText('深度推理')
      await expect.poll(() => selection(workId)).toEqual({ modelId: alphaId, anchorRunId: `root-${workId}` })
    }
  })

  test('详情可移入阅读，键盘聚焦与选择更新当前模型并关闭菜单', async () => {
    for (const mode of ['work'] as const) {
      const trigger = await openPicker(mode), alpha = options().filter({ has: page.getByText('深度推理', { exact: true }) })
      await alpha.hover(); const info = detail('深度推理'); await expect(info).toBeVisible()
      await expect(info).toContainText('128,000 tokens'); await expect(info).toContainText('200,000 tokens')
      await expect(info).toContainText('2026-11'); await expect(info).toContainText('OpenAI 兼容')
      await expect(info.locator('.model-picker-detail__capabilities dt')).toHaveText(['思考', '图片', '视频', '音频'])
      await expect(info.locator('dl > div').filter({ has: page.getByText('图片', { exact: true }) })).toHaveText('图片不支持')
      await expect(info.locator('dl > div').filter({ has: page.getByText('思考', { exact: true }) })).toHaveText('思考支持')
      await expect(info.locator('dl > div').filter({ has: page.getByText('音频', { exact: true }) })).toHaveText('音频未声明')
      await expect(info).not.toContainText('工具调用')
      await expect(info).not.toContainText(alphaId); await expect(info).not.toContainText('fixture-secret')
      await info.hover()
      // Cross the tooltip's 160 ms close grace period to catch disappearing
      // details after the pointer has left the model row for its content.
      await page.waitForTimeout(220); await expect(info).toBeVisible()
      await page.keyboard.press('Escape'); await expect(info).toHaveCount(0); await expect(menu()).toBeVisible()
      await closePicker(); await expect(trigger).toBeFocused()
      await page.keyboard.press('ArrowDown'); await expect(alpha).toBeFocused(); await expect(detail('深度推理')).toBeVisible()
      await page.keyboard.press('ArrowDown')
      const beta = options().filter({ has: page.getByText('轻快写作', { exact: true }) })
      await expect(beta).toBeFocused(); await expect(detail('轻快写作')).toBeVisible(); await expect(detail('深度推理')).toHaveCount(0)
      await page.keyboard.press('Enter'); await expect(menu()).toHaveCount(0); await expect(page.locator('.hover-detail')).toHaveCount(0)
      await expect(trigger).toBeFocused(); await expect(trigger.locator('.select__value')).toHaveText('轻快写作')
      await expect.poll(() => selection(workId)).toEqual({ modelId: betaId, anchorRunId: `root-${workId}` })
      await openPicker(mode); await expect(beta).toHaveAttribute('aria-current', 'true')
      await expect(menu().locator('.select__item[aria-current="true"]')).toHaveCount(1)
      await closePicker()
    }
    // Work selections are session-scoped; the picker receipt and persisted
    // session selection above are the authoritative assertions.
  })

  test('深浅色详情优先侧置，窄窗口自动避让且底部操作并排可见', async ({}, testInfo) => {
    for (const [appearance, mode] of [['light', 'work'], ['dark', 'work']] as const) {
      await setWindow(1440, 960); await setAppearance(appearance, mode)
      for (const [width, height] of [[1440, 960], [640, 700]] as const) {
        await setWindow(width, height); await openPicker(mode)
        await options().filter({ has: page.getByText('深度推理', { exact: true }) }).hover()
        const info = detail('深度推理'); await expect(info).toBeVisible(); await assertFooter()
        const geometry = await info.evaluate(element => {
          const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } }
          return { detail: rect(element), menu: rect(document.querySelector('.model-select-menu .select__panel')!),
            side: element.getAttribute('data-placement'), width: innerWidth, height: innerHeight, overflow: element.scrollWidth - element.clientWidth }
        })
        for (const bounds of [geometry.detail, geometry.menu]) {
          expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(geometry.width)
          expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(geometry.height)
        }
        expect(geometry.overflow).toBeLessThanOrEqual(1)
        if (geometry.width - geometry.menu.right - 14 >= geometry.detail.width) {
          expect(geometry.side).toBe('right'); expect(geometry.detail.left).toBeGreaterThan(geometry.menu.right)
        } else if (geometry.menu.left - 14 >= geometry.detail.width) {
          expect(geometry.side).toBe('left'); expect(geometry.detail.right).toBeLessThan(geometry.menu.left)
        } else expect(['above', 'below']).toContain(geometry.side)
        const screenshot = testInfo.outputPath(`model-picker-${mode}-${appearance}-${width}.png`)
        await page.screenshot({ path: screenshot, animations: 'disabled' })
        await testInfo.attach(`${mode}-${appearance}-${width}`, { path: screenshot, contentType: 'image/png' })
        await closePicker()
      }
    }
  })
})
