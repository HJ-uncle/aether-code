/** Read-only real Electron acceptance of a live five-session load.
 * Usage: node scripts/verify-live-five-session-client.mjs <run-root> */
import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRenderedUsers, latestRealUser, readSessionArchive } from './live-session-history.mjs'
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) throw new Error('run-root is required')
const runRoot = resolve(process.argv[2])
const manifest = JSON.parse(readFileSync(join(runRoot, 'active-start.json'), 'utf8'))
const sessions = manifest.sessions
expect(sessions).toHaveLength(5)
expect(new Set(sessions.map(x => x.sessionId)).size).toBe(5)
const configuredModelFor = session => session.modelId ?? (typeof session.model === 'string' ? session.model : session.model?.modelId)
for (const session of sessions) expect(configuredModelFor(session), 'every formal session has an explicit configured model').toEqual(expect.stringMatching(/\S/))
const expectedModelCounts = process.env.AETHER_CLIENT_EXPECTED_MODEL_COUNTS
if (expectedModelCounts) {
 const configuredModels = sessions.map(configuredModelFor)
 const actualCounts = Object.fromEntries([...new Set(configuredModels)].map(model => [model, configuredModels.filter(value => value === model).length]))
 expect(actualCounts, 'formal model distribution matches the explicit expected plan').toEqual(JSON.parse(expectedModelCounts))
} else {
 expect(sessions.filter(session => configuredModelFor(session) === 'qwen3.8-flash'), 'original five-session load contains exactly three requested Qwen sessions').toHaveLength(3)
}
const roots = new Set(sessions.map(x => resolve(x.workspace ?? x.workspacePath)))
expect(roots.size).toBe(2)
expect([...roots].map(root => sessions.filter(x => resolve(x.workspace ?? x.workspacePath) === root).length).sort()).toEqual([2, 3])
const token = readFileSync(join(runRoot, '.instance-token'), 'utf8').trim()
if (!token) throw new Error('Missing local instance token')
const baseUrl = manifest.baseUrl ?? manifest.base ?? 'http://127.0.0.1:12499'
expect(new URL(baseUrl).hostname).toBe('127.0.0.1')
const evidence = join(runRoot, 'client-live-' + new Date().toISOString().replace(/[-:.]/g, ''))
mkdirSync(join(appRoot, '.e2e-tmp'), { recursive: true })
mkdirSync(evidence, { recursive: true })
const profile = mkdtempSync(join(appRoot, '.e2e-tmp', 'live-five-session-'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '', autoStartEngine: true, lastSessionId: '', lastFolder: '', thinkingMode: 'off' }))
const activePhase = process.env.AETHER_CLIENT_ACCEPTANCE_PHASE === 'active'
const historyOnly = process.env.AETHER_CLIENT_HISTORY_ONLY === '1'
const acceptanceLabel = process.env.AETHER_CLIENT_ACCEPTANCE_LABEL || ''
if (acceptanceLabel && !/^[a-z0-9-]+$/.test(acceptanceLabel)) throw new Error('Invalid acceptance label')
const result = { scope: historyOnly ? 'terminal history only; workspace restart binding known failed in separate full replay' : 'full real client session/model/workspace/subagent recovery', phase: activePhase ? 'active' : 'terminal', startedAt: new Date().toISOString(), baseUrl, profile, sessions: [], rendererErrors: [], passed: false }
const scrub = text => String(text).split(token).join('[REDACTED]')
const normalize = text => String(text).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const sourceText = input => {
 let value = input
 try { if (typeof value === 'string') value = JSON.parse(value) } catch {}
 return Array.isArray(value) ? value.filter(x => x.type === 'text').map(x => x.text).join('\n') : String(input ?? '')
}
const summary = text => { const line = sourceText(text).split('\n')[0].replace(/\s+/g, ' ').trim(); return line.length > 50 ? line.slice(0, 50) + '…' : line }
let app, page
const historyChecked = new Set()
async function verifyLongHistory(session, record, archiveResult) {
 if (activePhase || historyChecked.has(session.sessionId)) return
 const archive = archiveResult.rows
 const users = archive.filter(row => row.role === 'user' && !row.isSidechain)
 expect(users.length).toBeGreaterThan(1)
 const first = users[0], latest = users.at(-1)
 const firstStage = sourceText(first.content).split('\n').find(line => /^阶段\s+1[：:]/.test(line))
 const latestStage = sourceText(latest.content).split('\n').find(line => /^阶段\s+\d+[：:]/.test(line))
 expect(firstStage, 'real earliest S1 stage marker exists').toBeTruthy()
 expect(latestStage, 'real latest persisted stage marker exists').toBeTruthy()
 const recovery = { archiveRows: archive.length, archiveUsers: users.length,
   first: { id: first.id, turnId: first.conversationId, marker: firstStage },
   latest: { id: latest.id, turnId: latest.conversationId, marker: latestStage }, archivePages: archiveResult.pages, pages: [] }
 record.historyRecovery = recovery
 const messages = page.locator('.chat__messages')
 const state = async () => ({ userIds: await messages.locator('.message--user[data-message-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id'))),
   earlier: await messages.locator('.chat__load-earlier').allTextContents() })
 recovery.initial = await state()
 for (;;) {
   const earlier = messages.locator('.chat__load-earlier').first()
   if (await earlier.count() === 0) break
   const before = await state()
   const button = (await earlier.textContent())?.trim()
   await earlier.click()
   await expect.poll(async () => (await state()).earlier.some(text => text.includes('正在加载')) ? JSON.stringify(before) : JSON.stringify(await state()), { timeout: 30_000, message: 'real history page or archive changes rendered state' }).not.toBe(JSON.stringify(before))
   recovery.pages.push({ button, ...(await state()) }); save()
 }
 expect(await messages.locator('.chat__load-earlier').count(), 'all available earlier pages loaded within bound').toBe(0)
 const rendered = await state()
 assertRenderedUsers(rendered.userIds, users, { complete: true })
 recovery.turns = []
 for (const user of users) {
   const turnId = user.conversationId ?? user.metadata?.turnId
   expect(turnId, 'every archived user has a persisted turn').toBeTruthy()
   const userRow = messages.locator('.message--user[data-message-id="' + user.id + '"]')
   await expect(userRow).toHaveCount(1)
   await expect(userRow).toHaveAttribute('data-turn-id', turnId)
   recovery.turns.push({ id: user.id, turnId })
 }
 const firstRow = messages.locator('.message--user[data-message-id="' + first.id + '"]')
 const latestRow = messages.locator('.message--user[data-message-id="' + latest.id + '"]')
 await expect(firstRow).toHaveCount(1); await expect(firstRow).toHaveAttribute('data-turn-id', first.conversationId)
 await expect(firstRow).toContainText(firstStage); await firstRow.scrollIntoViewIfNeeded()
 await page.screenshot({ path: join(evidence, 'history-earliest-' + (sessions.indexOf(session) + 1) + '.png'), fullPage: true })
 await expect(latestRow).toHaveCount(1); await expect(latestRow).toHaveAttribute('data-turn-id', latest.conversationId)
 await expect(latestRow).toContainText(latestStage); await latestRow.scrollIntoViewIfNeeded()
 await page.screenshot({ path: join(evidence, 'history-latest-' + (sessions.indexOf(session) + 1) + '.png'), fullPage: true })
 recovery.renderedUsers = rendered.userIds.length; recovery.loadedPageCount = recovery.pages.length
 recovery.archiveLoadCount = recovery.pages.filter(item => item.button?.includes('归档') || item.button?.includes('上下文已压缩')).length
 recovery.windowPageCount = recovery.pages.length - recovery.archiveLoadCount
 recovery.noWindowPaginationNeeded = recovery.windowPageCount === 0
 recovery.passed = true; historyChecked.add(session.sessionId); save()
}
async function verifyLatestUser(session, snapshot, record, archiveResult) {
 expect(snapshot.sessionId, 'latest user recovery snapshot belongs to selected session').toBe(session.sessionId)
 const lastUser = latestRealUser(snapshot, archiveResult?.rows)
 const messages = page.locator('.chat__messages')
 const latestRow = messages.locator('.message--user[data-message-id="' + lastUser.id + '"]')
 const users = (archiveResult?.rows ?? snapshot.history).filter(row => row.role === 'user' && !row.isSidechain)
 const recovery = { id: lastUser.id, turnId: lastUser.conversationId ?? lastUser.metadata?.turnId,
   source: archiveResult ? 'archive' : 'snapshot', historyCompacted: Boolean(snapshot.historyCompacted),
   archivePages: archiveResult?.pages ?? [], pages: [] }
 record.latestUserRecovery = recovery
 const state = async () => ({ userIds: await messages.locator('.message--user[data-message-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id'))),
   earlier: await messages.locator('.chat__load-earlier').allTextContents() })
 recovery.initial = await state()
 // Loading the retained archive is an explicit user action. Summary text alone cannot satisfy recovery.
 while (await latestRow.count() === 0) {
   const earlier = messages.locator('.chat__load-earlier').first()
   await expect.poll(async () => await latestRow.count() > 0 || await earlier.count() > 0, { timeout: 20_000, message: 'latest real user or its explicit history-loading control becomes available' }).toBe(true)
   if (await latestRow.count() > 0) break
   await expect(earlier, 'latest real user is reachable through explicit history loading').toHaveCount(1)
   const before = await state(), button = (await earlier.textContent())?.trim()
   await earlier.click()
   await expect.poll(async () => (await state()).earlier.some(text => text.includes('正在加载')) ? JSON.stringify(before) : JSON.stringify(await state()), { timeout: 30_000, message: 'explicit history loading changes rendered users or pages' }).not.toBe(JSON.stringify(before))
   recovery.pages.push({ button, ...(await state()) }); save()
 }
 const rendered = await state()
 assertRenderedUsers(rendered.userIds, users)
 await expect(latestRow, 'exact latest user message is rendered once').toHaveCount(1)
 expect(recovery.turnId, 'latest real user has a persisted turn').toBeTruthy()
 await expect(latestRow).toHaveAttribute('data-turn-id', recovery.turnId)
 record.latestUserProbe = sourceText(lastUser.content).split('\n')[0].trim().slice(0, 100)
 expect(record.latestUserProbe).not.toBe('')
 await expect(latestRow).toContainText(record.latestUserProbe, { timeout: 20_000 })
 await latestRow.scrollIntoViewIfNeeded()
 recovery.renderedUsers = rendered.userIds.length; recovery.passed = true
}
async function showSidebar(name) {
 const header = page.locator('.sidebar__header')
 if (await header.isVisible() && (await header.textContent())?.includes(name)) return
 await page.locator('.activity-bar button[title="' + name + '"]').click()
 await expect(header).toContainText(name)
}
const save = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
async function requestResult(path, query = {}) {
 const out = await page.evaluate(({ path, query }) => window.aether.engine.request({ method: 'GET', path, query }), { path, query })
 if (!out.ok) throw new Error(path + ': ' + scrub(out.message))
 return out
}
async function request(path, query = {}) {
 return (await requestResult(path, query)).data
}
try {
 const environment = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token }
 delete environment.ELECTRON_RENDERER_URL; delete environment.ELECTRON_RUN_AS_NODE
 app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: appRoot, env: environment })
 page = await app.firstWindow()
 page.on('pageerror', error => result.rendererErrors.push(scrub(error.message)))
 await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
 const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
 expect(engine.mode).toBe('remote'); expect(engine.baseUrl).toBe(baseUrl); expect(engine.phase).toBe('ready')
 if (process.env.AETHER_CLIENT_EXPECTED_BUILD_ID) expect(engine.buildId).toBe(process.env.AETHER_CLIENT_EXPECTED_BUILD_ID)
 result.engine = { mode: engine.mode, baseUrl: engine.baseUrl, instanceId: engine.instanceId, buildId: engine.buildId, protocolVersion: engine.protocolVersion }
 await showSidebar('会话历史')
 await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
 const listed = await request('/conversation/sessions')
 for (const session of sessions) {
   const row = listed.find(x => x.sessionId === session.sessionId)
   expect(row, 'real session appears in history').toBeTruthy()
   session.clientTitle = summary(row.title ?? row.lastMessage)
 }
 expect(new Set(sessions.map(x => x.clientTitle)).size).toBe(5)
 for (const session of [...sessions, ...[...sessions].reverse()]) {
   const record = { sessionId: session.sessionId, workspace: session.workspace ?? session.workspacePath, selectedAt: new Date().toISOString(), title: session.clientTitle }
   result.sessions.push(record)
   await showSidebar('会话历史')
   const escaped = session.clientTitle.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
   const row = page.locator('.history-view__item').filter({ has: page.locator('.history-view__summary', { hasText: new RegExp('^' + escaped + '$') }) })
   await expect(row).toHaveCount(1); await row.click(); await expect(row).toHaveClass(/is-active/)
   const snapshot = await request('/chat/snapshot', { sessionId: session.sessionId })
   expect(snapshot.schemaVersion).toBe(1); expect(snapshot.sessionId).toBe(session.sessionId); expect(snapshot.history.length).toBeGreaterThan(0)
   if (!activePhase) {
     expect(snapshot.finished, 'terminal recovery snapshot must be finished').toBe(true)
     expect(['succeeded', 'failed', 'cancelled', 'interrupted']).toContain(snapshot.run?.status)
   }
   const configuredModel = configuredModelFor(session)
   record.configuredModel = snapshot.run?.modelId
   record.actualModel = snapshot.run?.actualModelId
   if (configuredModel) {
     expect(record.configuredModel).toBe(configuredModel)
     expect(record.actualModel, 'actual provider model must be persisted').toBe(configuredModel)
     await expect(page.locator('.model-picker__trigger'), 'composer restores the selected session requested model').toHaveAttribute('title', '当前模型：' + configuredModel, { timeout: 20_000 })
     record.composerModel = configuredModel
   }
   const children = await request('/subagent/runs', { parentSessionId: session.sessionId })
   const jobs = await request('/command-jobs', { sessionId: session.sessionId })
   for (const child of children) expect(child.rootSessionId).toBe(session.sessionId)
   for (const job of jobs.jobs ?? []) expect(job.sessionId).toBe(session.sessionId)
   if (!historyOnly) {
   const directory = await request('/workspace/directory', { sessionId: session.sessionId, path: '.' })
   expect(normalize(directory.root)).toBe(normalize(record.workspace))
   expect(directory.entries.some(x => x.name === 'package.json')).toBe(true)
   const pkg = await request('/workspace/file/content', { sessionId: session.sessionId, path: 'package.json' })
   expect(pkg.isBinary).toBe(false); expect(pkg.content).toBe(readFileSync(join(record.workspace, 'package.json'), 'utf8'))
   }
   const archiveResult = activePhase ? undefined : await readSessionArchive(requestResult, session.sessionId)
   await verifyLatestUser(session, snapshot, record, archiveResult)
   if (children.length > 0) {
     // Individual child calls render direct cards; only adjacent multiple calls form a group.
     await expect(page.locator('.subagent-group__head, .subagent-card[data-run-id]').first()).toBeVisible({ timeout: 20_000 })
     for (const group of await page.locator('.subagent-group__head').all()) {
       if (await group.getAttribute('aria-expanded') === 'false') await group.click()
     }
   }
   const uiChildren = await page.locator('.subagent-card[data-run-id]').evaluateAll(nodes => nodes.map(x => x.getAttribute('data-run-id')))
   if (children.length > 0) expect(uiChildren.length, 'real child snapshots must produce visible UI cards').toBeGreaterThan(0)
   const latestChildren = await request('/subagent/runs', { parentSessionId: session.sessionId })
   for (const id of uiChildren) expect(latestChildren.some(x => x.runId === id && x.rootSessionId === session.sessionId), 'UI child belongs to selected session').toBe(true)
   const uiJobs = await page.locator('.command-job-card[data-job-id]').evaluateAll(nodes => nodes.map(x => x.getAttribute('data-job-id')))
   const latestJobs = await request('/command-jobs', { sessionId: session.sessionId })
   for (const id of uiJobs) expect((latestJobs.jobs ?? []).some(x => x.jobId === id && x.sessionId === session.sessionId), 'UI job belongs to selected session').toBe(true)
   Object.assign(record, { historyCount: snapshot.history.length, rootStatus: snapshot.run?.status, childCount: children.length, jobCount: (jobs.jobs ?? []).length, uiChildIds: uiChildren, uiJobIds: uiJobs })
   await verifyLongHistory(session, record, archiveResult)
   if (!historyOnly) {
   await showSidebar('资源管理器')
   await expect(page.locator('.explorer__tree')).toContainText(basename(record.workspace), { timeout: 20_000 })
   await expect(page.locator('.explorer__tree')).toContainText('package.json', { timeout: 20_000 })
   }
   await page.screenshot({ path: join(evidence, 'session-' + result.sessions.length + '.png'), fullPage: true }); save()
 }
 await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
 const reloadedSession = sessions.find(session => session.sessionId === result.sessions.at(-1).sessionId)
 const reloadedSnapshot = await request('/chat/snapshot', { sessionId: reloadedSession.sessionId })
 const reloadRecord = { sessionId: reloadedSession.sessionId }
 await verifyLatestUser(reloadedSession, reloadedSnapshot, reloadRecord, activePhase ? undefined : await readSessionArchive(requestResult, reloadedSession.sessionId))
 if (reloadedSnapshot.run?.modelId) await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title', '当前模型：' + reloadedSnapshot.run.modelId)
 result.reloadRecovery = reloadRecord.latestUserRecovery
 result.reloadRecovered = true; expect(result.rendererErrors).toEqual([]); if (!activePhase) expect(historyChecked.size).toBe(sessions.length); result.passed = true
} catch (error) {
 result.error = scrub(error?.stack ?? error)
 if (page) await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
 await app?.close().catch(error => result.closeError = scrub(error))
 result.finishedAt = new Date().toISOString(); save()
 const acceptanceFilename = historyOnly ? 'client-history-acceptance.json' : activePhase ? 'client-active-acceptance.json' : 'client-acceptance.json'
 writeFileSync(join(runRoot, acceptanceLabel ? acceptanceFilename.replace('.json', '-' + acceptanceLabel + '.json') : acceptanceFilename), JSON.stringify({
   passed: result.passed && !result.closeError, scope: result.scope, phase: result.phase, startedAt: result.startedAt,
   finishedAt: result.finishedAt, evidence, selectedCount: result.sessions.length,
   rendererErrors: result.rendererErrors, error: result.error, closeError: result.closeError
 }, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, evidence, selected: result.sessions.length, rendererErrors: result.rendererErrors.length, error: result.error }))
if (!result.passed || result.closeError) process.exitCode = 1

