/** Pure scheduling regression: execute the actual Git live-sync module with a
 * deterministic clock. No Electron window, Git process or network is required. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'

type LiveSync = typeof import('../src/renderer/src/core/git/live-sync')
type Listener = () => void
type Stream = { type: string; payload: { fileChange?: unknown; toolResult?: unknown; toolEnd?: unknown } }

function fixture() {
  let now = 0
  let serial = 0
  const timers = new Map<number, { due: number; run: Listener }>()
  const layoutListeners = new Set<Listener>()
  const workspaceListeners = new Set<Listener>()
  const connectionListeners = new Set<Listener>()
  const streamListeners = new Set<(event: Stream) => void>()
  const documentListeners = new Map<string, Set<Listener>>()
  const windowListeners = new Map<string, Set<Listener>>()
  const layout = { sidebarVisible: true, activeView: 'git' }
  const workspace = { root: '/tenant/first-session' }
  const connection = { key: 'remote:first-account', generation: 1 }
  const document = {
    visibilityState: 'visible',
    addEventListener: (name: string, listener: Listener) => add(documentListeners, name, listener),
    removeEventListener: (name: string, listener: Listener) => documentListeners.get(name)?.delete(listener)
  }
  const state = { operation: '', committing: false, status: { revision: 0 } }
  const disk = { revision: 0 }
  const calls: { root: string; background?: boolean }[] = []
  const io = { wait: async (): Promise<void> => {} }
  let active = 0
  let maxActive = 0

  function add(map: Map<string, Set<Listener>>, name: string, listener: Listener): void {
    if (!map.has(name)) map.set(name, new Set())
    map.get(name)!.add(listener)
  }
  function subscribe<T>(set: Set<T>, listener: T): () => void {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const imports: Record<string, unknown> = {
    '../engine/client': { onStreamEvent: (listener: (event: Stream) => void) => subscribe(streamListeners, listener) },
    '../engine/source': { getEngineSource: () => connection.generation, isRemoteEngine: () => true },
    '../platform/layout-state': { getLayout: () => layout, onLayoutChanged: (listener: Listener) => subscribe(layoutListeners, listener) },
    '../workspace/connection': { workspaceConnectionKey: () => connection.key, onWorkspaceConnectionChanged: (listener: Listener) => subscribe(connectionListeners, listener) },
    '../workspace/workspace-store': { getWorkspaceState: () => workspace, onWorkspaceChanged: (listener: Listener) => subscribe(workspaceListeners, listener) },
    './git-store': {
      getGitState: () => state,
      refreshGit: async (root: string, options: { background?: boolean }) => {
        calls.push({ root, ...options })
        maxActive = Math.max(maxActive, ++active)
        try {
          await io.wait()
          if (state.status.revision !== disk.revision) state.status = { revision: disk.revision }
        } finally { active-- }
      }
    }
  }
  const filename = resolve(__dirname, '../src/renderer/src/core/git/live-sync.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, Date: { now: () => now }, document,
    window: {
      addEventListener: (name: string, listener: Listener) => add(windowListeners, name, listener),
      removeEventListener: (name: string, listener: Listener) => windowListeners.get(name)?.delete(listener)
    },
    setTimeout: (run: Listener, ms: number) => { const id = ++serial; timers.set(id, { due: now + ms, run }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name in imports) return imports[name]
      throw new Error(`Unexpected Git live-sync dependency: ${name}`)
    }
  }, { filename })

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
  const stop = (module.exports as LiveSync).wireGitLiveSync()
  return {
    state, disk, calls, io, advance, stop, timers, layout, document, workspace, connection,
    maxActive: () => maxActive,
    setVisibility: (visibility: string) => { document.visibilityState = visibility; emit(documentListeners.get('visibilitychange') ?? new Set()) },
    changeLayout: () => emit(layoutListeners),
    changeConnection: () => emit(connectionListeners),
    focus: () => emit(windowListeners.get('focus') ?? new Set()),
    toolEnd: () => { for (const listener of streamListeners) listener({ type: 'payload', payload: { toolEnd: {} } }) }
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
  await f.advance(0)
  expect(f.calls).toHaveLength(2)
  expect(f.maxActive()).toBe(1)
  f.stop()
  f.focus()
  f.toolEnd()
  await f.advance(60_000)
  expect(f.calls).toHaveLength(2)
  expect(f.timers.size).toBe(0)
})
