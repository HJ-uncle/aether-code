/**
 * Real Electron settings contract: OS-encrypted remote credentials survive reload/relaunch,
 * rotate and clear through the UI, authenticate HTTP, and never enter public state or logs.
 * Only the external HTTP engine is a fixture; preload, IPC, safeStorage, and UI remain real.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'

declare global {
  interface Window {
    aether: AetherIdeApi
    __observeRemoteTokenTest: (payload: string) => Promise<void>
  }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const correctToken = 'e2e-ui-remote-correct-3bf69c2a'
const incorrectToken = 'e2e-ui-remote-incorrect-a71d908f'
const rollbackToken = 'e2e-ui-remote-rollback-5140e8da'
const secrets = [correctToken, incorrectToken, rollbackToken]
const historySessionId = 'remote-token-ui-history'
const historyTitle = '远端会话历史探针'
const historyReply = '远端会话历史已通过真实鉴权加载。'
const historyRows = [
  { id: 'remote-ui-user', role: 'user', content: historyTitle, createdAt: 1_800_000_000_000 },
  { id: 'remote-ui-assistant', role: 'assistant', content: historyReply, createdAt: 1_800_000_000_001 }
]
const remoteChatReply = '远端任务已通过鉴权和 SSE 完成。'
const remoteChatBodies: Array<Record<string, unknown>> = []
const recordedRoots = new Map<string, string[]>([
  [historySessionId, ['/srv/existing-project']],
  ['remote-existing-sandbox', []]
])
const extraHistory = new Map<string, Array<Record<string, unknown>>>()
const apiRequests: Array<{ method: string; path: string; sessionId: string; accepted: boolean }> = []
const diagnostics: string[] = []
const mainStdout: string[] = []
const mainStderr: string[] = []
let snapshotEventCount = 0
const rendererErrors: string[] = []
const probes: Array<{ token: string | undefined; accepted: boolean }> = []
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let fixture = ''
let remoteUrl = ''

function fixtureData(path: string, sessionId: string): unknown {
  if (path === '/health') return { status: 'ok' }
  if (path === '/meta') return {
    version: '1.0.0',
    buildId: `sha256:${'9'.repeat(64)}`,
    protocolVersion: 1,
    toolProfiles: ['code'],
    subagentSchemaVersion: 1,
    instanceId: 'remote-token-ui-fixture'
  }
  if (path === '/api/v1/conversation/sessions') return [{
    sessionId: historySessionId,
    title: historyTitle,
    lastReply: historyReply,
    lastAt: 1_800_000_000_001,
    messageCount: 2
  }]
  if (path === '/api/v1/models') return [{
    id: 'remote-fixture-model', tenantId: 'fixture', provider: 'openai', modelId: 'remote-fixture-model',
    apiKey: '', baseUrl: '', displayName: '远端夹具模型', isEnabled: true,
    capabilities: { contextWindow: 128000 }, createdAt: 1, updatedAt: 1
  }]
  if (path === '/api/v1/chat/runs') return {
    runs: recordedRoots.has(sessionId) ? [{ workspacePaths: recordedRoots.get(sessionId) }] : []
  }
  const history = [
    ...(sessionId === historySessionId ? historyRows : []),
    ...(extraHistory.get(sessionId) ?? [])
  ]
  if (path === '/api/v1/conversation/history') return history
  if (path === '/api/v1/chat/snapshot') return {
    schemaVersion: 1,
    source: 'persisted',
    sessionId,
    eventId: null,
    finished: true,
    projection: [],
    runs: [],
    history,
    todos: [],
    changes: [],
    commandJobs: []
  }
  // Tools, changes, and subagent runs have valid empty-list responses.
  return []
}

function tokenFile(): string {
  return join(fixture, 'engine', 'secrets', 'remote-instance-token.json')
}

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Windows environment names are case-insensitive. No developer credential or dev server
  // can supply a hidden fallback or bypass the built renderer during this test.
  for (const key of Object.keys(env)) {
    if ([
      'AETHER_IDE_REMOTE_INSTANCE_TOKEN',
      'AETHER_INSTANCE_TOKEN',
      'ELECTRON_RENDERER_URL',
      'ELECTRON_RUN_AS_NODE'
    ].includes(key.toUpperCase())) delete env[key]
  }
  return {
    ...env,
    AETHER_IDE_ECHO_ENGINE: '1',
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'workspace'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
    SKILLS_ROOT: join(fixture, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

async function observeRenderer(): Promise<void> {
  await page.evaluate(() => {
    const record = (payload: unknown): void => {
      void window.__observeRemoteTokenTest(JSON.stringify(payload)).catch(() => undefined)
    }
    window.aether.engine.onLog(entry => record({ kind: 'engine-log', entry }))
    window.aether.engine.onSnapshot(snapshot => record({ kind: 'snapshot', snapshot }))
  })
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${fixture}`],
    cwd: root,
    env: launchEnvironment()
  })
  app.process().stdout?.on('data', chunk => mainStdout.push(String(chunk)))
  app.process().stderr?.on('data', chunk => mainStderr.push(String(chunk)))
  page = await app.firstWindow()
  page.on('console', message => diagnostics.push(message.text()))
  page.on('pageerror', error => {
    rendererErrors.push(error.message)
    diagnostics.push(error.stack ?? error.message)
  })
  await page.exposeFunction('__observeRemoteTokenTest', (payload: string) => {
    diagnostics.push(payload)
    if ((JSON.parse(payload) as { kind?: string }).kind === 'snapshot') snapshotEventCount++
  })
  await expect(page.locator('.status-bar')).toBeVisible()
  await observeRenderer()
}

function cleanFixture(): void {
  if (!fixture) return
  if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('remote-token-ui-')) {
    throw new Error('Refusing remote token fixture cleanup outside test root')
  }
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function closeApp(): Promise<void> {
  const closing = app
  app = undefined
  await closing?.close()
}

async function openEngineSettings(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p')
    await page.locator('.palette__input').fill('设置')
    await page.keyboard.press('Enter')
  }
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.getByRole('tab', { name: '引擎管理', exact: true }).click()
}

async function expectPhase(phase: 'ready' | 'error'): Promise<void> {
  await expect.poll(async () => (await page.evaluate(
    () => window.aether.engine.getSnapshot()
  )).phase).toBe(phase)
  const statusButton = page.locator(`button.status-bar__item--${phase}`)
  await expect(statusButton).toBeVisible()
  await expect(statusButton).toContainText(phase === 'ready' ? '引擎：就绪' : '引擎：异常')
  await openEngineSettings()
  const statusSection = page.locator('.app-settings .sg').filter({
    has: page.getByRole('heading', { name: '当前状态', exact: true })
  })
  await statusSection.scrollIntoViewIfNeeded()
  // Keep a visible phase assertion: a long authentication error must not collapse the
  // state values to zero width when settings, history, and chat are visible together.
  await expect(statusSection.locator('.kv dd').filter({
    hasText: phase === 'ready' ? /^已就绪$/ : /^错误$/
  })).toBeVisible()
  if (phase === 'error') {
    const error = statusSection.locator('.settings-view__error')
    await error.scrollIntoViewIfNeeded()
    await expect(error).toBeVisible()
    await expect(error).toContainText(/令牌|凭据/)
  }
}

async function expectStoredCredential(): Promise<void> {
  const status = await page.evaluate(() => window.aether.settings.remoteTokenStatus())
  expect(status).toMatchObject({ configured: true, source: 'stored' })
  const input = page.getByLabel('远端令牌', { exact: true })
  await expect(input).toHaveAttribute('type', 'password')
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('placeholder', /已配置/)
  await expect(page.getByRole('button', { name: '清除令牌', exact: true })).toBeVisible()
  expect(existsSync(tokenFile())).toBe(true)
  const encrypted = JSON.parse(readFileSync(tokenFile(), 'utf8'))
  expect(encrypted).toMatchObject({ version: 1, encrypted: true })
  expect(typeof encrypted.value).toBe('string')
  expect(encrypted.value.length).toBeGreaterThan(0)
}

async function expectNoPublicSecret(): Promise<void> {
  const publicState = await page.evaluate(async () => ({
    settings: await window.aether.settings.get(),
    snapshot: await window.aether.engine.getSnapshot(),
    tokenStatus: await window.aether.settings.remoteTokenStatus(),
    text: document.body.textContent,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
  }))
  const settingsText = readFileSync(join(fixture, 'settings.json'), 'utf8')
  const settings = JSON.parse(settingsText) as Record<string, unknown>
  expect(Object.keys(settings).filter(key => /token|credential|secret/i.test(key))).toEqual([])
  const observed = [
    settingsText,
    JSON.stringify(publicState),
    ...diagnostics,
    // Preserve byte ordering within each process stream: a token may span data chunks.
    mainStdout.join(''),
    mainStderr.join(''),
    ...(existsSync(tokenFile()) ? [readFileSync(tokenFile(), 'utf8')] : [])
  ].join('\n')
  for (const secret of secrets) expect(observed).not.toContain(secret)
  expect(snapshotEventCount, '真实生命周期必须至少触发一次已观测的快照事件').toBeGreaterThan(0)
  expect(rendererErrors).toEqual([])
}

async function saveTokenAndExpect(token: string, phase: 'ready' | 'error'): Promise<void> {
  const firstProbe = probes.length
  await page.getByLabel('远端令牌', { exact: true }).fill(token)
  await page.getByRole('button', { name: '保存并重启', exact: true }).click()
  await expect.poll(() => probes.length).toBeGreaterThan(firstProbe)
  await expectPhase(phase)
  expect(probes.slice(firstProbe)).toContainEqual({ token, accepted: phase === 'ready' })
  await expectStoredCredential()
  await expectNoPublicSecret()
}

test.describe.serial('远端令牌设置真实界面闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'remote-token-ui-'))
    mkdirSync(join(fixture, 'workspace'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded',
      autoStartEngine: false,
      lastFolder: '',
      lastSessionId: '',
      remoteBaseUrl: ''
    }))
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      const sessionId = url.searchParams.get('sessionId') ?? ''
      response.setHeader('content-type', 'application/json')
      const token = request.headers['x-aether-instance-token'] as string | undefined
      const accepted = token === correctToken
      if (path === '/api/v1/tools') probes.push({ token, accepted })
      if (path.startsWith('/api/')) apiRequests.push({
        method: request.method ?? '',
        path,
        sessionId,
        accepted
      })
      if (path.startsWith('/api/') && !accepted) {
        response.writeHead(401)
        response.end(JSON.stringify({ code: 40100, message: 'Invalid or missing instance token' }))
        return
      }
      if (request.method === 'POST' && path === '/api/v1/chat') {
        let raw = ''
        for await (const chunk of request) raw += chunk.toString()
        const body = JSON.parse(raw) as Record<string, unknown>
        remoteChatBodies.push(body)
        const chatSession = String(body.sessionId ?? '')
        const previous = extraHistory.get(chatSession) ?? []
        const turn = remoteChatBodies.length
        extraHistory.set(chatSession, [...previous,
          { id: 'remote-chat-user-' + turn, role: 'user', content: body.message, createdAt: Date.now() },
          { id: 'remote-chat-assistant-' + turn, role: 'assistant', content: remoteChatReply, createdAt: Date.now() + 1 }
        ])
        if (request.headers.accept?.includes('text/event-stream')) {
          response.setHeader('content-type', 'text/event-stream')
          response.end('id: remote-ui-' + turn + ':1\ndata: ' + JSON.stringify({ content: remoteChatReply }) +
            '\n\nevent: done\nid: remote-ui-' + turn + ':2\ndata: [DONE]\n\n')
        } else {
          response.end(JSON.stringify({ code: 200, message: 'ok', data: { reply: remoteChatReply } }))
        }
        return
      }
      const data = fixtureData(path, sessionId)
      response.end(JSON.stringify({ code: 200, message: 'ok', data }))
    })
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await launchApp()
    const safeStorageAvailable = await app!.evaluate(
      ({ safeStorage }) => safeStorage.isEncryptionAvailable()
    )
    expect(safeStorageAvailable, '此真机验收要求系统 safeStorage 可用，不能以明文替代或跳过加密验收').toBe(true)
    await openEngineSettings()
  })

  test.afterAll(async () => {
    try {
      await closeApp()
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(done => server!.close(() => done()))
      }
      cleanFixture()
    }
  })

  test('通过设置输入令牌并保存重启，真实鉴权后才进入就绪', async () => {
    await expect.poll(async () => (await page.evaluate(
      () => window.aether.engine.getSnapshot()
    )).phase).toBe('idle')
    const remoteRow = page.locator('.sg__row').filter({
      has: page.locator('.sg__row-label', { hasText: /^远端服务$/ })
    })
    await remoteRow.click()
    await expect(remoteRow.getByRole('radio')).toHaveAttribute('aria-checked', 'true')
    const addressRow = page.locator('.sg__row').filter({
      has: page.locator('.sg__row-label', { hasText: /^远端地址$/ })
    })
    await addressRow.locator('input').fill(remoteUrl)
    await expect(page.getByLabel('远端令牌', { exact: true })).toHaveValue('')
    expect(await page.evaluate(() => window.aether.settings.remoteTokenStatus())).toMatchObject({
      configured: false,
      source: 'none'
    })
    await page.getByRole('switch', { name: '启动应用时自动连接引擎', exact: true }).click()
    await saveTokenAndExpect(correctToken, 'ready')
    const storedSettings = JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8'))
    expect(storedSettings).toMatchObject({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: true })
  })

  test('远端会话、历史和变更可真实加载，输入框可用且无映射拦截红错', async () => {
    const firstRequest = apiRequests.length
    const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
    if (await historyButton.getAttribute('aria-pressed') !== 'true') await historyButton.click()
    await expect(page.locator('.history-view')).toBeVisible()
    await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
    const historyRow = page.locator('button.history-view__item').filter({ hasText: historyTitle })
    await expect(historyRow).toBeVisible()
    await historyRow.click()
    await expect(page.locator('.chat-panel')).toContainText(historyTitle)
    await expect(page.locator('.chat-panel')).toContainText(historyReply)
    const chat = page.locator('.chat-panel')
    await expect(chat.locator('.chat__workspace')).toContainText('远端')
    await expect(chat.locator('.chat__input')).toHaveAttribute('contenteditable', 'true')
    await expect(chat.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(chat.getByRole('button', { name: '重新发送', exact: true })).toBeDisabled()
    await expect(chat.getByRole('button', { name: '重新生成', exact: true })).toBeDisabled()
    await expect.poll(() => apiRequests.slice(firstRequest).some(request =>
      request.method === 'GET' && request.path === '/api/v1/changes' &&
      request.sessionId === historySessionId && request.accepted
    )).toBe(true)

    // The visible history uses /chat/snapshot; verify the separate history read contract
    // through the same real preload/main transport without replacing it.
    const history = await page.evaluate(sessionId => window.aether.engine.request({
      method: 'GET', path: '/conversation/history', query: { sessionId }
    }), historySessionId)
    expect(history.ok, history.message).toBe(true)
    expect(history.data).toEqual(historyRows)
    for (const path of ['/api/v1/conversation/sessions', '/api/v1/conversation/history', '/api/v1/changes']) {
      expect(apiRequests.slice(firstRequest).some(request =>
        request.method === 'GET' && request.path === path && request.accepted
      ), `Authenticated read reached external engine: ${path}`).toBe(true)
    }
    await expect(page.locator('.history-view__empty--error')).toHaveCount(0)
    await expect(page.locator('.changes-panel__error')).toHaveCount(0)
    await expect(page.locator('.history-view')).not.toContainText('加载失败')
    await expectNoPublicSecret()
    const screenshot = test.info().outputPath('remote-ready-history.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await test.info().attach('远端已连接与历史加载', { path: screenshot, contentType: 'image/png' })
    await openEngineSettings()
  })

  test('真实界面发送远端消息并显示 SSE 回答，继续会话保留服务端目录', async () => {
    const before = remoteChatBodies.length
    const chat = page.locator('.chat-panel')
    await chat.locator('.chat__input').fill('通过真实远端界面发送测试消息')
    await expect(chat.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await chat.getByRole('button', { name: '发送', exact: true }).click()
    await expect(chat).toContainText(remoteChatReply)
    await expect.poll(() => remoteChatBodies.length).toBe(before + 1)
    expect(remoteChatBodies[before]).toMatchObject({
      sessionId: historySessionId, message: '通过真实远端界面发送测试消息',
      workspacePaths: ['/srv/existing-project']
    })
    expect(remoteChatBodies[before]).not.toHaveProperty('attachments')
    expect(JSON.stringify(remoteChatBodies[before])).not.toContain(fixture)
    await expectNoPublicSecret()
    await openEngineSettings()
  })

  test('普通与流式 IPC 都净化本地上下文，新会话目录显式配置且旧沙箱不被覆盖', async () => {
    const marker = 'C:/local-private-project'
    const send = async (sessionId: string, streaming: boolean) => {
      const before = remoteChatBodies.length
      const result = await page.evaluate(async ({ sessionId, streaming, marker }) => {
        const body = {
          sessionId, message: 'remote path isolation fixture', model: 'remote-fixture-model',
          workspacePaths: [marker], attachments: [{ name: marker + '/private.txt' }],
          context: marker + '/context', contexts: [{ path: marker + '/another.txt' }],
          workingDirectory: marker, cwd: marker, env: { LOCAL_CONTEXT: marker }
        }
        if (!streaming) return { response: await window.aether.engine.request({ method: 'POST', path: '/chat', body }), events: [] }
        const streamId = 'remote-isolation-' + sessionId
        const events: Array<{ type: string; payload?: unknown; message?: string }> = []
        let finish: () => void = () => {}
        let terminalTimer = 0
        const terminal = new Promise<void>((resolve, reject) => {
          finish = resolve
          terminalTimer = window.setTimeout(() => reject(new Error('Terminal stream event was not delivered')), 10000)
        })
        const unsubscribe = window.aether.engine.onStreamEvent(event => {
          if (event.streamId === streamId) {
            events.push(event)
            if (event.type === 'done' || event.type === 'error') finish()
          }
        })
        try {
          await Promise.all([terminal, window.aether.engine.stream.start({ streamId, path: '/chat', body })])
          return { response: null, events }
        } finally { window.clearTimeout(terminalTimer); unsubscribe() }
      }, { sessionId, streaming, marker })
      if (streaming) {
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'payload', payload: { content: remoteChatReply } }))
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'done' }))
        expect(result.events.some(event => event.type === 'error')).toBe(false)
      } else {
        expect(result.response?.ok, result.response?.message).toBe(true)
        expect(result.response?.data).toEqual({ reply: remoteChatReply })
      }
      expect(remoteChatBodies.length).toBe(before + 1)
      const captured = remoteChatBodies[before]
      expect(JSON.stringify(captured)).not.toContain(marker)
      expect(Object.keys(captured).sort()).toEqual(['message', 'model', 'sessionId', 'workspacePaths'])
      return captured
    }
    const reconnectWithRoot = async (root: string) => {
      const snapshot = await page.evaluate(async (remoteWorkspaceRoot) => {
        await window.aether.settings.update({ remoteWorkspaceRoot })
        return window.aether.engine.restart()
      }, root)
      expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    }
    await reconnectWithRoot('')
    expect((await send('remote-new-default', false)).workspacePaths).toEqual([])
    await reconnectWithRoot('/srv/configured-project')
    expect((await send('remote-new-explicit', true)).workspacePaths).toEqual(['/srv/configured-project'])
    expect((await send(historySessionId, false)).workspacePaths).toEqual(['/srv/existing-project'])
    expect((await send('remote-existing-sandbox', true)).workspacePaths).toEqual([])
    await reconnectWithRoot('')
    await expectNoPublicSecret()
    await openEngineSettings()
  })

  test('页面 reload 后保持已配置且输入为空，重新握手仍能读取密文', async () => {
    await page.reload()
    await expect(page.locator('.status-bar')).toBeVisible()
    await observeRenderer()
    await openEngineSettings()
    await expectStoredCredential()
    const firstProbe = probes.length
    await page.getByRole('button', { name: '重启', exact: true }).click()
    await expect.poll(() => probes.length).toBeGreaterThan(firstProbe)
    await expectPhase('ready')
    expect(probes.slice(firstProbe)).toContainEqual({ token: correctToken, accepted: true })
    await expectNoPublicSecret()
  })

  test('完整应用重启后自动连接，令牌仍已配置且不回显', async () => {
    await closeApp()
    const firstProbe = probes.length
    await launchApp()
    await openEngineSettings()
    await expect.poll(() => probes.length).toBeGreaterThan(firstProbe)
    await expectPhase('ready')
    expect(probes.slice(firstProbe)).toContainEqual({ token: correctToken, accepted: true })
    await expectStoredCredential()
    await expectNoPublicSecret()
  })

  test('普通设置落盘失败时回滚密文和连接配置，不重启现有连接', async () => {
    await openEngineSettings()
    await expectStoredCredential()
    const originalSettings = await page.evaluate(() => window.aether.settings.get())
    const originalSnapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(originalSnapshot.phase).toBe('ready')
    const originalTokenBytes = readFileSync(tokenFile())
    const settingsFile = join(fixture, 'settings.json')
    const backupFile = join(fixture, 'settings.rollback-backup.json')
    const originalSettingsBytes = readFileSync(settingsFile)
    const firstProbe = probes.length
    const replacementUrl = remoteUrl.replace('127.0.0.1', 'localhost')
    expect(replacementUrl).not.toBe(originalSettings.remoteBaseUrl)

    // Fault injection is confined to this run's userData. Preserve the original file
    // and create an empty directory at its path to make the real atomic rename fail.
    expect(dirname(fixture)).toBe(fixtureRoot)
    expect(basename(fixture)).toMatch(/^remote-token-ui-/)
    expect(dirname(settingsFile)).toBe(fixture)
    expect(dirname(backupFile)).toBe(fixture)
    expect(existsSync(backupFile)).toBe(false)
    let backedUp = false
    let blockingDirectory = false
    try {
      renameSync(settingsFile, backupFile)
      backedUp = true
      mkdirSync(settingsFile)
      blockingDirectory = true
      const address = page.locator('.sg__row').filter({
        has: page.locator('.sg__row-label', { hasText: /^远端地址$/ })
      }).locator('input')
      await address.fill(replacementUrl)
      await page.getByLabel('远端令牌', { exact: true }).fill(rollbackToken)
      const save = page.getByRole('button', { name: '保存并重启', exact: true })
      await save.click()
      const failure = page.locator('.app-settings .settings-view__actions .settings-view__error')
      await failure.scrollIntoViewIfNeeded()
      await expect(failure).toBeVisible()
      await expect(failure).toContainText(/rename/i)
      await expect(failure).toContainText('settings.json')
      await expect(save).toBeEnabled()
      await expect(page.locator('.app-settings .settings-view__saved')).toHaveCount(0)

      expect(readFileSync(tokenFile()).equals(originalTokenBytes)).toBe(true)
      const cachedSettings = await page.evaluate(() => window.aether.settings.get())
      expect(cachedSettings.remoteBaseUrl).toBe(originalSettings.remoteBaseUrl)
      expect(cachedSettings.engineMode).toBe(originalSettings.engineMode)
      expect(cachedSettings.preferredPort).toBe(originalSettings.preferredPort)
      expect(cachedSettings.autoStartEngine).toBe(originalSettings.autoStartEngine)
      expect(await page.evaluate(() => window.aether.engine.getSnapshot())).toMatchObject({
        phase: 'ready',
        baseUrl: originalSnapshot.baseUrl,
        updatedAt: originalSnapshot.updatedAt
      })
      expect(probes.length, '保存失败不得发起新的引擎握手').toBe(firstProbe)
    } finally {
      // Never recursively remove the blocker: unexpected contents must stop cleanup.
      if (blockingDirectory) rmdirSync(settingsFile)
      if (backedUp) renameSync(backupFile, settingsFile)
    }
    expect(readFileSync(settingsFile).equals(originalSettingsBytes)).toBe(true)
    await expectNoPublicSecret()

    await page.reload()
    await expect(page.locator('.status-bar')).toBeVisible()
    await observeRenderer()
    await openEngineSettings()
    const address = page.locator('.sg__row').filter({
      has: page.locator('.sg__row-label', { hasText: /^远端地址$/ })
    }).locator('input')
    await expect(address).toHaveValue(originalSettings.remoteBaseUrl)
    await expectStoredCredential()
    const beforeRestart = probes.length
    await page.getByRole('button', { name: '重启', exact: true }).click()
    await expect.poll(() => probes.length).toBeGreaterThan(beforeRestart)
    await expectPhase('ready')
    expect(probes.slice(beforeRestart)).toContainEqual({ token: correctToken, accepted: true })
    expect(probes.slice(beforeRestart).every(probe => probe.token === correctToken)).toBe(true)
    expect(readFileSync(tokenFile()).equals(originalTokenBytes)).toBe(true)
    await expectNoPublicSecret()
  })

  test('替换为错误令牌时认证失败，恢复正确令牌后重新就绪', async () => {
    await saveTokenAndExpect(incorrectToken, 'error')
    const failed = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(failed.error).toMatch(/令牌|凭据/)
    await expect(page.locator('.app-settings .settings-view__error')).toContainText(/令牌|凭据/)
    const screenshot = test.info().outputPath('remote-token-authentication-error.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await test.info().attach('错误令牌的阶段与可见提示', { path: screenshot, contentType: 'image/png' })
    await saveTokenAndExpect(correctToken, 'ready')
  })

  test('清除并重启后不发送旧令牌，完整应用重启也不会复活凭据', async () => {
    await expectStoredCredential()
    let firstProbe = probes.length
    await page.getByRole('button', { name: '清除令牌', exact: true }).click()
    await page.getByRole('button', { name: '保存并重启', exact: true }).click()
    await expect.poll(() => probes.length).toBeGreaterThan(firstProbe)
    await expectPhase('error')
    expect(probes.slice(firstProbe).every(probe => probe.token === undefined && !probe.accepted)).toBe(true)
    expect(await page.evaluate(() => window.aether.settings.remoteTokenStatus())).toMatchObject({
      configured: false,
      source: 'none'
    })
    await expect(page.getByLabel('远端令牌', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: '清除令牌', exact: true })).toHaveCount(0)
    await expect.poll(() => existsSync(tokenFile())).toBe(false)
    await expectNoPublicSecret()

    await closeApp()
    firstProbe = probes.length
    await launchApp()
    await openEngineSettings()
    await expect.poll(() => probes.length).toBeGreaterThan(firstProbe)
    await expectPhase('error')
    expect(probes.slice(firstProbe).every(probe => probe.token === undefined && !probe.accepted)).toBe(true)
    expect(await page.evaluate(() => window.aether.settings.remoteTokenStatus())).toMatchObject({
      configured: false,
      source: 'none'
    })
    await expect(page.getByLabel('远端令牌', { exact: true })).toHaveValue('')
    expect(existsSync(tokenFile())).toBe(false)
    await expectNoPublicSecret()
  })
})
