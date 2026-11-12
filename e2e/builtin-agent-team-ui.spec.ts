/** Real Electron + main IPC + authenticated mock HTTP: authored builtin instances,
 * completed-context reuse, live supplements and immutable producer display.
 * The test owns its profile, server port and build output; no user's app is touched. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView } from '../src/shared/subagent'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), token = 'builtin-agent-team-fixture', modelId = 'team-fixture-model'
const errors: string[] = [], chats: Record<string, unknown>[] = [], messages: Record<string, unknown>[] = []
const runs: SubagentRunView[] = [], history: EngineHistoryRow[] = []
const childArchives = new Map<string, EngineHistoryRow[]>()
const archiveReads: Array<{ sessionId: string; page: number }> = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let current: RootRun | undefined, projection: ChatSsePayload[] = [], sealed = false
let activeStream: ServerResponse | undefined
let holdNextArchive = false, heldArchive: { response: ServerResponse; body: string } | undefined
let app: ElectronApplication, page: Page, fixture: string
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function child(index: number, role: 'executor' | 'research', prior?: SubagentRunView): SubagentRunView {
  if (!current) throw new Error('Missing parent')
  const now = Date.now()
  return { schemaVersion: 2, view: 'summary', runId: `child-run-${index}`, tenantId: 'team-tenant', rootSessionId: current.sessionId,
    parentSessionId: current.sessionId, parentConversationId: current.turnId, parentMessageId: current.assistantMessageId, parentToolCallId: `delegate-${index}`,
    childSessionId: prior?.childSessionId ?? `child-context-${index}`, agentName: prior?.agentName ?? `执行代理 ${index}`,
    ...(prior ? { resumeFromRunId: prior.runId } : {}), task: '实现独立组件', description: '实现独立组件', modelId, status: prior ? 'running' : 'succeeded',
    ...(prior ? { partialOutput: '已开始整合原组件，正在检查兼容性。' } : {}),
    lastSeq: 1, createdAt: now, updatedAt: now, startedAt: now, ...(prior ? {} : { finishedAt: now, resultSummary: '组件已完成，可继续复用上下文。' }),
    ...(index === 2 ? { status: 'blocked', stopReason: 'needs_user', error: { code: 'NEEDS_USER', message: '需要适配 macOS 还是 Windows？', retryable: false } } : {}),
    continuation: { builtinRole: role, builtinRoleVersion: 1, readOnly: role === 'research' }, usage: {}, toolCount: 0, activeToolCount: 0, toolCalls: [],
    coverage: { asOfSeq: 1, toolCount: 0, includedToolCount: 0, activeToolCount: 0, includedActiveToolCount: 0, ids: [], hasMore: false, truncated: false, completeness: 'complete' } }
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'team-tenant', sessionId, namespace: { id: 'team-db', generation: 'one' },
      transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 },
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
    chats.push(input)
    const n = chats.length, now = Date.now(), id = String(input.sessionId), prompt = String(input.message)
    current = { schemaVersion: 1, runId: `parent-${n}`, sessionId: id, turnId: `turn-${n}`, userMessageId: `user-${n}`, assistantMessageId: `assistant-${n}`,
      seq: n, version: n === 1 ? 2 : 1, status: n === 1 ? 'succeeded' : 'running', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now,
      ...(n === 1 ? { finishedAt: now } : {}) }
    const collaborators = Array.isArray(input.collaborators) ? input.collaborators : []
    const added = collaborators.map(selector => {
      if (!record(selector)) throw new Error('Missing collaborator')
      const prior = selector.resumeRunId ? runs.find(run => run.runId === selector.resumeRunId) : undefined
      if (selector.resumeRunId && !prior) throw new Error('Resumed an unknown context')
      const next = child(runs.length + 1, selector.builtinRole === 'research' ? 'research' : 'executor', prior)
      runs.push(next)
      const archive = childArchives.get(next.childSessionId) ?? []
      const meta = { rootRunId: current!.runId, turnId: current!.turnId, ...(prior ? { subagentRunId: next.runId } : {}) }
      const childRow = (suffix: string, role: string, content: unknown): EngineHistoryRow => ({
        id: `${next.runId}-${suffix}`, role, content, isSidechain: true, createdAt: now, conversationId: current!.turnId, metadata: meta
      })
      const taskText = prior ? String(selector.task) : '实现独立组件，保持现有接口兼容'
      const instruction = !prior && next.runId === 'child-run-1'
        ? `用户明确委派你作为协作子代理，结合你的职责完成本次请求中与你相关的部分。保留此前上下文；以实际完成的结果、证据和未完成事项回复。\n\n本实例的任务与分工：\n${taskText}\n\n当前用户请求：\n${taskText}` : taskText
      archive.push({ ...childRow('user', 'user', instruction), metadata: { ...meta, attachments: [{ name: '组件需求.txt', type: 'text/plain', size: 42 }] } })
      if (!prior && next.runId === 'child-run-1') {
        archive.push({ ...childRow('orphan', 'tool', '上页工具保留的验证结果'), toolCallId: 'missing-before-window', toolName: 'read_file' })
        archive.push({ ...childRow('call', 'assistant', '先检查组件接口。'), reasoningContent: '核对组件边界和已有调用方。', toolCall: { id: 'read-component', name: 'read_file', args: { path: 'src/Component.tsx' } } },
          { ...childRow('parallel-call', 'assistant', ''), toolCall: { id: 'read-consumer', name: 'read_file', args: { path: 'src/Consumer.tsx' } } },
          { ...childRow('result', 'tool', 'export const Component = () => null'), toolCallId: 'read-component', toolName: 'read_file', metadata: { ...meta, status: 'succeeded' } },
          { ...childRow('parallel-result', 'tool', 'Consumer imports Component'), toolCallId: 'read-consumer', toolName: 'read_file', metadata: { ...meta, status: 'succeeded' } })
      }
      archive.push(childRow('assistant', 'assistant', prior ? '正在结合原组件继续处理。' : next.runId === 'child-run-2' ? '需要适配 macOS 还是 Windows？' : '<think>CHILD_REASONING_ONLY</think>组件已完成，可继续复用上下文。'))
      if (!prior && next.runId === 'child-run-1') archive.push({
        ...childRow('cancelled', 'assistant', 'cancelled'), id: 'subagent-outcome:historic-cancelled',
        metadata: { ...meta, subagentRunId: 'historic-cancelled', status: 'cancelled' }
      })
      childArchives.set(next.childSessionId, archive)
      return next
    })
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: prompt, createdAt: now, conversationId: current.turnId,
      metadata: { rootRunId: current.runId, turnId: current.turnId } }
    const finalResult = { schemaVersion: 1 as const, sessionId: id, turnId: current.turnId, runId: current.runId, assistantMessageId: current.assistantMessageId,
      text: n === 1 ? '<think>ROOT_REASONING_ONLY</think>已完成首个组件，另一个组件需要补充信息。' : '已复用原代理上下文，正在继续。', publishedAt: now,
      items: n === 1 ? [{ id: 'report', assetId: 'adopted-report', name: '组件说明.md', path: '组件说明.md', mimeType: 'text/markdown', size: 20, sha256: 'a'.repeat(64), kind: 'file' as const,
        producerChildSessionId: added[0].childSessionId, producerRunId: added[0].runId, producerArtifactId: 'child-artifact' }] : [] }
    history.push(user, { id: current.assistantMessageId, role: 'assistant', content: finalResult.text, createdAt: now, conversationId: current.turnId,
      metadata: { rootRunId: current.runId, turnId: current.turnId, ...(n === 1 ? { finalResult } : {}) } })
    projection = [{ run: { ...current, version: 1, status: 'running', finishedAt: undefined } }, { userMessage: user },
      ...added.map(run => ({ subagentEvent: { schemaVersion: 2 as const, kind: 'snapshot' as const, runId: run.runId, seq: run.lastSeq, view: run } })),
      { content: finalResult.text }, ...(n === 1 ? [{ finalResult }, { run: current }] : [])]
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    projection.forEach((payload, index) => response.write(`id: ${current!.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`))
    if (n === 1) response.end('data: [DONE]\n\n')
    else activeStream = response
    return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/subagent/capabilities') { response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return }
  if (path === '/api/v1/subagent/runs') { response.end(envelope({ schemaVersion: 2, runs: runs.filter(run => run.parentSessionId === url.searchParams.get('parentSessionId')), listComplete: true, hasMore: false, revision: `team-${runs.length}` })); return }
  const childMatch = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/(tools|events))?$/)
  if (childMatch) {
    const run = runs.find(item => item.runId === childMatch[1]); if (!run) { response.writeHead(404).end(envelope(null)); return }
    response.end(envelope(childMatch[2] === 'tools' ? { schemaVersion: 2, runId: run.runId, asOfSeq: run.lastSeq, totalCount: 0, items: [], hasMore: false }
      : childMatch[2] === 'events' ? { schemaVersion: 2, runId: run.runId, events: [], nextSeq: run.lastSeq, hasMore: false, checkpointRequired: false } : run)); return
  }
  if (path === '/api/v1/collaboration/capabilities') { response.end(envelope({ protocolVersion: 1, userControllerMutation: true, rootUserControllerMutation: true })); return }
  if (path.endsWith('/controller-context') && current) {
    const latest = runs.at(-1)!, recipient = { participantId: `child:${latest.childSessionId}`, kind: 'child', sessionId: latest.childSessionId,
      invocationRunId: latest.runId, admittedSeq: 1, admittedAt: latest.createdAt }
    response.end(envelope(sealed ? { outcome: 'closed' } : { outcome: 'ready', scope: { rootRunId: current.runId, rootAttemptId: `attempt-${current.runId}`, rootSessionId: current.sessionId },
      recipient, participants: { entries: [recipient], revision: 1, hasMore: false } })); return
  }
  if (path.endsWith('/messages') && request.method === 'POST' && current) {
    messages.push(input)
    response.end(envelope({ outcome: 'accepted', receipt: { messageId: 'supplement', rootRunId: current.runId, rootAttemptId: `attempt-${current.runId}`,
      senderParticipantId: 'user', senderInvocationRunId: current.runId, recipientParticipantId: input.recipientParticipantId, requestKey: input.requestKey,
      payloadHash: createHash('sha256').update(String(input.message)).digest('hex'), payloadBytes: Buffer.byteLength(String(input.message)),
      acceptedSeq: 1, acceptedAt: Date.now(), state: 'queued', delivery: { state: 'pending' } } })); return
  }
  if (path === '/api/v1/conversation/display') {
    const users = history.filter(row => row.role === 'user')
    const anchor = url.searchParams.get('anchorMessageId'), limit = Number(url.searchParams.get('limit') ?? 2)
    const start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
    const selected = users.slice(start, start + limit)
    const begin = selected.length ? history.findIndex(row => row.id === selected[0].id) : 0
    const next = users[start + selected.length]
    const end = next ? history.findIndex(row => row.id === next.id) : history.length
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })),
      messages: history.slice(begin, end), loadedTurnIds: selected.map(row => row.id), revision: `history-${history.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/conversation/archive') {
    const currentPage = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
    const archive = childArchives.get(sessionId) ?? history
    archiveReads.push({ sessionId, page: currentPage })
    const body = JSON.stringify({ code: 200, message: 'ok', data: archive.slice((currentPage - 1) * pageSize, currentPage * pageSize),
      pagination: { current: currentPage, pageSize, total: archive.length, totalPages: Math.ceil(archive.length / pageSize) },
      metadata: { archiveMessageCount: archive.length, archiveRevision: `archive-${archive.length}`, backend: 'jsonl', compressed: false } })
    if (holdNextArchive && pageSize === 50) { holdNextArchive = false; heldArchive = { response, body }; return }
    response.end(body); return
  }
  if (path === '/api/v1/cron/capabilities' || path === '/api/v1/workbench/clients') { response.writeHead(404).end(envelope(null)); return }
  const data = path === '/health' ? { status: 'ok' } : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'team-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Team fixture', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: current ? `${current.runId}:${projection.length}` : null, finished: current?.status !== 'running', projection, history, run: current, runs: current ? [current] : [], subagentRuns: runs, todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: current?.status === 'running', finished: current?.status !== 'running', run: current, lastEventId: current ? `${current.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: current?.sessionId === sessionId ? [current] : [] }
    : path === '/api/v1/conversation/history' ? history : path === '/api/v1/conversation/sessions' ? []
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: '/remote/team', entries: [] } : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/team' } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

function childUpdate(text?: string, phase?: 'running' | 'succeeded'): void {
  if (!activeStream || !current) throw new Error('No active stream')
  const child = runs.at(-1)!, now = Date.now()
  if (text) childArchives.get(child.childSessionId)!.push({ id: `child-event-${now}-${child.lastSeq}`, role: 'user', content: text,
    isSidechain: true, createdAt: now, conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId, subagentRunId: child.runId } })
  if (phase) child.compaction = { phase, startedAt: now - 1000, ...(phase === 'succeeded' ? { finishedAt: now, beforeTokens: 100000, afterTokens: 20000 } : {}) }
  child.lastSeq++; child.updatedAt = now; child.coverage.asOfSeq = child.lastSeq
  const frame: ChatSsePayload = { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: child.runId, seq: child.lastSeq, view: child } }
  projection.push(frame)
  activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(frame)}\n\n`)
}

function finishActive(): void {
  if (!activeStream || !current) throw new Error('No active parent stream')
  const child = runs.at(-1)!, now = Date.now()
  Object.assign(child, { status: 'succeeded', lastSeq: child.lastSeq + 1, updatedAt: now, finishedAt: now, resultSummary: '当前子任务已完成。' })
  child.coverage = { ...child.coverage, asOfSeq: child.lastSeq }
  childArchives.get(child.childSessionId)!.push({ id: `${child.runId}-final`, role: 'assistant', content: '当前子任务已完成。',
    isSidechain: true, createdAt: now, conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } })
  current = { ...current, status: 'succeeded', version: current.version + 1, updatedAt: now, finishedAt: now }
  const result = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId, runId: current.runId, assistantMessageId: current.assistantMessageId, text: '本轮工作已完成。', publishedAt: now, items: [] }
  const frames: ChatSsePayload[] = [{ subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: child.runId, seq: child.lastSeq, view: child } }, { finalResult: result }, { run: current }]
  for (const frame of frames) { projection.push(frame); activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(frame)}\n\n`) }
  const assistant = history.find(row => row.id === current!.assistantMessageId)
  if (assistant) { assistant.content = result.text; assistant.metadata = { rootRunId: current.runId, turnId: current.turnId, finalResult: result } }
  activeStream.end('data: [DONE]\n\n'); activeStream = undefined
}

test.beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'builtin-agent-team-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true,
    remoteWorkspaceRoot: '/remote/team', lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light', lastFolder: '' }))
  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global'); delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 45_000 })
})
test.afterAll(async () => {
  try { await app?.close() }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== join(root, '.e2e-tmp') || !basename(target).startsWith('builtin-agent-team-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('builtin instances, resume and live followup keep their exact child identities', async ({}, info) => {
  try {
    const work = page.locator('.work-view'), input = work.getByRole('textbox', { name: '任务目标', exact: true })
    await work.getByRole('button', { name: '新任务', exact: true }).click()
    for (let i = 0; i < 2; i++) {
      await input.pressSequentially('@agent ')
      await expect(page.getByRole('group', { name: '协作 Agent' })).toBeVisible()
      await expect(page.getByRole('group', { name: '协作 Agent' }).getByRole('option')).toHaveCount(3)
      if (i === 0) await page.screenshot({ path: info.outputPath('builtin-picker-light.png') })
      await page.getByRole('option', { name: /^执行/ }).click()
    }
    await input.pressSequentially('分别完成两个独立组件')
    await work.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chats.length).toBe(1)
    const selectors = chats[0].collaborators as Array<{ builtinRole: string; instanceKey: string }>
    expect(selectors.map(item => item.builtinRole)).toEqual(['executor', 'executor'])
    expect(new Set(selectors.map(item => item.instanceKey)).size).toBe(2)
    await expect(work.locator('.work-sidebar')).not.toContainText('builtin-agent:')
    await expect(work.getByRole('region', { name: '协作对话', exact: true })).toContainText('已完成首个组件，另一个组件需要补充信息。')
    const parentReply = work.locator('[data-message-id="assistant-1"]')
    await expect(parentReply).not.toContainText('ROOT_REASONING_ONLY')
    await expect(parentReply).not.toContainText('<think>')
    await expect(work.locator('[data-producer-child-session="child-context-1"]')).toBeVisible()
    const workspace = work.getByRole('region', { name: '任务工作区', exact: true })
    if (!await workspace.isVisible()) await work.getByRole('button', { name: '打开工作区', exact: true }).click()
    const tab = workspace.getByRole('tab', { name: '子代理', exact: true })
    if (await tab.isVisible()) await tab.click()
    else { await workspace.getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '子代理', exact: true }).click() }
    const panel = workspace.getByRole('region', { name: '协作代理', exact: true })
    await expect(panel.locator('.work-subagents__row')).toHaveCount(2)
    await expect(panel.getByRole('button', { name: '查看 执行代理 2 子代理详情', exact: true })).toContainText('待回答')
    await panel.getByRole('button', { name: '查看 执行代理 1 子代理详情', exact: true }).click()
    await panel.getByRole('button', { name: '代理信息', exact: true }).click()
    await expect(page.locator('.work-subagents__facts')).toContainText('角色执行')
    await page.keyboard.press('Escape')
    await expect(page.locator('.work-subagents__facts')).toHaveCount(0)
    const transcript = panel.getByRole('region', { name: '执行代理 1 的对话', exact: true })
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true })).toContainText('实现独立组件，保持现有接口兼容')
    await expect(transcript).toContainText('组件已完成，可继续复用上下文。')
    await expect(transcript).not.toContainText('CHILD_REASONING_ONLY')
    await expect(transcript).not.toContainText('<think>')
    await expect(transcript).not.toContainText('用户明确委派')
    await expect(transcript).not.toContainText('cancelled')
    await expect(transcript).toContainText('已取消')
    const userMessage = transcript.getByRole('article', { name: '用户消息', exact: true })
    const userBody = userMessage.locator('.message__bubble-content')
    await expect(userBody).toHaveText('实现独立组件，保持现有接口兼容')
    await expect(userMessage.getByRole('button', { name: '展开用户消息全文', exact: true })).toHaveCount(0)
    await expect(userMessage.locator('.attach-chip')).toContainText('组件需求.txt')
    const detailsTrigger = userMessage.getByRole('button', { name: '用户消息详情', exact: true })
    await detailsTrigger.click()
    const messageDetails = page.getByRole('dialog', { name: '用户消息详情', exact: true })
    await expect(messageDetails).toBeVisible()
    await expect(messageDetails.getByRole('tab', { name: '协作说明', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(messageDetails.getByRole('tabpanel')).toHaveCount(1)
    await expect(messageDetails.locator('.work-subagent-instruction__context')).toHaveCount(1)
    await expect(messageDetails.locator('.work-subagent-instruction__original')).toHaveCount(0)
    await expect(messageDetails).toContainText('用户明确委派你作为协作子代理')
    await expect(userBody).toHaveText('实现独立组件，保持现有接口兼容')
    await messageDetails.getByRole('tab', { name: '协作说明', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(messageDetails.getByRole('tab', { name: '原始消息', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(messageDetails.getByRole('tabpanel')).toHaveCount(1)
    await expect(messageDetails.locator('.work-subagent-instruction__context')).toHaveCount(0)
    const original = childArchives.get('child-context-1')?.find(row => row.id === 'child-run-1-user')?.content
    if (typeof original !== 'string') throw new Error('Missing original child user message fixture')
    await expect.poll(() => messageDetails.locator('.work-subagent-instruction__original').textContent()).toBe(original)
    await expect(userBody).not.toContainText('本实例的任务与分工')
    await expect(userMessage.locator('.work-subagent-instruction__original, .work-subagent-instruction__context')).toHaveCount(0)
    const detailsGeometry = await messageDetails.evaluate(element => ({ width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height, viewportHeight: innerHeight }))
    expect(detailsGeometry.width).toBeLessThanOrEqual(421)
    expect(detailsGeometry.height).toBeLessThanOrEqual(Math.min(480, detailsGeometry.viewportHeight * .6) + 1)
    await page.screenshot({ path: info.outputPath('child-user-message-details.png') })
    await page.keyboard.press('Escape')
    await expect(messageDetails).toHaveCount(0)
    await expect(detailsTrigger).toBeFocused()
    await expect(transcript).toBeVisible()
    await expect(userBody).toHaveText('实现独立组件，保持现有接口兼容')
    await detailsTrigger.click()
    await expect(messageDetails.getByRole('tab', { name: '协作说明', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(messageDetails.locator('.work-subagent-instruction__original')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(messageDetails).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '工作轮次', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '完整对话', exact: true })).toHaveCount(0)
    await expect(transcript.getByRole('button', { name: '展开过程', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await transcript.getByRole('button', { name: '展开过程', exact: true }).click()
    await expect(transcript).toContainText('调用记录未载入')
    await expect(transcript.locator('[data-work-tool-id="archive-output:child-run-1-orphan"]')).toBeVisible()
    await expect(transcript.locator('[data-work-tool-id^="archive-output:"]')).toHaveCount(1)
    for (const id of ['call', 'parallel-call']) {
      const tool = transcript.locator(`[data-work-tool-id="archive-call:child-run-1-${id}"]`)
      await expect(tool).toBeVisible()
      await expect(tool).not.toContainText('状态未知')
      await expect(tool).not.toContainText('调用记录未载入')
    }
    await transcript.getByRole('button', { name: '收起过程', exact: true }).click()
    await page.screenshot({ path: info.outputPath('child-conversation-light.png') })
    const childInput = panel.getByRole('textbox', { name: '继续交给 执行代理 1', exact: true })
    await childInput.fill('!')
    await panel.getByRole('button', { name: '继续执行', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('不能只发送标点或表情')
    await expect(childInput).toHaveValue('!')
    expect(chats).toHaveLength(1)
    expect(runs).toHaveLength(2)
    await panel.getByRole('textbox', { name: '继续交给 执行代理 1', exact: true }).fill('复用原上下文，整合组件并返回结果')
    const resume = panel.getByRole('button', { name: '继续执行', exact: true })
    await expect(resume).toHaveText(''); await resume.click()
    await expect.poll(() => chats.length).toBe(2)
    expect(chats[1].collaborators).toEqual([{ resumeRunId: 'child-run-1', task: '复用原上下文，整合组件并返回结果' }])
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true })).toHaveCount(2)
    await expect(transcript).toContainText('复用原上下文，整合组件并返回结果')
    await expect(transcript.locator('[data-live-run-id="child-run-3"]')).toContainText('已开始整合原组件，正在检查兼容性。')
    await expect(transcript).toContainText('组件已完成，可继续复用上下文。')
    expect(current?.status).toBe('running')
    expect(activeStream?.writableEnded).toBe(false)
    await expect(work.locator('.work-status--running')).toBeVisible()
    await expect(panel.getByRole('textbox', { name: '补充要求给 执行代理 1', exact: true })).toBeVisible()
    await panel.getByRole('textbox', { name: '补充要求给 执行代理 1', exact: true }).fill('？！')
    await panel.getByRole('button', { name: '发送补充要求', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('不能只发送标点或表情')
    expect(messages).toHaveLength(0)
    await panel.getByRole('textbox', { name: '补充要求给 执行代理 1', exact: true }).fill('运行中追加：保持原接口兼容')
    await panel.getByRole('button', { name: '发送补充要求', exact: true }).click()
    await expect.poll(() => messages.length).toBe(1)
    expect(messages[0]).toMatchObject({ recipientParticipantId: 'child:child-context-1', recipientInvocationRunId: 'child-run-3', message: '运行中追加：保持原接口兼容' })
    await expect(panel).toContainText('补充要求已排队')
    await expect(panel).not.toContainText('已执行完成')
    childUpdate('运行中追加：保持原接口兼容', 'running')
    await expect(panel.locator('.work-subagents__compaction')).toHaveText('正在自动压缩上下文…')
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true }).last()).toContainText('运行中追加：保持原接口兼容')
    childUpdate(undefined, 'succeeded')
    await expect(panel.locator('.work-subagents__compaction')).toHaveText('上下文已自动压缩')
    // A second revision received during an in-flight archive read must be read
    // afterwards, even when it is the last event in the stream.
    holdNextArchive = true
    childUpdate('正在读取时的补充一')
    await expect.poll(() => Boolean(heldArchive)).toBe(true)
    childUpdate('正在读取时的补充二')
    heldArchive!.response.end(heldArchive!.body); heldArchive = undefined
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true }).last()).toContainText('正在读取时的补充二')
    for (let index = 0; index < 8; index++) childUpdate(`材料 ${index}：${'保持组件接口和测试边界。'.repeat(12)}`)
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true }).last()).toContainText('材料 7：')
    const scroll = transcript.locator('.work-subagent-transcript__scroll')
    await scroll.evaluate(node => { node.scrollTop = 0 })
    childUpdate('阅读旧消息时到达的最新补充')
    await expect(transcript.getByRole('button', { name: '查看最新消息', exact: true })).toBeVisible()
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0)
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true }).last()).not.toContainText('阅读旧消息时到达的最新补充')
    await transcript.getByRole('button', { name: '查看最新消息', exact: true }).click()
    await expect(transcript.getByRole('article', { name: '用户消息', exact: true }).last()).toContainText('阅读旧消息时到达的最新补充')
    await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click()
    await expect(panel.locator('.work-subagents__row')).toHaveCount(2)
    await panel.getByRole('button', { name: '查看 执行代理 1 子代理详情', exact: true }).click()
    sealed = true
    await panel.getByRole('textbox', { name: '补充要求给 执行代理 1', exact: true }).fill('收尾时不能丢掉这条要求')
    await panel.getByRole('button', { name: '发送补充要求', exact: true }).click()
    await expect(panel).toContainText('补充尚未接纳，原文已保留')
    await expect(panel.getByRole('textbox', { name: '补充要求给 执行代理 1', exact: true })).toHaveValue('收尾时不能丢掉这条要求')
    expect(messages).toHaveLength(1)
    await page.screenshot({ path: info.outputPath('team-light.png') })
    finishActive()
    await expect(work.getByRole('region', { name: '协作对话', exact: true })).toContainText('本轮工作已完成。')
    await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click()
    await panel.getByRole('button', { name: '查看 执行代理 2 子代理详情', exact: true }).click()
    await expect(panel.getByRole('region', { name: '执行代理 2 的对话', exact: true })).toContainText('需要适配 macOS 还是 Windows？')
    await expect(panel.locator('.subagent-card__fail')).toHaveCount(0)
    await panel.getByRole('textbox', { name: '继续交给 执行代理 2', exact: true }).fill('请适配 macOS')
    await panel.getByRole('button', { name: '继续执行', exact: true }).click()
    await expect.poll(() => chats.length).toBe(3)
    expect(chats[2].collaborators).toEqual([{ resumeRunId: 'child-run-2', task: '请适配 macOS' }])
    expect(chats[2].toolResponse).toBeUndefined()
    finishActive()
    await expect(panel.getByRole('textbox', { name: '继续交给 执行代理 2', exact: true })).toBeVisible()
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
    await settings.getByRole('radio', { name: '深色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('.modal[aria-label="设置"]')).toHaveCount(0)
    // Revisit the child carrying the verified compaction state in dark mode.
    await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click()
    await panel.getByRole('button', { name: '查看 执行代理 1 子代理详情', exact: true }).click()
    await expect(panel.locator('.work-subagents__compaction')).toHaveText('上下文已自动压缩')
    await expect(panel.locator('[data-live-run-id]')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('team-dark.png') })
    // Restore an immutable published child reference, then read its independent
    // continuous conversation without changing that parent projection.
    const publishedRun = runs.at(-1)!, rootRun = current!
    const publishedChild = { protocolVersion: 1 as const, source: 0, sessionId: rootRun.sessionId, snapshotId: 'published-fixture',
      fence: { tenantId: publishedRun.tenantId, parentSessionId: rootRun.sessionId, rootSessionId: rootRun.sessionId,
        parentTurnId: rootRun.turnId, rootRunId: rootRun.runId, attemptId: 'published-attempt', streamId: 'published-stream',
        generation: 'published-generation', eventSequence: 1, revision: 1, usageRevision: 1 },
      identity: { tenantId: publishedRun.tenantId, runId: publishedRun.runId, rootSessionId: publishedRun.rootSessionId,
        parentSessionId: publishedRun.parentSessionId, parentConversationId: publishedRun.parentConversationId,
        parentMessageId: publishedRun.parentMessageId, parentToolCallId: publishedRun.parentToolCallId,
        childSessionId: publishedRun.childSessionId, modelId: publishedRun.modelId, createdAt: publishedRun.createdAt, agentName: publishedRun.agentName },
      atSeq: publishedRun.lastSeq, projectionIndex: projection.length }
    projection.push({ publishedChild })
    const originalFinal = history.findIndex(row => row.id === rootRun.assistantMessageId)
    const publishedCall: EngineHistoryRow = { id: 'published-call', role: 'assistant', content: '', createdAt: rootRun.createdAt,
      conversationId: rootRun.turnId, metadata: { rootRunId: rootRun.runId, turnId: rootRun.turnId },
      toolCall: { id: publishedRun.parentToolCallId, name: 'subagent', args: { task: publishedRun.task } } }
    const publishedReceipt: EngineHistoryRow & { publishedChild: typeof publishedChild } = { id: 'published-receipt', role: 'tool',
      content: '固定发布摘要', toolCallId: publishedRun.parentToolCallId, createdAt: rootRun.createdAt, conversationId: rootRun.turnId,
      metadata: { rootRunId: rootRun.runId, turnId: rootRun.turnId }, publishedChild }
    history.splice(originalFinal, 0, publishedCall, publishedReceipt)
    const savedProjection = JSON.stringify(projection)
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work).toBeVisible()
    const restoredWorkspace = work.getByRole('region', { name: '任务工作区', exact: true })
    if (!await restoredWorkspace.isVisible()) await work.getByRole('button', { name: '打开工作区', exact: true }).click()
    const restoredTab = restoredWorkspace.getByRole('tab', { name: '子代理', exact: true })
    if (await restoredTab.isVisible()) await restoredTab.click()
    else { await restoredWorkspace.getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '子代理', exact: true }).click() }
    await panel.getByRole('button', { name: '查看 执行代理 2 子代理详情', exact: true }).click()
    await expect(panel.locator('.work-subagents__heading')).toContainText('会话历史')
    await expect(panel.getByRole('region', { name: '执行代理 2 的对话', exact: true })).toContainText('请适配 macOS')
    await expect(panel.locator('.work-subagents__round')).toHaveCount(0)
    expect(JSON.stringify(projection)).toBe(savedProjection)
    await page.screenshot({ path: info.outputPath('published-child-conversation-dark.png') })
    await panel.getByRole('textbox', { name: '继续交给 执行代理 2', exact: true }).fill('沿用重启后上下文继续优化')
    await panel.getByRole('button', { name: '继续执行', exact: true }).click()
    await expect.poll(() => chats.length).toBe(4)
    expect(chats[3].collaborators).toEqual([{ resumeRunId: publishedRun.runId, task: '沿用重启后上下文继续优化' }])
    expect(runs.at(-1)?.childSessionId).toBe(publishedRun.childSessionId)
    finishActive()
    await expect(panel.getByRole('region', { name: '执行代理 2 的对话', exact: true })).toContainText('沿用重启后上下文继续优化')
    expect(errors).toEqual([])
    await expect(panel.getByRole('alert')).toHaveCount(0)
  } finally {
    await page.screenshot({ path: info.outputPath('last-state.png') }).catch(() => {})
    writeFileSync(info.outputPath('http-evidence.json'), JSON.stringify({ chats, messages, archiveReads, errors }, null, 2))
  }
})
