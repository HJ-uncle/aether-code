/** Real Electron + HTTP + IPC: a 129-run directory is discovered through three
 * pages, never preloaded through parent tools, snapshots or SSE. Covers retry,
 * bounded UI pages, targeted active reconciliation, scoped cancellation, continuation, keyboard,
 * small windows, themes, unified reading scroll, paired transcript tools and
 * late responses after changing parent/source.
 * No real engine or model is started. Build the exact candidate before execution. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { RootRun } from '../src/shared/root-run'
import type { FinalResult } from '../src/shared/final-result'
import type { SubagentRunStatus, SubagentRunView, SubagentToolSummary } from '../src/shared/subagent'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-subagent-directory-fixture-token', modelId = 'directory-fixture-model'
const PAGE_SIZE = 64, DIRECTORY_COUNT = 129
const errors: string[] = []
interface FixtureSession {
  run: RootRun
  history: EngineHistoryRow[]
  projection: ChatSsePayload[]
  runs: SubagentRunView[]
  first: SubagentRunView
}
interface DirectoryRead { parentSessionId: string; cursor: string | null; view: string | null; limit: string | null }
interface RunRead { runId: string; parentSessionId: string | null; rootSessionId: string | null; status: SubagentRunStatus }
interface ChatWrite { sessionId: string; message: string; collaborators: unknown }
interface HeldPage { response: ServerResponse; body: string; parentSessionId: string; cursor: string }

const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const capabilities = { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function finalResult(run: RootRun, text: string): FinalResult {
  return { schemaVersion: 1, sessionId: run.sessionId, turnId: run.turnId, runId: run.runId,
    assistantMessageId: run.assistantMessageId, text, items: [], publishedAt: run.finishedAt ?? run.updatedAt }
}

function createFixture(prefix: string) {
  const sessions = new Map<string, FixtureSession>(), archives = new Map<string, EngineHistoryRow[]>()
  const admissionReceipts = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
  const versions = new Map<string, Map<number, SubagentRunView>>()
  const directoryReads: DirectoryRead[] = [], runReads: RunRead[] = [], chatWrites: ChatWrite[] = []
  const childCancels: string[] = [], parentCancels: string[] = [], archiveReads: string[] = []
  const parentSseChildren: string[] = [], snapshotChildren: string[][] = []
  let hold: { parentSessionId: string; cursor: string } | undefined, held: HeldPage | undefined
  let replacementOrigin: string | undefined
  function agentName(index: number): string { return `${prefix}-${index === 75 ? 1 : index}号协作代理` }
  function createChild(id: string, parentRun: RootRun, index: number, resumeFromRunId?: string): SubagentRunView {
    const childIndex = index === 75 || resumeFromRunId ? 1 : index
    const now = parentRun.createdAt + index
    const status: SubagentRunStatus = index === 100 || index === 101 || resumeFromRunId ? 'running' : 'succeeded'
    const call: SubagentToolSummary = { id: `${prefix}-${id}-tool-${index}`, name: 'read_file', args: { path: `synthetic-${index}.ts` },
      status: status === 'running' ? 'running' : 'succeeded', ordinal: 1, revisionSeq: 2, detailRef: `detail-${index}`, detailTruncated: false }
    const run: SubagentRunView = { schemaVersion: 2, view: 'summary', runId: `${prefix}-${id}-child-${index}`, tenantId: `fixture-${prefix}`,
      rootSessionId: id, parentSessionId: id, parentConversationId: parentRun.turnId, parentMessageId: parentRun.assistantMessageId,
      parentToolCallId: `${prefix}-${id}-delegate-${index}`, childSessionId: `${prefix}-${id}-context-${childIndex}`,
      agentName: agentName(childIndex), task: `DIRECTORY_TASK_${index}`, description: `目录中的第 ${index} 轮工作`, modelId,
      status, lastSeq: 2, createdAt: now, startedAt: now, updatedAt: now, usage: {}, continuation: { readOnly: false },
      ...(resumeFromRunId ? { resumeFromRunId } : {}), ...(status === 'succeeded' ? { finishedAt: now + 1,
        resultSummary: index === 1 ? Array.from({ length: 80 }, (_, row) => `### DIRECTORY_RESULT_${row}\n\n记录 ${row}。`).join('\n\n') : `DIRECTORY_RESULT_${index}` } : { partialOutput: `DIRECTORY_ACTIVE_${index}` }),
      toolCount: 1, activeToolCount: status === 'running' ? 1 : 0, toolCalls: [call], latestActivity: call,
      coverage: { asOfSeq: 2, toolCount: 1, includedToolCount: 1, activeToolCount: status === 'running' ? 1 : 0,
        includedActiveToolCount: status === 'running' ? 1 : 0, ids: [call.id], hasMore: false, truncated: false, completeness: 'complete' } }
    versions.set(run.runId, new Map([[run.lastSeq, run]]))
    if (!archives.has(run.childSessionId)) {
      const rows: EngineHistoryRow[] = Array.from({ length: 61 }, (_, row) => ({
        id: `${run.childSessionId}-row-${row}`, role: row % 2 ? 'assistant' : 'user', createdAt: now + row,
        conversationId: run.childSessionId, content: `DIRECTORY_ARCHIVE_${childIndex}_${row}\n\n${'完整的独立子代理记录，用于验证真实滚动与阅读。'.repeat(12)}` }))
      rows.splice(55, 3,
        { id: `${run.childSessionId}-paired-call`, role: 'assistant', createdAt: now + 55, conversationId: run.childSessionId,
          toolCall: { id: 'directory-pair', name: 'read_file', args: { path: 'D:/deep/review/notes.md' } } },
        { id: `${run.childSessionId}-paired-result`, role: 'tool', createdAt: now + 56, conversationId: run.childSessionId,
          toolCallId: 'directory-pair', success: true, content: 'DIRECTORY_PAIRED_FULL_OUTPUT：读取到完整的审阅笔记。' },
        { id: `${run.childSessionId}-orphan-result`, role: 'tool', createdAt: now + 57, conversationId: run.childSessionId,
          toolCallId: 'directory-unloaded-call', metadata: { toolName: 'read_file' }, content: 'DIRECTORY_ORPHAN_RETAINED：未载入调用时仍保留输出。' })
      archives.set(run.childSessionId, rows)
    }
    return run
  }
  function makeSession(id: string, prompt: string): FixtureSession {
    const now = Date.now(), run: RootRun = { schemaVersion: 1, runId: `${prefix}-root-${id}`, sessionId: id, turnId: `${prefix}-turn-${id}`,
      userMessageId: `${prefix}-user-${id}`, assistantMessageId: `${prefix}-assistant-${id}`, seq: 1, version: 2, status: 'succeeded',
      modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
    const runs = Array.from({ length: DIRECTORY_COUNT }, (_, index) => createChild(id, run, index + 1)), first = runs[0]
    if (prompt === '协作界面设计验收') for (const child of runs) {
      const index = Number(child.parentToolCallId.split('-').at(-1))
      child.agentName = `界面审阅 ${index === 75 ? 1 : index}`
      child.task = child.description = `核对第 ${index} 项界面规范与交互行为`
    }
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: prompt, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId } }
    const result = finalResult(run, `目录任务已就绪：${prompt}`)
    // The parent publishes progress after its first child and an explicit final
    // answer. Later directory discovery cannot reclassify that answer as progress.
    const content = `已收到首个代理回执，其余协作记录可继续查看。\n\n${result.text}`
    // Root sequence orders turns within a session; SSE frame cursors are separate.
    const admitted: RootRun = { ...run, version: 1, status: 'running', finishedAt: undefined }
    const projection: ChatSsePayload[] = [{ run: admitted }, { userMessage: user }, { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: first.runId, seq: first.lastSeq, view: first } }, { content }, { finalResult: result }, { run }]
    const value = { run, runs, first, projection, history: [user, { id: run.assistantMessageId, role: 'assistant', content, createdAt: now, conversationId: run.turnId,
      metadata: { rootRunId: run.runId, turnId: run.turnId, finalResult: result } }] }
    sessions.set(id, value)
    return value
  }
  function updateChild(runId: string, status: 'succeeded' | 'cancelled'): SubagentRunView {
    const session = [...sessions.values()].find(item => item.runs.some(run => run.runId === runId))
    const position = session?.runs.findIndex(run => run.runId === runId) ?? -1
    if (!session || position < 0) throw new Error(`Unknown child ${runId}`)
    const previous = session.runs[position], seq = previous.lastSeq + 1, now = Date.now()
    const calls = previous.toolCalls.map(call => ({ ...call, status, revisionSeq: seq, finishedAt: now }))
    const run: SubagentRunView = { ...previous, status, lastSeq: seq, updatedAt: now, finishedAt: now, activeToolCount: 0,
      toolCalls: calls, latestActivity: calls[0], coverage: { ...previous.coverage, asOfSeq: seq, activeToolCount: 0, includedActiveToolCount: 0 },
      ...(status === 'cancelled' ? { stopReason: 'user_cancelled' } : { resultSummary: `DIRECTORY_RECONCILED_${runId}` }) }
    session.runs[position] = run
    versions.get(run.runId)!.set(seq, run)
    return run
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
      // A restarted remote endpoint can serve a new engine instance without
      // changing its storage identity. Forward only this test's local HTTP.
      if (replacementOrigin) {
        const destination = new URL(request.url ?? '/', replacementOrigin)
        const forward = httpRequest(destination, { method: request.method, headers: request.headers }, upstream => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers)
          upstream.pipe(response)
        })
        forward.on('error', error => { if (!response.destroyed) { errors.push(String(error)); if (!response.headersSent) response.writeHead(502); response.end(String(error)) } })
        response.once('close', () => { if (!response.writableFinished) forward.destroy() })
        request.pipe(forward); return
      }
      response.setHeader('content-type', 'application/json')
      if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
      let raw = ''
      for await (const part of request) raw += part.toString()
      const body: unknown = raw ? JSON.parse(raw) : {}
      const input = record(body) ? body : {}
      if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? '', current = sessions.get(sessionId)?.run
        const root = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
        response.end(envelope({ protocolVersion: 1, tenantId: `fixture-${prefix}`, sessionId,
          namespace: { id: `directory-${prefix}-db`, generation: 'one' },
          transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
          predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null })); return
      }
      if (path === '/api/v1/chat/admission/receipt' && request.method === 'POST') {
        const accepted = admissionReceipts.get(String(input.requestKey)), latest = accepted && sessions.get(accepted.run.sessionId)?.run
        const current = accepted && (latest?.runId === accepted.run.runId ? latest : accepted.run)
        response.end(envelope(accepted && current ? { protocolVersion: 1, status: 'accepted',
          receipt: { ...accepted.admission, sessionId: current.sessionId, rootRunId: current.runId,
            turnId: current.turnId, userMessageId: current.userMessageId, assistantMessageId: current.assistantMessageId },
          run: current, projection: { rootVersion: current.version, rootAttemptId: `attempt-${current.runId}`,
            user: { messageId: current.userMessageId, state: 'projected' },
            assistant: { anchorMessageId: current.assistantMessageId, state: 'persisted', messageId: current.assistantMessageId } }
        } : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
      }
      if (path === '/api/v1/chat' && request.method === 'POST') {
        const id = String(input.sessionId), message = String(input.message)
        if (!id.startsWith('work-')) throw new Error('Directory fixture received a non-Work task')
        chatWrites.push({ sessionId: id, message, collaborators: input.collaborators })
        let session = sessions.get(id)
        const collaborators = Array.isArray(input.collaborators) ? input.collaborators : []
        const resumeFromRunId = record(collaborators[0]) && typeof collaborators[0].resumeRunId === 'string' ? collaborators[0].resumeRunId : undefined
        if (resumeFromRunId) {
          if (!session || !session.runs.some(run => run.runId === resumeFromRunId && run.childSessionId === session!.first.childSessionId)) throw new Error('Continuation used a different child context')
          const now = Date.now(), number = chatWrites.filter(item => item.sessionId === id).length
          session.run = { ...session.run, runId: `${prefix}-root-${id}-turn-${number}`, turnId: `${prefix}-turn-${id}-${number}`,
            userMessageId: `${prefix}-user-${id}-${number}`, assistantMessageId: `${prefix}-assistant-${id}-${number}`, seq: session.run.seq + 1, createdAt: now, updatedAt: now, finishedAt: now }
          const next = createChild(id, session.run, 130, resumeFromRunId)
          session.runs.push(next)
          const user: EngineHistoryRow = { id: session.run.userMessageId, role: 'user', content: message, createdAt: now, conversationId: session.run.turnId,
            metadata: { rootRunId: session.run.runId, turnId: session.run.turnId } }
          const result = finalResult(session.run, `续跑已提交：${message}`)
          const content = result.text
          // Match the engine's admission order before publishing the new child.
          const admitted: RootRun = { ...session.run, version: 1, status: 'running', finishedAt: undefined }
          session.projection = [{ run: admitted }, { userMessage: user }, { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: next.runId, seq: next.lastSeq, view: next } }, { content }, { finalResult: result }, { run: session.run }]
          session.history.push(user, { id: session.run.assistantMessageId, role: 'assistant', content, createdAt: now, conversationId: session.run.turnId,
            metadata: { rootRunId: session.run.runId, turnId: session.run.turnId, finalResult: result } })
        } else {
          if (session) throw new Error('An original parent task was submitted twice')
          session = makeSession(id, message)
        }
        if (input.admission !== undefined) {
          const admission = input.admission
          if (!record(admission) || admission.protocolVersion !== 1 || admission.owner !== 'work' || typeof admission.requestKey !== 'string') throw new Error('Invalid directory fixture admission')
          admissionReceipts.set(admission.requestKey, { admission, run: session.run })
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        session.projection.forEach((payload, index) => {
          if (payload.subagentEvent?.schemaVersion === 2) parentSseChildren.push(payload.subagentEvent.runId)
          response.write(`id: ${session!.run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`)
        })
        response.end('data: [DONE]\n\n'); return
      }
      if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
        parentCancels.push(String(input.sessionId)); response.end(envelope({ sessionId: input.sessionId, cancelled: true })); return
      }
      if (path === '/api/v1/chat/stream' && request.method === 'GET') {
        const session = sessions.get(url.searchParams.get('sessionId') ?? '')
        const cursor = url.searchParams.get('lastEventId')
        const previous = cursor && session && cursor.startsWith(`${session.run.runId}:`) ? Number(cursor.slice(session.run.runId.length + 1)) : 0
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        session?.projection.forEach((payload, index) => {
          if (index + 1 > previous) response.write(`id: ${session.run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`)
        })
        response.end('data: [DONE]\n\n'); return
      }
      if (path === '/api/v1/subagent/capabilities') { response.end(envelope(capabilities)); return }
      if (path === '/api/v1/subagent/runs') {
        const parentSessionId = url.searchParams.get('parentSessionId') ?? '', cursor = url.searchParams.get('cursor')
        directoryReads.push({ parentSessionId, cursor, view: url.searchParams.get('view'), limit: url.searchParams.get('limit') })
        const session = sessions.get(parentSessionId)
        if (!session) { response.end(envelope({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: `${prefix}-empty` })); return }
        const offset = cursor === null ? 0 : cursor === `${prefix}-page-64` ? 64 : cursor === `${prefix}-page-128` ? 128 : -1
        if (offset < 0) { response.writeHead(400).end(JSON.stringify({ code: 400, message: 'CURSOR_SCOPE_MISMATCH', data: null })); return }
        const runs = session.runs.slice(offset, offset + PAGE_SIZE), hasMore = offset + PAGE_SIZE < session.runs.length
        const result = envelope({ schemaVersion: 2, runs, listComplete: !hasMore && offset === 0, hasMore,
          revision: `${prefix}-${parentSessionId}-directory`, ...(hasMore ? { nextCursor: `${prefix}-page-${offset + PAGE_SIZE}` } : {}) })
        if (hold?.parentSessionId === parentSessionId && hold.cursor === cursor) {
          hold = undefined; held = { response, body: result, parentSessionId, cursor }; return
        }
        response.end(result); return
      }
      const match = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/(cancel|tools|events)(?:\/([^/]+))?)?$/)
      if (match) {
        const runId = decodeURIComponent(match[1]), run = [...sessions.values()].flatMap(item => item.runs).find(item => item.runId === runId)
        if (!run) { response.writeHead(404).end(envelope(null)); return }
        if ((url.searchParams.has('parentSessionId') && url.searchParams.get('parentSessionId') !== run.parentSessionId)
          || (url.searchParams.has('rootSessionId') && url.searchParams.get('rootSessionId') !== run.rootSessionId)) {
          response.writeHead(403).end(JSON.stringify({ code: 403, message: 'CHILD_SCOPE_MISMATCH', data: null })); return
        }
        if (match[2] === 'cancel' && request.method === 'POST') { childCancels.push(runId); response.end(envelope(updateChild(runId, 'cancelled'))); return }
        const atSeq = Number(url.searchParams.get('atSeq') ?? run.lastSeq), version = versions.get(runId)?.get(atSeq)
        if (!version) { response.writeHead(409).end(JSON.stringify({ code: 409, message: 'WATERMARK_UNAVAILABLE', data: null })); return }
        if (match[2] === 'tools') {
          if (match[3]) {
            const call = version.toolCalls.find(item => item.id === decodeURIComponent(match[3]))
            if (!call) { response.writeHead(404).end(envelope(null)); return }
            const detail = Buffer.from(JSON.stringify({ args: { original: call.args, internalReceipt: 'RAW_DIRECTORY_ARGS_ONLY' }, output: `已完成目录文件检查。DIRECTORY_TOOL_${runId}` }))
            const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limitBytes') ?? 32768), end = Math.min(detail.length, offset + limit)
            response.end(envelope({ schemaVersion: 2, runId, asOfSeq: atSeq, tool: call, detail: { encoding: 'json-utf8', text: detail.subarray(offset, end).toString('utf8'), offset, totalBytes: detail.length, hasMore: end < detail.length, ...(end < detail.length ? { nextOffset: end } : {}) } })); return
          }
          response.end(envelope({ schemaVersion: 2, runId, asOfSeq: atSeq, totalCount: version.toolCount, items: version.toolCalls, hasMore: false })); return
        }
        if (match[2] === 'events') { response.end(envelope({ schemaVersion: 2, runId, events: [], nextSeq: run.lastSeq, hasMore: false, checkpointRequired: false })); return }
        runReads.push({ runId, parentSessionId: url.searchParams.get('parentSessionId'), rootSessionId: url.searchParams.get('rootSessionId'), status: run.status })
        response.end(envelope(version)); return
      }
      const id = url.searchParams.get('sessionId') ?? '', session = sessions.get(id)
      if (path === '/api/v1/conversation/display' && request.method === 'GET') {
        const rows = session?.history ?? []
        const users = rows.flatMap((row, index) => row.role === 'user' ? [{ row, index }] : [])
        const anchor = url.searchParams.get('anchorMessageId'), limit = Number(url.searchParams.get('limit') ?? 2)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error(`Invalid display limit: ${limit}`)
        const start = anchor ? users.findIndex(({ row }) => row.id === anchor) : Math.max(0, users.length - limit)
        if (start < 0) { response.writeHead(404).end(JSON.stringify({ code: 40400, message: 'Display turn not found', data: null })); return }
        const selected = users.slice(start, start + limit)
        // Display reads return whole turns; raw archive pages remain independent
        // so opening a child never preloads directory siblings into its parent.
        response.end(envelope({ schemaVersion: 1, grouping: 'root',
          turns: users.map(({ row }) => ({ userMessageId: row.id, conversationId: row.conversationId,
            preview: String(row.content ?? '').slice(0, 100), createdAt: row.createdAt })),
          messages: selected.length ? rows.slice(selected[0].index, users[start + selected.length]?.index ?? rows.length) : [],
          loadedTurnIds: selected.map(({ row }) => row.id), revision: `${prefix}-${id}-${rows.length}-${session?.run.version ?? 0}`,
          mutationRevision: `${prefix}-${id}-unchanged`, backend: 'jsonl', completeness: 'complete' })); return
      }
      if (path === '/api/v1/conversation/archive') {
        const rows = archives.get(id) ?? session?.history ?? [], current = Number(url.searchParams.get('current') ?? 1), pageSize = Number(url.searchParams.get('pageSize') ?? 50)
        archiveReads.push(id)
        response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, archiveRevision: `${prefix}-${id}-archive-${rows.length}`, backend: 'jsonl', compressed: false } })); return
      }
      if (path === '/api/v1/collaboration/capabilities') {
        response.end(envelope({ protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
          runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false })); return
      }
      if (path === '/api/v1/cron/capabilities' || path === '/api/v1/workbench/clients') { response.writeHead(404).end(envelope(null)); return }
      // Recovery must include this turn's published child. Initial siblings
      // remain discoverable only through the directory's HTTP pages.
      const publishedIds = new Set(session?.projection.flatMap(frame => frame.subagentEvent ? [frame.subagentEvent.runId] : []) ?? [])
      const publishedChildren = session?.runs.filter(child => publishedIds.has(child.runId)) ?? []
      const lastEventId = session ? `${session.run.runId}:${session.projection.length}` : null
      if (path === '/api/v1/chat/snapshot' && session) snapshotChildren.push(publishedChildren.map(child => child.runId))
      const data = path === '/health' ? { status: 'ok' }
        : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: `directory-fixture-${prefix}` }
          : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Directory fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
            : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: lastEventId, finished: true,
              projection: session?.projection ?? [], history: session?.history ?? [], run: session?.run, runs: session ? [session.run] : [], subagentRuns: publishedChildren, todos: [], changes: [], commandJobs: [] }
              : path === '/api/v1/chat/status' ? { running: false, finished: true, run: session?.run, lastEventId }
                : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
                  : path === '/api/v1/conversation/history' ? session?.history ?? []
                    : path === '/api/v1/conversation/sessions' ? [...sessions.entries()].map(([sessionId, item]) => ({ sessionId, title: item.history[0].content, lastAt: item.run.updatedAt, messageCount: item.history.length }))
                      : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
                        : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                          : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
                            : path === '/api/v1/workspace/directory' ? { root: '/remote/subagent-directory', entries: [] }
                              : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/subagent-directory' } : []
      response.setHeader('content-type', 'application/json'); response.end(envelope(data))
    })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
  })
  return { prefix, server, sessions, directoryReads, runReads, chatWrites, childCancels, parentCancels, archiveReads, parentSseChildren, snapshotChildren, agentName, makeSession, updateChild,
    holdPage(parentSessionId: string, cursor: string): void { if (held || hold) throw new Error('An owned page is already held'); hold = { parentSessionId, cursor } },
    heldPage(): HeldPage | undefined { return held },
    releasePage(fail = false): void {
      if (!held) throw new Error('No owned page to release')
      const value = held; held = undefined
      if (value.response.destroyed) return
      if (fail) value.response.writeHead(503).end(JSON.stringify({ code: 503, message: 'DIRECTORY_PAGE_RETRY', data: null }))
      else value.response.end(value.body)
    },
    replaceEndpointWith(destination: string): void {
      const value = new URL(destination)
      if (value.hostname !== '127.0.0.1' || value.protocol !== 'http:') throw new Error('Replacement must be an owned local HTTP fixture')
      replacementOrigin = destination
    },
    receipt() { return { prefix, replacementOrigin, directoryReads, runReads, chatWrites, childCancels, parentCancels, archiveReads, parentSseChildren, snapshotChildren } }
  }
}
const firstEngine = createFixture('FIRST'), secondEngine = createFixture('SECOND')
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = ''
const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '协作代理', exact: true })
const pagination = (): Locator => panel().locator('.work-subagents__pagination')
function origin(engine: ReturnType<typeof createFixture>): string {
  const address = engine.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing directory fixture port')
  return `http://127.0.0.1:${address.port}`
}
async function openWorkspace(): Promise<void> {
  if (await workspace().isVisible()) return
  const mobileTab = work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区(?: · \d+)?$/, exact: true })
  // Role locators omit hidden regions. A responsive pane already exists behind
  // its mobile tab, while the large-window toggle correctly says "收起工作区".
  if (await mobileTab.isVisible()) await mobileTab.click()
  else await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  await expect(workspace()).toBeVisible()
}
async function openDirectory(): Promise<void> {
  await openWorkspace()
  const tab = workspace().getByRole('tablist', { name: '已打开的工作区', exact: true }).getByRole('tab', { name: '子代理', exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    await workspace().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '子代理', exact: true }).click()
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
async function startTask(prompt: string): Promise<string> {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const before = firstEngine.chatWrites.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => firstEngine.chatWrites.length).toBe(before + 1)
  const id = firstEngine.chatWrites[before].sessionId
  await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(`目录任务已就绪：${prompt}`)
  await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
  await openDirectory()
  await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
  return id
}
const row = (engine: ReturnType<typeof createFixture>, index: number): Locator => panel().getByRole('button', { name: `查看 ${engine.agentName(index)} 子代理详情`, exact: true })
async function selectChild(engine: ReturnType<typeof createFixture>, index: number): Promise<void> {
  await row(engine, index).click()
  await expect(panel().locator('.work-subagents__heading h3')).toHaveText(engine.agentName(index))
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus() }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
  await openWorkspace()
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.locator('.app-settings__nav-item', { hasText: '外观' }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
}
async function writeReceipt(testInfo: TestInfo): Promise<void> {
  const path = testInfo.outputPath('directory-http-receipt.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ first: firstEngine.receipt(), second: secondEngine.receipt(), errors }, null, 2))
  await testInfo.attach('directory-http-receipt', { path, contentType: 'application/json' })
}

test.describe.serial('Work 子代理分页目录真实交互', () => {
  test.beforeAll(async () => {
    for (const engine of [firstEngine, secondEngine]) await new Promise<void>((done, reject) => { engine.server.once('error', reject); engine.server.listen(0, '127.0.0.1', done) })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-subagent-directory-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin(firstEngine), autoStartEngine: true,
      remoteWorkspaceRoot: '/remote/subagent-directory', lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', lastFolder: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global'); delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-subagent-directory-ui', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(async ({}, testInfo) => { await writeReceipt(testInfo); health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, testInfo) => {
    try { if (health) await health.closeAndAssert(testInfo); else await app?.close() }
    finally {
      for (const engine of [firstEngine, secondEngine]) { engine.server.closeAllConnections(); await new Promise<void>(done => engine.server.close(() => done())) }
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-subagent-directory-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('三页发现129轮并归并跨页上下文；分页失败保留详情草稿且同cursor重试', async () => {
    const id = await startTask('DIRECTORY_PAGING_ORIGINAL'), value = firstEngine.sessions.get(id)!
    expect(firstEngine.parentSseChildren.filter(runId => runId.includes(id))).toEqual([value.first.runId])
    expect(value.projection.flatMap(frame => frame.subagentEvent ? [frame.subagentEvent.runId] : [])).toEqual([value.first.runId])
    await expect(row(firstEngine, 129)).toHaveCount(0)
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect(pagination().filter({ hasText: /^代理 / }).locator(':scope > span')).toHaveText('代理 1–64 / 127')
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    await expect(row(firstEngine, 75)).toHaveCount(1)
    await expect(row(firstEngine, 75)).toHaveAccessibleName(`查看 ${firstEngine.agentName(75)} 子代理详情`)
    firstEngine.holdPage(id, 'FIRST-page-128')
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect.poll(() => firstEngine.heldPage()?.cursor).toBe('FIRST-page-128')
    await selectChild(firstEngine, 75)
    await expect(panel().locator('.work-subagents__round-count')).toHaveText('2 轮工作')
    const draft = panel().getByRole('textbox', { name: `继续交给 ${firstEngine.agentName(75)}`, exact: true })
    await draft.fill('PAGING_DRAFT：分页失败时继续保留输入')
    firstEngine.releasePage(true)
    await expect(panel().getByRole('alert')).toContainText('DIRECTORY_PAGE_RETRY')
    await expect(panel().locator('.work-subagents__heading h3')).toHaveText(firstEngine.agentName(75))
    await expect(draft).toHaveValue('PAGING_DRAFT：分页失败时继续保留输入')
    await expect(panel().locator('.work-subagents__round')).toHaveCount(2)
    await expect(panel().locator(`.work-subagents__round[data-run-id="${value.runs[74].runId}"]`)).toHaveCount(1)
    await panel().getByRole('button', { name: '返回子代理列表', exact: true }).press('Escape')
    await expect(row(firstEngine, 75)).toBeFocused()
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect(pagination().filter({ hasText: /^代理 / })).toContainText('代理 1–64 / 128')
    await pagination().getByRole('button', { name: '下一页', exact: true }).click()
    await expect(pagination().filter({ hasText: /^代理 / })).toContainText('代理 65–128 / 128')
    await expect(row(firstEngine, 129)).toHaveCount(1)
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    expect(firstEngine.directoryReads.filter(read => read.parentSessionId === id && read.cursor !== null).map(read => read.cursor)).toEqual(['FIRST-page-64', 'FIRST-page-128', 'FIRST-page-128'])
    await pagination().getByRole('button', { name: '上一页', exact: true }).click()
    await expect(row(firstEngine, 75)).toHaveAccessibleName(`查看 ${firstEngine.agentName(75)} 子代理详情`)
    const before = firstEngine.directoryReads.length
    await pagination().getByRole('button', { name: '返回第一页', exact: true }).click()
    await expect.poll(() => firstEngine.directoryReads.slice(before).some(read => read.parentSessionId === id && read.cursor === null)).toBe(true)
    await expect(pagination().getByRole('button', { name: '加载更多记录', exact: true })).toBeEnabled()
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect.poll(() => firstEngine.directoryReads.filter(read => read.parentSessionId === id && read.cursor === 'FIRST-page-64').length).toBe(2)
    await selectChild(firstEngine, 75); await expect(draft).toHaveValue('PAGING_DRAFT：分页失败时继续保留输入')
    const latestCard = panel().locator(`.subagent-card[data-run-id="${value.runs[74].runId}"]`)
    await latestCard.locator('.subagent-card__tools-header').click()
    await latestCard.locator('.subagent-card__call-toggle').click()
    const detail = latestCard.locator('.subagent-history__detail')
    await expect(detail).toContainText(`已完成目录文件检查。DIRECTORY_TOOL_${value.runs[74].runId}`)
    await expect(detail.locator('.subagent-history__toolbar')).toContainText('工具执行详情')
    await expect(detail).not.toContainText(/RAW_DIRECTORY_ARGS_ONLY|internalReceipt|字节|原始参数/)
    await expect(detail.locator('.subagent-card__call-section', { hasText: /^参数$/ })).toHaveCount(0)
    expect(firstEngine.chatWrites.filter(write => write.sessionId === id)).toEqual([{ sessionId: id, message: 'DIRECTORY_PAGING_ORIGINAL', collaborators: undefined }])
    expect(firstEngine.snapshotChildren.every(ids => ids.length === 1)).toBe(true)
  })

  test('简约协作布局将完成记录收为摘要，搜索只覆盖已载入代理且保留完整详情', async ({}, testInfo) => {
    const id = await startTask('协作界面设计验收'), value = firstEngine.sessions.get(id)!
    const search = panel().getByRole('searchbox', { name: '搜索已载入代理', exact: true })
    await search.fill('界面审阅 127')
    await expect(panel()).toContainText('0 个匹配 · 已载入 64 个')
    await expect(panel()).toContainText('已载入的代理中没有匹配结果')
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect(panel()).toContainText('1 个匹配 · 已载入 127 个')
    await expect(panel().locator('.work-subagents__row')).toHaveCount(1)
    await panel().locator('.work-subagents__row').press('Enter')
    await expect(panel().locator('.work-subagents__heading h3')).toHaveText('界面审阅 127')
    await panel().getByRole('button', { name: '代理信息', exact: true }).click()
    await expect(page.locator('.work-subagents__facts')).toContainText(modelId)
    await page.keyboard.press('Escape')
    await expect(page.locator('.work-subagents__info-panel')).toHaveCount(0)
    await expect(panel().locator('.work-subagents__heading h3')).toHaveText('界面审阅 127')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('界面审阅 127')
    await search.press('Escape')
    await expect(search).toHaveValue('')
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    await expect(panel().locator('.work-subagents__header')).toContainText('2 个已载入代理进行中')
    await expect(panel().getByRole('region', { name: '正在运行的子代理', exact: true })).toHaveCount(0)
    await expect(panel().locator('.work-subagents__row').first()).not.toContainText(/模型|耗时|工具|轮/)
    await expect(panel().locator('.work-subagents__row .work-subagents__avatar')).toHaveCount(0)
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const groups = conversation.getByRole('region', { name: '已完成的协作', exact: true })
    await expect(groups).toHaveCount(2)
    // The first receipt precedes the assistant prose, so it stays standalone.
    await expect(conversation.locator('.subagent-card')).toHaveCount(3)
    await expect(conversation.locator(`.subagent-card[data-run-id="${value.first.runId}"]`)).toBeVisible()
    for (const index of [99, 100]) await expect(conversation.locator(`.subagent-card[data-run-id="${value.runs[index].runId}"]`)).toBeVisible()
    const firstGroup = groups.first()
    await expect(firstGroup).toHaveAttribute('data-collaboration-count', '98')
    await firstGroup.locator('.work-collaboration-summary__toggle').press('Enter')
    await expect(firstGroup.locator('.subagent-card')).toHaveCount(18)
    await expect(firstGroup).toContainText('81–98 / 98')
    await firstGroup.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(firstGroup.locator(`.subagent-card[data-run-id="${value.runs[61].runId}"]`)).toBeVisible()
    await firstGroup.locator('.work-collaboration-summary__toggle').press('Space')
    await expect(firstGroup.locator('.subagent-card')).toHaveCount(0)
    for (const appearance of ['dark', 'light'] as const) {
      await setAppearance(appearance)
      for (const width of [1440, 940]) {
        await setWindow(width, 900)
        await expect(panel().locator('.work-subagents__row').first()).toBeVisible()
        const metrics = await panel().evaluate(element => {
          const row = element.querySelector('.work-subagents__row')!.getBoundingClientRect()
          return { rowHeight: row.height, client: element.clientWidth, scroll: element.scrollWidth }
        })
        expect(metrics.rowHeight).toBeGreaterThanOrEqual(44)
        expect(metrics.rowHeight).toBeLessThanOrEqual(64)
        expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1)
        await page.screenshot({ path: testInfo.outputPath(`collaboration-minimal-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await setWindow(1440, 900)
    // Completing adjacent runs must not replace a card that is being read or
    // move keyboard focus into the document when the completed groups join.
    const reading = conversation.locator(`.subagent-card[data-run-id="${value.runs[99].runId}"]`)
    if (await reading.getAttribute('open') === null) await reading.locator('summary').click()
    await expect(reading).toHaveAttribute('open', '')
    const readingControl = reading.locator('.subagent-card__tools-header')
    await expect(readingControl).toBeVisible()
    await expect.poll(() => readingControl.evaluate(element => element.closest('[inert], [hidden]') === null)).toBe(true)
    // Native details expands through content-visibility and block-size. Focus
    // can be ignored before that transition exposes the control to Chromium.
    await expect(async () => {
      await readingControl.focus()
      await expect(readingControl).toBeFocused({ timeout: 500 })
    }).toPass({ timeout: 5000 })
    const readingNode = await reading.elementHandle()
    firstEngine.updateChild(value.runs[99].runId, 'succeeded')
    await expect(reading.locator('summary')).toContainText('已完成')
    await expect(reading).toHaveAttribute('open', '')
    await expect(readingControl).toBeFocused()
    firstEngine.updateChild(value.runs[100].runId, 'succeeded')
    await expect(conversation.locator(`.subagent-card[data-run-id="${value.runs[100].runId}"] summary`)).toContainText('已完成')
    expect(await readingNode!.evaluate(node => node.isConnected)).toBe(true)
    await expect(readingControl).toBeFocused()
    await expect(groups).toHaveCount(2)
    expect(firstEngine.chatWrites.filter(write => write.sessionId === id)).toEqual([{ sessionId: id, message: '协作界面设计验收', collaborators: undefined }])
    expect(firstEngine.childCancels).not.toContain(value.first.runId)
  })

  test('后页active无父SSE时定向GET收敛终态；停止只取消选中run', async () => {
    const id = await startTask('DIRECTORY_ACTIVE_ORIGINAL'), value = firstEngine.sessions.get(id)!
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect(pagination().filter({ hasText: /^代理 / })).toContainText('代理 1–64 / 127')
    await pagination().getByRole('button', { name: '下一页', exact: true }).click()
    await expect(pagination().filter({ hasText: /^代理 / })).toContainText('代理 65–127 / 127')
    await expect(panel().locator('.work-subagents__row')).toHaveCount(63)
    await expect(row(firstEngine, 100)).toContainText('运行中')
    const target = value.runs[99], sibling = value.runs[100], parentPosts = firstEngine.chatWrites.length
    const before = firstEngine.runReads.filter(read => read.runId === target.runId).length
    firstEngine.updateChild(target.runId, 'succeeded')
    await expect.poll(() => firstEngine.runReads.filter(read => read.runId === target.runId && read.status === 'succeeded').length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(firstEngine.runReads.filter(read => read.runId === target.runId).length).toBeGreaterThan(before)
    await expect(row(firstEngine, 100)).toContainText('成功')
    expect(firstEngine.parentSseChildren.filter(runId => runId.includes(id))).toEqual([value.first.runId])
    expect(firstEngine.directoryReads.filter(read => read.parentSessionId === id && read.cursor === null).length).toBeGreaterThan(0)
    expect(firstEngine.runReads.filter(read => read.runId === target.runId).every(read => read.parentSessionId === id && read.rootSessionId === id)).toBe(true)
    await selectChild(firstEngine, 101)
    const cancelled = firstEngine.childCancels.length
    await panel().getByRole('button', { name: '停止本轮', exact: true }).click()
    await expect.poll(() => firstEngine.childCancels.slice(cancelled)).toEqual([sibling.runId])
    await expect(panel().locator('.work-subagents__heading [role="status"]')).toHaveText('已取消')
    expect(value.runs[99].status).toBe('succeeded'); expect(value.run.status).toBe('succeeded')
    expect(firstEngine.parentCancels).toEqual([]); expect(firstEngine.chatWrites.length).toBe(parentPosts)
  })

  test('小窗双视图统一滚动保留180px正文；主题、resize、Escape及CtrlEnter保留草稿并真实续跑', async ({}, testInfo) => {
    await setWindow(940, 640)
    const id = await startTask('DIRECTORY_SHORT_WINDOW_ORIGINAL'), value = firstEngine.sessions.get(id)!, name = firstEngine.agentName(1)
    await selectChild(firstEngine, 1)
    const toggle = panel().locator('.work-subagents__followup-toggle'), draft = panel().locator('.work-subagents__composer textarea')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(draft).toBeHidden()
    // Record an explicit collapsed choice so taller windows do not merely use
    // their expanded default during the collapsed-body geometry matrix.
    await toggle.press('Space'); await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('安排下一步')
    await expect(toggle).not.toContainText(name)
    await expect(panel().locator('.work-subagents__round-heading')).toHaveCount(0)
    await expect(panel().locator('.work-subagents__detail > .work-subagents__pagination')).toHaveCount(0)
    const roundCard = panel().locator('.subagent-card--round')
    await expect(roundCard.locator(':scope > summary')).toContainText('第 1 轮')
    await expect(roundCard.locator(':scope > summary')).not.toContainText(name)
    await expect(panel().locator(':scope > .collaboration-inspector')).toHaveCount(0)
    await panel().getByRole('button', { name: '代理信息', exact: true }).click()
    await expect(page.locator('.work-subagents__info-panel .collaboration-inspector > summary')).toHaveText('协作回执与能力')
    await page.keyboard.press('Escape')
    await expect(page.locator('.work-subagents__info-panel')).toHaveCount(0)
    const measurements: Array<Record<string, unknown>> = [], backgrounds: string[] = []
    for (const appearance of ['dark', 'light'] as const) {
      await setAppearance(appearance)
      backgrounds.push(await panel().evaluate(element => getComputedStyle(element).backgroundColor))
      for (const size of [{ width: 940, height: 640 }, { width: 1100, height: 760 }, { width: 1440, height: 900 }]) {
        await setWindow(size.width, size.height)
        let roundsViewport: { top: number; bottom: number } | undefined
        for (const view of ['工作轮次', '完整对话'] as const) {
          await panel().getByRole('button', { name: view, exact: true }).click()
          if (view === '完整对话') await expect(panel().getByRole('region', { name: `${name} 的完整对话`, exact: true })).toContainText('DIRECTORY_ARCHIVE_1_60')
          const scroller = panel().locator(view === '完整对话' ? '.work-subagent-transcript__scroll' : '.work-subagents__detail')
          const metrics = await scroller.evaluate(element => {
            const panel = element.closest('.work-subagents')!, body = element.closest('.work-subagent-transcript') ?? element
            const rect = body.getBoundingClientRect(), header = panel.querySelector('.work-subagents__header')!.getBoundingClientRect()
            const tabs = panel.querySelector('.work-subagents__tabs')!.getBoundingClientRect(), composer = panel.querySelector('.work-subagents__followup')!.getBoundingClientRect()
            return { height: element.clientHeight, width: element.clientWidth, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
              top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, overflowY: getComputedStyle(element).overflowY,
              headerBottom: header.bottom, tabsTop: tabs.top, tabsBottom: tabs.bottom, composerTop: composer.top }
          })
          expect(metrics.height, `${appearance}/${size.width}/${view}: readable body`).toBeGreaterThanOrEqual(180)
          expect(metrics.scrollWidth, `${appearance}/${size.width}/${view}: no horizontal clipping`).toBeLessThanOrEqual(metrics.width + 1)
          expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1)
          expect(metrics.overflowY).toMatch(/auto|scroll/)
          expect(metrics.tabsTop).toBeGreaterThanOrEqual(metrics.headerBottom)
          expect(metrics.top).toBeGreaterThanOrEqual(metrics.tabsBottom)
          expect(metrics.bottom).toBeLessThanOrEqual(metrics.composerTop + 1)
          if (view === '工作轮次') {
            roundsViewport = { top: metrics.top, bottom: metrics.bottom }
            const result = await roundCard.locator('.subagent-card__result-inner').evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, maxHeight: getComputedStyle(element).maxHeight, overflow: getComputedStyle(element).overflowY }))
            expect(result.maxHeight).toBe('none'); expect(result.overflow).toBe('visible')
            expect(result.scrollHeight).toBeLessThanOrEqual(result.height + 1)
          } else {
            expect(Math.abs(metrics.top - roundsViewport!.top)).toBeLessThanOrEqual(1)
            expect(Math.abs(metrics.bottom - roundsViewport!.bottom)).toBeLessThanOrEqual(1)
          }
          expect(metrics.scrollHeight).toBeGreaterThan(metrics.height)
          await scroller.evaluate(element => { element.scrollTop = 0 })
          await page.screenshot({ path: testInfo.outputPath(`directory-short-window-${appearance}-${size.width}x${size.height}-${view === '工作轮次' ? 'rounds' : 'transcript'}.png`), animations: 'disabled' })
          // The first four pixels belong to the workspace resize handle.
          await scroller.hover({ position: { x: 20, y: 40 } }); await page.mouse.wheel(0, 380)
          await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
          const scrollTop = await scroller.evaluate(element => element.scrollTop)
          await panel().getByRole('button', { name: view === '工作轮次' ? '完整对话' : '工作轮次', exact: true }).click()
          await panel().getByRole('button', { name: view, exact: true }).click()
          await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0)
          measurements.push({ appearance, view, ...size, ...metrics, actualScrollTarget: view === '完整对话' ? 'transcript' : 'rounds', scrollTop })
        }
      }
    }
    expect(backgrounds[0]).not.toBe(backgrounds[1])
    const metricsPath = testInfo.outputPath('directory-short-window-geometry.json')
    writeFileSync(metricsPath, JSON.stringify(measurements, null, 2)); await testInfo.attach('directory-short-window-geometry', { path: metricsPath, contentType: 'application/json' })
    const paired = panel().locator(`[data-transcript-id="${value.first.childSessionId}-paired-call"]`)
    await expect(paired.locator('.work-subagent-transcript__tool > summary')).toHaveCount(1)
    await expect(paired.locator('.work-subagent-transcript__tool > summary')).toContainText('review/notes.md')
    await expect(panel().locator(`article[data-transcript-id="${value.first.childSessionId}-paired-result"]`)).toHaveCount(0)
    await paired.locator('.work-subagent-transcript__tool > summary').click()
    await expect(paired.locator(`[data-transcript-id="${value.first.childSessionId}-paired-result"]`)).toContainText('DIRECTORY_PAIRED_FULL_OUTPUT')
    const orphan = panel().locator(`[data-transcript-id="${value.first.childSessionId}-orphan-result"]`)
    await orphan.locator('.work-subagent-transcript__tool > summary').click()
    await expect(orphan).toContainText('DIRECTORY_ORPHAN_RETAINED')
    await panel().getByRole('button', { name: '工作轮次', exact: true }).click()
    const resultEnd = roundCard.locator('h3', { hasText: 'DIRECTORY_RESULT_79' })
    await resultEnd.scrollIntoViewIfNeeded(); await expect(resultEnd).toBeInViewport()
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(draft).toHaveAccessibleName(`继续交给 ${name}`)
    await draft.fill('CONTINUATION_KEYBOARD_DRAFT：沿用此子代理上下文继续检查')
    for (const size of [{ width: 940, height: 640 }, { width: 1100, height: 760 }, { width: 1440, height: 900 }]) {
      await draft.focus(); await setWindow(size.width, size.height)
      await expect(draft).toBeVisible(); await expect(draft).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(draft).toHaveValue('CONTINUATION_KEYBOARD_DRAFT：沿用此子代理上下文继续检查')
    }
    await draft.press('Escape'); await expect(panel().locator('.work-subagents__heading h3')).toHaveText(name)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(toggle).toBeFocused()
    await expect(draft).toBeHidden(); await expect(toggle).toContainText('已保留草稿')
    await panel().getByRole('button', { name: '返回子代理列表', exact: true }).press('Escape')
    await expect(row(firstEngine, 1)).toBeFocused()
    await row(firstEngine, 1).press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(toggle).toContainText('已保留草稿')
    await toggle.press('Enter')
    await expect(draft).toBeVisible(); await expect(draft).toHaveValue('CONTINUATION_KEYBOARD_DRAFT：沿用此子代理上下文继续检查')
    await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    await expect(panel().getByRole('button', { name: '继续执行', exact: true })).toBeEnabled()
    const before = firstEngine.chatWrites.length
    await draft.press('Control+Enter')
    await expect.poll(() => firstEngine.chatWrites.length).toBe(before + 1)
    expect(firstEngine.chatWrites.at(-1)).toEqual({ sessionId: id, message: 'CONTINUATION_KEYBOARD_DRAFT：沿用此子代理上下文继续检查', collaborators: [{ resumeRunId: value.first.runId }] })
    await expect(panel().locator('.work-subagents__round')).toHaveCount(2)
    await expect(draft).toHaveAccessibleName(`补充要求给 ${name}`); await expect(draft).toHaveValue('')
    await draft.fill('ACTIVE_NEXT_DRAFT：执行时先保存下一步')
    await draft.press('Control+Enter'); expect(firstEngine.chatWrites.length).toBe(before + 1)
    const active = value.runs.find(run => run.resumeFromRunId === value.first.runId)!
    expect(active.childSessionId).toBe(value.first.childSessionId)
    const cancelled = firstEngine.childCancels.length
    await panel().getByRole('button', { name: '停止本轮', exact: true }).click()
    await expect.poll(() => firstEngine.childCancels.slice(cancelled)).toEqual([active.runId])
    await expect(draft).toHaveAccessibleName(`继续交给 ${name}`)
    await expect(draft).toHaveValue('ACTIVE_NEXT_DRAFT：执行时先保存下一步')
    expect(firstEngine.parentCancels).toEqual([])
    expect(firstEngine.archiveReads).toContain(value.first.childSessionId)
    await setAppearance('dark'); await setWindow(1440, 900)
  })

  test('切换父任务与远端来源丢弃迟到页面；不重POST原任务或串用cursor', async () => {
    const oldParent = await startTask('DIRECTORY_PARENT_A_ORIGINAL')
    firstEngine.holdPage(oldParent, 'FIRST-page-64')
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect.poll(() => firstEngine.heldPage()?.parentSessionId).toBe(oldParent)
    const currentParent = await startTask('DIRECTORY_PARENT_B_ORIGINAL')
    firstEngine.releasePage()
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    expect(firstEngine.directoryReads.filter(read => read.parentSessionId === currentParent).every(read => read.cursor === null)).toBe(true)
    expect(firstEngine.chatWrites.filter(write => write.sessionId === oldParent)).toHaveLength(1)
    await selectChild(firstEngine, 1)
    const oldDraft = panel().getByRole('textbox', { name: `继续交给 ${firstEngine.agentName(1)}`, exact: true })
    await oldDraft.fill('SOURCE_A_PRIVATE_DRAFT')
    await panel().getByRole('button', { name: '返回子代理列表', exact: true }).click()
    firstEngine.holdPage(currentParent, 'FIRST-page-64')
    await pagination().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect.poll(() => firstEngine.heldPage()?.parentSessionId).toBe(currentParent)
    // Replace the instance behind the same endpoint. Its persistent parent is
    // legitimate server history; renderer state is restored by actual IPC GETs.
    secondEngine.makeSession(currentParent, 'DIRECTORY_SOURCE_B_PERSISTED')
    firstEngine.replaceEndpointWith(origin(secondEngine))
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.locator('.app-settings__nav-item', { hasText: '引擎管理' }).click()
    await settings.getByRole('button', { name: '重启', exact: true }).click()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await openDirectory()
    await expect.poll(() => secondEngine.directoryReads.some(read => read.parentSessionId === currentParent)).toBe(true)
    firstEngine.releasePage()
    await expect(panel().locator('.work-subagents__row')).toHaveCount(PAGE_SIZE)
    await expect(row(secondEngine, 1)).toHaveCount(1); await expect(row(firstEngine, 75)).toHaveCount(0)
    await expect(panel()).not.toContainText('FIRST-')
    expect(secondEngine.directoryReads.every(read => read.cursor === null)).toBe(true)
    await selectChild(secondEngine, 1)
    await expect(panel().getByRole('textbox', { name: `继续交给 ${secondEngine.agentName(1)}`, exact: true })).toHaveValue('')
    expect(firstEngine.chatWrites.filter(write => write.sessionId === currentParent)).toHaveLength(1)
    expect(secondEngine.chatWrites).toEqual([]); expect(firstEngine.parentCancels).toEqual([]); expect(secondEngine.childCancels).toEqual([])
  })
})
