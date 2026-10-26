/** Fresh source-built Electron fixture: native HTML, no HTTP server, real modules/screenshots, file and session isolation. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserService } from '../src/main/browser/service'
import type { BrowserContext, BrowserSnapshot, BrowserTabState } from '../src/shared/browser'

const root = resolve(__dirname, '..')
type TestHost = typeof globalThis & { nativeBrowserTest: { service: BrowserService } }
let fixture = '', app: ElectronApplication, tab: BrowserTabState, firstFile = '', secondFile = ''
const context: BrowserContext = { engineId: JSON.stringify(['embedded', 'http://127.0.0.1:1', 'fixture', null]), sessionId: 'office-one' }

test.describe.serial('原生本地网页授权', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-native-file-'))
    const workspace = join(fixture, 'workspace'), first = join(workspace, 'one'), second = join(workspace, 'two'), outside = join(fixture, 'outside')
    for (const dir of [first, second, outside]) mkdirSync(dir, { recursive: true })
    firstFile = join(first, '办公 概览.html'); secondFile = join(second, 'other.html')
    writeFileSync(firstFile, '<!doctype html><meta charset="utf-8"><title>原生办公预览</title><link rel="stylesheet" href="/theme.css"><h1>等待模块</h1><button id="go">确认</button><script type="module" src="./main.js"></script>')
    writeFileSync(join(first, 'main.js'), "document.querySelector('h1').textContent='原生模块加载成功';document.querySelector('#go').onclick=()=>document.querySelector('h1').textContent='交互完成';")
    writeFileSync(join(first, 'theme.css'), 'body{font:18px sans-serif}h1{color:rgb(17,88,155)}')
    writeFileSync(join(first, '.secret.txt'), 'private')
    writeFileSync(secondFile, '<!doctype html><title>另一会话</title><h1>隔离文档</h1>')
    writeFileSync(join(outside, 'outside.txt'), 'outside private data')
    symlinkSync(outside, join(first, 'linked'), 'junction')
    const main = join(fixture, 'main.cjs')
    await build({ stdin: { contents: `import { app, BrowserWindow } from 'electron';
      import { BrowserService } from './src/main/browser/service'; import { allowRoot } from './src/main/fs/file-service';
      app.setPath('userData', ${JSON.stringify(join(fixture, 'profile'))});
      void app.whenReady().then(async()=>{ allowRoot(${JSON.stringify(workspace)}); const owner=new BrowserWindow({show:false,width:1000,height:750});
      await owner.loadURL('about:blank'); const service=new BrowserService(()=>owner,()=>{}); globalThis.nativeBrowserTest={service}; });`, resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: main, logLevel: 'silent' })
    app = await electron.launch({ args: [main], cwd: root })
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as TestHost).nativeBrowserTest))).toBe(true)
  })
  test.afterAll(async () => {
    await app?.close()
    if (dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-native-file-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  test('真实 browser_open 读取中文 HTML、相对模块与根目录样式并可截图', async ({}, testInfo) => {
    const result = await app.evaluate(async (_electron, { url, context }) => {
      const service = (globalThis as TestHost).nativeBrowserTest.service
      const result = await service.execute({ action: 'open', url }, context)
      if (result.success) service.setBounds({ tabId: (result.output as BrowserTabState).tabId, visible: true, bounds: { x: 0, y: 0, width: 900, height: 650 } })
      return result
    }, { url: pathToFileURL(firstFile).href, context })
    expect(result.success, result.error).toBe(true)
    tab = result.output as BrowserTabState
    expect(tab.url).toMatch(/^aether-local:\/\/[a-f0-9]{48}\//)
    await expect.poll(async () => {
      const result = await app.evaluate(async (_electron, { id, context }) => (globalThis as TestHost).nativeBrowserTest.service.execute({ action: 'snapshot', tabId: id }, context), { id: tab.tabId, context })
      return (result.output as BrowserSnapshot)?.text
    }).toContain('原生模块加载成功')
    const details = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === '原生办公预览')!
      return wc.executeJavaScript("({color:getComputedStyle(document.querySelector('h1')).color,origin:location.origin})")
    })
    expect(details.color).toBe('rgb(17, 88, 155)')
    expect(details.origin).toMatch(/^aether-local:/)
    const shot = await app.evaluate(async (_electron, id) => (globalThis as TestHost).nativeBrowserTest.service.read(id, 'screenshot'), tab.tabId)
    expect(shot.success, shot.error).toBe(true)
    const data = shot.output as { dataUrl: string }
    await testInfo.attach('native-local-office.png', { body: Buffer.from(data.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
  })

  test('阻止隐藏文件、junction逃逸、外网请求和跨会话网页资源', async () => {
    const second = await app.evaluate(async (_electron, { url, context }) => (globalThis as TestHost).nativeBrowserTest.service.execute({ action: 'open', url }, context),
      { url: pathToFileURL(secondFile).href, context: { ...context, sessionId: 'office-two' } })
    expect(second.success, second.error).toBe(true)
    const other = second.output as BrowserTabState
    const outcomes = await app.evaluate(async ({ webContents }, otherUrl) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === '原生办公预览')!
      return wc.executeJavaScript(`Promise.all(${JSON.stringify(['/.secret.txt', '/linked/outside.txt', 'https://example.com/', otherUrl])}.map(async url=>{try{const r=await fetch(url);return r.ok?'ALLOWED':String(r.status)}catch{return 'BLOCKED'}}))`)
    }, other.url)
    expect(outcomes).toEqual(['BLOCKED', '404', 'BLOCKED', 'BLOCKED'])
    const readOther = await app.evaluate(async (_electron, { id, context }) => (globalThis as TestHost).nativeBrowserTest.service.execute({ action: 'snapshot', tabId: id }, context), { id: other.tabId, context })
    expect(readOther.success).toBe(false)
    const navigation = await app.evaluate(async (_electron, { id, url }) => {
      try { await (globalThis as TestHost).nativeBrowserTest.service.action({ action: 'navigate', tabId: id, url }); return 'ALLOWED' } catch { return 'BLOCKED' }
    }, { id: tab.tabId, url: other.url })
    expect(navigation).toBe('BLOCKED')
  })

  test('外部引擎与未授权文件拒绝，正常文件导航仍可用', async () => {
    for (const [url, owner] of [
      [pathToFileURL(firstFile).href, { ...context, engineId: JSON.stringify(['remote', 'https://remote.test', 'remote', null]) }],
      [pathToFileURL(join(fixture, 'outside', 'outside.txt')).href, context],
      ['file://server/share/private.html', context],
    ] as const) {
      const result = await app.evaluate(async (_electron, { url, context }) => (globalThis as TestHost).nativeBrowserTest.service.execute({ action: 'open', url }, context), { url, context: owner })
      expect(result.success).toBe(false)
    }
    const result = await app.evaluate(async (_electron, { url, id, context }) => (globalThis as TestHost).nativeBrowserTest.service.execute({ action: 'navigate', tabId: id, url }, context), { url: pathToFileURL(firstFile).href, id: tab.tabId, context })
    expect(result.success, result.error).toBe(true)
  })
})
