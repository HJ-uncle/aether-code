import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'

/** D0: real main/IPC/engine ownership, authentication, metadata, and start/stop races. */
declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
let app: ElectronApplication | undefined
let page: Page
let imposter: Server
let occupiedPort: number
let fixture: string
let compatibleRemote = false
let requireRemoteToken = false
const remoteTokens: Array<string | undefined> = []
const remoteRequests: string[] = []

test.describe.serial('D0 配对运行时与身份', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'd0-host-'))
    imposter = createServer((req, res) => {
      remoteRequests.push(req.url ?? '')
      remoteTokens.push(req.headers['x-aether-instance-token'] as string | undefined)
      if (requireRemoteToken && req.url?.startsWith('/api/') && req.headers['x-aether-instance-token'] !== 'fixture-required-token') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 40100, message: 'Invalid or missing instance token' }))
        return
      }
      if (compatibleRemote) {
        const manifest = JSON.parse(readFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ code: 200, data: req.url === '/health' ? { status: 'ok' } : req.url === '/meta' ? { ...manifest, instanceId: 'compatible-remote' } : [] }))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 200, data: req.url === '/health' ? { status: 'ok' } : {
        version: 'old', buildId: 'not-this-build', protocolVersion: 999,
        toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'external-imposter'
      } }))
    })
    await new Promise<void>(done => imposter.listen(0, '127.0.0.1', done))
    occupiedPort = (imposter.address() as AddressInfo).port
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: occupiedPort, autoStartEngine: true,
      lastFolder: fixture, thinkingMode: 'off'
    }))
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
        AUTH_ENABLED: 'false', AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'synthetic-d0-remote-token', AETHER_GLOBAL_DIR: join(fixture, 'global'),
        WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
        SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
    })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.afterAll(async () => {
    await app?.close()
    await new Promise<void>(done => imposter?.close(() => done()))
    if (dirname(fixture) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('d0-host-')) throw new Error('Unsafe host fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('端口被占用也启动指定产物，所有业务接口要求实例身份', async () => {
    const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    const manifest = JSON.parse(readFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
    expect(snapshot.adopted).toBe(false)
    expect(snapshot.port).not.toBe(occupiedPort)
    expect(snapshot.entryPath).toBe(join(engineRoot, 'dist/main.js'))
    expect(snapshot.dataDir).toBe(join(fixture, 'engine/state/agent.db'))
    expect(snapshot.buildId).toBe(manifest.buildId)
    expect(snapshot.protocolVersion).toBe(1)
    expect(snapshot.instanceId).toBeTruthy()
    expect(JSON.stringify(snapshot)).not.toContain('Instance-Token')
    for (const route of ['/api/v1/tools', '/api/v1/models', '/metrics']) {
      const missing = await fetch(snapshot.baseUrl + route)
      expect(missing.status).toBe(401)
      const invalid = await fetch(snapshot.baseUrl + route, { headers: { 'X-Aether-Instance-Token': 'wrong' } })
      expect(invalid.status).toBe(401)
    }
    const tools = await page.evaluate(() => window.aether.engine.request<Array<{name:string}>>({ method: 'GET', path: '/tools', query: { pageSize: 1000 } }))
    expect(tools.ok, tools.message).toBe(true)
    expect(tools.data?.map(tool => tool.name)).toContain('read_file')
    expect(tools.data?.some(tool => /^(cron_|task_|agent_|remember$)/.test(tool.name))).toBe(false)
  })

  test('取消正在启动的引擎后不再出现迟到 ready，随后可重新启动', async () => {
    await page.evaluate(() => window.aether.engine.stop())
    const result = await page.evaluate(async () => {
      const observed: string[] = []
      const unsubscribe = window.aether.engine.onSnapshot(state => observed.push(state.phase))
      const starting = window.aether.engine.start()
      const stopped = await window.aether.engine.stop()
      const cut = observed.length
      await starting
      const settled = await window.aether.engine.getSnapshot()
      unsubscribe()
      return { stopped, settled, afterStop: observed.slice(cut) }
    })
    expect(result.stopped.phase).toBe('idle')
    expect(result.settled.phase).toBe('idle')
    expect(result.afterStop).not.toContain('ready')
    const restarted = await page.evaluate(() => window.aether.engine.start())
    expect(restarted.phase, restarted.error ?? '').toBe('ready')
  })

  test('remote 的 HTTP200 不足以就绪，协议不匹配会清楚失败', async () => {
    await page.evaluate(async (url) => {
      await window.aether.engine.stop()
      await window.aether.settings.update({ engineMode: 'remote', remoteBaseUrl: url })
    }, `http://127.0.0.1:${occupiedPort}`)
    const failed = await page.evaluate(() => window.aether.engine.start())
    expect(failed.phase).toBe('error')
    expect(failed.error).toMatch(/协议|protocol|不兼容|令牌|token/i)
    const response = await fetch(`http://127.0.0.1:${occupiedPort}/health`)
    expect(response.status).toBe(200)
  })
  test('本机手动连接不强制预设token，但仍验证业务认证与协议', async () => {
    compatibleRemote = true
    await app!.evaluate(() => { delete process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN })
    await page.evaluate(() => window.aether.engine.stop())
    const before = remoteRequests.length
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    expect(remoteRequests.slice(before)).toContain('/api/v1/tools')
    expect(remoteTokens.slice(before).every(token => token === undefined)).toBe(true)
  })

  test('本机引擎启用token时不绕过认证，配置匹配凭据后才就绪', async () => {
    requireRemoteToken = true
    await page.evaluate(() => window.aether.engine.stop())
    const failed = await page.evaluate(() => window.aether.engine.start())
    expect(failed.phase).toBe('error')
    expect(failed.error).toContain('AETHER_IDE_REMOTE_INSTANCE_TOKEN')
    await app!.evaluate(() => { process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = 'fixture-required-token' })
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    expect(remoteTokens.at(-1)).toBe('fixture-required-token')
    expect(JSON.stringify(started)).not.toContain('fixture-required-token')
    requireRemoteToken = false
  })

  test('remote 正确握手后也明确拒绝无工作区映射的本地文件和聊天请求', async () => {
    compatibleRemote = true
    await page.evaluate(() => window.aether.engine.stop())
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    const before = remoteRequests.length
    const result = await page.evaluate(async () => {
      const response = await window.aether.engine.request({ method: 'POST', path: '/workspace/file', body: { path: 'C:/local-only/project.ts', content: 'changed' } })
      const events: Array<{ type: string; message?: string }> = []
      const unsubscribe = window.aether.engine.onStreamEvent(event => {
        if (event.streamId === 'remote-refused') events.push(event)
      })
      await window.aether.engine.stream.start({ streamId: 'remote-refused', path: '/chat', body: { sessionId: 'remote-test', message: 'change file', workspacePaths: ['C:/local-only'] } })
      unsubscribe()
      return { response, events }
    })
    expect(result.response.ok).toBe(false)
    expect(result.response.message).toContain('工作区映射')
    expect(result.events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('工作区映射') })])
    expect(remoteRequests.slice(before).some(path => path.includes('/workspace') || path.includes('/chat'))).toBe(false)
  })

})
