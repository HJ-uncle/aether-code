/** Fresh Electron/source fixture: independent Work sessions scroll hidden native pages without stealing the selected resource; stale/cross-session/cancelled requests never dispatch. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'
import type { BrowserService } from '../src/main/browser/service'
import type { BrowserContext, BrowserEvent, BrowserScreenshot, BrowserSnapshot, BrowserTabState, BrowserToolRequest } from '../src/shared/browser'

type Host = typeof globalThis & { backgroundScroll: { service: BrowserService; owner: BrowserWindow; events: BrowserEvent[] } }
const root = resolve(__dirname, '..')
const context = (sessionId: string): BrowserContext => ({ engineId: JSON.stringify(['embedded', 'http://127.0.0.1:1', 'fixture', null]), sessionId })
let app: ElectronApplication, fixture = ''
let first: BrowserTabState, second: BrowserTabState, front: BrowserTabState

async function execute(request: BrowserToolRequest, sessionId: string) {
  return app.evaluate(async (_electron, { request, context }) => {
    return (globalThis as Host).backgroundScroll.service.execute(request, context, undefined,
      { requestId: crypto.randomUUID(), execution: { rootSessionId: context.sessionId, rootRunId: `root-${context.sessionId}`, ownerRunId: `root-${context.sessionId}` } })
  }, { request, context: context(sessionId) })
}
async function state() {
  return app.evaluate(async ({ webContents }) => {
    const host = (globalThis as Host).backgroundScroll
    const pages: Record<string, { scrollY: number; inner: number; clicks: number; value: string }> = {}
    for (const title of ['Work finance', 'Work legal', 'Selected document']) {
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === title)
      if (!wc) throw new Error(`Missing page ${title}`)
      pages[title] = await wc.executeJavaScript('({scrollY,inner:document.querySelector("#inner").scrollTop,clicks:window.clicks,value:document.querySelector("input").value})')
    }
    return { pages, reveals: host.events.filter(event => event.type === 'reveal').length,
      visibility: host.owner.contentView.children.map(view => view.getVisible()), focus: webContents.getFocusedWebContents()?.id ?? null }
  })
}

test.describe.serial('Work 后台原生浏览器滚动隔离', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-work-scroll-'))
    const files = ['Work finance', 'Work legal', 'Selected document'].map((title, index) => {
      const file = join(fixture, `page-${index}.html`)
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{height:5000px}#inner{height:100px;overflow:auto}#inner div{height:1000px}</style><h1>${title}</h1><input value="untouched"><button onclick="window.clicks++">change</button><div id="inner"><div>nested content</div></div><script>window.clicks=0</script>`)
      return pathToFileURL(file).href
    })
    const main = join(fixture, 'main.cjs')
    // A real hidden BrowserWindow avoids interrupting the user's running office campaign.
    await build({ stdin: { contents: `import {app,BrowserWindow} from 'electron';import {BrowserService} from './src/main/browser/service';import {allowRoot} from './src/main/fs/file-service';
      app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});void app.whenReady().then(async()=>{allowRoot(${JSON.stringify(fixture)});const owner=new BrowserWindow({show:false,width:1000,height:750});await owner.loadURL('about:blank');const events=[];const service=new BrowserService(()=>owner,event=>events.push(event));globalThis.backgroundScroll={service,owner,events};});`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: main, logLevel: 'silent' })
    app = await electron.launch({ args: [main], cwd: root })
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as Host).backgroundScroll))).toBe(true)
    const tabs: BrowserTabState[] = []
    for (const [index, sessionId] of ['finance', 'legal', 'user'].entries()) {
      const result = await execute({ action: 'open', url: files[index] }, sessionId)
      expect(result.success, result.error).toBe(true)
      const tab = result.output as BrowserTabState
      await expect.poll(async () => (await execute({ action: 'snapshot', tabId: tab.tabId }, sessionId)).success).toBe(true)
      tabs.push(tab)
    }
    ;[first, second, front] = tabs
    await app.evaluate((_electron, tabs) => {
      const host = (globalThis as Host).backgroundScroll
      for (const [index, tab] of tabs.entries()) host.service.setBounds({ tabId: tab.tabId, visible: index === 2, bounds: { x: 0, y: 0, width: 900, height: 600 } })
      host.events.length = 0
    }, tabs)
  })
  test.afterAll(async () => {
    await app?.close()
    if (!fixture || dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-work-scroll-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('两个不同会话同时滚动隐藏页面，不 reveal 或改变当前资源', async ({}, testInfo) => {
    const before = await state()
    const results = await Promise.all([
      execute({ action: 'scroll', tabId: first.tabId, navigationId: first.navigationId, deltaY: 600 }, 'finance'),
      execute({ action: 'scroll', tabId: second.tabId, navigationId: second.navigationId, deltaY: 1000 }, 'legal')
    ])
    for (const result of results) expect(result, result.error).toMatchObject({ success: true, metadata: { operationPerformed: true } })
    await expect.poll(async () => (await state()).pages['Work finance'].scrollY).toBe(600)
    await expect.poll(async () => (await state()).pages['Work legal'].scrollY).toBe(1000)
    const after = await state()
    expect(after.pages['Selected document']).toEqual(before.pages['Selected document'])
    expect(after.reveals).toBe(0)
    expect(after.visibility).toEqual(before.visibility)
    expect(after.focus).toBe(before.focus)
    expect((results[0].output as BrowserSnapshot).tab.context?.sessionId).toBe('finance')
    expect((results[1].output as BrowserSnapshot).tab.context?.sessionId).toBe('legal')
    await testInfo.attach('hidden-session-scroll.json', { body: JSON.stringify({ before, after, tabs: { first, second, front } }), contentType: 'application/json' })
  })

  test('隐藏元素滚动、snapshot、screenshot保持目标会话且不抢前台', async ({}, testInfo) => {
    const before = await state()
    const scroll = await execute({ action: 'scroll', tabId: first.tabId, navigationId: first.navigationId, selector: '#inner', deltaY: 240 }, 'finance')
    expect(scroll.success, scroll.error).toBe(true)
    await expect.poll(async () => (await state()).pages['Work finance'].inner).toBe(240)
    const snapshot = await execute({ action: 'snapshot', tabId: first.tabId }, 'finance')
    expect((snapshot.output as BrowserSnapshot).text).toContain('Work finance')
    const screenshot = await execute({ action: 'screenshot', tabId: first.tabId }, 'finance')
    expect(screenshot.success, screenshot.error).toBe(true)
    const image = screenshot.output as BrowserScreenshot
    expect(image.size).toBeGreaterThan(100)
    await testInfo.attach('hidden-finance.png', { body: Buffer.from(image.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
    const after = await state()
    expect(after.pages['Work legal']).toEqual(before.pages['Work legal'])
    expect(after.pages['Selected document']).toEqual(before.pages['Selected document'])
    expect(after.reveals).toBe(0)
    expect(after.visibility).toEqual(before.visibility)
    expect(after.focus).toBe(before.focus)
  })

  test('跨会话、旧导航和取消epoch均拒绝，不产生滚动副作用', async () => {
    const navigation = await execute({ action: 'navigate', tabId: first.tabId, url: first.url }, 'finance')
    expect(navigation.success, navigation.error).toBe(true)
    const current = (navigation.output as BrowserSnapshot).tab
    expect(current.navigationId).toBeGreaterThan(first.navigationId)
    const before = await state()
    const cross = await execute({ action: 'scroll', tabId: first.tabId, navigationId: current.navigationId, deltaY: 400 }, 'legal')
    const stale = await execute({ action: 'scroll', tabId: first.tabId, navigationId: first.navigationId, deltaY: 400 }, 'finance')
    const cancelled = await app.evaluate(async (_electron, { tab, context }) => {
      const controller = new AbortController(); controller.abort('old engine epoch')
      return (globalThis as Host).backgroundScroll.service.execute({ action: 'scroll', tabId: tab.tabId, navigationId: tab.navigationId, deltaY: 400 }, context, controller.signal)
    }, { tab: current, context: context('finance') })
    for (const result of [cross, stale, cancelled]) expect(result).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(cross.error).toContain('当前会话')
    expect(stale.error).toContain('页面已经变化')
    expect(cancelled.error).toContain('连接已切换')
    expect(await state()).toEqual(before)
    first = current
  })

  test('click、fill与键盘输入仍要求窗口可见且失败不派发', async () => {
    const before = await state()
    for (const request of [
      { action: 'click', selector: 'button' }, { action: 'fill', selector: 'input', text: 'must not write' }, { action: 'press_key', key: 'Enter' }
    ] as const) {
      const result = await execute({ ...request, tabId: first.tabId, navigationId: first.navigationId }, 'finance')
      expect(result).toMatchObject({ success: false, metadata: { operationPerformed: false } })
      expect(result.error).toContain('窗口当前不可见')
    }
    expect(await state()).toEqual(before)
  })
})
