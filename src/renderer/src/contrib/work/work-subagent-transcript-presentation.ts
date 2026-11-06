import { extractText, type EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { errorText } from '@renderer/core/engine/subagent-state'

export interface WorkTranscriptItem {
  row: EngineHistoryRow
  result?: EngineHistoryRow
  toolName?: string
  showIdentity: boolean
}

const callId = (row: EngineHistoryRow): string | undefined => row.role === 'assistant' && row.toolCall?.id?.trim() ? row.toolCall.id : undefined
const resultId = (row: EngineHistoryRow): string | undefined => row.role === 'tool' && typeof row.toolCallId === 'string' && row.toolCallId.trim() ? row.toolCallId : undefined
const turnId = (row: EngineHistoryRow): string | undefined => row.conversationId ?? row.metadata?.turnId
const runId = (row: EngineHistoryRow): string | undefined => row.metadata?.subagentRunId || (row.metadata?.runId ?? row.metadata?.rootRunId)

export function workTranscriptHasMessage(row: EngineHistoryRow): boolean {
  return Boolean(extractText(row.content) || extractText(row.reasoningContent) || errorText(row.error) ||
    errorText(row.metadata?.error) || row.metadata?.attachments?.length)
}

/** A partial archive is evidence, not a complete execution log. Only combine
 * adjacent, unambiguous receipts; an intervening message must stay in order. */
export function workTranscriptItems(rows: readonly EngineHistoryRow[], residentRows: readonly EngineHistoryRow[] = rows): WorkTranscriptItem[] {
  const calls = new Map<string, EngineHistoryRow[]>()
  const results = new Map<string, number>()
  for (const row of residentRows) {
    const invocation = callId(row), outcome = resultId(row)
    if (invocation) calls.set(invocation, [...(calls.get(invocation) ?? []), row])
    if (outcome) results.set(outcome, (results.get(outcome) ?? 0) + 1)
  }
  const items: WorkTranscriptItem[] = []
  let previousAssistant: EngineHistoryRow | undefined
  let previousModel: string | undefined
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], next = rows[index + 1], id = callId(row)
    const matched = id && next && resultId(next) === id && calls.get(id)?.length === 1 && results.get(id) === 1 &&
      (!turnId(row) || !turnId(next) || turnId(row) === turnId(next)) &&
      (!runId(row) || !runId(next) || runId(row) === runId(next))
    const result = matched ? next : undefined
    const knownCalls = typeof row.toolCallId === 'string' ? calls.get(row.toolCallId) : undefined
    const toolName = row.toolCall?.name ?? row.metadata?.toolName ?? result?.metadata?.toolName ??
      (knownCalls?.length === 1 ? knownCalls[0].toolCall?.name : undefined)
    let showIdentity = row.role === 'user'
    if (row.role === 'user') { previousAssistant = undefined; previousModel = undefined }
    else if (row.role === 'assistant' && workTranscriptHasMessage(row)) {
      showIdentity = !previousAssistant || turnId(previousAssistant) !== turnId(row) || runId(previousAssistant) !== runId(row) ||
        Boolean(row.modelId && row.modelId !== previousModel)
      previousAssistant = row
      previousModel = row.modelId ?? previousModel
    }
    items.push({ row, ...(result ? { result } : {}), ...(toolName ? { toolName } : {}), showIdentity })
    if (result) index++
  }
  return items
}
