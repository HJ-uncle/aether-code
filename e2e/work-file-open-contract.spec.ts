/** Production file-opening flow: offline Work recovery, remote isolation and async ownership fences. No Electron/model calls. */
import { expect, test } from '@playwright/test'
import { rejects } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { paths, workspaceRecoveryCandidates } from '../src/renderer/src/core/workspace/fs-client'
import type { openFileFromChat } from '../src/renderer/src/contrib/chat/open-file'

const filename = resolve(__dirname, '../src/renderer/src/contrib/chat/open-file.ts')
const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const workspaceRoot = 'D:/work/project'
const file = `${workspaceRoot}/docs/围棋.html`

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}

function fixture(remote = false, appMode: 'work' | 'code' = 'work') {
  const state = { source: 1, task: 'work-one', mode: appMode, ready: false }
  const calls = { snapshots: 0, session: [] as string[], reads: [] as string[], resources: [] as Array<{ path: string; sessionId: string }> }
  const hooks: { snapshot?: () => Promise<void>; read?: () => Promise<void> } = {}
  const unexpected = () => { throw new Error('Unexpected Code editor or authenticated session operation') }
  const imports: Record<string, unknown> = {
    '@renderer/core/editor/editor-activation': { activateDocument: unexpected },
    '@renderer/core/editor/editor-store': { assertDocumentConnection: unexpected, getDocument: unexpected, openFile: unexpected },
    '@renderer/core/workspace/workspace-store': { getWorkspaceState: () => ({ root: workspaceRoot }) },
    '@renderer/core/engine/client': { getSnapshot: async () => {
      calls.snapshots++
      await hooks.snapshot?.()
      return { mode: remote ? 'remote' : 'embedded', phase: 'idle' }
    } },
    './chat-file-path': { resolveChatPath: unexpected },
    '@renderer/core/engine/source': {
      getEngineSource: () => state.source,
      getEngineStorageKey: () => remote ? 'remote:https://engine.invalid' : '',
      isRemoteEngine: () => remote,
      isEngineReady: () => state.ready,
      assertEngineSource: (source: number) => {
        if (source !== state.source || !state.ready) throw new Error('引擎连接已变化，请在当前会话重试')
      }
    },
    '@renderer/core/workspace/fs-client': {
      paths, workspaceRecoveryCandidates,
      resolveSessionFilePath: async (_session: string, path: string) => {
        calls.session.push(path)
        throw new Error('任务文件通道尚未就绪')
      },
      readLocalRecoveryFile: async (path: string) => {
        calls.reads.push(path)
        await hooks.read?.()
        return { path, content: '<h1>当前磁盘内容</h1>', isBinary: false, size: 32, truncated: false }
      },
      remoteWorkspaceContext: unexpected, remoteWorkspaceRelativePath: unexpected
    },
    '@renderer/core/workspace/connection': { assertWorkspaceTarget: unexpected },
    '@renderer/core/platform/app-mode': { getAppMode: () => state.mode },
    '../work/work-resource-store': {
      openExternalWorkPathResource: (path: string, sessionId: string) => { calls.resources.push({ path, sessionId }) },
      openWorkFileResource: unexpected
    },
    '../work/work-state': { getWorkState: () => ({ activeTaskId: state.task, tasks: [
      { id: 'work-one', workspacePath: workspaceRoot },
      { id: 'work-two', workspacePath: 'D:/work/other-task' }
    ] }) }
  }
  const module = { exports: {} as { openFileFromChat: typeof openFileFromChat } }
  runInNewContext(code, { module, exports: module.exports, Error,
    require: (id: string) => { if (!(id in imports)) throw new Error(`Unmocked dependency: ${id}`); return imports[id] }
  }, { filename })
  return { state, calls, hooks, open: (path = file, hint = workspaceRoot) => module.exports.openFileFromChat(path, { sessionId: 'work-one', workspaceRoot: hint }) }
}

test('离线本地 Work 从会话读取失败转为限定目录的只读资源', async () => {
  const f = fixture()
  await f.open()
  expect(f.calls.session).toEqual([file])
  expect(f.calls.reads).toEqual([file])
  expect(f.calls.resources).toEqual([{ path: file, sessionId: 'work-one' }])
  expect(f.state.ready).toBe(false)
})

test('离线远端 Work 不读取本机文件或创建本地资源', async () => {
  const f = fixture(true)
  await rejects(f.open(), /引擎连接已变化/)
  expect(f.calls.reads).toEqual([])
  expect(f.calls.resources).toEqual([])
})

for (const boundary of ['snapshot', 'read'] as const) {
  for (const identity of ['source', 'task'] as const) {
    test(`${boundary} 等待期间切换 ${identity}，旧文件不能加入新会话`, async () => {
      const f = fixture(), entered = deferred(), release = deferred()
      f.hooks[boundary] = async () => { entered.resolve(); await release.promise }
      const result = f.open().then(() => ({ ok: true, error: '' }), error => ({ ok: false, error: String(error) }))
      await entered.promise
      if (identity === 'source') f.state.source++
      else f.state.task = 'work-two'
      release.resolve()
      const outcome = await result
      expect(outcome.ok).toBe(false)
      expect(outcome.error.length).toBeGreaterThan(0)
      expect(f.calls.resources).toEqual([])
      expect(f.calls.reads).toEqual(boundary === 'read' ? [file] : [])
    })
  }
}

for (const path of ['E:/outside/private.html', '../private.html']) test(`无合法恢复路径时不读取：${path}`, async () => {
  const f = fixture()
  expect(workspaceRecoveryCandidates(path, workspaceRoot)).toEqual([])
  await rejects(f.open(path), /任务文件通道尚未就绪/)
  expect(f.calls.reads).toEqual([])
  expect(f.calls.resources).toEqual([])
})

test('离线 Code 保留严格引擎就绪检查', async () => {
  const f = fixture(false, 'code')
  await rejects(f.open(), /引擎连接已变化/)
  expect(f.calls.session).toEqual([])
  expect(f.calls.reads).toEqual([])
  expect(f.calls.resources).toEqual([])
})

test('离线恢复不读取同账号另一任务的文件，调用方工作区提示不能越过当前任务根', async () => {
  const f = fixture()
  const other = 'D:/work/other-task/foreign.html'
  // General online recovery allows bounded sibling roots. Offline recovery
  // must additionally enforce the active task root instead of trusting a hint.
  expect(workspaceRecoveryCandidates(other, workspaceRoot)).toContain(other)
  await rejects(f.open(other, 'D:/work/other-task'), /任务文件通道尚未就绪/)
  expect(f.calls.reads).toEqual([])
  expect(f.calls.resources).toEqual([])
})
