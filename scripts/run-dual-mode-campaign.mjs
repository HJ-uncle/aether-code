/** Fresh live campaign: one real Electron, real DB model, Code/Work UI queues.
 * No game implementation or model/browser mock is supplied by this harness. */
import { _electron as electron, expect } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfiguredModel } from './gomoku-model-seed.mjs'
import { createCampaignPlan } from './dual-mode-campaign-plan.mjs'
import { manifestWorkspace, summarizeSnapshot } from './dual-mode-evidence.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = text => createHash('sha256').update(text).digest('hex')
const normalized = path => resolve(path).toLowerCase()
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }
const executing = value => ['preparing', 'running', 'waiting', 'cancelling'].includes(value?.run?.status)
const terminal = value => ['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(value?.run?.status)
const successfulBrowser = tool => tool.resultPresent && tool.success === true && tool.status === 'succeeded'
const submissionSucceeded = item => item.terminalOutcome === 'succeeded' || item.resolution?.verified === true
const browserComplete = submission => {
  const names = new Set(submission.browserEvidence.filter(tool => tool.rootRunId === submission.admittedRunId && successfulBrowser(tool)).map(tool => tool.name))
  return names.has('browser_snapshot') && names.has('browser_console') && names.has('browser_network') && ['browser_click', 'browser_fill', 'browser_press_key'].some(name => names.has(name))
}
const modes = ['code', 'work']
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }

async function previewServer(workspace, fixedOrigin) {
  const requested = fixedOrigin ? new URL(fixedOrigin) : null
  if (requested && (requested.protocol !== 'http:' || requested.hostname !== '127.0.0.1' || !requested.port || requested.pathname !== '/')) throw new Error('Resume preview origin must be an explicit loopback port')
  const canonical = await realpath(workspace)
  const server = createServer((request, response) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return }
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://local.invalid').pathname)
      if (pathname === '/__campaign_health') { response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ready'); return }
      if (pathname === '/favicon.ico' && !existsSync(join(canonical, 'favicon.ico'))) { response.writeHead(204).end(); return }
      const file = resolve(canonical, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname))
      if (!inside(canonical, file) || pathname.split('/').some(part => /^(?:\.git|\.env(?:\..*)?)$/i.test(part))) { response.writeHead(403).end(); return }
      let actual
      try { actual = await realpath(file) } catch { response.writeHead(404, { 'cache-control': 'no-store' }).end('Not created yet'); return }
      const info = await stat(actual)
      if (!inside(canonical, actual) || !info.isFile() || info.size > 32 * 1024 * 1024) { response.writeHead(403).end(); return }
      response.writeHead(200, { 'content-type': mime[extname(actual).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(request.method === 'HEAD' ? undefined : await readFile(actual))
    })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error.code || 'preview failure')) })
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(requested ? Number(requested.port) : 0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Preview server has no address')
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) } }
}

/** A recovery hold is not an operator request to stop adding requirements. */
export function resumeAdditionsPreference(previous) {
  const control = [...(previous.commands || [])].reverse().find(item => item.status === 'completed' && ['pause-additions', 'resume-additions'].includes(item.action))
  if (control) return control.action === 'pause-additions'
  if (typeof previous.resumeAdditionsPaused === 'boolean') return previous.resumeAdditionsPaused
  // Older resume attempts saved pausedAdditions=true before reconciliation,
  // but did not persist the pre-recovery preference. No pause command means
  // this legacy startup hold must not become a permanent pause after failure.
  if (modes.some(mode => previous.modes?.[mode]?.resumePending)) return false
  return previous.pausedAdditions === true
}

export function buildResumeRepairPrompt(mode, target, requirement) {
  const regression = mode === 'code'
    ? '复盘的两项已核实疑点必须用内置浏览器复验并修复：#rv-prev 在正式对局 total>0 时可用，但 click 内若 !review 直接 return，首次上一手无动作；#rv-first 使用 enterReview(1) 却在 review current===0 时禁用，导致不能从初始局面跳首手。明确“首手”为第1手、“上一手”可到第0手。'
    : '同时回归重开：旧终局后 reset 必须清除 winner、score 与结束状态，不能让上一局胜者残留；用真实浏览器结束一局再重开验证，并保留规则测试。'
  return `[中断恢复：仅 ${target.id}]\n上一段测试由观测脚本异常关闭，原 run ${target.admittedRunId} 的真实终态为 ${target.terminalOutcome}。保留已完成代码和失败记录，检查当前实现，仅补完并验收这一个需求，不重做基础项目，不执行其他排队需求。\n${regression}\n${requirement.prompt}`
}

/** Select across segments, including a send that failed before links were saved. */
export function findResumeRepair(owner, mode, target, text) {
  const candidates = owner.submissions.filter(item => item.kind === 'repair' && (
    item.id.startsWith(`${mode}-resume-${target.id}-`) ||
    item.recoveryOf?.runId === target.admittedRunId && item.repairIds?.includes(target.id)))
  if (candidates.length > 1) throw new Error(`${mode}/${target.id} has multiple resume repairs; refusing ambiguous replay`)
  const repair = candidates[0]
  if (repair && (repair.promptSha256 !== hash(text) || repair.recoveryOf?.runId && repair.recoveryOf.runId !== target.admittedRunId ||
    repair.repairIds && (repair.repairIds.length !== 1 || repair.repairIds[0] !== target.id))) {
    throw new Error(`${mode}/${target.id} existing resume repair differs from the exact original target/prompt`)
  }
  return repair
}

/** Pure resume planning: no previous run, requirement or failure is rewritten. */
export function resumeCampaignState(previous, { stamp, now, minActiveMs, maxMs }) {
  if (!['failed', 'interrupted'].includes(previous.phase)) throw new Error('Resume requires a stopped failed/interrupted campaign')
  const state = structuredClone(previous)
  state.previousSegments = [...(previous.previousSegments || []), { startedAt: previous.startedAt, finishedAt: previous.finishedAt,
    evidenceRoot: previous.evidenceRoot, phase: previous.phase, error: previous.error, sampledActiveMs: previous.sampledActiveMs,
    sampledConcurrentMs: previous.sampledConcurrentMs, longestContinuousActiveMs: previous.longestContinuousActiveMs || 0 }]
  state.segmentId = stamp; state.startedAt = now; state.finishedAt = null
  state.evidenceRoot = join(previous.runRoot, 'evidence', 'segments', stamp)
  state.phase = 'resuming'; state.error = null; state.executionPassed = false; state.productAcceptance = 'pending-independent-review'
  state.targetActiveMs = Math.max(60 * 60_000, minActiveMs); state.maxDurationMs = maxMs
  state.sampledActiveMs = 0; state.sampledConcurrentMs = 0; state.continuousActiveMs = 0; state.longestContinuousActiveMs = 0
  state.modeSwitches = 0; state.observations = 0; state.metricSamples = 0; state.rendererErrors = []; state.processErrors = []
  state.observationGaps = []; state.observationGapCount = 0; state.observationHold = null; state.latestAudit = null; state.finishRequested = false
  state.resumeAdditionsPaused = resumeAdditionsPreference(previous); state.pausedAdditions = true
  for (const mode of modes) {
    state.modes[mode].lastStatus = null
    state.modes[mode].extraAudits = 0
    state.modes[mode].resumePending = true
    state.modes[mode].resumeQueueVerified = null
  }
  return state
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const resumeRoot = process.env.AETHER_DUAL_RESUME_ROOT
  if (resumeRoot && process.env.AETHER_DUAL_RUN_ROOT) throw new Error('Choose a new run root or a resume root, not both')
  const runRoot = resolve(resumeRoot || process.env.AETHER_DUAL_RUN_ROOT || join(repository, '.ae', 'dual-mode-' + stamp))
  if (!resumeRoot && existsSync(runRoot)) throw new Error('Campaign root must be new; refusing to reuse prior game or profile state: ' + runRoot)
  const previousState = resumeRoot ? JSON.parse(readFileSync(join(runRoot, 'state.json'), 'utf8')) : null
  if (previousState && normalized(previousState.runRoot) !== normalized(runRoot)) throw new Error('Resume root differs from stored campaign identity')
  const profile = join(runRoot, 'profile'), evidenceRoot = resumeRoot ? join(runRoot, 'evidence', 'segments', stamp) : join(runRoot, 'evidence')
  const workspaces = { code: join(runRoot, 'code-gomoku'), work: join(runRoot, 'work-go') }
  if (previousState && (normalized(previousState.profile) !== normalized(profile) || modes.some(mode => normalized(previousState.workspaces[mode]) !== normalized(workspaces[mode])))) throw new Error('Stored profile/workspace is outside the resumed campaign')
  for (const path of [profile, evidenceRoot, ...Object.values(workspaces)]) mkdirSync(path, { recursive: true })
  const maxMs = Math.min(180, Math.max(1, Number(process.env.AETHER_DUAL_MAX_MINUTES) || 180)) * 60_000
  const minActiveMs = Math.max(resumeRoot ? 60 : 1, Number(process.env.AETHER_DUAL_MIN_ACTIVE_MINUTES) || 60) * 60_000
  const model = resumeRoot ? { modelId: previousState.modelId, displayName: previousState.modelId, apiKey: null } : readConfiguredModel()
  const scrub = value => (model.apiKey ? String(value).split(model.apiKey).join('[REDACTED]') : String(value)).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  const state = previousState ? resumeCampaignState(previousState, { stamp, now: new Date().toISOString(), minActiveMs, maxMs }) : { schemaVersion: 1, segmentId: stamp, startedAt: new Date().toISOString(), runRoot, profile, evidenceRoot, workspaces,
    phase: 'setup', modelId: model.modelId, targetActiveMs: minActiveMs, maxDurationMs: maxMs,
    sampledActiveMs: 0, sampledConcurrentMs: 0, continuousActiveMs: 0, longestContinuousActiveMs: 0, modeSwitches: 0, pausedAdditions: false,
    observationGaps: [], observationHold: null,
    rendererErrors: [], processErrors: [], issues: [], observations: 0, metricSamples: 0, commands: [],
    modes: Object.fromEntries(modes.map(mode => [mode, { sessionId: mode === 'code' ? 'dual-code-' + randomUUID() : null,
      nextBatch: 1, completedBatches: [], submissions: [], runs: {}, lastStatus: null, latestSnapshot: null, browserTabs: [], extraAudits: 0,
      blocked: null, seenFailures: [], browserRechecks: {} }])),
    executionPassed: false, productAcceptance: 'pending-independent-review', fileWriteIsolation: 'not-proven-for-arbitrary-execute_cmd', latestAudit: null, finishRequested: false }
  const serialize = value => scrub(JSON.stringify(value, (_, entry) => typeof entry === 'string'
    ? entry.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, image => `[image data omitted: ${image.length} characters]`) : entry, 2))
  const save = () => { const temporary = join(runRoot, 'state.json.tmp'); writeFileSync(temporary, serialize(state)); renameSync(temporary, join(runRoot, 'state.json')) }
  const log = (event, details = {}) => { const row = { at: new Date().toISOString(), event, ...details }; appendFileSync(join(evidenceRoot, 'events.jsonl'), scrub(JSON.stringify(row)) + '\n'); console.log(scrub(JSON.stringify(row))); save() }
  const artifact = (name, value) => { const path = join(evidenceRoot, name); writeFileSync(path, serialize(value)); return path }
  const controls = join(runRoot, 'commands.json')
  if (!resumeRoot) writeFileSync(controls, JSON.stringify({ commands: [] }, null, 2))
  if (previousState) writeFileSync(join(evidenceRoot, 'prior-state.json'), serialize(previousState), { flag: 'wx' })
  const safeSentinels = Object.fromEntries(modes.map(mode => {
    const file = join(workspaces[mode], '.campaign-sentinel.txt')
    const value = resumeRoot ? readFileSync(file, 'utf8') : `Campaign ${stamp}; owned project ${mode}; do not edit this isolation sentinel.\n`
    if (!value.includes(`owned project ${mode}; do not edit this isolation sentinel.`)) throw new Error('Invalid original isolation sentinel')
    if (!resumeRoot) writeFileSync(file, value)
    return [mode, hash(value)]
  }))
  let app, page, plan, closing = false, currentMode = '', previousTick = Date.now(), lastMetrics = 0, lastRuntime = 0, lastTurnSnapshot = 0, lastModeExercise = 0, nextCounter = 0
  let codeServer, workServer, auxiliaryElapsedMs = 0
  const started = Date.now(), deadline = started + maxMs
  const transient = error => /timeout|timed out|abort|请求超时|网络|ECONN|ETIMED|fetch failed|network|socket/i.test(String(error?.message || error)) || error?.httpStatus >= 500 || [408, 429].includes(error?.httpStatus)
  const observationGap = (context, error) => {
    const entry = { at: Date.now(), context, error: scrub(error?.message || error) }
    state.observationGaps.push(entry); state.observationGaps = state.observationGaps.slice(-200)
    state.observationGapCount = (state.observationGapCount || 0) + 1
    state.continuousActiveMs = 0; previousTick = Date.now()
    for (const mode of modes) state.modes[mode].lastStatus = null
    log('observation-gap', entry)
  }
  const request = async (method, path, body, query, mode = 'work') => {
    const expectedEngine = state.engine ? { mode: state.engine.mode, baseUrl: state.engine.baseUrl, instanceId: state.engine.instanceId, accountId: state.engine.accountId } : undefined
    // The bridge owns the abort deadline. Do not abandon an uncancelled HTTP
    // request with Promise.race or replay a mutation whose outcome is unknown.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await page.evaluate(input => window.aether.engine.request(input), { method, path, body, query, expectedEngine, toolProfile: mode === 'code' ? 'code' : 'general' })
        if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.message}`), { httpStatus: response.code < 1000 ? response.code : Math.floor(response.code / 100), code: response.code })
        return response.data
      } catch (error) {
        if (method !== 'GET' || attempt >= 1 || !transient(error)) throw error
        observationGap(`${mode} GET ${path} retry`, error)
        await delay(250)
      }
    }
  }
  const status = mode => request('GET', '/chat/status', undefined, { sessionId: state.modes[mode].sessionId }, mode)
  const observe = async (context, read) => {
    try { return { ok: true, value: await read() } }
    catch (error) {
      if (!transient(error)) throw error
      observationGap(context, error)
      const connection = await page.evaluate(() => window.aether.engine.getSnapshot())
      if (connection.phase !== 'ready' || connection.instanceId !== state.engine.instanceId) throw error
      // A cached ready label alone is not proof that the engine still answers.
      await request('GET', '/health')
      state.observationHold = { context, since: Date.now(), reason: scrub(error.message) }
      return { ok: false, error: scrub(error.message) }
    }
  }
  const selectMode = async mode => {
    await page.getByRole('tab', { name: mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click({ timeout: 20_000 })
    await expect(page.locator('#mode-' + mode)).toHaveAttribute('aria-hidden', 'false')
    if (currentMode !== mode) { state.modeSwitches++; currentMode = mode }
  }
  const workTask = () => page.evaluate(() => {
    const buckets = Object.entries(localStorage).filter(([key]) => key.startsWith('aether.work.state.v1')).map(([, value]) => JSON.parse(value))
    const bucket = buckets.find(value => value.activeTaskId)
    return bucket?.tasks.find(task => task.id === bucket.activeTaskId) ?? null
  })
  const workQueue = async () => {
    const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    const input = { taskId: state.modes.work.sessionId, expectedEngine: { mode: snapshot.mode, baseUrl: snapshot.baseUrl, instanceId: snapshot.instanceId, accountId: snapshot.accountId }, action: { kind: 'read' } }
    const result = await page.evaluate(value => window.aether.workQueue.invoke(value), input)
    if (!result.ok) throw new Error('Work queue read: ' + result.message)
    return result.value
  }
  const setFullMode = async mode => {
    await selectMode(mode)
    const button = page.locator('#mode-' + mode).getByRole('button', { name: /^切换本会话访问权限：/ })
    await expect(button).toBeEnabled({ timeout: 30_000 })
    if (!(await button.innerText()).includes('完全访问')) {
      await button.click()
      await page.getByRole('menuitem', { name: /^完全访问/ }).click()
    }
    await expect(button).toContainText('完全访问')
  }
  const chooseModel = async mode => {
    await selectMode(mode)
    const trigger = page.locator('#mode-' + mode).getByRole('button', { name: mode === 'work' ? 'Work 使用的模型' : '选择模型', exact: true })
    await expect(trigger).toBeEnabled({ timeout: 30_000 })
    await trigger.click()
    const escaped = (model.displayName || model.modelId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await page.getByRole('menuitem', { name: new RegExp('^' + escaped) }).click()
  }
  const submit = async (mode, text, id, kind = 'requirement', existingRecord) => {
    const owner = state.modes[mode]
    state.latestAudit = null; state.finishRequested = false
    if (state.phase === 'awaiting-independent-review') state.phase = 'running'
    await selectMode(mode)
    const before = owner.sessionId ? await status(mode) : null
    const other = modes.find(item => item !== mode), otherBefore = state.modes[other].sessionId ? await status(other) : null
    if (!existingRecord && owner.submissions.some(item => item.id === id)) throw new Error(`Refusing duplicate submission ID ${mode}/${id}`)
    if (existingRecord && (existingRecord.admittedRunId || existingRecord.terminalOutcome || existingRecord.promptSha256 !== hash(text))) throw new Error('Only a proven unadmitted exact prompt may be requeued')
    const attempt = { segmentId: state.segmentId, submittedAt: new Date().toISOString(), beforeRunId: before?.run?.runId ?? null,
      phase: 'sending', priorQueueLoss: existingRecord?.recovery?.kind ?? null }
    const record = existingRecord || { id, kind, promptSha256: hash(text), submittedAt: attempt.submittedAt, beforeRunId: before?.run?.runId ?? null,
      submittedWhileRunning: executing(before), otherBeforeRunId: otherBefore?.run?.runId ?? null, admittedRunId: null, terminalOutcome: null, browserEvidence: [] }
    record.attempts = [...(record.attempts || []), attempt]
    if (!existingRecord) owner.submissions.push(record)
    save()
    const surface = page.locator('#mode-' + mode)
    if (mode === 'code') {
      const composer = surface.locator('.chat__surface .input-composer__input[role="textbox"]').first()
      // An editable draft is available before restored session/model hydration.
      // Wait for the actual executable composer rather than losing one Enter.
      await expect(surface.getByRole('button', { name: '选择模型', exact: true })).toBeEnabled({ timeout: 90_000 })
      await expect(composer).toBeEditable({ timeout: 30_000 })
      await composer.fill(text)
      if (executing(before)) {
        // While active the icon is Stop; Enter uses the enqueue-capable submit.
        await composer.press('Enter')
      } else {
        const send = surface.getByRole('button', { name: '发送', exact: true })
        await expect(send).toBeEnabled({ timeout: 90_000 })
        await send.click()
      }
      await expect(composer).toHaveText('', { timeout: 15_000 })
      const queueTab = surface.locator('.session-tray__tab--queue')
      if (await queueTab.count()) {
        await queueTab.click()
        const queued = await surface.locator('.session-tray__queue-text').allTextContents()
        if (queued.includes(text)) attempt.uiQueueAck = { observedAt: Date.now(), exactPromptHash: hash(text), queueCount: queued.length, persistence: 'volatile' }
      }
    } else {
      const composer = surface.locator('.work-composer .input-composer__input[role="textbox"]').first()
      const target = await composer.count() ? composer : surface.locator('.input-composer__input[role="textbox"]').first()
      await expect(target).toBeEditable({ timeout: 30_000 })
      await target.fill(text)
      const send = surface.getByRole('button', { name: /^(开始任务|排到下一轮|发送)$/, exact: true }).filter({ visible: true }).last()
      await expect(send).toBeEnabled({ timeout: 30_000 })
      await send.click()
      await expect(target).toHaveText('', { timeout: 15_000 })
      if (!owner.sessionId) {
        await expect.poll(async () => (await workTask())?.id, { timeout: 30_000 }).toMatch(/^work-/)
        owner.sessionId = (await workTask()).id
      }
      if (kind !== 'baseline') {
        const queue = await workQueue()
        const entry = queue.state.entries.find(value => value.envelope.draft.text === text)
        if (entry) record.queueAck = { entryId: entry.id, revision: entry.revision, phase: entry.phase, stateRevision: queue.state.revision }
        if (record.submittedWhileRunning && !entry) throw new Error(`${id}: active Work submission has no durable queue acknowledgement`)
      }
    }
    const after = await status(mode), otherAfter = otherBefore ? await status(other) : null
    record.afterRunId = after.run?.runId ?? null
    record.otherAfterRunId = otherAfter?.run?.runId ?? null
    if (executing(before) && before.run?.runId !== after.run?.runId && after.run?.status !== 'succeeded') {
      state.issues.push({ kind: 'run-changed-during-submit', mode, id, before: before.run?.runId, after: after.run?.runId })
      // A terminal boundary may naturally occur during UI input; snapshots below decide admission/duplication.
    }
    log('submitted', { mode, id, queuedDuringRun: record.submittedWhileRunning, runId: record.beforeRunId })
    attempt.phase = 'ui-accepted'; attempt.acceptedAt = Date.now()
    return record
  }
  const ingestRuns = (mode, runs) => {
    const owner = state.modes[mode]
    for (const run of runs) if (run?.runId) {
      if (run.sessionId !== owner.sessionId) throw new Error(`${mode} root run belongs to a different session`)
      if (!Array.isArray(run.workspacePaths) || run.workspacePaths.length !== 1 || normalized(run.workspacePaths[0]) !== normalized(workspaces[mode])) throw new Error(`${mode} root run workspace binding differs from its isolated project`)
      if (Number.isInteger(owner.runs[run.runId]?.version) && Number.isInteger(run.version) && run.version < owner.runs[run.runId].version) continue
      owner.runs[run.runId] = { ...owner.runs[run.runId], ...run }
    }
  }
  const setOutcome = (submission, outcome, source) => {
    if (!['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(outcome)) return
    if (submission.terminalOutcome && submission.terminalOutcome !== outcome) throw new Error(`${submission.id} terminal outcome changed from ${submission.terminalOutcome} to ${outcome}`)
    if (!submission.terminalOutcome) {
      submission.terminalOutcome = outcome
      submission.needsTerminalEvidence = true
      submission.outcomeHistory = [...(submission.outcomeHistory || []), { outcome, source, runId: submission.admittedRunId, at: Date.now(), segmentId: state.segmentId }]
    }
  }
  const bindAdmission = (submission, runId, source) => {
    if (submission.admittedRunId && submission.admittedRunId !== runId) throw new Error(`${submission.id} has duplicate durable admissions`)
    submission.admittedRunId = runId
    submission.admissionProof = { source, runId, at: Date.now() }
  }
  const refreshRuns = async (mode, { matchUnknown = true } = {}) => {
    const owner = state.modes[mode]
    const result = await observe(`${mode} lightweight runs`, () => request('GET', '/chat/runs', undefined, { sessionId: owner.sessionId }, mode))
    if (!result.ok) return { complete: false }
    if (!Array.isArray(result.value?.runs)) throw new Error('Malformed durable run list')
    const runs = result.value.runs
    ingestRuns(mode, runs)
    let queue
    if (mode === 'work') {
      const observedQueue = await observe('Work durable queue read', workQueue)
      if (!observedQueue.ok) return { complete: false, runs }
      queue = observedQueue.value
      for (const entry of queue.state.entries) {
        const submission = owner.submissions.find(item => item.promptSha256 === hash(entry.envelope.draft.text))
        if (!submission) continue
        submission.queuePhase = entry.phase
        if (entry.receipt?.runId) bindAdmission(submission, entry.receipt.runId, 'durable-work-queue-receipt')
        else if (entry.frozen?.requestKey) {
          const admission = JSON.parse(entry.frozen.wireBody).admission
          const accepted = runs.filter(run => run.admissionReceipt?.requestKey === admission.requestKey &&
            run.admissionReceipt?.bodyDigest === admission.bodyDigest &&
            run.admissionReceipt?.namespace?.id === admission.namespace.id && run.admissionReceipt?.namespace?.generation === admission.namespace.generation)
          if (accepted.length > 1) throw new Error(`${submission.id} has multiple runs for its admission key`)
          if (accepted[0]) bindAdmission(submission, accepted[0].runId, 'durable-run-admission-receipt')
        }
        if (entry.outcome) setOutcome(submission, entry.outcome, 'work-queue')
      }
    }
    const unmatched = []
    owner.admissionLookups ||= {}
    let lookupBudget = matchUnknown ? 1 : 0
    // The response is bounded, but the current server still scans history
    // before slicing this route. Limit it to one unknown turn per call, with
    // per-run backoff, and prefer full evidence already due at a transition.
    for (const run of runs.filter(run => !owner.submissions.some(item => item.admittedRunId === run.runId))) {
      if (!run.turnId) { unmatched.push(run.runId); continue }
      const priorLookup = owner.admissionLookups[run.runId]
      if (!lookupBudget || priorLookup && Date.now() - priorLookup.lastAttemptAt < 60_000) { unmatched.push(run.runId); continue }
      lookupBudget--
      const lookup = { lastAttemptAt: Date.now(), attempts: (priorLookup?.attempts || 0) + 1, result: 'pending' }
      owner.admissionLookups[run.runId] = lookup
      try {
        const observed = await observe(`${mode} admission turn ${run.runId}`, () => request('GET', '/conversations/' + encodeURIComponent(run.turnId), undefined, { current: 1, pageSize: 8 }, mode))
        if (!observed.ok) { lookup.result = 'observation-unavailable'; unmatched.push(run.runId); continue }
        const messages = observed.value
        const users = Array.isArray(messages) ? messages.filter(item => item.role === 'user') : []
        const matches = owner.submissions.filter(item => users.some(user => hash(typeof user.content === 'string' ? user.content : JSON.stringify(user.content)) === item.promptSha256))
        if (matches.length === 1) { bindAdmission(matches[0], run.runId, 'turn-user-message-hash'); lookup.result = 'matched' }
        else { unmatched.push(run.runId); lookup.result = 'user-projection-unmatched' }
      } catch (error) {
        if (error.code !== 40400 && !transient(error)) throw error
        observationGap(`${mode} pending admission projection ${run.runId}`, error)
        lookup.result = 'projection-pending'; lookup.error = scrub(error.message)
        unmatched.push(run.runId)
      }
    }
    for (const submission of owner.submissions) {
      const run = owner.runs[submission.admittedRunId]
      if (run) setOutcome(submission, run.status, 'durable-run')
    }
    if (owner.submissions.some(item => item.needsTerminalEvidence)) owner.evidencePending = true
    owner.unmatchedRunIds = unmatched
    return { complete: unmatched.length === 0, runs, queue }
  }
  const checkpoint = async (mode, reason, { full = true } = {}) => {
    const owner = state.modes[mode]
    if (!owner.sessionId) return null
    const refreshed = await refreshRuns(mode, { matchUnknown: !full })
    if (!full) return refreshed
    const observed = await observe(`${mode} full snapshot (${reason})`, () => request('GET', '/chat/snapshot', undefined, { sessionId: owner.sessionId }, mode))
    if (!observed.ok) { owner.evidencePending = true; return null }
    const snapshot = observed.value
    const summary = summarizeSnapshot(snapshot)
    const filename = `${String(++nextCounter).padStart(4, '0')}-${mode}-${reason.replace(/[^a-z0-9-]/gi, '-').slice(0, 60)}`
    artifact(filename + '-snapshot.json', snapshot)
    artifact(filename + '-summary.json', summary)
    owner.latestSnapshot = filename + '-snapshot.json'
    owner.latestSnapshotRoot = evidenceRoot; owner.evidencePending = false
    if (snapshot.sessionId !== owner.sessionId) throw new Error(`${mode} snapshot belongs to a different session`)
    const runRows = [...(snapshot.runs || []), snapshot.run, snapshot.executionRun].filter(Boolean)
    ingestRuns(mode, runRows)
    const history = Array.isArray(snapshot.history) ? snapshot.history : []
    for (const submission of owner.submissions) {
      const matches = history.filter(item => item.role === 'user' && hash(typeof item.content === 'string' ? item.content : JSON.stringify(item.content)) === submission.promptSha256)
      if (matches.length > 1) throw new Error(`${mode}/${submission.id} duplicated in durable history`)
      const matched = matches[0]
      if (matched?.metadata?.rootRunId) bindAdmission(submission, matched.metadata.rootRunId, 'snapshot-user-message')
      if (!submission.admittedRunId) {
        const row = summary.userMessages.find(item => item.contentSha256 === submission.promptSha256)
        if (row?.rootRunId) bindAdmission(submission, row.rootRunId, 'snapshot-user-message-hash')
      }
    }
    if (mode === 'work') {
      const queue = refreshed.queue || (await observe('Work checkpoint queue read', workQueue)).value
      if (!queue) { owner.evidencePending = true; return null }
      artifact(filename + '-queue.json', queue)
      for (const entry of queue.state.entries) {
        const submission = owner.submissions.find(item => item.promptSha256 === hash(entry.envelope.draft.text))
        if (!submission) continue
        if (entry.receipt?.runId) bindAdmission(submission, entry.receipt.runId, 'durable-work-queue-receipt')
        if (entry.outcome) setOutcome(submission, entry.outcome, 'work-queue')
        submission.queuePhase = entry.phase
      }
      if (queue.dispatchError) state.issues.push({ kind: 'work-queue', message: queue.dispatchError, at: Date.now() })
    }
    for (const submission of owner.submissions) {
      const run = owner.runs[submission.admittedRunId]
      if (run) setOutcome(submission, run.status, 'durable-run')
      const found = summary.browser.tools.filter(tool => tool.rootRunId === submission.admittedRunId)
      if (found.length) submission.browserEvidence = [...new Map([...submission.browserEvidence, ...found].map(tool => [tool.id, tool])).values()]
      submission.needsTerminalEvidence = false
    }
    owner.unmatchedRunIds = Object.keys(owner.runs).filter(runId => !owner.submissions.some(item => item.admittedRunId === runId))
    for (const repair of owner.submissions.filter(item => item.kind === 'repair' && item.terminalOutcome === 'succeeded' && Array.isArray(item.repairIds))) {
      for (const id of repair.repairIds) {
        const original = owner.submissions.find(item => item.id === id)
        if (!original || original === repair || !original.admittedRunId || !original.terminalOutcome || !repair.admittedRunId || original.admittedRunId === repair.admittedRunId || !browserComplete(repair)) continue
        // Original execution and its failure remain immutable evidence. A new
        // explicit target-bound repair can resolve it, never rewrite that run.
        original.resolution = { verified: true, repairId: repair.id, repairRunId: repair.admittedRunId,
          verifiedAt: Date.now(), browserToolIds: repair.browserEvidence.filter(successfulBrowser).map(tool => tool.id) }
      }
    }
    owner.browserTabs = (await page.evaluate(() => window.aether.browser.list())).filter(tab => tab.context?.sessionId === owner.sessionId)
    for (const tab of owner.browserTabs) {
      if (tab.url.startsWith('http') && new URL(tab.url).origin !== plan[mode].origin) throw new Error(`${mode} owns unexpected page origin: ${tab.url}`)
    }
    for (const current of modes) if (hash(readFileSync(join(workspaces[current], '.campaign-sentinel.txt'), 'utf8')) !== safeSentinels[current]) throw new Error(`${current} isolation sentinel changed`)
    artifact(filename + '-manifest.json', await manifestWorkspace(workspaces[mode]))
    log('checkpoint', { mode, reason, run: summary.run, browser: { attempted: summary.browser.attempted, succeeded: summary.browser.succeeded }, submissionsConfirmed: owner.submissions.filter(item => item.admittedRunId).length })
    return summary
  }
  const snapshotAll = async reason => {
    for (const mode of modes) await checkpoint(mode, reason)
    await page.screenshot({ path: join(evidenceRoot, `${String(++nextCounter).padStart(4, '0')}-${reason.replace(/[^a-z0-9-]/gi, '-')}.png`) })
  }
  const submissionsSettled = () => modes.every(mode => state.modes[mode].submissions.every(item => submissionSucceeded(item)))
  const idleForAudit = async () => {
    if (!submissionsSettled() || modes.some(mode => state.modes[mode].blocked)) return false
    for (const mode of modes) if (executing(await status(mode))) return false
    const queue = await workQueue()
    return queue.state.entries.every(entry => entry.phase === 'terminal')
  }
  const processControls = async () => {
    let data
    try { data = JSON.parse(readFileSync(controls, 'utf8')) } catch { return }
    if (!Array.isArray(data.commands)) return
    for (const command of data.commands.slice(0, 100)) {
      if (!command || typeof command.id !== 'string' || state.commands.some(value => value.id === command.id)) continue
      const record = { id: command.id, action: command.action, at: new Date().toISOString(), status: 'processing' }
      state.commands.push(record); save()
      if (command.action === 'pause-additions') state.pausedAdditions = true
      else if (command.action === 'resume-additions') state.pausedAdditions = false
      else if (command.action === 'snapshot') await snapshotAll('control-' + command.id)
      else if (command.action === 'resume-mode' && modes.includes(command.mode)) state.modes[command.mode].blocked = null
      else if (command.action === 'message' && modes.includes(command.mode) && typeof command.text === 'string' && command.text.trim()) {
        if (Array.isArray(command.repairIds) && command.repairIds.length > 1) { record.status = 'rejected'; record.reason = 'One repair turn may resolve only one original requirement'; continue }
        const targetId = Array.isArray(command.repairIds) && typeof command.repairIds[0] === 'string' ? command.repairIds[0] : null
        const repairText = targetId ? `[修复目标 ${targetId}]\n${command.text}` : command.text
        const repair = await submit(command.mode, repairText, 'control-' + command.id, 'repair')
        if (Array.isArray(command.repairIds)) repair.repairIds = command.repairIds.filter(value => typeof value === 'string')
        state.modes[command.mode].blocked = null
      } else if (command.action === 'audit') {
        if (!await idleForAudit()) { record.status = 'rejected'; record.reason = 'Both roots and all queued submissions must be settled'; continue }
        const auditPath = new URL('./audit-dual-mode-games.mjs', import.meta.url)
        if (!existsSync(fileURLToPath(auditPath))) { record.status = 'rejected'; record.reason = 'Fixed audit module is not present yet'; continue }
        try {
          auditPath.search = '?review=' + Date.now()
          const { audit } = await import(auditPath.href)
          if (typeof audit !== 'function') throw new Error('Audit module must export audit()')
          const result = await audit({ app, page, state, request, artifact, log })
          state.latestAudit = { passed: result?.passed === true, result, at: Date.now(), submissionCount: modes.reduce((sum, mode) => sum + state.modes[mode].submissions.length, 0) }
          artifact('independent-audit-' + command.id.replace(/[^a-z0-9-]/gi, '-') + '.json', state.latestAudit)
        } catch (error) { state.latestAudit = { passed: false, error: scrub(error), at: Date.now() }; artifact('independent-audit-failed.json', state.latestAudit) }
      } else if (command.action === 'compaction-probe') {
        if (state.phase !== 'awaiting-independent-review' || !state.latestAudit?.passed || !await idleForAudit()) {
          record.status = 'rejected'; record.reason = 'Both game projects must pass independent review and be idle before the separate compression experiment'; continue
        }
        const probeStart = Date.now()
        try {
          const probePath = new URL('./run-context-compaction-probe.mjs', import.meta.url); probePath.search = '?probe=' + probeStart
          const { runCompactionProbe } = await import(probePath.href)
          state.contextCompactionProbe = await runCompactionProbe({ app, page, state, request, artifact, log })
          artifact('context-compaction-probe-result.json', state.contextCompactionProbe)
        } catch (error) {
          state.contextCompactionProbe = { completed: false, error: scrub(error.stack || error), at: Date.now() }
          artifact('context-compaction-probe-error.json', state.contextCompactionProbe)
        } finally {
          // The user's additional experiment owns a separate duration. It is
          // neither game load nor a failure of the earlier three-hour campaign.
          auxiliaryElapsedMs += Date.now() - probeStart
          state.auxiliaryElapsedMs = auxiliaryElapsedMs
          observationGap('separate context-compaction experiment; interval excluded from game load', new Error('Auxiliary test phase'))
        }
      } else if (command.action === 'finish') {
        const count = modes.reduce((sum, mode) => sum + state.modes[mode].submissions.length, 0)
        if (state.phase !== 'awaiting-independent-review' || !state.latestAudit?.passed || state.latestAudit.submissionCount !== count || !await idleForAudit() || state.rendererErrors.length) {
          record.status = 'rejected'; record.reason = 'Execution gates and a fresh passing independent audit are required'; continue
        }
        state.finishRequested = true
      } else if (command.action === 'stop') { record.status = 'accepted'; throw new Error('Controlled stop requested: ' + String(command.reason || command.id)) }
      else { record.status = 'rejected'; log('control-rejected', { id: command.id }); continue }
      record.status = 'completed'; log('control-completed', { id: command.id, action: command.action })
    }
  }
  const verifyBatchBrowser = async (mode, batch) => {
    const owner = state.modes[mode]
    const ids = plan[mode].requirements.filter(item => item.batch === batch).map(item => item.id)
    const entries = owner.submissions.filter(item => ids.includes(item.id))
    if (entries.length !== 2 || entries.some(item => !submissionSucceeded(item))) return false
    const missing = entries.filter(item => {
      const repair = item.resolution?.verified ? owner.submissions.find(value => value.id === item.resolution.repairId) : null
      const recheck = owner.submissions.find(value => value.id === owner.browserRechecks[item.id])
      return !browserComplete(item) && !(repair && browserComplete(repair)) && !(recheck?.terminalOutcome === 'succeeded' && recheck.targetId === item.id && browserComplete(recheck))
    })
    if (missing.length) {
      owner.blocked = { kind: 'missing-browser-evidence', batch, at: Date.now() }
      for (const target of missing) if (!owner.browserRechecks[target.id]) {
        const id = `${mode}-browser-recheck-${target.id}`
        owner.browserRechecks[target.id] = id
        state.issues.push({ kind: 'missing-browser-evidence', mode, batch, targetId: target.id, at: Date.now() })
        const repair = await submit(mode, `[${id}] 需求 ${target.id} 已结束，但该条真实日志缺少完整内置浏览器验收。请复用 ${plan[mode].origin} 的本会话标签，实际 browser_snapshot、browser_click 或 browser_press_key 验证该条关键行为，再 browser_console、browser_network 确认页面无异常。不能仅描述“验证过”。发现问题修复后复验，记录具体结果。仅操作 ${workspaces[mode]}，保留预览标签。`, id, 'browser-recheck')
        repair.targetId = target.id
        log('browser-recheck-submitted', { mode, batch, id, targetId: target.id })
      }
      return false
    }
    if (owner.blocked?.kind === 'missing-browser-evidence' && owner.blocked.batch === batch) owner.blocked = null
    return true
  }
  const ensureProgress = async (mode, now) => {
    const owner = state.modes[mode], current = owner.lastStatus
    if (owner.evidencePending || owner.unmatchedRunIds?.length || owner.resumePending) return
    for (const submission of owner.submissions) if (submission.terminalOutcome && !submissionSucceeded(submission) && !owner.seenFailures.includes(submission.admittedRunId)) {
      owner.seenFailures.push(submission.admittedRunId)
      owner.blocked = { kind: 'task-failed', id: submission.id, runId: submission.admittedRunId, outcome: submission.terminalOutcome, at: Date.now() }
      state.issues.push({ mode, ...owner.blocked }); log('mode-needs-repair', { mode, ...owner.blocked })
    }
    for (let batch = 1; batch < owner.nextBatch; batch++) if (!owner.completedBatches.includes(batch) && await verifyBatchBrowser(mode, batch)) owner.completedBatches.push(batch)
    if (state.pausedAdditions || state.observationHold || owner.resumePending || owner.blocked || owner.nextBatch > 5) return
    const pending = owner.submissions.filter(item => !item.terminalOutcome)
    const previous = owner.nextBatch - 1
    const previousFirst = plan[mode].requirements.find(item => item.batch === previous)
    const previousSubmission = owner.submissions.find(item => item.id === previousFirst?.id)
    const priorStarted = previous === 0 || Boolean(previousSubmission && submissionSucceeded(previousSubmission))
    const baselineReady = existsSync(join(workspaces[mode], 'index.html')) && now - Date.parse(owner.submissions[0]?.submittedAt || state.startedAt) >= 30_000
    if (!baselineReady || !priorStarted || pending.length > 1) return
    // Two separate real submissions per batch; the second always enters a live turn's queue.
    const batch = owner.nextBatch
    for (const requirement of plan[mode].requirements.filter(item => item.batch === batch)) {
      if (owner.submissions.some(item => item.id === requirement.id)) continue
      const before = await status(mode)
      await submit(mode, requirement.prompt, requirement.id)
      if (!executing(before)) await expect.poll(async () => executing(await status(mode)), { timeout: 90_000 }).toBe(true)
    }
    owner.nextBatch++; log('batch-submitted', { mode, batch })
  }
  const recoverSegment = async () => {
    if (!resumeRoot || !modes.some(mode => state.modes[mode].resumePending)) return
    for (const mode of modes) {
      const owner = state.modes[mode]
      if (!owner.resumePending) continue
      const reconciliation = await refreshRuns(mode)
      if (!reconciliation.complete) continue
      const targetId = mode === 'code' ? 'G02' : 'W02'
      const target = owner.submissions.find(item => item.id === targetId)
      if (!target) throw new Error('Resume target is absent: ' + targetId)
      // Startup may recover Work's durable dispatcher before our first read.
      // An active/unknown outcome is never permission to replay that target.
      if (!target.admittedRunId || !target.terminalOutcome) continue
      if (!submissionSucceeded(target)) {
        if (target.terminalOutcome !== 'interrupted' && target.terminalOutcome !== 'cancelled') {
          owner.blocked = { kind: 'resume-needs-reviewed-repair', id: targetId, outcome: target.terminalOutcome }; continue
        }
        const requirement = plan[mode].requirements.find(item => item.id === targetId)
        const text = buildResumeRepairPrompt(mode, target, requirement)
        let repair = findResumeRepair(owner, mode, target, text)
        const id = repair?.id || `${mode}-resume-${targetId}-${stamp}`
        const linkRepair = () => {
          repair ||= owner.submissions.find(item => item.id === id)
          if (!repair) return
          repair.repairIds = [targetId]
          repair.recoveryOf ||= { segment: previousState.segmentId || previousState.startedAt, runId: target.admittedRunId }
          if (!target.repairHistory?.some(item => item.repairId === id)) target.repairHistory = [...(target.repairHistory || []), {
            repairId: id, originalRunId: target.admittedRunId, originalOutcome: target.terminalOutcome,
            segmentId: repair.attempts?.[0]?.segmentId || stamp, submittedAt: Date.parse(repair.submittedAt)
          }]
          owner.seenFailures = [...new Set([...owner.seenFailures, target.admittedRunId])]
        }
        linkRepair()
        // A same-segment send may have reached the engine before its UI
        // acknowledgement failed. Only a new startup with complete durable
        // reconciliation and an empty queue can retry its existing record.
        const priorSegmentUnadmitted = repair && !repair.admittedRunId && !repair.terminalOutcome &&
          !repair.attempts?.some(attempt => attempt.segmentId === stamp)
        if (!repair || priorSegmentUnadmitted) {
          if (executing(await status(mode))) continue
          if (mode === 'work' && reconciliation.queue?.state.entries.some(entry => entry.phase !== 'terminal')) continue
          if (mode === 'code') {
            await selectMode('code')
            if (await page.locator('#mode-code .session-tray__tab--queue').count()) throw new Error('Code queue is unexpectedly present; refusing duplicate repair replay')
          }
          if (repair) {
            if (repair.recovery) repair.recoveryHistory = [...(repair.recoveryHistory || []), repair.recovery]
            repair.recovery = { kind: 'unadmitted-repair-after-setup-failure', segmentId: stamp, priorSubmittedAt: repair.submittedAt,
              verifiedAt: Date.now(), source: 'complete-durable-run-list-and-empty-queue', runs: reconciliation.runs.map(run => run.runId) }
            state.issues.push({ kind: repair.recovery.kind, mode, id, at: Date.now() })
          }
          save()
          try { repair = await submit(mode, text, id, 'repair', repair) }
          finally { linkRepair(); save() }
          owner.blocked = null
          log('resume-target-repair-submitted', { mode, id, targetId, originalRunId: target.admittedRunId, originalOutcome: target.terminalOutcome })
        }
        if (repair?.terminalOutcome && repair.terminalOutcome !== 'succeeded') {
          owner.blocked = { kind: 'resume-repair-needs-reviewed-repair', id, outcome: repair.terminalOutcome }; continue
        }
      }
      if (mode === 'code') {
        // Code's queue currently lives only in React state. We prove the old
        // prompts had no durable admission and observe an empty UI queue before
        // re-enqueuing their original records; this is a documented defect.
        const lost = owner.submissions.filter(item => item.kind === 'requirement' && !item.admittedRunId && !item.terminalOutcome && (!item.recovery?.requeuedAt || item.recovery.segmentId !== stamp))
        if (lost.length && !submissionSucceeded(target) && !executing(await status(mode))) {
          // Let the target repair prove admission before testing replay of the
          // old volatile queue; a stopped root is not a queue acknowledgement.
          continue
        }
        for (const item of lost) {
          if (!['G03', 'G04'].includes(item.id)) throw new Error('Unreviewed volatile queue loss: ' + item.id)
          if (!owner.resumeQueueVerified) {
            await selectMode('code')
            const count = await page.locator('#mode-code .session-tray__tab--queue').count()
            if (count) throw new Error('Code queue is unexpectedly present; refusing duplicate replay')
            owner.resumeQueueVerified = { at: Date.now(), runs: reconciliation.runs.map(run => run.runId), queueTabs: count }
          }
          const requirement = plan.code.requirements.find(value => value.id === item.id)
          if (hash(requirement.prompt) !== item.promptSha256) throw new Error('Original queued prompt changed: ' + item.id)
          if (item.recovery) item.recoveryHistory = [...(item.recoveryHistory || []), item.recovery]
          item.recovery = { kind: 'volatile-queue-lost-on-close', segmentId: stamp, priorSubmittedAt: item.submittedAt, verifiedAt: Date.now(), source: 'complete-durable-run-list-and-empty-Code-queue' }
          state.issues.push({ kind: item.recovery.kind, mode, id: item.id, at: Date.now() })
          await submit(mode, requirement.prompt, item.id, item.kind, item)
          item.recovery.requeuedAt = Date.now()
        }
      }
      owner.resumePending = false
      log('resume-owner-reconciled', { mode, requirementIds: owner.submissions.filter(item => item.kind === 'requirement').map(item => item.id) })
    }
    if (modes.every(mode => !state.modes[mode].resumePending)) {
      state.pausedAdditions = resumeAdditionsPreference(state)
      state.resumeAdditionsPaused = state.pausedAdditions
      state.phase = 'running'
      log('resume-reconciliation-complete', { newSegmentTargetMinutes: minActiveMs / 60_000, priorMinutesExcluded: previousState.sampledActiveMs / 60_000 })
    }
  }
  try {
    codeServer = await previewServer(workspaces.code, previousState?.origins.code); workServer = await previewServer(workspaces.work, previousState?.origins.work)
    plan = createCampaignPlan({ codeWorkspace: workspaces.code, workWorkspace: workspaces.work, codeOrigin: codeServer.origin, workOrigin: workServer.origin })
    artifact('campaign-plan.json', plan)
    state.origins = { code: codeServer.origin, work: workServer.origin }
    if (resumeRoot) {
      const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
      artifact('resume-settings-before.json', settings)
      // Work's folder picker persisted lastFolder. Restore only the known Code
      // owner at launch; retain account/model/engine and every other setting.
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...settings, lastFolder: workspaces.code, lastSessionId: state.modes.code.sessionId }, null, 2))
    } else writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: Number(process.env.AETHER_DUAL_ENGINE_PORT) || 12461,
      lastFolder: workspaces.code, lastSessionId: state.modes.code.sessionId, lastModelId: model.modelId, appearance: 'light', thinkingMode: 'off' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(profile, 'global'), AETHER_IDE_ENGINE_ENTRY: resolve(repository, '..', 'ai-agent-engine', 'dist', 'main.js'),
      WORKSPACE_ROOT: join(runRoot, 'scratch'), AUTH_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', OSM_MODE: 'balanced',
      ENABLE_LONG_TERM_MEMORY: 'true', AETHER_IDE_ECHO_ENGINE: '1', SKILLS_ROOT: join(profile, 'skills'), MCP_CONFIG_PATH: join(profile, 'mcp.json') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    log('starting', { controls, origins: state.origins })
    app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: repository, env, timeout: 90_000 })
    const capture = chunk => appendFileSync(join(evidenceRoot, 'desktop.log'), scrub(chunk.toString()))
    app.process().stdout?.on('data', capture); app.process().stderr?.on('data', capture)
    app.process().on('exit', (code, signal) => { if (!closing) { state.processErrors.push({ code, signal, at: Date.now() }); save() } })
    page = await app.firstWindow(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => { state.rendererErrors.push({ message: scrub(error.message), at: Date.now() }); save() })
    await app.evaluate(({ BrowserWindow, app: application }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1050)
      application.on('render-process-gone', (_event, contents, details) => console.error('[campaign render-process-gone]', contents.id, JSON.stringify(details)))
      application.on('child-process-gone', (_event, details) => console.error('[campaign child-process-gone]', JSON.stringify(details)))
    })
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
    if (resumeRoot) {
      const account = await page.evaluate(() => window.aether.account.getState())
      expect(account.status, 'reuse persisted account').toBe('authenticated')
      expect(account.user.id).toBe(previousState.engine.accountId)
      await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.accountId), { timeout: 30_000 }).toBe(previousState.engine.accountId)
      const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
      expect(engine.accountId).toBe(previousState.engine.accountId)
      expect(engine.baseUrl).toBe(previousState.engine.baseUrl)
      state.engine = { mode: engine.mode, version: engine.version, instanceId: engine.instanceId, buildId: engine.buildId, baseUrl: engine.baseUrl, accountId: engine.accountId }
      artifact('resume-engine-identity.json', { previous: previousState.engine, current: state.engine, allowedBoundary: 'one explicit process restart' })
      const catalog = await request('GET', '/models')
      expect((Array.isArray(catalog) ? catalog : catalog?.items || []).some(item => item.modelId === state.modelId && item.isEnabled), 'existing configured model').toBe(true)
      for (const mode of modes) {
        await selectMode(mode)
        await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId), { timeout: 30_000 }).toBe(state.modes[mode].sessionId)
        const security = await request('GET', '/security/mode', undefined, { sessionId: state.modes[mode].sessionId }, mode)
        expect(security.mode).toBe('full-access')
        await refreshRuns(mode)
      }
      // Resuming an existing task renders its workspace breadcrumb. The folder
      // picker belongs only to the new-task composer and is absent here.
      const restoredWorkTask = await workTask()
      expect(restoredWorkTask?.id, 'restored Work task owner').toBe(state.modes.work.sessionId)
      expect(normalized(restoredWorkTask?.workspacePath || ''), 'restored Work workspace').toBe(normalized(workspaces.work))
      const restoredWorkspace = page.locator('#mode-work .work-task-heading__project')
      await expect(restoredWorkspace).toContainText(basename(workspaces.work))
      expect(normalized(await restoredWorkspace.getAttribute('title') || '')).toBe(normalized(workspaces.work))
      state.resumeStartedAt = new Date().toISOString()
      previousTick = Date.now()
      await recoverSegment()
    } else {
    const account = await page.evaluate(() => window.aether.account.register())
    expect(account.status).toBe('authenticated')
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.accountId)).toBe(account.user.id)
    const created = await request('POST', '/models', model)
    await request('PUT', '/models/' + created.id, { isEnabled: true })
    expect((await request('POST', '/models/' + created.id + '/test', {})).success, 'real provider preflight').toBe(true)
    const catalog = await request('GET', '/models')
    const configured = (Array.isArray(catalog) ? catalog : catalog?.items || []).find(value => value.id === created.id)
    state.modelCapabilities = configured?.resolvedCapabilities ?? configured?.capabilities ?? null
    await page.evaluate(() => { localStorage.setItem('aether:queueSendMode', 'serial'); localStorage.setItem('aether.app.mode', 'code') })
    await page.reload()
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
    const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
    state.engine = { mode: engine.mode, version: engine.version, instanceId: engine.instanceId, buildId: engine.buildId, baseUrl: engine.baseUrl, accountId: engine.accountId }
    state.memoryPreferences = await request('GET', '/memory/preferences')
    expect(state.memoryPreferences.globalEnabled).toBe(false)
    expect(state.memoryPreferences.sessionDefaultEnabled).toBe(true)
    expect(state.memoryPreferences.enabled, 'memory capability must actually be enabled').toBe(true)
    state.browserSettings = await page.evaluate(() => window.aether.browser.getSettings())
    expect(state.browserSettings.aiEnabled).toBe(true)
    // Work owns an explicit folder; Code's initial folder remains intact.
    await selectMode('work')
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, workspaces.work)
    await page.locator('#mode-work .work-folder-button').click()
    await expect(page.locator('#mode-work .work-folder-button')).toContainText(basename(workspaces.work))
    await chooseModel('work'); await setFullMode('work')
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId || ''), { timeout: 30_000 }).toMatch(/^work-/)
    const workHomeConnection = await page.evaluate(() => window.aether.browser.getConnection())
    await chooseModel('code'); await setFullMode('code')
    // Authentication selects an account-scoped Code session even though the
    // startup settings hold the new embedded fallback ID. Read the actual UI owner.
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => Boolean(value.sessionId && value.sessionId !== workHomeConnection.sessionId)), { timeout: 30_000 }).toBe(true)
    const codeConnection = await page.evaluate(() => window.aether.browser.getConnection())
    state.modes.code.requestedStartupSessionId = state.modes.code.sessionId
    state.modes.code.sessionId = codeConnection.sessionId
    state.phase = 'running'; previousTick = Date.now()
    await submit('code', '[G00 基础开发]\n' + plan.code.baseline, 'G00', 'baseline')
    await expect.poll(async () => executing(await status('code')), { timeout: 90_000 }).toBe(true)
    await submit('work', '[W00 基础开发]\n' + plan.work.baseline, 'W00', 'baseline')
    await expect.poll(async () => executing(await status('work')), { timeout: 90_000 }).toBe(true)
    for (const mode of modes) {
      const security = await request('GET', '/security/mode', undefined, { sessionId: state.modes[mode].sessionId }, mode)
      expect(security.mode, `${mode} admitted session security`).toBe('full-access')
      await checkpoint(mode, 'baseline-running', { full: false })
    }
    log('both-baselines-started', { sessions: modes.map(mode => ({ mode, sessionId: state.modes[mode].sessionId })) })
    }
    for (;;) {
      const now = Date.now()
      if (now - auxiliaryElapsedMs >= deadline) throw new Error('Campaign exceeded its three-hour maximum budget excluding the separate context experiment')
      if (state.processErrors.length) throw new Error('Desktop process exited unexpectedly')
      if (state.rendererErrors.length) throw new Error('Renderer reported a runtime error')
      await processControls()
      const connection = await page.evaluate(() => window.aether.engine.getSnapshot())
      if (connection.phase !== 'ready' || connection.instanceId !== state.engine.instanceId) { state.lastConnection = connection; throw new Error('Engine became unavailable or changed instance during campaign') }
      const statusReads = await Promise.all(modes.map(async mode => ({ mode, observed: await observe(`${mode} status`, () => status(mode)) })))
      if (statusReads.some(row => !row.observed.ok)) { previousTick = Date.now(); save(); await delay(10_000); continue }
      const observations = statusReads.map(({ mode, observed }) => ({ mode, value: observed.value }))
      state.observationHold = null
      const sampledAt = Date.now(), elapsed = Math.max(0, sampledAt - previousTick)
      if (elapsed > 30_000) observationGap('sampling interval exceeded 30 seconds; interval excluded', new Error(`${elapsed} ms between observations`))
      previousTick = sampledAt
      // Conservatively credit only a run observed running at both interval ends;
      // an idle -> submit transition must never count the preceding idle period.
      const runningCount = observations.filter(row => row.value.run?.status === 'running' && state.modes[row.mode].lastStatus?.run?.status === 'running' && state.modes[row.mode].lastStatus.run.runId === row.value.run.runId).length
      if (runningCount && elapsed <= 30_000) {
        state.sampledActiveMs += elapsed
        state.continuousActiveMs += elapsed
        state.longestContinuousActiveMs = Math.max(state.longestContinuousActiveMs, state.continuousActiveMs)
      } else state.continuousActiveMs = 0
      if (runningCount === 2 && elapsed <= 30_000) state.sampledConcurrentMs += elapsed
      appendFileSync(join(evidenceRoot, 'status.jsonl'), serialize({ at: new Date().toISOString(), modes: observations.map(({ mode, value }) => ({ mode, streamRunning: value.running, finished: value.finished, run: value.run })) }).replace(/\n/g, '') + '\n')
      state.observations++
      for (const { mode, value } of observations) {
        const owner = state.modes[mode], previous = owner.lastStatus
        owner.lastStatus = value
        if (value.run?.runId) ingestRuns(mode, [value.run])
        const changed = previous?.run?.runId !== value.run?.runId || previous?.run?.status !== value.run?.status
        if (changed) await checkpoint(mode, 'run-transition', { full: Boolean(previous?.run && (terminal(value) || previous.run.runId !== value.run?.runId)) })
        if ((terminal(value) && value.run.status !== 'succeeded' || value.run?.status === 'waiting') && !owner.seenFailures.includes(value.run.runId)) {
          owner.seenFailures.push(value.run.runId)
          owner.blocked = { kind: value.run.status === 'waiting' ? 'user-interaction' : 'task-failed', runId: value.run.runId, outcome: value.run.status, at: Date.now() }
          state.issues.push({ mode, ...owner.blocked }); log('mode-needs-repair', { mode, ...owner.blocked })
        }
      }
      if (now - lastMetrics >= 30_000) {
        const result = await observe('OS diagnostics', () => page.evaluate(() => window.aether.engine.diagnostics({ refreshStorage: false })))
        if (result.ok) { appendFileSync(join(evidenceRoot, 'metrics.jsonl'), serialize({ at: new Date().toISOString(), diagnostics: result.value }).replace(/\n/g, '') + '\n'); state.metricSamples++ }
        lastMetrics = now
      }
      if (now - lastRuntime >= 10_000) {
        const result = await observe('runtime metrics', () => request('GET', '/performance/runtime'))
        if (result.ok) appendFileSync(join(evidenceRoot, 'runtime.jsonl'), serialize({ at: new Date().toISOString(), runtime: result.value }).replace(/\n/g, '') + '\n')
        lastRuntime = now
      }
      // UI operations may delay runtime sampling past its 15s idle lifetime.
      // Persist the actual warmup/ready state; never label these as gap-free samples.
      if (now - lastTurnSnapshot >= 60_000) {
        // Only admission reconciliation needs a fuller read without a run transition.
        // The steady-state loop otherwise stays on bounded status/OS diagnostics.
        for (const mode of modes) {
          const owner = state.modes[mode]
          if (owner.evidencePending) await checkpoint(mode, 'deferred-evidence-retry')
          else if (owner.submissions.some(item => !item.admittedRunId || !item.terminalOutcome)) await checkpoint(mode, 'lightweight-admission-reconciliation', { full: false })
        }
        lastTurnSnapshot = now
      }
      await recoverSegment()
      for (const mode of modes) await ensureProgress(mode, now)
      if (now - lastModeExercise >= 45_000) { await selectMode(currentMode === 'code' ? 'work' : 'code'); lastModeExercise = now }
      const allRequirementsDone = modes.every(mode => state.modes[mode].submissions.filter(item => item.kind === 'requirement' && submissionSucceeded(item)).length === 10 && state.modes[mode].completedBatches.length === 5)
      const allIdle = observations.every(({ value }) => !executing(value)) && modes.every(mode => state.modes[mode].submissions.every(item => Boolean(item.terminalOutcome)))
      const allResolved = submissionsSettled() && modes.every(mode => !state.modes[mode].blocked)
      if (allRequirementsDone && allIdle && allResolved) {
        if (state.sampledActiveMs >= minActiveMs) {
          if (state.phase !== 'awaiting-independent-review') {
            state.phase = 'awaiting-independent-review'
            await snapshotAll('awaiting-independent-review')
            log('awaiting-independent-review', { controls, activeMinutes: state.sampledActiveMs / 60_000 })
          }
          if (state.finishRequested && state.latestAudit?.passed) break
        }
        if (state.sampledActiveMs < minActiveMs && !state.pausedAdditions) {
          for (const mode of modes) {
            const owner = state.modes[mode]
            if (owner.extraAudits >= 12) throw new Error('Meaningful regression rounds exhausted before the active-load target; no idle time counted')
            const iteration = ++owner.extraAudits
            await submit(mode, `[${mode === 'code' ? 'GA' : 'WA'}${iteration}] 持续稳定性验收轮次 ${iteration}\n继续使用当前项目的 Aether 内置浏览器，复用属于本会话的页面，对尚未覆盖的边界局面、连续撤销重做、刷新存档、无效棋谱输入和桌面/360像素移动视口做真实交互回归。先查看既有 CHANGELOG，选择新边界并记下期望结果，至少执行两个不同场景；读取 console/network，检查是否有异常，发现问题直接修复并复验。不得用无意义 sleep 或只写报告消耗时间，不得运行外部浏览器。把实际新增证据记录到 STABILITY.md，保留失败历史。\n项目 ${workspaces[mode]}；唯一预览 ${plan[mode].origin}。`, `${mode === 'code' ? 'GA' : 'WA'}${iteration}`, 'regression')
          }
        }
      }
      log('progress', { activeMinutes: +(state.sampledActiveMs / 60_000).toFixed(1), continuousMinutes: +(state.continuousActiveMs / 60_000).toFixed(1), longestContinuousMinutes: +(state.longestContinuousActiveMs / 60_000).toFixed(1), concurrentMinutes: +(state.sampledConcurrentMs / 60_000).toFixed(1), modes: modes.map(mode => ({ mode, runId: state.modes[mode].lastStatus?.run?.runId, status: state.modes[mode].lastStatus?.run?.status, requirementsDone: state.modes[mode].submissions.filter(item => item.kind === 'requirement' && item.terminalOutcome === 'succeeded').length, nextBatch: state.modes[mode].nextBatch })) })
      save(); await delay(10_000)
    }
    state.phase = 'final-evidence'
    await snapshotAll('final')
    expect(state.sampledActiveMs, '>=60 minutes of verified task load in this one engine segment; gaps and idle excluded').toBeGreaterThanOrEqual(minActiveMs)
    expect(state.sampledConcurrentMs, 'two modes must have overlapping durable running intervals').toBeGreaterThan(0)
    expect(state.modeSwitches, 'exercise repeated foreground changes').toBeGreaterThanOrEqual(20)
    const firstRuntime = await request('GET', '/performance/runtime')
    await delay(5_100)
    artifact('runtime-final-pair.json', { first: firstRuntime, second: await request('GET', '/performance/runtime') })
    for (const mode of modes) {
      const owner = state.modes[mode]
      expect(existsSync(join(workspaces[mode], 'index.html'))).toBe(true)
      const tabs = await page.evaluate(() => window.aether.browser.list())
      let tab = tabs.find(value => value.context?.sessionId === owner.sessionId && value.url.startsWith(plan[mode].origin))
      if (!tab) {
        await selectMode(mode)
        await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId)).toBe(owner.sessionId)
        tab = await page.evaluate(url => window.aether.browser.create({ url }), plan[mode].origin)
        log('harness-reopened-final-preview', { mode, tabId: tab.tabId, evidenceKind: 'harness-only-not-model-tool-use' })
      }
      for (const kind of ['snapshot', 'console', 'network']) {
        const result = await page.evaluate(({ tabId, kind }) => window.aether.browser.read(tabId, kind), { tabId: tab.tabId, kind })
        artifact(`final-${mode}-browser-${kind}.json`, result)
        if (!result.success) throw new Error(`${mode} final browser ${kind} failed: ${result.error}`)
      }
      const shot = await page.evaluate(tabId => window.aether.browser.read(tabId, 'screenshot'), tab.tabId)
      if (shot.success && shot.output?.dataUrl) writeFileSync(join(evidenceRoot, `final-${mode}-browser.png`), Buffer.from(shot.output.dataUrl.split(',')[1], 'base64'))
      const manifest = await manifestWorkspace(workspaces[mode])
      artifact(`final-${mode}-manifest.json`, manifest)
      if (manifest.partial) throw new Error(`${mode} final workspace manifest is partial`)
    }
    if (state.rendererErrors.length || !submissionsSettled() || modes.some(mode => state.modes[mode].blocked || state.modes[mode].evidencePending || state.modes[mode].unmatchedRunIds?.length) || !state.latestAudit?.passed) throw new Error('Final verification gates changed; execution cannot be marked complete')
    state.productAcceptance = 'passed-independent-audit'
    state.executionPassed = true; state.phase = 'completed'; state.finishedAt = new Date().toISOString()
    log('campaign-execution-completed', { activeMinutes: state.sampledActiveMs / 60_000, concurrentMinutes: state.sampledConcurrentMs / 60_000, productAcceptance: state.productAcceptance })
  } catch (error) {
    state.error = scrub(error.stack || error); state.phase = 'failed'; state.finishedAt = new Date().toISOString()
    try { state.lastConnection = await page?.evaluate(() => window.aether.engine.getSnapshot()) } catch { /* Preserve original failure. */ }
    for (const mode of modes) try { if (page && plan && state.modes[mode].sessionId) await checkpoint(mode, 'failure') } catch (captureError) { state.issues.push({ kind: 'failure-capture', mode, error: scrub(captureError) }) }
    await page?.screenshot({ path: join(evidenceRoot, 'failure.png') }).catch(() => {})
    log('campaign-failed', { error: state.error, runRoot }); process.exitCode = 1
  } finally {
    closing = true; save()
    await app?.close().catch(error => { state.issues.push({ kind: 'close', error: scrub(error) }) })
    await codeServer?.close(); await workServer?.close()
    artifact('report.json', { phase: state.phase, executionPassed: state.executionPassed, productAcceptance: state.productAcceptance, error: state.error,
      startedAt: state.startedAt, finishedAt: state.finishedAt, engine: state.engine, sampledActiveMs: state.sampledActiveMs, sampledConcurrentMs: state.sampledConcurrentMs,
      segmentId: state.segmentId, previousSegments: state.previousSegments, longestContinuousActiveMs: state.longestContinuousActiveMs,
      observationGapCount: state.observationGapCount || 0, observationGaps: state.observationGaps,
      modeSwitches: state.modeSwitches, workspaces, origins: state.origins, modes: state.modes, issues: state.issues, rendererErrors: state.rendererErrors })
    save()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node scripts/run-dual-mode-campaign.mjs\nAETHER_DUAL_RUN_ROOT creates a new campaign; AETHER_DUAL_RESUME_ROOT resumes a stopped campaign with preserved profile, fixed preview origins and a new engine segment with >=60 minutes of measured task load (gaps/idle excluded). Never set both.\nOptional AETHER_DUAL_ENGINE_PORT, AETHER_DUAL_MAX_MINUTES (<=180), AETHER_DUAL_MIN_ACTIVE_MINUTES (default60).\nControl <runRoot>/commands.json: {commands:[{id,action:"snapshot"|"pause-additions"|"resume-additions"|"stop"|"audit"|"finish"},{id,action:"message",mode:"code"|"work",text,repairIds:["G01"]},{id,action:"resume-mode",mode:"code"|"work"}]}\nrepairIds allows one target. audit imports only scripts/audit-dual-mode-games.mjs export audit({app,page,state,request,artifact,log}); it must return {passed:true} before finish. The app remains open after execution gates until explicit finish.')
  else await main()
}
