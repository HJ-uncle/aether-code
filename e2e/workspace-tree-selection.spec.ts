/** Actual workspace store with deferred directory reads: atomic selection
 * restoration, repeated same-root opens and stale results. No Electron. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsEntry } from '../src/shared/ipc'

type Workspace = typeof import('../src/renderer/src/core/workspace/workspace-store')
type TreeMemory = typeof import('../src/renderer/src/core/workspace/file-tree-memory')
const entry = (path: string, isDirectory = false): FsEntry => ({ path, name: path.split('/').at(-1) ?? path, isDirectory, size: 0, mtimeMs: 0 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const values = new Map<string, string>()
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const directories = new Map<string, FsEntry[]>([
    ['/root', [entry('/root/docs', true)]],
    ['/root/docs', [entry('/root/docs/a.md'), entry('/root/docs/b.md')]],
    ['/other', [entry('/other/current.md')]]
  ])
  const io = { read: async (path: string) => directories.get(path) ?? [] }
  const imports: Record<string, unknown> = {
    react: { useSyncExternalStore: () => { throw new Error('No renderer is mounted in store tests') } },
    '../ipc-error': { ipcErrorMessage: (error: unknown) => String(error) },
    './fs-client': { allowRoot: async () => {}, readDir: (path: string) => io.read(path) },
    './recent-folders': { rememberRecentFolder: () => {} },
    '../engine/client': { getSettings: async () => ({ engineMode: 'embedded' }), updateSettings: async () => {} },
    '../engine/source': { getEngineSource: () => 0, getEngineStorageKey: () => 'embedded', isRemoteEngine: () => false },
    './connection': { workspaceConnectionKey: () => 'embedded', onWorkspaceConnectionChanged: () => () => {} }
  }
  function load(name: string): unknown {
    const filename = resolve(__dirname, `../src/renderer/src/core/workspace/${name}.ts`)
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    runInNewContext(code, { module, exports: module.exports, localStorage,
      require: (dependency: string) => {
        if (dependency in imports) return imports[dependency]
        throw new Error(`Unexpected workspace selection dependency: ${dependency}`)
      }
    }, { filename })
    return module.exports
  }
  const memory = load('file-tree-memory') as TreeMemory
  imports['./file-tree-memory'] = memory
  const workspace = load('workspace-store') as Workspace
  const scope = (root = '/root', mode: 'code' | 'work' = 'code') => memory.createFileTreeScope(mode, 'embedded', 'embedded', root)
  values.set('aether.expandedDirs', JSON.stringify({ '/root': ['/root', '/root/docs'] }))
  memory.writeFileTreeMemory(scope(), { selection: ['/root/docs/a.md'], cursorPath: '/root/docs/a.md', scrollTop: 1680 })
  return { workspace, memory, scope, directories, io }
}

test('Code 首个就绪快照原子恢复深层选区，同根再次初始化不覆盖记忆或 Work 选区', async () => {
  const f = fixture(), started = deferred<void>(), children = deferred<FsEntry[]>()
  f.memory.writeFileTreeMemory(f.scope('/root', 'work'), { selection: ['/root/docs/b.md'] })
  f.io.read = async path => {
    if (path === '/root/docs') { started.resolve(); return children.promise }
    return f.directories.get(path) ?? []
  }
  const readySelections: string[][] = []
  const off = f.workspace.onWorkspaceChanged(() => {
    const state = f.workspace.getWorkspaceState()
    if (state.root && !state.restoring) readySelections.push([...state.selection])
  })
  const opening = f.workspace.openFolderAt('/root')
  await started.promise
  expect(f.workspace.getWorkspaceState().restoring).toBe(true)
  expect(f.memory.readFileTreeMemory(f.scope()).selection).toEqual(['/root/docs/a.md'])
  expect(readySelections).toEqual([])
  children.resolve(f.directories.get('/root/docs')!)
  await opening
  expect(readySelections).toEqual([['/root/docs/a.md']])
  await f.workspace.openFolderAt('/root')
  expect(readySelections).toEqual([['/root/docs/a.md'], ['/root/docs/a.md']])
  expect(f.memory.readFileTreeMemory(f.scope())).toMatchObject({ selection: ['/root/docs/a.md'], cursorPath: '/root/docs/a.md', scrollTop: 1680 })
  expect(f.memory.readFileTreeMemory(f.scope('/root', 'work')).selection).toEqual(['/root/docs/b.md'])
  off()
})

test('加载期间的新选择优先，主动清空同步落盘且重开保持空选区', async () => {
  const f = fixture(), started = deferred<void>(), children = deferred<FsEntry[]>()
  f.io.read = async path => {
    if (path === '/root/docs') { started.resolve(); return children.promise }
    return f.directories.get(path) ?? []
  }
  const opening = f.workspace.openFolderAt('/root')
  await started.promise
  f.workspace.selectEntry('/root/docs', 'plain', ['/root', '/root/docs'])
  children.resolve(f.directories.get('/root/docs')!)
  await opening
  expect([...f.workspace.getSelection()]).toEqual(['/root/docs'])
  expect(f.memory.readFileTreeMemory(f.scope()).selection).toEqual(['/root/docs'])
  f.workspace.clearSelection()
  expect(f.memory.readFileTreeMemory(f.scope()).selection).toEqual([])
  await f.workspace.openFolderAt('/root')
  expect([...f.workspace.getSelection()]).toEqual([])
})

test('过期目录返回不能覆盖新根的选区，删除文件在有效恢复时移除', async () => {
  const f = fixture(), started = deferred<void>(), children = deferred<FsEntry[]>()
  f.memory.writeFileTreeMemory(f.scope('/other'), { selection: ['/other/current.md', '/other/deleted.md'] })
  f.io.read = async path => {
    if (path === '/root/docs') { started.resolve(); return children.promise }
    return f.directories.get(path) ?? []
  }
  const oldOpening = f.workspace.openFolderAt('/root')
  await started.promise
  await f.workspace.openFolderAt('/other')
  children.resolve(f.directories.get('/root/docs')!)
  await oldOpening
  expect(f.workspace.getWorkspaceState().root).toBe('/other')
  expect([...f.workspace.getSelection()]).toEqual(['/other/current.md'])
  expect(f.memory.readFileTreeMemory(f.scope('/other')).selection).toEqual(['/other/current.md'])
  expect(f.memory.readFileTreeMemory(f.scope()).selection).toEqual(['/root/docs/a.md'])
})
