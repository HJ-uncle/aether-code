/** New real Electron regression for duplicate model saves. UI, preload and IPC
 * are real; a controlled HTTP engine provides conflicts and a held save response.
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

test.describe.serial('模型重复保存真实界面回归', () => {
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
        if (path === '/api/v1/models' && method === 'POST') {
          const save = (fail = false): void => {
            if (fail) { reply(null, 503, 50300, '保存暂时不可用，请重试'); return }
            const existing = models.find(model => model.provider === body.provider && model.modelId === body.modelId)
            if (existing) {
              reply({ reason: 'MODEL_ALREADY_EXISTS', existingModelId: existing.id }, 409, 40901,
                '该提供方下已存在相同模型 ID，请编辑已有模型或使用其他模型 ID。')
              return
            }
            const model = { ...record(String(body.modelId)), baseUrl: String(body.baseUrl),
              displayName: body.displayName ? String(body.displayName) : String(body.modelId), apiKey: '...ider' }
            models.push(model)
            reply(model)
          }
          if (holdNextCreate) { holdNextCreate = false; releaseCreate = save; return }
          return save()
        }
        if (method === 'PUT') {
          const index = models.findIndex(model => model.id === path.split('/').at(-1))
          if (index < 0) return reply(null, 404, 40400, '模型不存在')
          models[index] = { ...models[index], ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}) }
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
      autoStartEngine: false, lastFolder: '', lastSessionId: 'model-conflict-session' }))
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
})
