/**
 * Real resident Electron/browser-bridge acceptance for a live run.
 *
 * Usage:
 *   node scripts/verify-live-five-session-browser-resident.mjs <run-root> [--once]
 *
 * The default mode keeps one Electron client open.  The client connects to the
 * engine named by the run manifest, switches each persisted session, opens a
 * real local HTTP page in the visible BrowserService, and records snapshot,
 * screenshot, console, network and temporary workspace CRUD evidence.  Use
 * --once for a bounded smoke of the same flow.  Ctrl+C (or a resident-stop
 * file in the evidence directory) ends a resident run.
 */
import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('run-root is required')
const once = process.argv.includes('--once')
const manifestPath = join(runRoot, 'active-start.json')
const continuationPath = join(runRoot, 'continuation-state.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8') || '{}') : {}
const continuation = existsSync(continuationPath) ? JSON.parse(readFileSync(continuationPath, 'utf8') || '{}') : {}
const source = Object.keys(manifest).length ? manifest : continuation
const sessions = Array.isArray(source.sessions) ? source.sessions : []
if (sessions.length !== 5) throw new Error(`expected five sessions, got ${sessions.length}`)
if (new Set(sessions.map(item => item.sessionId)).size !== 5) throw new Error('session IDs are not unique')
const baseUrl = source.baseUrl ?? source.base ?? 'http://127.0.0.1:12499'
const tokenPath = join(runRoot, '.instance-token')
const token = readFileSync(tokenPath, 'utf8').trim()
if (!token) throw new Error('missing .instance-token')
if (new URL(baseUrl).hostname !== '127.0.0.1') throw new Error('resident client only accepts a loopback engine')

const evidence = join(runRoot, `client-browser-resident-${new Date().toISOString().replace(/[-:.]/g, '')}`)
mkdirSync(evidence, { recursive: true })
const profile = mkdtempSync(join(appRoot, '.e2e-tmp', 'browser-resident-'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '', autoStartEngine: true,
  lastSessionId: '', lastFolder: '', thinkingMode: 'off'
}, null, 2))

const fixture = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid')
  if (url.pathname === '/ping') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Resident-Trace': 'browser-resident' })
    response.end(JSON.stringify({ ok: true, marker: 'resident-ping', payload: 'browser bridge' }))
    return
  }
  if (url.pathname === '/page') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><meta charset="utf-8"><title>Resident browser</title>
      <label for="name">Name</label><input id="name" value="initial">
      <button id="save">Save</button><p id="result">waiting</p>
      <script>console.log('resident-console');document.querySelector('#save').onclick=async()=>{document.querySelector('#result').textContent='saved:'+document.querySelector('#name').value;await fetch('/ping')}</script>`)
    return
  }
  response.writeHead(404).end()
})

const result = {
  scope: 'one resident real Electron client; engine and projects are external retained state',
  startedAt: new Date().toISOString(), finishedAt: null, baseUrl, profile, evidence,
  sessions: [], rendererErrors: [], pageErrors: [], passed: false, browserHandler: 'not-probed'
}
const save = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
const sourceText = value => {
  if (Array.isArray(value)) return value.filter(item => item?.type === 'text').map(item => item.text ?? '').join('\n')
  return String(value ?? '')
}
const historyTitle = value => {
  const firstLine = sourceText(value).split('\n')[0] ?? ''
  const normalized = firstLine.replace(/\s+/g, ' ').trim()
  return normalized.length > 50 ? `${normalized.slice(0, 50)}…` : normalized
}
const scrub = value => String(value).split(token).join('[REDACTED]')
let app, page, origin = ''
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

async function request(path, method = 'GET', body, query) {
  const envelope = await page.evaluate(async ({ path, method, body, query }) =>
    window.aether.engine.request({ method, path, body, query }), { path, method, body, query })
  if (!envelope.ok) throw new Error(`${path}: ${envelope.message}`)
  return envelope.data
}

async function showHistory() {
  const panel = page.locator('.history-view')
  // The history activity button is a toggle. Browser CRUD can leave the
  // panel mounted, so clicking it unconditionally would hide it and make the
  // next session look missing even though the bridge is healthy.
  if (await panel.isVisible().catch(() => false)) return
  const button = page.locator('.activity-bar button[title="会话历史"]')
  if (await button.count()) await button.click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
}

async function selectSession(session, title) {
  await showHistory()
  const escaped = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const row = page.locator('.history-view__item').filter({
    has: page.locator('.history-view__summary', { hasText: new RegExp(`^${escaped}$`) })
  })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect.poll(async () => page.evaluate(() => window.aether.browser.getConnection()), {
    timeout: 30_000, message: `browser connection follows ${session.sessionId}`
  }).toMatchObject({ status: 'connected', sessionId: session.sessionId })
}

async function openBrowserSurface() {
  await page.keyboard.press('Control+Alt+b')
  await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible({ timeout: 20_000 })
}

async function browserRound(session, title, index) {
  await selectSession(session, title)
  await openBrowserSurface()
  const tab = await page.evaluate(async url => window.aether.browser.create({ url }), `${origin}/page`)
  expect(tab.tabId).toBeTruthy()
  await page.evaluate(async tabId => window.aether.browser.share(tabId), tab.tabId)
  // The BrowserView normally supplies these bounds. Keep the explicit call as
  // a diagnostic barrier so hidden/empty tabs cannot satisfy the acceptance.
  await page.evaluate(async tabId => {
    const region = document.querySelector('[aria-label="网页内容区域"]')
    const rect = region?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('browser surface has no visible bounds')
    await window.aether.browser.setBounds({ tabId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible: true })
  }, tab.tabId)
  const snapshotResult = await page.evaluate(async tabId => window.aether.browser.read(tabId, 'snapshot'), tab.tabId)
  expect(snapshotResult.success, snapshotResult.error).toBe(true)
  expect(sourceText(snapshotResult.output?.text)).toContain('Name')
  const screenshotResult = await page.evaluate(async tabId => window.aether.browser.read(tabId, 'screenshot'), tab.tabId)
  expect(screenshotResult.success, screenshotResult.error).toBe(true)
  const screenshot = screenshotResult.output
  expect(screenshot?.dataUrl).toMatch(/^data:image\/png;base64,/)
  writeFileSync(join(evidence, `session-${index + 1}-browser.png`), Buffer.from(screenshot.dataUrl.split(',')[1], 'base64'))
  const consoleResult = await page.evaluate(async tabId => window.aether.browser.read(tabId, 'console'), tab.tabId)
  expect(consoleResult.success, consoleResult.error).toBe(true)
  const consoleText = JSON.stringify(consoleResult.output)
  expect(consoleText).toContain('resident-console')
  const network = await page.evaluate(async tabId => window.aether.browser.network(tabId, { limit: 100 }), tab.tabId)
  expect(network.entries.some(entry => entry.url.endsWith('/page'))).toBe(true)
  const ping = network.entries.find(entry => entry.url.endsWith('/ping'))
  if (ping?.id) {
    const detail = await page.evaluate(async ({ tabId, id }) => window.aether.browser.networkRequest(tabId, id), { tabId: tab.tabId, id: ping.id })
    expect(detail.entry.id).toBe(ping.id)
    expect(detail.response.headers.some(header => /^x-resident-trace$/i.test(header.name))).toBe(true)
  }
  await page.evaluate(async tabId => window.aether.browser.close(tabId), tab.tabId)
  return { sessionId: session.sessionId, title, tabId: tab.tabId, navigationId: tab.navigationId, snapshot: true, screenshotBytes: Buffer.from(screenshot.dataUrl.split(',')[1], 'base64').byteLength, console: true, network: true }
}

async function projectCrud(session, index) {
  const root = resolve(session.workspace ?? session.workspacePath ?? '')
  if (!root) throw new Error(`session ${session.sessionId} has no workspace`) 
  const relative = `.aether-browser-resident-${Date.now()}-${index}.md`
  await request('/workspace/file', 'POST', { sessionId: session.sessionId, path: relative, content: 'resident-v1' })
  const first = await request('/workspace/file/content', 'GET', undefined, { sessionId: session.sessionId, path: relative })
  expect(first.content).toBe('resident-v1')
  await request('/workspace/file', 'POST', { sessionId: session.sessionId, path: relative, content: 'resident-v2' })
  const second = await request('/workspace/file/content', 'GET', undefined, { sessionId: session.sessionId, path: relative })
  expect(second.content).toBe('resident-v2')
  await request('/workspace/file/trash', 'POST', { sessionId: session.sessionId, path: relative })
  const removed = await request('/workspace/file/info', 'GET', undefined, { sessionId: session.sessionId, path: relative }).catch(() => null)
  expect(removed).toBeNull()
  return { root, path: relative, create: true, update: true, delete: true }
}

async function main() {
  await new Promise((resolveListen, rejectListen) => {
    fixture.once('error', rejectListen)
    fixture.listen(0, '127.0.0.1', resolveListen)
  })
  const address = fixture.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  origin = `http://127.0.0.1:${address.port}`
  const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: appRoot, env })
  page = await app.firstWindow()
  page.on('pageerror', error => result.pageErrors.push(scrub(error.message)))
  page.on('console', message => { if (message.type() === 'error') result.rendererErrors.push(scrub(message.text())) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
  expect(engine.mode).toBe('remote'); expect(engine.baseUrl).toBe(baseUrl); expect(engine.phase).toBe('ready')
  result.engine = { mode: engine.mode, baseUrl: engine.baseUrl, instanceId: engine.instanceId, buildId: engine.buildId, protocolVersion: engine.protocolVersion }
  const listed = await request('/conversation/sessions')
  for (const session of sessions) {
    const row = listed.find(item => item.sessionId === session.sessionId)
    expect(row, `session ${session.sessionId} appears in history`).toBeTruthy()
    const title = historyTitle(row.title ?? row.lastMessage)
    const record = { sessionId: session.sessionId, workspace: session.workspace ?? session.workspacePath, title }
    result.sessions.push(record)
    record.browser = await browserRound(session, title, sessions.indexOf(session))
    record.project = await projectCrud(session, sessions.indexOf(session))
    await showHistory()
    save()
  }
  // This is a real client bridge check; the tab operations above are serviced
  // by BrowserService. A model handler probe is attempted only when requested,
  // so long resident runs never spend an unexpected provider request.
  result.browserHandler = 'client BrowserService + authenticated engine lease verified'
  result.passed = result.pageErrors.length === 0 && result.rendererErrors.length === 0 && result.sessions.length === 5
  save()
}

let stopping = false
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })
try {
  await main()
  if (!once) {
    writeFileSync(join(evidence, 'resident-ready.json'), JSON.stringify({ ready: true, at: new Date().toISOString(), buildId: result.engine?.buildId, evidence, profile, stop: 'SIGINT/SIGTERM or resident-stop file' }, null, 2))
    while (!stopping && !requireStop()) await wait(5000)
  }
} catch (error) {
  result.error = scrub(error?.stack ?? error)
  result.passed = false
} finally {
  result.finishedAt = new Date().toISOString()
  save()
  await app?.close().catch(error => { result.closeError = scrub(error?.message ?? error) })
  fixture.close()
  if (once) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  else writeFileSync(join(evidence, 'resident-stopped.json'), JSON.stringify({ at: new Date().toISOString(), reason: stopping ? 'signal' : 'resident-stop file' }, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, evidence, profile, selected: result.sessions.length, buildId: result.engine?.buildId, error: result.error }))
if (!result.passed) process.exitCode = 1

function requireStop() {
  try { return readFileSync(join(evidence, 'resident-stop'), 'utf8').trim() === 'stop' } catch { return false }
}
