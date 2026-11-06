/** Local-page duplication preserves scope/resources and independently revokes capabilities. No Electron launch. */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserLocalFiles } from '../src/main/browser/local-files'
import type { BrowserService } from '../src/main/browser/service'
import * as localInput from '../src/shared/browser-local-file'
import * as localContent from '../src/main/browser/local-file-content'
import * as localDirectory from '../src/main/browser/local-directory'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const localExports = {} as { BrowserLocalFiles: typeof BrowserLocalFiles }
runInNewContext(ts.transpileModule(readFileSync(join(root, 'src/main/browser/local-files.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: localExports, URL, Response, Buffer, process,
  require: (id: string) => id === 'electron' ? { app: { isReady: () => true } }
    : id === '../fs/file-service' ? { assertAllowed: (path: string) => path }
      : id === '../../shared/browser-local-file' ? localInput
        : id === './local-file-content' ? localContent
          : id === './local-directory' ? localDirectory : require(id) })

test('本地副本保留嵌套路径和根资源，关闭原标签不撤销副本', async () => {
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'duplicate-contract-'))
  try {
    const html = join(fixture, 'index.html')
    writeFileSync(html, '<h1>原稿</h1>')
    const files = new localExports.BrowserLocalFiles()
    const original = await files.open(pathToFileURL(html).href)
    const current = `${original.origin}/nested/page.html#棋谱`
    const copy = files.duplicate(current, original)
    expect(copy.root).toBe(original.root)
    expect(copy.origin).not.toBe(original.origin)
    expect(new URL(copy.url).pathname).toBe('/nested/page.html')
    expect(new URL(copy.url).hash).toBe(new URL(current).hash)
    expect(files.normalize(`${copy.origin}/theme.css`, copy)).toBe(`${copy.origin}/theme.css`)
    expect(() => files.normalize(copy.url, original)).toThrow()
    files.revoke(original)
    expect(files.normalize(copy.url, copy)).toBe(copy.url)
    expect(() => files.duplicate(current, original)).toThrow()
    files.dispose()
    expect(() => files.duplicate(copy.url, copy)).toThrow()
  } finally {
    if (dirname(resolve(fixture)) !== parent || !basename(fixture).startsWith('duplicate-contract-')) throw new Error('Unsafe cleanup')
    rmSync(fixture, { recursive: true, force: true })
  }
})

const serviceFile = join(root, 'src/main/browser/service.ts')
const source = ts.createSourceFile(serviceFile, readFileSync(serviceFile, 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BrowserService')!
const method = declaration.members.find(node => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'duplicate')!
const context = { Service: undefined as unknown as new () => { duplicate: BrowserService['duplicate']; allowed: boolean; calls: unknown[]; source: { state: { url: string } } }, Error }
runInNewContext(ts.transpileModule(`class Service {
  allowed=true; calls=[]; surfaceOwnership={canPresent:()=>this.allowed};
  source={state:{tabId:'original',url:'aether-local://old/nested/page.html',presentation:{mode:'work',sessionId:'task-a'},context:{sessionId:'task-a',engineId:'engine'},viewport:{width:390,height:844,mobile:true,deviceScaleFactor:2},zoomFactor:1.2},localFile:{root:'D:/work',origin:'aether-local://old'}};
  localFiles={duplicate:(url,grant)=>{this.calls.push(['grant',url,grant]);return {root:grant.root,origin:'aether-local://new',url:'aether-local://new/nested/page.html'}},revoke:grant=>this.calls.push(['revoke',grant])};
  entry(){return this.source}; state(entry){return structuredClone(entry.state)};
  async create(...args){this.calls.push(['create',...args]);return {tabId:'copy'}};
  async action(input){this.calls.push(['action',input]);return {tabId:input.tabId}};
  ${method.getText(source)}
} globalThis.Service=Service`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
{ ...context, structuredClone, get Service() { return context.Service }, set Service(value) { context.Service = value } })

test('复制使用原标签的会话与视口，不能将后台任务复制到前台任务', async () => {
  const host = new context.Service()
  await host.duplicate('original')
  const create = host.calls.find(call => Array.isArray(call) && call[0] === 'create') as unknown[]
  expect(create[1]).toEqual({ url: 'aether-local://old/nested/page.html', context: { sessionId: 'task-a', engineId: 'engine' } })
  expect(create[4]).toEqual({ mode: 'work', sessionId: 'task-a' })
  expect(create[5]).toMatchObject({ origin: 'aether-local://new' })
  expect(host.calls.slice(-2)).toEqual([
    ['action', { tabId: 'copy', action: 'viewport', viewport: { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 } }],
    ['action', { tabId: 'copy', action: 'zoom', zoomFactor: 1.2 }]
  ])
  host.allowed = false
  const count = host.calls.length
  const error = await host.duplicate('original').then(() => '', error => String(error))
  expect(error).toContain('该标签所属的会话')
  expect(host.calls).toHaveLength(count)
})

test('本地标签导航到 HTTP 后，复制当前网址且不复制旧文件授权', async () => {
  const host = new context.Service()
  host.source.state.url = 'https://example.test/current'
  await host.duplicate('original')
  const create = host.calls.find(call => Array.isArray(call) && call[0] === 'create') as unknown[]
  expect(create[1]).toMatchObject({ url: 'https://example.test/current' })
  expect(create[5]).toBeUndefined()
  expect(host.calls.some(call => Array.isArray(call) && call[0] === 'grant')).toBe(false)
})
