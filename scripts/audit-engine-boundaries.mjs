/** Authorized local audit: production route/policy code, disposable DB and fake PTY.
 * Run: node --import ../ai-agent-engine/node_modules/tsx/dist/loader.mjs scripts/audit-engine-boundaries.mjs
 * Vulnerable probes remain explicitly vulnerable in the JSON; a completed run is not a security pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engine = path.resolve(root, '../ai-agent-engine')
const requireEngine = createRequire(path.join(engine, 'package.json'))
const scratch = path.join(root, '.e2e-tmp')
fs.mkdirSync(scratch, { recursive: true })
const fixture = fs.mkdtempSync(path.join(scratch, 'audit-engine-boundaries-'))
const checked = (p) => {
  const absolute = path.resolve(p)
  const relative = path.relative(fixture, absolute)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('audit path escapes fixture')
  return absolute
}
Object.assign(process.env, {
  DATA_DIR: checked(path.join(fixture, 'audit.db')),
  WORKSPACE_ROOT: checked(path.join(fixture, 'workspaces')),
  AETHER_GLOBAL_DIR: checked(path.join(fixture, 'global')),
  JWT_SECRET: 'audit-only-synthetic-jwt-secret', AUTH_ENABLED: 'true', DEFAULT_SECURITY_MODE: 'safe',
  LOG_LEVEL: 'silent', NODE_ENV: 'production'
})
delete process.env.AETHER_INSTANCE_TOKEN
const source = (file) => import(pathToFileURL(path.join(engine, 'src', file)).href)
const findings = []
function result(id, vulnerable, evidence) {
  findings.push({ id, status: vulnerable ? 'vulnerable' : 'blocked', evidence })
}
async function probe(id, fn) {
  try {
    await fn()
  } catch (error) {
    // A rejected malformed tenant/session ID is the expected post-fix control,
    // while unrelated exceptions remain inconclusive and fail the audit.
    const message = String(error)
    const blockedByValidation = id === 'PATH-session-id-traversal' && /valid identifier|Path is invalid/i.test(message)
    findings.push({ id, status: blockedByValidation ? 'blocked' : 'inconclusive', evidence: message })
  }
}
const dbModule = await source('storage/sqlite/db.ts')
await dbModule.initDb()
const { policyEngine, setSecurityMode, getSecurityMode } = await source('security/policy-engine.ts')
const { workspaceManager } = await source('workspace/manager.ts')
const { cmdTool } = await source('tools/cmd/execute-command.ts')
const { commandJobs } = await source('core/command-jobs/index.ts')
const { guardedHttp } = await source('security/guarded-http.ts')
const { authMiddlewareHook } = await source('api/http/middleware.ts')
const { securityRoutes } = await source('api/http/routes/security.ts')
const { terminalRoutes } = await source('api/http/routes/terminal.ts')
const { workspaceRoutes } = await source('api/http/routes/workspace.ts')
const { terminalManager } = await source('terminal/index.ts')
const { SignJWT } = requireEngine('jose')
const Fastify = requireEngine('fastify')
const WebSocket = requireEngine('ws')
const app = Fastify()
app.addHook('onRequest', authMiddlewareHook)
await app.register(requireEngine('@fastify/websocket'))
await app.register(securityRoutes, { prefix: '/api/v1' })
await app.register(terminalRoutes, { prefix: '/api/v1' })
await app.register(workspaceRoutes, { prefix: '/api/v1' })
const ownRoot = workspaceManager.init({ tenantId: 'audit-a', sessionId: 'session-a' })
checked(ownRoot)
const outside = checked(path.join(fixture, 'outside'))
fs.mkdirSync(outside)
fs.writeFileSync(checked(path.join(outside, 'canary.txt')), 'AUDIT_ONLY_OUTSIDE_CANARY')
const ctx = { tenantId: 'audit-a', sessionId: 'session-a', toolProfile: 'code', currentToolCallId: 'audit-call',
  logger: { info() {}, warn() {}, error() {}, debug() {} } }
const fakeSessions = new Map()
const writes = []
const kills = []
terminalManager.create = (id, cwd) => {
  const session = { id, cwd, events: new EventEmitter(), title: 'audit-fake-pty' }
  fakeSessions.set(id, session)
  return session
}
terminalManager.get = (id) => fakeSessions.get(id)
terminalManager.write = (id, data) => writes.push({ id, data })
terminalManager.resize = () => {}
terminalManager.kill = (id) => { kills.push(id); fakeSessions.delete(id) }
async function jwt(tenant) {
  return new SignJWT({ tenantId: tenant, roles: ['viewer'] }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('synthetic-' + tenant).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET))
}
const tokenA = await jwt('audit-a')
const tokenB = await jwt('audit-b')
let receiver
try {
  await probe('API-anonymous-auth-enabled', async () => {
    const response = await app.inject('/api/v1/security/mode?sessionId=anonymous-audit')
    result('API-anonymous-auth-enabled', response.json().code === 200, { code: response.json().code, authEnabled: true, instanceTokenConfigured: false })
  })
  await probe('API-instance-token-negative-control', async () => {
    process.env.AETHER_INSTANCE_TOKEN = 'audit-only-instance-token'
    const response = await app.inject('/api/v1/security/mode?sessionId=anonymous-audit')
    result('API-instance-token-negative-control', response.statusCode !== 401, { httpStatus: response.statusCode })
    delete process.env.AETHER_INSTANCE_TOKEN
  })
  await probe('API-viewer-mutates-global-network-policy', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/security/network-policy', headers: { authorization: `Bearer ${tokenB}` }, payload: { blockPrivateIP: false } })
    result('API-viewer-mutates-global-network-policy', response.json().data?.blockPrivateIP === false, { code: response.json().code, suppliedRole: 'viewer' })
    const { saveNetworkPolicy, DEFAULT_NETWORK_POLICY } = await source('security/network-policy.ts')
    await saveNetworkPolicy(DEFAULT_NETWORK_POLICY)
  })
  await probe('API-anonymous-mode-escalation', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/security/mode', payload: { sessionId: 'anonymous-audit', mode: 'full-access' } })
    result('API-anonymous-mode-escalation', getSecurityMode('default', 'anonymous-audit') === 'full-access', { code: response.json().code })
  })
  await probe('API-cross-tenant-terminal', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/terminal/create', headers: { authorization: `Bearer ${tokenA}` }, payload: { sessionId: 'session-a' } })
    const id = created.json().data?.terminalId
    if (!id) throw new Error('fixture terminal not created')
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = app.server.address().port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/terminal/ws/${id}`, { headers: { authorization: `Bearer ${tokenB}` } })
    const data = []
    socket.on('message', chunk => data.push(JSON.parse(chunk.toString())))
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    fakeSessions.get(id).events.emit('data', 'AUDIT_FAKE_PTY_OUTPUT')
    socket.send(JSON.stringify({ type: 'input', data: 'AUDIT_FAKE_PTY_INPUT' }))
    // Wait on actual input/output delivery, bounded to avoid an audit hanging.
    const end = Date.now() + 2000
    while (Date.now() < end && (!writes.length || !data.length)) await new Promise(resolve => setTimeout(resolve, 10))
    result('API-cross-tenant-terminal-read-write', writes.some(value => value.id === id) && data.some(value => value.data === 'AUDIT_FAKE_PTY_OUTPUT'), { owner: 'audit-a', caller: 'audit-b', pty: 'stubbed; real route/auth/WebSocket' })
    socket.terminate()
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/terminal/${id}`, headers: { authorization: `Bearer ${tokenB}` } })
    result('API-cross-tenant-terminal-delete', kills.includes(id), { code: deleted.json().code, pty: 'stubbed' })
  })
  await probe('POLICY-tenant-session-key-collision', async () => {
    setSecurityMode('audit:a', 'session', 'full-access')
    result('POLICY-tenant-session-key-collision', getSecurityMode('audit', 'a:session') === 'full-access', 'Distinct tenant/session pairs share colon-joined key')
  })
  await probe('PATH-session-id-traversal', async () => {
    const escaped = workspaceManager.getPath({ tenantId: 'audit-a', sessionId: '../../outside' })
    checked(escaped)
    const relative = path.relative(process.env.WORKSPACE_ROOT, escaped)
    result('PATH-session-id-traversal', relative.startsWith('..'), { outsideWorkspaceRoot: relative.startsWith('..'), noWritePerformed: true })
  })
  await probe('PATH-direct-traversal-negative-control', async () => {
    let denied = false
    try { workspaceManager.resolveSafePath(ctx, path.join(outside, 'canary.txt')) } catch { denied = true }
    result('PATH-direct-traversal-negative-control', !denied, { denied })
  })
  await probe('API-session-traversal-read', async () => {
    const query = new URLSearchParams({ sessionId: '../../outside', path: 'canary.txt' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace/file/content?' + query, headers: { authorization: `Bearer ${tokenA}` } })
    result('API-session-traversal-read', response.json().data?.content === 'AUDIT_ONLY_OUTSIDE_CANARY', { code: response.json().code, canaryRead: response.json().data?.content === 'AUDIT_ONLY_OUTSIDE_CANARY' })
  })
  await probe('API-junction-file-read', async () => {
    const link = checked(path.join(ownRoot, 'linked-outside'))
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const query = new URLSearchParams({ sessionId: 'session-a', path: 'linked-outside/canary.txt' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace/file/content?' + query, headers: { authorization: `Bearer ${tokenA}` } })
    result('API-junction-file-read', response.json().data?.content === 'AUDIT_ONLY_OUTSIDE_CANARY', { code: response.json().code, canaryRead: response.json().data?.content === 'AUDIT_ONLY_OUTSIDE_CANARY' })
  })
  await probe('API-workspace-binding-cross-tenant', async () => {
    fs.writeFileSync(checked(path.join(ownRoot, 'owner-canary.txt')), 'AUDIT_ONLY_OWNER_CANARY')
    const bound = await app.inject({ method: 'POST', url: '/api/v1/workspace/bind', headers: { authorization: `Bearer ${tokenB}` }, payload: { sessionId: 'session-b', workspaceRoot: ownRoot } })
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace/file/content?' + new URLSearchParams({ sessionId: 'session-b', path: 'owner-canary.txt' }), headers: { authorization: `Bearer ${tokenB}` } })
    result('API-workspace-binding-cross-tenant', response.json().data?.content === 'AUDIT_ONLY_OWNER_CANARY', { bindingCode: bound.json().code, readCode: response.json().code, owner: 'audit-a', caller: 'audit-b' })
  })
  await probe('POLICY-safe-interpreter-outside-read-write', async () => {
    const marker = checked(path.join(outside, 'cmd-marker.txt'))
    const script = checked(path.join(ownRoot, 'probe.cjs'))
    fs.writeFileSync(script, `const fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(path.join(outside, 'canary.txt'))},'utf8')==='AUDIT_ONLY_OUTSIDE_CANARY')fs.writeFileSync(${JSON.stringify(marker)},'audit');`)
    const response = await cmdTool.execute({ command: 'node', args: ['probe.cjs'], cwd: ownRoot, timeoutMs: 5000 }, ctx)
    result('POLICY-safe-interpreter-outside-read-write', fs.existsSync(marker), { toolSuccess: response.success, markerExists: fs.existsSync(marker), needsConfirmation: response.needsConfirmation ?? false })
  })
  await probe('NETWORK-safe-guard-vs-interpreter', async () => {
    let hits = 0
    receiver = createServer((_request, response) => { hits++; response.end('AUDIT_LOOPBACK_ONLY') })
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${receiver.address().port}/audit`
    let denied = false
    try { await guardedHttp(url, ctx, 'audit') } catch { denied = true }
    result('NETWORK-safe-guard-negative-control', !denied || hits !== 0, { denied, hits })
    const script = checked(path.join(ownRoot, 'network.cjs'))
    fs.writeFileSync(script, `require('node:http').get(${JSON.stringify(url)},r=>r.resume());`)
    const response = await cmdTool.execute({ command: 'node', args: ['network.cjs'], cwd: ownRoot, timeoutMs: 5000 }, ctx)
    result('NETWORK-safe-interpreter-bypass', hits > 0, { hits, toolSuccess: response.success, destination: 'audit-owned loopback only' })
  })
} finally {
  receiver?.closeAllConnections()
  if (receiver) await new Promise(resolve => receiver.close(resolve))
  await app.close()
  await commandJobs.shutdown('Audit complete')
  dbModule.getDb().close()
  const report = { createdAt: new Date().toISOString(), fixture, scope: 'Actual engine source; isolated DB; terminal route PTY stub; real command child processes',
    sourceHashes: Object.fromEntries(['terminal/index.ts','api/http/routes/terminal.ts','security/policy-engine.ts','auth/middleware.ts','workspace/manager.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(engine,'src',file))).digest('hex')])), findings }
  fs.writeFileSync(path.join(root, 'docs/sandbox-api-audit-results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(findings, null, 2))
  process.exitCode = findings.some(item => item.status === 'inconclusive') ? 1 : findings.some(item => item.status === 'vulnerable') ? 2 : 0
  // Keep fixture evidence available for review. No recursive cleanup is performed here.
}
