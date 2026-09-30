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
let requiredRemoteToken = 'fixture-required-token'
const remoteTokens: Array<string | undefined> = []
const remoteRequests: string[] = []
const remoteChatBodies: Array<Record<string, unknown>> = []

test.describe.serial('D0 配对运行时与身份', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'd0-host-'))
    imposter = createServer(async (req, res) => {
      remoteRequests.push(req.url ?? '')
      remoteTokens.push(req.headers['x-aether-instance-token'] as string | undefined)
      if (requireRemoteToken && req.url?.startsWith('/api/') && req.headers['x-aether-instance-token'] !== requiredRemoteToken) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 40100, message: 'Invalid or missing instance token' }))
        return
      }
      if (compatibleRemote) {
        if (req.method === 'POST' && req.url === '/api/v1/chat') {
          let raw = ''
          for await (const chunk of req) raw += chunk.toString()
          remoteChatBodies.push(JSON.parse(raw) as Record<string, unknown>)
          if (req.headers.accept === 'application/json') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ code: 200, data: { accepted: true } }))
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end('id: remote-host:1\ndata: {"content":"remote fixture reply"}\n\nevent: done\nid: remote-host:2\ndata: [DONE]\n\n')
          return
        }
        if (req.url?.startsWith('/api/v1/chat/runs')) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ code: 200, data: { runs: [] } }))
          return
        }
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

  test('远端令牌可从设置加密保存，且不进入普通设置、快照或页面文本', async () => {
    compatibleRemote = true
    requireRemoteToken = true
    requiredRemoteToken = 'fixture-secure-token'
    await app!.evaluate(() => { delete process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN })
    await page.evaluate(async (url) => {
      await window.aether.engine.stop()
      await window.aether.settings.update({ engineMode: 'remote', remoteBaseUrl: url })
      await window.aether.settings.setRemoteToken('fixture-secure-token')
    }, `http://127.0.0.1:${occupiedPort}`)
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    expect(remoteTokens.at(-1)).toBe('fixture-secure-token')
    const settingsFile = readFileSync(join(fixture, 'settings.json'), 'utf8')
    const tokenFile = readFileSync(join(fixture, 'engine', 'secrets', 'remote-instance-token.json'), 'utf8')
    expect(settingsFile).not.toContain('fixture-secure-token')
    expect(tokenFile).not.toContain('fixture-secure-token')
    expect(tokenFile).toContain('"encrypted":true')
    expect(JSON.stringify(await page.evaluate(() => window.aether.engine.getSnapshot()))).not.toContain('fixture-secure-token')
    expect(await page.evaluate(() => document.body.textContent ?? '')).not.toContain('fixture-secure-token')

    const cleared = await page.evaluate(() => window.aether.settings.clearRemoteToken())
    expect(cleared.configured).toBe(false)
    await page.evaluate(() => window.aether.engine.stop())
    const refused = await page.evaluate(() => window.aether.engine.start())
    expect(refused.phase).toBe('error')
    expect(refused.error).toContain('远端令牌')
    requireRemoteToken = false
    requiredRemoteToken = 'fixture-required-token'
    await app!.evaluate(() => { process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = 'fixture-required-token' })
  })

  test('remote 会话经过真实 SSE 返回，主进程隔离本地路径并拒绝文件接口', async () => {
    compatibleRemote = true
    await page.evaluate(async () => {
      await window.aether.engine.stop()
      await window.aether.settings.update({ remoteWorkspaceRoot: '' })
    })
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    const before = remoteRequests.length
    const chatBefore = remoteChatBodies.length
    const result = await page.evaluate(async () => {
      const response = await window.aether.engine.request({ method: 'POST', path: '/workspace/file', body: { path: 'C:/local-only/project.ts', content: 'changed' } })
      const events: Array<{ type: string; payload?: unknown; message?: string }> = []
      let finish: () => void = () => {}
      let terminalTimer = 0
      const terminal = new Promise<void>((resolve, reject) => {
        finish = resolve
        terminalTimer = window.setTimeout(() => reject(new Error('Terminal stream event was not delivered')), 10000)
      })
      const unsubscribe = window.aether.engine.onStreamEvent(event => {
        if (event.streamId === 'remote-chat-allowed') {
          events.push(event)
          if (event.type === 'done' || event.type === 'error') finish()
        }
      })
      try {
        await Promise.all([terminal, window.aether.engine.stream.start({
          streamId: 'remote-chat-allowed', path: '/chat', body: {
            sessionId: 'remote-test', message: 'remote task', workspacePaths: ['C:/local-only'],
            attachments: [{ name: 'C:/local-only/private.txt' }], context: 'local document contents'
          }
        })])
      } finally { window.clearTimeout(terminalTimer); unsubscribe() }
      return { response, events }
    })
    expect(result.response.ok).toBe(false)
    expect(result.response.message).toContain('工作区')
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'payload', payload: { content: 'remote fixture reply' } }))
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'done' }))
    expect(result.events.some(event => event.type === 'error')).toBe(false)
    expect(remoteChatBodies.slice(chatBefore)).toEqual([{
      sessionId: 'remote-test', message: 'remote task', workspacePaths: []
    }])
    expect(remoteRequests.slice(before)).toContain('/api/v1/chat')
    expect(remoteRequests.slice(before).some(path => path.startsWith('/api/v1/workspace'))).toBe(false)
  })

  test('连接身份已经变化时普通请求与 SSE 都在主进程拒绝，不发送远端 HTTP', async () => {
    const before = remoteRequests.length
    const result = await page.evaluate(async () => {
      const current = await window.aether.engine.getSnapshot()
      const expectedEngine = { mode: current.mode, baseUrl: current.baseUrl, instanceId: 'previous-engine-instance' }
      const body = { sessionId: 'stale-identity-request', message: 'must not reach server' }
      const response = await window.aether.engine.request({ method: 'POST', path: '/chat', body, expectedEngine })
      const events: Array<{ type: string; message?: string }> = []
      let finish: () => void = () => {}
      let terminalTimer = 0
      const terminal = new Promise<void>((resolve, reject) => {
        finish = resolve
        terminalTimer = window.setTimeout(() => reject(new Error('Terminal stream event was not delivered')), 10000)
      })
      const unsubscribe = window.aether.engine.onStreamEvent(event => {
        if (event.streamId === 'stale-identity-stream') {
          events.push(event)
          if (event.type === 'done' || event.type === 'error') finish()
        }
      })
      try {
        await Promise.all([terminal, window.aether.engine.stream.start({ streamId: 'stale-identity-stream', path: '/chat', body, expectedEngine })])
      } finally { window.clearTimeout(terminalTimer); unsubscribe() }
      return { response, events }
    })
    expect(result.response.ok).toBe(false)
    expect(result.response.code).toBe(409)
    expect(result.response.message).toMatch(/变化|切换|连接/)
    expect(result.events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringMatching(/变化|切换|连接/) })])
    expect(remoteRequests.slice(before).filter(path => path === '/api/v1/chat' || path.includes('stale-identity-request'))).toEqual([])
  })

  test('远端目录与连接一起固定：保存B不改变A，重连和自动启动才使用B目录', async () => {
    const rootA = '/srv/fixture-a'
    const rootB = '/srv/fixture-b'
    const urlA = `http://127.0.0.1:${occupiedPort}`
    const secondBodies: Array<Record<string, unknown>> = []
    const second = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/chat') {
        let raw = ''
        for await (const chunk of req) raw += chunk.toString()
        secondBodies.push(JSON.parse(raw) as Record<string, unknown>)
        if (req.headers.accept === 'application/json') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 200, data: { accepted: true } }))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end('id: workspace-b:1\ndata: {"content":"remote fixture reply"}\n\nevent: done\nid: workspace-b:2\ndata: [DONE]\n\n')
        }
        return
      }
      const manifest = JSON.parse(readFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
      const data = req.url === '/health' ? { status: 'ok' }
        : req.url === '/meta' ? { ...manifest, instanceId: 'workspace-remote-b' }
        : req.url?.startsWith('/api/v1/chat/runs') ? { runs: [] } : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data }))
    })
    await new Promise<void>(done => second.listen(0, '127.0.0.1', done))
    const urlB = `http://127.0.0.1:${(second.address() as AddressInfo).port}`
    const sendBoth = async (tag: string): Promise<void> => {
      const result = await page.evaluate(async (name) => {
        const expectedEngine = await window.aether.engine.getSnapshot()
        const response = await window.aether.engine.request({
          method: 'POST', path: '/chat', expectedEngine,
          body: { sessionId: name + '-http', message: 'fixture plain chat' }
        })
        const errors: string[] = []
        const streamId = name + '-sse'
        const off = window.aether.engine.onStreamEvent(event => {
          if (event.streamId === streamId && event.type === 'error') errors.push(event.message)
        })
        try {
          await window.aether.engine.stream.start({
            streamId, path: '/chat', expectedEngine,
            body: { sessionId: name + '-sse', message: 'fixture streaming chat' }
          })
        } finally { off() }
        return { response, errors }
      }, tag)
      expect(result.response.ok, result.response.message).toBe(true)
      expect(result.errors).toEqual([])
    }
    try {
      compatibleRemote = true
      requireRemoteToken = false
      await page.evaluate(async ({ url, root }) => {
        await window.aether.settings.update({ engineMode: 'remote', remoteBaseUrl: url, remoteWorkspaceRoot: root, autoStartEngine: true })
        await window.aether.engine.restart()
      }, { url: urlA, root: rootA })

      // Calling start on the same ready connection must not silently apply a saved root.
      await page.evaluate(async () => {
        await window.aether.settings.update({ remoteWorkspaceRoot: '/srv/saved-only-a' })
        await window.aether.engine.start()
      })
      let before = remoteChatBodies.length
      await sendBoth('workspace-same-ready')
      expect(remoteChatBodies.slice(before).map(body => body.workspacePaths)).toEqual([[rootA], [rootA]])

      await page.evaluate(({ url, root }) => window.aether.settings.update({
        remoteBaseUrl: url, remoteWorkspaceRoot: root
      }), { url: urlB, root: rootB })
      expect((await page.evaluate(() => window.aether.engine.getSnapshot())).baseUrl).toBe(urlA)
      before = remoteChatBodies.length
      await sendBoth('workspace-saved-b')
      expect(remoteChatBodies.slice(before).map(body => body.workspacePaths)).toEqual([[rootA], [rootA]])
      expect(secondBodies).toEqual([])

      const connected = await page.evaluate(() => window.aether.engine.restart())
      expect(connected.phase, connected.error ?? '').toBe('ready')
      expect(connected.baseUrl).toBe(urlB)
      await sendBoth('workspace-reconnected-b')
      expect(secondBodies.map(body => body.workspacePaths)).toEqual([[rootB], [rootB]])

      // The application boot entry point must capture the same root as explicit start/restart.
      await app!.close()
      app = undefined
      app = await electron.launch({
        args: ['.', `--user-data-dir=${fixture}`], cwd: root,
        env: { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js') }
      })
      page = await app.firstWindow()
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
      expect((await page.evaluate(() => window.aether.engine.getSnapshot())).baseUrl).toBe(urlB)
      await sendBoth('workspace-boot-b')
      expect(secondBodies.slice(2).map(body => body.workspacePaths)).toEqual([[rootB], [rootB]])
    } finally {
      try {
        if (app) await page.evaluate(async (url) => {
          await window.aether.settings.update({ remoteBaseUrl: url, remoteWorkspaceRoot: '' })
          await window.aether.engine.restart()
        }, urlA)
      } finally {
        second.closeAllConnections()
        await new Promise<void>(done => second.close(() => done()))
      }
    }
  })

})
