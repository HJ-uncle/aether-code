import type { ToolActivity } from '@renderer/core/engine/useChat'
import { sessionActivityState } from './inline-activity-state'
import { sessionToolTarget } from './message-timeline'
import { sessionToolKind } from './tool-presentation'

/** Only adjacent, settled inspection receipts share a disclosure. Failures,
 * live work and file mutations remain individually discoverable. */
export function sessionActivityGroups(tools: readonly ToolActivity[]): ToolActivity[][] {
  const groups: ToolActivity[][] = []
  let previousKey: string | null = null
  for (const tool of tools) {
    const kind = sessionToolKind(tool)
    const target = sessionToolTarget(tool, undefined, true)
    const key = (kind === 'compact' || kind === 'visual') && sessionActivityState(tool) === 'done' && !tool.error &&
      !tool.metadata?.archiveOutputOnly && target ? JSON.stringify([tool.name, target, tool.args]) : null
    if (key && key === previousKey) groups[groups.length - 1].push(tool)
    else groups.push([tool])
    previousKey = key
  }
  return groups
}
