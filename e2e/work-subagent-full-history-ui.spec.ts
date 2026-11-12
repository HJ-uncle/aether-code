/** Real Electron + authenticated fixture: a child archive larger than the old
 * row/byte window loads automatically, prose stays readable, heavy process DOM
 * stays collapsed, refresh/selection races cannot replace another child, and
 * live progress does not repeatedly reload an already readable full archive.
 * Run with npm run test:e2e -- e2e/work-subagent-full-history-ui.spec.ts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'subagent-full-history-token', modelId = 'subagent-full-history-model'
const sessionId = 'work-full-history-parent', title = '子代理完整对话核对', now = Date.now() - 10_000
const childA = 'full-history-child-a', childB = 'full-history-child-b', childC = 'full-history-child-c'
const errors: string[] = [], mutations: string[] = [], heavyReads: string[] = []
const archiveReads: Array<{ sessionId: string; current: string | null; pageSize: string | null }> = []
const ownershipReads: Array<{ runId: string; parentSessionId: string | null; view: string | null }> = []
const summaryReads: Array<{ runId: string; lastSeq: number; status: string }> = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const parent: RootRun = { schemaVersion: 1, runId: 'full-history-root', sessionId, turnId: 'full-history-turn',
  userMessageId: 'full-history-user', assistantMessageId: 'full-history-answer', seq: 1, version: 2,
  status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
const children: SubagentRunView[] = [childA, childB, childC].map((id, index) => ({
  schemaVersion: 2, view: 'summary', runId: `${id}-run`, tenantId: 'full-history-tenant', rootSessionId: sessionId,
  parentSessionId: sessionId, parentConversationId: parent.turnId, parentMessageId: parent.assistantMessageId,
  parentToolCallId: `full-history-delegate-${index}`, childSessionId: id, agentName: `完整阅读代理 ${['A', 'B', 'C'][index]}`,
  task: '核对全部对话与工具记录', description: '核对全部对话与工具记录', modelId, status: index === 2 ? 'running' : 'succeeded', lastSeq: 1,
  createdAt: now + index, updatedAt: now + index, startedAt: now,
  ...(index === 2 ? { partialOutput: 'LIVE_C_SEQ_1：正在核对新增材料。' } : { finishedAt: now + index, resultSummary: '独立对话已准备好' }),
  continuation: { builtinRole: 'research', builtinRoleVersion: 1, readOnly: true },
  usage: {}, toolCount: 0, activeToolCount: 0, toolCalls: [],
  coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
    ids: [], hasMore: false, truncated: false, completeness: 'complete' }
}))
function row(childId: string, suffix: string, role: string, content: string, ordinal: number, turn = Math.floor(ordinal / 2).toString()): EngineHistoryRow {
  return { id: `${childId}-${suffix}`, role, content, isSidechain: true, createdAt: now + ordinal,
    conversationId: `${childId}-turn-${turn}`, metadata: { rootRunId: parent.runId, subagentRunId: `${childId}-run` } }
}
const longAnswer = 'LONG_ANSWER_BEGIN\n\n' + Array.from({ length: 90 }, (_, index) =>
  `完整结果段落 ${index}：${'每个接口结论都保留原文，读者无需继续加载才能核对。'.repeat(8)}\n\n`).join('') + 'LONG_ANSWER_END'
const thinking = `THINKING_BEGIN\n${'正在检查归属、工具结果与正文的顺序。'.repeat(8000)}\nTHINKING_END`
const toolOutput = `TOOL_OUTPUT_BEGIN\n${'const retainedEvidence = "full archive evidence";\n'.repeat(8500)}TOOL_OUTPUT_END`
const proseBeforeTool = 'PROSE_BEFORE_TOOL：已完成接口边界核对，接下来读取原始资料。'
const proseAfterTool = 'PROSE_AFTER_TOOL：原始资料支持上述结论，最终结果已完整保留。'
const archiveA: EngineHistoryRow[] = Array.from({ length: 220 }, (_, index) => row(childA, `history-${index}`,
  index % 2 ? 'assistant' : 'user', `HISTORY_${index.toString().padStart(3, '0')}：完整历史应按顺序保留。`, index))
archiveA.push(
  row(childA, 'long-prompt', 'user', '请保留完整的长结果。', 220), row(childA, 'long-answer', 'assistant', longAnswer, 221),
  row(childA, 'rich-prompt', 'user', '请读资料并保留调用前后的文字。', 222, 'rich'),
  { ...row(childA, 'rich-answer', 'assistant', proseBeforeTool, 223, 'rich'), reasoningContent: thinking,
    toolCall: { id: 'full-history-read', name: 'read_file', args: { path: '/remote/full-history/evidence.txt' } } },
  { ...row(childA, 'rich-output', 'tool', toolOutput, 224, 'rich'), toolCallId: 'full-history-read', success: true },
  row(childA, 'rich-final', 'assistant', proseAfterTool, 225, 'rich'),
  row(childA, 'thinking-prompt', 'user', '先检查过程。', 226, 'thinking'),
  { ...row(childA, 'thinking-only', 'assistant', '', 227, 'thinking'), reasoningContent: thinking },
  row(childA, 'tail-prompt', 'user', '最后一个问题。', 228, 'tail'),
  row(childA, 'tail-answer', 'assistant', 'TAIL_ANSWER_A：最后一条完整答复。', 229, 'tail')
)
const archives = new Map<string, EngineHistoryRow[]>([[childA, archiveA], [childB, [
  row(childB, 'prompt', 'user', 'CHILD_B_INSTRUCTION：独立任务。', 0),
  row(childB, 'answer', 'assistant', 'CHILD_B_ANSWER：只属于代理 B 的结果。', 1)
]]])
const archiveC: EngineHistoryRow[] = Array.from({ length: 220 }, (_, index) => row(childC, `history-${index}`,
  index % 2 ? 'assistant' : 'user', `LIVE_ARCHIVE_${index.toString().padStart(3, '0')}：已完成的正文仍可独立阅读。`, index))
archives.set(childC, archiveC)
const parentRows: EngineHistoryRow[] = [
  { id: parent.userMessageId, role: 'user', content: title, conversationId: parent.turnId, createdAt: now, metadata: { rootRunId: parent.runId } },
  { id: parent.assistantMessageId, role: 'assistant', content: '子代理的独立对话已准备好。', conversationId: parent.turnId, createdAt: now + 1, metadata: { rootRunId: parent.runId } }
]
let held: { sessionId: string; response?: ServerResponse; body?: string } | undefined
let failNextArchive = '', revision = 1, failureCount = 0
function releaseArchive(): void { held?.response?.end(held.body); held = undefined }
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  const current = id === sessionId ? parent : undefined, history = current ? parentRows : []
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Reading must not mutate work: ${path}`)
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/subagent/runs') {
    response.end(envelope({ schemaVersion: 2, runs: url.searchParams.get('parentSessionId') === sessionId ? children : [],
      listComplete: true, hasMore: false, revision: `full-history-directory-${children.map(child => child.lastSeq).join('-')}` })); return
  }
  const childPath = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/(tools|events))?$/)
  if (childPath) {
    const child = children.find(item => item.runId === decodeURIComponent(childPath[1])), owner = url.searchParams.get('parentSessionId')
    if (!child || owner && owner !== sessionId) throw new Error('Child ownership mismatch')
    ownershipReads.push({ runId: child.runId, parentSessionId: owner, view: url.searchParams.get('view') })
    if (!childPath[2]) summaryReads.push({ runId: child.runId, lastSeq: child.lastSeq, status: child.status })
    if (childPath[2] === 'tools') heavyReads.push(path)
    response.end(envelope(childPath[2] === 'tools' ? { schemaVersion: 2, runId: child.runId, asOfSeq: child.lastSeq, totalCount: 0, items: [], hasMore: false }
      : childPath[2] === 'events' ? { schemaVersion: 2, runId: child.runId, events: [], nextSeq: child.lastSeq, hasMore: false, checkpointRequired: false } : child)); return
  }
  if (path === '/api/v1/conversation/archive') {
    const archive = archives.get(id), child = children.find(item => item.childSessionId === id)
    if (!archive || !child) throw new Error(`Foreign archive requested: ${id}`)
    if (!ownershipReads.some(read => read.runId === child.runId && read.parentSessionId === sessionId && read.view === 'summary')) throw new Error('Archive read before ownership validation')
    archiveReads.push({ sessionId: id, current: url.searchParams.get('current'), pageSize: url.searchParams.get('pageSize') })
    if (failNextArchive === id) {
      failNextArchive = ''; failureCount++
      response.writeHead(500).end(JSON.stringify({ code: 500, message: 'FULL_HISTORY_REFRESH_FAILED', data: null })); return
    }
    const paged = url.searchParams.has('current') || url.searchParams.has('pageSize')
    const currentPage = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
    const body = JSON.stringify({ code: 200, message: 'ok', data: paged ? archive.slice((currentPage - 1) * pageSize, currentPage * pageSize) : archive,
      ...(paged ? { pagination: { current: currentPage, pageSize, total: archive.length, totalPages: Math.ceil(archive.length / pageSize) } } : {}),
      metadata: { archiveMessageCount: archive.length, archiveRevision: `full-${id}-${revision}`, backend: 'jsonl', compressed: false } })
    if (held?.sessionId === id) { held.response = response; held.body = body; return }
    response.end(body); return
  }
  if (/\/subagent\/runs\/[^/]+\/tools\//.test(path) || path === '/api/v1/workspace/file/content') {
    heavyReads.push(path); throw new Error(`Collapsed history must not fetch details: ${path}`)
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: history.filter(item => item.role === 'user').map(item => ({
      userMessageId: item.id, conversationId: item.conversationId, preview: item.content, createdAt: item.createdAt })),
    messages: history, loadedTurnIds: history.filter(item => item.role === 'user').map(item => item.id), revision: 'full-parent-stable',
    mutationRevision: 'full-parent-unchanged', backend: 'jsonl', completeness: 'complete' })); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'full-history-instance' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '完整阅读测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history, projection: [], run: current, runs: current ? [current] : [], subagentRuns: current ? children : [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? history
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'full-history-tenant', sessionId: id,
      namespace: { id: 'full-history-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/full-history', bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/full-history' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

let app: ElectronApplication | undefined, page: Page, fixture = ''
const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '协作代理', exact: true })
const transcript = (): Locator => panel().locator('.work-subagent-transcript')
const scroller = (): Locator => transcript().locator('.work-subagent-transcript__scroll')
const message = (suffix: string): Locator => transcript().locator(`[data-message-id="${childA}-${suffix}"]`)
async function openChildren(): Promise<void> {
  if (!(await workspace().isVisible())) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  const tab = workspace().getByRole('tab', { name: '子代理', exact: true })
  if (await tab.isVisible()) await tab.click()
  else { await workspace().getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '子代理', exact: true }).click() }
  await expect(panel()).toBeVisible()
}
async function selectChild(name: 'A' | 'B' | 'C'): Promise<void> {
  const back = panel().getByRole('button', { name: '返回子代理列表', exact: true })
  if (await back.isVisible()) await back.click()
  await panel().getByRole('button', { name: `查看 完整阅读代理 ${name} 子代理详情`, exact: true }).click()
  await expect(transcript()).toHaveAttribute('aria-label', `完整阅读代理 ${name} 的对话`)
  await expect(transcript()).toContainText(name === 'A' ? 'TAIL_ANSWER_A' : name === 'B' ? 'CHILD_B_ANSWER' : 'LIVE_ARCHIVE_219')
  await expect(scroller()).toHaveAttribute('aria-busy', 'false')
}
async function refreshChild(id: string): Promise<void> {
  const count = archiveReads.filter(read => read.sessionId === id).length
  await panel().getByRole('button', { name: '刷新子代理对话', exact: true }).click()
  await expect.poll(() => archiveReads.filter(read => read.sessionId === id).length).toBeGreaterThan(count)
  await expect(scroller()).toHaveAttribute('aria-busy', 'false')
}

test.describe.serial('Work 子代理自动完整历史', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'subagent-full-history-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/full-history', lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(name.toUpperCase())) delete env[name]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const key = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ key, sessionId, title, modelId, now }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'subagents', pane: 'workspace', ratio: 56 }))
    }, { key, sessionId, title, modelId, now })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await openChildren(); await selectChild('A')
  })
  test.afterEach(async ({}, info) => {
    releaseArchive()
    await info.attach('full-history-http-receipts', { body: JSON.stringify({ archiveReads, ownershipReads, summaryReads, heavyReads, failureCount, mutations, errors }, null, 2), contentType: 'application/json' })
    if (info.status !== info.expectedStatus && page) await info.attach('full-history-failure', { body: await page.screenshot(), contentType: 'image/png' })
    expect(errors).toEqual([]); expect(mutations).toEqual([]); expect(heavyReads).toEqual([])
    expect(archiveReads.every(read => read.current === null && read.pageSize === null)).toBe(true)
  })
  test.afterAll(async () => {
    releaseArchive()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('subagent-full-history-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('一次自动读取超过旧窗口的全部正文，工具和思考只在主动展开后挂载', async ({}, info) => {
    expect(archiveA.length).toBeGreaterThan(220)
    expect(Buffer.byteLength(JSON.stringify(archiveA))).toBeGreaterThan(512 * 1024)
    expect(archiveReads.filter(read => read.sessionId === childA)).toHaveLength(1)
    expect(ownershipReads).toContainEqual({ runId: `${childA}-run`, parentSessionId: sessionId, view: 'summary' })
    await expect(transcript().getByRole('button', { name: /加载更早消息|加载较新消息|查看最新消息/ })).toHaveCount(0)
    await expect(transcript().locator('[data-message-id^="full-history-child-a-history-"]')).toHaveCount(220)
    const historyIds = await transcript().locator('[data-message-id^="full-history-child-a-history-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))
    expect(historyIds).toEqual(Array.from({ length: 220 }, (_, index) => `${childA}-history-${index}`))
    for (const index of [0, 111, 219]) await expect(message(`history-${index}`)).toContainText(`HISTORY_${index.toString().padStart(3, '0')}`)
    await expect(message('long-answer')).toContainText('LONG_ANSWER_BEGIN')
    await expect(message('long-answer')).toContainText('LONG_ANSWER_END')
    await expect(message('long-answer').getByRole('button', { name: /继续阅读|继续展开|展开全文/ })).toHaveCount(0)
    await expect(message('rich-answer')).toContainText(proseBeforeTool)
    await expect(message('rich-answer')).toContainText(proseAfterTool)
    await expect(message('tail-answer')).toContainText('TAIL_ANSWER_A')
    expect(await transcript().locator('.work-message__process-toggle').count()).toBeGreaterThan(0)
    await expect(transcript().locator('.work-message__process-toggle[aria-expanded="true"]')).toHaveCount(0)
    await expect(transcript().locator('.work-message__process, .work-message__thinking, .work-tool-activity, .logline__detail, .md-code')).toHaveCount(0)
    await expect(transcript()).not.toContainText('TOOL_OUTPUT_BEGIN')
    await expect(transcript()).not.toContainText('THINKING_BEGIN')

    const rich = message('rich-answer')
    await rich.getByRole('button', { name: '展开过程', exact: true }).click()
    await expect(rich.getByRole('button', { name: '显示思考', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const tool = rich.locator('.work-tool-activity')
    await expect(tool).toHaveCount(1)
    await expect(tool.locator('.compact-tool-row > button')).toHaveAttribute('aria-expanded', 'false')
    await expect(rich.locator('.logline__detail, .work-message__thinking')).toHaveCount(0)
    await tool.locator('.compact-tool-row > button').click()
    await expect(tool.locator('.logline__detail')).toContainText('TOOL_OUTPUT_BEGIN')
    await tool.locator('.compact-tool-row > button').click()
    await expect(tool.locator('.logline__detail')).toHaveCount(0)
    await rich.getByRole('button', { name: '收起过程', exact: true }).click()
    await expect(rich.locator('.work-tool-activity')).toHaveCount(0)

    const reasoning = message('thinking-only')
    await reasoning.getByRole('button', { name: '展开过程', exact: true }).click()
    await expect(reasoning.getByRole('button', { name: '显示思考', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(reasoning.locator('.work-message__thinking')).toHaveCount(0)
    await reasoning.getByRole('button', { name: '显示思考', exact: true }).click()
    await expect(reasoning.locator('.work-message__thinking .logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(reasoning.locator('.logline__detail--thinking')).toHaveCount(0)
    await reasoning.locator('.work-message__thinking .logline').click()
    await expect(reasoning.locator('.logline__detail--thinking pre')).toHaveText(thinking)
    await reasoning.getByRole('button', { name: '隐藏思考', exact: true }).click()
    await expect(reasoning.locator('.logline__detail--thinking')).toHaveCount(0)
    await reasoning.getByRole('button', { name: '收起过程', exact: true }).click()
    await expect(transcript().locator('.work-message__process, .work-message__thinking, .work-tool-activity')).toHaveCount(0)
    await rich.scrollIntoViewIfNeeded()
    const screenshot = info.outputPath('full-history-collapsed-process.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('完整历史默认折叠布局', { path: screenshot, contentType: 'image/png' })
  })

  test('迟到的 A 历史不能串入 B，关闭再打开仍可直接阅读完整历史', async () => {
    const stale = row(childA, 'stale-only', 'assistant', 'STALE_A_ONLY：迟到响应只属于 A。', 230, 'stale')
    archiveA.push(stale); revision++; held = { sessionId: childA }
    await panel().getByRole('button', { name: '刷新子代理对话', exact: true }).click()
    await expect.poll(() => Boolean(held?.response)).toBe(true)
    await selectChild('B')
    const guard = await page.evaluateHandle(() => {
      const leaks: string[] = []
      const observer = new MutationObserver(() => {
        const element = document.querySelector('.work-subagent-transcript[aria-label="完整阅读代理 B 的对话"]')
        if (element?.textContent?.includes('STALE_A_ONLY') || element?.querySelector('[data-message-id^="full-history-child-a-"]')) leaks.push('A history reached B')
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      return { observer, leaks }
    })
    try {
      releaseArchive()
      // A fresh B response and render complete after the held A response was
      // released, so the race assertion does not rely on an arbitrary delay.
      await refreshChild(childB)
      await expect(transcript()).toContainText('CHILD_B_ANSWER')
      await expect(transcript()).not.toContainText('STALE_A_ONLY')
      await expect(transcript().locator('[data-message-id^="full-history-child-a-"]')).toHaveCount(0)
      expect(await guard.evaluate(value => value.leaks)).toEqual([])
    } finally {
      await guard.evaluate(value => value.observer.disconnect()); await guard.dispose()
      archiveA.pop(); revision++
    }
    await selectChild('A')
    await expect(message('history-0')).toContainText('HISTORY_000')
    await expect(message('tail-answer')).toContainText('TAIL_ANSWER_A')
    await expect(transcript()).not.toContainText('STALE_A_ONLY')
    await work().getByRole('button', { name: '收起工作区', exact: true }).click()
    await expect(workspace()).not.toBeVisible()
    await openChildren()
    await expect(transcript()).toHaveAttribute('aria-label', '完整阅读代理 A 的对话')
    await expect(message('history-0')).toContainText('HISTORY_000')
    await expect(message('long-answer')).toContainText('LONG_ANSWER_END')
    await expect(transcript().getByRole('button', { name: /加载更早消息|加载较新消息/ })).toHaveCount(0)
    await expect(transcript().locator('.work-message__process-toggle[aria-expanded="true"]')).toHaveCount(0)
  })

  test('完整历史刷新失败保留已读内容，明确重试后补齐新正文', async () => {
    await expect(scroller()).toHaveAttribute('aria-busy', 'false')
    failNextArchive = childA
    await refreshChild(childA)
    await expect(transcript().getByRole('alert')).toContainText('FULL_HISTORY_REFRESH_FAILED')
    await expect(message('history-0')).toContainText('HISTORY_000')
    await expect(message('long-answer')).toContainText('LONG_ANSWER_END')
    await expect(message('tail-answer')).toContainText('TAIL_ANSWER_A')
    archiveA.push(row(childA, 'retry-prompt', 'user', '补充最终结论。', 230, 'retry'),
      row(childA, 'retry-answer', 'assistant', 'RETRY_NEW_ANSWER：重试后读取的新正文。', 231, 'retry'))
    revision++
    const count = archiveReads.filter(read => read.sessionId === childA).length
    await transcript().getByRole('button', { name: '重新读取子代理对话', exact: true }).click()
    await expect.poll(() => archiveReads.filter(read => read.sessionId === childA).length).toBeGreaterThan(count)
    await expect(message('retry-answer')).toContainText('RETRY_NEW_ANSWER')
    await expect(scroller()).toHaveAttribute('aria-busy', 'false')
    await expect(transcript().getByRole('alert')).toHaveCount(0)
    await expect(message('history-0')).toContainText('HISTORY_000')
    await expect(message('long-answer')).toContainText('LONG_ANSWER_END')
    await expect(transcript().locator('.work-message__process, .work-message__thinking, .work-tool-activity')).toHaveCount(0)
    expect(failureCount).toBe(1)
  })

  test('运行中序号增长只更新实时进度，结束后自动同步全部正文并保留阅读位置', async () => {
    await selectChild('C')
    const run = children[2], live = transcript().locator('.work-subagent-transcript__live')
    const readCount = (): number => archiveReads.filter(read => read.sessionId === childC).length
    await expect(live).toContainText('LIVE_C_SEQ_1')
    const initialReads = readCount()
    expect(initialReads).toBe(1)
    await expect(transcript().locator('[data-message-id^="full-history-child-c-history-"]')).toHaveCount(220)
    await scroller().evaluate(async element => {
      element.scrollTop = 480
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    })
    await expect.poll(() => scroller().evaluate(element => element.scrollTop)).toBe(480)
    const anchor = await scroller().evaluate(element => {
      const top = element.getBoundingClientRect().top
      const first = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.getBoundingClientRect().bottom > top)
      if (!first) throw new Error('No readable history anchor')
      return { id: first.dataset.messageId!, top: first.getBoundingClientRect().top - top }
    })
    const anchorOffset = (): Promise<number> => transcript().locator(`[data-message-id="${anchor.id}"]`).evaluate(element =>
      element.getBoundingClientRect().top - element.closest('.work-subagent-transcript__scroll')!.getBoundingClientRect().top)
    const preserved = await transcript().locator(`[data-message-id="${anchor.id}"]`).elementHandle()
    if (!preserved) throw new Error('Missing history node')

    for (const seq of [2, 3, 4]) {
      run.lastSeq = seq; run.updatedAt = now + 1000 + seq; run.coverage = { ...run.coverage, asOfSeq: seq }
      run.partialOutput = `LIVE_C_SEQ_${seq}：正在逐项核对新增材料，已有历史保持原位。`
      await expect(live).toContainText(`LIVE_C_SEQ_${seq}`)
      expect(readCount()).toBe(initialReads)
      expect(Math.abs(await anchorOffset() - anchor.top)).toBeLessThanOrEqual(2)
      expect(await preserved.evaluate(element => element.isConnected)).toBe(true)
    }
    // Observe a later real summary poll after the last rendered delta. This
    // exceeds the archive coalescing window without a blind sleep, and would
    // catch an incorrectly scheduled full read following lastSeq changes.
    const observed = summaryReads.filter(read => read.runId === run.runId && read.lastSeq === 4).length
    await expect.poll(() => summaryReads.filter(read => read.runId === run.runId && read.lastSeq === 4).length).toBeGreaterThan(observed)
    expect(readCount()).toBe(initialReads)
    await expect(scroller()).toHaveAttribute('aria-busy', 'false')

    archiveC.push(row(childC, 'settled-prompt', 'user', '汇总新增材料的核对结果。', 220, 'settled'),
      row(childC, 'settled-answer', 'assistant', 'SETTLED_C_ANSWER：完整结果已归档，可与早期正文一起阅读。', 221, 'settled'))
    revision++; run.lastSeq = 5; run.status = 'succeeded'; run.updatedAt = now + 1010; run.finishedAt = run.updatedAt
    run.coverage = { ...run.coverage, asOfSeq: 5 }; run.resultSummary = '新增材料核对完成。'; delete run.partialOutput
    await expect(transcript().locator(`[data-message-id="${childC}-settled-answer"]`)).toContainText('SETTLED_C_ANSWER')
    await expect(scroller()).toHaveAttribute('aria-busy', 'false')
    expect(readCount()).toBe(initialReads + 1)
    await expect(live).toHaveCount(0)
    await expect(transcript().locator(`[data-message-id="${childC}-history-0"]`)).toContainText('LIVE_ARCHIVE_000')
    expect(Math.abs(await anchorOffset() - anchor.top)).toBeLessThanOrEqual(2)
    await expect(transcript().getByRole('button', { name: '查看最新消息', exact: true })).toBeVisible()
    await expect(transcript().getByRole('button', { name: /加载更早消息|加载较新消息/ })).toHaveCount(0)
    await expect(panel().getByRole('alert')).toHaveCount(0)
    await preserved.dispose()
  })
})
