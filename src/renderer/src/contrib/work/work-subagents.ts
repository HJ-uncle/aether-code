import type { SubagentRun } from '@shared/subagent'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { mergeSubagentRun, runToolState } from '@renderer/core/engine/subagent-state'

/** Keep the original invocation metadata while reconciling independently running children. */
export function workSubagentTools(sessionId: string, tools: ToolActivity[], runs: SubagentRun[]): ToolActivity[] {
  const result = new Map<string, ToolActivity>()
  for (const tool of tools) {
    if (tool.name !== 'subagent' && !tool.subagent) continue
    if (tool.subagent && tool.subagent.parentSessionId !== sessionId) continue
    result.set(tool.subagent?.parentToolCallId || tool.id, tool)
  }
  for (const incoming of runs) {
    if (incoming.parentSessionId !== sessionId) continue
    const previous = result.get(incoming.parentToolCallId)
    const run = mergeSubagentRun(previous?.subagent, incoming)
    let args = previous?.args || JSON.stringify({ task: run.task, description: run.description, role: run.continuation?.role })
    // A legacy parent invocation can omit the role even though the authoritative
    // child run has it. Add only the missing display metadata, preserving the
    // original task and mention payload used by the engine.
    if (run.continuation?.role && args) {
      try {
        const parsed: unknown = JSON.parse(args)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('role' in parsed))
          args = JSON.stringify({ ...(parsed as Record<string, unknown>), role: run.continuation.role })
      } catch { /* Keep non-JSON legacy args unchanged. */ }
    }
    result.set(run.parentToolCallId, {
      ...previous,
      id: run.parentToolCallId,
      name: 'subagent',
      args,
      result: run.resultSummary || run.partialOutput || previous?.result || '',
      state: runToolState(run),
      error: run.error?.message,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      subagent: run
    })
  }
  return [...result.values()]
}

export function buildWorkSubagentContinuation(run: SubagentRun, prompt: string): string {
  return `继续现有子代理，复用它的历史上下文。请调用 subagent 工具，参数如下；不要新建子代理，也不要在父任务代替执行。\n${JSON.stringify({ resumeRunId: run.runId, task: prompt.trim() })}`
}

export function workSubagentRole(args: string): string {
  try {
    const value: unknown = JSON.parse(args)
    if (!value || typeof value !== 'object' || !('role' in value)) return '子代理'
    const role = value.role
    if (role === 'implementer') return '开发实现'
    if (role === 'spec-reviewer') return '需求审查'
    if (role === 'code-quality-reviewer') return '代码审查'
    return typeof role === 'string' && role.trim() ? role : '子代理'
  } catch { return '子代理' }
}
