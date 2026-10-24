import ExcelJS, { type Workbook } from 'exceljs'
import { DOCUMENT_LIMITS } from './document-kind'
import { SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, type SpreadsheetRequest, type SpreadsheetResponse } from './spreadsheet-preview-contract'
import { spreadsheetDisplayValue } from './spreadsheet-value'

let workbook: Workbook | null = null
const reply = (message: SpreadsheetResponse): void => { postMessage(message) }
onmessage = (event: MessageEvent<SpreadsheetRequest>): void => {
  void (async () => {
    const message = event.data
    if (message.kind === 'load') {
      workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(message.data, { ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting', 'dataValidations'] })
      const sheets = workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }))
      let cells = 0
      workbook.eachSheet(sheet => sheet.eachRow(row => { cells += row.actualCellCount }))
      if (sheets.length > DOCUMENT_LIMITS.sheets || sheets.some(sheet => sheet.rows > DOCUMENT_LIMITS.rows || sheet.columns > DOCUMENT_LIMITS.columns) || cells > DOCUMENT_LIMITS.cells) {
        workbook = null; throw new Error('工作簿超出预览范围，请使用本机应用打开。')
      }
      reply({ kind: 'loaded', sheets })
    } else if (message.kind === 'page' && workbook) {
      const { sheet: index, row, column } = message
      const sheet = workbook.worksheets[index]
      if (!sheet || ![index, row, column].every(Number.isSafeInteger) || row < 0 || column < 0 || row >= Math.max(sheet.rowCount, 1) || column >= Math.max(sheet.columnCount, 1)) throw new Error('所选表格区域无效。')
      let formatFallbacks = 0
      const cells = Array.from({ length: Math.min(SHEET_PAGE_ROWS, Math.max(1, sheet.rowCount) - row) }, (_, y) =>
        Array.from({ length: Math.min(SHEET_PAGE_COLUMNS, Math.max(1, sheet.columnCount) - column) }, (_, x) => {
          const cell = sheet.getCell(row + y + 1, column + x + 1), alignment = cell.alignment?.horizontal
          const display = spreadsheetDisplayValue(cell.value, cell.text, cell.numFmt, workbook?.properties.date1904 === true)
          if (display.formatFallback) formatFallbacks++
          return { text: display.text, bold: cell.font?.bold === true, italic: cell.font?.italic === true,
            ...(alignment === 'left' || alignment === 'center' || alignment === 'right' ? { align: alignment } : {}) }
        }))
      reply({ kind: 'page', page: { sheet: index, row, column, cells, formatFallbacks } })
    }
  })().catch((error: unknown) => reply({ kind: 'error', message: error instanceof Error ? error.message : '工作簿暂时无法预览。' }))
}
