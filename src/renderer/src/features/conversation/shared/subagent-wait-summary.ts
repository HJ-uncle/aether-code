/** Targets describe the wait, not its outcome. Keep the same count while the
 * receipt streams, times out or settles; opaque run IDs are not task names. */
export function subagentWaitSummary(argsJson: string): string {
  try {
    const raw: unknown = JSON.parse(argsJson)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
    const args = raw as Record<string, unknown>
    if (Object.hasOwn(args, 'runIds')) {
      if (Object.hasOwn(args, 'runId') || !Array.isArray(args.runIds)
        || args.runIds.length < 1 || args.runIds.length > 8
        || !args.runIds.every(id => typeof id === 'string' && id.trim())) return ''
      const ids = args.runIds.map(id => (id as string).trim())
      return new Set(ids).size === ids.length ? `${ids.length} 个任务` : ''
    }
    return typeof args.runId === 'string' && args.runId.trim() ? '1 个任务' : ''
  } catch { return '' }
}
