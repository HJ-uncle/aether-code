/** Real Electron interaction against an isolated authenticated engine fixture.
 * Covers per-plugin grants, subset-safe bulk changes, one-click all permissions,
 * unavailable capabilities, old grants, and partial failures. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { PluginPermissionRecord } from '../src/renderer/src/core/engine/plugin-permissions'
import { newPlugin } from './fixtures/plugin'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-permissions-bulk-20261113')
const token = 'plugin-permission-fixture-token', modelId = 'permission-fixture-model', port = 12547, origin = `http://127.0.0.1:${port}`
const source = engineStorageKey({ mode: 'remote', baseUrl: origin }), stateKey = sessionStorageKey('aether.work.state.v1', source)
const plugins = new Map<string, PluginPermissionRecord>(), updates: Array<{ id: string; grants: string[]; revision: number }> = [], errors: string[] = []
const toolUpdates: Array<{ id: string; disabledTools: string[]; expectedRevision: number }> = []
const capabilities = [
  { id: 'skills.read', title: '读取本地 Skills', description: '列出当前可用技能并读取说明。', category: 'skills', access: 'read', defaultGranted: false, bridge: ['list_skills'] },
  { id: 'workspace.read', title: '读取工作区', description: '读取当前工作区的文件。', category: 'workspace', access: 'read', defaultGranted: false, bridge: ['read_file'] },
  { id: 'workspace.write', title: '写入工作区', description: '尚未开放的接口，不得新增授权。', category: 'workspace', access: 'write', defaultGranted: false, bridge: ['write_file'], available: false },
]
let app: ElectronApplication | undefined, page: Page, fixture = '', failure = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function seedPlugin(id: string, name: string, requested: string[], grants: string[] = []): void {
  const base = newPlugin(), manifest = { ...base.manifest, id, name, permissions: { requested } }
  plugins.set(id, { ...base, id, name, manifest, permissionGrants: grants, permissionRevision: 2, description: '权限管理测试', enabled: false, revision: 2,
    revisions: [{ revision: 2, hash: `sha256:${id}`, createdAt: 1 }], createdAt: 1, updatedAt: 1 })
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Missing fixture authentication')
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (path === '/api/v1/plugins/project/capabilities') { response.end(envelope({ catalogue: { capabilities } })); return }
  const agentTools = /^\/api\/v1\/plugins\/([^/]+)\/agent-tools$/.exec(path)
  if (agentTools) {
    const plugin = plugins.get(agentTools[1])!
    if (request.method === 'GET') {
      response.end(envelope({ tools: ['read_file', 'write_file', 'execute_cmd'].map(name => ({ name, description: `平台工具 ${name}`, parameters: { type: 'object' }, source: 'builtin', enabled: !plugin.agentDisabledTools?.includes(name), available: true })) })); return
    }
    if (request.method === 'PUT') {
      if (body.expectedRevision !== plugin.revision || !Array.isArray(body.disabledTools)) throw new Error('Invalid agent tool update')
      toolUpdates.push({ id: plugin.id, disabledTools: body.disabledTools as string[], expectedRevision: Number(body.expectedRevision) })
      const next = { ...plugin, agentDisabledTools: body.disabledTools as string[] }; plugins.set(plugin.id, next)
      response.end(envelope({ plugin: next })); return
    }
    throw new Error('Invalid Agent tool method')
  }
  const permissions = /^\/api\/v1\/plugins\/([^/]+)\/permissions$/.exec(path)
  if (permissions && request.method === 'PUT') {
    const plugin = plugins.get(permissions[1])!, grants = body.grants as string[]
    updates.push({ id: plugin.id, grants, revision: Number(body.expectedRevision) })
    if (plugin.id === failure) { response.writeHead(409).end(JSON.stringify({ code: 40900, message: '插件版本已变化，请刷新后重试。' })); return }
    if (body.expectedRevision !== plugin.revision || grants.some(id => !plugin.manifest.permissions?.requested.includes(id))) throw new Error('Invalid permission update')
    const next = { ...plugin, permissionGrants: grants, permissionRevision: plugin.revision }; plugins.set(plugin.id, next)
    response.end(envelope({ plugin: next })); return
  }
  const plugin = /^\/api\/v1\/plugins(?:\/([^/]+))?$/.exec(path)
  if (plugin && request.method === 'GET') { response.end(envelope(plugin[1] ? { plugin: plugins.get(plugin[1]) } : { plugins: [...plugins.values()] })); return }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: body.workspaceRoot, bindingEpoch: 'permissions' })); return }
  if (['/api/v1/workbench/clients','/api/v1/browser/clients','/api/v1/terminal/create','/api/v1/lsp/request','/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general','code'], subagentSchemaVersion: 1, instanceId: 'permission-ui' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '权限测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/toolkits' ? { toolkits: [] }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: url.searchParams.get('sessionId'), source: 'persisted', eventId: null, finished: true, history: [], projection: [], run: null, runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: null, lastEventId: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1,2], views: ['legacy','summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/workspace/directory' ? { root: '/permissions-ui', entries: [], bindingEpoch: 'permissions' }
    : path === '/api/v1/skills' ? { list: [] } : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })
const manager = (): ReturnType<Page['getByRole']> => page.getByRole('region', { name: '插件管理', exact: true })
async function captureAllPermissions(info: TestInfo): Promise<void> {
  try {
    for (const [appearance, width, height] of [['light', 1320, 900], ['dark', 1320, 900], ['dark', 860, 760]] as const) {
      await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height] as [number, number])
      await page.evaluate(async value => {
        document.documentElement.dataset.appearance = value
        for (let pass = 0; pass < 5; pass++) {
          await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
          const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime))
          if (!animations.length) return
          await Promise.allSettled(animations.map(animation => animation.finished))
        }
      }, appearance)
      const section = manager().getByRole('region', { name: '插件权限', exact: true })
      await expect(section.getByRole('button', { name: '开启全部权限', exact: true })).toBeVisible()
      await expect(section.getByRole('button', { name: '关闭全部权限', exact: true })).toBeVisible()
      expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(await manager().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath(`permissions-all-${appearance}-${width}.png`), animations: 'disabled' })
    }
  } finally {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
  }
}
test.describe.serial('插件权限管理', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: '/permissions-ui', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).flatMap(([key,value]) => value === undefined ? [] : [[key,value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AETHER_IDE_REMOTE_API_KEY','AETHER_IDE_REMOTE_BEARER_TOKEN','AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    plugins.clear(); updates.length = 0; toolUpdates.length = 0; failure = ''
    seedPlugin('alpha', '会话整理', ['skills.read','workspace.read'], ['workspace.read'])
    seedPlugin('beta', '资料检索', ['skills.read'])
    seedPlugin('gamma', '独立工具', [])
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
      localStorage.setItem('aether.app.mode', 'work'); localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, stateKey)
    await page.reload(); await expect(manager().getByRole('button', { name: '编辑插件 会话整理', exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => { if (!page.isClosed()) await page.screenshot({ path: info.outputPath('plugin-permissions.png') }); expect(errors).toEqual([]) })
  test.afterAll(async () => { try { await app?.close() } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); if (fixture) { if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe permission profile cleanup'); rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } } })

  test('单个插件权限开关保存回执，并保留其他已授予权限', async () => {
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    const skill = manager().getByRole('switch', { name: '允许读取本地 Skills', exact: true })
    await expect(skill).toHaveAttribute('aria-checked', 'false'); await skill.click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual(['workspace.read','skills.read'])
    await expect(skill).toHaveAttribute('aria-checked', 'true'); await skill.click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual(['workspace.read'])
    expect(updates).toEqual([{ id: 'alpha', grants: ['workspace.read','skills.read'], revision: 2 }, { id: 'alpha', grants: ['workspace.read'], revision: 2 }])
    await manager().getByRole('tab', { name: '概览', exact: true }).click()
    await manager().getByLabel('名称', { exact: true }).fill('尚未保存的修改')
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await expect(skill).toBeDisabled()
  })

  test('单插件 Agent 工具支持搜索、保存禁用和刷新恢复，保留目录外的已禁用工具', async ({}, info) => {
    const plugin = plugins.get('alpha')!; plugin.agentDisabledTools = ['legacy_tool']
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await manager().locator('summary').filter({ hasText: /^Agent 工具$/ }).click()
    const tools = manager().getByRole('region', { name: 'Agent 工具', exact: true })
    await expect(tools.getByRole('switch')).toHaveCount(3)
    await tools.getByRole('searchbox', { name: '搜索 Agent 工具', exact: true }).fill('execute')
    await expect(tools.getByRole('searchbox', { name: '搜索 Agent 工具', exact: true })).toHaveCSS('box-shadow', 'none')
    await expect(tools.getByRole('switch')).toHaveCount(1)
    const command = tools.getByRole('switch', { name: '允许 Agent 工具 execute_cmd', exact: true })
    await command.click()
    await expect.poll(() => plugins.get('alpha')?.agentDisabledTools).toEqual(['legacy_tool', 'execute_cmd'])
    await expect(command).toHaveAttribute('aria-checked', 'false')
    await tools.getByRole('button', { name: '刷新 Agent 工具', exact: true }).click()
    await expect(command).toHaveAttribute('aria-checked', 'false')
    await tools.getByRole('searchbox').fill('')
    await expect(tools.getByRole('switch', { name: '允许 Agent 工具 read_file', exact: true })).toHaveAttribute('aria-checked', 'true')
    expect(toolUpdates).toEqual([{ id: 'alpha', disabledTools: ['legacy_tool', 'execute_cmd'], expectedRevision: 2 }])
    expect(updates).toEqual([]); expect(plugins.get('beta')?.agentDisabledTools).toBeUndefined()
    await page.screenshot({ path: info.outputPath('agent-tools.png'), animations: 'disabled' })
    await command.click()
    await expect.poll(() => plugins.get('alpha')?.agentDisabledTools).toEqual(['legacy_tool'])
  })

  test('批量授权只修改已选择且已声明的插件，部分失败可以重试', async () => {
    failure = 'beta'
    await manager().getByRole('button', { name: '权限管理', exact: true }).click()
    await manager().getByRole('checkbox', { name: '选择当前列表全部插件', exact: true }).check()
    const skill = manager().getByRole('switch', { name: '批量允许读取本地 Skills', exact: true })
    await skill.click()
    await expect(manager().getByRole('alert')).toContainText('资料检索：插件版本已变化')
    expect(plugins.get('alpha')?.permissionGrants).toEqual(['workspace.read','skills.read'])
    expect(plugins.get('beta')?.permissionGrants).toEqual([])
    expect(plugins.get('gamma')?.permissionGrants).toEqual([])
    expect(updates.map(item => item.id)).toEqual(['alpha','beta'])
    failure = ''; await skill.click()
    await expect.poll(() => plugins.get('beta')?.permissionGrants).toEqual(['skills.read'])
    await expect(skill).toHaveAttribute('aria-checked', 'true')
    expect(updates.map(item => item.id)).toEqual(['alpha','beta','beta'])
    await skill.click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual(['workspace.read'])
    await expect.poll(() => plugins.get('beta')?.permissionGrants).toEqual([])
    expect(updates.some(item => item.id === 'gamma')).toBe(false)
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
  })

  test('新草稿不显示旧版授权为已开启，并可撤销仍在运行的旧版授权', async () => {
    const previous = plugins.get('alpha')!
    plugins.set(previous.id, { ...previous, revision: 3, publishedRevision: 2, enabled: true, permissionRevision: 2 })
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await expect(manager().getByRole('switch', { name: '允许读取工作区', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(manager().getByRole('region', { name: '插件权限', exact: true })).toContainText('管理草稿 r3 · 已发布 r2 · 已启用')
    await manager().getByRole('button', { name: '撤销旧版本授权', exact: true }).click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual([])
    expect(plugins.get('alpha')?.permissionRevision).toBe(3)
    expect(updates).toEqual([{ id: 'alpha', grants: [], revision: 3 }])
    await expect(manager().getByRole('button', { name: '撤销旧版本授权', exact: true })).toHaveCount(0)
  })

  test('一键开启与关闭单插件权限各保存一次，未保存草稿禁用操作', async ({}, info) => {
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    const enableAll = manager().getByRole('button', { name: '开启全部权限', exact: true })
    const disableAll = manager().getByRole('button', { name: '关闭全部权限', exact: true })
    await expect(enableAll).toHaveText('全部开启'); await expect(disableAll).toHaveText('全部关闭')
    await captureAllPermissions(info)
    await enableAll.click()
    await expect.poll(() => [...plugins.get('alpha')!.permissionGrants!].sort()).toEqual(['skills.read', 'workspace.read'])
    await expect(manager().getByRole('switch', { name: '允许读取本地 Skills', exact: true })).toHaveAttribute('aria-checked', 'true')
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('alpha'); expect([...updates[0].grants].sort()).toEqual(['skills.read', 'workspace.read']); expect(updates[0].revision).toBe(2)
    await disableAll.click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual([])
    await expect(manager().getByRole('switch', { name: '允许读取工作区', exact: true })).toHaveAttribute('aria-checked', 'false')
    expect(updates).toHaveLength(2); expect(updates[1]).toEqual({ id: 'alpha', grants: [], revision: 2 })
    expect(plugins.get('beta')?.permissionGrants).toEqual([])
    await manager().getByRole('tab', { name: '概览', exact: true }).click()
    await manager().getByLabel('名称', { exact: true }).fill('未保存权限草稿')
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await expect(enableAll).toBeDisabled(); await expect(disableAll).toBeDisabled()
    expect(updates).toHaveLength(2)
  })

  test('一键批量授权仅修改所选插件，每个一次且部分失败只重试未完成项', async () => {
    failure = 'beta'
    seedPlugin('delta', '未选的授权工具', ['skills.read', 'workspace.read'], ['workspace.read'])
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '权限管理', exact: true }).click()
    await manager().getByRole('checkbox', { name: '选择插件 会话整理', exact: true }).check()
    await manager().getByRole('checkbox', { name: '选择插件 资料检索', exact: true }).check()
    const section = manager().getByRole('region', { name: '批量插件权限', exact: true })
    const enableAll = section.getByRole('button', { name: '开启全部权限', exact: true })
    await enableAll.click()
    await expect(section.getByRole('alert')).toContainText('资料检索：插件版本已变化')
    expect([...plugins.get('alpha')!.permissionGrants!].sort()).toEqual(['skills.read', 'workspace.read'])
    expect(plugins.get('beta')?.permissionGrants).toEqual([])
    expect(updates.map(item => item.id)).toEqual(['alpha', 'beta'])
    failure = ''; await enableAll.click()
    await expect.poll(() => plugins.get('beta')?.permissionGrants).toEqual(['skills.read'])
    await expect(section.getByRole('alert')).toHaveCount(0)
    expect(updates.map(item => item.id)).toEqual(['alpha', 'beta', 'beta'])
    await section.getByRole('button', { name: '关闭全部权限', exact: true }).click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual([])
    await expect.poll(() => plugins.get('beta')?.permissionGrants).toEqual([])
    expect(updates.map(item => item.id)).toEqual(['alpha', 'beta', 'beta', 'alpha', 'beta'])
    expect(plugins.get('gamma')?.permissionGrants).toEqual([])
    expect(plugins.get('delta')?.permissionGrants).toEqual(['workspace.read'])
    expect(updates.some(item => item.id === 'gamma' || item.id === 'delta')).toBe(false)
    expect(updates.every(item => item.revision === 2)).toBe(true)
  })

  test('一键开启不新增未知或未开放权限，并保留已有此类授权供全部关闭撤销', async () => {
    const requested = ['skills.read', 'workspace.read', 'workspace.write', 'future.custom']
    seedPlugin('alpha', '会话整理', requested)
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await manager().getByRole('button', { name: '开启全部权限', exact: true }).click()
    await expect.poll(() => [...plugins.get('alpha')!.permissionGrants!].sort()).toEqual(['skills.read', 'workspace.read'])
    expect(updates).toHaveLength(1)
    await expect(manager().getByRole('switch', { name: '允许写入工作区', exact: true })).toBeDisabled()
    await manager().getByRole('button', { name: '返回插件列表', exact: true }).click()
    seedPlugin('alpha', '会话整理', requested, ['workspace.write', 'future.custom'])
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await manager().getByRole('button', { name: '开启全部权限', exact: true }).click()
    await expect.poll(() => [...plugins.get('alpha')!.permissionGrants!].sort()).toEqual([...requested].sort())
    expect(updates).toHaveLength(2)
    await manager().getByRole('button', { name: '关闭全部权限', exact: true }).click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual([])
    expect(updates).toHaveLength(3); expect(updates[2]).toEqual({ id: 'alpha', grants: [], revision: 2 })
  })

  test('一键全部关闭可直接撤销仍属旧版本的权限', async () => {
    const previous = plugins.get('alpha')!
    plugins.set(previous.id, { ...previous, revision: 3, publishedRevision: 2, enabled: true, permissionRevision: 2 })
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '编辑插件 会话整理', exact: true }).click()
    await manager().getByRole('tab', { name: '权限', exact: true }).click()
    await expect(manager().getByRole('switch', { name: '允许读取工作区', exact: true })).toHaveAttribute('aria-checked', 'false')
    await manager().getByRole('button', { name: '关闭全部权限', exact: true }).click()
    await expect.poll(() => plugins.get('alpha')?.permissionGrants).toEqual([])
    expect(plugins.get('alpha')?.permissionRevision).toBe(3)
    expect(updates).toEqual([{ id: 'alpha', grants: [], revision: 3 }])
    await expect(manager().getByRole('button', { name: '撤销旧版本授权', exact: true })).toHaveCount(0)
  })
})
