/** Pure scheduling regression: execute the actual Git live-sync module with a
 * deterministic clock. No Electron window, Git process or network is required. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'

type LiveSync = typeof import('../src/renderer/src/core/git/live-sync')
type Listener = () => void
type Stream = { type: string; streamId: string; payload: { fileChange?: unknown; toolResult?: unknown; toolEnd?: unknown } }

function fixture(work = false, ready = true) {
  let now = 0
  let serial = 0
  const timers = new Map<number, { due: number; run: Listener }>()
  const layoutListeners = new Set<Listener>()
  const modeListeners = new Set<Listener>()
  const workspaceListeners = new Set<Listener>()
  const connectionListeners = new Set<Listener>()
  const streamListeners = new Set<(event: Stream) => void>()
  const snapshotListeners = new Set<(snapshot: { phase: string }) => void>()
  const documentListeners = new Map<string, Set<Listener>>()
  const windowListeners = new Map<string, Set<Listener>>()
  const layout = { sidebarVisible: true, activeView: 'git' }
  const mode = { value: work ? 'work' : 'code' }
  const host = { active: true, sessionId: 'first-session', source: 1 }
  const workspace = { root: '/tenant/first-session' }
  const connection = { key: 'remote:first-account', generation: 1, ready }
  const document = {
    visibilityState: 'visible',
    addEventListener: (name: string, listener: Listener) => add(documentListeners, name, listener),
    removeEventListener: (name: string, listener: Listener) => documentListeners.get(name)?.delete(listener)
  }
  const state = { operation: '', committing: false, loaded: true, loading: false, errorMessage: '', status: { revision: 0 } }
  const disk = { revision: 0 }
  const calls: { root: string; background?: boolean }[] = []
  const callTimes: number[] = []
  const io = { wait: async (): Promise<void> => {} }
  let active = 0
  let maxActive = 0
  let autoFetch = false

  function add(map: Map<string, Set<Listener>>, name: string, listener: Listener): void {
    if (!map.has(name)) map.set(name, new Set())
    map.get(name)!.add(listener)
  }
  function subscribe<T>(set: Set<T>, listener: T): () => void {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const imports: Record<string, unknown> = {
    '../engine/client': {
      onStreamEvent: (listener: (event: Stream) => void) => subscribe(streamListeners, listener),
      onSnapshot: (listener: (snapshot: { phase: string }) => void) => subscribe(snapshotListeners, listener)
    },
    '../engine/source': { getEngineSource: () => connection.generation, isRemoteEngine: () => true, isEngineReady: () => connection.ready },
    '../platform/app-mode': { getAppMode: () => mode.value, onAppModeChanged: (listener: Listener) => subscribe(modeListeners, listener) },
    '../platform/layout-state': { getLayout: () => layout, onLayoutChanged: (listener: Listener) => subscribe(layoutListeners, listener) },
    '../workspace/connection': { workspaceConnectionKey: () => connection.key, captureWorkspaceTarget: () => ({ sessionId: 'first-session' }), onWorkspaceConnectionChanged: (listener: Listener) => subscribe(connectionListeners, listener) },
    '../workspace/workspace-store': { getWorkspaceState: () => workspace, onWorkspaceChanged: (listener: Listener) => subscribe(workspaceListeners, listener) },
    './git-store': { codeGitStore: {
      getGitState: () => state,
      startGitAutoFetch: () => { autoFetch = true },
      stopGitAutoFetch: () => { autoFetch = false },
      refreshGit: async (root: string, options: { background?: boolean }) => {
        calls.push({ root, ...options })
        callTimes.push(now)
        maxActive = Math.max(maxActive, ++active)
        try {
          await io.wait()
          if (state.status.revision !== disk.revision) state.status = { revision: disk.revision }
        } finally { active-- }
      }
    } }
  }
  const modules = new Map<string, object>()
  const environment = {
    Date: { now: () => now }, document, queueMicrotask,
    window: {
      addEventListener: (name: string, listener: Listener) => add(windowListeners, name, listener),
      removeEventListener: (name: string, listener: Listener) => windowListeners.get(name)?.delete(listener)
    },
    setTimeout: (run: Listener, ms: number) => { const id = ++serial; timers.set(id, { due: now + ms, run }); return id },
    clearTimeout: (id: number) => timers.delete(id)
  }
  const load = (relative: string): object => {
    const cached = modules.get(relative)
    if (cached) return cached
    const filename = resolve(__dirname, '../src/renderer/src/core/git', relative + '.ts')
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    modules.set(relative, module.exports)
    runInNewContext(code, {
      ...environment, module, exports: module.exports,
      require: (name: string) => {
        if (name in imports) return imports[name]
        if (['./store-live-sync', './live-sync-scheduler', '../engine/stream-owner'].includes(name)) return load(name)
        throw new Error(`Unexpected Git live-sync dependency: ${name}`)
      }
    }, { filename })
    return module.exports
  }
  const owner = load('../engine/stream-owner') as typeof import('../src/renderer/src/core/engine/stream-owner')
  owner.registerStreamOwner('code-stream', { source: 1, sessionId: 'first-session', profile: 'code' })

  const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms
    await flush()
    for (let turns = 0; turns < 100; turns++) {
      const next = [...timers].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
      if (!next) { now = end; return }
      now = next[1].due
      timers.delete(next[0])
      next[1].run()
      await flush()
    }
    throw new Error('Git live-sync scheduled an unbounded timer loop')
  }
  const emit = (set: Set<Listener>): void => { for (const listener of set) listener() }
  const stop = work
    ? (load('./store-live-sync') as typeof import('../src/renderer/src/core/git/store-live-sync')).wireGitStoreLiveSync({
      store: (imports['./git-store'] as { codeGitStore: Parameters<typeof import('../src/renderer/src/core/git/store-live-sync').wireGitStoreLiveSync>[0]['store'] }).codeGitStore,
      target: () => JSON.stringify([host.source, connection.generation, host.sessionId, workspace.root]),
      cwd: () => workspace.root,
      profile: 'general',
      sessionId: () => host.sessionId,
      eligible: () => host.active && mode.value === 'work' && host.source === connection.generation && connection.ready && connection.key !== 'remote:unavailable',
      subscribe: wake => {
        const mode = subscribe(modeListeners, wake), connection = subscribe(connectionListeners, wake)
        return () => { mode(); connection() }
      }
    })
    : (load('./live-sync') as LiveSync).wireGitLiveSync()
  return {
    state, disk, calls, callTimes, io, advance, stop, timers, layout, document, workspace, connection, owner, host,
    autoFetch: () => autoFetch,
    maxActive: () => maxActive,
    setVisibility: (visibility: string) => { document.visibilityState = visibility; emit(documentListeners.get('visibilitychange') ?? new Set()) },
    changeLayout: () => emit(layoutListeners),
    changeConnection: () => emit(connectionListeners),
    readiness: (ready: boolean) => {
      for (const listener of snapshotListeners) listener({ phase: ready ? 'ready' : 'starting' })
      // Deliberately publish after the Git listener, as React effect order can.
      connection.ready = ready
    },
    changeMode: (value: string) => { mode.value = value; emit(modeListeners) },
    focus: () => emit(windowListeners.get('focus') ?? new Set()),
    toolEnd: (streamId = 'code-stream') => { for (const listener of streamListeners) listener({ type: 'payload', streamId, payload: { toolEnd: {} } }) }
  }
}

test('可见 Git/资源树检测外部变化，隐藏窗口或离开侧栏停止轮询，重新显示立即更新', async () => {
  const f = fixture()
  try {
    await f.advance(0)
    expect(f.calls).toEqual([{ root: '/tenant/first-session', background: true }])
    f.disk.revision = 1
    await f.advance(8_000)
    expect(f.state.status.revision).toBe(1)

    f.setVisibility('hidden')
    const hiddenCount = f.calls.length
    f.disk.revision = 2
    await f.advance(60_000)
    expect(f.calls).toHaveLength(hiddenCount)
    expect(f.state.status.revision).toBe(1)
    f.setVisibility('visible')
    await f.advance(0)
    expect(f.calls).toHaveLength(hiddenCount + 1)
    expect(f.state.status.revision).toBe(2)

    f.layout.activeView = 'search'
    f.changeLayout()
    const searchCount = f.calls.length
    f.disk.revision = 3
    await f.advance(60_000)
    expect(f.calls).toHaveLength(searchCount)
    f.layout.activeView = 'explorer'
    f.changeLayout()
    await f.advance(0)
    expect(f.state.status.revision).toBe(3)
    expect(f.calls).toHaveLength(searchCount + 1)
  } finally { f.stop() }
  expect(f.timers.size).toBe(0)
})

test('Git 写操作期间不并发查询，结束后恢复同步；远端断开期间不请求', async () => {
  const f = fixture()
  try {
    f.state.operation = 'stage'
    await f.advance(8_000)
    expect(f.calls).toEqual([])
    f.state.operation = ''
    f.state.committing = true
    await f.advance(8_000)
    expect(f.calls).toEqual([])
    f.state.committing = false
    f.disk.revision = 1
    await f.advance(8_000)
    expect(f.state.status.revision).toBe(1)
    f.connection.key = 'remote:unavailable'
    f.changeConnection()
    const disconnectedCount = f.calls.length
    await f.advance(60_000)
    expect(f.calls).toHaveLength(disconnectedCount)
    f.connection.key = 'remote:next-account'
    f.connection.generation++
    f.workspace.root = '/tenant/next-session'
    f.changeConnection()
    await f.advance(0)
    expect(f.calls.at(-1)).toEqual({ root: '/tenant/next-session', background: true })
    expect(f.calls).toHaveLength(disconnectedCount + 1)
  } finally { f.stop() }
})

test('聚焦和工具结束事件在慢请求期间不重叠；释放连接后补刷且销毁不残留轮询', async () => {
  const f = fixture()
  let release!: () => void
  const pending = new Promise<void>(done => { release = done })
  f.io.wait = () => pending
  await f.advance(0)
  expect(f.calls).toHaveLength(1)
  f.focus()
  f.toolEnd()
  f.toolEnd()
  await f.advance(100)
  expect(f.calls).toHaveLength(1)
  expect(f.maxActive()).toBe(1)
  f.io.wait = async () => {}
  release()
  await f.advance(250)
  expect(f.calls).toHaveLength(2)
  expect(f.maxActive()).toBe(1)
  f.stop()
  f.focus()
  f.toolEnd()
  await f.advance(60_000)
  expect(f.calls).toHaveLength(2)
  expect(f.timers.size).toBe(0)
})

test('Code 与 Work 共用模式/可见性边界，新 Work 占位 loading 不阻塞首刷', async () => {
  for (const work of [false, true]) {
    const f = fixture(work)
    try {
      f.state.loaded = false
      f.state.loading = true
      await f.advance(0)
      expect(f.calls).toHaveLength(1)
      expect(f.autoFetch()).toBe(true)
      f.changeMode(work ? 'code' : 'work')
      expect(f.autoFetch()).toBe(false)
      expect(f.timers.size).toBe(0)
      f.focus()
      await f.advance(60_000)
      expect(f.calls).toHaveLength(1)
      f.changeMode(work ? 'work' : 'code')
      await f.advance(0)
      expect(f.calls).toHaveLength(2)
      if (work) {
        f.host.active = false
        f.changeConnection()
        await f.advance(60_000)
        expect(f.calls).toHaveLength(2)
        expect(f.autoFetch()).toBe(false)
        f.host.active = true
        f.changeConnection()
        await f.advance(0)
        expect(f.calls).toHaveLength(3)
      }
    } finally { f.stop() }
  }
})

test('Work 工具信号精确匹配会话、模式和引擎代际，未知流只由兜底轮询读取', async () => {
  const f = fixture(true)
  try {
    await f.advance(300)
    f.owner.registerStreamOwner('other-task', { source: 1, sessionId: 'other-session', profile: 'general' })
    f.toolEnd('other-task')
    f.toolEnd('unknown-stream')
    f.toolEnd('code-stream')
    await f.advance(100)
    expect(f.calls).toHaveLength(1)
    f.owner.registerStreamOwner('work-stream', { source: 1, sessionId: 'first-session', profile: 'general' })
    for (let i = 0; i < 125; i++) f.toolEnd('work-stream')
    await f.advance(79)
    expect(f.calls).toHaveLength(1)
    await f.advance(1)
    expect(f.calls).toHaveLength(2)

    f.connection.generation = 2
    f.changeConnection()
    f.toolEnd('work-stream')
    await f.advance(20_000)
    expect(f.calls).toHaveLength(2)
    expect(f.timers.size).toBe(0)
    f.host.source = 2
    f.host.sessionId = 'second-session'
    f.workspace.root = '/tenant/second-session'
    f.changeConnection()
    await f.advance(0)
    expect(f.calls.at(-1)?.root).toBe('/tenant/second-session')
    f.toolEnd('work-stream')
    await f.advance(300)
    expect(f.calls).toHaveLength(3)
  } finally { f.stop() }
})

test('Work 慢请求只补刷一次并按耗时冷却，隐藏期间完成不会复活定时器', async () => {
  const f = fixture(true)
  let release!: () => void
  f.io.wait = () => new Promise<void>(done => { release = done })
  try {
    await f.advance(0)
    for (let i = 0; i < 25; i++) f.focus()
    await f.advance(650)
    expect(f.calls).toHaveLength(1)
    f.io.wait = async () => {}
    release()
    await f.advance(649)
    expect(f.calls).toHaveLength(1)
    await f.advance(1)
    expect(f.calls).toHaveLength(2)
    expect(f.maxActive()).toBe(1)

    f.io.wait = () => new Promise<void>(done => { release = done })
    f.focus()
    await f.advance(250)
    expect(f.calls).toHaveLength(3)
    f.setVisibility('hidden')
    release()
    await f.advance(60_000)
    expect(f.timers.size).toBe(0)
    expect(f.calls).toHaveLength(3)
    f.io.wait = async () => {}
    f.setVisibility('visible')
    await f.advance(0)
    expect(f.calls).toHaveLength(4)
  } finally { f.stop() }
})

test('失败指数退避且聚焦不绕过背压，成功或会话切换恢复正常轮询', async () => {
  const f = fixture(true)
  try {
    f.state.errorMessage = 'engine busy'
    await f.advance(0)
    for (const wait of [2_500, 5_000, 10_000, 20_000, 30_000]) {
      const count = f.calls.length
      for (let i = 0; i < 30; i++) f.focus()
      await f.advance(wait - 1)
      expect(f.calls).toHaveLength(count)
      await f.advance(1)
      expect(f.calls).toHaveLength(count + 1)
    }
    expect(f.callTimes).toEqual([0, 2_500, 7_500, 17_500, 37_500, 67_500])
    f.state.errorMessage = ''
    f.host.sessionId = 'recovered-session'
    f.changeConnection()
    await f.advance(0)
    expect(f.calls).toHaveLength(7)
    await f.advance(5_000)
    expect(f.calls).toHaveLength(8)
    // A rejected transport read is also caught and backed off.
    f.io.wait = async () => { throw new Error('transport unavailable') }
    f.focus()
    await f.advance(250)
    const count = f.calls.length
    f.focus()
    await f.advance(2_499)
    expect(f.calls).toHaveLength(count)
    await f.advance(1)
    expect(f.calls).toHaveLength(count + 1)
  } finally { f.stop() }
})

test('在途请求切会话只补当前目标一次，旧目标完成不沿用旧延迟或待刷新位', async () => {
  const f = fixture(true)
  let release!: () => void
  f.io.wait = () => new Promise<void>(done => { release = done })
  try {
    await f.advance(0)
    f.host.sessionId = 'new-session'
    f.workspace.root = '/tenant/new-session'
    f.changeConnection()
    f.focus()
    await f.advance(800)
    expect(f.calls).toHaveLength(1)
    f.io.wait = async () => {}
    release()
    await f.advance(0)
    expect(f.calls.map(call => call.root)).toEqual(['/tenant/first-session', '/tenant/new-session'])
    await f.advance(800)
    expect(f.calls).toHaveLength(2)
    expect(f.maxActive()).toBe(1)
  } finally { f.stop() }
})

test('同代际引擎恢复就绪立即补刷，重复ready快照不重置空闲退避', async () => {
  const f = fixture(true, false)
  try {
    await f.advance(60_000)
    expect(f.calls).toEqual([])
    expect(f.timers.size).toBe(0)
    f.readiness(true)
    await f.advance(0)
    expect(f.calls).toHaveLength(1)
    expect(f.autoFetch()).toBe(true)
    for (let index = 0; index < 50; index++) f.readiness(true)
    await f.advance(4_999)
    expect(f.calls).toHaveLength(1)
    await f.advance(1)
    expect(f.calls).toHaveLength(2)
    f.readiness(false)
    await f.advance(10_000)
    expect(f.calls).toHaveLength(2)
    expect(f.autoFetch()).toBe(false)
    expect(f.timers.size).toBe(0)
    f.readiness(true)
    await f.advance(0)
    expect(f.calls).toHaveLength(3)
  } finally { f.stop() }
  f.readiness(true)
  await f.advance(60_000)
  expect(f.calls).toHaveLength(3)
  expect(f.timers.size).toBe(0)
})
