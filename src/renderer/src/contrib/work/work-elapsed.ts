/** Keep long-running clocks readable without losing the seconds they still update. */
export function formatWorkElapsed(durationMs: number, compact = false): string {
  const totalSeconds = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs / 1000)) : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds % 3600 / 60)
  const seconds = totalSeconds % 60
  if (compact) {
    return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', seconds ? `${seconds} 秒` : '']
      .filter(Boolean).join(' ') || '0 秒'
  }
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}
