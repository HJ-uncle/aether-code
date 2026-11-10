import type { ToolActivity } from '@renderer/core/engine/useChat'
import { workActivityState } from './work-inline-activity-state'
import { workToolTarget } from './work-message-timeline'
import { workToolKind } from './work-tool-presentation'

/** Only adjacent, settled inspection receipts share a disclosure. Failures,
 * live work and file mutations remain individually discoverable. */
export function workActivityGroups(tools: readonly ToolActivity[]): ToolActivity[][] {
  const groups: ToolActivity[][] = []
  let previousKey: string | null = null
  for (const tool of tools) {
    const kind = workToolKind(tool)
    const target = workToolTarget(tool, undefined, true)
    const key = (kind === 'compact' || kind === 'visual') && workActivityState(tool) === 'done' && !tool.error &&
      !tool.metadata?.archiveOutputOnly && target ? JSON.stringify([tool.name, target]) : null
    if (key && key === previousKey) groups[groups.length - 1].push(tool)
    else groups.push([tool])
    previousKey = key
  }
  return groups
}
