import type { SubagentRun, SubagentToolCall } from '@shared/subagent'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'

/** Transport counters cover saved records, including silent plan controls.
 * A bounded summary cannot establish how many unseen records are visible work. */
export function subagentToolPresentation(run?: SubagentRun, fallback: SubagentToolCall[] = []) {
  const records = [...(run?.toolCalls ?? fallback)]
  const latest = run?.schemaVersion === 2 ? run.latestActivity : undefined
  if (latest && !records.some(call => call.id === latest.id)) {
    records.push(latest)
  }
  const residentActive = records.filter(call => call.status === 'running').length
  const complete = run?.schemaVersion !== 2 || (
    run.coverage.completeness === 'complete' && !run.coverage.hasMore &&
    run.coverage.includedToolCount === run.toolCount && records.length === run.toolCount &&
    run.coverage.includedActiveToolCount === run.activeToolCount && residentActive === run.activeToolCount
  )
  const calls = records.filter(isVisibleToolActivity)
  const historyCount = run?.schemaVersion === 2 ? run.toolCount : records.length
  const activeCalls = calls.filter(call => call.status === 'running').length
  const unseenActiveCount = run?.schemaVersion === 2 ? Math.max(0, run.activeToolCount - residentActive) : 0
  const countLabel = complete ? `${calls.length.toLocaleString()} 次调用`
    : `${historyCount.toLocaleString()} 条历史记录 · 当前显示 ${calls.length.toLocaleString()} 次调用`
  return { calls, complete, historyCount, activeCalls, unseenActiveCount, countLabel }
}

/** A v1 snapshot is locally promoted to a bounded v2 view; only negotiation
 * establishes whether the server supports paged records and details. */
export function canPageSubagentHistory(run: SubagentRun | undefined, protocol: 1 | 2 | null): boolean {
  return run?.schemaVersion === 2 && protocol === 2
}
