/** Isolated, serial Electron renderer probe. No engine or real user profile is used.
 * Run after npm run build: node scripts/work-performance-probe.mjs
 * rAF gaps and click-to-two-rAF are scheduling proxies, not presented-frame/INP metrics.
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parent = path.join(root, '.e2e-tmp')
fs.mkdirSync(parent, { recursive: true })
// Other chats may rebuild out/ while profiling. Both GPU modes must load one
// immutable copy, so changes to the shared output cannot skew the comparison.
const snapshot = fs.mkdtempSync(path.join(parent, 'work-performance-build-'))
fs.cpSync(path.join(root, 'out'), path.join(snapshot, 'out'), { recursive: true })
fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ name: 'aether-code', version: '1.0.0', main: './out/main/index.js' }))
const buildFiles = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
  ...fs.readdirSync(path.join(snapshot, 'out/renderer/assets')).filter(name => /^index-.*\.(js|css)$/.test(name)).map(name => `out/renderer/assets/${name}`)]
const buildArtifacts = buildFiles.map(name => ({ path: name, bytes: fs.statSync(path.join(snapshot, name)).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(snapshot, name))).digest('hex') }))
const layers = process.argv.includes('--layers')
const verify = process.argv.includes('--verify')
const output = path.join(parent, verify ? 'work-performance-optimized-results.json' : layers ? 'work-performance-layers-results.json' : 'work-performance-results.json')
const report = { runId: crypto.randomUUID(), generatedAt: new Date().toISOString(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
  totalMemoryGiB: Math.round(os.totalmem() / 1024 ** 3), buildArtifacts,
  note: 'Frozen build; no engine, no conversation history; renderer scheduling probe only.', configurations: [] }
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function startProbe(page) {
  await page.evaluate(() => {
    window.__workProbe?.stop()
    const data = { frames: [], longTasks: [], events: [], writes: [], observedTypes: [], observationErrors: [] }
    const probeStart = performance.now()
    const observers = []
    for (const type of ['longtask', 'event']) {
      try {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (entry.startTime >= probeStart) (type === 'longtask' ? data.longTasks : data.events).push({ name: entry.name, duration: entry.duration })
        })
        observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
        data.observedTypes.push(type)
        observers.push(observer)
      } catch (error) { data.observationErrors.push({ type, message: String(error) }) }
    }
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      const start = performance.now()
      try { return original.call(this, key, value) }
      finally { if (key.startsWith('aether.work.state')) data.writes.push({ duration: performance.now() - start, bytes: value.length }) }
    }
    let last = performance.now(), raf
    const tick = now => { data.frames.push(now - last); last = now; raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    window.__workProbe = { data, stop() { cancelAnimationFrame(raf); for (const o of observers) o.disconnect(); Storage.prototype.setItem = original } }
  })
}
async function stopProbe(page) {
  const data = await page.evaluate(() => { window.__workProbe.stop(); return window.__workProbe.data })
  const durations = data.frames.slice(1)
  return { rafP50Ms: quantile(durations, .5), rafP95Ms: quantile(durations, .95), rafMaxMs: Math.max(0, ...durations),
    rafGapsOver34Ms: durations.filter(v => v > 34).length, frames: durations.length,
    observedTypes: data.observedTypes, observationErrors: data.observationErrors,
    longTaskCount: data.observedTypes.includes('longtask') ? data.longTasks.length : null,
    longTaskTotalMs: data.observedTypes.includes('longtask') ? data.longTasks.reduce((sum, e) => sum + e.duration, 0) : null,
    eventP95Ms: quantile(data.events.map(e => e.duration), .95), eventCount: data.events.length,
    writes: data.writes.length, writeP95Ms: quantile(data.writes.map(e => e.duration), .95),
    maxStateCharacters: Math.max(0, ...data.writes.map(e => e.bytes)) }
}
async function clickProbe(page, locator) {
  await locator.evaluate(element => {
    window.__clickProbe = null
    element.addEventListener('click', () => {
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__clickProbe = performance.now() - start }))
    }, { once: true, capture: true })
  })
  await locator.click()
  await page.waitForFunction(() => window.__clickProbe !== null)
  return page.evaluate(() => window.__clickProbe)
}
async function setGlass(page, variant) {
  await page.evaluate(variant => {
    document.getElementById('work-perf-disable-glass')?.remove()
    if (variant !== 'all') {
      const style = document.createElement('style'); style.id = 'work-perf-disable-glass'
      const selectors = { none: '*, *::before, *::after', 'no-overlay': '.modal-overlay', 'no-panel': '.work-settings-dialog',
        'no-inner': '.work-settings-dialog .app-settings__nav, .work-settings-dialog .app-settings__toolbar',
        'settings-solid': '.modal-overlay, .work-settings-dialog, .work-settings-dialog .app-settings__nav, .work-settings-dialog .app-settings__toolbar' }
      style.textContent = `${selectors[variant]} { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`
      document.head.append(style)
    }
  }, variant)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

for (const gpu of layers ? ['0'] : process.argv.includes('--default-graphics') ? ['0', '1', 'default'] : ['0', '1']) {
  const fixture = fs.mkdtempSync(path.join(parent, 'work-performance-'))
  fs.writeFileSync(path.join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: '', appearance: 'light' }))
  fs.writeFileSync(path.join(fixture, 'window-state.json'), JSON.stringify({ width: 1800, height: 1200 }))
  const config = { requestedGpu: gpu, samples: [], errors: [] }
  report.configurations.push(config)
  let app
  try {
    const env = { ...process.env, AETHER_ENABLE_GPU: gpu, AETHER_GLOBAL_DIR: path.join(fixture, 'global') }
    if (gpu === 'default') delete env.AETHER_ENABLE_GPU
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [snapshot, `--user-data-dir=${fixture}`], cwd: root, env, timeout: 30_000 })
    app.process().stderr?.on('data', data => { const s = data.toString(); if (/crash|GPU process|exited|ERROR/i.test(s)) config.errors.push(s.slice(0, 3000)) })
    const page = await app.firstWindow()
    page.on('pageerror', error => config.errors.push(error.message))
    await page.locator('.app-mode-switch').waitFor()
    config.gpu = await app.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), basic: await app.getGPUInfo('basic'), versions: process.versions }))
    config.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, focused: document.hasFocus(), visibility: document.visibilityState,
      supportedEntryTypes: PerformanceObserver.supportedEntryTypes }))
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('.work-view').waitFor()
    await delay(1000)
    config.graphicsPolicy = await page.evaluate(async () => ({ snapshot: await window.aether.graphics.getSnapshot(), effects: document.documentElement.dataset.visualEffects }))
    const variants = layers ? ['all', 'no-overlay', 'no-panel', 'no-inner', 'settings-solid', 'none', 'no-overlay', 'settings-solid', 'all'] : ['all', 'none', 'none', 'all']
    for (const [sampleIndex, glassVariant] of variants.entries()) {
      const glass = glassVariant !== 'none'
      await setGlass(page, glassVariant)
      await startProbe(page)
      const input = page.getByRole('textbox', { name: '任务目标', exact: true })
      await input.fill('')
      await input.pressSequentially('Work performance input and navigation probe. '.repeat(3), { delay: 10 })
      const inputMetrics = await stopProbe(page)
      await startProbe(page)
      const clickTimes = []
      for (const label of ['项目', '成果', '工作台', '项目', '工作台']) {
        clickTimes.push(await clickProbe(page, page.locator('.work-navigation__item').filter({ hasText: label }).first()))
      }
      const navigation = await stopProbe(page)
      await page.locator('.work-sidebar__bottom').getByRole('button', { name: '设置', exact: true }).click()
      await page.locator('.work-settings-dialog').waitFor()
      if (!layers) await page.screenshot({ path: path.join(parent, `work-performance-gpu${gpu}-glass${glass ? 1 : 0}.png`) })
      if (glassVariant === 'all') config.glassLayers = await page.evaluate(() => [...document.querySelectorAll('*')].map(e => ({ e, s: getComputedStyle(e) }))
        .filter(({ e, s }) => s.backdropFilter !== 'none' && e.getBoundingClientRect().width && e.getBoundingClientRect().height)
        .map(({ e, s }) => ({ className: e.className, filter: s.backdropFilter, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })))
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      const before = await cdp.send('Performance.getMetrics')
      await startProbe(page)
      const settingsClicks = []
      for (const label of ['外观', '文本编辑器', '终端', '文件', '工作台', '引擎管理', '外观', '文本编辑器']) {
        settingsClicks.push(await clickProbe(page, page.locator('.work-settings-dialog .app-settings__nav-item').filter({ hasText: label }).first()))
        await page.locator('.work-settings-dialog .app-settings__body').evaluate(el => { el.scrollTop = el.scrollHeight })
        await page.locator('.work-settings-dialog .app-settings__body').evaluate(el => { el.scrollTop = 0 })
      }
      const settingsMetrics = await stopProbe(page)
      const after = await cdp.send('Performance.getMetrics')
      const metricDeltas = Object.fromEntries(after.metrics.filter(e => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].includes(e.name))
        .map(e => [e.name, e.value - (before.metrics.find(p => p.name === e.name)?.value ?? 0)]))
      await cdp.detach()
      await page.locator('.work-settings-dialog').getByRole('button', { name: '关闭', exact: true }).click()
      config.samples.push({ sampleIndex, glass, glassVariant, input: inputMetrics, navigation: { ...navigation, clickToTwoRafP95Ms: quantile(clickTimes, .95) },
        settings: { ...settingsMetrics, clickToTwoRafP95Ms: quantile(settingsClicks, .95), clickTimesMs: settingsClicks, ...metricDeltas } })
      fs.writeFileSync(output, JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ requestedGpu: gpu, glass, glassVariant, sampleIndex, input: inputMetrics, navigationClickP95: quantile(clickTimes, .95), settings: config.samples.at(-1).settings }))
    }
  } catch (error) { config.failure = String(error); console.error(`GPU ${gpu}: ${error}`) }
  finally {
    await app?.close().catch(error => { config.errors.push(String(error)) })
    // Restrict removal to the newly created fixture; never operate on a real profile.
    const target = path.resolve(fixture)
    if (path.dirname(target) === parent && path.basename(target).startsWith('work-performance-')) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
  }
}
console.log(`Report: ${output}`)
report.finishedAt = new Date().toISOString()
fs.writeFileSync(output, JSON.stringify(report, null, 2))
const buildTarget = path.resolve(snapshot)
if (path.dirname(buildTarget) === parent && path.basename(buildTarget).startsWith('work-performance-build-')) fs.rmSync(buildTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
if (report.configurations.some(config => config.failure)) process.exitCode = 1
if (verify) {
  // This gate catches the original >200ms software settings regression. It is a
  // scheduling proxy with a generous frame-rate margin, not a production INP SLO.
  const regressions = report.configurations.flatMap(config => config.samples
    .filter(sample => sample.glassVariant === 'all' && sample.settings.clickToTwoRafP95Ms > 120)
    .map(sample => ({ requestedGpu: config.requestedGpu, sampleIndex: sample.sampleIndex, p95Ms: sample.settings.clickToTwoRafP95Ms })))
  report.verification = { budgetMs: 120, regressions, passed: !regressions.length && report.configurations.every(config => !config.failure) }
  fs.writeFileSync(output, JSON.stringify(report, null, 2))
  if (!report.verification.passed) process.exitCode = 1
}
