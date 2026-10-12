#!/usr/bin/env node
/** Real Electron observer for an isolated engineering soak, sharing its real sessions. */
import { _electron as electron, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/work-soak-ui.mjs --manifest <runner manifest.json> --base-url <isolated engine> --token-file <path> [--app-root <frozen application>] [--minutes 60] [--history-review]')
  process.exit(0)
}
const value = name => {
  const index = args.indexOf(name)
  const result = args[index + 1]
  if (index < 0 || !result || result.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return result
}
for (const name of ['--manifest', '--base-url', '--token-file']) if (!args.includes(name)) throw new Error(`Missing ${name}`)
const manifestPath = path.resolve(value('--manifest'))
const baseUrl = value('--base-url').replace(/\/+$/, '')
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('UI soak must target its isolated loopback engine')
const token = fs.readFileSync(value('--token-file'), 'utf8').trim()
if (!token) throw new Error('The isolated engine token file is empty')
const root = args.includes('--app-root') ? path.resolve(value('--app-root')) : process.cwd()
const buildFiles = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
const fingerprintBuild = () => Object.fromEntries(buildFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const buildFingerprint = fingerprintBuild()
const historyReview = args.includes('--history-review')
const outputBase = path.join(path.dirname(manifestPath), historyReview ? 'ui-history-review' : 'ui')
// A failed observer is evidence too; retries must never overwrite its result.
const output = fs.existsSync(path.join(outputBase, 'result.json'))
  ? `${outputBase}-${new Date().toISOString().replace(/[:.]/g, '-')}` : outputBase
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const checkBackend = () => {
  const state = readManifest()
  if (!historyReview && ['failed', 'stopped'].includes(state.status)) throw new Error(`Engineering runner ${state.status}; see manifest and backend events`)
  return state
}
const manifest = readManifest()
if (manifest.discovery?.providerMode === 'local-override') throw new Error('A local model fixture is not real UI soak evidence')
const items = [...manifest.sessions, ...manifest.cron]
if (items.length !== 15 || items.some(item => !item.sessionId.startsWith('work-'))) throw new Error('Expected 15 Work-owned sessions')
const logPath = path.join(output, 'events.jsonl')
const events = []
const emit = event => {
  const row = { at: new Date().toISOString(), ...event }
  fs.appendFileSync(logPath, JSON.stringify(row) + '\n')
  events.push(row)
  if (events.length > 100) events.shift()
}
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl,
  autoStartEngine: true, lastModelId: 'qwen3.8-flash', thinkingMode: 'off', appearance: 'dark', lastFolder: '', lastSessionId: '' }))
const startedAt = Date.now()
const minutes = Number(args.includes('--minutes') ? value('--minutes') : 60)
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error('Expected --minutes in (0, 60]')
const endAt = Math.min(startedAt + minutes * 60_000, historyReview ? Infinity : Date.parse(manifest.deadline) || Infinity)
let app
let page
let cycle = 0
let stopped = false
let failure = null
let actions = 0
let processExit = null
let stderrTail = ''
const pageErrors = []
const samples = []
const capturedChildSizes = new Set()
const counters = { taskVisits: 0, projectVisits: 0, artifactVisits: 0, activityVisits: 0, subagentVisits: 0, childDetailVisits: 0, automationVisits: 0, preferenceVisits: 0, completionVisits: 0, draftChecks: 0, reloads: 0 }
const click = async locator => { await locator.click(); actions++ }
const fill = async (locator, text) => { await locator.fill(text); actions++ }
process.once('SIGINT', () => { stopped = true })
process.once('SIGTERM', () => { stopped = true })
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: path.join(profile, 'global') } })
  app.process().on('exit', (code, signal) => {
    processExit = { code, signal }
    emit({ type: 'electron-exit', code, signal })
  })
  app.process().stderr?.on('data', data => {
    const safe = String(data).replaceAll(token, '[redacted]')
    stderrTail = (stderrTail + safe).slice(-32_000)
    fs.appendFileSync(path.join(output, 'electron-stderr.log'), safe)
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { pageErrors.push(error.message); emit({ type: 'page-error', message: error.message, stack: error.stack }) })
  await click(page.getByRole('tab', { name: 'Work 办公', exact: true }))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(async ({ items, baseUrl }) => {
    const snapshot = await window.aether.engine.getSnapshot()
    const source = 'remote:' + baseUrl + (snapshot.accountId ? ':account:' + snapshot.accountId : '')
    const key = 'aether.work.state.v1:' + encodeURIComponent(source)
    const tasks = items.map(item => ({ id: item.sessionId, title: `压力 ${item.kind} ${item.index + 1}`,
      draft: '', status: item.kind === 'cron' ? 'draft' : 'running', createdAt: Date.now(), updatedAt: Date.now(),
      workspacePath: item.workspace, modelId: item.requestedModel || 'qwen3.8-flash', attachments: [], sources: [],
      agentId: item.agentId, agentLocked: true, mentions: [], resources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: null, homeDraft: '', homeWorkspacePath: null,
      homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [],
      homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    localStorage.setItem('aether.app.mode', 'work')
  }, { items, baseUrl })
  await page.reload()
  const work = page.locator('.work-view')
  await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
  const home = async () => { await click(work.getByRole('button', { name: '新任务', exact: true })) }
  while (!stopped && Date.now() < endAt) {
    if (JSON.stringify(fingerprintBuild()) !== JSON.stringify(buildFingerprint)) throw new Error('Application build changed during UI soak')
    const backend = checkBackend()
    if (!historyReview && backend.status === 'completed') { emit({ type: 'backend-completed' }); break }
    cycle++
    const [width, height] = [[1440, 900], [1080, 780], [860, 720]][(cycle - 1) % 3]
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(...size), [width, height])
    const appearance = cycle % 2 ? 'dark' : 'light'
    await click(page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }))
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await click(settings.locator('.app-settings__nav-item', { hasText: '外观' }))
    await click(settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }))
    await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    await click(settings.getByRole('button', { name: '关闭', exact: true }))
    for (const item of items) {
      if (stopped || Date.now() >= endAt) break
      checkBackend()
      const title = `压力 ${item.kind} ${item.index + 1}`
      await home()
      await fill(work.getByRole('textbox', { name: '搜索 Work 任务', exact: true }), title)
      await click(work.locator('.work-task-row').filter({ hasText: title }))
      await expect(work.locator('.work-task-heading h1')).toHaveText(title)
      const draft = work.getByRole('textbox', { name: '继续对话', exact: true })
      const draftText = `未发送草稿 · ${item.sessionId}`
      await fill(draft, draftText)
      await click(work.locator('.work-conversation__toolbar').getByRole('button', { name: '活动', exact: true }))
      await expect(work.locator('.work-workspace__body--activity')).toBeVisible()
      const activity = work.locator('.work-activities__list:visible').getByRole('option')
      const activityCount = await activity.count()
      if (activityCount) {
        await click(activity.last())
        await expect(work.getByRole('article', { name: '活动详情' })).toBeVisible()
        counters.activityVisits++
      }
      await click(work.getByRole('tab', { name: '子代理', exact: true }))
      await expect(work.locator('.work-subagents')).toBeVisible()
      const child = work.locator('.work-subagents .subagent-card').first()
      if (await child.count()) {
        if (await child.getAttribute('open') === null) await click(child.locator('summary'))
        const tools = child.locator('.subagent-card__tools-header')
        if (await tools.isVisible() && !(await child.locator('.subagent-card__tools-list').isVisible())) await click(tools)
        const firstCall = child.locator('.subagent-card__call-toggle:not(:disabled)').first()
        if (await firstCall.count() && await firstCall.getAttribute('aria-expanded') !== 'true') await click(firstCall)
        counters.childDetailVisits++
        if (!capturedChildSizes.has(width)) {
          await page.screenshot({ path: path.join(output, `work-child-requested-${width}.png`), animations: 'disabled' })
          capturedChildSizes.add(width)
        }
      }
      counters.subagentVisits++
      await click(work.getByRole('tab', { name: /^成果(?: \d+)?$/, exact: true }))
      const artifacts = work.locator('.work-artifacts-shell__list:visible').getByRole('option')
      if (await artifacts.count()) {
        await click(artifacts.last())
        await click(work.getByRole('tab', { name: '文件改动', exact: true }))
        await expect(work.getByRole('tab', { name: '文件改动', exact: true })).toHaveAttribute('aria-selected', 'true')
        await click(work.getByRole('tab', { name: '预览', exact: true }))
        counters.artifactVisits++
      }
      const conversation = work.locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
      if (await conversation.isVisible()) await click(conversation)
      await expect(draft).toHaveText(draftText)
      counters.draftChecks++
      counters.taskVisits++
      if (pageErrors.length) throw new Error('Renderer emitted a page error')
      emit({ type: 'task-visited', cycle, sessionId: item.sessionId, activityCount, requestedWidth: width, requestedHeight: height,
        actualViewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) })
    }
    if (stopped || Date.now() >= endAt) break
    checkBackend()
    await home()
    await click(work.locator('.work-navigation__item[title="项目"]'))
    const sharedProject = work.locator('.work-project').filter({ has: page.getByRole('heading', { name: 'shared-project', exact: true }) })
    await expect(sharedProject.locator('.work-task-row')).toHaveCount(5)
    counters.projectVisits++
    await home()
    await click(work.locator('.work-navigation__item[title="自动化"]'))
    await expect(work.locator('.work-automation')).toBeVisible()
    if (!historyReview) {
      try { await expect(work.locator('.work-automation-row').filter({ hasText: manifest.runId })).toHaveCount(5) }
      catch (error) { checkBackend(); throw error }
    }
    const jobs = await work.locator('.work-automation-row').count()
    counters.automationVisits++
    emit({ type: 'automation-visited', cycle, renderedRows: jobs })
    await home()
    const homeInput = work.getByRole('textbox', { name: '任务目标', exact: true })
    for (const trigger of ['@', '/']) {
      await fill(homeInput, trigger)
      const completion = page.locator('.work-completion-popover')
      await expect(completion).toBeVisible()
      const bounds = await completion.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const topInset = document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? 0
        const middle = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 16))
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          width: innerWidth, height: innerHeight, topInset, hit: !!middle && element.contains(middle) }
      })
      if (bounds.top < bounds.topInset - 1 || bounds.bottom > bounds.height + 1 || bounds.left < 0 || bounds.right > bounds.width + 1 || !bounds.hit) {
        throw new Error(`Completion popover clipped: ${JSON.stringify(bounds)}`)
      }
      await homeInput.press('Escape'); actions++
      await expect(completion).toHaveCount(0)
      counters.completionVisits++
    }
    await fill(homeInput, '')
    await click(work.getByRole('button', { name: '对话偏好', exact: true }))
    await expect(page.locator('.composer-options__popup')).toBeVisible()
    await page.keyboard.press('Escape')
    actions++
    counters.preferenceVisits++
    const sample = await app.evaluate(({ app }) => app.getAppMetrics().map(process => ({ type: process.type, cpu: process.cpu, memory: process.memory })))
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      nodes: document.querySelectorAll('*').length, rendererHeap: performance.memory?.usedJSHeapSize ?? null }))
    if (layout.scrollWidth > layout.viewport + 1) throw new Error(`Window overflow at ${width}px`)
    samples.push({ at: Date.now(), cycle, processes: sample, layout })
    emit({ type: 'cycle-finished', cycle, actions, counters, layout, processes: sample })
    fs.writeFileSync(path.join(output, 'heartbeat.json'), JSON.stringify({ status: 'running', at: new Date().toISOString(), cycle, actions, counters }))
    if (cycle === 1 || cycle % 10 === 0) await page.screenshot({ path: path.join(output, `work-cycle-${cycle}.png`), animations: 'disabled' })
    if (cycle % 5 === 0) {
      await page.reload(); counters.reloads++
      await expect(page.getByRole('tab', { name: 'Work 办公', exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    await delay(3000)
  }
  if (stopped) throw new Error('UI soak interrupted before completion')
  if (!counters.activityVisits || !counters.artifactVisits || !counters.childDetailVisits) throw new Error('UI soak has no evidence of actual activity, artifacts or child details')
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  emit({ type: 'ui-failure', error: failure })
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
} finally {
  if (app) {
    await app.close().catch(error => { failure ||= String(error) })
    processExit ??= { code: app.process().exitCode, signal: app.process().signalCode }
    if (processExit.code !== 0 || processExit.signal) failure ||= `Electron exit was not clean: ${JSON.stringify(processExit)}`
  }
  const nativePath = path.join(profile, 'logs', 'native-processes.jsonl')
  const nativeEvents = fs.existsSync(nativePath) ? fs.readFileSync(nativePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const nativeFailures = nativeEvents.filter(event => event.event.endsWith('-process-gone') && !['clean-exit', 'killed'].includes(event.reason))
  if (!nativeEvents.some(event => event.event === 'startup')) failure ||= 'The build did not produce native process diagnostics'
  if (nativeFailures.length || /\bFATAL[: ]|STATUS_BREAKPOINT|GPU process isn't usable/i.test(stderrTail)) failure ||= 'Electron reported a native process failure'
  const result = { status: failure ? 'failed' : historyReview ? 'history-reviewed' : 'completed', failure, startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1000, cycle, actions, counters, pageErrors, samples, profile, processExit, nativeEvents, buildFingerprint,
    appRoot: root,
    scope: historyReview ? 'Historical real sessions only; this is a UI driver preflight, not a live pressure-test pass.' : 'Live Electron Work UI observing real runner sessions; model dispatch and Cron owned by engineering runner.' }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(output, 'heartbeat.json'), JSON.stringify({ status: result.status, at: result.endedAt, cycle, counters }))
  console.log(JSON.stringify({ status: result.status, elapsedSeconds: result.elapsedSeconds, cycle, actions, counters, failure }))
  if (failure) process.exitCode = 1
}
