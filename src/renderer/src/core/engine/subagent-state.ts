import type {
  SubagentError,
  SubagentEvent,
  SubagentRun,
  SubagentRunStatus,
  SubagentToolCall,
  SubagentUsage
} from '@shared/subagent'
import type { ChatMessage, ToolActivity } from './useChat'

const STATUSES: SubagentRunStatus[] = [
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
  'interrupted'
]
const STATUS_LABELS: Record<SubagentRunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  cancelling: '取消中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  blocked: '受阻',
  interrupted: '已中断'
}
const STOP_REASON_LABELS: Record<string, string> = {
  completed: '任务完成',
  cancelled: '任务已取消',
  user_cancelled: '用户停止',
  parent_cancelled: '父任务已停止',
  parent_deleted: '父会话已删除',
  engine_restarted: '引擎重启',
  deadline_exceeded: '超过执行时限',
  max_steps: '达到步骤上限',
  budget: '达到用量上限',
  budget_exceeded: '达到用量上限',
  context_limit: '超出上下文长度',
  output_limit: '达到输出长度上限',
  permission: '需要授权',
  needs_user: '需要用户输入',
  provider_error: '模型请求失败',
  runtime_error: '执行错误',
  execution_error: '执行错误',
  repeated_failure: '工具连续失败或重复调用',
  empty_output: '模型未返回最终结果',
  incomplete: '任务未完成',
  missing_outcome: '任务未报告完成状态'
}

export function subagentStopReasonLabel(reason: string): string {
  return STOP_REASON_LABELS[reason] ?? reason
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
export function errorText(value: unknown): string | undefined {
  return optionalText(value) || optionalText(record(value)?.message)
}
function normalizeError(raw: unknown): SubagentError | undefined {
  const r = record(raw)
  const message = errorText(raw)
  return message
    ? { code: optionalText(r?.code) ?? 'UNKNOWN', message, retryable: r?.retryable === true }
    : undefined
}
function normalizeUsage(raw: unknown): SubagentUsage {
  const r = record(raw) ?? {}
  return {
    inputTokens: finite(r.inputTokens),
    outputTokens: finite(r.outputTokens),
    totalTokens: finite(r.totalTokens),
    cacheReadTokens: finite(r.cacheReadTokens),
    cacheWriteTokens: finite(r.cacheWriteTokens),
    estimated: r.estimated === true,
    unknown: r.unknown === true
  }
}

/** Reject malformed/cross-version control data at the boundary, without hiding ordinary output. */
export function normalizeSubagentRun(raw: unknown): SubagentRun | undefined {
  const r = record(raw)
  if (
    !r ||
    r.schemaVersion !== 1 ||
    typeof r.runId !== 'string' ||
    !r.runId ||
    typeof r.parentSessionId !== 'string' ||
    !r.parentSessionId ||
    typeof r.parentToolCallId !== 'string' ||
    !r.parentToolCallId ||
    !STATUSES.includes(r.status as SubagentRunStatus) ||
    finite(r.lastSeq) === undefined
  )
    return undefined
  const text = (key: string): string => optionalText(r[key]) ?? ''
  const calls: SubagentToolCall[] = []
  for (const rawCall of Array.isArray(r.toolCalls) ? r.toolCalls : []) {
    const call = record(rawCall)
    if (
      !call ||
      typeof call.id !== 'string' ||
      typeof call.name !== 'string' ||
      !['running', 'succeeded', 'failed', 'cancelled'].includes(String(call.status))
    )
      continue
    calls.push({
      id: call.id,
      name: call.name,
      args: call.args,
      status: call.status as SubagentToolCall['status'],
      output: optionalText(call.output),
      error: normalizeError(call.error),
      startedAt: finite(call.startedAt),
      finishedAt: finite(call.finishedAt),
      durationMs: finite(call.durationMs)
    })
  }
  return {
    schemaVersion: 1,
    runId: r.runId,
    tenantId: text('tenantId'),
    rootSessionId: text('rootSessionId'),
    parentSessionId: r.parentSessionId,
    parentToolCallId: r.parentToolCallId,
    parentConversationId: text('parentConversationId'),
    parentMessageId: text('parentMessageId'),
    childSessionId: text('childSessionId'),
    task: text('task'),
    description: text('description'),
    modelId: text('modelId'),
    status: r.status as SubagentRunStatus,
    lastSeq: r.lastSeq as number,
    createdAt: finite(r.createdAt) ?? 0,
    updatedAt: finite(r.updatedAt) ?? 0,
    startedAt: finite(r.startedAt),
    finishedAt: finite(r.finishedAt),
    durationMs: finite(r.durationMs),
    error: normalizeError(r.error),
    stopReason: optionalText(r.stopReason),
    resultSummary: optionalText(r.resultSummary),
    partialOutput: optionalText(r.partialOutput),
    externalEffectStatus: r.externalEffectStatus === 'unknown' ? 'unknown' : undefined,
    usage: normalizeUsage(r.usage),
    toolCalls: calls,
    transcriptRef: optionalText(r.transcriptRef)
  }
}

export function normalizeSubagentEvent(raw: unknown): SubagentEvent | undefined {
  const r = record(raw)
  const snapshot = normalizeSubagentRun(r?.snapshot)
  if (
    !r ||
    !snapshot ||
    r.schemaVersion !== 1 ||
    r.runId !== snapshot.runId ||
    finite(r.seq) === undefined ||
    r.seq !== snapshot.lastSeq ||
    typeof r.kind !== 'string'
  )
    return undefined
  return { schemaVersion: 1, kind: r.kind, runId: snapshot.runId, seq: r.seq as number, snapshot }
}

export function isSubagentActive(status: SubagentRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling'
}

/** seq gates duplicates; a late progress snapshot may enrich a terminal run but never revive it. */
export function mergeSubagentRun(
  previous: SubagentRun | undefined,
  incoming: SubagentRun
): SubagentRun {
  if (!previous) return incoming
  if (
    previous.runId !== incoming.runId ||
    previous.parentSessionId !== incoming.parentSessionId ||
    previous.parentToolCallId !== incoming.parentToolCallId ||
    incoming.lastSeq <= previous.lastSeq
  )
    return previous
  const usage: SubagentUsage = { ...previous.usage, ...incoming.usage }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ] as const) {
    const before = previous.usage[key]
    const next = incoming.usage[key]
    usage[key] = before === undefined ? next : next === undefined ? before : Math.max(before, next)
  }
  const toolCalls = [...previous.toolCalls]
  for (const call of incoming.toolCalls) {
    const index = toolCalls.findIndex((item) => item.id === call.id)
    if (index < 0) toolCalls.push(call)
    else {
      const before = toolCalls[index]
      toolCalls[index] = {
        ...before,
        ...call,
        status: before.status !== 'running' ? before.status : call.status,
        output: call.output ?? before.output,
        error: call.error ?? before.error,
        finishedAt: before.finishedAt ?? call.finishedAt
      }
    }
  }
  const next = {
    ...incoming,
    usage,
    toolCalls,
    externalEffectStatus: incoming.externalEffectStatus ?? previous.externalEffectStatus,
    startedAt: previous.startedAt ?? incoming.startedAt
  }
  if (!isSubagentActive(previous.status)) {
    return {
      ...next,
      status: previous.status,
      finishedAt: previous.finishedAt,
      error: previous.error ?? incoming.error,
      stopReason: previous.stopReason ?? incoming.stopReason,
      resultSummary: incoming.resultSummary ?? previous.resultSummary,
      partialOutput: incoming.partialOutput ?? previous.partialOutput
    }
  }
  if (
    previous.status === 'cancelling' &&
    (incoming.status === 'queued' || incoming.status === 'running')
  ) {
    return { ...next, status: 'cancelling' }
  }
  return next
}

export function runToolState(run: SubagentRun): ToolActivity['state'] {
  if (isSubagentActive(run.status)) return 'running'
  if (run.status === 'succeeded') return 'done'
  if (run.status === 'cancelled') return 'cancelled'
  return 'error'
}

export function toolStatusLabel(tool: ToolActivity): string {
  if (tool.subagent) return STATUS_LABELS[tool.subagent.status]
  if (tool.state === 'unknown') return '状态未知'
  if (tool.state === 'waiting') return '等待应答'
  if (tool.state === 'interrupted') return '已中断'
  if (tool.state === 'cancelled') return '已取消'
  if (tool.state === 'error') return '失败'
  return tool.state === 'running' ? '运行中' : '成功'
}

export function subagentStatusLabel(status: SubagentRunStatus): string {
  return STATUS_LABELS[status]
}

/** Historical child status requires evidence; ordinary legacy tools keep their existing compatibility. */
export function toolResultState(raw: unknown, name: string): ToolActivity['state'] {
  const r = record(raw) ?? {}
  const nested = record(r.metadata) ?? {}
  const run = normalizeSubagentRun(r.subagent ?? nested.subagent)
  if (run) return runToolState(run)
  const status = r.status ?? nested.status
  if (status === 'waiting') return 'waiting'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'running') return 'running'
  if (status === 'succeeded') return 'done'
  if (status === 'failed') return 'error'
  const success = r.success ?? nested.success
  if (r.status === 'cancelled' || nested.status === 'cancelled') return 'cancelled'
  if (
    success === false ||
    r.isError === true ||
    r.is_error === true ||
    errorText(r.error ?? nested.error)
  )
    return 'error'
  if (success === true) return 'done'
  return name === 'subagent' ? 'unknown' : 'done'
}

/** Own snapshots by the dispatch ID, including events arriving after a later parent turn starts. */
export function attachSubagentRuns(
  messages: ChatMessage[],
  runs: readonly SubagentRun[],
  restoreMissing = false
): ChatMessage[] {
  let result = messages
  for (const incoming of runs) {
    let owner = result.findIndex((m) =>
      m.tools.some((tool) => tool.id === incoming.parentToolCallId)
    )
    if (owner < 0)
      owner = result.findIndex(
        (m) =>
          m.role === 'assistant' &&
          (m.id === incoming.parentMessageId ||
            Boolean(
              incoming.parentConversationId && m.conversationId === incoming.parentConversationId
            ))
      )
    if (owner < 0) {
      if (!restoreMissing) continue
      // A committed dispatch can outlive an interrupted transcript projection. Restore the persisted parent identity.
      const restored: ChatMessage = {
        id: incoming.parentMessageId || `subagent-${incoming.runId}`,
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        items: [],
        status: 'done',
        createdAt: incoming.createdAt,
        conversationId: incoming.parentConversationId || undefined
      }
      const nextIndex = result.findIndex((m) => m.createdAt > incoming.createdAt)
      owner = nextIndex < 0 ? result.length : nextIndex
      result = [...result.slice(0, owner), restored, ...result.slice(owner)]
    }
    const message = result[owner]
    const index = message.tools.findIndex((tool) => tool.id === incoming.parentToolCallId)
    const previous = index >= 0 ? message.tools[index] : undefined
    const run = mergeSubagentRun(previous?.subagent, incoming)
    if (previous?.subagent === run) continue
    const tool: ToolActivity = {
      ...previous,
      id: run.parentToolCallId,
      name: 'subagent',
      args: previous?.args || JSON.stringify({ task: run.task, description: run.description }),
      result: run.resultSummary ?? run.partialOutput ?? previous?.result ?? '',
      state: runToolState(run),
      subagent: run,
      error: run.error?.message,
      startedAt: run.startedAt ?? run.createdAt
    }
    const tools = [...message.tools]
    if (index < 0) tools.push(tool)
    else tools[index] = tool
    const next = {
      ...message,
      tools,
      items: index < 0 ? [...message.items, { kind: 'tool' as const, id: tool.id }] : message.items
    }
    result = [...result.slice(0, owner), next, ...result.slice(owner + 1)]
  }
  return result
}

export function exportSubagentDetails(tool: ToolActivity): string {
  const run = tool.subagent
  const reason = run?.error?.message ?? tool.error
  const lines = [reason ? `失败原因：${reason}` : '']
  if (run) {
    lines.push(`目标任务：${run.task}`)
    if (run.stopReason) lines.push(`结束原因：${subagentStopReasonLabel(run.stopReason)}`)
    if (run.externalEffectStatus === 'unknown') lines.push('已停止本地执行；外部操作结果可能未知')
    for (const call of run.toolCalls) {
      lines.push(
        `  - ${call.name}（${call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '运行中'}）${call.error?.message ? `：${call.error.message}` : ''}`
      )
      if (call.args !== undefined)
        lines.push(
          `    参数：${typeof call.args === 'string' ? call.args : JSON.stringify(call.args)}`
        )
      if (call.output) lines.push(`    结果：${call.output}`)
    }
    if (run.resultSummary || run.partialOutput)
      lines.push(run.resultSummary ?? run.partialOutput ?? '')
    lines.push(
      `工具调用 ${run.toolCalls.length}；Tokens ${run.usage.unknown ? '未知' : (run.usage.totalTokens ?? '未知')}`
    )
    if (run.durationMs !== undefined) lines.push(`耗时：${(run.durationMs / 1000).toFixed(1)}s`)
  } else if (tool.name === 'subagent') {
    lines.push('旧记录未保存结构化详情。')
    if (tool.result) lines.push(tool.result.split('__SUBAGENT_META__')[0].trim())
  }
  return lines.filter(Boolean).join('\n')
}
