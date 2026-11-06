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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
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

function repositoryFingerprint(cwd: string): string {
  return createHash('sha256').update(JSON.stringify({
    head: git(cwd, 'rev-parse', 'HEAD'),
    status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
    index: git(cwd, 'ls-files', '--stage'),
    staged: git(cwd, 'diff', '--cached', '--binary'),
    unstaged: git(cwd, 'diff', '--binary')
  })).digest('hex')
}

interface OrphanBinding {
  generation: string
  resource: { file: string; generation: string; pid: number }
  snapshot: { root: string; epoch: string }
}

/** The real manager supplies the session generation; a killed owner cannot run
 * either lease's release. The reserved repository lease still requires native
 * PID/birth and named-job verification before the recovery API can archive it. */
async function createOrphanBindingLease(targetSession: string, binding: { root: string; epoch: string }, lockFile: string): Promise<OrphanBinding> {
  const managerUrl = pathToFileURL(join(engineRoot, 'dist', 'workspace', 'manager.js')).href
  const repositoryUrl = pathToFileURL(join(engineRoot, 'dist', 'workspace', 'repository-lease.js')).href
  const prefix = 'AETHER_BINDING_ORPHAN '
  const script = `
    import { WorkspaceManager } from ${JSON.stringify(managerUrl)};
    import { acquireRepositoryLease } from ${JSON.stringify(repositoryUrl)};
    const [sessionId, root, epoch, file] = process.argv.slice(1);
    const manager = new WorkspaceManager(process.env.WORKSPACE_ROOT);
    await manager.withBindingLease({ tenantId: 'default', sessionId }, { root, epoch }, async binding => {
      const lease = await acquireRepositoryLease(file, 0, { ...binding.resource, root: binding.snapshot.root, epoch: binding.snapshot.epoch });
      console.log(${JSON.stringify(prefix)} + JSON.stringify({ generation: lease.owner.generation, resource: binding.resource, snapshot: binding.snapshot }));
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `
  const owner = spawn(process.execPath, ['--input-type=module', '--eval', script, targetSession, binding.root, binding.epoch, lockFile], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AUTH_ENABLED: 'false', WORKSPACE_ROOT: workspaceRoot,
      AETHER_ALLOWED_WORKSPACE_ROOTS: workspaceRoot, DATA_DIR: join(fixture, 'engine.db'),
      AETHER_WORKSPACE_BINDINGS_FILE: join(fixture, 'workspace-bindings.json') }
  })
  let output = ''
  let diagnostics = ''
  owner.stdout?.on('data', chunk => { output += String(chunk) })
  owner.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  owner.on('error', error => { diagnostics += error.message })
  const recordLine = () => output.split(/\r?\n/).slice(0, -1).find(line => line.startsWith(prefix))
  try {
    await expect.poll(() => Boolean(recordLine()) || owner.exitCode !== null || owner.signalCode !== null, { timeout: 15_000 }).toBe(true)
    const line = recordLine()
    if (!line) throw new Error(`旧会话租约 owner 未建立：${diagnostics || `exit ${owner.exitCode}`}`)
    const record = JSON.parse(line.slice(prefix.length)) as OrphanBinding
    expect(record.generation).toMatch(/^[0-9a-f-]{36}$/i)
    expect(record.resource.generation).toMatch(/^[0-9a-f-]{36}$/i)
    expect(record.resource.pid).toBe(owner.pid)
    expect(record.snapshot).toEqual(binding)
    expect(existsSync(record.resource.file)).toBe(true)
    expect(existsSync(lockFile)).toBe(true)
    await stop(owner)
    expect(existsSync(record.resource.file)).toBe(true)
    expect(existsSync(lockFile)).toBe(true)
    return record
  } finally { await stop(owner) }
}

function recoverRepositoryWithNativeAudit(lockFile: string, generation: string): void {
  const repositoryUrl = pathToFileURL(join(engineRoot, 'dist', 'workspace', 'repository-lease.js')).href
  const script = `
    import { repositoryLeaseStatus, recoverRepositoryLease } from ${JSON.stringify(repositoryUrl)};
    const [file, generation] = process.argv.slice(1);
    const state = repositoryLeaseStatus(file);
    if (!state.recoverable || !state.native?.verified) throw new Error(JSON.stringify(state));
    recoverRepositoryLease(file, generation);
  `
  execFileSync(process.execPath, ['--input-type=module', '--eval', script, lockFile, generation], {
    cwd: fixture, windowsHide: true, encoding: 'utf8', timeout: 15_000
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
    engine = spawn(process.execPath, [process.env.AETHER_E2E_ENGINE_ENTRY || join(engineRoot, 'dist', 'main.js')], {
      cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...environment, AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instance,
        ENCRYPTION_KEY: 'e'.repeat(64), PORT: String(port), HOST: '127.0.0.1',
        DATA_DIR: join(fixture, 'engine.db'), MEMORY_DB_PATH: join(fixture, 'memory.db'),
        AETHER_WORKSPACE_BINDINGS_FILE: join(fixture, 'workspace-bindings.json'),
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
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env: { ...environment, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance } })
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

  test('仓库已恢复但旧会话绑定丢失时，重新绑定可自动清理残留会话锁并快速读取 Git', async ({}, info) => {
    const abandonedSession = `work-git-abandoned-${randomUUID()}`
    const abandonedWorkspace = join(workspaceRoot, 'abandoned-project')
    mkdirSync(abandonedWorkspace)
    git(abandonedWorkspace, 'init', '-b', 'main')
    git(abandonedWorkspace, 'config', 'user.name', 'Aether Git Recovery')
    git(abandonedWorkspace, 'config', 'user.email', 'git-recovery@example.invalid')
    git(abandonedWorkspace, 'config', 'commit.gpgSign', 'false')
    writeFileSync(join(abandonedWorkspace, 'interrupted.txt'), 'before interruption\n')
    git(abandonedWorkspace, 'add', '--', 'interrupted.txt')
    git(abandonedWorkspace, 'commit', '-m', 'abandoned session fixture')
    writeFileSync(join(abandonedWorkspace, 'interrupted.txt'), 'after interruption\n')
    const untouched = repositoryFingerprint(workspace)
    const beforeRecovery = repositoryFingerprint(abandonedWorkspace)
    const selected = await request<{ workspaceRoot: string; bindingEpoch: string }>({
      method: 'POST', path: '/workspace/bind', body: { sessionId: abandonedSession, workspaceRoot: abandonedWorkspace }
    })
    expect(selected.ok, selected.message).toBe(true)
    expect(selected.data?.bindingEpoch).toMatch(/^[0-9a-f-]{36}$/i)
    const oldBinding = { root: selected.data!.workspaceRoot, epoch: selected.data!.bindingEpoch }
    const lockFile = join(abandonedWorkspace, '.git', '.aether-operation.lock')
    const orphan = await createOrphanBindingLease(abandonedSession, oldBinding, lockFile)
    const heldBinding = readFileSync(orphan.resource.file)

    // Recover only the repository, as an earlier recovery attempt would have
    // done. The second half must independently verify the surviving binding.
    recoverRepositoryWithNativeAudit(lockFile, orphan.generation)
    const archive = `${lockFile}.recovered-${orphan.generation}.json`
    expect(existsSync(lockFile)).toBe(false)
    expect(JSON.parse(readFileSync(archive, 'utf8'))).toMatchObject({
      owner: { pid: orphan.resource.pid },
      bindingLease: { ...orphan.resource, root: oldBinding.root, epoch: oldBinding.epoch }
    })
    expect(JSON.parse(readFileSync(archive + '.audit.json', 'utf8')).state.native).toMatchObject({
      verified: true, ownerAlive: false, jobExists: false, activeProcesses: 0
    })
    expect(readFileSync(orphan.resource.file)).toEqual(heldBinding)

    const bindingsFile = join(fixture, 'workspace-bindings.json')
    const persisted = JSON.parse(readFileSync(bindingsFile, 'utf8')) as {
      version: number
      bindings: Array<{ tenantId: string; sessionId: string; workspaceRoot: string; epoch?: string }>
    }
    const belongsToInterruptedSession = (entry: typeof persisted.bindings[number]) => entry.tenantId === 'default' && entry.sessionId === abandonedSession
    expect(persisted.bindings.filter(belongsToInterruptedSession)).toEqual([
      { tenantId: 'default', sessionId: abandonedSession, workspaceRoot: oldBinding.root, epoch: oldBinding.epoch }
    ])
    const unrelatedBindings = persisted.bindings.filter(entry => !belongsToInterruptedSession(entry))
    const temporary = `${bindingsFile}.fixture-${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ ...persisted, bindings: unrelatedBindings }) + '\n')
    renameSync(temporary, bindingsFile)
    expect(JSON.parse(readFileSync(bindingsFile, 'utf8')).bindings).toEqual(unrelatedBindings)
    expect(existsSync(orphan.resource.file)).toBe(true)

    const started = Date.now()
    const rebound = await request<{ workspaceRoot: string; bindingEpoch: string }>({
      method: 'POST', path: '/workspace/bind', body: { sessionId: abandonedSession, workspaceRoot: abandonedWorkspace }
    })
    const bindElapsed = Date.now() - started
    const timingPath = info.outputPath('binding-recovery-timing.json')
    mkdirSync(dirname(timingPath), { recursive: true })
    writeFileSync(timingPath, JSON.stringify({ bindElapsed, ok: rebound.ok, message: rebound.message }, null, 2))
    await info.attach('binding-recovery-timing', { path: timingPath, contentType: 'application/json' })
    expect(rebound.ok, rebound.message).toBe(true)
    expect(rebound.data?.workspaceRoot).toBe(oldBinding.root)
    expect(rebound.data?.bindingEpoch).toMatch(/^[0-9a-f-]{36}$/i)
    expect(rebound.data?.bindingEpoch).not.toBe(oldBinding.epoch)
    expect(existsSync(orphan.resource.file)).toBe(false)
    expect(readFileSync(`${orphan.resource.file}.recovered-${orphan.resource.generation}.json`)).toEqual(heldBinding)
    const statusStarted = Date.now()
    const refreshed = await request<GitStatusResult>({
      method: 'GET', path: '/git/status', query: {
        sessionId: abandonedSession, cwd: '.', expectedRoot: rebound.data!.workspaceRoot, bindingEpoch: rebound.data!.bindingEpoch
      }
    })
    const statusElapsed = Date.now() - statusStarted
    writeFileSync(timingPath, JSON.stringify({ bindElapsed, statusElapsed, ok: rebound.ok && refreshed.ok }, null, 2))
    expect(refreshed.ok, refreshed.message).toBe(true)
    expect(refreshed.data).toMatchObject({ success: true, isRepo: true })
    expect(refreshed.data?.files).toEqual([expect.objectContaining({ path: 'interrupted.txt', unstagedChange: 'modified' })])
    expect(bindElapsed, 'verified stale binding must not consume the 30 second lease wait').toBeLessThan(5_000)
    expect(statusElapsed, 'Git status must not queue behind the old session lease').toBeLessThan(5_000)
    expect(repositoryFingerprint(abandonedWorkspace)).toBe(beforeRecovery)
    expect(repositoryFingerprint(workspace)).toBe(untouched)
    const finalBindings = JSON.parse(readFileSync(bindingsFile, 'utf8')) as typeof persisted
    expect(finalBindings.bindings.filter(entry => !belongsToInterruptedSession(entry))).toEqual(unrelatedBindings)
  })
})
