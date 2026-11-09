/** Real Electron + authenticated HTTP: a text-only follow-up preserves the
 * latest published files and selected preview; a new delivery replaces them.
 * The fixture owns one profile and server and never contacts the user's engine. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult, FinalResultItem } from '../src/shared/final-result'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'artifact-retention-token', model = 'artifact-retention-model'
const task = 'work-retained-delivery', emptyTask = 'work-no-delivery'
const titles = new Map([[task, '保留上一轮交付'], [emptyTask, '没有文件的独立会话']])
const workspaceRoot = '/remote/retention'
const histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const assets = new Map<string, { item: FinalResultItem; text: string; runId: string; sessionId: string }>()
const errors: string[] = [], chats: Record<string, unknown>[] = []
const assetReads: Array<{ sessionId: string; runId: string; assetId: string }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', generation = 0
let pending: { response: ServerResponse; run: RootRun; sequence: number } | undefined
let original: FinalResult
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const latest = (id: string): RootRun | undefined => runs.get(id)?.at(-1)

function runFor(id: string, seq: number, status: RootRun['status'] = 'succeeded'): RootRun {
  const start = Date.now() - 60_000 + seq * 1000
  return { schemaVersion: 1, sessionId: id, runId: `${id}-${generation}-root-${seq}`, turnId: `${id}-${generation}-turn-${seq}`,
    userMessageId: `${id}-${generation}-user-${seq}`, assistantMessageId: `${id}-${generation}-assistant-${seq}`,
    seq, version: status === 'running' ? 1 : 2, status, modelId: model, pending: [], workspacePaths: [workspaceRoot],
    createdAt: start, updatedAt: start + 500, startedAt: start, ...(status === 'running' ? {} : { finishedAt: start + 500 }) }
}
function delivery(run: RootRun, files: Array<[string, string]>): FinalResult {
  return { schemaVersion: 1, sessionId: run.sessionId, runId: run.runId, turnId: run.turnId,
    assistantMessageId: run.assistantMessageId, text: files.length ? '文件已交付。' : '这轮只回答问题，没有生成新的文件。',
    publishedAt: run.finishedAt ?? run.updatedAt, items: files.map(([name, text], index) => {
      const item: FinalResultItem = { id: `${run.runId}-item-${index}`, assetId: `${run.runId}-asset-${index}`,
        name, path: `交付/${name}`, kind: 'file', mimeType: 'text/plain', size: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex') }
      assets.set(item.assetId, { item, text, runId: run.runId, sessionId: run.sessionId })
      return item
    }) }
}
function append(run: RootRun, prompt: string, result?: FinalResult): void {
  runs.set(run.sessionId, [...(runs.get(run.sessionId) ?? []), run])
  const metadata = { rootRunId: run.runId }
  histories.set(run.sessionId, [...(histories.get(run.sessionId) ?? []),
    { id: run.userMessageId, role: 'user', content: prompt, conversationId: run.turnId, createdAt: run.createdAt, metadata },
    { id: run.assistantMessageId, role: 'assistant', content: result?.text ?? '仅有文字答复。', conversationId: run.turnId,
      createdAt: run.finishedAt ?? run.createdAt, metadata: { ...metadata, ...(result ? { finalResult: result } : {}) } }])
}
function closePending(): void {
  pending?.response.end('data: [DONE]\n\n')
  pending = undefined
}
function reset(): void {
  closePending(); generation++; histories.clear(); runs.clear(); assets.clear(); admissions.clear()
  const first = runFor(task, 1)
  original = delivery(first, [['工作汇报.txt', 'FIRST_REPORT_CONTENT：原来交付的工作汇报。'], ['项目梳理.txt', 'SECOND_REPORT_CONTENT：用户正在查看的项目梳理。']])
  append(first, '生成工作汇报与项目梳理', original)
  const followup = runFor(task, 2)
  append(followup, '你看过全部代码了吗', delivery(followup, []))
  const empty = runFor(emptyTask, 1)
  append(empty, '你好', delivery(empty, []))
}
function frame(stream: NonNullable<typeof pending>, payload: ChatSsePayload): void {
  stream.response.write(`id: ${stream.run.runId}:${++stream.sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function finish(files: Array<[string, string]> | null): FinalResult | undefined {
  if (!pending) throw new Error('No active send to finish')
  const stream = pending, run: RootRun = { ...stream.run, version: 2, status: 'succeeded', updatedAt: Date.now(), finishedAt: Date.now() }
  const result = files === null ? undefined : delivery(run, files)
  const content = result?.text ?? '纯文字答复，不发布任何文件。'
  runs.set(task, [...runs.get(task)!.slice(0, -1), run])
  histories.set(task, histories.get(task)!.map(row => row.id === run.assistantMessageId
    ? { ...row, content, metadata: { ...row.metadata, ...(result ? { finalResult: result } : {}) } } : row))
  frame(stream, { content })
  if (result) frame(stream, { finalResult: result })
  frame(stream, { run })
  for (const [key, value] of admissions) if (value.run.runId === run.runId) admissions.set(key, { ...value, run })
  closePending()
  return result
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const parsed: unknown = raw ? JSON.parse(raw) : {}, input = isRecord(parsed) ? parsed : {}
  const current = latest(sessionId), rows = histories.get(sessionId) ?? []
  if (path === '/api/v1/conversation/result-asset') {
    const runId = url.searchParams.get('runId') ?? '', assetId = url.searchParams.get('assetId') ?? ''
    const asset = assets.get(assetId)
    if (!asset || asset.sessionId !== sessionId || asset.runId !== runId) throw new Error('Asset request escaped its owning publication')
    assetReads.push({ sessionId, runId, assetId })
    response.end(envelope({ content: asset.text, isBinary: false, encoding: 'utf8', totalSize: asset.item.size,
      mimeType: asset.item.mimeType, tooLarge: false, truncated: false })); return
  }
  if (path === '/api/v1/chat/admission/context') {
    const matching = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'retention-tenant', sessionId,
      namespace: { id: 'retention-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: matching, predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: `attempt-${accepted.run.runId}`,
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    if (input.sessionId !== task || typeof input.message !== 'string' || pending) throw new Error('Unexpected chat send')
    chats.push(input)
    const run = runFor(task, (runs.get(task)?.length ?? 0) + 1, 'running')
    append(run, input.message)
    if (isRecord(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    pending = { response, run, sequence: 0 }
    frame(pending, { run }); frame(pending, { userMessage: histories.get(task)!.at(-2)! })
    response.flushHeaders(); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: input.workspaceRoot })); return }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${sessionId}-${generation}-${rows.length}-${current?.version ?? 0}`,
      mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'artifact-retention' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '成果保留测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: current?.status === 'running' ? 'live' : 'persisted',
      eventId: current?.status === 'running' ? `${current.runId}:${pending?.sequence ?? 0}` : null, finished: current?.status !== 'running',
      history: rows, projection: [], run: current, runs: runs.get(sessionId) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: current?.status === 'running', finished: current?.status !== 'running', run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(sessionId) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: histories.get(id)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: `binding-${sessionId}`, entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().locator('.work-artifacts-workspace')
const preview = (): Locator => workspace().locator('.work-final-result')
const cards = (runId: string): Locator => work().locator(`.work-final-deliverables[data-final-result-run="${runId}"]`)
async function selectTask(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
}
async function begin(prompt: string): Promise<string> {
  const count = chats.length
  await work().getByRole('textbox', { name: '继续对话', exact: true }).fill(prompt)
  const send = work().getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled(); await send.click()
  await expect.poll(() => chats.length).toBe(count + 1)
  await expect.poll(() => pending?.run.runId).toBeTruthy()
  const runId = pending!.run.runId
  await expect(work().getByText(prompt, { exact: true })).toBeVisible()
  return runId
}
async function assertSelected(item: FinalResultItem): Promise<void> {
  await expect(preview()).toHaveAttribute('data-final-result-item', item.id)
  await expect(workspace().locator(`.work-artifacts-workspace__files [data-final-result-item="${item.id}"]`)).toHaveAttribute('aria-current', 'true')
  await expect(preview()).toContainText(assets.get(item.assetId)!.text)
}

test.describe.serial('Work 成果保留', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(source)
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'artifact-retention-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    reset()
    const tasks = [...titles].map(([id, title]) => ({ id, title, status: 'done', draft: '', mentions: [], createdAt: Date.now(), updatedAt: Date.now(),
      workspacePath: workspaceRoot, modelId: model, attachments: [], sources: [] }))
    await page.evaluate(({ key, tasks, activeTaskId }) => {
      window.dispatchEvent(new Event('blur'))
      localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId, homeSources: [] }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, { key: storageKey, tasks, activeTaskId: task })
    await page.reload()
    await expect(work().getByRole('heading', { name: titles.get(task)!, exact: true })).toBeVisible()
    await expect(workspace()).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('artifact-retention-failure.png'); await page.screenshot({ path })
      await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('artifact-retention-http', { body: JSON.stringify({ errors, chats, assetReads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    closePending()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('artifact-retention-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('本轮空交付保留上轮两个文件，重载仍显示最近成果且对话卡不移入本轮', async ({}, info) => {
    await assertSelected(original.items[0])
    await expect(workspace().getByRole('button', { name: '选择交付轮次', exact: true })).toContainText('最近成果')
    await expect(workspace().locator('.work-artifacts-workspace__toolbar')).toContainText('2 个交付物')
    await expect(cards(original.runId).locator('.work-final-deliverable')).toHaveCount(2)
    await expect(cards(latest(task)!.runId)).toHaveCount(0)
    await workspace().screenshot({ path: info.outputPath('previous-delivery-retained.png'), animations: 'disabled' })
    await page.reload()
    await assertSelected(original.items[0])
    await expect(workspace().getByRole('button', { name: '选择交付轮次', exact: true })).toContainText('最近成果')
  })

  test('手动查看第二个文件后，新提问和无文件答复保持预览，新的非空交付才更新', async () => {
    const second = original.items[1]
    await cards(original.runId).getByRole('button', { name: `预览 ${second.name}`, exact: true }).click()
    await assertSelected(second)
    await preview().evaluate(element => element.setAttribute('data-retention-marker', 'preserve-preview'))
    const readsBefore = assetReads.filter(read => read.assetId === second.assetId).length
    const emptyRun = await begin('只解释原报告，不生成新的文件')
    await assertSelected(second)
    await expect(preview()).toHaveAttribute('data-retention-marker', 'preserve-preview')
    finish([])
    await expect(work().locator('.work-task-heading__actions')).toContainText('已完成')
    await assertSelected(second)
    await expect(preview()).toHaveAttribute('data-retention-marker', 'preserve-preview')
    await expect(cards(emptyRun)).toHaveCount(0)
    expect(assetReads.filter(read => read.assetId === second.assetId)).toHaveLength(readsBefore)

    await workspace().locator(`.work-artifacts-workspace__files [data-final-result-item="${original.items[0].id}"]`).click()
    await workspace().locator(`.work-artifacts-workspace__files [data-final-result-item="${second.id}"]`).click()
    const textRun = await begin('继续解释，也不发布成果清单')
    finish(null)
    await expect(work().locator('.work-task-heading__actions')).toContainText('已完成')
    await assertSelected(second)
    await expect(cards(textRun)).toHaveCount(0)

    const newRun = await begin('现在生成修订后的新报告')
    await assertSelected(second)
    const result = finish([['修订报告.txt', 'NEW_REPORT_CONTENT：这是新一轮实际交付的报告。']])!
    await assertSelected(result.items[0])
    await expect(preview()).toHaveAttribute('data-final-result-run', newRun)
    await expect(workspace().getByRole('button', { name: '选择交付轮次', exact: true })).toContainText('本轮成果')
    await expect(cards(newRun).locator('.work-final-deliverable')).toHaveCount(1)
    await expect(cards(original.runId).locator('.work-final-deliverable')).toHaveCount(2)
  })

  test('切换到没有文件的另一会话不会带入旧交付物', async () => {
    await assertSelected(original.items[0])
    const before = assetReads.length
    await selectTask(emptyTask)
    await expect(workspace()).toHaveAttribute('data-final-result-session', emptyTask)
    await expect(workspace()).toContainText('0 个交付物')
    await expect(preview()).toHaveCount(0)
    await expect(workspace()).not.toContainText('工作汇报.txt')
    expect(assetReads.slice(before)).toEqual([])
    await selectTask(task)
    await assertSelected(original.items[0])
  })
})
