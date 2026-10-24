/** Import-only adapter for an existing owned office runner. Never launches an app. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ROLES = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance']
const ACTIVE_ROLES = ['finance', 'people', 'sales', 'operations', 'compliance']
const REPORT_LABEL = '五角色应用并发、六会话切换'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const cut = (text, limit = 240) => String(text ?? '').slice(0, limit)
const statusMap = { preparing: 'running', running: 'running', waiting: 'waiting', cancelling: 'running',
  succeeded: 'done', failed: 'error', cancelled: 'stopped', interrupted: 'interrupted' }

export function summarizeNumbers(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
    max: sorted.length ? sorted.at(-1) : null, over34: sorted.filter(value => value > 34).length }
}

export function rendererMeasurementComplete(data) {
  return Boolean(data && data.elapsedMs >= 89500 && !data.everHidden
    && !data.visibility.some(sample => sample.hidden) && data.longTaskSupported
    && !data.dropped?.frames && !data.dropped?.heaps
    && data.frames.some(sample => !sample.hidden && Number.isFinite(sample.interval))
    && data.heaps.some(sample => !sample.hidden && Number.isFinite(sample.usedJSHeapSize)))
}

// G2 waits for PMO to finish before admitting the five application roles.
// Keep that completed root in the isolation checks without demanding impossible
// six-root concurrency or substituting historical active child rows for roots.
export function assessRootActivity(visits, samples, pinned, expectedActiveRoles) {
  assert.deepEqual([...expectedActiveRoles].sort(), [...ACTIVE_ROLES].sort(), 'This phase requires exactly the five application roles')
  const exact = (role, value) => value?.run?.runId === pinned[role]?.runId && value?.run?.sessionId === pinned[role]?.sessionId
  const running = (role, value) => exact(role, value) && value.running === true && ['preparing', 'running'].includes(value.run.status)
  const completed = (role, value) => exact(role, value) && value.running === false && value.run.status === 'succeeded'
  const runningRoles = ROLES.filter(role => visits.some(visit => visit.role === role && [visit.apiBefore, visit.apiAfter].every(value => running(role, value))))
  const observedRunningRoles = ROLES.filter(role => visits.some(visit => visit.role === role && [visit.apiBefore, visit.apiAfter].some(value => running(role, value)))
    || samples.some(sample => running(role, sample.roots[role])))
  const batchRunningRoles = samples.map(sample => ROLES.filter(role => running(role, sample.roots[role])))
  const pmoVisits = visits.filter(visit => visit.role === 'pmo')
  const completedPmoVerified = pmoVisits.length > 0 && pmoVisits.every(visit => [visit.apiBefore, visit.apiAfter].every(value => completed('pmo', value)))
    && samples.every(sample => completed('pmo', sample.roots.pmo))
  const missingActiveRoles = expectedActiveRoles.filter(role => !runningRoles.includes(role))
  const fiveRoleBatchObserved = batchRunningRoles.some(roles => expectedActiveRoles.every(role => roles.includes(role)))
  return { expectedActiveRoles: [...expectedActiveRoles], expectedCompletedRoles: ['pmo'], runningRoles, observedRunningRoles,
    missingActiveRoles, completedPmoVerified, fiveRoleBatchObserved,
    peak: batchRunningRoles.length ? Math.max(...batchRunningRoles.map(roles => roles.length)) : null,
    peakBasis: 'Maximum running root count within fresh bounded API batches; each batch is non-atomic.',
    complete: missingActiveRoles.length === 0 && completedPmoVerified && fiveRoleBatchObserved }
}

export function classifyOfficeUiLoadReport(report) {
  const uncertainChecks = ['currentRootMessageVisible', 'childrenMembershipVerified', 'rootStatusCorresponds', 'headingStatusCorresponds', 'childLatestStatusAndModelCorrespond']
  if (report.errors.length || report.visits.some(visit => Object.entries(visit.checks).some(([key, value]) => value === false && !uncertainChecks.includes(key)))) return 'failed'
  if (!report.performance?.measurementComplete || !report.performance?.longTaskSupported
    || report.visits.some(visit => Object.values(visit.checks).some(value => value !== true))
    || report.coverage.rolesVisitedTwice.length !== 6 || report.coverage.rolesWithChildRows.length !== 6
    || !report.coverage.rootActivity.complete || !report.coverage.stablePairsCompared
    || !report.coverage.activeRowsObserved || !report.coverage.completedRowsObserved) return 'incomplete'
  return 'passed'
}

// Compare only persistent members of the same section: completion, resumption,
// insertion and bounded pagination are legitimate reasons for membership change.
export function compareStableRows(before, after) {
  const duplicates = after.filter((row, index) => after.findIndex(other => other.id === row.id) !== index).map(row => row.id)
  const reordered = []
  let comparedPairs = 0
  for (const group of ['active', 'completed']) {
    const common = new Set(before.filter(row => row.group === group && after.some(next => next.id === row.id && next.group === group)).map(row => row.id))
    const a = before.filter(row => row.group === group && common.has(row.id)).map(row => row.id)
    const b = after.filter(row => row.group === group && common.has(row.id)).map(row => row.id)
    comparedPairs += common.size * (common.size - 1) / 2
    if (a.join('\0') !== b.join('\0')) reordered.push({ group, before: a, after: b })
  }
  return { stable: !duplicates.length && !reordered.length, duplicates, reordered, comparedPairs }
}

function deadline(promise, milliseconds = 6000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bounded UI observation timed out')), milliseconds) })])
    .finally(() => clearTimeout(timer))
}

// Runs in the renderer. All observers/timers have a hard lifetime and bounded
// samples; no global prototypes, app stores or browser surfaces are modified.
function installRendererProbe({ key, durationMs }) {
  if (window[key]) throw new Error('A renderer observation already owns this key')
  const started = performance.now(), caps = { frames: 18000, longTasks: 1024, heaps: 100, visibility: 128 }
  const data = { started, durationMs, caps, frames: [], longTasks: [], heaps: [], visibility: [],
    dropped: { frames: 0, longTasks: 0, heaps: 0, visibility: 0 }, errors: [],
    longTaskCount: 0, longTaskMaxMs: 0, longTaskTotalMs: 0, hiddenLongTaskCount: 0,
    visibleLongTaskCount: 0, visibleLongTaskMaxMs: 0, longTaskSupported: false,
    everHidden: document.hidden, stopped: false }
  const add = (name, value) => { if (data[name].length < caps[name]) data[name].push(value); else data.dropped[name]++ }
  const visibility = () => { data.everHidden ||= document.hidden;
    add('visibility', { at: performance.now() - started, hidden: document.hidden, focused: document.hasFocus() }) }
  const heap = () => { const memory = performance.memory; add('heaps', { at: performance.now() - started,
    hidden: document.hidden, focused: document.hasFocus(), usedJSHeapSize: memory?.usedJSHeapSize ?? null,
    totalJSHeapSize: memory?.totalJSHeapSize ?? null, jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null }) }
  let observer, raf, interval, timer, last, wasHidden = document.hidden
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.startTime >= started) {
          const hidden = document.hidden
          data.longTaskCount++; data.longTaskTotalMs += entry.duration; data.longTaskMaxMs = Math.max(data.longTaskMaxMs, entry.duration)
          if (hidden) data.hiddenLongTaskCount++
          else { data.visibleLongTaskCount++; data.visibleLongTaskMaxMs = Math.max(data.visibleLongTaskMaxMs, entry.duration) }
          add('longTasks', { at: entry.startTime - started, duration: entry.duration, hidden })
        }
      })
      observer.observe({ type: 'longtask', buffered: false }); data.longTaskSupported = true
    }
  } catch (error) { data.errors.push(String(error).slice(0, 240)) }
  const tick = now => {
    if (data.stopped) return
    if (last !== undefined) add('frames', { at: now - started, interval: now - last, hidden: document.hidden || wasHidden })
    last = now; wasHidden = document.hidden; raf = requestAnimationFrame(tick)
  }
  const stop = reason => {
    if (data.stopped) return data
    data.stopped = true; data.stopReason = reason; data.elapsedMs = performance.now() - started
    cancelAnimationFrame(raf); clearInterval(interval); clearTimeout(timer); observer?.disconnect()
    document.removeEventListener('visibilitychange', visibility); heap(); visibility()
    return data
  }
  window[key] = { data, stop }
  document.addEventListener('visibilitychange', visibility)
  visibility(); heap(); raf = requestAnimationFrame(tick); interval = setInterval(heap, 1000)
  timer = setTimeout(() => stop('automatic-90-second-deadline'), durationMs)
  return { started, caps, visibility: document.visibilityState, supported: data.longTaskSupported }
}

async function workStore(c, key) {
  return deadline(c.page.evaluate(({ key, ids }) => {
    const pick = value => ({ activeTaskId: value.activeTaskId, tasks: value.tasks.filter(task => ids.includes(task.id)).map(task => ({
      id: task.id, title: task.title, status: task.status, agentId: task.agentId, modelId: task.modelId, workspacePath: task.workspacePath })) })
    if (key) { const text = localStorage.getItem(key); if (!text || text.length > 4 * 1024 * 1024) throw new Error('Work state missing/oversized'); return { key, ...pick(JSON.parse(text)) } }
    const matches = []
    for (let index = 0; index < Math.min(localStorage.length, 1024); index++) {
      const name = localStorage.key(index)
      if (!name?.startsWith('aether.work.state.v1')) continue
      const text = localStorage.getItem(name)
      if (!text || text.length > 4 * 1024 * 1024) continue
      const value = JSON.parse(text)
      if (Array.isArray(value.tasks) && ids.every(id => value.tasks.some(task => task.id === id))) matches.push({ key: name, ...pick(value) })
    }
    if (matches.length !== 1) throw new Error('Expected exactly one Work namespace containing all six owned tasks')
    return matches[0]
  }, { key, ids: ROLES.map(role => c.state.roles[role].sessionId) }))
}

async function rootStatus(c, role, expectedEngine) {
  const value = await deadline(c.page.evaluate(async ({ sessionId, expectedEngine }) => {
    const response = await window.aether.engine.request({ method: 'GET', path: '/chat/status',
      query: { sessionId }, expectedEngine, toolProfile: 'general' })
    if (!response.ok) throw new Error('Root status request rejected: ' + response.code)
    return response.data
  }, { sessionId: c.state.roles[role].sessionId, expectedEngine })), run = value.run
  return { sessionId: c.state.roles[role].sessionId, running: value.running, finished: value.finished,
    run: run ? { runId: run.runId, sessionId: run.sessionId, turnId: run.turnId, status: run.status,
      seq: run.seq, version: run.version, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId,
      modelId: run.actualModelId ?? run.modelId, updatedAt: run.updatedAt } : null }
}

async function childSummary(c, sessionId, expectedEngine) {
  return deadline(c.page.evaluate(async ({ sessionId, expectedEngine }) => {
    const response = await window.aether.engine.request({ method: 'GET', path: '/subagent/runs',
      query: { parentSessionId: sessionId, view: 'summary', limit: 64 }, subagentProtocol: 2, expectedEngine, toolProfile: 'general' })
    if (!response.ok) return { error: { code: response.code, message: String(response.message).slice(0, 160) } }
    const value = response.data
    if (value?.schemaVersion !== 2 || !Array.isArray(value.runs)) return { error: { code: 'unexpected-summary-protocol' } }
    return { schemaVersion: value.schemaVersion, revision: value.revision, hasMore: value.hasMore, listComplete: value.listComplete,
      returnedCount: value.runs.length, rows: value.runs.slice(0, 64).map(run => ({ runId: run.runId,
        parentSessionId: run.parentSessionId, rootSessionId: run.rootSessionId, childSessionId: run.childSessionId,
        status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, modelId: run.modelId,
        toolCount: run.toolCount, activeToolCount: run.activeToolCount })) }
  }, { sessionId, expectedEngine }))
}

async function captureDom(c) {
  return deadline(c.page.evaluate(() => {
    const work = document.querySelector('#mode-work'), panel = work?.querySelector('#work-panel-subagents')
    const visible = element => Boolean(element && !element.closest('[hidden]') && getComputedStyle(element).visibility !== 'hidden'
      && element.getBoundingClientRect().width && element.getBoundingClientRect().height)
    const rows = [...(panel?.querySelectorAll('.work-subagents__row') ?? [])].filter(visible)
    const groupNames = { '正在运行的子代理': 'active', '已结束的子代理': 'completed' }
    const groups = [...(panel?.querySelectorAll('.work-subagents__group') ?? [])].map(element => ({
      name: groupNames[element.getAttribute('aria-label')] ?? 'unknown', visible: visible(element), top: element.getBoundingClientRect().top }))
    const status = work?.querySelector('.work-task-heading .work-status')
    const feedback = [...(work?.querySelectorAll('[data-current-run-feedback="true"]') ?? [])].filter(visible).slice(0, 2)
    return { at: Date.now(), hidden: document.hidden, focused: document.hasFocus(), workVisible: work?.getAttribute('aria-hidden') === 'false',
      heading: work?.querySelector('.work-task-heading h1')?.getAttribute('title'),
      workspace: work?.querySelector('.work-task-heading__project')?.getAttribute('title'),
      headingStatusClass: status?.className, headingStatusText: status?.textContent?.slice(0, 60),
      currentFeedback: feedback.map(element => ({ phase: element.dataset.phase, state: element.dataset.state })),
      messageIds: [...(work?.querySelectorAll('.work-message[data-message-id]') ?? [])].filter(visible).slice(-128).map(element => element.dataset.messageId),
      groups, panelVisible: visible(panel), rowCount: rows.length,
      rows: rows.slice(0, 64).map(element => ({ id: element.dataset.childSessionId, status: element.dataset.agentStatus,
        group: groupNames[element.closest('.work-subagents__group')?.getAttribute('aria-label')] ?? 'unknown',
        modelId: element.dataset.modelId ?? null, toolCount: element.dataset.toolCount, activeToolCount: element.dataset.activeToolCount,
        pending: element.dataset.pending, top: element.getBoundingClientRect().top })),
      alertCount: [...(work?.querySelectorAll('[role="alert"]') ?? [])].filter(visible).length }
  }))
}

/** Synchronous lease admission precedes asynchronous reads. New queued UI work
 * waits for release instead of becoming a failed command or stealing selection. */
export function startOfficeUiLoadProbe(c, options) {
  assert.deepEqual(options.expectedActiveRoles?.slice().sort(), [...ACTIVE_ROLES].sort(), 'Explicitly configure the five active application roles')
  const expectedActiveRoles = [...options.expectedActiveRoles]
  assert.ok(c?.app && c.page && c.state?.runRoot, 'An already-owned office runner is required')
  assert.equal(realpathSync(c.state.runRoot), realpathSync(options.expectedRoot), 'Owned campaign root differs')
  assert.ok(!c.uiLoadProbePromise && !c.contextProbePromise, 'Another owned probe is active')
  assert.deepEqual(Object.keys(options.requiredSubmissionIds).sort(), [...ROLES].sort(), 'Pin all six exact stage IDs')
  assert.equal(new Set(Object.values(options.requiredSubmissionIds)).size, 6, 'Pin six distinct stage IDs')
  assert.ok(typeof c.state.evidenceRoot === 'string' && c.state.evidenceRoot, 'An existing evidence directory is required')
  const evidenceRoot = realpathSync(c.state.evidenceRoot)
  const pinned = Object.fromEntries(ROLES.map(role => {
    const owner = c.state.roles[role]
    const record = owner.submissions.find(item => item.id === options.requiredSubmissionIds[role])
    const run = record?.actualAdmittedRun, receipt = run?.serverAdmissionReceipt
    assert.ok(record?.phase === 'admitted' && run?.runId === record.runId && receipt?.rootRunId === record.runId
      && run.sessionId === owner.sessionId && receipt.sessionId === owner.sessionId, role + ' stage has not actually been admitted')
    return [role, { sessionId: owner.sessionId, runId: record.runId, submissionId: record.id }]
  }))
  assert.equal(new Set(Object.values(pinned).map(item => item.sessionId)).size, 6)
  assert.equal(new Set(Object.values(pinned).map(item => item.runId)).size, 6, 'Pin six distinct real roots')
  const queueFile = join(c.state.runRoot, 'commands.json')
  const initialQueue = readFileSync(queueFile), queueHash = sha(initialQueue)
  const queue = JSON.parse(initialQueue).commands
  assert.ok(Array.isArray(queue) && queue.every(command => c.state.commands?.some(record => record.id === command.id && ['completed', 'failed'].includes(record.status))),
    'Drain every queued command before observing the UI; historical failures remain evidence')
  assert.ok(Object.values(options.requiredSubmissionIds).every(id => c.state.commands?.some(record => record.id === id && record.status === 'completed')),
    'All six pinned stage commands must have completed successful admission')
  assert.ok(!(c.state.commands || []).some(record => ['started', 'processing'].includes(record.status)), 'A runner command still owns UI admission')
  const expectedEngine = { ...options.expectedEngine }
  assert.ok(expectedEngine.instanceId && expectedEngine.instanceId === options.expectedInstanceId, 'Pin a fresh live engine snapshot and its instance')
  const previousRunnerInstanceId = c.state.engine?.instanceId
  const originalMethods = Object.fromEntries(['submit', 'createAndStart', 'selectTask'].map(name => [name, c[name]]))
  assert.ok(Object.values(originalMethods).every(method => typeof method === 'function'))
  const lease = { id: randomUUID(), active: true, contender: false }
  let release
  const released = new Promise(resolve => { release = resolve })
  const wrappers = {}
  for (const [name, original] of Object.entries(originalMethods)) {
    wrappers[name] = async (...args) => { lease.contender = true; await released; return original.apply(c, args) }
    c[name] = wrappers[name]
  }
  const guard = () => {
    assert.ok(lease.active && !lease.contender, 'New runner UI work is waiting; returning control')
    assert.equal(sha(readFileSync(queueFile)), queueHash, 'Queue changed; stop before competing with admission')
    assert.ok(!(c.state.commands || []).some(record => ['started', 'processing'].includes(record.status)), 'Runner admission resumed')
    assert.equal(c.state.engine?.instanceId, previousRunnerInstanceId, 'Runner engine binding changed')
  }
  const output = join(evidenceRoot, 'ui-load-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + lease.id.slice(0, 8))
  const control = { accepted: true, label: REPORT_LABEL, output, durationMs: 90000, pinned, expectedActiveRoles,
    expectedCompletedRoles: ['pmo'], queueSha256: queueHash, runnerPid: process.pid }
  c.uiLoadProbePromise = Promise.resolve().then(async () => {
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(), engine: expectedEngine, pinned, queueSha256: queueHash,
      label: REPORT_LABEL, expectedActiveRoles, expectedCompletedRoles: ['pmo'],
      durationMs: 90000, visits: [], rootActivitySamples: [], errors: [], screenshots: [], limitations: [
        'This only observes the existing renderer; rAF gaps are scheduling proxies, not INP or presented-frame timing.',
        'Heap is renderer JS heap, not total Electron/engine memory; heap support and hidden periods are reported explicitly.',
        'Child API pages and rendered rows are bounded to 64; missing off-page children remain unverified.',
        'Live API and DOM are bracketed observations, not one atomic snapshot. No business acceptance or OS isolation claim.',
        'PMO is expected completed before the five application roots start. Peak uses fresh non-atomic API batches, never six-root concurrency.' ] }
    let store, restore, probeKey, rendererData, last = new Map(), ownedMessageIds = new Map()
    const statusCache = {}
    const persist = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
    const sampleRoots = async () => {
      guard()
      const startedAt = Date.now()
      const entries = await Promise.all(ROLES.map(async role => [role, await rootStatus(c, role, expectedEngine)]))
      guard()
      for (const [role, value] of entries) {
        assert.equal(value.run?.runId, pinned[role].runId, role + ' latest API root differs from stage admission')
        assert.equal(value.run?.sessionId, pinned[role].sessionId, role + ' latest API session differs from stage admission')
        statusCache[role] = value
      }
      report.rootActivitySamples.push({ startedAt, finishedAt: Date.now(), roots: Object.fromEntries(entries) })
      assert.ok(statusCache.pmo.running === false && statusCache.pmo.run.status === 'succeeded', 'G2 requires the pinned PMO root to remain completed')
    }
    const select = async role => {
      guard()
      const current = await workStore(c, store.key), task = current.tasks.find(task => task.id === pinned[role].sessionId)
      const match = await deadline(c.page.locator('#mode-work .work-sidebar__task').evaluateAll((buttons, title) => {
        const indexes = buttons.flatMap((button, index) => button.querySelector('span')?.textContent === title ? [index] : [])
        return { indexes }
      }, task.title))
      assert.equal(match.indexes.length, 1, 'Current UI must expose exactly one sidebar button for ' + role)
      guard(); await c.page.locator('#mode-work .work-sidebar__task').nth(match.indexes[0]).click({ timeout: 2500 })
      const until = Date.now() + 5000
      for (;;) {
        guard()
        const selected = await workStore(c, store.key), dom = await captureDom(c)
        if (selected.activeTaskId === task.id && dom.heading === task.title) break
        if (Date.now() >= until) throw new Error('Task selection failed to settle for ' + role)
        await delay(150)
      }
    }
    try {
      guard(); mkdirSync(output, { recursive: false })
      const actualEngine = await deadline(c.page.evaluate(() => window.aether.engine.getSnapshot()))
      assert.equal(actualEngine.instanceId, expectedEngine.instanceId)
      report.engine = { ...expectedEngine, buildId: actualEngine.buildId, phase: actualEngine.phase }
      assert.equal(actualEngine.phase, 'ready')
      store = await workStore(c)
      assert.equal(store.tasks.length, 6)
      assert.ok(Object.values(pinned).some(item => item.sessionId === store.activeTaskId), 'An owned Work task must already be selected')
      restore = await deadline(c.page.evaluate(() => ({ tab: document.querySelector('#mode-work .work-workspace__tabs [aria-selected="true"]')?.id,
        workspaceOpen: document.querySelector('#mode-work .work-task-heading [aria-label="收起工作区"]')?.getAttribute('aria-pressed') === 'true',
        hidden: document.hidden, workVisible: document.querySelector('#mode-work')?.getAttribute('aria-hidden') === 'false' })))
      assert.ok(restore.workVisible && !restore.hidden, 'The existing Work renderer must be visible; this helper never opens or foregrounds windows')
      report.initialTaskId = store.activeTaskId; report.initialView = restore
      await sampleRoots()
      probeKey = '__officeUiLoadProbe_' + lease.id.replaceAll('-', '')
      guard(); report.probe = await deadline(c.page.evaluate(installRendererProbe, { key: probeKey, durationMs: 90000 }))
      const started = Date.now(), end = started + 90000
      for (let index = 0; Date.now() < end && index < 24; index++) {
        const visitStarted = Date.now(), role = ROLES[index % 6]
        guard(); const before = await rootStatus(c, role, expectedEngine)
        assert.equal(before.run?.runId, pinned[role].runId, 'Root changed during observation')
        await select(role)
        guard(); await c.page.locator('#mode-work .work-conversation__toolbar').getByRole('button', { name: '子代理', exact: true }).click({ timeout: 2500 })
        const back = c.page.locator('#work-panel-subagents').getByRole('button', { name: '返回子代理列表', exact: true })
        if (await back.isVisible()) { guard(); await back.click({ timeout: 2500 }) }
        const childBefore = await childSummary(c, pinned[role].sessionId, expectedEngine)
        await delay(250)
        guard(); const ui = await captureDom(c), selected = await workStore(c, store.key)
        const after = await rootStatus(c, role, expectedEngine), childAfter = await childSummary(c, pinned[role].sessionId, expectedEngine)
        statusCache[role] = after
        const task = selected.tasks.find(task => task.id === pinned[role].sessionId)
        const baseline = store.tasks.find(item => item.id === task.id)
        const rootExpected = [before, after].map(value => statusMap[value.run?.status]).filter(Boolean)
        const foreign = ui.messageIds.filter(id => Object.entries(statusCache).some(([owner, value]) => owner !== role && [value.run?.userMessageId, value.run?.assistantMessageId].includes(id))
          || (ownedMessageIds.has(id) && ownedMessageIds.get(id) !== role))
        for (const id of ui.messageIds) if (!ownedMessageIds.has(id)) ownedMessageIds.set(id, role)
        const childRows = [...(childBefore.rows ?? []), ...(childAfter.rows ?? [])]
        const unknownChildren = ui.rows.filter(row => !childRows.some(run => run.childSessionId === row.id)).map(row => row.id)
        const crossOwnedChildren = childRows.filter(run => run.parentSessionId !== pinned[role].sessionId).map(run => run.childSessionId)
        const latestPerChild = page => {
          const latest = new Map()
          for (const run of page.rows ?? []) if (!latest.has(run.childSessionId) || run.createdAt > latest.get(run.childSessionId).createdAt) latest.set(run.childSessionId, run)
          return latest
        }
        const childLatestBefore = latestPerChild(childBefore), childLatestAfter = latestPerChild(childAfter)
        const childStatusMismatches = ui.rows.filter(row => {
          const candidates = [childLatestBefore.get(row.id), childLatestAfter.get(row.id)].filter(Boolean)
          return candidates.length && !candidates.some(run => run.status === row.status && (!row.modelId || run.modelId === row.modelId))
        }).map(row => ({ id: row.id, uiStatus: row.status, uiModelId: row.modelId,
          before: childLatestBefore.get(row.id), after: childLatestAfter.get(row.id) }))
        const stable = compareStableRows(last.get(role) ?? [], ui.rows); last.set(role, ui.rows)
        const visit = { role, index, elapsedMs: Date.now() - visitStarted, selectedTask: task, apiBefore: before, apiAfter: after,
          childrenBefore: childBefore, childrenAfter: childAfter, ui, stable,
          checks: { selectedTaskMatches: selected.activeTaskId === task.id && ui.heading === task.title,
            workAndPanelVisible: ui.workVisible && ui.panelVisible && !ui.hidden,
            workspaceCorresponds: (ui.workspace ?? null) === (task.workspacePath ?? null),
            bindingUnchanged: ['modelId', 'agentId', 'workspacePath'].every(key => task[key] === baseline[key]),
            rootIdentityMatches: [before, after].every(value => value.run?.runId === pinned[role].runId && value.run?.sessionId === pinned[role].sessionId),
            expectedCompletedRootState: role !== 'pmo' || [before, after].every(value => value.running === false && value.run?.status === 'succeeded'),
            rootStatusCorresponds: rootExpected.length ? rootExpected.includes(task.status) : null,
            headingStatusCorresponds: rootExpected.length ? rootExpected.some(status => ui.headingStatusClass?.split(' ').includes('work-status--' + status)) : null,
            currentRootMessageVisible: ui.messageIds.some(id => [after.run?.userMessageId, after.run?.assistantMessageId].includes(id)),
            noForeignVisibleMessages: foreign.length === 0, noCrossOwnedApiChildren: crossOwnedChildren.length === 0,
            childOrderStable: stable.stable, groupsInFixedOrder: !ui.rows.length || ui.groups.map(group => group.name).join(',') === 'active,completed',
            childrenMembershipVerified: !childBefore.error && !childAfter.error && unknownChildren.length === 0,
            childLatestStatusAndModelCorrespond: !childBefore.error && !childAfter.error && childStatusMismatches.length === 0 },
          foreignMessageIds: foreign, unknownChildren, crossOwnedChildren, childStatusMismatches }
        report.visits.push(visit)
        if (index < 6) {
          guard(); const name = String(index + 1).padStart(2, '0') + '-' + role + '.png'
          await c.page.screenshot({ path: join(output, name), timeout: 5000 }); report.screenshots.push(name)
        }
        if ((index + 1) % 6 === 0) await sampleRoots()
        persist()
        // Poll only local ownership while resting; no repeated API/full-log scans.
        const nextAt = Math.min(visitStarted + 5000, end)
        while (Date.now() < nextAt) { guard(); await delay(Math.min(250, nextAt - Date.now())) }
      }
      while (Date.now() < end) { guard(); await delay(Math.min(250, end - Date.now())) }
    } catch (error) { report.errors.push(cut(error?.message || error)); report.aborted = true }
    finally {
      if (probeKey) {
        try { rendererData = await deadline(c.page.evaluate(key => { const probe = window[key]; if (!probe) return null;
          const data = probe.stop('controller-finally'); delete window[key]; return data }, probeKey)) }
        catch (error) { report.errors.push('Probe cleanup: ' + cut(error.message)); report.rendererCleanupPendingAutomaticDeadline = true }
      }
      if (rendererData) {
        report.performance = { ...rendererData, rafVisibleMs: summarizeNumbers(rendererData.frames.filter(frame => !frame.hidden).map(frame => frame.interval)),
          rafHiddenMs: summarizeNumbers(rendererData.frames.filter(frame => frame.hidden).map(frame => frame.interval)),
          heapUsedBytes: summarizeNumbers(rendererData.heaps.map(sample => sample.usedJSHeapSize)),
          measurementComplete: rendererMeasurementComplete(rendererData) }
      }
      let canRestore = false
      try { canRestore = restore && store && !lease.contender && sha(readFileSync(queueFile)) === queueHash }
      catch (error) { report.errors.push('Restore ownership check: ' + cut(error.message)) }
      if (canRestore) {
        try {
          const role = ROLES.find(role => pinned[role].sessionId === store.activeTaskId)
          await select(role)
          if (restore.workspaceOpen && restore.tab) { guard(); await c.page.locator('#' + restore.tab).click({ timeout: 2500 }) }
          if (!restore.workspaceOpen) { const button = c.page.getByRole('button', { name: '收起工作区', exact: true });
            if (await button.isVisible()) { guard(); await button.click({ timeout: 2500 }) } }
          report.selectionRestored = true
        } catch (error) { report.errors.push('Selection restore: ' + cut(error.message)) }
      }
      report.finishedAt = new Date().toISOString()
      report.coverage = { rolesVisitedTwice: ROLES.filter(role => report.visits.filter(visit => visit.role === role).length >= 2),
        rootActivity: assessRootActivity(report.visits, report.rootActivitySamples, pinned, expectedActiveRoles),
        rolesWithChildRows: ROLES.filter(role => report.visits.some(visit => visit.role === role && visit.ui.rows.length)),
        stablePairsCompared: report.visits.reduce((sum, visit) => sum + visit.stable.comparedPairs, 0),
        activeRowsObserved: report.visits.reduce((sum, visit) => sum + visit.ui.rows.filter(row => row.group === 'active').length, 0),
        completedRowsObserved: report.visits.reduce((sum, visit) => sum + visit.ui.rows.filter(row => row.group === 'completed').length, 0) }
      report.status = classifyOfficeUiLoadReport(report)
      if (report.visits.length || probeKey || store) persist()
      return report
    }
  }).finally(() => {
    lease.active = false
    for (const [name, wrapper] of Object.entries(wrappers)) if (c[name] === wrapper) c[name] = originalMethods[name]
    release(); c.uiLoadProbePromise = null
  })
  return control
}
