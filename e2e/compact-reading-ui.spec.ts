/** Compact child reading in real Electron: authenticated archives retain full
 * instructions and answers while collapsed process text stays out of the body.
 * Includes full archive reading, reading/draft memory and stale source isolation.
 * Run with playwright.compact-reading.config.ts; AETHER_E2E_APP_ENTRY can override the build entry. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'
import type { EngineFileChange } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'compact-reading-fixture-token', model = 'compact-reading-model', now = Date.now() - 10_000
const taskA = 'work-compact-task-a', taskB = 'work-compact-task-b'
const errors: string[] = [], mutations: string[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
type ArchiveRead = { sessionId: string; current: number | null; pageSize: number | null }
type HeldArchive = { sessionId: string; current: number; response?: ServerResponse; body?: string }

function makeEngine(name: string) {
  const roots = new Map<string, RootRun>(), children = new Map<string, SubagentRunView>(), archives = new Map<string, EngineHistoryRow[]>()
  const reads: ArchiveRead[] = [], runReads: Array<{ runId: string; parentSessionId: string | null }> = []
  const fileReads: Array<{ sessionId: string; path: string }> = []
  const capabilityProbes: string[] = []
  const reportPath = `/remote/compact/${name}/reports/接口审阅结果与兼容性说明.txt`
  const changes: EngineFileChange[] = [
    { id: 'report-v1', sessionId: taskA, turnId: `turn-${taskA}`, runId: `root-${taskA}`, path: reportPath,
      kind: 'write', oldContent: null, newContent: `REPORT_FIRST_${name}\n`, isNew: true, truncated: false, status: 'pending', createdAt: now + 1000 },
    { id: 'report-v2', sessionId: taskA, turnId: `turn-${taskA}`, runId: `root-${taskA}`, path: reportPath,
      kind: 'write', oldContent: `REPORT_FIRST_${name}\n`, newContent: `REPORT_CURRENT_${name}\n兼容性核对已完成。\n`, truncated: false, status: 'pending', createdAt: now + 2000 },
    { id: 'notes-v1', sessionId: taskA, turnId: `turn-${taskA}`, runId: `root-${taskA}`, path: `/remote/compact/${name}/notes.txt`,
      kind: 'write', oldContent: null, newContent: `NOTES_${name}\n`, isNew: true, truncated: false, status: 'pending', createdAt: now + 3000 }
  ]
  let held: HeldArchive | undefined, archiveRevision = 1
  const title = (id: string): string => `阅读核对任务 ${id === taskA ? 'A' : 'B'} · ${name}`
  const agentName = (index: number): string => `阅读代理 ${index}`
  const instruction = `${name}：核对完整需求与原始附件，保留接口和测试边界。\n` +
    Array.from({ length: 244 }, (_, index) => `INSTRUCTION_SEGMENT_${index.toString().padStart(3, '0')} ${'retain-original-content '.repeat(22)}\n`).join('') + `\nINSTRUCTION_END_${name} ✅`
  const finalText = `# 完整审阅结果 ${name}\n\n` + Array.from({ length: 95 }, (_, index) =>
    `段落 ${index}：RESULT_SEGMENT_${index.toString().padStart(3, '0')} ${'接口行为保持一致，记录可以逐段核对。'.repeat(6)}\n\n`).join('') + `FINAL_END_${name}`
  const thinking = `THINKING_BEGIN_${name}\n${'尚未形成最终结论，正在核对原始调用边界。'.repeat(900)}\nTHINKING_END_${name}`
  const failureDiagnostic = `500 event:error data:${JSON.stringify({ code: 'InternalError', message: 'inference abort',
    request_id: `fixture-request-${name}`, detail: `DIAGNOSTIC_END_${name}` })}`
  const beforeFailure = `NORMAL_BEFORE_FAILURE_${name}：已确认两个接口的参数一致，尚未完成其余核对。`
  for (const id of [taskA, taskB]) {
    const run: RootRun = { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`,
      userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: 2,
      status: 'succeeded', modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
    roots.set(id, run)
    for (const index of id === taskA ? [1, 2] : [3]) {
      const child: SubagentRunView = { schemaVersion: 2, view: 'summary', runId: `compact-child-run-${index}`,
        tenantId: `compact-${name}`, rootSessionId: id, parentSessionId: id, parentConversationId: run.turnId,
        parentMessageId: run.assistantMessageId, parentToolCallId: `delegate-${index}`, childSessionId: `compact-child-${index}`,
        agentName: agentName(index), task: '核对完整需求、历史与结果', description: '核对完整需求、历史与结果', modelId: model,
        status: 'succeeded', lastSeq: 1, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now,
        resultSummary: `阅读资料已准备好 · ${name}`, continuation: { builtinRole: 'research', builtinRoleVersion: 1, readOnly: true },
        usage: {}, toolCount: 0, activeToolCount: 0, toolCalls: [],
        coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0,
          ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
      children.set(child.runId, child)
      const row = (suffix: string, role: string, content: string, ordinal: number): EngineHistoryRow => ({
        id: `${child.childSessionId}-${suffix}`, role, content, isSidechain: true, createdAt: now + ordinal,
        conversationId: `${child.childSessionId}-turn-${Math.floor(ordinal / 2)}`,
        metadata: { rootRunId: run.runId, subagentRunId: child.runId } })
      if (index === 1) {
        const rows = Array.from({ length: 50 }, (_, ordinal) => row(`old-${ordinal}`, ordinal % 2 ? 'assistant' : 'user',
          `OLD_PAGE_${name}_${ordinal}：早期记录保持原文。`, ordinal))
        rows.push(row('instruction', 'user', instruction, 50), row('instruction-ack', 'assistant', '已接收完整指令。', 51),
          row('thinking-prompt', 'user', '先核对过程，尚未请求最终结论。', 52),
          { ...row('thinking-only', 'assistant', '', 53), reasoningContent: thinking },
          row('answer-prompt', 'user', '请给出可以逐段阅读的完整结果。', 54), row('answer', 'assistant', finalText, 55),
          row('short-prompt', 'user', '只需要一个简短结论。', 56),
          { ...row('short-answer', 'assistant', `SHORT_FINAL_${name}：核对完成。`, 57), reasoningContent: thinking },
          row('tail-prompt', 'user', `TAIL_PROMPT_${name}：保留当前阅读位置。`, 58), row('tail-answer', 'assistant', `TAIL_ANSWER_${name}`, 59))
        archives.set(child.childSessionId, rows)
      } else {
        const rows = [row('other-user', 'user', `OTHER_CHILD_${name}_${index}：独立任务指令。`, 0),
          row('other-answer', 'assistant', `OTHER_ANSWER_${name}_${index}：独立任务结果。`, 1)]
        if (index === 2) {
          const previousRunId = `${child.runId}-previous`, previousTurn = `${child.childSessionId}-failed-previous`, currentTurn = `${child.childSessionId}-failed-current`
          const previousMetadata = { rootRunId: run.runId, subagentRunId: previousRunId }
          const currentMetadata = { rootRunId: run.runId, subagentRunId: child.runId }
          rows.push(
            { ...row('failure-prompt', 'user', '继续核对接口。', 2), conversationId: previousTurn, metadata: previousMetadata },
            { ...row('failure-with-content', 'assistant', beforeFailure, 3), conversationId: previousTurn, metadata: previousMetadata },
            { ...row('failure-duplicate', 'assistant', failureDiagnostic, 4), conversationId: previousTurn,
              metadata: { ...previousMetadata, error: failureDiagnostic, status: 'failed' } },
            { ...row('failure-retry-prompt', 'user', '再试一次未完成的核对。', 5), conversationId: currentTurn, metadata: currentMetadata },
            { ...row('failure-only', 'assistant', failureDiagnostic, 6), conversationId: currentTurn,
              error: failureDiagnostic, metadata: { ...currentMetadata, status: 'failed' } }
          )
          child.status = 'failed'
          child.error = { code: 'SUBAGENT_EXECUTION_FAILED', message: failureDiagnostic, retryable: true }
          delete child.resultSummary
        }
        archives.set(child.childSessionId, rows)
      }
    }
  }
  function parentHistory(id: string): EngineHistoryRow[] {
    const run = roots.get(id)
    if (!run) return []
    const text = `阅读任务已就绪：${title(id)}`
    // This ledger fixture has real /changes but no deliver_files manifest.
    // An empty published manifest intentionally selects the delivery-only UI.
    return [{ id: run.userMessageId, role: 'user', content: title(id), conversationId: run.turnId, createdAt: now,
      metadata: { rootRunId: run.runId } }, { id: run.assistantMessageId, role: 'assistant', content: text,
      conversationId: run.turnId, createdAt: now + 1, metadata: { rootRunId: run.runId } }]
  }
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    const id = url.searchParams.get('sessionId') ?? '', current = roots.get(id), rows = parentHistory(id)
    response.setHeader('content-type', 'application/json')
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
    // Retained Code surfaces probe these services during boot. This reading
    // fixture advertises them as unavailable instead of misclassifying their
    // capability registration as a user chat/change write.
    if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
      capabilityProbes.push(`${request.method} ${path}`)
      response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Capability is unavailable in the compact reading fixture', data: null })); return
    }
    if (request.method !== 'GET' && (path === '/api/v1/chat' || /^\/api\/v1\/changes(?:\/|$)/.test(path))) {
      mutations.push(`${request.method} ${path}`); throw new Error(`Reading must not mutate or submit work: ${path}`)
    }
    if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
      response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Unsupported fixture operation', data: null })); return
    }
    if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    if (path === '/api/v1/subagent/runs') {
      const parent = url.searchParams.get('parentSessionId')
      response.end(envelope({ schemaVersion: 2, runs: [...children.values()].filter(child => child.parentSessionId === parent),
        listComplete: true, hasMore: false, revision: `directory-${name}-${parent}` })); return
    }
    const childPath = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/(tools|events))?$/)
    if (childPath) {
      const child = children.get(decodeURIComponent(childPath[1])), parent = url.searchParams.get('parentSessionId')
      if (!child || parent && child.parentSessionId !== parent) throw new Error('Child ownership mismatch')
      runReads.push({ runId: child.runId, parentSessionId: parent })
      response.end(envelope(childPath[2] === 'tools' ? { schemaVersion: 2, runId: child.runId, asOfSeq: 1, totalCount: 0, items: [], hasMore: false }
        : childPath[2] === 'events' ? { schemaVersion: 2, runId: child.runId, events: [], nextSeq: 1, hasMore: false, checkpointRequired: false } : child)); return
    }
    if (path === '/api/v1/conversation/archive') {
      const archive = archives.get(id)
      if (!archive) throw new Error(`Foreign archive requested: ${id}`)
      const paged = url.searchParams.has('current') || url.searchParams.has('pageSize')
      const currentPage = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
      reads.push({ sessionId: id, current: paged ? currentPage : null, pageSize: paged ? pageSize : null })
      const body = JSON.stringify({ code: 200, message: 'ok', data: paged ? archive.slice((currentPage - 1) * pageSize, currentPage * pageSize) : archive,
        ...(paged ? { pagination: { current: currentPage, pageSize, total: archive.length, totalPages: Math.ceil(archive.length / pageSize) } } : {}),
        metadata: { archiveMessageCount: archive.length, archiveRevision: `${name}-${id}-${archiveRevision}`, backend: 'jsonl', compressed: false } })
      if (held?.sessionId === id && (!paged || held.current === currentPage && pageSize === 50)) { held.response = response; held.body = body; return }
      response.end(body); return
    }
    if (path === '/api/v1/conversation/display') {
      const users = rows.filter(row => row.role === 'user')
      response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
        conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
        loadedTurnIds: users.map(row => row.id), revision: `${name}-${id}-stable`, mutationRevision: `${name}-${id}-unchanged`, backend: 'jsonl', completeness: 'complete' })); return
    }
    if (path === '/api/v1/changes') {
      const own = id === taskA ? changes : []
      response.end(envelope(url.searchParams.get('view') === 'net' && own.length ? [
        { ...changes[1], id: 'report-net', isNew: true, oldContent: null, changeIds: ['report-v1', 'report-v2'] }, changes[2]
      ] : own)); return
    }
    if (path === '/api/v1/workspace/file/content') {
      const path = url.searchParams.get('path') ?? ''
      fileReads.push({ sessionId: id, path })
      if (id !== taskA || !['reports/接口审阅结果与兼容性说明.txt', 'notes.txt'].includes(path)) throw new Error('Crossed artifact workspace')
      const content = path === 'notes.txt' ? changes[2].newContent! : changes[1].newContent!
      response.end(envelope({ content, isBinary: false, totalSize: Buffer.byteLength(content), root: `/remote/compact/${name}`, bindingEpoch: 'one' })); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(envelope(null)); return }
    const ownChildren = [...children.values()].filter(child => child.parentSessionId === id)
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: `compact-${name}` }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '阅读测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
        history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: ownChildren, todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
      : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
      : path === '/api/v1/conversation/history' ? rows
      : path === '/api/v1/conversation/sessions' ? [taskA, taskB].map(sessionId => ({ sessionId, title: title(sessionId), lastAt: now, messageCount: 2 }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: `compact-${name}`, sessionId: id,
        namespace: { id: `compact-${name}-db`, generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
      : path === '/api/v1/workspace/directory' ? { root: `/remote/compact/${name}`, bindingEpoch: 'one', entries: [] }
      : path === '/api/v1/workspace/bind' ? { workspaceRoot: `/remote/compact/${name}` }
      : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
      : path === '/api/v1/command-jobs' ? { jobs: [] } : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })
  return { name, title, agentName, instruction, finalText, thinking, failureDiagnostic, beforeFailure, roots, children, archives, reads, runReads, fileReads, capabilityProbes, reportPath, server,
    holdArchive(sessionId: string, current: number) {
      if (held) throw new Error('An archive is already held')
      // Freeze a new snapshot so changing the selected source can race with a
      // genuine pending archive response rather than a reused local view.
      archiveRevision++; held = { sessionId, current }
    },
    isHeld: () => Boolean(held?.response), releaseArchive() { held?.response?.end(held.body); held = undefined } }
}
const first = makeEngine('FIRST'), second = makeEngine('SECOND')
type Engine = ReturnType<typeof makeEngine>
function origin(engine: Engine): string {
  const address = engine.server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}
let app: ElectronApplication | undefined, page: Page, fixture = ''
const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '协作代理', exact: true })
const transcript = (): Locator => panel().locator('.work-subagent-transcript')
const scroller = (): Locator => transcript().locator('.work-subagent-transcript__scroll')
const message = (suffix: string): Locator => transcript().locator(`[data-message-id="compact-child-1-${suffix}"]`)
async function openChildren(): Promise<void> {
  if (!(await workspace().isVisible())) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  const tab = workspace().getByRole('tab', { name: '子代理', exact: true })
  if (await tab.isVisible()) await tab.click()
  else { await workspace().getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '子代理', exact: true }).click() }
  await expect(panel()).toBeVisible()
}
async function selectChild(index: number): Promise<void> {
  const back = panel().getByRole('button', { name: '返回子代理列表', exact: true })
  if (await back.isVisible()) await back.click()
  await panel().getByRole('button', { name: `查看 阅读代理 ${index} 子代理详情`, exact: true }).click()
  await expect(transcript()).toHaveAttribute('aria-label', `阅读代理 ${index} 的对话`)
  await expect(scroller()).toHaveAttribute('aria-busy', 'false')
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.modal-overlay:has([role="dialog"][aria-label="设置"])')).toHaveCount(0)
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus() }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function settleMotion(target: Locator): Promise<void> {
  await target.evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
}
async function selectTask(engine: Engine, id: string): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: engine.title(id) }).click()
  await expect(work().getByRole('heading', { name: engine.title(id), exact: true })).toBeVisible()
  await openChildren()
}

test.describe.serial('子代理紧凑阅读', () => {
  test.beforeAll(async () => {
    for (const engine of [first, second]) await new Promise<void>((done, reject) => { engine.server.once('error', reject); engine.server.listen(0, '127.0.0.1', done) })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'compact-reading-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin(first), autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/compact', lastSessionId: '', lastModelId: model, appearance: 'light', lastFolder: '', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(name.toUpperCase())) delete env[name]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await setWindow(1440, 900)
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const seeds = [first, second].map(engine => ({ key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin(engine) })),
      tasks: [taskA, taskB].map(id => ({ id, title: engine.title(id), status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: null, modelId: model, attachments: [], sources: [] })) }))
    await page.evaluate(({ seeds, activeTaskId }) => {
      for (const seed of seeds) localStorage.setItem(seed.key, JSON.stringify({ tasks: seed.tasks, activeTaskId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'subagents', pane: 'workspace', ratio: 56 }))
    }, { seeds, activeTaskId: taskA })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: first.title(taskA), exact: true })).toBeVisible()
    await openChildren(); await selectChild(1)
    await expect(message('instruction')).toBeAttached()
  })
  test.afterEach(async ({}, info) => {
    for (const engine of [first, second]) engine.releaseArchive()
    await info.attach('reading-http-receipts', { body: JSON.stringify({ first: { archives: first.reads, ownership: first.runReads, files: first.fileReads, capabilityProbes: first.capabilityProbes }, second: { archives: second.reads, ownership: second.runReads, files: second.fileReads, capabilityProbes: second.capabilityProbes }, mutations, errors }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
    await expect(panel().getByRole('alert')).toHaveCount(0)
  })
  test.afterAll(async () => {
    for (const engine of [first, second]) engine.releaseArchive()
    try { await app?.close() }
    finally {
      for (const engine of [first, second]) { engine.server.closeAllConnections(); await new Promise<void>(done => engine.server.close(() => done())) }
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('compact-reading-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('长用户消息以有限预览气泡呈现，展开保留全文和滚动锚点，折叠过程不挂载长正文', async ({}, info) => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(520, 600))
    const instruction = message('instruction'), summary = instruction.getByRole('button', { name: '展开用户消息全文', exact: true })
    expect(first.instruction.length).toBeGreaterThan(120_000)
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(instruction.locator('.work-subagent-instruction__body--preview')).toHaveCount(1)
    await expect(instruction).not.toContainText('INSTRUCTION_END_FIRST')
    await expect(instruction.locator('.work-subagent-instruction__meta > span')).toHaveText('用户')
    await expect(instruction.locator('time')).toHaveAttribute('datetime', new Date(now + 50).toISOString())
    await expect(instruction.getByRole('button', { name: '用户消息详情', exact: true })).toHaveCount(0)
    await expect(work().getByRole('region', { name: '协作对话', exact: true }).locator('.work-subagent-instruction')).toHaveCount(0)
    await expect(transcript()).not.toContainText(/继续阅读|继续展开|还有\s*[\d,]+\s*字符/)
    for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 980, 560]) {
      await setWindow(width, 800); await setAppearance(appearance); await openChildren()
      await instruction.scrollIntoViewIfNeeded(); await settleMotion(panel())
      const geometry = await instruction.evaluate(element => {
        const article = element.getBoundingClientRect(), scroll = element.closest('.work-subagent-transcript__scroll')!
        const box = scroll.getBoundingClientRect(), style = getComputedStyle(scroll)
        const label = element.querySelector('.message__bubble-content')!
        const meta = element.querySelector('.work-subagent-instruction__meta')!
        return { width: article.width, contentWidth: scroll.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight), height: article.height, labelHeight: label.getBoundingClientRect().height,
          panelWidth: element.closest('.work-subagents')!.getBoundingClientRect().width, metaHeight: meta.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight), textLength: label.textContent?.length ?? 0,
          rightGap: box.left + scroll.clientLeft + scroll.clientWidth - Number.parseFloat(style.paddingRight) - article.right,
          overflow: element.scrollWidth > element.clientWidth + 1, viewportOverflow: scroll.scrollWidth > scroll.clientWidth + 1 }
      })
      expect(geometry.width).toBeLessThanOrEqual((geometry.panelWidth <= 480 ? geometry.contentWidth * .94 : Math.min(620, geometry.contentWidth * .88)) + 1)
      expect(geometry.width).toBeLessThan(geometry.contentWidth)
      expect(geometry.height).toBeLessThanOrEqual(geometry.metaHeight + 6 * geometry.lineHeight + 32)
      expect(geometry.labelHeight).toBeLessThanOrEqual(6 * geometry.lineHeight + 1)
      expect(geometry.textLength).toBeLessThanOrEqual(321)
      expect(Math.abs(geometry.rightGap)).toBeLessThanOrEqual(1)
      expect(geometry.overflow).toBe(false); expect(geometry.viewportOverflow).toBe(false)
      const path = info.outputPath(`compact-instruction-${appearance}-${width}.png`)
      await page.screenshot({ path }); await info.attach(`子代理摘要 ${appearance} ${width}`, { path, contentType: 'image/png' })
    }
    await setWindow(1440, 900)
    await summary.focus(); await page.keyboard.press('Enter')
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toBeFocused()
    await expect(instruction.locator('.work-subagent-instruction__body--preview')).toHaveCount(0)
    await expect.poll(() => instruction.locator('.message__bubble-content').textContent()).toBe(first.instruction)
    await expect(instruction.getByRole('button', { name: /继续阅读|继续展开/ })).toHaveCount(0)
    for (const [appearance, width] of [['dark', 1440], ['light', 980]] as const) {
      await setWindow(width, 800); await setAppearance(appearance); await openChildren()
      const workspacePane = work().locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
      if (await workspacePane.isVisible()) await workspacePane.click()
      await expect(instruction).toBeVisible(); await settleMotion(instruction)
      await scroller().evaluate(element => {
        const article = element.querySelector('[data-message-id="compact-child-1-instruction"]')!
        element.scrollTop += article.getBoundingClientRect().top - element.getBoundingClientRect().top + 1200
      })
      await expect.poll(() => instruction.evaluate(element => element.getBoundingClientRect().top -
        element.closest('.work-subagent-transcript__scroll')!.getBoundingClientRect().top)).toBeLessThan(-500)
      await settleMotion(panel())
      const sticky = await instruction.evaluate(element => {
        const scroll = element.closest('.work-subagent-transcript__scroll')!
        const viewport = scroll.getBoundingClientRect(), viewportTop = viewport.top + scroll.clientTop
        const header = element.querySelector('.work-subagent-instruction__meta')!
        const summary = header.getBoundingClientRect(), label = header.querySelector('span')!.getBoundingClientRect()
        // The identity line remains reachable while reading a long message.
        // Probe its background as well as text, without relying on DPR rounding.
        const points = [
          { label: 'viewport-left', x: summary.left + 8, y: viewportTop + 1 },
          { label: 'viewport-right', x: summary.right - 8, y: viewportTop + 1 },
          { label: 'text-top', x: label.left + 1, y: label.top + 1 },
          { label: 'text-bottom', x: label.left + 1, y: label.bottom - 1 }
        ]
        return { viewportTop, summaryTop: summary.top, summaryBottom: summary.bottom, scrollTop: scroll.scrollTop,
          position: getComputedStyle(header).position,
          articleTop: element.getBoundingClientRect().top, dpr: devicePixelRatio,
          points: points.map(point => {
            const hit = document.elementFromPoint(point.x, point.y)
            return { ...point, covered: hit !== null && header.contains(hit), hit: hit?.tagName,
              hitClass: hit instanceof HTMLElement ? hit.className : null }
          }) }
      })
      const path = info.outputPath(`compact-instruction-scrolled-${appearance}-${width}.png`)
      await page.screenshot({ path }); await info.attach(`长指令滚动 ${appearance} ${width}`, { path, contentType: 'image/png' })
      const evidence = JSON.stringify(sticky)
      expect(sticky.position).toBe('sticky')
      expect(Math.abs(sticky.summaryTop - sticky.viewportTop), evidence).toBeLessThanOrEqual(1)
      expect(sticky.points.every(point => point.covered), evidence).toBe(true)
    }
    await instruction.getByRole('button', { name: '收起用户消息', exact: true }).click()
    await expect(instruction.locator('.work-subagent-instruction__body--preview')).toHaveCount(1)
    await expect(instruction).not.toContainText('INSTRUCTION_END_FIRST')
    const collapsedPosition = await instruction.evaluate(element => {
      const row = element.getBoundingClientRect(), scroll = element.closest('.work-subagent-transcript__scroll')!.getBoundingClientRect()
      return { top: row.top - scroll.top, bottom: row.bottom - scroll.top, viewport: scroll.height }
    })
    expect(collapsedPosition.top).toBeGreaterThanOrEqual(-1)
    expect(collapsedPosition.bottom).toBeLessThanOrEqual(collapsedPosition.viewport + 1)
    await setWindow(1440, 900)

    const thinking = message('thinking-only')
    await expect(thinking.getByRole('button', { name: '展开过程', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(thinking.getByRole('button', { name: '继续阅读', exact: true })).toHaveCount(0)
    await expect(thinking.locator('.work-assistant-content')).toHaveCount(0)
    await expect(thinking.locator('.logline__detail pre')).toHaveCount(0)
    await expect(thinking).not.toContainText('THINKING_END_FIRST')
    await thinking.getByRole('button', { name: '展开过程', exact: true }).click()
    await expect(thinking.locator('.logline')).toHaveCount(0)
    await thinking.getByRole('button', { name: '显示思考', exact: true }).click()
    await expect(thinking.locator('.logline')).toHaveAttribute('aria-expanded', 'false')
    await expect(thinking.getByRole('button', { name: '继续阅读', exact: true })).toHaveCount(0)
    await thinking.locator('.logline').click()
    await expect.poll(() => thinking.locator('.logline__detail pre').textContent()).toBe(first.thinking)
    await expect(thinking.getByRole('button', { name: /继续阅读|继续展开/ })).toHaveCount(0)
    await thinking.getByRole('button', { name: '收起过程', exact: true }).click()
    await expect(thinking.locator('.logline__detail pre')).toHaveCount(0)
    await expect(thinking).not.toContainText('THINKING_END_FIRST')
    await expect(message('short-answer')).toContainText('SHORT_FINAL_FIRST：核对完成。')
    await expect(message('short-answer').getByRole('button', { name: '继续阅读', exact: true })).toHaveCount(0)

    const answer = message('answer')
    await expect(answer).toContainText('FINAL_END_FIRST')
    expect((await answer.textContent())!.match(/RESULT_SEGMENT_\d{3}/g)).toHaveLength(95)
    await expect(answer.getByRole('button', { name: /继续阅读|继续展开/ })).toHaveCount(0)
    await answer.getByRole('button', { name: '复制回复', exact: true }).click()
    // Native Windows clipboard text uses CRLF; compare every content character
    // after normalizing that platform newline convention only.
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(first.finalText)
    // Leave this expanded for the memory assertions in the following scenario.
    await summary.click()
    await expect(instruction.locator('.message__bubble-content')).toContainText('INSTRUCTION_END_FIRST')
  })

  test('失败正文与状态只显示一次提示，不同轮次各自保留诊断和失败前正文', async ({}, info) => {
    await selectChild(2)
    const withContent = transcript().locator('[data-message-id="compact-child-2-failure-with-content"]')
    const errorOnly = transcript().locator('[data-message-id="compact-child-2-failure-only"]')
    const failures = transcript().locator('.work-subagent-transcript__failure')
    const summary = '模型服务暂时异常，本次执行未完成。请稍后重试。'
    await expect(failures).toHaveCount(2)
    await expect(withContent.locator('.work-subagent-transcript__failure')).toHaveCount(1)
    await expect(errorOnly.locator('.work-subagent-transcript__failure')).toHaveCount(1)
    await expect(failures.locator('.work-error-notice__reason')).toHaveText([summary, summary])
    await expect(withContent.locator('.work-assistant-content')).toHaveText(first.beforeFailure)
    await expect(transcript()).toContainText('OTHER_ANSWER_FIRST_2')
    await expect(errorOnly.locator('.work-assistant-content')).toHaveCount(0)
    await expect(errorOnly.getByRole('button', { name: '复制回复', exact: true })).toHaveCount(0)
    await expect(transcript()).not.toContainText(/500 event:error|InternalError|inference abort|request_id|DIAGNOSTIC_END/)
    await expect(page.locator('.work-error-diagnostics__detail')).toHaveCount(0)
    await expect(failures.getByRole('button', { name: /重试|重启/ })).toHaveCount(0)
    await withContent.hover()
    await withContent.getByRole('button', { name: '复制回复', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(first.beforeFailure)
    const screenshot = info.outputPath('compact-child-errors.png')
    await page.screenshot({ path: screenshot }); await info.attach('不同轮次的简洁失败提示', { path: screenshot, contentType: 'image/png' })
    for (const [message, runId] of [[withContent, 'compact-child-run-2-previous'], [errorOnly, 'compact-child-run-2']] as const) {
      await message.getByRole('button', { name: '任务恢复更多操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '查看诊断详情', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '诊断详情', exact: true })
      await expect(dialog).toBeVisible()
      const detail = dialog.locator('.work-error-diagnostics__detail')
      await expect(detail).toContainText(`运行 ID：${runId}`)
      await expect(detail).toContainText(first.failureDiagnostic)
      expect((await detail.textContent())!.split(first.failureDiagnostic)).toHaveLength(2)
      await dialog.getByRole('button', { name: '复制诊断', exact: true }).click()
      const fullDetail = (await detail.textContent())!
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(fullDetail)
      await dialog.getByRole('button', { name: '完成', exact: true }).click()
      await expect(page.locator('.work-error-diagnostics__detail')).toHaveCount(0)
    }
    await expect(failures).toHaveCount(2)
    await expect(transcript()).not.toContainText(first.failureDiagnostic)
    await selectChild(1)
  })

  test('完整历史与展开滚动草稿保留，切父任务或引擎时旧快照不能串入当前对话', async () => {
    const instruction = message('instruction'), answer = message('answer')
    const draft = panel().getByRole('textbox', { name: '继续交给 阅读代理 1', exact: true })
    await draft.fill('保留未发送的审阅要求，不应交给别的任务或引擎')
    await scroller().evaluate(element => { element.scrollTop = 120 })
    await expect.poll(() => scroller().evaluate(element => element.scrollTop)).toBe(120)
    await selectChild(2)
    await expect(transcript()).toContainText('OTHER_ANSWER_FIRST_2')
    await expect(panel().getByRole('textbox', { name: '继续交给 阅读代理 2', exact: true })).toHaveValue('')
    await selectChild(1)
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(answer).toContainText('FINAL_END_FIRST')
    await expect(draft).toHaveValue('保留未发送的审阅要求，不应交给别的任务或引擎')
    await expect.poll(() => scroller().evaluate(element => element.scrollTop)).toBeCloseTo(120, 0)
    await expect(transcript().getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
    await expect(transcript().locator('[data-message-id="compact-child-1-old-0"]')).toContainText('OLD_PAGE_FIRST_0')
    expect(first.reads).toContainEqual({ sessionId: 'compact-child-1', current: null, pageSize: null })
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(answer).toContainText('FINAL_END_FIRST')

    first.holdArchive('compact-child-1', 1)
    await panel().getByRole('button', { name: '刷新子代理对话', exact: true }).click()
    await expect.poll(() => first.isHeld()).toBe(true)
    await selectTask(first, taskB); await selectChild(3)
    await expect(transcript()).toContainText('OTHER_ANSWER_FIRST_3')
    first.releaseArchive(); await settleMotion(panel())
    await expect(transcript()).not.toContainText('OLD_PAGE_FIRST_0')
    await expect(transcript()).not.toContainText('INSTRUCTION_END_FIRST')
    await expect(panel().getByRole('textbox', { name: '继续交给 阅读代理 3', exact: true })).toHaveValue('')
    await selectTask(first, taskA); await selectChild(1)
    await expect(draft).toHaveValue('保留未发送的审阅要求，不应交给别的任务或引擎')
    await expect(instruction.getByRole('button', { name: '收起用户消息', exact: true })).toHaveAttribute('aria-expanded', 'true')

    first.holdArchive('compact-child-1', 1)
    await panel().getByRole('button', { name: '刷新子代理对话', exact: true }).click()
    await expect.poll(() => first.isHeld()).toBe(true)
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '引擎管理', exact: true }).click()
    await settings.getByRole('textbox', { name: '远端地址', exact: true }).fill(origin(second))
    await settings.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await expect(settings.locator('.engine-status__hero')).toContainText(origin(second))
    await expect(settings.locator('.engine-status__badge')).toHaveText('已连接')
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('.modal-overlay:has([role="dialog"][aria-label="设置"])')).toHaveCount(0)
    await expect(work().getByRole('heading', { name: second.title(taskA), exact: true })).toBeVisible()
    await openChildren(); await selectChild(1)
    await expect(message('tail-answer')).toContainText('TAIL_ANSWER_SECOND')
    first.releaseArchive(); await settleMotion(panel())
    await expect(transcript()).not.toContainText('FIRST')
    await expect(draft).toHaveValue('')
    await expect(instruction.getByRole('button', { name: '展开用户消息全文', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(answer).toContainText('FINAL_END_SECOND')
    await expect(answer.getByRole('button', { name: /继续阅读|继续展开/ })).toHaveCount(0)
    await expect(transcript().getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
    await expect(transcript().locator('[data-message-id="compact-child-1-old-0"]')).toContainText('OLD_PAGE_SECOND_0')
    expect(second.reads).toContainEqual({ sessionId: 'compact-child-1', current: null, pageSize: null })
    expect(second.runReads.some(read => read.runId === 'compact-child-run-1' && read.parentSessionId === taskA)).toBe(true)
  })

  test('成果两级工具栏保持搜索、版本与文件信息可用，宽窄窗口不挤占阅读区', async ({}, info) => {
    const artifacts = workspace().getByRole('region', { name: '本会话成果与改动', exact: true })
    const tab = workspace().getByRole('tab', { name: '成果', exact: true })
    if (await tab.isVisible()) await tab.click()
    else { await workspace().getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '成果', exact: true }).click() }
    await expect(workspace().locator('[data-final-result-fallback="changes"]')).toBeVisible()
    await expect(artifacts).toHaveAttribute('data-session-id', taskA)
    await expect(artifacts.locator('.work-session-artifacts__header')).toContainText('2 个文件')
    const search = artifacts.getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
    await search.fill('不存在的文件')
    await expect(artifacts.getByRole('status')).toHaveText('当前范围没有匹配的文件。')
    await search.fill('接口审阅结果')
    await expect(artifacts.locator('.work-session-artifacts__header')).toContainText('1 / 2 个文件')
    await expect(artifacts.locator('.work-session-artifacts__file-header strong')).toHaveText('接口审阅结果与兼容性说明.txt')
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', 'report-net')
    await expect(artifacts.locator('.work-change-review__count')).toHaveAttribute('aria-label', '2 条修改待确认')
    await artifacts.getByRole('button', { name: '批量改动操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '保留待确认改动', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '保留待确认改动', exact: true })
    await expect(confirmation).toContainText('以下 1 个文件的 2 处改动')
    await expect(confirmation).toContainText('接口审阅结果与兼容性说明.txt')
    await expect(confirmation).not.toContainText('notes.txt')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.modal[aria-label="保留待确认改动"]')).toHaveCount(0)
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: /^修改记录/ }).click()
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-diff-scope', 'operation')
    const versions = artifacts.getByRole('button', { name: '选择单次修改', exact: true })
    await expect(versions).toHaveText(/记录 \d \/ 2/)
    await versions.click()
    const versionMenu = page.getByRole('menu', { name: '选择单次修改', exact: true })
    await expect(versionMenu.getByRole('menuitem')).toHaveCount(2)
    await expect(versionMenu.getByRole('menuitem').first()).toContainText(new Date(now).getFullYear().toString())
    await versionMenu.getByRole('menuitem').last().click()
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', 'report-v1')
    await expect(artifacts.locator('.work-session-artifacts__diff')).toContainText('REPORT_FIRST_SECOND')
    await artifacts.getByRole('button', { name: '文件改动信息', exact: true }).click()
    const details = page.getByRole('dialog', { name: '文件改动信息', exact: true })
    await expect(details).toHaveAttribute('data-motion-state', 'open'); await settleMotion(details)
    await expect(details).toContainText(second.reportPath)
    const selectedTime = await page.evaluate(timestamp => new Date(timestamp).toLocaleString(), now + 1000)
    await expect(details.locator('dl > div').filter({ has: page.locator('dt', { hasText: '当前记录' }) }).locator('time')).toHaveText(selectedTime)
    await expect(details).toHaveCSS('opacity', '1')
    expect(await details.evaluate(element => getComputedStyle(element).transitionProperty)).not.toMatch(/opacity|all/)
    await page.keyboard.press('Escape'); await expect(page.locator('.work-session-artifacts__info-panel')).toHaveCount(0)
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: /^当前内容/ }).click()
    await expect(artifacts.locator('[data-artifact-view="current"]')).toContainText('REPORT_CURRENT_SECOND')
    expect(second.fileReads).toContainEqual({ sessionId: taskA, path: 'reports/接口审阅结果与兼容性说明.txt' })
    await artifacts.getByRole('button', { name: '差异范围', exact: true }).click()
    await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: /^待确认改动/ }).click()
    await expect(artifacts.locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', 'report-net')
    for (const [appearance, width] of [['light', 1440], ['dark', 980]] as const) {
      await setWindow(width, 800); await setAppearance(appearance)
      // Narrow windows show one pane at a time; choose the workspace through
      // its real control before measuring the visible file reader.
      const workspacePane = work().locator('.work-mobile-tabs').getByRole('button', { name: '工作区', exact: true })
      if (await workspacePane.isVisible()) await workspacePane.click()
      await expect(artifacts).toBeVisible(); await settleMotion(artifacts)
      const geometry = await artifacts.evaluate(element => {
        const controls = element.querySelector('.work-session-artifacts__controls')!.getBoundingClientRect()
        const batch = element.querySelector('.work-session-artifacts__batch')!.getBoundingClientRect()
        const split = element.querySelector('.work-session-artifacts__split')!.getBoundingClientRect()
        const header = element.querySelector('.work-session-artifacts__file-header')!.getBoundingClientRect()
        const detail = element.querySelector('.work-session-artifacts__diff')!.getBoundingClientRect()
        return { overflow: element.scrollWidth > element.clientWidth + 1, controlsBottom: controls.bottom, batchTop: batch.top,
          batchBottom: batch.bottom, splitTop: split.top, headerHeight: header.height, bodyHeight: detail.height,
          singleLine: getComputedStyle(element.querySelector('.work-session-artifacts__file-header strong')!).whiteSpace }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.batchTop + 1)
      expect(geometry.batchBottom).toBeLessThanOrEqual(geometry.splitTop + 1)
      expect(geometry.headerHeight).toBeLessThanOrEqual(48)
      expect(geometry.bodyHeight).toBeGreaterThanOrEqual(180)
      expect(geometry.singleLine).toBe('nowrap')
      await expect(artifacts).not.toContainText('任务结束后可确认')
      const path = info.outputPath(`compact-artifacts-${appearance}-${width}.png`)
      await page.screenshot({ path }); await info.attach(`成果工具栏 ${appearance} ${width}`, { path, contentType: 'image/png' })
    }
  })
})
