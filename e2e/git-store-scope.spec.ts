/** Store contracts: connection isolation, queued writes and silent background refresh. No Electron window. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import { DEFAULT_SETTINGS } from '../src/shared/ipc'
import type { GitBranchInfoResult, GitLeaseResult, GitResult, GitStatusResult } from '../src/shared/git-types'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import { publishWorkspaceSelection } from '../src/renderer/src/core/workspace/connection'
import { disposeGitStore, getGitState, loadBranches, onGitChanged, refreshGit, stage } from '../src/renderer/src/core/git/git-store'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function status(path: string): GitStatusResult {
  return { success: true, isRepo: true, files: [{ path, changeType: 'untracked', staged: false,
    stagedChange: null, unstagedChange: 'untracked', binary: false, additions: 0, deletions: 0 }] }
}
const branch: GitBranchInfoResult = { success: true, info: { branch: 'main', upstream: null, ahead: null, behind: null } }
let previousWindow: PropertyDescriptor | undefined
let previousStorage: PropertyDescriptor | undefined
let statusCall: (cwd: string) => Promise<GitStatusResult>
let stageCall: (cwd: string, path: string) => Promise<GitResult>
let branchesCall: () => Promise<{ success: boolean; branches: string[]; current: string }>
let leaseCall: (cwd: string) => Promise<GitLeaseResult>
let recoverCall: (cwd: string, generation: string) => Promise<GitLeaseResult>
let remoteCall: (input: EngineRequestInput) => Promise<unknown>

test.beforeEach(async () => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  } })
  statusCall = async () => status('current.txt')
  stageCall = async () => ({ success: true })
  branchesCall = async () => ({ success: true, branches: ['main'], current: 'main' })
  leaseCall = async () => ({ success: true, lease: { busy: false, recoverable: false } })
  recoverCall = async () => ({ success: false, error: 'unexpected recovery' })
  remoteCall = async (input) => {
    if (input.path === '/workspace/bind') return {}
    if (input.path === '/workspace/directory') return { root: '/remote/project', entries: [] }
    if (input.path === '/git/binding') return { root: '/remote/project', epoch: 'fixture-epoch', contractVersion: 2, mutationRequiresBinding: true }
    if (input.path === '/git/status') return status('current.txt')
    if (input.path === '/git/branch-info') return branch
    if (input.path === '/git/list-stashes') return { success: true, stashes: [] }
    if (input.path === '/git/action') return { success: true }
    throw new Error(`unexpected ${input.path}`)
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout,
    aether: {
      git: { status: (cwd: string) => statusCall(cwd), branchInfo: async () => branch,
        listStashes: async () => ({ success: true, stashes: [] }),
        leaseStatus: (cwd: string) => leaseCall(cwd),
        recoverLease: (cwd: string, generation: string) => recoverCall(cwd, generation),
        listBranches: () => branchesCall(),
        stage: (cwd: string, path: string) => stageCall(cwd, path) },
      settings: { get: async () => ({ ...DEFAULT_SETTINGS }), update: async () => ({ ...DEFAULT_SETTINGS }) },
      engine: { request: async (input: EngineRequestInput) => ({ ok: true, code: 200, message: '', data: await remoteCall(input) }) }
    }
  } })
  publishEngineSource({ mode: 'embedded', baseUrl: '', instanceId: undefined, phase: 'idle' })
  await refreshGit(null)
})

test.afterEach(async () => {
  publishEngineSource({ mode: 'embedded', baseUrl: '', instanceId: undefined, phase: 'idle' })
  await refreshGit(null)
  disposeGitStore()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('Git A→B→A 时旧请求不能覆盖重新打开的同一路径', async () => {
  const old = deferred<GitStatusResult>()
  const started = deferred<void>()
  statusCall = () => { started.resolve(); return old.promise }
  const pending = refreshGit('/repo/a')
  await started.promise
  statusCall = async () => status('fresh.txt')
  await refreshGit('/repo/b')
  await refreshGit('/repo/a')
  old.resolve(status('obsolete.txt'))
  await pending
  expect(getGitState().files.map(file => file.path)).toEqual(['fresh.txt'])
  expect(getGitState().cwd).toBe('/repo/a')
})

test('Git 旧请求失败不能清除新请求的 loading 或覆盖新错误状态', async () => {
  const old = deferred<GitStatusResult>()
  const fresh = deferred<GitStatusResult>()
  const started = deferred<void>()
  statusCall = () => { started.resolve(); return old.promise }
  const pendingOld = refreshGit('/repo/a')
  await started.promise
  statusCall = () => fresh.promise
  const pendingFresh = refreshGit('/repo/b')
  old.reject(new Error('obsolete failure'))
  await pendingOld
  expect(getGitState().loading).toBe(true)
  expect(getGitState().errorMessage).toBe('')
  fresh.resolve(status('new.txt'))
  await pendingFresh
  expect(getGitState().loading).toBe(false)
})

test('Git 排队暂存不得在切换后的工作区执行', async () => {
  await refreshGit('/repo/a')
  const started = deferred<void>()
  const finish = deferred<GitResult>()
  const calls: Array<[string, string]> = []
  stageCall = async (cwd, path) => { calls.push([cwd, path]); started.resolve(); return finish.promise }
  const first = stage('first.txt')
  await started.promise
  const queued = stage('queued.txt')
  await refreshGit('/repo/b')
  finish.resolve({ success: true })
  expect((await first).success).toBe(false)
  expect((await queued).success).toBe(false)
  expect(calls).toEqual([['/repo/a', 'first.txt']])
  expect(getGitState().cwd).toBe('/repo/b')
  expect(getGitState().errorMessage).toBe('')
  expect(getGitState().operation).toBe('')
})

test('同路径切换远端账号立即清空 Git，旧响应不能回写', async () => {
  const old = deferred<GitStatusResult>()
  const started = deferred<void>()
  const select = (accountId: string): void => {
    publishEngineSource({ mode: 'remote', baseUrl: 'http://scope.test', instanceId: 'server', accountId, phase: 'ready' })
    publishWorkspaceSelection({ ...DEFAULT_SETTINGS, lastSessionId: `session-${accountId}` }, `remote:http://scope.test:account:${accountId}`)
  }
  select('a')
  await refreshGit('/remote/project')
  expect(getGitState().files).toHaveLength(1)
  const normalRemote = remoteCall
  remoteCall = async input => {
    if (input.path === '/git/status' && input.query?.sessionId === 'session-a') {
      started.resolve()
      return old.promise
    }
    return normalRemote(input)
  }
  const pending = refreshGit('/remote/project')
  await started.promise
  select('b')
  expect(getGitState().files).toEqual([])
  expect(getGitState().branch).toBe('')
  await refreshGit('/remote/project')
  old.resolve(status('account-a-secret.txt'))
  await pending
  expect(getGitState().files.map(file => file.path)).toEqual(['current.txt'])
  expect(getGitState().errorMessage).toBe('')
})

test('Git 后台快照不变时不触发渲染，变化时无 loading 闪烁', async () => {
  await refreshGit('/repo/a')
  const before = getGitState()
  const snapshots: Array<{ loading: boolean; files: string[] }> = []
  const dispose = onGitChanged(() => snapshots.push({ loading: getGitState().loading, files: getGitState().files.map(file => file.path) }))
  try {
    await refreshGit('/repo/a', { background: true })
    expect(getGitState()).toBe(before)
    expect(snapshots).toEqual([])
    statusCall = async () => status('changed.txt')
    await refreshGit('/repo/a', { background: true })
    expect(snapshots).toEqual([{ loading: false, files: ['changed.txt'] }])
  } finally { dispose() }
})

test('本地引擎生命周期变化不清空本地 Git 快照', async () => {
  await refreshGit('/repo/a')
  const before = getGitState()
  publishEngineSource({ mode: 'embedded', baseUrl: 'http://127.0.0.1:12323', instanceId: 'new-engine', phase: 'ready' })
  expect(getGitState()).toBe(before)
  publishEngineSource({ mode: 'embedded', baseUrl: 'http://127.0.0.1:12323', instanceId: 'new-engine', phase: 'starting' })
  expect(getGitState()).toBe(before)
})

test('Git 后台刷新恢复后清除错误，仓库删除后清除旧分支', async () => {
  await refreshGit('/repo/a')
  statusCall = async () => ({ success: false, error: 'temporary lock' })
  await refreshGit('/repo/a', { background: true })
  expect(getGitState().errorMessage).toBe('temporary lock')
  statusCall = async () => status('recovered.txt')
  await refreshGit('/repo/a', { background: true })
  expect(getGitState().errorMessage).toBe('')
  expect(getGitState().files[0]?.path).toBe('recovered.txt')
  statusCall = async () => ({ success: true, isRepo: false, files: [] })
  await refreshGit('/repo/a', { background: true })
  expect(getGitState().status).toEqual({ isRepo: false, branch: '', ahead: null, behind: null, changes: [] })
  expect(getGitState().upstream).toBeNull()
})

test('Git 旧分支列表不能写入新仓库缓存', async () => {
  await refreshGit('/repo/a')
  const old = deferred<{ success: boolean; branches: string[]; current: string }>()
  branchesCall = () => old.promise
  const pending = loadBranches()
  await refreshGit('/repo/b')
  old.resolve({ success: true, branches: ['private-branch'], current: 'private-branch' })
  await pending
  expect(getGitState().branches).toEqual([])
  expect(getGitState().branch).toBe('main')
})

test('Code 原生状态只恢复已核验且有代际的孤儿占用，随后只重读状态一次', async () => {
  const calls: string[] = []
  statusCall = async cwd => {
    calls.push(`status:${cwd}`)
    return calls.filter(call => call.startsWith('status:')).length === 1
      ? { success: false, error: 'Git operation left a verified orphan lease. Recover the interrupted operation, then retry.' }
      : status('recovered.txt')
  }
  leaseCall = async cwd => {
    calls.push(`lease:${cwd}`)
    return { success: true, lease: { busy: true, recoverable: true, generation: 'native-generation' } }
  }
  recoverCall = async (cwd, generation) => {
    calls.push(`recover:${cwd}:${generation}`)
    return { success: true, lease: { busy: false, recoverable: false } }
  }
  await refreshGit('/repo/native')
  expect(calls).toEqual(['status:/repo/native', 'lease:/repo/native', 'recover:/repo/native:native-generation', 'status:/repo/native'])
  expect(getGitState().files.map(file => file.path)).toEqual(['recovered.txt'])
  expect(getGitState().errorMessage).toBe('')
})

test('Code 活跃/未知/缺代际租约不能自动恢复，恢复代际失效不能继续重读', async () => {
  for (const lease of [
    { busy: true, recoverable: false, generation: 'active' },
    { busy: true, recoverable: true },
    { busy: false, recoverable: true, generation: 'invalid' }
  ]) {
    let recoveries = 0, reads = 0
    statusCall = async () => { reads++; return { success: false, errorCode: 'git-orphan', error: 'orphan' } }
    leaseCall = async () => ({ success: true, lease })
    recoverCall = async () => { recoveries++; return { success: true, lease: { busy: false, recoverable: false } } }
    await refreshGit('/repo/native')
    expect(recoveries).toBe(0)
    expect(reads).toBe(1)
    expect(getGitState().errorMessage).toContain('可疑中断占用')
  }
  let reads = 0, recoveries = 0
  statusCall = async () => { reads++; return { success: false, errorCode: 'git-orphan', error: 'orphan' } }
  leaseCall = async () => ({ success: true, lease: { busy: true, recoverable: true, generation: 'expired' } })
  recoverCall = async (_cwd, generation) => {
    expect(generation).toBe('expired'); recoveries++
    return { success: false, error: 'generation changed' }
  }
  await refreshGit('/repo/native')
  expect(recoveries).toBe(1)
  expect(reads).toBe(1)
  expect(getGitState().errorMessage).toBe('generation changed')
})

test('Code 状态或租约核验期间切换仓库，不恢复旧占用也不借新目标恢复', async () => {
  for (const boundary of ['status', 'lease'] as const) {
    const gate = deferred<GitStatusResult & GitLeaseResult>(), started = deferred<void>()
    const calls: string[] = []
    statusCall = async cwd => {
      if (cwd !== '/repo/old') return status('fresh.txt')
      calls.push('old-status')
      if (boundary === 'status') { started.resolve(); return gate.promise }
      return { success: false, errorCode: 'git-orphan', error: 'orphan' }
    }
    leaseCall = async cwd => { calls.push(`lease:${cwd}`); started.resolve(); return gate.promise }
    recoverCall = async cwd => { calls.push(`recover:${cwd}`); return { success: true, lease: { busy: false, recoverable: false } } }
    const pending = refreshGit('/repo/old')
    await started.promise
    await refreshGit('/repo/new')
    gate.resolve(boundary === 'status'
      ? { success: false, errorCode: 'git-orphan', error: 'orphan' }
      : { success: true, lease: { busy: true, recoverable: true, generation: 'old-generation' } })
    await pending
    expect(calls).toEqual(boundary === 'status' ? ['old-status'] : ['old-status', 'lease:/repo/old'])
    expect(getGitState().cwd).toBe('/repo/new')
    expect(getGitState().files.map(file => file.path)).toEqual(['fresh.txt'])
    expect(getGitState().errorMessage).toBe('')
  }
})

test('Code 恢复后再次遇到孤儿只上报失败，不无限恢复或重放写操作', async () => {
  let reads = 0, recoveries = 0, writes = 0
  statusCall = async () => { reads++; return { success: false, errorCode: 'git-orphan', error: 'orphan persists' } }
  leaseCall = async () => ({ success: true, lease: { busy: true, recoverable: true, generation: 'once' } })
  recoverCall = async () => { recoveries++; return { success: true, lease: { busy: false, recoverable: false } } }
  stageCall = async () => { writes++; return { success: true } }
  await refreshGit('/repo/native')
  expect(reads).toBe(2)
  expect(recoveries).toBe(1)
  expect(writes).toBe(0)
  expect(getGitState().errorMessage).toBe('orphan persists')
})

