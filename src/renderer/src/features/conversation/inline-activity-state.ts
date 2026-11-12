import type { ToolActivity } from '@renderer/core/engine/useChat'
import { commandToolState } from '@renderer/core/engine/command-job-state'
import { runToolState, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { sessionToolTarget } from './message-timeline'
import { sessionToolFeedback } from './tool-feedback'

export const SESSION_INLINE_ACTIVITY_PAGE_SIZE = 20

/** A background dispatch receipt can finish before its durable job does. */
export function sessionActivityState(tool: ToolActivity): ToolActivity['state'] {
  return tool.commandJob ? commandToolState(tool.commandJob)
    : tool.subagent ? runToolState(tool.subagent) : tool.state
}

export function sessionActivitySummary(tools: readonly ToolActivity[], workspacePath?: string | null): {
  tool: ToolActivity; state: ToolActivity['state']; label: string; target: string
} | null {
  tools = tools.filter(isVisibleToolActivity)
  if (!tools.length) return null
  const current = tools.findLast(tool => ['running', 'waiting'].includes(sessionActivityState(tool)))
    ?? tools.findLast(tool => sessionActivityState(tool) !== 'done')
    ?? tools.at(-1)!
  const state = sessionActivityState(current)
  const done = tools.filter(tool => sessionActivityState(tool) === 'done').length
  const action = toolDisplayName(current.name)
  const label = done === tools.length
    ? tools.length === 1 ? `已完成 · ${action}` : `已完成 ${done} 项操作 · ${action}`
    : `${sessionToolFeedback(current, state)?.label ?? toolStatusLabel(current)} · ${action}${tools.length > 1 ? ` · ${done}/${tools.length} 已完成` : ''}`
  return { tool: current, state, label, target: sessionToolTarget(current, workspacePath) }
}

