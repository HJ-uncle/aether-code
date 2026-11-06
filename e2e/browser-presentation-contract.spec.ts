/** Execute production presentation/create/geometry methods without Electron or a model. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { BrowserContext, BrowserSurfaceOwner, BrowserTabPresentation, BrowserTabState } from '../src/shared/browser'
import type { BrowserConnectInput } from '../src/shared/browser-api'
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser'
import { BrowserPresentationRegistry, BrowserSurfaceOwnership, validatePresentation } from '../src/main/browser/surface-ownership'
import { clampBounds, contextsMatch, normalizeBrowserUrl, pendingBrowserEngineMatches, validateContext } from '../src/main/browser/validation'

const filename = resolve(__dirname, '../src/main/browser/service.ts')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
const methods = ['create', 'currentPresentation', 'rememberPresentation', 'activateSurface', 'hideSurfaces', 'setBounds', 'adoptUnboundTabs', 'bindContext']
const service = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BrowserService')!
const declarations = methods.map(name => {
  const method = service.members.find(node => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
  if (!method) throw new Error(`Missing production BrowserService.${name}`)
  return method.getText(source)
})
const compiled = ts.transpileModule(`class Fixture {
  tabs = new Map(); surfaceOwnership = new BrowserSurfaceOwnership(); presentations = new BrowserPresentationRegistry();
  settings = {get: () => settings}; temporaryPartition = 'temporary'; localPartition = 'local'; disposed = false;
  constructor(){this.surfaceOwnership.reset()}
  getWindow(){return owner} configureSession(){} observeOwner(){} observe(){}
  initialize(){return initialization} applyViewport(){return Promise.resolve()}
  navigate(entry,url){entry.state.url=url;return Promise.resolve()}
  state(entry){return structuredClone(entry.state)} entry(id){const entry=this.tabs.get(id);if(!entry)throw new Error('missing tab');return entry}
  changed(entry){events.push({type:'changed',tab:this.state(entry)})} emit(event){events.push(event)}
  ${declarations.join('\n')}
} globalThis.Service=Fixture;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

type Engine = BrowserConnectInput['expectedEngine']
type Entry = { state: BrowserTabState; visible: boolean; layoutVersion: number; view: { visible: boolean } }
interface Service {
  tabs: Map<string, Entry>
  create(input?: { context?: BrowserContext; url?: string }, engine?: Engine, onCreated?: () => void, presentation?: BrowserTabPresentation): Promise<BrowserTabState>
  activateSurface(owner: BrowserSurfaceOwner, engine?: Engine): void
  currentPresentation(): BrowserTabPresentation | undefined
  rememberPresentation(context: BrowserContext, mode: 'code' | 'work'): void
  adoptUnboundTabs(context: BrowserContext, engine: Engine): void
  setBounds(input: { tabId: string; surface: BrowserSurfaceOwner; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }): void
}
function fixture(initialization = Promise.resolve()) {
  const events: unknown[] = [], owner = { isDestroyed: () => false, getContentSize: () => [1_000, 750], contentView: { addChildView() {} } }
  class View {
    visible = false
    webContents = { isDestroyed: () => false }
    setBounds() {}
    setVisible(value: boolean) { this.visible = value }
  }
  const context = { events, owner, initialization, settings: DEFAULT_BROWSER_SETTINGS, structuredClone, randomUUID,
    BrowserPresentationRegistry, BrowserSurfaceOwnership, validatePresentation, clampBounds, contextsMatch,
    normalizeBrowserUrl, pendingBrowserEngineMatches, validateContext, isLocalFileUrl: () => false,
    session: { fromPartition: () => ({}) }, WebContentsView: View, BrowserNetworkCollector: class {},
    AbortController, Service: undefined as unknown as new () => Service }
  runInNewContext(compiled, context)
  const host = new context.Service()
  const bounds = (tabId: string, surface: BrowserSurfaceOwner, visible = true) => host.setBounds({ tabId, surface, visible, bounds: { x: 0, y: 0, width: 800, height: 600 } })
  return { host, events, bounds, visible: (tabId: string) => host.tabs.get(tabId)!.view.visible }
}
const ready: Engine = { mode: 'embedded', baseUrl: 'http://127.0.0.1:12323', instanceId: 'engine-one', accountId: null }
const engineId = JSON.stringify([ready.mode, ready.baseUrl, ready.instanceId, ready.accountId])
const context = (sessionId: string): BrowserContext => ({ sessionId, engineId })

test('background native tabs keep their context and never borrow the foreground presentation', async () => {
  const f = fixture(), code = { mode: 'code' as const, sessionId: 'code-task', engineId, generation: 1 }
  f.host.activateSurface(code)
  const user = await f.host.create({}, ready, undefined, f.host.currentPresentation())
  f.host.rememberPresentation(context('work-one'), 'work')
  const work = await f.host.create({ context: context('work-one') })
  const unknown = await f.host.create({ context: context('work-two') })
  expect(user.presentation).toEqual({ mode: 'code', sessionId: 'code-task', engineId })
  expect(work.presentation).toEqual({ mode: 'work', ...context('work-one') })
  expect(unknown.presentation).toBeUndefined()
  f.bounds(user.tabId, code)
  f.bounds(work.tabId, code)
  f.bounds(unknown.tabId, code)
  expect(f.visible(user.tabId)).toBe(true)
  expect(f.visible(work.tabId)).toBe(false)
  expect(f.visible(unknown.tabId)).toBe(false)
  f.host.rememberPresentation(context('work-two'), 'work')
  expect(f.host.tabs.get(unknown.tabId)!.state).toMatchObject({ context: context('work-two'), presentation: { mode: 'work', ...context('work-two') } })
  const workOwner = { mode: 'work' as const, ...context('work-one'), generation: 2 }
  f.host.activateSurface(workOwner)
  f.bounds(work.tabId, workOwner)
  expect(f.visible(user.tabId)).toBe(false)
  expect(f.visible(work.tabId)).toBe(true)
  f.bounds(work.tabId, code, false)
  expect(f.visible(work.tabId)).toBe(true)
  f.host.activateSurface({ ...workOwner, sessionId: 'work-two', generation: 3 })
  f.bounds(work.tabId, workOwner)
  expect(f.visible(work.tabId)).toBe(false)
})

test('adoption cannot transfer an unbound tab across modes, sessions, or engines', async () => {
  const f = fixture(), target = context('first')
  const presentations: BrowserTabPresentation[] = [
    { mode: 'code', sessionId: 'first' }, { mode: 'work', sessionId: 'first' },
    { mode: 'code', sessionId: 'second' }, { mode: 'code', sessionId: null },
    { mode: 'code', sessionId: 'first', engineId: 'foreign-engine' }
  ]
  const tabs = await Promise.all(presentations.map(presentation => f.host.create({}, ready, undefined, presentation)))
  f.host.rememberPresentation(target, 'code')
  f.host.adoptUnboundTabs(target, ready)
  expect(tabs.map(tab => f.host.tabs.get(tab.tabId)!.state.context)).toEqual([target, undefined, undefined, undefined, undefined])
  expect(f.host.tabs.get(tabs[0].tabId)!.state.presentation).toEqual({ mode: 'code', ...target })
})

test('verified engine readiness fills an offline page display identity without granting tool context', async () => {
  const f = fixture(), initial = { mode: 'code' as const, sessionId: null, pendingSourceId: 'selected-local-account', generation: 1 }
  f.host.activateSurface(initial)
  const own = await f.host.create({}, { mode: 'embedded', baseUrl: '', accountId: null }, undefined, f.host.currentPresentation())
  const foreign = await f.host.create({}, { ...ready, accountId: 'other-account' }, undefined, f.host.currentPresentation())
  f.bounds(own.tabId, initial)
  expect(f.visible(own.tabId)).toBe(true)
  const next = { mode: initial.mode, sessionId: initial.sessionId, generation: 2, engineId }
  f.host.activateSurface(next, ready)
  expect(f.host.tabs.get(own.tabId)!.state).toMatchObject({ presentation: { mode: 'code', sessionId: null, engineId } })
  expect(f.host.tabs.get(own.tabId)!.state.presentation?.pendingSourceId).toBeUndefined()
  expect(f.host.tabs.get(own.tabId)!.state.context).toBeUndefined()
  expect(f.host.tabs.get(foreign.tabId)!.state.presentation?.engineId).toBeUndefined()
  f.bounds(own.tabId, next)
  f.bounds(foreign.tabId, next)
  expect(f.visible(own.tabId)).toBe(true)
  expect(f.visible(foreign.tabId)).toBe(false)
})

test('an asynchronous page open retains the captured presentation through a surface switch', async () => {
  let release!: () => void
  const f = fixture(new Promise<void>(resolve => { release = resolve }))
  f.host.activateSurface({ mode: 'code', sessionId: 'first', engineId, generation: 1 })
  const captured = f.host.currentPresentation()!
  const opened = f.host.create({}, ready, undefined, captured)
  captured.sessionId = 'mutated'
  f.host.activateSurface({ mode: 'work', sessionId: 'second', engineId, generation: 2 })
  release()
  expect((await opened).presentation).toEqual({ mode: 'code', sessionId: 'first', engineId })
})
