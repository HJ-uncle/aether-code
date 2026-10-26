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
export interface SheetPage { sheet: number; row: number; column: number; cells: SheetCell[][]; formatFallbacks: number; layout: SheetLayout }
export type SpreadsheetRequest = { kind: 'load'; data: ArrayBuffer } | { kind: 'page'; sheet: number; row: number; column: number }
export type SpreadsheetResponse = { kind: 'loaded'; sheets: SheetSummary[] } | { kind: 'page'; page: SheetPage } | { kind: 'error'; message: string }
export const SHEET_PAGE_ROWS = 100
export const SHEET_PAGE_COLUMNS = 20
