import type { EngineHistoryRow } from './chat-history'

const PLAN_CONTROLS = new Set(['plan_update', 'todo_create', 'todo_list', 'todo_update', 'todo_delete'])
const VISIBLE_OUTCOMES = new Set(['error', 'failed', 'blocked', 'cancelled', 'interrupted', 'waiting'])

export function isTaskPlanControl(name: string | undefined): boolean {
  return Boolean(name && PLAN_CONTROLS.has(name))
}

interface PlanReceipt {
  name?: string
  state?: string
  status?: string
  success?: boolean
  error?: unknown
  metadata?: { status?: unknown; success?: unknown; error?: unknown }
}

/** Plans have their own state surface. Keep failures visible without marking
 * receipts hidden, which would also erase their audit/export evidence. Pending
 * and incomplete legacy controls are silent; they never prove plan completion. */
export function isSilentTaskPlanActivity(receipt: PlanReceipt): boolean {
  if (!isTaskPlanControl(receipt.name)) return false
  return !VISIBLE_OUTCOMES.has(receipt.state ?? receipt.status ?? String(receipt.metadata?.status ?? '')) &&
    receipt.success !== false && receipt.metadata?.success !== false && !receipt.error && !receipt.metadata?.error
}

export function isVisibleToolActivity<T extends PlanReceipt & { hidden?: boolean }>(receipt: T): boolean {
  return !receipt.hidden && !isSilentTaskPlanActivity(receipt)
}

/** The archive remains intact in memory/storage. Its user-facing transcript
 * omits silent control calls/results while retaining their surrounding prose. */
export function taskPlanTranscriptRows(rows: readonly EngineHistoryRow[]): EngineHistoryRow[] {
  const calls = new Map<string, string>()
  const outcomes = new Map<string, EngineHistoryRow>()
  for (const row of rows) {
    if (row.toolCall?.id && row.toolCall.name) calls.set(row.toolCall.id, row.toolCall.name)
    if (row.role === 'tool' && typeof row.toolCallId === 'string') outcomes.set(row.toolCallId, row)
  }
  const displayed: EngineHistoryRow[] = []
  for (const row of rows) {
    const name = row.toolCall?.name ?? row.metadata?.toolName ?? (typeof row.toolCallId === 'string' ? calls.get(row.toolCallId) : undefined)
    const outcome = row.role === 'tool' ? row : row.toolCall?.id ? outcomes.get(row.toolCall.id) : undefined
    if (!isSilentTaskPlanActivity({ name, ...(outcome ?? row) })) { displayed.push(row); continue }
    if (row.role === 'tool') continue
    if (row.role === 'assistant' && row.toolCall) {
      if (row.content || row.reasoningContent || row.usage || row.metadata?.attachments?.length) displayed.push({ ...row, toolCall: undefined })
    } else displayed.push(row)
  }
  return displayed
}
