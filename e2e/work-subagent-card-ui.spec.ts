/** Isolated Electron + authenticated fixture: Work cards show name/status/time inside process,
 * open the matching child inspector by mouse or keyboard, and never load inline details. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'subagent-card-fixture', sessionId = 'work-subagent-card-parent', modelId = 'subagent-card-model'
const title = '子代理主卡导航核对', now = Date.now() - 10_000
const completedPreview = ['接口研究结果：现有协议可以直接复用。', '已核对事件边界与历史读取入口。', '继续沿用独立子代理的上下文。',
  '完整校验记录保留在右侧对话。', '已检查任务入口、模块依赖、存储布局、调用顺序、接口边界与回放记录，相关证据可以在子代理的完整对话中继续查阅。'.repeat(4), 'COMPLETE_RESULT_TAIL'].join(' ')
const completedResult = '## 接口研究结果：**现有协议可以直接复用。**\n\n' + completedPreview.split(' ').slice(1).join('\n\n')
const errors: string[] = [], mutations: string[] = [], detailReads: string[] = [], archiveReads: string[] = [], toolDetailReads: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const parent: RootRun = { schemaVersion: 1, runId: 'card-parent-run', sessionId, turnId: 'card-turn', userMessageId: 'card-user',
  assistantMessageId: 'card-answer', seq: 1, version: 2, status: 'succeeded', modelId, pending: [], workspacePaths: [],
  createdAt: now, updatedAt: now + 10, finishedAt: now + 10 }
const runs: SubagentRunView[] = (['running', 'succeeded', 'failed', 'blocked'] as const).map((status, index) => ({
  schemaVersion: 2, view: 'summary', runId: `card-run-${index}`, tenantId: 'card-tenant', rootSessionId: sessionId,
  parentSessionId: sessionId, parentConversationId: parent.turnId, parentMessageId: parent.assistantMessageId,
  parentToolCallId: `card-tool-${index}`, childSessionId: `card-child-${index}`, agentName: ['组件执行', '接口研究', '失败代理', '待回答代理'][index],
  task: `DETAIL_ONLY_TASK_${index}`, description: `DETAIL_ONLY_DESCRIPTION_${index}`, modelId,
  status, lastSeq: 1, createdAt: now + index, updatedAt: now + index, startedAt: now,
  ...(index === 1 ? { finishedAt: now + 5, resultSummary: completedResult, stopReason: 'completed' } : {}),
  ...(index === 0 ? { partialOutput: 'RUNNING_PROCESS_MUST_STAY_IN_INSPECTOR' } : {}),
  ...(index === 2 ? { partialOutput: '失败前已核对接口。', error: { code: 'FAILED', message: 'DETAIL_ONLY_ERROR', retryable: false } } : {}),
  ...(index === 3 ? { stopReason: 'needs_user', error: { code: 'NEEDS_USER', message: 'DETAIL_ONLY_QUESTION', retryable: false } } : {}),
  ...(index < 3 ? { continuation: { builtinRole: (['executor', 'research', 'general'] as const)[index], readOnly: index === 1 } } : {}),
  usage: { totalTokens: 8000 }, toolCount: 0, activeToolCount: 0, toolCalls: [],
  coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
    ids: [], hasMore: false, truncated: false, completeness: 'complete' }
}))
const metadata = { rootRunId: parent.runId, turnId: parent.turnId }
const history: EngineHistoryRow[] = [
  { id: parent.userMessageId, role: 'user', content: title, conversationId: parent.turnId, createdAt: now, metadata },
  { id: 'directory-call', role: 'assistant', content: '', conversationId: parent.turnId, createdAt: now, metadata,
    toolCall: { id: 'card-directory', name: 'subagent_directory', args: {} } },
  { id: 'directory-result', role: 'tool', toolCallId: 'card-directory', content: JSON.stringify({ agents: [] }),
    success: true, conversationId: parent.turnId, createdAt: now, metadata },
  { id: 'followup-call', role: 'assistant', content: '', conversationId: parent.turnId, createdAt: now, metadata,
    toolCall: { id: 'card-followup', name: 'subagent_followup', args: { agentId: 'existing-child', task: '补充接口要求' } } },
  { id: 'followup-result', role: 'tool', toolCallId: 'card-followup', content: JSON.stringify({ action: 'queued', childSessionId: 'card-child-0', receipt: { id: 'queued-input' } }),
    success: true, conversationId: parent.turnId, createdAt: now, metadata },
  ...runs.flatMap((run, index) => [
    { id: `call-${index}`, role: 'assistant', content: '', conversationId: parent.turnId, createdAt: now + index * 2 + 1, metadata,
      toolCall: { id: run.parentToolCallId, name: 'subagent_start', args: { ...(index < 3 ? { builtinRole: index ? 'executor' : 'research' } : {}), task: run.task } } },
    { id: `result-${index}`, role: 'tool', toolCallId: run.parentToolCallId, content: JSON.stringify({ started: true, runId: run.runId }),
      success: true, conversationId: parent.turnId, createdAt: now + index * 2 + 2, metadata: { ...metadata, subagent: run } }
  ]),
  { id: 'pending-call', role: 'assistant', content: '', conversationId: parent.turnId, createdAt: now + 9, metadata,
    toolCall: { id: 'card-pending', name: 'subagent_start', args: { description: '准备代理', task: 'PENDING_DETAIL_ONLY_TASK' } } },
  { id: parent.assistantMessageId, role: 'assistant', content: '接口调研已有结果，组件仍在执行。', conversationId: parent.turnId, createdAt: now + 10, metadata }
]
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Read-only card navigation must not mutate ${path}`)
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: parent.userMessageId, conversationId: parent.turnId,
      preview: title, createdAt: now }], messages: history, loadedTurnIds: [parent.userMessageId], revision: 'card-history',
      mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (/^\/api\/v1\/subagent\/runs\/[^/]+$/.test(path)) {
    const runId = decodeURIComponent(path.split('/').at(-1)!); detailReads.push(runId)
    response.end(envelope(runs.find(run => run.runId === runId))); return
  }
  const childPage = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)\/(events|tools)$/)
  if (childPage) {
    const run = runs.find(item => item.runId === childPage[1])
    if (!run) { response.writeHead(404).end(envelope(null)); return }
    if (childPage[2] === 'tools') toolDetailReads.push(run.runId)
    response.end(envelope(childPage[2] === 'events'
      ? { schemaVersion: 2, runId: run.runId, events: [], nextSeq: run.lastSeq, hasMore: false, checkpointRequired: false }
      : { schemaVersion: 2, runId: run.runId, asOfSeq: run.lastSeq, totalCount: 0, items: [], hasMore: false })); return
  }
  if (path === '/api/v1/conversation/archive') {
    archiveReads.push(id)
    const child = runs.find(run => run.childSessionId === id)
    const rows = child ? [{ id: `${id}-instruction`, role: 'user', content: child.task, createdAt: now,
      conversationId: parent.turnId, isSidechain: true, metadata: { ...metadata, subagentRunId: child.runId } },
    { id: `${id}-answer`, role: 'assistant', content: `INSPECTOR_RESULT_${id}\n${child.resultSummary ?? ''}`, createdAt: now + 1,
      conversationId: parent.turnId, isSidechain: true, metadata: { ...metadata, subagentRunId: child.runId } }] : []
    const current = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
    response.end(JSON.stringify({ code: 200, data: rows.slice((current - 1) * pageSize, current * pageSize),
      pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) },
      metadata: { archiveMessageCount: rows.length, archiveRevision: 'card-archive', backend: 'jsonl', compressed: false } })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const matching = id === sessionId
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'card-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '卡片核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: matching ? history : [], projection: [], run: matching ? parent : undefined, runs: matching ? [parent] : [], subagentRuns: matching ? runs : [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: matching ? parent : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [parent] : [] }
    : path === '/api/v1/conversation/history' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history.length }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'card-tenant', sessionId: id,
      namespace: { id: 'card-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs, listComplete: true, hasMore: false, revision: 'card-runs' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/card', entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/card' } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'subagent-card-profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: '/remote/card', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(1440, 900) })
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
  if (page && !page.isClosed()) {
    const path = info.outputPath('subagent-card-ui.png'); await page.screenshot({ path, animations: 'disabled' })
    await info.attach('subagent-card-ui', { path, contentType: 'image/png' })
  }
  const log = info.outputPath('app-errors.json')
  writeFileSync(log, JSON.stringify({ errors, mutations, detailReads, archiveReads, toolDetailReads }, null, 2))
  await info.attach('app-errors', { path: log, contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('subagent-card-profile-')) throw new Error('Unsafe card fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('协作收进过程且仅显示名称状态用时，展开后仍能打开正确独立对话', async ({}, info) => {
  const parentProcess = page.locator('.work-conversation .work-message__process-toggle')
  await expect(parentProcess).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.work-subagent-card')).toHaveCount(0)
  await parentProcess.click()
  const running = page.locator('.work-subagent-card[data-run-id="card-run-0"]')
  const completed = page.locator('.work-subagent-card[data-run-id="card-run-1"]')
  await expect(running).toBeVisible(); await expect(completed).toBeVisible()
  await expect(page.locator('.work-subagent-card')).toHaveCount(5)
  await expect(running.locator('.work-subagent-card__name')).toHaveText('组件执行')
  await expect(running.locator('.work-subagent-card__status')).toContainText('正在运行')
  await expect(completed.locator('.work-subagent-card__status')).toHaveText('已完成')
  await expect(running.locator('.work-subagent-card__role')).toHaveText('执行')
  await expect(completed.locator('.work-subagent-card__role')).toHaveText('调研')
  await expect(page.locator('.work-subagent-card[data-run-id="card-run-2"] .work-subagent-card__role')).toHaveText('通用')
  await expect(page.locator('.work-subagent-card[data-run-id="card-run-3"] .work-subagent-card__role')).toHaveCount(0)
  await expect(page.locator('[data-work-tool-id="card-pending"] .work-subagent-card__role')).toHaveCount(0)
  await expect(completed.locator('.work-subagent-card__result')).toHaveCount(0)
  await expect(completed).not.toContainText('接口研究结果：')
  await expect(completed.locator('.work-subagent-card__timing')).toContainText('本轮用时')
  await expect(running.locator('.work-subagent-card__timing')).toContainText('本轮用时')
  expect(await completed.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
  await expect(page.locator('.work-subagent-card')).not.toContainText(['RUNNING_PROCESS_MUST_STAY_IN_INSPECTOR'])
  await expect(page.locator('.work-subagent-card :is(details, .subagent-card__goal-block, .subagent-card__footer, .subagent-card__tools-block)')).toHaveCount(0)
  // Restoring the session reconciles its active run summary independently of
  // rendering. Finished summaries, full tool data and archives stay demand-only.
  expect(detailReads.every(id => id === 'card-run-0')).toBe(true)
  expect(toolDetailReads).toEqual([]); expect(archiveReads).toEqual([])
  const process = page.locator('.work-message__process-toggle')
  if (await process.getAttribute('aria-expanded') !== 'true') await process.click()
  await expect(page.locator('[data-work-tool-id="card-directory"]')).toContainText('查看可复用子代理')
  await expect(page.locator('[data-work-tool-id="card-directory"] .work-subagent-card')).toHaveCount(0)
  await expect(page.locator('[data-work-tool-id="card-followup"] .work-subagent-card')).toHaveCount(0)
  await running.getByText('正在运行', { exact: true }).click()
  const inspector = page.getByRole('region', { name: '协作代理', exact: true })
  await expect(inspector.getByRole('heading', { name: '组件执行', exact: true })).toBeVisible()
  await inspector.getByRole('button', { name: '展开过程', exact: true }).click()
  await expect(inspector).toContainText('INSPECTOR_RESULT_card-child-0')
  expect(archiveReads).toContain('card-child-0'); expect(archiveReads).not.toContain('card-child-1')
  await completed.getByRole('button').focus(); await page.keyboard.press('Enter')
  await expect(inspector.getByRole('heading', { name: '接口研究', exact: true })).toBeVisible()
  await expect(inspector).toContainText('INSPECTOR_RESULT_card-child-1')
  await expect(inspector).toContainText('COMPLETE_RESULT_TAIL')
  expect(archiveReads).toContain('card-child-1')
  await expect(completed).not.toContainText('接口研究结果：现有协议可以直接复用。')
  await inspector.getByRole('button', { name: '返回子代理列表', exact: true }).click()
  await completed.getByText('已完成', { exact: true }).click()
  await expect(inspector.getByRole('heading', { name: '接口研究', exact: true })).toBeVisible()
  for (const [index, name, status] of [[2, '失败代理', '失败'], [3, '待回答代理', '待回答']] as const) {
    const card = page.locator(`.work-subagent-card[data-run-id="card-run-${index}"]`)
    await card.getByText(status, { exact: true }).click()
    await expect(inspector.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(inspector).toContainText(`INSPECTOR_RESULT_card-child-${index}`)
  }
  await page.locator('[data-work-tool-id="card-pending"]').getByRole('button').click()
  await expect(inspector.getByRole('heading', { name: '准备代理', exact: true })).toBeVisible()
  await expect(inspector).toContainText('代理开始后可查看独立对话')

  // Replay the real parent pattern: admission receipts, one terminal structured
  // notification, then one parent answer. The notice must update its original card.
  for (const [index, run] of runs.entries()) {
    run.status = 'succeeded'; run.finishedAt = now + 9; run.stopReason = 'completed'; run.parentMessageId = `call-${index}`
    run.agentName = ['组件执行', '接口研究', '验证执行', '整合检查'][index]
    run.continuation = { builtinRole: 'research', builtinRoleVersion: 1, readOnly: true }
    run.resultSummary = index === 1 ? completedResult : ['组件已经完成，保留现有接口。', '', '已核对变更与回归结果。', '四个模块可以按现有契约组合。'][index]
    delete run.error; delete run.partialOutput
  }
  const pendingIndex = history.findIndex(row => row.id === 'pending-call')
  history.splice(pendingIndex, 1)
  const notifyingRun = runs[1], receipt = history.find(row => row.id === 'result-1')!
  receipt.metadata = { ...metadata }
  history.splice(history.length - 1, 0, { id: `subagent-result:${notifyingRun.runId}`, role: 'assistant', conversationId: parent.turnId,
    createdAt: now + 9, content: 'SUBAGENT_PROTOCOL_ONLY：子代理任务状态已更新，这是系统完成通知。',
    metadata: { subagent: notifyingRun, subagentNotification: { runId: notifyingRun.runId, parentToolCallId: notifyingRun.parentToolCallId } } })
  const finalAnswer = '四个代理已完成工作，接口与验证结果一致，可以继续集成。'
  history.find(row => row.id === parent.assistantMessageId)!.content = finalAnswer
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  // Explicit reading choices survive replay; the fresh-session default above
  // remains collapsed, but this reader already opened the same process.
  if (await parentProcess.getAttribute('aria-expanded') === 'true') await parentProcess.click()
  await expect(parentProcess).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.work-collaboration-summary')).toHaveCount(0)
  await expect(page.locator('.work-conversation').getByText(finalAnswer, { exact: true })).toBeVisible()
  await parentProcess.click()
  const group = page.locator('.work-collaboration-summary[data-collaboration-count="4"]')
  await expect(group.getByRole('button', { name: '协作 · 4', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('.work-subagent-card')).toHaveCount(4)
  await parentProcess.click()
  await expect(group).toHaveCount(0)
  await expect(page.locator('.work-conversation').getByText(finalAnswer, { exact: true })).toBeVisible()
  await parentProcess.click()
  await expect(group.locator('.work-subagent-card')).toHaveCount(4)
  await expect(group.locator('.work-subagent-card__status')).toHaveText(['已完成', '已完成', '已完成', '已完成'])
  await expect(group.locator('.work-subagent-card__role')).toHaveText(['调研', '调研', '调研', '调研'])
  await expect(page.locator('.work-message__process-toggle')).toHaveCount(1)
  await expect(page.locator('.work-conversation')).not.toContainText('SUBAGENT_PROTOCOL_ONLY')
  await expect(page.locator('.work-conversation').getByText(finalAnswer, { exact: true })).toBeVisible()
  await group.getByRole('button', { name: '协作 · 4', exact: true }).click()
  await expect(group.locator('.work-subagent-card')).toHaveCount(0)
  await group.getByRole('button', { name: '协作 · 4', exact: true }).click()
  await expect(group.locator('.work-subagent-card')).toHaveCount(4)
  await completed.getByRole('button').click()
  await expect(inspector.getByRole('heading', { name: '接口研究', exact: true })).toBeVisible()
  await expect(page.locator('.work-conversation').getByText(finalAnswer, { exact: true })).toBeInViewport()
  await expect(group.getByRole('button', { name: '协作 · 4', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('subagent-card-light.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const settings = page.locator('.modal[aria-label="设置"]')
  await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
  await settings.getByRole('radio', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('subagent-card-dark.png'), animations: 'disabled' })
})
