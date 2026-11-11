/** New isolated Electron acceptance for XLSX review regions: real shared cells,
 * worker preparation and charts; no old E2E, production profile or export flow. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'

const root = resolve(__dirname, '..'), temporary = join(root, '.e2e-tmp')
let app: ElectronApplication, page: Page, workspace = '', mixed: Buffer
const runtimeErrors: string[] = []
interface Result { pages?: string[]; error?: string }
type Harness = Window & { renderXlsxTest(bytes: number[], options?: { abort?: boolean; abortAfter?: number }): Promise<Result> }
async function workbook(configure: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook(); configure(book); return Buffer.from(await book.xlsx.writeBuffer())
}
function style(sheet: ExcelJS.Worksheet): void {
  sheet.eachRow((row, index) => row.eachCell(cell => {
    cell.font = { name: 'Microsoft YaHei', size: index === 1 ? 11 : 10, bold: index === 1, color: { argb: index === 1 ? 'FFFFFFFF' : 'FF27364B' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 1 ? 'FF243247' : index % 2 ? 'FFF7F9FC' : 'FFFFFFFF' } }
    cell.alignment = { wrapText: true, vertical: 'middle' }
  }))
}
test.beforeAll(async () => {
  mkdirSync(temporary, { recursive: true }); workspace = mkdtempSync(join(temporary, 'xlsx-native-'))
  const main = join(workspace, 'main.cjs')
  writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(workspace, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:960,height:540,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});w.loadURL('http://127.0.0.1:14622/.e2e-tmp/office-xlsx-render-fixture/index.html')});app.on('window-all-closed',()=>app.quit());`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [main], cwd: root, env }); page = await app.firstWindow()
  page.on('pageerror', error => runtimeErrors.push(error.message))
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 60_000 })
  mixed = await workbook(book => {
    const sheet = book.addWorksheet('Mixed'); sheet.columns = [{ width: 15 }, { width: 60 }, { width: 22 }]
    sheet.addRow(['ID', 'Description', 'Data'])
    for (let row = 1; row <= 60; row++) sheet.addRow([`ROW-${String(row).padStart(3, '0')}`, row === 20 ? 'manifest.webmanifest'.repeat(5) : row % 7 === 0 ? '中文长说明应自然换行。'.repeat(10) : `Body ${row}`, row])
    sheet.getRow(8).height = 48
    sheet.mergeCells('B14:B16'); sheet.getCell('B14').value = 'VERTICAL-MERGE-UNIQUE'
    sheet.mergeCells('B24:C24'); sheet.getCell('B24').value = 'HORIZONTAL-MERGE-UNIQUE'; style(sheet)
  })
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    if (workspace) { const target = resolve(workspace); if (dirname(target) !== temporary || !basename(target).startsWith('xlsx-native-')) throw new Error('Unsafe fixture cleanup'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})
test.afterEach(async () => { expect(runtimeErrors).toEqual([]); expect(await page.locator('[data-xlsx-measure]').count()).toBe(0) })
async function render(bytes: Buffer, options?: { abort?: boolean; abortAfter?: number }): Promise<Result> {
  return page.evaluate(({ bytes, options }) => (window as unknown as Harness).renderXlsxTest(bytes, options), { bytes: [...bytes], options })
}
async function valid(bytes: Buffer): Promise<string[]> { const result = await render(bytes); expect(result.error).toBeUndefined(); expect(result.pages?.length).toBeGreaterThan(0); return result.pages! }
async function inspect(html: string) {
  return page.evaluate(async html => {
    document.getElementById('capture')?.remove()
    const frame = document.createElement('iframe'); frame.id = 'capture'; frame.setAttribute('sandbox', 'allow-same-origin')
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '960px', height: '540px', border: '0', zIndex: '1000', background: 'white' })
    const ready = new Promise<void>(done => { frame.onload = () => done() })
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'none';connect-src 'none';img-src data:;style-src 'unsafe-inline';font-src 'none';base-uri 'none';form-action 'none';object-src 'none';frame-src 'none'"><style>html,body{margin:0;width:960px;height:540px;overflow:hidden;background:white;color:black;color-scheme:light}*{animation:none!important;transition:none!important}</style></head><body>${html}</body></html>`
    // Set srcdoc before mounting so about:blank cannot satisfy the load signal.
    document.body.append(frame)
    await ready; const doc = frame.contentDocument!, win = frame.contentWindow!; await doc.fonts.ready
    const bounds = doc.querySelector('.aether-xlsx-region__content')!.getBoundingClientRect()
    return { bottom: bounds.bottom, title: doc.querySelector('.aether-xlsx-region__title')!.textContent,
      rows: [...doc.querySelectorAll('[data-sheet-row]')].map(row => Number(row.getAttribute('data-sheet-row'))),
      cells: [...doc.querySelectorAll('td')].map(cell => { const css = win.getComputedStyle(cell), box = cell.getBoundingClientRect(); return {
        text: cell.textContent, fill: css.backgroundColor, color: css.color, font: css.fontFamily, fontSize: css.fontSize, width: box.width,
        longWrap: css.overflowWrap, clipped: cell.scrollWidth > cell.clientWidth + 2 || cell.scrollHeight > cell.clientHeight + 2,
        bottom: box.bottom, right: box.right, rowSpan: cell.rowSpan, colSpan: cell.colSpan,
      } }), charts: [...doc.querySelectorAll('[data-spreadsheet-chart]')].map(chart => ({
        type: chart.getAttribute('data-chart-type'), slices: chart.querySelectorAll('[data-chart-slice]').length,
        colors: [...chart.querySelectorAll('[data-chart-slice]')].map(slice => win.getComputedStyle(slice).fill),
        legendColors: [...chart.querySelectorAll('.spreadsheet-chart__legend li > span')].map(swatch => win.getComputedStyle(swatch).backgroundColor),
      })) }
  }, html)
}
async function inspectAll(pages: string[]) {
  const snapshots: Awaited<ReturnType<typeof inspect>>[] = []
  for (const html of pages) { const snapshot = await inspect(html); expect(snapshot.bottom).toBeLessThanOrEqual(524.5)
    expect(snapshot.cells.filter(cell => cell.clipped || cell.bottom > 524.5 || cell.right > 944.5)).toEqual([]); snapshots.push(snapshot) }
  return snapshots
}
test('60条数据含多行说明与不同高度，全部末行位于真实可见范围', async ({}, info) => {
  const pages = await valid(mixed), actual = await inspectAll(pages)
  expect(actual.flatMap(snapshot => snapshot.rows)).toEqual(Array.from({ length: 61 }, (_, i) => i + 1))
  for (let row = 1; row <= 60; row++) expect(actual.flatMap(snapshot => snapshot.cells).filter(cell => cell.text === `ROW-${String(row).padStart(3, '0')}`)).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('all-rows-final-region.png') })
})
test('源表头字体、填色、列宽保留，长文件名开启换行后完整显示', async ({}, info) => {
  const actual = await inspectAll(await valid(mixed)), first = actual[0].cells[0]
  expect(first.fill).toBe('rgb(36, 50, 71)'); expect(first.color).toBe('rgb(255, 255, 255)'); expect(first.font).toContain('Microsoft YaHei'); expect(first.width).toBe(105)
  const long = actual.flatMap(snapshot => snapshot.cells).find(cell => cell.text?.includes('manifest.webmanifest'))!
  expect(long.longWrap).toBe('anywhere'); expect(long.clipped).toBe(false)
  await inspect((await valid(mixed))[1]); await page.screenshot({ path: info.outputPath('source-style-wrapping.png') })
})
test('横纵合并跨候选分区边界时保留主单元格与完整跨度', async () => {
  const actual = (await inspectAll(await valid(mixed))).flatMap(snapshot => snapshot.cells)
  expect(actual.filter(cell => cell.text === 'VERTICAL-MERGE-UNIQUE')).toHaveLength(1)
  expect(actual.find(cell => cell.text === 'VERTICAL-MERGE-UNIQUE')!.rowSpan).toBe(3)
  expect(actual.find(cell => cell.text === 'HORIZONTAL-MERGE-UNIQUE')!.colSpan).toBe(2)
})
test('宽工作表按真实列宽分区，右侧最后一列不丢失', async () => {
  const bytes = await workbook(book => { const sheet = book.addWorksheet('Wide'); sheet.columns = [{ width: 70 }, { width: 70 }, { width: 70 }]; sheet.addRows([['A', 'B', 'C'], ['A-END', 'B-END', 'C-END']]); style(sheet) })
  const actual = await inspectAll(await valid(bytes)); expect(actual).toHaveLength(3)
  for (const value of ['A-END', 'B-END', 'C-END']) expect(actual.flatMap(snapshot => snapshot.cells).filter(cell => cell.text === value)).toHaveLength(1)
})
test('公式缓存0、false和百分比正确显示，缺失缓存如实告知', async ({}, info) => {
  const bytes = await workbook(book => { const sheet = book.addWorksheet('Values'); sheet.columns = [{ width: 26 }, { width: 36 }]
    sheet.addRows([['Kind', 'Value'], ['Zero', { formula: '1-1', result: 0 }], ['Boolean', { formula: '1>2', result: false }], ['Percent', { formula: '1/8', result: .125 }], ['Missing cache', { formula: 'SUM(1,2)' }]])
    sheet.getCell('B2').numFmt = '0.00'; sheet.getCell('B4').numFmt = '0.0%'; style(sheet) })
  const actual = await inspectAll(await valid(bytes)), text = actual.flatMap(snapshot => snapshot.cells).map(cell => cell.text)
  for (const expected of ['0.00', 'FALSE', '12.5%', '未保存计算结果']) expect(text).toContain(expected)
  expect(text).not.toContain('[object Object]'); await page.screenshot({ path: info.outputPath('formula-falsy-caches.png') })
})
async function nativeChart(): Promise<Buffer> {
  const base = await workbook(book => { const sheet = book.addWorksheet('Status'); sheet.columns = [{ width: 20 }, { width: 15 }]; sheet.addRows([['Status', 'Count'], ['Ready', 23], ['Missing', 2], ['Unknown', 4]]); style(sheet) })
  const zip = await JSZip.loadAsync(base)
  zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('</worksheet>', '<drawing r:id="chartDrawing"/></worksheet>'))
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chartDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>')
  zip.file('xl/drawings/drawing1.xml', '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="4762500" cy="2857500"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="Status chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>')
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>')
  zip.file('xl/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:doughnutChart><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Status counts</c:v></c:tx><c:cat><c:strRef><c:f>Status!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Status!$B$2:$B$4</c:f></c:numRef></c:val></c:ser><c:holeSize val="55"/></c:doughnutChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>')
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  return zip.generateAsync({ type: 'nodebuffer' })
}
test('原生工作簿图表与数据均生成可见区域，不丢弃环形图', async ({}, info) => {
  const actual = await inspectAll(await valid(await nativeChart()))
  const palette = await page.evaluate(() => [1, 2, 3].map(index => {
    const swatch = document.createElement('span'); swatch.style.color = `var(--document-chart-${index})`; document.body.append(swatch)
    const color = getComputedStyle(swatch).color; swatch.remove(); return color
  }))
  expect(new Set(palette).size).toBe(3)
  expect(actual.flatMap(snapshot => snapshot.charts)).toEqual([{ type: 'doughnut', slices: 3, colors: palette, legendColors: palette }])
  expect(actual.flatMap(snapshot => snapshot.cells).some(cell => cell.text === '23')).toBe(true)
  await page.screenshot({ path: info.outputPath('native-chart-region.png') })
})
test('超高数据行明确失败并清理临时测量节点', async () => {
  const bytes = await workbook(book => { const sheet = book.addWorksheet('Tall'); sheet.getCell('A1').value = 'Too tall'; sheet.getRow(1).height = 600 })
  expect((await render(bytes)).error).toContain('高于单个画面')
})
test('超宽合并区域明确失败，不把正文裁成空白', async () => {
  const bytes = await workbook(book => { const sheet = book.addWorksheet('Merged'); sheet.columns = [{ width: 80 }, { width: 80 }]; sheet.mergeCells('A1:B1'); sheet.getCell('A1').value = 'Too wide' })
  expect((await render(bytes)).error).toContain('宽于单个预览区域')
})
test('超页数和损坏输入有明确错误，不返回部分成功', async () => {
  const bytes = await workbook(book => { const sheet = book.addWorksheet('Large'); for (let row = 1; row <= 1600; row++) sheet.getCell(row, 1).value = row })
  expect((await render(bytes)).error).toContain('超过 100'); expect((await render(Buffer.from('not-a-workbook'))).error).toContain('Error')
})
test('启动前和解析中的取消均停止处理，无残留测量界面', async () => {
  expect((await render(mixed, { abort: true })).error).toContain('AbortError')
  expect((await render(mixed, { abortAfter: 1 })).error).toContain('AbortError')
})
