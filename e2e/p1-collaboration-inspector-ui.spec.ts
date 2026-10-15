/** Fresh Electron + authenticated HTTP fixture for the current P1 inspector.
 * Proves explicit reads, exact owner queries, bounded page replacement, capability
 * honesty, hostile-page rejection, keyboard access and narrow-window layout. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'

const root = resolve(__dirname, '..'), token = 'p1-collaboration-inspector-token', modelId = 'p1-collaboration-fixture'
const capability = { protocolVersion: 1, durableQueueReceipts: true, receiptPagination: true, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false }
const reads: Array<{ method: string; path: string; query: Record<string, string> }> = [], errors: string[] = []
let fixture = '', app: ElectronApplication | undefined, page: Page, sessionId = '', malformed = false
let run: RootRun | undefined, child: SubagentRunView | undefined
let history: EngineHistoryRow[] = []
let legacyArchive = false
let filteredFirstPage = false
const archiveReads: Array<{ sessionId: string; current: number; pageSize: number }> = []
const legacyRows = (child = false, epoch = 'snapshot'): EngineHistoryRow[] => Array.from({ length: child ? 151 : 601 }, (_, index) => ({
  id: `${child ? 'child' : 'root'}-archive-${index}`, role: index % 2 ? 'assistant' : 'user', conversationId: `archive-turn-${Math.floor(index / 2)}`,
  content: `ARCHIVE_${child ? 'CHILD' : 'ROOT'}_${epoch}_ROW_${index}`, modelId, createdAt: 1_700_000_000_000 + index }))
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function receipt(seq: number) { return { messageId: `receipt-${seq}`, rootRunId: run!.runId, rootAttemptId: 'trusted-attempt', senderParticipantId: 'root', senderInvocationRunId: run!.runId,
  recipientParticipantId: malformed ? 'child:foreign' : 'child:inspector-child', requestKey: `request-${seq}`, payloadHash: 'a'.repeat(64), payloadBytes: 10, acceptedSeq: seq, acceptedAt: Date.now(), state: 'queued' } }
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    response.setHeader('content-type', 'application/json')
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    if (path.startsWith('/api/v1/collaboration/')) reads.push({ method: request.method ?? '', path, query: Object.fromEntries(url.searchParams.entries()) })
    let body = ''; for await (const part of request) body += part.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const input = JSON.parse(body) as { sessionId: string; message: string }, now = Date.now()
      sessionId = input.sessionId
      run = { schemaVersion: 1, runId: 'inspector-root', sessionId, turnId: 'inspector-turn', userMessageId: 'inspector-user', assistantMessageId: 'inspector-assistant',
        version: 1, seq: 4, status: 'succeeded', modelId, createdAt: now, updatedAt: now, finishedAt: now, pending: [] }
      child = { schemaVersion: 2, view: 'summary', runId: 'inspector-child-run', tenantId: 'inspector-tenant', rootSessionId: sessionId, parentSessionId: sessionId,
        parentConversationId: run.turnId, parentMessageId: run.assistantMessageId, parentToolCallId: 'inspector-delegate', childSessionId: 'inspector-child',
        agentName: '回执检查代理', modelId, task: '保持独立工作，检查协作回执', description: '协作观测夹具', status: 'running', lastSeq: 1,
        createdAt: now, updatedAt: now, startedAt: now, usage: {}, toolCount: 0, activeToolCount: 0, toolCalls: [],
        coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
      history = [{ id: run.userMessageId, role: 'user', content: input.message, conversationId: run.turnId, createdAt: now }, { id: run.assistantMessageId, role: 'assistant', content: '协作观测任务已建立', conversationId: run.turnId, createdAt: now }]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frames = [{ userMessage: history[0] }, { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: child.runId, seq: 1, view: child } }, { content: '协作观测任务已建立' }, { run }]
      frames.forEach((frame, index) => response.write(`id: inspector-root:${index + 1}\ndata: ${JSON.stringify(frame)}\n\n`))
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/collaboration/capabilities') { response.end(envelope(capability)); return }
    if (path.endsWith('/controller-context')) {
      response.end(envelope({ outcome: 'ready', scope: { rootRunId: run!.runId, rootAttemptId: 'trusted-attempt', rootSessionId: sessionId },
        participants: { entries: [], revision: 2, hasMore: false }, recipient: { participantId: 'child:inspector-child', kind: 'child', sessionId: 'inspector-child', invocationRunId: child!.runId, admittedSeq: 2, admittedAt: Date.now() } })); return
    }
    if (path.endsWith('/participants/child%3Ainspector-child/receipts')) {
      const cursor = url.searchParams.get('cursor'), entries = cursor ? [receipt(25)] : Array.from({ length: 24 }, (_, index) => receipt(index + 1))
      response.end(envelope({ entries, revision: 25, hasMore: !cursor, ...(!cursor ? { nextCursor: 'trusted-page-two' } : {}) })); return
    }
    if (path === '/api/v1/subagent/capabilities') { response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return }
    if (path === '/api/v1/subagent/runs') { response.end(envelope({ schemaVersion: 2, runs: child ? [child] : [], listComplete: true, hasMore: false, revision: 'inspector-directory' })); return }
    if (path === '/api/v1/subagent/runs/inspector-child-run') { response.end(envelope(child)); return }
    if (path === '/api/v1/conversation/archive') {
      const id = url.searchParams.get('sessionId') ?? '', current = Number(url.searchParams.get('current')), pageSize = Number(url.searchParams.get('pageSize'))
      archiveReads.push({ sessionId: id, current, pageSize })
      const rows = legacyRows(id === 'inspector-child', `PAGE_${current}`).map((row, index) => filteredFirstPage && id === sessionId && index < 200 ? { ...row, role: 'system' } : row)
      response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize),
        pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, backend: 'sqlite' } })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'p1-inspector-instance' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'P1 观测模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: url.searchParams.get('sessionId') ?? '', source: 'persisted', eventId: run ? 'inspector-root:4' : null,
            finished: true, projection: [], history: url.searchParams.get('sessionId') === sessionId ? legacyArchive ? legacyRows().slice(-2) : history : [], historyCompacted: legacyArchive, run, runs: run ? [run] : [], subagentRuns: child ? [child] : [], todos: [], changes: [], commandJobs: [] }
            : path === '/api/v1/chat/status' ? { running: false, finished: true, run }
              : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
                : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
                    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
                      : path === '/api/v1/workspace/directory' ? { root: '/remote/inspector', entries: [] }
                        : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/inspector' } : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(envelope(null)) })
})

test.describe.serial('P1 当前协作回执检查器', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'p1-collaboration-inspector-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/inspector', lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', lastFolder: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global'); delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterAll(async () => {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('p1-collaboration-inspector-')) throw new Error('Unsafe inspector fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('按需读取可信回执、替换有界分页并拒绝跨身份内容', async ({}, testInfo) => {
    const work = page.locator('.work-view')
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('独立检查协作回执的能力与证据')
    await work.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(work.getByRole('region', { name: '协作对话', exact: true })).toContainText('协作观测任务已建立')
    const workspace = work.getByRole('region', { name: '任务工作区', exact: true })
    if (!await workspace.isVisible()) await work.getByRole('button', { name: '打开工作区', exact: true }).click()
    await workspace.getByRole('tab', { name: '子代理', exact: true }).click()
    await workspace.getByRole('button', { name: '查看 回执检查代理 子代理详情', exact: true }).click()
    const inspector = workspace.locator('.collaboration-inspector')
    await expect(inspector).toBeVisible()
    expect(reads.filter(item => item.path.endsWith('/receipts'))).toHaveLength(0)
    await inspector.locator(':scope > summary').focus(); await page.keyboard.press('Enter')
    await expect(inspector).toHaveAttribute('open', '')
    expect(reads.filter(item => item.path.endsWith('/receipts'))).toHaveLength(0)
    await inspector.getByRole('button', { name: '读取协作回执', exact: true }).click()
    await expect(inspector.locator('.collaboration-inspector__list > details')).toHaveCount(24)
    await expect(inspector).toContainText('运行中通讯引擎未启用')
    await expect(inspector).toContainText('未提供消费确认')
    const contextRead = reads.find(item => item.path.endsWith('/controller-context'))
    expect(contextRead?.query).toEqual({ rootSessionId: sessionId, recipientParticipantId: 'child:inspector-child' })
    await inspector.getByRole('button', { name: '下一页回执', exact: true }).click()
    await expect(inspector.locator('.collaboration-inspector__list > details')).toHaveCount(1)
    await expect(inspector).toContainText('第 2 页 · 此页 1 条')
    const receiptReads = reads.filter(item => item.path.endsWith('/receipts'))
    expect(receiptReads.map(item => item.query.limit)).toEqual(['24', '24'])
    expect(receiptReads[1].query).toMatchObject({ rootAttemptId: 'trusted-attempt', rootSessionId: sessionId, cursor: 'trusted-page-two' })
    await inspector.getByRole('button', { name: '重新读取第一页', exact: true }).click()
    await expect(inspector.locator('.collaboration-inspector__list > details')).toHaveCount(24)
    malformed = true
    await inspector.getByRole('button', { name: '下一页回执', exact: true }).click()
    await expect(inspector.getByRole('alert')).toContainText('不属于当前任务与代理')
    await expect(inspector.locator('.collaboration-inspector__list > details')).toHaveCount(24)
    await expect(inspector).not.toContainText('child:foreign')
    expect(reads.every(item => item.method === 'GET')).toBe(true)
    expect(await inspector.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await testInfo.attach('p1-collaboration-http-evidence', { body: JSON.stringify(reads, null, 2), contentType: 'application/json' })
    await testInfo.attach('p1-collaboration-inspector', { body: await page.screenshot(), contentType: 'image/png' })
    expect(errors).toEqual([])
  })
  test('无版本归档的根任务与子代理双向单页导航，独立快照不能混入正文', async ({}, testInfo) => {
    legacyArchive = true
    await page.reload()
    const work = page.locator('.work-view'), conversation = work.getByRole('region', { name: '协作对话', exact: true })
    await expect(conversation).toContainText('ARCHIVE_ROOT_snapshot_ROW_600')
    const composer = conversation.getByRole('textbox', { name: '继续对话', exact: true })
    const draft = 'P1_ARCHIVE_NAVIGATION_PRESERVES_UNSENT_DRAFT'
    await composer.fill(draft)
    await conversation.getByRole('button', { name: '查看更早归档', exact: true }).click()
    await expect(conversation).toContainText('归档第 4 / 4 页')
    await expect(conversation.locator('.work-message')).toHaveCount(1)
    for (let current = 3; current >= 1; current--) {
      await conversation.getByRole('button', { name: /^查看更早归档（/ }).click()
      await expect(conversation).toContainText(`归档第 ${current} / 4 页`)
      await expect(conversation.locator('.work-message').first()).toContainText(`ARCHIVE_ROOT_PAGE_${current}_ROW_${(current - 1) * 200}`)
      expect(await conversation.locator('.work-message').count()).toBeLessThanOrEqual(180)
      await expect(conversation).not.toContainText('ARCHIVE_ROOT_snapshot_')
      await expect(composer).toHaveText(draft)
    }
    await conversation.getByRole('button', { name: /^查看较新消息/ }).click()
    await conversation.getByRole('button', { name: '查看较新归档页', exact: true }).click()
    await expect(conversation).toContainText('归档第 2 / 4 页')
    await conversation.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(conversation).toContainText('归档第 4 / 4 页')
    await expect(conversation.locator('.work-message')).toHaveCount(1)
    await expect(composer).toHaveText(draft)
    const workspace = work.getByRole('region', { name: '任务工作区', exact: true })
    if (!await workspace.isVisible()) await work.getByRole('button', { name: '打开工作区', exact: true }).click()
    await workspace.getByRole('tab', { name: '子代理', exact: true }).click()
    await workspace.getByRole('button', { name: '查看 回执检查代理 子代理详情', exact: true }).click()
    await workspace.getByRole('button', { name: '完整对话', exact: true }).click()
    const transcript = workspace.getByRole('region', { name: '回执检查代理 的完整对话', exact: true })
    await expect(transcript).toContainText('归档第 4 / 4 页')
    for (let current = 3; current >= 1; current--) {
      await transcript.getByRole('button', { name: '加载更早记录', exact: true }).click()
      await expect(transcript).toContainText(`归档第 ${current} / 4 页`)
      await expect(transcript.locator('[data-transcript-id]')).toHaveCount(50)
      await expect(transcript.locator('[data-transcript-id]').first()).toContainText(`ARCHIVE_CHILD_PAGE_${current}_ROW_${(current - 1) * 50}`)
    }
    await transcript.getByRole('button', { name: '加载较新记录', exact: true }).click()
    await expect(transcript).toContainText('归档第 2 / 4 页')
    await transcript.getByRole('button', { name: '更新子代理完整对话', exact: true }).click()
    await expect(transcript).toContainText('归档第 4 / 4 页')
    await expect(transcript.locator('[data-transcript-id]')).toHaveCount(1)
    expect(archiveReads.every(read => read.pageSize <= (read.sessionId === 'inspector-child' ? 50 : 200))).toBe(true)
    await testInfo.attach('p1-legacy-archive-http-evidence', { body: JSON.stringify(archiveReads, null, 2), contentType: 'application/json' })
    await testInfo.attach('p1-legacy-archive-page', { body: await page.screenshot(), contentType: 'image/png' })
    expect(errors).toEqual([])
  })
  test('Code 首归档页全部被回放过滤后仍能返回较新页', async () => {
    filteredFirstPage = true
    await page.evaluate(async id => {
      const snapshot = await window.aether.engine.getSnapshot()
      const source = 'remote:' + snapshot.baseUrl.replace(/\/+$/, '')
      localStorage.setItem('aether:lastSessionId:' + encodeURIComponent(source), id)
      localStorage.setItem('aether.app.mode', 'code')
    }, sessionId)
    await page.reload()
    const chat = page.locator('.chat').filter({ visible: true })
    await expect(chat).toContainText('ARCHIVE_ROOT_snapshot_ROW_600')
    await chat.locator('[data-archive-page="true"]').click()
    await expect(chat).toContainText('归档第 4 / 4 页')
    for (let current = 3; current >= 1; current--) {
      await chat.locator('[data-archive-page="true"]').click()
      await expect(chat).toContainText(`归档第 ${current} / 4 页`)
    }
    await expect(chat.locator('.chat__turn')).toHaveCount(0)
    await expect(chat).toContainText('未提供跨页版本一致性')
    await chat.getByRole('button', { name: '查看较新归档页', exact: true }).click()
    await expect(chat).toContainText('归档第 2 / 4 页')
    await expect(chat.locator('.chat__turn').first()).toContainText('ARCHIVE_ROOT_PAGE_2_ROW_200')
    await chat.getByRole('button', { name: '回到最新归档', exact: true }).click()
    await expect(chat).toContainText('归档第 4 / 4 页')
    expect(errors).toEqual([])
  })
})
