import { replayMessages, type EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { taskPlanTranscriptRows } from '@renderer/core/engine/task-plan'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { errorText } from '@renderer/core/engine/subagent-state'
import { workTranscriptItems } from './work-subagent-transcript-presentation'
import { workMessageTimeline } from './work-message-timeline'

/** Owned child archives legitimately contain sidechain rows. The archive loader
 * verifies ownership before this display-only adapter is called. Output-only
 * slots retain partial-page evidence without claiming a missing invocation. */
export function workSubagentMessages(rows: readonly EngineHistoryRow[]): ChatMessage[] {
  // Child invocation IDs are distinct from the parent's root/turn IDs. Adapt
  // only this owned archive view; main replay and the durable rows stay intact.
  const source = taskPlanTranscriptRows(rows.map(row => typeof row.metadata?.subagentRunId === 'string' && row.metadata.subagentRunId
    ? { ...row, metadata: { ...row.metadata, runId: row.metadata.subagentRunId } } : row)).filter(row => row.role !== 'system')
  const normalized: EngineHistoryRow[] = []
  const outputOnly = new Set<string>()
  const originalCalls = new Map<string, string>()
  for (const item of workTranscriptItems(source, source)) {
    const { row, result } = item
    if (row.role === 'tool') {
      const id = `archive-output:${row.id}`
      outputOnly.add(id)
      // This empty view slot is never persisted or sent to the model. Its label
      // and empty input explicitly distinguish a receipt from an invocation.
      normalized.push({ id: row.id, role: 'assistant', createdAt: row.createdAt, conversationId: row.conversationId,
        metadata: { runId: row.metadata?.runId, rootRunId: row.metadata?.rootRunId, turnId: row.metadata?.turnId },
        toolCall: { id, name: item.toolName || 'unknown' } }, { ...row, isSidechain: false, toolCallId: id })
    } else if (row.toolCall) {
      // Archive IDs may be repeated by legacy providers; never let a later
      // result overwrite another invocation because the provider ID collided.
      const id = `archive-call:${row.id}`
      if (row.toolCall.id) originalCalls.set(id, row.toolCall.id)
      normalized.push({ ...row, isSidechain: false, toolCall: { ...row.toolCall, id, name: item.toolName || 'unknown' } })
      if (result) normalized.push({ ...result, isSidechain: false, toolCallId: id })
    } else normalized.push({ ...row, isSidechain: false })
  }
  const messages = replayMessages(normalized)
  let cursor = -1
  for (const row of normalized) {
    if (row.role === 'user') { cursor++; continue }
    if (row.role !== 'assistant') continue
    const current = messages[cursor]
    const runId = row.metadata?.runId ?? row.metadata?.rootRunId
    const turnId = row.conversationId ?? row.metadata?.turnId
    if (!current || current.role !== 'assistant' || current.runId !== runId || current.conversationId !== turnId) cursor++
    const message = messages[cursor]
    if (!message) continue
    const failure = errorText(row.error) || errorText(row.metadata?.error)
    if (failure) { message.error = failure; message.status = 'error' }
    else if (row.metadata?.status === 'interrupted') message.status = 'interrupted'
    else if (row.metadata?.status === 'cancelled') message.status = 'aborted'
  }
  for (const message of messages) {
    message.tools = message.tools.map(tool => outputOnly.has(tool.id)
      ? { ...tool, args: '', hidden: false, metadata: { ...tool.metadata, archiveOutputOnly: true } }
      : { ...tool, hidden: false, metadata: { ...tool.metadata, archiveToolCallId: originalCalls.get(tool.id) } })
  }
  return messages
}

/** Child completion comes from its own archive chronology, never a parent run
 * manifest. A trailing tool call or an active invocation is still process. */
export function workSubagentFinalAnswer(message: ChatMessage, messages: readonly ChatMessage[], runningRunId?: string): { text: string } | false {
  if (message.role !== 'assistant' || message.runId === runningRunId && runningRunId !== undefined) return false
  const later = messages.slice(messages.indexOf(message) + 1)
  if (later.some(next => next.role === 'assistant' && next.runId === message.runId && next.conversationId === message.conversationId)) return false
  const segments = workMessageTimeline(message)
  const last = segments.at(-1)
  return last?.kind === 'content' && last.text.trim() ? { text: last.text } : false
}
