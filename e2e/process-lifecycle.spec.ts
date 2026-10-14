/** Pure lifecycle contracts: synthetic ChildProcess events only, no Electron/model/PTY. */
import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, test } from '@playwright/test'
import {
  observeProcessLifecycle,
  OwnedProcessLedger,
  ProcessStopError,
  type OwnedProcessHandle
} from '../src/main/engine/sdk/process-lifecycle'

function fixture(pid: number | null = 99) {
  const child = new ChildProcess()
  const childPid = pid ?? undefined
  Object.defineProperty(child, 'pid', { value: childPid })
  const signals: (NodeJS.Signals | number | undefined)[] = []
  child.kill = (signal) => { signals.push(signal); child.killed = true; return true }
  const lifecycle = observeProcessLifecycle(child)
  const handle: OwnedProcessHandle = { pid: childPid, lifecycle, stop: () => lifecycle.stop(5, 5).then(() => undefined) }
  const exit = (code: number | null = 1, signal: NodeJS.Signals | null = null): void => { child.emit('exit', code, signal) }
  const close = (code: number | null = 1, signal: NodeJS.Signals | null = null): void => { child.emit('close', code, signal) }
  return { child, lifecycle, handle, signals, exit, close }
}

test('stop uses one promise and sends SIGTERM exactly once', async () => {
  const f = fixture()
  const first = f.lifecycle.stop(30, 30)
  expect(f.lifecycle.stop(0, 0)).toBe(first)
  expect(observeProcessLifecycle(f.child)).toBe(f.lifecycle)
  expect(f.signals).toEqual(['SIGTERM'])
  f.exit(); f.close()
  expect(await first).toMatchObject({ outcome: 'exited-unverified', cleanupVerified: false, exitCode: 1 })
})

test('child.killed and successful kill are not exit evidence', async () => {
  const f = fixture()
  f.child.killed = true
  await expect(f.lifecycle.stop(5, 5)).rejects.toBeInstanceOf(ProcessStopError)
  expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(f.lifecycle.observation()).toMatchObject({ closeObserved: false, exitObserved: false, forced: true })
})

test('false kill and thrown kill still require exit and close', async () => {
  for (const kind of ['false', 'throw']) {
    const f = fixture()
    f.child.kill = (signal) => {
      f.signals.push(signal)
      if (kind === 'throw') throw new Error('denied')
      return false
    }
    await expect(f.lifecycle.stop(5, 5)).rejects.toThrow(/未确认/)
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(f.lifecycle.observation().signalErrors).toHaveLength(2)
  }
})

test('exit waits for close and never sends SIGKILL while pipes drain', async () => {
  const f = fixture()
  const stopping = f.lifecycle.stop(5, 50)
  let settled = false
  void stopping.then(() => { settled = true })
  f.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(settled).toBe(false)
  expect(f.signals).toEqual(['SIGTERM'])
  f.close(0)
  expect(await stopping).toMatchObject({ exitObserved: true, closeObserved: true, forced: false })
})

test('already observed exit still waits for real close without a new signal', async () => {
  const f = fixture()
  f.exit(0)
  const stopping = f.lifecycle.stop(5, 5)
  expect(f.signals).toEqual([])
  f.close(0)
  expect((await stopping).method).toBe('none')
})

test('spawn error has a separate failure receipt even though no exit event exists', async () => {
  const f = fixture(null)
  f.child.emit('error', new Error('ENOENT'))
  const stopping = f.lifecycle.stop(5, 5)
  f.close(-2)
  await expect(stopping).rejects.toMatchObject({ receipt: { outcome: 'spawn-failed', spawnError: 'ENOENT', exitObserved: false, closeObserved: true } })
  expect(f.signals).toEqual([])
})

test('error after spawn is retained as signal error rather than inventing spawn failure', async () => {
  const f = fixture()
  f.child.emit('error', new Error('ESRCH'))
  const stopping = f.lifecycle.stop(5, 5)
  f.exit(); f.close()
  expect(await stopping).toMatchObject({ spawnError: null, signalErrors: ['ESRCH'] })
})

test('late close is recorded after timeout without rewriting the failed stop', async () => {
  const f = fixture()
  const stopping = f.lifecycle.stop(5, 5)
  await expect(stopping).rejects.toThrow(/未确认/)
  f.exit(1); f.close(1)
  expect(await f.lifecycle.closed).toMatchObject({ closeObserved: true, exitObserved: true, forced: true })
  expect(f.lifecycle.stop()).toBe(stopping)
  await expect(stopping).rejects.toThrow(/未确认/)
})

test('forced exit stays forced and has no business cleanup proof', async () => {
  const f = fixture()
  f.child.kill = (signal) => {
    f.signals.push(signal)
    if (signal === 'SIGKILL') { f.exit(null, 'SIGKILL'); f.close(null, 'SIGKILL') }
    return true
  }
  await expect(f.lifecycle.stop(5, 5)).rejects.toMatchObject({ receipt: { outcome: 'forced-unverified', forced: true, cleanupVerified: false, signal: 'SIGKILL' } })
  expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

test('Windows requested code 1 is unverified exit, not a permanent restart ban', async () => {
  const f = fixture()
  const stop = f.lifecycle.stop(5, 5)
  f.exit(1); f.close(1)
  expect(await stop).toMatchObject({ outcome: 'exited-unverified', exitCode: 1, forced: false })
})

test('native high exit codes and unexpected signals retain abnormal failure', async () => {
  for (const [code, signal] of [[0xC0000005, null], [-1073741819, null], [null, 'SIGABRT']] as const) {
    const f = fixture()
    const stop = f.lifecycle.stop(5, 5)
    f.exit(code, signal); f.close(code, signal)
    await expect(stop).rejects.toMatchObject({ receipt: { outcome: 'abnormal-exit', exitCode: code, signal } })
  }
})

test('ordinary natural nonzero exits fail even after a close', async () => {
  for (const code of [1, 2, 127]) {
    const f = fixture()
    f.exit(code, null); f.close(code, null)
    await expect(f.lifecycle.stop(5, 5)).rejects.toMatchObject({ receipt: { outcome: 'abnormal-exit', exitCode: code, method: 'none' } })
    expect(f.signals).toEqual([])
  }
})

test('requested SIGTERM with ordinary code 2 remains abnormal', async () => {
  const f = fixture()
  const stop = f.lifecycle.stop(5, 5)
  f.exit(2, null); f.close(2, null)
  await expect(stop).rejects.toMatchObject({ receipt: { outcome: 'abnormal-exit', exitCode: 2, method: 'SIGTERM' } })
})

test('close without exit for a spawned child cannot claim successful stop', async () => {
  const f = fixture()
  const stop = f.lifecycle.stop(5, 5)
  f.close(1)
  await expect(stop).rejects.toThrow(/未确认/)
})

test('ledger retains unclosed failed handle and blocks a new instance', async () => {
  const f = fixture()
  const ledger = new OwnedProcessLedger<OwnedProcessHandle>()
  ledger.register(f.handle, 1)
  await expect(ledger.stopAll()).rejects.toThrow(/未确认/)
  expect(ledger.unclosed()).toEqual([f.handle])
  expect(ledger.wasStopRequested(f.handle)).toBe(true)
  expect(() => ledger.assertNoUnclosed()).toThrow(/阻止启动/)
  f.exit(1); f.close(1)
  await ledger.stopAll()
  expect(ledger.unclosed()).toEqual([])
  expect(() => ledger.assertNoUnclosed()).not.toThrow()
})

test('cleanup continues for later exact handles after predecessor failure', async () => {
  const first = fixture(100)
  const second = fixture(101)
  second.child.kill = (signal) => { second.signals.push(signal); second.exit(); second.close(); return true }
  const ledger = new OwnedProcessLedger<OwnedProcessHandle>()
  ledger.register(first.handle, 1)
  await expect(ledger.stopAll()).rejects.toThrow(/未确认/)
  ledger.register(second.handle, 2)
  await expect(ledger.stopAll()).rejects.toThrow(/未确认/)
  expect(second.signals).toEqual(['SIGTERM'])
  expect(ledger.unclosed()).toEqual([first.handle])
})

test('remote/external ledger has no owned child to signal', async () => {
  const ledger = new OwnedProcessLedger<OwnedProcessHandle>()
  await ledger.stopAll()
  expect(ledger.unclosed()).toEqual([])
})

// Load the real host class with only its external dependencies substituted.
// This exercises ordering without importing Electron or creating a live engine.
function hostFixture() {
  const filename = path.resolve('src/main/engine/host.ts')
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const nativeRequire = createRequire(filename)
  const counters = { spawn: 0, migration: 0, runtime: 0, clear: 0 }
  const mocks: Record<string, unknown> = {
    '../settings-store': { getSettings: () => ({ preferredPort: 12599 }) },
    './logger': { logger: { info() {}, warn() {}, error() {} } },
    './remote-attachments': { clearRemoteAttachments() { counters.clear++ } },
    './sdk/process-lifecycle': { OwnedProcessLedger },
    './sdk/process-manager': { startProcess() { counters.spawn++; throw new Error('spawn should be blocked') } },
    './runtime': { resolveRuntime() { counters.runtime++; return null }, migrateLegacyModels() { counters.migration++ } },
    './remote-workspace': { validateRemoteWorkspaceRoot: (value: string) => value },
    './protocol': { subagentProtocolHeaders: () => ({}), engineHeaders: () => ({}) }
  }
  const mod: { exports: { EngineHost?: new () => EventEmitter } } = { exports: {} }
  const requireMock = (specifier: string): unknown => {
    if (specifier.startsWith('node:')) return nativeRequire(specifier)
    return mocks[specifier] ?? {}
  }
  const run = new vm.Script(`(function(require,module,exports){${compiled}\n})`, { filename }).runInThisContext()
  run(requireMock, mod, mod.exports)
  if (!mod.exports.EngineHost) throw new Error('Host class export missing')
  const host = new mod.exports.EngineHost() as EventEmitter & {
    stop(): Promise<{ phase: string }>
    start(mode: 'embedded' | 'remote', url?: string, workspaceRoot?: string): Promise<{ phase: string; error?: string }>
    getSnapshot(): { phase: string; error?: string; pid?: number | null; port?: number | null; mode?: string; entryPath?: string | null }
    patch(next: Record<string, unknown>): void
    ownedProcesses: OwnedProcessLedger<OwnedProcessHandle>
    handle: OwnedProcessHandle | null
    generation: number
    onProcessExit(generation: number, handle: OwnedProcessHandle, code: number | null, signal: string | null): void
  }
  return { host, counters }
}

test('host stop is single-flight and blocked restart never spawns or migrates', async () => {
  const { host, counters } = hostFixture()
  const f = fixture()
  host.handle = f.handle
  host.ownedProcesses.register(f.handle, 0)
  const first = host.stop()
  expect(host.stop()).toBe(first)
  await expect(first).rejects.toThrow(/未确认/)
  expect(host.getSnapshot()).toMatchObject({ phase: 'error', pid: 99 })
  expect(host.handle).toBe(f.handle)
  await expect(host.start('embedded')).rejects.toThrow(/阻止启动/)
  expect(counters).toMatchObject({ spawn: 0, migration: 0 })
})

test('old generation late exit cannot corrupt a newer owned handle', () => {
  const { host } = hostFixture()
  const old = fixture(100)
  const current = fixture(101)
  host.ownedProcesses.register(old.handle, 1)
  host.ownedProcesses.register(current.handle, 2)
  host.handle = current.handle
  host.generation = 2
  const snapshot = host.getSnapshot()
  host.onProcessExit(1, old.handle, 1, null)
  expect(host.handle).toBe(current.handle)
  expect(host.generation).toBe(2)
  expect(host.getSnapshot()).toBe(snapshot)
})

test('host second stop keeps the original failed promise even after late close', async () => {
  const { host } = hostFixture()
  const f = fixture()
  host.handle = f.handle
  host.ownedProcesses.register(f.handle, 0)
  const failed = host.stop()
  await expect(failed).rejects.toThrow(/未确认/)
  expect(host.stop()).toBe(failed)
  f.exit(1); f.close(1)
  const recovered = host.stop()
  expect(recovered).toBe(failed)
  expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
  await expect(failed).rejects.toThrow(/未确认/)
})

test('forced/native closed failure stays shared for rollback, then explicit start may pass close gate', async () => {
  for (const kind of ['forced', 'native']) {
    const { host, counters } = hostFixture()
    const f = fixture()
    f.child.kill = (signal) => {
      f.signals.push(signal)
      if ((kind === 'forced' && signal === 'SIGKILL') || kind === 'native') {
        const code = kind === 'native' ? 0xC0000005 : 1
        f.exit(code); f.close(code)
      }
      return true
    }
    host.handle = f.handle
    host.ownedProcesses.register(f.handle, 0)
    const failed = host.stop()
    await expect(failed).rejects.toBeInstanceOf(ProcessStopError)
    // Mirrors runtime activation's catch path: second stop must not turn the
    // failed candidate into an idle snapshot and silently proceed to rollback.
    expect(host.stop()).toBe(failed)
    await expect(host.stop()).rejects.toBeInstanceOf(ProcessStopError)
    expect(counters.runtime).toBe(0)
    const result = await host.start('embedded')
    expect(result).toMatchObject({ phase: 'error' })
    expect(result.error).toContain('未找到配套引擎运行时')
    expect(counters.runtime).toBe(1)
    await expect(failed).rejects.toBeInstanceOf(ProcessStopError)
  }
})

test('failed owned close gate preserves old mode, PID, port and runtime identity', async () => {
  const { host, counters } = hostFixture()
  const f = fixture()
  host.handle = f.handle
  host.ownedProcesses.register(f.handle, 0)
  host.patch({ mode: 'embedded', phase: 'error', pid: 99, port: 12598, entryPath: 'old-runtime.js' })
  const result = await host.start('remote', 'http://127.0.0.1:12597', 'D:/synthetic')
  expect(result).toMatchObject({ phase: 'error', mode: 'embedded', pid: 99, port: 12598, entryPath: 'old-runtime.js' })
  expect(counters.runtime).toBe(0)
  expect(counters.spawn).toBe(0)
})

test('host remote stop performs no spawn and reaches idle', async () => {
  const { host, counters } = hostFixture()
  expect(await host.stop()).toMatchObject({ phase: 'idle' })
  expect(counters.spawn).toBe(0)
})

test('process launch environment and ownership switches remain intact', () => {
  const source = readFileSync(path.resolve('src/main/engine/sdk/process-manager.ts'), 'utf8')
  expect(source).toContain('cwd: opts.cwd ?? binDir')
  expect(source).toContain('windowsHide: true')
  expect(source).toContain('detached: false')
  expect(source).toContain("stdio: ['pipe', 'pipe', 'pipe']")
  expect(source).toContain('AETHER_ENGINE_PORT: String(opts.port)')
  expect(source).toContain("AETHER_ENGINE_HOST: '127.0.0.1'")
  expect(source).toContain('...callerEnv')
  expect(source).toContain('env.AETHER_ENGINE_PROJECT_ENV = JSON.stringify')
  expect(source).toContain('SKILLS_ROOT: resolveSkillsRoot(binDir)')
})
