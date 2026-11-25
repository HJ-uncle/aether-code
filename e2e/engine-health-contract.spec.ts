/** Engine health probe contracts with a bundled EngineHost and controlled fetch.
 * No real Electron window, engine process, network or credentials are used. */
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

type Subject = typeof import('../src/main/engine/host')
const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp', 'engine-health-contract')
const requireModule = createRequire(__filename)
const origin = 'http://engine-health.fixture'
const buildId = 'sha256:' + 'a'.repeat(64)
let compiled = ''
let fixture = ''

function loadSubject() {
  const harness = {
    mode: 'fail-health' as 'fail-health' | 'fail-meta' | 'ok',
    calls: [] as string[]
  }
  const electron = {
    app: { getPath: () => fixture },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'test-encrypted',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf8')
    }
  }
  const syntheticFetch = async (url: string): Promise<Response> => {
    const path = new URL(url).pathname
    harness.calls.push(path)
    if (harness.mode === 'fail-health') throw new Error('synthetic health timeout')
    if (path === '/health') return Response.json({ code: 200, data: { status: 'ok' } })
    if (path === '/meta' && harness.mode === 'fail-meta') throw new Error('synthetic metadata timeout')
    if (path === '/meta') return Response.json({ code: 200, data: {
      version: '2.0.0', buildId, protocolVersion: 1,
      toolProfiles: ['general'], subagentSchemaVersion: 1,
      instanceId: 'health-instance'
    } })
    throw new Error('Unexpected health probe path: ' + path)
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'fetch', 'setInterval', compiled)(
    (name: string) => name === 'electron' ? electron : requireModule(name),
    module,
    module.exports,
    syntheticFetch,
    () => ({ unref() {} })
  )
  const subject = module.exports as Subject
  return { subject, harness }
}

function readyHost(subject: Subject): InstanceType<Subject['EngineHost']> {
  const host = new subject.EngineHost()
  Object.assign(host, {
    snapshot: {
      ...host.getSnapshot(), mode: 'embedded', phase: 'ready', baseUrl: origin,
      instanceId: 'health-instance', buildId, accountId: null
    },
    generation: 0,
    transportController: new AbortController()
  })
  return host
}

test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true })
  const result = await build({
    stdin: {
      contents: `export * from './src/main/engine/host.ts'`,
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'ws'],
    write: false
  })
  compiled = result.outputFiles[0].text
})

test.beforeEach(() => { fixture = mkdtempSync(join(fixtures, 'fixture-')) })
test.afterEach(() => {
  if (dirname(fixture) !== fixtures || !basename(fixture).startsWith('fixture-')) throw new Error('Unsafe health fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

test('three consecutive probe failures enter the terminal local error state', async () => {
  const { subject, harness } = loadSubject()
  const host = readyHost(subject)
  const checkHealth = (host as unknown as { checkHealth: () => Promise<void> }).checkHealth.bind(host)

  await checkHealth(); expect(host.getHealthDiagnostics()).toMatchObject({ consecutiveFailures: 1 })
  await checkHealth(); expect(host.getHealthDiagnostics()).toMatchObject({ consecutiveFailures: 2 })
  await checkHealth()

  expect(harness.calls).toEqual(['/health', '/health', '/health'])
  expect(host.getSnapshot()).toMatchObject({
    phase: 'error',
    baseUrl: origin,
    error: '引擎暂时失去响应（连续 3 次检查失败），正在自动恢复'
  })
  expect(host.getHealthDiagnostics()).toMatchObject({ consecutiveFailures: 3 })

  harness.mode = 'ok'
  await checkHealth()
  expect(host.getSnapshot()).toMatchObject({ phase: 'ready', baseUrl: origin, error: null })
  expect(host.getHealthDiagnostics()).toMatchObject({ consecutiveFailures: 0 })
})

test('a successful health and metadata probe clears transient failures', async () => {
  const { subject, harness } = loadSubject()
  const host = readyHost(subject)
  const checkHealth = (host as unknown as { checkHealth: () => Promise<void> }).checkHealth.bind(host)

  await checkHealth(); await checkHealth()
  expect(host.getHealthDiagnostics().consecutiveFailures).toBe(2)
  harness.mode = 'ok'
  await checkHealth()

  expect(harness.calls).toEqual(['/health', '/health', '/health', '/meta'])
  expect(host.getSnapshot()).toMatchObject({ phase: 'ready', baseUrl: origin })
  expect(host.getHealthDiagnostics()).toMatchObject({ consecutiveFailures: 0 })
  expect(host.getHealthDiagnostics().lastSuccessAt).toEqual(expect.any(Number))
})




