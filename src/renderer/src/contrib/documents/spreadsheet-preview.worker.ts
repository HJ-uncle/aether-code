import ExcelJS, { type Workbook } from 'exceljs'
import { DOCUMENT_LIMITS } from './document-kind'
import { prepareOfficeArchive } from './office-archive'
import { type SpreadsheetRequest, type SpreadsheetResponse } from './spreadsheet-preview-contract'
import { spreadsheetThemeColors } from './spreadsheet-style'
import { buildSpreadsheetLayout, buildSpreadsheetPage, spreadsheetRequestValid } from './spreadsheet-page'

let workbook: Workbook | null = null
const reply = (message: SpreadsheetResponse): void => { postMessage(message) }
onmessage = (event: MessageEvent<SpreadsheetRequest>): void => {
  const message = event.data
  void (async () => {
    if (message.kind === 'load') {
      const next = new ExcelJS.Workbook()
      const buffer = await prepareOfficeArchive(message.data, 'xlsx', new AbortController().signal)
      // All ZIP/XML/workbook work stays here; transferring the input to this
      // worker leaves the editor responsive even for a large worksheet.
      await next.xlsx.load(buffer, { ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting', 'dataValidations'] })
      workbook = next
      const sheets = next.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }))
      let cells = 0
      next.eachSheet(sheet => sheet.eachRow(row => { cells += row.actualCellCount }))
      if (sheets.length > DOCUMENT_LIMITS.sheets || sheets.some(sheet => sheet.rows > DOCUMENT_LIMITS.rows || sheet.columns > DOCUMENT_LIMITS.columns) || cells > DOCUMENT_LIMITS.cells) {
        workbook = null; throw new Error('工作簿超出 Aether 当前预览范围，原文件已保留。')
      }
      // Offsets are computed from the real dimensions for the whole sheet once;
      // scrolling never has to guess positions from the currently loaded cells.
      const layouts = next.worksheets.map(sheet => buildSpreadsheetLayout(sheet))
      reply({ kind: 'loaded', sheets, layouts })
    } else if (message.kind === 'page' && workbook) {
      const { sheet: index, row, column, endRow, endColumn, requestId } = message
      const sheet = workbook.worksheets[index]
      if (!sheet || !spreadsheetRequestValid(index, row, column, sheet, endRow, endColumn)) throw new Error('所选表格区域无效。')
      const themeColors = spreadsheetThemeColors((workbook as Workbook & { _themes?: { theme1?: unknown } })._themes?.theme1)
      const page = buildSpreadsheetPage(sheet, index, row, column, themeColors, workbook.properties.date1904 === true, endRow, endColumn)
      reply({ kind: 'page', requestId, page })
    }
  })().catch((error: unknown) => reply({ kind: 'error', message: error instanceof Error ? error.message : '工作簿暂时无法预览。', ...(message.kind === 'page' ? { requestId: message.requestId } : {}) }))
}
