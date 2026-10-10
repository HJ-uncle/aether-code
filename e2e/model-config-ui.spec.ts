/** D1 real Electron form + authenticated IPC/API + durable model overrides. No LLM requests. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { EngineModel } from '../src/renderer/src/core/engine/models'

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}
const root = resolve(__dirname, '..')
let app: ElectronApplication | undefined
let page: Page
let modelId: string
let fixture = ''
const initial = {
  vision: false,
  thinking: true,
  parallelTools: false,
  toolCalling: false,
  contextWindow: 123456
}

async function saved(): Promise<EngineModel> {
  const result = await page.evaluate(() =>
    window.aether.engine.request<EngineModel[]>({ method: 'GET', path: '/models' })
  )
  expect(result.ok, result.message).toBe(true)
  const model = result.data?.find((item) => item.id === modelId)
  if (!model) throw new Error('Synthetic model not found')
  return model
}
async function edit() {
  await page.locator('.settings-view').getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑模型' })
  await expect(dialog).toBeVisible()
  return dialog
}
async function save() {
  const dialog = page.getByRole('dialog', { name: '编辑模型' })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('D1 模型配置无损编辑', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'd1-model-ui-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({
        engineMode: 'embedded',
        preferredPort: 12413,
        autoStartEngine: true,
        lastFolder: fixture,
        thinkingMode: 'off'
      })
    )
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: root,
      env: {
        ...process.env,
        AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist/main.js'),
        AUTH_ENABLED: 'false',
        AETHER_GLOBAL_DIR: join(fixture, 'global'),
        WORKSPACE_ROOT: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
        SKILLS_ROOT: join(fixture, 'skills'),
        ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const response = await page.evaluate(
      async (capabilityOverrides) =>
        window.aether.engine.request<EngineModel>({
          method: 'POST',
          path: '/models',
          body: {
            provider: 'openai',
            modelId: 'gpt-4o',
            displayName: 'D1 synthetic model',
            baseUrl: 'https://example.com/v1',
            apiKey: 'synthetic-key-no-provider-call',
            capabilityOverrides
          }
        }),
      initial
    )
    expect(response.ok, response.message).toBe(true)
    modelId = response.data!.id
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '模型', exact: true }).click()
    await page.locator('.settings-view').getByRole('button', { name: '刷新', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '编辑区' }).getByRole('button', { name: '编辑', exact: true })
    ).toBeVisible()
  })
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const resolvedFixture = resolve(fixture)
    if (
      dirname(resolvedFixture) !== resolve(root, '.e2e-tmp') ||
      !basename(resolvedFixture).startsWith('d1-model-ui-')
    ) {
      throw new Error('Refusing cleanup outside this model UI fixture')
    }
    rmSync(resolvedFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('实际表单改名不覆盖隐藏能力和密钥', async () => {
    const dialog = await edit()
    await dialog.getByPlaceholder('可选', { exact: true }).fill('D1 renamed')
    await save()
    const model = await saved()
    expect(model.displayName).toBe('D1 renamed')
    expect(model.capabilityOverrides).toEqual(initial)
    expect(model.apiKey).toBe('...call')
  })
  test('改单项false保留上下文和其他override', async () => {
    const dialog = await edit()
    await dialog
      .getByRole('group', { name: '思考能力', exact: true })
      .getByRole('radio', { name: '关闭', exact: true })
      .click()
    await save()
    expect((await saved()).capabilityOverrides).toEqual({ ...initial, thinking: false })
  })
  test('单项默认发送null恢复推断，不清除其他人工设置', async () => {
    const dialog = await edit()
    await dialog
      .getByRole('group', { name: '图片输入能力', exact: true })
      .getByRole('radio', { name: '默认', exact: true })
      .click()
    await save()
    const model = await saved()
    const { vision: _vision, ...remaining } = initial
    expect(model.capabilityOverrides).toEqual({ ...remaining, thinking: false })
    expect(model.resolvedCapabilities?.vision).toBe(true)
    const reopened = await edit()
    await expect(
      reopened
        .getByRole('group', { name: '图片输入能力' })
        .getByRole('radio', { name: '默认', exact: true })
    ).toHaveAttribute('aria-checked', 'true')
    await reopened.getByRole('button', { name: '取消', exact: true }).click()
  })
  test('小数 K 编辑精确保存整数 token，并在重新打开时保留值', async () => {
    const dialog = await edit()
    const context = dialog.getByPlaceholder('如 128', { exact: true })
    await expect(context).toHaveValue('123.456')
    await context.fill('123.789')
    await save()
    expect((await saved()).capabilityOverrides).toEqual({
      contextWindow: 123789, parallelTools: false, toolCalling: false, thinking: false
    })
    const reopened = await edit()
    await expect(reopened.getByPlaceholder('如 128', { exact: true })).toHaveValue('123.789')
    await reopened.getByRole('button', { name: '取消', exact: true }).click()
  })
})
