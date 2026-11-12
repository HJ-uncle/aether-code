/** Real Electron MCP settings: list-first light/dark and narrow layout, JSON
 * disclosure/import/export, exact CRUD scope, edit dialogs, connection results
 * and per-tool enablement. Uses a disposable authenticated HTTP fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { McpSettingsFixture, initialMcpSettingsServers, mcpSettingsDefaultWorkspace, mcpSettingsModel, mcpSettingsTask, mcpSettingsToken, mcpSettingsWorkspace } from './fixtures/mcp-settings'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/mcp-settings')
const fixture = new McpSettingsFixture(), errors: string[] = []
let app: ElectronApplication | undefined, page: Page, profile = ''
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const view = () => settings().locator('.settings-view--mcp')
const serverList = () => view().getByRole('region', { name: 'MCP 服务器', exact: true })
const server = (name: string) => serverList().getByRole('article', { name, exact: true })
const jsonDisclosure = () => view().getByRole('button', { name: 'JSON 配置', exact: true })
const jsonEditor = () => view().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })
const editDialog = () => page.getByRole('dialog', { name: '编辑 MCP 服务器', exact: true })
const createDialog = () => page.getByRole('dialog', { name: '新增 MCP 服务器', exact: true })
const writes = () => fixture.requests.filter(request => request.method !== 'GET')
const stored = (id: string, scope: 'project' | 'global' = 'project') => fixture.servers.find(item => item.id === id && item.scope === scope)

async function windowSize(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function openSettings(appearance: 'light' | 'dark' = 'light', width = 1320): Promise<void> {
  await windowSize(width)
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(settings()).toBeVisible()
  await settings().getByRole('tab', { name: '外观', exact: true }).click()
  await settings().getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings().getByRole('tab', { name: 'MCP', exact: true }).click()
  await expect(server('文档检索')).toBeVisible()
  expect(fixture.workspaceReads).toContain(mcpSettingsTask.id)
  await expect.poll(() => fixture.requests.some(request => request.path === '/api/v1/mcp/servers' && request.query.path === mcpSettingsWorkspace)).toBe(true)
}
async function choose(container: Locator, name: string, option: string): Promise<void> {
  await container.getByRole('button', { name, exact: true }).click()
  await page.getByRole('menu', { name, exact: true }).getByRole('menuitem', { name: option, exact: true }).click()
}
async function advanced(dialog: Locator): Promise<void> {
  const details = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^高级选项/ }) })
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
}
async function actions(name: string): Promise<Locator> {
  await server(name).getByRole('button', { name: `${name} 的更多操作`, exact: true }).click()
  const menu = page.getByRole('dialog', { name: `${name} 的操作`, exact: true })
  await expect(menu).toBeVisible()
  return menu
}
async function edit(name: string): Promise<Locator> {
  await (await actions(name)).getByRole('button', { name: '编辑', exact: true }).click()
  await expect(editDialog()).toBeVisible()
  return editDialog()
}
async function jsonOpen(): Promise<void> {
  if (await jsonDisclosure().getAttribute('aria-expanded') !== 'true') await jsonDisclosure().click()
  await expect(jsonDisclosure()).toHaveAttribute('aria-expanded', 'true')
  await expect(jsonEditor()).toBeVisible()
}
async function shot(name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await test.info().attach(name, { path, contentType: 'image/png' })
}
async function noHorizontalOverflow(container: Locator): Promise<void> {
  expect(await container.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const bounds = await container.boundingBox()
  expect(bounds).not.toBeNull()
  for (const button of await container.getByRole('button').all()) {
    if (!await button.isVisible()) continue
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
  }
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); profile = mkdtempSync(join(fixtureRoot, 'profile-'))
  await fixture.start()
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: fixture.origin,
    remoteWorkspaceRoot: mcpSettingsDefaultWorkspace, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: mcpSettingsModel, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = mcpSettingsToken; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1320, 900); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.beforeEach(async () => {
  fixture.reset()
  const storageKey = `aether.work.state.v1:${encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: fixture.origin }))}`
  await page.evaluate(({ storageKey, task, model }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(storageKey, JSON.stringify({ tasks: [{ ...task, status: 'done', draft: '', mentions: [],
      createdAt: 1, updatedAt: 2, modelId: model, attachments: [], sources: [] }], activeTaskId: task.id, homeDraft: '' }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
  }, { storageKey, task: mcpSettingsTask, model: mcpSettingsModel })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.work-task-heading h1')).toHaveText(mcpSettingsTask.title)
  await expect(page.locator('.work-view')).toContainText('MCP_SETTINGS_READY')
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await shot('mcp-settings-final')
  await info.attach('mcp-requests', { body: JSON.stringify({ requests: fixture.requests, workspaceReads: fixture.workspaceReads }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(fixture.errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    await fixture.close()
    if (profile) {
      if (dirname(resolve(profile)) !== resolve(fixtureRoot)) throw new Error('Unsafe MCP settings profile cleanup')
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1320, 760]) {
  test(`${appearance} / ${width}：服务器列表优先，JSON 默认折叠且操作不挤出页面`, async () => {
    await openSettings(appearance, width)
    await expect(serverList().getByRole('article')).toHaveCount(3)
    await expect(view().locator('section').first()).toHaveAttribute('aria-label', 'MCP 服务器')
    await expect(serverList().getByRole('button', { name: '刷新 MCP 服务器', exact: true })).toBeVisible()
    await expect(serverList().getByRole('button', { name: '新增服务器', exact: true })).toBeVisible()
    await expect(jsonDisclosure()).toHaveAttribute('aria-expanded', 'false')
    await expect(jsonEditor()).toBeHidden()
    await expect(view().locator('textarea:visible')).toHaveCount(0)
    await expect(server('文档检索')).toContainText(/stdio/i)
    await expect(server('文档检索')).toContainText('项目')
    await expect(server('远端资料')).toContainText('全局')
    await expect(server('文档检索').getByRole('switch', { name: '文档检索 启用', exact: true })).toBeChecked()
    await expect(server('远端资料').getByRole('switch', { name: '远端资料 启用', exact: true })).not.toBeChecked()
    await expect(server('内置资源').getByRole('switch', { name: '内置资源 启用', exact: true })).toBeDisabled()
    await expect(serverList().getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
    await expect(serverList().getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
    const first = await server('文档检索').boundingBox(), json = await jsonDisclosure().boundingBox()
    expect(first!.y + first!.height).toBeLessThan(json!.y)
    await noHorizontalOverflow(view())
    for (const article of await serverList().getByRole('article').all()) await noHorizontalOverflow(article)
    expect(writes()).toEqual([])
    await shot(`mcp-${appearance}-${width}-list-first`)
  })
}

test('JSON 读取和文件导入仅更新编辑内容，应用按所选全局作用域写入', async () => {
  await openSettings('light', 1320)
  expect(fixture.requests.some(request => request.path === '/api/v1/mcp/config/export')).toBe(false)
  await jsonOpen()
  await view().getByRole('button', { name: '读取当前配置', exact: true }).click()
  await expect.poll(async () => JSON.parse(await jsonEditor().inputValue()).mcpServers['docs-stdio']?.command).toBe('node')
  expect(fixture.requests.find(request => request.path === '/api/v1/mcp/config/export')?.query).toEqual({ path: mcpSettingsWorkspace, scope: 'project' })
  expect(writes()).toEqual([])
  await choose(view(), 'MCP JSON 保存层级', '全局')
  const config = { mcpServers: { imported: { name: '导入的服务', type: 'http', url: 'https://imported-fixture.invalid/mcp', enabled: false,
    futureOption: { retain: [false, 0, '完整字段'] } } } }
  const text = JSON.stringify(config, null, 2)
  await expect(view().getByRole('button', { name: '导入 JSON 文件', exact: true })).toBeVisible()
  await view().locator('input[type="file"]').setInputFiles({ name: 'fixture-mcp.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(jsonEditor()).toHaveValue(text)
  expect(writes()).toEqual([])
  await jsonDisclosure().click(); await expect(jsonEditor()).toBeHidden()
  await jsonOpen(); await expect(jsonEditor()).toHaveValue(text)
  await view().getByRole('button', { name: '应用 JSON', exact: true }).click()
  await expect.poll(() => stored('imported', 'global')?.name).toBe('导入的服务')
  expect(writes()).toEqual([{ method: 'POST', path: '/api/v1/mcp/config/import', query: { path: mcpSettingsWorkspace }, body: { scope: 'global', config } }])
  expect(stored('docs-stdio')).toEqual(initialMcpSettingsServers[0])
  await expect(server('导入的服务')).toBeVisible()
  await expect(server('导入的服务').getByRole('switch', { name: '导入的服务 启用', exact: true })).not.toBeChecked()
  await shot('mcp-json-global-import')
})

test('JSON 语法和引擎校验失败保留全文，失败不会修改服务器', async () => {
  await openSettings('dark', 760); await jsonOpen()
  await jsonEditor().fill('{broken JSON')
  await view().getByRole('button', { name: '应用 JSON', exact: true }).click()
  await expect(view().getByRole('alert')).toBeVisible()
  await expect(jsonEditor()).toHaveValue('{broken JSON')
  expect(writes()).toEqual([])
  const text = JSON.stringify({ mcpServers: { rejected: { type: 'http', url: 'not-a-url' } } }, null, 2)
  fixture.failImport = true
  await jsonEditor().fill(text)
  await view().getByRole('button', { name: '应用 JSON', exact: true }).click()
  await expect(view().getByRole('alert')).toContainText('夹具校验失败')
  await expect(jsonEditor()).toHaveValue(text)
  expect(fixture.servers).toEqual(initialMcpSettingsServers)
  await expect(serverList().getByRole('article')).toHaveCount(3)
  await noHorizontalOverflow(view())
  await shot('mcp-json-validation-keeps-draft')
})

test('stdio 编辑对话框保留标识与作用域，完整参数和高级设置按原合同保存', async () => {
  await openSettings('dark', 760)
  const dialog = await edit('文档检索')
  await expect(dialog.getByRole('textbox', { name: 'MCP id', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('textbox', { name: 'MCP id', exact: true })).toHaveValue('docs-stdio')
  await expect(dialog.getByRole('textbox', { name: 'MCP 环境变量', exact: true })).toBeHidden()
  await dialog.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('文档检索更新')
  await dialog.getByRole('textbox', { name: 'MCP 命令', exact: true }).fill('node-updated')
  const argv = ['server.mjs', '', ' literal whitespace ', '"quoted"']
  await dialog.getByRole('textbox', { name: 'MCP 参数', exact: true }).fill(JSON.stringify(argv))
  await advanced(dialog)
  await dialog.getByRole('textbox', { name: 'MCP 环境变量', exact: true }).fill('{"DOCS_ROOT":"updated-docs","FLAG":"0"}')
  await dialog.getByRole('textbox', { name: 'MCP 禁用工具', exact: true }).fill('export_report, future_tool')
  await dialog.getByRole('textbox', { name: 'MCP 请求超时', exact: true }).fill('0')
  await dialog.getByRole('textbox', { name: 'MCP 描述', exact: true }).fill('更新后的用途')
  await expect(dialog.getByRole('button', { name: 'MCP 服务器保存层级', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport({ ratio: 1 })
  await noHorizontalOverflow(dialog)
  await shot('mcp-stdio-edit-narrow')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => stored('docs-stdio')?.name).toBe('文档检索更新')
  expect(writes()).toEqual([{ method: 'PATCH', path: '/api/v1/mcp/servers/docs-stdio', query: { path: mcpSettingsWorkspace, scope: 'project' },
    body: { name: '文档检索更新', description: '更新后的用途', transportType: 'stdio', scope: 'project', disabledTools: ['export_report', 'future_tool'],
      timeoutMs: 0, command: 'node-updated', args: argv, env: { DOCS_ROOT: 'updated-docs', FLAG: '0' } } }])
  await expect(server('文档检索更新')).toBeVisible()
  const reopened = await edit('文档检索更新')
  await expect(reopened.getByRole('textbox', { name: 'MCP 参数', exact: true })).toHaveValue(JSON.stringify(argv, null, 2))
  await reopened.getByRole('textbox', { name: 'MCP 描述', exact: true }).fill('只修改描述，保留已有启动参数')
  await reopened.getByRole('button', { name: '保存', exact: true }).click()
  await expect(reopened).toBeHidden()
  await expect.poll(() => stored('docs-stdio')?.description).toBe('只修改描述，保留已有启动参数')
  expect(stored('docs-stdio')?.args).toEqual(argv)
  expect(writes()).toHaveLength(2)
  expect(writes()[1]).toEqual({ method: 'PATCH', path: '/api/v1/mcp/servers/docs-stdio', query: { path: mcpSettingsWorkspace, scope: 'project' },
    body: { name: '文档检索更新', description: '只修改描述，保留已有启动参数', transportType: 'stdio', scope: 'project', disabledTools: ['export_report', 'future_tool'],
      timeoutMs: 0, command: 'node-updated', args: argv, env: { DOCS_ROOT: 'updated-docs', FLAG: '0' } } })
})

test('键盘逐层关闭菜单与编辑框，520×700 单列高级设置滚动时保留操作栏', async () => {
  await openSettings('light', 520)
  await windowSize(520, 700)
  const more = server('文档检索').getByRole('button', { name: '文档检索 的更多操作', exact: true })
  await more.scrollIntoViewIfNeeded(); await more.focus(); await more.press('Enter')
  const menu = page.getByRole('dialog', { name: '文档检索 的操作', exact: true })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('button', { name: '编辑', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden(); await expect(settings()).toBeVisible()
  await expect(more).toBeFocused()

  await more.press('Enter')
  await expect(menu.getByRole('button', { name: '编辑', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = editDialog()
  await expect(dialog).toBeVisible()
  const transport = dialog.getByRole('button', { name: 'MCP 传输类型', exact: true })
  await transport.focus(); await transport.press('ArrowDown')
  const choices = page.getByRole('menu', { name: 'MCP 传输类型', exact: true })
  await expect(choices).toBeVisible()
  await expect(choices.getByRole('menuitem', { name: 'stdio（本地命令）', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(choices).toBeHidden(); await expect(dialog).toBeVisible(); await expect(transport).toBeFocused()

  const details = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^高级选项/ }) })
  const summary = details.locator('summary')
  await summary.scrollIntoViewIfNeeded(); await summary.focus(); await summary.press('Enter')
  await expect(details).toHaveAttribute('open', '')
  await dialog.getByRole('textbox', { name: 'MCP 请求超时', exact: true }).scrollIntoViewIfNeeded()
  expect(await dialog.locator('.mcp-form').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
  expect(await dialog.locator('.modal__body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport({ ratio: 1 })
  await noHorizontalOverflow(dialog)
  await shot('mcp-520x700-advanced-keyboard')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden(); await expect(settings()).toBeVisible()
  await expect(more).toBeFocused()

  await more.press('Enter')
  await expect(menu.getByRole('button', { name: '编辑', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu.getByRole('button', { name: '删除', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const confirmation = page.getByRole('dialog', { name: '删除 MCP 配置', exact: true })
  await expect(confirmation).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden(); await expect(settings()).toBeVisible()
  await expect(more).toBeFocused()
  expect(writes()).toEqual([])
  expect(stored('docs-stdio')).toEqual(initialMcpSettingsServers[0])
})

test('全局 HTTP 编辑保留请求头并可恢复默认超时，取消编辑不写入', async () => {
  await openSettings()
  const dialog = await edit('远端资料')
  await expect(dialog.getByRole('textbox', { name: 'MCP URL', exact: true })).toHaveValue(initialMcpSettingsServers[1].url!)
  await expect(dialog.getByRole('textbox', { name: 'MCP 命令', exact: true })).toHaveCount(0)
  await choose(dialog, 'MCP 传输类型', 'SSE')
  await dialog.getByRole('textbox', { name: 'MCP URL', exact: true }).fill('https://updated-fixture.invalid/events')
  await advanced(dialog)
  await expect(dialog.getByRole('textbox', { name: 'MCP 请求头', exact: true })).toHaveValue(JSON.stringify(initialMcpSettingsServers[1].headers, null, 2))
  await dialog.getByRole('textbox', { name: 'MCP 请求头', exact: true }).fill('{"Authorization":"Bearer updated-fixture"}')
  await dialog.getByRole('textbox', { name: 'MCP 请求超时', exact: true }).fill('')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => stored('remote-docs', 'global')?.transportType).toBe('sse')
  expect(stored('remote-docs', 'global')?.timeoutMs).toBeUndefined()
  expect(writes()).toEqual([{ method: 'PATCH', path: '/api/v1/mcp/servers/remote-docs', query: { path: mcpSettingsWorkspace, scope: 'global' },
    body: { name: '远端资料', description: '连接团队的资料服务。', transportType: 'sse', scope: 'global', disabledTools: [], timeoutMs: null,
      url: 'https://updated-fixture.invalid/events', headers: { Authorization: 'Bearer updated-fixture' } } }])
  const again = await edit('远端资料')
  await again.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('不应保存')
  await again.getByRole('button', { name: '取消', exact: true }).click()
  await expect(again).toBeHidden()
  expect(writes()).toHaveLength(1); expect(stored('remote-docs', 'global')?.name).toBe('远端资料')
})

test('新增服务器通过对话框保存，切换传输只发送对应连接字段', async () => {
  await openSettings('light', 760)
  await serverList().getByRole('button', { name: '新增服务器', exact: true }).click()
  const dialog = createDialog()
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'MCP id', exact: true }).fill('new-http')
  await dialog.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('新建资料服务')
  await choose(dialog, 'MCP 传输类型', 'HTTP')
  await dialog.getByRole('textbox', { name: 'MCP URL', exact: true }).fill('https://new-fixture.invalid/mcp')
  await expect(dialog.getByRole('textbox', { name: 'MCP 参数', exact: true })).toHaveCount(0)
  await advanced(dialog)
  await choose(dialog, 'MCP 服务器保存层级', '全局')
  await dialog.getByRole('textbox', { name: 'MCP 请求头', exact: true }).fill('{"X-Fixture":"new"}')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport({ ratio: 1 })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => stored('new-http', 'global')?.name).toBe('新建资料服务')
  expect(writes()).toEqual([{ method: 'POST', path: '/api/v1/mcp/servers', query: { path: mcpSettingsWorkspace },
    body: { id: 'new-http', name: '新建资料服务', description: '', transportType: 'http', scope: 'global', disabledTools: [], enabled: true,
      url: 'https://new-fixture.invalid/mcp', headers: { 'X-Fixture': 'new' } } }])
  await expect(server('新建资料服务')).toBeVisible()
})

test('连接测试展示真实工具结果，工具开关仅修改原始工具名和当前服务器', async () => {
  await openSettings()
  await server('文档检索').getByRole('button', { name: '测试', exact: true }).click()
  await expect(view().getByRole('status')).toContainText('文档检索 连接成功，发现 2 个工具')
  expect(writes()[0]).toEqual({ method: 'POST', path: '/api/v1/mcp/servers/docs-stdio/test', query: { path: mcpSettingsWorkspace, scope: 'project' }, body: null })
  const details = server('文档检索').locator('details').filter({ has: page.locator('summary').filter({ hasText: /^工具\s*2/ }) })
  await expect(details).toBeVisible()
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click()
  const read = details.getByRole('switch', { name: '读取文件 启用', exact: true })
  const report = details.getByRole('switch', { name: 'export_report 启用', exact: true })
  await expect(read).toBeChecked(); await expect(report).not.toBeChecked()
  await read.click(); await expect.poll(() => stored('docs-stdio')?.disabledTools).toEqual(['export_report', 'read_file'])
  await expect(read).not.toBeChecked()
  await report.click(); await expect.poll(() => stored('docs-stdio')?.disabledTools).toEqual(['read_file'])
  await expect(report).toBeChecked()
  expect(writes().slice(1)).toEqual([
    { method: 'PATCH', path: '/api/v1/mcp/servers/docs-stdio', query: { path: mcpSettingsWorkspace, scope: 'project' }, body: { disabledTools: ['export_report', 'read_file'] } },
    { method: 'PATCH', path: '/api/v1/mcp/servers/docs-stdio', query: { path: mcpSettingsWorkspace, scope: 'project' }, body: { disabledTools: ['read_file'] } }
  ])
  expect(stored('remote-docs', 'global')).toEqual(initialMcpSettingsServers[1])
  await shot('mcp-tools-actual-states')
})

test('失败测试不改变启用状态，服务器开关和删除仍使用精确作用域', async () => {
  await openSettings('dark', 760)
  fixture.failTestFor = 'remote-docs'
  await server('远端资料').getByRole('button', { name: '测试', exact: true }).click()
  await expect(view().getByRole('alert')).toContainText('夹具连接失败')
  await expect(server('远端资料').getByRole('switch', { name: '远端资料 启用', exact: true })).not.toBeChecked()
  expect(stored('remote-docs', 'global')?.enabled).toBe(false)
  fixture.failTestFor = null
  await server('远端资料').getByRole('switch', { name: '远端资料 启用', exact: true }).click()
  await expect.poll(() => stored('remote-docs', 'global')?.enabled).toBe(true)
  await expect(server('远端资料').getByRole('switch', { name: '远端资料 启用', exact: true })).toBeChecked()
  expect(writes().at(-1)).toEqual({ method: 'POST', path: '/api/v1/mcp/servers/remote-docs/enable', query: { path: mcpSettingsWorkspace, scope: 'global' }, body: null })
  const builtin = await actions('内置资源')
  await expect(builtin.getByRole('button', { name: '删除', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(builtin).toBeHidden()
  await (await actions('远端资料')).getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除 MCP 配置', exact: true })
  await expect(confirmation).toContainText('远端资料')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  expect(writes().filter(request => request.method === 'DELETE')).toEqual([])
  await (await actions('远端资料')).getByRole('button', { name: '删除', exact: true }).click()
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(() => stored('remote-docs', 'global')).toBeUndefined()
  await expect(server('远端资料')).toHaveCount(0)
  expect(writes().at(-1)).toEqual({ method: 'DELETE', path: '/api/v1/mcp/servers/remote-docs', query: { path: mcpSettingsWorkspace, scope: 'global' }, body: null })
  expect(stored('docs-stdio')).toEqual(initialMcpSettingsServers[0])
})
