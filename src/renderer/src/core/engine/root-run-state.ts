import { normalizeRootRunCompaction, normalizeRootRunRequestConfig, type RootRun, type RootRunStatus } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { normalizeRunPending } from './pending'

const statuses: RootRunStatus[] = ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']
export function normalizeRootRun(raw: unknown): RootRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const run = raw as RootRun
  if (run.schemaVersion !== 1 || !run.runId || !run.sessionId || !run.turnId || !run.userMessageId ||
    !statuses.includes(run.status) || !Number.isInteger(run.version) || !Array.isArray(run.pending)) return undefined
  return { ...run, requestConfig: normalizeRootRunRequestConfig(run.requestConfig), compaction: normalizeRootRunCompaction(run.compaction) }
}
export function rootStatus(status: RootRunStatus): ChatMessage['status'] {
  return status === 'succeeded' ? 'done' : status === 'failed' ? 'error' :
    status === 'cancelled' ? 'aborted' : status === 'running' ? 'streaming' : status
}
export function rootStatusLabel(status: RootRunStatus): string {
  return { running: '运行中', waiting: '等待应答', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[status]
}
export function mergeRootRun(previous: RootRun | undefined, next: RootRun): RootRun {
  if (!previous) return next
  if (previous.runId !== next.runId || previous.sessionId !== next.sessionId || next.version <= previous.version) return previous
  return next
}

function rootRunErrorMessage(run: RootRun): string | undefined {
  const error = typeof run.error === 'string' ? run.error : run.error?.message
  const code = typeof run.error === 'object' ? run.error?.code : undefined
  // 旧引擎和历史记录只有通用英文；更具体的服务端诊断应原样保留。
  if (error === 'Model returned no final answer' && (code === 'EMPTY_OUTPUT' || run.stopReason === 'empty_output')) {
    return '未收到模型的最终回答。模型服务可能返回了空内容，或响应未被正确解析；请重试，若仍失败请检查模型服务配置。'
  }
  return error
}

/** Bind only explicit engine identities; optimistic IDs may be supplied exactly once by the owning stream. */
export function applyRootRun(
  messages: ChatMessage[], run: RootRun,
  optimistic?: { userId?: string; assistantId?: string }
): ChatMessage[] {
  let assistantFound = false
  /**
   * A few legacy history rows predate the durable identity envelope and have
   * neither conversationId nor runId.  They are still recoverable when they
   * sit directly after this run's user row; the caller marks that positional
   * candidate explicitly so an unrelated orphan later in the transcript is
   * never claimed by a run.
   */
  const update = (message: ChatMessage, positionalAssistant = false): ChatMessage => {
    const own = message.runId === run.runId || message.conversationId === run.turnId ||
      message.id === (message.role === 'user' ? run.userMessageId : run.assistantMessageId) ||
      message.id === (message.role === 'user' ? optimistic?.userId : optimistic?.assistantId) ||
      positionalAssistant && message.role === 'assistant' && !message.runId && !message.conversationId && !message.run
    if (!own) return message
    if (message.run && message.run.version > run.version) return message
    const base = { ...message, runId: run.runId, conversationId: run.turnId, run }
    if (message.role === 'user') return { ...base, id: run.userMessageId }
    assistantFound = true
    const interactions = run.pending.map(item => normalizeRunPending(item, run.runId)).filter(item => item !== null)
    const pending = interactions.find(item => item.status !== 'answered')
    // A waiting run carries the ask/permission question in `run.error` as a
    // durable diagnostic for recovery. It is not a failure and must not render
    // the question again in the red message error strip below the card.
    const error = run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled'
      ? rootRunErrorMessage(run)
      : undefined
    return {
      ...base,
      id: run.assistantMessageId || message.id,
      status: rootStatus(run.status),
      modelId: run.actualModelId ||
        (message.usage && typeof message.usage === 'object' && typeof (message.usage as Record<string, unknown>).modelId === 'string'
          ? (message.usage as { modelId: string }).modelId : undefined) || message.modelId || run.modelId,
      startedAt: run.startedAt ?? message.startedAt ?? run.createdAt,
      endedAt: run.finishedAt,
      error: error || (run.status === 'interrupted' ? '运行已中断，未自动重试' : run.status === 'cancelled' ? '已停止' : undefined),
      interactions,
      pending,
      answered: undefined,
      tools: message.tools.map(tool => {
        if (tool.subagent || tool.commandJob) return tool
        const interaction = interactions.find(item => item.toolCallId === tool.id)
        if (interaction?.status === 'pending') return { ...tool, state: run.status === 'waiting' ? 'waiting' : run.status === 'cancelled' ? 'cancelled' : 'interrupted' }
        if (interaction?.status === 'answered' && tool.state === 'waiting') return {
          ...tool, state: interaction.kind === 'ask' ? 'done' : interaction.output === 'rejected' ? 'cancelled' : run.status === 'running' ? 'running' : 'interrupted',
          result: interaction.output ?? tool.result
        }
        if (tool.state === 'running' && run.status !== 'running' && run.status !== 'waiting') return {
          ...tool, state: run.status === 'cancelled' ? 'cancelled' : 'interrupted',
          error: tool.error ?? '工具未报告最终结果'
        }
        return tool
      })
    }
  }
  // Do not pass `update` directly to Array#map: its second callback argument
  // is the numeric index, which would accidentally enable the positional
  // legacy-assistant fallback for every other assistant row.
  const result = messages.map(message => update(message))
  if (!assistantFound) {
    // Empty-output/failed turns may have a durable root-run record and a user
    // history row, but no assistant row at all.  Appending the synthetic error
    // card to the end makes it drift below later retries after a restart. Keep
    // the card attached to its own request by inserting it immediately after
    // the matching user message, which is also where the live optimistic turn
    // rendered it before persistence caught up.
    const userIndex = result.findIndex(message => message.role === 'user' && message.id === run.userMessageId)
    if (userIndex >= 0) {
      const positionalAssistant = result[userIndex + 1]
      if (positionalAssistant?.role === 'assistant' && !positionalAssistant.runId && !positionalAssistant.conversationId && !positionalAssistant.run) {
        result[userIndex + 1] = update(positionalAssistant, true)
        return result
      }
      const assistant = update({
        id: run.assistantMessageId || `run-${run.runId}`, runId: run.runId, conversationId: run.turnId,
        role: 'assistant', content: '', thinking: '', tools: [], items: [], status: rootStatus(run.status), createdAt: run.createdAt
      })
      result.splice(userIndex + 1, 0, assistant)
    }
  }
  return result
}

export function applyRootRuns(messages: ChatMessage[], runs: RootRun[]): ChatMessage[] {
  return [...runs].sort((a, b) => a.seq - b.seq).reduce((result, run) => applyRootRun(result, run), messages)
}

export function finishTransport(message: ChatMessage, error?: string, receivedAt = Date.now()): ChatMessage {
  if (message.run && message.run.status !== 'running') return error ? { ...message, error } : message
  return { ...message, status: error ? 'error' : 'interrupted', error: error ?? '连接已结束，但尚未收到运行终态；请重新加载会话查看结果', endedAt: receivedAt }
}
