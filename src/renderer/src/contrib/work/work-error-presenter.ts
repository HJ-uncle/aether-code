export interface WorkErrorPresentation {
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

export function workErrorStatusLabel(status: string): string {
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

function knownReason(raw: string, state: Record<string, unknown> | undefined): string | undefined {
  // Structured terminal state is authoritative.  Do not let a successful
  // result that quotes an old error code become a new error card.
  const structured = `${textField(state?.errorCode) ?? ''} ${textField(state?.stopReason) ?? ''}`.trim()
  const haystack = (state ? structured : raw).toLowerCase()
  if (haystack.includes('engine_restarted') || haystack.includes('engine restarted')) return '引擎已重启，任务执行未自动恢复。之前的副作用状态无法安全接管，请重新发起任务。'
  if (haystack.includes('empty_output') || haystack.includes('no final answer')) return '模型没有返回最终回答。请重试；若持续发生，请检查模型服务配置。'
  if (haystack.includes('context_limit') || haystack.includes('context limit')) return '任务超过了模型上下文容量。请缩小范围或从当前结果继续。'
  if (haystack.includes('output_limit') || haystack.includes('output limit')) return '模型输出达到长度上限，任务只保留了部分结果。'
  if (haystack.includes('timeout') || haystack.includes('timed out')) return '任务执行超时，已停止继续等待。请缩小范围或重新发起任务。'
  if (haystack.includes('step_limit') || haystack.includes('steps limit')) return '任务达到最大执行步骤，已停止继续运行。请拆分任务后重试。'
  if (haystack.includes('usage_limit') || haystack.includes('rate limit')) return '模型服务达到用量或速率限制，请稍后重试。'
  if (haystack.includes('authorization') || haystack.includes('needs approval')) return '任务正在等待授权，完成授权后可继续执行。'
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
export function presentWorkError(rawValue: string): WorkErrorPresentation {
  const raw = rawValue.trim()
  const state = parseState(raw)
  const status = textField(state?.status)
  const runId = textField(state?.runId)
  const code = textField(state?.errorCode)
  const reason = knownReason(raw, state)
  const explicit = humanSummary(raw)
  const title = status === 'interrupted' ? '任务已中断' : status === 'cancelled' ? '任务已取消' :
    status === 'blocked' || status === 'waiting' ? '任务需要处理' : status === 'failed' ? '任务执行失败' :
      raw.includes('连接已结束') ? '任务连接已结束' : '任务执行出现问题'
  const summary = reason ?? explicit ?? (status === 'interrupted'
    ? '任务在执行过程中被中断。请查看诊断详情并重新发起任务。'
    : status === 'cancelled' ? '任务已停止，未继续执行。' : '引擎未提供具体原因，请查看诊断详情。')
  const capped = raw.length > MAX_DETAIL_LENGTH
    ? `${raw.slice(0, MAX_DETAIL_LENGTH)}\n\n…诊断信息过长，已折叠其余 ${raw.length - MAX_DETAIL_LENGTH} 个字符。` : raw
  const detail = [status ? `状态：${workErrorStatusLabel(status)}` : '', runId ? `运行 ID：${runId}` : '',
    code ? `错误码：${code}` : '', `原始诊断：\n${capped}`].filter(Boolean).join('\n')
  // Waiting/blocked states still have an outstanding interaction or require a
  // user decision. Replaying the original request from an error card would
  // create a second run and can duplicate side effects, so those surfaces only
  // expose diagnostics (the pending card owns its real response action).
  const retryable = status !== 'waiting' && status !== 'blocked'
  return { title, summary, detail, retryable, status, runId, code }
}
