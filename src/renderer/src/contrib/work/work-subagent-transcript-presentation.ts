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
const receiptName = (row: EngineHistoryRow): string | undefined => row.toolName ?? row.metadata?.toolName
const turnId = (row: EngineHistoryRow): string | undefined => row.conversationId ?? row.metadata?.turnId
const runId = (row: EngineHistoryRow): string | undefined => row.metadata?.subagentRunId || (row.metadata?.runId ?? row.metadata?.rootRunId)

export function workTranscriptHasMessage(row: EngineHistoryRow): boolean {
  return Boolean(extractText(row.content) || extractText(row.reasoningContent) || errorText(row.error) ||
    errorText(row.metadata?.error) || row.metadata?.attachments?.length)
}

/** Parallel calls are persisted before their receipts. Pair by invocation
 * identity within one uninterrupted child turn, never by row adjacency. */
export function workTranscriptItems(rows: readonly EngineHistoryRow[], residentRows: readonly EngineHistoryRow[] = rows): WorkTranscriptItem[] {
  const calls = new Map<string, EngineHistoryRow[]>()
  const results = new Map<string, EngineHistoryRow[]>()
  const keys = new Map<EngineHistoryRow, string>()
  const positions = new Map<EngineHistoryRow, number>()
  let segment = 0, previousRun: string | undefined, previousTurn: string | undefined
  for (const [index, row] of residentRows.entries()) {
    const run = runId(row), turn = turnId(row)
    if (row.role === 'user' || previousRun && run && previousRun !== run || previousTurn && turn && previousTurn !== turn) {
      segment++
      previousRun = undefined
      previousTurn = undefined
    }
    previousRun = run ?? previousRun
    previousTurn = turn ?? previousTurn
    const invocation = callId(row), outcome = resultId(row)
    const id = invocation ?? outcome
    if (!id) continue
    const key = JSON.stringify([segment, id])
    keys.set(row, key)
    positions.set(row, index)
    if (invocation) calls.set(key, [...(calls.get(key) ?? []), row])
    if (outcome) results.set(key, [...(results.get(key) ?? []), row])
  }
  const pairs = new Map<EngineHistoryRow, EngineHistoryRow>()
  const owners = new Map<EngineHistoryRow, EngineHistoryRow>()
  for (const [key, invocations] of calls) {
    const receipts = results.get(key)
    if (invocations.length !== 1 || receipts?.length !== 1) continue
    const call = invocations[0], result = receipts[0]
    if (positions.get(call)! >= positions.get(result)! ||
      turnId(call) && turnId(result) && turnId(call) !== turnId(result) ||
      runId(call) && runId(result) && runId(call) !== runId(result) ||
      call.toolCall?.name && receiptName(result) && call.toolCall.name !== receiptName(result)) continue
    pairs.set(call, result)
    owners.set(result, call)
  }
  const items: WorkTranscriptItem[] = []
  const visible = new Set(rows)
  let previousAssistant: EngineHistoryRow | undefined
  let previousModel: string | undefined
  for (const row of residentRows) {
    if (owners.has(row)) continue
    // Rendering fewer rows must not discard a call that is already resident.
    // Keep invocation order when older rows become visible. A genuinely
    // unloaded invocation remains an explicit output-only item.
    const result = pairs.get(row)
    if (!visible.has(row) && !(result && visible.has(result))) continue
    const knownCalls = calls.get(keys.get(row) ?? '')
    const toolName = row.toolCall?.name ?? receiptName(row) ?? (result ? receiptName(result) : undefined) ??
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
  }
  return items
}
