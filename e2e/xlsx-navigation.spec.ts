/** New real-Electron navigation cases only: long rows, horizontal bands,
 * multiple worksheet/chart ownership and an empty sheet. No export flow. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import type { XlsxRenderedDocument } from '../src/shared/office-render'

const root = resolve(__dirname, '..'), temporary = join(root, '.e2e-tmp')
let app: ElectronApplication, page: Page, workspace = '', result: XlsxRenderedDocument
const errors: string[] = []
type Harness = Window & { renderNavigation(bytes: number[]): Promise<XlsxRenderedDocument> }

async function fixtureWorkbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const detail = book.addWorksheet('功能明细'); detail.columns = [{ width: 18 }, { width: 30 }, { width: 18 }]
  detail.addRow(['编号', '说明', '状态'])
  for (let i = 1; i <= 36; i++) detail.addRow([i, `功能-${i}`, '已实现'])
  const wide = book.addWorksheet('宽工作表'); wide.columns = [{ width: 70 }, { width: 70 }, { width: 70 }]
  wide.addRows([['A列', 'B列', 'C列'], ['LEFT-END', 'MIDDLE-END', 'RIGHT-END']])
  const stats = book.addWorksheet('统计视图'); stats.columns = [{ width: 20 }, { width: 15 }]
  stats.addRows([['状态', '数量'], ['已实现', 23], ['未提供', 2], ['待核实', 4]])
  book.addWorksheet('留白表')
  const zip = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
  zip.file('xl/worksheets/sheet3.xml', (await zip.file('xl/worksheets/sheet3.xml')!.async('string')).replace('</worksheet>', '<drawing r:id="charts"/></worksheet>'))
  const relationship = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const relationships = (contents: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${contents}</Relationships>`
  zip.file('xl/worksheets/_rels/sheet3.xml.rels', relationships(relationship('charts', 'drawing', '../drawings/drawing1.xml')))
  const anchors = [1, 2].map(i => `<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="4762500" cy="2667000"/><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="${i}" name="chart${i}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart${i}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`).join('')
  zip.file('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`)
  zip.file('xl/drawings/_rels/drawing1.xml.rels', relationships([1, 2].map(i => relationship(`chart${i}`, 'chart', `../charts/chart${i}.xml`)).join('')))
  for (const [i, title] of ['功能状态分布', '交付范围'].entries()) zip.file(`xl/charts/chart${i + 1}.xml`, `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:pieChart><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>状态</c:v></c:tx><c:cat><c:strRef><c:f>统计视图!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>统计视图!$B$2:$B$4</c:f></c:numRef></c:val></c:ser></c:pieChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`)
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' + [1, 2].map(i => `<Override PartName="/xl/charts/chart${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('') + '</Types>'))
  return zip.generateAsync({ type: 'nodebuffer' })
}

test.beforeAll(async () => {
  mkdirSync(temporary, { recursive: true }); workspace = mkdtempSync(join(temporary, 'xlsx-navigation-'))
  const main = join(workspace, 'main.cjs')
  writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(workspace, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:960,height:540,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});w.loadURL('http://127.0.0.1:14631/.e2e-tmp/xlsx-navigation-fixture/index.html')});app.on('window-all-closed',()=>app.quit());`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [main], cwd: root, env }); page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 60_000 })
  result = await page.evaluate(bytes => (window as unknown as Harness).renderNavigation(bytes), [...await fixtureWorkbook()])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    if (workspace) { const target = resolve(workspace); if (dirname(target) !== temporary || !basename(target).startsWith('xlsx-navigation-')) throw new Error('Unsafe cleanup'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})
test.afterEach(async () => { expect(errors).toEqual([]); expect(await page.locator('[data-xlsx-measure]').count()).toBe(0) })

test('分组目录覆盖全部区域，纵向分页和横向分区的当前范围与真实单元格一致', async () => {
  expect(result.navigation.sheets.map(sheet => sheet.name)).toEqual(['功能明细', '宽工作表', '统计视图', '留白表'])
  expect(result.regions).toHaveLength(result.pages.length)
  const detail = result.regions.filter(region => region.sheet === 1)
  expect(detail).toEqual([
    { sheet: 1, name: '功能明细', kind: 'cells', range: 'A1:C15' },
    { sheet: 1, name: '功能明细', kind: 'cells', range: 'A16:C30' },
    { sheet: 1, name: '功能明细', kind: 'cells', range: 'A31:C37' },
  ])
  expect(result.regions.filter(region => region.sheet === 2).map(region => region.kind === 'cells' && region.range)).toEqual(['A1:A2', 'B1:B2', 'C1:C2'])
  let next = 1
  for (const sheet of result.navigation.sheets) {
    expect(sheet.firstPage).toBe(next)
    for (let index = sheet.firstPage - 1; index < sheet.lastPage; index++) expect(result.regions[index].name).toBe(sheet.name)
    next = sheet.lastPage + 1
  }
  expect(next).toBe(result.pages.length + 1)
  expect(result.regions.at(-1)).toEqual({ sheet: 4, name: '留白表', kind: 'cells', range: 'A1:A1' })
  const markers = await page.evaluate(pages => pages.map(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return { title: doc.querySelector('.aether-xlsx-region__title')!.textContent, rows: [...doc.querySelectorAll('[data-sheet-row]')].map(row => Number(row.getAttribute('data-sheet-row'))), text: doc.body.textContent }
  }), result.pages)
  expect(markers.slice(0, 3).flatMap(part => part.rows)).toEqual(Array.from({ length: 37 }, (_, i) => i + 1))
  expect(markers[5].text).toContain('RIGHT-END')
})

test('目录指明两张图表所在区域，按编号直接显示对应真实图表', async ({}, info) => {
  const stats = result.navigation.sheets[2]
  expect(stats.chartPages).toHaveLength(2)
  expect(stats.chartPages).toEqual([stats.lastPage - 1, stats.lastPage])
  for (const [index, chartPage] of stats.chartPages.entries()) {
    expect(result.regions[chartPage - 1]).toEqual({ sheet: 3, name: '统计视图', kind: 'chart', title: ['功能状态分布', '交付范围'][index] })
    const actual = await page.evaluate(html => {
      document.getElementById('capture')?.remove()
      const display = document.createElement('div'); display.id = 'capture'; display.innerHTML = html; document.body.append(display)
      return { title: display.querySelector('.aether-xlsx-region__title')!.textContent, charts: display.querySelectorAll('[data-spreadsheet-chart]').length, slices: display.querySelectorAll('[data-chart-slice]').length }
    }, result.pages[chartPage - 1])
    expect(actual.title).toContain(['功能状态分布', '交付范围'][index])
    expect(actual.charts).toBe(1); expect(actual.slices).toBe(3)
    await page.screenshot({ path: info.outputPath(`chart-region-${chartPage}.png`) })
  }
})
