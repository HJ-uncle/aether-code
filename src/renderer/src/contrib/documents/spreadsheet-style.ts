import type { SheetBorder, SheetCell } from './spreadsheet-preview-contract'

export interface SpreadsheetColor { argb?: string; theme?: number; indexed?: number; tint?: number }
export interface SpreadsheetCellStyle {
  font?: { bold?: boolean; italic?: boolean; underline?: boolean | string; strike?: boolean; color?: SpreadsheetColor }
  fill?: { type?: string; pattern?: string; fgColor?: SpreadsheetColor }
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean }
  border?: Partial<Record<'top' | 'right' | 'bottom' | 'left' | 'diagonal', { style?: string; color?: SpreadsheetColor }>>
}

const indexed = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'
]

function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))) }

/** Resolve Excel theme colors with their light/dark variants before applying tint. */
export function spreadsheetColor(color: SpreadsheetColor | undefined, themeColors: string[] = []): string | undefined {
  if (!color) return undefined
  let hex: string | undefined
  if (color.argb && /^[0-9a-f]{8}$/i.test(color.argb)) hex = color.argb.slice(2)
  else if (color.theme !== undefined && Number.isInteger(color.theme) && themeColors[color.theme]) hex = themeColors[color.theme]
  else if (color.indexed !== undefined && Number.isInteger(color.indexed)) hex = indexed[color.indexed]
  if (!hex) return undefined
  const rgb = [0, 2, 4].map(offset => Number.parseInt(hex!.slice(offset, offset + 2), 16))
  const tint = typeof color.tint === 'number' && Number.isFinite(color.tint) ? Math.max(-1, Math.min(1, color.tint)) : 0
  const adjusted = rgb.map(channel => tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint)
  return '#' + adjusted.map(clampByte).map(channel => channel.toString(16).padStart(2, '0')).join('')
}

const borderWidths: Record<string, number> = { hair: 1, thin: 1, medium: 2, thick: 3, dotted: 1, dashed: 1, double: 3 }

export function spreadsheetBorder(border: { style?: string; color?: SpreadsheetColor } | undefined, themeColors: string[]): SheetBorder | undefined {
  const width = border?.style ? borderWidths[border.style] : undefined
  if (!width) return undefined
  return { width, color: spreadsheetColor(border?.color, themeColors), style: border?.style === 'dotted' ? 'dotted' : border?.style === 'dashed' ? 'dashed' : border?.style === 'double' ? 'double' : 'solid' }
}

export function spreadsheetCellStyle(style: SpreadsheetCellStyle, themeColors: string[]): Partial<SheetCell> {
  const horizontal = style.alignment?.horizontal
  const vertical = style.alignment?.vertical
  const borders: SheetCell['borders'] = {}
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const border = spreadsheetBorder(style.border?.[side], themeColors)
    if (border) borders[side] = border
  }
  const fill = style.fill?.type === 'pattern' && style.fill.pattern === 'solid' ? spreadsheetColor(style.fill.fgColor, themeColors) : undefined
  return {
    bold: style.font?.bold === true,
    italic: style.font?.italic === true,
    underline: style.font?.underline === true || typeof style.font?.underline === 'string',
    strike: style.font?.strike === true,
    wrap: style.alignment?.wrapText === true,
    color: spreadsheetColor(style.font?.color, themeColors),
    background: fill,
    ...(horizontal === 'left' || horizontal === 'center' || horizontal === 'right' || horizontal === 'justify' ? { align: horizontal } : {}),
    ...(vertical === 'top' || vertical === 'middle' || vertical === 'bottom' ? { verticalAlign: vertical } : {}),
    ...(Object.keys(borders).length ? { borders } : {})
  }
}

/** ExcelJS stores theme XML as markup, so only pass bounded color attributes through. */
export function spreadsheetThemeColors(themeXml: unknown): string[] {
  if (typeof themeXml !== 'string' || themeXml.length > 1_000_000) return []
  const colors: string[] = []
  const scheme = /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/i.exec(themeXml)?.[1]
  if (!scheme) return colors
  const elements = /<(?:\w+:)?(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/gi
  const found = new Map<string, string>()
  for (const match of scheme.matchAll(elements)) {
    const color = /<(?:\w+:)?(?:srgbClr val="([0-9a-f]{6})"|sysClr[^>]*lastClr="([0-9a-f]{6})")/i.exec(match[2])
    if (color) found.set(match[1].toLowerCase(), (color[1] || color[2]).toLowerCase())
  }
  // ExcelJS's theme indexes are dk1, lt1, dk2, lt2, accents, links. The two
  // light/dark pairs are swapped relative to DrawingML's document order.
  for (const name of ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const color = found.get(name)
    if (color) colors.push(color)
  }
  return colors
}

export function spreadsheetLength(value: unknown, fallback: number, multiplier: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.round(value * multiplier)) : fallback
}
