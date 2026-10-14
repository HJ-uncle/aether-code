/** Real editor-store and session HTTP adapter: document ownership, saves/reloads,
 * scratch tasks, account/source fences, owner conflicts and native watch exclusion.
 * Service timing is controlled; no Electron or model calls. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { EngineRequestInput } from '../src/shared/ipc'
import * as fsClient from '../src/renderer/src/core/workspace/fs-client'
import * as engineSource from '../src/renderer/src/core/engine/source'

type Store = typeof import('../src/renderer/src/core/editor/editor-store')
type Opener = typeof import('../src/renderer/src/contrib/chat/open-file')
type Sync = typeof import('../src/renderer/src/core/editor/document-sync')
const project = resolve(__dirname, '..')
let sequence = 0

function load<T>(relative: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const filename = resolve(project, relative)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout, ...globals,
    require: (name: string) => { if (name in imports) return imports[name]; throw new Error(`Unexpected dependency: ${name}`) }
  }, { filename })
  return module.exports as T
}

function deferred<T>() {
  let done!: (value: T) => void
  return { promise: new Promise<T>(resolve => { done = resolve }), resolve: (value: T) => done(value) }
}

function fixture(mode: 'embedded' | 'remote' = 'embedded') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const snapshot = { mode, baseUrl: mode === 'remote' ? 'https://synthetic.invalid' : '', phase: 'ready' as const,
    instanceId: `session-document-${++sequence}`, accountId: 'account-a' }
  engineSource.publishEngineSource(snapshot)
  let codeKey = 'Code-selection-a', grants = 0, localReads = 0, gitRefreshes = 0, diagnoses = 0
  const calls: EngineRequestInput[] = [], writes: Array<{ sessionId: string; path: string; content: string }> = [], activated: string[] = [], watches: string[][] = []
  const roots = new Map([['work-a', 'D:/scratch/a'], ['work-b', 'D:/scratch/b']])
  const files = new Map<string, { content: string; isBinary: boolean; totalSize: number; truncated: boolean }>([
    ['work-a:report.txt', { content: 'TASK_A_DISK', isBinary: false, totalSize: 11, truncated: false }],
    ['work-b:report.txt', { content: 'TASK_B_DISK', isBinary: false, totalSize: 11, truncated: false }]
  ])
  const io: { before?: (input: EngineRequestInput) => Promise<void>; snapshot?: () => Promise<typeof snapshot> } = {}
  const bridge = { engine: {
    getSnapshot: async () => io.snapshot ? io.snapshot() : snapshot,
    request: async (input: EngineRequestInput) => {
      calls.push(input)
      await io.before?.(input)
      const body = input.body as Record<string, unknown> | undefined
      const sessionId = String(input.query?.sessionId ?? body?.sessionId ?? ''), path = String(input.query?.path ?? body?.path ?? '')
      if (input.path === '/workspace/directory') return { ok: true, code: 200, data: { root: roots.get(sessionId), entries: [] } }
      if (input.path === '/workspace/file/content') return { ok: true, code: 200, data: files.get(`${sessionId}:${path}`) }
      if (input.path === '/workspace/file' && input.method === 'POST') {
        const content = String(body?.content)
        writes.push({ sessionId, path, content })
        files.set(`${sessionId}:${path}`, { content, isBinary: false, totalSize: content.length, truncated: false })
        return { ok: true, code: 200, data: { written: true } }
      }
      if (input.path === '/workspace/file/info') return { ok: true, code: 200, data: { isDirectory: false, size: files.get(`${sessionId}:${path}`)?.totalSize ?? 0, mtimeMs: 1 } }
      throw new Error(`Unexpected HTTP operation ${input.path}`)
    }
  }, fs: {
    readFile: async (path: string) => { localReads++; return { path, content: 'CODE_DISK', isBinary: false, truncated: false, size: 9 } },
    allowRoot: async () => { grants++ }, watchDocuments: async (paths: string[]) => { watches.push(paths) }, onDocumentsChanged: () => () => {}
  } }
  const windowMock = { aether: bridge, addEventListener: () => {}, removeEventListener: () => {} }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock })
  const store = load<Store>('src/renderer/src/core/editor/editor-store.ts', {
    react: { useSyncExternalStore: () => {} }, '../ipc-error': { ipcErrorMessage: (value: unknown) => value instanceof Error ? value.message : String(value) },
    '../git/git-store': { refreshGit: async () => { gitRefreshes++ } },
    '../lsp/diagnostics': { clearDocumentDiagnostics: () => {}, diagnoseDocument: async () => { diagnoses++ } },
    './recent-files': { rememberRecent: () => {} }, '../workspace/fs-client': fsClient,
    '../workspace/workspace-store': { getWorkspaceState: () => ({ root: 'D:/code' }) },
    './editor-activation': { activateDocument: (path: string) => activated.push(path) },
    './file-identity': { fileIdentity: (path: string) => /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path },
    './active-editor': { getActiveEditor: () => null }, '../workspace/connection': { workspaceConnectionKey: () => codeKey }
  })
  const opener = load<Opener>('src/renderer/src/contrib/chat/open-file.ts', {
    '@renderer/core/editor/editor-activation': { activateDocument: (path: string) => activated.push(path) },
    '@renderer/core/editor/editor-store': store, '@renderer/core/workspace/workspace-store': { getWorkspaceState: () => ({ root: 'D:/code' }) },
    '@renderer/core/engine/client': { getSnapshot: () => bridge.engine.getSnapshot() },
    './chat-file-path': { resolveChatPath: () => { throw new Error('Work must not use the Code path resolver') } },
    '@renderer/core/engine/source': engineSource, '@renderer/core/workspace/fs-client': fsClient,
    '@renderer/core/workspace/connection': { assertWorkspaceTarget: () => { throw new Error('Work must not use the Code workspace target') } }
  })
  const sync = () => load<Sync>('src/renderer/src/core/editor/document-sync.ts', { './editor-store': store, '../engine/source': engineSource }, { window: windowMock }).watchOpenDocuments()
  return { store, opener, sync, calls, writes, activated, roots, files, watches, io, snapshot,
    counters: () => ({ grants, localReads, gitRefreshes, diagnoses }), switchCode: () => { codeKey = 'Code-selection-b' },
    expire: () => engineSource.publishEngineSource({ ...snapshot, accountId: 'account-b' }),
    close: () => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') }
  }
}

for (const mode of ['embedded', 'remote'] as const) test(`${mode}：两个 scratch 任务同名文件独立打开保存，Code 会话切换不改归属`, async () => {
  const f = fixture(mode)
  try {
    await f.opener.openFileFromChat('report.txt:2:3', { sessionId: 'work-a' })
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-b', workspaceRoot: 'D:/wrong-code-root' })
    expect(f.store.getDocument('D:/scratch/a/report.txt')?.content).toBe('TASK_A_DISK')
    expect(f.store.getDocument('D:/scratch/b/report.txt')?.content).toBe('TASK_B_DISK')
    expect(f.store.getEditorState().reveals['D:/scratch/a/report.txt']).toMatchObject({ line: 2, column: 3 })
    f.switchCode()
    f.store.setDocumentContent('D:/scratch/a/report.txt', 'TASK_A_SAVED')
    await f.store.saveDocument('D:/scratch/a/report.txt')
    expect(f.writes).toEqual([{ sessionId: 'work-a', path: 'report.txt', content: 'TASK_A_SAVED' }])
    expect(f.files.get('work-b:report.txt')?.content).toBe('TASK_B_DISK')
    expect(f.counters()).toEqual({ grants: 0, localReads: 0, gitRefreshes: 0, diagnoses: 0 })
    expect(f.calls.every(call => call.expectedEngine?.accountId === 'account-a' && call.toolProfile === 'general')).toBe(true)
  } finally { f.close() }
})

test('session 文件重载和关闭重开都复用任务 owner，原磁盘变更不能被静默覆盖', async () => {
  const f = fixture()
  try {
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    const path = 'D:/scratch/a/report.txt'
    f.files.get('work-a:report.txt')!.content = 'TASK_A_NEW_DISK'
    await f.store.reloadDocuments([path])
    expect(f.store.getDocument(path)?.content).toBe('TASK_A_NEW_DISK')
    f.store.setDocumentContent(path, 'UNSAVED_BUFFER')
    f.files.get('work-a:report.txt')!.content = 'TASK_A_CONFLICT'
    await expect(Promise.resolve(f.store.saveDocument(path))).rejects.toThrow('未覆盖磁盘内容')
    expect(f.writes).toEqual([])
    expect(f.store.getDocument(path)?.content).toBe('UNSAVED_BUFFER')
    await f.store.reloadDocumentFromDisk(path)
    expect(f.store.getDocument(path)?.content).toBe('TASK_A_CONFLICT')
    const owner = f.store.getDocument(path)?.sessionFileTarget?.key
    f.store.closeFile(path); f.switchCode()
    expect(await f.store.reopenLastClosedFile()).toBe(true)
    expect(f.store.getDocument(path)?.sessionFileTarget?.key).toBe(owner)
    expect(f.counters().localReads).toBe(0)
  } finally { f.close() }
})

test('截断文件禁止覆盖保存，任务绑定变化与另一 owner 的同一路径必须拒绝', async () => {
  const f = fixture()
  try {
    f.files.get('work-a:report.txt')!.truncated = true
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    f.store.setDocumentContent('D:/scratch/a/report.txt', 'PARTIAL_EDIT')
    await expect(Promise.resolve(f.store.saveDocument('D:/scratch/a/report.txt'))).rejects.toThrow('部分内容')
    f.store.closeFile('D:/scratch/a/report.txt')
    f.files.get('work-a:report.txt')!.truncated = false
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    f.roots.set('work-b', 'D:/scratch/a')
    await expect(Promise.resolve(f.opener.openFileFromChat('report.txt', { sessionId: 'work-b' }))).rejects.toThrow('其他工作区会话')
    f.roots.set('work-a', 'D:/scratch/rebound')
    await expect(Promise.resolve(f.store.reloadDocumentFromDisk('D:/scratch/a/report.txt'))).rejects.toThrow('任务工作区已变化')
    expect(f.writes).toEqual([])
  } finally { f.close() }
})

test('保存预读期间账号变化，保留草稿且既不写旧引擎也不写新 Code 工作区', async () => {
  const f = fixture('remote')
  try {
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    const started = deferred<void>(), release = deferred<void>()
    f.io.before = async input => { if (input.path === '/workspace/file/content') { started.resolve(); await release.promise } }
    f.store.setDocumentContent('D:/scratch/a/report.txt', 'KEEP_THIS_DRAFT')
    const saving = f.store.saveDocument('D:/scratch/a/report.txt')
    await started.promise; f.expire(); release.resolve()
    await expect(Promise.resolve(saving)).rejects.toThrow('引擎连接已变化')
    expect(f.writes).toEqual([])
    expect(f.store.getDocument('D:/scratch/a/report.txt')?.content).toBe('KEEP_THIS_DRAFT')
    const previous = f.calls.length
    await expect(Promise.resolve(f.store.saveDocument('D:/scratch/a/report.txt'))).rejects.toThrow('引擎连接已变化')
    expect(f.calls).toHaveLength(previous)
  } finally { f.close() }
})

test('初始 snapshot 和内容响应迟到时，旧任务文件都不能激活或交给新来源', async () => {
  const first = fixture('remote')
  try {
    const entered = deferred<void>(), release = deferred<void>()
    first.io.snapshot = async () => { entered.resolve(); await release.promise; return first.snapshot }
    const opening = first.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    await entered.promise; first.expire(); release.resolve()
    await expect(Promise.resolve(opening)).rejects.toThrow('引擎连接已变化')
    expect(first.calls).toEqual([]); expect(first.activated).toEqual([])
  } finally { first.close() }
  const second = fixture('remote')
  try {
    const entered = deferred<void>(), release = deferred<void>()
    second.io.before = async input => { if (input.path === '/workspace/file/content') { entered.resolve(); await release.promise } }
    const opening = second.opener.openArtifactFromChat({ kind: 'artifact', sessionId: 'work-a', path: 'report.txt' }, { sessionId: 'work-a' })
    await entered.promise; second.expire(); release.resolve()
    await expect(Promise.resolve(opening)).rejects.toThrow('引擎连接已变化')
    expect(second.activated).toEqual([])
    expect(second.store.getDocument('D:/scratch/a/report.txt')?.content).toBe('')
  } finally { second.close() }
})

test('嵌入任务的独立 HTTP 文件不会授权本机目录或进入 Code 原生 watcher', async () => {
  const f = fixture()
  let stop: (() => void) | undefined
  try {
    await f.opener.openFileFromChat('report.txt', { sessionId: 'work-a' })
    await f.store.openFile('D:/code/code.txt')
    stop = f.sync()
    await new Promise<void>(done => setTimeout(done, 0))
    expect(f.watches).toEqual([['D:/code/code.txt']])
    expect(f.counters().grants).toBe(0)
    expect(f.watches.flat()).not.toContain('D:/scratch/a/report.txt')
  } finally { stop?.(); await new Promise<void>(done => setTimeout(done, 0)); f.close() }
})
