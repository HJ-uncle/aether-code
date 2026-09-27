import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSsePayload, EngineFileChange, EngineTodo, StreamEvent } from '@shared/ipc'
import * as engine from './client'
import {
  buildToolResponse,
  mergePending,
  normalizePending,
  type PendingInteraction
} from './pending'

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
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  tools: ToolActivity[]
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
   * 思考模式：true/false 显式开关，undefined 交给引擎按模型能力判断。
   *
   * 引擎侧语义（见 chat 路由）：不传时看 capabilities.thinking 是否为真；
   * 传 false 是「强制关闭」，与不传并不等价，所以这里必须保留 undefined。
   */
  thinkingMode?: boolean
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
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
    const message: ChatMessage = {
      id: row.id || newId(),
      role: 'assistant',
      content: extractText(row.content),
      thinking: typeof row.reasoningContent === 'string' ? row.reasoningContent : '',
      tools: [],
      status: 'done',
      createdAt,
      ...(row.modelId ? { modelId: row.modelId } : {}),
      ...(row.usage ? { usage: row.usage } : {})
    }
    if (row.toolCall && typeof row.toolCall === 'object' && row.toolCall.name) {
      message.tools.push({
        id: row.toolCall.id || newId(),
        name: row.toolCall.name,
        args: JSON.stringify(row.toolCall.args ?? {}, null, 2),
        result: '',
        state: 'done'
      })
      if (row.toolCall.id) {
        openTools.set(row.toolCall.id, { message, index: message.tools.length - 1 })
      }
    }
    result.push(message)
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
  /** 清空当前会话；传入 sessionId 时同步删除引擎侧历史 */
  clear: (sessionId?: string) => void
} {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [todos, setTodos] = useState<EngineTodo[]>([])

  /** 当前流式请求 ID；用 ref 是因为事件回调拿不到最新 state */
  const activeStreamRef = useRef<string | null>(null)

  /** 当前流对应的引擎会话 ID，停止时用它显式取消引擎侧运行 */
  const activeSessionRef = useRef<string | null>(null)

  useEffect(() => {
    const off = engine.onStreamEvent((event: StreamEvent) => {
      // 只处理当前这条流，忽略历史流的迟到事件
      if (event.streamId !== activeStreamRef.current) return
      applyEvent(event)
    })
    return off

    function applyEvent(event: StreamEvent): void {
      if (event.type === 'done') {
        setMessages((prev) =>
          patchLastAssistant(prev, (msg) => ({
            ...msg,
            status: 'done',
            endedAt: msg.endedAt ?? Date.now()
          }))
        )
        setStreaming(false)
        activeStreamRef.current = null
        return
      }

      if (event.type === 'error') {
        setMessages((prev) =>
          patchLastAssistant(prev, (msg) => ({
            ...msg,
            status: 'error',
            error: event.message,
            endedAt: msg.endedAt ?? Date.now()
          }))
        )
        setStreaming(false)
        activeStreamRef.current = null
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
      // 允许「只发附件不发文字」：多模态模型的常见用法就是丢张图让它看
      if ((!trimmed && attachments.length === 0) || activeStreamRef.current) return

      const now = Date.now()
      const userMessage: ChatMessage = {
        id: newId(),
        role: 'user',
        content: trimmed,
        thinking: '',
        tools: [],
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
  }, [])

  /**
   * 清空当前会话。
   *
   * 必须同时删引擎侧历史：conversations 表会随启动回放还原到界面，
   * 只清内存的话「清空」过的记录下次启动又会全部回来。
   */
  const clear = useCallback((sessionId?: string) => {
    if (activeStreamRef.current) return
    setMessages([])
    setTodos([])
    if (sessionId) {
      void engine
        .request({
          method: 'DELETE',
          path: '/conversation/history',
          query: { sessionId }
        })
        .catch(() => {})
    }
  }, [])

  return { messages, streaming, todos, send, respond, abort, clear, loadHistory }
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

function reducePayload(message: ChatMessage, payload: ChatSsePayload): ChatMessage {
  if (typeof payload.content === 'string') {
    return { ...message, content: message.content + payload.content }
  }

  if (typeof payload.thinking === 'string') {
    return { ...message, thinking: message.thinking + payload.thinking }
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
    return {
      ...message,
      pending: merged,
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
      if (index >= 0) {
        tools[index] = { ...tools[index], ...normalized, state: 'running', ...hidden }
      } else {
        tools.push({
          id: normalized.id || newId(),
          name: normalized.name || '未命名工具',
          args: normalized.args || '',
          result: '',
          state: 'running',
          ...hidden
        })
      }
      return { ...message, tools }
    }

    // args 帧可能先于 start 帧到达（引擎侧顺序不保证），此时先占位。
    // 引擎的 __tool_args__ 携带的是流式**增量片段**，必须追加：覆盖会让参数
    // 只剩最后一个片段（曾出现参数只显示一个 "}" 的卡片）。
    // 完整参数随后会由 __tool_start__/__tool_call__ 整串覆盖，不会重复累积。
    if (kind === 'args') {
      if (index >= 0) {
        tools[index] = { ...tools[index], args: `${tools[index].args}${normalized.args ?? ''}` }
      } else {
        tools.push({
          id: normalized.id || newId(),
          name: normalized.name || '未命名工具',
          args: normalized.args || '',
          result: '',
          state: 'running',
          ...hidden
        })
      }
      return { ...message, tools }
    }

    // end / result
    if (index >= 0) {
      tools[index] = {
        ...tools[index],
        name: normalized.name || tools[index].name,
        result: normalized.result || tools[index].result,
        state: 'done'
      }
    } else {
      tools.push({
        id: normalized.id || newId(),
        name: normalized.name || '未命名工具',
        args: normalized.args || '',
        result: normalized.result || '',
        state: 'done'
      })
    }
    return { ...message, tools }
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
