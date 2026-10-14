#!/usr/bin/env node
/** Observe a real six-session load; dispatch/providers/scheduling belong to the
 * runner. Node 24+, built Aether and a live-six-manifest.json are required.
 * Usage: node scripts/verify-live-six-session-client.mjs <run-root> [--app-root <frozen-app>]
 * Manifest: schemaVersion:1, runId, status:'running', phase:'active', startedAt, deadline, baseUrl,
 * tokenFile? (relative to run-root, defaults .instance-token), expectedBuildId?,
 * clientMain? (absolute frozen out/main/index.js inside run-root), appRoot?, requiredActualModelIds?,
 * sessions:[{kind:'code'|'work'|'cron',sessionId,workspacePath,title?,modelId,
 *           currentModelId?,agentId?,jobId?}] (exactly two of each).
 * Everything written belongs to a run-root/client-live-six directory; no production
 * profile, task, model configuration, workspace or engine process is modified. */
import { _electron as electron, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { monitorElectronHealth, redactNativeLog } from '../e2e/helpers/electron-health.ts'
import { isVisibleToolActivity, isTaskPlanControl } from '../src/renderer/src/core/engine/task-plan.ts'
import { toolDisplayName } from '../src/renderer/src/core/engine/tool-labels.ts'
import { requireStressSubagentV2, readStressSubagentPages, stressCronEditableFields, stressCronEditableSHA256 } from './stress-subagent-archive.mjs'
import { verifyStressCronReceiptChain, isStressCronRendererMutation } from './stress-cron-receipts.mjs'

const argv = process.argv.slice(2)
if (!argv[0] || argv.includes('--help')) {
  console.log('node scripts/verify-live-six-session-client.mjs <run-root> [--app-root <frozen-app>]')
  process.exit(argv.includes('--help') ? 0 : 1)
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = path.resolve(argv[0]), manifestPath = path.join(runRoot, 'live-six-manifest.json')
const allowedRunRoot = path.resolve(repository, '.ae')
const under = (root, target) => { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) }
if (!under(allowedRunRoot, runRoot)) throw new Error('The live run-root must be inside this repository .ae directory')
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const initial = readManifest()
if (initial.schemaVersion !== 1 || !initial.runId || !Array.isArray(initial.sessions) || initial.sessions.length !== 6) throw new Error('Expected a schemaVersion 1 manifest containing six real sessions')
if (initial.status !== 'running' || initial.phase !== 'active') throw new Error('The workload runner must be running in its active phase before Electron starts')
if (initial.requiredActualModelIds !== undefined && (!Array.isArray(initial.requiredActualModelIds) || initial.requiredActualModelIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('requiredActualModelIds must be an array of actual execution model IDs')
const items = initial.sessions.map((item, index) => ({ ...item, clientTitle: `持续验收 ${item.kind} ${index + 1}` }))
for (const kind of ['code', 'work', 'cron']) if (items.filter(item => item.kind === kind).length !== 2) throw new Error(`Expected exactly two ${kind} sessions`)
if (new Set(items.map(item => item.sessionId)).size !== 6 || items.some(item => !/^[\w.:-]+$/.test(item.sessionId) || !item.workspacePath || !item.modelId)) throw new Error('Each real session needs a distinct ID, workspacePath and modelId')
if (items.some(item => item.kind !== 'code' && !item.sessionId.startsWith('work-'))) throw new Error('Work and cron sessions must use Work-owned work- IDs')
if (initial.providerMode === 'local-override' || initial.discovery?.providerMode === 'local-override') throw new Error('A local provider fixture cannot be accepted as real model load')
const baseUrl = String(initial.baseUrl).replace(/\/+$/, '')
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('Only the explicitly isolated loopback engine may be observed')
const tokenPath = path.resolve(runRoot, initial.tokenFile ?? '.instance-token')
if (!under(runRoot, tokenPath)) throw new Error('The instance token must belong to this isolated run-root')
const token = fs.readFileSync(tokenPath, 'utf8').trim()
if (!token) throw new Error('Missing isolated instance token')
const secrets = [token, ...Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_?KEY/i.test(name)).flatMap(([, value]) => value ? [value] : [])]
const scrub = value => redactNativeLog(String(value), secrets)
const flag = argv.indexOf('--app-root')
const appRoot = path.resolve(flag >= 0 ? argv[flag + 1] : initial.appRoot ?? repository)
const clientMain = path.resolve(initial.clientMain ?? path.join(appRoot, 'out', 'main', 'index.js'))
if (initial.clientMain && !under(runRoot, clientMain)) throw new Error('The frozen clientMain must belong to this isolated run-root')
const clientBuildRoot = initial.clientMain ? path.dirname(path.dirname(path.dirname(clientMain))) : appRoot
const clientOut = path.join(clientBuildRoot, 'out')
const fingerprint = () => {
  const files = {}, digest = createHash('sha256')
  let bytes = 0
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Frozen client output cannot contain symbolic links')
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(clientOut, absolute).replaceAll('\\', '/'), data = fs.readFileSync(absolute)
        const hash = createHash('sha256').update(data).digest('hex')
        files[relative] = hash; bytes += data.length
        digest.update(relative + '\0' + data.length + '\0' + hash + '\n')
      }
    }
  }
  visit(clientOut)
  for (const required of ['main/index.js', 'preload/index.js', 'renderer/index.html']) if (!files[required]) throw new Error(`Missing frozen client file: ${required}`)
  return { sha256: digest.digest('hex'), fileCount: Object.keys(files).length, bytes, files }
}
const buildFingerprint = fingerprint()
const deadline = Date.parse(initial.deadline), runnerStarted = Date.parse(initial.startedAt)
if (!Number.isFinite(deadline) || !Number.isFinite(runnerStarted) || deadline <= runnerStarted || deadline <= Date.now()) throw new Error('A live future deadline and actual runner start are required')
const output = path.join(runRoot, `client-live-six-${new Date().toISOString().replace(/[-:.]/g, '')}`)
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: items[0].modelId, thinkingMode: 'off', appearance: 'dark' }))
const startedAt = Date.now(), targetIntervalMs = 30_000, maxActionMs = Number(initial.maxUiActionMs ?? 10_000)
if (!Number.isFinite(maxActionMs) || maxActionMs < 1000 || maxActionMs > 30_000) throw new Error('maxUiActionMs must be between 1000 and 30000')
const result = { schemaVersion: 1, runId: initial.runId, scope: 'Real Electron observing six existing runner-owned sessions; workload execution and scheduler evidence are owned by the main runner. Imported task indexes are recovery setup, not UI CRUD coverage.', startedAt: new Date(startedAt).toISOString(), runnerStartedAt: initial.startedAt, deadline: initial.deadline, baseUrl, appRoot, clientMain, clientBuildRoot, frozenClient: Boolean(initial.clientMain), buildFingerprint, profile, output, status: 'running', passed: false, cycle: 0, rendererErrors: [], consoleErrors: [], failures: [], responsiveness: [], observations: [], samples: [], sessions: Object.fromEntries(items.map(item => [item.sessionId, { kind: item.kind, visits: 0, activeVisits: 0, completedVisits: 0, modelIdsSeen: [], actualModelIdsSeen: [], modelEvidence: [], runIdsSeen: [], childIdsSeen: [], planVisits: 0, detailVisits: 0, reloadRecoveries: 0, apiEventIdsSeen: [] }])), counters: { clicks: 0, keypresses: 0, codeVisits: 0, workVisits: 0, cronSessionVisits: 0, automationVisits: 0, automationEditCancellations: 0, childDetailVisits: 0, transcriptVisits: 0, artifactVisits: 0, planVisits: 0, toolDetailVisits: 0, reloads: 0, streamEvents: 0 } }
for (const stats of Object.values(result.sessions)) { stats.transcriptVisits = 0; stats.transcriptReceipts = [] }
let app, page, health, stopped = false, models = [], lastStreamTotal = 0, subagentProtocol
process.once('SIGINT', () => { stopped = true })
process.once('SIGTERM', () => { stopped = true })
const emit = event => fs.appendFileSync(path.join(output, 'events.jsonl'), scrub(JSON.stringify({ at: new Date().toISOString(), ...event })) + '\n')
const save = () => {
  fs.writeFileSync(path.join(output, 'result.json'), scrub(JSON.stringify(result, null, 2)))
  fs.writeFileSync(path.join(output, 'heartbeat.json'), JSON.stringify({ status: result.status, at: new Date().toISOString(), cycle: result.cycle, counters: result.counters, failures: result.failures.length, lastFailure: result.failures.at(-1) ?? null }))
}
const textContent = value => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n')
  return ''
}
const attribute = value => JSON.stringify(String(value))
const uniquePush = (values, value) => { if (value && !values.includes(value)) values.push(value) }
class ObserverCutoff extends Error {}
function guardWorkload() {
  if (fs.existsSync(path.join(runRoot, 'STOP'))) throw new Error('Owned workload STOP invalidated observation; see supervisor evidence')
  if (Date.now() >= deadline) throw new ObserverCutoff('The declared active observation window ended')
  const backend = readManifest()
  if (backend.phase !== 'active' || backend.status !== 'running') throw new Error(`Runner left its active phase before the deadline: ${backend.phase}/${backend.status}`)
}
async function action(label, operation) {
  guardWorkload()
  const before = performance.now()
  try { return await operation() }
  finally {
    const ms = Math.round(performance.now() - before)
    const cutoffOverlap = Date.now() >= deadline
    result.responsiveness.push({ at: new Date().toISOString(), cycle: result.cycle, label, ms, cutoffOverlap })
    if (ms > maxActionMs && !cutoffOverlap) emit({ type: 'slow-ui-action', label, ms, limitMs: maxActionMs })
  }
}
async function click(locator, label) { await action(label, () => locator.click()); result.counters.clicks++ }
async function key(locator, keyName, label) { await action(label, () => locator.press(keyName)); result.counters.keypresses++ }
async function api(pathname, query = {}) {
  guardWorkload()
  let response
  try { response = await page.evaluate(({ pathname, query, subagentProtocol }) => window.aether.engine.request({ method: 'GET', path: pathname, query, ...(subagentProtocol ? { subagentProtocol } : {}) }), { pathname, query, subagentProtocol }) }
  catch (error) { if (Date.now() >= deadline) throw new ObserverCutoff('Engine request overlapped the runner cutoff'); throw error }
  if (Date.now() >= deadline) throw new ObserverCutoff('Engine response arrived after the active observation window')
  if (!response.ok) throw new Error(`${pathname}: ${scrub(response.message)}`)
  return response.data
}
async function childPages(parentSessionId) {
  return readStressSubagentPages(query => api('/subagent/runs', query), parentSessionId)
}
async function installStreamProbe() {
  await page.evaluate(() => {
    window.__liveSixProbe?.off?.()
    window.__liveSixProbe?.performance?.off?.()
    const probe = { total: 0, content: 0, todo: 0, child: 0, error: 0, lastAt: null, recent: [], off: null }
    window.__liveSixProbe = probe
    // Diagnose cumulative main-thread pressure without copying task content or
    // retaining an unbounded hour-long trace. Counters survive each sample;
    // only the latest 64 slow scheduling intervals/long tasks are retained.
    const metrics = { installedAt: Date.now(), longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0,
      loopSamples: 0, maxLoopDelayMs: 0, recent: [], off: null }
    probe.performance = metrics
    const record = entry => { metrics.recent.push(entry); if (metrics.recent.length > 64) metrics.recent.shift() }
    let observer
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          metrics.longTasks++; metrics.longTaskMs += entry.duration
          metrics.maxLongTaskMs = Math.max(metrics.maxLongTaskMs, entry.duration)
          record({ kind: 'longtask', at: Date.now(), startTime: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ type: 'longtask', buffered: false })
    } catch { /* Older renderer builds still expose event-loop delay below. */ }
    let expected = performance.now() + 500
    const timer = setInterval(() => {
      const now = performance.now(), delay = Math.max(0, now - expected)
      expected = now + 500; metrics.loopSamples++
      metrics.maxLoopDelayMs = Math.max(metrics.maxLoopDelayMs, delay)
      if (delay >= 100) record({ kind: 'event-loop', at: Date.now(), duration: delay, documentHidden: document.hidden })
    }, 500)
    metrics.off = () => { observer?.disconnect(); clearInterval(timer) }
    probe.off = window.aether.engine.onStreamEvent(event => {
      probe.total++; probe.lastAt = Date.now()
      const payload = event.type === 'payload' ? event.payload : undefined
      if (typeof payload?.content === 'string') probe.content++
      if (payload?.todo) probe.todo++
      if (payload?.subagentEvent) probe.child++
      if (event.type === 'error') probe.error++
      if (event.type !== 'payload' || payload?.run || payload?.todo || payload?.subagentEvent || payload?.toolEnd || payload?.toolResult) {
        probe.recent.push({ type: event.type, eventId: event.eventId, streamId: event.streamId, sessionId: payload?.run?.sessionId, runId: payload?.run?.runId, rootStatus: payload?.run?.status, todoCount: payload?.todo?.todos?.length, childRunId: payload?.subagentEvent?.runId, error: event.type === 'error' ? event.message : undefined })
        if (probe.recent.length > 40) probe.recent.shift()
      }
    })
  })
  lastStreamTotal = 0
}
async function collectStreamProbe() {
  const snapshot = await page.evaluate(() => {
    const probe = window.__liveSixProbe
    return probe ? { total: probe.total, content: probe.content, todo: probe.todo, child: probe.child, error: probe.error, lastAt: probe.lastAt, recent: probe.recent.splice(0) } : null
  })
  if (snapshot) { result.counters.streamEvents += Math.max(0, snapshot.total - lastStreamTotal); lastStreamTotal = snapshot.total; emit({ type: 'ipc-stream-observation', ...snapshot }) }
}
async function rendererPerformance() {
  if (!page || page.isClosed()) return null
  let timer
  const read = page.evaluate(() => {
    const value = window.__liveSixProbe?.performance
    return value ? { installedAt: value.installedAt, longTasks: value.longTasks, longTaskMs: value.longTaskMs,
      maxLongTaskMs: value.maxLongTaskMs, loopSamples: value.loopSamples, maxLoopDelayMs: value.maxLoopDelayMs,
      recent: value.recent.splice(0), heapBytes: performance.memory?.usedJSHeapSize ?? null,
      nodes: document.querySelectorAll('*').length, documentHidden: document.hidden } : null
  })
  try {
    return await Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Renderer diagnostic exceeded 3000ms')), 3000)
    })])
  } catch (error) { return { diagnosticError: scrub(error.message) } }
  finally { if (timer) clearTimeout(timer) }
}
async function ready() {
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
  expect(engine.mode).toBe('remote'); expect(engine.baseUrl.replace(/\/+$/, '')).toBe(baseUrl); expect(engine.phase).toBe('ready')
  if (initial.expectedBuildId) expect(engine.buildId).toBe(initial.expectedBuildId)
  result.engine = { baseUrl: engine.baseUrl, instanceId: engine.instanceId, buildId: engine.buildId, protocolVersion: engine.protocolVersion }
}
async function reload(label) {
  await collectStreamProbe()
  await action(label, () => page.reload())
  result.counters.reloads++
  await ready(); await installStreamProbe()
}
const codeSurface = () => page.locator('.mode-surface[data-mode="code"]')
const workSurface = () => page.locator('.work-view')
async function switchMode(kind) {
  await click(page.getByRole('tab', { name: kind === 'code' ? 'Code 开发' : 'Work 办公', exact: true }), `switch-${kind}`)
  await expect(page.locator(`.mode-surface[data-mode="${kind}"]`)).toBeVisible()
}
async function showHistory() {
  const code = codeSurface()
  // The initial settings editor intentionally suppresses the sidebar below
  // 1280px. Leave that editor through its real UI before browsing sessions;
  // CSS visibility alone cannot tell whether a toggle is already pressed.
  if (await code.locator('.app-settings').isVisible()) {
    const before = await code.evaluate(root => ({
      viewport: { width: innerWidth, height: innerHeight },
      sidebarDisplay: root.querySelector('.workbench__sidebar') ? getComputedStyle(root.querySelector('.workbench__sidebar')).display : 'unmounted',
      historyPressed: root.querySelector('.activity-bar button[title="会话历史"]')?.getAttribute('aria-pressed') ?? null
    }))
    emit({ type: 'observer-navigation-precondition', cycle: result.cycle, reason: 'Close the initial settings editor before selecting real Code history; narrow settings intentionally hide the sidebar', ...before })
    await click(code.getByRole('button', { name: '关闭 设置', exact: true }), 'close-initial-settings-editor')
    await expect(code.locator('.app-settings')).toHaveCount(0)
  }
  const history = code.locator('.activity-bar button[title="会话历史"]')
  if (await history.getAttribute('aria-pressed') !== 'true') await click(history, 'open-code-history')
  await expect(history).toHaveAttribute('aria-pressed', 'true')
  const header = code.locator('.sidebar__header')
  await expect(header).toBeVisible(); await expect(header).toContainText('会话历史')
  await expect(code.locator('.history-view')).toBeVisible()
  await click(codeSurface().getByRole('button', { name: '刷新会话列表', exact: true }), 'refresh-code-history')
}
async function openWorkTab(name) {
  const work = workSurface()
  const tabs = work.getByRole('tablist', { name: '工作区内容', exact: true })
  // The artifact count is part of the accessible name once the first file is
  // produced. Keep the same label contract as the Work E2E selectors and scope
  // it to the workspace tablist, away from conversation shortcuts/detail tabs.
  const target = tabs.getByRole('tab', { name: name === '成果' ? /^成果(?: \d+)?$/ : name, exact: true })
  if (!await target.isVisible()) {
    const mobile = work.locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ })
    if (await mobile.isVisible()) await click(mobile, 'show-mobile-workspace')
    else {
      const opening = work.getByRole('button', { name: '打开工作区', exact: true })
      if (await opening.isVisible()) await click(opening, 'open-workspace')
    }
  }
  await expect(tabs, 'the selected task has one workspace navigation tablist').toHaveCount(1)
  await expect(target, `workspace tab ${name} is unambiguous with or without a count`).toHaveCount(1)
  await click(target, `open-work-tab-${name}`)
  await expect(target).toHaveAttribute('aria-selected', 'true')
  const panelId = await target.getAttribute('aria-controls')
  expect(panelId, `workspace tab ${name} identifies its own panel`).toMatch(/^work-panel-[a-z]+$/)
  const panel = work.locator(`[role="tabpanel"][id=${attribute(panelId)}]`)
  await expect(panel).toHaveCount(1)
  await expect(panel, `workspace tab ${name} reveals its controlled panel`).toBeVisible()
}
async function showWorkConversation() {
  const button = workSurface().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
  if (await button.isVisible()) await click(button, 'show-mobile-conversation')
}
async function showSession(item) {
  if (item.kind === 'code') {
    await switchMode('code'); await showHistory()
    const row = codeSurface().locator(`.history-view__item[data-session-id=${attribute(item.sessionId)}]`)
    await expect(row, 'real Code session is selectable through history').toHaveCount(1)
    await click(row, 'select-code-session'); await expect(row).toHaveClass(/is-active/)
  } else {
    await switchMode('work')
    await click(workSurface().getByRole('button', { name: '新任务', exact: true }), 'show-work-home')
    const input = workSurface().getByRole('textbox', { name: '搜索 Work 任务', exact: true })
    await action('search-work-task', () => input.fill(item.clientTitle))
    const row = workSurface().locator('.work-task-row').filter({ hasText: item.clientTitle })
    await expect(row).toHaveCount(1); await click(row, 'select-work-session')
    await expect(workSurface().locator('.work-task-heading h1')).toHaveText(item.clientTitle)
    await showWorkConversation()
  }
}
function snapshotUser(snapshot) {
  const rows = [...(snapshot.history ?? []), ...(snapshot.projection ?? []).flatMap(payload => payload.userMessage ? [payload.userMessage] : [])]
  const users = rows.filter(row => row.role === 'user' && row.isSidechain !== true)
  return users.findLast(row => row.id === snapshot.run?.userMessageId) ?? users.at(-1)
}
async function verifyUser(item, snapshot) {
  const user = snapshotUser(snapshot)
  if (!user?.id) throw new Error(`Session ${item.sessionId} has no real persisted/projected user to verify`)
  const root = item.kind === 'code' ? codeSurface() : workSurface()
  const selector = item.kind === 'code' ? '.message--user' : '.work-message--user'
  const row = root.locator(`${selector}[data-message-id=${attribute(user.id)}]`)
  for (let attempt = 0; attempt < 8 && await row.count() === 0; attempt++) {
    const earlier = root.locator(item.kind === 'code' ? '.chat__load-earlier' : '.work-history-load').first()
    if (!await earlier.isVisible()) break
    await click(earlier, 'load-earlier-user-history')
  }
  await expect(row, 'exact selected-session user must survive replay').toHaveCount(1)
  const text = textContent(user.content).trim().slice(0, 80)
  if (text) await expect(row).toContainText(text)
  return { id: user.id, turnId: user.conversationId ?? user.metadata?.turnId }
}
async function verifyModel(item, snapshot) {
  const stats = result.sessions[item.sessionId]
  for (const run of [...(snapshot.runs ?? []), ...(snapshot.run ? [snapshot.run] : [])]) {
    if (run.sessionId !== item.sessionId) throw new Error('Snapshot model receipt belongs to another session')
    uniquePush(stats.actualModelIdsSeen, run.actualModelId)
    if (run.actualModelId && !stats.modelEvidence.some(prior => prior.runId === run.runId && prior.actual === run.actualModelId)) stats.modelEvidence.push({ runId: run.runId, requested: run.modelId ?? null, actual: run.actualModelId })
  }
  const selected = snapshot.run?.modelId
  if (!selected) return { requested: null, actual: null }
  const model = models.find(model => model.id === selected || model.modelId === selected)
  const canonical = model?.modelId || selected
  const label = model?.displayName?.trim() || canonical
  const picker = item.kind === 'code'
    ? codeSurface().locator('.model-picker .select__trigger')
    : workSurface().getByRole('button', { name: 'Work 使用的模型', exact: true })
  await expect(picker, 'composer selection must match the actual selected-session request model').toHaveAttribute('title', `当前模型：${canonical}`)
  await expect(picker.locator('.select__value')).toHaveText(label)
  uniquePush(stats.modelIdsSeen, selected); uniquePush(stats.actualModelIdsSeen, snapshot.run?.actualModelId)
  return { requested: selected, actual: snapshot.run?.actualModelId ?? null }
}
const runIdentity = snapshot => JSON.stringify([snapshot.run?.runId, snapshot.run?.modelId, snapshotUser(snapshot)?.id])
async function verifyRecoveredSession(item) {
  let snapshot = await api('/chat/snapshot', { sessionId: item.sessionId })
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(snapshot.schemaVersion).toBe(1); expect(snapshot.sessionId).toBe(item.sessionId)
    const identity = runIdentity(snapshot)
    try {
      const user = await verifyUser(item, snapshot), model = await verifyModel(item, snapshot)
      const fresh = await api('/chat/snapshot', { sessionId: item.sessionId })
      expect(fresh.sessionId).toBe(item.sessionId)
      if (runIdentity(fresh) === identity) return { snapshot, user, model }
      emit({ type: 'snapshot-superseded-during-ui-check', sessionId: item.sessionId, oldRunId: snapshot.run?.runId, newRunId: fresh.run?.runId })
      snapshot = fresh
    } catch (error) {
      if (error instanceof ObserverCutoff) throw error
      const fresh = await api('/chat/snapshot', { sessionId: item.sessionId })
      expect(fresh.sessionId).toBe(item.sessionId)
      // A runner may start the next turn during selection/replay. Retry only
      // with evidence of that transition; a stable missing/wrong row stays red.
      if (runIdentity(fresh) === identity) throw error
      emit({ type: 'snapshot-transition-retry', sessionId: item.sessionId, oldRunId: snapshot.run?.runId, newRunId: fresh.run?.runId })
      snapshot = fresh
    }
  }
  throw new Error(`Session ${item.sessionId} changed turns during three consecutive UI ownership checks`)
}
async function inspectCompletedTurn(item, snapshot) {
  const completed = [...(snapshot.runs ?? []), ...(snapshot.run ? [snapshot.run] : [])]
    .filter(run => run.sessionId === item.sessionId && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status))
    .sort((left, right) => right.createdAt - left.createdAt)
  const target = completed.find(run => (snapshot.history ?? []).some(row => row.role === 'assistant' && row.id === run.assistantMessageId && textContent(row.content).trim()))
  if (!target) return { uiChecked: false }
  const root = item.kind === 'code' ? codeSurface() : workSurface()
  const row = root.locator(`${item.kind === 'code' ? '.message--assistant' : '.work-message--assistant'}[data-message-id=${attribute(target.assistantMessageId)}]`)
  for (let attempt = 0; attempt < 8 && await row.count() === 0; attempt++) {
    const earlier = root.locator(item.kind === 'code' ? '.chat__load-earlier' : '.work-history-load').first()
    if (!await earlier.isVisible()) break
    await click(earlier, 'load-completed-turn-history')
  }
  await expect(row, 'a completed persisted run must have its own rendered assistant row').toHaveCount(1)
  await action('view-completed-turn', () => row.scrollIntoViewIfNeeded())
  const rendered = (await row.locator('.md').allTextContents()).join('').trim()
  expect(rendered.length, 'completed-turn content must be visible in the owned conversation').toBeGreaterThan(0)
  return { uiChecked: true, runId: target.runId, assistantMessageId: target.assistantMessageId, status: target.status }
}
function planReceipts(snapshot) {
  const names = new Map(), results = new Map()
  for (const row of snapshot.history ?? []) {
    if (row.toolCall?.id && row.toolCall.name) names.set(row.toolCall.id, row.toolCall.name)
    if (row.role === 'tool' && typeof row.toolCallId === 'string') results.set(row.toolCallId, row)
  }
  for (const payload of snapshot.projection ?? []) {
    const start = payload.toolStart ?? payload.toolCall
    if (start?.id && start.name) names.set(start.id, start.name)
    const end = payload.toolEnd ?? payload.toolResult
    if (end?.id) { if (end.name) names.set(end.id, end.name); results.set(end.id, end) }
  }
  const controls = [...names].filter(([, name]) => isTaskPlanControl(name)).map(([id, name]) => ({ id, name, silent: !isVisibleToolActivity({ name, ...(results.get(id) ?? {}) }) }))
  return {
    ids: controls.filter(control => control.silent).map(control => control.id),
    // Sidebar options have no call-ID attribute. Check exact built-in labels only
    // when that name has no legitimate failure receipt in the same session.
    silentOnlyNames: [...new Set(controls.filter(control => control.silent && !controls.some(other => other.name === control.name && !other.silent)).map(control => control.name))]
  }
}
async function verifySilentControls(item, snapshot) {
  const root = item.kind === 'code' ? codeSurface() : workSurface()
  const forbidden = planReceipts(snapshot)
  const rendered = await root.locator('.compact-tool-row[data-tool-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-id')))
  expect(rendered.filter(id => forbidden.ids.includes(id)), 'internal successful plans cannot reappear in ordinary tool lists').toEqual([])
  let sidebarLabels = []
  if (item.kind !== 'code') {
    await openWorkTab('活动')
    sidebarLabels = await root.locator('.work-activities__list [role="option"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title') ?? ''))
    const forbiddenLabels = forbidden.silentOnlyNames.map(toolDisplayName)
    expect(sidebarLabels.filter(label => forbiddenLabels.some(name => label === name || label.startsWith(`${name} · `))), 'successful built-in plan controls cannot appear in the activity sidebar').toEqual([])
    await showWorkConversation()
  }
  return { legacySilentCount: forbidden.ids.length, renderedOrdinaryTools: rendered.length, sidebarToolCount: sidebarLabels.length, sidebarPlanLabelsChecked: forbidden.silentOnlyNames }
}
async function inspectPlan(item, snapshot) {
  const todos = snapshot.todos ?? []
  if (!todos.length) return { todoCount: 0, uiChecked: false }
  if (item.kind === 'code') {
    const tab = codeSurface().locator('.session-tray__tab').filter({ hasText: /^任务/ })
    await expect(tab).toBeVisible(); await click(tab, 'open-code-plan')
    const tray = codeSurface().locator('.todo-tray')
    if (!await tray.isVisible()) {
      const expand = codeSurface().getByRole('button', { name: '展开托盘', exact: true })
      if (await expand.isVisible()) await click(expand, 'expand-code-plan')
    }
    await expect(tray).toBeVisible()
    await expect(tray).toContainText(todos[0].title)
  } else {
    await openWorkTab('活动')
    const steps = workSurface().locator('.work-steps')
    await expect(steps).toBeVisible()
    if (await steps.getAttribute('open') === null) await click(steps.locator('summary'), 'expand-work-plan')
    await expect(steps).toContainText(todos[0].title)
  }
  result.counters.planVisits++; result.sessions[item.sessionId].planVisits++
  return { todoCount: todos.length, states: todos.map(todo => todo.status), uiChecked: true }
}
async function inspectCodeTools(item) {
  const root = codeSurface()
  const process = root.locator('.process__summary').last()
  if (await process.isVisible() && await process.getAttribute('aria-expanded') !== 'true') await key(process, 'Enter', 'expand-code-tool-group')
  const toggle = root.locator('.compact-tool-row button.logline:not(:disabled)').last()
  if (await toggle.isVisible()) {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await click(toggle, 'open-code-tool-detail')
    await expect(root.locator('.logline__detail').last()).toBeVisible(); result.counters.toolDetailVisits++
    result.sessions[item.sessionId].detailVisits++
    result.sessions[item.sessionId].toolDetailVisits = (result.sessions[item.sessionId].toolDetailVisits ?? 0) + 1
  }
  for (const group of await root.locator('.subagent-group__head').all()) if (await group.getAttribute('aria-expanded') === 'false') await click(group, 'open-code-child-group')
  const cards = root.locator('.subagent-card[data-run-id]')
  if (await cards.count()) {
    const card = cards.last()
    if (await card.getAttribute('open') === null) await click(card.locator('summary'), 'open-code-child')
    await expect(card.locator('.subagent-card__goal-block')).toBeVisible(); result.counters.childDetailVisits++
    result.sessions[item.sessionId].childDetailVisits = (result.sessions[item.sessionId].childDetailVisits ?? 0) + 1
    const calls = card.locator('.subagent-card__tools-header')
    if (await calls.isVisible() && !await card.locator('.subagent-card__tools-list').isVisible()) await click(calls, 'open-code-child-tools')
    const call = card.locator('.subagent-card__call-toggle:not(:disabled)').first()
    if (await call.isVisible() && await call.getAttribute('aria-expanded') !== 'true') await click(call, 'open-code-child-result')
  }
  return await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-run-id')))
}
async function verifyChildOwnership(item, childRuns, runIds = [], sessionIds = []) {
  // Active UI can receive a newly spawned round after the first API snapshot.
  const missing = () => runIds.some(id => !childRuns.some(child => child.runId === id)) || sessionIds.some(id => !childRuns.some(child => child.childSessionId === id))
  if (missing()) {
    const fresh = await childPages(item.sessionId)
    childRuns.splice(0, childRuns.length, ...fresh)
  }
  for (const child of childRuns) {
    expect(child.parentSessionId).toBe(item.sessionId)
    expect(child.rootSessionId).toBe(item.sessionId)
    uniquePush(result.sessions[item.sessionId].childIdsSeen, child.childSessionId || child.runId)
  }
  for (const id of runIds) expect(childRuns.some(child => child.runId === id), 'UI child round must belong to the selected real parent').toBe(true)
  for (const id of sessionIds) expect(childRuns.some(child => child.childSessionId === id), 'UI child session must belong to the selected real parent').toBe(true)
}
async function inspectLiveChildIndicators(panel, view) {
  const indicators = await panel.locator('.work-subagents__live .ui-spinner').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node)
    return { width: parseFloat(style.width), height: parseFloat(style.height), flexGrow: style.flexGrow, flexShrink: style.flexShrink,
      expectedWidth: parseFloat(node.style.width), expectedHeight: parseFloat(node.style.height) }
  }))
  for (const indicator of indicators) {
    expect(indicator.expectedWidth, `${view}: live child ring declares its size`).toBe(14)
    expect(indicator.expectedHeight).toBe(14)
    expect(Math.abs(indicator.width - indicator.expectedWidth), `${view}: live child ring cannot stretch across the panel`).toBeLessThanOrEqual(0.75)
    expect(Math.abs(indicator.height - indicator.expectedHeight)).toBeLessThanOrEqual(0.75)
    expect(indicator.flexGrow).toBe('0')
    expect(indicator.flexShrink).toBe('0')
  }
  // A child can settle between clicks; an absent ring records no running-state
  // observation instead of claiming a finished child exercised the ring.
  return { view, indicators }
}
function workTranscriptCoverageReasons(items, sessions, startedAt, deadline) {
  const reasons = [], start = Date.parse(startedAt), end = Date.parse(deadline)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return ['Work transcript evidence has no valid formal observation window']
  for (const item of items) {
    if (item.kind !== 'work' && item.kind !== 'cron') continue
    const stats = sessions?.[item.sessionId], receipts = stats?.transcriptReceipts
    if (!Number.isSafeInteger(stats?.transcriptVisits) || stats.transcriptVisits < 1 || !Array.isArray(receipts) || !receipts.length) {
      reasons.push(`Session ${item.sessionId} lacks its own loaded child transcript observation`)
      continue
    }
    if (receipts.length !== stats.transcriptVisits) reasons.push(`Session ${item.sessionId} transcript visit count differs from its receipts`)
    for (const receipt of receipts) {
      const at = Date.parse(receipt?.at)
      if (receipt?.sessionId !== item.sessionId || receipt?.kind !== item.kind
        || !['childSessionId', 'childRunId'].every(key => typeof receipt?.[key] === 'string' && receipt[key].trim().length > 0)
        || receipt?.identitySource !== 'owned-round-observed-before-open'
        || !Number.isFinite(at) || at < start || at >= end
        || !['resident', 'total', 'visibleRecords'].every(key => Number.isSafeInteger(receipt?.[key]))
        || receipt.resident < 1 || receipt.total < receipt.resident || receipt.visibleRecords < 1 || receipt.visibleRecords > receipt.resident) {
        reasons.push(`Session ${item.sessionId} has invalid, foreign or out-of-window transcript evidence`)
      }
    }
  }
  return reasons
}
async function verifyLoadedWorkTranscript(panel) {
  const transcript = panel.locator('.work-subagent-transcript')
  await expect(transcript).toBeVisible()
  // Loading completion and actual records establish readiness; the old label
  // alone could neither distinguish a pending read nor detect an empty replay.
  await expect(transcript.locator('.work-subagent-transcript__scroll')).toHaveAttribute('aria-busy', 'false')
  const label = transcript.locator('.work-subagent-transcript__toolbar > span')
  await expect(label).toHaveText(/^当前窗口 [\d,]+ \/ [\d,]+ 条记录$/)
  await expect(transcript.getByRole('button', { name: '更新子代理完整对话', exact: true })).toBeEnabled()
  expect(await transcript.locator('.work-subagent-transcript__error').count(), 'real child transcript must load without hiding errors').toBe(0)
  // A new round can refresh between awaited locator reads. Admit one coherent
  // DOM state rather than combining readiness and records from different frames.
  const current = await transcript.evaluate(node => ({
    ready: node.querySelector('.work-subagent-transcript__scroll')?.getAttribute('aria-busy') === 'false',
    enabled: node.querySelector('button[aria-label="更新子代理完整对话"]')?.disabled === false,
    errors: node.querySelectorAll('.work-subagent-transcript__error').length,
    label: node.querySelector('.work-subagent-transcript__toolbar > span')?.textContent ?? '',
    ids: Array.from(node.querySelectorAll('[data-transcript-id]'), row => row.getAttribute('data-transcript-id'))
  }))
  expect(current.ready, 'the admitted transcript window is no longer loading').toBe(true)
  expect(current.enabled, 'the admitted transcript remains available for refresh').toBe(true)
  expect(current.errors, 'the admitted window contains no load error').toBe(0)
  const counts = /^当前窗口 ([\d,]+) \/ ([\d,]+) 条记录$/.exec(current.label)
  if (!counts) throw new Error('Loaded transcript did not expose its current window counts')
  const resident = Number(counts[1].replaceAll(',', '')), total = Number(counts[2].replaceAll(',', ''))
  expect(resident, 'real child transcript has persisted records').toBeGreaterThan(0)
  expect(total, 'the complete archive count includes the resident window').toBeGreaterThanOrEqual(resident)
  const ids = current.ids
  expect(ids.length, 'a loaded transcript renders actual conversation records').toBeGreaterThan(0)
  expect(ids.length).toBeLessThanOrEqual(resident)
  expect(ids.every(id => typeof id === 'string' && id.length > 0), 'each rendered record retains its durable identity').toBe(true)
  expect(new Set(ids).size, 'the resident transcript contains no duplicate records').toBe(ids.length)
  return { resident, total, visibleRecords: ids.length }
}
async function inspectWorkDetails(item, childRuns) {
  const work = workSurface(), stats = result.sessions[item.sessionId]
  await openWorkTab('活动')
  const completedTools = await work.locator('.work-activities__list:visible').getByRole('option').filter({ has: page.locator('.work-tool-state--done') }).all()
  let toolResult = null
  for (const tool of completedTools.reverse()) {
    await click(tool, 'select-completed-work-activity')
    const detail = work.getByRole('article', { name: '活动详情', exact: true })
    await expect(detail).toBeVisible()
    await expect(detail.locator('header > .work-tool-state--done')).toBeVisible()
    const outputBlock = detail.locator('.work-activity-detail__block').filter({ has: page.getByRole('heading', { name: '输出', exact: true }) })
    if (!await outputBlock.count() || !(await outputBlock.locator('pre').textContent())?.trim()) continue
    await expect(outputBlock.locator('pre')).toHaveText(/\S/)
    toolResult = { name: await detail.locator('h3').textContent(), outputCharacters: (await outputBlock.locator('pre').textContent()).length }
    result.counters.toolDetailVisits++; stats.detailVisits++
    stats.toolDetailVisits = (stats.toolDetailVisits ?? 0) + 1
    break
  }
  await openWorkTab('子代理')
  const panel = work.getByRole('region', { name: '协作代理', exact: true })
  await expect(panel).toBeVisible()
  const back = panel.getByRole('button', { name: '返回子代理列表', exact: true })
  if (await back.isVisible()) await click(back, 'return-child-list')
  const row = panel.locator('.work-subagents__row[data-child-session-id]').first()
  let childSessionId = null, uiChildIds = [], liveIndicators = [], transcriptReceipt = null
  if (await row.isVisible()) {
    childSessionId = await row.getAttribute('data-child-session-id')
    await verifyChildOwnership(item, childRuns, [], [childSessionId])
    await click(row, 'open-work-child-detail')
    const rounds = panel.getByRole('button', { name: '工作轮次', exact: true })
    await click(rounds, 'show-work-child-rounds')
    liveIndicators.push(await inspectLiveChildIndicators(panel, 'rounds'))
    const card = panel.locator('.subagent-card[data-run-id]').first()
    await expect(card).toBeVisible()
    if (await card.getAttribute('open') === null) await click(card.locator('summary'), 'expand-work-child-round')
    uiChildIds = await panel.locator('.subagent-card[data-run-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-run-id')))
    await verifyChildOwnership(item, childRuns, uiChildIds)
    result.counters.childDetailVisits++; stats.detailVisits++
    stats.childDetailVisits = (stats.childDetailVisits ?? 0) + 1
    if (result.cycle % 4 === 0) {
      const transcript = panel.getByRole('button', { name: '完整对话', exact: true })
      if (await transcript.isEnabled()) {
        // The transcript spans the child's conversation. Record the owned round
        // visible at admission, rather than claiming every row belongs to it.
        const childRunId = await panel.locator('.work-subagents__round[data-run-id]').last().getAttribute('data-run-id')
        if (!childRunId || !childRuns.some(child => child.runId === childRunId && child.childSessionId === childSessionId)) throw new Error('The transcript admission round does not belong to the selected owned child')
        await click(transcript, 'open-real-child-transcript')
        const window = await verifyLoadedWorkTranscript(panel)
        liveIndicators.push(await inspectLiveChildIndicators(panel, 'transcript'))
        guardWorkload()
        const at = new Date().toISOString()
        if (Date.parse(at) >= deadline) throw new ObserverCutoff('Transcript observation completed after the active window')
        transcriptReceipt = { at, sessionId: item.sessionId, kind: item.kind, childSessionId, childRunId, identitySource: 'owned-round-observed-before-open', ...window }
        stats.transcriptVisits++; stats.transcriptReceipts.push(transcriptReceipt)
        result.counters.transcriptVisits++
        emit({ type: 'work-child-transcript-loaded', ...transcriptReceipt })
      } else emit({ type: 'work-child-transcript-not-yet-inspectable', sessionId: item.sessionId, kind: item.kind, childSessionId })
    }
  }
  await openWorkTab('成果')
  const artifact = work.locator('.work-artifacts-shell__list:visible').getByRole('option').first()
  if (await artifact.isVisible()) {
    await click(artifact, 'open-work-artifact')
    const preview = work.getByRole('tab', { name: '预览', exact: true })
    if (await preview.isVisible()) await click(preview, 'preview-work-artifact')
    const changes = work.getByRole('tab', { name: '文件改动', exact: true })
    if (await changes.isVisible()) { await click(changes, 'inspect-work-file-changes'); if (await preview.isVisible()) await click(preview, 'return-artifact-preview') }
    result.counters.artifactVisits++
  }
  await showWorkConversation()
  return { childSessionId, uiChildIds, toolResult, liveIndicators, transcriptReceipt }
}
let expectedViewport = null
async function layoutMetrics() {
  const metrics = await page.evaluate(() => {
    const visible = selector => [...document.querySelectorAll(selector)].filter(node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden], [inert]'))
    const widths = visible('.work-conversation, .work-workspace, .work-composer, .chat__surface, .process__summary, .work-process, .subagent-card > summary').map(node => ({ class: node.className, overflow: node.scrollWidth - node.clientWidth }))
    return { viewport: { width: innerWidth, height: innerHeight }, documentOverflow: document.documentElement.scrollWidth - innerWidth, nodes: document.querySelectorAll('*').length, heap: performance.memory?.usedJSHeapSize ?? null, panels: widths }
  })
  if (expectedViewport) {
    expect(Math.abs(metrics.viewport.width - expectedViewport.width), 'actual renderer width must match the exercised content viewport').toBeLessThanOrEqual(2)
    expect(Math.abs(metrics.viewport.height - expectedViewport.height), 'actual renderer height must match the exercised content viewport').toBeLessThanOrEqual(2)
  }
  expect(metrics.documentOverflow, 'the desktop must not acquire horizontal window scrolling').toBeLessThanOrEqual(2)
  const overflowing = metrics.panels.filter(panel => panel.overflow > 3)
  expect(overflowing, 'visible conversation/composer/card headers must fit their window').toEqual([])
  return metrics
}
async function visit(item) {
  const started = performance.now(), stats = result.sessions[item.sessionId]
  await showSession(item)
  const { snapshot, user, model } = await verifyRecoveredSession(item)
  const completedTurn = await inspectCompletedTurn(item, snapshot)
  const childRuns = await childPages(item.sessionId)
  for (const child of childRuns) { expect(child.parentSessionId).toBe(item.sessionId); expect(child.rootSessionId).toBe(item.sessionId); uniquePush(stats.childIdsSeen, child.childSessionId || child.runId) }
  const plan = await inspectPlan(item, snapshot)
  const details = item.kind === 'code' ? { uiChildIds: await inspectCodeTools(item) } : await inspectWorkDetails(item, childRuns)
  await verifyChildOwnership(item, childRuns, details.uiChildIds ?? [])
  const controls = await verifySilentControls(item, snapshot)
  const layout = await layoutMetrics()
  stats.visits++; if (['running', 'waiting'].includes(snapshot.run?.status)) stats.activeVisits++
  if (completedTurn.uiChecked) stats.completedVisits++
  uniquePush(stats.runIdsSeen, snapshot.run?.runId); uniquePush(stats.apiEventIdsSeen, snapshot.eventId)
  result.counters[item.kind === 'code' ? 'codeVisits' : item.kind === 'cron' ? 'cronSessionVisits' : 'workVisits']++
  const record = { at: new Date().toISOString(), cycle: result.cycle, sessionId: item.sessionId, kind: item.kind, ms: Math.round(performance.now() - started), user, model, rootStatus: snapshot.run?.status ?? null, runId: snapshot.run?.runId ?? null, eventId: snapshot.eventId, childCount: childRuns.length, historyCount: snapshot.history?.length ?? 0, projectionCount: snapshot.projection?.length ?? 0, completedTurn, plan, controls, details, layout }
  result.observations.push(record); emit({ type: 'session-visited', ...record })
  if (result.cycle <= 3 || result.cycle % 20 === 0) await page.screenshot({ path: path.join(output, `cycle-${result.cycle}-${item.kind}-${items.indexOf(item) + 1}.png`), animations: 'disabled' })
  if (result.cycle % 5 === 0 && item === items[result.cycle % items.length]) {
    await reload('reload-active-session')
    const next = await verifyRecoveredSession(item)
    stats.reloadRecoveries++
    emit({ type: 'selected-session-recovered', sessionId: item.sessionId, runId: next.snapshot.run?.runId })
  }
  await collectStreamProbe(); health.assertHealthy()
}
async function inspectAutomation() {
  await switchMode('work')
  await click(workSurface().locator('.work-navigation__item[title="自动化"]'), 'open-automation-entry')
  const management = workSurface().getByRole('region', { name: '自动化管理', exact: true })
  await expect(management).toBeVisible()
  const jobs = await api('/cron'), list = Array.isArray(jobs) ? jobs : jobs.list ?? []
  const records = []
  const editableFields = stressCronEditableFields, editableHash = stressCronEditableSHA256
  const installMutationProbe = jobId => app.evaluate(({ ipcMain }, { jobId, mutationSource }) => {
    // Observe the real IPC invoke boundary: contextBridge's renderer API is frozen.
    const handlers = ipcMain._invokeHandlers, channel = 'engine:request'
    if (!(handlers instanceof Map) || globalThis.__liveSixAutomationMutationProbe) throw new Error('Owned IPC mutation probe cannot be installed safely')
    const original = handlers.get(channel)
    if (typeof original !== 'function') throw new Error('Owned engine request invoke handler is missing')
    const jobPath = `/cron/${encodeURIComponent(jobId)}`, probe = { original, wrapper: null, observedCalls: 0, mutations: [] }
    const isMutation = new Function('return (' + mutationSource + ')')()
    probe.wrapper = function (...args) {
      const input = args[1], method = String(input?.method ?? 'GET').toUpperCase(), pathname = String(input?.path ?? '')
      if (pathname === jobPath || pathname.startsWith(jobPath + '/')) probe.observedCalls++
      if (isMutation(input)) {
        probe.mutations.push({ at: Date.now(), method, path: pathname })
      }
      return Reflect.apply(original, this, args)
    }
    handlers.set(channel, probe.wrapper); globalThis.__liveSixAutomationMutationProbe = probe
  }, { jobId, mutationSource: isStressCronRendererMutation.toString() })
  const finishMutationProbe = () => app.evaluate(({ ipcMain }) => {
    const probe = globalThis.__liveSixAutomationMutationProbe, handlers = ipcMain._invokeHandlers
    if (!probe || handlers.get('engine:request') !== probe.wrapper) throw new Error('Owned IPC mutation probe was replaced or lost')
    handlers.set('engine:request', probe.original); delete globalThis.__liveSixAutomationMutationProbe
    return { observedCalls: probe.observedCalls, mutations: probe.mutations }
  })
  const concurrentUpdateReceipts = (before, after) => {
    const logPath = path.join(runRoot, 'events.jsonl')
    if (!fs.existsSync(logPath)) throw new Error('Runner has no durable owned cron configuration receipts')
    const lines = fs.readFileSync(logPath, 'utf8').split('\n'); lines.pop()
    const lane = items.find(item => item.kind === 'cron' && item.sessionId === before.sessionId)
    if (!lane) throw new Error('Observed Cron job is not owned by this six-session campaign')
    return verifyStressCronReceiptChain(before, after, lines.filter(Boolean).map(line => JSON.parse(line)),
      { tenantId: 'default', ownerRunId: initial.runId, lane: lane.lane, sessionId: lane.sessionId, jobId: before.id })
  }
  for (const item of items.filter(item => item.kind === 'cron')) {
    guardWorkload()
    const fresh = readManifest().sessions.find(session => session.sessionId === item.sessionId)
    const job = list.find(job => fresh?.jobId ? job.id === fresh.jobId : job.sessionId === item.sessionId)
    if (!job) throw new Error(`Cron session ${item.sessionId} has no actual scheduler job`)
    expect(job.sessionId).toBe(item.sessionId)
    if (job.configuration) expect(job.configuration.target).toEqual({ kind: 'session', sessionId: item.sessionId })
    const row = management.locator('.automation-list-row').filter({ has: page.getByRole('button', { name: `编辑自动化 ${job.name}`, exact: true }) })
    await expect(row).toHaveCount(1)
    expect(await row.getAttribute('data-job-id')).toBe(job.id)
    await expect(row.getByRole('button', { name: `编辑自动化 ${job.name}`, exact: true })).toBeVisible()
    let mutationProbe
    await installMutationProbe(job.id)
    try {
      await click(row.getByRole('button', { name: `编辑自动化 ${job.name}`, exact: true }), 'edit-real-automation')
      const modal = page.getByRole('dialog', { name: '编辑自动化', exact: true })
      const form = modal.locator('.automation-editor__form')
      await expect(modal).toBeVisible(); await expect(form).toBeVisible()
      await expect(form.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(job.name)
      const schedule = job.configuration?.schedule
      if (!schedule || schedule.kind === 'legacy') {
        await expect(form.getByRole('textbox', { name: '时间表达式', exact: true })).toHaveValue(schedule?.expression ?? job.cronExpr)
      } else if (schedule.kind === 'interval') {
        await expect(form.getByRole('spinbutton', { name: '间隔（分钟）', exact: true })).toHaveValue(String(schedule.everyMinutes))
      } else {
        await expect(form.getByLabel('执行时间', { exact: true })).toHaveValue(schedule.localTime)
        await expect(form.getByLabel('时区', { exact: true })).toHaveValue(schedule.timeZone)
      }
      await expect(form.getByRole('button', { name: '自动化聊天方式', exact: true })).toHaveText('复用已有聊天')
      await expect(form.getByRole('textbox', { name: '每次运行的目标', exact: true })).toHaveValue(job.message)
      await action('edit-automation-local-draft', () => form.getByRole('textbox', { name: '名称', exact: true }).fill(`${job.name} · 未保存界面检查`))
      await click(modal.getByRole('button', { name: '取消', exact: true }), 'cancel-automation-edit')
      await expect(modal).toHaveCount(0)
      // This exact read proves the installed invoke wrapper observes the owning bridge.
      await api(`/cron/${encodeURIComponent(job.id)}`)
    } finally { mutationProbe = await finishMutationProbe() }
    expect(mutationProbe.observedCalls).toBeGreaterThan(0)
    expect(mutationProbe.mutations).toEqual([])
    const afterResponse = await api('/cron'), afterList = Array.isArray(afterResponse) ? afterResponse : afterResponse.list ?? []
    const after = afterList.find(candidate => candidate.id === job.id)
    if (!after) throw new Error('Cancelling an automation draft removed the owned scheduler job')
    let updateReceipts = []
    if (after.revision === job.revision) expect(editableFields(after)).toEqual(editableFields(job))
    else await expect.poll(() => {
      guardWorkload()
      try { updateReceipts = concurrentUpdateReceipts(job, after); return true } catch { return false }
    }, { timeout: 3000, message: 'Concurrent driver updates require the complete durable owned revision chain and matching final hash' }).toBe(true)
    result.counters.automationEditCancellations++
    records.push({ sessionId: item.sessionId, jobId: job.id, enabled: job.enabled, lastRunAt: job.lastRunAt ?? null, cronExpr: job.cronExpr,
      configuration: job.configuration ?? null, scheduleRevision: job.scheduleRevision ?? null })
    emit({ type: 'automation-draft-cancel-no-ipc-mutation', jobId: job.id, sessionId: item.sessionId, mutationProbe, beforeRevision: job.revision ?? null,
      afterRevision: after.revision ?? null, beforeEditableSHA256: editableHash(job), afterEditableSHA256: editableHash(after), updateReceipts })
  }
  result.counters.automationVisits++; emit({ type: 'automation-entry-visited', cycle: result.cycle, jobs: records })
}
async function sample(cycleStarted) {
  const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(process => ({ type: process.type, pid: process.pid, cpu: process.cpu, memory: process.memory })))
  const layout = await layoutMetrics(), performanceMetrics = await rendererPerformance(), sample = { at: new Date().toISOString(), cycle: result.cycle, cycleMs: Math.round(performance.now() - cycleStarted), processes, layout, performanceMetrics }
  result.samples.push(sample); emit({ type: 'cycle-sample', ...sample }); save()
}
async function recordFailure(error, context) {
  const record = { at: new Date().toISOString(), cycle: result.cycle, context, message: scrub(error?.stack ?? error) }
  result.failures.push(record); emit({ type: 'client-failure', ...record }); save()
  const performanceMetrics = await rendererPerformance().catch(error => ({ diagnosticError: scrub(error.message) }))
  emit({ type: 'failure-performance', context, performanceMetrics })
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${result.failures.length}.png`), animations: 'disabled' }).catch(() => {})
}
save()
try {
  const environment = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: path.join(profile, 'global') }
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [clientMain, `--user-data-dir=${profile}`], cwd: appRoot, env: environment })
  health = await monitorElectronHealth(app, 'live-six', secrets)
  page = await app.firstWindow(); page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { const event = { at: new Date().toISOString(), message: scrub(error.message), stack: scrub(error.stack) }; result.rendererErrors.push(event); emit({ type: 'renderer-error', ...event }); save() })
  page.on('console', message => { if (message.type() === 'error') { const event = { at: new Date().toISOString(), text: scrub(message.text()) }; result.consoleErrors.push(event); if (result.consoleErrors.length > 500) result.consoleErrors.shift(); emit({ type: 'renderer-console-error', ...event }) } })
  await ready(); subagentProtocol = requireStressSubagentV2(await api('/subagent/capabilities'));
  result.subagentProtocol = subagentProtocol;
  await installStreamProbe(); models = await api('/models')
  await page.evaluate(async ({ items, baseUrl }) => {
    const engine = await window.aether.engine.getSnapshot()
    const source = `remote:${baseUrl}${engine.accountId ? `:account:${engine.accountId}` : ''}`
    const key = `aether.work.state.v1:${encodeURIComponent(source)}`
    const tasks = items.filter(item => item.kind !== 'code').map(item => ({ id: item.sessionId, title: item.clientTitle, draft: '', status: 'running', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: item.workspacePath, modelId: item.currentModelId ?? item.modelId, agentId: item.agentId, agentLocked: true, attachments: [], sources: [], mentions: [], resources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: null, homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    localStorage.setItem('aether.app.mode', 'code')
    localStorage.setItem('aether.ide.layout', JSON.stringify({ sidebarVisible: true, sidebarWidth: 250, chatPanelVisible: true, chatPanelWidth: 560, panelVisible: false }))
  }, { items, baseUrl })
  await reload('load-isolated-work-import')
  emit({ type: 'observer-started', profile, deadline: initial.deadline, sessions: items.map(item => ({ sessionId: item.sessionId, kind: item.kind })) })
  let consecutiveCycleFailures = 0
  while (!stopped && Date.now() < deadline) {
    if (fs.existsSync(path.join(runRoot, 'STOP'))) throw new Error('Owned workload STOP invalidated observation; see supervisor evidence')
    const cycleStarted = performance.now(), wallStarted = Date.now(), backend = readManifest()
    if (Date.now() >= deadline) break
    if (backend.runId !== initial.runId || backend.baseUrl.replace(/\/+$/, '') !== baseUrl) throw new Error('Runner identity changed during observation')
    if (backend.phase !== 'active') throw new Error(`Runner left its actual workload phase: ${backend.phase}`)
    if (JSON.stringify(fingerprint()) !== JSON.stringify(buildFingerprint)) throw new Error('The observed application build changed during the run')
    if (['failed', 'stopped'].includes(backend.status)) throw new Error(`Real runner became ${backend.status}; see workload evidence`)
    if (backend.status === 'completed' && Date.now() < deadline) throw new Error('Runner completed before the declared actual workload deadline')
    result.cycle++
    const dimensions = [[1440, 900], [1100, 760], [940, 640]][(result.cycle - 1) % 3]
    expectedViewport = { width: dimensions[0], height: dimensions[1] }
    await app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(...dimensions), dimensions)
    await expect.poll(async () => page.evaluate(([width, height]) =>
      Math.max(Math.abs(innerWidth - width), Math.abs(innerHeight - height)), dimensions),
    { message: 'Actual content viewport must stay within native frame rounding of the requested dimensions' }).toBeLessThanOrEqual(2)
    let failedCycle = false
    for (const item of items) {
      if (stopped || Date.now() >= deadline) break
      try { guardWorkload(); await visit(item) }
      catch (error) {
        if (error instanceof ObserverCutoff || Date.now() >= deadline) { emit({ type: 'runner-cutoff-overlapped-ui-cycle', sessionId: item.sessionId, message: scrub(error.message) }); break }
        failedCycle = true; await recordFailure(error, `session:${item.sessionId}`); if (page.isClosed()) throw error; await reload('recover-observer-page')
      }
    }
    if (!stopped && Date.now() < deadline) try { guardWorkload(); await inspectAutomation() }
    catch (error) {
      if (error instanceof ObserverCutoff || Date.now() >= deadline) emit({ type: 'runner-cutoff-overlapped-automation', message: scrub(error.message) })
      else { failedCycle = true; await recordFailure(error, 'automation-entry'); await reload('recover-automation-page') }
    }
    health.assertHealthy()
    await sample(cycleStarted)
    consecutiveCycleFailures = failedCycle ? consecutiveCycleFailures + 1 : 0
    if (consecutiveCycleFailures >= 3) throw new Error('Three consecutive UI cycles failed; workload runner remains independently active')
    if (result.rendererErrors.length) throw new Error('Renderer emitted an uncaught page error')
    if (result.consoleErrors.length) throw new Error('Renderer emitted a console error during active observation')
    const wait = Math.min(targetIntervalMs - (Date.now() - wallStarted), deadline - Date.now())
    if (wait > 0) await delay(wait)
  }
  if (stopped) throw new Error('Observer interrupted before the live workload deadline')
  if (fs.existsSync(path.join(runRoot, 'STOP'))) throw new Error('Owned workload STOP invalidated final observation acceptance')
  result.deadlineReached = Date.now() >= deadline
  for (const [id, stats] of Object.entries(result.sessions)) {
    if (!stats.visits || !stats.activeVisits || !stats.completedVisits) throw new Error(`Session ${id} lacks actual UI visits in both active and completed states`)
    if (!stats.planVisits || !stats.toolDetailVisits || !stats.childDetailVisits || !stats.childIdsSeen.length) throw new Error(`Session ${id} lacks its own plan, tool-result or child-detail UI evidence`)
    if (new Set(stats.actualModelIdsSeen).size < 2) throw new Error(`Session ${id} lacks confirmed actual receipts for both execution models`)
    for (const required of initial.requiredActualModelIds ?? []) if (!stats.actualModelIdsSeen.includes(required)) throw new Error(`Session ${id} lacks confirmed actual receipt for required model ${required}`)
  }
  if (!result.counters.automationVisits || !result.counters.automationEditCancellations || !result.counters.childDetailVisits || !result.counters.toolDetailVisits || !result.counters.planVisits) throw new Error('Missing actual automation edit/cancel, child, tool-result or task-plan interaction evidence')
  const transcriptReasons = workTranscriptCoverageReasons(items, result.sessions, initial.startedAt, initial.deadline)
  if (transcriptReasons.length) throw new Error(transcriptReasons.join('; '))
  const observedModels = new Set(Object.values(result.sessions).flatMap(session => session.modelIdsSeen))
  if (observedModels.size < 2) throw new Error('Client did not observe at least two actual configured models')
  const actualModels = new Set(Object.values(result.sessions).flatMap(session => session.actualModelIdsSeen))
  result.actualModelIdsSeen = [...actualModels]
  if (actualModels.size < 2) throw new Error('Client did not observe at least two confirmed actual execution models in server-owned run receipts')
  for (const required of initial.requiredActualModelIds ?? []) if (!actualModels.has(required)) throw new Error(`No confirmed actual execution receipt for required model ${required}`)
  if (result.failures.length) throw new Error(`Client recorded ${result.failures.length} unreconciled failures; retries do not erase them`)
  if (result.consoleErrors.length) throw new Error(`Renderer recorded ${result.consoleErrors.length} console errors; inspect the retained event log`)
  if (result.responsiveness.some(entry => !entry.cutoffOverlap && entry.ms > maxActionMs)) throw new Error(`UI actions exceeded the declared ${maxActionMs}ms response threshold`)
  result.finalBuildFingerprint = fingerprint()
  if (JSON.stringify(result.finalBuildFingerprint) !== JSON.stringify(buildFingerprint)) throw new Error('The frozen application build changed before final acceptance')
  result.passed = true
} catch (error) {
  await recordFailure(error, 'observer')
} finally {
  if (health) try {
    await health.closeAndAssert({ outputPath: name => path.join(output, name), attach: async () => {} })
    result.nativeHealthPath = path.join(output, 'electron-health-live-six.json')
  } catch (error) { result.passed = false; await recordFailure(error, 'electron-health') }
  else await app?.close().catch(error => { result.passed = false; result.closeError = scrub(error) })
  if (result.rendererErrors.length || result.consoleErrors.length || result.failures.length) result.passed = false
  result.finishedAt = new Date().toISOString(); result.elapsedSeconds = (Date.now() - startedAt) / 1000
  result.status = result.passed ? 'completed' : stopped ? 'stopped' : 'failed'
  const durations = result.responsiveness.filter(action => !action.cutoffOverlap).map(action => action.ms).sort((a, b) => a - b)
  result.actionLatency = { count: durations.length, cutoffOverlaps: result.responsiveness.filter(action => action.cutoffOverlap).length, maxMs: durations.at(-1) ?? 0, p95Ms: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0, overThreshold: durations.filter(ms => ms > maxActionMs).length, thresholdMs: maxActionMs }
  result.finalRunnerStatus = (() => { try { return readManifest().status } catch { return 'unreadable' } })()
  result.durationEvidence = 'This observer deadline is not proof that AI tasks continuously ran. Main runner SSE, turn histories, disk side effects and real cron triggers must independently establish the entire declared workload duration.'
  save()
  fs.writeFileSync(path.join(runRoot, `client-live-six-acceptance-${path.basename(output)}.json`), scrub(JSON.stringify({ passed: result.passed, status: result.status, startedAt: result.startedAt, finishedAt: result.finishedAt, elapsedSeconds: result.elapsedSeconds, output, counters: result.counters, rendererErrors: result.rendererErrors.length, failures: result.failures.length, actionLatency: result.actionLatency, scope: result.scope, durationEvidence: result.durationEvidence }, null, 2)))
  console.log(JSON.stringify({ passed: result.passed, status: result.status, output, cycle: result.cycle, counters: result.counters, failures: result.failures.length }))
  if (!result.passed) process.exitCode = 1
}
