/** Round-0001 concurrency/resource probe. Read-only against the frozen out/ build.
 * Launches N isolated Electron instances concurrently, measures cold-start time to
 * first paint of the Work view, and samples per-instance RSS via app.getAppMetrics().
 * No engine, no real user profile, no network.
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const parent = path.join(root, '.e2e-tmp')
fs.mkdirSync(parent, { recursive: true })
const snapshot = fs.mkdtempSync(path.join(parent, 'perf-concurrency-build-'))
fs.cpSync(path.join(root, 'out'), path.join(snapshot, 'out'), { recursive: true })
fs.writeFileSync(
  path.join(snapshot, 'package.json'),
  JSON.stringify({ name: 'aether-code', version: '1.0.0', main: './out/main/index.js' })
)

const concurrencyArg = process.argv.find(a => a.startsWith('--concurrency='))
const CONCURRENCY = Number(concurrencyArg ? concurrencyArg.split('=')[1] : process.env.PERF_CONCURRENCY || 3)
const outputSuffix = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || ''
const report = {
  runId: crypto.randomUUID(),
  generatedAt: new Date().toISOString(),
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  totalMemoryGiB: Math.round(os.totalmem() / 1024 ** 3),
  concurrency: CONCURRENCY,
  note: 'Concurrent isolated-instance cold start; frozen build; no engine; RSS from app.getAppMetrics().',
  instances: []
}

async function launchOne(index) {
  const fixture = fs.mkdtempSync(path.join(parent, `perf-concurrency-${index}-`))
  fs.writeFileSync(
    path.join(fixture, 'settings.json'),
    JSON.stringify({ autoStartEngine: false, lastFolder: '', appearance: 'light' })
  )
  fs.writeFileSync(path.join(fixture, 'window-state.json'), JSON.stringify({ width: 1800, height: 1200 }))
  const env = {
    ...process.env,
    AETHER_ENABLE_GPU: '0',
    AETHER_GLOBAL_DIR: path.join(fixture, 'global')
  }
  delete env.ELECTRON_RUN_AS_NODE
  const record = { index, fixture, startedAt: new Date().toISOString() }
  const t0 = performance.now()
  let app
  try {
    app = await electron.launch({
      args: [snapshot, `--user-data-dir=${fixture}`, '--new-instance'],
      cwd: root,
      env,
      timeout: 60_000
    })
    record.launchMs = performance.now() - t0
    const page = await app.firstWindow()
    const tWindow = performance.now()
    record.firstWindowMs = tWindow - t0
    await page.locator('.app-mode-switch').waitFor({ timeout: 60_000 })
    record.readyMs = performance.now() - t0
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.locator('.work-view').waitFor({ timeout: 60_000 })
    record.workViewMs = performance.now() - t0
    // Let the renderer settle before sampling memory.
    await new Promise(r => setTimeout(r, 1500))
    record.metrics = await app.evaluate(async ({ app }) => {
      const m = app.getAppMetrics()
      return {
        processCount: m.length,
        totalWorkingSetKiB: m.reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0),
        byType: m.map(p => ({
          type: p.type,
          workingSetKiB: p.memory?.workingSetSize ?? null,
          peakWorkingSetKiB: p.memory?.peakWorkingSetSize ?? null,
          cpuPercent: p.cpu?.percentCPUUsage ?? null
        }))
      }
    })
    record.ok = true
  } catch (error) {
    record.ok = false
    record.error = String(error).slice(0, 2000)
  } finally {
    await app?.close().catch(() => {})
    const target = path.resolve(fixture)
    if (path.dirname(target) === parent && path.basename(target).startsWith('perf-concurrency-')) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
  return record
}

const wallStart = performance.now()
const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => launchOne(i)))
report.wallClockMs = performance.now() - wallStart
report.instances = results
report.summary = {
  launched: results.filter(r => r.ok).length,
  failed: results.filter(r => !r.ok).length,
  readyMsMax: Math.max(0, ...results.filter(r => r.ok).map(r => r.readyMs)),
  workViewMsMax: Math.max(0, ...results.filter(r => r.ok).map(r => r.workViewMs)),
  totalWorkingSetMiB: results.filter(r => r.ok).reduce((s, r) => s + r.metrics.totalWorkingSetKiB, 0) / 1024,
  processCountTotal: results.filter(r => r.ok).reduce((s, r) => s + r.metrics.processCount, 0)
}
report.finishedAt = new Date().toISOString()
const output = path.join(parent, `perf-concurrency-results${outputSuffix}.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.summary, null, 2))
console.log(`Report: ${output}`)
const buildTarget = path.resolve(snapshot)
if (path.dirname(buildTarget) === parent && path.basename(buildTarget).startsWith('perf-concurrency-build-')) {
  fs.rmSync(buildTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
if (report.summary.failed) process.exitCode = 1