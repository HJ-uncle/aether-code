/** New isolated native BrowserService regression: closed sheets vs scroll-reachable
 * content, truthful click dispatch, and changing/occluded targets. No resident
 * profile, model, export flow, or historical E2E suite is used. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserService } from '../src/main/browser/service'
import type { BrowserSnapshot, BrowserToolRequest, BrowserToolResult } from '../src/shared/browser'
import { browserOutputPresentation } from '../../ai-agent-engine/src/core/utils/browser-output'

interface Evidence { events: { type: string; id: string; trusted: boolean }[]; scrollY: number; nestedScrollTop: number }
interface Harness {
  service: BrowserService
  context: { engineId: string; sessionId: string }
  tabId: string
  wc: import('electron').WebContents
  commands: string[]
  hook?: 'move-before-validation' | 'obscure-after-preparation' | 'fail-mouse-release' | 'cancel-after-preparation'
  cancellation?: AbortController
  ready: boolean
}
type FixtureGlobal = typeof globalThis & { actionability: Harness }
const root = resolve(__dirname, '..'), temporary = join(root, '.e2e-tmp')
let app: ElectronApplication, server: Server, fixture: string

const html = `<!doctype html><meta charset="utf-8"><title>Actionability fixture</title>
<style>
body{margin:0;font:18px system-ui}main{padding:24px}button{min-width:140px;min-height:44px}
#host{margin-top:24px}#underlay{position:fixed;bottom:0;left:0;right:0;height:32px}
#host.sheet{position:fixed;left:24px;right:24px;bottom:0;height:240px;padding:24px;background:white;transform:translateY(105%)}
#host.sheet.open{transform:translateY(0)}#host.scroller{height:180px;overflow:auto}
#overlay{position:fixed;inset:0;background:#ccc;z-index:20}#overlay[hidden]{display:none}
</style><main><h1>Native actionability</h1><div id="host"></div></main>
<button id="underlay">Unrelated edge</button><div id="overlay" hidden></div>
<script>
const host=document.getElementById('host'),overlay=document.getElementById('overlay');let events=[];
for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>events.push({type,id:e.target.id,trusted:e.isTrusted}),true);
window.fixture={reset(name){host.className='';host.removeAttribute('style');host.removeAttribute('aria-hidden');host.removeAttribute('inert');
host.innerHTML='<button id="target">Target control</button>';overlay.hidden=true;
if(name==='below-fold')host.style.marginTop='1800px';
if(name==='nested-scroll'){host.className='scroller';host.firstElementChild.style.marginTop='1000px'}
if(name==='aria-hidden')host.setAttribute('aria-hidden','true');if(name==='inert')host.setAttribute('inert','');
if(name==='hidden')host.hidden=true;else host.hidden=false;
if(name==='disabled')host.firstElementChild.disabled=true;
if(name==='display-none')host.style.display='none';if(name==='visibility-hidden')host.style.visibility='hidden';
if(name==='fixed-offscreen')host.className='sheet';if(name==='closed-after-snapshot')host.className='sheet open';
if(name==='overlay')overlay.hidden=false;
if(name==='oversized-partial'){Object.assign(host.firstElementChild.style,{position:'fixed',left:'-1400px',top:'100px',width:'1600px'})}
scrollTo(0,0);host.scrollTop=0;events=[];},close(){host.classList.remove('open')},obscure(){overlay.hidden=false},
move(){host.firstElementChild.style.transform='translateX(250px)'},
evidence(){return {events:[...events],scrollY,nestedScrollTop:host.scrollTop}}};window.fixture.reset('visible');
</script>`

test.beforeAll(async () => {
  mkdirSync(temporary, { recursive: true }); fixture = mkdtempSync(join(temporary, 'browser-actionability-'))
  writeFileSync(join(fixture, 'page.html'), html)
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback fixture server')
  const main = join(fixture, 'main.cjs')
  await build({ stdin: { contents: `
    import {app,BrowserWindow} from 'electron';
    import {BrowserService} from ${JSON.stringify(join(root, 'src/main/browser/service.ts'))};
    app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});
    app.whenReady().then(async()=>{
      const owner=new BrowserWindow({width:1000,height:760,useContentSize:true,show:true,webPreferences:{backgroundThrottling:false}});
      await owner.loadURL('about:blank');
      const context={engineId:'isolated-actionability',sessionId:'isolated-actionability'};
      const service=new BrowserService(()=>owner,event=>{
        if(event.type==='reveal')service.setBounds({tabId:event.tabId,bounds:{x:0,y:0,width:1000,height:760},visible:true,revealRequestId:event.requestId});
      });
      service.updateSettings({aiEnabled:true,persistSession:false,zoomFactor:1,defaultViewport:null});
      const tab=await service.create({url:'http://127.0.0.1:${address.port}/',context});
      service.setBounds({tabId:tab.tabId,bounds:{x:0,y:0,width:1000,height:760},visible:true});
      const view=owner.contentView.children.find(child=>child.webContents);
      const wc=view.webContents;
      const state=globalThis.actionability={service,context,tabId:tab.tabId,wc,commands:[],ready:true};
      const command=wc.debugger.sendCommand.bind(wc.debugger);
      wc.debugger.sendCommand=async(method,params,...rest)=>{
        if(method==='Input.dispatchMouseEvent')state.commands.push(params.type);
        if(state.hook==='fail-mouse-release'&&method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased'){
          state.hook=undefined;throw new Error('fixture release acknowledgement lost');
        }
        if(state.hook==='move-before-validation'&&method==='Runtime.callFunctionOn'&&params.functionDeclaration?.includes('const {element,context}=this,frame=')){
          state.hook=undefined;await wc.executeJavaScript('window.fixture.move()');
        }
        if(state.hook==='obscure-after-preparation'&&method==='Runtime.callFunctionOn'&&params.functionDeclaration?.includes('return {scrolled:this.scrolled,error:this.error}')){
          state.hook=undefined;await wc.executeJavaScript('window.fixture.obscure()');
        }
        if(state.hook==='cancel-after-preparation'&&method==='Runtime.callFunctionOn'&&params.functionDeclaration?.includes('return {scrolled:this.scrolled,error:this.error}')){
          state.hook=undefined;state.cancellation.abort();
        }
        return command(method,params,...rest);
      };
      app.on('before-quit',()=>service.dispose());
    });app.on('window-all-closed',()=>app.quit());`, resolveDir: root, loader: 'ts' },
    outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [main], cwd: root, env })
  await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).actionability?.ready)).toBe(true)
})

test.afterAll(async () => {
  await app?.close(); await new Promise<void>(done => server?.close(() => done()) ?? done())
  if (fixture && dirname(fixture) === temporary && basename(fixture).startsWith('browser-actionability-') &&
      !lstatSync(fixture).isSymbolicLink() && realpathSync(fixture) === fixture) rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

async function reset(name: string): Promise<void> {
  await app.evaluate(async (_electron, name) => {
    const h = (globalThis as FixtureGlobal).actionability; h.commands.length = 0; h.hook = undefined
    await h.wc.executeJavaScript(`window.fixture.reset(${JSON.stringify(name)})`)
  }, name)
}
async function execute(request: Partial<BrowserToolRequest>): Promise<BrowserToolResult> {
  return app.evaluate(async (_electron, request) => {
    const h = (globalThis as FixtureGlobal).actionability
    h.cancellation = new AbortController()
    return h.service.execute({ tabId: h.tabId, ...request } as BrowserToolRequest, h.context, h.cancellation.signal)
  }, request)
}
async function evidence(): Promise<Evidence & { commands: string[] }> {
  return app.evaluate(async () => {
    const h = (globalThis as FixtureGlobal).actionability
    return { ...await h.wc.executeJavaScript('window.fixture.evidence()'), commands: [...h.commands] }
  })
}
async function snapshot(): Promise<BrowserSnapshot> {
  const result = await execute({ action: 'snapshot' }); expect(result.success, result.error).toBe(true)
  return result.output as BrowserSnapshot
}

for (const scale of [1, 2]) test(`DPR ${scale}: 普通离屏控件可滚动点击，关闭抽屉不能误点视口边缘`, async () => {
  await execute({ action: 'viewport', viewport: { width: 1000, height: 760, deviceScaleFactor: scale, mobile: false } })
  for (const name of ['below-fold', 'nested-scroll']) {
    await reset(name)
    const before = await snapshot(), target = before.elements.find(item => item.role === 'button' && item.name === 'Target control')
    expect(target?.ref).toBeDefined(); expect(target?.inViewport).toBe(false)
    const normalized = browserOutputPresentation(JSON.stringify(before), 64 * 1024)
    expect(JSON.parse(normalized!.modelInputContent).elements.find((item: { ref: string }) => item.ref === target!.ref).inViewport).toBe(false)
    const click = await execute({ action: 'click', ref: target!.ref, navigationId: before.tab.navigationId })
    expect(click.success, click.error).toBe(true); expect(click.metadata?.operationPerformed).toBe(true)
    const after = await evidence()
    expect(after.commands).toEqual(['mousePressed', 'mouseReleased'])
    expect(after.events.filter(event => event.type === 'click')).toEqual([{ type: 'click', id: 'target', trusted: true }])
    expect(name === 'below-fold' ? after.scrollY : after.nestedScrollTop).toBeGreaterThan(0)
  }
  await reset('fixed-offscreen')
  const before = await snapshot(), target = before.elements.find(item => item.role === 'button' && item.name === 'Target control')
  expect(target?.inViewport).toBe(false)
  const click = await execute({ action: 'click', selector: '#target' })
  expect(click.success).toBe(false); expect(click.metadata?.operationPerformed).toBe(false)
  expect(click.error).toContain('视口外'); expect(click.error).toContain('未发送鼠标点击')
  expect((await evidence()).commands).toEqual([]); expect((await evidence()).events).toEqual([])
})

test('隐藏、禁用区域和遮挡拒绝不发送鼠标，也不误报 unknown', async () => {
  for (const name of ['hidden', 'inert', 'display-none', 'visibility-hidden', 'disabled', 'overlay']) {
    await reset(name)
    const observed = await snapshot()
    if (!['overlay', 'disabled'].includes(name)) expect(observed.elements.some(item => item.role === 'button' && item.name === 'Target control')).toBe(false)
    const result = await execute({ action: 'click', selector: '#target' })
    expect(result.success, name).toBe(false); expect(result.metadata?.operationPerformed, name).toBe(false)
    if (name === 'overlay') expect(result.error).toContain('遮挡')
    expect((await evidence()).commands, name).toEqual([]); expect((await evidence()).events, name).toEqual([])
  }
})

test('aria-hidden 语义不阻断截图中真实可见控件的物理点击', async () => {
  for (const locator of ['coordinates', 'selector']) {
    await reset('aria-hidden')
    const observed = await snapshot()
    expect(observed.elements.some(item => item.role === 'button' && item.name === 'Target control')).toBe(false)
    expect(observed.screenshot?.width).toBeGreaterThan(500)
    const coordinates = await app.evaluate(() => (globalThis as FixtureGlobal).actionability.wc.executeJavaScript(
      '(()=>{const r=document.getElementById("target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'))
    const result = await execute({ action: 'click', ...(locator === 'coordinates' ? coordinates : { selector: '#target' }) })
    expect(result.success, result.error).toBe(true)
    expect((await evidence()).events.filter(event => event.type === 'click')).toEqual([{ type: 'click', id: 'target', trusted: true }])
  }
})

test('正常按钮和部分可见的大元素只点击其真实可见区域', async () => {
  for (const name of ['visible', 'oversized-partial']) {
    await reset(name)
    const result = await execute({ action: 'click', selector: '#target' })
    expect(result.success, result.error).toBe(true)
    expect((await evidence()).events.filter(event => event.type === 'click')).toEqual([{ type: 'click', id: 'target', trusted: true }])
  }
})

test('快照后抽屉关闭、截图后目标移动或准备后被遮挡均拒绝，不重放动作', async () => {
  await reset('closed-after-snapshot')
  const before = await snapshot(), target = before.elements.find(item => item.role === 'button' && item.name === 'Target control')
  expect(target?.inViewport).toBe(true)
  await app.evaluate(() => (globalThis as FixtureGlobal).actionability.wc.executeJavaScript('window.fixture.close()'))
  const closed = await execute({ action: 'click', ref: target!.ref, navigationId: before.tab.navigationId })
  expect(closed.metadata?.operationPerformed).toBe(false); expect(closed.error).toContain('视口外')
  expect((await evidence()).commands).toEqual([])
  for (const hook of ['move-before-validation', 'obscure-after-preparation'] as const) {
    await reset('below-fold')
    await app.evaluate((_electron, hook) => { (globalThis as FixtureGlobal).actionability.hook = hook }, hook)
    const result = await execute({ action: 'click', selector: '#target' })
    expect(result.success).toBe(false); expect(result.metadata?.operationPerformed).toBe(false)
    expect(result.error).toContain('定位时已滚动页面或容器')
    const after = await evidence(); expect(after.scrollY).toBeGreaterThan(0)
    expect(after.commands).toEqual([]); expect(after.events).toEqual([])
  }
})

test('鼠标已经发送但回执失败时仍如实返回 unknown', async () => {
  await reset('visible')
  await app.evaluate(() => { (globalThis as FixtureGlobal).actionability.hook = 'fail-mouse-release' })
  const result = await execute({ action: 'click', selector: '#target' })
  expect(result.success).toBe(false); expect(result.metadata?.operationPerformed).toBe('unknown')
  expect((await evidence()).commands).toEqual(['mousePressed', 'mouseReleased'])
  expect((await evidence()).events.map(event => event.type)).toContain('mousedown')
})

test('定位滚动后的取消明确没有点击，并保留滚动可能发生的说明', async () => {
  await reset('below-fold')
  await app.evaluate(() => { (globalThis as FixtureGlobal).actionability.hook = 'cancel-after-preparation' })
  const result = await execute({ action: 'click', selector: '#target' })
  expect(result.success).toBe(false); expect(result.metadata?.operationPerformed).toBe(false)
  expect(result.error).toContain('未发送鼠标点击'); expect(result.error).toContain('是否发生滚动无法确认')
  const after = await evidence(); expect(after.scrollY).toBeGreaterThan(0)
  expect(after.commands).toEqual([]); expect(after.events).toEqual([])
})
