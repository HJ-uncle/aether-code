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
    const cached = saved instanceof Date ? saved.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0) : saved
    const text = format(numberFormat || (saved instanceof Date ? 'yyyy-mm-dd' : 'General'), cached, { date1904 })
    return text.length > 2000 ? fallback() : { text, formatFallback: false }
  } catch { return fallback() }
}
