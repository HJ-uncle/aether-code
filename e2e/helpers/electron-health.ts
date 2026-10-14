import { expect, type ElectronApplication, type TestInfo } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const marker = 'AETHER_E2E_NATIVE_EVENT '
const crashReasons = new Set(['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'])
type NativeEvent = { kind: string; reason?: string; exitCode?: number; id?: number; type?: string; serviceName?: string }

export function redactNativeLog(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|x-aether-instance-token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

export function nativeEventFailed(event: NativeEvent): boolean {
  return crashReasons.has(event.reason ?? '') || typeof event.exitCode === 'number' && event.exitCode !== 0
}

/** pageerror cannot observe native child crashes or a fatal exit during app.quit.
 * Keep a bounded, redacted process record and assert it even when UI assertions pass. */
export async function monitorElectronHealth(app: ElectronApplication, label: string, secrets: readonly string[] = []) {
  const child = app.process(), events: NativeEvent[] = [], failures: string[] = []
  const sensitive = [...secrets, ...Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_?KEY/i.test(name)).flatMap(([, value]) => value ? [value] : [])]
  let stderrTail = '', pending = '', closing = false, exited = false, closed = false
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let close: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const exitPromise = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => { exited = true; exit = { code, signal }; resolve() })
  })
  const closePromise = new Promise<void>(resolve => {
    child.once('close', (code, signal) => { closed = true; close = { code, signal }; resolve() })
  })
  const remember = (line: string): void => {
    const safe = redactNativeLog(line, sensitive)
    stderrTail = (stderrTail + safe + '\n').slice(-32_768)
    const offset = line.indexOf(marker)
    if (offset >= 0) {
      try {
        const event = JSON.parse(line.slice(offset + marker.length)) as NativeEvent
        events.push(event)
        if (events.length > 200) events.shift()
        if (nativeEventFailed(event)) failures.push(`native ${redactNativeLog(JSON.stringify(event), sensitive)}`)
      } catch { failures.push('Invalid native health event') }
    } else if (/\bFATAL[:\]]|Check failed:|Received signal|GPU process isn't usable|unknown software exception/i.test(line)) failures.push(safe)
    if (failures.length > 100) failures.shift()
  }
  child.stderr?.on('data', chunk => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''
    lines.forEach(remember)
    if (pending.length > 32_768) { remember(pending); pending = '' }
  })
  const hostPid = await app.evaluate(({ app, webContents }, marker) => {
    const emit = (event: Record<string, unknown>): void => { process.stderr.write(marker + JSON.stringify(event) + '\n') }
    const observe = (contents: Electron.WebContents): void => {
      contents.on('render-process-gone', (_event, details) => emit({ kind: 'render-process-gone', id: contents.id, reason: details.reason, exitCode: details.exitCode }))
    }
    for (const contents of webContents.getAllWebContents()) observe(contents)
    app.on('web-contents-created', (_event, contents) => observe(contents))
    app.on('child-process-gone', (_event, details) => emit({ kind: 'child-process-gone', type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName }))
    return process.pid
  }, marker)
  return {
    assertHealthy(): void {
      expect(failures, `${label}: native crash signals`).toEqual([])
      expect(exited && !closing, `${label}: Electron exited before suite teardown`).toBe(false)
    },
    async closeAndAssert(testInfo: TestInfo, requestClose: () => Promise<unknown> = () => app.close()): Promise<void> {
      closing = true
      let closeError = ''
      try { await requestClose() } catch (error) { closeError = redactNativeLog(String(error), sensitive) }
      let timer: NodeJS.Timeout | undefined
      try {
        // exit does not imply stdio has drained. A native fatal line can be
        // delivered afterwards, so preserve the exact close receipt as well.
        await Promise.race([Promise.all([exitPromise, closePromise]), new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })])
      } finally { if (timer) clearTimeout(timer) }
      if (pending) { remember(pending); pending = '' }
      const report = { label, hostPid, launcherPid: child.pid, exited, exit, closed, close, closeError, failures, events, stderrTail }
      const reportPath = testInfo.outputPath(`electron-health-${label}.json`)
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, JSON.stringify(report, null, 2))
      await testInfo.attach(`electron-health-${label}`, { path: reportPath, contentType: 'application/json' })
      console.log(`ELECTRON_HEALTH ${label} hostPid=${hostPid} launcherPid=${child.pid} exit=${JSON.stringify(exit)} nativeEvents=${events.length} failures=${failures.length}`)
      expect(closeError, `${label}: Electron close error`).toBe('')
      expect(exited, `${label}: Electron process must exit`).toBe(true)
      expect(closed, `${label}: Electron stdio must close before native log acceptance`).toBe(true)
      expect(exit, `${label}: abnormal Electron exit; inspect attached native health report`).toEqual({ code: 0, signal: null })
      expect(close, `${label}: abnormal Electron close receipt`).toEqual({ code: 0, signal: null })
      expect(failures, `${label}: native crash signals; inspect attached native health report`).toEqual([])
    }
  }
}

export type ElectronHealthMonitor = Awaited<ReturnType<typeof monitorElectronHealth>>
