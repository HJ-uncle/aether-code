/** Pure address routing and AI ownership contracts for explicitly selected local files. No Electron launch. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { localBrowserInput } from '../src/shared/browser-local-file'
import { pendingBrowserEngineMatches, validateContext } from '../src/main/browser/validation'
import type { BrowserService } from '../src/main/browser/service'
import type { BrowserContext, BrowserTabState } from '../src/shared/browser'
import type { BrowserConnectInput } from '../src/shared/browser-api'

test('本机绝对路径与 file URL 交给文件入口，保留中文、空格及原始大小写', () => {
  for (const value of ['C:\\资料 目录\\中文 日志.log', 'd:/报告/会议记录.txt', '/tmp/中文 文件.txt', 'file:///C:/reports/a%20b.txt']) {
    expect(localBrowserInput(value)).toBe(value)
    expect(localBrowserInput(`  ${value}  `)).toBe(value)
  }
})

test('Windows 复制为路径和单引号包裹的路径去掉一层配对引号', () => {
  const path = 'C:\\资料 目录\\中文 日志.log'
  expect(localBrowserInput(`  "${path}"  `)).toBe(path)
  expect(localBrowserInput(`'${path}'`)).toBe(path)
  expect(localBrowserInput('"file:///C:/reports/a%20b.txt"')).toBe('file:///C:/reports/a%20b.txt')
  expect(localBrowserInput(`"${path}'`)).toBeNull()
  expect(localBrowserInput(`'${path}"`)).toBeNull()
})

test('普通网址、本机服务与相对路径保持原有网页分流', () => {
  for (const value of ['', '  ', 'https://example.test/report', 'http://127.0.0.1:3000/a', 'localhost:5173',
    '127.0.0.1:3000', '[::1]:8080/', 'example.test', 'about:blank', './report.txt', '../report.txt', 'report.txt',
    'C:relative.txt', 'javascript:alert(1)', 'data:text/html,hello', 'mailto:user@example.test']) {
    expect(localBrowserInput(value), value).toBeNull()
  }
})

test('网络共享和设备路径只分流到受控本地校验，不伪装成 HTTP 地址', () => {
  for (const value of ['\\\\server\\share\\report.txt', '\\\\?\\C:\\report.txt', '\\\\.\\pipe\\test', 'file://server/share/report.txt']) {
    expect(localBrowserInput(value)).toBe(value)
  }
})

type Entry = { state: BrowserTabState; pendingEngine?: BrowserConnectInput['expectedEngine']; localPresentationEngine?: BrowserConnectInput['expectedEngine'] }
interface PolicyHost {
  tabs: Map<string, Entry>
  changes: string[]
  bindContext: BrowserService['bindContext']
  adoptUnboundTabs: BrowserService['adoptUnboundTabs']
  activateSurface: BrowserService['activateSurface']
}

// Exercise the actual Electron-owning methods without importing/launching Electron.
const filename = resolve(__dirname, '../src/main/browser/service.ts')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
const service = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BrowserService')
if (!service) throw new Error('BrowserService declaration missing')
const methods = ['bindContext', 'adoptUnboundTabs', 'activateSurface'].map(name => {
  const method = service.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)
  if (!method) throw new Error(`BrowserService.${name} missing`)
  return method.getText(source)
}).join('\n')
const Host = runInNewContext(ts.transpileModule(`class PolicyHost {
  tabs = new Map(); changes = [];
  settings = { get: () => ({ aiEnabled: true }) };
  surfaceOwnership = { activate: () => true };
  hideSurfaces() {};
  presentations = { get: context => ({ mode: 'work', sessionId: context.sessionId, engineId: context.engineId }) };
  entry(id) { const entry = this.tabs.get(id); if (!entry) throw new Error('Unknown tab'); return entry; }
  changed(entry) { this.changes.push(entry.state.tabId); }
  state(entry) { return structuredClone(entry.state); }
  ${methods}
} PolicyHost`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
{ Map, Error, structuredClone, validateContext, pendingBrowserEngineMatches }) as new () => PolicyHost

const engine: BrowserConnectInput['expectedEngine'] = { mode: 'remote', baseUrl: 'https://fixture.invalid', instanceId: 'local-preview-policy', accountId: 'fixture-user' }
const context: BrowserContext = { sessionId: 'local-preview-task', engineId: JSON.stringify(['remote', engine.baseUrl, engine.instanceId, engine.accountId]) }
function entry(id: string, local: boolean): Entry {
  return { pendingEngine: { ...engine }, state: {
    tabId: id, title: id, url: 'about:blank', loading: false, canGoBack: false, canGoForward: false,
    zoomFactor: 1, viewport: null, navigationId: 1,
    presentation: { mode: 'work', sessionId: context.sessionId },
    ...(local ? { localFile: { path: 'C:\\outside\\notes.txt', name: 'notes.txt', kind: 'text' as const, size: 5 } } : {})
  } }
}

test('用户本地文件不能显式绑定 AI，会话启动自动收养只接管普通网页', () => {
  const host = new Host(), local = entry('local', true), web = entry('web', false)
  host.tabs.set('local', local); host.tabs.set('web', web)
  const original = structuredClone(local)
  expect(() => host.bindContext('local', context)).toThrow(/本地文件.*AI/)
  expect(local).toEqual(original)
  expect(host.changes).toEqual([])
  host.adoptUnboundTabs(context, engine)
  expect(local).toEqual(original)
  expect(web.state.context).toEqual(context)
  expect(web.pendingEngine).toBeUndefined()
  expect(host.changes).toEqual(['web'])
})

test('离线本地文件仅提升匹配引擎的展示身份，不能被收养或迁移到其它账户', () => {
  const host = new Host(), local = entry('local', true), otherAccount = entry('other-account', true)
  local.pendingEngine = undefined; otherAccount.pendingEngine = undefined
  local.localPresentationEngine = { ...engine }
  otherAccount.localPresentationEngine = { ...engine, accountId: 'different-account' }
  const previousOther = structuredClone(otherAccount)
  host.tabs.set('local', local); host.tabs.set('other-account', otherAccount)
  host.activateSurface({ mode: 'work', sessionId: context.sessionId, engineId: context.engineId, generation: 2 }, engine)
  expect(local.state.presentation).toEqual({ mode: 'work', sessionId: context.sessionId, engineId: context.engineId })
  expect(local.state.context).toBeUndefined(); expect(local.pendingEngine).toBeUndefined()
  expect(otherAccount).toEqual(previousOther)
  expect(host.changes).toEqual(['local'])
  host.adoptUnboundTabs(context, engine)
  expect(local.state.context).toBeUndefined(); expect(local.pendingEngine).toBeUndefined()
  expect(host.changes).toEqual(['local'])
})
