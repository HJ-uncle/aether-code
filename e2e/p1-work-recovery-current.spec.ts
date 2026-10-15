/** Fresh Work Electron contract: malformed SSE and replay expiry recover through
 * the real main/preload bridge, replace a held authoritative snapshot and never
 * POST the task again. The HTTP peer is controlled; no real LLM is exercised. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'

test('Work 坏帧和过期回放各自恢复同一任务，提示状态准确且不重复提交', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), fixtureParent = join(root, '.e2e-tmp')
  const token = 'p1-work-recovery-token', model = 'p1-work-recovery-model', producer = 'p1-work-producer'
  const errors: string[] = [], admissions: Record<string, unknown>[] = [], resumeCursors: string[] = []
  let app: ElectronApplication | undefined, fixture = '', activeId = '', sequence = 0, snapshots = 0
  let run: RootRun | undefined, stream: ServerResponse | undefined
  let projection: ChatSsePayload[] = [], history: Array<Record<string, unknown>> = []
  let snapshotGate: Promise<void> | undefined, releaseSnapshot: (() => void) | undefined
  const responseBody = (data: unknown) => JSON.stringify({ code: 200, message: 'OK', data })
  const holdSnapshot = () => { snapshotGate = new Promise<void>(done => { releaseSnapshot = done }) }
  const send = (payload: ChatSsePayload) => {
    if (!stream || stream.destroyed || stream.writableEnded) throw new Error('Missing active Work SSE viewer')
    projection.push(structuredClone(payload))
    stream.write(`id: ${producer}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 401, message: 'Invalid or missing instance token' })); return
    }
    let raw = ''; for await (const part of request) raw += part.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>
      admissions.push(body); activeId = String(body.sessionId)
      if (!activeId.startsWith('work-')) throw new Error('Work submitted to a non-Work session')
      const now = Date.now()
      run = { schemaVersion: 1, runId: 'p1-work-root', sessionId: activeId, turnId: 'p1-work-turn',
        userMessageId: 'p1-work-user', assistantMessageId: 'p1-work-assistant', seq: 1, version: 1,
        status: 'running', modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
      history = [{ id: run.userMessageId, role: 'user', content: body.message, conversationId: run.turnId, createdAt: now }]
      stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      send({ run }); send({ userMessage: history[0] }); send({ content: 'P1_LIVE_PARTIAL ' }); return
    }
    const id = url.searchParams.get('sessionId') ?? '', owned = id === activeId && Boolean(run)
    if (path === '/api/v1/chat/stream' && owned) {
      resumeCursors.push(url.searchParams.get('lastEventId') ?? '')
      stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return
    }
    if (path === '/api/v1/chat/snapshot' && owned) { snapshots++; await snapshotGate }
    if (path === '/api/v1/subagent/capabilities') {
      response.setHeader('content-type', 'application/json')
      response.end(responseBody({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
        toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return
    }
    if (path === '/api/v1/subagent/runs') {
      response.setHeader('content-type', 'application/json')
      response.end(responseBody({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'p1-work-recovery-directory' })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'p1-work-recovery-instance' }
        : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: 'P1 Recovery Model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 128000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: owned && run?.status === 'running' ? 'live' : 'persisted', sessionId: id,
            eventId: owned ? `${producer}:${sequence}` : null, finished: !owned || run?.status !== 'running', projection: owned ? projection : [],
            history: owned ? history : [], run: owned ? run : undefined, runs: owned ? [run] : [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
            : path === '/api/v1/chat/status' ? { running: owned && run?.status === 'running', finished: owned && run?.status !== 'running', run: owned ? run : undefined }
              : path === '/api/v1/chat/runs' ? { runs: owned ? [run] : [] }
                : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(run && path === `/api/v1/sessions/${encodeURIComponent(activeId)}/binding`), agentId: null, metadata: null, agent: null }
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                  : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false, sessionId: id }
                    : path === '/api/v1/workspace/directory' ? { root: '/remote/p1-work', entries: [] }
                      : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/p1-work' } : []
    response.setHeader('content-type', 'application/json'); response.end(responseBody(data))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
  })
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing recovery fixture address')
    mkdirSync(fixtureParent, { recursive: true }); fixture = mkdtempSync(join(fixtureParent, 'p1-work-recovery-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, remoteWorkspaceRoot: '/remote/p1-work', autoStartEngine: true, lastModelId: model, lastSessionId: '', lastFolder: '', appearance: 'dark' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    const mainWindow = await app.browserWindow(page)
    await mainWindow.evaluate(window => window.setSize(1440, 940))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const work = page.locator('.work-view'), conversation = work.getByRole('region', { name: '协作对话', exact: true })
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('P1_RECOVERY_CURRENT_TASK')
    await work.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => admissions.length).toBe(1)
    await expect(conversation.locator('.work-message--assistant')).toContainText('P1_LIVE_PARTIAL')

    // Corrupt one transport representation while retaining its authoritative
    // payload in the peer's snapshot. The snapshot gate makes recovery visible.
    const beforeMalformedSnapshots = snapshots
    holdSnapshot()
    projection.push({ content: 'P1_SNAPSHOT_RECOVERED ' }); sequence++
    stream!.write(`id: ${producer}:${sequence}\ndata: {malformed\n\n`)
    await expect.poll(() => snapshots).toBeGreaterThan(beforeMalformedSnapshots)
    const notice = conversation.locator('.chat__notice--info')
    await expect(notice).toContainText('实时更新包含无法解析的事件，正在从引擎快照重新同步。')
    expect(admissions).toHaveLength(1)
    releaseSnapshot!(); snapshotGate = undefined
    await expect.poll(() => resumeCursors.length).toBe(1)
    expect(resumeCursors[0]).toBe(`${producer}:4`)
    await expect(notice).toContainText('实时更新已从引擎快照恢复。')
    await expect(conversation.locator('.work-message--assistant')).toHaveCount(1)
    await expect(conversation.locator('.work-message--assistant')).toContainText('P1_LIVE_PARTIAL P1_SNAPSHOT_RECOVERED')

    // Exercise the actual in-band retention signal separately, on the resumed
    // subscription. It must not change the durable root or submit another task.
    const beforeSnapshots = snapshots
    holdSnapshot(); stream!.write('data: {"error":"Replay cursor unavailable","code":"snapshot_required"}\n\n')
    await expect.poll(() => snapshots).toBeGreaterThan(beforeSnapshots)
    await expect(notice).toContainText('实时更新发生缺口，正在从引擎快照重新同步。')
    releaseSnapshot!(); snapshotGate = undefined
    await expect.poll(() => resumeCursors.length).toBe(2)
    expect(resumeCursors).toEqual([`${producer}:4`, `${producer}:4`])
    await expect(notice).toContainText('实时更新已从引擎快照恢复。')
    const recoveredText = await conversation.locator('.work-message--assistant').innerText()
    expect(recoveredText.match(/P1_LIVE_PARTIAL/g)).toHaveLength(1)
    expect(recoveredText.match(/P1_SNAPSHOT_RECOVERED/g)).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('p1-work-recovered.png') })
    await notice.getByRole('button', { name: '知道了', exact: true }).click(); await expect(notice).toHaveCount(0)

    send({ content: 'P1_RESUMED_FINAL' })
    run = { ...run!, status: 'succeeded', version: 2, updatedAt: Date.now(), finishedAt: Date.now() }
    send({ run }); stream!.end('event: done\ndata: [DONE]\n\n')
    await expect(work.locator('.work-task-heading')).toContainText('已完成')
    await expect(conversation.locator('.work-message--assistant')).toContainText('P1_RESUMED_FINAL')
    expect(admissions).toHaveLength(1)
    expect(admissions[0]).toMatchObject({ sessionId: activeId, message: 'P1_RECOVERY_CURRENT_TASK', model })
    expect(run.runId).toBe('p1-work-root')
    expect(errors).toEqual([])
  } finally {
    releaseSnapshot?.(); stream?.destroy(); await app?.close()
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureParent || !basename(target).startsWith('p1-work-recovery-')) throw new Error(`Unsafe cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
