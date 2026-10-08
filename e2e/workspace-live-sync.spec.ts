/** Actual workspace scheduler with a controlled clock: local/remote identity, visible paths and disposal, without Electron. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsEntry } from '../src/shared/ipc'

type Listener = () => void
type LiveSync = typeof import('../src/renderer/src/core/workspace/live-sync')

function fixture() {
  let now = 0, serial = 0
  const timers = new Map<number, { due: number; run: Listener }>()
  const sourceListeners = new Set<Listener>(), connectionListeners = new Set<Listener>(), workspaceListeners = new Set<Listener>()
  const layoutListeners = new Set<Listener>(), visibilityListeners = new Set<Listener>()
  const streamListeners = new Set<(event: { type: string; payload: { fileChange?: unknown } }) => void>()
  const layout = { sidebarVisible: true, activeView: 'explorer' }
  const connection = { key: 'embedded', generation: 0, remote: false }
  const workspace = { root: null as string | null, children: new Map<string, FsEntry[]>(), expanded: new Set<string>() }
  const calls: string[] = []
  const io = { wait: async (): Promise<void> => {} }
  const document = { visibilityState: 'visible', addEventListener: (_name: string, listener: Listener) => visibilityListeners.add(listener), removeEventListener: (_name: string, listener: Listener) => visibilityListeners.delete(listener) }
  function subscribe<T>(set: Set<T>, listener: T) { set.add(listener); return () => { set.delete(listener) } }
  const imports: Record<string, unknown> = {
    '../engine/client': { onStreamEvent: (listener: (event: { type: string; payload: { fileChange?: unknown } }) => void) => subscribe(streamListeners, listener) },
    '../engine/source': { getEngineSource: () => connection.generation, isRemoteEngine: () => connection.remote, subscribeEngineSource: (listener: Listener) => subscribe(sourceListeners, listener) },
    '../platform/layout-state': { getLayout: () => layout, onLayoutChanged: (listener: Listener) => subscribe(layoutListeners, listener) },
    './connection': { workspaceConnectionKey: () => connection.key, onWorkspaceConnectionChanged: (listener: Listener) => subscribe(connectionListeners, listener) },
    './fs-client': { paths: { dirname: (path: string) => win32.dirname(path).replace(/\\/g, '/') } },
    './workspace-store': {
      getWorkspaceState: () => workspace,
      onWorkspaceChanged: (listener: Listener) => subscribe(workspaceListeners, listener),
      refreshDirectory: async (dir: string) => { calls.push(dir); await io.wait(); return workspace.children.get(dir) ?? [] }
    }
  }
  const filename = resolve(__dirname, '../src/renderer/src/core/workspace/live-sync.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, document,
    setTimeout: (run: Listener, delay: number) => { const id = ++serial; timers.set(id, { due: now + delay, run }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => { if (name in imports) return imports[name]; throw new Error(`Unexpected workspace live-sync dependency: ${name}`) }
  }, { filename })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const advance = async (ms: number) => {
    const end = now + ms
    await flush()
    for (let turns = 0; turns < 100; turns++) {
      const next = [...timers].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
      if (!next) { now = end; return }
      now = next[1].due; timers.delete(next[0]); next[1].run(); await flush()
    }
    throw new Error('Workspace live-sync scheduled an unbounded timer loop')
  }
  const emit = (listeners: Set<Listener>) => { for (const listener of listeners) listener() }
  const stop = (module.exports as LiveSync).wireWorkspaceLiveSync()
  const mount = (root: string | null) => {
    workspace.root = root
    workspace.children = new Map(root ? [[root, []]] : [])
    workspace.expanded = new Set(root ? [root] : [])
    emit(workspaceListeners)
  }
  return { stop, timers, advance, mount, workspace, connection, calls, io,
    sourceChanged: () => emit(sourceListeners), connectionChanged: () => emit(connectionListeners),
    visibility: (value: string) => { document.visibilityState = value; emit(visibilityListeners) }
  }
}

test('本地空目录启用同步，Windows 已展开目录不因分隔符差异漏刷，隐藏与关闭停止轮询', async () => {
  const f = fixture()
  try {
    await f.advance(60_000)
    expect(f.calls).toEqual([])
    expect(f.timers.size).toBe(0)
    f.mount('D:\\project')
    f.workspace.children.set('D:\\project\\child', [])
    f.workspace.expanded.add('D:\\project\\child')
    await f.advance(100)
    expect(f.calls).toEqual(['D:\\project', 'D:\\project\\child'])
    f.visibility('hidden')
    const count = f.calls.length
    await f.advance(60_000)
    expect(f.calls).toHaveLength(count)
    f.visibility('visible')
    await f.advance(0)
    expect(f.calls.slice(count)).toEqual(['D:\\project', 'D:\\project\\child'])
    f.mount(null)
    const closedCount = f.calls.length
    await f.advance(60_000)
    expect(f.calls).toHaveLength(closedCount)
    expect(f.timers.size).toBe(0)
  } finally { f.stop() }
})

test('慢请求期间切根不继续读取旧目录，销毁后异步完成不复活轮询', async () => {
  const f = fixture()
  let release!: () => void
  f.io.wait = () => new Promise<void>(done => { release = done })
  f.mount('D:\\first')
  f.workspace.children.set('D:\\first\\child', [])
  f.workspace.expanded.add('D:\\first\\child')
  await f.advance(100)
  expect(f.calls).toEqual(['D:\\first'])
  f.mount('D:\\second')
  f.io.wait = async () => {}
  release()
  await f.advance(100)
  expect(f.calls).toEqual(['D:\\first', 'D:\\second'])
  f.io.wait = () => new Promise<void>(done => { release = done })
  await f.advance(8_000)
  const count = f.calls.length
  f.stop()
  release()
  await f.advance(60_000)
  expect(f.calls).toHaveLength(count)
  expect(f.timers.size).toBe(0)
})

test('远端断开时无请求，连接恢复后仅同步当前工作区', async () => {
  const f = fixture()
  try {
    f.connection.remote = true
    f.connection.key = 'remote:unavailable'
    f.mount('D:\\remote')
    f.connectionChanged()
    await f.advance(60_000)
    expect(f.calls).toEqual([])
    f.connection.key = 'remote:next-session'
    f.connection.generation++
    f.connectionChanged()
    await f.advance(100)
    expect(f.calls).toEqual(['D:\\remote'])
  } finally { f.stop() }
})
