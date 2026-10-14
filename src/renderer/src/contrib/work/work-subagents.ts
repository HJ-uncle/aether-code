import type { SubagentRun } from '@shared/subagent'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { mergeSubagentRun, runToolState } from '@renderer/core/engine/subagent-state'

export interface WorkSubagentGroup {
  key: string
  childSessionId: string
  label: string
  modelId: string
  active: boolean
  latest: ToolActivity
  tools: ToolActivity[]
}

function workSubagentArgs(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

/** Keep the original invocation metadata while reconciling independently running children. */
export function workSubagentTools(sessionId: string, tools: ToolActivity[], runs: SubagentRun[]): ToolActivity[] {
  const result = new Map<string, ToolActivity>()
  for (const tool of tools) {
    if (tool.subagentDeletion) continue
    if (tool.name !== 'subagent' && !tool.subagent) continue
    if (tool.subagent && tool.subagent.parentSessionId !== sessionId) continue
    result.set(tool.subagent?.parentToolCallId || tool.subagentRef?.identity.parentToolCallId || tool.id, tool)
  }
  for (const incoming of runs) {
    if (incoming.parentSessionId !== sessionId) continue
    if (tools.some(tool => tool.subagentDeletion?.runId === incoming.runId &&
      tool.subagentDeletion.parentSessionId === incoming.parentSessionId &&
      tool.subagentDeletion.rootSessionId === incoming.rootSessionId &&
      tool.subagentDeletion.childSessionId === incoming.childSessionId &&
      tool.subagentDeletion.parentToolCallId === incoming.parentToolCallId)) continue
    const previous = result.get(incoming.parentToolCallId)
    if (previous?.subagentRef) continue
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

/**
 * A child session is the durable identity of an @Agent mention.  Every resume
 * creates a new run, so the list must group runs by childSessionId instead of
 * presenting each round as a new agent.
 */
export function workSubagentGroups(sessionId: string, tools: ToolActivity[], runs: SubagentRun[]): WorkSubagentGroup[] {
  const grouped = new Map<string, ToolActivity[]>()
  const reconciled = workSubagentTools(sessionId, tools, runs)
  const knownRuns = new Map(reconciled.flatMap(tool => tool.subagent ? [[tool.subagent.runId, tool.subagent] as const] : []))
  for (const tool of reconciled) {
    const args = workSubagentArgs(tool.args)
    const pendingResume = typeof args.resumeRunId === 'string' ? knownRuns.get(args.resumeRunId) : undefined
    const childSessionId = tool.subagent?.childSessionId || tool.subagentRef?.identity.childSessionId || pendingResume?.childSessionId
    const key = childSessionId ? `child:${childSessionId}` : `legacy:${tool.id}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(tool)
    else grouped.set(key, [tool])
  }
  return [...grouped.entries()]
    .map(([key, entries]) => {
      const ordered = [...entries].sort((a, b) =>
        (b.subagentRef?.identity.createdAt ?? b.subagent?.createdAt ?? b.startedAt ?? (b.state === 'running' ? Number.MAX_SAFE_INTEGER : 0)) -
        (a.subagentRef?.identity.createdAt ?? a.subagent?.createdAt ?? a.startedAt ?? (a.state === 'running' ? Number.MAX_SAFE_INTEGER : 0)) ||
        (b.subagentRef?.identity.createdAt ?? b.subagent?.updatedAt ?? b.finishedAt ?? 0) - (a.subagentRef?.identity.createdAt ?? a.subagent?.updatedAt ?? a.finishedAt ?? 0))
      const latest = ordered[0]
      const run = ordered.find(tool => tool.subagent)?.subagent
      return {
        key,
        childSessionId: run?.childSessionId || latest.subagentRef?.identity.childSessionId || '',
        label: latest.subagentRef?.identity.agentName?.trim() || run?.agentName?.trim() || workSubagentName(latest),
        modelId: latest.subagentRef?.identity.modelId || run?.modelId || '',
        active: entries.some((tool) => !tool.subagentRef && (tool.subagent ? ['queued', 'running', 'cancelling'].includes(tool.subagent.status) : tool.state === 'running')),
        latest,
        tools: ordered
      }
    })
    .sort((a, b) => (b.latest.subagentRef?.identity.createdAt ?? b.latest.subagent?.updatedAt ?? 0) - (a.latest.subagentRef?.identity.createdAt ?? a.latest.subagent?.updatedAt ?? 0))
}

/** A preparation announcement receives its durable child identity asynchronously. */
export function resolveWorkSubagentGroup(groups: WorkSubagentGroup[], selectedKey: string | null): WorkSubagentGroup | undefined {
  if (!selectedKey) return undefined
  const exact = groups.find(group => group.key === selectedKey)
  if (exact || !selectedKey.startsWith('legacy:')) return exact
  const parentToolCallId = selectedKey.slice('legacy:'.length)
  return groups.find(group => group.tools.some(tool => tool.id === parentToolCallId || tool.subagent?.parentToolCallId === parentToolCallId))
}

export function workSubagentName(tool: ToolActivity): string {
  const run = tool.subagent
  const agentName = run?.agentName?.trim() || tool.subagentRef?.identity.agentName?.trim() || ''
  if (agentName) return agentName
  const role = run?.continuation?.role ? workSubagentRole(JSON.stringify({ role: run.continuation.role })) : workSubagentRole(tool.args)
  const description = workSubagentArgs(tool.args).description
  return role === '子代理' ? run?.description || (typeof description === 'string' ? description.trim() : '') || '协作代理' : role
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
