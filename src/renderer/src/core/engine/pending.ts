/**
 * 交互帧归一化（纯函数，无副作用，可直接单测）
 *
 * 引擎在流里会发出两类需要用户应答的帧，且**形状不统一** —— 这是历史包袱：
 *
 *   1. ask_user 工具：`{ question, options: [{label, description}], multiSelect, toolCallId }`
 *   2. 安全策略拦截：先发一个 ask_user 别名帧（options 是**字符串数组** ['approved','rejected']），
 *      再发 `{ requestId, toolName, args, description }`
 *
 * 应答方式只有一条路：再发一次 /chat 带 toolResponse，没有专用端点。
 *    - 提问：name = 'ask_user'，output = 所选 label
 *    - 授权：name = **被拦截的真实工具名**，output 必须精确等于 'approved' / 'rejected'
 *      （引擎侧是严格 === 匹配，写成别的值会被当成拒绝）
 *
 * 因此这里统一成同一形状，并把「回传时要用的工具名」一并算好，
 * UI 层不需要知道这些差异。
 */
import type { ChatSsePayload } from '@shared/ipc'

export interface PendingOption {
  /** 按钮上显示的文字 */
  label: string
  /** 回传给引擎的值（授权场景必须是 approved / rejected） */
  value: string
  description?: string
}

export interface PendingInteraction {
  kind: 'ask' | 'permission'
  question: string
  options: PendingOption[]
  /** 回传用的 toolCallId；授权场景即 permissionRequest.requestId */
  toolCallId: string
  /** 回传时 toolResponse.name 该填什么 */
  toolName: string
  multiSelect: boolean
}

/** 授权场景的固定选项：值必须与引擎严格匹配 */
export const PERMISSION_OPTIONS: PendingOption[] = [
  { label: '允许执行', value: 'approved' },
  { label: '拒绝', value: 'rejected' }
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * 把 asks 的 options 统一成对象数组。
 * 引擎两种形状都出现过：字符串数组 与 {label, description} 对象数组。
 */
function normalizeOptions(raw: unknown): PendingOption[] {
  if (!Array.isArray(raw)) return []

  const options: PendingOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      options.push({ label: item, value: item })
      continue
    }
    const record = asRecord(item)
    if (!record) continue

    const label = readString(record, 'label', 'title', 'text', 'value')
    if (!label) continue
    const description = readString(record, 'description', 'detail')
    options.push({ label, value: label, ...(description ? { description } : {}) })
  }
  return options
}

/**
 * 归一化一个 SSE 帧。
 *
 * 同时返回 permission 与 ask 两种可能的解析结果由调用方按 toolCallId 去重
 * （引擎对授权场景会连发两帧），见 mergePending。
 */
export function normalizePending(payload: ChatSsePayload): PendingInteraction | null {
  const permission = asRecord(payload.permissionRequest)
  if (permission) {
    const toolName = readString(permission, 'toolName', 'name') || 'unknown'
    const toolCallId = readString(permission, 'requestId', 'toolCallId', 'id')
    if (!toolCallId) return null

    // ask_user 的别名 permission 帧（引擎对真正的提问也会补发这一帧）不是安全拦截：
    // 真实的问题与选项都在 args 里，归一化成 ask，避免被套上「安全策略」的壳
    if (toolName === 'ask_user') {
      const args = asRecord(permission.args)
      if (args && (args.question || args.options)) return askInteraction(toolCallId, args)
    }

    const description = readString(permission, 'description', 'question', 'message')
    return {
      kind: 'permission',
      question: description || `安全策略拦截了 ${toolName}，是否允许执行？`,
      options: PERMISSION_OPTIONS,
      toolCallId,
      // 关键：授权回传必须用被拦截的真实工具名
      toolName,
      multiSelect: false
    }
  }

  const ask = asRecord(payload.ask_user)
  if (ask) {
    const toolCallId = readString(ask, 'toolCallId', 'tool_call_id', 'id')
    if (!toolCallId) return null
    return askInteraction(toolCallId, ask)
  }

  return null
}

/** 把 ask_user 负载（帧本体，或别名帧的 args）归一化成 ask 交互 */
function askInteraction(toolCallId: string, source: Record<string, unknown>): PendingInteraction {
  const options = normalizeOptions(source.options)
  return {
    kind: 'ask',
    question: readString(source, 'question', 'message') || '需要你的确认',
    // 没有选项时给一个"已完成"兜底，避免 UI 渲染出空按钮组
    options: options.length > 0 ? options : [{ label: '继续', value: '继续' }],
    toolCallId,
    toolName: 'ask_user',
    multiSelect: Boolean(source.multiSelect)
  }
}

/**
 * 合并待应答项。
 *
 * 引擎对安全拦截会连发两帧：ask_user 别名帧（options 是 approved/rejected 字符串）
 * 与 permission_request，两者 toolCallId 相同。别名帧已被 normalizePending 归一化成
 * ask，因此此处 permission 获胜只会发生在真实工具拦截场景 —— 它携带真实工具名，
 * 回传路由需要它。
 */
export function mergePending(
  current: PendingInteraction | undefined,
  incoming: PendingInteraction
): PendingInteraction {
  if (!current) return incoming
  if (current.toolCallId !== incoming.toolCallId) return incoming
  if (incoming.kind === 'permission') return incoming
  return current
}

/** 构造回传给引擎的 toolResponse（多选时把 label 逗号连接） */
export function buildToolResponse(
  pending: PendingInteraction,
  selectedValues: string[]
): { toolCallId: string; name: string; output: string } {
  // 回传用 value 而非 label：授权场景 value 才是引擎严格匹配的 approved/rejected，
  // 而 label 是给人看的中文
  const output = selectedValues.join(',')
  return { toolCallId: pending.toolCallId, name: pending.toolName, output }
}
