/** Windows root-engine telemetry. It does not claim coverage of child processes. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)

export async function readWindowsProcessSample(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Engine PID must be a positive integer')
  if (process.platform !== 'win32') throw new Error('Engine process telemetry requires Windows')
  // Query only the explicitly owned PID. No process inventory or command lines
  // are collected; PID reuse is checked against the verified creation timestamp.
  const script = `$ErrorActionPreference = 'Stop'; $target = Get-Process -Id ${pid}; [pscustomobject]@{ pid = $target.Id; creationTimeUtc = $target.StartTime.ToUniversalTime().ToString('o'); creationTimeTicks = $target.StartTime.ToUniversalTime().Ticks.ToString(); workingSetBytes = $target.WorkingSet64; privateMemoryBytes = $target.PrivateMemorySize64; cpuSeconds = $target.CPU; handleCount = $target.Handles } | ConvertTo-Json -Compress`
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 32_768 })
    return JSON.parse(stdout.trim())
  } catch { throw new Error(`Cannot sample the owned engine process ${pid}`) }
}

export function validateProcessSample(sample, identity) {
  if (sample?.pid !== identity.pid || sample.creationTimeTicks !== identity.creationTimeTicks) throw new Error('Engine process identity changed or PID was reused')
  for (const key of ['workingSetBytes', 'privateMemoryBytes', 'cpuSeconds', 'handleCount']) {
    if (typeof sample[key] !== 'number' || !Number.isFinite(sample[key]) || sample[key] < 0) throw new Error(`Invalid engine metric ${key}`)
  }
  return sample
}

export async function startProcessMonitor({ pid, creationTimeTicks, runRoot, intervalMs = 30_000, readSample = readWindowsProcessSample, onError = () => {} }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d{16,20}$/.test(creationTimeTicks || '')) throw new Error('Engine telemetry requires a verified PID and UTC creation ticks')
  const identity = { pid, creationTimeTicks }
  if (fs.existsSync(path.join(runRoot, 'engine-process-summary.json'))) throw new Error('Engine telemetry already exists; preserve the previous evidence')
  const lockPath = path.join(runRoot, '.engine-monitor.lock')
  const lock = fs.openSync(lockPath, 'wx')
  fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock)
  const summaryPath = path.join(runRoot, 'engine-process-summary.json')
  const eventPath = path.join(runRoot, 'engine-process-events.jsonl')
  const summary = { identity, scope: 'owned engine root process only; children and Electron excluded', monitorPid: process.pid, intervalMs, startedAt: new Date().toISOString(), status: 'running', samples: 0, first: null, last: null, peaks: {} }
  const save = () => {
    const temporary = `${summaryPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`)
    fs.renameSync(temporary, summaryPath)
  }
  let failure = null
  let pending = null
  const sample = async () => {
    const metrics = validateProcessSample(await readSample(pid), identity)
    const event = { at: new Date().toISOString(), type: 'engine-process-sample', ...metrics }
    fs.appendFileSync(eventPath, `${JSON.stringify(event)}\n`)
    summary.samples += 1; summary.first ||= event; summary.last = event
    for (const key of ['workingSetBytes', 'privateMemoryBytes', 'handleCount']) summary.peaks[key] = Math.max(summary.peaks[key] || 0, metrics[key])
    summary.cpuSecondsDelta = metrics.cpuSeconds - summary.first.cpuSeconds
    save()
  }
  const recordFailure = error => {
    failure ||= error; summary.status = 'failed'; summary.error = error.message
    fs.appendFileSync(eventPath, `${JSON.stringify({ at: new Date().toISOString(), type: 'engine-process-error', identity, error: error.message })}\n`)
    save(); onError(error)
  }
  try { await sample() } catch (error) {
    recordFailure(error); fs.unlinkSync(lockPath); throw error
  }
  const timer = setInterval(() => {
    if (!pending && !failure) pending = sample().catch(recordFailure).finally(() => { pending = null })
  }, intervalMs)
  timer.unref()
  return {
    summary,
    async stop() {
      clearInterval(timer)
      await pending
      if (!failure) { try { await sample() } catch (error) { recordFailure(error) } }
      summary.status = failure ? 'failed' : 'completed'; summary.finishedAt = new Date().toISOString(); save()
      fs.unlinkSync(lockPath)
      if (failure) throw failure
      return summary
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node scripts/work-soak-process.mjs --run-root PATH --engine-pid PID --engine-start-ticks UTC_TICKS\nSamples only the explicitly owned Windows engine PID every 30 seconds until this run manifest becomes terminal. Run directory must already contain manifest.json.')
    return
  }
  const value = flag => args[args.indexOf(flag) + 1]
  for (const flag of ['--run-root', '--engine-pid', '--engine-start-ticks']) if (!args.includes(flag)) throw new Error(`Missing ${flag}`)
  const runRoot = path.resolve(value('--run-root'))
  const readManifest = () => JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'))
  if (readManifest().status !== 'running') throw new Error('Run manifest must be running before attaching telemetry')
  let failure = null
  let stopped = false
  const interrupt = () => { stopped = true }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  const monitor = await startProcessMonitor({ pid: Number(value('--engine-pid')), creationTimeTicks: value('--engine-start-ticks'), runRoot, onError: error => { failure = error } })
  console.log(JSON.stringify({ monitorPid: process.pid, engine: monitor.summary.identity, runRoot, scope: monitor.summary.scope }))
  try {
    while (!stopped && !failure && ['running', 'stopping'].includes(readManifest().status)) await delay(5_000)
  } finally {
    await monitor.stop()
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  }
  if (failure) throw failure
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
