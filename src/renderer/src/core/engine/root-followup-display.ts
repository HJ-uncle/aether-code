import type { ChatMessage } from './useChat'
import type { ControllerPending, ControllerSavedRecord } from './collaboration-contract'
import type { RootRun } from '@shared/root-run'

export interface RootFollowupDisplay {
  requestKey: string
  rootRunId: string
  message: ChatMessage
  state: 'pending' | 'unknown' | 'integrated' | 'unread' | 'refused'
  label: string
}

/** Receipt display is separate from model history and transcript boundaries.
 * Accepted mail can be visible before the model consumes it without pretending
 * it has already entered context, or splitting the assistant's current stream. */
export function projectRootFollowupDisplay(input: {
  storageIdentity: string
  sessionId: string
  messages: readonly ChatMessage[]
  pending: readonly ControllerPending[]
  history: readonly ControllerSavedRecord[]
}): RootFollowupDisplay[] {
  const roots = new Map<string, RootRun>()
  for (const message of input.messages) if (message.run?.sessionId === input.sessionId) {
    const previous = roots.get(message.run.runId)
    if (!previous || previous.version < message.run.version) roots.set(message.run.runId, message.run)
  }
  const records = new Map<string, ControllerPending | ControllerSavedRecord>()
  for (const item of [...input.pending, ...input.history]) {
    if (item.storageIdentity === input.storageIdentity && item.rootSessionId === input.sessionId && item.targetKind === 'root')
      records.set(item.requestKey, item)
  }
  const result: RootFollowupDisplay[] = []
  for (const item of records.values()) {
    const run = roots.get(item.rootRunId)
    if (!run) continue
    const receipt = 'kind' in item && item.kind === 'accepted' ? item.receipt : undefined
    const delivered = receipt && input.messages.some(message => message.role === 'user' && message.runId === run.runId && message.conversationId === run.turnId &&
      (message.rootFollowup?.messageId === receipt.messageId && message.rootFollowup.rootRunId === run.runId && message.rootFollowup.turnId === run.turnId ||
        receipt.delivery?.state === 'integrated' && message.id === receipt.delivery.historyMessageId))
    if (delivered) continue
    // Never resurrect content removed from authoritative history or collapsed
    // into a compaction summary. A local receipt is not a transcript source.
    if (receipt?.delivery?.state === 'suppressed' && receipt.delivery.integratedAt !== undefined) continue
    const active = run.status === 'running' || run.status === 'waiting'
    if (receipt?.delivery?.state === 'integrated' && !active) continue
    let state: RootFollowupDisplay['state'] = 'unknown', label = '发送状态待确认，原文已保留'
    if ('kind' in item && item.kind === 'refused' || receipt?.state === 'rejected') {
      state = 'refused'; label = '未被接纳，原文已保留'
    } else if (receipt?.delivery?.state === 'integrated') {
      state = 'integrated'; label = '已加入上下文'
    } else if (receipt?.delivery?.state === 'suppressed' || receipt?.state === 'interrupted') {
      state = 'unread'; label = '未确认读取，原文已保留'
    } else if (receipt?.state === 'queued') {
      state = active ? 'pending' : 'unknown'
      label = active ? '已送达，等待读取' : '运行已结束，投递状态待核对'
    }
    result.push({ requestKey: item.requestKey, rootRunId: run.runId, state, label,
      message: { id: `controller-display:${item.requestKey}`, role: 'user', content: item.message,
        runId: run.runId, conversationId: run.turnId, thinking: '', tools: [], items: [], status: 'done',
        createdAt: receipt?.acceptedAt ?? item.createdAt } })
  }
  return result.sort((a, b) => a.message.createdAt - b.message.createdAt || a.requestKey.localeCompare(b.requestKey))
}
