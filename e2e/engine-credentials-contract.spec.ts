/** Engine credential boundaries with isolated files and mocked OS encryption.
 * Covers destination binding, migration/restart safety, transactional saves,
 * environment authority and HTTP trust without starting an app or engine. */
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

type Subject = typeof import('../src/main/engine/remote-token') & typeof import('../src/main/engine/remote-auth') &
  typeof import('../src/main/account/transport-trust') & typeof import('../src/main/settings-store') &
  Pick<typeof import('../src/main/engine/connection'), 'connectionInputForSettings'>
const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp', 'engine-credentials', 'fixtures')
const requireModule = createRequire(__filename)
const first = 'https://first.example.test/engine', second = 'https://second.example.test/engine'
let compiled = '', fixture = ''
const encrypted = (value: string) => Buffer.from('test-encrypted:' + value).toString('base64')
const legacyPath = () => join(fixture, 'engine', 'secrets', 'remote-instance-token.json')
const tokenPath = (url: string) => join(fixture, 'engine', 'secrets', `remote-instance-token-${createHash('sha256').update(url).digest('hex')}.json`)

function loadSubject(env: Record<string, string | undefined> = {}) {
  const harness = { encryption: true, backend: 'test-encrypted', reads: [] as string[], failSettingsRename: false }
  const electron = {
    app: { getPath: () => fixture },
    safeStorage: {
      isEncryptionAvailable: () => harness.encryption, getSelectedStorageBackend: () => harness.backend,
      encryptString: (value: string) => Buffer.from('test-encrypted:' + value),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^test-encrypted:/, '')
    }
  }
  const module = { exports: {} }
  const syntheticProcess = Object.create(process) as NodeJS.Process
  syntheticProcess.env = { ...env }
  new Function('require', 'module', 'exports', 'process', compiled)(
    (name: string) => name === 'electron' ? electron : name === 'node:fs'
      ? { ...requireModule(name), readFileSync: (path: string, ...args: unknown[]) => {
        harness.reads.push(String(path)); return requireModule(name).readFileSync(path, ...args)
      }, renameSync: (from: string, to: string) => {
        if (harness.failSettingsRename && to === join(fixture, 'settings.json')) throw new Error('simulated settings rename failure')
        return requireModule(name).renameSync(from, to)
      } }
      : requireModule(name), module, module.exports, syntheticProcess)
  return { subject: module.exports as Subject, harness, env: syntheticProcess.env }
}
function writeLegacy(value = 'legacy-instance-token', target?: string | null): void {
  mkdirSync(dirname(legacyPath()), { recursive: true })
  writeFileSync(legacyPath(), JSON.stringify({ version: target === undefined ? 1 : 2,
    ...(target === undefined ? {} : { target }), encrypted: true, value: encrypted(value) }))
}

test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true })
  const result = await build({ stdin: { contents: `export * from './src/main/engine/remote-token.ts'; export * from './src/main/engine/remote-auth.ts'; export * from './src/main/account/transport-trust.ts'; export * from './src/main/settings-store.ts'; export { connectionInputForSettings } from './src/main/engine/connection.ts';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], write: false })
  compiled = result.outputFiles[0].text
})
test.beforeEach(() => { fixture = mkdtempSync(join(fixtures, 'fixture-')) })
test.afterEach(() => {
  if (dirname(fixture) !== fixtures || !basename(fixture).startsWith('fixture-')) throw new Error('Unsafe engine credentials fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

test('instance tokens are isolated by normalized service including port and path', () => {
  const { subject } = loadSubject()
  subject.setRemoteInstanceToken(first + '///', 'first-token')
  subject.setRemoteInstanceToken(second, 'second-token')
  expect(subject.getRemoteInstanceToken(first)).toBe('first-token')
  expect(subject.getRemoteInstanceToken(second)).toBe('second-token')
  expect(subject.getRemoteInstanceToken(first + '/other')).toBe('')
  expect(subject.getRemoteInstanceToken('https://first.example.test:444/engine')).toBe('')
  subject.clearRemoteInstanceToken(first)
  expect(subject.remoteInstanceTokenConfigured(first)).toBe(false)
  expect(subject.getRemoteInstanceToken(second)).toBe('second-token')
  expect(() => subject.setRemoteInstanceToken(first + '?token=invalid', 'secret')).toThrow('远端地址')
})

test('legacy migration binds only the saved startup destination, never a new draft or restart target', () => {
  writeLegacy()
  const { subject } = loadSubject()
  expect(subject.getRemoteInstanceToken(second)).toBe('')
  expect(subject.getRemoteInstanceToken(first)).toBe('')
  subject.initializeRemoteInstanceTokens(first + '/')
  subject.initializeRemoteInstanceTokens(second)
  expect(subject.getRemoteInstanceToken(first)).toBe('legacy-instance-token')
  expect(subject.getRemoteInstanceToken(second)).toBe('')
  expect(existsSync(legacyPath())).toBe(false)
  const restarted = loadSubject().subject
  restarted.initializeRemoteInstanceTokens(second)
  expect(restarted.getRemoteInstanceToken(first)).toBe('legacy-instance-token')
  expect(restarted.getRemoteInstanceToken(second)).toBe('')
})

test('an interrupted migration retains its original target and never replaces a newer scoped token', () => {
  writeLegacy('old-token', first)
  const { subject } = loadSubject()
  subject.setRemoteInstanceToken(first, 'new-token')
  subject.initializeRemoteInstanceTokens(second)
  expect(subject.getRemoteInstanceToken(first)).toBe('new-token')
  expect(subject.getRemoteInstanceToken(second)).toBe('')
  expect(existsSync(legacyPath())).toBe(false)
})

test('legacy data without a valid saved URL remains unbound across restarts', () => {
  writeLegacy()
  loadSubject().subject.initializeRemoteInstanceTokens('')
  expect(JSON.parse(readFileSync(legacyPath(), 'utf8'))).toMatchObject({ version: 2, target: null })
  const restarted = loadSubject().subject
  restarted.initializeRemoteInstanceTokens(second)
  expect(restarted.getRemoteInstanceToken(second)).toBe('')
  expect(existsSync(legacyPath())).toBe(true)
})

test('environment token authority is frozen to the initial saved URL', () => {
  const { subject, env } = loadSubject({ AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'initial-env-token' })
  expect(subject.getEnvironmentRemoteInstanceToken(first)).toBe('')
  subject.initializeRemoteInstanceTokens(first)
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = 'changed-env-token'
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL = second
  subject.initializeRemoteInstanceTokens(second)
  expect(subject.getEnvironmentRemoteInstanceToken(first + '/')).toBe('initial-env-token')
  expect(subject.getEnvironmentRemoteInstanceToken(second)).toBe('')
})

test('an implicit environment token never follows edited preferences on the next launch', () => {
  const env = { AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'original-environment-token' }
  loadSubject(env).subject.initializeRemoteInstanceTokens(first)
  const restarted = loadSubject(env).subject
  restarted.initializeRemoteInstanceTokens(second)
  expect(restarted.getEnvironmentRemoteInstanceToken(second)).toBe('')
  expect(restarted.getEnvironmentRemoteInstanceToken(first)).toBe(env.AETHER_IDE_REMOTE_INSTANCE_TOKEN)
  const binding = readFileSync(join(dirname(legacyPath()), 'environment-instance-target.json'), 'utf8')
  expect(binding).not.toContain(env.AETHER_IDE_REMOTE_INSTANCE_TOKEN)
})

test('a malformed legacy envelope remains recoverable and cannot follow a new target', () => {
  writeLegacy()
  writeFileSync(legacyPath(), '{broken')
  const { subject } = loadSubject()
  expect(() => subject.initializeRemoteInstanceTokens(first)).toThrow('原文件已保留')
  expect(() => subject.assertRemoteTokenTargetChange(second)).not.toThrow()
  expect(subject.getRemoteInstanceToken(second)).toBe('')
  expect(readFileSync(legacyPath(), 'utf8')).toBe('{broken')
})

test('explicit environment token URL overrides startup URL and invalid or absent targets fail closed', () => {
  const explicit = loadSubject({ AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'explicit-token', AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL: second }).subject
  explicit.initializeRemoteInstanceTokens(first)
  expect(explicit.getEnvironmentRemoteInstanceToken(first)).toBe('')
  expect(explicit.getEnvironmentRemoteInstanceToken(second)).toBe('explicit-token')
  const invalid = loadSubject({ AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'invalid-target-token', AETHER_IDE_REMOTE_INSTANCE_TOKEN_URL: 'invalid' }).subject
  invalid.initializeRemoteInstanceTokens(first)
  expect(invalid.getEnvironmentRemoteInstanceToken(first)).toBe('')
  const unbound = loadSubject({ AETHER_IDE_REMOTE_INSTANCE_TOKEN: 'unbound-token' }).subject
  unbound.initializeRemoteInstanceTokens('')
  unbound.initializeRemoteInstanceTokens(first)
  expect(unbound.getEnvironmentRemoteInstanceToken(first)).toBe('')
})

test('failed combined saves restore exact encrypted bytes for update, clear and creation', () => {
  const { subject } = loadSubject()
  subject.setRemoteInstanceToken(first, 'previous-token')
  const previous = readFileSync(tokenPath(first))
  const failSave = () => { throw new Error('settings-write-failed') }
  expect(() => subject.withRemoteInstanceTokenChange(first, 'replacement-token', failSave)).toThrow('settings-write-failed')
  expect(readFileSync(tokenPath(first))).toEqual(previous)
  expect(() => subject.withRemoteInstanceTokenChange(first, '', failSave)).toThrow('settings-write-failed')
  expect(subject.getRemoteInstanceToken(first)).toBe('previous-token')
  expect(() => subject.withRemoteInstanceTokenChange(second, 'new-token', failSave)).toThrow('settings-write-failed')
  expect(existsSync(tokenPath(second))).toBe(false)
  expect(readdirSync(dirname(tokenPath(first))).some(file => file.endsWith('.tmp'))).toBe(false)
})

test('tampered destination metadata and unavailable OS encryption never expose or overwrite tokens', () => {
  const { subject, harness } = loadSubject()
  subject.setRemoteInstanceToken(first, 'original-token')
  const original = readFileSync(tokenPath(first))
  harness.encryption = false
  expect(() => subject.getRemoteInstanceToken(first)).toThrow('系统密钥')
  expect(() => subject.setRemoteInstanceToken(first, 'replacement')).toThrow('系统密钥')
  expect(readFileSync(tokenPath(first))).toEqual(original)
  harness.encryption = true
  harness.backend = 'basic_text'
  expect(() => subject.setRemoteInstanceToken(first, 'replacement')).toThrow('系统密钥')
  const tampered = { ...JSON.parse(original.toString()), target: second }
  writeFileSync(tokenPath(first), JSON.stringify(tampered))
  expect(() => subject.getRemoteInstanceToken(first)).toThrow('绑定地址')
})

test('advanced credentials retain exact URL binding and transactional rollback', () => {
  const { subject } = loadSubject({ AETHER_IDE_REMOTE_AUTH_URL: first, AETHER_IDE_REMOTE_API_KEY: 'environment-api-key' })
  expect(subject.getRemoteAuth(first)).toMatchObject({ source: 'environment', credential: { value: 'environment-api-key' } })
  expect(subject.getRemoteAuth(second)).toEqual({ source: 'none', credential: null })
  subject.withRemoteAuthChange(first, { type: 'bearer', value: 'stored-bearer' }, () => undefined)
  expect(subject.getRemoteAuth(first)).toMatchObject({ source: 'stored', credential: { value: 'stored-bearer' } })
  expect(() => subject.withRemoteAuthChange(first, { type: 'api-key', value: 'replacement' }, () => { throw new Error('failed') })).toThrow('failed')
  expect(subject.getRemoteAuth(first).credential?.value).toBe('stored-bearer')
  expect(subject.getRemoteAuth(second).credential).toBeNull()
})

test('all credential classes require exact HTTP service trust and revocation applies immediately', () => {
  const { subject } = loadSubject(), http = 'http://service.example.test:8080/engine'
  expect(() => subject.assertTrustedCredentialTransport(http)).toThrow(subject.CredentialTransportError)
  try { subject.assertTrustedCredentialTransport(http) } catch (error) {
    expect(error).toMatchObject({ code: 'http-trust-required' })
  }
  expect(() => subject.assertTrustedCredentialTransport(http, false)).not.toThrow()
  subject.saveHttpTrust(http + '/', true)
  expect(() => subject.assertTrustedCredentialTransport(http)).not.toThrow()
  expect(() => subject.assertTrustedCredentialTransport(http + '/other')).toThrow(subject.CredentialTransportError)
  expect(() => subject.assertTrustedCredentialTransport('http://service.example.test:8081/engine')).toThrow(subject.CredentialTransportError)
  subject.saveHttpTrust(http, false)
  expect(() => subject.assertTrustedCredentialTransport(http)).toThrow(subject.CredentialTransportError)
})

test('HTTPS and loopback credential checks avoid trust-file reads', () => {
  const { subject, harness } = loadSubject()
  for (const url of [first, 'http://localhost:12323', 'http://127.0.0.1:12323', 'http://[::1]:12323']) {
    for (let index = 0; index < 20; index++) subject.assertTrustedCredentialTransport(url)
  }
  expect(harness.reads).toEqual([])
})

test('workspace roots belong to their saved service through selection, restart, and explicit clearing', () => {
  const file = join(fixture, 'settings.json'), a = '/srv/team-a', b = '/srv/team-b'
  writeFileSync(file, JSON.stringify({ engineMode: 'remote', remoteBaseUrl: first + '///', remoteWorkspaceRoot: a }))
  const { subject } = loadSubject(), initial = subject.getSettings()
  expect(initial.remoteWorkspaceRoot).toBe(a)
  expect(initial).not.toHaveProperty('remoteWorkspaceRoots')
  const change = subject.connectionInputForSettings(initial, { remoteBaseUrl: second })
  expect(change).not.toHaveProperty('remoteWorkspaceRoot')
  for (const url of [second, first + '/other', 'https://first.example.test:444/engine', 'http://first.example.test/engine']) {
    expect(subject.workspaceRootForConnection('remote', url, a)).toBe('')
  }
  // An older renderer may include A's root in the submitted preferences for B.
  expect(subject.updateSettings({ ...change, remoteWorkspaceRoot: a }).remoteWorkspaceRoot).toBe('')
  expect(subject.workspaceRootForConnection('remote', first)).toBe(a)
  const explicit = subject.connectionInputForSettings(subject.getSettings(), { remoteWorkspaceRoot: '  ' + b + '  ' })
  expect(subject.updateSettings(explicit).remoteWorkspaceRoot).toBe(b)
  expect(subject.updateSettings({ autoStartEngine: false }).remoteWorkspaceRoot).toBe(b)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  expect(stored.remoteWorkspaceRoots).toEqual({ [first]: a, [second]: b })
  expect(stored).not.toHaveProperty('remoteWorkspaceRoot')
  const restarted = loadSubject().subject
  expect(restarted.getSettings().remoteWorkspaceRoot).toBe(b)
  expect(restarted.updateSettings({ ...restarted.getSettings(), remoteBaseUrl: first + '/' }).remoteWorkspaceRoot).toBe(a)
  expect(restarted.updateSettings({ engineMode: 'embedded', remoteWorkspaceRoot: a }).remoteWorkspaceRoot).toBe('')
  expect(restarted.updateSettings({ engineMode: 'remote', remoteBaseUrl: second + '/' }).remoteWorkspaceRoot).toBe(b)
  expect(restarted.updateSettings({ remoteWorkspaceRoot: '' }).remoteWorkspaceRoot).toBe('')
  expect(restarted.getSettings()).not.toHaveProperty('remoteWorkspaceRoots')
  expect(loadSubject().subject.workspaceRootForConnection('remote', first)).toBe(a)
  expect(JSON.parse(readFileSync(file, 'utf8')).remoteWorkspaceRoots).toEqual({ [first]: a })
})

test('orphaned legacy roots and a stale scalar next to a directory table never become defaults', () => {
  const file = join(fixture, 'settings.json')
  for (const remoteBaseUrl of [undefined, 'invalid', first + '?secret=x']) {
    writeFileSync(file, JSON.stringify({ engineMode: 'remote', remoteBaseUrl, remoteWorkspaceRoot: '/orphan' }))
    const { subject } = loadSubject()
    expect(subject.getSettings().remoteWorkspaceRoot).toBe('')
    expect(subject.updateSettings({ engineMode: 'remote', remoteBaseUrl: second }).remoteWorkspaceRoot).toBe('')
  }
  writeFileSync(file, JSON.stringify({ engineMode: 'remote', remoteBaseUrl: first, remoteWorkspaceRoot: '/stale',
    remoteWorkspaceRoots: { [first]: 'relative/path', [second + '/']: '/b', 'invalid': '/ignored' } }))
  const { subject } = loadSubject()
  expect(subject.getSettings().remoteWorkspaceRoot).toBe('')
  expect(subject.updateSettings({ remoteBaseUrl: second }).remoteWorkspaceRoot).toBe('/b')
  expect(() => subject.updateSettings({ remoteWorkspaceRoot: 'relative/path' })).toThrow('绝对路径')
  expect(JSON.parse(readFileSync(file, 'utf8')).remoteWorkspaceRoots).toEqual({ [second]: '/b' })
})

test('failed directory writes preserve the selected service and both workspace roots in memory and after restart', () => {
  const { subject, harness } = loadSubject(), file = join(fixture, 'settings.json')
  subject.updateSettings({ engineMode: 'remote', remoteBaseUrl: first })
  subject.updateSettings({ remoteWorkspaceRoot: '/a' })
  subject.updateSettings({ remoteBaseUrl: second })
  subject.updateSettings({ remoteWorkspaceRoot: '/b' })
  subject.updateSettings({ remoteBaseUrl: first })
  const before = readFileSync(file)
  harness.failSettingsRename = true
  for (const patch of [{ remoteWorkspaceRoot: '/wrong' }, { remoteWorkspaceRoot: '' }, { remoteBaseUrl: second }]) {
    expect(() => subject.updateSettings(patch)).toThrow('simulated settings rename failure')
    expect(subject.getSettings()).toMatchObject({ remoteBaseUrl: first, remoteWorkspaceRoot: '/a' })
    expect(subject.workspaceRootForConnection('remote', second)).toBe('/b')
    expect(readFileSync(file)).toEqual(before)
  }
  expect(readdirSync(fixture).filter(name => name.endsWith('.tmp'))).toEqual([])
  const restarted = loadSubject().subject
  expect(restarted.getSettings()).toMatchObject({ remoteBaseUrl: first, remoteWorkspaceRoot: '/a' })
  expect(restarted.updateSettings({ remoteBaseUrl: second }).remoteWorkspaceRoot).toBe('/b')
})
