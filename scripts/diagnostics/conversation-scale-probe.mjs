/** Conversation scale probe: isolated SQLite + loopback HTTP storage fixture.
 * This measures renderer/IPC/HTTP-fixture costs, NOT real engine/model costs.
 * node scripts/diagnostics/conversation-scale-probe.mjs --prepare-only
 * node scripts/diagnostics/conversation-scale-probe.mjs --app-entry out/main/index.js
 * Optional: --sample <export.json> --source-db <agent.db> --sessions 1000
 * --turns 1000 --scenario sessions|turns|both --output <directory-under-.e2e-tmp/conversation-scale>
 * --snapshot-mode full|tail (full isolates rendering; tail exercises display hydration)
 * --verify-fixture-only validates both HTTP datasets without starting Electron.
 * --cpu-profile records the long transcript cold load from window attachment onward.
 * No production configuration, account rows, tokens or workspace files are copied.
 * Every Electron process is awaited and closed before the next one starts.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = path.join(repo, '.e2e-tmp/conversation-scale')
const model = 'conversation-scale-fixture', workspace = '/isolated/conversation-scale'
const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
  args.set(key.slice(2), process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i])
}
const count = (key, fallback) => {
  const value = Number(args.get(key) ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error(`${key} must be 1..10000`)
  return value
}
const inside = target => {
  const absolute = path.resolve(target), relative = path.relative(base, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be a child of .e2e-tmp/conversation-scale')
  return absolute
}
const json = (file, value) => fs.writeFileSync(inside(file), JSON.stringify(value, null, 2))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const parse = text => { try { return JSON.parse(text) } catch { return null } }
const quantile = (values, percentile) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)] : null
const summary = values => ({ count: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95), maxMs: values.length ? Math.max(...values) : null })

// Redact the entire prose, not only known secret patterns. Keep whitespace,
// punctuation, Markdown structure and Latin/CJK character widths/byte counts.
function redact(text) {
  return String(text).replace(/\p{Script=Han}/gu, '文').replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x')
    .replace(/[0-9]/g, '0').replace(/[\p{L}\p{N}]/gu, character => /[Xx文0]/.test(character) ? character : 'x')
}
function redactValue(value) {
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number') return 0
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    /^(path|file|filePath|content|command|cwd|query|limit|offset|pattern|url|encoding|recursive|timeout|description|code|input|output|name|type|mode|args|parameters)$/.test(key) ? key : redact(key), redactValue(item)]))
  return value
}
function textContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => typeof part?.text === 'string' ? part.text : '[non-text attachment omitted]').join('\n')
  return ''
}
function safeToolName(name) { return typeof name === 'string' && /^[a-z][a-z0-9_:.\/-]{0,100}$/i.test(name) ? name : 'fixture_tool' }

function normalizeSample(rawRows, source) {
  const turns = [], sourceBytes = { content: 0, reasoning: 0, toolArgs: 0 }
  let turn
  for (const raw of rawRows) {
    if (!['user', 'assistant', 'tool'].includes(raw.role)) continue
    if (raw.role === 'user') { turn = []; turns.push(turn) }
    if (!turn) continue
    const content = textContent(raw.content), reasoning = textContent(raw.reasoningContent)
    sourceBytes.content += Buffer.byteLength(content); sourceBytes.reasoning += Buffer.byteLength(reasoning)
    const row = { role: raw.role, content: redact(content) }
    if (reasoning) row.reasoningContent = redact(reasoning)
    if (raw.toolCall) {
      sourceBytes.toolArgs += Buffer.byteLength(JSON.stringify(raw.toolCall.args ?? {}))
      row.toolCall = { id: String(raw.toolCall.id), name: safeToolName(raw.toolCall.name), args: redactValue(raw.toolCall.args ?? {}) }
    }
    if (raw.toolCallId) row.toolCallId = String(raw.toolCallId)
    if (raw.toolName) row.toolName = safeToolName(raw.toolName)
    if (raw.role === 'tool') row.success = (raw.success ?? raw.metadata?.success) !== false
    turn.push(row)
  }
  const completed = turns.filter(rows => rows.some(row => row.role === 'assistant' && row.content && !row.toolCall))
  if (!completed.length) throw new Error('The selected sample has no complete user/assistant turn')
  // Replace identities before writing the export; only link relationships survive.
  for (const [index, rows] of completed.entries()) {
    const ids = new Map(), mapped = value => { if (!ids.has(value)) ids.set(value, `tool-${index}-${ids.size}`); return ids.get(value) }
    for (const row of rows) {
      if (row.toolCall) row.toolCall.id = mapped(row.toolCall.id)
      if (row.toolCallId) row.toolCallId = mapped(row.toolCallId)
    }
  }
  return { schemaVersion: 1, provenance: { ...source, sourceBytes, exportedAt: new Date().toISOString(),
    redaction: 'All prose letters/digits masked; whitespace/Markdown punctuation preserved; account/config/attachments/metadata excluded.',
    limitations: 'Attachment bytes and metadata-specific cards are excluded; this is a real text/tool shape sample, not an exact visual replay.' }, turns: completed }
}

function exportSample(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false })
  let rows, source
  try {
    database.exec('PRAGMA query_only=ON; BEGIN')
    const columns = new Set(database.prepare('PRAGMA table_info(conversations)').all().map(column => column.name))
    if (!columns.has('session_id')) throw new Error('Unsupported conversation database schema')
    const candidates = database.prepare(`SELECT tenant_id,session_id,COUNT(*) rows,SUM(role='user') users,
      SUM(role='assistant') assistants,SUM(length(content)) characters FROM conversations GROUP BY tenant_id,session_id
      HAVING users BETWEEN 1 AND 25 AND assistants>0 AND characters BETWEEN 10000 AND 500000 ORDER BY abs(characters-80000) LIMIT 1`).all()
    if (candidates.length) {
      const candidate = candidates[0]
      const fields = ['role', 'content', 'tool_call_id', 'tool_call_name', 'tool_name', 'tool_args', 'reasoning_content'].filter(name => columns.has(name))
      rows = database.prepare(`SELECT ${fields.join(',')} FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id`).all(candidate.tenant_id, candidate.session_id).map(row => ({
        role: row.role, content: row.content, reasoningContent: row.reasoning_content,
        ...(row.tool_call_name ? { toolCall: { id: row.tool_call_id, name: row.tool_call_name, args: parse(row.tool_args) ?? {} } } : {}),
        ...(row.role === 'tool' ? { toolCallId: row.tool_call_id, toolName: row.tool_name } : {}) }))
      source = { backend: 'sqlite', sourceSessionDigest: hash(`${candidate.tenant_id}:${candidate.session_id}`), sourceRows: rows.length }
    }
  } finally { database.exec('ROLLBACK'); database.close() }
  if (!rows) {
    const sessionsRoot = path.join(path.dirname(dbPath), 'sessions')
    const candidates = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).flatMap(tenant => {
      const directory = path.join(sessionsRoot, tenant.name)
      return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('subagent-'))
        .map(entry => { const file = path.join(directory, entry.name); return { file, bytes: fs.statSync(file).size } })
    }).filter(item => item.bytes >= 10000 && item.bytes <= 500000).sort((a, b) => Math.abs(a.bytes - 100000) - Math.abs(b.bytes - 100000))
    for (const candidate of candidates) {
      const before = fs.statSync(candidate.file), bytes = fs.readFileSync(candidate.file), after = fs.statSync(candidate.file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue
      const entries = bytes.toString('utf8').trim().split(/\r?\n/).map(parse)
      // Refuse mutation/summary/blob histories rather than approximating deletion
      // semantics or loading production engine code that may migrate/write storage.
      if (!entries.length || entries.some(entry => !entry || !['user', 'assistant', 'tool'].includes(entry.type) || !entry.payload || entry.isSidechain)) continue
      if (entries.filter(entry => entry.type === 'user').length > 25) continue
      rows = entries.map(entry => entry.payload)
      if (rows.some(row => typeof row.content !== 'string' && !Array.isArray(row.content))) continue
      const groups = []
      for (const row of rows) { if (row.role === 'user') groups.push([]); groups.at(-1)?.push(row) }
      if (!groups.length || groups.some(group => !group.some(row => row.role === 'assistant' && textContent(row.content) && !row.toolCall))) { rows = undefined; continue }
      source = { backend: 'jsonl', sourceSessionDigest: hash(candidate.file), sourceArchiveSha256: hash(bytes), sourceArchiveBytes: bytes.length, sourceRows: rows.length }
      break
    }
  }
  if (!rows) throw new Error('No safe representative history found; provide --sample with a reviewed export')
  return normalizeSample(rows, source)
}

function materializeTurn(sampleTurn, sessionId, index) {
  const turnId = `${sessionId}-turn-${index}`, runId = `${sessionId}-run-${index}`, now = 1800000000000 + index * 1000
  const tools = new Map(), toolId = original => { if (!tools.has(original)) tools.set(original, `${turnId}-tool-${tools.size}`); return tools.get(original) }
  const rows = sampleTurn.map((row, ordinal) => ({ ...structuredClone(row), id: `${turnId}-message-${ordinal}`, createdAt: now + ordinal,
    conversationId: turnId, modelId: model, metadata: { rootRunId: runId, turnId },
    ...(row.toolCall ? { toolCall: { ...structuredClone(row.toolCall), id: toolId(row.toolCall.id) } } : {}),
    ...(row.toolCallId ? { toolCallId: toolId(row.toolCallId) } : {}) }))
  const answer = rows.findLast(row => row.role === 'assistant' && row.content && !row.toolCall)
  if (!answer) throw new Error('Sample turn has no answer')
  const run = { schemaVersion: 1, runId, sessionId, turnId, userMessageId: rows[0].id, assistantMessageId: answer.id,
    seq: index + 1, version: 1, status: 'succeeded', modelId: model, pending: [], workspacePaths: [workspace],
    createdAt: now, updatedAt: now + rows.length, startedAt: now, finishedAt: now + rows.length }
  answer.metadata.finalResult = { schemaVersion: 1, sessionId, turnId, runId, assistantMessageId: answer.id,
    text: answer.content, publishedAt: run.finishedAt, items: [] }
  return { rows, run }
}

function prepareDatabase(file, sample, sessionCount, turnCount) {
  if (fs.existsSync(file)) throw new Error('Refusing to overwrite an existing scale fixture')
  const database = new DatabaseSync(inside(file))
  try {
    database.exec(`PRAGMA journal_mode=DELETE; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,scenario TEXT,turn_count INTEGER,row_count INTEGER,updated_at INTEGER);
      CREATE TABLE turns(session_id TEXT,ordinal INTEGER,user_id TEXT,conversation_id TEXT,preview TEXT,created_at INTEGER,run TEXT,PRIMARY KEY(session_id,ordinal));
      CREATE TABLE messages(session_id TEXT,ordinal INTEGER,turn_index INTEGER,body TEXT,PRIMARY KEY(session_id,ordinal));
      CREATE INDEX messages_turn ON messages(session_id,turn_index); BEGIN`)
    const insertSession = database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
    const insertTurn = database.prepare('INSERT INTO turns VALUES(?,?,?,?,?,?,?)')
    const insertMessage = database.prepare('INSERT INTO messages VALUES(?,?,?,?)')
    const seed = (id, title, scenario, count, serial) => {
      let ordinal = 0
      for (let index = 0; index < count; index++) {
        const { rows, run } = materializeTurn(sample.turns[index % sample.turns.length], id, index)
        insertTurn.run(id, index, rows[0].id, run.turnId, rows[0].content.slice(0, 240), run.createdAt, JSON.stringify(run))
        for (const row of rows) insertMessage.run(id, ordinal++, index, JSON.stringify(row))
      }
      insertSession.run(id, title, scenario, count, ordinal, 1800000000000 - serial * 1000)
    }
    // Session state deliberately rejects arbitrary IDs; match real Work admissions.
    for (let index = 0; index < sessionCount; index++) seed(`work-scale-session-${index}`, `规模会话 ${String(index + 1).padStart(4, '0')}`, 'sessions', sample.turns.length, index)
    seed('work-scale-long', '千轮会话', 'turns', turnCount, 0)
    database.exec('COMMIT')
    return { sessions: sessionCount, sampleTurnsPerSession: sample.turns.length, longConversationTurns: turnCount,
      storedRows: database.prepare('SELECT COUNT(*) count FROM messages').get().count, databaseBytes: fs.statSync(file).size }
  } finally { database.close() }
}

function fixtureServer(file, scenario, snapshotMode) {
  const database = new DatabaseSync(file, { readOnly: true }), token = crypto.randomUUID(), requests = [], violations = []
  database.exec('PRAGMA query_only=ON')
  const sessions = database.prepare('SELECT * FROM sessions WHERE scenario=? ORDER BY updated_at DESC').all(scenario)
  const own = new Set(sessions.map(session => session.id))
  const turnsQuery = database.prepare('SELECT * FROM turns WHERE session_id=? ORDER BY ordinal')
  const rowsQuery = database.prepare('SELECT body FROM messages WHERE session_id=? ORDER BY ordinal')
  const selectedQuery = database.prepare('SELECT body FROM messages WHERE session_id=? AND turn_index>=? AND turn_index<? ORDER BY ordinal')
  const server = createServer((request, response) => {
    const started = performance.now(), url = new URL(request.url ?? '/', 'http://127.0.0.1'), endpoint = url.pathname
    const id = url.searchParams.get('sessionId') ?? '', authorized = own.has(id), turns = authorized ? turnsQuery.all(id) : []
    const runs = turns.map(turn => JSON.parse(turn.run)), current = runs.at(-1) ?? null
    response.setHeader('content-type', 'application/json')
    const send = (data, code = 200, http = 200) => {
      const body = JSON.stringify({ code, message: code === 200 ? 'ok' : 'Fixture rejected request', data })
      requests.push({ endpoint, method: request.method, durationMs: performance.now() - started, bytes: Buffer.byteLength(body), sessionId: id })
      response.writeHead(http).end(body)
    }
    if (endpoint.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { violations.push('Authentication failed'); send(null, 401, 401); return }
    if (endpoint === '/api/v1/workspace/bind') { request.resume(); send({ workspaceRoot: workspace }); return }
    // The app registers optional clients with POST. Decline capability discovery
    // before mutation guards, just as the existing isolated UI fixtures do.
    if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(endpoint)) { request.resume(); send(null, 404, 404); return }
    if (request.method !== 'GET') { violations.push(`${request.method} ${endpoint}`); request.resume(); send(null, 405, 405); return }
    if (endpoint === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    if (endpoint === '/api/v1/conversation/display') {
      const limit = Number(url.searchParams.get('limit') ?? 2), anchor = url.searchParams.get('anchorMessageId')
      const start = anchor ? turns.findIndex(turn => turn.user_id === anchor) : Math.max(0, turns.length - limit)
      if (start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) { send(null, 40400, 404); return }
      const selected = turns.slice(start, start + limit)
      send({ schemaVersion: 1, grouping: 'root', turns: turns.map(turn => ({ userMessageId: turn.user_id, conversationId: turn.conversation_id, preview: turn.preview, createdAt: turn.created_at })),
        messages: authorized ? selectedQuery.all(id, start, start + limit).map(row => JSON.parse(row.body)) : [], loadedTurnIds: selected.map(turn => turn.user_id),
        revision: `${id}-fixed`, mutationRevision: 'fixed', backend: 'sqlite', completeness: 'complete' }); return
    }
    const history = () => !authorized ? [] : (snapshotMode === 'tail' ? selectedQuery.all(id, Math.max(0, turns.length - 2), turns.length) : rowsQuery.all(id)).map(row => JSON.parse(row.body))
    const data = endpoint === '/health' ? { status: 'ok' }
      : endpoint === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'scale-fixture' }
      : endpoint === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '隔离压测模型（不可调用）', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 256000 } }]
      : endpoint === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: history(), projection: [], run: current, runs, subagentRuns: [], todos: [], changes: [], commandJobs: [] }
      : endpoint === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
      : endpoint === '/api/v1/chat/runs' ? { runs }
      : endpoint === '/api/v1/conversation/history' ? history()
      : endpoint === '/api/v1/conversation/sessions' ? sessions.map(session => ({ sessionId: session.id, title: session.title, lastAt: session.updated_at, messageCount: session.row_count }))
      : endpoint === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'scale-fixture', sessionId: id, namespace: { id: 'scale-fixture-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
      : endpoint === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: 'one', entries: [] }
      : endpoint === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : endpoint === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
      : endpoint === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
      : /\/sessions\/[^/]+\/binding$/.test(endpoint) ? { started: true, agentId: null, metadata: null, agent: null }
      : endpoint === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
      : endpoint === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
      : endpoint === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
      : endpoint === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
      : endpoint === '/api/v1/command-jobs' ? { jobs: [] }
      : endpoint === '/api/v1/toolkits' || /\/toolkits$/.test(endpoint) ? { toolkits: [] }
      : endpoint === '/api/v1/settings' ? {} : []
    send(data)
  })
  return { server, token, sessions, requests, violations, close: async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); database.close() } }
}

async function startSampling(page, target = '.work-conversation__scroll') {
  await page.evaluate(target => {
    window.__conversationScale?.stop()
    const frames = [], tasks = [], geometry = [], supported = PerformanceObserver.supportedEntryTypes.includes('longtask')
    const observer = supported ? new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration) }) : null
    observer?.observe({ type: 'longtask' })
    let frame, previous, count = 0
    const tick = now => {
      if (previous !== undefined) frames.push(now - previous)
      previous = now
      const element = document.querySelector(target)
      if (element && count++ % 3 === 0) geometry.push({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    window.__conversationScale = { stop() { cancelAnimationFrame(frame); if (observer) { for (const entry of observer.takeRecords()) tasks.push(entry.duration); observer.disconnect() } return { frames, tasks, supported, geometry } } }
  }, target)
}
async function stopSampling(page) {
  const result = await page.evaluate(() => window.__conversationScale.stop())
  const heights = result.geometry.map(value => value.height), viewports = result.geometry.map(value => value.viewport)
  const heightRange = heights.length ? [Math.min(...heights), Math.max(...heights)] : null
  const viewportRange = viewports.length ? [Math.min(...viewports), Math.max(...viewports)] : null
  return { rafIntervals: summary(result.frames), longTasks: result.supported ? { ...summary(result.tasks), totalMs: result.tasks.reduce((sum, value) => sum + value, 0) } : null,
    geometrySummary: { samples: result.geometry.length, heightRange, viewportRange,
      stableHeight: heightRange ? heightRange[1] - heightRange[0] <= 2 : null,
      stableViewport: viewportRange ? viewportRange[1] - viewportRange[0] <= 1 : null },
    geometry: result.geometry, note: 'rAF intervals are renderer scheduling gaps; they are not FPS, presented frames or INP.' }
}
async function settle(page, milliseconds = 180) {
  await page.evaluate(ms => new Promise(resolve => { const start = performance.now(); const next = now => now - start >= ms ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next) }), milliseconds)
}
async function memory(app, page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Performance.enable')
    const { metrics } = await cdp.send('Performance.getMetrics'), dom = await cdp.send('Memory.getDOMCounters')
    // CDP counts can retain detached documents until GC. Count the current
    // document separately, outside the timing sample, without forcing GC.
    const connected = await page.evaluate(() => {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
      let nodes = 1
      while (walker.nextNode()) nodes++
      const scroll = document.querySelector('.work-conversation__scroll')
      return { lightDomNodes: nodes, elements: document.getElementsByTagName('*').length,
        mountedConversationMessages: document.querySelectorAll('.work-conversation__content .work-message').length,
        mountedConversationTurns: document.querySelectorAll('.work-conversation__content > .work-conversation-turn').length,
        mountedSidebarTasks: document.querySelectorAll('.work-sidebar__task-row').length,
        historyPreparing: Boolean(document.querySelector('.work-conversation[data-history-preparing="true"]')),
        conversationBusy: scroll?.getAttribute('aria-busy') === 'true',
        conversationVisibility: scroll ? getComputedStyle(scroll).visibility : null }
    })
    const processMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, memory: item.memory })))
    return { jsHeapUsedBytes: metrics.find(item => item.name === 'JSHeapUsedSize')?.value ?? null,
      jsHeapTotalBytes: metrics.find(item => item.name === 'JSHeapTotalSize')?.value ?? null, dom,
      domNote: 'CDP DOM counters include detached nodes/documents awaiting GC. connected counts only the current document light DOM, including its hidden mounted nodes; shadow trees are excluded.',
      connected,
      processes: processMetrics, processMemoryUnit: 'Electron workingSetSize/privateBytes/peakWorkingSetSize are KiB; no forced GC.' }
  } finally { await cdp.detach() }
}

async function scrollGeometry(locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect(), maximum = Math.max(0, element.scrollHeight - element.clientHeight)
    const style = getComputedStyle(element), left = parseFloat(style.borderLeftWidth) || 0, right = parseFloat(style.borderRightWidth) || 0
    return { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight,
      ratio: maximum ? element.scrollTop / maximum : 0, maximum,
      trackTop: rect.top + element.clientTop, trackHeight: element.clientHeight,
      gutter: element.offsetWidth - element.clientWidth - left - right,
      right: rect.right - right }
  })
}

/** Native dragging must not use scrollTop writes: that would miss the browser's
 * pointer-to-thumb mapping when the content height changes under the pointer. */
async function dragNativeThumb(page, locator, targets) {
  const drags = []
  for (const targetRatio of targets) {
    const before = await scrollGeometry(locator)
    if (before.gutter <= 0 || before.maximum <= 0) return { supported: false, reason: before.gutter <= 0 ? 'No visible native scrollbar gutter' : 'No vertical overflow', drags }
    // Chromium's minimum thumb is larger than proportional height in a 1000-turn
    // transcript. Click near its centre; endpoints are clamped by the browser.
    const thumb = Math.max(20, before.trackHeight * before.viewport / before.height)
    const x = before.right - before.gutter / 2
    const from = before.trackTop + before.ratio * (before.trackHeight - thumb) + thumb / 2
    // Proportional estimates are insufficient at either end: a few pixels of
    // minimum-thumb error can leave thousands of transcript pixels unread.
    const to = targetRatio === 0 ? before.trackTop - 20
      : targetRatio === 1 ? before.trackTop + before.trackHeight + 20
      : before.trackTop + targetRatio * (before.trackHeight - thumb) + thumb / 2
    const eventProbe = await locator.evaluateHandle(element => {
      const events = [], types = ['pointerdown', 'pointercancel', 'pointerup', 'mousedown', 'mousemove', 'mouseup']
      const record = event => {
        if (events.length < 160) events.push({ type: event.type, at: performance.now(), x: event.clientX, y: event.clientY,
          button: event.button, targetIsScroll: event.target === element })
      }
      for (const type of types) window.addEventListener(type, record, { capture: true, passive: true })
      return { finish() { for (const type of types) window.removeEventListener(type, record, { capture: true }); return events } }
    })
    let held, heldLater, released, pointerEvents
    try {
      await page.mouse.move(x, from); await page.mouse.down()
      try {
        await page.mouse.move(x, to, { steps: 24 }); await settle(page, 160)
        held = await scrollGeometry(locator); await settle(page, 160); heldLater = await scrollGeometry(locator)
      } finally { await page.mouse.up() }
      await settle(page, 180)
      released = await scrollGeometry(locator)
    } finally { pointerEvents = await eventProbe.evaluate(probe => probe.finish()); await eventProbe.dispose() }
    const endpointDistancePx = targetRatio === 0 ? Math.abs(released.top)
      : targetRatio === 1 ? Math.abs(released.maximum - released.top) : null
    drags.push({ targetRatio, before, held, heldLater, released, pointerEvents, endpointDistancePx,
      reachedRequestedRange: endpointDistancePx === null ? Math.abs(released.ratio - targetRatio) <= .03 : endpointDistancePx <= 2,
      targetTolerance: endpointDistancePx === null ? 'absolute ratio error <= 0.03' : 'absolute distance to actual endpoint <= 2 CSS pixels',
      holdingDriftPx: Math.abs(heldLater.top - held.top), releaseDriftPx: Math.abs(released.top - heldLater.top),
      stableHeight: Math.max(before.height, held.height, heldLater.height, released.height) - Math.min(before.height, held.height, heldLater.height, released.height) <= 2,
      stableViewport: Math.max(before.viewport, held.viewport, heldLater.viewport, released.viewport) - Math.min(before.viewport, held.viewport, heldLater.viewport, released.viewport) <= 1 })
  }
  return { supported: true, drags, allTargetsReached: drags.every(drag => drag.reachedRequestedRange),
    stable: drags.every(drag => drag.stableHeight && drag.stableViewport && drag.holdingDriftPx <= 4 && drag.releaseDriftPx <= 4) }
}

async function runScenario(electron, databaseFile, scenario, output, appEntry, snapshotMode) {
  const fixture = fixtureServer(databaseFile, scenario, snapshotMode), directory = inside(path.join(output, scenario)), errors = []
  fs.mkdirSync(directory, { recursive: true })
  const profile = inside(path.join(directory, 'profile')); fs.mkdirSync(profile)
  await new Promise((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${fixture.server.address().port}`, storageKey = `aether.work.state.v1:${encodeURIComponent(`remote:${origin}`)}`
  json(path.join(profile, 'settings.json'), { engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace,
    autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' })
  json(path.join(profile, 'window-state.json'), { width: 1440, height: 1000 })
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^AETHER_IDE_REMOTE_|^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|DATA_DIR|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/i.test(key)) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = fixture.token; env.AETHER_GLOBAL_DIR = path.join(profile, 'global')
  const launch = () => electron.launch({ args: [appEntry, `--user-data-dir=${profile}`], cwd: repo, env, timeout: 60000 })
  const tasks = fixture.sessions.map(session => ({ id: session.id, title: session.title, status: 'done', draft: '', mentions: [],
    createdAt: session.updated_at, updatedAt: session.updated_at, workspacePath: workspace, modelId: model, attachments: [], sources: [] }))
  if (tasks.some(task => !task.id.startsWith('work-'))) throw new Error('Fixture IDs do not satisfy Work task persistence')
  const result = { scenario, sessionCount: tasks.length, targetTurns: fixture.sessions[0].turn_count, snapshotMode,
    phases: [], progress: [], readiness: [], validationFailures: [], errors }
  const scenarioStarted = performance.now()
  let currentStage = 'starting', stageStarted = scenarioStarted
  const progress = stage => {
    currentStage = stage; stageStarted = performance.now()
    const event = { stage, elapsedMs: stageStarted - scenarioStarted, at: new Date().toISOString() }
    result.progress.push(event); console.log(JSON.stringify({ scenario, progress: event }))
    json(path.join(directory, 'result.json'), result)
  }
  const heartbeat = setInterval(() => {
    console.log(JSON.stringify({ scenario, waitingFor: currentStage, stageElapsedMs: Math.round(performance.now() - stageStarted),
      httpRequests: fixture.requests.length, lastEndpoint: fixture.requests.at(-1)?.endpoint ?? null }))
  }, 10000)
  let app, page, cpuSession
  const stopCpuProfile = async () => {
    if (!cpuSession) return
    const session = cpuSession; cpuSession = undefined
    try {
      const { profile } = await session.send('Profiler.stop')
      const file = inside(path.join(directory, 'cold-load.cpuprofile'))
      json(file, profile)
      result.cpuProfile = { ...result.cpuProfile, file, samples: profile.samples?.length ?? 0,
        profileDurationMs: (profile.endTime - profile.startTime) / 1000 }
    } catch (error) { result.cpuProfile = { ...result.cpuProfile, error: String(error) } }
    finally { await session.detach().catch(() => {}) }
  }
  const installGuards = async window => {
    window.on('pageerror', error => errors.push(error.message)); window.on('crash', () => errors.push('Renderer crashed'))
    await window.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith('file:') || url.startsWith(origin + '/') || /^(data:|blob:|devtools:|aether:)/.test(url)) return route.continue()
      errors.push('Blocked external renderer request'); return route.abort()
    })
  }
  const ready = async target => {
    await page.locator('.work-task-heading h1').filter({ hasText: target.title }).waitFor({ timeout: 180000 })
    await page.waitForFunction(expected => {
      const conversation = document.querySelector('.work-conversation'), scroll = conversation?.querySelector('.work-conversation__scroll')
      const content = scroll?.querySelector('.work-conversation__content')
      // The last preparation batch has all nodes but remains hidden while real
      // layout/position restoration finishes. Node count alone is not readiness.
      if (!conversation || !scroll || !content || conversation.getAttribute('data-history-preparing') === 'true' ||
        scroll.getAttribute('aria-busy') === 'true' || conversation.querySelector('.work-conversation__preparing') ||
        conversation.querySelector('.work-loading') || getComputedStyle(scroll).visibility !== 'visible' || !scroll.getClientRects().length) return false
      return content.querySelectorAll(':scope > .work-conversation-turn').length === expected
    }, target.turn_count, { timeout: 180000 })
    const scroll = page.locator('.work-conversation__scroll')
    let previous = await scrollGeometry(scroll)
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const current = await scrollGeometry(scroll)
      if (Math.abs(current.height - previous.height) <= 2 && Math.abs(current.viewport - previous.viewport) <= 1 && Math.abs(current.top - previous.top) <= 4) {
        result.readiness.push({ sessionId: target.id, targetTurns: target.turn_count, signal: 'all turns mounted, preparation cleared, viewport visible, stable across two rAF callbacks', geometry: current })
        return
      }
      previous = current
    }
    throw new Error('Visible full history did not settle its geometry after preparation')
  }
  const measure = async (name, action, target = '.work-conversation__scroll') => {
    progress(name)
    await startSampling(page, target); const start = performance.now(); const details = await action()
    const elapsedMs = performance.now() - start
    // Keep a short post-ready observation window, but never include that
    // intentional wait in action-to-ready latency.
    await settle(page)
    const scheduling = await stopSampling(page)
    const phase = { name, target, elapsedMs, samplingDurationMs: performance.now() - start, ...scheduling,
      ...(details === undefined ? {} : { details }), memory: await memory(app, page) }
    result.phases.push(phase)
    // Keep later diagnostic phases available, but fail the final probe instead
    // of reporting a near-end ratio as a successfully visited real boundary.
    if (details?.supported === true && details.allTargetsReached === false) result.validationFailures.push(`${name}: native scrollbar did not reach its requested endpoint/range`)
    if (details?.supported === true && details.stable === false) result.validationFailures.push(`${name}: native scrollbar geometry or held/released position changed`)
    json(path.join(directory, `${String(result.phases.length).padStart(2, '0')}-${name}.json`), phase)
    json(path.join(directory, 'result.json'), result)
  }
  try {
    // Bootstrap only writes this isolated profile; close before measuring a fresh process.
    progress('bootstrap-launch')
    app = await launch(); page = await app.firstWindow(); await installGuards(page)
    progress('bootstrap-engine-ready')
    await page.locator('.status-bar').filter({ hasText: '引擎：就绪' }).waitFor({ timeout: 90000 })
    progress('bootstrap-seed')
    await page.evaluate(({ storageKey, tasks }) => {
      window.dispatchEvent(new Event('blur'))
      localStorage.setItem(storageKey, JSON.stringify({ tasks, activeTaskId: tasks[0].id, homeDraft: '', homeSources: [] }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
    }, { storageKey, tasks })
    // Let the normal state owner adopt the seeded profile before closing, so a
    // final blur/save cannot overwrite it with the bootstrap's empty task list.
    progress('bootstrap-reload')
    await page.reload()
    await page.locator('.work-sidebar__task-row').first().waitFor({ timeout: 30000 })
    result.seed = await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key) ?? '{}')
      return { taskCount: state.tasks?.length ?? 0, activeTaskId: state.activeTaskId ?? null, visibleSidebarRows: document.querySelectorAll('.work-sidebar__task-row').length }
    }, storageKey)
    if (result.seed.taskCount !== tasks.length || result.seed.activeTaskId !== tasks[0].id) throw new Error(`Fixture seed was not adopted: ${JSON.stringify(result.seed)}`)
    await page.locator('.work-task-heading h1').filter({ hasText: tasks[0].title }).waitFor({ timeout: 30000 })
    progress('bootstrap-close')
    await app.close(); app = undefined
    progress('cold-process-launch')
    const coldStart = performance.now(); app = await launch(); page = await app.firstWindow()
    if (scenario === 'turns' && args.has('cpu-profile')) {
      progress('cold-load-cpu-profiler-start')
      try {
        cpuSession = await page.context().newCDPSession(page)
        await cpuSession.send('Profiler.enable'); await cpuSession.send('Profiler.setSamplingInterval', { interval: 1000 }); await cpuSession.send('Profiler.start')
        result.cpuProfile = { samplingIntervalMicroseconds: 1000, startedAfterLaunchMs: performance.now() - coldStart,
          coverage: 'Renderer JavaScript from Playwright window attachment to complete history readiness; excludes early process startup and engine/native execution.' }
      } catch (error) { result.cpuProfile = { error: String(error) }; await cpuSession?.detach().catch(() => {}); cpuSession = undefined }
    }
    await installGuards(page)
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 1000); win.show(); win.focus() })
    await startSampling(page); const samplingStartMs = performance.now() - coldStart
    progress('cold-process-history-ready')
    await ready(fixture.sessions[0])
    const coldReadyMs = performance.now() - coldStart
    await settle(page)
    const coldScheduling = await stopSampling(page)
    await stopCpuProfile()
    result.phases.push({ name: 'cold-process-open', elapsedMs: coldReadyMs, samplingStartMs,
      note: 'OS file caches are not flushed. Scheduling collection starts when Playwright obtains the window.',
      ...coldScheduling, memory: await memory(app, page) })
    json(path.join(directory, '01-cold-process-open.json'), result.phases.at(-1))
    json(path.join(directory, 'result.json'), result)
    if (scenario === 'sessions') {
      const sidebar = page.locator('.work-sidebar__recent')
      await measure('project-sidebar-open-all', async () => {
        await page.locator('.work-sidebar').getByRole('tab', { name: '项目', exact: true }).click()
        await page.waitForFunction(expected => document.querySelectorAll('.work-sidebar__project-group .work-sidebar__task-row').length === expected, tasks.length)
        return { mountedRows: await sidebar.locator('.work-sidebar__task-row').count(), projectGroups: await sidebar.locator('.work-sidebar__project-group').count() }
      }, '.work-sidebar__recent')
      await measure('project-sidebar-wheel', async () => {
        const box = await sidebar.boundingBox()
        if (!box) throw new Error('Project sidebar has no bounds')
        await sidebar.hover({ position: { x: Math.min(30, box.width / 2), y: Math.min(70, box.height / 2) } })
        for (const direction of [1, -1]) for (let step = 0; step < 8; step++) { await page.mouse.wheel(0, direction * 650); await settle(page, 100) }
        return { mountedRows: await sidebar.locator('.work-sidebar__task-row').count() }
      }, '.work-sidebar__recent')
      await measure('project-sidebar-native-thumb', () => dragNativeThumb(page, sidebar, [1, .5, 0]), '.work-sidebar__recent')
      await page.locator('.work-sidebar').getByRole('tab', { name: '最近', exact: true }).click()
    }
    await measure('home-open', async () => {
      await page.locator('.work-breadcrumb').click()
      const search = page.getByRole('searchbox', { name: '搜索 Work 任务', exact: true })
      await search.waitFor()
    })
    await measure('home-search', async () => {
      await page.getByRole('searchbox', { name: '搜索 Work 任务', exact: true }).fill(tasks.at(-1).title)
      await page.locator(`.work-task-row[data-task-id="${tasks.at(-1).id}"]`).waitFor()
    })
    await measure('open-search-result', async () => {
      await page.locator(`.work-task-row[data-task-id="${tasks.at(-1).id}"]`).click(); await ready(fixture.sessions.at(-1))
    })
    for (let index = 0; index < Math.min(3, tasks.length > 1 ? tasks.length : 0); index++) {
      await measure(`switch-${index + 1}`, async () => {
        const row = page.locator(`.work-sidebar__task-row[data-task-id="${tasks[index].id}"] button`).first()
        await row.click(); await ready(fixture.sessions[index])
      })
    }
    await measure('conversation-scroll-wheel', async () => {
      const scroll = page.locator('.work-conversation__scroll')
      await scroll.hover({ position: { x: 20, y: 120 } })
      for (const direction of [-1, 1, -1, 1]) for (let step = 0; step < 6; step++) { await page.mouse.wheel(0, direction * 650); await settle(page, 100) }
    })
    if (scenario === 'turns') {
      const scroll = page.locator('.work-conversation__scroll')
      await measure('conversation-native-thumb-full-range', () => dragNativeThumb(page, scroll, [1, .5, 0, 1]))
      await measure('conversation-expand-final-process', async () => {
        const toggle = page.locator('.work-conversation__content > .work-conversation-turn').last().getByRole('button', { name: '展开过程', exact: true }).first()
        await toggle.click()
        await page.locator('.work-conversation__content > .work-conversation-turn').last().getByRole('button', { name: '收起过程', exact: true }).first().waitFor()
        await settle(page, 300)
        return { expanded: true, geometry: await scrollGeometry(scroll) }
      })
      await measure('conversation-expanded-native-thumb-full-range', () => dragNativeThumb(page, scroll, [1, .5, 0, 1]))
    }
    result.integrity = await page.evaluate(() => ({ mountedTurns: document.querySelectorAll('.work-conversation__content > .work-conversation-turn').length,
      mountedMessages: document.querySelectorAll('.work-conversation__content .work-message').length,
      pagingButtons: [...document.querySelectorAll('.work-conversation button')].filter(button => /查看更早消息|查看较新消息/.test(button.textContent ?? '')).length }))
    result.scrollChecks = result.phases.filter(phase => phase.name.includes('native-thumb')).map(phase => ({ phase: phase.name,
      supported: phase.details?.supported ?? false, allTargetsReached: phase.details?.allTargetsReached ?? false,
      stable: phase.details?.stable === true && phase.geometrySummary.stableHeight === true && phase.geometrySummary.stableViewport === true }))
    await page.screenshot({ path: inside(path.join(directory, 'final.png')) })
  } catch (error) {
    result.failure = String(error)
    progress('failed')
    if (page && !page.isClosed()) result.failureState = await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key) ?? '{}')
      return { taskCount: state.tasks?.length ?? 0, activeTaskId: state.activeTaskId ?? null,
        sidebarRows: document.querySelectorAll('.work-sidebar__task-row').length,
        mountedTurns: document.querySelectorAll('.work-conversation-turn').length,
        heading: document.querySelector('.work-task-heading h1')?.textContent ?? null }
    }, storageKey).catch(() => null)
    if (page && !page.isClosed()) await page.screenshot({ path: inside(path.join(directory, 'failure.png')), timeout: 5000 }).catch(() => {})
  } finally {
    await stopCpuProfile()
    clearInterval(heartbeat)
    if (app) await app.close().catch(error => errors.push(String(error)))
    result.http = { requests: fixture.requests.length, totalBytes: fixture.requests.reduce((sum, request) => sum + request.bytes, 0),
      handlerDuration: summary(fixture.requests.map(request => request.durationMs)), mutationsBlocked: fixture.violations }
    json(path.join(directory, 'http.json'), fixture.requests)
    await fixture.close(); json(path.join(directory, 'result.json'), result)
  }
  return result
}

async function verifyFixture(file) {
  const results = []
  for (const scenario of ['sessions', 'turns']) {
    const fixture = fixtureServer(file, scenario, 'full')
    try {
      await new Promise((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', resolve) })
      const origin = `http://127.0.0.1:${fixture.server.address().port}`, target = fixture.sessions[0]
      if (!target.id.startsWith('work-')) throw new Error('Fixture session ID would be dropped by Work state normalization')
      const read = async (endpoint, parameters) => {
        const response = await fetch(`${origin}/api/v1/${endpoint}?${new URLSearchParams(parameters)}`, { headers: { 'x-aether-instance-token': fixture.token } })
        if (!response.ok) throw new Error(`Fixture ${endpoint} failed`)
        return (await response.json()).data
      }
      const snapshot = await read('chat/snapshot', { sessionId: target.id })
      if (snapshot.history.length !== target.row_count || snapshot.runs.length !== target.turn_count) throw new Error('Snapshot size mismatch')
      const initial = await read('conversation/display', { sessionId: target.id, limit: '10' })
      if (initial.turns.length !== target.turn_count || initial.loadedTurnIds.length !== Math.min(10, target.turn_count)) throw new Error('Display index mismatch')
      const first = await read('conversation/display', { sessionId: target.id, limit: '10', anchorMessageId: initial.turns[0].userMessageId })
      if (first.messages[0]?.id !== initial.turns[0].userMessageId || new Set(snapshot.history.map(row => row.id)).size !== snapshot.history.length) throw new Error('Invalid identity or ordering')
      results.push({ scenario, sessions: fixture.sessions.length, turns: initial.turns.length, physicalRows: snapshot.history.length,
        responseBytes: fixture.requests.reduce((sum, request) => sum + request.bytes, 0), checked: ['snapshot size', 'turn index', 'first anchor', 'unique row identities'] })
    } finally { await fixture.close() }
  }
  return results
}

async function main() {
  fs.mkdirSync(base, { recursive: true })
  const sessionCount = count('sessions', 1000), turnCount = count('turns', 1000)
  const output = inside(args.get('output') ?? path.join(base, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  fs.mkdirSync(output, { recursive: true })
  const sampleFile = args.get('sample') ? path.resolve(String(args.get('sample'))) : path.join(base, 'sample.json')
  let sample
  if (fs.existsSync(sampleFile)) sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8'))
  else {
    if (args.has('sample')) throw new Error('Explicit sample file does not exist')
    const dbPath = path.resolve(String(args.get('source-db') ?? path.join(process.env.APPDATA ?? '', 'Aether Code/engine/state/agent.db')))
    sample = exportSample(dbPath); json(sampleFile, sample)
  }
  if (sample.schemaVersion !== 1 || !sample.turns?.length || !sample.provenance?.redaction) throw new Error('Expected a reviewed, redacted sample export')
  const file = path.join(output, 'fixture.sqlite'), prepared = prepareDatabase(file, sample, sessionCount, turnCount)
  const manifest = { generatedAt: new Date().toISOString(), scope: 'renderer + IPC + loopback HTTP + isolated SQLite storage fixture; not actual engine/model performance',
    source: sample.provenance, sampleSha256: hash(fs.readFileSync(sampleFile)), fixture: prepared, databaseFile: file, sampleFile,
    metricNotes: ['rAF intervals are scheduling proxies, not FPS/INP.', 'Cold means a fresh Electron process; OS disk caches remain warm.', 'No production writes, account/config copies or model calls.'],
    machine: { platform: process.platform, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() } }
  json(path.join(output, 'manifest.json'), manifest)
  console.log(JSON.stringify({ prepared: true, output, sampleRows: sample.turns.reduce((sum, turn) => sum + turn.length, 0), ...prepared }))
  if (args.has('verify-fixture-only')) {
    const verification = await verifyFixture(file)
    json(path.join(output, 'fixture-verification.json'), verification)
    console.log(JSON.stringify({ fixtureVerified: verification })); return
  }
  if (args.has('prepare-only')) return
  const snapshotMode = String(args.get('snapshot-mode') ?? 'full')
  if (!['full', 'tail'].includes(snapshotMode)) throw new Error('snapshot-mode must be full or tail')
  const requested = args.get('scenario') ?? 'both', scenarios = requested === 'both' ? ['sessions', 'turns'] : [requested]
  if (scenarios.some(value => !['sessions', 'turns'].includes(value))) throw new Error('scenario must be sessions, turns or both')
  const appEntry = path.resolve(repo, String(args.get('app-entry') ?? 'out/main/index.js'))
  manifest.appEntry = appEntry; manifest.appEntrySha256 = hash(fs.readFileSync(appEntry))
  const rendererRoot = path.resolve(path.dirname(appEntry), '../renderer')
  manifest.rendererFiles = [path.join(rendererRoot, 'index.html'), ...fs.readdirSync(path.join(rendererRoot, 'assets'))
    .filter(name => /^index-.*\.(js|css)$/.test(name)).map(name => path.join(rendererRoot, 'assets', name))]
    .map(file => ({ file: path.relative(rendererRoot, file), sha256: hash(fs.readFileSync(file)) }))
  json(path.join(output, 'manifest.json'), manifest)
  const { _electron: electron } = await import('@playwright/test')
  const report = { ...manifest, scenarios: [] }
  for (const scenario of scenarios) {
    const result = await runScenario(electron, file, scenario, output, appEntry, snapshotMode)
    report.scenarios.push(result); json(path.join(output, 'report.json'), report)
    console.log(JSON.stringify({ scenario, failure: result.failure ?? null, phases: result.phases.map(phase => ({ name: phase.name, elapsedMs: phase.elapsedMs, rafP95Ms: phase.rafIntervals.p95Ms })) }))
  }
  if (report.scenarios.some(result => result.failure || result.errors.length || result.validationFailures.length || result.http.mutationsBlocked.length)) process.exitCode = 1
}
await main()
