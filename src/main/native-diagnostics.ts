import { app, crashReporter } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

type DiagnosticDetails = Record<string, string | number | boolean | undefined>
type DiagnosticWriter = (event: string, details?: DiagnosticDetails) => void

// Keep a no-op writer until startup diagnostics are initialized. Engine health
// probes can run after app readiness and must never make logging a dependency
// for the main process to stay alive.
let diagnosticWriter: DiagnosticWriter = () => undefined

/**
 * Append a bounded, local diagnostic event to the native process journal.
 * Callers should pass only operational metadata; credentials and request bodies
 * must never be written here.
 */
export function recordNativeDiagnostic(event: string, details: DiagnosticDetails = {}): void {
  diagnosticWriter(event, details)
}

/** Native failures never reach React's error handler; retain local evidence across restarts. */
export function initializeNativeDiagnostics(): void {
  const directory = join(app.getPath('userData'), 'logs')
  const journal = join(directory, 'native-processes.jsonl')
  const record = (event: string, details: DiagnosticDetails = {}): void => {
    try {
      mkdirSync(directory, { recursive: true })
      if (existsSync(journal) && statSync(journal).size > 512 * 1024) {
        rmSync(journal + '.previous', { force: true })
        renameSync(journal, journal + '.previous')
      }
      appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n')
    } catch {
      // A read-only/full profile must not turn diagnostics into another crash.
    }
  }
  diagnosticWriter = record
  record('startup', { electron: process.versions.electron, platform: process.platform, arch: process.arch })
  try {
    // Dumps remain on this computer. No endpoint is configured and no upload is permitted.
    crashReporter.start({ uploadToServer: false, compress: true })
    record('crash-reporter-ready')
  } catch {
    record('crash-reporter-unavailable')
  }
  app.on('child-process-gone', (_event, details) => {
    record('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode })
  })
  app.on('web-contents-created', (_event, contents) => {
    const webContentsId = contents.id
    contents.on('render-process-gone', (_event, details) => {
      record('render-process-gone', { webContentsId, reason: details.reason, exitCode: details.exitCode })
    })
  })
  app.on('before-quit', () => record('before-quit'))
  app.on('will-quit', () => record('will-quit'))
  process.on('exit', exitCode => record('process-exit', { exitCode }))
}
