/** Real Electron, engine disabled: explicit local file grants outside the workspace,
 * address/picker routing, encodings, disk reload, images/PDF/Office/native HTML,
 * independent duplicate/close lifetimes, size limits and remote presentation. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import pptxgen from 'pptxgenjs'
import { Workbook } from 'exceljs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const names = { text: '中文 记录.txt', log: '运行 日志.log', utf16le: 'UTF16LE.txt', utf16be: 'UTF16BE.txt', gbk: 'GBK 日志.log',
  png: '图片.png', svg: '向量图.svg', pdf: '报告.pdf', docx: '文档.docx', xlsx: '表格.xlsx', pptx: '演示.pptx', html: '本地 页面.html' }
const unsafeText = '外部中文文本\n<script>window.__browserLocalUnsafeExecuted=true</script>\n<img src="missing" onerror="window.__browserLocalUnsafeExecuted=true">\n末行日志'
const errors: string[] = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', outside = '', workspace = '', origin = ''
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>服务预览基线</title><h1>HTTP 页面 ${request.url}</h1><script>window.fixtureMarker='kept'</script>`)
})
const browser = () => page.getByRole('region', { name: '内置浏览器', exact: true })
const preview = () => browser().getByRole('region', { name: '本地文件预览', exact: true })
const address = () => browser().getByRole('textbox', { name: '网页地址', exact: true })
const file = (name: string) => join(outside, name)
async function tabs(): Promise<BrowserTabState[]> { return page.evaluate(() => window.aether.browser.list()) }
async function nextTab(before: BrowserTabState[]): Promise<BrowserTabState> {
  let next: BrowserTabState | undefined
  await expect.poll(async () => {
    next = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId) && !tab.loading)
    return next?.tabId ?? null
  }).not.toBeNull()
  return next!
}
async function openAddress(value: string): Promise<BrowserTabState> {
  const before = await tabs()
  await address().fill(value); await address().press('Enter')
  return nextTab(before)
}
async function select(tab: BrowserTabState): Promise<void> {
  await browser().locator(`[data-browser-tab-id="${tab.tabId}"] [role="tab"]`).click()
}
async function openLocal(name: string): Promise<BrowserTabState> {
  const tab = await openAddress(file(name))
  expect(tab.localFile).toMatchObject({ name, path: file(name) })
  expect(tab.context).toBeUndefined()
  return tab
}
async function fixtureFiles(): Promise<void> {
  writeFileSync(file(names.text), unsafeText)
  writeFileSync(file(names.log), '日志初始内容\n未刷新')
  writeFileSync(file('相邻未授权.txt'), 'sibling must remain private')
  const utf16 = Buffer.from('中文编码日志\n第二行', 'utf16le')
  writeFileSync(file(names.utf16le), Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]))
  writeFileSync(file(names.utf16be), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()]))
  writeFileSync(file(names.gbk), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc8, 0xd5, 0xd6, 0xbe, 0x0a, 0x4f, 0x4b]))
  writeFileSync(file(names.png), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'))
  writeFileSync(file(names.svg), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="24" height="18" fill="green"/><script>parent.__browserLocalUnsafeExecuted=true</script></svg>')
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([612, 792]).drawText('LocalFilePdfMarker', { x: 48, y: 720, size: 20, font })
  writeFileSync(file(names.pdf), await pdf.save())
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>LocalFileWordMarker</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>')
  writeFileSync(file(names.docx), await docx.generateAsync({ type: 'nodebuffer' }))
  const workbook = new Workbook()
  workbook.addWorksheet('本地工作表').addRow(['LocalFileSheetMarker', 42])
  await workbook.xlsx.writeFile(file(names.xlsx))
  const deck = new pptxgen(); deck.layout = 'LAYOUT_WIDE'
  deck.addSlide().addText('LocalFileSlideMarker', { x: 1, y: 1, w: 7, h: 1, fontSize: 28 })
  await deck.writeFile({ fileName: file(names.pptx) })
  mkdirSync(file('assets'))
  writeFileSync(file(names.html), '<!doctype html><meta charset="utf-8"><title>独立本地 HTML</title><link rel="stylesheet" href="./assets/theme.css"><h1>等待模块</h1><script type="module" src="./assets/main.js"></script>')
  writeFileSync(file('assets/theme.css'), 'h1{color:rgb(17,88,155)}')
  writeFileSync(file('assets/main.js'), "document.querySelector('h1').textContent='本地相对模块已加载'")
  writeFileSync(file('大文本.log'), '大文本开头\n' + '0123456789abcdef0123456789abcdef\n'.repeat(150_000) + 'END_NOT_IN_PREVIEW')
  const huge = openSync(file('超限.txt'), 'w')
  try { ftruncateSync(huge, 32 * 1024 * 1024 + 1) } finally { closeSync(huge) }
}

test.describe.serial('用户受控本地文件浏览器预览', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'browser-user-local-ui-'))
    workspace = join(fixture, 'workspace'); outside = join(fixture, '外部 资料')
    const profile = join(fixture, 'profile')
    for (const path of [workspace, outside, profile]) mkdirSync(path)
    writeFileSync(join(workspace, 'workspace.txt'), 'authorized workspace')
    await fixtureFiles()
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const serverAddress = server.address()
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('Missing local fixture port')
    origin = `http://127.0.0.1:${serverAddress.port}`
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'light' }))
    const env: Record<string, string> = { AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'AETHER_GLOBAL_DIR') env[name] = value
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'browser-user-local')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    // Preserve input/selection evidence for intermittent native focus races; emit only on failure.
    await page.addInitScript(() => {
      const scope = window as Window & { __addressAudit?: unknown[] }
      scope.__addressAudit = []
      for (const type of ['beforeinput', 'input', 'change', 'compositionstart', 'compositionend', 'focusin', 'focusout', 'keydown', 'keyup']) {
        document.addEventListener(type, event => {
          const target = event.target
          if (!(target instanceof HTMLInputElement) || !target.classList.contains('browser-address')) return
          scope.__addressAudit!.push({ type, value: target.value, start: target.selectionStart, end: target.selectionEnd,
            inputType: event instanceof InputEvent ? event.inputType : undefined,
            data: event instanceof InputEvent ? event.data : undefined, key: event instanceof KeyboardEvent ? event.key : undefined,
            composing: event instanceof InputEvent || event instanceof KeyboardEvent ? event.isComposing : undefined,
            focused: document.hasFocus() })
          if (scope.__addressAudit!.length > 200) scope.__addressAudit!.shift()
        }, true)
      }
    })
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(() => localStorage.setItem('aether.app.mode', 'code'))
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
    await page.keyboard.press('Control+Alt+b')
    await expect(browser()).toBeVisible()
    await expect(address()).toHaveAttribute('placeholder', '输入网址、localhost:端口或本地路径')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) console.log('ADDRESS_AUDIT', await page.evaluate(() => (window as Window & { __addressAudit?: unknown[] }).__addressAudit))
    expect(errors).toEqual([]); health?.assertHealthy()
    for (const tab of await tabs()) await page.evaluate(id => window.aether.browser.close(id), tab.tabId)
  })
  test.afterAll(async ({}, info) => {
    try {
      if (health) await health.closeAndAssert(info)
      else await app?.close()
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (!fixture) return
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('browser-user-local-ui-')) throw new Error('Unsafe local preview fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('带引号和空格的中文外部文件显示纯文本，网页标签保留且返回网址新建网页', async ({}, info) => {
    await address().fill(`${origin}/web`); await address().press('Enter')
    await expect.poll(tabs).toContainEqual(expect.objectContaining({ url: `${origin}/web`, loading: false }))
    const web = (await tabs()).find(tab => tab.url === `${origin}/web`)!
    const local = await openAddress(`"${file(names.text)}"`)
    expect(local.localFile).toMatchObject({ name: names.text, kind: 'text', size: statSync(file(names.text)).size })
    expect(local.context).toBeUndefined()
    await expect(preview().locator('.browser-local-preview__text').getByRole('gridcell')).toHaveText(unsafeText.split('\n'))
    await expect(preview().locator('script, img, iframe')).toHaveCount(0)
    expect(await page.evaluate(() => (window as Window & { __browserLocalUnsafeExecuted?: boolean }).__browserLocalUnsafeExecuted ?? false)).toBe(false)
    expect((await tabs()).find(tab => tab.tabId === web.tabId)?.url).toBe(`${origin}/web`)
    await expect(address()).toHaveValue(file(names.text))
    const screenshot = info.outputPath('local-file-text.png')
    await browser().screenshot({ path: screenshot }); await info.attach('local-file-text', { path: screenshot, contentType: 'image/png' })
    const secondWeb = await openAddress(`${origin}/next`)
    expect(secondWeb.localFile).toBeUndefined(); expect(secondWeb.url).toBe(`${origin}/next`)
    expect((await tabs()).find(tab => tab.tabId === local.tabId)?.localFile?.path).toBe(file(names.text))
    await select(local)
    await expect(preview().locator('.browser-local-preview__text')).toContainText('末行日志')
  })

  test('文件工具栏使用原生选择器，取消不建标签、选择文件不扩大工作区权限', async () => {
    const before = await tabs()
    await app!.evaluate(({ dialog }) => {
      const receipt = globalThis as typeof globalThis & { __localFilePickerCancelled?: boolean }
      receipt.__localFilePickerCancelled = false
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original; receipt.__localFilePickerCancelled = true
        return { canceled: true, filePaths: [] }
      }
    })
    await browser().getByRole('button', { name: '打开本地文件', exact: true }).click()
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { __localFilePickerCancelled?: boolean }).__localFilePickerCancelled)).toBe(true)
    expect((await tabs()).map(tab => tab.tabId)).toEqual(before.map(tab => tab.tabId))
    await app!.evaluate(({ dialog }, path) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [path] } }
    }, file(names.log))
    await browser().getByRole('button', { name: '打开本地文件', exact: true }).click()
    const local = await nextTab(before)
    expect(local.localFile?.path).toBe(file(names.log))
    await expect(preview().locator('.browser-local-preview__text')).toContainText('日志初始内容')
    const rejected = await page.evaluate(async ({ chosen, sibling, directory }) => {
      const failure = async (operation: () => Promise<unknown>): Promise<string> => { try { await operation(); return '' } catch (error) { return String(error) } }
      return Promise.all([
        failure(() => window.aether.fs.readFile(chosen)), failure(() => window.aether.fs.readFile(sibling)),
        failure(() => window.aether.fs.readDir(directory)), failure(() => window.aether.fs.writeFile(sibling, 'should never be written'))
      ])
    }, { chosen: file(names.log), sibling: file('相邻未授权.txt'), directory: outside })
    for (const error of rejected) expect(error).toContain('工作区之外')
    expect(readFileSync(file('相邻未授权.txt'), 'utf8')).toBe('sibling must remain private')
  })

  test('UTF16 LE/BE 与 GBK 中文日志正常解码，file URL 也进入本地文件入口', async () => {
    for (const [name, expected] of [[names.utf16le, '中文编码日志'], [names.utf16be, '中文编码日志'], [names.gbk, '中文日志']]) {
      const tab = await openAddress(pathToFileURL(file(name)).href)
      expect(tab.localFile?.kind).toBe('text')
      const content = await page.evaluate(id => window.aether.browser.readLocalFile(id), tab.tabId)
      expect(content.kind).toBe('text')
      if (content.kind !== 'text') throw new Error('Expected decoded text')
      expect(content.text).toContain(expected); expect(content.text).not.toContain('\ufffd'); expect(content.truncated).toBe(false)
      await expect(preview().locator('.browser-local-preview__text')).toContainText(expected)
    }
  })

  test('刷新按钮和 Ctrl+R 从磁盘重读已授权日志，保留同一标签', async () => {
    const tab = await openAddress(`'${file(names.log)}'`)
    await expect(preview().locator('.browser-local-preview__text')).toContainText('日志初始内容')
    writeFileSync(file(names.log), '按钮刷新后的磁盘内容')
    await browser().getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(preview().locator('.browser-local-preview__text')).toContainText('按钮刷新后的磁盘内容')
    const firstVersion = (await tabs()).find(item => item.tabId === tab.tabId)!.navigationId
    expect(firstVersion).toBeGreaterThan(tab.navigationId)
    writeFileSync(file(names.log), '键盘刷新后的磁盘内容')
    await preview().getByRole('grid').focus(); await page.keyboard.press('Control+r')
    await expect(preview().locator('.browser-local-preview__text')).toContainText('键盘刷新后的磁盘内容')
    expect((await tabs()).find(item => item.tabId === tab.tabId)!.navigationId).toBeGreaterThan(firstVersion)
    expect((await tabs()).filter(item => item.localFile?.path === file(names.log))).toHaveLength(1)
  })

  test('PNG 和 SVG 以图片解码，SVG 脚本不能进入工作台', async () => {
    for (const name of [names.png, names.svg]) {
      const tab = await openLocal(name)
      expect(tab.localFile?.kind).toBe('binary')
      const data = await page.evaluate(id => window.aether.browser.readLocalFile(id), tab.tabId)
      expect(data.kind).toBe('binary')
      if (data.kind !== 'binary') throw new Error('Expected binary image')
      expect(Buffer.from(data.base64, 'base64')).toEqual(readFileSync(file(name)))
      await expect(preview().getByRole('img', { name, exact: true })).toBeVisible()
      await expect.poll(() => preview().getByRole('img', { name, exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
      expect(await page.evaluate(() => (window as Window & { __browserLocalUnsafeExecuted?: boolean }).__browserLocalUnsafeExecuted ?? false)).toBe(false)
    }
  })

  test('PDF、Word、Excel 与 PowerPoint 复用安全文档预览器', async ({}, info) => {
    await openLocal(names.pdf)
    const pdf = preview().locator('[data-document-preview="pdf"]')
    await expect(pdf.locator('canvas').first()).toHaveAttribute('data-rendered-page', '1')
    await expect(pdf.locator('.document-preview__pdf-text').first()).toContainText('LocalFilePdfMarker')
    const screenshot = info.outputPath('local-file-pdf.png')
    await browser().screenshot({ path: screenshot }); await info.attach('local-file-pdf', { path: screenshot, contentType: 'image/png' })
    for (const [name, marker] of [[names.docx, 'LocalFileWordMarker'], [names.pptx, 'LocalFileSlideMarker']]) {
      await openLocal(name)
      const frame = preview().locator('iframe').first()
      await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
      await expect(frame.contentFrame().getByText(marker, { exact: true }).first()).toBeVisible()
      expect(await frame.getAttribute('srcdoc')).toContain("script-src 'none'")
    }
    await openLocal(names.xlsx)
    await expect(preview().getByRole('table', { name: '本地工作表', exact: true })).toContainText('LocalFileSheetMarker')
  })

  test('本地 HTML 原生执行相对 CSS/模块并与 IDE 桥隔离', async () => {
    const tab = await openLocal(names.html)
    expect(tab.localFile?.kind).toBe('html'); expect(tab.url).toMatch(/^aether-local:/)
    await expect(preview()).toHaveCount(0)
    await expect.poll(() => app!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url)
      return guest ? guest.executeJavaScript("({heading:document.querySelector('h1')?.textContent,color:document.querySelector('h1')?getComputedStyle(document.querySelector('h1')).color:'',bridge:typeof window.aether,node:typeof require,process:typeof process})") : null
    }, tab.url)).toEqual({ heading: '本地相对模块已加载', color: 'rgb(17, 88, 155)', bridge: 'undefined', node: 'undefined', process: 'undefined' })
  })

  test('复制文件标签拥有独立授权，关闭原标签后原读取失败而副本仍能刷新', async () => {
    const original = await openLocal(names.text), before = await tabs()
    await browser().locator(`[data-browser-tab-id="${original.tabId}"] [role="tab"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制标签页', exact: true }).click()
    const copy = await nextTab(before)
    expect(copy.localFile).toEqual(original.localFile); expect(copy.context).toBeUndefined()
    await browser().locator(`[data-browser-tab-id="${original.tabId}"] .browser-tab__close`).click()
    await expect.poll(async () => (await tabs()).some(tab => tab.tabId === original.tabId)).toBe(false)
    const closedError = await page.evaluate(async id => { try { await window.aether.browser.readLocalFile(id); return '' } catch (error) { return String(error) } }, original.tabId)
    expect(closedError).not.toBe('')
    await select(copy)
    await browser().getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(preview().locator('.browser-local-preview__text')).toContainText('外部中文文本')
    const content = await page.evaluate(id => window.aether.browser.readLocalFile(id), copy.tabId)
    expect(content).toMatchObject({ kind: 'text', text: unsafeText })
  })

  test('大文本只读取前 4 MiB，超限和非本机常规路径不创建标签', async () => {
    const tab = await openLocal('大文本.log')
    const content = await page.evaluate(id => window.aether.browser.readLocalFile(id), tab.tabId)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') throw new Error('Expected bounded text')
    expect(content.truncated).toBe(true); expect(content.size).toBe(statSync(file('大文本.log')).size)
    expect(content.text).toContain('大文本开头'); expect(content.text).not.toContain('END_NOT_IN_PREVIEW')
    expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024)
    await expect(preview().getByRole('status')).toContainText('前 4 MiB')
    const before = (await tabs()).map(item => item.tabId)
    for (const path of [file('超限.txt'), file('不存在.txt'), 'relative.txt', 'file://server/share/report.txt',
      '\\\\server\\share\\report.txt', '\\\\?\\C:\\report.txt', '\\\\.\\pipe\\report', `${file(names.text)}:hidden`, 'https://example.invalid/report.txt']) {
      const error = await page.evaluate(async path => { try { await window.aether.browser.openLocalFile(path); return '' } catch (error) { return String(error) } }, path)
      expect(error, path).not.toBe('')
    }
    expect((await tabs()).map(item => item.tabId)).toEqual(before)
  })

  test('远端任务 presentation 也可展示本机文件，但文件没有 AI context 且不能 share', async () => {
    const engineId = JSON.stringify(['remote', origin, 'local-file-remote', null])
    await page.evaluate(engineId => window.aether.browser.activateSurface({ mode: 'work', sessionId: 'remote-local-file-task', engineId, generation: 100_000 }), engineId)
    const local = await page.evaluate(path => window.aether.browser.openLocalFile(path), file(names.text))
    expect(local).not.toBeNull()
    if (!local) throw new Error('Explicit path unexpectedly cancelled')
    expect(local.presentation).toMatchObject({ mode: 'work', sessionId: 'remote-local-file-task', engineId })
    expect(local.context).toBeUndefined()
    const content = await page.evaluate(id => window.aether.browser.readLocalFile(id), local.tabId)
    expect(content).toMatchObject({ kind: 'text', text: unsafeText })
    const shareError = await page.evaluate(async ({ id, engineId }) => {
      try { await window.aether.browser.share(id, { sessionId: 'remote-local-file-task', engineId }); return '' } catch (error) { return String(error) }
    }, { id: local.tabId, engineId })
    expect(shareError).not.toBe('')
    expect((await tabs()).find(tab => tab.tabId === local.tabId)?.context).toBeUndefined()
    // Reset the synthetic ownership generation through the normal renderer lifetime.
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
  })
})
