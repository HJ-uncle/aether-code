/** New isolated Electron coverage: Work's composer keeps its neutral
 * border and gains a soft editing shadow without an outer ring, with local toolbar
 * focus. Both themes are captured; no messages, uploads or exports are sent. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'composer-soft-fixture', sessionId = 'work-composer-soft', modelId = 'composer-soft-model'
const title = '输入框焦点样式核对', remoteRoot = '/remote/composer-soft'
const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Focus inspection must not send or mutate ${path}`)
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'composer-soft-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '输入焦点核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [],
      revision: 'composer-soft-empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'composer-soft-tenant', sessionId: id,
      namespace: { id: 'composer-soft-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}
async function theme(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const settings = page.locator('.modal[aria-label="设置"]')
  await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click(); await expect(settings).toHaveCount(0)
}
async function assertEditorFocus(shell: Locator, editor: Locator, border: string, shadow: string): Promise<void> {
  await expect(editor).toBeFocused()
  await expect(shell).toHaveCSS('border-top-color', border)
  await expect(shell).toHaveCSS('box-shadow', shadow)
  await expect(editor).toHaveCSS('outline-style', 'none')
  await expect(editor).toHaveCSS('box-shadow', 'none')
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'composer-soft-profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: remoteRoot, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, modelId, remoteRoot }) => {
    const now = Date.now()
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'draft', draft: '', createdAt: now,
      updatedAt: now, workspacePath: remoteRoot, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, modelId, remoteRoot })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot('composer-soft-failure', info)
  await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('composer-soft-profile-')) throw new Error('Unsafe composer fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Work 办公：明暗编辑焦点保持中性边框与柔和阴影，工具栏独立聚焦', async ({}, info) => {
  const shell = page.locator('.work-view .input-composer'), editor = shell.locator('.input-composer__input')
  await expect(shell).toHaveCount(1); await expect(editor).toBeVisible()
  await editor.fill('请检查这段输入的焦点样式，保留草稿，不发送。')
  for (const appearance of ['light', 'dark'] as const) {
    await theme(appearance)
    // Closing Settings can restore focus to the contenteditable; move focus
    // to a stable chrome control before asserting the resting state.
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).focus()
    await expect(editor).not.toBeFocused()
    const styles = await shell.evaluate(element => {
      const style = getComputedStyle(element), token = style.getPropertyValue('--composer-focus-shadow').trim()
      const probe = document.createElement('span'); probe.style.display = 'none'; element.append(probe)
      probe.style.borderColor = 'var(--input-border)'; const border = getComputedStyle(probe).borderTopColor
      probe.style.boxShadow = 'var(--shadow-card)'; const restingShadow = getComputedStyle(probe).boxShadow
      probe.style.boxShadow = 'var(--composer-focus-shadow)'; const focusedShadow = getComputedStyle(probe).boxShadow
      probe.remove(); return { token, border, restingShadow, focusedShadow }
    })
    expect(styles.token).not.toBe(''); expect(styles.focusedShadow).not.toBe(styles.restingShadow)
    expect(styles.focusedShadow).not.toBe('none')
    const layers = styles.focusedShadow.replace(/(?:rgba?|hsla?|color)\([^)]*\)/g, '').split(',')
      .map(layer => [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1])))
    expect(layers.length).toBeGreaterThan(0)
    for (const layer of layers) {
      expect(layer.length).toBeGreaterThanOrEqual(3)
      expect(layer[2] === 0 && (layer[3] ?? 0) > 0).toBe(false)
    }
    await expect(shell).toHaveCSS('border-top-color', styles.border)
    await expect(shell).toHaveCSS('box-shadow', styles.restingShadow)
    await editor.click(); await assertEditorFocus(shell, editor, styles.border, styles.focusedShadow)
    await screenshot(`composer-soft-work-${appearance}-pointer`, info)

    const toolbarButton = shell.locator('.input-composer__toolbar button:enabled').first()
    await toolbarButton.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
    await expect(toolbarButton).toBeFocused()
    const localFocus = await toolbarButton.evaluate(element => {
      const style = getComputedStyle(element)
      return { visible: element.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), shadow: style.boxShadow }
    })
    expect(localFocus.visible).toBe(true)
    expect(localFocus.outline !== 'none' && localFocus.width > 0 || localFocus.shadow !== 'none').toBe(true)
    await expect(shell).toHaveCSS('border-top-color', styles.border); await expect(shell).toHaveCSS('box-shadow', styles.restingShadow)

    // Use actual reverse Tab navigation from the toolbar, including the polish
    // button when enabled, instead of synthesizing :focus-visible on the editor.
    for (let index = 0; index < 8 && !await editor.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    expect(await editor.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    await assertEditorFocus(shell, editor, styles.border, styles.focusedShadow)
    await screenshot(`composer-soft-work-${appearance}-keyboard`, info)
  }
})
