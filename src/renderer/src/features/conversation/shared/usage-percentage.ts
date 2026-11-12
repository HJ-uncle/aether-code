import type { UsageDetailRow } from './usage'

export interface UsagePercentage {
  value: string
  basisLabel: string
  basisTokens: number | null
  reason?: string
}

/** Percentages describe the row's declared billing scope. Older child rows
 * without denominator metadata cannot safely fall back to the overall total. */
export function usagePercentage(
  row: UsageDetailRow,
  total: number,
  summary: readonly UsageDetailRow[]
): UsagePercentage {
  const defaultLabel = row.child
    ? row.group === 'output' ? '累计输出' : '累计输入'
    : summary.some(item => item.unknown) ? '已知总用量' : '总用量'
  const basisLabel = row.shareOf?.label || defaultLabel
  const denominator = row.shareOf === undefined ? row.child ? null : total : row.shareOf?.tokens ?? null
  const basisTokens = denominator !== null && Number.isFinite(denominator) && denominator >= 0 ? denominator : null
  const base = { basisLabel, basisTokens }

  if (row.unknown) return { ...base, value: '未知', reason: '此项用量尚未完整报告，无法计算占比。' }
  if (!Number.isFinite(row.tokens) || row.tokens < 0) {
    return { ...base, value: '—', reason: '此项用量不是有效的非负数，无法计算占比。' }
  }
  if (denominator === null) {
    return { ...base, value: '—', reason: `缺少可核对的${basisLabel}，无法计算占比。` }
  }
  if (!Number.isFinite(denominator) || denominator < 0) {
    return { ...base, value: '—', reason: `${basisLabel}不是有效的非负数，无法计算占比。` }
  }
  if (denominator === 0) return { ...base, value: '—', reason: `${basisLabel}为 0，无法计算占比。` }
  if (row.tokens > denominator) {
    return { ...base, value: '—', reason: `此项用量超过${basisLabel}，无法确认占比。` }
  }
  const percent = row.tokens / denominator * 100
  return { ...base, value: row.tokens > 0 && percent < 0.1 ? '<0.1%' : `${Number(percent.toFixed(1))}%` }
}
