import type { SubagentRun } from '@shared/subagent'
import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import { isSubagentActive } from '@renderer/core/engine/subagent-state'
import { subagentToolPresentation } from '../chat/subagent-tool-presentation'

/** The run summary is a bounded live preview, not archive evidence. Its
 * identity must match the independently verified child before it is shown. */
export function workSubagentLiveMessage(run: SubagentRun | undefined, childSessionId: string, messages: readonly ChatMessage[]): ChatMessage | undefined {
  if (!run || run.childSessionId !== childSessionId || !isSubagentActive(run.status)) return undefined
  const owned = messages.filter(message => message.runId === run.runId)
  const preview = run.partialOutput?.slice(-4000) ?? ''
  const content = preview && !owned.some(message => message.content.endsWith(preview)) ? preview : ''
  const tools: ToolActivity[] = subagentToolPresentation(run).calls.filter(call => call.status === 'running' &&
    !owned.some(message => message.tools.some(tool => tool.metadata?.archiveToolCallId === call.id))).slice(-8).map(call => ({
      id: `live:${run.runId}:${call.id}`, name: call.name,
      args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}), result: call.output ?? '',
      state: 'running', startedAt: call.startedAt, metadata: { livePreview: true }
    }))
  if (!content && !tools.length) return undefined
  return { id: `live:${run.runId}`, role: 'assistant', runId: run.runId, content, thinking: '', tools,
    items: [...tools.map(tool => ({ kind: 'tool' as const, id: tool.id })), ...(content ? [{ kind: 'content' as const, text: content }] : [])],
    status: 'streaming', createdAt: run.updatedAt }
}
