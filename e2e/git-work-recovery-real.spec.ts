/**
 * Real engine/remote transport Git recovery probe.
 *
 * This intentionally does not reuse the legacy Git workspace fixture.  It
 * creates its own repository, binds a Work-shaped session through the live
 * engine, leaves a verified orphan lease behind, and proves that status can
 * recover and retry without a manual process restart.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { AetherIdeApi } from '../src/preload'
import type { GitLeaseResult, GitStatusResult } from '../src/shared/git-types'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtures = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '../ai-agent-engine')
const sessionId = `work-git-recovery-${randomUUID()}`
const instance = `work-git-recovery-instance-${randomUUID()}`
let fixture = ''
let workspaceRoot = ''
let workspace = ''
let baseUrl = ''
let engine: ChildProcess | undefined
let app: ElectronApplication | undefined
let page: Page

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    else { clearTimeout(timer); resolve() }
  })
}

type EngineResult<T> = { ok: boolean; code: number; message?: string; data?: T }
async function request<T>(input: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown }): Promise<EngineResult<T>> {
  return page.evaluate(value => window.aether.engine.request<T>(value), input)
}

async function bind(): Promise<{ root: string; epoch: string }> {
  const response = await request<{ workspaceRoot: string; bindingEpoch: string }>({
    method: 'POST', path: '/workspace/bind', body: { sessionId, workspaceRoot: workspace }
  })
  expect(response.ok, response.message).toBe(true)
  expect(response.data?.workspaceRoot).toBeTruthy()
  expect(response.data?.bindingEpoch).toBeTruthy()
  return { root: response.data!.workspaceRoot, epoch: response.data!.bindingEpoch }
}

async function status(binding: { root: string; epoch: string }): Promise<EngineResult<GitStatusResult>> {
  return request<GitStatusResult>({
    method: 'GET', path: '/git/status', query: { sessionId, cwd: '.', expectedRoot: binding.root, bindingEpoch: binding.epoch }
  })
}

/** Spawn a real engine lease owner and terminate it without releasing the lock. */
async function createOrphanLease(lockFile: string): Promise<{ generation: string; owner: ChildProcess }> {
  const moduleUrl = pathToFileURL(join(engineRoot, 'dist', 'workspace', 'repository-lease.js')).href
  const script = `import { acquireRepositoryLease } from ${JSON.stringify(moduleUrl)}; const file=process.argv[1]; const lease=await acquireRepositoryLease(file); console.log(JSON.stringify({generation:lease.owner.generation})); setInterval(()=>{},1000)`
  const owner = spawn(process.execPath, ['--input-type=module', '--eval', script, lockFile], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let diagnostics = ''
  owner.stdout?.on('data', chunk => { output += String(chunk) })
  owner.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  await expect.poll(() => output.trim() || diagnostics.trim() || (owner.exitCode === null ? '' : `child exited ${owner.exitCode}`), { timeout: 15_000 }).not.toBe('')
  if (!output.trim()) throw new Error(`孤儿租约 owner 未建立：${diagnostics || `exit ${owner.exitCode}`}`)
  const record = JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as { generation?: string }
  expect(record.generation).toMatch(/^[0-9a-f-]{36}$/i)
  await expect.poll(() => existsSync(lockFile), { timeout: 5_000 }).toBe(true)
  owner.kill('SIGTERM')
  await new Promise<void>(resolve => owner.once('close', () => resolve()))
  expect(existsSync(lockFile)).toBe(true)
  return { generation: record.generation!, owner }
}

test.describe.serial('Work Git 真实孤儿租约恢复', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtures, { recursive: true })
    fixture = mkdtempSync(join(fixtures, 'git-work-recovery-'))
    workspaceRoot = join(fixture, 'workspace-root')
    workspace = join(workspaceRoot, 'project')
    mkdirSync(workspaceRoot)
    mkdirSync(workspace)
    git(workspace, 'init', '-b', 'main')
    git(workspace, 'config', 'user.name', 'Aether Git Recovery')
    git(workspace, 'config', 'user.email', 'git-recovery@example.invalid')
    git(workspace, 'config', 'commit.gpgSign', 'false')
    writeFileSync(join(workspace, 'tracked.txt'), 'baseline\n')
    git(workspace, 'add', '--', 'tracked.txt')
    git(workspace, 'commit', '-m', 'recovery fixture')
    writeFileSync(join(workspace, 'tracked.txt'), 'pending change\n')

    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    const output: string[] = []
    engine = spawn(process.execPath, [join(engineRoot, 'dist', 'main.js')], {
      cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...environment, AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instance,
        ENCRYPTION_KEY: 'e'.repeat(64), PORT: String(port), HOST: '127.0.0.1',
        DATA_DIR: join(fixture, 'engine.db'), MEMORY_DB_PATH: join(fixture, 'memory.db'),
        AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: workspaceRoot,
        AETHER_ALLOWED_WORKSPACE_ROOTS: workspaceRoot, MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
        SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false'
      }
    })
    engine.stdout?.on('data', chunk => output.push(String(chunk)))
    engine.stderr?.on('data', chunk => output.push(String(chunk)))
    await expect.poll(async () => {
      if (engine?.exitCode !== null) throw new Error('真实 Git 验收引擎提前退出：' + output.join('').slice(-3000))
      return fetch(baseUrl + '/health').then(response => response.status).catch(() => 0)
    }, { timeout: 90_000 }).toBe(200)

    const profile = join(fixture, 'desktop')
    mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: baseUrl, remoteWorkspaceRoot: '',
      autoStartEngine: true, lastFolder: '', lastSessionId: '', thinkingMode: 'off'
    }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...environment, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance } })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toBeVisible()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    await stop(engine)
    if (fixture) {
      const name = fixture.slice(fixtures.length + 1)
      if (sep && (!name.startsWith('git-work-recovery-') || name.includes(sep))) throw new Error('Unsafe Git recovery fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('Work 绑定状态在孤儿锁恢复后可刷新并完成真实 Git 重试', async () => {
    const binding = await bind()
    const initial = await status(binding)
    expect(initial.ok, initial.message).toBe(true)
    expect(initial.data).toMatchObject({ success: true, isRepo: true })
    expect(initial.data?.files?.map(file => file.path)).toEqual(['tracked.txt'])

    const lockFile = join(workspace, '.git', '.aether-operation.lock')
    const orphan = await createOrphanLease(lockFile)
    const blocked = await status(binding)
    expect(blocked.ok).toBe(false)
    expect(`${blocked.message ?? ''} ${JSON.stringify(blocked.data)}`).toContain('Git operation left a verified orphan lease')

    const lease = await request<GitLeaseResult>({ method: 'GET', path: '/git/lease', query: { sessionId, cwd: '.', expectedRoot: binding.root, bindingEpoch: binding.epoch } })
    expect(lease.ok, lease.message).toBe(true)
    expect(lease.data?.lease).toMatchObject({ busy: true, recoverable: true, generation: orphan.generation })

    const recovered = await request<GitLeaseResult>({
      method: 'POST', path: '/git/action', body: { sessionId, cwd: '.', op: 'recover-lease', generation: orphan.generation, expectedRoot: binding.root, bindingEpoch: binding.epoch }
    })
    expect(recovered.ok, recovered.message).toBe(true)
    expect(existsSync(`${lockFile}.recovered-${orphan.generation}.json`)).toBe(true)
    expect(existsSync(`${lockFile}.recovered-${orphan.generation}.json.audit.json`)).toBe(true)

    const retried = await status(binding)
    expect(retried.ok, retried.message).toBe(true)
    expect(retried.data).toMatchObject({ success: true, isRepo: true })
    expect(retried.data?.files).toEqual([expect.objectContaining({ path: 'tracked.txt', unstagedChange: 'modified' })])
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('pending change\n')
  })
})
