/** Real Electron, controlled HTTP: composer workspace authority/races, keyboard
 * disclosure, context usage/compaction and narrow layout; settled command receipts
 * respect process folding. Run through a serial config after building the app. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'composer-context-token', model = 'composer-context-model', now = Date.now() - 10_000
const taskA = 'work-composer-a', taskB = 'work-composer-b', taskHeld = 'work-composer-held'
const taskDraft = 'work-composer-draft', draftRoot = '/remote/chosen-draft-workspace'
const staleRoot = 'D:/stale-local-selection/not-the-remote-workspace'
const actualRoot = `/remote/actual-project/${'很长的项目工作区目录名-'.repeat(12)}final-project`
const roots = new Map([[taskA, actualRoot], [taskB, '/remote/actual-task-b'], [taskHeld, '/remote/late-task-path']])
const titles = new Map([[taskA, '工作区与命令折叠核对'], [taskB, '当前工作区 B'], [taskHeld, '等待目录回执的任务'], [taskDraft, '尚未发送的草稿任务']])
const errors: string[] = [], mutations: string[] = [], directoryReads: string[] = [], probes: string[] = []
const bindings: Array<{ sessionId: string; workspaceRoot: string; profile: string; bootstrap: boolean }> = []
const geometries: unknown[] = []
const contextSnapshots: Array<{ sessionId: string; phase: string; used: number }> = []
const usage = { currentPromptTokens: 113_300, contextWindow: 256_000, promptTokens: 450_000,
  completionTokens: 100, totalTokens: 450_100, contextUsageEstimated: false }
let codeBootstrapSession: string | undefined
let held: { response: ServerResponse; body: string } | undefined, holdDirectory = false
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const runs = new Map<string, RootRun>([...roots.keys()].map(id => [id, {
  schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`,
  assistantMessageId: `assistant-${id}`, seq: 1, version: 2, status: 'succeeded', modelId: model,
  pending: [], workspacePaths: [], createdAt: now, updatedAt: now, startedAt: now - 100, finishedAt: now
}]))
const jobs: CommandJobSnapshot[] = (['failed', 'cancelled'] as const).map((status, index) => ({
  schemaVersion: 1, jobId: `composer-job-${status}`, sessionId: taskA, ownerSessionId: taskA,
  runId: runs.get(taskA)!.runId, turnId: runs.get(taskA)!.turnId, toolCallId: `command-${status}`,
  version: 2, status, command: index ? 'node stopped-command.js' : 'node failed-command.js', args: [],
  cwd: actualRoot, background: true, createdAt: now - 100, updatedAt: now, finishedAt: now,
  exitCode: index ? null : 1, signal: index ? 'SIGTERM' : null, cursor: 1, earliestCursor: 0,
  error: index ? { code: 'COMMAND_CANCELLED', message: 'Stopped by cancel_command' }
    : { code: 'COMMAND_FAILED', message: 'FAILED_COMMAND_DIAGNOSTIC' }
}))
const finalText = 'FINAL_ANSWER_STAYS_VISIBLE：文件已整理完成，历史命令可在过程里核对。'
function history(id: string): EngineHistoryRow[] {
  const run = runs.get(id)
  if (!run) return []
  const metadata = { rootRunId: run.runId }, conversationId = run.turnId
  const rows: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: titles.get(id), conversationId, createdAt: now - 200, metadata }]
  if (id === taskA) for (const [index, job] of jobs.entries()) {
    rows.push({ id: `assistant-step-${index}`, role: 'assistant', content: '', conversationId, createdAt: now - 100 + index,
      metadata, toolCall: { id: job.toolCallId, name: 'execute_cmd', args: { command: job.command, background: true } } },
    { id: `tool-result-${index}`, role: 'tool', toolCallId: job.toolCallId, content: `RECEIPT_${job.status}`,
      conversationId, createdAt: now - 90 + index, metadata: { ...metadata, commandJob: job, success: false } })
  }
  rows.push({ id: run.assistantMessageId, role: 'assistant', content: id === taskA ? finalText : `任务结果：${titles.get(id)}`,
    conversationId, createdAt: now, metadata, modelId: model, ...(id === taskB ? { usage } : {}) })
  return rows
}
function releaseDirectory(): void {
  holdDirectory = false
  held?.response.end(held.body)
  held = undefined
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const id = url.searchParams.get('sessionId') ?? '', run = runs.get(id), rows = history(id)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    probes.push(`${request.method} ${path}`)
    response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Capability unavailable in this read-only fixture', data: null })); return
  }
  if (path === '/api/v1/workspace/bind' && request.method === 'POST') {
    const sessionId = String(body.sessionId ?? ''), workspaceRoot = String(body.workspaceRoot ?? ''), profile = String(request.headers['x-aether-tool-profile'] ?? '')
    // Retained Code boot owns a generated session and binds the configured
    // remote root before listing it (remoteWorkspaceContext). Work's saved
    // hints must never enter this path; even its first bind remains a failure.
    // Generic workspace requests follow the app's current profile after the
    // mode switch. The first Code request establishes the exact session/root
    // identity; a later general profile cannot authorize a different session.
    const bootstrap = workspaceRoot === '/remote/configured-default' &&
      (codeBootstrapSession ? sessionId === codeBootstrapSession && (profile === 'code' || profile === 'general')
        : profile === 'code' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(sessionId))
    bindings.push({ sessionId, workspaceRoot, profile, bootstrap })
    if (bootstrap) {
      codeBootstrapSession = sessionId
      response.end(envelope({ workspaceRoot })); return
    }
    mutations.push(`${request.method} ${path}`)
    throw new Error(`Unexpected binding ${JSON.stringify(bindings.at(-1))}`)
  }
  if (request.method !== 'GET' && (path === '/api/v1/chat' || path.startsWith('/api/v1/command-jobs'))) {
    mutations.push(`${request.method} ${path}`)
    throw new Error(`Displaying context must not change workspace or execute work: ${path}`)
  }
  if (request.method !== 'GET') { response.writeHead(404).end(envelope(null)); return }
  if (path === '/api/v1/workspace/directory') {
    directoryReads.push(id)
    const body = envelope({ root: roots.get(id) ?? '/remote/configured-default', bindingEpoch: `binding-${id}`, entries: [] })
    if (id === taskHeld && holdDirectory) {
      if (held) throw new Error('Expected one coalesced held directory request')
      held = { response, body }; return
    }
    response.end(body); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // A live compaction snapshot remains attached until navigation closes it.
    // Ending it would falsely turn the running fixture into a completed task.
    if (run?.status === 'running') response.write(': context compaction is active\n\n')
    else response.end('data: [DONE]\n\n')
    return
  }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-unchanged`, backend: 'jsonl', completeness: 'complete' })); return
  }
  const output = path.match(/^\/api\/v1\/command-jobs\/([^/]+)\/output$/)
  if (output) {
    const job = jobs.find(value => value.jobId === decodeURIComponent(output[1]) && value.sessionId === id)
    if (!job) throw new Error('Command output crossed task ownership')
    response.end(envelope({ job, entries: [{ seq: 1, stream: 'stdout', text: `OUTPUT_${job.status}` }],
      nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false })); return
  }
  if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(envelope(null)); return }
  const running = run?.status === 'running'
  if (path === '/api/v1/chat/snapshot' && id === taskB) {
    contextSnapshots.push({ sessionId: id, phase: run?.compaction?.phase ?? 'idle', used: usage.currentPromptTokens })
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'composer-context' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '工作区测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 256_000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: running ? 'live' : 'persisted',
      eventId: running ? `${id}-compaction:1` : null, finished: !running,
      history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: id === taskA ? jobs : [] }
    : path === '/api/v1/chat/status' ? { running, finished: !running, run, lastEventId: running ? `${id}-compaction:1` : null }
    : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'composer-context', sessionId: id,
      namespace: { id: 'composer-db', generation: 'one' }, transport: {
        toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
      runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(run), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: id === taskA ? jobs : [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const context = (): Locator => work().locator('.work-composer-workspace:visible')
const popup = (): Locator => page.getByRole('dialog', { name: '当前工作区', exact: true })
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function selectTask(id: string): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: titles.get(id)! }).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}
async function displayBoundary(): Promise<number> {
  // The Code root-list response completes its existing bootstrap bind. Do not
  // absorb a later Work mutation into a new baseline or wait for polling idle.
  await expect.poll(() => bindings.every(binding => binding.bootstrap && directoryReads.includes(binding.sessionId))).toBe(true)
  return bindings.length
}
async function seed(activeTaskId: string | null = taskA, homeWorkspacePath: string | null = null): Promise<void> {
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: id === taskDraft ? 'draft' : runs.get(id)?.status === 'running' ? 'running' : 'done', draft: '', createdAt: now, updatedAt: now,
    workspacePath: id === taskDraft ? draftRoot : staleRoot, modelId: model, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId, homeWorkspacePath }) => {
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId, homeWorkspacePath, homeDraft: '' }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false,
      tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, tasks, activeTaskId, homeWorkspacePath })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
}

test.describe.serial('Work 输入区上下文', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'composer-context-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: '/remote/configured-default', autoStartEngine: true, lastSessionId: '', lastFolder: '',
      lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await setWindow(1440, 900)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await seed()
  })
  test.afterEach(async ({}, info) => {
    releaseDirectory()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('composer-context-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
      await info.attach('failure-footer-layout', { body: JSON.stringify(await page.locator('.work-composer-workspace:visible').evaluateAll(elements => elements.map(element => {
        const footer = element.closest('.input-composer__followup-row')!
        return { html: footer.outerHTML, width: footer.clientWidth, scrollWidth: footer.scrollWidth,
          children: [...footer.children].map(child => ({ className: child.className, box: child.getBoundingClientRect().toJSON(),
            minWidth: getComputedStyle(child).minWidth, flex: getComputedStyle(child).flex })) }
      })), null, 2), contentType: 'application/json' })
    }
    const receiptsPath = info.outputPath('context-http-receipts.json'), geometryPath = info.outputPath('context-geometry.json')
    writeFileSync(receiptsPath, JSON.stringify({ directoryReads, bindings, probes, contextSnapshots, mutations, errors }, null, 2))
    writeFileSync(geometryPath, JSON.stringify(geometries, null, 2))
    await info.attach('context-http-receipts', { path: receiptsPath, contentType: 'application/json' })
    await info.attach('context-geometry', { path: geometryPath, contentType: 'application/json' })
    expect(mutations).toEqual([]); expect(errors).toEqual([])
    for (const binding of bindings) {
      expect(binding).toMatchObject({ sessionId: codeBootstrapSession, workspaceRoot: '/remote/configured-default', bootstrap: true })
      expect(['code', 'general']).toContain(binding.profile)
    }
  })
  test.afterAll(async () => {
    releaseDirectory()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('composer-context-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('显示远端实际根目录而非本地旧提示，长路径在窄窗口可用键盘完整查看', async ({}, info) => {
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    const trigger = context().getByRole('button', { name: `当前工作区：${actualRoot}`, exact: true })
    await expect(trigger).toBeVisible()
    const initialBindings = await displayBoundary()
    expect(directoryReads).toContain(taskA)
    await expect(trigger).not.toHaveAttribute('title', staleRoot)
    for (const width of [1440, 980]) {
      await setWindow(width, 800)
      await expect(trigger).toBeVisible()
      const geometry = await trigger.evaluate(element => {
        const box = element.getBoundingClientRect(), footer = element.closest('.input-composer__followup-row')!
        const hint = footer.querySelector(':scope > p')!
        const label = element.querySelector('span')!, style = getComputedStyle(label)
        return { width: box.width, footerWidth: footer.getBoundingClientRect().width,
          overflow: footer.scrollWidth > footer.clientWidth + 1, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
          clipped: label.scrollWidth > label.clientWidth, right: box.right, hintLeft: hint.getBoundingClientRect().left,
          hint: hint.textContent }
      })
      geometries.push({ viewportWidth: width, ...geometry })
      await info.attach(`footer-geometry-${width}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
      expect(geometry.overflow).toBe(false)
      expect(geometry.width).toBeLessThanOrEqual(geometry.footerWidth * 0.5)
      expect(geometry.whiteSpace).toBe('nowrap'); expect(geometry.textOverflow).toBe('ellipsis'); expect(geometry.clipped).toBe(true)
      expect(geometry.hint).toContain('Enter')
      expect(geometry.right).toBeLessThanOrEqual(geometry.hintLeft + 1)
      await trigger.focus(); await page.keyboard.press('Enter')
      await expect(popup()).toBeVisible()
      await expect(popup().locator('p')).toHaveText(actualRoot)
      await expect(popup().locator('p')).toHaveCSS('user-select', 'text')
      await expect(popup()).not.toContainText(staleRoot)
      await expect(popup()).toHaveAttribute('data-motion-state', 'open')
      await expect(popup()).toHaveCSS('opacity', '1')
      const path = info.outputPath(`composer-context-${width}.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`工作区路径 ${width}`, { path, contentType: 'image/png' })
      await page.keyboard.press('Escape')
      await expect(popup()).toHaveCount(0)
      await expect(trigger).toBeFocused()
      const closedPath = info.outputPath(`composer-context-closed-${width}.png`)
      await page.screenshot({ path: closedPath, animations: 'disabled' }); await info.attach(`闭合工作区底栏 ${width}`, { path: closedPath, contentType: 'image/png' })
      expect(bindings).toHaveLength(initialBindings)
    }
    await setWindow(1440, 900)
  })

  test('切换任务后迟到的旧工作区响应不会覆盖当前任务', async () => {
    holdDirectory = true
    await selectTask(taskHeld)
    await expect.poll(() => Boolean(held)).toBe(true)
    await expect(context()).not.toContainText('not-the-remote-workspace')
    await selectTask(taskB)
    const current = context().getByRole('button', { name: `当前工作区：${roots.get(taskB)}`, exact: true })
    await expect(current).toBeVisible()
    const initialBindings = await displayBoundary()
    releaseDirectory()
    // Two animation frames give the old promise's microtasks a turn without a
    // fixed delay; the positive current identity remains the acceptance signal.
    await context().evaluate(async () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    await expect(current).toBeVisible()
    await current.click()
    await expect(popup().locator('p')).toHaveText(roots.get(taskB)!)
    await expect(popup()).not.toContainText(roots.get(taskHeld)!)
    await page.keyboard.press('Escape')
    expect(bindings).toHaveLength(initialBindings)
  })

  test('已结束的失败与停止命令随过程折叠，最终回复始终显示', async ({}, info) => {
    await selectTask(taskA)
    const message = work().locator(`[data-message-id="${runs.get(taskA)!.assistantMessageId}"]`)
    const controls = message.getByRole('button', { name: '展开过程', exact: true })
    await expect(message).toContainText(finalText)
    await expect(controls).toHaveAttribute('aria-expanded', 'false')
    await expect(message.locator('[data-tool-kind="command"]')).toHaveCount(0)
    await expect(message).not.toContainText('failed-command.js')
    await expect(message).not.toContainText('stopped-command.js')
    await controls.click()
    await expect(message.locator('[data-tool-kind="command"]')).toHaveCount(2)
    for (const job of jobs) {
      const tool = message.locator(`[data-work-tool-id="${job.toolCallId}"]`)
      await expect(tool).toBeVisible()
      await expect(tool).toContainText(job.command)
      expect(await tool.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
    }
    await expect(message).toContainText(finalText)
    await message.getByRole('button', { name: '收起过程', exact: true }).click()
    await expect(message.locator('[data-tool-kind="command"]')).toHaveCount(0)
    await expect(message).toContainText(finalText)
    const appearance = await page.locator('html').getAttribute('data-appearance')
    try {
      await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'dark'))
      const path = info.outputPath('settled-commands-collapsed-dark.png')
      await page.screenshot({ path, animations: 'disabled' }); await info.attach('深色收起命令过程', { path, contentType: 'image/png' })
    } finally {
      await page.locator('html').evaluate((element, value) => value ? element.setAttribute('data-appearance', value) : element.removeAttribute('data-appearance'), appearance)
    }
  })

  test('首页与草稿保留已选路径或显示默认工作区，查看路径不绑定会话也不发送任务', async () => {
    const chosen = '/remote/chosen-home-workspace'
    await seed(null, chosen)
    await expect(context().getByRole('button', { name: `当前工作区：${chosen}`, exact: true })).toBeVisible()
    await context().getByRole('button').click()
    await expect(popup().locator('p')).toHaveText(chosen)
    await page.keyboard.press('Escape')
    await seed(null, null)
    await expect(context().getByRole('button', { name: '当前工作区：默认工作区', exact: true })).toBeVisible()
    await context().getByRole('button').click()
    await expect(popup()).toContainText('任务将使用默认工作区。')
    await page.keyboard.press('Escape')
    await seed(taskDraft)
    await expect(context().getByRole('button', { name: `当前工作区：${draftRoot}`, exact: true })).toBeVisible()
    await context().getByRole('button').click()
    await expect(popup().locator('p')).toHaveText(draftRoot)
    await page.keyboard.press('Escape')
    expect(mutations).toEqual([])
  })

  test('上下文浮层保留简写与精确数值，浅深色窄窗口支持聚焦查看和 Escape 关闭', async ({}, info) => {
    await seed(taskB)
    const ring = work().locator('.context-ring:visible'), card = page.getByTestId('context-usage-card')
    await expect(ring).toHaveAttribute('data-context-source', 'reported')
    expect(contextSnapshots).toContainEqual({ sessionId: taskB, phase: 'idle', used: 113_300 })
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const width of [1440, 980]) {
        await setWindow(width, 800)
        await ring.focus()
        await expect(card).toBeVisible()
        await expect(card).toHaveAttribute('data-motion-state', 'open')
        await expect(card).toHaveCSS('opacity', '1')
        await expect(ring).toHaveAttribute('aria-describedby', (await card.getAttribute('id'))!)
        await expect(card.getByTestId('context-used-number')).toHaveAttribute('data-value', '113300')
        await expect(card.getByTestId('context-percent-number')).toHaveAttribute('data-value', '44.3')
        await expect(card.getByTestId('context-used-compact-number')).toHaveAttribute('data-value', '113300')
        await expect(card.locator('.ctx-card__tokens')).toContainText('256k')
        await expect(card.locator('.ctx-card__tokens-label')).toHaveText('使用 / 上限')
        await expect(card.locator('.ctx-card__exact-tokens')).toContainText('256,000 tokens')
        await expect(card.locator('.ctx-card__source-hint')).toHaveText('模型统计 · 最近一次请求输入')
        await expect(card.getByRole('status')).toHaveText('按需自动压缩 · 非累计计费用量')
        const text = await card.innerText()
        expect(text.match(/113,300/g)).toHaveLength(1)
        expect(text.match(/256,000/g)).toHaveLength(1)
        expect(text).not.toContain('450,000')
        await expect(card.getByTestId('context-used-compact-number')).toHaveCount(1)
        const geometry = await card.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
            width: bounds.width, height: bounds.height, overflow: element.scrollWidth > element.clientWidth + 1 }
        })
        geometries.push({ type: 'usage-card', appearance, viewportWidth: width, ...geometry })
        expect(geometry.left).toBeGreaterThanOrEqual(7)
        expect(geometry.right).toBeLessThanOrEqual(width - 7)
        expect(geometry.top).toBeGreaterThanOrEqual(7)
        expect(geometry.bottom).toBeLessThanOrEqual(793)
        expect(geometry.width).toBeLessThanOrEqual(301)
        expect(geometry.height).toBeLessThan(250)
        expect(geometry.overflow).toBe(false)
        const path = info.outputPath(`context-usage-${appearance}-${width}.png`)
        await page.screenshot({ path, animations: 'disabled' })
        await info.attach(`上下文浮层 ${appearance} ${width}`, { path, contentType: 'image/png' })
        await page.keyboard.press('Escape')
        await expect(card).toHaveCount(0)
        await expect(ring).toBeFocused()
        await expect(ring).not.toHaveAttribute('aria-describedby')
        // Focus remains on Escape. A real pointer entry can reopen the same surface.
        await page.mouse.move(0, 0)
        await ring.hover()
        await expect(card).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(card).toHaveCount(0)
        await page.keyboard.press('Tab')
      }
    }
    await setWindow(1440, 900)
  })

  test('上下文浮层呈现引擎压缩进行、完成和失败状态，历史通知不会重新弹出', async ({}, info) => {
    const original = runs.get(taskB)!
    const ring = work().locator('.context-ring:visible'), card = page.getByTestId('context-usage-card')
    try {
      for (const [index, phase] of (['running', 'succeeded', 'failed'] as const).entries()) {
        const finishedAt = Date.now()
        runs.set(taskB, { ...original, version: original.version + index + 1, seq: original.seq + index + 1,
          status: phase === 'running' ? 'running' : 'succeeded', updatedAt: finishedAt,
          ...(phase === 'running' ? { finishedAt: undefined } : { finishedAt }),
          compaction: { phase, startedAt: finishedAt - 1_000,
            ...(phase === 'running' ? {} : { finishedAt }), beforeTokens: 113_300,
            ...(phase === 'succeeded' ? { afterTokens: 28_000 } : {}),
            ...(phase === 'failed' ? { error: 'CONTEXT_COMPACTION_TEST_FAILURE' } : {}) } })
        await seed(taskB)
        await expect(ring).toHaveAttribute('data-compaction-phase', phase)
        expect(contextSnapshots).toContainEqual({ sessionId: taskB, phase, used: 113_300 })
        await ring.focus()
        await expect(card).toBeVisible()
        await expect(card.getByTestId('context-used-number')).toHaveAttribute('data-value', '113300')
        if (phase === 'running') {
          await expect(ring).toHaveAttribute('aria-busy', 'true')
          await expect(card.getByRole('progressbar', { name: '自动压缩上下文' })).toHaveAttribute('aria-valuetext', '正在自动压缩')
          await expect(card.getByRole('status')).toHaveText('正在自动压缩上下文')
        } else {
          await expect(ring).toHaveAttribute('aria-busy', 'false')
          await expect(card.getByRole('status')).toHaveText(phase === 'succeeded'
            ? '自动压缩完成（历史估算 113.3k → 28k）' : '自动压缩失败：CONTEXT_COMPACTION_TEST_FAILURE')
          await expect(card.getByRole('progressbar', { name: '自动压缩上下文' })).toHaveCount(0)
        }
        const path = info.outputPath(`context-compaction-${phase}.png`)
        await page.screenshot({ path, animations: 'disabled' })
        await info.attach(`上下文压缩 ${phase}`, { path, contentType: 'image/png' })
        await page.keyboard.press('Escape')
        await expect(card).toHaveCount(0)
      }
      runs.set(taskB, { ...original, version: original.version + 4, seq: original.seq + 4,
        compaction: { phase: 'failed', startedAt: Date.now() - 20_000, finishedAt: Date.now() - 10_000,
          error: 'EXPIRED_COMPACTION_NOTICE' } })
      await seed(taskB)
      await expect(ring).toHaveAttribute('data-compaction-phase', 'idle')
      await ring.focus()
      await expect(card.getByRole('status')).toHaveText('按需自动压缩 · 非累计计费用量')
      await expect(card).not.toContainText('EXPIRED_COMPACTION_NOTICE')
      await page.keyboard.press('Escape')
    } finally { runs.set(taskB, original) }
  })
})
