/** Fresh regression for the observed oversized-frame incident: a sealed SSE
 * prefix stays running while durable execution finishes. Real Electron/IPC
 * must settle Work, disclose missing records and admit the next user turn. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'

test('Work 已结束的观察流同步真实终态，提示记录不完整并可继续下一轮', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp'), model = 'publication-terminal-fixture'
  const token = 'publication-terminal-fixture-token', errors: string[] = [], admissions: Record<string, unknown>[] = []
  const requests: string[] = [], desktopLog: string[] = []
  let passed = false
  let app: ElectronApplication | undefined, fixture = '', sessionId = '', sequence = 0, snapshots = 0, resumes = 0
  let published: RootRun | undefined, execution: RootRun | undefined, stream: ServerResponse | undefined, closed = false
  let producer = '', projection: ChatSsePayload[] = [], history: Record<string, unknown>[] = []
  const json = (response: ServerResponse, data: unknown): void => {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 200, message: 'OK', data }))
  }
  const send = (payload: ChatSsePayload): void => {
    projection.push(structuredClone(payload)); stream!.write(`id: ${producer}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (requests.length < 200) requests.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401).end(JSON.stringify({ code: 401, message: 'Invalid instance token' })); return
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>; admissions.push(body)
      sessionId = String(body.sessionId); producer = 'publication-fixture-' + admissions.length; sequence = 0; closed = false
      const now = Date.now(), ordinal = admissions.length
      published = { schemaVersion: 1, runId: 'publication-root-' + ordinal, sessionId, turnId: 'publication-turn-' + ordinal,
        userMessageId: 'publication-user-' + ordinal, assistantMessageId: 'publication-assistant-' + ordinal,
        seq: ordinal, version: 1, status: 'running', modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
      execution = structuredClone(published); projection = []
      const user = { id: published.userMessageId, role: 'user', content: body.message, conversationId: published.turnId, createdAt: now }
      history.push(user); stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      send({ run: published }); send({ userMessage: user }); send({ content: ordinal === 1 ? 'CONFIRMED_PREFIX_ONLY' : 'SECOND_TURN_ACCEPTED' }); return
    }
    const id = url.searchParams.get('sessionId') ?? '', owned = id === sessionId && Boolean(published)
    if (path === '/api/v1/chat/admission/context') {
      const root = owned && execution ? { ...execution, attemptId: 'attempt-' + execution.runId } : null
      json(response, { protocolVersion: 1, tenantId: 'default', sessionId: id,
        namespace: { id: 'publication-namespace', generation: 'publication-generation' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
        predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }); return
    }
    if (path === '/api/v1/chat/stream') { resumes++; response.writeHead(409).end(JSON.stringify({ code: 40902, message: 'snapshot_required' })); return }
    if (path === '/api/v1/chat/snapshot' && owned) snapshots++
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'publication-terminal-instance' }
        : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: model, isEnabled: true, capabilities: { toolCalling: true, contextWindow: 128000 } }]
          : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
            : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'publication-terminal' }
              : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: owned ? 'live' : 'persisted', sessionId: id,
                eventId: owned ? `${producer}:${sequence}` : null, finished: !owned || closed,
                projection: owned ? projection : [], history: owned ? history : [], run: owned ? published : undefined,
                executionRun: owned ? execution : undefined, runs: owned ? [published] : [], todos: [], changes: [], commandJobs: [], subagentRuns: [],
                ...(owned && closed && admissions.length === 1 ? { error: 'Parent stream publication requires recovery: oversized_frame',
                  publicationRecovery: { reason: 'oversized_frame', lastConfirmedEventId: `${producer}:${sequence}` } } : {}) }
                : path === '/api/v1/chat/status' ? { running: owned && !closed, finished: owned && closed, run: owned ? execution : undefined }
                  : path === '/api/v1/chat/runs' ? { runs: owned ? [execution] : [] }
                    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(published), agentId: null, metadata: null, agent: null }
                      : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                        : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false, sessionId: id }
                          : path === '/api/v1/workspace/directory' ? { root: '/remote/publication-terminal', entries: [] }
                            : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/publication-terminal' } : []
    json(response, data)
  }
  const server = createServer((request, response) => { void handle(request, response).catch(error => {
    errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error))
  }) })
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-publication-terminal-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
      remoteWorkspaceRoot: '/remote/publication-terminal', autoStartEngine: true, lastModelId: model, lastSessionId: '', lastFolder: '' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    app.process().stdout?.on('data', chunk => desktopLog.push(String(chunk)))
    app.process().stderr?.on('data', chunk => desktopLog.push(String(chunk)))
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const work = page.locator('.work-view'), heading = work.locator('.work-task-heading')
    const conversation = work.getByRole('region', { name: '协作对话', exact: true })
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('FIRST_PUBLICATION_TASK')
    await work.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(conversation.locator('.work-message--assistant')).toContainText('CONFIRMED_PREFIX_ONLY')
    const before = snapshots
    closed = true; stream!.end('event: done\ndata: [DONE]\n\n')
    await expect.poll(() => snapshots).toBeGreaterThan(before + 1)
    await expect(heading).toContainText('进行中')
    await expect(conversation.locator('.chat__notice--info')).toContainText('任务仍在执行')
    expect(admissions).toHaveLength(1); expect(resumes).toBe(0)
    execution = { ...execution!, status: 'succeeded', version: 2, finishedAt: Date.now(), updatedAt: Date.now() }
    await expect(heading).toContainText('已完成')
    await expect(conversation.locator('.chat__notice--info')).toContainText('任务已结束，但本轮实时记录不完整')
    await expect(work.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    await expect(conversation.locator('.work-message--assistant')).toHaveCount(1)
    await expect(work.locator('.work-next-turn__error')).toHaveCount(0)
    await expect(work).not.toContainText('Admission response is not an object')
    await page.screenshot({ path: testInfo.outputPath('publication-terminal-incomplete.png') })
    // The next turn proves the recovery loop released admission. A green task
    // badge alone would miss a stranded streaming or retrying gate.
    await work.getByRole('textbox', { name: '继续对话', exact: true }).fill('SECOND_AFTER_TERMINAL')
    await work.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => admissions.length).toBe(2)
    expect(admissions[0].sessionId).toBe(admissions[1].sessionId)
    expect(admissions.map(body => body.message)).toEqual(['FIRST_PUBLICATION_TASK', 'SECOND_AFTER_TERMINAL'])
    await expect(conversation).toContainText('SECOND_TURN_ACCEPTED')
    execution = { ...execution!, status: 'succeeded', version: 2, finishedAt: Date.now(), updatedAt: Date.now() }
    published = execution; send({ run: published }); closed = true; stream!.end('event: done\ndata: [DONE]\n\n')
    await expect(heading).toContainText('已完成')
    expect(resumes).toBe(0); expect(errors).toEqual([])
    passed = true
  } finally {
    stream?.destroy(); await app?.close(); server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    writeFileSync(testInfo.outputPath('fixture-diagnostics.json'), JSON.stringify({ fixture, passed, requests, errors, snapshots, resumes,
      admissions, published, execution }, null, 2))
    writeFileSync(testInfo.outputPath('desktop.log'), desktopLog.join(''))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('work-publication-terminal-')) throw new Error('Unsafe cleanup')
      if (passed) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
