import { commandJobDisplayLabel } from './command-job-state'
import { commandFailureLabel } from './tool-feedback'
import { toolDisplayName } from './tool-labels'
import { utf8BytePreview } from './utf8-preview'
import type {
  SubagentError,
  SubagentCoverage,
  SubagentDeltaEvent,
  SubagentEvent,
  SubagentIdentity,
  SubagentRun,
  SubagentRunV1,
  SubagentRunView,
  SubagentRunStatus,
  SubagentToolCall,
  SubagentToolSummary,
  SubagentUsage
} from '@shared/subagent'
import type { SubagentDiscoveryRef } from '@shared/subagent'
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
    estimated: typeof r.estimated === 'boolean' ? r.estimated : undefined,
    unknown: typeof r.unknown === 'boolean' ? r.unknown : undefined
  }
}

/** Reject malformed/cross-version control data at the boundary, without hiding ordinary output. */
function normalizeLegacySubagentRun(raw: unknown): SubagentRunV1 | undefined {
  const r = record(raw)
  if (
    !r ||
    r.schemaVersion !== 1 ||
    typeof r.runId !== 'string' ||
    !r.runId ||
    r.runId.length > 1024 ||
    typeof r.parentSessionId !== 'string' ||
    !r.parentSessionId ||
    typeof r.parentToolCallId !== 'string' ||
    !r.parentToolCallId ||
    !STATUSES.includes(r.status as SubagentRunStatus) ||
    finite(r.lastSeq) === undefined ||
    !Number.isSafeInteger(r.lastSeq) ||
    [
      'tenantId',
      'rootSessionId',
      'parentSessionId',
      'parentConversationId',
      'parentMessageId',
      'parentToolCallId',
      'childSessionId'
    ].some((key) => typeof r[key] === 'string' && (r[key] as string).length > 4096)
  )
    return undefined
  const text = (key: string): string => optionalText(r[key]) ?? ''
  const calls: SubagentToolCall[] = []
  for (const rawCall of Array.isArray(r.toolCalls) ? r.toolCalls : []) {
    const call = record(rawCall)
    if (
      !call ||
      typeof call.id !== 'string' ||
      call.id.length > 1024 ||
      typeof call.name !== 'string' ||
      call.name.length > 1024 ||
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
    resumeFromRunId: preview(optionalText(r.resumeFromRunId), 4096),
    agentId: preview(optionalText(r.agentId), 4096),
    agentName: optionalText(r.agentName),
    continuation:
      typeof record(r.continuation)?.readOnly === 'boolean'
        ? {
            role: optionalText(record(r.continuation)?.role),
            readOnly: record(r.continuation)!.readOnly as boolean
          }
        : undefined,
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
    transcriptRef: preview(optionalText(r.transcriptRef), 4096)
  }
}

export const SUBAGENT_VIEW_MAX_TOOLS = 64
export const SUBAGENT_VIEW_MAX_ACTIVE = 32
export const SUBAGENT_VIEW_MAX_BYTES = 256 * 1024
export const SUBAGENT_CACHE_MAX_BYTES = 4 * 1024 * 1024
const IDENTITY_KEYS: (keyof SubagentIdentity)[] = [
  'tenantId',
  'rootSessionId',
  'parentSessionId',
  'parentConversationId',
  'parentMessageId',
  'parentToolCallId',
  'childSessionId'
]
const OPTIONAL_LEGACY_IDENTITY = new Set<keyof SubagentIdentity>([
  'parentConversationId',
  'parentMessageId'
])
const encoder = new TextEncoder()

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validUsage(value: unknown): boolean {
  const usage = record(value)
  return (
    !!usage &&
    ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(
      (key) => usage[key] === undefined || finite(usage[key]) !== undefined
    ) &&
    ['estimated', 'unknown'].every(
      (key) => usage[key] === undefined || typeof usage[key] === 'boolean'
    )
  )
}

/** Never split a multibyte code point or turn an args object into invalid JSON. */
const preview = utf8BytePreview

function boundedArgs(
  value: unknown,
  depth = 0,
  budget = { remaining: 2048, truncated: false }
): unknown {
  if (typeof value === 'string') {
    const result = preview(value, Math.min(512, budget.remaining)) ?? ''
    budget.remaining -= encoder.encode(result).byteLength
    budget.truncated ||= result !== value
    return result
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (depth >= 3 || budget.remaining <= 0) {
    budget.truncated = true
    return '[详情已省略]'
  }
  if (Array.isArray(value)) {
    budget.truncated ||= value.length > 8
    return value.slice(0, 8).map((item) => boundedArgs(item, depth + 1, budget))
  }
  const input = record(value)
  if (!input) return undefined
  const output: Record<string, unknown> = {}
  let count = 0
  for (const key in input) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    if (count++ >= 8) {
      budget.truncated = true
      break
    }
    const selectedKey = preview(key, Math.min(128, budget.remaining)) ?? ''
    budget.truncated ||= selectedKey !== key
    budget.remaining -= encoder.encode(selectedKey).byteLength
    Object.defineProperty(output, selectedKey, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: boundedArgs(input[key], depth + 1, budget)
    })
  }
  return output
}

export function subagentResidentBytes(value: SubagentRun): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

function normalizeSummary(raw: unknown, asOfSeq: number): SubagentToolSummary | undefined {
  const call = record(raw)
  if (
    !call ||
    typeof call.id !== 'string' ||
    !call.id ||
    call.id.length > 1024 ||
    typeof call.name !== 'string' ||
    call.name.length > 1024 ||
    !['running', 'succeeded', 'failed', 'cancelled'].includes(String(call.status)) ||
    !integer(call.revisionSeq) ||
    call.revisionSeq < 1 ||
    call.revisionSeq > asOfSeq ||
    !integer(call.ordinal) ||
    call.ordinal < 1 ||
    typeof call.detailRef !== 'string' ||
    call.detailRef.length > 4096 ||
    typeof call.detailTruncated !== 'boolean'
  )
    return undefined
  const argBudget = { remaining: 2048, truncated: false }
  const args = boundedArgs(call.args, 0, argBudget)
  const output = preview(optionalText(call.output))
  return {
    id: call.id,
    name: call.name,
    args,
    status: call.status as SubagentToolCall['status'],
    revisionSeq: call.revisionSeq,
    ordinal: call.ordinal,
    detailRef: call.detailRef,
    detailTruncated: call.detailTruncated || argBudget.truncated || output !== call.output,
    output,
    argsPreview: preview(optionalText(call.argsPreview)),
    outputPreview: preview(optionalText(call.outputPreview)),
    error: normalizeError(call.error)
      ? {
          ...normalizeError(call.error)!,
          code: preview(normalizeError(call.error)!.code, 256) ?? 'UNKNOWN',
          message: preview(normalizeError(call.error)!.message, 2048) ?? ''
        }
      : undefined,
    startedAt: finite(call.startedAt),
    finishedAt: finite(call.finishedAt),
    durationMs: finite(call.durationMs)
  }
}

function normalizeCoverage(
  raw: unknown,
  seq: number,
  calls?: SubagentToolSummary[]
): SubagentCoverage | undefined {
  const r = record(raw)
  const ids = r?.ids
  if (
    !r ||
    r.asOfSeq !== seq ||
    !integer(r.toolCount) ||
    !integer(r.includedToolCount) ||
    !integer(r.activeToolCount) ||
    !integer(r.includedActiveToolCount) ||
    r.toolCount < r.includedToolCount ||
    r.activeToolCount > r.toolCount ||
    r.activeToolCount < r.includedActiveToolCount ||
    r.includedActiveToolCount > r.includedToolCount ||
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === 'string' && id) ||
    new Set(ids).size !== ids.length ||
    ids.length !== r.includedToolCount ||
    typeof r.hasMore !== 'boolean' ||
    typeof r.truncated !== 'boolean' ||
    !['complete', 'partial', 'unknown'].includes(String(r.completeness))
  )
    return undefined
  if (
    calls &&
    (r.includedToolCount !== calls.length ||
      r.includedActiveToolCount !== calls.filter((call) => call.status === 'running').length ||
      !calls.every((call) => ids.includes(call.id)))
  )
    return undefined
  if (
    r.completeness === 'complete' &&
    (r.hasMore ||
      r.includedToolCount !== r.toolCount ||
      r.includedActiveToolCount !== r.activeToolCount)
  )
    return undefined
  return {
    asOfSeq: seq,
    toolCount: r.toolCount,
    includedToolCount: r.includedToolCount,
    activeToolCount: r.activeToolCount,
    includedActiveToolCount: r.includedActiveToolCount,
    ids: [...ids] as string[],
    hasMore: r.hasMore,
    truncated: r.truncated,
    completeness: r.completeness as SubagentCoverage['completeness'],
    nextCursor: optionalText(r.nextCursor)
  }
}

function coverageFor(view: SubagentRunView, calls: SubagentToolSummary[]): SubagentCoverage {
  const omitted = calls.length < view.toolCount
  const includedActiveToolCount = calls.filter((call) => call.status === 'running').length
  const complete =
    !omitted &&
    includedActiveToolCount === view.activeToolCount &&
    view.coverage.completeness !== 'unknown'
  return {
    ...view.coverage,
    asOfSeq: view.lastSeq,
    toolCount: view.toolCount,
    activeToolCount: view.activeToolCount,
    ids: calls.map((call) => call.id),
    includedToolCount: calls.length,
    includedActiveToolCount,
    hasMore: !complete && (omitted || view.coverage.hasMore),
    truncated: omitted || view.coverage.truncated || calls.some((call) => call.detailTruncated),
    completeness:
      view.coverage.completeness === 'unknown' ? 'unknown' : complete ? 'complete' : 'partial'
  }
}

/** Selection follows update revisions, including a very old tool that just completed. */
export function boundSubagentView(
  view: SubagentRunView,
  maxBytes = SUBAGENT_VIEW_MAX_BYTES,
  maxTools = SUBAGENT_VIEW_MAX_TOOLS
): SubagentRunView {
  const latest = view.latestActivity
  const byId = new Map(view.toolCalls.map((call) => [call.id, call]))
  if (latest) byId.set(latest.id, latest)
  const ordered = [...byId.values()].sort(
    (a, b) =>
      Number(b.id === latest?.id) - Number(a.id === latest?.id) ||
      Number(b.status === 'running') - Number(a.status === 'running') ||
      b.revisionSeq - a.revisionSeq ||
      b.ordinal - a.ordinal
  )
  let active = 0
  const calls: SubagentToolSummary[] = []
  let budget = Math.max(0, maxBytes - 16 * 1024)
  for (const call of ordered) {
    if (calls.length >= maxTools) break
    if (call.status === 'running' && active >= SUBAGENT_VIEW_MAX_ACTIVE) continue
    const bytes = encoder.encode(JSON.stringify(call)).byteLength
    if (bytes > budget) continue
    calls.push(call)
    budget -= bytes
    if (call.status === 'running') active++
  }
  const next: SubagentRunView = {
    ...view,
    toolCalls: calls,
    coverage: coverageFor(view, calls),
    task: preview(view.task, 4096) ?? '',
    description: preview(view.description, 2048) ?? '',
    resultSummary: preview(view.resultSummary, 4096),
    partialOutput: preview(view.partialOutput, 4096),
    latestActivity: latest,
    residentToolCount: calls.length,
    agentName: preview(view.agentName, 1024),
    modelId: preview(view.modelId, 1024) ?? '',
    error: view.error
      ? {
          ...view.error,
          code: preview(view.error.code, 256) ?? 'UNKNOWN',
          message: preview(view.error.message, 2048) ?? ''
        }
      : undefined,
    stopReason: preview(view.stopReason, 1024),
    continuation: view.continuation
      ? { readOnly: view.continuation.readOnly, role: preview(view.continuation.role, 1024) }
      : undefined
  }
  next.residentBytes = subagentResidentBytes(next)
  next.residentBytes = subagentResidentBytes(next)
  // Huge headers are malformed server data; keep the latest tool and expose omitted details.
  while (next.residentBytes > maxBytes && next.toolCalls.length > 1) {
    next.toolCalls.pop()
    next.coverage = coverageFor(next, next.toolCalls)
    next.residentToolCount = next.toolCalls.length
    next.residentBytes = subagentResidentBytes(next)
  }
  next.residentBytes = subagentResidentBytes(next)
  return next
}

export function toSubagentView(run: SubagentRun): SubagentRunView {
  if (run.schemaVersion === 2) return boundSubagentView(run)
  const calls = run.toolCalls.map((call, index): SubagentToolSummary => ({
    ...call,
    args: boundedArgs(call.args),
    output: preview(call.output),
    revisionSeq: run.lastSeq,
    ordinal: index + 1,
    detailRef: run.transcriptRef ?? '',
    detailTruncated: true
  }))
  const activeToolCount = calls.filter((call) => call.status === 'running').length
  const latestActivity = [...calls].sort(
    (a, b) =>
      (b.finishedAt ?? b.startedAt ?? b.ordinal) - (a.finishedAt ?? a.startedAt ?? a.ordinal)
  )[0]
  return boundSubagentView({
    ...run,
    schemaVersion: 2,
    view: 'summary',
    toolCalls: calls,
    toolCount: calls.length,
    activeToolCount,
    latestActivity,
    coverage: {
      asOfSeq: run.lastSeq,
      toolCount: calls.length,
      includedToolCount: calls.length,
      activeToolCount,
      includedActiveToolCount: activeToolCount,
      ids: calls.map((call) => call.id),
      hasMore: false,
      truncated: false,
      completeness: 'complete'
    }
  })
}

export function normalizeSubagentRun(raw: unknown): SubagentRun | undefined {
  const r = record(raw)
  if (r?.schemaVersion === 1) return normalizeLegacySubagentRun(raw)
  if (
    !r ||
    r.schemaVersion !== 2 ||
    r.view !== 'summary' ||
    !integer(r.lastSeq) ||
    !Array.isArray(r.toolCalls) ||
    !integer(r.toolCount) ||
    !integer(r.activeToolCount) ||
    !validUsage(r.usage) ||
    !integer(r.createdAt) ||
    !integer(r.updatedAt)
  )
    return undefined
  if (
    typeof r.runId !== 'string' ||
    r.runId.length > 1024 ||
    ['transcriptRef', 'agentId', 'resumeFromRunId'].some(
      (key) =>
        r[key] !== undefined && (typeof r[key] !== 'string' || (r[key] as string).length > 4096)
    )
  )
    return undefined
  const legacy = normalizeLegacySubagentRun({ ...r, schemaVersion: 1, toolCalls: [] })
  if (
    !legacy ||
    !IDENTITY_KEYS.every(
      (key) =>
        typeof r[key] === 'string' &&
        (OPTIONAL_LEGACY_IDENTITY.has(key) || r[key]) &&
        (r[key] as string).length <= 4096
    )
  )
    return undefined
  const indexed = new Map<string, SubagentToolSummary>()
  for (const rawCall of r.toolCalls) {
    const call = normalizeSummary(rawCall, r.lastSeq)
    if (!call) return undefined
    const before = indexed.get(call.id)
    if (before && JSON.stringify(before) !== JSON.stringify(call)) return undefined
    indexed.set(call.id, call)
  }
  const calls = [...indexed.values()]
  const coverage = normalizeCoverage(r.coverage, r.lastSeq, calls)
  if (
    !coverage ||
    r.toolCount !== coverage.toolCount ||
    r.activeToolCount !== coverage.activeToolCount
  )
    return undefined
  const latestActivity =
    r.latestActivity === undefined ? undefined : normalizeSummary(r.latestActivity, r.lastSeq)
  if (r.latestActivity !== undefined && !latestActivity) return undefined
  if (latestActivity?.status === 'running' && r.activeToolCount === 0) return undefined
  return boundSubagentView({
    ...legacy,
    schemaVersion: 2,
    view: 'summary',
    toolCalls: calls,
    coverage,
    toolCount: r.toolCount,
    activeToolCount: r.activeToolCount,
    latestActivity,
    recoveryRequired: r.recoveryRequired === true
  })
}

export function normalizeSubagentDeltaEvent(raw: unknown): SubagentDeltaEvent | undefined {
  const r = record(raw)
  const identity = record(r?.identity)
  const patch = record(r?.headerPatch)
  if (
    !r ||
    r.schemaVersion !== 2 ||
    typeof r.runId !== 'string' ||
    !r.runId ||
    r.runId.length > 1024 ||
    typeof r.kind !== 'string' ||
    !integer(r.seq) ||
    !integer(r.baseSeq) ||
    r.seq !== r.baseSeq + 1 ||
    !identity ||
    !patch ||
    !IDENTITY_KEYS.every(
      (key) =>
        typeof identity[key] === 'string' &&
        (OPTIONAL_LEGACY_IDENTITY.has(key) || identity[key]) &&
        (identity[key] as string).length <= 4096
    ) ||
    (patch.lastSeq !== undefined && patch.lastSeq !== r.seq) ||
    (patch.runId !== undefined && patch.runId !== r.runId) ||
    IDENTITY_KEYS.some((key) => patch[key] !== undefined && patch[key] !== identity[key]) ||
    ['schemaVersion', 'view', 'toolCalls', 'coverage'].some((key) => key in patch)
  )
    return undefined
  if (
    ![
      'created',
      'started',
      'cancelling',
      'tool.started',
      'tool.completed',
      'usage.updated',
      'output.updated',
      'finished'
    ].includes(r.kind)
  )
    return undefined
  if (['tool.started', 'tool.completed'].includes(r.kind) && r.toolUpsert === undefined)
    return undefined
  if (
    (patch.status !== undefined && !STATUSES.includes(patch.status as SubagentRunStatus)) ||
    [
      'toolCount',
      'activeToolCount',
      'updatedAt',
      'createdAt',
      'startedAt',
      'finishedAt',
      'durationMs'
    ].some((key) => patch[key] !== undefined && !integer(patch[key])) ||
    (patch.usage !== undefined && !validUsage(patch.usage))
  )
    return undefined
  if (
    ['transcriptRef', 'agentId', 'resumeFromRunId'].some(
      (key) =>
        patch[key] !== undefined &&
        (typeof patch[key] !== 'string' || (patch[key] as string).length > 4096)
    )
  )
    return undefined
  const coverage = r.coverage === undefined ? undefined : normalizeCoverage(r.coverage, r.seq)
  if (r.coverage !== undefined && !coverage) return undefined
  const toolUpsert = r.toolUpsert === undefined ? undefined : normalizeSummary(r.toolUpsert, r.seq)
  if (r.toolUpsert !== undefined && (!toolUpsert || toolUpsert.revisionSeq !== r.seq))
    return undefined
  const header = record(r.header)
  if (
    r.header !== undefined &&
    (!header ||
      header.runId !== r.runId ||
      header.lastSeq !== r.seq ||
      IDENTITY_KEYS.some((key) => header[key] !== identity[key]))
  )
    return undefined
  return {
    schemaVersion: 2,
    kind: r.kind,
    runId: r.runId,
    seq: r.seq,
    baseSeq: r.baseSeq,
    identity: identity as unknown as SubagentIdentity,
    header: header as unknown as SubagentDeltaEvent['header'],
    headerPatch: patch,
    toolUpsert,
    coverage
  }
}

export function normalizeSubagentEvent(raw: unknown): SubagentEvent | undefined {
  const r = record(raw)
  const snapshot = normalizeLegacySubagentRun(r?.snapshot)
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

export type SubagentReduceStatus = 'applied' | 'verified-duplicate' | 'gap' | 'invalid'
export interface SubagentReduceResult {
  status: SubagentReduceStatus
  run?: SubagentRun
  reason?: string
}

function deltaIdentity(event: SubagentDeltaEvent, run: SubagentRun): boolean {
  return event.runId === run.runId && IDENTITY_KEYS.every((key) => event.identity[key] === run[key])
}

/** Apply one v2 delta only at its exact base sequence; gaps are recoverable, never skipped. */
export function reduceSubagentDelta(
  previous: SubagentRun | undefined,
  raw: unknown
): SubagentReduceResult {
  const event = normalizeSubagentDeltaEvent(raw)
  if (!event) return { status: 'invalid', reason: 'invalid subagent delta' }
  if (!previous) {
    if (!event.header || event.kind !== 'created' || event.baseSeq !== 0)
      return { status: 'gap', reason: 'delta has no creation header' }
    const header = event.header as SubagentRunView
    if (header.lastSeq !== event.seq || header.runId !== event.runId)
      return { status: 'invalid', reason: 'header identity mismatch' }
    const coverage = event.coverage ?? {
      asOfSeq: event.seq,
      toolCount: header.toolCount,
      includedToolCount: 0,
      activeToolCount: header.activeToolCount,
      includedActiveToolCount: 0,
      ids: [],
      hasMore: header.toolCount > 0,
      truncated: header.toolCount > 0,
      completeness: 'partial' as const
    }
    const seeded = normalizeSubagentRun({
      ...header,
      schemaVersion: 2,
      view: 'summary',
      toolCalls: [],
      coverage
    })
    if (!seeded || seeded.schemaVersion !== 2)
      return { status: 'invalid', reason: 'invalid creation header' }
    return { status: 'applied', run: mergeDeltaView(seeded, event) }
  }
  if (!deltaIdentity(event, previous))
    return { status: 'invalid', reason: 'run or tenant identity mismatch' }
  if (event.seq <= previous.lastSeq) {
    // The same seq is valid only when it carries no contradictory scalar/tool revision.
    if (event.seq === previous.lastSeq) {
      const patch = event.headerPatch
      const currentView = toSubagentView(previous)
      const candidate = normalizeSubagentRun({
        ...currentView,
        ...event.header,
        ...patch,
        schemaVersion: 2,
        view: 'summary',
        toolCalls: currentView.toolCalls,
        coverage: currentView.coverage
      })
      if (!candidate || candidate.schemaVersion !== 2 || !sameScalar(currentView, candidate))
        return { status: 'invalid', reason: 'same-seq scalar conflict' }
    }
    if (event.seq === previous.lastSeq && event.toolUpsert) {
      const current = previous.toolCalls.find((call) => call.id === event.toolUpsert!.id)
      if (current && JSON.stringify(current) !== JSON.stringify(event.toolUpsert))
        return { status: 'invalid', reason: 'same-seq tool conflict' }
      if (!current)
        return {
          status: 'gap',
          run: previous,
          reason: 'duplicate tool is outside verified coverage'
        }
    }
    return { status: 'verified-duplicate', run: previous }
  }
  if (event.baseSeq !== previous.lastSeq || event.seq !== previous.lastSeq + 1)
    return { status: 'gap', run: previous, reason: 'delta base sequence gap' }
  const current = toSubagentView(previous)
  if (
    !isSubagentActive(previous.status) &&
    event.headerPatch.status !== undefined &&
    event.headerPatch.status !== previous.status
  )
    return { status: 'invalid', run: previous, reason: 'terminal run status cannot change' }
  const currentTool =
    event.toolUpsert && current.toolCalls.find((call) => call.id === event.toolUpsert!.id)
  if (currentTool && currentTool.status !== 'running' && event.toolUpsert?.status === 'running')
    return { status: 'invalid', run: previous, reason: 'terminal tool cannot return to running' }
  const nextToolCount = event.headerPatch.toolCount ?? current.toolCount
  const nextActiveCount = event.headerPatch.activeToolCount ?? current.activeToolCount
  if (
    nextToolCount < current.toolCount ||
    nextActiveCount > nextToolCount ||
    (event.coverage &&
      (event.coverage.toolCount !== nextToolCount ||
        event.coverage.activeToolCount !== nextActiveCount))
  )
    return { status: 'invalid', run: previous, reason: 'delta counter conflict' }
  const next = mergeDeltaView(current, event)
  if (next.toolCalls.filter((call) => call.status === 'running').length > next.activeToolCount)
    return { status: 'invalid', run: previous, reason: 'delta active tool count conflict' }
  return { status: 'applied', run: next }
}

function mergeDeltaView(view: SubagentRunView, event: SubagentDeltaEvent): SubagentRunView {
  const patch = event.headerPatch as Partial<SubagentRunView>
  const byId = new Map(view.toolCalls.map((call) => [call.id, call]))
  if (
    event.toolUpsert &&
    (isSubagentActive(view.status) || event.toolUpsert.status !== 'running')
  ) {
    const before = byId.get(event.toolUpsert.id)
    if (!before || event.toolUpsert.revisionSeq >= before.revisionSeq)
      byId.set(
        event.toolUpsert.id,
        before && before.status !== 'running'
          ? {
              ...event.toolUpsert,
              status: before.status,
              finishedAt: before.finishedAt,
              output: event.toolUpsert.output ?? before.output
            }
          : event.toolUpsert
      )
  }
  const calls = [...byId.values()]
  const next: SubagentRunView = {
    ...view,
    ...patch,
    schemaVersion: 2,
    view: 'summary',
    lastSeq: event.seq,
    status: !isSubagentActive(view.status)
      ? view.status
      : view.status === 'cancelling' && (patch.status === 'queued' || patch.status === 'running')
        ? 'cancelling'
        : (patch.status ?? view.status),
    usage: patch.usage ? mergeUsage(view.usage, normalizeUsage(patch.usage)) : view.usage,
    finishedAt: isSubagentActive(view.status)
      ? (patch.finishedAt ?? view.finishedAt)
      : view.finishedAt,
    activeToolCount: !isSubagentActive(view.status)
      ? view.activeToolCount
      : (patch.activeToolCount ?? view.activeToolCount),
    toolCalls: calls,
    coverage: event.coverage ?? {
      ...view.coverage,
      asOfSeq: event.seq,
      ids: calls.map((call) => call.id),
      includedToolCount: calls.length,
      includedActiveToolCount: calls.filter((call) => call.status === 'running').length
    },
    latestActivity:
      event.toolUpsert && byId.get(event.toolUpsert.id)
        ? byId.get(event.toolUpsert.id)
        : view.latestActivity
  }
  if (event.kind === 'finished' && !isSubagentActive(next.status) && next.activeToolCount === 0) {
    const finishTool = (call: SubagentToolSummary): SubagentToolSummary =>
      call.status !== 'running'
        ? call
        : {
            ...call,
            status: 'cancelled',
            revisionSeq: event.seq,
            finishedAt: next.finishedAt ?? next.updatedAt,
            detailRef: `/subagent/runs/${encodeURIComponent(event.runId)}/tools/${encodeURIComponent(call.id)}?atSeq=${event.seq}`
          }
    next.toolCalls = next.toolCalls.map(finishTool)
    if (next.latestActivity) next.latestActivity = finishTool(next.latestActivity)
  }
  next.coverage = { ...next.coverage, asOfSeq: event.seq }
  return boundSubagentView(next)
}

export function isSubagentActive(status: SubagentRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling'
}

function isView(run: SubagentRun): run is SubagentRunView {
  return run.schemaVersion === 2
}

function mergeSubagentView(
  previous: SubagentRunView | undefined,
  incoming: SubagentRunView
): SubagentRunView {
  if (!previous) return boundSubagentView(incoming)
  if (!sameRunIdentity(previous, incoming)) return previous
  if (incoming.lastSeq < previous.lastSeq) return previous
  if (incoming.lastSeq === previous.lastSeq) {
    // Same watermark may enrich coverage, but scalar conflicts cannot be resolved by arrival order.
    if (!sameScalar(previous, incoming)) {
      return { ...previous, recoveryRequired: true }
    }
  }
  const incomingIds = new Set(incoming.toolCalls.map((call) => call.id))
  const byId = new Map(
    previous.toolCalls
      .filter(
        (call) =>
          incoming.lastSeq === previous.lastSeq ||
          call.status !== 'running' ||
          incomingIds.has(call.id)
      )
      .map((call) => [call.id, call])
  )
  for (const call of incoming.toolCalls) {
    const before = byId.get(call.id)
    if (!before || call.revisionSeq > before.revisionSeq)
      byId.set(
        call.id,
        before && before.status !== 'running'
          ? {
              ...call,
              status: before.status,
              finishedAt: before.finishedAt,
              output: call.output ?? before.output
            }
          : call
      )
    else if (
      call.revisionSeq === before.revisionSeq &&
      JSON.stringify(call) !== JSON.stringify(before)
    )
      return { ...previous, recoveryRequired: true }
  }
  const latest =
    incoming.latestActivity &&
    (!previous.latestActivity ||
      incoming.latestActivity.revisionSeq >= previous.latestActivity.revisionSeq)
      ? incoming.latestActivity
      : previous.latestActivity
  const merged: SubagentRunView = {
    ...previous,
    ...incoming,
    toolCalls: [...byId.values()],
    latestActivity: latest,
    status: isSubagentActive(previous.status) ? incoming.status : previous.status,
    usage: mergeUsage(previous.usage, incoming.usage),
    startedAt: previous.startedAt ?? incoming.startedAt,
    finishedAt: isSubagentActive(previous.status) ? incoming.finishedAt : previous.finishedAt,
    recoveryRequired: incoming.recoveryRequired
  }
  const bounded = boundSubagentView(merged)
  return JSON.stringify(bounded) === JSON.stringify(previous) ? previous : bounded
}

function sameRunIdentity(a: SubagentRun, b: SubagentRun): boolean {
  return a.runId === b.runId && IDENTITY_KEYS.every((key) => a[key] === b[key])
}

function sameScalar(a: SubagentRunView, b: SubagentRunView): boolean {
  return (
    [
      'status',
      'createdAt',
      'updatedAt',
      'startedAt',
      'finishedAt',
      'durationMs',
      'toolCount',
      'activeToolCount',
      'task',
      'description',
      'modelId',
      'agentId',
      'agentName',
      'resumeFromRunId',
      'transcriptRef',
      'continuation',
      'error',
      'stopReason',
      'resultSummary',
      'partialOutput',
      'externalEffectStatus',
      'usage'
    ] as const
  ).every((key) =>
    key === 'usage'
      ? (
          [
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'estimated',
            'unknown'
          ] as const
        ).every(
          (usageKey) =>
            a.usage[usageKey] === undefined ||
            b.usage[usageKey] === undefined ||
            a.usage[usageKey] === b.usage[usageKey]
        )
      : a[key] === undefined ||
        b[key] === undefined ||
        JSON.stringify(a[key]) === JSON.stringify(b[key])
  )
}

export function reduceSubagentEvent(
  previous: SubagentRun | undefined,
  raw: unknown
): SubagentReduceResult {
  const eventRecord = record(raw)
  if (eventRecord?.schemaVersion === 2 && eventRecord.kind === 'snapshot') {
    const view = normalizeSubagentRun(eventRecord.view)
    if (
      !view ||
      view.schemaVersion !== 2 ||
      eventRecord.runId !== view.runId ||
      eventRecord.seq !== view.lastSeq
    )
      return { status: 'invalid', reason: 'invalid summary checkpoint' }
    return reduceSubagentRun(previous, view)
  }
  if (eventRecord?.schemaVersion === 2) return reduceSubagentDelta(previous, raw)
  const event = normalizeSubagentEvent(raw)
  if (!event) return { status: 'invalid', reason: 'invalid legacy event' }
  if (previous && !sameRunIdentity(previous, event.snapshot))
    return { status: 'invalid', reason: 'legacy run identity mismatch' }
  if (previous && event.seq <= previous.lastSeq) {
    if (event.seq === previous.lastSeq && previous.status !== event.snapshot.status)
      return { status: 'invalid', reason: 'legacy same-seq scalar conflict' }
    return { status: 'verified-duplicate', run: previous }
  }
  // A v1 event is an authoritative complete snapshot and can bridge older sequence gaps.
  return { status: 'applied', run: mergeSubagentRun(previous, event.snapshot) }
}

export function reduceSubagentRun(
  previous: SubagentRun | undefined,
  raw: unknown
): SubagentReduceResult {
  const incoming = normalizeSubagentRun(raw)
  if (!incoming) return { status: 'invalid', reason: 'invalid subagent view' }
  if (previous && !sameRunIdentity(previous, incoming))
    return { status: 'invalid', reason: 'view identity mismatch' }
  if (previous && incoming.lastSeq < previous.lastSeq)
    return { status: 'verified-duplicate', run: previous }
  if (
    previous &&
    previous.lastSeq === incoming.lastSeq &&
    (previous.schemaVersion === 2 || incoming.schemaVersion === 2) &&
    !sameScalar(toSubagentView(previous), toSubagentView(incoming))
  )
    return { status: 'invalid', run: previous, reason: 'same-seq scalar conflict' }
  const next = mergeSubagentRun(previous, incoming)
  if (next.schemaVersion === 2 && next.recoveryRequired && !previous)
    return { status: 'gap', run: next, reason: 'view requires recovery' }
  if (
    next.schemaVersion === 2 &&
    next.recoveryRequired &&
    previous?.schemaVersion === 2 &&
    !previous.recoveryRequired
  )
    return { status: 'invalid', run: previous, reason: 'same-revision tool conflict' }
  return { status: next === previous ? 'verified-duplicate' : 'applied', run: next }
}

function mergeUsage(previous: SubagentUsage, incoming: SubagentUsage): SubagentUsage {
  const usage: SubagentUsage = {
    ...previous,
    ...incoming,
    estimated: incoming.estimated ?? previous.estimated,
    unknown: incoming.unknown ?? previous.unknown
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ] as const) {
    const before = previous[key],
      next = incoming[key]
    usage[key] = before === undefined ? next : next === undefined ? before : Math.max(before, next)
  }
  return usage
}

/** seq gates duplicates; a late progress snapshot may enrich a terminal run but never revive it. */
export function mergeSubagentRun(
  previous: SubagentRun | undefined,
  incoming: SubagentRun
): SubagentRun {
  if (!previous) return incoming
  if (isView(previous) || isView(incoming))
    return mergeSubagentView(toSubagentView(previous), toSubagentView(incoming))
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
  const toolCalls: SubagentToolCall[] = [...previous.toolCalls]
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
  if (tool.subagentDeletion) return '记录已删除'
  const commandFailure = commandFailureLabel(tool)
  if (commandFailure) return commandFailure
  if (tool.commandJob) return commandJobDisplayLabel(tool.commandJob)
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
export function applySubagentDeletions(messages: ChatMessage[], refs: readonly SubagentDiscoveryRef[]): ChatMessage[] {
  const deleted = refs.filter(ref => ref.deleted)
  if (!deleted.length) return messages
  let changed = false
  const result = messages.map(message => {
    const tools = message.tools.map(tool => {
      const ref = deleted.find(ref => tool.id === ref.parentToolCallId && (
        tool.subagent
          ? ['runId', 'tenantId', 'parentSessionId', 'rootSessionId', 'parentConversationId', 'parentToolCallId', 'childSessionId']
            .every(key => tool.subagent![key as keyof SubagentRun] === ref[key as keyof SubagentDiscoveryRef])
          : tool.name === 'subagent' && !tool.subagentDeletion &&
            (message.id === ref.parentMessageId || message.conversationId === ref.parentConversationId)
      ))
      if (!ref || tool.subagentDeletion) return tool
      changed = true
      // Keep the invocation for diagnostics, but retire its actionable card.
      // A later cached snapshot must not turn the same dispatch back to running.
      return { ...tool, subagentDeletion: ref, state: 'unknown' as const, hidden: true }
    })
    return tools.some((tool, index) => tool !== message.tools[index]) ? { ...message, tools } : message
  })
  return changed ? result : messages
}

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
    // A recovered prefix has fixed child evidence; independent inventory may be newer.
    if (message.publishedChildFence) continue
    const index = message.tools.findIndex((tool) => tool.id === incoming.parentToolCallId)
    const previous = index >= 0 ? message.tools[index] : undefined
    if (previous?.subagentDeletion) continue
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
        `  - ${toolDisplayName(call.name)}（${call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '运行中'}）${call.error?.message ? `：${call.error.message}` : ''}`
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
