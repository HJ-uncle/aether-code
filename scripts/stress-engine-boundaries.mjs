/**
 * Bounded high-pressure regression for the fixed HTTP boundary.
 * Uses a disposable engine process, synthetic JWTs and fake workspace data.
 * It checks that concurrent unauthorized/RBAC/path requests stay rejected,
 * the process remains healthy, and shutdown completes without a leaked child.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const repo = path.resolve(import.meta.dirname, '..')
const engine = path.resolve(repo, '../ai-agent-engine/dist/main.js')
if (!fs.existsSync(engine)) throw new Error(`Engine build missing: ${engine}`)
const fixture = fs.mkdtempSync(path.join(repo, '.e2e-tmp', 'stress-engine-'))
const workspace = path.join(fixture, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(fixture, 'outside.txt'), 'STRESS_OUTSIDE_CANARY')
const instanceToken = 'stress-instance-token'
const jwtSecret = 'stress-jwt-secret-that-is-only-used-in-this-fixture'

function base64url(value) { return Buffer.from(value).toString('base64url') }
async function jwt(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 }))
  const data = `${header}.${body}`
  const key = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(jwtSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.webcrypto.subtle.sign('HMAC', key, Buffer.from(data))).toString('base64url')
  return `${data}.${signature}`
}
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function waitForHealth(url, child) {
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`engine exited during startup: ${child.exitCode}`)
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).status === 200) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('engine health timeout')
}
async function batch(count, fn) {
  const values = await Promise.all(Array.from({ length: count }, (_, index) => fn(index)))
  return { count: values.length, bad: values.filter(Boolean).length }
}

const port = await freePort()
const url = `http://127.0.0.1:${port}`
const admin = await jwt({ tenantId: 'stress-admin', sub: 'stress-admin', roles: ['admin'] })
const viewer = await jwt({ tenantId: 'stress-viewer', sub: 'stress-viewer', roles: ['viewer'] })
const child = spawn(process.execPath, [engine], {
  cwd: fixture,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), AUTH_ENABLED: 'true',
    AETHER_INSTANCE_TOKEN: instanceToken, JWT_SECRET: jwtSecret,
    DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'private'),
    AETHER_ALLOWED_WORKSPACE_ROOTS: workspace, AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false', DEFAULT_SECURITY_MODE: 'safe',
    LOG_LEVEL: 'silent', NODE_ENV: 'production', MAX_ITERATIONS: '2',
  },
})
let output = ''
child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000) })
child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000) })
const checks = []
try {
  await waitForHealth(url, child)
  const instance = { 'x-aether-instance-token': instanceToken }
  const viewerHeaders = { ...instance, authorization: `Bearer ${viewer}`, 'content-type': 'application/json' }
  const adminHeaders = { ...instance, authorization: `Bearer ${admin}`, 'content-type': 'application/json' }
  for (let round = 0; round < 3; round++) {
    checks.push({ name: `anonymous-${round}`, ...(await batch(256, async () => {
      try { return (await fetch(`${url}/api/v1/tools`, { signal: AbortSignal.timeout(5000) })).status !== 401 } catch { return true }
    })) })
    checks.push({ name: `viewer-network-policy-${round}`, ...(await batch(128, async () => {
      try {
        const response = await fetch(`${url}/api/v1/security/network-policy`, { method: 'PUT', headers: viewerHeaders, body: JSON.stringify({ blockPrivateIP: false }), signal: AbortSignal.timeout(5000) })
        const body = await response.json()
        return response.status !== 200 || body.code !== 41015
      } catch { return true }
    })) })
    checks.push({ name: `viewer-mode-${round}`, ...(await batch(128, async index => {
      try {
        const response = await fetch(`${url}/api/v1/security/mode`, { method: 'PUT', headers: viewerHeaders, body: JSON.stringify({ sessionId: `stress-${index}`, mode: 'full-access' }), signal: AbortSignal.timeout(5000) })
        const body = await response.json()
        return response.status !== 200 || body.code !== 41015
      } catch { return true }
    })) })
    checks.push({ name: `path-traversal-${round}`, ...(await batch(128, async () => {
      try {
        const query = new URLSearchParams({ sessionId: '../../outside', path: 'outside.txt' })
        const response = await fetch(`${url}/api/v1/workspace/file/content?${query}`, { headers: adminHeaders, signal: AbortSignal.timeout(5000) })
        const body = await response.json()
        return body.data?.content === 'STRESS_OUTSIDE_CANARY'
      } catch { return true }
    })) })
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    if (health.status !== 200) throw new Error(`health failed after round ${round}: ${health.status}`)
  }
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve() }, 10_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
const failures = checks.filter(check => check.bad > 0)
const shutdownClean = child.exitCode === 0 || child.signalCode === 'SIGTERM'
console.log(JSON.stringify({ rounds: 3, requests: checks.reduce((sum, item) => sum + item.count, 0), checks, failures, childExitCode: child.exitCode, childSignal: child.signalCode, outputTail: output.slice(-1000) }, null, 2))
if (failures.length || !shutdownClean) process.exitCode = 1
