/** Main-process connection coordinator with the real settings file, isolated user data, and controlled host operations.
 * The host returns error snapshots just like EngineHost; no real process, network or production credential is used. */
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineMode, EngineSnapshot } from '../src/shared/ipc'

type Subject = typeof import('../src/main/engine/connection') & typeof import('../src/main/settings-store') & Pick<typeof import('../src/main/engine/runtime'), 'requireLocalRuntime'>
const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp', 'engine-management', 'local-connection-fixtures')
const requireModule = createRequire(__filename), a = 'https://remote-a.example.test/team', aRoot = '/srv/team-a'
let compiled = '', fixture = ''
function snapshot(mode: EngineMode, phase: EngineSnapshot['phase'], error: string | null = null): EngineSnapshot {
  return { mode, phase, baseUrl: phase === 'ready' ? (mode === 'remote' ? a : 'http://127.0.0.1:31229') : '', port: null, pid: null, adopted: false,
    entryPath: null, runtimeSource: null, version: null, dataDir: null, error, updatedAt: 1 }
}
function barrier() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}
function load() {
  type Start = (mode: EngineMode, url: string, root: string, signal: AbortSignal) => Promise<EngineSnapshot>
  const harness = { current: snapshot('embedded', 'idle'), hasRuntime: true, packaged: true, failWrite: false, failStop: false,
    calls: [] as string[], start: (async (mode: EngineMode) => snapshot(mode, 'ready')) as Start }
  const host = {
    get remoteWorkspaceRoot() { return aRoot }, getSnapshot: () => harness.current,
    setCheckingConnection(checking: boolean) { harness.calls.push('checking:' + checking); harness.current = { ...harness.current, checkingConnection: checking } },
    async stop() {
      harness.calls.push('stop')
      if (harness.failStop) throw new Error('could not confirm old stop')
      return harness.current = snapshot(harness.current.mode, 'idle')
    },
    async start(mode: EngineMode, url: string, directory: string, _retry: boolean, _proof: unknown, signal: AbortSignal) {
      harness.calls.push('start:' + mode); signal.throwIfAborted()
      harness.current = snapshot(mode, 'starting')
      const result = await harness.start(mode, url, directory, signal)
      signal.throwIfAborted()
      return harness.current = result
    }
  }
  const ports = { host, requireRuntime() { harness.calls.push('check-local'); if (!harness.hasRuntime) throw new Error('no local package') },
    async probe() { harness.calls.push('remote-probe'); throw new Error('no remote probe expected') } }
  const electron = { app: { get isPackaged() { return harness.packaged }, getPath: () => fixture, getAppPath: () => join(fixture, 'app') } }
  const synthetic = Object.create(process) as NodeJS.Process
  Object.defineProperties(synthetic, { env: { value: {} }, resourcesPath: { value: join(fixture, 'resources') }, platform: { value: 'win32' }, arch: { value: 'x64' } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'ports', 'process', compiled)(
    (name: string) => name === 'electron' ? electron : name === 'node:fs' ? { ...requireModule(name), renameSync(from: string, to: string) {
      if (harness.failWrite && to === join(fixture, 'settings.json')) throw new Error('settings write refused')
      return requireModule(name).renameSync(from, to)
    } } : requireModule(name), module, module.exports, ports, synthetic)
  return { subject: module.exports as Subject, harness }
}
function remoteBaseline() {
  const { subject, harness } = load()
  subject.updateSettings({ engineMode: 'remote', remoteBaseUrl: a, preferredPort: 12327, autoStartEngine: true })
  subject.updateSettings({ remoteWorkspaceRoot: aRoot })
  harness.current = snapshot('remote', 'ready')
  const local = subject.connectionInputForSettings(subject.getSettings(), { engineMode: 'embedded', autoStartEngine: false, preferredPort: 32101 })
  return { subject, harness, local }
}

test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true })
  const result = await build({ stdin: { contents: `export * from './src/main/engine/connection'; export * from './src/main/settings-store'; export { requireLocalRuntime } from './src/main/engine/runtime';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], write: false,
    plugins: [{ name: 'controlled-host', setup(builder) {
      builder.onResolve({ filter: /^\.\/(host|runtime|remote-probe)$/ }, args => /[\\/]engine[\\/]connection\.ts$/.test(args.importer) ? { path: args.path, namespace: 'connection-ports' } : undefined)
      const modules: Record<string, string> = { './host': 'export const engineHost = ports.host', './runtime': 'export const requireLocalRuntime = ports.requireRuntime', './remote-probe': 'export const probeRemoteConnection = ports.probe' }
      builder.onLoad({ filter: /.*/, namespace: 'connection-ports' }, args => ({ contents: modules[args.path] }))
    }}] })
  compiled = result.outputFiles[0].text
})
test.beforeEach(() => { fixture = mkdtempSync(join(fixtures, 'profile-')) })
test.afterEach(() => {
  if (dirname(fixture) !== fixtures || !basename(fixture).startsWith('profile-')) throw new Error('Unsafe local connection fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

for (const mode of ['embedded', 'remote'] as const) test(`changing only automatic startup preserves idle, error, and ready ${mode} connections`, async () => {
  const { subject, harness } = load(), url = mode === 'remote' ? a + '///' : ''
  subject.updateSettings({ engineMode: mode, remoteBaseUrl: url, autoStartEngine: true })
  harness.hasRuntime = false
  for (const phase of ['idle', 'error', 'ready'] as const) {
    const original = snapshot(mode, phase, phase === 'error' ? 'previous failure' : null)
    harness.current = original
    const enabled = !subject.getSettings().autoStartEngine
    const input = subject.connectionInputForSettings(subject.getSettings(), { autoStartEngine: enabled, remoteBaseUrl: mode === 'remote' ? a : '' })
    expect(await subject.applyEngineConnection(input)).toBe(original)
    expect(harness.current).toBe(original)
    expect(load().subject.getSettings()).toMatchObject({ engineMode: mode, remoteBaseUrl: url, autoStartEngine: enabled })
  }
  expect(harness.calls).toEqual([])
})

test('a separate start still validates the package, and a missing candidate does not retire remote A', async () => {
  const { subject, harness, local } = remoteBaseline()
  const original = readFileSync(join(fixture, 'settings.json'))
  harness.hasRuntime = false
  await expect(subject.applyEngineConnection(local)).rejects.toThrow('no local package')
  expect(harness.current).toMatchObject({ phase: 'ready', mode: 'remote', baseUrl: a })
  expect(harness.calls).toEqual(['checking:true', 'check-local', 'checking:false'])
  expect(readFileSync(join(fixture, 'settings.json'))).toEqual(original)
  harness.hasRuntime = true
  await expect(subject.applyEngineConnection(local)).resolves.toMatchObject({ phase: 'ready', mode: 'embedded' })
  expect(subject.getSettings()).toMatchObject({ engineMode: 'embedded', autoStartEngine: false, preferredPort: 32101 })
})

test('a failed local launch restores A, reports the local failure, and leaves unrelated concurrent edits in place', async () => {
  const { subject, harness, local } = remoteBaseline()
  harness.start = async (mode, url, directory) => {
    if (mode === 'embedded') {
      expect(subject.getSettings()).toMatchObject({ engineMode: 'embedded', preferredPort: 32101, autoStartEngine: false })
      subject.updateSettings({ lastFolder: '/unrelated-preference' })
      return snapshot('embedded', 'error', 'local handshake failed')
    }
    expect([url, directory]).toEqual([a, aRoot]); return snapshot('remote', 'ready')
  }
  await expect(subject.applyEngineConnection(local)).rejects.toThrow(/本机引擎启动失败：local handshake failed。已重新连接原服务/)
  expect(harness.current).toMatchObject({ mode: 'remote', phase: 'ready', baseUrl: a, checkingConnection: false })
  expect(load().subject.getSettings()).toMatchObject({ engineMode: 'remote', remoteBaseUrl: a, remoteWorkspaceRoot: aRoot, preferredPort: 12327, autoStartEngine: true, lastFolder: '/unrelated-preference' })
  expect(harness.calls.filter(call => /^(start|stop)/.test(call))).toEqual(['stop', 'start:embedded', 'start:remote'])
})

test('a failed restoration reports both causes and keeps A selected for a manual retry', async () => {
  const { subject, harness, local } = remoteBaseline()
  harness.start = async mode => { if (mode === 'embedded') throw new Error('local child could not launch'); return snapshot('remote', 'error', 'remote A is offline') }
  await expect(subject.applyEngineConnection(local)).rejects.toThrow(/本机引擎启动失败：local child could not launch。原服务设置已恢复，但重新连接未成功：remote A is offline/)
  expect(harness.current).toMatchObject({ mode: 'remote', phase: 'error' })
  expect(load().subject.getSettings().engineMode).toBe('remote')
})

test('a settings rollback write failure is explicit and does not start A against selected local settings', async () => {
  const { subject, harness, local } = remoteBaseline()
  harness.start = async () => { harness.failWrite = true; return snapshot('embedded', 'error', 'local failed') }
  await expect(subject.applyEngineConnection(local)).rejects.toThrow(/local failed；未能恢复原服务设置：settings write refused/)
  expect(harness.calls).not.toContain('start:remote')
  expect(load().subject.getSettings().engineMode).toBe('embedded')
})

test('failure to confirm stopping A reports that failure and does not launch a second host', async () => {
  const { subject, harness, local } = remoteBaseline()
  harness.failStop = true
  await expect(subject.applyEngineConnection(local)).rejects.toThrow(/原服务未能正常断开：could not confirm old stop。原服务设置已恢复/)
  expect(harness.calls.filter(call => call.startsWith('start:'))).toEqual([])
  expect(load().subject.getSettings().engineMode).toBe('remote')
})

for (const pause of ['embedded', 'remote'] as const) test(`explicit stop during ${pause === 'embedded' ? 'local startup' : 'recovery of A'} wins even if a late start completes`, async () => {
  const { subject, harness, local } = remoteBaseline(), entered = barrier(), late = barrier()
  harness.start = async (mode, _url, _root, signal) => {
    if (mode === pause) { entered.release(); await late.wait; expect(signal.aborted).toBe(true) }
    return mode === 'embedded' ? snapshot('embedded', 'error', 'local failed') : snapshot('remote', 'ready')
  }
  const rejected = expect(subject.applyEngineConnection(local)).rejects.toThrow('已取消连接')
  await entered.wait
  try { await expect(subject.stopEngineConnection()).resolves.toMatchObject({ phase: 'idle' }) } finally { late.release() }
  await rejected
  expect(harness.current.phase).toBe('idle')
  expect(harness.calls.filter(c => c === 'start:remote')).toHaveLength(pause === 'remote' ? 1 : 0)
  expect(harness.calls.filter(c => c === 'stop')).toHaveLength(2)
  expect(load().subject.getSettings().engineMode).toBe(pause)
})

test('first-run repair offers package import only when the installed Windows client includes its trusted Node', () => {
  const { subject, harness } = load()
  expect(() => subject.requireLocalRuntime()).toThrow(/完整 Aether 客户端.*连接其他引擎/)
  expect(() => subject.requireLocalRuntime()).not.toThrow(/AETHER_IDE_ENGINE_ENTRY|\.tgz/)
  const binary = join(fixture, 'resources', 'engine', 'win32-x64', 'runtime', 'node.exe')
  mkdirSync(dirname(binary), { recursive: true }); writeFileSync(binary, 'fixture present; never executed')
  expect(() => subject.requireLocalRuntime()).toThrow(/高级设置.*导入并选用.*\.tgz/)
  harness.packaged = false
  expect(() => subject.requireLocalRuntime()).toThrow(/开发版.*AETHER_IDE_ENGINE_ENTRY/)
})
