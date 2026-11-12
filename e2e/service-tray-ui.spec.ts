/** Real Electron service tray: no log polling, acknowledged stop, unread/read menus,
 * and exact terminal reveal. Uses an isolated remote HTTP fixture/profile, never a model.
 * Build first. Run serially with the other Electron specs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'service-tray-fixture', taskId = 'work-service-tray-task', jobId = 'service-tray-job', model = 'service-tray-model'
const title = '服务与通知验收', now = Date.now() - 5000
const errors: string[] = [], actions: { path: string; sessionId: string }[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', outputReads = 0
let releaseStop: (() => void) | undefined
let stopGate: Promise<void> | undefined
let deletions = 0
let job: CommandJobSnapshot = { schemaVersion: 1, jobId, sessionId: taskId, ownerSessionId: taskId,
  version: 1, status: 'running', command: 'node', args: ['fixture-service.js'], cwd: '/service-tray-fixture',
  background: true, createdAt: now, updatedAt: now, exitCode: null, signal: null, cursor: 1, earliestCursor: 0 }
const run = { schemaVersion: 1, runId: 'service-tray-run', sessionId: taskId, turnId: 'service-tray-turn',
  userMessageId: 'service-tray-user', assistantMessageId: 'service-tray-assistant', seq: 1, version: 2,
  status: 'succeeded', modelId: model, pending: [], workspacePaths: ['/service-tray-fixture'], createdAt: now, updatedAt: now, finishedAt: now }
const history = [{ id: run.userMessageId, role: 'user', content: title, conversationId: run.turnId, createdAt: now },
  { id: run.assistantMessageId, role: 'assistant', content: '后台服务已启动。', conversationId: run.turnId, createdAt: now + 1 }]
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing fixture token: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const sessionId = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : '')
  if (path === `/api/v1/command-jobs/${jobId}/cancel`) {
    if (request.method !== 'POST' || sessionId !== taskId) throw new Error('Wrong cancellation owner or method')
    actions.push({ path, sessionId })
    if (stopGate) await stopGate
    job = { ...job, version: job.version + 1, status: 'cancelled', updatedAt: Date.now(), finishedAt: Date.now(), exitCode: 0,
      error: { code: 'COMMAND_CANCELLED', message: 'Cancelled by user' } }
    response.end(envelope(job)); return
  }
  if (path === `/api/v1/command-jobs/${jobId}/output`) {
    if (sessionId !== taskId) throw new Error('Wrong output owner')
    outputReads++
    const cursor = Number(url.searchParams.get('cursor') ?? 0)
    response.end(envelope({ job, entries: cursor ? [] : [{ seq: 1, stream: 'stdout', text: 'SERVICE_TRAY_LOG\n' }],
      nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false })); return
  }
  if (path === `/api/v1/command-jobs/${jobId}`) {
    if (request.method === 'DELETE') {
      if (sessionId !== taskId || job.status === 'running') throw new Error('Wrong delete owner or active command')
      deletions++; response.end(envelope({ deleted: true })); return
    }
    response.end(envelope(job)); return
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: run.userMessageId, conversationId: run.turnId, preview: title, createdAt: now }],
      messages: history, loadedTurnIds: [run.userMessageId], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected write: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'9'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '服务测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history, projection: [], run, runs: [run], subagentRuns: [], todos: [], changes: [], commandJobs: [job] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [run] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'service-tray-fixture', sessionId,
      namespace: { id: 'service-tray-fixture-db', generation: 'one' },
      transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/history' ? history
    : path === '/api/v1/conversation/sessions' ? [{ sessionId: taskId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: '/service-tray-fixture', bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/service-tray-fixture' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [job] }
    : path === '/api/v1/plugins' ? { plugins: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const tray = () => page.locator('.service-tray__panel')
const entry = () => page.locator('.service-tray__button')
const row = () => tray().locator('.service-tray__row[data-service-id="command:service-tray-job"]')
async function settleSurface(selector: string): Promise<void> {
  await page.locator(selector).evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
}
async function openTray(): Promise<void> {
  if (!(await tray().isVisible())) await entry().click()
  await expect(tray()).toBeVisible()
}

test.describe.serial('服务托盘真实动作与通知', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'service-tray-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: '/service-tray-fixture', autoStartEngine: true,
      lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, taskId, title, now, model }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: [{ id: taskId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: '/service-tray-fixture', modelId: model, attachments: [], sources: [] }], activeTaskId: taskId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { stateKey, taskId, title, now, model })
    await page.reload()
    await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: /Admission response|Admission.*object/ })).toHaveCount(0)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('service-tray-failure.png') })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseStop?.()
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('service-tray-profile-')) throw new Error(`Unsafe service fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('紧凑图标打开服务，查看详情不读取完整日志；右键停止等待真实回执', async ({}, info) => {
    await expect(entry()).toHaveAccessibleName('服务与通知，1 个运行中')
    await expect(entry()).not.toHaveText(/运行|服务|通知/)
    await openTray()
    await expect(row()).toContainText('运行中')
    await row().getByRole('button', { name: /^node/ }).click()
    await expect(tray().locator('.service-tray__detail')).toContainText('fixture-service.js')
    expect(outputReads).toBe(0)
    await tray().getByRole('button', { name: '返回活动列表', exact: true }).click()
    for (const appearance of ['light', 'dark'] as const) {
      await tray().getByRole('button', { name: '关闭服务与通知', exact: true }).click()
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(settings).toBeHidden()
      await openTray()
      await expect(page.locator('.service-tray__popover')).toHaveClass(/is-positioned/)
      await settleSurface('.service-tray__popover')
      const panelPath = info.outputPath(`service-panel-${appearance}.png`)
      await page.screenshot({ path: panelPath }); await info.attach(`服务面板 ${appearance}`, { path: panelPath, contentType: 'image/png' })
      await row().click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: '停止', exact: true })).toBeVisible()
      await settleSurface('.context-menu')
      await expect(page.locator('.context-menu')).toHaveAttribute('data-motion-state', 'open')
      await page.getByRole('menuitem', { name: '停止', exact: true }).click({ trial: true })
      const menuPath = info.outputPath(`service-menu-${appearance}.png`)
      await page.screenshot({ path: menuPath }); await info.attach(`服务菜单 ${appearance}`, { path: menuPath, contentType: 'image/png' })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menuitem', { name: '停止', exact: true })).toBeHidden()
    }
    stopGate = new Promise<void>(done => { releaseStop = done })
    // Deliberately reopen at identical coordinates before the former exit completes.
    // Waiting for DOM removal here would hide the product's rapid-reopen regression.
    await row().click({ button: 'right' })
    await expect(page.locator('.context-menu')).not.toHaveAttribute('aria-hidden', 'true')
    await page.getByRole('menuitem', { name: '停止', exact: true }).click()
    await expect.poll(() => actions).toEqual([{ path: `/api/v1/command-jobs/${jobId}/cancel`, sessionId: taskId }])
    expect(job.status).toBe('running')
    await expect(row()).toContainText('运行中')
    releaseStop?.(); stopGate = undefined
    await expect(row()).toContainText('已停止')
    await expect(entry()).toHaveAccessibleName('服务与通知，0 个运行中，1 条未读')
    expect(outputReads).toBe(0)
  })

  test('通知可查看详情、标未读、全部已读和清除，清除后同状态不再重现', async () => {
    await tray().getByRole('tab', { name: /^通知/ }).click()
    await expect(row()).toHaveAttribute('data-unread', 'true')
    await row().getByRole('button', { name: /^未读/ }).click()
    await expect(entry()).toHaveAccessibleName('服务与通知，0 个运行中')
    await tray().getByRole('button', { name: '返回活动列表', exact: true }).click()
    await row().locator('.service-tray__row-main').focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: '标为未读', exact: true }).click()
    await expect(row()).toHaveAttribute('data-unread', 'true')
    await tray().getByRole('button', { name: '全部标为已读', exact: true }).click()
    await expect(row()).toHaveAttribute('data-unread', 'false')
    await tray().getByRole('button', { name: '清除已读通知', exact: true }).click()
    await expect(tray()).toContainText('暂无通知')
    await tray().getByRole('tab', { name: '服务', exact: true }).click()
    await expect(row()).toContainText('已停止')
    expect(job.status).toBe('cancelled')
    expect(outputReads).toBe(0)
  })

  test('服务菜单真实打开对应终端输出，关闭服务浮层并保留会话归属', async () => {
    await row().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在终端中查看', exact: true }).click()
    await expect(tray()).toBeHidden()
    const terminal = page.locator('.work-terminal-panel')
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-session-id', taskId)
    await expect(terminal.locator('.work-terminal-panel__detail')).toHaveAttribute('data-job-id', jobId)
    await expect(terminal.locator('.work-terminal-panel__output')).toContainText('SERVICE_TRAY_LOG')
    expect(outputReads).toBeGreaterThan(0)
  })

  test('终端删除历史后，旧列表快照不会复活服务或通知', async () => {
    await page.locator('.work-terminal-panel__detail').getByRole('button', { name: '删除服务历史', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '删除后台运行记录', exact: true })
    await confirmation.getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletions).toBe(1)
    await expect(page.locator(`.work-terminal-panel__job[data-job-id="${jobId}"]`)).toHaveCount(0)
    await openTray()
    const back = tray().getByRole('button', { name: '返回活动列表', exact: true })
    if (await back.isVisible()) await back.click()
    await tray().getByRole('tab', { name: '服务', exact: true }).click()
    await expect(row()).toHaveCount(0)
    await expect(tray()).toContainText('暂无后台服务')
    await tray().getByRole('tab', { name: /^通知/ }).click()
    await expect(tray()).toContainText('暂无通知')
  })
})
