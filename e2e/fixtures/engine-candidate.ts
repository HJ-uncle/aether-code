/** A disposable B endpoint for the connection handshake and account login. The
 * ready A service uses the full ResourceSettingsFixture. Each server only binds
 * to loopback. No renderer IPC handlers or production identity checks are mocked. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'

const accessToken = 'fixture-access-only-for-engine-b', refreshToken = 'fixture-refresh-only-for-engine-b'
export const fixtureRecoveryKey = 'aether_recovery_' + 'b'.repeat(36)
const user = { id: 'fixture-account-b', tenantId: 'tenant-b', name: '服务 B 的测试账号', email: null, avatarUrl: null, bio: null,
  userData: {}, createdAt: '2026-01-01T00:00:00.000Z', identities: [], roles: ['tenant-admin'], sessionId: 'session-b' }
const respond = (res: ServerResponse, data: unknown, status = 200, message = 'ok'): void => {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: status, message, data }))
}
export class EngineCandidateFixture {
  origin = ''
  behavior: 'ready' | 'incompatible' | 'token' | 'login' | 'hold' | 'unavailable' = 'ready'
  expectedCredentialDigests?: { instanceToken?: string; apiKey?: string; bearer?: string }
  adminHandler?: (request: IncomingMessage, response: ServerResponse, isPersonalAccount: boolean) => void
  readonly requests: Array<{ method: string; path: string; token: string; apiKey: string; bearer: string }> = []
  readonly workspaceBinds: string[] = []
  readonly graphQueries: Array<{ root: string | null; sessionId: string | null }> = []
  private readonly held = new Set<ServerResponse>()
  private readonly server = createServer((req, res) => { void (async () => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const receipt = { method: req.method ?? 'GET', path, token: String(req.headers['x-aether-instance-token'] ?? ''),
      apiKey: String(req.headers['x-api-key'] ?? ''), bearer: String(req.headers.authorization ?? '') }
    this.requests.push(receipt)
    if (this.adminHandler && path.startsWith('/admin/')) {
      this.adminHandler(req, res, receipt.bearer === `Bearer ${accessToken}`); return
    }
    if (path === '/health') {
      if (this.behavior === 'unavailable') return respond(res, null, 503, 'Temporarily unavailable')
      if (this.behavior !== 'hold') return respond(res, { status: 'ok' })
      this.held.add(res); res.once('close', () => this.held.delete(res)); return
    }
    if (path === '/meta') return respond(res, { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: this.behavior === 'incompatible' ? 2 : 1,
      toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: 'fixture-engine-b' })
    if (path === '/auth/account/providers') return respond(res, { providers: [], registrationEnabled: false })
    if (path === '/auth/account/login' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      if (JSON.parse(Buffer.concat(chunks).toString()).recoveryKey !== fixtureRecoveryKey) return respond(res, null, 401, 'Invalid login')
      return respond(res, { user, accessToken, refreshToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (path === '/auth/account/me') return receipt.bearer === `Bearer ${accessToken}` ? respond(res, user) : respond(res, null, 401, 'Authentication required')
    if (path === '/api/v1/tools') {
      if (this.expectedCredentialDigests) {
        const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
        if (this.expectedCredentialDigests.instanceToken && digest(receipt.token) !== this.expectedCredentialDigests.instanceToken) return respond(res, null, 401, 'Invalid or missing instance token')
        const expected = this.expectedCredentialDigests
        if (expected.apiKey || expected.bearer) {
          if (!receipt.apiKey && !receipt.bearer) return respond(res, null, 401, 'Authentication required')
          if (expected.apiKey && digest(receipt.apiKey) !== expected.apiKey) return respond(res, null, 401, 'Invalid API key')
          if (expected.bearer && digest(receipt.bearer.replace(/^Bearer /, '')) !== expected.bearer) return respond(res, null, 401, 'Invalid bearer token')
        }
      }
      if (this.behavior === 'token') return respond(res, null, 401, 'Invalid or missing instance token')
      if (this.behavior === 'login' && receipt.bearer !== `Bearer ${accessToken}`) return respond(res, null, 401, receipt.apiKey ? 'Invalid API key' : 'Authentication required')
      return respond(res, [])
    }
    if (path === '/api/v1/workspace/bind' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const { workspaceRoot } = JSON.parse(Buffer.concat(chunks).toString()) as { workspaceRoot: string }
      this.workspaceBinds.push(workspaceRoot); return respond(res, { workspaceRoot, bindingEpoch: 'b', contractVersion: 2 })
    }
    if (path === '/api/v1/workspace/directory') return respond(res, { root: '/sandbox-b', entries: [], bindingEpoch: 'b' })
    if (path === '/api/v1/codegraph/status') {
      const query = new URL(req.url!, this.origin).searchParams
      this.graphQueries.push({ root: query.get('path'), sessionId: query.get('sessionId') })
      return respond(res, { root: '/sandbox-b', initialized: false, indexing: false })
    }
    // The workbench may initialize a new, empty identity immediately after login.
    if (path === '/api/v1/conversation/sessions' || path === '/api/v1/models') return respond(res, [])
    return respond(res, null, 404, 'Not available in the fixture')
  })().catch(() => respond(res, null, 500, 'Invalid fixture request')) })
  activeProbes(): number { return this.held.size }
  release(): void { this.behavior = 'ready'; for (const res of this.held) respond(res, { status: 'ok' }); this.held.clear() }
  async start(): Promise<void> {
    await new Promise<void>((done, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done) })
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Missing candidate port')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> { this.release(); this.server.closeAllConnections(); if (this.server.listening) await new Promise<void>(done => this.server.close(() => done())) }
}
