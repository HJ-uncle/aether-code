import type { RootRun } from '@shared/root-run'

export type SessionErrorContext = Pick<RootRun, 'status' | 'runId' | 'error' | 'stopReason'>

export interface SessionErrorPresentation {
  title: string
  summary: string
  detail: string
  /** A terminal Work error can be safely offered as a user initiated retry. */
  retryable: boolean
  status?: string
  runId?: string
  code?: string
}

const MAX_DETAIL_LENGTH = 16_000
const STATUS_LABELS: Record<string, string> = {
  queued: '排队中', running: '运行中', cancelling: '取消中', succeeded: '已完成',
  failed: '失败', cancelled: '已取消', blocked: '受阻', interrupted: '已中断', waiting: '等待处理'
}

export function sessionErrorStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function parseState(raw: string): Record<string, unknown> | undefined {
  const match = raw.match(/\[子任务状态\]\s*(\{[^\n]*\})/)
  if (!match) return undefined
  try {
    const value: unknown = JSON.parse(match[1])
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function modelResponseIssue(raw: string, state: Record<string, unknown> | undefined): 'output-limit' | 'incomplete-response' | undefined {
  const status = textField(state?.status)
  if (status && status !== 'failed' && status !== 'interrupted') return undefined
  const code = textField(state?.errorCode)?.toUpperCase()
  const stopReason = textField(state?.stopReason)?.toLowerCase()
  if (code === 'OUTPUT_LIMIT' || stopReason === 'output_limit') return 'output-limit'
  if (code === 'INCOMPLETE_RESPONSE' || stopReason === 'incomplete_response') return 'incomplete-response'
  // Older providers used the same sentence for multiple causes. Without the
  // structured reason, report only incompleteness, never guess a length limit.
  if (!code && !stopReason && raw === 'Model response ended before completion') return 'incomplete-response'
  return undefined
}

function knownReason(raw: string, state: Record<string, unknown> | undefined): string | undefined {
  // Structured terminal state is authoritative.  Do not let a successful
  // result that quotes an old error code become a new error card.
  const structured = `${textField(state?.errorCode) ?? ''} ${textField(state?.stopReason) ?? ''}`.trim()
  const haystack = (state ? structured : raw).toLowerCase()
  if (haystack.includes('engine_restarted') || haystack.includes('engine restarted')) return '引擎已重启，这次任务未能继续。'
  if (haystack.includes('empty_output') || haystack.includes('no final answer')) return '模型没有返回最终回答。请重试；若持续发生，请检查模型服务配置。'
  if (haystack.includes('context_limit') || haystack.includes('context limit')) return '任务超过了模型上下文容量。请缩小范围或从当前结果继续。'
  if (haystack.includes('output_limit') || haystack.includes('output limit')) return '模型本轮输出达到上限，已保留现有内容。可调整思考或输出设置后重试。'
  if (haystack.includes('incomplete_response') || haystack.includes('incomplete response')) return '模型响应提前结束，未返回完整结果。'
  if (haystack.includes('timeout') || haystack.includes('timed out')) return '任务执行超时，已停止继续等待。请缩小范围或重新发起任务。'
  if (haystack.includes('step_limit') || haystack.includes('steps limit')) return '任务达到最大执行步骤，已停止继续运行。请拆分任务后重试。'
  if (haystack.includes('usage_limit') || haystack.includes('rate limit')) return '模型服务达到用量或速率限制，请稍后重试。'
  if (haystack.includes('authorization') || haystack.includes('needs approval')) return '任务正在等待授权，完成授权后可继续执行。'
  const status = textField(state?.status)
  // HTTP/SSE envelopes are provider diagnostics, not a user-facing answer.
  // A successful or pending structured state must not be reclassified from a
  // quoted transport error in its text; known structured reasons take priority.
  if ((!state || status === 'failed' || status === 'interrupted') && /^5\d{2}\s+(?:event:\s*error\b|(?:data:\s*)?\{)/i.test(raw)) {
    return '模型服务暂时异常，本次执行未完成。请稍后重试。'
  }
  return undefined
}

function humanSummary(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const explicit = lines.find(line => /^子代理(?:未完成|已取消|需要授权)[：:]/.test(line))
  if (explicit) return explicit.replace(/^子代理(?:未完成|已取消|需要授权)[：:]/, '').trim()
  return lines.find(line => !line.startsWith('[子代理最终结果') && !line.startsWith('[子任务状态]') &&
    !line.startsWith('以上为当前调用的机器状态') && !line.startsWith('原始诊断') && !line.startsWith('{') &&
    !/^部分结果(?:（[^）]+）)?[：:]/.test(line))
}

/** Convert raw engine/subagent error text into a concise, truthful Work notice. */
export function presentSessionError(rawValue: string, context?: SessionErrorContext): SessionErrorPresentation {
  const raw = rawValue.trim()
  // The durable root run takes precedence over protocol-like text quoted in
  // a diagnostic. Its original message remains available in the details.
  const state = context ? {
    status: context.status,
    runId: context.runId,
    errorCode: typeof context.error === 'object' ? context.error?.code : undefined,
    stopReason: context.stopReason
  } : parseState(raw)
  const status = textField(state?.status)
  const runId = textField(state?.runId)
  const code = textField(state?.errorCode)
  const stopReason = textField(state?.stopReason)
  const issue = modelResponseIssue(raw, state)
  const reason = issue === 'output-limit' ? '模型本轮输出达到上限，已保留现有内容。可调整思考或输出设置后重试。'
    : issue === 'incomplete-response' ? '模型响应提前结束，未返回完整结果。'
      : knownReason(raw, state)
  const explicit = humanSummary(raw)
  const title = status === 'cancelled' ? '任务已取消' : status === 'blocked' || status === 'waiting' ? '任务需要处理'
    : issue === 'output-limit' ? '模型输出达到上限' : issue === 'incomplete-response' ? '模型响应未完成'
      : status === 'interrupted' ? '任务已中断' : status === 'failed' ? '任务执行失败'
        : raw.includes('连接已结束') ? '任务连接已结束' : '任务执行出现问题'
  const summary = reason ?? explicit ?? (status === 'interrupted'
    ? '任务在执行过程中被中断。请查看诊断详情并重新发起任务。'
    : status === 'cancelled' ? '任务已停止，未继续执行。' : '引擎未提供具体原因，请查看诊断详情。')
  const original = typeof context?.error === 'string' ? context.error : context?.error?.message
  const diagnostic = original && original.trim() !== raw ? `${raw}\n\n运行原始错误：\n${original}` : raw
  const capped = diagnostic.length > MAX_DETAIL_LENGTH
    ? `${diagnostic.slice(0, MAX_DETAIL_LENGTH)}\n\n…诊断信息过长，已折叠其余 ${diagnostic.length - MAX_DETAIL_LENGTH} 个字符。` : diagnostic
  const detail = [status ? `状态：${sessionErrorStatusLabel(status)}` : '', runId ? `运行 ID：${runId}` : '',
    code ? `错误码：${code}` : '', stopReason ? `停止原因：${stopReason}` : '', `原始诊断：\n${capped}`].filter(Boolean).join('\n')
  // Waiting/blocked states still have an outstanding interaction or require a
  // user decision. Replaying the original request from an error card would
  // create a second run and can duplicate side effects, so those surfaces only
  // expose diagnostics (the pending card owns its real response action).
  const retryable = status !== 'waiting' && status !== 'blocked'
  return { title, summary, detail, retryable, status, runId, code }
}
