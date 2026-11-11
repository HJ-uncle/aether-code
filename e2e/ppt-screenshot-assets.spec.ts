/** New native-pixel acceptance: one isolated Electron window → authenticated
 * screenshot broker → versioned PNG → native PPTX → exact Vite-patched preview.
 * Uses built engine modules, no production profile, model calls or export UI. */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { AgentContext } from '../../ai-agent-engine/src/core/agent-context'
import { patchPptxPreview } from '../scripts/pptx-preview-transform'

const root = resolve(__dirname, '..'), tempRoot = join(root, '.e2e-tmp')
const load = new Function('url', 'return import(url)') as <T>(url: string) => Promise<T>
const engine = <T>(file: string): Promise<T> => load<T>(pathToFileURL(resolve(root, '../ai-agent-engine/dist', file)).href)

test('真实截图保存后可直接嵌入 PPT，深色图表预览保留源文字颜色', async ({}, testInfo) => {
  mkdirSync(tempRoot, { recursive: true })
  const fixture = mkdtempSync(join(tempRoot, 'ppt-screenshot-native-')), workspace = join(fixture, 'project')
  mkdirSync(workspace)
  const originalEnvironment = { DATA_DIR: process.env.DATA_DIR, AUTH_ENABLED: process.env.AUTH_ENABLED }
  process.env.DATA_DIR = join(fixture, 'state/agent.db'); process.env.AUTH_ENABLED = 'false'
  let app: ElectronApplication | undefined
  let closeDatabase: (() => Promise<unknown>) | undefined
  let disposeBrowser: (() => void) | undefined
  try {
    const main = join(fixture, 'main.cjs'), html = join(workspace, 'product.html')
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>Screenshot product fixture</title>
      <style>body{margin:0;background:#eef2f6;font:20px sans-serif;color:#12233e;padding:48px}main{background:white;border-radius:20px;padding:36px}h1{font-size:38px}.tiles{display:flex;gap:20px}.tile{padding:30px;background:#dce9fa;border-radius:16px;font-size:36px}</style>
      <main><h1>真实产品页面 · 截图素材</h1><p>本页用于验证浏览器截图可以直接进入 PPT，不使用模型绘制替代图。</p><div class="tiles"><div class="tile">2</div><div class="tile">4</div><div class="tile">8</div><div class="tile">16</div></div></main>`)
    writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(fixture, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(html)});});app.on('window-all-closed',()=>app.quit());`)
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [main], cwd: root, env })
    const page = await app.firstWindow()
    await expect(page.locator('h1')).toHaveText('真实产品页面 · 截图素材')
    await page.evaluate(() => document.fonts.ready)
    const { browserBridge } = await engine<typeof import('../../ai-agent-engine/src/tools/browser/browser-bridge')>('tools/browser/browser-bridge.js')
    const { browserTools } = await engine<typeof import('../../ai-agent-engine/src/tools/browser/browser-tools')>('tools/browser/browser-tools.js')
    const { officeDocumentTool } = await engine<typeof import('../../ai-agent-engine/src/tools/office/index')>('tools/office/index.js')
    const database = await engine<typeof import('../../ai-agent-engine/src/storage/sqlite/db')>('storage/sqlite/db.js')
    closeDatabase = database.closeDb; disposeBrowser = () => browserBridge.dispose()
    const sessionId = basename(fixture), identity = { tenantId: 'ppt-screenshot-native' }
    const context = { ...identity, sessionId, rootSessionId: sessionId, rootRunId: 'capture-run', turnId: 'capture-turn',
      browserPrincipal: { ...identity, method: 'none' }, modelName: 'fixture-vision', modelCaps: { vision: true },
      workspacePaths: [workspace], projectRoot: workspace, cwd: workspace, toolProfile: 'general',
      logger: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as AgentContext
    const client = browserBridge.register(identity, sessionId, undefined, 2)
    const save = browserTools.find(tool => tool.name === 'browser_save_screenshot')
    expect(save, 'Build the engine before this test').toBeDefined()
    const pending = save!.execute({ tabId: 'native-page', navigationId: 1, path: 'assets/product.png', expectedHash: 'missing' }, context)
    const [command] = await browserBridge.poll(identity, client.clientId, client.clientToken)
    expect(command.action).toBe('screenshot')
    const capture = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
      return { dataUrl: image.toDataURL(), ...image.getSize() }
    })
    expect(capture.width).toBeGreaterThan(1000); expect(capture.height).toBeGreaterThan(500)
    expect(browserBridge.result(identity, client.clientId, client.clientToken, command.requestId,
      { success: true, output: JSON.stringify({ ...capture, tab: { tabId: 'native-page', navigationId: 1 } }) }, command.execution)).toBe(true)
    const saved = await pending
    expect(saved.success, saved.output.slice(0, 1000)).toBe(true)
    const image = JSON.parse(saved.output) as { path: string; expectedHash: string }
    const pixels = Buffer.from(capture.dataUrl.split(',')[1], 'base64')
    expect(readFileSync(image.path)).toEqual(pixels)
    expect(image.expectedHash).toBe(`sha256:${createHash('sha256').update(pixels).digest('hex')}`)
    const created = await officeDocumentTool.execute({ operation: 'create', path: 'product.pptx', expectedHash: 'missing', presentation: {
      theme: { background: '151923', foreground: 'F2F6FC', accent: '70B7FF', muted: '96A3B2' },
      slides: [{ title: '真实浏览器截图', image: { path: image.path, fit: 'contain' } },
        { title: '图表标签保真', chart: { type: 'bar', categories: ['对局', '规则', '离线'], series: [{ name: '功能', values: [6, 3, 2] }] } }],
    } }, context)
    expect(created.success, created.output).toBe(true)
    const { readOfficeZip } = await engine<typeof import('../../ai-agent-engine/src/tools/office/office-zip')>('tools/office/office-zip.js')
    const bytes = readFileSync(join(workspace, 'product.pptx')), parts = readOfficeZip(bytes)
    expect(Object.entries(parts).some(([name, data]) => name.startsWith('ppt/media/') && Buffer.from(data).equals(pixels))).toBe(true)
    await page.setContent('<style>body{margin:0}#preview{width:1100px}</style><div id="preview"></div>')
    await page.addScriptTag({ content: readFileSync(join(root, 'node_modules/jszip/dist/jszip.min.js'), 'utf8') })
    const converter = patchPptxPreview(readFileSync(join(root, 'node_modules/@jvmr/pptx-to-html/dist/index.js'), 'utf8'))
      .replace('import JSZip from "jszip";', 'const JSZip = window.JSZip;').replace('export { pptxToHtml };', 'window.convertPptx = pptxToHtml;')
    await page.addScriptTag({ content: converter })
    await page.evaluate(async base64 => {
      const converterWindow = window as unknown as { convertPptx(buffer: ArrayBuffer, config: object): Promise<string[]> }
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      document.querySelector('#preview')!.innerHTML = (await converterWindow.convertPptx(bytes.buffer, { width: 1100, height: 619, scaleToFit: true })).join('')
    }, bytes.toString('base64'))
    await expect(page.locator('.slide-container')).toHaveCount(2)
    expect(await page.locator('img').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 1000)).toBe(true)
    const labels = page.locator('text[data-pptx-chart-label="category"], text[data-pptx-chart-label="value"]')
    expect(await labels.count()).toBeGreaterThan(3)
    expect(new Set(await labels.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill)))).toEqual(new Set(['rgb(150, 163, 178)']))
    const previewFile = testInfo.outputPath('real-screenshot-ppt-preview.png')
    await page.screenshot({ path: previewFile, fullPage: true })
    await testInfo.attach('real-screenshot-ppt-preview', { path: previewFile, contentType: 'image/png' })
  } finally {
    disposeBrowser?.(); await app?.close(); await closeDatabase?.()
    for (const [name, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    if (dirname(fixture) !== tempRoot || !basename(fixture).startsWith('ppt-screenshot-native-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
