export interface SheetSummary { name: string; rows: number; columns: number }
export interface SheetBorder { color?: string; width?: number; style?: 'solid' | 'dotted' | 'dashed' | 'double' }
export interface SheetCell {
  text: string
  bold?: boolean
  italic?: boolean
  align?: 'left' | 'center' | 'right' | 'justify'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  color?: string
  background?: string
  underline?: boolean
  strike?: boolean
  borders?: Partial<Record<'top' | 'right' | 'bottom' | 'left', SheetBorder>>
  colSpan?: number
  rowSpan?: number
  covered?: boolean
}
export interface SheetLayout { columns: number[]; rows: number[] }
/** A rectangular, half-open cell range: row/column are inclusive, end* exclusive. */
export interface SheetPage { sheet: number; row: number; column: number; endRow: number; endColumn: number; cells: SheetCell[][]; formatFallbacks: number; layout: SheetLayout }
export type SpreadsheetRequest = { kind: 'load'; data: ArrayBuffer } | { kind: 'page'; sheet: number; row: number; column: number; endRow?: number; endColumn?: number; requestId: number }
export type SpreadsheetResponse = { kind: 'loaded'; sheets: SheetSummary[]; layouts: SheetLayout[] } | { kind: 'page'; requestId: number; page: SheetPage } | { kind: 'error'; message: string; requestId?: number }
export const SHEET_PAGE_ROWS = 100
export const SHEET_PAGE_COLUMNS = 20
export const SHEET_RANGE_CELL_LIMIT = SHEET_PAGE_ROWS * SHEET_PAGE_COLUMNS * 12
