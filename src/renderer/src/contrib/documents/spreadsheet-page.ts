import { DOCUMENT_LIMITS } from './document-kind'
import { SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, SHEET_RANGE_CELL_LIMIT, type SheetCell, type SheetLayout, type SheetPage } from './spreadsheet-preview-contract'
import { spreadsheetDisplayValue } from './spreadsheet-value'
import { spreadsheetCellStyle, spreadsheetLength } from './spreadsheet-style'
import type { SpreadsheetCellStyle } from './spreadsheet-style'

export interface SpreadsheetPageSource {
  rowCount: number
  columnCount: number
  model: { merges: string[] }
  getCell: (row: number, column: number) => {
    isMerged: boolean
    value: Parameters<typeof spreadsheetDisplayValue>[0]
    text: string
    numFmt: string
    master: {
      value: Parameters<typeof spreadsheetDisplayValue>[0]
      text: string
      numFmt: string
    }
    style: SpreadsheetCellStyle
  }
  getColumn: (column: number) => { width?: number }
  getRow: (row: number) => { height?: number }
}

function columnNumber(letters: string): number {
  return Array.from(letters).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
}

/**
 * Slice merges against the requested page. A continuation gets the master's
 * value only at the clipped top-left; ExcelJS's absolute master can otherwise
 * belong to a different page and duplicate its value across page boundaries.
 */
export function buildSpreadsheetPage(source: SpreadsheetPageSource, sheet: number, row: number, column: number, themeColors: string[], date1904: boolean, endRow = row + SHEET_PAGE_ROWS, endColumn = column + SHEET_PAGE_COLUMNS): SheetPage {
  const rows = Math.max(0, Math.min(endRow, Math.max(1, source.rowCount)) - row)
  const columns = Math.max(0, Math.min(endColumn, Math.max(1, source.columnCount)) - column)
  const spans = new Map<number, { colSpan: number; rowSpan: number }>()
  const covered = new Set<number>()
  const continuation = new Set<number>()
  for (const ref of source.model.merges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
    if (!match) continue
    const startColumn = columnNumber(match[1]), startRow = Number(match[2])
    const endColumn = columnNumber(match[3]), endRow = Number(match[4])
    if (startRow > row + rows || endRow <= row || startColumn > column + columns || endColumn <= column) continue
    const visibleStartRow = Math.max(startRow, row + 1), visibleStartColumn = Math.max(startColumn, column + 1)
    const visibleEndRow = Math.min(endRow, row + rows), visibleEndColumn = Math.min(endColumn, column + columns)
    const anchor = (visibleStartRow - 1 - row) * columns + visibleStartColumn - 1 - column
    spans.set(anchor, { rowSpan: visibleEndRow - visibleStartRow + 1, colSpan: visibleEndColumn - visibleStartColumn + 1 })
    if (visibleStartRow !== startRow || visibleStartColumn !== startColumn) continuation.add(anchor)
    for (let y = visibleStartRow; y <= visibleEndRow; y++) {
      for (let x = visibleStartColumn; x <= visibleEndColumn; x++) {
        if (y !== visibleStartRow || x !== visibleStartColumn) covered.add((y - 1 - row) * columns + x - 1 - column)
      }
    }
  }
  let formatFallbacks = 0
  const cells = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: columns }, (_, x): SheetCell => {
      const position = y * columns + x, cell = source.getCell(row + y + 1, column + x + 1)
      const valueCell = cell.isMerged && !continuation.has(position) ? cell.master : cell
      const display = continuation.has(position)
        ? { text: '', formatFallback: false }
        : spreadsheetDisplayValue(valueCell.value, valueCell.text, valueCell.numFmt, date1904)
      if (display.formatFallback) formatFallbacks++
      return {
        text: display.text,
        ...spreadsheetCellStyle(cell.style, themeColors),
        ...(spans.get(position) || {}),
        ...(covered.has(position) ? { covered: true } : {})
      }
    }))
  const layout: SheetLayout = {
    columns: Array.from({ length: columns }, (_, x) => spreadsheetLength(source.getColumn(column + x + 1).width, 110, 7, 640)),
    rows: Array.from({ length: rows }, (_, y) => spreadsheetLength(source.getRow(row + y + 1).height, 30, 1.34, 640))
  }
  return { sheet, row, column, endRow: row + rows, endColumn: column + columns, cells, formatFallbacks, layout }
}

export function buildSpreadsheetLayout(source: SpreadsheetPageSource): SheetLayout {
  return {
    columns: Array.from({ length: Math.max(1, source.columnCount) }, (_, index) => spreadsheetLength(source.getColumn(index + 1).width, 110, 7, 640)),
    rows: Array.from({ length: Math.max(1, source.rowCount) }, (_, index) => spreadsheetLength(source.getRow(index + 1).height, 30, 1.34, 640)),
  }
}

export interface SpreadsheetAxis { offsets: Float64Array; total: number }

/** Prefix offsets let a 12,000-row scrollbar land directly on the real row. */
export function buildSpreadsheetAxis(lengths: number[]): SpreadsheetAxis {
  const offsets = new Float64Array(lengths.length + 1)
  for (let index = 0; index < lengths.length; index++) offsets[index + 1] = offsets[index] + lengths[index]
  return { offsets, total: offsets[lengths.length] || 0 }
}

export function spreadsheetAxisIndex(axis: SpreadsheetAxis, position: number): number {
  const count = axis.offsets.length - 1
  if (!count) return 0
  let low = 0, high = count
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (axis.offsets[middle] <= position) low = middle
    else high = middle - 1
  }
  return Math.min(count - 1, Math.max(0, low))
}

export function spreadsheetRequestValid(index: number, row: number, column: number, source: Pick<SpreadsheetPageSource, 'rowCount' | 'columnCount'>, endRow?: number, endColumn?: number): boolean {
  const bounded = endRow !== undefined || endColumn !== undefined
  const lastRow = endRow ?? row + SHEET_PAGE_ROWS, lastColumn = endColumn ?? column + SHEET_PAGE_COLUMNS
  return [index, row, column, lastRow, lastColumn].every(Number.isSafeInteger) && index >= 0 && row >= 0 && column >= 0 &&
    lastRow > row && lastColumn > column &&
    (bounded || row % SHEET_PAGE_ROWS === 0 && column % SHEET_PAGE_COLUMNS === 0) &&
    row < Math.max(source.rowCount, 1) && column < Math.max(source.columnCount, 1) &&
    lastRow <= Math.max(source.rowCount, 1) && lastColumn <= Math.max(source.columnCount, 1) &&
    (lastRow - row) * (lastColumn - column) <= SHEET_RANGE_CELL_LIMIT &&
    source.rowCount <= DOCUMENT_LIMITS.rows && source.columnCount <= DOCUMENT_LIMITS.columns
}
