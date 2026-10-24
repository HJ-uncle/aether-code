export interface SheetSummary { name: string; rows: number; columns: number }
export interface SheetCell { text: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right' }
export interface SheetPage { sheet: number; row: number; column: number; cells: SheetCell[][]; formatFallbacks: number }
export type SpreadsheetRequest = { kind: 'load'; data: ArrayBuffer } | { kind: 'page'; sheet: number; row: number; column: number }
export type SpreadsheetResponse = { kind: 'loaded'; sheets: SheetSummary[] } | { kind: 'page'; page: SheetPage } | { kind: 'error'; message: string }
export const SHEET_PAGE_ROWS = 100
export const SHEET_PAGE_COLUMNS = 20
