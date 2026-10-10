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
  /**
   * 单次调用口径：本轮最后一次 LLM 调用的真实输入 token（当前上下文占用快照）。
   * 区别于 promptTokens——后者是本次请求内跨 ReAct 迭代累加值，多轮工具调用后
   * 会成倍膨胀，不能当「当前上下文大小」用；用量环分子应取这个字段。
   */
  currentPromptTokens?: number
  /** 当前模型的上下文窗口上限（引擎能力表解析结果），用量环分母；缺失时前端回退估算值 */
  contextWindow?: number
  /** 输入构成（引擎侧细分，属于「输入」组） */
  systemPromptTokens?: number
  systemToolsTokens?: number
  messagesTokens?: number
  skillTokens?: number
  ragTokens?: number
  builtinToolsTokens?: number
  mcpToolsTokens?: number
  toolResultsTokens?: number
  /** 缓存是输入的复用情况，与提示词构成是不同维度，不额外计入总用量。 */
  cacheHitTokens?: number
  cacheMissTokens?: number
  /** 输出细分（属于「输出」组） */
  reasoningTokens?: number
}

export interface UsageDetailRow {
  label: string
  /** 输入与输出是同级主项；缓存命中属于输入下的构成明细，不单独参与加总。 */
  group: 'input' | 'output' | 'cache'
  tokens: number
  /** 缩进的子项（输入的二级构成） */
  child?: boolean
  unknown?: boolean
  title?: string
  /** 小计说明，不再作为另一项消耗加入总量。 */
  subtotal?: boolean
}

export interface UsageTotal {
  /** 累计总 token（各轮 totalTokens 之和；引擎缺该字段时按输入+输出兜底） */
  total: number
  input: number
  output: number
  parentTotal: number
  subagentTotal: number
  unknownSubagents: number
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

export interface ContextUsageSnapshot {
  used: number
  estimated?: boolean
  provisional?: boolean
  requestInputTokenEstimate?: number
  contextWindow?: number
  modelId?: string
}

/** Latest model input and its window belong to the same invocation, never billing totals or a future composer model. */
export function latestContextUsage(messages: ChatMessage[]): ContextUsageSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const frame = asUsageFrame(message.usage)
    if (!frame) continue
    // Explicit turn billing is cumulative and cannot stand in for an unknown
    // invocation input (for example an approval seed after compaction).
    if ((message.usage as Record<string, unknown>).usageScope === 'turn' && frame.currentPromptTokens === undefined) continue
    const used = frame.currentPromptTokens ?? frame.promptTokens
    if (used === undefined || used < 0) continue
    const raw = message.usage as Record<string, unknown>
    const estimated = message.contextUsageEstimated ??
      (typeof raw.contextUsageEstimated === 'boolean' ? raw.contextUsageEstimated : undefined)
    return {
      used,
      ...(estimated === undefined ? {} : { estimated }),
      ...(typeof raw.contextUsageProvisional === 'boolean' ? { provisional: raw.contextUsageProvisional } : {}),
      ...(typeof raw.requestInputTokenEstimate === 'number' && Number.isFinite(raw.requestInputTokenEstimate) && raw.requestInputTokenEstimate >= 0
        ? { requestInputTokenEstimate: raw.requestInputTokenEstimate } : {}),
      ...(frame.contextWindow && frame.contextWindow > 0 ? { contextWindow: frame.contextWindow } : {}),
      ...((message.contextModelId ?? message.modelId) ? { modelId: message.contextModelId ?? message.modelId } : {})
    }
  }
  return null
}

/** 明细行的展示顺序与标签（对齐引擎 QA 日志描述，便于两边对照排查） */
const DETAIL_ROWS: ReadonlyArray<{
  key: keyof UsageFrame
  label: string
  group: UsageDetailRow['group']
  child?: boolean
}> = [
  { key: 'promptTokens', label: '累计输入 Prompt', group: 'input' },
  { key: 'systemPromptTokens', label: '系统提示词', group: 'input', child: true },
  { key: 'messagesTokens', label: '对话历史', group: 'input', child: true },
  { key: 'toolResultsTokens', label: '工具结果', group: 'input', child: true },
  { key: 'builtinToolsTokens', label: '内置工具说明', group: 'input', child: true },
  { key: 'mcpToolsTokens', label: 'MCP 工具说明', group: 'input', child: true },
  { key: 'skillTokens', label: '技能 Prompt', group: 'input', child: true },
  { key: 'ragTokens', label: '知识库 RAG', group: 'input', child: true },
  { key: 'cacheMissTokens', label: '缓存未命中', group: 'input', child: true },
  { key: 'cacheHitTokens', label: '缓存命中', group: 'cache', child: true },
  { key: 'completionTokens', label: '输出 Completion', group: 'output' },
  { key: 'reasoningTokens', label: '其中推理', group: 'output', child: true }
]

interface DisplayInputUsage {
  hit: number
  reportedHit: number
  inputKnown: boolean
  inputMissing: boolean
  capped: boolean
  frames: number
}

// Keep display completeness out of billing snapshots and IPC structures.
const detailCompleteness = new WeakMap<UsageTotal, boolean>()

/** A subtotal is redundant only when every contributing frame reported both billing counters. */
export function hasCompleteUsageDetails(total: UsageTotal): boolean {
  return detailCompleteness.get(total) === true
}

/** The breakdown keeps the provider's complete prompt total and nests cache details beneath it. */
function usageDetails(acc: Record<string, number>, display: DisplayInputUsage): UsageDetailRow[] {
  const { reportedHit, inputKnown, inputMissing, capped, frames } = display

  return DETAIL_ROWS.map((row): UsageDetailRow => {
    const detail: UsageDetailRow = {
      label: row.label,
      group: row.group,
      child: row.child,
      tokens: acc[row.key] ?? 0
    }
    if (row.key === 'promptTokens') {
      detail.tokens = acc.promptTokens ?? 0
      if (inputMissing && inputKnown) detail.title = '部分调用未报告输入总量；此处汇总已报告的完整输入，缺失部分未估算。'
      else if (reportedHit > 0) detail.title = '包含缓存命中；缓存明细作为输入构成展示，不重复计入合计。'
    } else if (row.key === 'cacheHitTokens') {
      detail.tokens = display.hit
      detail.title = !inputKnown ? '输入总量未报告，无法确认缓存占比。'
        : inputMissing ? `部分调用未报告输入总量；保留已知缓存命中，无法确认全部输入的缓存占比。${capped ? ` 已报告调用的缓存命中已按各次输入上限展示（供应商累计报告 ${reportedHit.toLocaleString('en-US')} tokens）。` : ''}`
        : capped && frames === 1 ? `供应商报告缓存命中 ${reportedHit.toLocaleString('en-US')} tokens，超过输入总量；按输入上限展示。`
        : capped ? `部分调用的缓存命中超过其输入总量；按各次输入上限展示（供应商累计报告 ${reportedHit.toLocaleString('en-US')} tokens）。`
        : '已复用的输入，归入累计输入 Prompt；此处作为输入构成明细展示。'
    } else if (row.key === 'cacheMissTokens') {
      // Some providers report cache creation here, not all uncached prompt tokens.
      detail.title = '供应商报告的缓存未命中或缓存写入统计，不重复计入总用量。'
    } else if (row.group === 'input' && row.child && reportedHit > 0) {
      detail.title = '全部输入的构成（含缓存），不重复计入合计。'
    }
    return detail
  }).filter(row => row.tokens > 0 || (reportedHit > 0 &&
    (row.label === '缓存命中' || (inputKnown && row.label === '累计输入 Prompt'))))
}

/**
 * 汇总整条会话的用量。
 *
 * 只统计 assistant 消息（usage 挂在那里）；用户消息不含用量。
 * startedAt/endedAt 取所有消息的极值，用于页脚显示「会话使用时间」。
 */
export function sumUsage(messages: ChatMessage[]): UsageTotal {
  const acc: Record<string, number> = {}
  const display: DisplayInputUsage = {
    hit: 0, reportedHit: 0, inputKnown: false, inputMissing: false,
    capped: false, frames: 0
  }
  let completeDetails = true
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
    display.frames += 1
    const reportedHit = Math.max(0, frame.cacheHitTokens ?? 0)
    display.reportedHit += reportedHit
    if (frame.promptTokens !== undefined) {
      const input = Math.max(0, frame.promptTokens)
      const hit = Math.min(input, reportedHit)
      display.inputKnown = true
      display.hit += hit
      display.capped ||= reportedHit > input
    } else {
      // One invocation's known input cannot cap cache reported by a different invocation.
      display.inputMissing = true
      display.hit += reportedHit
    }
    completeDetails &&= frame.promptTokens !== undefined && frame.completionTokens !== undefined
    for (const [key, value] of Object.entries(frame)) {
      acc[key] = (acc[key] ?? 0) + (value as number)
    }
    total += frame.totalTokens ?? (frame.promptTokens ?? 0) + (frame.completionTokens ?? 0)
  }

  const summary = usageDetails(acc, display)

  const children = subagentUsage(messages)
  const detail: UsageDetailRow[] = [...summary]
  if (children.count > 0) {
    if (!completeDetails || acc.promptTokens === undefined || acc.completionTokens === undefined ||
      (acc.promptTokens + acc.completionTokens) !== total) {
      detail.unshift({ label: '主代理自身', group: 'input', tokens: total, subtotal: true,
        title: '主代理用量小计，输入明细可能未完整报告，不重复计入总用量。' })
    }
    detail.push({ label: '子代理（已知用量）', group: 'output', tokens: children.total })
    if (children.unknown > 0) detail.push({ label: `子代理用量缺失（${children.unknown} 个）`, group: 'output', tokens: 0, unknown: true })
    if (children.finishedAt && (endedAt === undefined || children.finishedAt > endedAt)) endedAt = children.finishedAt
  }

  const result: UsageTotal = {
    total: total + children.total,
    parentTotal: total,
    subagentTotal: children.total,
    unknownSubagents: children.unknown,
    input: acc.promptTokens ?? 0,
    output: acc.completionTokens ?? 0,
    rounds,
    summary: detail,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {})
  }
  detailCompleteness.set(result, rounds > 0 && completeDetails)
  return result
}

/** Snapshots can appear in both replay and live data; count each run only once, never as context occupancy. */
function subagentUsage(messages: ChatMessage[]): { total: number; unknown: number; count: number; finishedAt?: number } {
  const runs = new Map<string, NonNullable<ChatMessage['tools'][number]['subagent']>>()
  for (const message of messages) for (const tool of message.tools) {
    const run = tool.subagent
    if (run && (!runs.has(run.runId) || runs.get(run.runId)!.lastSeq < run.lastSeq)) runs.set(run.runId, run)
  }
  let total = 0
  let unknown = 0
  let finishedAt: number | undefined
  for (const run of runs.values()) {
    const usage = run.usage
    const tokens = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens : undefined)
    if (usage.unknown || tokens === undefined) unknown++
    // Unknown totals may still contain an observed lower bound; display that part without inventing zero usage.
    if (tokens !== undefined) total += tokens
    if (run.finishedAt && (finishedAt === undefined || run.finishedAt > finishedAt)) finishedAt = run.finishedAt
  }
  return { total, unknown, count: runs.size, finishedAt }
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
    const total = sumUsage(turn.messages)
    turn.tokens = total.total
    turn.summary = total.summary

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
