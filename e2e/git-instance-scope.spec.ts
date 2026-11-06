/** Pure store contracts: Code/Work isolation, progressive refresh, retained drafts, history caching/races, serialized reads and safe orphan recovery. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import type { GitLogEntry, GitLogResult, GitResult, GitStashEntry, GitStatusResult } from '../src/shared/git-types'
import { codeGitStore } from '../src/renderer/src/core/git/git-store'
import { createGitStore, type GitStore } from '../src/renderer/src/core/git/git-store-instance'
import { captureSessionGitTarget, GitRequestError } from '../src/renderer/src/core/git/git-target'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import { buildHistoryViewModels } from '../src/renderer/src/core/git/git-history-graph'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function status(name: string): GitStatusResult {
  return {
    success: true,
    isRepo: true,
    files: [
      {
        path: `${name}.txt`,
        changeType: 'modified',
        staged: true,
        stagedChange: 'modified',
        unstagedChange: null,
        additions: 1,
        deletions: 0,
        binary: false
      }
    ]
  }
}
function history(symbol: string, subject: string): GitLogResult {
  const hash = symbol.repeat(40)
  return {
    success: true,
    commits: [{ hash, shortHash: hash.slice(0, 7), subject, author: 'History Author', date: '2026-11-05', parents: [] }]
  }
}
function historyRows(count: number, label: string): GitLogEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const hash = (index + 1).toString(16).padStart(40, '0')
    return { hash, shortHash: hash.slice(-7), subject: `${label} ${index}`, author: 'History Author', date: '2026-11-05', parents: [] }
  })
}
const branch = {
  success: true,
  info: { branch: 'main', upstream: null, ahead: null, behind: null }
}
let previousWindow: PropertyDescriptor | undefined
let previousStorage: PropertyDescriptor | undefined
let stores: GitStore[]
let calls: Array<{ session: string; op: string; body?: Record<string, unknown>; query?: EngineRequestInput['query'] }>
let bindings: string[]
let bindingEpoch: string
let remote: (session: string, op: string, body?: Record<string, unknown>, query?: EngineRequestInput['query']) => Promise<unknown>

function task(session: string, onCapture?: () => void): GitStore {
  const store = createGitStore({
    initialCwd: '/same/path',
    draftKey: `task:${session}`,
    identity: () => JSON.stringify([getEngineSource(), session]),
    captureTarget: () => {
      onCapture?.()
      return captureSessionGitTarget(session, '')
    }
  })
  stores.push(store)
  return store
}

test.beforeEach(async () => {
  stores = []
  calls = []
  bindings = []
  bindingEpoch = 'epoch-1'
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    }
  })
  remote = async (session, op) => {
    if (op === 'status') return status(session)
    if (op === 'branch-info') return branch
    if (op === 'lease') return { success: true, lease: { busy: false, recoverable: false } }
    return { success: true }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      aether: {
        git: { status: async () => status('code'), branchInfo: async () => branch, listStashes: async () => ({ success: true, stashes: [] }) },
        engine: {
          request: async (input: EngineRequestInput) => {
            const body = input.body as Record<string, unknown> | undefined
            const session = String(input.query?.sessionId ?? body?.sessionId ?? '')
            if (input.path === '/git/binding') {
              bindings.push(session)
              return {
                ok: true,
                code: 200,
                message: '',
                data: {
                  root: `/tasks/${session}`,
                  epoch: bindingEpoch,
                  contractVersion: 2,
                  mutationRequiresBinding: true
                }
              }
            }
            const op = String(body?.op ?? input.path.slice('/git/'.length))
            calls.push({ session, op, body, query: input.query })
            return { ok: true, code: 200, message: '', data: await remote(session, op, body, input.query) }
          }
        }
      }
    }
  })
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready' })
  await codeGitStore.refreshGit(null)
})

test.afterEach(async () => {
  for (const store of stores) store.disposeGitStore()
  await codeGitStore.refreshGit(null)
  codeGitStore.disposeGitStore()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('Code 与同路径的两个 Work 任务分别保留状态、草稿和写操作目标', async () => {
  const a = task('a'),
    b = task('b')
  await Promise.all([
    codeGitStore.refreshGit('/code'),
    a.refreshGit('/same/path'),
    b.refreshGit('/same/path')
  ])
  a.setCommitMessage('task A draft')
  b.setCommitMessage('task B draft')
  codeGitStore.setCommitMessage('Code draft')
  const revision = a.getCommitDraftRevision()
  await a.refreshGit('/same/path')
  expect(a.getCommitDraftRevision()).toBe(revision)
  expect((await a.stage('a.txt')).success).toBe(true)
  expect(calls.filter((call) => call.op === 'stage')).toEqual([
    expect.objectContaining({
      session: 'a',
      body: expect.objectContaining({ path: 'a.txt', expectedRoot: '/tasks/a' })
    })
  ])
  expect(a.getGitState().files.map((file) => file.path)).toEqual(['a.txt'])
  expect(b.getGitState().files.map((file) => file.path)).toEqual(['b.txt'])
  expect(codeGitStore.getGitState().files.map((file) => file.path)).toEqual(['code.txt'])
  expect([
    a.getGitState().commitMessage,
    b.getGitState().commitMessage,
    codeGitStore.getGitState().commitMessage
  ]).toEqual(['task A draft', 'task B draft', 'Code draft'])
})

test('任务首轮刷新立即发布文件，并共用一次捕获完成慢分支读取', async () => {
  let captures = 0
  const a = task('a', () => { captures++ }), gate = deferred<typeof branch>()
  remote = async (session, op) => op === 'branch-info' ? gate.promise : status(session)
  const pending = a.refreshGit('/same/path')
  try {
    await expect.poll(() => calls.filter(call => call.op === 'branch-info').length).toBe(1)
    expect(a.getGitState()).toMatchObject({ loaded: true, loading: true, isRepo: true, errorMessage: '' })
    expect(a.getGitState().files.map(file => file.path)).toEqual(['a.txt'])
    expect(a.getGitState().status?.changes.map(file => file.path)).toEqual(['a.txt'])
    expect(captures).toBe(1)
    expect(bindings).toEqual(['a', 'a', 'a', 'a'])
  } finally {
    gate.resolve(branch)
    await pending
  }
  expect(a.getGitState()).toMatchObject({ loaded: true, loading: false, branch: 'main', errorMessage: '' })
  // Capture plus the pre/post guards for status, branch and stash all remain.
  expect(bindings).toEqual(['a', 'a', 'a', 'a', 'a', 'a', 'a'])
  expect(captures).toBe(1)
})

test('任务后台文件变化而分支未变时同步更新状态，后续相同快照保持引用', async () => {
  const a = task('a')
  await a.refreshGit('/same/path')
  const before = a.getGitState()
  const snapshots: Array<ReturnType<GitStore['getGitState']>> = []
  const unsubscribe = a.onGitChanged(() => snapshots.push(a.getGitState()))
  remote = async (_session, op) => op === 'status' ? status('updated') : branch
  try {
    await a.refreshGit('/same/path', { background: true })
    const updated = a.getGitState()
    expect(snapshots).toHaveLength(1)
    expect(updated.loading).toBe(false)
    expect(updated.status).toEqual({ isRepo: true, branch: 'main', ahead: null, behind: null, changes: updated.files })
    expect(updated.status?.changes).toBe(updated.files)
    expect(updated.files.map(file => file.path)).toEqual(['updated.txt'])
    expect(before.files.map(file => file.path)).toEqual(['a.txt'])
    await a.refreshGit('/same/path', { background: true })
    expect(a.getGitState()).toBe(updated)
    expect(snapshots).toHaveLength(1)
  } finally {
    unsubscribe()
  }
})

test('手动与后台刷新读取外部存储变化，文件分支未变也更新且相同记录不重渲染', async () => {
  const a = task('a')
  let externalStashes: GitStashEntry[] = []
  remote = async (session, op) => op === 'status' ? status(session)
    : op === 'list-stashes' ? { success: true, stashes: externalStashes } : branch
  await a.refreshGit('/same/path')
  expect(a.getGitState().stashes).toEqual([])
  externalStashes = [{ index: 0, hash: 'a'.repeat(40), message: 'On main: external stash', date: '2026-11-05T12:00:00+08:00' }]
  await a.refreshGit('/same/path')
  expect(a.getGitState().stashes).toEqual(externalStashes)
  const before = a.getGitState()
  await a.refreshGit('/same/path', { background: true })
  expect(a.getGitState()).toBe(before)
  externalStashes = []
  await a.refreshGit('/same/path', { background: true })
  expect(a.getGitState().stashes).toEqual([])
  expect(a.getGitState().files).toBe(before.files)
  expect(a.getGitState().status).toBe(before.status)
  expect(a.getGitState().errorMessage).toBe('')
})

test('刷新存储失败保留上次记录并明确报错，不发布为空或成功', async () => {
  const a = task('a')
  const saved: GitStashEntry[] = [{ index: 0, hash: 'b'.repeat(40), message: 'On main: saved checkpoint' }]
  remote = async (session, op) => op === 'status' ? status(session)
    : op === 'list-stashes' ? { success: true, stashes: saved } : branch
  await a.refreshGit('/same/path')
  const fallback = remote
  remote = async (session, op, body) => op === 'list-stashes'
    ? { success: false, error: 'stash unavailable' } : fallback(session, op, body)
  await a.refreshGit('/same/path', { background: true })
  expect(a.getGitState().stashes).toEqual(saved)
  expect(a.getGitState()).toMatchObject({ loaded: true, loading: false, errorMessage: 'stash unavailable' })
})

for (const throws of [false, true]) {
  test(`任务分支${throws ? '请求异常' : '失败信封'}保留本轮文件和此前分支，显示错误`, async () => {
    const a = task('a')
    await a.refreshGit('/same/path')
    remote = async (_session, op) => {
      if (op === 'status') return status('updated')
      if (throws) throw new Error('branch unavailable')
      return { success: false, error: 'branch unavailable' }
    }
    await a.refreshGit('/same/path')
    expect(a.getGitState()).toMatchObject({ loaded: true, loading: false, isRepo: true, branch: 'main', errorMessage: 'branch unavailable' })
    expect(a.getGitState().files.map(file => file.path)).toEqual(['updated.txt'])
    expect(a.getGitState().status).toMatchObject({ isRepo: true, branch: 'main', changes: [expect.objectContaining({ path: 'updated.txt' })] })
  })
}

test('同轮状态发布后绑定变化仍拒绝分支读取，不重新捕获并接受新工作区', async () => {
  let captures = 0
  const a = task('a', () => { captures++ })
  const unsubscribe = a.onGitChanged(() => {
    if (a.getGitState().loaded) bindingEpoch = 'epoch-2'
  })
  try {
    await a.refreshGit('/same/path')
  } finally {
    unsubscribe()
  }
  expect(calls.map(call => call.op)).toEqual(['status'])
  expect(captures).toBe(1)
  expect(a.getGitState()).toMatchObject({ loaded: true, loading: false, isRepo: true, branch: '' })
  expect(a.getGitState().files.map(file => file.path)).toEqual(['a.txt'])
  expect(a.getGitState().errorMessage).toContain('工作区已重新绑定')
})

test('视图取消订阅后提交仍归原任务，完成时保留操作期间编辑的新草稿', async () => {
  const a = task('a'),
    b = task('b'),
    gate = deferred<GitResult>()
  await Promise.all([a.refreshGit('/same/path'), b.refreshGit('/same/path')])
  remote = async (session, op) =>
    op === 'commit' ? gate.promise : op === 'status' ? status(session) : branch
  a.setCommitMessage('original draft')
  const unsubscribe = a.onGitChanged(() => undefined)
  const pending = a.commit()
  await expect.poll(() => calls.filter((call) => call.op === 'commit').length).toBe(1)
  unsubscribe()
  a.setCommitMessage('new draft')
  b.setCommitMessage('other task')
  expect(a.getGitState().repositoryOperation?.getSnapshot().pending).toBe('run')
  expect(b.getGitState().operation).toBe('')
  gate.resolve({ success: true })
  expect((await pending).success).toBe(true)
  expect(a.getGitState().commitMessage).toBe('new draft')
  expect(a.getGitState().repositoryOperation?.getSnapshot().phase).toBe('succeeded')
  expect(b.getGitState().commitMessage).toBe('other task')
})

test('AI 建议预约跨视图保留，并阻止同任务写入', async () => {
  const a = task('a')
  await a.refreshGit('/same/path')
  const release = a.beginSuggestion()
  expect(release).not.toBeNull()
  expect(a.beginSuggestion()).toBeNull()
  expect((await a.stage('a.txt')).success).toBe(false)
  expect(calls.filter((call) => call.op === 'stage')).toHaveLength(0)
  a.setCommitProposal('generated proposal')
  release!()
  expect(a.getGitState().operation).toBe('')
  expect(a.getGitState().commitProposal).toBe('generated proposal')
})

test('任务刷新等待正在执行的写操作，避免争抢同一仓库租约', async () => {
  const a = task('a'),
    gate = deferred<GitResult>()
  await a.refreshGit('/same/path')
  remote = async (session, op) =>
    op === 'stage' ? gate.promise : op === 'status' ? status(session) : branch
  const pending = a.stage('a.txt')
  await expect.poll(() => calls.filter((call) => call.op === 'stage').length).toBe(1)
  const before = calls.filter((call) => call.op === 'status').length
  const refresh = a.refreshGit('/same/path')
  await Promise.resolve()
  expect(calls.filter((call) => call.op === 'status')).toHaveLength(before)
  gate.resolve({ success: true })
  await Promise.all([pending, refresh])
  expect(calls.filter((call) => call.op === 'status').length).toBeGreaterThan(before)
  expect(a.getGitState().errorMessage).toBe('')
})

test('只凭可恢复且有 generation 的孤儿租约自动恢复一次', async () => {
  const a = task('a')
  let recovered = false
  remote = async (session, op, body) => {
    if (op === 'status')
      return recovered
        ? status(session)
        : { success: false, errorCode: 'git-orphan', error: 'orphan' }
    if (op === 'lease')
      return {
        success: true,
        lease: { busy: true, recoverable: true, generation: 'owned-generation' }
      }
    if (op === 'recover-lease') {
      expect(body?.generation).toBe('owned-generation')
      recovered = true
      return { success: true, lease: { busy: false, recoverable: false } }
    }
    return branch
  }
  await a.refreshGit('/same/path')
  expect(a.getGitState().isRepo).toBe(true)
  expect(calls.filter((call) => call.op === 'recover-lease')).toHaveLength(1)
})

test('任务新建分支依次创建并切换，两个写操作使用同一个冻结目标', async () => {
  const a = task('a'), gate = deferred<GitResult>()
  remote = async (_session, op) => op === 'create-branch' ? gate.promise : { success: true }
  const client = await a.getClient()
  const pending = client.gitCreateBranch('feature/new', 'base-ref')
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0].op).toBe('create-branch')
  gate.resolve({ success: true })
  expect((await pending).success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['create-branch', 'checkout'])
  for (const call of calls) {
    expect(call.session).toBe('a')
    expect(call.body).toMatchObject({ branch: 'feature/new', cwd: '.', expectedRoot: '/tasks/a', bindingEpoch: 'epoch-1' })
  }
  expect(calls[0].body?.ref).toBe('base-ref')
})

test('新建分支失败时保持原失败信封，不能继续切换', async () => {
  const failure: GitResult = { success: false, error: 'branch rejected', executionDisposition: 'not_started', errorCode: 'git-busy' }
  remote = async () => failure
  const result = await (await task('a').getClient()).gitCreateBranch('feature/new')
  expect(result).toEqual(failure)
  expect(calls.map(call => call.op)).toEqual(['create-branch'])
})

for (const mode of ['result', 'throw'] as const) {
  test(`分支已创建后 checkout ${mode} 失败不能把整个命令标为未开始`, async () => {
    remote = async (_session, op) => {
      if (op === 'create-branch') return { success: true }
      const failure: GitResult = { success: false, error: 'checkout blocked', executionDisposition: 'not_started', errorCode: 'git-busy' }
      if (mode === 'throw') throw new GitRequestError(failure)
      return failure
    }
    const result = await (await task('a').getClient()).gitCreateBranch('feature/new')
    expect(calls.map(call => call.op)).toEqual(['create-branch', 'checkout'])
    expect(result).toMatchObject({ success: false, executionDisposition: 'may_have_effects' })
    expect(result.error).toContain('已创建，但切换失败')
    expect(result.error).toContain('checkout blocked')
  })
}

test('推送到远程未指定分支时读取原任务当前分支，指定分支不增加读取', async () => {
  const client = await task('a').getClient()
  expect((await client.gitPushTo('backup')).success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['branch-info', 'push-to'])
  expect(calls[1].body).toMatchObject({ remote: 'backup', branch: 'main', expectedRoot: '/tasks/a' })
  calls = []
  expect((await client.gitPushTo('backup', 'feature/explicit')).success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['push-to'])
  expect(calls[0].body?.branch).toBe('feature/explicit')
})

test('分离 HEAD 时推送入口拒绝，不产生远程写入', async () => {
  remote = async () => ({ success: true, info: { branch: 'HEAD', upstream: null, ahead: null, behind: null } })
  const result = await (await task('a').getClient()).gitPushTo('backup')
  expect(result).toMatchObject({ success: false, executionDisposition: 'not_started' })
  expect(result.error).toContain('不在任何分支')
  expect(calls.map(call => call.op)).toEqual(['branch-info'])
})

for (const existing of [false, true]) {
  test(`远程分支切换${existing ? '复用已有' : '创建'}本地分支，避免分离 HEAD`, async () => {
    remote = async (_session, op) => {
      if (op === 'list-remote-branches') return { success: true, branches: ['origin/feature/topic'] }
      if (op === 'list-branches') return { success: true, branches: existing ? ['main', 'feature/topic'] : ['main'] }
      return { success: true }
    }
    const result = await (await task('a').getClient()).gitCheckout('origin/feature/topic')
    expect(result.success).toBe(true)
    expect(calls.map(call => call.op)).toEqual(existing
      ? ['list-remote-branches', 'list-branches', 'checkout']
      : ['list-remote-branches', 'list-branches', 'create-branch', 'checkout'])
    const actions = calls.filter(call => call.body)
    expect(actions.map(call => call.body?.branch)).toEqual(existing ? ['feature/topic'] : ['feature/topic', 'feature/topic'])
    if (!existing) expect(actions[0].body?.ref).toBe('origin/feature/topic')
    expect(calls.every(call => call.session === 'a')).toBe(true)
  })
}

test('带斜线的本地分支不是远程引用时仍直接切换', async () => {
  remote = async (_session, op) => op === 'list-remote-branches' ? { success: true, branches: ['origin/main'] } : { success: true }
  expect((await (await task('a').getClient()).gitCheckout('feature/local')).success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['list-remote-branches', 'checkout'])
  expect(calls[1].body?.branch).toBe('feature/local')
})

test('批量删除 stash 先去重并按索引降序，不改变调用方选择数组', async () => {
  const indexes = [0, 2, 1, 2]
  expect((await (await task('a').getClient()).gitStashDropBatch(indexes)).success).toBe(true)
  expect(calls[0].body?.indexes).toEqual([2, 1, 0])
  expect(indexes).toEqual([0, 2, 1, 2])
})

test('普通推送只有缺少上游时发布当前任务分支，其他失败不重复推送', async () => {
  const fallback = remote
  remote = async (session, op, body) => op === 'push'
    ? { success: false, error: 'The current branch main has no upstream branch.' }
    : fallback(session, op, body)
  const client = await task('a').getClient()
  expect((await client.gitPush()).success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['push', 'branch-info', 'publish-branch'])
  expect(calls[2].body).toMatchObject({ sessionId: 'a', expectedRoot: '/tasks/a' })
  calls = []
  remote = async () => ({ success: false, error: 'network unavailable' })
  expect((await client.gitPush()).error).toBe('network unavailable')
  expect(calls.map(call => call.op)).toEqual(['push'])
})

test('推送到其他分支只更改目标引用，不把目标分支当作本地源分支', async () => {
  const result = await (await task('a').getClient()).gitPushToBranch('backup', 'release/next')
  expect(result.success).toBe(true)
  expect(calls.map(call => call.op)).toEqual(['branch-info', 'push-to-branch'])
  expect(calls[1].body).toMatchObject({ remote: 'backup', branch: 'release/next', expectedRoot: '/tasks/a' })
})

test('多个远程序列推送同一分支，部分成功不可作为未开始重放', async () => {
  const gate = deferred<GitResult>(), a = task('a'), fallback = remote
  remote = async (session, op, body) => {
    if (op === 'push-to') return body?.remote === 'origin' ? gate.promise
      : { success: false, executionDisposition: 'not_started', error: 'backup unavailable' }
    return fallback(session, op, body)
  }
  const destinations = ['origin', 'backup', 'origin']
  const pending = a.pushToMany(destinations)
  destinations[1] = 'unrequested'
  await expect.poll(() => calls.filter(call => call.op === 'push-to').length).toBe(1)
  expect(calls.filter(call => call.op === 'push-to').map(call => call.body?.remote)).toEqual(['origin'])
  gate.resolve({ success: true })
  const result = await pending
  expect(result).toMatchObject({ success: false, executionDisposition: 'may_have_effects', results: [
    { remote: 'origin', ok: true }, { remote: 'backup', ok: false, error: 'backup unavailable' }
  ] })
  expect(result.error).toContain('origin：成功')
  expect(result.error).toContain('backup：失败')
  expect(a.getGitState().repositoryOperation?.getSnapshot().retryAllowed).toBe(false)
  expect(calls.filter(call => call.op === 'push-to').map(call => [call.session, call.body?.remote, call.body?.branch]))
    .toEqual([['a', 'origin', 'main'], ['a', 'backup', 'main']])
})

test('多远程全部成功返回逐项成功信息；未选择目标时不发送请求', async () => {
  const a = task('a')
  const empty = await a.pushToMany([])
  expect(empty).toMatchObject({ success: false, executionDisposition: 'not_started', results: [] })
  expect(calls).toHaveLength(0)
  const result = await a.pushToMany(['origin', 'backup'])
  expect(result).toMatchObject({ success: true, results: [{ remote: 'origin', ok: true }, { remote: 'backup', ok: true }] })
  expect(result.notice).toContain('origin：成功')
  expect(result.notice).toContain('backup：成功')
})

test('引擎切换后旧任务已完成的写入和 AI 预约解除，不保留永久忙碌实例', async () => {
  const a = task('a'), b = task('b'), gate = deferred<GitResult>()
  await Promise.all([a.refreshGit('/same/path'), b.refreshGit('/same/path')])
  const release = b.beginSuggestion()
  expect(release).not.toBeNull()
  const fallback = remote
  remote = async (session, op, body) => op === 'stage' ? gate.promise : fallback(session, op, body)
  const pending = a.stage('a.txt')
  await expect.poll(() => calls.filter(call => call.op === 'stage').length).toBe(1)
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: 'replacement' })
  gate.resolve({ success: true })
  await pending
  release!()
  expect(a.getGitState().operation).toBe('')
  expect(a.getGitState().committing).toBe(false)
  expect(a.getGitState().repositoryOperation?.getSnapshot().pending).toBeNull()
  expect(b.getGitState().operation).toBe('')
})

test('引擎切换后的后台读取安静结束，旧响应和排队失败不写入状态也不 reject', async () => {
  const a = task('a'), gate = deferred<unknown>()
  remote = async () => gate.promise
  const branches = a.loadBranches()
  await expect.poll(() => calls.some(call => call.op === 'list-branches')).toBe(true)
  const queued = [a.loadStashes(), a.loadCurrentUser(), a.loadHistoryAuthors(), a.loadLog(), a.loadRemotes(),
    a.loadTags(), a.loadRemoteBranches(), a.loadTimeline('file.txt'), a.applyLiveHunks('file.txt', 'text')]
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: 'replacement' })
  gate.resolve({ success: true, branches: ['obsolete'] })
  await expect(Promise.all([branches, ...queued])).resolves.toHaveLength(10)
  expect(a.getGitState().branches).toEqual([])
  expect(a.getGitState().errorMessage).toBe('')
})

test('当前任务后台读取失败写入错误状态，不成为未处理 Promise 拒绝', async () => {
  const a = task('a')
  remote = async () => { throw new Error('read unavailable') }
  await expect(Promise.all([a.loadStashes(), a.loadBranches(), a.loadCurrentUser(), a.loadHistoryAuthors(),
    a.loadLog(), a.loadRemotes(), a.loadTags(), a.loadRemoteBranches(), a.loadTimeline('file.txt')])).resolves.toHaveLength(9)
  expect(a.getGitState().errorMessage).toBe('read unavailable')
  expect(a.getGitState().timelineError).toBe('read unavailable')
})

for (const empty of [false, true]) {
  test(`历史同查询并发只读取一次，${empty ? '成功空历史' : '提交列表'}可从缓存复用`, async () => {
    const a = task('history-cache'), gate = deferred<GitLogResult>()
    const result: GitLogResult = empty ? { success: true, commits: [] } : history('a', 'cached history')
    remote = async () => gate.promise
    const first = a.ensureLog(50)
    const second = a.ensureLog(50)
    try {
      await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(1)
      expect(a.getGitState()).toMatchObject({ logLoaded: false, logLoading: true, logError: '' })
      gate.resolve(result)
      await Promise.all([first, second])
      expect(a.getGitState()).toMatchObject({
        commits: result.commits, logLoaded: true, logLoading: false, logExhausted: true, logError: ''
      })
      await Promise.all([a.ensureLog(50), a.ensureLog(50)])
      expect(calls.filter(call => call.op === 'log')).toHaveLength(1)
      expect(a.getGitState().commits).toEqual(result.commits)
    } finally {
      gate.resolve(result)
      await Promise.all([first, second])
    }
  })
}

for (const thrown of [false, true]) {
  test(`历史${thrown ? '异常' : '失败结果'}仅显示局部错误并保留缓存，明确重试可恢复`, async () => {
    const a = task('history-retry')
    remote = async () => history('a', 'cached before failure')
    await a.ensureLog()
    const cached = a.getGitState().commits
    remote = async () => {
      if (thrown) throw new Error('history transport unavailable')
      return { success: false, error: 'history transport unavailable' }
    }

    await expect(a.reloadLog()).resolves.toBeUndefined()
    expect(a.getGitState()).toMatchObject({
      commits: cached, logLoaded: true, logLoading: false,
      logError: 'history transport unavailable', errorMessage: ''
    })
    const attempts = calls.filter(call => call.op === 'log').length
    await a.ensureLog()
    expect(calls.filter(call => call.op === 'log')).toHaveLength(attempts)

    remote = async () => history('b', 'history retry recovered')
    await a.reloadLog()
    expect(a.getGitState()).toMatchObject({
      commits: history('b', 'history retry recovered').commits,
      logLoaded: true, logLoading: false, logError: '', errorMessage: ''
    })
    expect(calls.filter(call => call.op === 'log')).toHaveLength(attempts + 1)
  })
}

test('历史过滤 A→B→A 时旧 A 响应不能回填，也不能解除新 A 的加载状态', async () => {
  const a = task('history-aba'), oldGate = deferred<GitLogResult>(), latestGate = deferred<GitLogResult>()
  let requests = 0
  remote = async () => ++requests === 1 ? oldGate.promise : latestGate.promise
  await a.setHistoryFilter({ search: 'A' }, { reload: false })
  const first = a.loadLog()
  let latest: Promise<void> | undefined
  try {
    await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(1)
    await a.setHistoryFilter({ search: 'B' }, { reload: false })
    latest = a.setHistoryFilter({ search: 'A' })
    oldGate.resolve(history('a', 'obsolete A response'))
    await first
    await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(2)
    expect(a.getGitState()).toMatchObject({ historySearch: 'A', commits: [], logLoaded: false, logLoading: true })

    latestGate.resolve(history('b', 'current A response'))
    await latest
    expect(a.getGitState()).toMatchObject({
      commits: history('b', 'current A response').commits, logLoaded: true, logLoading: false, logError: ''
    })
  } finally {
    oldGate.resolve(history('a', 'obsolete A response'))
    latestGate.resolve(history('b', 'current A response'))
    await Promise.all([first, latest])
  }
})

test('文件刷新先完成且保留已缓存历史，延迟历史响应不占用全局加载状态', async () => {
  const a = task('history-background')
  const fallback = remote
  remote = async (session, op, body) => op === 'log'
    ? history('a', 'previous cached history') : fallback(session, op, body)
  await a.refreshGit('/same/path')
  await a.ensureLog()
  const cached = a.getGitState().commits
  const gate = deferred<GitLogResult>()
  remote = async (session, op, body) => op === 'log' ? gate.promise : fallback(session, op, body)
  let refreshDone = false
  const refresh = a.refreshGit('/same/path').then(() => { refreshDone = true })
  try {
    // The history gate is deliberately unresolved until both expectations pass.
    await expect.poll(() => refreshDone).toBe(true)
    await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(2)
    expect(a.getGitState()).toMatchObject({
      commits: cached, loaded: true, loading: false, logLoaded: true, logLoading: true,
      operation: '', errorMessage: ''
    })
    expect(a.getGitState().files.map(file => file.path)).toEqual(['history-background.txt'])

    gate.resolve(history('b', 'fresh history after status'))
    await expect.poll(() => a.getGitState().logLoading).toBe(false)
    expect(a.getGitState().commits).toEqual(history('b', 'fresh history after status').commits)
  } finally {
    gate.resolve(history('b', 'fresh history after status'))
    await refresh
    await expect.poll(() => a.getGitState().logLoading).toBe(false)
  }
})

test('同路径不同 Work 任务分别缓存历史，另一任务先完成不污染仍在加载的任务', async () => {
  const a = task('history-task-a'), b = task('history-task-b')
  const gateA = deferred<GitLogResult>(), gateB = deferred<GitLogResult>()
  remote = async session => session === 'history-task-a' ? gateA.promise : gateB.promise
  const pendingA = a.ensureLog(), pendingB = b.ensureLog()
  try {
    await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(2)
    gateB.resolve(history('b', 'task B history'))
    await pendingB
    expect(b.getGitState().commits).toEqual(history('b', 'task B history').commits)
    expect(a.getGitState()).toMatchObject({ commits: [], logLoaded: false, logLoading: true })
    gateA.resolve(history('a', 'task A history'))
    await pendingA

    await Promise.all([a.ensureLog(), b.ensureLog()])
    expect(a.getGitState().commits).toEqual(history('a', 'task A history').commits)
    expect(b.getGitState().commits).toEqual(history('b', 'task B history').commits)
    expect(calls.filter(call => call.op === 'log').map(call => call.session).sort()).toEqual([
      'history-task-a', 'history-task-b'
    ])
  } finally {
    gateA.resolve(history('a', 'task A history'))
    gateB.resolve(history('b', 'task B history'))
    await Promise.all([pendingA, pendingB])
  }
})

test('已加载550条历史时重验分两页读取，全部完成后原子替换且不截掉尾部缓存', async () => {
  const a = task('history-large-cache')
  const cachedRows = historyRows(550, 'cached'), freshRows = historyRows(550, 'revalidated')
  remote = async (_session, _op, _body, query) => ({
    success: true, commits: cachedRows.slice(Number(query?.skip ?? 0), Number(query?.skip ?? 0) + Number(query?.limit))
  })
  await a.loadLog(500)
  await a.loadLog(50, true)
  expect(a.getGitState().commits).toEqual(cachedRows)
  const cachedSnapshot = a.getGitState().commits
  calls = []
  const tail = deferred<GitLogResult>()
  remote = async (_session, _op, _body, query) => Number(query?.skip) === 500
    ? tail.promise : { success: true, commits: freshRows.slice(0, Number(query?.limit)) }
  const reload = a.reloadLog(550)
  try {
    await expect.poll(() => calls.filter(call => call.op === 'log').length).toBe(2)
    expect(calls.filter(call => call.op === 'log').map(call => ({
      offset: Number(call.query?.skip), limit: Number(call.query?.limit)
    }))).toEqual([{ offset: 0, limit: 500 }, { offset: 500, limit: 50 }])
    expect(a.getGitState().commits).toBe(cachedSnapshot)
    expect(a.getGitState()).toMatchObject({ logLoaded: true, logLoading: true, logError: '' })

    tail.resolve({ success: true, commits: freshRows.slice(500) })
    await reload
    expect(a.getGitState().commits).toEqual(freshRows)
    expect(a.getGitState().legacyCommits.map(commit => commit.subject)).toEqual(freshRows.map(commit => commit.subject))
    expect(a.getGitState()).toMatchObject({ logLoaded: true, logLoading: false, logExhausted: false, logError: '' })
    await a.ensureLog(550)
    expect(calls.filter(call => call.op === 'log')).toHaveLength(2)
  } finally {
    tail.resolve({ success: true, commits: freshRows.slice(500) })
    await reload
  }
})

test('加载更早的分页不会延长首页60秒缓存，过期后会重验已加载历史', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const a = task('history-page-ttl')
    const initial = historyRows(100, 'initial'), updated = historyRows(100, 'updated')
    let rows = initial
    remote = async (_session, _op, _body, query) => ({
      success: true, commits: rows.slice(Number(query?.skip ?? 0), Number(query?.skip ?? 0) + Number(query?.limit))
    })
    await a.ensureLog(50)
    now += 59_000
    await a.loadLog(50, true)
    expect(a.getGitState().commits).toEqual(initial)
    await a.ensureLog(100)
    expect(calls.filter(call => call.op === 'log')).toHaveLength(2)

    rows = updated
    now += 2_000
    await a.ensureLog(100)
    expect(calls.filter(call => call.op === 'log').map(call => ({
      offset: Number(call.query?.skip), limit: Number(call.query?.limit)
    }))).toEqual([
      { offset: 0, limit: 50 }, { offset: 50, limit: 50 }, { offset: 0, limit: 100 }
    ])
    expect(a.getGitState().commits).toEqual(updated)
    expect(a.getGitState()).toMatchObject({ logLoading: false, logError: '' })
  } finally {
    Date.now = originalNow
  }
})

for (const merge of [false, true]) {
  test(`旧引擎${merge ? '合并' : '线性'}历史 hash 周围换行归一化，父关系与正文保留`, async () => {
    const hashes = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]
    const payload: GitLogResult = { success: true, commits: hashes.map((hash, index) => ({
      hash: index ? `\n${hash}` : hash, shortHash: hash.slice(0, 7), subject: '  keep subject  ', body: ' \nkeep body\n ',
      author: 'test', date: '2026-11-04', parents: index === 0 && merge ? [` ${hashes[1]} `, hashes[2]]
        : index < 2 ? [hashes[index + 1]] : []
    })) }
    remote = async () => payload
    const client = await task('a').getClient()
    for (const result of [await client.gitLog(), await client.gitIncoming()]) {
      expect(result.commits?.map(commit => commit.hash)).toEqual(hashes)
      expect(result.commits?.[0].parents).toEqual(merge ? hashes.slice(1) : [hashes[1]])
      expect(result.commits?.[1].subject).toBe('  keep subject  ')
      expect(result.commits?.[1].body).toBe(' \nkeep body\n ')
      const models = buildHistoryViewModels(result.commits!, hashes[0])
      expect(models[1].inputSwimlanes.some(node => node.id === models[1].hash)).toBe(true)
      if (!merge) expect(models.map(model => model.outputSwimlanes.length)).toEqual([1, 1, 0])
      else expect(models[0].isMerge).toBe(true)
    }
    expect(payload.commits?.[1].hash).toBe(`\n${hashes[1]}`)
  })
}
