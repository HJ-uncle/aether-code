import { format } from 'ssf'

/** Format saved values only. SSF is a number formatter, never a formula engine. */
export function spreadsheetDisplayValue(value: unknown, rawText: string, numberFormat: string | undefined, date1904 = false): { text: string; formatFallback: boolean } {
  let saved = value
  const fallback = (): { text: string; formatFallback: boolean } => ({ text: rawText.slice(0, 2000), formatFallback: true })
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    saved = 'result' in value ? value.result : undefined
    if (saved === undefined || saved === null) return { text: '未保存计算结果', formatFallback: true }
  }
  if (saved === null || saved === undefined) return { text: '', formatFallback: false }
  if (numberFormat && numberFormat.length > 256) return fallback()
  if (!(typeof saved === 'number' || typeof saved === 'string' || typeof saved === 'boolean' || saved instanceof Date)) {
    return { text: rawText.slice(0, 2000), formatFallback: false }
  }
  if (saved instanceof Date && !Number.isFinite(saved.getTime())) return fallback()
  if (typeof saved === 'number' && !Number.isFinite(saved)) return fallback()
  if (typeof saved === 'string' && saved.length > 2000) return fallback()
  try {
    // ExcelJS has already converted date-formatted serials into absolute Date
    // values using the workbook's 1904 flag. Convert that UTC Date back to an
    // absolute serial so SSF does not reinterpret it in the renderer's local
    // timezone. Numeric values still use the workbook serial and therefore
    // retain the date1904 option.
    const isDate = saved instanceof Date
    const serial = saved instanceof Date ? saved.getTime() / 86400000 + 25569 : saved
    const text = format(
      numberFormat || (isDate ? 'yyyy-mm-dd' : 'General'),
      serial,
      isDate ? { date1904: false } : { date1904 },
    )
    return text.length > 2000 ? fallback() : { text, formatFallback: false }
  } catch { return fallback() }
}
