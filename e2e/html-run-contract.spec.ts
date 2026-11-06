/** Production HTML action ordering and scope races, without Electron or a model. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { rejects } from 'node:assert/strict'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserSurfaceOwner, BrowserTabState } from '../src/shared/browser'
import { browserScopeKey, browserTabInScope } from '../src/renderer/src/core/browser/scope'
import type { runHtmlFile } from '../src/renderer/src/contrib/editor/run-html'

const moduleExports: { runHtmlFile: typeof runHtmlFile } = {} as { runHtmlFile: typeof runHtmlFile }
const code = ts.transpileModule(readFileSync(resolve(__dirname, '../src/renderer/src/contrib/editor/run-html.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
runInNewContext(code, { exports: moduleExports, Error, require: (id: string) => id.endsWith('/scope')
  ? { browserScopeKey, browserTabInScope } : {} })

function fixture(mode: 'code' | 'work' = 'code') {
  let owner: BrowserSurfaceOwner = { mode, generation: 1, sessionId: 'task-one', engineId: 'engine-one' }
  const target = { path: 'D:/project/docs/围棋.html', root: 'D:/project' }
  const tab: BrowserTabState = { tabId: 'html', url: 'http://127.0.0.1:123/token/docs/html', title: '围棋',
    loading: false, canGoBack: false, canGoForward: false, zoomFactor: 1, viewport: null, navigationId: 1,
    presentation: { mode, sessionId: owner.sessionId!, engineId: owner.engineId } }
  const calls: unknown[] = []
  const host = {
    owner: () => owner,
    initialize: async () => { calls.push('initialize') },
    open: async (value: typeof target) => { calls.push(['open', value]); return tab },
    accept: (value: BrowserTabState) => { calls.push(['accept', value.tabId]) },
    reveal: (value: BrowserTabState, scope: BrowserSurfaceOwner) => { calls.push(['reveal', value.tabId, scope.mode]) }
  }
  return { target, tab, calls, host,
    run: (prepare?: () => Promise<void>) => moduleExports.runHtmlFile(target, prepare, host),
    switch: () => { owner = { ...owner, generation: owner.generation + 1, sessionId: 'task-two' } } }
}

for (const mode of ['code', 'work'] as const) test(`${mode}：先保存订阅，再打开实际文件并选中返回的标签`, async () => {
  const f = fixture(mode)
  await f.run(async () => { f.calls.push('save') })
  expect(f.calls).toEqual(['save', 'initialize', ['open', f.target], ['accept', 'html'], ['reveal', 'html', mode]])
})

for (const point of ['save', 'initialize'] as const) test(`${point} 期间切任务，不向新任务打开旧文件`, async () => {
  const f = fixture()
  if (point === 'initialize') f.host.initialize = async () => { f.calls.push('initialize'); f.switch() }
  await rejects(f.run(async () => { if (point === 'save') f.switch() }), /会话或引擎已切换/)
  expect(f.calls).toEqual(point === 'save' ? [] : ['initialize'])
})

test('打开期间切任务：保留原标签记录，但不抢新任务的显示区域', async () => {
  const f = fixture('work')
  f.host.open = async () => { f.switch(); return f.tab }
  await f.run()
  expect(f.calls).toEqual(['initialize', ['accept', 'html']])
})

test('打开失败不会再调用 reveal，也不会创建空白替代页', async () => {
  const f = fixture()
  f.host.open = async () => { throw new Error('HTML 文件不存在') }
  await rejects(f.run(), /HTML 文件不存在/)
  expect(f.calls).toEqual(['initialize'])
})

test('保存失败保留编辑器，不初始化或打开浏览器', async () => {
  const f = fixture()
  await rejects(f.run(async () => { throw new Error('磁盘冲突') }), /磁盘冲突/)
  expect(f.calls).toEqual([])
})

test('错误会话的返回标签无法被显示到当前会话', async () => {
  const f = fixture()
  f.tab.presentation!.sessionId = 'wrong-session'
  await rejects(f.run(), /网页未关联到当前会话/)
  expect(f.calls.filter(call => Array.isArray(call) && call[0] === 'reveal')).toEqual([])
})

test('Work 运行把文件会话和点击时的展示归属一起交给主进程', async () => {
  const f = fixture('work'), target = { ...f.target, sessionId: 'task-one' }
  let received: unknown
  await moduleExports.runHtmlFile(target, undefined, { ...f.host,
    open: async (file, owner) => { received = { file, owner }; return f.tab }
  })
  expect(received).toEqual({ file: target,
    owner: { mode: 'work', generation: 1, sessionId: 'task-one', engineId: 'engine-one' } })
})
