import type { RootRun, RootRunStatus } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { normalizeRunPending } from './pending'

const statuses: RootRunStatus[] = ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']
export function normalizeRootRun(raw: unknown): RootRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const run = raw as RootRun
  if (run.schemaVersion !== 1 || !run.runId || !run.sessionId || !run.turnId || !run.userMessageId ||
    !statuses.includes(run.status) || !Number.isInteger(run.version) || !Array.isArray(run.pending)) return undefined
  return run
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

/** Bind only explicit engine identities; optimistic IDs may be supplied exactly once by the owning stream. */
export function applyRootRun(
  messages: ChatMessage[], run: RootRun,
  optimistic?: { userId?: string; assistantId?: string }
): ChatMessage[] {
  let assistantFound = false
  const update = (message: ChatMessage): ChatMessage => {
    const own = message.runId === run.runId || message.conversationId === run.turnId ||
      message.id === (message.role === 'user' ? run.userMessageId : run.assistantMessageId) ||
      message.id === (message.role === 'user' ? optimistic?.userId : optimistic?.assistantId)
    if (!own) return message
    if (message.run && message.run.version > run.version) return message
    const base = { ...message, runId: run.runId, conversationId: run.turnId, run }
    if (message.role === 'user') return { ...base, id: run.userMessageId }
    assistantFound = true
    const interactions = run.pending.map(item => normalizeRunPending(item, run.runId)).filter(item => item !== null)
    const pending = interactions.find(item => item.status !== 'answered')
    const error = typeof run.error === 'string' ? run.error : run.error?.message
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
        if (tool.subagent) return tool
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
  const result = messages.map(update)
  if (!assistantFound && result.some(message => message.role === 'user' && message.id === run.userMessageId)) {
    result.push(update({
      id: run.assistantMessageId || `run-${run.runId}`, runId: run.runId, conversationId: run.turnId,
      role: 'assistant', content: '', thinking: '', tools: [], items: [], status: rootStatus(run.status), createdAt: run.createdAt
    }))
  }
  return result
}

export function applyRootRuns(messages: ChatMessage[], runs: RootRun[]): ChatMessage[] {
  return [...runs].sort((a, b) => a.seq - b.seq).reduce((result, run) => applyRootRun(result, run), messages)
}

export function finishTransport(message: ChatMessage, error?: string): ChatMessage {
  if (message.run && message.run.status !== 'running') return error ? { ...message, error } : message
  return { ...message, status: error ? 'error' : 'interrupted', error: error ?? '连接已结束，但尚未收到运行终态；请重新加载会话查看结果', endedAt: Date.now() }
}
