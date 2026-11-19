/** Exercise the real generic workspace store and file client through an in-memory IPC boundary. */
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import type { EngineRequestInput } from '../src/shared/ipc'

type Runtime = typeof import('../src/renderer/src/core/workspace/workspace-store') & typeof import('../src/renderer/src/core/workspace/connection') & typeof import('../src/renderer/src/core/engine/source') & typeof import('../src/shared/ipc')
const root = resolve(__dirname, '..'), requireModule = createRequire(join(root, 'package.json'))
let compiled = ''
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: [
    'export * from "./src/renderer/src/core/workspace/workspace-store"', 'export * from "./src/renderer/src/core/workspace/connection"',
    'export * from "./src/renderer/src/core/engine/source"', 'export { DEFAULT_SETTINGS } from "./src/shared/ipc"'
  ].join('\n'), resolveDir: root }, tsconfig: join(root, 'tsconfig.web.json'), bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false })
  compiled = result.outputFiles[0].text
})

function fixture(request: (input: EngineRequestInput) => Promise<unknown>) {
  const module = { exports: {} }, prefs = new Map<string, string>()
  new Function('module', 'exports', 'require', 'window', 'localStorage', compiled)(module, module.exports, requireModule,
    { aether: { engine: { request } } }, { getItem: (key: string) => prefs.get(key) ?? null, setItem: (key: string, value: string) => prefs.set(key, value) })
  const runtime = module.exports as Runtime
  const select = (session: string) => {
    const snapshot = { mode: 'remote', phase: 'ready', baseUrl: 'http://example.test/' + session } as const
    runtime.publishEngineSource(snapshot)
    runtime.publishWorkspaceSelection({ ...runtime.DEFAULT_SETTINGS, engineMode: 'remote', remoteBaseUrl: snapshot.baseUrl, lastSessionId: session, remoteWorkspaceRoot: '/' + session }, runtime.engineStorageKey(snapshot))
  }
  return { runtime, select }
}

function success(input: EngineRequestInput) {
  const id = String(input.query?.sessionId || '')
  return { ok: true, data: input.path === '/workspace/bind' ? {} : { root: '/' + id, entries: [], bindingEpoch: 'epoch-' + id } }
}

test('通用工作区只有实际使用时才绑定，读取偏好和更换来源不触发 I/O，重复消费者共享请求', async () => {
  const requests: EngineRequestInput[] = [], { runtime, select } = fixture(async input => { requests.push(input); return success(input) })
  select('first'); expect(runtime.workspacePreferencesRoot()).toBe('/first'); expect(runtime.getWorkspaceState().root).toBeNull(); expect(requests).toEqual([])
  await Promise.all([runtime.restoreLastFolder(), runtime.restoreLastFolder()]); expect(runtime.getWorkspaceState().root).toBe('/first')
  const first = requests.length; await runtime.restoreLastFolder(); expect(requests).toHaveLength(first)
  select('second'); expect(runtime.workspacePreferencesRoot()).toBe('/second'); expect(runtime.getWorkspaceState().root).toBeNull(); expect(requests).toHaveLength(first)
  await runtime.restoreLastFolder(); expect(runtime.getWorkspaceState().root).toBe('/second')
  expect(requests.filter(r => r.path === '/workspace/bind').map(r => r.body)).toEqual([{ sessionId: 'first', workspaceRoot: '/first' }, { sessionId: 'second', workspaceRoot: '/second' }])
})

test('旧服务迟到的目录响应不能恢复到新服务，切换本身也不会帮新服务建立工作区', async () => {
  let release!: () => void, started!: () => void
  const held = new Promise<void>(r => { release = r }), received = new Promise<void>(r => { started = r }), requests: EngineRequestInput[] = []
  const { runtime, select } = fixture(async input => {
    requests.push(input)
    if (input.path === '/workspace/directory' && input.query?.sessionId === 'old') { started(); await held }
    return success(input)
  })
  select('old'); expect(runtime.workspacePreferencesRoot()).toBe('/old')
  const previous = runtime.restoreLastFolder(); await received
  select('new'); release(); await previous
  expect(runtime.getWorkspaceState()).toMatchObject({ root: null, error: null }); expect(requests.filter(r => r.path === '/workspace/bind')).toHaveLength(1)
  await runtime.restoreLastFolder(); expect(runtime.getWorkspaceState().root).toBe('/new')
})
