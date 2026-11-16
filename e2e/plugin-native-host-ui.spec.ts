/** Real Electron main/preload boundary, permission revocation and close-to-tray.
 * The engine is an isolated HTTP authority fixture; native dialogs are intercepted
 * only after IPC reaches Electron so tests never need human input or OS notifications. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

const root = resolve(__dirname, '..'), temporary = join(root, '.e2e-tmp/plugin-native-host')
const token = 'native-host-test', errors: string[] = [], authorizations: Record<string, unknown>[] = []
let app: ElectronApplication | undefined, page: Page, profile = '', origin = '', granted = true, background = false
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://localhost'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Fixture authentication missing')
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (path === '/api/v1/plugins/native-example/capabilities/invoke') {
    authorizations.push(body)
    if (!granted || body.expectedRevision !== 3 || body.method !== 'host.authorize' || !['ui.dialogs', 'ui.clipboard', 'ui.notifications'].includes(String(body.capability))) {
      response.writeHead(403).end(JSON.stringify({ code: 403, message: 'Permission denied' })); return
    }
    response.end(envelope({ result: { authorized: true } })); return
  }
  if (path === '/api/v1/plugins/runtime/background') { response.end(envelope({ enabled: background, running: 0, tasks: background ? [{ id: 'timer', pluginId: 'native-example' }] : [] })); return }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: '/native-host', bindingEpoch: 'test' })); return }
  if (['/api/v1/workbench/clients','/api/v1/browser/clients','/api/v1/browser/hosts','/api/v1/terminal/create','/api/v1/lsp/request','/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general','code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: 'test', modelId: 'test', provider: 'openai', displayName: '测试模型', isEnabled: true }]
    : path === '/api/v1/plugins' ? { plugins: [] }
    : path === '/api/v1/toolkits' ? { toolkits: [] }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: url.searchParams.get('sessionId'), source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1,2], views: ['legacy','summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/workspace/directory' ? { root: '/native-host', entries: [], bindingEpoch: 'test' }
    : path === '/api/v1/skills' ? { list: [] } : path === '/api/v1/chat/runs' ? { runs: [] } : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

test.describe.serial('插件原生系统桥与后台驻留', () => {
  test.beforeAll(async () => {
    mkdirSync(temporary, { recursive: true }); profile = mkdtempSync(join(temporary, 'profile-'))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: '/native-host', lastModelId: 'test', appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).flatMap(([key,value]) => value === undefined ? [] : [[key,value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AETHER_IDE_REMOTE_API_KEY','AETHER_IDE_REMOTE_BEARER_TOKEN','AETHER_IDE_REMOTE_AUTH_URL','AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(profile, 'global')
    app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.afterAll(async () => {
    await app?.close(); await new Promise<void>(done => server.close(() => done()))
    const rel = relative(temporary, profile)
    if (profile && rel && rel !== '..' && !rel.startsWith('..\\') && !isAbsolute(rel)) rmSync(profile, { recursive: true, force: true })
    expect(errors).toEqual([])
  })
  test('原生弹窗经主进程重新校验授权和当前修订', async () => {
    await app!.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const input = args[args.length - 1] as { title: string; buttons: string[] }
        if (input.title !== 'native-example · 测试' || input.buttons.join(',') !== '继续,取消') throw new Error('Native dialog options mismatch')
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const result = await page.evaluate(() => window.aether.pluginHost.dialog({ pluginId: 'native-example', revision: 3 }, { title: '测试', message: '原生 IPC', kind: 'question', buttons: ['继续','取消'] }))
    expect(result).toEqual({ response: 1, canceled: true })
    expect(authorizations.at(-1)).toEqual({ capability: 'ui.dialogs', method: 'host.authorize', args: {}, expectedRevision: 3 })
    granted = false
    const rejected = await page.evaluate(() => window.aether.pluginHost.dialog({ pluginId: 'native-example', revision: 3 }, { title: '测试', message: '权限撤销' }).then(() => '', error => String(error.message)))
    expect(rejected).toContain('尚未获得')
    granted = true
    const stale = await page.evaluate(() => window.aether.pluginHost.dialog({ pluginId: 'native-example', revision: 2 }, { title: '测试', message: '旧版本' }).then(() => '', error => String(error.message)))
    expect(stale).toContain('当前版本已经失效')
  })
  test('剪贴板具名操作与大文本经过真实 IPC 完整往返', async () => {
    // Use Electron's boundary with an isolated clipboard implementation; do not overwrite the user's clipboard.
    await app!.evaluate(({ clipboard }) => { let content = ''; clipboard.writeText = text => { content = text }; clipboard.readText = () => content })
    expect(await page.evaluate(() => window.aether.pluginHost.clipboard({ pluginId: 'native-example', revision: 3 }, { action: 'write', text: '中文 🍎' }))).toEqual({ written: true })
    expect(await page.evaluate(() => window.aether.pluginHost.clipboard({ pluginId: 'native-example', revision: 3 }, { action: 'read' }))).toEqual({ text: '中文 🍎' })
    const large = await page.evaluate(async () => {
      const text = '中'.repeat(1024 * 1024 + 1), identity = { pluginId: 'native-example', revision: 3 }
      await window.aether.pluginHost.clipboard(identity, { action: 'write', text })
      const result = await window.aether.pluginHost.clipboard(identity, { action: 'read' })
      return result.text === text
    })
    expect(large).toBe(true)
  })
  test('已授权后台任务关闭窗口后驻留，重新显示仍能使用', async () => {
    background = true
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return win ? { destroyed: win.isDestroyed(), visible: win.isVisible() } : null })).toEqual({ destroyed: false, visible: false })
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    background = false
  })
})
