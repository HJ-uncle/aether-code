/** 纯逻辑：执行真实文档服务源码，用可控 IPC Promise 验证关闭/重开/重命名/输入和迟到回包。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { FsFileContent, FsStat } from '../src/shared/ipc'

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
    stat: async (path: string): Promise<FsStat> => ({ path, isDirectory: false, size: 0, mtimeMs: 0 }),
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
      stat: (value: string) => io.stat(value),
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

function binaryFile(path: string, values: number[]): FsFileContent {
  return { path, content: '', bytes: Uint8Array.from(values).buffer, isBinary: true, size: values.length, truncated: false }
}

test('Office/PDF焦点及新增标签复查只读stat，真实watch事件比较字节并保留未变buffer', async () => {
  for (const extension of ['docx', 'pptx', 'xlsx', 'pdf']) {
    const { store, io } = fixture()
    const documentPath = `D:/workspace/preview.${extension}`
    let reads = 0, mtime = 1, values = [0, 1, 2, 3, 4]
    io.stat = async () => ({ path: documentPath, isDirectory: false, size: values.length, mtimeMs: mtime })
    io.read = async () => { reads++; return binaryFile(documentPath, values) }
    await store.openFile(documentPath)
    const original = store.getDocument(documentPath)!
    await store.reloadDocuments([documentPath])
    await store.reloadDocuments([documentPath])
    expect(reads).toBe(1)
    expect(store.getDocument(documentPath)).toBe(original)
    await store.reloadDocuments([documentPath], new Set([documentPath]))
    expect(reads).toBe(2)
    expect(store.getDocument(documentPath)).toBe(original)
    mtime++
    await store.reloadDocuments([documentPath])
    expect(reads).toBe(3)
    expect(store.getDocument(documentPath)).toBe(original)
    await store.reloadDocuments([documentPath])
    expect(reads).toBe(3)
    // Equal size and mtime must not hide a genuine change notification. The
    // last byte also verifies the non-word-aligned comparison tail.
    values = [0, 1, 2, 3, 9]
    await store.reloadDocuments([documentPath], new Set([documentPath]))
    const changed = store.getDocument(documentPath)!
    expect(changed).not.toBe(original)
    expect([...new Uint8Array(changed.bytes!)]).toEqual(values)
    expect(store.getDocumentIdentity(documentPath)?.revision).toBe(1)
    expect(store.isDirty(changed)).toBe(false)
  }
})

test('二进制监听的迟到回包不能覆盖后完成的新版本或关闭后重开的实例', async () => {
  const { store, io } = fixture()
  const documentPath = 'D:/workspace/race.docx'
  io.stat = async () => ({ path: documentPath, isDirectory: false, size: 3, mtimeMs: 1 })
  io.read = async () => binaryFile(documentPath, [0, 1, 1])
  await store.openFile(documentPath)
  const read = deferred<FsFileContent>(), started = deferred<void>()
  io.read = () => { started.resolve(); return read.promise }
  const first = store.reloadDocuments([documentPath], new Set([documentPath]))
  await started.promise
  io.read = async () => binaryFile(documentPath, [0, 3, 3])
  await store.reloadDocuments([documentPath], new Set([documentPath]))
  read.resolve(binaryFile(documentPath, [0, 2, 2]))
  await first
  expect([...new Uint8Array(store.getDocument(documentPath)!.bytes!)]).toEqual([0, 3, 3])
  const staleRead = deferred<FsFileContent>(), staleStarted = deferred<void>()
  io.read = () => { staleStarted.resolve(); return staleRead.promise }
  const stale = store.reloadDocuments([documentPath], new Set([documentPath]))
  await staleStarted.promise
  store.closeFile(documentPath)
  io.read = async () => binaryFile(documentPath, [0, 5, 5])
  await store.openFile(documentPath)
  staleRead.resolve(binaryFile(documentPath, [0, 4, 4]))
  await stale
  expect([...new Uint8Array(store.getDocument(documentPath)!.bytes!)]).toEqual([0, 5, 5])
})

test('二进制刷新保留连接边界，旧工作区回包不替换已打开的内容', async () => {
  const { store, io, switchConnection } = fixture()
  const documentPath = 'D:/workspace/scoped.pdf'
  io.stat = async () => ({ path: documentPath, isDirectory: false, size: 3, mtimeMs: 1 })
  io.read = async () => binaryFile(documentPath, [0, 1, 1])
  await store.openFile(documentPath)
  const original = store.getDocument(documentPath)!.bytes
  const read = deferred<FsFileContent>(), started = deferred<void>()
  io.read = () => { started.resolve(); return read.promise }
  const refreshing = store.reloadDocuments([documentPath], new Set([documentPath]))
  await started.promise
  switchConnection('remote:new-session')
  read.resolve(binaryFile(documentPath, [0, 2, 2]))
  await refreshing
  expect(store.getDocument(documentPath)!.bytes).toBe(original)
})

test('二进制磁盘结果不覆盖空的未保存文本，其他媒体仍跳过自动整文件重读', async () => {
  const { store, io } = fixture()
  const documentPath = 'D:/workspace/text.docx'
  await store.openFile(documentPath)
  store.setDocumentContent(documentPath, '')
  io.read = async () => binaryFile(documentPath, [0, 1, 2])
  await store.reloadDocuments([documentPath])
  expect(store.getDocument(documentPath)).toMatchObject({ isBinary: false, content: '', savedContent: 'disk', externalChange: 'modified' })
  const imagePath = 'D:/workspace/image.png'
  let reads = 0
  io.read = async () => { reads++; return binaryFile(imagePath, [0, 1, 2]) }
  await store.openFile(imagePath)
  await store.reloadDocuments([imagePath], new Set([imagePath]))
  expect(reads).toBe(1)
})
