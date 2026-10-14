/** Real Electron BrowserService/Bridge: >65s condition waits, explicit deadlines,
 * controlled-engine cancellation and connection replacement, without model calls.
 * Run against the owner's prebuilt out; this spec never builds or patches runtime code. */
/* eslint-disable no-empty-pattern -- Playwright requires a destructured fixture argument before TestInfo. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserSnapshot, BrowserTabState, BrowserToolRequest } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..')
const instanceToken = `browser-long-wait-${randomUUID()}`
const holdMs = 65_000
type Command = {
  requestId: string
  sessionId: string
  action: BrowserToolRequest['action']
  args: Omit<BrowserToolRequest, 'action'>
  expiresAt?: number | null
}
type Reply = { requestId: string; success: boolean; output: string; error?: string }
type Registration = {
  clientId: string
  clientToken: string
  sessionId: string
  releasedAt?: number
}
type Watch = { finish: (active: boolean) => void }
type RequestRecord = {
  command: Command
  clientId: string
  queuedAt: number
  deliveredAt?: number
  deliveredTick?: number
  readyTick?: number
  active: boolean
  preflights: number
  watchRequests: number
  abortedWatches: number
  watches: Set<Watch>
  replies: { clientId: string; at: number; tick: number; reply: Reply }[]
}
type GateProbe = { reads: number; exists: boolean; visible: boolean; text: string | null }
type BuildIdentity = { mainSha256: string; outSha256: string; files: number }

let app: ElectronApplication | undefined
let page: Page
let health: ElectronHealthMonitor | undefined
let fixture = '',
  origin = '',
  tabId = '',
  guestId = 0,
  sessionId = ''
let built: BuildIdentity
const clients = new Map<string, Registration>()
const requests = new Map<string, RequestRecord>()
const queue: RequestRecord[] = []
const timers = new Set<NodeJS.Timeout>()
const errors: string[] = []
const fixtureErrors: string[] = []
const modelRequests: string[] = []
const cancelCalls: { sessionId: string; requestIds: string[]; at: number }[] = []
const evidence: Record<string, unknown>[] = []

// Only the controlled page is instrumented. The original DOM predicate remains
// intact, so a read counter proves the actual service wait loop has started.
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>浏览器长等待回归</title>
<style>body{font:18px sans-serif;padding:24px}p{margin:8px 0}</style>
<h1>本地条件等待页面</h1><main id="gates"></main><script>
window.gateReads = Object.create(null);
const originalQuerySelector = document.querySelector.bind(document);
document.querySelector = function(selector) {
  if (typeof selector === 'string' && selector.startsWith('#gate-')) {
    window.gateReads[selector] = (window.gateReads[selector] || 0) + 1;
  }
  return originalQuerySelector(selector);
};
</script></html>`

function buildIdentity(): BuildIdentity {
  const out = join(root, 'out')
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(out)
  files.sort()
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(out, path).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(createHash('sha256').update(readFileSync(path)).digest())
  }
  return {
    mainSha256: createHash('sha256')
      .update(readFileSync(join(out, 'main/index.js')))
      .digest('hex'),
    outSha256: hash.digest('hex'),
    files: files.length
  }
}

function schedule(callback: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    timers.delete(timer)
    callback()
  }, ms)
  timers.add(timer)
  return timer
}

function json(response: ServerResponse, data: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ code: status, message: 'controlled browser wait fixture', data }))
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    if (url.pathname === '/demo') {
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
      response.end(html)
      return
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    if (
      url.pathname.startsWith('/api/') &&
      request.headers['x-aether-instance-token'] !== instanceToken
    ) {
      json(response, {}, 401)
      return
    }
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (url.pathname === '/health') {
      json(response, { status: 'ok' })
      return
    }
    if (url.pathname === '/meta') {
      json(response, {
        version: '2.0.0',
        buildId: `sha256:${'b'.repeat(64)}`,
        protocolVersion: 1,
        toolProfiles: ['code'],
        subagentSchemaVersion: 1,
        instanceId: 'browser-long-wait-remote'
      })
      return
    }
    if (url.pathname === '/api/v1/browser/clients' && request.method === 'POST') {
      const client: Registration = {
        clientId: String(body.clientId ?? randomUUID()),
        clientToken: String(body.clientToken ?? randomUUID()),
        sessionId: String(body.sessionId)
      }
      clients.set(client.clientId, client)
      json(response, {
        ...client,
        capabilities: { requestWatch: true },
        pollTimeoutMs: 20_000,
        leaseMs: 65_000
      })
      return
    }
    const route = /^\/api\/v1\/browser\/clients\/([^/]+)(.*)$/.exec(url.pathname)
    if (route) {
      const client = clients.get(decodeURIComponent(route[1]))
      if (!client || request.headers['x-aether-browser-token'] !== client.clientToken) {
        json(response, {}, 404)
        return
      }
      const suffix = route[2]
      if (suffix === '/results' && request.method === 'POST') {
        const record = requests.get(String(body.requestId))
        if (!record) {
          fixtureErrors.push('Result for an unknown request')
          json(response, {}, 404)
          return
        }
        // Retain all authenticated attempts, including those from a released
        // client, so duplicate or late replies cannot be hidden by map overwrite.
        record.replies.push({
          clientId: client.clientId,
          at: Date.now(),
          tick: performance.now(),
          reply: body as unknown as Reply
        })
        record.active = false
        for (const watch of [...record.watches]) watch.finish(false)
        json(response, { accepted: true })
        return
      }
      if (!suffix && request.method === 'DELETE') {
        client.releasedAt = Date.now()
        // Leave request.active unchanged: switching must cancel through the
        // real connection controller, rather than simulated engine cancellation.
        json(response, { removed: true })
        return
      }
      if (client.releasedAt) {
        json(response, {}, 404)
        return
      }
      if (suffix === '/commands') {
        const finish = (): void => {
          const index = queue.findIndex((record) => record.clientId === client.clientId)
          const record = index < 0 ? undefined : queue.splice(index, 1)[0]
          if (record) {
            record.deliveredAt = Date.now()
            record.deliveredTick = performance.now()
          }
          json(response, { commands: record ? [record.command] : [] })
        }
        if (queue.some((record) => record.clientId === client.clientId)) finish()
        else {
          const timer = schedule(finish, 120)
          response.once('close', () => {
            clearTimeout(timer)
            timers.delete(timer)
          })
        }
        return
      }
      const state = /^\/requests\/([^/]+)\/state$/.exec(suffix)
      if (state) {
        const record = requests.get(decodeURIComponent(state[1]))
        if (!record || record.clientId !== client.clientId || !record.deliveredAt) {
          json(response, {}, 404)
          return
        }
        if (url.searchParams.get('wait') !== 'true') {
          record.preflights++
          json(response, { active: record.active })
          return
        }
        record.watchRequests++
        if (!record.active) {
          json(response, { active: false })
          return
        }
        const watch: Watch = {
          finish: (active) => {
            clearTimeout(timer)
            timers.delete(timer)
            record.watches.delete(watch)
            json(response, { active })
          }
        }
        record.watches.add(watch)
        // The bridge's individual HTTP request budget is 25s; a 20s heartbeat
        // renews monitoring without imposing a total lifetime on the operation.
        const timer = schedule(() => watch.finish(record.active), 20_000)
        response.once('close', () => {
          clearTimeout(timer)
          timers.delete(timer)
          record.watches.delete(watch)
          if (!response.writableEnded) record.abortedWatches++
        })
        return
      }
      fixtureErrors.push(`Unexpected browser route: ${request.method} ${suffix}`)
      json(response, {}, 404)
      return
    }
    if (url.pathname === '/api/v1/chat/cancel' && request.method === 'POST') {
      const cancelled: string[] = []
      for (const record of requests.values()) {
        if (record.command.sessionId !== body.sessionId || !record.active) continue
        record.active = false
        cancelled.push(record.command.requestId)
        for (const watch of [...record.watches]) watch.finish(false)
      }
      cancelCalls.push({ sessionId: String(body.sessionId), requestIds: cancelled, at: Date.now() })
      json(response, { cancelled: true })
      return
    }
    if (
      /^\/api\/v1\/(?:chat(?:\/stream|\/send|\/message|\/run)?|utility\/chat)$/.test(url.pathname)
    ) {
      modelRequests.push(`${request.method} ${url.pathname}`)
      json(response, {}, 400)
      return
    }
    if (url.pathname === '/api/v1/chat/snapshot') {
      json(response, {
        schemaVersion: 1,
        sessionId: url.searchParams.get('sessionId'),
        source: 'persisted',
        finished: true,
        eventId: null,
        projection: [],
        runs: [],
        history: [],
        todos: [],
        changes: [],
        commandJobs: []
      })
      return
    }
    if (url.pathname === '/api/v1/workspace/bind') {
      json(response, { workspaceRoot: '/remote/project' })
      return
    }
    if (url.pathname === '/api/v1/workspace/directory') {
      json(response, { root: '/remote/project', entries: [] })
      return
    }
    json(response, [])
  })().catch((error) => {
    fixtureErrors.push(String(error))
    if (!response.headersSent) json(response, {}, 500)
    else if (!response.destroyed) response.end()
  })
})

function currentClient(expectedSession = sessionId): Registration {
  const live = [...clients.values()].filter(
    (client) => client.sessionId === expectedSession && !client.releasedAt
  )
  expect(live, 'Exactly one registered client must own this session').toHaveLength(1)
  return live[0]
}

function issue(
  action: Command['action'],
  args: Command['args'],
  expiry: { expiresAt?: number | null } = {}
): RequestRecord {
  const client = currentClient()
  const record: RequestRecord = {
    command: { requestId: randomUUID(), sessionId: client.sessionId, action, args, ...expiry },
    clientId: client.clientId,
    queuedAt: Date.now(),
    active: true,
    preflights: 0,
    watchRequests: 0,
    abortedWatches: 0,
    watches: new Set(),
    replies: []
  }
  requests.set(record.command.requestId, record)
  queue.push(record)
  return record
}

async function reply(record: RequestRecord, timeout = 10_000): Promise<Reply> {
  await expect
    .poll(() => record.replies.length, {
      timeout,
      message: `Reply for ${record.command.action} ${record.command.requestId}`
    })
    .toBe(1)
  expect(record.replies[0].clientId).toBe(record.clientId)
  return record.replies[0].reply
}

async function native<T>(expression: string): Promise<T> {
  if (!app) throw new Error('Electron is not running')
  return app.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.id)
      if (!guest || guest.isDestroyed() || guest.getURL() !== input.url)
        throw new Error('Owned local guest is not available')
      return guest.executeJavaScript(input.expression)
    },
    { id: guestId, url: `${origin}/demo`, expression }
  ) as Promise<T>
}

async function probe(selector: string): Promise<GateProbe> {
  return native<GateProbe>(`(()=>{
    const element = document.getElementById(${JSON.stringify(selector.slice(1))});
    return {reads:window.gateReads[${JSON.stringify(selector)}]||0,exists:!!element,
      visible:!!element?.getClientRects().length,text:element?.textContent??null};
  })()`)
}

async function addGate(selector: string, text: string): Promise<void> {
  await native(`(()=>{
    const element=document.createElement('p');
    element.id=${JSON.stringify(selector.slice(1))};element.textContent=${JSON.stringify(text)};
    document.getElementById('gates').appendChild(element);
  })()`)
  expect(await probe(selector)).toMatchObject({ exists: true, visible: true, text })
}

async function waitStarted(record: RequestRecord, selector: string): Promise<void> {
  await expect
    .poll(() => ({
      delivered: !!record.deliveredAt,
      preflights: record.preflights,
      watching: record.watches.size
    }))
    .toMatchObject({ delivered: true, preflights: 1, watching: 1 })
  await expect.poll(async () => (await probe(selector)).reads).toBeGreaterThan(0)
  expect(await probe(selector)).toMatchObject({ exists: false, visible: false })
  expect(record.replies).toHaveLength(0)
  record.readyTick = performance.now()
}

async function holdUntil(tick: number): Promise<void> {
  // This is the deliberate boundary under test, not a guessed readiness delay.
  while (performance.now() < tick) await delay(Math.ceil(tick - performance.now()))
}

async function snapshotBarrier(): Promise<{ snapshot: BrowserSnapshot; elapsedMs: number }> {
  const start = performance.now()
  const record = issue('snapshot', { tabId }, { expiresAt: Date.now() + 10_000 })
  const result = await reply(record, 8_000)
  expect(result.success, result.error).toBe(true)
  const snapshot = JSON.parse(result.output) as BrowserSnapshot
  expect(snapshot.tab).toMatchObject({ tabId, url: `${origin}/demo`, context: { sessionId } })
  return { snapshot, elapsedMs: performance.now() - start }
}

function recordEvidence(record: RequestRecord): Record<string, unknown> {
  return {
    command: record.command,
    clientId: record.clientId,
    queuedAt: record.queuedAt,
    deliveredAt: record.deliveredAt,
    active: record.active,
    preflights: record.preflights,
    watchRequests: record.watchRequests,
    abortedWatches: record.abortedWatches,
    openWatches: record.watches.size,
    replies: record.replies.map((item) => ({
      clientId: item.clientId,
      at: item.at,
      success: item.reply.success,
      error: item.reply.error,
      elapsedMs: record.deliveredTick === undefined ? null : item.tick - record.deliveredTick,
      outputSha256: createHash('sha256')
        .update(item.reply.output ?? '')
        .digest('hex')
    }))
  }
}

async function attach(testInfo: TestInfo, details: Record<string, unknown>): Promise<void> {
  const item = { title: testInfo.title, build: built, ...details }
  evidence.push(item)
  await testInfo.attach('browser-wait-evidence', {
    body: JSON.stringify(item, null, 2),
    contentType: 'application/json'
  })
}

async function reconnect(targetSession: string): Promise<void> {
  await page.evaluate(async (target) => {
    const snapshot = await window.aether.engine.getSnapshot()
    await window.aether.browser.connect({
      sessionId: target,
      expectedEngine: {
        mode: snapshot.mode,
        baseUrl: snapshot.baseUrl,
        instanceId: snapshot.instanceId,
        accountId: snapshot.accountId
      }
    })
  }, targetSession)
  await expect
    .poll(() => page.evaluate(() => window.aether.browser.getConnection()))
    .toMatchObject({ status: 'connected', sessionId: targetSession })
  currentClient(targetSession)
}

async function longWait(testInfo: TestInfo, mode: 'default' | 'zero'): Promise<void> {
  const selector = `#gate-${mode}`
  const text = `${mode}: 条件在真实等待至少65秒后满足`
  const record = issue(
    'wait',
    { tabId, selector, ...(mode === 'zero' ? { timeoutMs: 0 } : {}) },
    mode === 'zero' ? { expiresAt: null } : {}
  )
  if (mode === 'default') {
    expect(record.command).not.toHaveProperty('expiresAt')
    expect(record.command.args).not.toHaveProperty('timeoutMs')
  } else {
    expect(record.command).toHaveProperty('expiresAt', null)
    expect(record.command.args).toHaveProperty('timeoutMs', 0)
  }
  await waitStarted(record, selector)
  const start = record.readyTick!
  console.log(`LONG_WAIT_START mode=${mode} request=${record.command.requestId}`)
  const checkpoints: Record<string, unknown>[] = []
  for (const boundary of [31_000, 61_000]) {
    await holdUntil(start + boundary)
    const observed = await probe(selector)
    const elapsedMs = performance.now() - start
    expect(record.replies, `${mode} must still be waiting past ${boundary}ms`).toHaveLength(0)
    expect(record.active).toBe(true)
    expect(observed).toMatchObject({ exists: false, visible: false })
    expect(observed.reads).toBeGreaterThan(1)
    expect(record.watchRequests).toBeGreaterThanOrEqual(Math.floor(boundary / 20_000) + 1)
    health!.assertHealthy()
    checkpoints.push({
      elapsedMs,
      ...observed,
      watchRequests: record.watchRequests,
      resultCount: record.replies.length
    })
    console.log(
      `LONG_WAIT_CHECKPOINT mode=${mode} elapsedMs=${Math.round(elapsedMs)} reads=${observed.reads} results=${record.replies.length}`
    )
  }
  await holdUntil(start + holdMs)
  expect(record.replies).toHaveLength(0)
  const conditionAfterMs = performance.now() - start
  expect(conditionAfterMs).toBeGreaterThanOrEqual(holdMs)
  await addGate(selector, text)
  const result = await reply(record)
  expect(result.success, result.error).toBe(true)
  const snapshot = JSON.parse(result.output) as BrowserSnapshot
  expect(snapshot.text).toContain(text)
  expect(snapshot.tab).toMatchObject({ tabId, url: `${origin}/demo`, context: { sessionId } })
  const elapsedMs = record.replies[0].tick - record.deliveredTick!
  expect(elapsedMs).toBeGreaterThanOrEqual(holdMs)
  expect(record.replies).toHaveLength(1)
  expect((await snapshotBarrier()).snapshot.text).toContain(text)
  await attach(testInfo, {
    mode,
    conditionAfterMs,
    elapsedMs,
    checkpoints,
    probe: await probe(selector),
    request: recordEvidence(record)
  })
  console.log(
    `LONG_WAIT_SUCCESS mode=${mode} elapsedMs=${Math.round(elapsedMs)} replies=${record.replies.length}`
  )
}

test.describe.serial('浏览器长等待与取消边界（现有产物）', () => {
  test.beforeAll(async () => {
    built = buildIdentity()
    console.log(`BROWSER_WAIT_BUILD ${JSON.stringify(built)}`)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-long-wait-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({
        engineMode: 'remote',
        remoteBaseUrl: origin,
        autoStartEngine: true,
        lastSessionId: ''
      })
    )
    writeFileSync(
      join(fixture, 'browser-settings.json'),
      JSON.stringify({ homeUrl: 'about:blank', persistSession: false, aiEnabled: true })
    )
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken,
      AETHER_GLOBAL_DIR: join(fixture, 'global')
    }
    // A dev-server override could silently load a different renderer while the
    // out hash stays intact; inherited remote credentials must not leave fixture isolation.
    for (const key of Object.keys(env)) {
      if (
        [
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'AETHER_IDE_REMOTE_API_KEY',
          'AETHER_IDE_REMOTE_BEARER_TOKEN',
          'AETHER_IDE_REMOTE_AUTH_URL'
        ].includes(key.toUpperCase())
      )
        delete env[key]
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'browser-long-wait', [instanceToken])
    page = await app.firstWindow()
    expect(page.url(), 'The real window must load the frozen renderer artifact').toMatch(
      /^file:.*\/out\/renderer\/index\.html/
    )
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect
      .poll(() => page.evaluate(() => window.aether.browser.getConnection()))
      .toMatchObject({ status: 'connected' })
    const connection = await page.evaluate(() => window.aether.browser.getConnection())
    if (!connection.sessionId) throw new Error('Connected browser has no session')
    sessionId = connection.sessionId
    currentClient()
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    const opened = await reply(
      issue('open', { url: `${origin}/demo` }, { expiresAt: Date.now() + 20_000 }),
      20_000
    )
    expect(opened.success, opened.error).toBe(true)
    tabId = (JSON.parse(opened.output) as BrowserTabState).tabId
    await expect
      .poll(() => page.evaluate(() => window.aether.browser.list()))
      .toContainEqual(expect.objectContaining({ tabId, url: `${origin}/demo`, loading: false }))
    const owned = await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .filter((wc) => wc.getURL() === url)
          .map((wc) => wc.id),
      `${origin}/demo`
    )
    expect(owned, 'One real Electron guest must own the local page').toHaveLength(1)
    guestId = owned[0]
    expect(await native('({node:typeof require,bridge:typeof window.aether})')).toEqual({
      node: 'undefined',
      bridge: 'undefined'
    })
    expect((await snapshotBarrier()).snapshot.text).toContain('本地条件等待页面')
  })

  test.afterEach(() => {
    expect(errors, 'Renderer runtime errors').toEqual([])
    expect(fixtureErrors, 'Controlled queue contract errors').toEqual([])
    expect(modelRequests, 'No model or chat request is permitted in this regression').toEqual([])
    health?.assertHealthy()
    expect(buildIdentity(), 'Prebuilt out must stay byte-for-byte unchanged').toEqual(built)
    for (const record of requests.values())
      expect(
        record.replies.length,
        `No duplicate reply for ${record.command.requestId}`
      ).toBeLessThanOrEqual(1)
  })

  test.afterAll(async ({}, testInfo) => {
    let closeFailure: unknown
    try {
      if (health) await health.closeAndAssert(testInfo)
      else await app?.close()
    } catch (error) {
      closeFailure = error
    }
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const report = {
      buildBefore: built,
      buildAfter: buildIdentity(),
      modelRequests,
      errors,
      fixtureErrors,
      cancelCalls,
      tests: evidence,
      requests: [...requests.values()].map(recordEvidence),
      clients: [...clients.values()].map((client) => ({
        clientId: client.clientId,
        sessionId: client.sessionId,
        releasedAt: client.releasedAt
      }))
    }
    const reportPath = testInfo.outputPath('browser-long-wait-summary.json')
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('browser-long-wait-summary', {
      path: reportPath,
      contentType: 'application/json'
    })
    if (fixture) {
      const absolute = resolve(fixture)
      if (
        dirname(absolute) !== join(root, '.e2e-tmp') ||
        !basename(absolute).startsWith('browser-long-wait-')
      )
        throw new Error('Unsafe fixture cleanup')
      rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    if (closeFailure) throw closeFailure
  })

  test('缺省等待省略 expiresAt，条件65秒后满足仍成功', async ({}, testInfo) => {
    test.setTimeout(150_000)
    await longWait(testInfo, 'default')
  })

  test('timeoutMs=0 且 expiresAt=null，条件65秒后满足仍成功', async ({}, testInfo) => {
    test.setTimeout(150_000)
    await longWait(testInfo, 'zero')
  })

  test('显式页面超时失败，随后满足条件不会迟到成功', async ({}, testInfo) => {
    const selector = '#gate-timeout'
    const record = issue(
      'wait',
      { tabId, selector, timeoutMs: 450 },
      { expiresAt: Date.now() + 10_000 }
    )
    const result = await reply(record)
    const elapsedMs = record.replies[0].tick - record.deliveredTick!
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/超时|时限/)
    expect(elapsedMs).toBeGreaterThanOrEqual(300)
    expect(elapsedMs).toBeLessThan(4_000)
    expect(await probe(selector)).toMatchObject({ exists: false, visible: false })
    expect((await probe(selector)).reads).toBeGreaterThan(0)
    const barrier = await snapshotBarrier()
    expect(barrier.snapshot.text).not.toContain('超时后出现')
    await addGate(selector, '超时后出现')
    expect((await snapshotBarrier()).snapshot.text).toContain('超时后出现')
    expect(record.replies).toHaveLength(1)
    expect(record.replies[0].reply.success).toBe(false)
    await attach(testInfo, {
      elapsedMs,
      queueReleaseMs: barrier.elapsedMs,
      probe: await probe(selector),
      request: recordEvidence(record)
    })
  })

  test('用户取消经真实IPC和请求监控中止无限等待，同页队列继续且无迟到成功', async ({}, testInfo) => {
    const selector = '#gate-cancel'
    const record = issue('wait', { tabId, selector, timeoutMs: 0 }, { expiresAt: null })
    await waitStarted(record, selector)
    const cancelAt = performance.now()
    const cancelled = await page.evaluate(
      (id) =>
        window.aether.engine.request({
          method: 'POST',
          path: '/chat/cancel',
          body: { sessionId: id }
        }),
      sessionId
    )
    expect(cancelled).toMatchObject({ ok: true })
    const result = await reply(record, 5_000)
    const cancelledAfterMs = record.replies[0].tick - cancelAt
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/取消|结束/)
    expect(cancelledAfterMs).toBeLessThan(3_000)
    expect(cancelCalls.at(-1)).toMatchObject({ sessionId, requestIds: [record.command.requestId] })
    await expect
      .poll(() => page.evaluate(() => window.aether.browser.getConnection()))
      .toMatchObject({ status: 'connected', sessionId })
    const barrier = await snapshotBarrier()
    expect(barrier.elapsedMs).toBeLessThan(3_000)
    expect(barrier.snapshot.text).not.toContain('取消后新条件')
    await addGate(selector, '取消后新条件')
    const fresh = issue(
      'wait',
      { tabId, selector, timeoutMs: 1_000 },
      { expiresAt: Date.now() + 10_000 }
    )
    const freshResult = await reply(fresh)
    expect(freshResult.success, freshResult.error).toBe(true)
    expect((JSON.parse(freshResult.output) as BrowserSnapshot).text).toContain('取消后新条件')
    expect(record.replies).toHaveLength(1)
    expect(record.replies[0].reply.success).toBe(false)
    await attach(testInfo, {
      cancelledAfterMs,
      queueReleaseMs: barrier.elapsedMs,
      cancelCall: cancelCalls.at(-1),
      request: recordEvidence(record),
      fresh: recordEvidence(fresh)
    })
  })

  test('等待中切换连接释放同页队列，旧请求不会向新连接回报迟到成功', async ({}, testInfo) => {
    const selector = '#gate-switch'
    const record = issue('wait', { tabId, selector }, {})
    await waitStarted(record, selector)
    const oldClient = currentClient()
    const switchAt = performance.now()
    const alternate = `${sessionId}-alternate`
    await reconnect(alternate)
    await expect.poll(() => !!oldClient.releasedAt).toBe(true)
    await expect.poll(() => record.abortedWatches).toBeGreaterThan(0)
    const switchCancelledAfterMs = performance.now() - switchAt
    expect(switchCancelledAfterMs, 'Switching must promptly abort the old watch').toBeLessThan(
      5_000
    )
    expect(
      record.active,
      'The fixture must not manufacture cancellation for a connection switch'
    ).toBe(true)
    expect(record.replies).toHaveLength(0)
    const alternateClient = currentClient(alternate)
    await reconnect(sessionId)
    expect(alternateClient.releasedAt).toBeDefined()
    expect(currentClient().clientId).not.toBe(oldClient.clientId)
    const barrier = await snapshotBarrier()
    expect(barrier.elapsedMs).toBeLessThan(3_000)
    expect(barrier.snapshot.text).not.toContain('切换后新条件')
    expect(await probe(selector)).toMatchObject({ exists: false, visible: false })
    await addGate(selector, '切换后新条件')
    const fresh = issue('wait', { tabId, selector }, { expiresAt: null })
    const freshResult = await reply(fresh)
    expect(freshResult.success, freshResult.error).toBe(true)
    expect((JSON.parse(freshResult.output) as BrowserSnapshot).text).toContain('切换后新条件')
    await snapshotBarrier()
    expect(record.active).toBe(true)
    expect(
      record.replies,
      'An abandoned connection may not post any old result, including after the condition matches'
    ).toHaveLength(0)
    await attach(testInfo, {
      switchCancelledAfterMs,
      switchAndRecoverMs: performance.now() - switchAt,
      queueReleaseMs: barrier.elapsedMs,
      oldClientId: oldClient.clientId,
      oldReleasedAt: oldClient.releasedAt,
      alternateClientId: alternateClient.clientId,
      newClientId: currentClient().clientId,
      request: recordEvidence(record),
      fresh: recordEvidence(fresh)
    })
  })
})
