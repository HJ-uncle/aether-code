/** Fresh regression for the 2026-10-23 dual-mode campaign: a blocked history
 * read must cancel its actual transport without killing the engine or replaying
 * mutations. Includes real Electron preload → IPC → HTTP verification. */
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { engineTransportFailure } from '../src/main/engine/request-error'
import { managementRequestTimeout } from '../src/main/engine/request-timeout'

test('observation timeout and transport messages preserve unknown mutation outcomes', () => {
  for (const path of ['/chat/snapshot', '/api/v1/chat/snapshot', '/chat/snapshot?sessionId=a',
    '/conversations/turn-id', '/api/v1/conversations/turn-id?current=1&pageSize=8']) {
    expect(managementRequestTimeout({ method: 'GET', path, timeoutMs: 0 })).toBe(15000)
  }
  expect(managementRequestTimeout({ method: 'POST', path: '/chat' })).toBe(120000)
  expect(managementRequestTimeout({ method: 'DELETE', path: '/conversations/turn-id' })).toBe(120000)
  expect(managementRequestTimeout({ method: 'GET', path: '/conversations' })).toBe(120000)
  const controller = new AbortController()
  controller.abort(new DOMException('internal URL/token must not appear', 'TimeoutError'))
  expect(engineTransportFailure(controller.signal.reason, controller.signal, 'GET', null)).toMatchObject({ ok: false, code: 408 })
  expect(engineTransportFailure(controller.signal.reason, controller.signal, 'POST', null).message).toContain('操作结果尚未确认')
  expect(engineTransportFailure(controller.signal.reason, controller.signal, 'GET', '引擎连接已经切换')).toMatchObject({ code: 409, message: '引擎连接已经切换' })
  expect(JSON.stringify(engineTransportFailure(new Error('private request details'), new AbortController().signal, 'GET', null))).not.toMatch(/private|token|internal/)
})

test('real IPC cancels a hung snapshot while status remains usable and does not retry a dropped mutation', async ({}, testInfo) => {
  test.setTimeout(70000)
  const root = resolve(__dirname, '..'), token = 'snapshot-timeout-fixture'
  let app: ElectronApplication | undefined, fixture = '', snapshotRequests = 0, snapshotClosed = false, mutations = 0
  let conversationRequests = 0
  const errors: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/api/v1/chat/snapshot' && url.searchParams.get('sessionId') === 'blocked-history') {
      snapshotRequests++; res.on('close', () => { snapshotClosed = true }); return
    }
    if (url.pathname === '/api/v1/conversations/blocked-turn') {
      conversationRequests++; return
    }
    if (url.pathname === '/api/v1/security/mode' && req.method === 'PUT') {
      mutations++
      if (url.searchParams.get('probe') === 'body') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000' }); res.write('{"code":200,')
        setTimeout(() => res.destroy(), 30)
      } else req.socket.destroy()
      return
    }
    const data = url.pathname === '/health' ? { status: 'ok' }
      : url.pathname === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
        toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'timeout-current' }
        : url.pathname === '/api/v1/chat/status' ? (url.searchParams.get('sessionId') === 'blocked-history'
          ? { running: true, finished: false, run: { runId: 'still-running', status: 'running' } } : { running: false, finished: true })
          : url.pathname === '/api/v1/chat/snapshot' ? { sessionId: url.searchParams.get('sessionId'), source: 'persisted', finished: true, history: [], projection: [], runs: [] }
            : url.pathname === '/api/v1/workspace/directory' ? { root: '/remote/timeout', entries: [] }
              : url.pathname === '/api/v1/security/mode' ? { mode: 'safe' }
                : url.pathname === '/api/v1/memory/settings' ? { enabled: false, effectiveScope: 'off' } : []
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 200, data }))
  })
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    const parent = join(root, '.e2e-tmp'); await mkdir(parent, { recursive: true }); fixture = await mkdtemp(join(parent, 'snapshot-timeout-'))
    await writeFile(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
      remoteWorkspaceRoot: '/remote/timeout', autoStartEngine: true, lastSessionId: '', lastFolder: '' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env })
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase)).toBe('ready')
    const started = Date.now()
    const [failed, conversation] = await page.evaluate(() => Promise.all([
      window.aether.engine.request({ method: 'GET', path: '/chat/snapshot', query: { sessionId: 'blocked-history' } }),
      window.aether.engine.request({ method: 'GET', path: '/conversations/blocked-turn', query: { current: 1, pageSize: 8 } })
    ]))
    expect(failed).toMatchObject({ ok: false, code: 408, data: null })
    expect(failed.message).toContain('后台任务可能仍在运行')
    expect(Date.now() - started).toBeLessThan(25000)
    await expect.poll(() => snapshotClosed).toBe(true)
    expect(snapshotRequests).toBe(1)
    // This legacy history route is embedded-only. Its transport deadline must
    // not accidentally widen the existing remote route contract.
    expect(conversation).toMatchObject({ ok: false, code: 409, data: null })
    expect(conversationRequests).toBe(0)
    expect(await page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase)).toBe('ready')
    const status = await page.evaluate(() => window.aether.engine.request({ method: 'GET', path: '/chat/status', query: { sessionId: 'blocked-history' } }))
    expect(status).toMatchObject({ ok: true, data: { run: { runId: 'still-running', status: 'running' } } })
    const retry = await page.evaluate(() => window.aether.engine.request({ method: 'GET', path: '/chat/snapshot', query: { sessionId: 'recovered-history' } }))
    expect(retry).toMatchObject({ ok: true, data: { sessionId: 'recovered-history' } })
    const mutation = await page.evaluate(() => window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { mode: 'safe', sessionId: 'transport-probe' } }))
    expect(mutation).toMatchObject({ ok: false, code: 503, data: null })
    expect(mutation.message).toContain('操作结果尚未确认'); expect(mutations).toBe(1)
    const partial = await page.evaluate(() => window.aether.engine.request({ method: 'PUT', path: '/security/mode',
      query: { probe: 'body' }, body: { mode: 'safe', sessionId: 'transport-probe' } }))
    expect(partial).toMatchObject({ ok: false, code: 503, data: null })
    expect(partial.message).toContain('操作结果尚未确认'); expect(mutations).toBe(2)
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('engine-still-ready-after-snapshot-timeout.png') })
  } finally {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
})
