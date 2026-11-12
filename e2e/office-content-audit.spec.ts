/** New Office audit: real font metadata survives worker page normalization,
 * invalid typography is bounded, and point units remain independent of pixels. */
import { expect, test } from '@playwright/test'
import ExcelJS from 'exceljs'
import { buildSpreadsheetPage } from '../src/renderer/src/features/documents/spreadsheet-page'
import { spreadsheetCellStyle } from '../src/renderer/src/features/documents/spreadsheet-style'

test('Excel font names and point sizes survive binary loading and page slicing', async () => {
  const source = new ExcelJS.Workbook(), sheet = source.addWorksheet('字体')
  sheet.getCell('A1').value = '标题字号'
  sheet.getCell('A1').font = { name: 'Microsoft YaHei', size: 24, bold: true }
  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(await source.xlsx.writeBuffer())
  const page = buildSpreadsheetPage(loaded.worksheets[0], 0, 0, 0, [], false)
  expect(page.cells[0][0]).toMatchObject({ text: '标题字号', fontFamily: '"Microsoft YaHei"', fontSize: 24, bold: true })
})

test('font names are a single quoted family and unsupported sizes are discarded', () => {
  expect(spreadsheetCellStyle({ font: { name: 'A,"B"\\C', size: 12 } }, []).fontFamily).toBe('"A,\\"B\\"\\\\C"')
  for (const size of [0, -1, Infinity, NaN, 410]) expect(spreadsheetCellStyle({ font: { size } }, []).fontSize).toBeUndefined()
  for (const name of ['bad\nfont', 'x'.repeat(129)]) expect(spreadsheetCellStyle({ font: { name } }, []).fontFamily).toBeUndefined()
  expect(spreadsheetCellStyle({ font: { size: 10.5 } }, []).fontSize).toBe(10.5)
})
