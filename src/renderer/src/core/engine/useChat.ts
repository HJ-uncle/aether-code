import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSsePayload, EngineFileChange, EngineTodo, StreamEvent } from '@shared/ipc'
import * as engine from './client'
import {
  buildToolResponse,
  mergePending,
  normalizePending,
  type PendingInteraction
} from './pending'
import { patchSessionMeta } from '@renderer/contrib/history/session-meta'

// ==================== 模型 ====================

export interface ToolActivity {
  id: string
  name: string
  args: string
  result: string
  state: 'running' | 'done' | 'error'
  /**
   * 该调用由交互卡片（提问 / 安全授权）代表，不再单独渲染工具条目。
   *
   * ask_user 会同时下发工具帧与提问帧，两者是同一件事；而且它永远等不到
   * tool_end（引擎发出提问帧后即挂起等应答），不隐藏就会留下一个「执行中」
   * 且展示原始 args JSON 的残留卡片。
   */
  hidden?: boolean
  /** 引擎下发的文件改动记录（write_file/delete_file 后），供 diff 卡片渲染 */
  change?: EngineFileChange
  /** 工具开始执行的时间戳（ms，本机时钟），子代理卡片运行中耗时跳动用 */
  startedAt?: number
}

/**
 * 时间线条目：记录本轮各类输出（思考 / 正文 / 工具调用 / 交互）的**真实发生顺序**。
 *
 * content/thinking/tools 三个扁平字段为了渲染与导出分别聚合了全文，
 * 但把「先想一段 → 调个工具 → 再想一段」的穿插顺序丢掉了。
 * SSE 帧本身是严格按发生顺序到达的，这里顺手记下顺序，渲染层据此穿插排布。
 */
export type TimelineItem =
  | { kind: 'thinking'; text: string }
  | { kind: 'content'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'interaction' }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  tools: ToolActivity[]
  /** 输出时间线（流式期间精确保序；历史回放为近似顺序） */
  items: TimelineItem[]
  status: 'streaming' | 'done' | 'error' | 'aborted'
  error?: string
  usage?: unknown
  createdAt: number
  /**
   * 等待用户应答的交互（提问 / 安全授权）。
   *
   * 引擎发出该帧后会**挂起当前流**等待应答 —— 不是断连。
   * 不渲染它会让用户看到"卡在某个工具执行中"。
   */
  pending?: PendingInteraction
  /** 已提交的应答值，用于回显并禁用按钮 */
  answered?: string
  /** 本轮开始时间（首次收到该帧时打点），用于计算「使用时间」 */
  startedAt?: number
  /** 本轮结束时间（done/error/aborted 时打点）；缺失表示仍在进行中 */
  endedAt?: number
  /** 用户消息携带的附件（仅 role=user），用于气泡内展示附件条 */
  attachments?: ChatAttachment[]
  /** 产生该条消息的模型 id（仅 assistant）；回放历史时由引擎给出 */
  modelId?: string
  /** 所属轮次 id（引擎 conversations 表的 conversation_id）；历史回放合并同轮 assistant 行用 */
  conversationId?: string
}

/**
 * 一条已上传到工作区的附件。
 *
 * `path` 是相对工作区根的路径 —— 引擎的 `/workspace` 白名单只认工作区内的路径，
 * 所以渲染层先把字节落盘到工作区，再把相对路径交给引擎读回。
 */
export interface ChatAttachment {
  /** 相对工作区根的路径（引擎 attachments[].name 用的就是它） */
  path: string
  /** 原始文件名（界面展示用） */
  name: string
  /** MIME，仅作提示 */
  type: string
  size: number
}

/** 排队中的一条待发消息（流式进行中入队，回合结束后按序/合并发出） */
export interface QueuedMessage {
  id: string
  text: string
  attachments: ChatAttachment[]
}

export interface SendOptions {
  sessionId: string
  agentId?: string
  model?: string
  /**
   * 绑定的工作区路径。
   *
   * 引擎以 workspacePaths[0] 作为主工作区（Agent 相对路径的基准），
   * 沙箱目录退为兜底 —— 因此把用户打开的文件夹放在首位传进来，
   * Agent 的 write_file 等工具才会真正作用于同一份代码。
   * 注意只有 /chat 会读取该字段，且每轮都必须带上，丢了就会切回沙箱目录。
   */
  workspacePaths?: string[]
  /** 本轮要随消息发给引擎的附件（图片走视觉/OCR，文本走 smart_read） */
  attachments?: ChatAttachment[]
  /**
   * 思考档位：'low' / 'high' 显式下发引擎档位字符串；'max' 映射 'high' 强制档；
   * false 强制关闭思考；undefined 交给引擎按模型能力判断。
   *
   * 引擎侧语义（见 chat 路由）：不传时看 capabilities.thinking 是否为真；
   * 字符串档位表示「强制开启并指定推理 effort」，false 是显式关闭。
   */
  thinkingMode?: 'low' | 'medium' | 'high' | false
}

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
interface EngineHistoryRow {
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
function replayMessages(rows: EngineHistoryRow[]): ChatMessage[] {
  const result: ChatMessage[] = []
  /** 尚未收到结果的工具调用，按 toolCallId 索引，用于回填 tool 结果行 */
  const openTools = new Map<string, { message: ChatMessage; index: number }>()

  for (const row of rows) {
    if (row.role === 'system') continue
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
        open.message.tools[open.index] = {
          ...open.message.tools[open.index],
          result: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
          state: 'done'
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
        state: 'done'
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
function normalizeTool(raw: unknown): Partial<ToolActivity> {
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
    result: readString('output', 'result', 'content', 'text')
  }
}

// ==================== Hook ====================

export function useChat(): {
  messages: ChatMessage[]
  streaming: boolean
  /** 会话待办清单（引擎 todo 工具维护，随 \x00__todo__ 帧整表下发） */
  todos: EngineTodo[]
  send: (text: string, options: SendOptions) => Promise<void>
  /**
   * 从引擎回放指定会话的历史消息（启动 / 会话切换时调用）。
   *
   * 引擎的 conversations 表本来就是 AI 上下文的来源，这里只是把同一份数据
   * 以消息列表的形式还原到界面 —— 不引入新的持久化，也就不会出现两边不一致。
   */
  loadHistory: (sessionId: string) => Promise<void>
  /** 应答提问/授权；会以 toolResponse 续跑同一条会话 */
  respond: (
    values: string[],
    options: Pick<SendOptions, 'sessionId' | 'model' | 'workspacePaths'> &
      Partial<Pick<SendOptions, 'thinkingMode'>>
  ) => Promise<void>
  abort: () => void
  /** 清空当前会话；传入 sessionId 时同步删除引擎侧历史；失败时抛错且不清理界面 */
  clear: (sessionId?: string) => Promise<void>
  /** 删除一整轮对话（引擎侧 + 界面） */
  deleteTurn: (sessionId: string, message: ChatMessage) => Promise<void>
  /** 从某条用户消息处截断重发（重新发送 / 重新生成共用） */
  retryFrom: (userMessage: ChatMessage, options: SendOptions) => Promise<void>
  /** 消息级回退：恢复该消息之后的所有文件改动（含 kept）并截断对话，不自动重发 */
  revertFrom: (sessionId: string, userMessage: ChatMessage) => Promise<void>
  /** 合并发送：把排队中的消息与本条合并成一条立即发出（流中时合并全部队列） */
  mergeAndSend: (text: string, options: SendOptions) => Promise<void>
  /** 当前排队中的消息（供队列托盘渲染） */
  queue: QueuedMessage[]
  /** 从队列移除一条 */
  removeQueued: (id: string) => void
  /** 清空队列（不影响正在跑的回合） */
  clearQueue: () => void
} {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [todos, setTodos] = useState<EngineTodo[]>([])

  /** 当前流式请求 ID；用 ref 是因为事件回调拿不到最新 state */
  const activeStreamRef = useRef<string | null>(null)

  /** 当前流对应的引擎会话 ID，停止时用它显式取消引擎侧运行 */
  const activeSessionRef = useRef<string | null>(null)

  /**
   * 连续发送队列：流式进行中用户继续发的消息先进队列，
   * 当前流结束（完成/出错/中止）后按序自动发出。
   *
   * 队列本体放 state 而非 ref：托盘 UI 要实时渲染排队消息
   * （预览/删除/清空），ref 变更不触发重渲染。
   * 发送逻辑在事件回调里读队列，用 queueRef 镜像一份保证拿到最新值。
   */
  type QueuedEntry = QueuedMessage & { options: SendOptions }
  const [queue, setQueue] = useState<QueuedEntry[]>([])
  const queueRef = useRef<QueuedEntry[]>([])
  const syncQueue = useCallback((next: QueuedEntry[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  /** 队列调度：当前无活动流时依次取队首发出 */
  const drainQueue = useCallback(async (): Promise<void> => {
    if (activeStreamRef.current) return
    const [next, ...rest] = queueRef.current
    if (!next) return
    syncQueue(rest)
    await sendInternalRef.current(next.text, next.options)
  }, [syncQueue])

  /**
   * send 的实际执行体（不含排队判断）。由 send（带排队）与 drainQueue 共用。
   * useCallback 初始化顺序：drainQueue 引用它，因此声明在其之前。
   */
  const sendInternalRef = useRef<(text: string, options: SendOptions) => Promise<void>>(async () => {})
  const drainQueueRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    const off = engine.onStreamEvent((event: StreamEvent) => {
      // 只处理当前这条流，忽略历史流的迟到事件
      if (event.streamId !== activeStreamRef.current) return
      applyEvent(event)
    })
    return off

    function applyEvent(event: StreamEvent): void {
      if (event.type === 'done' || event.type === 'error') {
        setMessages((prev) =>
          patchLastAssistant(prev, (msg) => ({
            ...msg,
            ...(event.type === 'done'
              ? { status: 'done' as const }
              : { status: 'error' as const, error: event.message }),
            endedAt: msg.endedAt ?? Date.now()
          }))
        )
        setStreaming(false)
        activeStreamRef.current = null
        // 连续发送：当前流结束后自动发出队列中的下一条
        void drainQueueRef.current()
        return
      }

      // todo 帧是会话级清单，不归属任何一条消息
      const todoFrame = event.payload.todo
      if (todoFrame && Array.isArray(todoFrame.todos)) {
        setTodos(todoFrame.todos)
        return
      }

      const payload = event.payload
      setMessages((prev) =>
        patchLastAssistant(prev, (msg) => ({
          // 首个数据帧即本轮真实起点：起流到首帧之间的建连耗时不计入使用时间
          ...(msg.startedAt ? {} : { startedAt: Date.now() }),
          ...reducePayload(msg, payload)
        }))
      )
    }
  }, [])

  /** 统一起流：设置激活流 ID 并发出请求 */
  const runStream = useCallback(async (body: Record<string, unknown>) => {
    const streamId = newId()
    activeStreamRef.current = streamId
    activeSessionRef.current = typeof body.sessionId === 'string' ? body.sessionId : null
    await engine.startStream({ streamId, path: '/chat', body })
  }, [])

  const send = useCallback(
    async (text: string, options: SendOptions) => {
      const trimmed = text.trim()
      const attachments = options.attachments ?? []
      if ((!trimmed && attachments.length === 0)) return

      // 顺手记下「这条会话在哪个项目里」——会话历史面板的「打开项目目录」靠它
      const workspacePath = options.workspacePaths?.[0]
      if (options.sessionId && workspacePath) {
        patchSessionMeta(options.sessionId, { workspacePath })
      }

      // 流式进行中不抢占（引擎对同会话新请求是 abort 旧流，不是排队）：
      // 入队等待，当前流结束后由 drainQueue 按序发出
      if (activeStreamRef.current) {
        syncQueue([...queueRef.current, { id: newId(), text: trimmed, attachments, options }])
        return
      }

      await sendInternalRef.current(trimmed, options)
    },
    [syncQueue]
  )

  /**
   * 合并发送：把队列中尚未发出的消息与本条合并成一条（正文用空行拼接）。
   * 本条已在流中时合并队列全部；本条未发送时只合并队列。
   */
  const mergeAndSend = useCallback(
    async (text: string, options: SendOptions): Promise<void> => {
      const trimmed = text.trim()
      const pending = [...queueRef.current]
      syncQueue([])
      const parts = [trimmed, ...pending.map((item) => item.text)].filter(Boolean)
      const mergedAttachments = pending.flatMap((item) => item.attachments)
      if (parts.length === 0 && mergedAttachments.length === 0) return
      await sendInternalRef.current(parts.join('\n\n'), {
        ...options,
        attachments: [...(options.attachments ?? []), ...mergedAttachments]
      })
    },
    [syncQueue]
  )

  /** 从队列移除一条（用户在托盘里点删除） */
  const removeQueued = useCallback(
    (id: string): void => {
      syncQueue(queueRef.current.filter((item) => item.id !== id))
    },
    [syncQueue]
  )

  /** 清空队列（不影响正在跑的回合） */
  const clearQueue = useCallback((): void => {
    syncQueue([])
  }, [syncQueue])

  const sendInternal = useCallback(
    async (text: string, options: SendOptions) => {
      const trimmed = text.trim()
      const attachments = options.attachments ?? []
      // 允许「只发附件不发文字」：多模态模型的常见用法就是丢张图让它看
      if ((!trimmed && attachments.length === 0) || activeStreamRef.current) return

      const now = Date.now()
      const userMessage: ChatMessage = {
        id: newId(),
        role: 'user',
        content: trimmed,
        thinking: '',
        tools: [],
        items: [],
        status: 'done',
        createdAt: now,
        ...(attachments.length > 0 ? { attachments } : {})
      }
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        items: [],
        status: 'streaming',
        createdAt: now + 1,
        // 记下本轮实际请求的模型，供每轮问答末尾展示
        ...(options.model ? { modelId: options.model } : {})
      }

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setStreaming(true)

      await runStream({
        message: trimmed,
        sessionId: options.sessionId || undefined,
        agentId: options.agentId || undefined,
        model: options.model || undefined,
        workspacePaths: options.workspacePaths?.length ? options.workspacePaths : undefined,
        // undefined 不参与 JSON 序列化 → 引擎收到「未指定」，按其能力判断
        thinkingMode: options.thinkingMode,
        // 引擎只读 name（相对工作区路径）；type 仅作提示，content 留给内联场景
        attachments:
          attachments.length > 0
            ? attachments.map((file) => ({ name: file.path, type: file.type }))
            : undefined
      })
    },
    [runStream]
  )

  // sendInternal 定义晚于 drainQueue/send：用 ref 桥接，首次渲染后立即可用。
  // 渲染期写 ref 违反 React 规则（react-hooks/refs），挪进 effect 同步。
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    // drainQueue 的 useCallback 依赖链引用了这两个 ref，react-hooks/immutability 会误报
    // 「修改了传给 hook 的值」；桥接语义本来就是渲染后同步最新回调，行为不变。
    sendInternalRef.current = sendInternal
    drainQueueRef.current = drainQueue
  })
  /* eslint-enable react-hooks/immutability */

  /**
   * 回放引擎历史。
   *
   * 流式进行中不回放（会覆盖正在生成的消息）；拉取失败静默处理 ——
   * 启动时引擎可能尚未就绪，等下一次会话变化仍有机会。
   */
  const loadHistory = useCallback(async (targetSessionId: string) => {
    if (!targetSessionId || activeStreamRef.current) return
    try {
      const result = await engine.request<EngineHistoryRow[]>({
        method: 'GET',
        path: '/conversation/history',
        query: { sessionId: targetSessionId }
      })
      if (!result.ok || !Array.isArray(result.data)) return
      // 等待期间用户可能已经发起了新流：历史只该落到静止的界面上
      if (activeStreamRef.current) return
      setMessages(replayMessages(result.data))
    } catch {
      /* 静默：引擎未就绪 / 网络失败时保持当前界面 */
    }
  }, [])

  /**
   * 应答提问/授权。
   *
   * 引擎没有专用端点，唯一方式是再发一次 /chat 带 toolResponse；
   * 引擎会据此继续同一条会话（授权通过时它把该命令写入会话白名单，
   * 并让模型用相同参数重新调用工具）。
   */
  const respond = useCallback(
    async (
      values: string[],
      options: Pick<SendOptions, 'sessionId' | 'model' | 'workspacePaths'> &
        Partial<Pick<SendOptions, 'thinkingMode'>>
    ) => {
      // 取最后一条「有 pending 且未应答」的助手消息
      const target = [...messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.pending && !message.answered)
      const pending = target?.pending
      if (!target || !pending) return

      const answeredLabel = values.join('，')
      setMessages((prev) =>
        prev.map((message) =>
          message.id === target.id
            ? { ...message, answered: answeredLabel, status: 'streaming', error: undefined }
            : message
        )
      )
      setStreaming(true)

      // 必须沿用同一轮的 model 与 workspacePaths：不带的话引擎会回退到默认模型，
      // 造成同一会话中途换模型；workspacePaths 丢失则 Agent 会切回沙箱目录
      await runStream({
        sessionId: options.sessionId || undefined,
        model: options.model || undefined,
        workspacePaths: options.workspacePaths?.length ? options.workspacePaths : undefined,
        thinkingMode: options.thinkingMode,
        toolResponse: buildToolResponse(pending, values)
      })
    },
    [messages, runStream]
  )

  const abort = useCallback(() => {
    const streamId = activeStreamRef.current
    if (!streamId) return
    void engine.abortStream(streamId)
    // 只断开 SSE 是不够的：引擎把客户端断连当作「可能重连」，会进入 15 秒宽限期
    // 才真正 abort，工具在这期间照跑 —— 表现为「点了停止后端还在运行」。
    // 这里再显式调一次 /chat/cancel，让引擎立刻停。
    const sessionId = activeSessionRef.current
    if (sessionId) {
      void engine.request({ method: 'POST', path: '/chat/cancel', body: { sessionId } })
    }
    setMessages((prev) =>
      patchLastAssistant(prev, (msg) => ({
        ...msg,
        status: 'aborted',
        error: '已停止',
        endedAt: msg.endedAt ?? Date.now()
      }))
    )
    setStreaming(false)
    activeStreamRef.current = null
    activeSessionRef.current = null
    // 用户主动停止：排队中的消息不再自动发出（保留在队列里由用户决定去留）
    syncQueue([])
  }, [syncQueue])

  /**
   * 清空当前会话。
   *
   * 必须同时删引擎侧历史：conversations 表会随启动回放还原到界面，
   * 只清内存的话「清空」过的记录下次启动又会全部回来。
   *
   * 顺序上先删引擎再清界面：引擎侧删除失败时保留消息并抛错，
   * 让调用方给出明确提示 —— 否则用户看着「清空成功」，重启后记录复活。
   */
  const clear = useCallback(
    async (sessionId?: string): Promise<void> => {
      if (activeStreamRef.current) return
      if (sessionId) {
        const result = await engine.request({
          method: 'DELETE',
          path: '/conversation/history',
          query: { sessionId }
        })
        if (!result.ok) throw new Error(result.message || '引擎侧历史删除失败')
      }
      setMessages([])
      setTodos([])
    },
    []
  )

  /**
   * 把界面消息定位到引擎历史行。
   *
   * 界面里只有「历史回放」的消息带引擎 message_id；刚发出去的实时消息
   * id 是前端随机 UUID。因此先按 id 匹配，匹配不到再按「角色 + 正文」
   * 兜底 —— 实时消息刚落库，内容必然一致。
   */
  const resolveEngineRow = useCallback(
    async (sessionId: string, message: ChatMessage): Promise<EngineHistoryRow | null> => {
      const result = await engine.request<EngineHistoryRow[]>({
        method: 'GET',
        path: '/conversation/history',
        query: { sessionId }
      })
      if (!result.ok || !Array.isArray(result.data)) return null
      const rows = result.data
      return (
        rows.find((row) => row.id === message.id) ??
        rows.find((row) => row.role === message.role && row.content === message.content) ??
        null
      )
    },
    []
  )

  /** 删除一整轮对话（该消息所在轮：从轮首用户消息到下一个用户消息之前），同步删引擎侧历史 */
  const deleteTurn = useCallback(
    async (sessionId: string, message: ChatMessage): Promise<void> => {
      if (activeStreamRef.current) return
      const row = await resolveEngineRow(sessionId, message)
      if (!row?.conversationId) throw new Error('未能定位该轮对话的引擎记录')
      const result = await engine.request({
        method: 'DELETE',
        path: `/conversation/turns/${row.conversationId}`,
        query: { sessionId }
      })
      if (!result.ok) throw new Error(result.message || '引擎侧删除失败')
      await loadHistory(sessionId)
    },
    [loadHistory, resolveEngineRow]
  )

  /**
   * 从某条用户消息处重试：删除该消息及其后的所有历史（引擎侧 + 界面），
   * 再以原内容重新发送。重新发送（用户消息）与重新生成（取其前一条
   * 用户消息）都走这里。
   */
  const retryFrom = useCallback(
    async (userMessage: ChatMessage, options: SendOptions): Promise<void> => {
      if (activeStreamRef.current) return
      const row = await resolveEngineRow(options.sessionId, userMessage)
      if (row?.id) {
        const result = await engine.request({
          method: 'POST',
          path: '/conversation/truncate',
          body: { sessionId: options.sessionId, messageId: row.id }
        })
        if (!result.ok) throw new Error(result.message || '引擎侧截断失败')
      }
      setMessages((prev) => {
        const index = prev.findIndex((m) => m.id === userMessage.id)
        return index >= 0 ? prev.slice(0, index) : prev
      })
      await send(userMessage.content, {
        ...options,
        attachments: userMessage.attachments
      })
    },
    [resolveEngineRow, send]
  )

  /**
   * 消息级回退（对齐 wuzu-client 的 revert-files 语义）：
   * 把该用户消息起之后所有轮次产生的文件改动按快照恢复（含已保留的），
   * 再截断该消息及之后的对话历史。不自动重发，由调用方决定回填输入框。
   */
  const revertFrom = useCallback(
    async (sessionId: string, userMessage: ChatMessage): Promise<void> => {
      if (activeStreamRef.current) throw new Error('会话运行中，请先停止再回退')
      const rows = await (async (): Promise<EngineHistoryRow[]> => {
        const result = await engine.request<EngineHistoryRow[]>({
          method: 'GET',
          path: '/conversation/history',
          query: { sessionId }
        })
        if (!result.ok || !Array.isArray(result.data)) throw new Error('读取会话历史失败')
        return result.data
      })()
      // 分界时间：该用户消息（含）之前最近一条记录的时间戳；
      // 引擎记录时间晚于消息展示时间，这里取分界前 1 秒容钟表误差
      const index = rows.findIndex((row) => row.id === userMessage.id)
      const boundary = (() => {
        if (index > 0) return Number(rows[index - 1].createdAt) || 0
        const fallback = rows
          .filter((row) => Number(row.createdAt) < Number(userMessage.createdAt))
          .map((row) => Number(row.createdAt))
        return fallback.length ? Math.max(...fallback) : 0
      })() - 1000

      // 恢复该分界之后的所有改动（含 kept）；已 reverted 的跳过
      const changes = await engine.request<Array<{ id: string; status: string; truncated: boolean }>>({
        method: 'GET',
        path: '/changes',
        query: { sessionId, createdAfter: String(boundary) }
      })
      if (changes.ok && Array.isArray(changes.data)) {
        for (const change of changes.data) {
          if (change.status === 'reverted' || change.truncated) continue
          const r = await engine.request({
            method: 'POST',
            path: `/changes/${change.id}/revert`,
            body: {}
          })
          if (!r.ok) throw new Error(`文件回退失败（${change.id}）：${r.message || 'unknown'}`)
        }
      }

      // 截断对话：定位该用户消息在引擎侧的行，删除它及其后所有历史
      const row = rows.find((r) => r.id === userMessage.id) ?? null
      if (row) {
        const result = await engine.request({
          method: 'POST',
          path: '/conversation/truncate',
          body: { sessionId, messageId: row.id }
        })
        if (!result.ok) throw new Error(result.message || '引擎侧截断失败')
      }
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === userMessage.id)
        return i >= 0 ? prev.slice(0, i) : prev
      })
    },
    []
  )

  return {
    messages,
    streaming,
    todos,
    send,
    respond,
    abort,
    clear,
    loadHistory,
    deleteTurn,
    retryFrom,
    revertFrom,
    mergeAndSend,
    queue,
    removeQueued,
    clearQueue
  }
}

// ==================== 纯函数辅助 ====================

function patchLastAssistant(
  messages: ChatMessage[],
  patch: (message: ChatMessage) => ChatMessage
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const next = [...messages]
      next[i] = patch(messages[i])
      return next
    }
  }
  return messages
}

/**
 * 往时间线追加一段文本输出：与上一个条目同类则合并（流式增量帧），否则新开。
 * 合并只发生在「连续」时 —— 思考 → 工具 → 再思考 会产生两个思考条目，
 * 这正是渲染层恢复穿插顺序所依据的信息。
 */
function appendTimeline(items: TimelineItem[], kind: 'thinking' | 'content', text: string): void {
  const last = items[items.length - 1]
  if (last && last.kind === kind) {
    // 浅拷贝的数组与上一帧共享条目对象：合并时必须换出新对象，不能原地改
    items[items.length - 1] = { kind, text: last.text + text }
  } else {
    items.push({ kind, text })
  }
}

function reducePayload(message: ChatMessage, payload: ChatSsePayload): ChatMessage {
  const payloadError = (payload as { error?: unknown }).error
  if (typeof payloadError === 'string' && payloadError) {
    return {
      ...message,
      status: 'error',
      error: payloadError,
      endedAt: message.endedAt ?? Date.now()
    }
  }

  if (typeof payload.content === 'string') {
    const items = [...message.items]
    appendTimeline(items, 'content', payload.content)
    return { ...message, content: message.content + payload.content, items }
  }

  if (typeof payload.thinking === 'string') {
    const items = [...message.items]
    appendTimeline(items, 'thinking', payload.thinking)
    return { ...message, thinking: message.thinking + payload.thinking, items }
  }

  if (payload.usage) {
    return { ...message, usage: payload.usage }
  }

  // 交互帧优先于工具帧判断：授权场景会同时携带 toolStart/toolEnd，
  // 若先走工具分支就不会生成待应答项，UI 又会卡住
  const pending = normalizePending(payload)
  if (pending) {
    const merged = mergePending(message.pending, pending)
    const sameInteraction = message.pending?.toolCallId === merged.toolCallId
    const items = [...message.items]
    if (!sameInteraction) items.push({ kind: 'interaction' })
    return {
      ...message,
      pending: merged,
      items,
      // 换了新的交互时清掉上一次的应答回显
      answered: sameInteraction ? message.answered : undefined
    }
  }

  const toolFrame = pickToolFrame(payload)

  // 文件改动帧：把改动记录挂到对应的工具条目上（write_file/delete_file 的 diff 卡片）
  const fileChange = payload.fileChange
  if (fileChange?.toolCallId) {
    const tools = [...message.tools]
    const index = tools.findIndex((tool) => tool.id === fileChange.toolCallId)
    if (index >= 0) {
      tools[index] = { ...tools[index], change: fileChange }
      return { ...message, tools }
    }
  }

  if (toolFrame) {
    const [kind, raw] = toolFrame
    const normalized = normalizeTool(raw)
    const tools = [...message.tools]
    const index = normalized.id ? tools.findIndex((tool) => tool.id === normalized.id) : -1
    // ask_user 的呈现交给交互卡片，工具条目只做占位（保持 id 可被后续帧命中）
    const hidden = normalized.name === 'ask_user' ? { hidden: true } : {}

    if (kind === 'start') {
      const items = [...message.items]
      if (index >= 0) {
        tools[index] = { ...tools[index], ...normalized, state: 'running', ...hidden }
      } else {
        const id = normalized.id || newId()
        tools.push({
          id,
          name: normalized.name || '未命名工具',
          args: normalized.args || '',
          result: '',
          state: 'running',
          startedAt: Date.now(),
          ...hidden
        })
        items.push({ kind: 'tool', id })
      }
      return { ...message, tools, items }
    }

    // args 帧可能先于 start 帧到达（引擎侧顺序不保证），此时先占位。
    // 引擎的 __tool_args__ 携带的是流式**增量片段**，必须追加：覆盖会让参数
    // 只剩最后一个片段（曾出现参数只显示一个 "}" 的卡片）。
    // 完整参数随后会由 __tool_start__/__tool_call__ 整串覆盖，不会重复累积。
    if (kind === 'args') {
      if (index >= 0) {
        tools[index] = { ...tools[index], args: `${tools[index].args}${normalized.args ?? ''}` }
        return { ...message, tools }
      }
      // args 先于 start：此刻就是该工具真实开始的时间点，占位工具同步进时间线
      const id = normalized.id || newId()
      tools.push({
        id,
        name: normalized.name || '未命名工具',
        args: normalized.args || '',
        result: '',
        state: 'running',
        startedAt: Date.now(),
        ...hidden
      })
      return { ...message, tools, items: [...message.items, { kind: 'tool', id }] }
    }

    // end / result
    if (index >= 0) {
      tools[index] = {
        ...tools[index],
        name: normalized.name || tools[index].name,
        result: normalized.result || tools[index].result,
        state: 'done'
      }
      return { ...message, tools }
    }
    // 只有孤立的 end/result 帧：此刻才知道这个工具存在，补进时间线末尾
    const id = normalized.id || newId()
    tools.push({
      id,
      name: normalized.name || '未命名工具',
      args: normalized.args || '',
      result: normalized.result || '',
      state: 'done'
    })
    return { ...message, tools, items: [...message.items, { kind: 'tool', id }] }
  }

  return message
}

function pickToolFrame(payload: ChatSsePayload): ['start' | 'args' | 'end', unknown] | null {
  if (payload.toolStart) return ['start', payload.toolStart]
  if (payload.toolCall) return ['start', payload.toolCall]
  if (payload.toolArgs) return ['args', payload.toolArgs]
  if (payload.toolEnd) return ['end', payload.toolEnd]
  if (payload.toolResult) return ['end', payload.toolResult]
  return null
}
