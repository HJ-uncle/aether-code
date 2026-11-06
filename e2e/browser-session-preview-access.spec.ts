/** Session preview authorization, binding revocation and bounded filesystem
 * access with real directories/HTTP and stubbed engine transport. No Electron. */
import { expect, test } from '@playwright/test'
import { rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { engineTargetError, type EngineIdentity } from '../src/main/engine/protocol'
import type { EngineRequestInput, EngineRequestResult, EngineSnapshot } from '../src/shared/ipc'
import type { BrowserPreviewServer } from '../src/main/browser-preview'
import type { sessionPreviewAccess } from '../src/main/browser-workspace-preview'
import type * as FileService from '../src/main/fs/file-service'

const repository = resolve(__dirname, '..'), parent = join(repository, '.e2e-tmp')
const expected: EngineIdentity = { mode: 'embedded', baseUrl: 'http://127.0.0.1:12323', instanceId: 'preview-engine', accountId: 'preview-user' }
type Binding = { root?: unknown; bindingEpoch?: unknown; entries?: unknown }
type Snapshot = EngineIdentity & Pick<EngineSnapshot, 'phase'>

function loadModule<T extends object>(relative: string, imports: Record<string, unknown>): T {
  const exports = {} as T
  const code = ts.transpileModule(readFileSync(join(repository, relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  runInNewContext(code, { exports, URL, Buffer, process, Error,
    require: (id: string) => {
      if (id in imports) return imports[id]
      if (id.startsWith('node:')) return require(id)
      throw new Error(`Unexpected production dependency: ${id}`)
    } })
  return exports
}

function fixture() {
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'session-preview-access-'))
  const scratch = join(directory, 'scratch'), codeRoot = join(directory, 'code'), other = join(directory, 'other')
  for (const path of [scratch, codeRoot, other, join(scratch, 'docs'), join(scratch, 'assets')]) mkdirSync(path)
  writeFileSync(join(scratch, 'docs', 'page.html'), '<h1>SESSION_PREVIEW</h1>')
  writeFileSync(join(scratch, 'assets', 'style.css'), 'h1 { color: green }')
  writeFileSync(join(other, 'private.html'), '<h1>PRIVATE_OUTSIDE</h1>')
  writeFileSync(join(codeRoot, 'offline.html'), '<h1>CODE_OFFLINE</h1>')
  let snapshot: Snapshot = { ...expected, phase: 'ready' }
  let result: EngineRequestResult<Binding> = { ok: true, code: 200, message: '', data: { root: scratch, bindingEpoch: 'binding-one', entries: [] } }
  let duringRequest: (() => void) | undefined
  const calls: EngineRequestInput[] = []
  const filesystem = loadModule<Pick<typeof FileService, 'allowRoot' | 'assertAllowed' | 'getAllowedRoots'>>('src/main/fs/file-service.ts', {
    electron: {}, './gitignore-matcher': {}, '../../shared/attachments': {}, '../../shared/file-signature': {}
  })
  filesystem.allowRoot(codeRoot)
  const session = loadModule<{ sessionPreviewAccess: typeof sessionPreviewAccess }>('src/main/browser-workspace-preview.ts', {
    './engine/host': { engineHost: { getSnapshot: () => snapshot } },
    './engine/protocol': { engineTargetError },
    './engine/client': { engineRequest: async (input: EngineRequestInput) => {
      calls.push(structuredClone(input)); duringRequest?.(); return structuredClone(result)
    } }
  })
  const preview = loadModule<{ BrowserPreviewServer: typeof BrowserPreviewServer }>('src/main/browser-preview.ts', { './fs/file-service': filesystem })
  const servers: BrowserPreviewServer[] = []
  return { directory, scratch, codeRoot, other, calls, filesystem,
    access: () => session.sessionPreviewAccess('work-private-session', { ...expected }),
    setSnapshot: (value: Partial<Snapshot>) => { snapshot = { ...snapshot, ...value } },
    setBinding: (data: Binding) => { result = { ok: true, code: 200, message: '', data } },
    failRequest: () => { result = { ok: false, code: 503, message: 'workspace temporarily unavailable', data: null } },
    duringRequest: (callback: () => void) => { duringRequest = callback },
    server: () => { const server = new preview.BrowserPreviewServer(); servers.push(server); return server },
    cleanup: () => {
      for (const server of servers) server.dispose()
      if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith('session-preview-access-')) throw new Error('Unsafe fixture cleanup')
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

test('会话根目录由携带引擎身份的认证请求确定，每次校验重新确认绑定', async () => {
  const f = fixture()
  try {
    const access = await f.access()
    expect(access.root).toBe(realpathSync(f.scratch))
    await access.validate()
    expect(f.calls).toEqual(Array.from({ length: 2 }, () => ({ method: 'GET', path: '/workspace/directory',
      query: { sessionId: 'work-private-session', path: '.' }, expectedEngine: expected, toolProfile: 'general' })))
    expect(f.filesystem.getAllowedRoots()).toHaveLength(1)
    expect(() => f.filesystem.assertAllowed(f.scratch)).toThrow(/拒绝访问工作区之外/)
  } finally { f.cleanup() }
})

test('私有会话网页及父目录资源可读取，Code 全局授权和越界隔离保持独立', async () => {
  const f = fixture()
  try {
    const access = await f.access(), server = f.server(), allowed = f.filesystem.getAllowedRoots()
    const url = await server.open(join(f.scratch, 'docs', 'page.html'), f.codeRoot, access)
    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>SESSION_PREVIEW</h1>')
    const resource = await fetch(new URL('../assets/style.css', url))
    expect(resource.status).toBe(200)
    expect(await resource.text()).toBe('h1 { color: green }')
    await rejects(server.open(join(f.other, 'private.html'), f.other, access), /当前工作区中的 HTML/)
    symlinkSync(f.other, join(f.scratch, 'escaped'), 'junction')
    const escaped = await fetch(new URL('../escaped/private.html', url))
    expect(escaped.status).toBe(403)
    expect(await escaped.text()).not.toContain('PRIVATE_OUTSIDE')
    expect(f.filesystem.getAllowedRoots()).toEqual(allowed)
    expect(() => f.filesystem.assertAllowed(join(f.scratch, 'docs', 'page.html'))).toThrow(/拒绝访问工作区之外/)
    await rejects(server.open(join(f.scratch, 'docs', 'page.html'), f.scratch), /拒绝访问工作区之外/)
    f.setBinding({ root: f.other, bindingEpoch: 'binding-two', entries: [] })
    const revoked = await fetch(url)
    expect(revoked.status).toBe(404)
    expect(await revoked.text()).not.toContain('SESSION_PREVIEW')
  } finally { f.cleanup() }
})

test('Code 已授权目录在引擎离线时仍可运行，且不查询会话绑定', async () => {
  const f = fixture()
  try {
    f.setSnapshot({ phase: 'idle' })
    const url = await f.server().open(join(f.codeRoot, 'offline.html'), f.codeRoot)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>CODE_OFFLINE</h1>')
    expect(f.calls).toEqual([])
  } finally { f.cleanup() }
})

for (const changed of ['root', 'epoch', 'epoch-missing'] as const) test(`绑定 ${changed} 变化会永久撤销原授权`, async () => {
  const f = fixture()
  try {
    const access = await f.access()
    f.setBinding({ root: changed === 'root' ? f.other : f.scratch,
      ...(changed !== 'epoch-missing' ? { bindingEpoch: changed === 'epoch' ? 'binding-two' : 'binding-one' } : {}), entries: [] })
    await rejects(access.validate(), /工作区已变化/)
    const count = f.calls.length
    f.setBinding({ root: f.scratch, bindingEpoch: 'binding-one', entries: [] })
    await rejects(access.validate(), /工作区已变化/)
    expect(f.calls).toHaveLength(count)
  } finally { f.cleanup() }
})

for (const change of [
  { instanceId: 'other-instance' }, { accountId: 'other-user' }, { baseUrl: 'http://127.0.0.1:12400' },
  { mode: 'remote' as const }, { phase: 'idle' as const }
]) test(`引擎 ${Object.keys(change)[0]} 变化撤销授权，恢复原身份也不能复用`, async () => {
  const f = fixture()
  try {
    const access = await f.access(), count = f.calls.length
    f.setSnapshot(change)
    await rejects(access.validate(), /引擎连接已变化/)
    expect(f.calls).toHaveLength(count)
    f.setSnapshot({ ...expected, phase: 'ready' })
    await rejects(access.validate(), /工作区已变化/)
    expect(f.calls).toHaveLength(count)
  } finally { f.cleanup() }
})

test('认证请求返回期间切换引擎，不签发旧响应的目录授权', async () => {
  const f = fixture()
  try {
    f.duringRequest(() => f.setSnapshot({ instanceId: 'replacement' }))
    await rejects(f.access(), /引擎连接已变化/)
    expect(f.calls).toHaveLength(1)
    expect(() => f.filesystem.assertAllowed(f.scratch)).toThrow(/拒绝访问工作区之外/)
  } finally { f.cleanup() }
})

test('目录别名重新指向其它真实目录时，原授权失效', async () => {
  const f = fixture()
  try {
    const alias = join(f.directory, 'workspace-alias')
    symlinkSync(f.scratch, alias, 'junction')
    f.setBinding({ root: alias, bindingEpoch: 'binding-one', entries: [] })
    const access = await f.access()
    expect(access.root).toBe(realpathSync(f.scratch))
    unlinkSync(alias); symlinkSync(f.other, alias, 'junction')
    await rejects(access.validate(), /工作区已变化/)
  } finally { f.cleanup() }
})

test('绑定请求失败会撤销旧授权，但重新运行可获得独立有效授权', async () => {
  const f = fixture()
  try {
    const server = f.server(), first = await f.access()
    const oldUrl = await server.open(join(f.scratch, 'docs', 'page.html'), f.scratch, first)
    f.failRequest()
    await rejects(first.validate(), /temporarily unavailable/)
    f.setBinding({ root: f.scratch, bindingEpoch: 'binding-one', entries: [] })
    await rejects(first.validate(), /工作区已变化/)
    const fresh = await f.access()
    expect(fresh.key).not.toBe(first.key)
    await fresh.validate()
    const url = await server.open(join(f.scratch, 'docs', 'page.html'), f.scratch, fresh)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>SESSION_PREVIEW</h1>')
    const oldResponse = await fetch(oldUrl)
    expect(oldResponse.status).toBe(404)
    expect(await oldResponse.text()).not.toContain('SESSION_PREVIEW')
  } finally { f.cleanup() }
})

for (const invalid of [
  { root: 'relative/root', entries: [] }, { root: 10, entries: [] },
  { root: 'root\u0000with-control', entries: [] }, { entries: [] }
]) test(`无效目录响应不会产生授权：${JSON.stringify(invalid)}`, async () => {
  const f = fixture()
  try {
    f.setBinding(invalid)
    await rejects(f.access(), /未提供有效的会话工作区/)
    expect(f.filesystem.getAllowedRoots()).toHaveLength(1)
  } finally { f.cleanup() }
})
