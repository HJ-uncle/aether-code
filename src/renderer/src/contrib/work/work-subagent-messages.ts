import { extractText, replayMessages, type EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { taskPlanTranscriptRows } from '@renderer/core/engine/task-plan'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { errorText } from '@renderer/core/engine/subagent-state'
import { workTranscriptItems } from './work-subagent-transcript-presentation'
import { workMessageTimeline } from './work-message-timeline'

/** Owned child archives legitimately contain sidechain rows. The archive loader
 * verifies ownership before this display-only adapter is called. Output-only
 * slots retain partial-page evidence without claiming a missing invocation. */
export function workSubagentMessages(rows: readonly EngineHistoryRow[], visibleCount?: number): ChatMessage[] {
  // Child invocation IDs are distinct from the parent's root/turn IDs. Adapt
  // only this owned archive view; main replay and the durable rows stay intact.
  const source = taskPlanTranscriptRows(rows.map(row => {
    const owned = typeof row.metadata?.subagentRunId === 'string' && row.metadata.subagentRunId
      ? { ...row, metadata: { ...row.metadata, runId: row.metadata.subagentRunId } } : row
    // Preserve the exact message; envelope grouping belongs to the user-message
    // component, which also offers the original text for explicit inspection.
    if (row.role === 'user') return owned
    const failure = errorText(row.error) || errorText(row.metadata?.error)
    // ReAct writes this reserved outcome record even when cancellation produced
    // no prose. Its status fallback is a notice, not a model answer. Ordinary
    // messages (including a real answer saying "cancelled") are untouched.
    if (row.role === 'assistant' && !failure && owned.metadata?.runId &&
      row.id === `subagent-outcome:${owned.metadata.runId}` && row.metadata?.status === 'cancelled' &&
      row.content === 'cancelled') {
      return { ...owned, content: '', metadata: { ...owned.metadata, error: 'cancelled' } }
    }
    // Failed invocations without partial output archive the error as content
    // too. Remove only that exact fallback before replay merges neighbouring
    // rows, so earlier prose and ordinary messages quoting errors stay intact.
    return row.role === 'assistant' && failure?.trim() && extractText(row.content).trim() === failure.trim()
      ? { ...owned, content: '' } : owned
  })).filter(row => row.role !== 'system')
  const normalized: EngineHistoryRow[] = []
  const outputOnly = new Set<string>()
  const originalCalls = new Map<string, string>()
  for (const item of workTranscriptItems(visibleCount === undefined ? source : source.slice(-visibleCount), source)) {
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
    if (failure) message.error = failure
    if (row.metadata?.status === 'interrupted') message.status = 'interrupted'
    else if (row.metadata?.status === 'cancelled') message.status = 'aborted'
    else if (failure) message.status = 'error'
  }
  for (const message of messages) {
    message.tools = message.tools.map(tool => outputOnly.has(tool.id)
      ? { ...tool, args: '', hidden: false, metadata: { ...tool.metadata, archiveOutputOnly: true } }
      : { ...tool, hidden: false, metadata: { ...tool.metadata, archiveToolCallId: originalCalls.get(tool.id) } })
  }
  return messages
}

/** Keep raw cancellation diagnostics for copying while the notice is readable. */
export function workSubagentErrorText(message: ChatMessage): string | undefined {
  return message.status === 'aborted' && message.error === 'cancelled' ? '任务已取消。' : message.error
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
