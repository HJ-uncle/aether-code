import type { SessionSubagentGroup } from './subagents'

/** The list describes the assigned work, not a repeating tool or model name.
 * A new continuation announcement must not borrow the previous round's task. */
export function sessionSubagentTaskSummary(group: SessionSubagentGroup): string {
  const latest = group.latest
  const announcing = !latest.subagent && (latest.state === 'running' || latest.state === 'waiting')
  const active = group.tools.find(tool => !tool.subagentRef && tool.subagent && ['queued', 'running', 'cancelling'].includes(tool.subagent.status))
  const tool = announcing ? latest : active ?? latest
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(tool.args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch { /* Legacy announcements may not carry structured task text. */ }
  const task = tool.subagent?.task || (typeof args.task === 'string' ? args.task : '') ||
    tool.subagent?.description || (typeof args.description === 'string' ? args.description : '')
  return task.replace(/\s+/g, ' ').trim()
}

/** Search only the loaded directory; preserve its durable creation order and
 * filter before the 64-row display window so off-page matches remain visible. */
export function searchSessionSubagentGroups(groups: readonly SessionSubagentGroup[], query: string): SessionSubagentGroup[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? groups.filter(group => {
    const text = `${group.label}\n${sessionSubagentTaskSummary(group)}`.toLocaleLowerCase()
    return words.every(word => text.includes(word))
  }) : [...groups]
}
