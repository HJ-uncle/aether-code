/**
 * 会话用量统计
 *
 * 引擎每轮结束会下发一份 usage 帧（QA 日志的同一份结构），字段很多且多为
 * 可选 —— 老后端可能缺字段，因此这里全部按可选处理，缺失即视为 0。
 * 界面需要的是「累计 + 分组」，分组口径与引擎 QA 日志一致：
 * 输入 promptTokens / 输出 completionTokens / 总 totalTokens。
 */
import type { ChatMessage } from '@renderer/core/engine/useChat'

/** 引擎下发的单轮用量帧（对齐 observability/qa-logger.ts 的 usage 结构） */
export interface UsageFrame {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** 输入构成（引擎侧细分，属于「输入」组） */
  systemPromptTokens?: number
  systemToolsTokens?: number
  messagesTokens?: number
  skillTokens?: number
  ragTokens?: number
  builtinToolsTokens?: number
  mcpToolsTokens?: number
  toolResultsTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  /** 输出细分（属于「输出」组） */
  reasoningTokens?: number
}

export interface UsageDetailRow {
  label: string
  /** 该字段是否属于输入组（用于染色） */
  group: 'input' | 'output'
  tokens: number
  /** 缩进的子项（输入的二级构成） */
  child?: boolean
}

export interface UsageTotal {
  /** 累计总 token（各轮 totalTokens 之和；引擎缺该字段时按输入+输出兜底） */
  total: number
  input: number
  output: number
  /** 已完成的轮次数（用于均摊与展示） */
  rounds: number
  /** 按累计值排序、只保留非零项的分组明细 */
  summary: UsageDetailRow[]
  /** 会话首次用量出现的时间 */
  startedAt?: number
  /** 最后一轮结束时间；仍在生成中则取当前已知值 */
  endedAt?: number
}

/** 把 unknown 的 usage 帧安全收窄成 UsageFrame（引擎字段可能缺失） */
export function asUsageFrame(raw: unknown): UsageFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const frame: UsageFrame = {}
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      frame[key as keyof UsageFrame] = value
    }
  }
  return Object.keys(frame).length > 0 ? frame : null
}

/** 明细行的展示顺序与标签（对齐引擎 QA 日志描述，便于两边对照排查） */
const DETAIL_ROWS: ReadonlyArray<{
  key: keyof UsageFrame
  label: string
  group: 'input' | 'output'
  child?: boolean
}> = [
  { key: 'promptTokens', label: '输入 Prompt', group: 'input' },
  { key: 'systemPromptTokens', label: '系统提示词', group: 'input', child: true },
  { key: 'messagesTokens', label: '对话历史', group: 'input', child: true },
  { key: 'toolResultsTokens', label: '工具结果', group: 'input', child: true },
  { key: 'builtinToolsTokens', label: '内置工具说明', group: 'input', child: true },
  { key: 'mcpToolsTokens', label: 'MCP 工具说明', group: 'input', child: true },
  { key: 'skillTokens', label: '技能 Prompt', group: 'input', child: true },
  { key: 'ragTokens', label: '知识库 RAG', group: 'input', child: true },
  { key: 'cacheHitTokens', label: '命中缓存', group: 'input', child: true },
  { key: 'cacheMissTokens', label: '未命中缓存', group: 'input', child: true },
  { key: 'completionTokens', label: '输出 Completion', group: 'output' },
  { key: 'reasoningTokens', label: '其中推理', group: 'output', child: true }
]

/**
 * 汇总整条会话的用量。
 *
 * 只统计 assistant 消息（usage 挂在那里）；用户消息不含用量。
 * startedAt/endedAt 取所有消息的极值，用于页脚显示「会话使用时间」。
 */
export function sumUsage(messages: ChatMessage[]): UsageTotal {
  const acc: Record<string, number> = {}
  let total = 0
  let rounds = 0
  let startedAt: number | undefined
  let endedAt: number | undefined

  for (const message of messages) {
    if (message.role !== 'assistant') continue

    if (message.startedAt && (startedAt === undefined || message.startedAt < startedAt)) {
      startedAt = message.startedAt
    }
    if (message.endedAt && (endedAt === undefined || message.endedAt > endedAt)) {
      endedAt = message.endedAt
    }

    const frame = asUsageFrame(message.usage)
    if (!frame) continue

    rounds += 1
    for (const [key, value] of Object.entries(frame)) {
      acc[key] = (acc[key] ?? 0) + (value as number)
    }
    total += frame.totalTokens ?? (frame.promptTokens ?? 0) + (frame.completionTokens ?? 0)
  }

  const summary = DETAIL_ROWS.map((row) => ({
    label: row.label,
    group: row.group,
    child: row.child,
    tokens: acc[row.key] ?? 0
  })).filter((row) => row.tokens > 0)

  return {
    total,
    input: acc.promptTokens ?? 0,
    output: acc.completionTokens ?? 0,
    rounds,
    summary,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {})
  }
}

/**
 * 一次用户提问 + 其后的全部 AI 输出 = 一个 turn
 *
 * 引擎一轮问答会拆成多条 assistant 消息（思考 / 执行命令 / 再思考 …），
 * 按用户消息切成组，才能给出"一问一答的总消耗"。
 */
export interface ChatTurn {
  /** 组内首条消息的 id，用作 React key */
  id: string
  messages: ChatMessage[]
  /** 该轮所有 assistant 消息的 token 累计 */
  tokens: number
  /** 该轮的明细行（口径同会话累计，供展开查看） */
  summary: UsageDetailRow[]
  /** 用户提问发起的时刻，用于展示「对话时间」 */
  askedAt: number
  /** 该轮最早的 assistant 开始时刻；缺失表示尚未开始 */
  startedAt?: number
  /** 该轮最晚的 assistant 结束时刻；缺失表示仍在进行中 */
  endedAt?: number
  /** 该轮实际使用的模型 id（取组内 assistant 消息的记名） */
  modelId?: string
}

export function groupIntoTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []

  const push = (message: ChatMessage, tokens: number): void => {
    turns.push({
      id: message.id,
      messages: [message],
      tokens,
      summary: [],
      askedAt: message.createdAt
    })
  }

  for (const message of messages) {
    const current = turns[turns.length - 1]
    // 用户提问开新的一组；assistant / 系统消息归入当前组
    if (message.role === 'user' || !current) {
      push(message, message.role === 'user' ? 0 : usageOf(message))
      continue
    }
    current.messages.push(message)
    current.tokens += usageOf(message)
  }

  // 组内逐条累计明细：明细行依赖全组求和，分组完成后才能算
  for (const turn of turns) {
    const acc: Record<string, number> = {}
    for (const message of turn.messages) {
      const frame = asUsageFrame(message.usage)
      if (!frame) continue
      for (const [key, value] of Object.entries(frame)) {
        acc[key] = (acc[key] ?? 0) + (value as number)
      }
    }
    turn.summary = DETAIL_ROWS.map((row) => ({
      label: row.label,
      group: row.group,
      child: row.child,
      tokens: acc[row.key] ?? 0
    })).filter((row) => row.tokens > 0)

    // 任务耗时取该轮 assistant 的最早开始 ~ 最晚结束
    let earliest = Number.POSITIVE_INFINITY
    let latest = Number.NEGATIVE_INFINITY
    for (const message of turn.messages) {
      if (message.role !== 'assistant') continue
      if (
        message.startedAt &&
        (turn.startedAt === undefined || message.startedAt < turn.startedAt)
      ) {
        turn.startedAt = message.startedAt
      }
      if (message.endedAt && (turn.endedAt === undefined || message.endedAt > turn.endedAt)) {
        turn.endedAt = message.endedAt
      }
      // 组内换了模型时以最后一条为准：同一轮中途换模型是异常路径，
      // 展示「最终生效的那个」比展示旧的更贴近实际
      if (message.modelId) turn.modelId = message.modelId
      // 回放历史时只有 createdAt（引擎不存逐轮的起止点），
      // 用组内消息的时间跨度兜底，否则「任务耗时」在重启后全部消失
      if (message.createdAt) {
        if (message.createdAt < earliest) earliest = message.createdAt
        if (message.createdAt > latest) latest = message.createdAt
      }
    }
    if (turn.startedAt === undefined && earliest !== Number.POSITIVE_INFINITY) {
      turn.startedAt = earliest
    }
    if (turn.endedAt === undefined && latest !== Number.NEGATIVE_INFINITY) {
      turn.endedAt = latest
    }
    // 跨度不足 1s（或只剩起点）时不算耗时，避免显示成 0s 的噪声
    if (
      turn.startedAt !== undefined &&
      turn.endedAt !== undefined &&
      turn.endedAt <= turn.startedAt
    ) {
      turn.startedAt = undefined
      turn.endedAt = undefined
    }
  }

  return turns
}

/** 单条消息的 token 量；缺 usage 记 0 */
function usageOf(message: ChatMessage): number {
  const frame = asUsageFrame(message.usage)
  if (!frame) return 0
  return frame.totalTokens ?? (frame.promptTokens ?? 0) + (frame.completionTokens ?? 0)
}

/**
 * 把 token 数格式化成带 k / M 单位的紧凑形式。
 * 千分位在大数下会糊成一片（372,825 要数位才知道量级），
 * 用 372.8k / 1.2M 一眼就能比较。
 * 保留 1 位小数，但整数时省掉 .0（45k 而不是 45.0k）。
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  const trim = (n: number): string => {
    const s = n.toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) : s
  }
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}k`
  return String(value)
}

/** 把毫秒格式化成「1h 02m 03s」这类可读时长；不足 1 秒显示 <1s */
export function formatDuration(startedAt?: number, endedAt?: number): string | null {
  if (!startedAt || !endedAt || endedAt < startedAt) return null
  const ms = endedAt - startedAt
  if (ms < 1000) return '<1s'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** 把毫秒格式化成「2026-09-26 14:05:33」这类本地时间戳；无效值返回 null */
export function formatTimestamp(at?: number): string | null {
  if (!at || at <= 0) return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}
