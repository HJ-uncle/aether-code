/** Real Electron regression for model form controls, footer actions and duplicate
 * saves. UI, preload and IPC are real; a controlled HTTP engine provides responses.
 * No model/provider calls or production database writes. Run only after build,
 * serially when the campaign's Electron instance has been stopped by its owner. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineModel } from '../src/renderer/src/core/engine/models'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const instanceToken = 'model-conflict-ui-instance-fixture'
let app: ElectronApplication | undefined
let health: ElectronHealthMonitor | undefined
let page: Page
let server: Server | undefined
let fixture = ''
let nextId = 0
let models: EngineModel[] = []
let holdNextCreate = false
let releaseCreate: ((fail?: boolean) => void) | undefined
const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
const rendererErrors: string[] = []

function record(modelId: string): EngineModel {
  return { id: `conflict-${++nextId}`, tenantId: 'fixture', provider: 'deepseek', modelId,
    displayName: modelId, baseUrl: 'https://example.com/original', apiKey: '...inal',
    isEnabled: true, createdAt: 1, updatedAt: 1 }
}
const writes = (method: string, modelId?: string) => requests.filter(request => request.method === method &&
  (modelId === undefined || request.body.modelId === modelId))

async function addDialog(): Promise<Locator> {
  // Closing dialogs become aria-hidden before their dismissal callback runs.
  await expect(page.locator('.modal--model-form')).toHaveCount(0)
  await page.locator('.settings-view--models').getByRole('button', { name: '添加模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加模型', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

async function fillDraft(dialog: Locator, modelId: string): Promise<void> {
  await dialog.getByLabel('模型 ID', { exact: true }).fill(modelId)
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-attempted-key-never-a-provider')
  await dialog.getByLabel('接口地址', { exact: true }).fill('https://example.com/attempted')
}

test.describe.serial('模型表单与重复保存真实界面回归', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'model-save-conflict-ui-'))
    models = [record('configured-model')]
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      const method = request.method ?? 'GET'
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}
      const reply = (data: unknown, status = 200, code = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code, message, data }))
      }
      if (path === '/health') return reply({ status: 'ok' })
      if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'c'.repeat(64)}`,
        protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'model-conflict-ui' })
      if (request.headers['x-aether-instance-token'] !== instanceToken) return reply(null, 401, 40100, 'invalid fixture instance token')
      if (path.startsWith('/api/v1/models')) {
        requests.push({ method, path, body })
        if (path === '/api/v1/models' && method === 'GET') return reply(models)
        if (/^\/api\/v1\/models\/[^/]+\/test$/.test(path) && method === 'POST') return reply({ success: true, latency: 12 })
        if (path === '/api/v1/models/detect-capabilities' && method === 'POST') return reply({ vision: true, contextWindow: 256000 })
        if (path === '/api/v1/models' && method === 'POST') {
          const save = (fail = false): void => {
            if (fail) { reply(null, 503, 50300, '保存暂时不可用，请重试'); return }
            const existing = models.find(model => model.provider === body.provider && model.modelId === body.modelId)
            if (existing) {
              reply({ reason: 'MODEL_ALREADY_EXISTS', existingModelId: existing.id }, 409, 40901,
                '该提供方下已存在相同模型 ID，请编辑已有模型或使用其他模型 ID。')
              return
            }
            const model: EngineModel = { ...record(String(body.modelId)), provider: String(body.provider), baseUrl: String(body.baseUrl),
              displayName: body.displayName ? String(body.displayName) : String(body.modelId), apiKey: '...ider',
              apiFormat: body.apiFormat === 'openai' || body.apiFormat === 'anthropic' ? body.apiFormat : 'auto',
              capabilityOverrides: body.capabilityOverrides as EngineModel['capabilityOverrides'] }
            models.push(model)
            reply(model)
          }
          if (holdNextCreate) { holdNextCreate = false; releaseCreate = save; return }
          return save()
        }
        if (method === 'PUT') {
          const index = models.findIndex(model => model.id === path.split('/').at(-1))
          if (index < 0) return reply(null, 404, 40400, '模型不存在')
          models[index] = { ...models[index],
            ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
            ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
            ...(body.apiFormat === 'auto' || body.apiFormat === 'openai' || body.apiFormat === 'anthropic' ? { apiFormat: body.apiFormat } : {}) }
          return reply(models[index])
        }
      }
      if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'model-conflict-session',
        finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (path === '/api/v1/chat/runs') return reply({ runs: [] })
      return reply([])
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const remoteBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl,
      autoStartEngine: true, appearance: 'dark', lastFolder: '', lastSessionId: 'model-conflict-session' }))
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
        'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(name.toUpperCase())) delete env[name]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken } })
    health = await monitorElectronHealth(app, 'model-save-conflict', [instanceToken])
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '模型', exact: true }).click()
    await expect(page.locator('.settings-view--models')).toContainText('configured-model')
  })

  test.afterEach(() => {
    expect(rendererErrors).toEqual([])
    health?.assertHealthy()
  })

  test.afterAll(async ({}, testInfo) => {
    releaseCreate?.(true)
    releaseCreate = undefined
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } finally {
      server?.closeAllConnections()
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
      if (fixture) {
        if (dirname(resolve(fixture)) !== resolve(fixtureRoot) || !basename(fixture).startsWith('model-save-conflict-ui-'))
          throw new Error('Refusing cleanup outside model conflict fixture')
        rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('已加载重复项提前阻止请求，显式打开编辑不带入草稿密钥或地址', async ({}, testInfo) => {
    const dialog = await addDialog()
    await fillDraft(dialog, ' configured-model ')
    await expect(dialog.getByRole('alert')).toContainText('该服务商下已存在相同模型 ID')
    await expect(dialog.getByLabel('模型 ID', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await dialog.getByLabel('模型 ID', { exact: true }).press('Enter')
    expect(writes('POST')).toHaveLength(0)
    expect(writes('PUT')).toHaveLength(0)
    await dialog.screenshot({ path: testInfo.outputPath('model-duplicate-inline.png') })
    await dialog.getByLabel('模型 ID', { exact: true }).fill('different-model')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByLabel('模型 ID', { exact: true }).fill('configured-model')
    await dialog.getByRole('button', { name: '编辑已有模型', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑模型', exact: true })
    await expect(edit).toBeVisible()
    await expect(edit.getByLabel('模型 ID', { exact: true })).toBeDisabled()
    await expect(edit.getByRole('button', { name: '服务商', exact: true })).toBeDisabled()
    await expect(edit.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(edit.getByLabel('接口地址', { exact: true })).toHaveValue('https://example.com/original')
    await expect(edit.getByLabel('上下文窗口', { exact: true })).toHaveValue('')
    await expect(edit.getByRole('button', { name: 'API 格式', exact: true })).toHaveText('自动识别')
    await edit.getByLabel('显示名称', { exact: true }).fill('Explicitly edited model')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toBeHidden()
    expect(writes('POST')).toHaveLength(0)
    expect(writes('PUT').map(request => request.body)).toEqual([{ displayName: 'Explicitly edited model' }])
    expect(models[0]).toMatchObject({ displayName: 'Explicitly edited model', apiKey: '...inal', baseUrl: 'https://example.com/original' })
  })

  test('缓存列表之后发生并发新增，409 回执提供恢复入口且不自动更新已有配置', async ({}, testInfo) => {
    const dialog = await addDialog()
    await fillDraft(dialog, 'created-elsewhere')
    models.push(record('created-elsewhere'))
    const putCount = writes('PUT').length
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('该服务商下已存在相同模型 ID')
    await expect(dialog.getByRole('button', { name: '编辑已有模型', exact: true })).toBeVisible()
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-attempted-key-never-a-provider')
    await expect(dialog).not.toContainText('SQLITE_CONSTRAINT')
    expect(writes('POST', 'created-elsewhere')).toHaveLength(1)
    expect(writes('PUT')).toHaveLength(putCount)
    expect(models.filter(model => model.modelId === 'created-elsewhere')).toHaveLength(1)
    expect(models.find(model => model.modelId === 'created-elsewhere')?.apiKey).toBe('...inal')
    await dialog.screenshot({ path: testInfo.outputPath('model-concurrent-conflict.png') })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  })

  test('同一事件轮次重复 Enter 和点击仅发一次保存，失败后可重试成功', async () => {
    const dialog = await addDialog()
    await fillDraft(dialog, 'guarded-model')
    holdNextCreate = true
    await dialog.evaluate(element => {
      const input = element.querySelector<HTMLInputElement>('input[aria-label="模型 ID"]')!
      const save = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '保存')!
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      save.click()
    })
    await expect.poll(() => writes('POST', 'guarded-model').length).toBe(1)
    await expect(dialog.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('API Key', { exact: true })).toBeDisabled()
    expect(releaseCreate).toBeDefined()
    const rejectFirst = releaseCreate!
    releaseCreate = undefined
    rejectFirst(true)
    await expect(dialog.getByRole('alert')).toContainText('保存暂时不可用，请重试')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(writes('POST', 'guarded-model')).toHaveLength(2)
    expect(models.filter(model => model.modelId === 'guarded-model')).toHaveLength(1)
  })

  test('服务商浮层可真实点击，上下文四档可选择且键盘不会误保存或关闭弹窗', async ({}, testInfo) => {
    const dialog = await addDialog()
    const provider = dialog.getByRole('button', { name: '服务商', exact: true })
    await provider.click()
    await page.getByRole('menu', { name: '服务商', exact: true }).getByRole('menuitem', { name: 'OpenAI 兼容', exact: true }).click()
    await expect(provider).toHaveText('OpenAI 兼容')
    await expect(dialog.getByLabel('接口地址', { exact: true })).toHaveValue('https://api.openai.com/v1')
    await provider.click()
    await page.getByRole('menu', { name: '服务商', exact: true }).getByRole('menuitem', { name: 'DeepSeek', exact: true }).click()
    await expect(provider).toHaveText('DeepSeek')
    await expect(dialog.getByLabel('接口地址', { exact: true })).toHaveValue('https://api.deepseek.com')
    await expect(dialog.getByRole('button', { name: 'deepseek-chat', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'deepseek-reasoner', exact: true })).toHaveCount(0)
    await fillDraft(dialog, 'context-picker-draft')
    const context = dialog.getByRole('combobox', { name: '上下文窗口', exact: true })
    const presetButton = dialog.getByRole('button', { name: '选择上下文窗口预设', exact: true })
    const presets = page.getByRole('listbox', { name: '上下文窗口预设', exact: true })
    await expect(context).toHaveValue('256')
    for (const value of ['128', '256', '512', '1000']) {
      await presetButton.click()
      await expect(presets.getByRole('option')).toHaveText(['128 K', '256 K', '512 K', '1000 K'])
      await presets.getByRole('option', { name: `${value} K`, exact: true }).click()
      await expect(context).toHaveValue(value)
      await expect(presets).toBeHidden()
    }
    await context.fill('256')
    await dialog.locator('.modal__header').hover()
    const createsBefore = writes('POST').length
    await context.press('ArrowDown')
    await expect(presets).toBeVisible()
    await context.press('ArrowDown')
    await context.press('Enter')
    await expect(context).toHaveValue('512')
    await expect(presets).toBeHidden()
    await expect(dialog).toBeVisible()
    expect(writes('POST')).toHaveLength(createsBefore)
    await context.press('ArrowDown')
    await expect(presets).toBeVisible()
    await context.press('Escape')
    await expect(presets).toBeHidden()
    await expect(dialog).toBeVisible()
    await context.press('ArrowDown')
    await expect(presets).toBeVisible()
    await context.press('Tab')
    await expect(presets).toBeHidden()
    await expect(dialog).toBeVisible()
    await context.fill('123.789')
    await presetButton.click()
    await expect(presets.getByRole('option')).toHaveText(['128 K', '256 K', '512 K', '1000 K'])
    await dialog.screenshot({ path: testInfo.outputPath('model-context-presets.png') })
    await context.press('Escape')
    await context.fill('')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(writes('POST')).toHaveLength(createsBefore)
  })

  test('新建默认 256 K 和自由输入的小数按 token 保存，重新编辑保留配置', async () => {
    for (const [id, input, tokens] of [
      ['context-default-model', '256', 256000],
      ['context-custom-model', '123.789', 123789]
    ] as const) {
      const dialog = await addDialog()
      await fillDraft(dialog, id)
      const context = dialog.getByLabel('上下文窗口', { exact: true })
      await expect(context).toHaveValue('256')
      if (input !== '256') await context.fill(input)
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toBeHidden()
      const create = writes('POST', id).filter(request => request.path === '/api/v1/models')
      expect(create).toHaveLength(1)
      expect(create[0].body.capabilityOverrides).toEqual({ contextWindow: tokens })
      expect(models.find(model => model.modelId === id)?.capabilityOverrides).toEqual({ contextWindow: tokens })
      await expect(page.locator('.modal--model-form')).toHaveCount(0)
      await page.locator('.settings-view--models .sg__row').filter({ hasText: id }).getByRole('button', { name: '编辑', exact: true }).click()
      const edit = page.getByRole('dialog', { name: '编辑模型', exact: true })
      await expect(edit.getByLabel('上下文窗口', { exact: true })).toHaveValue(input)
      await edit.getByRole('button', { name: '取消', exact: true }).click()
      await expect(edit).toBeHidden()
    }
  })

  test('连接和能力按钮固定在底栏左侧，从正文顶部操作也会滚动到结果', async ({}, testInfo) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720))
    const dialog = await addDialog()
    await fillDraft(dialog, 'footer-actions-model')
    const footer = dialog.locator('.modal__footer')
    const secondary = footer.locator('.model-form__secondary-actions')
    const primary = footer.locator('.model-form__primary-actions')
    const body = dialog.locator('.modal__body')
    await expect(secondary.getByRole('button')).toHaveText(['测试连接', '检测能力'])
    await expect(primary.getByRole('button')).toHaveText(['取消', '保存'])
    await expect(body.getByRole('button', { name: '测试连接', exact: true })).toHaveCount(0)
    await expect(body.getByRole('button', { name: '检测能力', exact: true })).toHaveCount(0)
    await expect(page.locator('.modal-overlay')).toHaveAttribute('data-motion-state', 'open')
    await body.evaluate(element => { element.scrollTop = 0 })
    const before = await secondary.boundingBox()
    const primaryBox = await primary.boundingBox()
    if (!before || !primaryBox) throw new Error('Missing model footer action bounds')
    expect(before.x + before.width).toBeLessThan(primaryBox.x)
    await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const after = await secondary.boundingBox()
    if (!after) throw new Error('Missing model footer after scrolling')
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    await body.evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
    await secondary.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('连接正常（12 ms）')
    await expect(dialog.getByRole('status')).toBeInViewport({ ratio: 1 })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(requests.filter(request => request.path === '/api/v1/models/new/test').map(request => request.body)).toEqual([{
      provider: 'deepseek', modelId: 'footer-actions-model', apiKey: 'synthetic-attempted-key-never-a-provider', baseUrl: 'https://example.com/attempted', apiFormat: 'auto'
    }])
    await body.evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
    await expect(dialog.getByRole('status')).not.toBeInViewport()
    await secondary.getByRole('button', { name: '检测能力', exact: true }).click()
    await expect(dialog).toContainText('推断能力')
    await expect(dialog.getByRole('button', { name: '→ 填入图片输入', exact: true })).toBeInViewport({ ratio: 1 })
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(requests.filter(request => request.path === '/api/v1/models/detect-capabilities').map(request => request.body)).toEqual([{
      provider: 'deepseek', modelId: 'footer-actions-model', baseUrl: 'https://example.com/attempted', apiFormat: 'auto'
    }])
    await dialog.screenshot({ path: testInfo.outputPath('model-footer-actions.png') })
    await primary.getByRole('button', { name: '取消', exact: true }).click()
  })

  test('API 格式可选择保存和重开，连接测试使用当前格式及地址并复用已保存密钥', async ({}, testInfo) => {
    const id = 'api-format-model'
    const dialog = await addDialog()
    await fillDraft(dialog, id)
    const chooseFormat = async (form: Locator, label: string): Promise<void> => {
      const control = form.getByRole('button', { name: 'API 格式', exact: true })
      await control.click()
      const menu = page.getByRole('menu', { name: 'API 格式', exact: true })
      await expect(menu.locator('.select__item-head')).toHaveText(['自动识别', 'OpenAI', 'Anthropic'])
      await expect(menu.locator('.select__item-desc')).toHaveText(['Chat Completions 格式', 'Messages 格式'])
      await menu.getByRole('menuitem').filter({ has: page.getByText(label, { exact: true }) }).click()
      await expect(control).toHaveText(label)
    }
    await expect(dialog.getByRole('button', { name: 'API 格式', exact: true })).toHaveText('自动识别')
    await chooseFormat(dialog, 'Anthropic')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(dialog).toContainText('连接正常（12 ms）')
    const draftTest = requests.filter(request => request.path === '/api/v1/models/new/test' && request.body.modelId === id)
    expect(draftTest.map(request => request.body)).toEqual([{
      provider: 'deepseek', modelId: id, apiKey: 'synthetic-attempted-key-never-a-provider', baseUrl: 'https://example.com/attempted', apiFormat: 'anthropic'
    }])
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    const created = models.find(model => model.modelId === id)
    if (!created) throw new Error('Missing API format fixture model')
    expect(created.apiFormat).toBe('anthropic')
    expect(requests.filter(request => request.path === '/api/v1/models' && request.method === 'POST' && request.body.modelId === id).map(request => request.body.apiFormat)).toEqual(['anthropic'])
    const openEdit = async (): Promise<Locator> => {
      await expect(page.locator('.modal--model-form')).toHaveCount(0)
      await page.locator('.settings-view--models .sg__row').filter({ hasText: id }).getByRole('button', { name: '编辑', exact: true }).click()
      const form = page.getByRole('dialog', { name: '编辑模型', exact: true })
      await expect(form).toBeVisible()
      return form
    }
    const edit = await openEdit()
    await expect(edit.getByRole('button', { name: 'API 格式', exact: true })).toHaveText('Anthropic')
    await expect(edit.getByLabel('API Key', { exact: true })).toHaveValue('')
    await edit.getByLabel('接口地址', { exact: true }).fill('https://example.com/custom/anthropic')
    await chooseFormat(edit, 'OpenAI')
    await edit.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(edit).toContainText('连接正常（12 ms）')
    const savedTest = requests.filter(request => request.path === `/api/v1/models/${created.id}/test`)
    expect(savedTest.map(request => request.body)).toEqual([{
      provider: 'deepseek', modelId: id, baseUrl: 'https://example.com/custom/anthropic', apiFormat: 'openai'
    }])
    expect(models.find(model => model.id === created.id)?.apiFormat).toBe('anthropic')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toBeHidden()
    expect(requests.filter(request => request.path === `/api/v1/models/${created.id}` && request.method === 'PUT').map(request => request.body)).toEqual([{
      apiFormat: 'openai', baseUrl: 'https://example.com/custom/anthropic'
    }])
    const reopened = await openEdit()
    await expect(reopened.getByRole('button', { name: 'API 格式', exact: true })).toHaveText('OpenAI')
    await expect(reopened.getByLabel('接口地址', { exact: true })).toHaveValue('https://example.com/custom/anthropic')
    await chooseFormat(reopened, '自动识别')
    await reopened.getByRole('button', { name: '保存', exact: true }).click()
    await expect(reopened).toBeHidden()
    expect(requests.filter(request => request.path === `/api/v1/models/${created.id}` && request.method === 'PUT').at(-1)?.body).toEqual({ apiFormat: 'auto' })
    const automatic = await openEdit()
    await expect(automatic.getByRole('button', { name: 'API 格式', exact: true })).toHaveText('自动识别')
    await automatic.screenshot({ path: testInfo.outputPath('model-api-format-auto.png') })
    await automatic.getByRole('button', { name: '取消', exact: true }).click()
  })
})
