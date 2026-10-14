/** Real Electron + authenticated local SSE regression for the GAjuXf Work
 * click timeouts. The provider is synthetic; the IPC decoder, React tree,
 * native input/actionability, child archive and draft persistence stay real.
 * Run serially against a freshly built or immutable AETHER_E2E_APP_ENTRY.
 * No real model, business profile, product click injection or force click. */
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload, EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView, SubagentToolSummary } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureParent = join(root, '.e2e-tmp')
const token = 'work-streaming-interaction-fixture', modelId = 'work-streaming-interaction-model'
const workspaceRoot = '/remote/work-streaming-interaction'
const clickTimeoutMs = 20_000, responseBudgetMs = 2_500, tickIntervalMs = 50
const sessions = new Map<string, Session>(), children = new Map<string, SubagentRunView>()
const childVersions = new Map<string, Map<number, SubagentRunView>>()
const archives = new Map<string, EngineHistoryRow[]>(), files = new Map<string, string>()
const requests: Array<{ sessionId: string; message: string }> = [], cancellations: string[] = [], childCancellations: string[] = []
const archiveReads: Array<{ childSessionId: string; current: number; pageSize: number; total: number; revision: string }> = []
const archiveRefreshes: Array<{ childSessionId: string; viewport: { width: number; height: number }; rowId: string; watermark: number; total: number; tick: number; readIndex: number }> = []
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = ''
let timer: ReturnType<typeof setInterval> | undefined
interface CpuProbe {
  session: CDPSession
  timer?: ReturnType<typeof setTimeout>
  result?: Promise<{ profile?: unknown; error?: string }>
}
let cpuProbe: CpuProbe | undefined

interface Session {
  run: RootRun
  response: ServerResponse
  seq: number
  ticks: number
  frames: number
  bytes: number
  startedAt: number
  content: string
  history: EngineHistoryRow[]
  projection: ChatSsePayload[]
  changes: EngineFileChange[]
}
interface Receipt {
  label: string
  viewport: { width: number; height: number }
  clickMs: number
  responseMs: number
  tickBefore: number
  tickAfter: number
  sequence: number
  error?: string
}
interface BrowserProbe {
  longTasks: Array<{ startTime: number; duration: number }>
  longTaskCount: number
  longTaskTotalMs: number
  observer: PerformanceObserver | null
}

const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const childName = (index: number): string => `流式协作代理 ${index + 1}`
function value(id: string): Session {
  const result = sessions.get(id)
  if (!result) throw new Error(`Missing streaming session ${id}`)
  return result
}
function emit(id: string, payload: ChatSsePayload): void {
  const session = value(id)
  if (session.response.destroyed || session.response.writableEnded) throw new Error(`Closed SSE ${id}`)
  if (payload.content) session.content += payload.content
  session.projection.push(structuredClone(payload))
  const wire = `id: ${session.run.runId}:${++session.seq}\ndata: ${JSON.stringify(payload)}\n\n`
  session.frames++
  session.bytes += Buffer.byteLength(wire)
  session.response.write(wire)
}
function publishChild(id: string, run: SubagentRunView): void {
  children.set(run.runId, structuredClone(run))
  let versions = childVersions.get(run.runId)
  if (!versions) { versions = new Map(); childVersions.set(run.runId, versions) }
  versions.set(run.lastSeq, structuredClone(run))
  emit(id, { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: run.runId, seq: run.lastSeq, view: run } })
}
function call(index: number, seq: number, running: boolean): SubagentToolSummary {
  return { id: `child-call-${index}`, name: 'read_file', args: { path: `module-${index + 1}.ts` }, output: `CHILD_TOOL_WATERMARK_${seq}`,
    status: running ? 'running' : 'succeeded', ordinal: 1, revisionSeq: seq, detailRef: `child-detail-${index}`, detailTruncated: false }
}
function makeChild(id: string, run: RootRun, index: number): SubagentRunView {
  const now = Date.now(), latest = call(index, 1, true)
  return { schemaVersion: 2, view: 'summary', runId: `child-${id}-${index}`, tenantId: 'streaming-fixture', rootSessionId: id, parentSessionId: id,
    parentConversationId: run.turnId, parentMessageId: run.assistantMessageId, parentToolCallId: `dispatch-${index}`, childSessionId: `context-${id}-${index}`,
    task: `检查模块 ${index + 1} 的实现与测试`, description: childName(index), agentName: childName(index), modelId, status: 'running',
    createdAt: now, startedAt: now, updatedAt: now, lastSeq: 1, usage: {}, continuation: { readOnly: false }, toolCount: 1, activeToolCount: 1,
    toolCalls: [latest], latestActivity: latest, partialOutput: `CHILD_LIVE_${index}_1`,
    coverage: { asOfSeq: 1, toolCount: 1, includedToolCount: 1, activeToolCount: 1, includedActiveToolCount: 1, ids: [latest.id], hasMore: false, truncated: false, completeness: 'complete' } }
}
function completeChild(id: string, run: SubagentRunView, status: 'succeeded' | 'cancelled'): void {
  const index = Number(run.parentToolCallId.slice('dispatch-'.length)), seq = run.lastSeq + 1
  const latest: SubagentToolSummary = { ...call(index, seq, false), status }
  publishChild(id, { ...run, lastSeq: seq, updatedAt: Date.now(), finishedAt: Date.now(), status, activeToolCount: 0, toolCalls: [latest], latestActivity: latest,
    ...(status === 'succeeded' ? { resultSummary: Array.from({ length: 80 }, (_, row) => `### CHILD_RESULT_${index}_${row}\n\n已验证第 ${row} 项约束，协作结论保留。\n\n\`\`\`ts\nexport const check${row} = ${row};\n\`\`\``).join('\n\n') } : { stopReason: 'user_cancelled' }),
    coverage: { ...run.coverage, asOfSeq: seq, activeToolCount: 0, includedActiveToolCount: 0 } })
}
function change(id: string, version: number): EngineFileChange {
  return { id: 'streaming-report-receipt', toolCallId: 'write-report', path: `${workspaceRoot}/report.md`, displayPath: 'report.md', kind: 'write',
    oldContent: version === 1 ? null : files.get('report.md') ?? null, newContent: `# STREAM_ARTIFACT_VERSION_${version}\n\nLATEST_ARTIFACT_CONTENT_${version}\n\n持续流式任务的当前成果。`,
    isNew: version === 1, truncated: false, status: 'kept', createdAt: value(id).startedAt }
}
function appendArchive(childSessionId: string, marker: string): { rowId: string; watermark: number; total: number } {
  const rows = archives.get(childSessionId)
  if (!rows) throw new Error(`Missing streaming archive ${childSessionId}`)
  const watermark = rows.length + 1, rowId = `append-${watermark}`
  rows.push({ id: rowId, role: 'assistant', content: `${marker} LIVE_ARCHIVE_APPEND_${watermark}`, createdAt: Date.now(), conversationId: childSessionId })
  return { rowId, watermark, total: rows.length }
}
function publishArtifact(id: string, version: number): EngineFileChange {
  const receipt = change(id, version), session = value(id)
  files.set('report.md', receipt.newContent ?? '')
  session.changes = [receipt]
  emit(id, { fileChange: receipt })
  return receipt
}
function startLoad(id: string): void {
  if (timer) throw new Error('Only one sustained fixture may run at a time')
  timer = setInterval(() => {
    try {
      const session = value(id)
      if (session.run.status !== 'running') return
      const tick = ++session.ticks
      emit(id, { content: `\n\nSTREAM_PARENT_TICK_${tick}：持续分析与协作仍在运行。` })
      for (const run of [...children.values()].filter(child => child.parentSessionId === id && child.status === 'running')) {
        if (tick === 12 && run.parentToolCallId !== 'dispatch-4') { completeChild(id, run, 'succeeded'); continue }
        const index = Number(run.parentToolCallId.slice('dispatch-'.length)), seq = run.lastSeq + 1, latest = call(index, seq, true)
        publishChild(id, { ...run, lastSeq: seq, updatedAt: Date.now(), toolCalls: [latest], latestActivity: latest, partialOutput: `CHILD_LIVE_${index}_${seq}`, coverage: { ...run.coverage, asOfSeq: seq } })
      }
      // Append history while the UI is reading it. Each HTTP page is coherent,
      // but independent pages are allowed to observe different live revisions.
      if (tick % 4 === 0) {
        const run = [...children.values()].find(child => child.parentSessionId === id && child.parentToolCallId === 'dispatch-4')!
        appendArchive(run.childSessionId, `PERIODIC_TICK_${tick}`)
      }
    } catch (error) { errors.push(String(error)); stopLoad() }
  }, tickIntervalMs)
}
function stopLoad(): void { if (timer) clearInterval(timer); timer = undefined }
function finish(id: string, status: 'succeeded' | 'cancelled'): void {
  stopLoad()
  const session = value(id), now = Date.now()
  session.run = { ...session.run, status, seq: session.seq + 1, version: session.run.version + 1, updatedAt: now, finishedAt: now }
  for (const run of [...children.values()].filter(child => child.parentSessionId === id && child.status === 'running')) completeChild(id, run, status)
  session.history.push({ id: session.run.assistantMessageId, role: 'assistant', content: session.content, createdAt: now, conversationId: session.run.turnId })
  emit(id, { run: session.run })
  session.response.end('data: [DONE]\n\n')
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '', current = sessions.get(sessionId)?.run ?? null
      const root = current ? { ...current, attemptId: 'fixture-attempt-' + current.runId } : null
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ protocolVersion: 1, tenantId: 'work-fixture', sessionId,
        namespace: { id: 'work-fixture-db', generation: 'generation-one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root,
        predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }))
      return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const id = String(body.sessionId), now = Date.now()
      if (!id.startsWith('work-')) throw new Error('Fixture received a non-Work task')
      requests.push({ sessionId: id, message: String(body.message) })
      const run: RootRun = { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`,
        seq: 1, version: 1, status: 'running', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
      const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: String(body.message), createdAt: now, conversationId: run.turnId }
      sessions.set(id, { run, response, seq: 0, ticks: 0, frames: 0, bytes: 0, startedAt: now, content: '', history: [user], projection: [], changes: [] })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      emit(id, { run }); emit(id, { userMessage: user })
      emit(id, { content: Array.from({ length: 100 }, (_, index) => `### STREAM_INITIAL_${index}\n\n先核对约束，再由五个代理同时检查结果。\n\n\`\`\`ts\nexport const initial${index} = ${index};\n\`\`\``).join('\n\n') })
      for (let index = 0; index < 5; index++) {
        const delegated = makeChild(id, run, index)
        archives.set(delegated.childSessionId, Array.from({ length: 61 }, (_, row) => ({ id: `${delegated.runId}-row-${row}`, role: row % 2 ? 'assistant' : 'user', content: `CHILD_ARCHIVE_${index}_${row}`, createdAt: now + row, conversationId: delegated.childSessionId })))
        publishChild(id, delegated)
      }
      for (let index = 0; index < 30; index++) {
        const toolId = `finished-tool-${index}`
        emit(id, { toolStart: { id: toolId, name: 'read_file', args: { path: `verified-${index}.ts` } } })
        emit(id, { toolEnd: { id: toolId, name: 'read_file', output: `ACTIVITY_FINISHED_${index}\n${Array.from({ length: 40 }, (_, row) => `验证正文 ${row}`).join('\n')}`, success: true } })
      }
      emit(id, { toolStart: { id: 'write-report', name: 'write_file', args: { path: 'report.md' } } }); publishArtifact(id, 1)
      emit(id, { toolEnd: { id: 'write-report', name: 'write_file', output: '报告已写入', success: true } })
      startLoad(id); return
    }
    if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
      const id = String(body.sessionId); cancellations.push(id); finish(id, 'cancelled')
      response.setHeader('content-type', 'application/json'); response.end(envelope({ cancelled: true, sessionId: id })); return
    }
    if (path === '/api/v1/subagent/capabilities') {
      response.setHeader('content-type', 'application/json'); response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(envelope(null)); return }
    if (path === '/api/v1/subagent/runs') {
      response.setHeader('content-type', 'application/json'); response.end(envelope({ schemaVersion: 2, runs: [...children.values()].filter(run => run.parentSessionId === url.searchParams.get('parentSessionId')), listComplete: true, hasMore: false, revision: 'streaming-fixture' })); return
    }
    const match = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/(tools|cancel|events)(?:\/([^/]+))?)?$/)
    if (match) {
      const run = children.get(decodeURIComponent(match[1])); response.setHeader('content-type', 'application/json')
      if (!run) { response.writeHead(404).end(envelope(null)); return }
      if (match[2] === 'cancel' && request.method === 'POST') {
        childCancellations.push(run.runId); completeChild(run.parentSessionId, run, 'cancelled'); response.end(envelope(children.get(run.runId))); return
      }
      if (match[2] === 'tools') {
        const atSeq = Number(url.searchParams.get('atSeq') ?? run.lastSeq)
        const version = childVersions.get(run.runId)?.get(atSeq)
        if (!version) { response.writeHead(409).end(JSON.stringify({ code: 40901, message: 'Requested watermark unavailable', data: null })); return }
        const tool = version.toolCalls[0]
        if (match[3]) {
          if (decodeURIComponent(match[3]) !== tool.id) { response.writeHead(404).end(envelope(null)); return }
          const rawDetail = Buffer.from(JSON.stringify({ args: tool.args, output: tool.output }), 'utf8')
          const offset = Number(url.searchParams.get('offset') ?? '0'), limit = Number(url.searchParams.get('limitBytes') ?? '32768'), end = Math.min(rawDetail.length, offset + limit)
          response.end(envelope({ schemaVersion: 2, runId: run.runId, asOfSeq: atSeq, tool, detail: { encoding: 'json-utf8', text: rawDetail.subarray(offset, end).toString('utf8'), offset, totalBytes: rawDetail.length, hasMore: end < rawDetail.length, ...(end < rawDetail.length ? { nextOffset: end } : {}) } })); return
        }
        const cursor = Number(url.searchParams.get('cursor') ?? '0'), limit = Number(url.searchParams.get('limit') ?? '50')
        response.end(envelope({ schemaVersion: 2, runId: run.runId, asOfSeq: atSeq, totalCount: 1, items: version.toolCalls.slice(cursor, cursor + limit), hasMore: false })); return
      }
      if (match[2] === 'events') {
        const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0'), limit = Number(url.searchParams.get('limit') ?? '50')
        const remaining = [...childVersions.get(run.runId)!.values()].filter(version => version.lastSeq > afterSeq)
        const events = remaining.slice(0, limit).map(version => ({ schemaVersion: 2, kind: 'snapshot', runId: run.runId, seq: version.lastSeq, view: version }))
        response.end(envelope({ schemaVersion: 2, runId: run.runId, events, nextSeq: events.at(-1)?.seq ?? afterSeq, hasMore: remaining.length > events.length, checkpointRequired: false })); return
      }
      const atSeq = url.searchParams.get('atSeq'), version = atSeq === null ? run : childVersions.get(run.runId)?.get(Number(atSeq))
      if (!version) { response.writeHead(409).end(JSON.stringify({ code: 40901, message: 'Requested watermark unavailable', data: null })); return }
      response.end(envelope(version)); return
    }
    if (path === '/api/v1/conversation/archive') {
      const childSessionId = url.searchParams.get('sessionId') ?? '', rows = archives.get(childSessionId) ?? []
      const current = Number(url.searchParams.get('current') ?? '1'), pageSize = Number(url.searchParams.get('pageSize') ?? '50'), revision = `archive-${rows.length}-${rows.at(-1)?.id ?? 'empty'}`
      archiveReads.push({ childSessionId, current, pageSize, total: rows.length, revision })
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, archiveRevision: revision, backend: 'jsonl', compressed: false } })); return
    }
    if (path === '/api/v1/workspace/file/content') {
      const requested = (url.searchParams.get('path') ?? '').replace(/\\/g, '/')
      const relative = requested.startsWith(`${workspaceRoot}/`) ? requested.slice(workspaceRoot.length + 1) : requested
      const content = files.get(relative)
      response.setHeader('content-type', 'application/json')
      if (content === undefined) { response.writeHead(404).end(JSON.stringify({ code: 40401, message: 'File not found in the fixture workspace', data: null })); return }
      response.end(envelope({ content, isBinary: false, totalSize: Buffer.byteLength(content) })); return
    }
    const binding = path.match(/^\/api\/v1\/sessions\/([^/]+)\/binding$/)
    if (binding) {
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ started: sessions.has(decodeURIComponent(binding[1])), agentId: null, metadata: null, agent: null })); return
    }
    const id = url.searchParams.get('sessionId') ?? '', session = sessions.get(id)
    const data = path === '/health' ? { status: 'ok' }
      // The host manifest remains v1; v2 child views are separately negotiated
      // by /subagent/capabilities, as on the real embedded engine.
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-streaming-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Streaming fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: session?.run.status === 'running' ? 'live' : 'persisted', eventId: session ? `${session.run.runId}:${session.seq}` : null, finished: session?.run.status !== 'running', projection: session?.projection ?? [], history: session?.history ?? [], run: session?.run, runs: session ? [session.run] : [], todos: [], changes: session?.changes ?? [], commandJobs: [], subagentRuns: [...children.values()].filter(run => run.parentSessionId === id) }
            : path === '/api/v1/chat/status' ? { running: session?.run.status === 'running', finished: Boolean(session && session.run.status !== 'running'), run: session?.run, lastEventId: session ? `${session.run.runId}:${session.seq}` : null }
              : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
                : path === '/api/v1/conversation/sessions' ? [...sessions.entries()].map(([sessionId, item]) => ({ sessionId, title: item.history[0].content, lastAt: item.startedAt, messageCount: item.history.length }))
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                        : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
                          : path === '/api/v1/workspace/bind' ? { workspaceRoot }
                            : path === '/api/v1/system-tools' || path === '/api/v1/tools' ? [{ name: 'read_file', displayName: '读取文件', description: '读取隔离工作区' }, { name: 'write_file', displayName: '写入文件', description: '写入隔离工作区' }]
                              : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '协作代理', exact: true })
async function startTask(prompt: string): Promise<string> {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const before = requests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => requests.length).toBe(before + 1)
  const id = requests[before].sessionId
  await expect(work().locator('[data-current-run-feedback="true"]')).toHaveAttribute('data-state', 'running')
  await expect.poll(() => value(id).ticks).toBeGreaterThanOrEqual(20)
  return id
}
async function openWorkspace(): Promise<void> {
  if (!await workspace().count()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  if (!await workspace().isVisible()) await work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区(?: · \d+)?$/ }).click()
  await expect(workspace()).toBeVisible()
}
async function measure(id: string, label: string, target: Locator, verify: () => Promise<void>, receipts: Receipt[]): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), before = value(id).ticks, started = performance.now()
  let clickMs = 0, failure: string | undefined
  try {
    await target.click({ timeout: clickTimeoutMs })
    clickMs = performance.now() - started
    await verify()
  } catch (error) { failure = String(error); throw error }
  finally {
    receipts.push({ label, viewport, clickMs: clickMs || performance.now() - started, responseMs: performance.now() - started, tickBefore: before, tickAfter: value(id).ticks, sequence: value(id).seq, ...(failure ? { error: failure } : {}) })
  }
  expect(receipts.at(-1)!.responseMs, `${label}: click and observable result under live SSE`).toBeLessThanOrEqual(responseBudgetMs)
}
async function tab(id: string, name: '活动' | '成果' | '子代理', receipts: Receipt[]): Promise<void> {
  const target = workspace().getByRole('tablist', { name: '工作区内容', exact: true }).getByRole('tab', { name: new RegExp('^' + name + '(?: \\d+)?$') })
  await measure(id, `open-${name}`, target, () => expect(target).toHaveAttribute('aria-selected', 'true'), receipts)
}
async function installProbe(): Promise<void> {
  await page.evaluate(() => {
    const probe: BrowserProbe = { longTasks: [], longTaskCount: 0, longTaskTotalMs: 0, observer: null }
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      probe.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          probe.longTaskCount++
          probe.longTaskTotalMs += entry.duration
          probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
        if (probe.longTasks.length > 1024) probe.longTasks.splice(0, probe.longTasks.length - 1024)
      })
      probe.observer.observe({ type: 'longtask', buffered: false })
    }
    ;(window as Window & { workStreamingProbe?: BrowserProbe }).workStreamingProbe = probe
  })
  if (process.env.AETHER_E2E_STREAMING_CPU === '1') {
    const session = await page.context().newCDPSession(page)
    const probe: CpuProbe = { session }
    cpuProbe = probe
    await session.send('Profiler.enable')
    // Diagnostic-only sampling has a fixed frequency and lifetime. It changes
    // neither the sustained provider fixture nor the response/action budgets.
    await session.send('Profiler.setSamplingInterval', { interval: 2_000 })
    await session.send('Profiler.start')
    probe.timer = setTimeout(() => { void stopCpuProbe(probe) }, 120_000)
  }
}
function stopCpuProbe(probe: CpuProbe): Promise<{ profile?: unknown; error?: string }> {
  if (!probe.result) {
    if (probe.timer) clearTimeout(probe.timer)
    probe.timer = undefined
    probe.result = probe.session.send('Profiler.stop').then(result => ({ profile: result.profile }), error => ({ error: String(error) })).finally(() => probe.session.detach().catch(() => {}))
  }
  return probe.result
}
async function report(testInfo: TestInfo, id: string, receipts: Receipt[]): Promise<void> {
  const probe = cpuProbe
  cpuProbe = undefined
  const cpu = probe ? await stopCpuProbe(probe) : undefined
  if (cpu) {
    const profilePath = testInfo.outputPath(cpu.profile ? 'work-streaming-interaction.cpuprofile' : 'work-streaming-cpu-error.json')
    writeFileSync(profilePath, JSON.stringify(cpu.profile ?? cpu, null, 2))
    await testInfo.attach(cpu.profile ? 'streaming-renderer-cpu-profile' : 'streaming-renderer-cpu-error', { path: profilePath, contentType: 'application/json' })
  }
  const metrics = await page.evaluate(() => {
    const probe = (window as Window & { workStreamingProbe?: BrowserProbe }).workStreamingProbe
    probe?.observer?.disconnect()
    return { longTaskSupported: Boolean(probe?.observer), longTasks: probe?.longTasks ?? [], longTaskCount: probe?.longTaskCount ?? 0, longTaskTotalMs: probe?.longTaskTotalMs ?? 0, domNodes: document.querySelectorAll('*').length, viewport: { width: innerWidth, height: innerHeight } }
  }).catch(error => ({ probeError: String(error) }))
  const session = value(id)
  const output = testInfo.outputPath('work-streaming-interaction-receipts.json')
  writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), candidate: process.env.AETHER_E2E_APP_ENTRY ?? '.', clickTimeoutMs, responseBudgetMs, tickIntervalMs, initialChildCount: 5,
    root: { runId: session.run.runId, status: session.run.status, ticks: session.ticks, frames: session.frames, bytes: session.bytes, sequence: session.seq },
    children: [...children.values()].filter(run => run.parentSessionId === id).map(run => ({ runId: run.runId, status: run.status, lastSeq: run.lastSeq, archiveRows: archives.get(run.childSessionId)?.length })),
    receipts, archiveReads, archiveRefreshes, cancellations, childCancellations, metrics, errors,
    cpu: { requested: process.env.AETHER_E2E_STREAMING_CPU === '1', samplingIntervalUs: 2000, maximumDurationMs: 120_000, captured: Boolean(cpu?.profile), ...(cpu?.error ? { error: cpu.error } : {}) } }, null, 2))
  await testInfo.attach('streaming-load-and-click-receipts', { path: output, contentType: 'application/json' })
}

test.describe.serial('Work 持续子Agent事件中的真实点击与数据保留', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing streaming fixture port')
    mkdirSync(fixtureParent, { recursive: true }); fixture = mkdtempSync(join(fixtureParent, 'work-streaming-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, remoteWorkspaceRoot: workspaceRoot, lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', lastFolder: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, entry]) => entry === undefined ? [] : [[key, entry]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-streaming-interaction', [token]); page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, testInfo) => {
    stopLoad()
    if (cpuProbe) { await stopCpuProbe(cpuProbe); cpuProbe = undefined }
    for (const session of sessions.values()) session.response.destroy()
    try { if (health) await health.closeAndAssert(testInfo); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const absolute = resolve(fixture)
        if (dirname(absolute) !== fixtureParent || !basename(absolute).startsWith('work-streaming-')) throw new Error(`Unsafe owned cleanup ${absolute}`)
        rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('三种视口持续流中活动、成果、子对话响应预算与引用新鲜度；取消只停止指定范围', async ({}, testInfo) => {
    const id = await startTask('STREAMING_CLICK_REGRESSION：持续协作中查看活动与成果'), receipts: Receipt[] = []
    const runningChild = [...children.values()].find(run => run.parentSessionId === id && run.parentToolCallId === 'dispatch-4')!
    await installProbe()
    try {
      for (const size of [{ width: 1440, height: 900 }, { width: 1102, height: 760 }, { width: 940, height: 640 }]) {
        await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
        // Chromium rounds native content dimensions at fractional Windows DPR.
        // Keep the requested matrix within two pixels and record actual bounds.
        await expect.poll(async () => {
          const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          return Math.abs(actual.width - size.width) <= 2 && Math.abs(actual.height - size.height) <= 2
        }).toBe(true)
        await openWorkspace()
        expect(await workspace().evaluate(element => element.scrollWidth - element.clientWidth), `${size.width}: workspace horizontal overflow`).toBeLessThanOrEqual(2)
        await tab(id, '活动', receipts)
        const completed = workspace().getByRole('listbox', { name: '工具活动列表', exact: true }).getByRole('option').filter({ hasText: childName(0) })
        await measure(id, 'select-completed-child-activity', completed, () => expect(workspace().locator('.work-activity-detail')).toContainText(childName(0)), receipts)
        await tab(id, '成果', receipts)
        await expect(workspace().locator('.work-artifact-preview')).toContainText('STREAM_ARTIFACT_VERSION_1')
        await tab(id, '子代理', receipts)
        if (await panel().getByRole('button', { name: '返回子代理列表', exact: true }).count()) await panel().getByRole('button', { name: '返回子代理列表', exact: true }).click({ timeout: clickTimeoutMs })
        await measure(id, 'open-live-child-detail', panel().getByRole('button', { name: `查看 ${childName(4)} 子代理详情`, exact: true }), () => expect(panel().locator('h3')).toHaveText(childName(4)), receipts)
        const transcriptToggle = panel().getByRole('button', { name: '完整对话', exact: true })
        await measure(id, 'open-live-child-transcript', transcriptToggle, async () => {
          await expect(transcriptToggle).toHaveAttribute('aria-pressed', 'true')
          await expect(panel().locator('.work-subagent-transcript__scroll')).toHaveAttribute('aria-busy', 'false')
          await expect(panel().locator('[data-transcript-id]')).not.toHaveCount(0)
        }, receipts)
        const transcript = panel().getByRole('region', { name: `${childName(4)} 的完整对话`, exact: true })
        // An unchanged archive revision may legitimately reuse the resident
        // page. Admit an explicit new row before each measured refresh so that
        // a fast implementation still has real new data to fetch and render.
        const readIndex = archiveReads.length
        const appended = appendArchive(runningChild.childSessionId, `EXPLICIT_REFRESH_${size.width}_${size.height}`)
        const minimumAppendWatermark = appended.watermark
        archiveRefreshes.push({ childSessionId: runningChild.childSessionId, viewport: size, ...appended, tick: value(id).ticks, readIndex })
        await measure(id, 'refresh-appending-child-transcript', transcript.getByRole('button', { name: '更新子代理完整对话', exact: true }), async () => {
          await expect(transcript.locator('.work-subagent-transcript__scroll')).toHaveAttribute('aria-busy', 'false')
          // Crossing a 50-row page boundary can legitimately evict the old
          // tail. Freshness is a nondecreasing visible append watermark.
          await expect.poll(() => transcript.locator('[data-transcript-id^="append-"]').evaluateAll(elements => Math.max(0, ...elements.map(element => Number((element as HTMLElement).dataset.transcriptId!.slice('append-'.length)))))).toBeGreaterThanOrEqual(minimumAppendWatermark)
          await expect.poll(() => archiveReads.slice(readIndex).filter(read => read.childSessionId === runningChild.childSessionId && read.pageSize === 50 && read.total >= appended.total).length).toBeGreaterThanOrEqual(1)
          await expect(transcript.getByRole('alert')).toHaveCount(0)
        }, receipts)
        await page.screenshot({ path: testInfo.outputPath(`streaming-child-${size.width}.png`), animations: 'disabled' })
      }
      // Use the wide view for the composer's public draft input. Changing this
      // independently of the preview catches memoized closures over old drafts.
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
      await openWorkspace(); await tab(id, '成果', receipts)
      const input = work().getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill('LATEST_USER_DRAFT：保留刚输入的补充要求')
      publishArtifact(id, 2)
      await expect(workspace().locator('.work-artifact-preview')).toContainText('LATEST_ARTIFACT_CONTENT_2')
      const sentBefore = requests.length
      await measure(id, 'add-latest-artifact-reference', workspace().getByRole('button', { name: '添加到对话', exact: true }), async () => {
        await expect(input).toContainText('LATEST_USER_DRAFT')
        const chip = input.locator('.mention-chip--file')
        await expect(chip).toHaveText('report.md')
        await expect(chip).toHaveAttribute('title', '文件：' + workspaceRoot + '/report.md')
        await expect(input).not.toContainText('streaming-report-receipt')
        await expect(input).not.toContainText('STREAM_ARTIFACT_VERSION_2')
      }, receipts)
      expect(requests.length, 'Adding a reference must not send a second model request').toBe(sentBefore)
      const expectedDraft = `LATEST_USER_DRAFT：保留刚输入的补充要求\n\n针对成果 @${workspaceRoot}/report.md：\n`
      await expect.poll(() => page.evaluate(id => {
        for (const key of Object.keys(localStorage).filter(key => key.startsWith('aether.work.state.v1'))) {
          const state = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks?: Array<{ id: string; draft: string; mentions?: Array<{ source: string; path?: string; displayText: string; textOffset?: number; content?: string }> }> }
          const task = state.tasks?.find(task => task.id === id)
          if (task) return { draft: task.draft, mentions: task.mentions ?? [] }
        }
        return null
      }, id)).toEqual({ draft: expectedDraft, mentions: [{ source: 'file', path: workspaceRoot + '/report.md', displayText: 'report.md', textOffset: expectedDraft.indexOf('@') }] })
      await tab(id, '子代理', receipts)
      const previousChildCancels = childCancellations.length
      await measure(id, 'cancel-only-live-child', panel().getByRole('button', { name: '停止本轮', exact: true }), async () => {
        await expect.poll(() => childCancellations.slice(previousChildCancels)).toEqual([runningChild.runId])
        await expect(panel().locator('.work-subagents__heading [role="status"]')).toHaveText('已取消')
      }, receipts)
      expect(value(id).run.status, 'Child stop does not stop its root').toBe('running')
      await expect(work().getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
      await expect.poll(() => value(id).ticks).toBeGreaterThanOrEqual(80)
      const marker = `STREAM_FINAL_ROOT_${value(id).seq}`
      emit(id, { content: `\n\n${marker}` })
      await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(marker)
      const beforeRootCancels = cancellations.length
      await measure(id, 'cancel-only-selected-root', work().getByRole('button', { name: '停止任务', exact: true }), async () => {
        await expect.poll(() => cancellations.slice(beforeRootCancels)).toEqual([id])
        await expect(work().locator('.work-task-heading')).toContainText('已停止')
        await expect(work().locator('[data-current-run-feedback="true"]')).toHaveCount(0)
      }, receipts)
      await expect(input).toContainText('LATEST_USER_DRAFT')
      await expect(input.locator('.mention-chip--file')).toHaveText('report.md')
      await expect(input.locator('.mention-chip--file')).toHaveAttribute('title', '文件：' + workspaceRoot + '/report.md')
      await expect(input).not.toContainText('streaming-report-receipt')
      expect([...children.values()].filter(run => run.parentSessionId === id).map(run => run.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'cancelled'])
      expect(archiveReads.filter(read => read.childSessionId === runningChild.childSessionId && read.pageSize === 50).length).toBeGreaterThanOrEqual(4)
      expect(archives.get(runningChild.childSessionId)!.length).toBeGreaterThan(61)
      expect(receipts.some(receipt => receipt.tickAfter > receipt.tickBefore), 'At least one measured click overlaps admitted live SSE').toBe(true)
      expect(value(id).frames).toBeGreaterThan(200)
    } finally {
      if (value(id).run.status === 'running') finish(id, 'cancelled')
      await report(testInfo, id, receipts)
    }
  })

  test('持续协作流自然完成后清除运行状态并保留最终内容与成果', async ({}, testInfo) => {
    const id = await startTask('STREAMING_TERMINAL_REGRESSION：验证正常完成'), receipts: Receipt[] = []
    await installProbe()
    try {
      emit(id, { content: '\n\nSTREAM_TERMINAL_SUCCESS：最终协作结论已写入。' })
      finish(id, 'succeeded')
      await expect(work().locator('.work-task-heading')).toContainText('已完成')
      await expect(work().locator('[data-current-run-feedback="true"]')).toHaveCount(0)
      await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
      await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText('STREAM_TERMINAL_SUCCESS')
      await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
      await openWorkspace(); await tab(id, '成果', receipts)
      await expect(workspace().locator('.work-artifact-preview')).toContainText('STREAM_ARTIFACT_VERSION_1')
      expect([...children.values()].filter(run => run.parentSessionId === id).every(run => run.status === 'succeeded')).toBe(true)
      expect(cancellations).not.toContain(id)
    } finally {
      if (value(id).run.status === 'running') finish(id, 'cancelled')
      await report(testInfo, id, receipts)
    }
  })
})
