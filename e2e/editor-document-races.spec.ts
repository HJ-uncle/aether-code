/** 纯逻辑：执行真实文档服务源码，用可控 IPC Promise 验证关闭/重开/重命名/输入和迟到回包。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsFileContent } from '../src/shared/ipc'

type EditorStore = typeof import('../src/renderer/src/core/editor/editor-store')
type Recovery = typeof import('../src/renderer/src/core/editor/editor-recovery')
const root = resolve(__dirname, '..')
const path = 'D:/workspace/file.txt'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function file(content: string): FsFileContent {
  return { path, content, isBinary: false, truncated: false, size: content.length }
}

/** 模块自身运行在独立 VM，磁盘和时序由替身控制；不创建 Electron 窗口或修改源码。 */
function load<T>(relative: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const filename = resolve(root, relative)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout, ...globals,
    require: (name: string) => {
      if (name in imports) return imports[name]
      throw new Error(`Unexpected service dependency: ${name}`)
    }
  }, { filename })
  return module.exports as T
}

function fixture() {
  let connectionKey = 'embedded'
  const writes: { path: string; content: string }[] = []
  const persisted: string[] = []
  const io = {
    read: async (_path: string): Promise<FsFileContent> => file('disk'),
    write: async (_path: string, _content: string): Promise<void> => {}
  }
  const workspace = { getWorkspaceState: () => ({ root: 'D:/workspace' }), onWorkspaceChanged: () => () => {} }
  const store = load<EditorStore>('src/renderer/src/core/editor/editor-store.ts', {
    react: { useSyncExternalStore: () => {} },
    '../ipc-error': { ipcErrorMessage: (error: unknown) => String(error) },
    '../git/git-store': { refreshGit: async () => {} },
    '../lsp/diagnostics': { diagnoseDocument: async () => {}, clearDocumentDiagnostics: () => {} },
    './recent-files': { rememberRecent: () => {} },
    '../workspace/fs-client': {
      paths: { basename: (value: string) => value.split('/').pop() },
      readFile: (value: string) => io.read(value),
      writeFile: async (value: string, content: string) => { writes.push({ path: value, content }); await io.write(value, content) }
    },
    '../workspace/workspace-store': workspace,
    './editor-activation': { activateDocument: () => {} },
    './file-identity': { fileIdentity: (value: string) => value.toLowerCase() },
    './active-editor': { getActiveEditor: () => null }
    , '../workspace/connection': { workspaceConnectionKey: () => connectionKey }
  })
  const recovery = (): Recovery => {
    const storage = new Map([['aether.editor.recovery:d:/workspace', JSON.stringify({
      tabs: [{ path, draft: { content: 'old recovered draft', savedContent: 'disk' } }], activePath: path
    })]])
    return load<Recovery>('src/renderer/src/core/editor/editor-recovery.ts', {
      '../workspace/workspace-store': workspace,
      '../platform/layout-state': { getLayout: () => ({ activeEditorView: '' }), onLayoutChanged: () => () => {} },
      '../toast': { toast: { error: () => {} } },
      './file-identity': { fileIdentity: (value: string) => value.toLowerCase() },
      './editor-activation': { activateDocument: () => {} },
      './editor-store': store,
      './editor-groups': { getEditorGroups: () => ({ focusedGroupId: 'main', groups: [] }), onEditorGroupsChanged: () => () => {}, restoreEditorGroups: () => {} }
    }, {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); persisted.push(value) } },
      window: { addEventListener: () => {}, removeEventListener: () => {} }
    })
  }
  return { store, io, writes, persisted, recovery, switchConnection: (key: string) => { connectionKey = key } }
}

test('保存预读等待期间重命名，取消旧路径写盘并保留新路径草稿', async () => {
  const { store, io, writes } = fixture()
  await store.openFile(path)
  store.setDocumentContent(path, 'draft')
  const read = deferred<FsFileContent>()
  const started = deferred<void>()
  io.read = () => { started.resolve(); return read.promise }
  const saving = store.saveDocument(path)
  await started.promise
  store.renameDocument(path, 'D:/workspace/renamed.txt')
  read.resolve(file('disk'))
  await expect(Promise.resolve(saving)).rejects.toThrow('保存已取消')
  expect(writes).toEqual([])
  expect(store.getDocument('D:/workspace/renamed.txt')?.content).toBe('draft')
  expect([...store.getEditorState().saving]).toEqual([])
})

test('远程连接或会话切换后旧文档禁止写入新工作区', async () => {
  const { store, switchConnection, writes } = fixture()
  await store.openFile(path)
  store.setDocumentContent(path, 'local draft')
  switchConnection('remote:next-session')
  await expect(Promise.resolve(store.saveDocument(path))).rejects.toThrow('连接或会话已经切换')
  expect(writes).toEqual([])
})

test('保存期间继续输入合法，已落盘快照之外的新输入保持dirty', async () => {
  const { store, io, writes } = fixture()
  await store.openFile(path)
  store.setDocumentContent(path, 'first edit')
  const written = deferred<void>()
  const started = deferred<void>()
  io.write = () => { started.resolve(); return written.promise }
  const saving = store.saveDocument(path)
  await started.promise
  store.setDocumentContent(path, 'second edit')
  written.resolve()
  await saving
  expect(writes).toEqual([{ path, content: 'first edit' }])
  expect(store.getDocument(path)).toMatchObject({ content: 'second edit', savedContent: 'first edit' })
})

test('旧保存回包不能更新重新打开的新文档基线，旧队列也不能保存新实例', async () => {
  const { store, io, writes } = fixture()
  await store.openFile(path)
  store.setDocumentContent(path, 'first edit')
  const written = deferred<void>()
  const started = deferred<void>()
  io.write = () => { started.resolve(); return written.promise }
  const saving = store.saveDocument(path)
  await started.promise
  const queued = store.saveDocument(path)
  store.closeFile(path)
  await store.openFile(path)
  store.setDocumentContent(path, 'new instance edit')
  written.resolve()
  await saving
  await expect(Promise.resolve(queued)).rejects.toThrow('保存已取消')
  expect(writes).toEqual([{ path, content: 'first edit' }])
  expect(store.getDocument(path)).toMatchObject({ content: 'new instance edit', savedContent: 'disk', error: null })
})

test('监听重读的旧回包不能覆盖内容相同的新文档实例', async () => {
  const { store, io } = fixture()
  await store.openFile(path)
  const read = deferred<FsFileContent>()
  io.read = () => read.promise
  const reloading = store.reloadDocuments([path])
  store.closeFile(path)
  io.read = async () => file('disk')
  await store.openFile(path)
  read.resolve(file('stale external version'))
  await reloading
  expect(store.getDocument(path)).toMatchObject({ content: 'disk', savedContent: 'disk' })
})

test('显式重载期间输入后撤销至原文，仍拒绝迟到回包', async () => {
  const { store, io } = fixture()
  await store.openFile(path)
  const read = deferred<FsFileContent>()
  io.read = () => read.promise
  const reloading = store.reloadDocumentFromDisk(path)
  store.setDocumentContent(path, 'new edit')
  store.setDocumentContent(path, 'disk')
  read.resolve(file('other disk version'))
  await expect(Promise.resolve(reloading)).rejects.toThrow('读取期间文档已修改')
  expect(store.getDocument(path)?.content).toBe('disk')
})

test('启动恢复旧读取期间关闭并重开输入，新输入不能被旧草稿覆盖', async () => {
  const { store, io, recovery } = fixture()
  const read = deferred<FsFileContent>()
  const started = deferred<void>()
  io.read = () => { started.resolve(); return read.promise }
  const stop = recovery().startEditorRecovery()
  try {
    await started.promise
    store.closeFile(path)
    io.read = async () => file('disk')
    await store.openFile(path)
    store.setDocumentContent(path, 'new user input')
    read.resolve(file('disk'))
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(store.getDocument(path)).toMatchObject({ content: 'new user input', savedContent: 'disk' })
  } finally { stop() }
})

test('没有并发操作时正常恢复草稿，保留基线与磁盘冲突', async () => {
  const { store, io, recovery } = fixture()
  io.read = async () => file('external new disk')
  const stop = recovery().startEditorRecovery()
  try {
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(store.getDocument(path)).toMatchObject({
      content: 'old recovered draft', savedContent: 'disk', externalChange: 'modified', diskContent: 'external new disk'
    })
  } finally { stop() }
})

test('StrictMode同步初始化清理再初始化，只恢复一次且不覆盖原草稿快照', async () => {
  const { store, io, persisted, recovery } = fixture()
  const read = deferred<FsFileContent>()
  const started = deferred<void>()
  let reads = 0
  io.read = () => { reads++; started.resolve(); return read.promise }
  const service = recovery()
  const stopFirst = service.startEditorRecovery()
  stopFirst()
  const stopSecond = service.startEditorRecovery()
  try {
    await started.promise
    expect(reads).toBe(1)
    expect(persisted).toEqual([])
    read.resolve(file('disk'))
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(store.getDocument(path)).toMatchObject({ content: 'old recovered draft', savedContent: 'disk' })
  } finally { stopSecond() }
  expect(persisted.length).toBeGreaterThan(0)
  expect(JSON.parse(persisted[persisted.length - 1]).tabs[0].draft.content).toBe('old recovered draft')
})
