/** Fresh Electron coverage: muted Work file/task/ordinary targets in both themes;
 * receipt details prefer above, fall below near the top, fit narrow windows,
 * and close with Escape without opening files or changing conversation state. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'process-muted-hover-fixture', sessionId = 'work-process-muted-hover-session', modelId = 'process-muted-hover-model'
const title = '过程名称与详情位置核对', remoteRoot = '/remote/process-muted-hover', now = Date.now() - 10_000
const paths = ['需求核对说明.md', '工作区交互实现.tsx', '回归测试检查清单.json'].map(name => `${remoteRoot}/delivery/review/${name}`)
const directory = `${remoteRoot}/ordinary-target`
const answer = '正文保持正常阅读颜色，文件、任务与操作目标使用辅助颜色。'
// Real text supplies scrollable conversation space, without changing product geometry.
const prompt = [title, '检查三个源文件。', '新建一个实现文件。', '安排一个调研任务。', '复核工作区目录。', '保留最终结果。', '核对明暗两种主题。', '检查浮窗方向。'].join('\n')
const finalAnswer = [answer, ...Array.from({ length: 12 }, (_, index) => `验收记录 ${index + 1}：所有步骤均已完成，完整结果保留在正文中，过程详情按需查看。`)].join('\n\n')
const run: RootRun = { schemaVersion: 1, runId: 'muted-hover-run', sessionId, turnId: 'muted-hover-turn',
  userMessageId: 'muted-hover-user', assistantMessageId: 'muted-hover-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now + 20, finishedAt: now + 20 }
const change: EngineFileChange = { id: 'muted-new-file', sessionId, turnId: run.turnId, runId: run.runId,
  path: `${remoteRoot}/new-review.ts`, kind: 'write', oldContent: null, newContent: 'export const review = true;\n',
  isNew: true, oldHash: 'missing', truncated: false, status: 'pending', createdAt: now + 4, toolCallId: 'muted-write' }
const child: SubagentRunView = { schemaVersion: 2, view: 'summary', runId: 'muted-child-run', tenantId: 'muted-hover-tenant',
  rootSessionId: sessionId, parentSessionId: sessionId, parentConversationId: run.turnId, parentMessageId: 'call-muted-child',
  parentToolCallId: 'muted-child', childSessionId: 'muted-child-session', agentName: '交互调研', task: '核对工作区的文件名称与浮窗信息层级。',
  description: '交互调研', modelId, status: 'succeeded', lastSeq: 1, createdAt: now + 5, updatedAt: now + 6,
  startedAt: now + 5, finishedAt: now + 6, resultSummary: '调研完成，过程与正文的信息层级清晰。', stopReason: 'completed',
  continuation: { builtinRole: 'research', builtinRoleVersion: 1, readOnly: true }, usage: { totalTokens: 128 }, toolCount: 0, activeToolCount: 0, toolCalls: [],
  coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
    ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
const secondChild: SubagentRunView = { ...child, runId: 'muted-child-run-2', parentMessageId: 'call-muted-child-2',
  parentToolCallId: 'muted-child-2', childSessionId: 'muted-child-session-2', agentName: '结果核对', task: '核对调研结果的完整性。' }
const children = [child, secondChild]
const metadata = { rootRunId: run.runId, turnId: run.turnId }
const history: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: prompt, createdAt: now, conversationId: run.turnId, metadata }]
function addTool(id: string, name: string, args: Record<string, unknown>, result: unknown, extra: Record<string, unknown> = {}): void {
  const at = now + history.length
  history.push({ id: `call-${id}`, role: 'assistant', content: '', createdAt: at, conversationId: run.turnId, metadata, toolCall: { id, name, args } },
    { id: `result-${id}`, role: 'tool', toolCallId: id, content: typeof result === 'string' ? result : JSON.stringify(result),
      success: true, createdAt: at + 1, conversationId: run.turnId, metadata: { ...metadata, success: true, ...extra } })
}
addTool('muted-read', 'read_file', { files: paths.map(path => ({ path })) }, { batch: true, files: paths.map(path => ({ path, success: true,
  output: { path, expectedHash: `sha256:${'a'.repeat(64)}`, encoding: 'utf-8', lineEnding: 'LF', utf8Bom: false,
    startLine: 1, endLine: 12, totalLines: 24, content: 'SOURCE_CONTENT_STAYS_AVAILABLE' } })) })
addTool('muted-write', 'write_file', { path: change.path, content: change.newContent }, '文件已创建', { change })
addTool('muted-child', 'subagent_start', { builtinRole: 'research', task: child.task }, { started: true, runId: child.runId }, { subagent: child })
addTool('muted-child-2', 'subagent_start', { builtinRole: 'research', task: secondChild.task }, { started: true, runId: secondChild.runId }, { subagent: secondChild })
// Identical adjacent directory receipts exercise the ordinary grouped target too.
addTool('muted-directory-1', 'list_directory', { path: directory }, { entries: ['review.ts'] })
addTool('muted-directory-2', 'list_directory', { path: directory }, { entries: ['review.ts'] })
history.push({ id: run.assistantMessageId, role: 'assistant', content: finalAnswer, createdAt: now + 20, conversationId: run.turnId, metadata })

const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  const matching = id === sessionId, rows = matching ? history : []
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (path === '/api/v1/workspace/file/content') throw new Error('Hover must not open workspace files')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Read-only receipt inspection must not mutate ${path}`)
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: matching ? [{ userMessageId: run.userMessageId,
      conversationId: run.turnId, preview: prompt, createdAt: now }] : [], messages: rows, loadedTurnIds: matching ? [run.userMessageId] : [],
      revision: 'muted-hover-history', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const childDetail = children.find(item => path === `/api/v1/subagent/runs/${item.runId}`)
  if (childDetail) { response.end(envelope(childDetail)); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'muted-hover-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '过程样式核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: matching ? run : undefined, runs: matching ? [run] : [], subagentRuns: matching ? children : [], todos: [], changes: matching ? [change] : [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching ? run : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history.length }]
    : path === '/api/v1/changes' ? matching ? [change] : []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'muted-hover-tenant', sessionId: id,
      namespace: { id: 'muted-hover-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: matching ? children : [], listComplete: true, hasMore: false, revision: 'muted-hover-runs' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

async function screenshot(name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}
async function theme(appearance: 'light' | 'dark'): Promise<void> {
  if (await page.locator('html').getAttribute('data-appearance') === appearance) return
  await page.keyboard.press('Escape'); await page.mouse.move(4, 4)
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const settings = page.locator('.modal[aria-label="设置"]')
  await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click(); await expect(settings).toHaveCount(0)
}
async function prepare(width = 1440): Promise<void> {
  await page.keyboard.press('Escape'); await page.mouse.move(4, 4)
  if (!app) throw new Error('Electron application missing')
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
  const toggle = page.locator('.work-conversation .work-message__process-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await expect(page.locator('[data-work-tool-id="muted-read"] button.logline')).toBeVisible()
  const scroll = page.locator('.work-conversation__scroll')
  // The conversation follows layout changes until a real reading gesture pauses
  // it. Assigning scrollTop alone is not that gesture and can be overwritten.
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  const bottom = await scroll.evaluate(element => element.scrollTop)
  expect(bottom).toBeGreaterThan(0)
  await scroll.hover({ position: { x: 8, y: 16 } }); await page.mouse.wheel(0, -1200)
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  await page.locator('.work-message__process-viewport').evaluate(element => { element.scrollTop = 0 })
  await expect.poll(() => batchHeader().evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(174)
}
function batchHeader(): Locator { return page.locator('[data-work-tool-id="muted-read"] button.logline') }
async function closeTooltip(): Promise<void> {
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0); await page.mouse.move(4, 4)
}
async function assertWithinViewport(tooltip: Locator): Promise<void> {
  const box = await tooltip.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
  })
  expect(box.left).toBeGreaterThanOrEqual(7); expect(box.top).toBeGreaterThanOrEqual(7)
  expect(box.right).toBeLessThanOrEqual(box.width - 7); expect(box.bottom).toBeLessThanOrEqual(box.height - 7)
}
async function hoverAbove(header: Locator): Promise<Locator> {
  await closeTooltip()
  await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(174)
  const tooltip = page.getByRole('tooltip')
  // Scrolling intentionally dismisses details. Re-enter after any trailing
  // wheel/resize scroll instead of treating its dismissal as a placement failure.
  await expect(async () => {
    await page.mouse.move(4, 4); await header.hover()
    await expect(tooltip).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 6000 })
  await expect(tooltip).toHaveAttribute('data-placement', 'above')
  const anchor = await header.boundingBox(), panel = await tooltip.boundingBox()
  if (!anchor || !panel) throw new Error('Missing real receipt geometry')
  expect(anchor.y).toBeGreaterThan(174)
  expect(panel.y + panel.height).toBeLessThanOrEqual(anchor.y - 5)
  await assertWithinViewport(tooltip)
  return tooltip
}
async function hoverNearTop(): Promise<Locator> {
  await closeTooltip()
  const header = batchHeader()
  await header.evaluate(element => {
    const scroll = element.closest<HTMLElement>('.work-conversation__scroll')
    if (!scroll) throw new Error('Conversation scroll area missing')
    scroll.scrollTop += element.getBoundingClientRect().top - (scroll.getBoundingClientRect().top + 8)
  })
  await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(174)
  await header.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible(); await expect(tooltip).toHaveAttribute('data-placement', 'below')
  const anchor = await header.boundingBox(), panel = await tooltip.boundingBox()
  if (!anchor || !panel) throw new Error('Missing fallback geometry')
  expect(anchor.y - 14).toBeLessThan(160)
  expect(panel.height).toBeGreaterThan(anchor.y - 14)
  expect(panel.y).toBeGreaterThanOrEqual(anchor.y + anchor.height + 5)
  await assertWithinViewport(tooltip)
  for (const path of paths) await expect(tooltip).toContainText(path)
  return tooltip
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'process-muted-hover-profile-'))
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
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await screenshot('process-muted-hover-failure', info)
  await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('process-muted-hover-profile-')) throw new Error('Unsafe muted-hover fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('明暗主题：文件、任务、新文件和普通目标使用 muted，正文保持原色', async ({}, info) => {
  for (const appearance of ['light', 'dark'] as const) {
    await theme(appearance); await prepare()
    const colors = await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.display = 'none'; document.documentElement.append(probe)
      probe.style.color = 'var(--fg-muted)'; const muted = getComputedStyle(probe).color
      probe.style.color = 'var(--fg)'; const foreground = getComputedStyle(probe).color
      probe.remove(); return { muted, foreground }
    })
    expect(colors.muted).not.toBe(colors.foreground)
    const files = page.locator('[data-work-tool-id="muted-read"] .logline__file-name')
    await expect(files).toHaveText(paths.map(path => path.split('/').at(-1)!))
    const newFile = page.locator('.work-file-change-row__name'), tasks = page.locator('.work-subagent-card--compact .work-subagent-card__name')
    const target = page.locator('.work-activity-group__target')
    await expect(newFile).toHaveText('new-review.ts'); await expect(tasks).toHaveText(['交互调研', '结果核对'])
    await expect(page.locator('.work-file-change-row__action')).toHaveText('新建文件')
    await expect(target).toContainText('ordinary-target')
    for (const item of [...await files.all(), newFile, ...await tasks.all(), target]) await expect(item).toHaveCSS('color', colors.muted)
    const body = page.locator('.work-message__answer').getByText(answer, { exact: true })
    await expect(body).toBeVisible(); await expect(body).toHaveCSS('color', colors.foreground)
    await expect(page.locator('.work-file-change-row__stats')).toHaveAttribute('aria-label', '新增 1 行，删除 0 行')
    await screenshot(`process-muted-${appearance}`, info)
  }
})

test('明暗主题：三类过程详情默认向上，顶部空间不足向下，Escape 关闭', async ({}, info) => {
  for (const appearance of ['light', 'dark'] as const) {
    await theme(appearance); await prepare()
    const read = batchHeader()
    const tooltip = await hoverAbove(read)
    for (const path of paths) await expect(tooltip).toContainText(path)
    await expect(read).toHaveAttribute('aria-expanded', 'false')
    await screenshot(`process-hover-above-${appearance}`, info)
    await closeTooltip()
    await hoverAbove(page.locator('.work-file-change-row')); await expect(page.getByRole('tooltip')).toContainText(change.path)
    await closeTooltip()
    await hoverAbove(page.locator('.work-subagent-card--compact .work-subagent-card__open').first())
    await expect(page.getByRole('tooltip')).toContainText(child.task)
    await closeTooltip(); await hoverNearTop(); await screenshot(`process-hover-below-${appearance}`, info)
    await closeTooltip(); await expect(read).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.work-message__answer')).toContainText(answer)
  }
})

test('窄窗口：明暗详情边界保持在屏内，完整文件信息可查看并可关闭', async ({}, info) => {
  for (const appearance of ['light', 'dark'] as const) {
    await theme(appearance); await prepare(620)
    const tooltip = await hoverAbove(batchHeader())
    for (const path of paths) await expect(tooltip).toContainText(path)
    await screenshot(`process-hover-narrow-above-${appearance}`, info)
    await closeTooltip(); await hoverNearTop(); await screenshot(`process-hover-narrow-below-${appearance}`, info)
    await closeTooltip(); await expect(batchHeader()).toHaveAttribute('aria-expanded', 'false')
  }
})
