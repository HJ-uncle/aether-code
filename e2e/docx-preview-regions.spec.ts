/** New isolated native DOCX renderer acceptance. No production profile, Office,
 * old E2E or export UI. Every tail marker must actually fit in a captured clip. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'

const root = resolve(__dirname, '..'), temp = join(root, '.e2e-tmp')
let workspace = ''
const captureBase = '<style>html,body{margin:0;width:960px;height:540px;overflow:hidden;background:white;color:black;color-scheme:light}*{animation:none!important;transition:none!important}</style><main id="capture"></main>'
const captureCsp = "default-src 'none';script-src 'none';connect-src 'none';img-src data:;style-src 'unsafe-inline';font-src 'none';base-uri 'none';form-action 'none';object-src 'none';frame-src 'self' blob: data:"
let app: ElectronApplication, page: Page, server: Server, networkRequests = 0, networkUrl: string
interface BrowserHarness {
  sourceSections: string[]
  regions: string[]
  renderDocx(base64: string): Promise<{ count: number; sections: number; baseline: { font: string; size: string; lineHeight: string; fill: string; border: string } }>
  checkRegion(index: number, markers: string[]): Promise<{ visible: string[]; bodySize: string; section: string; regionLabel: string }>
  proposal: { docxPreviewRegions(html: string[], signal: AbortSignal, options?: { maxRegions?: number; maxHtmlBytes?: number }): Promise<string[]> }
  sanitize(html: string): string
}
type HarnessWindow = Window & BrowserHarness
const escape = (value: string) => value.replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[character]!))
const paragraph = (text: string, extra = '') => `<w:p><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/>${extra}</w:pPr><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`
const table = (count: number, prefix: string) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="8" w:color="7092B0"/><w:bottom w:val="single" w:sz="8" w:color="7092B0"/><w:left w:val="single" w:sz="8" w:color="7092B0"/><w:right w:val="single" w:sz="8" w:color="7092B0"/><w:insideH w:val="single" w:sz="8" w:color="7092B0"/><w:insideV w:val="single" w:sz="8" w:color="7092B0"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6200"/></w:tblGrid>${Array.from({ length: count }, (_, index) => `<w:tr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/><w:shd w:fill="EDF3F8"/></w:tcPr>${paragraph(`${prefix}-${String(index).padStart(3, '0')}`)}</w:tc><w:tc><w:tcPr><w:tcW w:w="6200" w:type="dxa"/></w:tcPr>${paragraph(`行 ${index + 1} 样式保持原字号，表格最后一行也必须可见。`)}</w:tc></w:tr>`).join('')}</w:tbl>`

async function docx(body: string, width = 12240): Promise<string> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
  zip.file('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/><w:color w:val="172033"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="${width}" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'base64' })
}

test.beforeAll(async () => {
  mkdirSync(temp, { recursive: true })
  workspace = mkdtempSync(join(temp, 'docx-regions-native-'))
  const main = join(workspace, 'main.cjs')
  writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(workspace, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:960,height:540,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL('about:blank')});app.on('window-all-closed',()=>app.quit());`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [main], cwd: root, env }); page = await app.firstWindow()
  await page.setContent(captureBase)
  await page.addScriptTag({ content: readFileSync(join(root, 'node_modules/jszip/dist/jszip.min.js'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(join(root, 'node_modules/docx-preview/dist/docx-preview.js'), 'utf8') })
  const library = await build({ stdin: { contents: `export {docxPreviewRegions} from './src/renderer/src/core/workbench/docx-preview-regions';export {passiveDocumentHtml as sanitize} from './src/renderer/src/contrib/documents/document-html';`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'proposal', platform: 'browser', logLevel: 'silent' })
  await page.addScriptTag({ content: library.outputFiles[0].text })
  await page.evaluate(() => {
    const w = window as unknown as HarnessWindow & { docx: { parseAsync(buffer: ArrayBuffer, options: object): Promise<unknown>; renderDocument(model: unknown, options: object): Promise<Node[]> }; proposal: BrowserHarness['proposal'] & { sanitize(html: string): string } }
    w.sanitize = w.proposal.sanitize
    w.renderDocx = async base64 => {
      const options = { inWrapper: false, ignoreFonts: true, useBase64URL: true, renderAltChunks: false, renderComments: false, experimental: false, breakPages: true, ignoreLastRenderedPageBreak: false }
      const buffer = Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer
      const nodes = await w.docx.renderDocument(await w.docx.parseAsync(buffer, options), options)
      const style = nodes.filter(node => node instanceof HTMLStyleElement).map(node => (node as HTMLStyleElement).outerHTML).join('')
      w.sourceSections = nodes.filter(node => node instanceof HTMLElement && node.tagName === 'SECTION').map(node => w.sanitize(style + (node as HTMLElement).outerHTML))
      const capture = document.getElementById('capture')!; capture.innerHTML = w.sourceSections[0]
      await document.fonts.ready
      const paragraph = getComputedStyle(capture.querySelector('p')!), cell = capture.querySelector('td')
      const baseline = { font: paragraph.fontFamily, size: paragraph.fontSize, lineHeight: paragraph.lineHeight, fill: cell ? getComputedStyle(cell).backgroundColor : '', border: cell ? getComputedStyle(cell).borderTop : '' }
      capture.innerHTML = ''
      w.regions = await w.proposal.docxPreviewRegions(w.sourceSections, new AbortController().signal)
      return { count: w.regions.length, sections: w.sourceSections.length, baseline }
    }
    w.checkRegion = async (index, markers) => {
      const capture = document.getElementById('capture')!; capture.innerHTML = w.regions[index]
      await document.fonts.ready; await Promise.all(Array.from(document.images, image => image.decode()))
      const clip = capture.querySelector('[data-docx-region-clip]')!.getBoundingClientRect()
      const visible: string[] = [], walker = document.createTreeWalker(capture, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode, value = node.textContent ?? ''
        if (node.parentElement?.closest('style')) continue
        for (const marker of markers) {
          const at = value.indexOf(marker); if (at < 0) continue
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + marker.length)
          const bounds = range.getBoundingClientRect()
          if (bounds.width > 0 && bounds.height > 0 && bounds.left >= clip.left - .5 && bounds.top >= clip.top - .5 && bounds.right <= clip.right + .5 && bounds.bottom <= clip.bottom + .5) visible.push(marker)
        }
      }
      const source = capture.querySelector('section.docx')!
      return { visible, bodySize: getComputedStyle(source.querySelector('p')!).fontSize,
        section: source.outerHTML, regionLabel: capture.querySelector('[data-docx-preview-region]')!.firstElementChild!.textContent! }
    }
  })
  // Trusted test functions are installed before the production-style policy.
  // The measured/captured document itself cannot run code or contact a URL.
  await page.evaluate(policy => {
    const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = policy; document.head.prepend(meta)
  }, captureCsp)
  server = createServer((_request, response) => { networkRequests++; response.end('unexpected') })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing network probe')
  networkUrl = `http://127.0.0.1:${address.port}/must-not-load`
})
test.afterAll(async () => {
  try { await app?.close() }
  finally {
    await new Promise<void>(done => server?.close(() => done()) ?? done())
    if (workspace) {
      const target = resolve(workspace)
      if (dirname(target) !== temp || !basename(target).startsWith('docx-regions-native-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

async function captureNative(path: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    await contents.executeJavaScript('(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images).map(image=>image.decode()));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()')
    const capture = await contents.capturePage({ x: 0, y: 0, width: 960, height: 540 })
    return capture.resize({ width: 960, height: 540, quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(path, Buffer.from(png, 'base64'))
}

test('长单一区段的每个段落、表格尾行与末尾正文都出现在实际可见图内', async ({}, info) => {
  const markers = [...Array.from({ length: 40 }, (_, i) => `PARA-${String(i).padStart(3, '0')}`), ...Array.from({ length: 50 }, (_, i) => `ROW-${String(i).padStart(3, '0')}`), 'DOCUMENT-END-SENTINEL']
  const base64 = await docx(markers.slice(0, 40).map(marker => paragraph(`${marker} 原字号连续内容，每段都需要完整覆盖的真实预览画面。`)).join('') + table(50, 'ROW') + paragraph('DOCUMENT-END-SENTINEL 文档最后一段，不能只存在于隐藏的 DOM 里。'))
  const result = await page.evaluate(base64 => (window as unknown as HarnessWindow).renderDocx(base64), base64)
  expect(result.sections).toBe(1); expect(result.count).toBeGreaterThan(3); expect(result.baseline.size).toBe('16px')
  const seen = new Set<string>(), coverage = []
  for (let index = 0; index < result.count; index++) {
    const actual = await page.evaluate(({ index, markers }) => (window as unknown as HarnessWindow).checkRegion(index, markers), { index, markers })
    expect(actual.bodySize).toBe(result.baseline.size); expect(actual.regionLabel).toContain('非 Word 页码')
    actual.visible.forEach(marker => seen.add(marker)); coverage.push({ region: index + 1, visible: actual.visible })
    if (actual.visible.includes('DOCUMENT-END-SENTINEL')) await captureNative(info.outputPath('long-document-final-region.png'))
    if (index === 0) await captureNative(info.outputPath('long-document-first-region.png'))
  }
  expect([...seen].sort()).toEqual([...markers].sort())
  writeFileSync(info.outputPath('coverage.json'), JSON.stringify({ ...result, coverage }, null, 2))
})

test('横向宽页和显式分页按原顺序覆盖，未缩小字体', async ({}, info) => {
  const content = paragraph('SECTION-ONE-START') + '<w:tbl><w:tblPr><w:tblW w:w="17280" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="8640"/><w:gridCol w:w="8640"/></w:tblGrid><w:tr><w:tc>' + paragraph('WIDE-LEFT-MARKER') + '</w:tc><w:tc>' + paragraph('WIDE-RIGHT-MARKER', '<w:jc w:val="right"/>') + '</w:tc></w:tr></w:tbl>' + paragraph('SECTION-ONE-END') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + paragraph('SECTION-TWO-END')
  const result = await page.evaluate(base64 => (window as unknown as HarnessWindow).renderDocx(base64), await docx(content, 20000))
  expect(result.sections).toBe(2)
  expect(result.count, 'empty paper tails should not create many blank inspection images').toBeLessThan(6)
  const markers = ['SECTION-ONE-START', 'WIDE-LEFT-MARKER', 'WIDE-RIGHT-MARKER', 'SECTION-ONE-END', 'SECTION-TWO-END'], seen = new Set<string>()
  for (let index = 0; index < result.count; index++) {
    const actual = await page.evaluate(({ index, markers }) => (window as unknown as HarnessWindow).checkRegion(index, markers), { index, markers })
    expect(actual.bodySize).toBe('16px'); actual.visible.forEach(marker => seen.add(marker))
    if (actual.visible.includes('WIDE-RIGHT-MARKER')) await captureNative(info.outputPath('wide-right-region.png'))
  }
  expect([...seen].sort()).toEqual([...markers].sort())
})

test('跨区域的正常文字行在重叠画面中有完整证据，保留表格样式', async () => {
  await page.evaluate(base64 => (window as unknown as HarnessWindow).renderDocx(base64), await docx(table(45, 'BOUNDARY')))
  const result = await page.evaluate(async () => {
    const w = window as unknown as HarnessWindow, markers = Array.from({ length: 45 }, (_, i) => `BOUNDARY-${String(i).padStart(3, '0')}`)
    const coverage: Record<string, number[]> = {}, styles = []
    for (let index = 0; index < w.regions.length; index++) {
      const actual = await w.checkRegion(index, markers)
      for (const marker of actual.visible) (coverage[marker] ??= []).push(index)
      const cell = document.querySelector('#capture td')!, css = getComputedStyle(cell)
      styles.push({ fill: css.backgroundColor, border: css.borderTop, font: getComputedStyle(cell.querySelector('p')!).fontSize })
    }
    return { coverage, styles }
  })
  expect(Object.keys(result.coverage)).toHaveLength(45)
  expect(Object.values(result.coverage).some(regions => regions.length > 1)).toBe(true)
  expect(new Set(result.styles.map(style => style.font))).toEqual(new Set(['16px']))
  expect(new Set(result.styles.map(style => style.fill))).toEqual(new Set(['rgb(237, 243, 248)']))
  expect(result.styles.every(style => style.border.includes('rgb(112, 146, 176)'))).toBe(true)
})

test('预算不足与原始内部裁切明确失败，不返回前几张冒充完整内容', async () => {
  const failures = await page.evaluate(async () => {
    const w = window as unknown as HarnessWindow, results = []
    for (const [sections, options] of [[w.sourceSections, { maxRegions: 1 }], [w.sourceSections, { maxHtmlBytes: 1 }], ['<section class="docx" style="width:816px;height:80px;overflow:hidden"><p style="margin-top:200px">CLIPPED-TAIL</p></section>', {}]] as const) {
      try { await w.proposal.docxPreviewRegions(typeof sections === 'string' ? [sections] : sections, new AbortController().signal, options); results.push('unexpected-success') }
      catch (error) { results.push(String(error)) }
    }
    return { results, frames: document.querySelectorAll('iframe').length }
  })
  expect(failures.results[0]).toContain('超过 1 个预览区域'); expect(failures.results[1]).toContain('HTML 预算'); expect(failures.results[2]).toContain('内部存在裁切')
  expect(failures.frames).toBe(0)
})

test('取消移除测量iframe，文档样式不能触发外网加载', async () => {
  const before = networkRequests
  const result = await page.evaluate(async url => {
    const w = window as unknown as HarnessWindow
    const safe = w.sanitize(`<style>.docx{background-image:url('${url}')}</style><section class="docx" style="width:816px;min-height:1056px"><p>SAFE-CONTENT</p><script>window.externalExecuted=true</script></section>`)
    const regions = await w.proposal.docxPreviewRegions([safe], new AbortController().signal)
    document.getElementById('capture')!.innerHTML = regions[0]
    await document.fonts.ready
    const cancellation = new AbortController()
    const pending = w.proposal.docxPreviewRegions(w.sourceSections, cancellation.signal)
    cancellation.abort(new Error('fixture cancellation'))
    let error = ''; try { await pending } catch (cause) { error = String(cause) }
    return { regions: regions.length, frames: document.querySelectorAll('iframe').length, error, scriptPresent: safe.includes('<script') }
  }, networkUrl)
  expect(result.regions).toBeGreaterThan(0); expect(result.frames).toBe(0); expect(result.error).toContain('fixture cancellation'); expect(result.scriptPresent).toBe(false)
  expect(networkRequests).toBe(before)
})
