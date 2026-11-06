/** Work 全文搜索 API 纯逻辑：会话绑定、后端选项、取消隔离、迟到响应与结果边界；无需 Electron。 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import type { EngineRequestInput, EngineRequestResult, SearchOptions } from '../src/shared/ipc'
import type { SessionFileTarget } from '../src/renderer/src/core/workspace/fs-client'
import type { WorkSearchApiDependencies } from '../src/renderer/src/contrib/work/work-search-api'
import * as pathSafety from '../src/shared/path-safety'

type SearchApiModule = typeof import('../src/renderer/src/contrib/work/work-search-api')

function loadSearchApi(): SearchApiModule {
  const filename = resolve(__dirname, '../src/renderer/src/contrib/work/work-search-api.ts')
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const unexpected = (): never => { throw new Error('Search must use the injected session dependencies') }
  const dependencies: Record<string, unknown> = {
    '@shared/path-safety': pathSafety,
    '../../core/engine/client': { request: unexpected },
    '../../core/workspace/fs-client': { assertSessionFileTarget: unexpected }
  }
  // A module import must not silently initialize the current Code workspace or
  // fall back to reading its file tree when the search endpoint is unavailable.
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected Work search dependency: ${name}`)
    return dependencies[name]
  } }, { filename })
  return module.exports as SearchApiModule
}

const { startWorkSearch } = loadSearchApi()
const options: SearchOptions = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' }
const hit = { path: 'src/hello.ts', line: 3, text: 'hello world', column: 1, length: 5 }

function ok(data: unknown): EngineRequestResult<unknown> {
  return { ok: true, code: 0, message: '', data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function expectRejection(operation: Promise<unknown>, message: string): Promise<void> {
  // VM promises belong to another realm; normalize their outcome before using
  // assertions so the test still fails if an invalid response resolves.
  const result = await operation.then(
    () => ({ rejected: false, message: '' }),
    reason => ({ rejected: true, message: String(reason) })
  )
  expect(result.rejected).toBe(true)
  expect(result.message).toContain(message)
}

function fixture(mode: 'embedded' | 'remote' = 'embedded') {
  const root = mode === 'embedded' ? 'D:/engine/work-home/task-a' : '/engine/work/task-a'
  const target: SessionFileTarget = { source: 8, expectedEngine: {
    mode, baseUrl: 'http://engine.test', instanceId: 'engine-a', accountId: 'account-a'
  }, sessionId: 'work-task-a', root, bindingEpoch: 'epoch-a', key: 'task-a-bound' }
  const calls: EngineRequestInput[] = []
  const assertions: SessionFileTarget[] = []
  let current = true, engineCurrent = true, nextId = 0
  const data = (overrides: Record<string, unknown> = {}) => ({
    root, bindingEpoch: 'epoch-a', hits: [hit], truncated: false, strategy: 'scan', ...overrides
  })
  let reply = async (): Promise<EngineRequestResult<unknown>> => ok(data())
  let cancelReply = async (): Promise<EngineRequestResult<unknown>> => ok({ cancelled: true })
  const deps: WorkSearchApiDependencies = {
    assertTarget(actual) {
      assertions.push(actual)
      expect(actual).toBe(target)
      if (!engineCurrent) throw new Error('引擎连接已变化')
    },
    async request(input) {
      calls.push(input)
      return input.path === '/workspace/search/cancel' ? cancelReply() : reply()
    },
    newId: () => `search-${++nextId}`
  }
  return { root, target, deps, data, calls, assertions,
    current: () => current,
    changeSession: () => { current = false },
    changeEngine: () => { engineCurrent = false },
    replyWith: (value: unknown) => { reply = async () => ok(value) },
    respond: (operation: () => Promise<EngineRequestResult<unknown>>) => { reply = operation },
    failCancel: () => { cancelReply = async () => { throw new Error('cancel transport failed') } },
    start: () => startWorkSearch(target, () => current, 'hello', options, {}, true, deps)
  }
}

for (const mode of ['embedded', 'remote'] as const) {
  test(`${mode} 搜索只调用会话绑定的后端接口，不遍历目录或逐文件读取`, async () => {
    const f = fixture(mode)
    const result = await f.start().promise
    expect(result).toEqual({ hits: [hit], truncated: false, strategy: 'scan', error: undefined })
    expect(f.calls).toEqual([{
      method: 'POST', path: '/workspace/search', expectedEngine: f.target.expectedEngine,
      toolProfile: 'general', body: { sessionId: 'work-task-a', expectedRoot: f.root,
        bindingEpoch: 'epoch-a', requestId: 'search-1', query: 'hello', options, excludes: {}, useIgnoreFiles: true }
    }])
    expect(f.calls[0].expectedEngine).toBe(f.target.expectedEngine)
    expect(f.assertions).toHaveLength(2)
  })
}

test('搜索选项、glob、排除开关与忽略文件设置原样交给后端', async () => {
  const f = fixture('remote')
  const config = { caseSensitive: true, wholeWord: true, useRegex: true, include: '**/*.ts,*.md', exclude: '**/generated/**' }
  const excludes = { '**/node_modules': false, '**/.git': true }
  await startWorkSearch(f.target, f.current, '^(hello|世界)$', config, excludes, false, f.deps).promise
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].body).toEqual({ sessionId: 'work-task-a', expectedRoot: f.root, bindingEpoch: 'epoch-a',
    requestId: 'search-1', query: '^(hello|世界)$', options: config, excludes, useIgnoreFiles: false })
})

test('有效部分命中保留，并明确携带截断状态和后端失败说明', async () => {
  const f = fixture()
  f.replyWith(f.data({ hits: [hit, { ...hit, path: 'README.md', line: 9 }], truncated: true,
    strategy: 'git', error: '无法读取 private.txt；结果不完整' }))
  expect(await f.start().promise).toEqual({ hits: [hit, { ...hit, path: 'README.md', line: 9 }],
    truncated: true, strategy: 'git', error: '无法读取 private.txt；结果不完整' })
})

test('取消只发送一次原引擎和本请求的取消指令，并拒绝迟到命中', async () => {
  const f = fixture('remote'), pending = deferred<EngineRequestResult<unknown>>()
  f.respond(() => pending.promise)
  const operation = f.start()
  operation.cancel()
  operation.cancel()
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]).toEqual({ method: 'POST', path: '/workspace/search/cancel',
    expectedEngine: f.target.expectedEngine, toolProfile: 'general',
    body: { sessionId: 'work-task-a', requestId: 'search-1' } })
  expect(f.calls[1].expectedEngine).toBe(f.target.expectedEngine)
  pending.resolve(ok(f.data()))
  await expectRejection(operation.promise, '搜索已取消')
  operation.cancel()
  expect(f.calls).toHaveLength(2)
})

test('同时搜索的请求 ID 独立，取消一个不会取消另一个', async () => {
  const f = fixture(), firstPending = deferred<EngineRequestResult<unknown>>(), secondPending = deferred<EngineRequestResult<unknown>>()
  f.respond(() => firstPending.promise)
  const first = f.start()
  f.respond(() => secondPending.promise)
  const second = f.start()
  first.cancel()
  expect(f.calls.map(call => call.body)).toEqual([
    expect.objectContaining({ requestId: 'search-1' }),
    expect.objectContaining({ requestId: 'search-2' }),
    { sessionId: 'work-task-a', requestId: 'search-1' }
  ])
  firstPending.resolve(ok(f.data()))
  secondPending.resolve(ok(f.data({ hits: [{ ...hit, path: 'second.ts' }] })))
  await expectRejection(first.promise, '搜索已取消')
  expect((await second.promise).hits.map(value => value.path)).toEqual(['second.ts'])
  second.cancel()
  expect(f.calls).toHaveLength(3)
})

test('取消接口失败仍丢弃迟到结果，已结束的搜索不发送取消请求', async () => {
  const f = fixture(), pending = deferred<EngineRequestResult<unknown>>()
  f.respond(() => pending.promise)
  f.failCancel()
  const operation = f.start()
  operation.cancel()
  pending.resolve(ok(f.data()))
  await expectRejection(operation.promise, '搜索已取消')
  expect(f.calls.filter(call => call.path.endsWith('/cancel'))).toHaveLength(1)
  const completed = fixture()
  const done = completed.start()
  await done.promise
  done.cancel()
  expect(completed.calls.map(call => call.path)).toEqual(['/workspace/search'])
})

test('开始前已切会话或换引擎时拒绝搜索，且不产生后端请求', async () => {
  const stale = fixture()
  stale.changeSession()
  const operation = stale.start()
  operation.cancel()
  await expectRejection(operation.promise, '搜索已取消')
  expect(stale.calls).toEqual([])
  const foreign = fixture()
  foreign.changeEngine()
  await expectRejection(foreign.start().promise, '引擎连接已变化')
  expect(foreign.calls).toEqual([])
})

test('请求期间切会话或换引擎，旧结果无法进入新工作区', async () => {
  for (const change of ['session', 'engine'] as const) {
    const f = fixture(), pending = deferred<EngineRequestResult<unknown>>()
    f.respond(() => pending.promise)
    const operation = f.start()
    if (change === 'session') f.changeSession()
    else f.changeEngine()
    pending.resolve(ok(f.data()))
    await expectRejection(operation.promise, change === 'session' ? '搜索已取消' : '引擎连接已变化')
    expect(f.calls.map(call => call.path)).toEqual(['/workspace/search'])
  }
})

test('拒绝其它工作区根目录、缺失或过期 bindingEpoch 的响应', async () => {
  const f = fixture()
  for (const overrides of [
    { root: 'D:/engine/work-home/task-b' }, { root: `${f.root}/nested` }, { root: undefined },
    { bindingEpoch: 'epoch-b' }, { bindingEpoch: undefined }
  ]) {
    f.replyWith(f.data(overrides))
    await expectRejection(f.start().promise, '任务工作区已变化')
  }
})

test('根路径比较兼容 Windows 分隔符与大小写，远端 POSIX 路径保留大小写边界', async () => {
  const windows = fixture()
  windows.replyWith(windows.data({ root: 'd:\\ENGINE\\work-home\\TASK-A\\' }))
  expect((await windows.start().promise).hits).toEqual([hit])
  const remote = fixture('remote')
  remote.replyWith(remote.data({ root: `${remote.root}/` }))
  expect((await remote.start().promise).hits).toEqual([hit])
  remote.replyWith(remote.data({ root: '/engine/work/TASK-A' }))
  await expectRejection(remote.start().promise, '任务工作区已变化')
})

test('命中路径拒绝目录穿越、编码穿越、绝对路径和模糊分隔符', async () => {
  const f = fixture()
  for (const path of ['', '../outside.ts', 'src/../../outside.ts', '%2e%2e/outside.ts', '%252e%252e/outside.ts',
    'src/%2e%2e/outside.ts', 'src\\..\\outside.ts', '/etc/passwd', '//server/share', 'D:/outside.ts',
    'C:relative.ts', './relative.ts', 'src//file.ts', 'src/', 'src\\file.ts', 'null\u0000.ts', 'line\n.ts', 'del\u007f.ts']) {
    await test.step(JSON.stringify(path), async () => {
      f.replyWith(f.data({ hits: [{ ...hit, path }] }))
      await expectRejection(f.start().promise, '无效路径或位置')
    })
  }
  f.replyWith(f.data({ hits: [{ ...hit, path: '文档/100%done.md' }] }))
  expect((await f.start().promise).hits[0].path).toBe('文档/100%done.md')
})

test('命中坐标必须为安全整数，预览片段不能超过 240 字符', async () => {
  const f = fixture()
  const invalid = [
    { line: 0 }, { line: -1 }, { line: 1.5 }, { line: '1' }, { line: Number.MAX_SAFE_INTEGER + 1 },
    { column: 0 }, { column: -2 }, { column: NaN }, { column: undefined }, { column: Infinity },
    { length: -1 }, { length: 0.5 }, { length: undefined }, { length: Number.MAX_SAFE_INTEGER + 1 },
    { text: 'x'.repeat(241) }, { text: null }
  ]
  for (const overrides of invalid) {
    f.replyWith(f.data({ hits: [{ ...hit, ...overrides }] }))
    await expectRejection(f.start().promise, '无效路径或位置')
  }
  // Snippet offsets do not replace the original column; zero-width regular
  // expressions are valid hits even though their match length is zero.
  f.replyWith(f.data({ hits: [{ ...hit, column: 1200, length: 0, text: 'x'.repeat(240) }] }))
  expect((await f.start().promise).hits).toEqual([{ ...hit, column: 1200, length: 0, text: 'x'.repeat(240) }])
})

test('拒绝错误的响应结构与超量结果，边界内 2000 条命中可完整返回', async () => {
  const f = fixture()
  for (const data of [null, 'invalid', f.data({ hits: {} }), f.data({ truncated: 'false' }),
    f.data({ strategy: 'unknown' }), f.data({ strategy: ['git'] }), f.data({ error: 500 }),
    f.data({ hits: Array.from({ length: 2001 }, () => hit) })]) {
    f.replyWith(data)
    await expectRejection(f.start().promise, '搜索响应无效')
  }
  for (const invalidHit of [null, 1]) {
    f.replyWith(f.data({ hits: [invalidHit] }))
    await expectRejection(f.start().promise, '搜索结果无效')
  }
  f.replyWith(f.data({ hits: Array.from({ length: 2000 }, () => hit), truncated: true }))
  const result = await f.start().promise
  expect(result.hits).toHaveLength(2000)
  expect(result.truncated).toBe(true)
})

test('旧引擎缺少接口时明确要求升级，不回退到目录遍历', async () => {
  for (const code of [404, 40400]) {
    const f = fixture('remote')
    f.respond(async () => ({ ok: false, code, message: 'route missing', data: null }))
    await expectRejection(f.start().promise, '当前引擎尚不支持项目全文搜索')
    expect(f.calls.map(call => call.path)).toEqual(['/workspace/search'])
  }
})

test('后端业务错误和网络错误不会伪装成无匹配成功结果', async () => {
  const f = fixture()
  f.respond(async () => ({ ok: false, code: 409, message: 'workspace binding changed', data: null }))
  await expectRejection(f.start().promise, 'workspace binding changed')
  f.respond(async () => ({ ok: false, code: 500, message: '', data: null }))
  await expectRejection(f.start().promise, '项目搜索失败')
  f.respond(async () => { throw new Error('engine disconnected') })
  const operation = f.start()
  await expectRejection(operation.promise, 'engine disconnected')
  operation.cancel()
  expect(f.calls.map(call => call.path)).toEqual(['/workspace/search', '/workspace/search', '/workspace/search'])
})
