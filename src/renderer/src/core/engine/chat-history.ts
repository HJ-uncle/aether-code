import type { ChatMessage, TimelineItem, ToolActivity } from './useChat'
import {
  errorText,
  mergeSubagentRun,
  normalizeSubagentRun,
  runToolState,
  toolResultState
} from './subagent-state'

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * 回放时合并用量帧。
 *
 * 引擎的流式 `__usage__` 帧下发的是**整个提问的累计值**（一轮 ReAct 里每次
 * 迭代都会重新下发全量累计），而落库时每条 assistant 行只存**该次迭代的增量**。
 * 回放如果按「后一行覆盖前一行」取用量，整轮的消耗就被压成最后一次迭代的量
 * —— 与生成期间看到的累计值差一个数量级（重启后 282k 变 10.4k 就是这么来的）。
 *
 * 这里改为按字段累加：同一轮内多条 assistant 行的增量相加，还原出与实时帧
 * 同口径的累计值。字段可能缺失（老数据 / 非 DeepSeek 模型），缺的跳过。
 */
function mergeUsageFrame(previous: unknown, next: unknown): Record<string, number> {
  const base = asNumberRecord(previous)
  for (const [key, value] of Object.entries(asNumberRecord(next))) {
    base[key] = (base[key] ?? 0) + value
  }
  return base
}

function asNumberRecord(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return result
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  return result
}

/**
 * 引擎 conversations 表回放行（GET /conversation/history 的 data 项）。
 *
 * 字段按引擎 rowToMessage 的输出宽松声明：user/assistant 的 content 可能是
 * multipart 数组（JSON.parse 过），assistant 行可携带发起的 toolCall，
 * 工具结果以 role=tool 的独立行跟随其后。
 */
export interface EngineHistoryRow {
  id?: string
  role?: string
  content?: unknown
  reasoningContent?: unknown
  usage?: unknown
  createdAt?: number
  modelId?: string
  /** 所属轮次 id（引擎 conversations 表的 conversation_id），删除整轮时定位用 */
  conversationId?: string
  toolCallId?: unknown
  toolCall?: { id?: string; name?: string; args?: unknown } | null
  success?: boolean
  error?: unknown
  metadata?: { subagent?: unknown; success?: boolean; error?: unknown }
  isSidechain?: boolean
}

/**
 * 把引擎存的 content 还原为可读文本。
 *
 * user/assistant 的 content 可能是 multipart 数组（文本+图片等混合），
 * 渲染层只关心文本块；纯非文本内容时标注类型，避免显示成空白。
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') {
    // 历史数据里存在把 multipart 结构整体 JSON.stringify 后当字符串存进来的情况
    // （会话列表曾直接显示 [{"role":"user","content":"… 原文）。看起来像 JSON 时
    // 先尝试解析回结构化内容再走正常提取。
    const trimmed = content.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
          const text = extractText(parsed)
          if (text) return text
        }
      } catch {
        // 不是合法 JSON，按纯文本处理
      }
    }
    return content
  }
  if (Array.isArray(content)) {
    // 消息结构数组（[{role, content}]）：取最后一条的文本
    if (
      content.length > 0 &&
      content.every(
        (part) => part && typeof part === 'object' && 'role' in (part as Record<string, unknown>)
      )
    ) {
      return extractText((content[content.length - 1] as Record<string, unknown>).content)
    }
    const texts = content
      .filter(
        (part) =>
          part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
      )
      .map((part) => String((part as Record<string, unknown>).text ?? ''))
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
    const kinds = content
      .map((part) =>
        part && typeof part === 'object'
          ? String((part as Record<string, unknown>).type ?? 'unknown')
          : 'unknown'
      )
      .filter((kind) => kind !== 'text')
    return kinds.length > 0 ? `[${kinds.join('、')}内容]` : ''
  }
  // 单条消息结构（{role, content}）：提取其 content 文本
  if (content && typeof content === 'object' && 'content' in (content as Record<string, unknown>)) {
    return extractText((content as Record<string, unknown>).content)
  }
  return content == null ? '' : String(content)
}

/**
 * 把引擎历史行回放成 ChatMessage[]。
 *
 * 对齐 SSE 渲染的语义：assistant 行生成消息并登记其工具调用，随后的
 * role=tool 行按 toolCallId 回填结果；system 行（压缩摘要）不对外展示。
 */
export function replayMessages(rows: EngineHistoryRow[]): ChatMessage[] {
  const result: ChatMessage[] = []
  /** 尚未收到结果的工具调用，按 toolCallId 索引，用于回填 tool 结果行 */
  const openTools = new Map<string, { message: ChatMessage; index: number }>()

  for (const row of rows) {
    if (row.role === 'system' || row.isSidechain === true) continue
    const createdAt = Number(row.createdAt) || 0

    if (row.role === 'user') {
      result.push({
        id: row.id || newId(),
        role: 'user',
        content: extractText(row.content),
        thinking: '',
        tools: [],
        items: [],
        status: 'done',
        createdAt
      })
      continue
    }

    if (row.role === 'tool') {
      const toolCallId = typeof row.toolCallId === 'string' ? row.toolCallId : ''
      const open = toolCallId ? openTools.get(toolCallId) : undefined
      if (open) {
        const previous = open.message.tools[open.index]
        const subagent = normalizeSubagentRun(row.metadata?.subagent)
        open.message.tools[open.index] = {
          ...previous,
          result: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
          state: subagent ? runToolState(subagent) : toolResultState(row, previous.name),
          error: subagent?.error?.message ?? errorText(row.error ?? row.metadata?.error),
          subagent
        }
        openTools.delete(toolCallId)
      }
      continue
    }

    if (row.role !== 'assistant') continue
    // 一轮 ReAct 会存成多条 assistant 行（每次工具调用截断一次）。
    // 对齐 wuzu-client：同一轮（conversationId 相同或紧邻）的 assistant 行
    // 合并回一条消息，过程块收成同一个折叠块，正文只在轮末出现一次。
    const prev = result[result.length - 1]
    const sameTurn =
      prev &&
      prev.role === 'assistant' &&
      (!row.conversationId || !prev.conversationId || row.conversationId === prev.conversationId)
    let message: ChatMessage
    if (sameTurn) {
      message = prev
      if (message.content) {
        // 前一段正文已在 items 里，新内容另起一段，避免拼接粘连
        message.content = `${message.content}\n\n`
      }
      // 轮内后续行时间更晚：更新为「本轮已知的最后时刻」，
      // 供历史回放后「任务耗时」用 startedAt~endedAt 跨度计算
      if (createdAt > (message.endedAt ?? 0)) message.endedAt = createdAt
    } else {
      message = {
        id: row.id || newId(),
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        items: [],
        status: 'done',
        createdAt,
        // 回放场景没有真实的流式起止点，用首行/末行 createdAt 兜底
        startedAt: createdAt,
        ...(row.conversationId ? { conversationId: row.conversationId } : {})
      }
      result.push(message)
    }
    if (row.modelId && !message.modelId) message.modelId = row.modelId
    if (row.usage) message.usage = mergeUsageFrame(message.usage, row.usage)
    message.thinking += typeof row.reasoningContent === 'string' ? row.reasoningContent : ''

    // 本行的时间线条目：按「思考 → 工具 → 正文」的近似顺序穿插进同一条消息
    const rowItems: TimelineItem[] = []
    const rowThinking = typeof row.reasoningContent === 'string' ? row.reasoningContent : ''
    if (rowThinking) rowItems.push({ kind: 'thinking', text: rowThinking })
    if (row.toolCall && typeof row.toolCall === 'object' && row.toolCall.name) {
      const tool: ToolActivity = {
        id: row.toolCall.id || newId(),
        name: row.toolCall.name,
        args: JSON.stringify(row.toolCall.args ?? {}, null, 2),
        result: '',
        state: row.toolCall.name === 'subagent' ? 'unknown' : 'done'
      }
      message.tools.push(tool)
      rowItems.push({ kind: 'tool', id: tool.id })
      if (tool.id) openTools.set(tool.id, { message, index: message.tools.length - 1 })
    }
    const rowContent = extractText(row.content)
    if (rowContent) {
      message.content += rowContent
      rowItems.push({ kind: 'content', text: rowContent })
    }
    message.items.push(...rowItems)
  }

  return result
}

/**
 * 工具帧负载归一化。
 *
 * 引擎的 toolStart/toolCall/toolResult 等帧由工具层自行构造，字段名不完全统一，
 * 这里做一层容错提取，避免某个字段改名直接让 UI 空白。
 */
export function normalizeTool(raw: unknown): Partial<ToolActivity> {
  if (!raw || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>

  const readString = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
      if (value !== undefined && value !== null && typeof value === 'object') {
        try {
          return JSON.stringify(value, null, 2)
        } catch {
          return String(value)
        }
      }
    }
    return ''
  }

  return {
    id: readString('id', 'toolCallId', 'tool_call_id', 'callId', 'call_id'),
    name: readString('name', 'toolName', 'tool'),
    args: readString('args', 'arguments', 'input', 'params'),
    result: readString('output', 'result', 'content', 'text'),
    error: errorText(
      record.error ??
        (record.metadata && typeof record.metadata === 'object'
          ? (record.metadata as Record<string, unknown>).error
          : undefined)
    ),
    subagent: normalizeSubagentRun(
      record.subagent ??
        (record.metadata && typeof record.metadata === 'object'
          ? (record.metadata as Record<string, unknown>).subagent
          : undefined)
    )
  }
}

export function finishTool(previous: ToolActivity, raw: unknown): ToolActivity {
  const normalized = normalizeTool(raw)
  const subagent = normalized.subagent
    ? mergeSubagentRun(previous.subagent, normalized.subagent)
    : previous.subagent
  return {
    ...previous,
    name: normalized.name || previous.name,
    result:
      subagent?.resultSummary ?? subagent?.partialOutput ?? (normalized.result || previous.result),
    state: subagent
      ? runToolState(subagent)
      : toolResultState(raw, normalized.name || previous.name),
    error: subagent?.error?.message ?? normalized.error,
    subagent
  }
}

/** Late tool results belong to the original dispatch, not the last assistant of a newer turn. */
export function applyToolResult(messages: ChatMessage[], raw: unknown): ChatMessage[] {
  const id = normalizeTool(raw).id
  if (!id) return messages
  const owner = messages.findIndex((message) => message.tools.some((tool) => tool.id === id))
  if (owner < 0) return messages
  const message = messages[owner]
  return messages.map((item, index) =>
    index !== owner
      ? item
      : {
          ...message,
          tools: message.tools.map((tool) => (tool.id === id ? finishTool(tool, raw) : tool))
        }
  )
}
