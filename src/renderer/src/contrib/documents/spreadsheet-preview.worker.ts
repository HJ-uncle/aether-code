import ExcelJS, { type Workbook } from 'exceljs'
import { DOCUMENT_LIMITS } from './document-kind'
import { prepareOfficeArchive } from './office-archive'
import { SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, type SheetCell, type SheetLayout, type SpreadsheetRequest, type SpreadsheetResponse } from './spreadsheet-preview-contract'
import { spreadsheetDisplayValue } from './spreadsheet-value'
import { spreadsheetCellStyle, spreadsheetLength, spreadsheetThemeColors } from './spreadsheet-style'

let workbook: Workbook | null = null
const reply = (message: SpreadsheetResponse): void => { postMessage(message) }
onmessage = (event: MessageEvent<SpreadsheetRequest>): void => {
  void (async () => {
    const message = event.data
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
      reply({ kind: 'loaded', sheets })
    } else if (message.kind === 'page' && workbook) {
      const { sheet: index, row, column } = message
      const sheet = workbook.worksheets[index]
      if (!sheet || ![index, row, column].every(Number.isSafeInteger) || row < 0 || column < 0 || row >= Math.max(sheet.rowCount, 1) || column >= Math.max(sheet.columnCount, 1)) throw new Error('所选表格区域无效。')
      const themeColors = spreadsheetThemeColors((workbook as Workbook & { _themes?: { theme1?: unknown } })._themes?.theme1)
      let formatFallbacks = 0
      const rows = Math.min(SHEET_PAGE_ROWS, Math.max(1, sheet.rowCount) - row)
      const columns = Math.min(SHEET_PAGE_COLUMNS, Math.max(1, sheet.columnCount) - column)
      const spans = new Map<number, { colSpan: number; rowSpan: number }>(), covered = new Set<number>()
      for (const ref of sheet.model.merges) {
        const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
        if (!match) continue
        const number = (letters: string): number => Array.from(letters).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
        const startColumn = number(match[1]), startRow = Number(match[2]), endColumn = number(match[3]), endRow = Number(match[4])
        if (startRow > row + rows || endRow <= row || startColumn > column + columns || endColumn <= column) continue
        spans.set((Math.max(startRow, row + 1) - 1 - row) * columns + Math.max(startColumn, column + 1) - 1 - column, {
          rowSpan: Math.min(endRow, row + rows) - Math.max(startRow, row + 1) + 1,
          colSpan: Math.min(endColumn, column + columns) - Math.max(startColumn, column + 1) + 1
        })
        for (let y = Math.max(startRow, row + 1); y <= Math.min(endRow, row + rows); y++) {
          for (let x = Math.max(startColumn, column + 1); x <= Math.min(endColumn, column + columns); x++) {
            if (y !== Math.max(startRow, row + 1) || x !== Math.max(startColumn, column + 1)) covered.add((y - 1 - row) * columns + x - 1 - column)
          }
        }
      }
      const cells = Array.from({ length: rows }, (_, y) =>
        Array.from({ length: columns }, (_, x): SheetCell => {
          const position = y * columns + x, cell = sheet.getCell(row + y + 1, column + x + 1)
          const valueCell = cell.isMerged ? cell.master : cell
          const display = spreadsheetDisplayValue(valueCell.value, valueCell.text, valueCell.numFmt, workbook?.properties.date1904 === true)
          if (display.formatFallback) formatFallbacks++
          return {
            text: display.text,
            ...spreadsheetCellStyle(cell.style, themeColors),
            ...(spans.get(position) || {}),
            ...(covered.has(position) ? { covered: true } : {})
          }
        }))
      const layout: SheetLayout = {
        columns: Array.from({ length: columns }, (_, x) => spreadsheetLength(sheet.getColumn(column + x + 1).width, 110, 7, 640)),
        rows: Array.from({ length: rows }, (_, y) => spreadsheetLength(sheet.getRow(row + y + 1).height, 30, 1.34, 640))
      }
      reply({ kind: 'page', page: { sheet: index, row, column, cells, formatFallbacks, layout } })
    }
  })().catch((error: unknown) => reply({ kind: 'error', message: error instanceof Error ? error.message : '工作簿暂时无法预览。' }))
}
