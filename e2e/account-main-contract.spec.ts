/** Main-process account contracts with real isolated files and mocked Electron
 * dialogs/OS encryption. No app, production credentials or external network. */
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AccountCredential } from '../src/main/account/credential-store'
import type { AccountState, AccountUser } from '../src/shared/account'

type Subject = typeof import('../src/main/account/service') & typeof import('../src/main/account/credential-store') & typeof import('../src/main/engine/remote-auth') & typeof import('../src/main/engine/host') & typeof import('../src/renderer/src/core/engine/source') & typeof import('../src/main/browser-bridge') & typeof import('../src/main/browser/native-host-manager') & typeof import('../src/main/account/transport-trust') & typeof import('../src/main/engine/remote-probe') & typeof import('../src/main/terminal/remote-terminal')
const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp', 'account-simplify', 'main-contract')
const requireModule = createRequire(__filename)
const endpoint = 'https://account.example.test/engine', otherEndpoint = 'https://account.example.test/other-engine'
let compiled = '', fixture = ''
const user = (): AccountUser => ({ id: 'user-a', tenantId: 'tenant-a', name: 'Test', email: null, avatarUrl: null, bio: null,
  userData: {}, createdAt: new Date(0).toISOString(), identities: [], sessionId: 'session-a', authenticatedAt: new Date(0).toISOString(), roles: ['tenant-admin'] })
const credential = (): AccountCredential => ({ user: user(), accessToken: 'aether_session_synthetic_1234567890',
  refreshToken: 'aether_refresh_synthetic_1234567890', expiresAt: new Date(Date.now() + 900_000).toISOString(),
  recoveryKey: 'aether_recovery_' + 'a'.repeat(43), exportedAt: '2026-11-01T00:00:00.000Z' })

function loadSubject() {
  const calls: Array<{ path: string; method: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> }> = []
  const changes: AccountState[] = []
  const harness = {
    clipboard: '', failEncryption: false, identityChanges: 0, cleanup: 0, dialogs: 0, sockets: 0, openedUrls: [] as string[],
    target: { scope: endpoint, url: endpoint, headers: {} },
    picked: { canceled: false, filePath: join(fixture, 'recovery.json') },
    respond: async (_path: string, _body: Record<string, unknown>, _init: RequestInit): Promise<unknown> => { throw new Error('Unexpected network request') }
  }
  const electron = {
    app: { getPath: () => fixture },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-encrypted',
      encryptString: (value: string) => { if (harness.failEncryption) throw new Error('Synthetic secure storage unavailable'); return Buffer.from('synthetic-encryption:' + value) },
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^synthetic-encryption:/, '') },
    clipboard: { writeText: (value: string) => { harness.clipboard = value }, readText: () => harness.clipboard, clear: () => { harness.clipboard = '' } },
    dialog: { showSaveDialog: async () => { harness.dialogs++; return harness.picked } },
    shell: { openExternal: async (url: string) => { harness.openedUrls.push(url) } }
  }
  const module = { exports: {} }
  const syntheticFetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/engine/auth/account', '').replace('/engine/api/v1', '')
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    calls.push({ path, method: init.method ?? 'GET', authorization: new Headers(init.headers).get('Authorization'), apiKey: new Headers(init.headers).get('X-API-Key'), body })
    const data = await harness.respond(path, body, init)
    if (data instanceof Response) return data
    return new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  new Function('require', 'module', 'exports', 'fetch', 'setInterval', compiled)(
    (name: string) => name === 'electron' ? electron : name === 'ws' ? class { constructor() { harness.sockets++; throw new Error('Unexpected network socket') } } : requireModule(name), module, module.exports, syntheticFetch, () => ({ unref() {} }))
  const subject = module.exports as Subject
  subject.configureAccountService({ target: () => harness.target, identityChanged: async () => { harness.identityChanges++ },
    beforeIdentityChange: async () => { harness.cleanup++; return null }, changed: state => changes.push(state) })
  return { subject, harness, calls, changes }
}

test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true })
  const result = await build({ stdin: { contents: `export * from './src/main/account/service.ts'; export * from './src/main/account/credential-store.ts'; export * from './src/main/engine/remote-auth.ts'; export * from './src/main/engine/host.ts'; export * from './src/renderer/src/core/engine/source.ts'; export * from './src/main/browser-bridge.ts'; export * from './src/main/browser/native-host-manager.ts'; export * from './src/main/account/transport-trust.ts'; export * from './src/main/engine/remote-probe.ts'; export * from './src/main/terminal/remote-terminal.ts';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'ws'], write: false })
  compiled = result.outputFiles[0].text
})
test.beforeEach(() => { fixture = mkdtempSync(join(fixtures, 'fixture-')) })
test.afterEach(() => {
  if (dirname(fixture) !== fixtures || !basename(fixture).startsWith('fixture-')) throw new Error('Unsafe account fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

test('recovery export only saves the existing key and publishes backup metadata, never a credential', async () => {
  const { subject, harness, calls, changes } = loadSubject(), saved = credential()
  saved.exportedAt = null
  subject.saveAccountCredential(endpoint, saved)
  expect(await subject.accountService.exportRecovery()).toBe(true)
  expect(calls).toEqual([])
  const backup = JSON.parse(readFileSync(harness.picked.filePath, 'utf8'))
  expect(backup).toMatchObject({ scope: 'remote', serviceUrl: endpoint, userId: saved.user.id, recoveryKey: saved.recoveryKey })
  expect(subject.readAccountCredential(endpoint).credential?.recoveryKey).toBe(saved.recoveryKey)
  expect(subject.readAccountCredential(endpoint).credential?.exportedAt).toBeTruthy()
  expect(changes.at(-1)).toMatchObject({ connectionMode: 'remote', recovery: { available: true, exportedAt: expect.any(String) } })
  expect(JSON.stringify(changes)).not.toContain(saved.recoveryKey)
  expect(JSON.stringify(changes)).not.toContain(saved.accessToken)
  expect(harness.identityChanges).toBe(0)
  expect(loadSubject().subject.readAccountCredential(endpoint).credential?.exportedAt).toBe(subject.readAccountCredential(endpoint).credential?.exportedAt)
})

test('missing key, cancelled export and failed write never rotate a key or mark a backup', async () => {
  const { subject, harness, calls } = loadSubject(), saved = credential()
  subject.saveAccountCredential(endpoint, { ...saved, recoveryKey: undefined, exportedAt: null })
  await expect(subject.accountService.exportRecovery()).rejects.toThrow('重新生成恢复码')
  expect(harness.dialogs).toBe(0)
  subject.saveAccountCredential(endpoint, { ...saved, exportedAt: null })
  harness.picked.canceled = true
  expect(await subject.accountService.exportRecovery()).toBe(false)
  harness.picked = { canceled: false, filePath: join(fixture, 'missing', 'recovery.json') }
  await expect(subject.accountService.exportRecovery()).rejects.toThrow()
  expect(subject.readAccountCredential(endpoint).credential?.exportedAt).toBeNull()
  expect(calls).toEqual([])
})

test('explicit regeneration clears backup metadata, and copy stays entirely in the main process', async () => {
  const { subject, harness, calls, changes } = loadSubject(), saved = credential(), nextKey = 'aether_recovery_' + 'b'.repeat(43)
  subject.saveAccountCredential(endpoint, saved)
  harness.respond = async path => { expect(path).toBe('/recovery'); return { recoveryKey: nextKey } }
  const state = await subject.accountService.regenerateRecovery()
  expect(calls).toHaveLength(1)
  expect(calls[0].authorization).toBe('Bearer ' + saved.accessToken)
  expect(state.recovery).toEqual({ available: true, exportedAt: null })
  expect(subject.readAccountCredential(endpoint).credential).toMatchObject({ accessToken: saved.accessToken, refreshToken: saved.refreshToken, recoveryKey: nextKey, exportedAt: null })
  await subject.accountService.copyRecovery()
  expect(harness.clipboard).toBe(nextKey)
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(changes)).not.toContain(nextKey)
  expect(harness.identityChanges).toBe(0)
})

test('reverification refreshes only same-session identity metadata without interrupting work', async () => {
  const { subject, harness, calls, changes } = loadSubject(), saved = credential(), authenticatedAt = new Date().toISOString()
  subject.saveAccountCredential(endpoint, saved)
  harness.respond = async path => { expect(path).toBe('/reauth'); return { ...saved.user, authenticatedAt } }
  const state = await subject.accountService.reauthenticate(saved.recoveryKey!)
  expect(calls[0]).toMatchObject({ path: '/reauth', authorization: 'Bearer ' + saved.accessToken, body: { recoveryKey: saved.recoveryKey } })
  expect(state.user?.authenticatedAt).toBe(authenticatedAt)
  expect(subject.readAccountCredential(endpoint).credential).toEqual({ ...saved, user: { ...saved.user, authenticatedAt } })
  expect(harness.identityChanges).toBe(0)
  expect(harness.cleanup).toBe(0)
  expect(JSON.stringify(changes)).not.toContain(saved.recoveryKey)
})

test('reverification rejects another user/session and network failure without altering credentials', async () => {
  const { subject, harness } = loadSubject(), saved = credential()
  subject.saveAccountCredential(endpoint, saved)
  for (const invalid of [{ ...saved.user, id: 'wrong' }, { ...saved.user, tenantId: 'wrong' }, { ...saved.user, sessionId: 'wrong' }]) {
    harness.respond = async () => invalid
    await expect(subject.accountService.reauthenticate(saved.recoveryKey!)).rejects.toThrow()
    expect(subject.readAccountCredential(endpoint).credential).toEqual(saved)
  }
  harness.respond = async () => { throw new Error('Synthetic offline') }
  await expect(subject.accountService.reauthenticate(saved.recoveryKey!)).rejects.toThrow('Synthetic offline')
  expect(subject.readAccountCredential(endpoint).credential).toEqual(saved)
  expect(harness.identityChanges).toBe(0)
})

test('third-party reverification authenticates the request and keeps the existing session', async () => {
  const { subject, harness, calls } = loadSubject(), saved = credential()
  subject.saveAccountCredential(endpoint, saved)
  harness.respond = async () => ({ ...saved.user, authenticatedAt: new Date().toISOString() })
  await subject.accountService.externalLogin('oidc-test', 'reauth', 'synthetic-proof')
  expect(calls[0]).toMatchObject({ path: '/external/credential', authorization: 'Bearer ' + saved.accessToken, body: { mode: 'reauth' } })
  expect(subject.readAccountCredential(endpoint).credential?.accessToken).toBe(saved.accessToken)
  expect(subject.readAccountCredential(endpoint).credential?.user.sessionId).toBe(saved.user.sessionId)
  expect(harness.identityChanges).toBe(0)
  expect(harness.cleanup).toBe(0)
})

test('browser reverification authenticates start and poll, and rejects a changed session', async () => {
  const { subject, harness, calls } = loadSubject(), saved = credential()
  subject.saveAccountCredential(endpoint, saved)
  let resultUser = { ...saved.user, authenticatedAt: new Date().toISOString() }
  harness.respond = async path => {
    if (path === '/external/start') return { authorizationUrl: 'https://id.example.test/authorize', flowId: 'flow', pollToken: 'synthetic-poll-token' }
    if (path === '/external/poll') return { status: 'complete', result: resultUser }
    throw new Error('Unexpected request')
  }
  await subject.accountService.externalLogin('oidc-test', 'reauth')
  expect(calls.map(call => [call.path, call.authorization])).toEqual([
    ['/external/start', 'Bearer ' + saved.accessToken], ['/external/poll', 'Bearer ' + saved.accessToken]
  ])
  expect(harness.openedUrls).toEqual(['https://id.example.test/authorize'])
  expect(subject.readAccountCredential(endpoint).credential).toEqual({ ...saved, user: resultUser })
  const before = subject.readAccountCredential(endpoint).credential
  resultUser = { ...resultUser, sessionId: 'another-session' }
  await expect(subject.accountService.externalLogin('oidc-test', 'reauth')).rejects.toThrow('不同的登录会话')
  expect(subject.readAccountCredential(endpoint).credential).toEqual(before)
  expect(harness.identityChanges).toBe(0)
  expect(harness.cleanup).toBe(0)
})

test('refresh and same-key login preserve the local successful export record', async () => {
  const { subject, harness } = loadSubject(), saved = credential()
  subject.saveAccountCredential(endpoint, { ...saved, expiresAt: new Date(0).toISOString() })
  harness.respond = async path => {
    if (path === '/refresh') return { ...saved, recoveryKey: undefined, exportedAt: undefined, accessToken: 'aether_session_rotated_1234567890' }
    if (path === '/login') return { ...saved, recoveryKey: undefined, exportedAt: undefined }
    throw new Error('Unexpected request')
  }
  await subject.ensureAccountSession(harness.target)
  expect(subject.readAccountCredential(endpoint).credential?.exportedAt).toBe(saved.exportedAt)
  await subject.accountService.login(saved.recoveryKey!)
  expect(subject.readAccountCredential(endpoint).credential?.exportedAt).toBe(saved.exportedAt)
})

test('logout tombstone blocks old advanced credentials until an explicit save, including restart', () => {
  const { subject } = loadSubject()
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'old-synthetic-key' }, () => {})
  subject.saveAccountCredential(endpoint, null)
  expect(subject.remoteAuthStatus(endpoint).effective).toBe('signed-out')
  const restarted = loadSubject().subject
  expect(restarted.readAccountCredential(endpoint).managed).toBe(true)
  restarted.withRemoteAuthChange(endpoint, undefined, () => {})
  expect(restarted.remoteAuthStatus(endpoint).effective).toBe('signed-out')
  restarted.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'new-synthetic-key' }, () => {})
  expect(restarted.remoteAuthStatus(endpoint).effective).toBe('advanced')
  expect(restarted.readAccountCredential(endpoint).managed).toBe(false)
  expect(loadSubject().subject.remoteAuthStatus(endpoint).effective).toBe('advanced')
})

test('explicit advanced save rolls back both credential bytes and cached tombstone on settings failure', () => {
  const { subject } = loadSubject()
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'old-synthetic-key' }, () => {})
  subject.saveAccountCredential(endpoint, null)
  subject.saveAccountCredential(otherEndpoint, null)
  const tombstone = join(fixture, 'accounts', createHash('sha256').update(endpoint).digest('hex') + '.json')
  const before = readFileSync(tombstone)
  expect(() => subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'new-synthetic-key' }, () => { throw new Error('Synthetic settings failure') })).toThrow('Synthetic settings failure')
  expect(readFileSync(tombstone)).toEqual(before)
  expect(subject.getRemoteAuth(endpoint).credential?.value).toBe('old-synthetic-key')
  expect(subject.readAccountCredential(endpoint).managed).toBe(true)
  expect(loadSubject().subject.remoteAuthStatus(endpoint).effective).toBe('signed-out')
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'selected-synthetic-key' }, () => {})
  expect(subject.readAccountCredential(otherEndpoint).managed).toBe(true)
  expect(existsSync(tombstone)).toBe(false)
})

test('saving an advanced key cannot silently sign out a current or expired account', () => {
  const { subject } = loadSubject(), saved = credential()
  for (const expiresAt of [saved.expiresAt, new Date(0).toISOString()]) {
    const current = { ...saved, expiresAt }
    subject.saveAccountCredential(endpoint, current)
    subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-key' }, () => {})
    expect(subject.readAccountCredential(endpoint).credential).toEqual(current)
    expect(subject.remoteAuthStatus(endpoint).effective).toBe('account')
  }
})

test('same-URL advanced credential changes expire transport and renderer cache identity without leaking keys', () => {
  const { subject } = loadSubject(), firstKey = 'synthetic-api-key-first', secondKey = 'synthetic-api-key-second'
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: firstKey }, () => {})
  const host = new subject.EngineHost(), identity = subject.authenticationIdentity(endpoint)
  Object.assign(host, { remoteTarget: { url: endpoint, workspaceRoot: '' }, snapshot: {
    ...host.getSnapshot(), mode: 'remote', phase: 'ready', baseUrl: endpoint, instanceId: 'same-engine', accountId: identity
  } })
  expect(identity).toMatch(/^advanced-[a-f0-9]{64}$/)
  expect(loadSubject().subject.authenticationIdentity(endpoint)).toBe(identity)
  subject.publishEngineSource(host.getSnapshot())
  const previousStorage = subject.getEngineStorageKey(), previousSource = subject.getEngineSource(), previousSignal = host.requestSignal
  host.on('snapshot', subject.publishEngineSource)
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: secondKey }, () => {})
  expect(host.refreshAuthenticationIdentity()).toBe(true)
  expect(previousSignal.aborted).toBe(true)
  expect(host.requestSignal.aborted).toBe(false)
  expect(host.getSnapshot().accountId).not.toBe(identity)
  expect(subject.getEngineStorageKey()).not.toBe(previousStorage)
  expect(subject.getEngineSource()).toBe(previousSource + 1)
  expect(() => subject.assertEngineSource(previousSource)).toThrow('引擎连接已变化')
  expect(host.requestHeaders()['X-API-Key']).toBe(secondKey)
  for (const key of [firstKey, secondKey]) expect(JSON.stringify(host.getSnapshot()) + subject.getEngineStorageKey()).not.toContain(key)
  const currentSignal = host.requestSignal
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: secondKey }, () => {})
  expect(host.refreshAuthenticationIdentity()).toBe(false)
  expect(host.requestSignal).toBe(currentSignal)
  subject.withRemoteAuthChange(otherEndpoint, { type: 'api-key', value: firstKey }, () => {})
  expect(host.refreshAuthenticationIdentity()).toBe(false)
  expect(host.requestSignal).toBe(currentSignal)
})

test('account priority and logout tombstones determine identity even when advanced keys remain stored', () => {
  const { subject } = loadSubject(), saved = credential(), host = new subject.EngineHost()
  subject.saveAccountCredential(endpoint, saved)
  Object.assign(host, { remoteTarget: { url: endpoint, workspaceRoot: '' }, snapshot: {
    ...host.getSnapshot(), mode: 'remote', phase: 'ready', baseUrl: endpoint, instanceId: 'same-engine', accountId: saved.user.id
  } })
  const originalSignal = host.requestSignal
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-retained-key' }, () => {})
  expect(subject.authenticationIdentity(endpoint)).toBe(saved.user.id)
  expect(host.refreshAuthenticationIdentity()).toBe(false)
  expect(host.requestSignal).toBe(originalSignal)
  expect(host.requestHeaders().Authorization).toBe('Bearer ' + saved.accessToken)
  subject.saveAccountCredential(endpoint, null)
  expect(subject.authenticationIdentity(endpoint)).toBeNull()
  expect(host.refreshAuthenticationIdentity()).toBe(true)
  expect(host.requestHeaders()['X-API-Key']).toBeUndefined()
  expect(host.requestHeaders().Authorization).toBeUndefined()
})

test('advanced identity changes stop browser polling and unregister with the original credential', async () => {
  const { subject, harness, calls } = loadSubject(), host = subject.engineHost
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-browser-old' }, () => {})
  Object.assign(host, { remoteTarget: { url: endpoint, workspaceRoot: '' }, snapshot: {
    ...host.getSnapshot(), mode: 'remote', phase: 'ready', baseUrl: endpoint, instanceId: 'same-engine', accountId: subject.authenticationIdentity(endpoint)
  } })
  let pollSignal: AbortSignal | null | undefined
  harness.respond = async (path, _body, init) => {
    if (init.method === 'POST' && path === '/browser/clients') return { clientId: 'client-old', clientToken: 'synthetic-client-token', sessionId: 'session-old' }
    if (init.method === 'DELETE' && path === '/browser/clients/client-old') return {}
    if (path === '/browser/clients/client-old/commands') {
      pollSignal = init.signal
      return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('poll aborted')), { once: true }) })
    }
    throw new Error('Unexpected browser request')
  }
  const bridge = new subject.BrowserEngineBridge({ getSettings: () => ({ aiEnabled: true }), rememberPresentation: () => {},
    adoptUnboundTabs: () => {}, execute: async () => ({ success: true }) }, () => {})
  try {
    await bridge.connect({ sessionId: 'session-old', expectedEngine: host.getSnapshot() })
    await expect.poll(() => !!pollSignal).toBe(true)
    expect(bridge.getState().status).toBe('connected')
    subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-browser-new' }, () => {})
    expect(host.refreshAuthenticationIdentity()).toBe(true)
    expect(pollSignal?.aborted).toBe(true)
    expect(bridge.getState().status).toBe('disconnected')
    expect(bridge.getContext()).toBeUndefined()
    await bridge.disconnectAndWait()
    const deleted = calls.filter(call => call.method === 'DELETE')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatchObject({ path: '/browser/clients/client-old', apiKey: 'synthetic-browser-old' })
  } finally { await bridge.disconnectAndWait(); bridge.dispose() }
})

test('advanced identity epochs stop native browser hosts and register the replacement authority', async () => {
  const { subject } = loadSubject(), host = subject.engineHost
  subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-native-old' }, () => {})
  Object.assign(host, { remoteTarget: { url: endpoint, workspaceRoot: '' }, snapshot: {
    ...host.getSnapshot(), mode: 'remote', phase: 'ready', baseUrl: endpoint, instanceId: 'same-engine', accountId: subject.authenticationIdentity(endpoint)
  } })
  const requests: Array<{ path: string; method: string; apiKey: string | null; signal: AbortSignal | null | undefined }> = []
  let registrations = 0
  const http: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace('/engine/api/v1', ''), method = init?.method ?? 'GET'
    requests.push({ path, method, apiKey: new Headers(init?.headers).get('X-API-Key'), signal: init?.signal })
    let data: unknown = {}
    if (method === 'POST' && path === '/browser/hosts') data = { hostId: 'host-' + ++registrations, hostToken: 'synthetic-host-token', protocolVersion: 1,
      authority: { kind: 'account' }, capabilities: { nativeHostDemand: 1 }, leaseMs: 30000 }
    else if (method === 'GET' && path.endsWith('/demands')) {
      return new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('demand poll aborted')), { once: true }) })
    } else if (method !== 'DELETE') throw new Error('Unexpected native browser request')
    return new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const manager = new subject.NativeBrowserHostManager({ getSettings: () => ({ aiEnabled: true }), execute: async () => ({ success: true }) },
    () => host.nativeBrowserHostTransports(), http)
  const refresh = () => { void manager.refresh() }
  host.on('snapshot', refresh)
  try {
    await manager.refresh()
    await expect.poll(() => requests.some(request => request.path === '/browser/hosts/host-1/demands')).toBe(true)
    const oldPoll = requests.find(request => request.path === '/browser/hosts/host-1/demands')!
    subject.withRemoteAuthChange(endpoint, { type: 'api-key', value: 'synthetic-native-new' }, () => {})
    expect(host.refreshAuthenticationIdentity()).toBe(true)
    expect(oldPoll.signal?.aborted).toBe(true)
    await expect.poll(() => requests.some(request => request.method === 'DELETE' && request.path === '/browser/hosts/host-1')).toBe(true)
    await expect.poll(() => requests.some(request => request.path === '/browser/hosts/host-2/demands')).toBe(true)
    expect(requests.find(request => request.method === 'DELETE' && request.path === '/browser/hosts/host-1')?.apiKey).toBe('synthetic-native-old')
    expect(requests.filter(request => request.method === 'POST').map(request => request.apiKey)).toEqual(['synthetic-native-old', 'synthetic-native-new'])
    expect(manager.getSnapshot()).toMatchObject({ hosts: 1, roots: 0, cleanupFailure: null })
  } finally { host.off('snapshot', refresh); await manager.disconnectAndWait(); manager.dispose() }
})

const privateService = 'http://private.example.test/engine'

test('revoking HTTP consent blocks cached browser and native host cleanup without borrowing new credentials', async () => {
  const { subject, harness, calls } = loadSubject(), host = subject.engineHost
  subject.saveHttpTrust(privateService, true)
  subject.withRemoteAuthChange(privateService, { type: 'api-key', value: 'synthetic-original-browser-key' }, () => {})
  Object.assign(host, { remoteTarget: { url: privateService, workspaceRoot: '' }, snapshot: {
    ...host.getSnapshot(), mode: 'remote', phase: 'ready', baseUrl: privateService, instanceId: 'browser-trust', accountId: subject.authenticationIdentity(privateService)
  } })
  harness.respond = async (path, _body, init) => {
    if (path === '/browser/clients') return { clientId: 'client', clientToken: 'synthetic-registration-token', sessionId: 'session' }
    if (path === '/browser/hosts') return { hostId: 'host', hostToken: 'synthetic-host-token', protocolVersion: 1,
      authority: { kind: 'account' }, capabilities: { nativeHostDemand: 1 }, leaseMs: 30_000 }
    if (init.method === 'DELETE') return {}
    if (path.endsWith('/commands') || path.endsWith('/demands')) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    throw new Error('Unexpected request: ' + path)
  }
  const executor = { getSettings: () => ({ aiEnabled: true }), rememberPresentation() {}, adoptUnboundTabs() {}, execute: async () => ({ success: true }) }
  const bridge = new subject.BrowserEngineBridge(executor, () => {}), native = new subject.NativeBrowserHostManager(executor, () => host.nativeBrowserHostTransports())
  try {
    await Promise.all([bridge.connect({ sessionId: 'session', expectedEngine: host.getSnapshot() }), native.refresh()])
    await expect.poll(() => calls.filter(r => r.path.endsWith('/commands') || r.path.endsWith('/demands')).length).toBe(2)
    subject.saveHttpTrust(privateService, false)
    const outcomes = await Promise.all([bridge.disconnectAndWait(), native.disconnectAndWait()])
    expect(outcomes.every(message => message?.includes('HTTP'))).toBe(true)
    expect(calls.filter(r => r.method === 'DELETE')).toHaveLength(0)
    subject.saveHttpTrust(privateService, true)
    expect(await bridge.disconnectAndWait()).toBeNull()
    expect(calls.filter(r => r.method === 'DELETE')).toMatchObject([{ path: '/browser/clients/client', apiKey: 'synthetic-original-browser-key' }])
  } finally { bridge.dispose(); native.dispose() }
})

test('revoking HTTP trust between remote PTY creation and attachment blocks both the socket and cached DELETE', async () => {
  const { subject, harness, calls } = loadSubject(), host = subject.engineHost
  const snapshot = { ...host.getSnapshot(), mode: 'remote' as const, phase: 'ready' as const, baseUrl: privateService, instanceId: 'pty-trust' }
  const target = { snapshot, headers: { 'X-Aether-Instance-Token': 'synthetic-old-pty-token' }, signal: new AbortController().signal }
  const terminal = new subject.RemoteTerminalService(() => target)
  subject.saveHttpTrust(privateService, true)
  harness.respond = async (path, _body, init) => {
    if (path === '/terminal/create') { subject.saveHttpTrust(privateService, false); return { terminalId: 'old-pty' } }
    if (init.method === 'DELETE' && path === '/terminal/old-pty') return { success: true }
    throw new Error('Unexpected PTY request')
  }
  await expect(terminal.create({ sessionId: 'session', cols: 80, rows: 24 }, { onData() {}, onExit() {} })).rejects.toThrow('HTTP')
  expect(harness.sockets).toBe(0)
  expect((await terminal.disposeForIdentityChange()).join()).toContain('HTTP')
  expect(calls.find(r => r.method === 'DELETE')).toBeUndefined()
  subject.saveHttpTrust(privateService, true)
  expect(await terminal.disposeForIdentityChange()).toEqual([])
  expect(calls.filter(r => r.method === 'DELETE')).toHaveLength(1)
})

test('an account request checks current HTTP consent again after shared refresh, and cancellation only releases one waiter', async () => {
  const { subject, harness, calls } = loadSubject(), original = credential()
  harness.target = { scope: privateService, url: privateService, headers: {} }
  subject.saveHttpTrust(privateService, true)
  subject.saveAccountCredential(privateService, { ...original, expiresAt: new Date(0).toISOString() })
  let release!: (value: unknown) => void
  harness.respond = async path => { if (path !== '/refresh') throw new Error('Unexpected account request'); return new Promise(resolve => { release = resolve }) }
  const pending = subject.accountService.sessions(), controller = new AbortController()
  const waiter = subject.ensureAccountSession(harness.target, controller.signal)
  await expect.poll(() => calls.filter(call => call.path === '/refresh').length).toBe(1)
  controller.abort(new Error('connection cancelled'))
  await expect(waiter).rejects.toThrow('connection cancelled')
  subject.saveHttpTrust(privateService, false)
  release({ ...original, accessToken: 'synthetic-rotated-access-token' })
  await expect(pending).rejects.toThrow('HTTP')
  expect(calls.map(call => call.path)).toEqual(['/refresh'])
  expect(subject.readAccountCredential(privateService).credential?.accessToken).toBe('synthetic-rotated-access-token')
})

test('candidate probing never refreshes an inactive account; a committed target reuses its handshake to rotate its rejected session', async () => {
  const { subject, harness, calls, changes } = loadSubject(), saved = credential(), host = subject.engineHost
  // A appears active while B is checked, and B's clock still considers its rejected token fresh.
  const origin = 'http://127.0.0.1:19230/engine'
  subject.saveAccountCredential(origin, saved)
  harness.respond = async (path, _body, init) => {
    if (path === '/engine/health') return { status: 'ok' }
    if (path === '/engine/meta') return { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1, toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: 'candidate' }
    if (path === '/tools') {
      if (new Headers(init.headers).get('Authorization') === 'Bearer synthetic-rotated-access-token') return []
      return new Response(JSON.stringify({ code: 401, message: 'Authentication required' }), { status: 401 })
    }
    if (path === '/refresh') return { ...saved, accessToken: 'synthetic-rotated-access-token' }
    throw new Error('Unexpected candidate request ' + path)
  }
  const signal = new AbortController().signal
  const proof = await subject.probeRemoteConnection(origin, {}, signal)
  expect(proof.issue).toBe('authentication-required'); expect(calls.map(c => c.path)).toEqual(['/engine/health', '/engine/meta', '/tools']); expect(changes).toEqual([])
  harness.target = { scope: origin, url: origin, headers: {} }
  try {
    const snapshot = await host.startVerifiedRemote(proof, '', signal)
    expect(snapshot).toMatchObject({ phase: 'ready', instanceId: 'candidate', accountId: saved.user.id })
    expect(calls.map(c => c.path)).toEqual(['/engine/health', '/engine/meta', '/tools', '/refresh', '/tools'])
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-rotated-access-token')
  } finally { await host.stop() }
})


const managedId = '00000000-0000-4000-8000-000000000071'
const familyParentFixture = (): AccountCredential => ({ ...credential(), user: { ...user(), accountKind: 'primary', mainAccountActivated: true, authenticatedAt: new Date().toISOString() } })
const familyScope = (c: AccountCredential) => ({ serviceUrl: endpoint, userId: c.user.id, tenantId: c.user.tenantId, sessionId: c.user.sessionId! })
const familyChildFixture = (): AccountCredential => ({ user: { ...user(), id: managedId, name: '协作空间', accountKind: 'child', mainAccountActivated: false,
  tenantId: 'account_child_00000000-0000-4000-8000-000000000072', sessionId: 'child-only-session' },
  accessToken: 'synthetic-child-access-token-123', refreshToken: 'synthetic-child-refresh-token-123', expiresAt: new Date(Date.now() + 900_000).toISOString() })

test('family management pins the service, principal, tenant and session; rejects unactivated or nested callers and incomplete inventories', async () => {
  const { subject, harness, calls } = loadSubject(), api = subject.accountService, parent = familyParentFixture(), scope = familyScope(parent)
  subject.saveAccountCredential(endpoint, parent)
  const item = { id: managedId, name: '办'.repeat(80), status: 'active', createdAt: new Date().toISOString() }
  for (const stale of [{ ...scope, serviceUrl: otherEndpoint }, { ...scope, userId: 'another' }, { ...scope, tenantId: 'another' }, { ...scope, sessionId: 'another' }]) {
    await expect(api.createChild(stale, 'example')).rejects.toThrow('已切换')
  }
  await expect(api.createChild(scope, 'x\u202ey')).rejects.toThrow('名称')
  await expect(api.setChildStatus(scope, managedId, 'false')).rejects.toThrow('状态')
  expect(calls).toEqual([])
  harness.respond = async (path, body, init) => {
    if (path === '/children' && init.method === 'POST') return { ...item, name: body.name }
    if (path === '/children/' + managedId) return { ...item, status: body.status }
    return { limit: 3, used: 1, children: [{ ...item, recoveryKey: 'unwanted-remote-field' }] }
  }
  expect(await api.family(scope)).toEqual({ limit: 3, used: 1, children: [item] })
  await api.createChild(scope, '  New  '); await api.setChildStatus(scope, managedId, false)
  expect(calls.map(c => [c.method,c.path,c.body])).toEqual([['GET','/children',{}],['POST','/children',{name:'New'}],['PATCH','/children/'+managedId,{status:'disabled'}]])
  expect(calls.every(c => c.authorization === 'Bearer ' + parent.accessToken)).toBe(true)
  harness.respond = async () => ({ used: 2, limit: 3, children: [item] })
  await expect(api.family(scope)).rejects.toThrow('不完整')
  const count = calls.length
  for (const forbidden of [familyChildFixture(), { ...parent, user: { ...parent.user, mainAccountActivated: false } }]) {
    subject.saveAccountCredential(endpoint, forbidden)
    await expect(api.family(familyScope(forbidden))).rejects.toThrow('已开通的主账号')
  }
  expect(calls).toHaveLength(count)
})

test('family handoff replaces the encrypted principal, scrubs a copied parent key, and never restores the parent on restart, expiry or logout', async () => {
  const { subject, harness, calls, changes } = loadSubject(), api = subject.accountService, parent = familyParentFixture(), scope = familyScope(parent), child = familyChildFixture()
  subject.saveAccountCredential(endpoint, parent)
  await api.copyRecovery(); expect(harness.clipboard).toBe(parent.recoveryKey)
  harness.respond = async (path) => { expect(path).toBe('/children/' + managedId + '/enter'); return child }
  expect(await api.enterChild(scope, managedId)).toMatchObject({status:'authenticated',user:child.user,recovery:{available:false,exportedAt:null}})
  expect(harness.clipboard).toBe(''); expect(harness.cleanup).toBe(1); expect(harness.identityChanges).toBe(1)
  for (const secret of [parent.recoveryKey!, parent.accessToken, parent.refreshToken, child.accessToken, child.refreshToken]) expect(JSON.stringify(changes)).not.toContain(secret)
  await expect(api.family(scope)).rejects.toThrow('已切换')
  for(const action of [() => api.copyRecovery(), () => api.exportRecovery(), () => api.regenerateRecovery(), () => api.externalLogin('fixture','link')]) await expect(action()).rejects.toThrow('子账号')
  expect(calls).toHaveLength(1)
  const restarted = loadSubject(), stored = restarted.subject.readAccountCredential(endpoint)
  expect(stored).toMatchObject({ managed:true, credential:{user:child.user,accessToken:child.accessToken} })
  expect(JSON.stringify(stored)).not.toContain(parent.recoveryKey!); expect(JSON.stringify(stored)).not.toContain(parent.refreshToken)
  restarted.harness.respond = async path => path === '/providers' ? {providers:[],registrationEnabled:true} : new Response(JSON.stringify({code:401,message:'synthetic expired child'}), {status:401})
  expect(await restarted.subject.accountService.getState()).toMatchObject({ status:'expired', user:child.user })
  expect(await restarted.subject.accountService.logout()).toMatchObject({ status:'signed-out', user:null })
  expect(loadSubject().subject.readAccountCredential(endpoint)).toMatchObject({ managed:true, credential:null })
})

test('family handoff requires an exported parent recovery key or an available linked provider, and rejects every mismatched grant', async () => {
  const { subject,harness,calls }=loadSubject(), api=subject.accountService, parent=familyParentFixture(), scope=familyScope(parent), child=familyChildFixture()
  subject.saveAccountCredential(endpoint,{...parent,exportedAt:null})
  await expect(api.enterChild(scope,managedId)).rejects.toThrow('保存主账号恢复文件'); expect(calls).toEqual([])
  const federated = { ...parent, recoveryKey:undefined, exportedAt:null, user:{...parent.user,identities:[{providerId:'company',subject:'test'}]} }
  subject.saveAccountCredential(endpoint,federated); harness.respond=async ()=>({providers:[]})
  await expect(api.enterChild(scope,managedId)).rejects.toThrow('保存主账号恢复文件'); expect(calls.map(c=>c.path)).toEqual(['/providers'])
  for(const invalid of [parent, {...child,user:{...child.user,id:'unselected'}}, {...child,user:{...child.user,tenantId:parent.user.tenantId}},
    {...child,user:{...child.user,sessionId:parent.user.sessionId}}, {...child,user:{...child.user,accountKind:'primary'}}, {...child,refreshToken:parent.refreshToken}, {...child,recoveryKey:parent.recoveryKey}]) {
    harness.respond=async path=>path==='/providers'?{providers:[{id:'company',type:'oidc',name:'Company'}]}:invalid
    await expect(api.enterChild(scope,managedId)).rejects.toThrow('所选子账号'); expect(subject.readAccountCredential(endpoint).credential).toEqual(federated)
  }
  harness.respond=async path=>path==='/providers'?{providers:[{id:'company',type:'oidc',name:'Company'}]}:child
  expect((await api.enterChild(scope,managedId)).user?.id).toBe(managedId)
})

test('family handoff rejects late or unpersistable grants and revokes only the new child session at its original service', async () => {
  const {subject,harness,calls}=loadSubject(), api=subject.accountService, parent=familyParentFixture(), scope=familyScope(parent), child=familyChildFixture()
  subject.saveAccountCredential(endpoint,parent)
  for(const failure of ['write','service']) {
    harness.target={scope:endpoint,url:endpoint,headers:{}}
    harness.respond=async path=>{
      if(path==='/logout') return {loggedOut:true}
      expect(path).toBe('/children/'+managedId+'/enter')
      if(failure==='write') harness.failEncryption=true
      else harness.target={scope:otherEndpoint,url:otherEndpoint,headers:{}}
      return child
    }
    await expect(api.enterChild(scope,managedId)).rejects.toThrow(failure==='write'?'secure storage':'已切换')
    harness.failEncryption=false
    expect(calls.at(-1)).toMatchObject({path:'/logout',authorization:'Bearer '+child.accessToken,body:{all:false}})
    expect(subject.readAccountCredential(endpoint).credential).toEqual(parent)
    expect(loadSubject().subject.readAccountCredential(endpoint).credential).toEqual(parent)
    expect(subject.readAccountCredential(otherEndpoint).credential).toBeNull()
  }
})

const anonymousChildScope = { serviceUrl: endpoint, userId: null, tenantId: null, sessionId: null }
const childLoginName = 'fixture.child', childPassword = 'synthetic child password for this test'
const childResetCode = 'aether_child_reset_' + 'r'.repeat(43)

for (const invalid of ['primary account', 'missing session', 'expired grant', 'default tenant'] as const) {
  test(`child password login rejects an invalid grant (${invalid}) without saving or publishing it`, async () => {
    const { subject, harness, calls, changes } = loadSubject(), grant = familyChildFixture()
    switch (invalid) {
      case 'primary account': grant.user.accountKind = 'primary'; break
      case 'missing session': delete grant.user.sessionId; break
      case 'expired grant': grant.expiresAt = new Date(0).toISOString(); break
      case 'default tenant': grant.user.tenantId = 'default'; break
    }
    harness.respond = async () => grant
    await expect(subject.accountService.childPasswordLogin(anonymousChildScope, childLoginName, childPassword)).rejects.toThrow('有效的子账号会话')
    expect(calls).toMatchObject([{ path: '/child-password/login', method: 'POST', authorization: null }])
    expect(harness.identityChanges).toBe(0)
    expect(changes).toEqual([])
    expect(loadSubject().subject.readAccountCredential(endpoint)).toEqual({ managed: false, persistence: 'none', credential: null })
  })
}

for (const operation of ['login', 'copy reset code'] as const) {
  for (const switched of ['service', 'account'] as const) {
    test(`child password ${operation} ignores a late response after switching ${switched}`, async () => {
      const { subject, harness, calls, changes } = loadSubject(), child = familyChildFixture()
      const otherServiceAccount = familyParentFixture()
      const replacement = { ...child, user: { ...child.user, id: 'another-child', tenantId: 'another-tenant', sessionId: 'another-session' },
        accessToken: 'synthetic-replacement-access', refreshToken: 'synthetic-replacement-refresh' }
      const original = operation === 'login' ? null : child
      if (original) subject.saveAccountCredential(endpoint, original)
      subject.saveAccountCredential(otherEndpoint, otherServiceAccount)
      harness.clipboard = 'keep existing clipboard'
      harness.respond = async () => {
        // Fetch has captured the original target and authorization; switch before it delivers the response.
        if (switched === 'service') harness.target = { scope: otherEndpoint, url: otherEndpoint, headers: {} }
        else subject.saveAccountCredential(endpoint, replacement)
        return operation === 'login' ? child : { code: childResetCode }
      }
      const action = operation === 'login'
        ? subject.accountService.childPasswordLogin(anonymousChildScope, childLoginName, childPassword)
        : subject.accountService.copyChildResetCode(familyScope(child), childPassword)
      await expect(action).rejects.toThrow('已切换')
      expect(calls).toMatchObject([operation === 'login'
        ? { path: '/child-password/login', method: 'POST', authorization: null }
        : { path: '/child-password/reset-code', method: 'POST', authorization: 'Bearer ' + child.accessToken }])
      expect(harness.clipboard).toBe('keep existing clipboard')
      expect(harness.identityChanges).toBe(0)
      expect(changes).toEqual([])
      for (const store of [subject, loadSubject().subject]) {
        expect(store.readAccountCredential(endpoint).credential).toEqual(switched === 'account' ? replacement : original)
        expect(store.readAccountCredential(otherEndpoint).credential).toEqual(otherServiceAccount)
      }
    })
  }
}

test('child password login preserves the new account if old identity cleanup outlasts the request', async () => {
  const { subject, harness, changes } = loadSubject(), child = familyChildFixture(), replacement = familyParentFixture()
  harness.respond = async () => child
  subject.configureAccountService({
    target: () => harness.target,
    beforeIdentityChange: async () => { harness.cleanup++; subject.saveAccountCredential(endpoint, replacement); return null },
    identityChanged: async () => { harness.identityChanges++ },
    changed: state => changes.push(state)
  })
  await expect(subject.accountService.childPasswordLogin(anonymousChildScope, childLoginName, childPassword)).rejects.toThrow('已切换')
  expect(harness.cleanup).toBe(1)
  expect(harness.identityChanges).toBe(0)
  expect(changes).toEqual([])
  expect(loadSubject().subject.readAccountCredential(endpoint).credential).toEqual(replacement)
})

test('child password login persists the session and copies only the reset code without exposing secrets to the renderer', async () => {
  const login = loadSubject(), child = familyChildFixture()
  login.harness.respond = async () => child
  const state = await login.subject.accountService.childPasswordLogin(anonymousChildScope, childLoginName, childPassword)
  expect(login.calls).toEqual([{ path: '/child-password/login', method: 'POST', authorization: null, apiKey: null,
    body: { loginName: childLoginName, password: childPassword } }])
  expect(state).toMatchObject({ status: 'authenticated', user: child.user, persistence: 'encrypted', recovery: { available: false, exportedAt: null } })
  expect(login.harness.identityChanges).toBe(1)
  expect(login.changes).toContainEqual(state)

  const restarted = loadSubject()
  restarted.harness.clipboard = 'replace on successful copy'
  restarted.harness.respond = async () => ({ code: childResetCode })
  const result = await restarted.subject.accountService.copyChildResetCode(familyScope(child), childPassword)
  expect(restarted.calls).toEqual([{ path: '/child-password/reset-code', method: 'POST', authorization: 'Bearer ' + child.accessToken, apiKey: null,
    body: { currentPassword: childPassword } }])
  expect(result).toBeUndefined()
  expect(restarted.harness.clipboard).toBe(childResetCode)
  expect(restarted.harness.identityChanges).toBe(0)
  const rendererState = JSON.stringify([state, ...login.changes, ...restarted.changes])
  for (const secret of [childPassword, child.accessToken, child.refreshToken, childResetCode]) expect(rendererState).not.toContain(secret)
  const stored = loadSubject().subject.readAccountCredential(endpoint)
  expect(stored).toMatchObject({ managed: true, persistence: 'encrypted', credential: child })
  for (const secret of [childPassword, childResetCode]) expect(JSON.stringify(stored)).not.toContain(secret)
})

test('copying an invalid child reset code leaves the clipboard untouched', async () => {
  const { subject, harness } = loadSubject(), child = familyChildFixture()
  subject.saveAccountCredential(endpoint, child)
  harness.clipboard = 'keep existing clipboard'
  for (const code of [familyParentFixture().recoveryKey, childResetCode.slice(0, -1)]) {
    harness.respond = async () => ({ code })
    await expect(subject.accountService.copyChildResetCode(familyScope(child), childPassword)).rejects.toThrow('子账号自己保存的密码恢复码')
    expect(harness.clipboard).toBe('keep existing clipboard')
  }
})
