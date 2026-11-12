/** Real Electron/engine acceptance controller. Startup never sends a model request.
 * Run explicitly with --start --root <campaign> --round 1 --app-entry <index.js>
 * --engine-entry <main.js>. The loopback control.json contains the control token.
 * POST /send {id,role:'product'|'development',promptFile|text} uses the real UI.
 * --resume-inspection reopens a closed round without registering/seeding/sending.
 * --resume (or --resume-inspection --allow-model-actions) enables explicit send/retry.
 * GET /status, /ui-state; POST /snapshot, /screenshot, /preview, /stop, /retry,
 * /audit-office, /audit-go, /cancel-audit, /close. Inspection artifacts never replace original state.
 * Two roots share files, but forwarding is a supervisor action, not native peer messaging.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { readConfiguredModel } from './gomoku-model-seed.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const active = value => ['preparing', 'running', 'waiting', 'cancelling'].includes(value?.run?.status)
const sha = value => createHash('sha256').update(value).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const normalized = path => resolve(path).replaceAll('\\', '/').toLowerCase()
const safeName = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
const terminal = value => value && !value.running && ['succeeded', 'cancelled', 'failed', 'interrupted'].includes(value.run?.status)

export function parseArguments(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (['--start', '--check', '--resume-inspection', '--resume', '--allow-model-actions'].includes(key)) options[key.slice(2)] = true
    else if (key.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key.slice(2)] = argv[++i]
    else throw new Error('Invalid controller argument: ' + key)
  }
  if (options.start && options.check) throw new Error('Choose --start or --check')
  if (options.resume && options['resume-inspection']) throw new Error('Choose --resume or --resume-inspection')
  if (options['allow-model-actions'] && !options['resume-inspection']) throw new Error('--allow-model-actions requires --resume-inspection')
  return options
}

/** Read-only preflight, including offline proof that reopening cannot resume an active run. */
export function checkedResume(options) {
  assert.ok(options.resume || options['resume-inspection'], 'Resume flag required')
  const round = Number(options.round || 1)
  assert.ok(Number.isSafeInteger(round) && round > 0, 'Invalid round')
  const campaign = resolve(options.root || 'D:/trust-test/cooperative-acceptance-20261103')
  const root = join(campaign, `round-${round}`), statePath = join(root, 'state.json')
  const originalBytes = readFileSync(statePath), original = JSON.parse(originalBytes)
  assert.equal(original.schemaVersion, 1, 'Unsupported saved round state')
  for (const [key, path] of Object.entries({ campaign, root, workspace: join(root, 'workspace'), profile: join(root, 'profile'), evidence: join(campaign, 'evidence', `round-${round}`) })) {
    assert.equal(normalized(original[key]), normalized(path), `Saved ${key} does not match requested round`)
    assert.ok(statSync(path).isDirectory(), `Saved ${key} is not a directory`)
  }
  assert.equal(original.round, round, 'Saved round differs')
  assert.equal(original.phase, 'closed', 'Close the old controller before resuming the round')
  assert.ok(original.startedAt && original.engine?.accountId && original.modelId && original.modelRecordId, 'Incomplete original identity')
  assert.equal(original.engine.mode, 'embedded', 'Only saved embedded rounds can be resumed')
  const saved = original.builds
  for (const key of ['appEntry', 'engineEntry', 'appSha256', 'engineSha256']) assert.ok(typeof saved?.[key] === 'string', `Missing saved ${key}`)
  for (const [argument, key] of [['app-entry', 'appEntry'], ['engine-entry', 'engineEntry']]) if (options[argument]) {
    assert.equal(normalized(options[argument]), normalized(saved[key]), 'Resume must use the original build paths')
  }
  const builds = checkedBuilds({ ...options, 'app-entry': saved.appEntry, 'engine-entry': saved.engineEntry,
    'app-sha': saved.appSha256, 'engine-sha': saved.engineSha256 })
  if (options['app-sha']) assert.equal(options['app-sha'].replace(/^sha256:/, ''), saved.appSha256)
  if (options['engine-sha']) assert.equal(options['engine-sha'].replace(/^sha256:/, ''), saved.engineSha256)
  assert.deepEqual(builds.manifest, saved.manifest, 'Saved engine manifest changed')
  assert.equal(original.engine.buildId, builds.manifest.buildId, 'Saved running engine build differs')
  assert.ok(!options['model-db'] && !options['model-id'] && !options['engine-port'], 'Resume uses saved model and engine settings')
  const settingsPath = join(original.profile, 'settings.json'), settingsBytes = readFileSync(settingsPath), settings = JSON.parse(settingsBytes)
  assert.equal(settings.engineMode, 'embedded', 'Saved profile changed engine mode')
  assert.equal(normalized(settings.lastFolder), normalized(original.workspace), 'Saved profile changed workspace')
  const lastObservation = original.finalStatus || JSON.parse(readFileSync(join(original.evidence, 'status.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1))
  assert.equal(lastObservation.engine?.instanceId, original.engine.instanceId, 'Last status belongs to another engine instance')
  for (const [role, mode] of [['product', 'work'], ['development', 'code']]) {
    const owner = original.roles?.[role], observed = lastObservation.roles?.[role]
    assert.equal(owner?.mode, mode, 'Saved role mode differs')
    assert.ok(owner.sessionId && Array.isArray(owner.submissions), 'Saved role identity missing')
    assert.equal(observed?.sessionId, owner.sessionId, 'Last observed session differs')
    assert.ok(terminal(observed?.status), `${role} must be observed terminal before closing; active tasks cannot be inspection-resumed`)
    const lastSend = owner.submissions.at(-1)
    assert.ok(!lastSend || lastObservation.at >= lastSend.at || original.finalStatus, 'Final observation predates the last submission')
  }
  return { original, builds, statePath, originalStateSha256: sha(originalBytes), profileSettingsSha256: sha(settingsBytes), lastObservation }
}

export function retryIntent(input, owner, before) {
  assert.ok(typeof input.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.id), 'Unique retry id required')
  const expected = input.expected
  for (const key of ['sessionId', 'runId', 'turnId']) assert.ok(typeof expected?.[key] === 'string' && expected[key], `Retry expected.${key} required`)
  for (const key of ['userMessageId', 'turnId']) assert.ok(typeof input.target?.[key] === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.target[key]), `Retry target.${key} required`)
  assert.equal(owner?.sessionId, expected.sessionId, 'Retry session differs from role')
  assert.ok(!active(before) && !before?.running && terminal(before), 'Cannot retry while running, waiting, preparing, cancelling, or unknown')
  assert.equal(before.run.sessionId, expected.sessionId, 'Retry session changed')
  assert.equal(before.run.runId, expected.runId, 'Retry root run changed')
  assert.equal(before.run.turnId, expected.turnId, 'Retry root turn changed')
  return { role: input.role, expected: { sessionId: expected.sessionId, runId: expected.runId, turnId: expected.turnId },
    target: { userMessageId: input.target.userMessageId, turnId: input.target.turnId } }
}

export function checkedBuilds(options) {
  const appEntry = resolve(options['app-entry'] || join(repo, 'out/main/index.js'))
  const engineEntry = resolve(options['engine-entry'] || join(repo, '../ai-agent-engine/dist/main.js'))
  const appSha256 = sha(readFileSync(appEntry)), engineSha256 = sha(readFileSync(engineEntry))
  if (options['app-sha']) assert.equal(appSha256, options['app-sha'].replace(/^sha256:/, ''), 'Client entry changed')
  if (options['engine-sha']) assert.equal(engineSha256, options['engine-sha'].replace(/^sha256:/, ''), 'Engine entry changed')
  const manifest = JSON.parse(readFileSync(join(dirname(engineEntry), 'runtime/build-manifest.json'), 'utf8'))
  assert.match(manifest.buildId, /^sha256:[a-f0-9]{64}$/)
  return { appEntry, engineEntry, appSha256, engineSha256, manifest }
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|SOURCE_KEY|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS/i.test(key)))
}

export async function launchController(options) {
  const resumed = options.resume || options['resume-inspection'] ? checkedResume(options) : null
  const builds = resumed?.builds || checkedBuilds(options)
  const modelActionsAllowed = !options['resume-inspection'] || Boolean(options['allow-model-actions'])
  const round = Number(options.round || 1)
  assert.ok(Number.isSafeInteger(round) && round > 0, 'Invalid round')
  const campaign = resolve(options.root || 'D:/trust-test/cooperative-acceptance-20261103')
  const root = join(campaign, `round-${round}`)
  if (!resumed) assert.ok(!existsSync(root), 'Refusing to reuse a round/profile; select a fresh campaign or round')
  const inspectionId = resumed ? stamp() + '-' + randomBytes(4).toString('hex') : null
  const controllerRoot = resumed ? join(root, 'inspections', inspectionId) : root
  const workspace = join(root, 'workspace'), profile = join(root, 'profile')
  const evidence = resumed ? join(resumed.original.evidence, 'inspections', inspectionId) : join(campaign, 'evidence', `round-${round}`)
  assert.ok(!existsSync(evidence), 'Refusing to overwrite prior evidence')
  const model = resumed ? null : readConfiguredModel({ database: options['model-db'], modelId: options['model-id'] || 'deepseek-v4.1-flash',
    ...(process.env.AETHER_ACCEPTANCE_SOURCE_KEY ? { encryptionKey: process.env.AETHER_ACCEPTANCE_SOURCE_KEY } : {}) })
  if (model) assert.equal(new URL(model.baseUrl).protocol, 'https:', 'Real-model acceptance requires HTTPS')
  const secrets = [model?.apiKey, process.env.ENCRYPTION_KEY, process.env.AETHER_ACCEPTANCE_SOURCE_KEY].filter(Boolean)
  const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  const encode = value => scrub(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const directories = resumed ? [controllerRoot, evidence] : [workspace, profile, join(profile, 'skills'), evidence, join(workspace, 'product'), join(workspace, 'app'), join(workspace, 'handoff')]
  for (const dir of directories) mkdirSync(dir, { recursive: true })
  const state = resumed ? { ...structuredClone(resumed.original), evidence, controllerRoot, phase: 'launching', inspectionId,
    inspectionStartedAt: new Date().toISOString(), originalStatePath: resumed.statePath, originalStateSha256: resumed.originalStateSha256,
    originalEvidence: resumed.original.evidence, originalEngine: structuredClone(resumed.original.engine),
    profileSettingsSha256AtOpen: resumed.profileSettingsSha256, priorErrors: structuredClone(resumed.original.errors), errors: [], modelActionsAllowed,
    startup: { mode: 'resume', accountRegistrations: 0, modelSeeds: 0, sessionsCreated: 0, modelRequests: 0 } }
    : { schemaVersion: 1, root, campaign, round, workspace, profile, evidence, builds, modelId: model.modelId,
      startedAt: new Date().toISOString(), phase: 'launching', roles: { product: { mode: 'work', submissions: [] }, development: { mode: 'code', submissions: [] } }, errors: [], modelActionsAllowed }
  const save = () => {
    if (resumed) assert.equal(sha(readFileSync(resumed.statePath)), resumed.originalStateSha256, 'Original state changed while inspecting')
    writeFileSync(join(controllerRoot, 'state.json.tmp'), encode(state)); renameSync(join(controllerRoot, 'state.json.tmp'), join(controllerRoot, 'state.json'))
  }
  const artifact = (name, data) => { const path = resolve(evidence, name)
    assert.ok(normalized(path).startsWith(normalized(evidence) + '/'), 'Artifact must remain inside this inspection evidence directory')
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, encode(data)); return path }
  const log = (kind, data = {}) => appendFileSync(join(evidence, 'events.jsonl'), encode(JSON.stringify({ at: Date.now(), kind, ...data })) + '\n')
  const preferredPort = Number(options['engine-port'] || 12471 + round)
  if (!resumed) writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort,
    lastFolder: workspace, lastModelId: model.modelId, appearance: 'light', thinkingMode: 'off' }))
  save()
  let app, page, server, timer, activeAudit, closing = false, uiTail = Promise.resolve()
  const ui = action => { const next = uiTail.then(() => { assert.ok(!closing, 'Controller is closing'); return action() }); uiTail = next.catch(() => {}); return next }
  const cancelAudit = reason => {
    if (!activeAudit) return { cancelled: false, reason: 'No active audit' }
    const { id, kind, cancelFile, controller } = activeAudit
    writeFileSync(cancelFile, String(reason || 'Cancelled by controller'))
    controller.abort(new Error('AUDIT_CANCELLED: ' + (reason || 'Cancelled by controller')))
    log('audit-cancel', { id, kind, reason }); return { cancelled: true, id, kind, cancelFile }
  }
  const expected = () => ({ mode: state.engine.mode, baseUrl: state.engine.baseUrl, instanceId: state.engine.instanceId, accountId: state.engine.accountId })
  const request = async (method, path, body, query, mode = 'work') => {
    if (!modelActionsAllowed) assert.equal(method, 'GET', 'Inspection request bridge is read-only')
    const response = await page.evaluate(input => window.aether.engine.request(input), { method, path, body, query,
      ...(state.engine ? { expectedEngine: expected() } : {}), toolProfile: mode === 'code' ? 'code' : 'general' })
    if (!response.ok) throw new Error(scrub(`${method} ${path}: ${response.code} ${response.message}`))
    return response
  }
  const tasks = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('aether.work.state.v1'))
    .flatMap(([, value]) => { const entry = JSON.parse(value); return (entry.tasks || []).map(task => ({ ...task, active: task.id === entry.activeTaskId })) }))
  const modeSurface = mode => page.locator('#mode-' + mode)
  const selectMode = async mode => { await page.getByRole('tab', { name: mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click(); await expect(modeSurface(mode)).toHaveAttribute('aria-hidden', 'false') }
  const select = async role => {
    const owner = state.roles[role]; assert.ok(owner, 'Unknown role')
    await selectMode(owner.mode)
    if (owner.mode === 'work' && owner.sessionId) {
      const task = (await tasks()).find(item => item.id === owner.sessionId)
      assert.ok(task, 'Work task missing')
      if (!task.active) {
        const matching = modeSurface('work').locator('.work-sidebar__task').filter({ hasText: task.title })
        assert.equal(await matching.count(), 1, 'Ambiguous Work task title; refusing to select a different task')
        await matching.click()
      }
      await expect.poll(async () => (await tasks()).find(item => item.active)?.id).toBe(owner.sessionId)
    }
    if (owner.mode === 'code' && owner.sessionId && (await page.evaluate(() => window.aether.browser.getConnection())).sessionId !== owner.sessionId) {
      const history = modeSurface('code').getByRole('button', { name: '会话历史', exact: true })
      if (await history.getAttribute('aria-pressed') !== 'true') await history.click()
      const item = modeSurface('code').locator('[data-session-id]').filter({ visible: true })
      const target = item.and(modeSurface('code').locator('[data-session-id=' + JSON.stringify(owner.sessionId) + ']'))
      await expect(target).toHaveCount(1); await target.click()
    }
    if (owner.sessionId) await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => value.sessionId), { timeout: 30_000 }).toBe(owner.sessionId)
  }
  const status = async () => {
    const roles = {}
    for (const [name, owner] of Object.entries(state.roles)) roles[name] = { ...owner,
      ...(owner.sessionId ? { status: (await request('GET', '/chat/status', undefined, { sessionId: owner.sessionId }, owner.mode)).data } : {}) }
    return { at: Date.now(), phase: state.phase, round, workspace, modelId: state.modelId, modelActionsAllowed,
      inspectionId, engine: state.engine, originalEngine: state.originalEngine, roles, errors: state.errors,
      audit: activeAudit ? { id: activeAudit.id, kind: activeAudit.kind, cancelFile: activeAudit.cancelFile, cancelled: activeAudit.controller.signal.aborted } : null }
  }
  const configure = async role => {
    assert.ok(!resumed && modelActionsAllowed, 'Resumed rounds may only use their existing sessions')
    const owner = state.roles[role], surface = modeSurface(owner.mode)
    await selectMode(owner.mode)
    if (owner.mode === 'work') {
      await surface.getByRole('button', { name: '新任务', exact: true }).click()
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, workspace)
      await surface.getByRole('button', { name: '选择工作区', exact: true }).click()
      await expect(surface.locator('.work-folder-button')).toContainText(basename(workspace))
    }
    const picker = surface.getByRole('button', { name: owner.mode === 'work' ? '使用的模型' : '选择模型', exact: true })
    await expect(picker).toBeEnabled({ timeout: 90_000 }); await picker.click()
    await page.getByRole('menuitem').filter({ hasText: model.displayName || model.modelId }).first().click()
    const permission = surface.getByRole('button', { name: /^切换本会话访问权限：/ })
    if (!(await permission.innerText()).includes('完全访问')) { await permission.click(); await page.getByRole('menuitem', { name: /^完全访问/ }).click() }
    await expect(permission).toContainText('完全访问')
    if (owner.mode === 'code') {
      await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()).then(value => Boolean(value.status === 'connected' && value.sessionId && value.sessionId !== state.roles.product.sessionId)), { timeout: 30_000 }).toBe(true)
      owner.sessionId = (await page.evaluate(() => window.aether.browser.getConnection())).sessionId
      assert.notEqual(owner.sessionId, state.roles.product.sessionId)
    }
    save()
  }
  const send = async input => {
    assert.ok(modelActionsAllowed, 'Inspection mode forbids model actions; use explicit --allow-model-actions or --resume')
    assert.ok(typeof input.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.id), 'Unique submission id required')
    const owner = state.roles[input.role]; assert.ok(owner, 'Unknown role')
    const text = typeof input.text === 'string' ? input.text : readFileSync(resolve(input.promptFile), 'utf8')
    assert.ok(text.trim(), 'Empty prompt')
    const hash = sha(text), prior = owner.submissions.find(record => record.id === input.id)
    if (prior) { assert.equal(prior.promptSha256, hash, 'Submission ID already belongs to another prompt'); return prior }
    assert.equal(sha(readFileSync(builds.appEntry)), builds.appSha256, 'Client entry changed during run')
    assert.equal(sha(readFileSync(builds.engineEntry)), builds.engineSha256, 'Engine entry changed during run')
    if (!owner.sessionId) await configure(input.role); else await select(input.role)
    const before = owner.sessionId ? (await request('GET', '/chat/status', undefined, { sessionId: owner.sessionId }, owner.mode)).data : null
    const record = { id: input.id, at: Date.now(), promptSha256: hash, phase: 'preparing-ui', submittedWhileRunning: active(before), beforeRunId: before?.run?.runId,
      ...(input.forwardedFrom ? { forwardedFrom: input.forwardedFrom, transfer: 'supervisor-ui-forwarding' } : {}) }
    owner.submissions.push(record); artifact(`prompts/${input.role}-${input.id}.txt`, text); save()
    try {
      const surface = modeSurface(owner.mode)
      const composer = surface.locator(owner.mode === 'code' ? '.chat__surface .input-composer__input[role="textbox"]' : '.input-composer__input[role="textbox"]').filter({ visible: true }).first()
      await expect(composer).toBeEditable({ timeout: 30_000 }); await composer.fill(text)
      record.phase = 'dispatching'; save()
      if (owner.mode === 'code' && active(before)) await composer.press('Enter')
      else { const button = surface.getByRole('button', { name: /^(开始任务|排到下一轮|发送)$/ }).filter({ visible: true }).last(); await expect(button).toBeEnabled(); await button.click() }
      await expect(composer).toHaveText('', { timeout: 20_000 })
      if (!owner.sessionId) {
        await expect.poll(async () => (await tasks()).find(item => item.active)?.id, { timeout: 30_000 }).toMatch(/^work-/)
        owner.sessionId = (await tasks()).find(item => item.active).id
        const task = (await tasks()).find(item => item.id === owner.sessionId)
        assert.equal(normalized(task.workspacePath), normalized(workspace)); assert.equal(task.modelId, state.modelId)
      }
      if (!active(before)) await expect.poll(async () => (await request('GET', '/chat/status', undefined, { sessionId: owner.sessionId }, owner.mode)).data?.run?.runId || '', { timeout: 90_000 }).not.toBe(before?.run?.runId || '')
      const after = (await request('GET', '/chat/status', undefined, { sessionId: owner.sessionId }, owner.mode)).data
      record.phase = 'ui-accepted'; record.sessionId = owner.sessionId; record.afterRun = after.run
      if (after.run?.workspacePaths) assert.deepEqual(after.run.workspacePaths.map(normalized), [normalized(workspace)])
      if (after.run?.actualModelId) assert.equal(after.run.actualModelId, state.modelId)
      if (owner.mode === 'work' && active(before)) record.queue = await page.evaluate(input => window.aether.workQueue.invoke(input), { taskId: owner.sessionId, expectedEngine: expected(), action: { kind: 'read' } })
      save(); log('ui-send', { role: input.role, ...record }); return record
    } catch (error) { record.phase = 'outcome-unconfirmed'; record.error = scrub(error.message); save(); throw error }
  }
  const uiState = async () => ({ source: 'electron-dom', nativeScreenVerified: false, at: Date.now(),
    connection: await page.evaluate(() => window.aether.browser.getConnection()),
    dom: await page.evaluate(() => {
      const visible = element => {
        if (element.closest('[aria-hidden="true"], [hidden]')) return false
        const style = getComputedStyle(element), box = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0
      }
      const label = element => (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180)
      const collect = selector => [...document.querySelectorAll(selector)].filter(visible)
      return {
        surfaces: collect('#mode-work, #mode-code').map(element => ({ id: element.id,
          headings: [...element.querySelectorAll('h1,h2,[role="heading"]')].filter(visible).map(label) })),
        tabs: collect('[role="tab"]').map(element => ({ label: label(element), selected: element.getAttribute('aria-selected') === 'true' })),
        buttons: collect('button,[role="button"],[role="menuitem"]').map(element => ({ label: label(element),
          disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true', pressed: element.getAttribute('aria-pressed') })),
        dialogs: collect('[role="dialog"],[role="alertdialog"]').map(element => ({ label: label(element), text: element.innerText.slice(0, 1500) })),
        messages: collect('article[data-message-id]').map(element => ({ messageId: element.getAttribute('data-message-id'), turnId: element.getAttribute('data-turn-id'),
          role: element.classList.contains('message--user') || element.classList.contains('work-message--user') ? 'user' : 'assistant' })),
        composers: collect('.input-composer__input[role="textbox"]').map(element => ({ label: element.getAttribute('aria-label'), characters: (element.textContent || '').length,
          editable: element.getAttribute('contenteditable') === 'true', disabled: element.getAttribute('aria-disabled') === 'true' })),
        alerts: collect('[role="alert"],[role="status"]').map(element => label(element)),
        focused: document.activeElement ? { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') } : null
      }
    }) })
  const retry = async input => {
    assert.ok(modelActionsAllowed, 'Inspection mode forbids model actions; use explicit --allow-model-actions or --resume')
    const owner = state.roles[input.role]; assert.ok(owner?.sessionId, 'Existing role session required')
    const inputHash = sha(JSON.stringify({ role: input.role, expected: input.expected, target: input.target }))
    const records = owner.retries ||= [], prior = records.find(record => record.id === input.id)
    if (prior) { assert.equal(prior.inputHash, inputHash, 'Retry ID belongs to a different target'); return prior }
    assert.ok(!records.some(record => record.inputHash === inputHash), 'Retry target already dispatched with another action ID')
    assert.ok(!records.some(record => ['dispatching', 'outcome-unconfirmed'].includes(record.phase)), 'An earlier retry has uncertain outcome; inspect before another retry')
    assert.equal(sha(readFileSync(builds.appEntry)), builds.appSha256, 'Client entry changed during run')
    assert.equal(sha(readFileSync(builds.engineEntry)), builds.engineSha256, 'Engine entry changed during run')
    const readStatus = async () => (await request('GET', '/chat/status', undefined, { sessionId: owner.sessionId }, owner.mode)).data
    const before = await readStatus(), intent = retryIntent(input, owner, before)
    const history = (await request('GET', '/conversation/history', undefined, { sessionId: owner.sessionId }, owner.mode)).data
    assert.ok(Array.isArray(history), 'Retry history is unavailable')
    const message = history.find(row => row.id === intent.target.userMessageId)
    assert.equal(message?.role, 'user', 'Retry target must be an existing user message in current history')
    assert.equal(message.metadata?.turnId || message.conversationId, intent.target.turnId, 'Retry target turn differs')
    await select(input.role)
    const article = modeSurface(owner.mode).locator('article[data-message-id=' + JSON.stringify(intent.target.userMessageId) + ']')
    await expect(article).toHaveCount(1)
    await expect(article).toBeVisible()
    const label = owner.mode === 'work' ? '重新发起' : '重新发送'
    const button = article.getByRole('button', { name: label, exact: true })
    await article.hover(); await expect(button).toBeEnabled()
    retryIntent(input, owner, await readStatus())
    const record = { id: input.id, inputHash, at: Date.now(), source: 'real-ui-user-message-retry', ...intent,
      targetContentSha256: sha(message.content || ''), before: { sessionId: owner.sessionId, runId: before.run.runId, turnId: before.run.turnId,
        userMessageId: before.run.userMessageId, status: before.run.status }, phase: 'opening-confirmation' }
    records.push(record); save()
    try {
      await button.click()
      const dialog = page.getByRole('dialog', { name: label, exact: true })
      await expect(dialog).toBeVisible()
      record.confirmationText = await dialog.innerText()
      retryIntent(input, owner, await readStatus())
      record.phase = 'dispatching'; record.confirmedAt = Date.now(); save()
      await dialog.getByRole('button', { name: owner.mode === 'work' ? '重新发起' : '确定', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await readStatus()).run?.runId || before.run.runId, { timeout: 90_000 }).not.toBe(before.run.runId)
      const after = await readStatus()
      assert.equal(after.run.sessionId, owner.sessionId, 'Retry switched session')
      assert.notEqual(after.run.turnId, before.run.turnId, 'Retry did not create a new turn')
      record.phase = 'ui-accepted'; record.acceptedAt = Date.now()
      record.after = { sessionId: after.run.sessionId, runId: after.run.runId, turnId: after.run.turnId,
        userMessageId: after.run.userMessageId, status: after.run.status }
      record.afterRun = after.run; save(); log('ui-retry', { role: input.role, ...record }); return record
    } catch (error) { record.phase = 'outcome-unconfirmed'; record.error = scrub(error.message); save(); throw error }
  }
  const audit = async (kind, input) => {
    assert.ok(!activeAudit, 'Another audit is active')
    const entry = { office: ['cooperative-office-audit.mjs', 'auditOffice'], go: ['cooperative-go-ui-audit.mjs', 'auditGo'] }[kind]
    assert.ok(entry, 'Unknown audit')
    const path = join(repo, 'scripts', entry[0])
    assert.ok(existsSync(path), `Audit module missing: ${entry[0]}`)
    const moduleSha256 = sha(readFileSync(path)), url = pathToFileURL(path)
    url.searchParams.set('sha256', moduleSha256)
    const module = await import(url.href)
    assert.equal(typeof module[entry[1]], 'function', `Audit module must export ${entry[1]}`)
    const id = stamp() + '-' + randomBytes(4).toString('hex'), controller = new AbortController()
    const cancelFile = join(evidence, 'cancel-audit-' + id + '.flag')
    activeAudit = { id, kind, controller, cancelFile }
    const monitor = setInterval(() => { if (existsSync(cancelFile) && !controller.signal.aborted) controller.abort(new Error('AUDIT_CANCELLED: cancellation file detected')) }, 100)
    monitor.unref()
    log('audit-start', { id, kind, moduleSha256, cancelFile })
    try {
      const result = await module[entry[1]]({ app, page, state, request, artifact, select, screenshot, uiState, workspace, evidence,
        signal: controller.signal, cancelFile }, input)
      controller.signal.throwIfAborted()
      log('audit-complete', { id, kind, moduleSha256 }); return { moduleSha256, source: 'electron-dom', nativeScreenVerified: false, result }
    } finally { clearInterval(monitor); activeAudit = undefined }
  }
  const archive = async (sessionId, prefix) => {
    const first = await request('GET', '/conversation/archive', undefined, { sessionId, current: 1, pageSize: 100 })
    assert.ok(first.pagination && Array.isArray(first.data), 'Archive must be paginated')
    const revision = first.metadata?.archiveRevision, total = first.pagination.total, rows = [], pages = []
    for (let current = 1; current <= Math.max(1, first.pagination.totalPages); current++) {
      const response = current === 1 ? first : await request('GET', '/conversation/archive', undefined, { sessionId, current, pageSize: 100 })
      assert.equal(response.pagination?.total, total, 'Archive changed during read; retry after settling')
      assert.equal(response.metadata?.archiveRevision, revision, 'Archive revision changed during read')
      assert.equal(response.data.length, Math.max(0, Math.min(100, total - (current - 1) * 100)), 'Incomplete archive page')
      pages.push(artifact(`${prefix}/archive-${current}.json`, response)); rows.push(...response.data)
    }
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'Duplicate archive IDs')
    return { sessionId, total, revision, backend: first.metadata?.backend, pages, rows }
  }
  const snapshot = async () => {
    const directory = 'snapshots/' + stamp(), summary = { at: Date.now(), status: await status(), roots: {}, files: [] }
    for (const [role, owner] of Object.entries(state.roles)) {
      if (!owner.sessionId) continue
      const sessions = new Set(), runs = new Set(), rootRecord = { sessions: [], subagents: [], jobs: [] }, todo = [owner.sessionId]
      while (todo.length) {
        const sessionId = todo.shift(); if (sessions.has(sessionId)) continue; sessions.add(sessionId)
        const prefix = `${directory}/${role}/${safeName(sessionId)}`
        try {
          const full = await archive(sessionId, prefix); rootRecord.sessions.push({ ...full, rows: undefined })
          artifact(`${prefix}/conversation.json`, full.rows)
          artifact(`${prefix}/current-history.json`, await request('GET', '/conversation/history', undefined, { sessionId }))
        } catch (error) { rootRecord.sessions.push({ sessionId, incomplete: true, error: scrub(error.message) }) }
        let cursor
        do {
          const directoryPage = (await request('GET', '/subagent/runs', undefined, { parentSessionId: sessionId, view: 'summary', limit: 100, cursor })).data
          for (const run of directoryPage.runs) {
            if (runs.has(run.runId)) continue; runs.add(run.runId)
            if (run.childSessionId) todo.push(run.childSessionId)
            const runPrefix = `${prefix}/subagents/${safeName(run.runId)}`
            const details = { run, tools: [], events: [] }; let toolCursor
            try {
              do {
                const page = (await request('GET', `/subagent/runs/${encodeURIComponent(run.runId)}/tools`, undefined, { parentSessionId: sessionId, atSeq: run.lastSeq, limit: 100, cursor: toolCursor })).data
                for (const tool of page.items) {
                  let offset = 0, raw = '', chunk
                  do { chunk = (await request('GET', `/subagent/runs/${encodeURIComponent(run.runId)}/tools/${encodeURIComponent(tool.id)}`, undefined, { parentSessionId: sessionId, atSeq: run.lastSeq, offset, limitBytes: 65536 })).data.detail; raw += chunk.text;
                    if (chunk.hasMore) assert.ok(chunk.nextOffset > offset, 'Tool detail made no progress'); offset = chunk.nextOffset
                  } while (chunk.hasMore)
                  details.tools.push({ summary: tool, detail: JSON.parse(raw) })
                }
                if (page.hasMore) assert.ok(page.nextCursor && page.nextCursor !== toolCursor, 'Tool page made no progress'); toolCursor = page.nextCursor
              } while (toolCursor)
              let afterSeq = 0, eventPage
              do { eventPage = (await request('GET', `/subagent/runs/${encodeURIComponent(run.runId)}/events`, undefined, { parentSessionId: sessionId, format: 'delta', afterSeq, limit: 100 })).data;
                assert.ok(!eventPage.checkpointRequired, 'Event checkpoint required'); details.events.push(...eventPage.events)
                if (eventPage.hasMore) assert.ok(eventPage.nextSeq > afterSeq, 'Event page made no progress'); afterSeq = eventPage.nextSeq
              } while (eventPage.hasMore)
            } catch (error) { details.incomplete = true; details.error = scrub(error.message) }
            rootRecord.subagents.push({ runId: run.runId, path: artifact(`${runPrefix}/run.json`, details), incomplete: details.incomplete || false })
          }
          if (directoryPage.hasMore) assert.ok(directoryPage.nextCursor && directoryPage.nextCursor !== cursor, 'Run directory made no progress'); cursor = directoryPage.nextCursor
        } while (cursor)
      }
      const jobs = (await request('GET', '/command-jobs', undefined, { sessionId: owner.sessionId })).data.jobs
      for (const job of jobs) {
        const output = []; let cursor = 0, chunk
        do { chunk = (await request('GET', `/command-jobs/${encodeURIComponent(job.jobId)}/output`, undefined, { sessionId: owner.sessionId, cursor, maxBytes: 65536 })).data; output.push(chunk)
          if (chunk.hasMore) assert.ok(chunk.nextCursor > cursor, 'Command output made no progress'); cursor = chunk.nextCursor
        } while (chunk.hasMore)
        rootRecord.jobs.push({ jobId: job.jobId, path: artifact(`${directory}/${role}/jobs/${safeName(job.jobId)}.json`, { job, output }), retainedOutputOnly: output.some(item => item.truncated) })
      }
      summary.roots[role] = rootRecord
    }
    const walk = path => { for (const item of readdirSync(path, { withFileTypes: true })) { const file = join(path, item.name)
      if (item.isDirectory() && !['node_modules', '.git', '.cache'].includes(item.name)) walk(file)
      else if (item.isFile()) summary.files.push({ path: relative(workspace, file), bytes: statSync(file).size, sha256: sha(readFileSync(file)) }) } }
    walk(workspace); const report = artifact(`${directory}/snapshot.json`, summary)
    log('snapshot', { report }); return { report, roots: summary.roots, files: summary.files }
  }
  const screenshot = async input => {
    if (input.role) await select(input.role)
    const path = join(evidence, 'screenshots', safeName(input.name || stamp()) + '.png'); mkdirSync(dirname(path), { recursive: true })
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(path, Buffer.from(data, 'base64')); return { path }
  }
  const preview = async input => {
    await select(input.role || 'product')
    if (input.url) {
      const tab = await page.evaluate(url => window.aether.browser.create({ url }), input.url)
      return { tab, source: 'actual-preload-browser-create', screenshot: await screenshot({ name: input.name || 'preview' }) }
    }
    const path = resolve(workspace, input.path || '')
    assert.ok(normalized(path).startsWith(normalized(workspace) + '/'), 'Preview must remain inside this round workspace')
    assert.ok(existsSync(path), 'Preview file missing')
    await page.keyboard.press('Control+p')
    await page.locator('.palette__input').fill(relative(workspace, path).split(sep).join('/'))
    const item = page.locator('.palette__item').filter({ hasText: basename(path) }).first()
    await expect(item).toBeVisible({ timeout: 30_000 }); await item.click()
    return { path, source: 'actual-ui-quick-open', screenshot: await screenshot({ name: input.name || 'preview' }) }
  }
  const stop = async input => {
    await select(input.role)
    const mode = state.roles[input.role].mode, surface = modeSurface(mode)
    const button = mode === 'code'
      ? surface.locator('.input-composer__stop').filter({ visible: true })
      : surface.getByRole('button', { name: '停止任务', exact: true }).filter({ visible: true }).first()
    await expect(button).toHaveCount(1)
    await expect(button).toHaveAttribute('aria-label', mode === 'code' ? '停止生成' : '停止任务')
    await expect(button).toBeEnabled()
    const target = await button.evaluate(element => ({ tag: element.tagName, className: element.className,
      ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title'), insideComposer: Boolean(element.closest('.input-composer')) }))
    if (mode === 'code') assert.ok(target.insideComposer, 'Stop target is outside the conversation composer')
    log('chat-stop-button-selected', { role: input.role, target })
    await button.click(); log('real-stop-button-clicked', { role: input.role, target }); return status()
  }
  const close = async () => {
    if (closing) return; closing = true; clearInterval(timer)
    cancelAudit('Controller closing')
    let deadline
    try { state.finalStatus = await Promise.race([status(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Final status exceeded 5 seconds; closing desktop now')), 5000)
    })]) } catch (error) { log('close-status-unavailable', { message: scrub(error.message) }) } finally { clearTimeout(deadline) }
    state.phase = 'closing'; save()
    await app?.close(); state.phase = 'closed'; state.closedAt = new Date().toISOString(); save(); server?.close()
  }
  try {
    app = await electron.launch({ args: [builds.appEntry, '--user-data-dir=' + profile], cwd: repo, timeout: 90_000,
      env: { ...cleanEnvironment(), AETHER_GLOBAL_DIR: join(profile, 'global'), AETHER_IDE_ENGINE_ENTRY: builds.engineEntry,
        WORKSPACE_ROOT: workspace, AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', DEFAULT_SECURITY_MODE: 'standard',
        SKILLS_ROOT: join(profile, 'skills'), MCP_CONFIG_PATH: join(profile, 'mcp.json'), ENABLE_LONG_TERM_MEMORY: 'false', AETHER_IDE_ECHO_ENGINE: '1' } })
    app.process().stdout?.on('data', value => appendFileSync(join(evidence, 'desktop.log'), scrub(value)))
    app.process().stderr?.on('data', value => appendFileSync(join(evidence, 'desktop.log'), scrub(value)))
    app.process().on('exit', (code, signal) => { if (!closing) { state.phase = 'desktop-exited'; state.errors.push({ at: Date.now(), code, signal }); save() } })
    page = await app.firstWindow(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => { state.errors.push({ at: Date.now(), message: scrub(error.message) }); save() })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1050))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
    const account = resumed ? await page.evaluate(() => window.aether.account.getState()) : await page.evaluate(() => window.aether.account.register())
    assert.equal(account.status, 'authenticated', 'Saved account must already be authenticated; resume never registers or logs in')
    if (resumed) assert.equal(account.user.id, resumed.original.engine.accountId, 'Saved account changed')
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.accountId), { timeout: 30_000 }).toBe(account.user.id)
    const identity = await page.evaluate(() => window.aether.engine.getSnapshot())
    state.engine = { mode: identity.mode, baseUrl: identity.baseUrl, instanceId: identity.instanceId, accountId: identity.accountId, buildId: identity.buildId }
    assert.equal(identity.buildId, builds.manifest.buildId, 'Running engine differs from verified manifest')
    if (!resumed) {
      const created = (await request('POST', '/models', model)).data
      await request('PUT', '/models/' + encodeURIComponent(created.id), { isEnabled: true })
      state.modelRecordId = created.id
      await page.reload(); await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(value => value.phase), { timeout: 90_000 }).toBe('ready')
    } else {
      assert.notEqual(identity.instanceId, resumed.original.engine.instanceId, 'Old engine instance still running')
      await select('development'); await select('product')
      const restored = await status()
      for (const role of ['product', 'development']) assert.ok(terminal(restored.roles[role].status), 'Resumed session is unexpectedly active')
      artifact('resume-identity.json', { originalStatePath: resumed.statePath, originalStateSha256: resumed.originalStateSha256,
        startedAt: state.startedAt, inspectionStartedAt: state.inspectionStartedAt, previousEngine: state.originalEngine, engine: state.engine,
        restoredSessions: Object.fromEntries(Object.entries(state.roles).map(([role, owner]) => [role, owner.sessionId])), startup: state.startup })
    }
    state.phase = 'ready'; save(); artifact('builds.json', builds)
    let observing = false
    timer = setInterval(async () => { if (observing || closing) return; observing = true
      try { const value = await status(); appendFileSync(join(evidence, 'status.jsonl'), encode(JSON.stringify({ at: Date.now(), ...value })) + '\n') }
      catch (error) { log('observation-error', { message: scrub(error.message) }) } finally { observing = false }
    }, 10_000); timer.unref()
    const token = randomBytes(32).toString('hex')
    server = createServer(async (incoming, outgoing) => {
      const respond = (status, value) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); outgoing.end(encode(value)) }
      try {
        if (incoming.headers.origin || incoming.headers['x-controller-token'] !== token || incoming.headers.host !== `127.0.0.1:${server.address().port}`) return respond(403, { error: 'Local controller authorization required' })
        let raw = ''; for await (const chunk of incoming) { raw += chunk; if (raw.length > 2_000_000) throw new Error('Control payload too large') }
        const input = raw ? JSON.parse(raw) : {}, path = new URL(incoming.url, 'http://127.0.0.1').pathname
        if (incoming.method === 'GET' && path === '/status') return respond(200, await status())
        if (incoming.method === 'GET' && path === '/ui-state') return respond(200, await ui(uiState))
        if (incoming.method !== 'POST') return respond(404, { error: 'Unknown endpoint' })
        const actions = { '/send': () => ui(() => send(input)), '/select': () => ui(async () => { await select(input.role); return { selected: input.role } }),
          '/snapshot': snapshot, '/screenshot': () => ui(() => screenshot(input)), '/preview': () => ui(() => preview(input)), '/stop': () => ui(() => stop(input)),
          '/ui-state': () => ui(uiState), '/retry': () => ui(() => retry(input)), '/audit-office': () => ui(() => audit('office', input)), '/audit-go': () => ui(() => audit('go', input)) }
        if (path === '/cancel-audit') { respond(200, cancelAudit('Explicit /cancel-audit request')); return }
        if (path === '/close') { respond(200, { closing: true }); void close(); return }
        if (!actions[path]) return respond(404, { error: 'Unknown endpoint' })
        respond(200, await actions[path]())
      } catch (error) { log('control-error', { path: incoming.url, message: scrub(error.message) }); respond(500, { error: scrub(error.message) }) }
    })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(Number(options.port || 0), '127.0.0.1', done) })
    const controlPath = join(controllerRoot, 'control.json')
    writeFileSync(controlPath, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid, root, controllerRoot, workspace, evidence, inspectionId, modelActionsAllowed }, null, 2))
    console.log(JSON.stringify({ phase: 'ready', controlPath, workspace, evidence, modelId: state.modelId, modelActionsAllowed, paidRequestsOnStartup: 0 }))
    process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() })
    return { app, page, state, close, send, status, snapshot, screenshot, preview, select, retry, uiState, audit }
  } catch (error) { state.phase = 'setup-failed'; state.errors.push({ at: Date.now(), message: scrub(error.message) }); save(); await app?.close().catch(() => {}); throw new Error(scrub(error.message)) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  if (options.check) {
    const resumed = options.resume || options['resume-inspection'] ? checkedResume(options) : null
    console.log(JSON.stringify({ checked: true, ...(resumed ? { builds: resumed.builds, originalStatePath: resumed.statePath,
      originalStateSha256: resumed.originalStateSha256, originalStartedAt: resumed.original.startedAt, workspace: resumed.original.workspace,
      profile: resumed.original.profile, sessions: Object.fromEntries(Object.entries(resumed.original.roles).map(([role, owner]) => [role, owner.sessionId])) }
      : checkedBuilds(options)), paidRequests: 0, launchedElectron: false }, null, 2))
  }
  else if (options.start) await launchController(options)
  else console.log('No app or model started. Use --check to inspect builds; --start explicitly launches the supervision controller. See file header.')
}
