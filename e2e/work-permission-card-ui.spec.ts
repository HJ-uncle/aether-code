/** Real isolated Work approval/question regression: prepared Agent configuration, bounded
 * disclosures, accessible decisions, exact durable request identity and session
 * full-access ordering. HTTP/SSE records side effects; no Agent or command is
 * actually executed, and opening details cannot authorize a response or write. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootPending, RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'permission-card-ui-token', modelId = 'permission-card-model', workspaceRoot = '/remote/permission-card-fixture'
const longPrompt = '按事实逐项核对资料，保留完整来源并区分待确认信息。\n'.repeat(140) + '完整工作指令结尾：保留这句话以核对全部内容。'
const preparedTools = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir', 'glob', 'grep',
  'office_document', 'office_inspect', 'office_environment', 'deliver_files', 'workbench_context', 'workbench_open', 'workbench_render',
  'execute_cmd', 'command_output', 'cancel_command', 'web_fetch', 'http_request', 'browser_tabs', 'browser_open', 'browser_navigate',
  'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_scroll', 'browser_press_key', 'browser_wait',
  'browser_console', 'browser_network', 'browser_network_request', 'browser_set_viewport', 'browser_close', 'code_diagnose', 'codegraph',
  'agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete', 'remember', 'recall', 'list_memories', 'forget', 'link_memories', 'search_history',
]
const preparedCreate = { name: '项目交付审阅助手', description: '检查项目说明、数据依据与交付文件。', systemPrompt: longPrompt,
  model: modelId, temperature: 0.35, skills: ['文档审阅'], mcpServers: ['fixture-docs'], knowledgeBases: ['fixture-knowledge'], allowedTools: preparedTools }
const previousAgent = { id: 'agent-permission-target', name: '原项目助手', description: '保留事实来源。', systemPrompt: '原始工作指令。',
  model: modelId, temperature: 0.2, skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['read_file'] }
const updateChanges = { name: '更新后的项目助手', description: '补充改动核对与交付检查。', systemPrompt: '更新指令：先核对来源，再汇总本次改动。', allowedTools: ['read_file', 'write_file'] }
const questionGroups = [
  { tab: '交付形式', question: '这次先交付哪一种材料？', multiSelect: false, allowInput: false,
    options: [{ label: '项目说明', description: '先完成可阅读的项目背景、目标与使用说明。' },
      { label: '演示文稿', description: '先整理用于评审展示的内容与结论。' }] },
  { tab: '检查范围', question: '本次需要核对哪些内容？', multiSelect: true, allowInput: true,
    options: [{ label: '功能清单', description: '逐项确认现有功能与交付范围，保留完整核对结果。' },
      { label: '数据来源', description: '记录数据出处、引用链接与最后核对时间。' },
      ...Array.from({ length: 12 }, (_, index) => ({ label: `附加核对 ${index + 1}`, description: `完整保留第 ${index + 1} 项的检查依据与后续处理要求。` }))] },
  { question: '还有哪些必须保留的要求？', options: [], allowInput: true },
]
const singleQuestion = '请补充需要保留的交付要求。'
type Scenario = 'create' | 'update' | 'delete' | 'command' | 'questions' | 'single-question'
type Decision = 'approved' | 'rejected'
const errors: string[] = [], forbidden: string[] = [], history: EngineHistoryRow[] = [], projection: ChatSsePayload[] = []
const chats: Record<string, unknown>[] = [], decisions: Array<{ sessionId: string; runId: string; toolResponse: Record<string, unknown> }> = []
const securityWrites: Array<{ sessionId: string; mode: string }> = [], audit: string[] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let current: RootRun | undefined, activeStream: ServerResponse | undefined, ordinal = 0, scenario: Scenario = 'create'
let expectedDecision: string | null = null, allowFullAccess = false, securityMode = 'safe'
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const attempt = (): string => `permission-attempt-${current?.runId ?? 'none'}-${current?.version ?? 0}`

function pendingFor(kind: Scenario, sequence: number): RootPending {
  const common = { requestId: `permission-request-${sequence}`, toolCallId: `permission-tool-call-${sequence}`, kind: 'permission' as const, status: 'pending' as const }
  if (kind === 'questions') return { ...common, kind: 'ask', toolName: 'ask_user', args: { questions: questionGroups } }
  if (kind === 'single-question') return { ...common, kind: 'ask', toolName: 'ask_user', args: { question: singleQuestion, options: [] }, question: singleQuestion }
  if (kind === 'command') return { ...common, toolName: 'execute_cmd', args: { command: 'printf "permission-fixture-only"', cwd: workspaceRoot },
    description: '需要执行这条命令以检查工作目录，实际命令只在隔离夹具中展示。' }
  const toolName = `agent_${kind}`, args = kind === 'create'
    ? { name: preparedCreate.name, description: preparedCreate.description, systemPrompt: longPrompt }
    : kind === 'update' ? { id: previousAgent.id, ...updateChanges } : { id: previousAgent.id }
  const config = kind === 'create' ? preparedCreate : kind === 'update'
    ? { id: previousAgent.id, before: previousAgent, changes: updateChanges, after: { ...previousAgent, ...updateChanges } }
    : { id: previousAgent.id, agent: previousAgent }
  const reason = `Agent ${{ create: '创建', update: '更新', delete: '删除' }[kind]}确认\n\n${JSON.stringify(config, null, 2)}\n\n确认后执行以上配置。`
  const description = `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`
  return { ...common, toolName, args, description, pendingAction: { type: toolName, reason,
    operation: { version: 1, action: kind, tenantId: 'permission-card-tenant',
      ...(kind === 'create' ? { input: preparedCreate } : { id: previousAgent.id, before: previousAgent, ...(kind === 'update' ? { input: updateChanges } : {}) }) } } }
}
function updateRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing permission fixture root')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  return current
}
function publish(payload: ChatSsePayload): void {
  if (!current || !activeStream || activeStream.writableEnded) throw new Error('Missing owned permission stream')
  projection.push(payload)
  activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function requestPermission(): void {
  if (!current) throw new Error('Missing permission fixture root')
  const pending = pendingFor(scenario, current.seq)
  if (pending.kind === 'ask') publish({ ask_user: { toolCallId: pending.toolCallId, ...pending.args } })
  else {
    publish({ ask_user: { toolCallId: pending.toolCallId, question: pending.description, options: ['approved', 'rejected'] } })
    publish({ permissionRequest: { ...pending, requestId: pending.toolCallId } })
  }
  publish({ run: updateRun({ status: 'waiting', pending: [pending] }) })
  activeStream!.end('data: [DONE]\n\n'); activeStream = undefined
}
function finishDecision(output: string): void {
  if (!current || !activeStream) throw new Error('Missing decision stream')
  const pending = current.pending[0]
  publish({ run: updateRun({ status: 'running', pending: [{ ...pending, status: 'answered', output }] }) })
  const text = `PERMISSION_FINISHED_${current.seq}：已记录${pending.kind === 'ask' ? '回答' : output === 'approved' ? '允许' : '拒绝'}，未执行真实操作。`
  const finalResult = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId, runId: current.runId,
    assistantMessageId: current.assistantMessageId, text, publishedAt: Date.now(), items: [] }
  const assistant = history.find(row => row.id === current!.assistantMessageId)!
  assistant.content = text; assistant.metadata = { ...assistant.metadata, finalResult }
  publish({ finalResult }); publish({ run: updateRun({ status: 'succeeded', finishedAt: Date.now() }) })
  activeStream.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: attempt() } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'permission-card-tenant', sessionId,
      namespace: { id: 'permission-card-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: attempt(),
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    chats.push(input)
    if (activeStream) throw new Error('Another chat was sent before the prior stream completed')
    if (record(input.toolResponse)) {
      const result = input.toolResponse, pending = current?.pending[0]
      if (!current || current.status !== 'waiting' || !expectedDecision || input.sessionId !== current.sessionId || input.runId !== current.runId ||
        result.requestId !== pending?.requestId || result.runId !== current.runId || result.toolCallId !== pending.toolCallId ||
        result.name !== pending.toolName || result.output !== expectedDecision) throw new Error(`Unexpected permission response: ${JSON.stringify(input)}`)
      decisions.push({ sessionId: current.sessionId, runId: current.runId, toolResponse: result }); audit.push('decision')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); activeStream = response
      finishDecision(expectedDecision); expectedDecision = null; return
    }
    if (typeof input.sessionId !== 'string' || input.message !== `PERMISSION_SCENARIO_${scenario}`) throw new Error('Unexpected initial message')
    const now = Date.now(), sequence = ++ordinal
    current = { schemaVersion: 1, runId: `permission-run-${sequence}`, sessionId: input.sessionId, turnId: `permission-turn-${sequence}`,
      userMessageId: `permission-user-${sequence}`, assistantMessageId: `permission-assistant-${sequence}`, seq: sequence, version: 1,
      status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    history.length = 0; projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: input.message, createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    history.push(user, { id: current.assistantMessageId, role: 'assistant', content: `PERMISSION_ACTIVE_${sequence}`,
      createdAt: now + 1, conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } })
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); activeStream = response
    publish({ run: current }); publish({ userMessage: user }); publish({ content: `PERMISSION_ACTIVE_${sequence}` }); return
  }
  if (path === '/api/v1/security/mode' && request.method === 'PUT') {
    if (!current || current.status !== 'waiting' || !allowFullAccess || input.sessionId !== current.sessionId || input.mode !== 'full-access')
      throw new Error(`Unexpected security write: ${JSON.stringify(input)}`)
    securityWrites.push({ sessionId: current.sessionId, mode: input.mode }); audit.push('security')
    securityMode = input.mode; response.end(envelope({ sessionId: current.sessionId, mode: securityMode })); return
  }
  if (path === '/api/v1/workspace/bind' && request.method === 'POST') {
    if (typeof input.sessionId !== 'string' || input.workspaceRoot !== workspaceRoot) throw new Error('Unexpected workspace binding')
    response.end(envelope({ workspaceRoot, bindingEpoch: 'one', contractVersion: 2 })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Unexpected mutation: ${path}`) }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const matching = current?.sessionId === sessionId ? current : undefined
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: matching ? [{ userMessageId: matching.userMessageId,
      conversationId: matching.turnId, preview: history[0].content, createdAt: matching.createdAt }] : [], messages: matching ? history : [],
      loadedTurnIds: matching ? [matching.userMessageId] : [], revision: `permission-history-${matching?.version ?? 0}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'permission-card-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '权限卡片测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: matching ? 'live' : 'persisted', eventId: matching ? `${matching.runId}:${projection.length}` : null,
      finished: matching?.status !== 'running', projection: matching ? projection : [], history: matching ? history : [], run: matching,
      runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching,
      lastEventId: matching ? `${matching.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(matching), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: securityMode, sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const card = (): Locator => conversation().getByRole('form', { name: '操作确认', exact: true })
const questionCard = (): Locator => conversation().getByRole('form', { name: '补充信息', exact: true })
const questionNavigation = (): Locator => questionCard().getByRole('group', { name: '问题导航', exact: true })
const questionTab = (label: string): Locator => questionNavigation().getByRole('button', { name: label, exact: true })
const body = (): Locator => card().getByRole('region', { name: '操作详情', exact: true })
const detailbar = (): Locator => card().getByRole('group', { name: '配置详情', exact: true })
const detail = (label: string): Locator => detailbar().getByRole('button', { name: label, exact: true })
async function resize(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(width, 900) }, width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}
async function shot(name: string): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished))
  })
  const path = test.info().outputPath(`${name}.png`); await page.screenshot({ path }); await test.info().attach(name, { path, contentType: 'image/png' })
}
async function start(kind: Scenario, appearance: 'light' | 'dark' = 'light', width = 1440): Promise<RootPending> {
  scenario = kind; expectedDecision = null; allowFullAccess = false; securityMode = 'safe'
  chats.length = 0; decisions.length = 0; securityWrites.length = 0; audit.length = 0
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await resize(width)
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(`PERMISSION_SCENARIO_${kind}`)
  const next = ordinal + 1
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(conversation()).toContainText(`PERMISSION_ACTIVE_${next}`)
  requestPermission()
  if (kind === 'questions' || kind === 'single-question') {
    await expect(questionCard()).toHaveCount(1)
    await expect(questionCard().getByRole('button', { name: '提交回复', exact: true })).toBeDisabled()
  } else {
    await expect(card()).toHaveCount(1)
    await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
  }
  return current!.pending[0]
}
function expectUntouched(): void {
  expect(decisions).toEqual([]); expect(securityWrites).toEqual([]); expect(forbidden).toEqual([])
  expect(chats.filter(item => record(item.toolResponse))).toEqual([])
}
async function decide(pending: RootPending, output: string, button: Locator, fullAccess = false): Promise<void> {
  const owned = current!
  expectedDecision = output; allowFullAccess = fullAccess
  await button.click()
  await expect.poll(() => decisions).toEqual([{ sessionId: owned.sessionId, runId: owned.runId,
    toolResponse: { requestId: pending.requestId, runId: owned.runId, toolCallId: pending.toolCallId, name: pending.toolName, output } }])
  await expect(conversation()).toContainText(`PERMISSION_FINISHED_${owned.seq}`)
  await expect(card()).toHaveCount(0)
  await expect(questionCard()).toHaveCount(0)
  if (!fullAccess) expect(securityWrites).toEqual([])
}
async function expectDecisionsVisible(confirmLabel: string): Promise<void> {
  await expect(card().getByRole('button', { name: confirmLabel, exact: true })).toBeInViewport({ ratio: 1 })
  await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(card().getByRole('button', { name: '本会话改为完全访问并放行', exact: true })).toBeInViewport({ ratio: 1 })
}
async function expectSinglePanel(label: string): Promise<void> {
  await expect(detail(label)).toHaveAttribute('aria-expanded', 'true')
  await expect(body()).toHaveCount(1)
  await expect(detailbar().locator('button[aria-expanded="true"]')).toHaveCount(1)
}
async function openDetail(label: string): Promise<Locator> {
  const button = detail(label)
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  await expectSinglePanel(label)
  await expect.poll(() => body().evaluate(element => element.scrollTop)).toBe(0)
  return body()
}
async function repeatCurrentDetail(label: string): Promise<void> {
  await expectSinglePanel(label)
  await detail(label).click()
  await expectSinglePanel(label)
}
async function verifyBoundedScroll(confirmLabel: string): Promise<void> {
  const dimensions = await body().evaluate(element => ({ height: element.getBoundingClientRect().height,
    scroll: element.scrollHeight, client: element.clientHeight, limit: Math.min(innerHeight * 0.36, 300) }))
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.limit + 2)
  expect(dimensions.scroll - dimensions.client).toBeGreaterThan(100)
  const footer = card().locator('.work-permission__footer'), before = await footer.boundingBox()
  await body().evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => body().evaluate(element => element.scrollTop)).toBeGreaterThan(100)
  const after = await footer.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
  await expectDecisionsVisible(confirmLabel)
  expect(await card().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing permission fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'permission-card-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 900); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await shot('permission-card-final')
  await info.attach('permission-side-effects', { body: JSON.stringify({ chats, decisions, securityWrites, audit, errors, forbidden }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(forbidden).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('permission-card-profile-')) throw new Error('Unsafe permission fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 760]) {
  test(`${appearance} / ${width}：创建 Agent 使用单行详情栏，面板互斥且保留完整配置和审批`, async () => {
    const pending = await start('create', appearance, width)
    expect(pending.args).not.toHaveProperty('allowedTools')
    await expect(card().getByRole('heading', { name: '创建 Agent', exact: true })).toBeVisible()
    await expect(card().locator('.work-permission__summary')).toHaveText(preparedCreate.name)
    await expect(card().locator('.work-permission__description')).toHaveText(preparedCreate.description)
    await expect(card().locator('.work-permission__metadata')).toContainText('权限卡片测试模型')
    await expect(card().locator('.work-permission__metadata')).toContainText('0.35')
    await expect(card()).not.toContainText('确认后继续当前任务'); await expect(card()).not.toContainText('等待确认')
    await expectSinglePanel('工作指令')
    for (const label of ['资源', '工具权限', '完整参数']) await expect(detail(label)).toHaveAttribute('aria-expanded', 'false')
    await expect(detailbar().getByRole('button')).toHaveCount(4)
    const rows = await detailbar().getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y))
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(5)
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    await shot(`create-${appearance}-${width}-default`)

    const instructions = body()
    await expect(instructions.locator('[data-section="systemPrompt"]')).toBeVisible()
    expect(await instructions.locator('[data-section="systemPrompt"] > p').textContent()).toBe(longPrompt)
    await verifyBoundedScroll('创建 Agent')
    await shot(`create-${appearance}-${width}-instructions`)
    await repeatCurrentDetail('工作指令'); expectUntouched()
    const resources = await openDetail('资源')
    await expect(detail('工作指令')).toHaveAttribute('aria-expanded', 'false')
    await expect(resources.locator('[data-section="systemPrompt"]')).toHaveCount(0)
    await expect(resources.getByRole('region', { name: '技能', exact: true })).toContainText('文档审阅')
    await expect(resources.getByRole('region', { name: 'MCP 服务', exact: true })).toContainText('fixture-docs')
    await expect(resources.getByRole('region', { name: '知识库', exact: true })).toContainText('fixture-knowledge')
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    const tools = await openDetail('工具权限')
    await expect(detail('资源')).toHaveAttribute('aria-expanded', 'false')
    await expect(tools.locator('[data-section="skills"]')).toHaveCount(0)
    const toolList = tools.locator('[data-section="allowedTools"]')
    await expect(toolList.locator('.work-permission__tool-group')).toHaveCount(7)
    await expect(toolList.locator('.work-permission__tool-group > h5')).toContainText(['文件与搜索', '办公与预览', '终端命令', '网页与网络', '代码分析', 'Agent 管理', '记忆与历史'])
    await expect(toolList.locator('li')).toHaveCount(preparedTools.length)
    const entries = await toolList.locator('li').evaluateAll(items => items.map(item => ({ text: item.textContent ?? '', id: item.getAttribute('title') })))
    expect(entries.map(item => item.id).sort()).toEqual([...preparedTools].sort())
    for (const entry of entries) { expect(entry.text).toMatch(/\p{Script=Han}/u); expect(entry.text).not.toContain(entry.id); expect(entry.text).not.toMatch(/[（(].*[）)]/) }
    await expect(toolList.locator('li[title="read_file"]')).toHaveText('读取文件')
    await expect(toolList.locator('li[title="execute_cmd"]')).toHaveText('执行命令')
    await verifyBoundedScroll('创建 Agent'); await shot(`create-${appearance}-${width}-tools`)
    const raw = await openDetail('完整参数')
    await expect(detail('工具权限')).toHaveAttribute('aria-expanded', 'false')
    await expect(raw.locator('[data-section="allowedTools"]')).toHaveCount(0)
    const complete = await raw.locator('.work-permission__raw').textContent()
    expect(complete).toContain(pending.description)
    expect(complete).toContain(JSON.stringify(pending.args, null, 2))
    expect(complete).toContain('search_history')
    await verifyBoundedScroll('创建 Agent'); expectUntouched()
    await shot(`create-${appearance}-${width}-expanded`)
    await repeatCurrentDetail('完整参数')
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    const output: Decision = width === 760 ? 'rejected' : 'approved'
    await decide(pending, output, card().getByRole('button', { name: output === 'approved' ? '创建 Agent' : '拒绝', exact: true }))
  })
}

test('更新 Agent 显示目标身份与前后改动，批准保持原始请求标识', async () => {
  const pending = await start('update')
  await expect(card().getByRole('heading', { name: '更新 Agent', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(previousAgent.name)
  const fields = card().locator('.work-permission__fields')
  await expect(fields).toContainText(previousAgent.id)
  await expect(fields).toContainText(previousAgent.name); await expect(fields).toContainText(updateChanges.name)
  await expect(fields).toContainText(previousAgent.description); await expect(fields).toContainText(updateChanges.description)
  await expectSinglePanel('工作指令')
  const instructions = body()
  await expect(instructions).toContainText(previousAgent.systemPrompt); await expect(instructions).toContainText(updateChanges.systemPrompt)
  const tools = await openDetail('工具权限')
  await expect(tools.locator('[data-section="systemPrompt"]')).toHaveCount(0)
  await expect(tools.locator('.work-permission__before li[title="read_file"]')).toHaveText('读取文件')
  await expect(tools.locator('[data-section="allowedTools"] > .work-permission__tool-groups li')).toHaveCount(2)
  await expect(tools.locator('[data-section="allowedTools"] > .work-permission__tool-groups li[title="write_file"]')).toHaveText('写入文件')
  await expectDecisionsVisible('更新 Agent'); expectUntouched(); await shot('update-agent-changes')
  await decide(pending, 'approved', card().getByRole('button', { name: '更新 Agent', exact: true }))
})

test('删除 Agent 清楚标识目标并使用删除语义，批准只恢复对应调用', async () => {
  const pending = await start('delete', 'dark', 760)
  await expect(card().getByRole('heading', { name: '删除 Agent', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(previousAgent.name)
  await expect(card().locator('.work-permission__fields')).toContainText(previousAgent.id)
  const confirm = card().getByRole('button', { name: '删除 Agent', exact: true })
  await expect(confirm).toHaveClass(/\bbtn--danger\b/)
  await expectSinglePanel('工作指令')
  const raw = await openDetail('完整参数'); await expect(raw.locator('pre')).toContainText(pending.description!)
  await expectDecisionsVisible('删除 Agent'); expectUntouched(); await shot('delete-agent-confirmation')
  await decide(pending, 'approved', confirm)
})

for (const output of ['approved', 'rejected'] as const) test(`普通命令显示命令与原因，${output}沿用原审批响应`, async () => {
  const pending = await start('command')
  await expect(card().locator('pre[aria-label="命令"]')).toBeVisible()
  await expect(card().locator('pre[aria-label="命令"]')).toHaveText(String(pending.args.command))
  await expectSinglePanel('完整参数')
  await expect(card().locator('.work-permission__reason')).toHaveText(pending.description!)
  await expect(card().locator('.work-permission__fields')).toContainText(workspaceRoot)
  await expectDecisionsVisible('允许执行'); expectUntouched(); await shot(`command-${output}`)
  await decide(pending, output, card().getByRole('button', { name: output === 'approved' ? '允许执行' : '拒绝', exact: true }))
})

test('完全访问仅在明确点击后写当前会话权限，再放行原始请求', async () => {
  const pending = await start('command')
  const sessionId = current!.sessionId
  await expectSinglePanel('完整参数')
  await repeatCurrentDetail('完整参数'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '本会话改为完全访问并放行', exact: true }), true)
  expect(securityWrites).toEqual([{ sessionId, mode: 'full-access' }])
  expect(audit).toEqual(['security', 'decision'])
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 760]) {
  test(`${appearance} / ${width}：多组提问保留选择和草稿，键盘操作不提交并精确回复原请求`, async () => {
    const pending = await start('questions', appearance, width)
    const question = questionCard(), submit = question.getByRole('button', { name: '提交回复', exact: true })
    const progress = question.locator('.work-question__progress')
    const questionBody = question.locator('.work-question__body')
    const supplement = '保留来源链接与核对日期。', freeAnswer = '核心数据不得省略。\n缺失的信息请标注待确认。'
    expect(pending.requestId).not.toBe(pending.toolCallId)
    await expect(question.getByRole('heading', { name: '需要你的意见', exact: true })).toBeVisible()
    await expect(card()).toHaveCount(0)
    await expect(questionNavigation().getByRole('button')).toHaveCount(3)
    await expect(questionTab('交付形式')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('group', { name: questionGroups[0].question, exact: true })).toBeVisible()
    await expect(progress).toHaveText('已回答 0 / 3')
    await expect(submit).toBeDisabled()
    const firstChoice = question.getByRole('radio', { name: /^项目说明/ })
    const secondChoice = question.getByRole('radio', { name: /^演示文稿/ })
    await expect(firstChoice).toHaveAccessibleName(/先完成可阅读的项目背景、目标与使用说明。/)
    await expect(question.getByRole('textbox')).toHaveCount(0)
    await firstChoice.focus(); await firstChoice.press('Space')
    await expect(firstChoice).toBeChecked(); await expect(secondChoice).not.toBeChecked()
    await firstChoice.press('ArrowRight')
    await expect(secondChoice).toBeChecked(); await expect(firstChoice).not.toBeChecked()
    await expect(progress).toHaveText('已回答 1 / 3'); await expect(submit).toBeDisabled()
    expectUntouched(); await shot(`questions-${appearance}-${width}-single-choice`)

    await question.getByRole('button', { name: '下一题', exact: true }).click()
    await expect(questionTab('检查范围')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('radio')).toHaveCount(0)
    await expect(question.getByRole('checkbox')).toHaveCount(14)
    await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBe(0)
    const functions = question.getByRole('checkbox', { name: /^功能清单/ })
    const sources = question.getByRole('checkbox', { name: /^数据来源/ })
    await functions.focus(); await functions.press('Space')
    await sources.focus(); await sources.press('Space')
    await expect(functions).toBeChecked(); await expect(sources).toBeChecked()
    await sources.press('Space'); await expect(sources).not.toBeChecked()
    await sources.press('Space'); await expect(sources).toBeChecked()
    const extra = question.getByRole('textbox', { name: `补充回答：${questionGroups[1].question}`, exact: true })
    await extra.fill(`  ${supplement}  `)
    await expect(progress).toHaveText('已回答 2 / 3'); await expect(submit).toBeDisabled()
    const footer = question.locator('.work-question__footer'), before = await footer.boundingBox()
    await expect.poll(() => questionBody.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
    await questionBody.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const after = await footer.boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
    await expect(submit).toBeInViewport({ ratio: 1 })
    expect(await question.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expectUntouched(); await shot(`questions-${appearance}-${width}-multiple-choice`)

    const nextQuestion = question.getByRole('button', { name: '下一题', exact: true })
    await nextQuestion.focus(); await nextQuestion.press('Enter')
    await expect(questionTab('问题 3')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('checkbox')).toHaveCount(0)
    await expect(question.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0)
    const answer = question.getByRole('textbox', { name: `补充回答：${questionGroups[2].question}`, exact: true })
    const finalQuestion = question.locator('legend')
    await expect(finalQuestion).toHaveText(questionGroups[2].question)
    await expect(finalQuestion).toBeFocused()
    await page.keyboard.press('Tab'); await expect(answer).toBeFocused()
    expectUntouched()
    await answer.fill('  '); await expect(submit).toBeDisabled(); await expect(progress).toHaveText('已回答 2 / 3')
    await answer.fill(freeAnswer)
    await expect(progress).toHaveText('已回答 3 / 3'); await expect(submit).toBeEnabled()
    expectUntouched()
    await questionTab('交付形式').focus(); await questionTab('交付形式').press('Enter')
    await expect(secondChoice).toBeChecked(); await expect(firstChoice).not.toBeChecked()
    await expect(question.locator('fieldset')).toHaveCount(1)
    await questionTab('检查范围').focus(); await questionTab('检查范围').press('Space')
    await expect(functions).toBeChecked(); await expect(sources).toBeChecked()
    await expect(extra).toHaveValue(`  ${supplement}  `)
    await questionTab('检查范围').click()
    await expect(questionTab('检查范围')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await questionTab('问题 3').click(); await expect(answer).toHaveValue(freeAnswer)
    await expect(submit).toBeInViewport({ ratio: 1 })
    expectUntouched(); await shot(`questions-${appearance}-${width}-ready`)

    // Each group's choices and free text use the Work answer separator; the
    // engine response contract joins the resulting groups with a comma.
    await decide(pending, `演示文稿,功能清单、数据来源、${supplement},${freeAnswer}`, submit)
    expect(audit).toEqual(['decision'])
  })
}

test('单组自由提问无需导航，换行保留且仅提交按钮发送回答', async () => {
  const pending = await start('single-question', 'light', 760)
  const question = questionCard(), submit = question.getByRole('button', { name: '提交回复', exact: true })
  await expect(questionNavigation()).toHaveCount(0)
  await expect(question.locator('fieldset')).toHaveCount(1)
  await expect(question.getByRole('group', { name: singleQuestion, exact: true })).toBeVisible()
  await expect(question.getByRole('radio')).toHaveCount(0); await expect(question.getByRole('checkbox')).toHaveCount(0)
  await expect(question.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0)
  const input = question.getByRole('textbox', { name: `补充回答：${singleQuestion}`, exact: true })
  await expect(input).toHaveJSProperty('tagName', 'TEXTAREA')
  await input.fill('   '); await expect(submit).toBeDisabled()
  await input.fill('保留完整来源'); await input.press('End'); await input.press('Enter'); await input.pressSequentially('需要可编辑文件')
  await expect(input).toHaveValue('保留完整来源\n需要可编辑文件')
  await expect(submit).toBeEnabled(); expectUntouched()
  await shot('single-question-free-text')
  await decide(pending, '保留完整来源\n需要可编辑文件', submit)
  expect(audit).toEqual(['decision'])
})
