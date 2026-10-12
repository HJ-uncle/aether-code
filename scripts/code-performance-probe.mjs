/** Run serially after npm run build:
 * node scripts/code-performance-probe.mjs --stage=before
 * node scripts/code-performance-probe.mjs --stage=after
 * Optional: --build-root=<absolute path containing out/>
 * Frozen build, isolated software-rendering profile, no engine or user data.
 */
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node runs this JavaScript file without a TypeScript loader. */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const stage = process.argv.find(arg => arg.startsWith('--stage='))?.slice('--stage='.length)
if (!['before', 'after'].includes(stage)) throw new Error('Pass --stage=before or --stage=after')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildRootArgument = process.argv.find(arg => arg.startsWith('--build-root='))
const suppliedBuildRoot = buildRootArgument?.slice('--build-root='.length)
if (buildRootArgument && !path.isAbsolute(suppliedBuildRoot)) throw new Error('--build-root must be an absolute path')
const buildRoot = suppliedBuildRoot ? path.resolve(suppliedBuildRoot) : root
const parent = path.join(root, '.e2e-tmp')
const runId = crypto.randomUUID()
const output = path.join(parent, `code-performance-${stage}-${runId}.json`)
const layoutKey = 'aether.ide.layout'
const codeSelector = '.mode-surface[data-mode="code"]'
const report = {
  schemaVersion: 1, runId, stage, generatedAt: new Date().toISOString(),
  buildInput: { root: buildRoot, out: path.join(buildRoot, 'out') },
  environment: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, totalMemoryGiB: Math.round(os.totalmem() / 1024 ** 3) },
  requested: { graphicsMode: 'software', autoStartEngine: false, width: 1800, height: 1200 },
  limitations: [
    'Click-to-second-rAF starts at the captured DOM click; Playwright actionability/input-dispatch wait is excluded.',
    'rAF timing is a renderer scheduling proxy; it does not confirm screen presentation and is not INP.',
    'Event Timing may omit events below its 16 ms threshold; no Event Timing sample does not imply zero latency.',
    'Storage timings cover synchronous localStorage.setItem only, excluding preceding JSON serialization, React publication and later paint.',
    'Fresh isolated profile has no engine, workspace, conversation history or guest browser page; results do not describe those workloads.',
    'One run is an observation, not a performance SLO or a statistically sufficient before/after conclusion.'
  ],
  buildArtifacts: [], pageErrors: [], observations: {}, cleanup: []
}
const quantile = (values, p) => values.length
  ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null
const check = (condition, message) => { if (!condition) throw new Error(message) }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2))
const twoRaf = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

function removeOwnedFixture(target, prefix) {
  const resolved = path.resolve(target)
  // Both checks are required before recursive deletion: a prefix alone is not
  // enough to prove that a path is inside the disposable workspace fixtures.
  check(path.dirname(resolved) === parent && path.basename(resolved).startsWith(prefix), `Unsafe cleanup path: ${resolved}`)
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  report.cleanup.push({ prefix, removed: true })
}

async function startProbe(page, label) {
  await page.evaluate(({ label, layoutKey }) => {
    window.__codeProbe?.stop()
    const data = { label, startedAt: performance.now(), frames: [], longTasks: [], events: [], writes: [],
      pointerMoves: [], observedTypes: [], observationErrors: [] }
    const observers = []
    const collect = (type, entries) => {
      for (const entry of entries) if (entry.startTime >= data.startedAt) {
        if (type === 'longtask') data.longTasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration })
        else data.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration,
          processingStart: entry.processingStart, processingEnd: entry.processingEnd, interactionId: entry.interactionId })
      }
    }
    for (const type of ['longtask', 'event']) {
      try {
        const observer = new PerformanceObserver(list => collect(type, list.getEntries()))
        observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
        data.observedTypes.push(type)
        observers.push({ type, observer })
      } catch (error) { data.observationErrors.push({ type, message: String(error) }) }
    }
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      const start = performance.now()
      try { return original.call(this, key, value) }
      finally {
        if (key === layoutKey && this === localStorage) data.writes.push({ startTime: start,
          duration: performance.now() - start, characters: String(value).length })
      }
    }
    const onPointerMove = event => {
      if (event.buttons) data.pointerMoves.push({ startTime: performance.now(), x: event.clientX, y: event.clientY })
    }
    document.addEventListener('pointermove', onPointerMove, true)
    let last = performance.now(), raf
    const tick = now => { data.frames.push({ startTime: now, duration: now - last }); last = now; raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    window.__codeProbe = { data, stop() {
      cancelAnimationFrame(raf)
      for (const { type, observer } of observers) { collect(type, observer.takeRecords()); observer.disconnect() }
      document.removeEventListener('pointermove', onPointerMove, true)
      Storage.prototype.setItem = original
      data.finishedAt = performance.now()
    } }
  }, { label, layoutKey })
}

async function stopProbe(page) {
  const raw = await page.evaluate(() => { window.__codeProbe.stop(); return window.__codeProbe.data })
  const frames = raw.frames.slice(1).map(entry => entry.duration)
  return { raw, summary: {
    rafP50Ms: quantile(frames, .5), rafP95Ms: quantile(frames, .95), rafMaxMs: Math.max(0, ...frames),
    rafGapsOver34Ms: frames.filter(value => value > 34).length, measuredFrameIntervals: frames.length,
    longTaskCount: raw.observedTypes.includes('longtask') ? raw.longTasks.length : null,
    longTaskTotalMs: raw.observedTypes.includes('longtask') ? raw.longTasks.reduce((sum, entry) => sum + entry.duration, 0) : null,
    eventP95Ms: quantile(raw.events.map(entry => entry.duration), .95), eventCount: raw.events.length,
    layoutWrites: raw.writes.length, layoutWriteP95Ms: quantile(raw.writes.map(entry => entry.duration), .95),
    pointerMoves: raw.pointerMoves.length
  } }
}

async function clickProbe(page, locator, label) {
  await locator.evaluate(element => {
    window.__codeClickProbe = null
    element.addEventListener('click', () => {
      const startTime = performance.now()
      requestAnimationFrame(firstRaf => requestAnimationFrame(secondRaf => {
        window.__codeClickProbe = { startTime, firstRaf, secondRaf, duration: performance.now() - startTime }
      }))
    }, { once: true, capture: true })
  })
  await locator.click()
  await page.waitForFunction(() => window.__codeClickProbe !== null)
  await page.waitForFunction(({ codeSelector, label }) => [...document.querySelectorAll(`${codeSelector} .app-settings__nav-item`)]
    .some(element => element.getAttribute('aria-label') === label && element.getAttribute('aria-selected') === 'true'), { codeSelector, label })
  return { label, ...await page.evaluate(() => window.__codeClickProbe) }
}

async function dimensions(page) {
  return page.evaluate(({ codeSelector, layoutKey }) => {
    const rect = selector => {
      const element = document.querySelector(`${codeSelector} ${selector}`)
      if (!element) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const layoutRaw = localStorage.getItem(layoutKey)
    return { sidebar: rect('.workbench__sidebar'), chat: rect('.workbench__chat:not(.workbench__chat--left)'),
      main: rect('.workbench__main'), body: rect('.workbench__body'), layoutRaw,
      layout: layoutRaw ? JSON.parse(layoutRaw) : null,
      focused: document.hasFocus(), visibility: document.visibilityState }
  }, { codeSelector, layoutKey })
}

async function dragProbe(page, code, name, panel, layoutField, deltaX) {
  const separator = code.getByRole('separator', { name, exact: true })
  const bounds = await separator.boundingBox()
  check(bounds?.width && bounds.height, `Separator unavailable: ${name}`)
  const before = await dimensions(page)
  check(before.focused && before.visibility === 'visible', 'Code window must be visible and focused during dragging')
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await startProbe(page, name)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX, y, { steps: 60 })
  await twoRaf(page)
  const afterMovement = await dimensions(page)
  const duringWrites = await page.evaluate(() => window.__codeProbe.data.writes.length)
  await page.mouse.up()
  await twoRaf(page)
  const afterPointerUp = await dimensions(page)
  const metrics = await stopProbe(page)
  const observation = { name, panel, layoutField, requestedSteps: 60, deltaX, expectedWidthDelta: 120,
    before, afterMovement, duringWrites, afterPointerUp, ...metrics }
  report.observations.drags.push(observation)
  // These assertions check the interaction outcome, not a timing budget or an
  // implementation-specific write count; both before and after are valid runs.
  check(Math.abs(afterPointerUp[panel].width - before[panel].width - 120) <= 3, `${name}: unexpected final width`)
  check(Math.abs(afterPointerUp.layout?.[layoutField] - afterPointerUp[panel].width) <= 3, `${name}: layout was not persisted`)
  save()
}

const marker = 'AETHER_CODE_PROBE_NATIVE_EVENT '
const crashReasons = new Set(['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'])
const sensitive = Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_?KEY/i.test(name))
  .flatMap(([, value]) => value ? [value] : [])
function redact(value) {
  let safe = value
  for (const secret of sensitive) if (secret.length >= 4) safe = safe.split(secret).join('[REDACTED]')
  return safe.replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|x-aether-instance-token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

function monitorHealth(app) {
  const child = app.process()
  const state = { launcherPid: child.pid, hostPid: null, exited: false, exit: null, earlyExit: false,
    closeError: '', nativeEvents: [], failures: [], stderrTail: '' }
  let pending = '', closing = false
  const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => {
    state.exited = true; state.exit = { code, signal }; state.earlyExit = !closing; resolve()
  }))
  const remember = line => {
    const safe = redact(line)
    state.stderrTail = (state.stderrTail + safe + '\n').slice(-32_768)
    const offset = line.indexOf(marker)
    if (offset >= 0) {
      try {
        const event = JSON.parse(safe.slice(offset + marker.length))
        state.nativeEvents.push(event)
        if (state.nativeEvents.length > 200) state.nativeEvents.shift()
        if (crashReasons.has(event.reason) || typeof event.exitCode === 'number' && event.exitCode !== 0) state.failures.push(`native ${JSON.stringify(event)}`)
      } catch { state.failures.push('Invalid native health event') }
    } else if (/\bFATAL[:\]]|Check failed:|Received signal|GPU process isn't usable|unknown software exception/i.test(line)) state.failures.push(safe)
    if (state.failures.length > 100) state.failures.shift()
  }
  child.stderr?.on('data', chunk => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''
    lines.forEach(remember)
    if (pending.length > 32_768) { remember(pending); pending = '' }
  })
  return {
    state,
    async install() {
      state.hostPid = await app.evaluate(({ app, webContents }, marker) => {
        const emit = event => process.stderr.write(marker + JSON.stringify(event) + '\n')
        const observe = contents => contents.on('render-process-gone', (_event, details) => emit({
          kind: 'render-process-gone', id: contents.id, reason: details.reason, exitCode: details.exitCode }))
        webContents.getAllWebContents().forEach(observe)
        app.on('web-contents-created', (_event, contents) => observe(contents))
        app.on('child-process-gone', (_event, details) => emit({ kind: 'child-process-gone', type: details.type,
          reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName }))
        return process.pid
      }, marker)
    },
    async close() {
      closing = true
      try { await app.close() } catch (error) { state.closeError = redact(String(error)) }
      let timer
      try { await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, 10_000) })]) }
      finally { clearTimeout(timer) }
      if (pending) { remember(pending); pending = '' }
      state.passed = state.exited && state.exit?.code === 0 && state.exit?.signal === null &&
        !state.earlyExit && !state.closeError && !state.failures.length
    }
  }
}

let snapshot, fixture, app, health
fs.mkdirSync(parent, { recursive: true })
try {
  snapshot = fs.mkdtempSync(path.join(parent, 'code-performance-build-'))
  // Keep one immutable output copy even if another chat rebuilds the checkout.
  fs.cpSync(path.join(buildRoot, 'out'), path.join(snapshot, 'out'), { recursive: true })
  fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ name: 'aether-code', version: '1.0.0', main: './out/main/index.js' }))
  const buildFiles = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
    ...fs.readdirSync(path.join(snapshot, 'out/renderer/assets')).filter(name => /^index-.*\.(js|css)$/.test(name))
      .sort().map(name => `out/renderer/assets/${name}`)]
  report.buildArtifacts = buildFiles.map(name => ({ path: name, bytes: fs.statSync(path.join(snapshot, name)).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(snapshot, name))).digest('hex') }))
  fixture = fs.mkdtempSync(path.join(parent, 'code-performance-profile-'))
  fs.writeFileSync(path.join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, graphicsMode: 'software', lastFolder: '', appearance: 'light' }))
  fs.writeFileSync(path.join(fixture, 'window-state.json'), JSON.stringify({ width: 1800, height: 1200 }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: path.join(fixture, 'global') }
  // A saved software policy must not be silently replaced by the developer's
  // diagnostic GPU override or a parent process's Electron Node mode.
  delete env.AETHER_ENABLE_GPU
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [snapshot, `--user-data-dir=${fixture}`], cwd: root, env, timeout: 30_000 })
  health = monitorHealth(app)
  report.health = health.state
  await health.install()
  const page = await app.firstWindow()
  page.on('pageerror', error => report.pageErrors.push(redact(error.message)))
  page.setDefaultTimeout(20_000)
  await page.locator('.app-mode-switch').waitFor()
  const codeTab = page.getByRole('tab', { name: 'Code 开发', exact: true })
  await codeTab.click()
  const code = page.locator(codeSelector)
  await code.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('#mode-tab-code')?.getAttribute('aria-selected') === 'true')
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.show(); window.focus(); window.webContents.focus()
  })
  await page.waitForFunction(() => document.hasFocus() && document.visibilityState === 'visible')
  if (!await code.locator('.app-settings').isVisible()) await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await code.locator('.app-settings').waitFor({ state: 'visible' })
  const settingTab = label => code.locator('.app-settings__nav').getByRole('tab', { name: label, exact: true })
  await settingTab('工作台').click()
  await twoRaf(page)
  report.graphics = await app.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(),
    basic: await app.getGPUInfo('basic'), versions: process.versions }))
  report.graphicsPolicy = await page.evaluate(async () => ({ snapshot: await window.aether.graphics.getSnapshot(),
    effects: document.documentElement.dataset.visualEffects }))
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    focused: document.hasFocus(), visibility: document.visibilityState, supportedEntryTypes: PerformanceObserver.supportedEntryTypes }))
  check(report.graphicsPolicy.snapshot.configuredMode === 'software', 'Software graphics setting was not loaded')
  report.observations.glassLayers = await page.evaluate(() => [...document.querySelectorAll('*')].map(element => ({ element, style: getComputedStyle(element) }))
    .filter(({ element, style }) => style.backdropFilter !== 'none' && element.getBoundingClientRect().width && element.getBoundingClientRect().height)
    .map(({ element, style }) => { const { width, height } = element.getBoundingClientRect(); return {
      className: String(element.className), filter: style.backdropFilter, width, height } }))
  await startProbe(page, 'already-open Code settings navigation')
  const clicks = []
  for (const label of [...Array(2)].flatMap(() => ['外观', '文本编辑器', '终端', '文件', '工作台', '引擎管理', '外观', '文本编辑器'])) {
    clicks.push(await clickProbe(page, settingTab(label), label))
  }
  report.observations.settings = { clicks, clickToSecondRafP50Ms: quantile(clicks.map(entry => entry.duration), .5),
    clickToSecondRafP95Ms: quantile(clicks.map(entry => entry.duration), .95), ...await stopProbe(page) }
  report.observations.drags = []
  save()
  await dragProbe(page, code, '调整侧边栏宽度', 'sidebar', 'sidebarWidth', 120)
  await dragProbe(page, code, '调整对话面板宽度', 'chat', 'chatPanelWidth', -120)
  const beforeSwitch = await dimensions(page)
  await code.locator('.workbench__body').evaluate(element => { window.__codePreservationNode = element })
  const selectedBefore = await code.locator('.app-settings__nav-item[aria-selected="true"]').getAttribute('aria-label')
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await page.locator('.work-view').waitFor({ state: 'visible' })
  await code.waitFor({ state: 'hidden' })
  const whileWork = await code.evaluate(element => ({ inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'),
    layoutRaw: localStorage.getItem('aether.ide.layout') }))
  await codeTab.click()
  await code.waitFor({ state: 'visible' })
  await page.locator('.mode-surface[data-mode="work"]').waitFor({ state: 'hidden' })
  await twoRaf(page)
  const afterSwitch = await dimensions(page)
  const sameDom = await code.locator('.workbench__body').evaluate(element => element === window.__codePreservationNode)
  const selectedAfter = await code.locator('.app-settings__nav-item[aria-selected="true"]').getAttribute('aria-label')
  report.observations.modePreservation = { beforeSwitch, whileWork, afterSwitch, selectedBefore, selectedAfter, sameDom,
    sameLayout: beforeSwitch.layoutRaw === whileWork.layoutRaw && beforeSwitch.layoutRaw === afterSwitch.layoutRaw }
  check(sameDom && selectedBefore === selectedAfter && report.observations.modePreservation.sameLayout, 'Code state changed after Code→Work→Code')
  check(whileWork.inert && whileWork.ariaHidden === 'true', 'Hidden Code surface remained interactive')
  check(Math.abs(beforeSwitch.sidebar.width - afterSwitch.sidebar.width) <= 3 && Math.abs(beforeSwitch.chat.width - afterSwitch.chat.width) <= 3,
    'Code dimensions changed after mode switch')
  check(await codeTab.getAttribute('aria-selected') === 'true', 'Code tab was not active at completion')
  check(!report.pageErrors.length, 'Renderer pageerror recorded')
} catch (error) {
  report.failure = redact(String(error))
  process.exitCode = 1
} finally {
  if (health) {
    try { await health.close() } catch (error) { report.closeFailure = redact(String(error)); process.exitCode = 1 }
    if (!health.state.passed) process.exitCode = 1
  } else if (app) {
    try { await app.close() } catch (error) { report.closeFailure = redact(String(error)); process.exitCode = 1 }
  }
  // Preserve a still-live profile for diagnosis instead of deleting files used
  // by a process which failed to close. A nonzero exit reports this condition.
  if (!app || health?.state.exited) {
    for (const [target, prefix] of [[fixture, 'code-performance-profile-'], [snapshot, 'code-performance-build-']]) {
      if (!target) continue
      try { removeOwnedFixture(target, prefix) } catch (error) { report.cleanup.push({ prefix, error: redact(String(error)) }); process.exitCode = 1 }
    }
  } else report.cleanup.push({ removed: false, reason: 'Electron exit was not confirmed; fixtures retained' })
  report.finishedAt = new Date().toISOString()
  report.passed = !report.failure && !report.closeFailure && !report.pageErrors.length && Boolean(report.health?.passed) &&
    !report.cleanup.some(entry => entry.error || entry.removed === false)
  if (!report.passed) process.exitCode = 1
  save()
  console.log(JSON.stringify({ report: output, passed: report.passed, settingsClickP95Ms: report.observations.settings?.clickToSecondRafP95Ms,
    dragWrites: report.observations.drags?.map(drag => ({ panel: drag.panel, during: drag.duringWrites, total: drag.summary.layoutWrites })),
    exit: report.health?.exit, nativeFailures: report.health?.failures.length }))
}
