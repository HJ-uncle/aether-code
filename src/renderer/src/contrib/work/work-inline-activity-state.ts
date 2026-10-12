import type { ToolActivity } from '@renderer/core/engine/useChat'
import { commandToolState } from '@renderer/core/engine/command-job-state'
import { runToolState, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { workToolTarget } from './work-message-timeline'

export const WORK_INLINE_ACTIVITY_PAGE_SIZE = 20

/** A background dispatch receipt can finish before its durable job does. */
export function workActivityState(tool: ToolActivity): ToolActivity['state'] {
  return tool.commandJob ? commandToolState(tool.commandJob)
    : tool.subagent ? runToolState(tool.subagent) : tool.state
}

export function workActivitySummary(tools: readonly ToolActivity[], workspacePath?: string | null): {
  tool: ToolActivity; state: ToolActivity['state']; label: string; target: string
} | null {
  if (!tools.length) return null
  const current = tools.findLast(tool => ['running', 'waiting'].includes(workActivityState(tool)))
    ?? tools.findLast(tool => workActivityState(tool) !== 'done')
    ?? tools.at(-1)!
  const state = workActivityState(current)
  const done = tools.filter(tool => workActivityState(tool) === 'done').length
  const action = toolDisplayName(current.name)
  const label = done === tools.length
    ? tools.length === 1 ? `已完成 · ${action}` : `已完成 ${done} 项操作 · ${action}`
    : `${toolStatusLabel(current)} · ${action}${tools.length > 1 ? ` · ${done}/${tools.length} 已完成` : ''}`
  return { tool: current, state, label, target: workToolTarget(current, workspacePath) }
}

