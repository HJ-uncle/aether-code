/** Real Electron/source fixture: native capture failure, truthful host state,
 * cancellation, and fresh layout ACK before a single actual click. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, NativeImage, WebContents } from 'electron'
import type { BrowserService } from '../src/main/browser/service'
import type { BrowserContext, BrowserEvent, BrowserScreenshot, BrowserSnapshot, BrowserTabState, BrowserToolRequest, BrowserToolResult } from '../src/shared/browser'

type RecoveryHost = {
  service: BrowserService
  owner: BrowserWindow
  events: BrowserEvent[]
  acknowledge: boolean
  pending?: Promise<BrowserToolResult>
  releaseLayout?: () => void
  layoutWaiting?: boolean
  sendCommand?: WebContents['debugger']['sendCommand']
}
type Host = typeof globalThis & { browserRecovery: RecoveryHost }
const root = resolve(__dirname, '..')
const context: BrowserContext = { engineId: JSON.stringify(['embedded', 'browser-recovery-fixture']), sessionId: 'session' }
let app: ElectronApplication, fixture = '', tab: BrowserTabState

async function execute(request: BrowserToolRequest, session = context) {
  return app.evaluate(async (_electron, { request, context }) =>
    (globalThis as Host).browserRecovery.service.execute(request, context), { request, context: session })
}

test.describe.serial('浏览器宿主恢复与真实执行回执', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-recovery-'))
    const file = join(fixture, 'page.html')
    writeFileSync(file, '<!doctype html><meta charset="utf-8"><title>Browser recovery fixture</title><style>html,body{margin:0;background:rgb(26,160,92);height:100%}button{margin:20px;width:160px;height:60px}</style><button onclick="window.clicks++">一次提交</button><script>window.clicks=0</script>')
    const main = join(fixture, 'main.cjs')
    await build({ stdin: { contents: `import {app,BrowserWindow} from 'electron';import {BrowserService} from './src/main/browser/service';import {allowRoot} from './src/main/fs/file-service';
      app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});void app.whenReady().then(async()=>{allowRoot(${JSON.stringify(fixture)});const owner=new BrowserWindow({show:false,width:950,height:700});await owner.loadURL('about:blank');const events=[];let service;const host={owner,events,acknowledge:false};service=new BrowserService(()=>owner,event=>{events.push(event);if(event.type==='reveal'&&host.acknowledge)service.setBounds({tabId:event.tabId,revealRequestId:event.requestId,visible:true,bounds:{x:0,y:0,width:800,height:600}})});host.service=service;globalThis.browserRecovery=host;});`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: main, logLevel: 'silent' })
    app = await electron.launch({ args: [main], cwd: root })
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as Host).browserRecovery))).toBe(true)
    const opened = await execute({ action: 'open', url: pathToFileURL(file).href })
    expect(opened.success, opened.error).toBe(true)
    tab = opened.output as BrowserTabState
    await expect.poll(async () => (await execute({ action: 'snapshot', tabId: tab.tabId })).success).toBe(true)
  })

  test.afterAll(async () => {
    await app?.close()
    if (!fixture || dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-recovery-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('隐藏窗口明确说明需要恢复，拒绝点击且不泄露其他会话状态', async () => {
    const listed = await execute({ action: 'tabs' })
    expect((listed.output as BrowserTabState[])[0].availability).toEqual({ window: 'hidden', surface: 'hidden', initialization: 'ready', interaction: 'needs_user' })
    const click = await execute({ action: 'click', tabId: tab.tabId, navigationId: tab.navigationId, selector: 'button' })
    expect(click).toMatchObject({ success: false, metadata: { operationPerformed: false }, output: { tabId: tab.tabId, availability: { interaction: 'needs_user' } } })
    const cross = await execute({ action: 'snapshot', tabId: tab.tabId }, { ...context, sessionId: 'another-task' })
    expect(cross).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(cross.output).toBeUndefined()
    const transferred = await app.evaluate(async ({ webContents }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      const capture = wc.capturePage
      wc.capturePage = async () => {
        host.service.bindContext(tab.tabId, { ...context, sessionId: 'shared-during-capture' })
        throw new Error('Native capture interrupted')
      }
      try { return await host.service.execute({ action: 'screenshot', tabId: tab.tabId }, context) }
      finally { wc.capturePage = capture; host.service.bindContext(tab.tabId, context) }
    }, { tab, context })
    expect(transferred).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(transferred.output).toBeUndefined()
    expect(transferred.error).toContain('交给其他会话')
  })

  test('原生截图失败后取得同一隐藏页面的真实PNG，不显示窗口或重复输入', async ({}, testInfo) => {
    const result = await app.evaluate(async ({ webContents, nativeImage }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      const capture = wc.capturePage
      const reveals = host.events.filter(event => event.type === 'reveal').length
      wc.capturePage = async () => { throw new Error('Current display surface not available for capture') }
      try {
        const result = await host.service.execute({ action: 'screenshot', tabId: tab.tabId }, context)
        if (!result.success) return { result }
        const image = result.output as BrowserScreenshot
        const png = Buffer.from(image.dataUrl.split(',')[1], 'base64')
        const bitmap = nativeImage.createFromBuffer(png).toBitmap()
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
        const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
        return { result, actual: { width, height }, color: [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]],
          visible: host.owner.isVisible(), reveals: host.events.filter(event => event.type === 'reveal').length - reveals,
          clicks: await wc.executeJavaScript('window.clicks') }
      } finally { wc.capturePage = capture }
    }, { tab, context })
    expect(result.result.success, result.result.error).toBe(true)
    expect(result).toMatchObject({ visible: false, reveals: 0, clicks: 0, color: [26, 160, 92] })
    const image = result.result.output as BrowserScreenshot
    expect({ width: image.width, height: image.height }).toEqual(result.actual)
    await testInfo.attach('recovered-hidden-page.png', { body: Buffer.from(image.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
  })

  test('两种捕获均失败时返回失败；取消不会再触发后备捕获', async () => {
    const result = await app.evaluate(async ({ webContents }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      const capture = wc.capturePage, command = wc.debugger.sendCommand.bind(wc.debugger)
      let fallbackCalls = 0
      wc.capturePage = async () => { throw new Error('Current display surface not available for capture') }
      wc.debugger.sendCommand = async (method, ...args) => {
        if (method === 'Page.captureScreenshot') { fallbackCalls++; throw new Error('Capture unavailable') }
        return command(method, ...args)
      }
      try {
        const failed = await host.service.execute({ action: 'screenshot', tabId: tab.tabId }, context)
        const snapshot = await host.service.execute({ action: 'snapshot', tabId: tab.tabId }, context)
        const controller = new AbortController()
        wc.capturePage = async () => { controller.abort(); throw new Error('Capture cancelled') }
        const cancelled = await host.service.execute({ action: 'screenshot', tabId: tab.tabId }, context, controller.signal)
        return { failed, snapshot, cancelled, fallbackCalls }
      } finally { wc.capturePage = capture; wc.debugger.sendCommand = command }
    }, { tab, context })
    expect(result.failed).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(result.failed.error).toContain('截图表面不可用')
    expect(result.snapshot.success, result.snapshot.error).toBe(true)
    const snapshot = result.snapshot.output as BrowserSnapshot
    expect(snapshot.text).toContain('一次提交')
    expect(snapshot.screenshot).toBeUndefined()
    expect(snapshot.screenshotUnavailable).toContain('截图表面不可用')
    expect(result.cancelled).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(result.fallbackCalls).toBe(2)
  })

  test('原生捕获超时仍给页面快照保留后备预算，返回真实像素且不显示窗口', async ({}, testInfo) => {
    const result = await app.evaluate(async ({ webContents, nativeImage }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      const capture = wc.capturePage, command = wc.debugger.sendCommand.bind(wc.debugger)
      const reveals = host.events.filter(event => event.type === 'reveal').length
      let fallbackCalls = 0
      wc.capturePage = () => new Promise<NativeImage>(() => {})
      wc.debugger.sendCommand = async (method, ...args) => {
        if (method === 'Page.captureScreenshot') fallbackCalls++
        return command(method, ...args)
      }
      try {
        const result = await host.service.execute({ action: 'snapshot', tabId: tab.tabId }, context)
        const snapshot = result.output as BrowserSnapshot | undefined
        if (!result.success || !snapshot?.screenshot) return { result, fallbackCalls }
        const png = Buffer.from(snapshot.screenshot.dataUrl.split(',')[1], 'base64')
        const bitmap = nativeImage.createFromBuffer(png).toBitmap()
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
        const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
        return { result, fallbackCalls, color: [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]],
          actual: { width, height }, visible: host.owner.isVisible(),
          reveals: host.events.filter(event => event.type === 'reveal').length - reveals,
          clicks: await wc.executeJavaScript('window.clicks') }
      } finally { wc.capturePage = capture; wc.debugger.sendCommand = command }
    }, { tab, context })
    expect(result.result.success, result.result.error).toBe(true)
    expect(result).toMatchObject({ fallbackCalls: 1, color: [26, 160, 92], visible: false, reveals: 0, clicks: 0 })
    const snapshot = result.result.output as BrowserSnapshot
    expect(snapshot.screenshotUnavailable).toBeUndefined()
    expect({ width: snapshot.screenshot!.width, height: snapshot.screenshot!.height }).toEqual(result.actual)
    await testInfo.attach('snapshot-after-native-timeout.png', { body: Buffer.from(snapshot.screenshot!.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
  })

  test('两种捕获均不返回时有界结束，外层取消仍阻止后备捕获', async () => {
    const result = await app.evaluate(async ({ webContents }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      const capture = wc.capturePage, command = wc.debugger.sendCommand.bind(wc.debugger)
      let fallbackCalls = 0
      wc.capturePage = () => new Promise<NativeImage>(() => {})
      wc.debugger.sendCommand = async (method, ...args) => {
        if (method === 'Page.captureScreenshot') { fallbackCalls++; return new Promise(() => {}) }
        return command(method, ...args)
      }
      try {
        const started = Date.now()
        const snapshot = await host.service.execute({ action: 'snapshot', tabId: tab.tabId }, context)
        const elapsed = Date.now() - started
        const cancelled = await host.service.execute({ action: 'snapshot', tabId: tab.tabId }, context, AbortSignal.timeout(100))
        return { snapshot, elapsed, cancelled, fallbackCalls }
      } finally { wc.capturePage = capture; wc.debugger.sendCommand = command }
    }, { tab, context })
    expect(result.snapshot.success, result.snapshot.error).toBe(true)
    const snapshot = result.snapshot.output as BrowserSnapshot
    expect(snapshot.text).toContain('一次提交')
    expect(snapshot.screenshot).toBeUndefined()
    expect(snapshot.screenshotUnavailable).toContain('超时')
    expect(result.elapsed).toBeLessThan(10_000)
    expect(result.fallbackCalls).toBe(1)
    expect(result.cancelled).toMatchObject({ success: false, metadata: { operationPerformed: false } })
  })

  test('等待布局配置完成后只点击一次，不把旧可见状态当作显示确认', async () => {
    await app.evaluate(({ webContents }, { tab, context }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      host.owner.showInactive()
      host.acknowledge = true
      host.sendCommand = wc.debugger.sendCommand.bind(wc.debugger)
      wc.debugger.sendCommand = async (method, ...args) => {
        if (method === 'Emulation.setTouchEmulationEnabled') {
          host.layoutWaiting = true
          await new Promise<void>(resolve => { host.releaseLayout = resolve })
        }
        return host.sendCommand!(method, ...args)
      }
      host.pending = host.service.execute({ action: 'click', tabId: tab.tabId, navigationId: tab.navigationId, selector: 'button' }, context)
    }, { tab, context })
    await expect.poll(() => app.evaluate(() => (globalThis as Host).browserRecovery.layoutWaiting)).toBe(true)
    expect(await app.evaluate(async ({ webContents }) => webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!.executeJavaScript('window.clicks'))).toBe(0)
    const result = await app.evaluate(async ({ webContents }) => {
      const host = (globalThis as Host).browserRecovery
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === 'Browser recovery fixture')!
      wc.debugger.sendCommand = host.sendCommand!
      host.releaseLayout!()
      const result = await host.pending!
      return { result, clicks: await wc.executeJavaScript('window.clicks') }
    })
    expect(result.result.success, result.result.error).toBe(true)
    expect(result.result.metadata?.operationPerformed).toBe(true)
    expect(result.clicks).toBe(1)
  })
})
