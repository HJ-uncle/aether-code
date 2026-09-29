import type { CommandJobSnapshot } from '@shared/command-job'
import { attachCommandJobs } from './command-job-state'
import { subscribeCommandJobs, getCommandJobs, ingestCommandJob, forgetCommandSession, refreshCommandJobs, activateCommandSession } from './command-job-store'
import type { SubagentRun } from '@shared/subagent'
import type { RootRun } from '@shared/root-run'
import { applyRootRun, finishTransport, mergeRootRun, normalizeRootRun } from './root-run-state'
import { applyToolResult, normalizeTool, type EngineHistoryRow } from './chat-history'
export { extractText } from './chat-history'
import { attachSubagentRuns } from './subagent-state'
import { ingestSubagentEvent, ingestSubagentRun, getSubagentRuns, refreshSubagentRuns, subscribeSubagents, forgetSubagentSession, hasActiveSubagents } from './subagent-store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { reducePayload } from './chat-payload'
import { acceptEventId, restoreChatSnapshot, type ChatRecoverySnapshot } from './chat-recovery'
import type { EngineFileChange, EngineTodo, StreamEvent } from '@shared/ipc'
import * as engine from './client'
import { revertConversationFrom } from './change-revert'
import {
  buildToolResponse,
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
  state: 'running' | 'done' | 'error' | 'unknown' | 'cancelled' | 'waiting' | 'interrupted'
  durationMs?: number
  finishedAt?: number
  metadata?: Record<string, unknown>
  error?: string
  subagent?: SubagentRun
  commandJob?: CommandJobSnapshot
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
  runId?: string
  run?: RootRun
  interactions?: PendingInteraction[]
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  tools: ToolActivity[]
  /** 输出时间线（流式期间精确保序；历史回放为近似顺序） */
  items: TimelineItem[]
  status: 'streaming' | 'done' | 'error' | 'aborted' | 'waiting' | 'interrupted'
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

/** 队列发送模式：serial 按序逐条 / batch 合并成一条；localStorage 持久化 */
export type QueueSendMode = 'serial' | 'batch'
const QUEUE_SEND_MODE_KEY = 'aether:queueSendMode'

function loadQueueSendMode(): QueueSendMode {
  try {
    return localStorage.getItem(QUEUE_SEND_MODE_KEY) === 'batch' ? 'batch' : 'serial'
  } catch {
    return 'serial'
  }
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
  /** 子代理专用模型（空/undefined = 跟随主模型）；来自设置「按用途指派」 */
  subagentModel?: string
  /** 轻任务专用模型（图片理解等旁路调用）；来自设置「按用途指派」 */
  utilityModel?: string
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ==================== Hook ====================

export function useChat(): {
  messages: ChatMessage[]
  commandJobs: CommandJobSnapshot[]
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
    requestId: string,
    values: string[],
    options: Pick<SendOptions, 'sessionId' | 'model' | 'workspacePaths'> &
      Partial<Pick<SendOptions, 'thinkingMode' | 'subagentModel' | 'utilityModel'>>
  ) => Promise<void>
  abort: () => Promise<void>
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
  /** 编辑队列中一条消息的正文与附件 */
  updateQueued: (id: string, text: string, attachments: ChatAttachment[]) => void
  /** 拖拽排序：把 fromIndex 的消息挪到 toIndex */
  moveQueued: (fromIndex: number, toIndex: number) => void
  /** 手动发出队列：空闲时按当前模式（serial 发队首 / batch 合并全部）立即发送 */
  flushQueue: () => Promise<void>
  /** 队列发送模式（serial 按序逐条 / batch 合并成一条），持久化到 localStorage */
  queueSendMode: QueueSendMode
  setQueueSendMode: (mode: QueueSendMode) => void
  /**
   * 运行中切换模型时，把队列里所有待发消息的模型改写为新模型
   * （已发出的回合不受影响，避免出现「正在运行的模型显示成后选的模型」）
   */
  retargetQueuedModel: (model: string) => void
  /**
   * 恢复断开的流（刷新页面 / 切回会话后调用）。
   * 返回 true 表示该会话确有进行中的流且已成功挂接；false 表示无需恢复。
   */
  resumeStream: (sessionId: string) => Promise<boolean>
} {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [commandJobs, setCommandJobs] = useState<CommandJobSnapshot[]>([])
  const [streaming, setStreaming] = useState(false)
  const [todos, setTodos] = useState<EngineTodo[]>([])

  /**
   * 流式帧节流（对齐 wuzu-client 的 80ms 快照方案）：
   * SSE 的 content/thinking delta 帧频率远高于人眼可分辨的刷新率，
   * 每帧 setMessages 会让整棵消息树跟着每帧重渲染。
   * 这里把流式 patch 攒进队列，距上次 flush 满 80ms 才合并成一次 setMessages；
   * done/error 等关键帧到达时立即 flush，保证终态不延迟。
   *
   * patch 以 (prev) => next 函数形式攒着，flush 时依次折叠 ——
   * 与直接 setMessages 的 updater 语义一致，不会丢帧。
   */
  const STREAM_THROTTLE_MS = 80
  const pendingPatchesRef = useRef<Array<(prev: ChatMessage[]) => ChatMessage[]>>([])
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushAtRef = useRef(0)

  const flushStreamPatches = useCallback((): void => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
    lastFlushAtRef.current = Date.now()
    const patches = pendingPatchesRef.current
    pendingPatchesRef.current = []
    if (patches.length === 0) return
    setMessages((prev) => {
      let next = prev
      for (const patch of patches) next = patch(next)
      return next
    })
  }, [])

  const scheduleStreamPatch = useCallback(
    (patch: (prev: ChatMessage[]) => ChatMessage[]): void => {
      pendingPatchesRef.current.push(patch)
      const elapsed = Date.now() - lastFlushAtRef.current
      if (elapsed >= STREAM_THROTTLE_MS) {
        flushStreamPatches()
        return
      }
      throttleTimerRef.current ??= setTimeout(flushStreamPatches, STREAM_THROTTLE_MS - elapsed)
    },
    [flushStreamPatches]
  )

  // 卸载时清掉 pending 定时器，避免组件销毁后 setState
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    }
  }, [])

  /** 当前流式请求 ID；用 ref 是因为事件回调拿不到最新 state */
  const activeStreamRef = useRef<string | null>(null)

  /** 当前流对应的引擎会话 ID，停止时用它显式取消引擎侧运行 */
  const activeSessionRef = useRef<string | null>(null)
  /** Viewing a session outlives its parent stream; child results must still reach its dispatch card. */
  const viewSessionRef = useRef<string | null>(null)
  const rootRunsRef = useRef(new Map<string, RootRun>())
  const activeRunIdRef = useRef<string | null>(null)
  const optimisticIdsRef = useRef<{ userId?: string; assistantId?: string }>({})
  const answeringRef = useRef(new Set<string>())
  const historyRequestRef = useRef(0)
  const consumedEventIdRef = useRef<string | null>(null)
  const recoveryAttemptsRef = useRef(0)
  const recoverRef = useRef<(sessionId: string) => Promise<boolean>>(async () => false)
  const selectView = useCallback((sessionId: string): void => {
    activateCommandSession(sessionId)
    if (viewSessionRef.current === sessionId) return
    const oldStream = activeStreamRef.current
    viewSessionRef.current = sessionId
    historyRequestRef.current++
    consumedEventIdRef.current = null
    recoveryAttemptsRef.current = 0
    activeStreamRef.current = null
    activeSessionRef.current = null
    activeRunIdRef.current = null
    optimisticIdsRef.current = {}
    rootRunsRef.current.clear()
    answeringRef.current.clear()
    pendingPatchesRef.current = []
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    throttleTimerRef.current = null
    setStreaming(false)
    setMessages([])
    setCommandJobs([])
    setTodos([])
    // Detach only this client. The server owns the old run's eventual outcome.
    if (oldStream) void engine.abortStream(oldStream)
  }, [])

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

  /** 队列调度：当前无活动流时按模式发出 —— serial 只发队首，batch 全队列合并成一条 */
  const drainQueue = useCallback(async (): Promise<void> => {
    if (activeStreamRef.current) return
    if (queueSendModeRef.current === 'batch' && queueRef.current.length > 1) {
      const pending = [...queueRef.current]
      syncQueue([])
      const text = pending.map((item, index) => `${index + 1}. ${item.text}`).join('\n\n')
      const attachments = pending.flatMap((item) => item.attachments)
      // 模型取最后一条（更贴近当前意图），其余沿用队首的会话/工作区参数
      const last = pending[pending.length - 1]
      await sendInternalRef.current(text, {
        ...pending[0].options,
        model: last.options.model,
        attachments
      })
      return
    }
    const [next, ...rest] = queueRef.current
    if (!next) return
    syncQueue(rest)
    await sendInternalRef.current(next.text, next.options)
  }, [syncQueue])

  /** 手动发出队列（托盘「发送」按钮）：与 drainQueue 同逻辑，仅供空闲时调用 */
  const flushQueue = useCallback(async (): Promise<void> => {
    if (activeStreamRef.current) return
    if (queueSendModeRef.current === 'batch') {
      const pending = [...queueRef.current]
      if (pending.length === 0) return
      syncQueue([])
      if (pending.length === 1) {
        await sendInternalRef.current(pending[0].text, pending[0].options)
        return
      }
      const text = pending.map((item, index) => `${index + 1}. ${item.text}`).join('\n\n')
      const attachments = pending.flatMap((item) => item.attachments)
      const last = pending[pending.length - 1]
      await sendInternalRef.current(text, {
        ...pending[0].options,
        model: last.options.model,
        attachments
      })
      return
    }
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
    const offCommands = subscribeCommandJobs(() => {
      const sessionId = viewSessionRef.current
      if (sessionId) {
        const jobs = getCommandJobs(sessionId)
        setCommandJobs(previous => previous.length === jobs.length && previous.every((job, index) => job === jobs[index]) ? previous : jobs)
        setMessages(previous => attachCommandJobs(previous, jobs, sessionId))
      }
    })
    const offSubagents = subscribeSubagents(() => {
      setMessages((prev) => attachSubagentRuns(prev, getSubagentRuns(viewSessionRef.current)))
    })
    const reconcile = () => {
      const sessionId = viewSessionRef.current
      if (sessionId && hasActiveSubagents(sessionId)) {
        void refreshSubagentRuns(sessionId).catch(() => {})
        void refreshCommandJobs(sessionId).catch(() => {})
      }
    }
    const timer = setInterval(reconcile, 2500)
    const off = engine.onStreamEvent((event: StreamEvent) => {
      if (event.streamId === activeStreamRef.current) {
        if (!acceptEventId(consumedEventIdRef.current, event.eventId)) return
        if (event.eventId) { consumedEventIdRef.current = event.eventId; recoveryAttemptsRef.current = 0 }
      }
      if (event.type === 'payload') {
        if (event.payload.subagentEvent) {
          const child = ingestSubagentEvent(event.payload.subagentEvent)
          if (child) void refreshCommandJobs(child.parentSessionId).catch(() => {})
          return
        }
        const result = event.payload.toolEnd ?? event.payload.toolResult
        if (result) {
          const normalized = normalizeTool(result)
          if (normalized.subagent) ingestSubagentRun(normalized.subagent)
          if (normalized.commandJob) ingestCommandJob(normalized.commandJob)
          // Child snapshots carry their own session ownership; ordinary results require the active stream below.
        }
      }
      // 只处理当前这条流，忽略历史流的迟到事件
      if (event.streamId !== activeStreamRef.current) return
      applyEvent(event)
    })
    return () => { off(); offSubagents(); offCommands(); clearInterval(timer) }

    function recover(sessionId: string): void {
      if (++recoveryAttemptsRef.current <= 3) { void recoverRef.current(sessionId); return }
      setMessages(previous => patchLastAssistant(previous, message => finishTransport(message, '连接多次中断，请重新打开此会话恢复')))
    }

    function applyEvent(event: StreamEvent): void {
      if (event.type === 'snapshot-required' || (event.type === 'payload' && (event.payload as { code?: string }).code === 'snapshot_required')) {
        const sessionId = activeSessionRef.current
        const previousStream = activeStreamRef.current
        activeStreamRef.current = null
        if (previousStream) void engine.abortStream(previousStream)
        setStreaming(false)
        if (sessionId && viewSessionRef.current === sessionId) recover(sessionId)
        return
      }
      if (event.type === 'done' || event.type === 'error') {
        // 终态是关键帧：先立即 flush 掉攒着的流式 patch，再落终态 ——
        // 否则最后一波正文会晚 80ms 出现在「已完成」的消息上
        flushStreamPatches()
        setMessages((prev) => patchLastAssistant(prev, (msg) => finishTransport(msg, event.type === 'error' ? event.message : undefined)))
        const run = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
        setStreaming(false)
        activeStreamRef.current = null
        answeringRef.current.clear()
        reconcile()
        if (run?.status === 'succeeded') void drainQueueRef.current()
        else if (event.type === 'error' && run?.status === 'running' && activeSessionRef.current === viewSessionRef.current) {
          const sessionId = activeSessionRef.current
          if (sessionId) recover(sessionId)
        }
        return
      }

      const run = normalizeRootRun(event.payload.run)
      if (run && run.sessionId === activeSessionRef.current) {
        flushStreamPatches()
        const merged = mergeRootRun(rootRunsRef.current.get(run.runId), run)
        rootRunsRef.current.set(run.runId, merged)
        activeRunIdRef.current = run.runId
        const optimistic = { ...optimisticIdsRef.current }
        setMessages((prev) => applyRootRun(prev, merged, optimistic))
        return
      }
      if (event.payload.userMsgId || event.payload.assistantMsgId) {
        const ids = { ...optimisticIdsRef.current }
        const activeRunId = activeRunIdRef.current
        setMessages((prev) => prev.map(message => {
          if (event.payload.userMsgId && message.id === ids.userId) return { ...message, id: event.payload.userMsgId }
          if (event.payload.assistantMsgId && message.role === 'assistant' && (message.id === ids.assistantId || message.runId === activeRunId)) return { ...message, id: event.payload.assistantMsgId }
          return message
        }))
        // React may apply these queued updaters after subsequent SSE frames. Never mutate a captured ID map.
        optimisticIdsRef.current = {
          ...ids,
          ...(event.payload.userMsgId ? { userId: event.payload.userMsgId } : {}),
          ...(event.payload.assistantMsgId ? { assistantId: event.payload.assistantMsgId } : {})
        }
        return
      }

      // todo 帧是会话级清单，不归属任何一条消息
      const todoFrame = event.payload.todo
      if (todoFrame && Array.isArray(todoFrame.todos)) {
        setTodos(todoFrame.todos)
        return
      }

      const payload = event.payload
      const ownerRunId = activeRunIdRef.current ?? undefined
      // 流式数据帧走节流队列：高频 content/thinking delta 攒 80ms 合并一次渲染
      scheduleStreamPatch((prev) => {
        const result = payload.toolEnd ?? payload.toolResult
        // Approval frames can also carry tool results; preserve their pending interaction first.
        const updated = result && !normalizePending(payload) ? applyToolResult(prev, result, ownerRunId) : prev
        if (updated !== prev) return attachSubagentRuns(updated, getSubagentRuns(viewSessionRef.current))
        return attachSubagentRuns(patchLastAssistant(prev, (msg) => ({
          // 首个数据帧即本轮真实起点：起流到首帧之间的建连耗时不计入使用时间
          ...(msg.startedAt ? {} : { startedAt: Date.now() }),
          ...reducePayload(msg, payload)
        })), getSubagentRuns(viewSessionRef.current))
      })
    }
  }, [flushStreamPatches, scheduleStreamPatch])

  /** 统一起流：设置激活流 ID 并发出请求 */
  const runStream = useCallback(async (body: Record<string, unknown>) => {
    const streamId = newId()
    activeStreamRef.current = streamId
    consumedEventIdRef.current = null
    recoveryAttemptsRef.current = 0
    activeSessionRef.current = typeof body.sessionId === 'string' ? body.sessionId : null
    viewSessionRef.current = activeSessionRef.current
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

  /** 编辑队列中一条消息（正文 / 附件），其余字段（options、id）保持不动 */
  const updateQueued = useCallback(
    (id: string, text: string, attachments: ChatAttachment[]): void => {
      syncQueue(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, text: text.trim(), attachments } : item
        )
      )
    },
    [syncQueue]
  )

  /** 拖拽排序：把 fromIndex 的消息挪到 toIndex */
  const moveQueued = useCallback(
    (fromIndex: number, toIndex: number): void => {
      const list = [...queueRef.current]
      if (
        fromIndex < 0 ||
        fromIndex >= list.length ||
        toIndex < 0 ||
        toIndex >= list.length ||
        fromIndex === toIndex
      )
        return
      const [moved] = list.splice(fromIndex, 1)
      list.splice(toIndex, 0, moved)
      syncQueue(list)
    },
    [syncQueue]
  )

  /** 队列发送模式（serial 按序逐条 / batch 合并成一条），localStorage 持久化 */
  const [queueSendMode, setQueueSendModeState] = useState<QueueSendMode>(loadQueueSendMode)
  const queueSendModeRef = useRef<QueueSendMode>(queueSendMode)
  const setQueueSendMode = useCallback((mode: QueueSendMode): void => {
    queueSendModeRef.current = mode
    setQueueSendModeState(mode)
    try {
      localStorage.setItem(QUEUE_SEND_MODE_KEY, mode)
    } catch {
      /* 私密模式等场景写不进就保持内存值 */
    }
  }, [])

  /**
   * 运行中切换模型时，把队列里所有待发消息的 options.model 改写为新模型。
   * 已发出的回合不受影响（它显示的是自己启动时的 modelId），
   * 避免出现「正在运行的回合显示成输入框后选的模型」这类错标。
   */
  const retargetQueuedModel = useCallback(
    (model: string): void => {
      const list = queueRef.current
      if (list.length === 0) return
      syncQueue(list.map((item) => ({ ...item, options: { ...item.options, model } })))
    },
    [syncQueue]
  )

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

      activeRunIdRef.current = null
      optimisticIdsRef.current = { userId: userMessage.id, assistantId: assistantMessage.id }
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
        subagentModel: options.subagentModel || undefined,
        utilityModel: options.utilityModel || undefined,
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
  const restoreSession = useCallback(async (sessionId: string): Promise<ChatRecoverySnapshot | null> => {
    if (!sessionId) return null
    selectView(sessionId)
    if (activeStreamRef.current) return null
    const generation = ++historyRequestRef.current
    try {
      const [result] = await Promise.all([
        engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId } }),
        refreshSubagentRuns(sessionId).catch(() => {})
      ])
      if (!result.ok || !result.data || result.data.schemaVersion !== 1 || result.data.sessionId !== sessionId) return null
      if (activeStreamRef.current || viewSessionRef.current !== sessionId || generation !== historyRequestRef.current) return null
      const snapshot = result.data
      const restored = restoreChatSnapshot(snapshot)
      for (const job of snapshot.commandJobs ?? []) ingestCommandJob(job)
      rootRunsRef.current.clear()
      for (const run of snapshot.runs) rootRunsRef.current.set(run.runId, run)
      if (snapshot.run) rootRunsRef.current.set(snapshot.run.runId, snapshot.run)
      activeRunIdRef.current = snapshot.run?.runId ?? null
      consumedEventIdRef.current = snapshot.eventId
      optimisticIdsRef.current = {}
      for (const message of restored.messages) for (const tool of message.tools) {
        if (tool.subagent) ingestSubagentRun(tool.subagent)
        if (tool.commandJob) ingestCommandJob(tool.commandJob)
      }
      setMessages(attachCommandJobs(attachSubagentRuns(restored.messages, getSubagentRuns(sessionId), true), getCommandJobs(sessionId), sessionId))
      setCommandJobs(getCommandJobs(sessionId))
      setTodos(restored.todos)
      return snapshot
    } catch { return null }
  }, [selectView])

  const loadHistory = useCallback(async (sessionId: string): Promise<void> => {
    await restoreSession(sessionId)
  }, [restoreSession])

  /** Snapshot and watermark describe the same state; subscribe only after replacing the current turn. */
  const resumeStream = useCallback(async (sessionId: string): Promise<boolean> => {
    const snapshot = await restoreSession(sessionId)
    if (!snapshot || activeStreamRef.current || viewSessionRef.current !== sessionId ||
      snapshot.source !== 'live' || snapshot.finished || !snapshot.eventId) return false
    const streamId = 'resume-' + newId()
    activeStreamRef.current = streamId
    activeSessionRef.current = sessionId
    setStreaming(true)
    await engine.startStream({ streamId, path: '/chat/stream', method: 'GET',
      query: { sessionId, lastEventId: snapshot.eventId }, body: undefined })
    return true
  }, [restoreSession])
  useEffect(() => { recoverRef.current = resumeStream }, [resumeStream])

  /**
   * 应答提问/授权。
   *
   * 引擎没有专用端点，唯一方式是再发一次 /chat 带 toolResponse；
   * 引擎按持久化 requestId 恢复原运行；批准后执行保存的参数，重复应答不重复执行。
   */
  const respond = useCallback(
    async (
      requestId: string,
      values: string[],
      options: Pick<SendOptions, 'sessionId' | 'model' | 'workspacePaths'> &
        Partial<Pick<SendOptions, 'thinkingMode' | 'subagentModel' | 'utilityModel'>>
    ) => {
      if (activeStreamRef.current || answeringRef.current.has(requestId)) return
      const target = messages.find(message => message.interactions?.some(item => item.requestId === requestId && item.status === 'pending'))
      const pending = target?.interactions?.find(item => item.requestId === requestId && item.status === 'pending')
      if (!target?.run || !pending?.runId || target.run.sessionId !== options.sessionId) throw new Error('待应答请求已变化，请重新加载会话')
      answeringRef.current.add(requestId)
      activeRunIdRef.current = target.runId ?? null
      optimisticIdsRef.current = { assistantId: target.id }
      setStreaming(true)
      try {
        // The engine restores the original model/workspace and acknowledges the request before UI marks it answered.
        await runStream({ sessionId: options.sessionId, runId: target.runId, toolResponse: buildToolResponse(pending, values) })
      } catch (error) {
        answeringRef.current.delete(requestId)
        setStreaming(false)
        throw error
      }
    }, [messages, runStream]
  )

  const abort = useCallback(async (): Promise<void> => {
    const streamId = activeStreamRef.current
    const sessionId = activeSessionRef.current
    if (!streamId || !sessionId) return
    syncQueue([])
    try {
      // Cancellation is an engine operation. Detaching first would leave tools executing during recovery.
      await engine.requestOrThrow({ method: 'POST', path: '/chat/cancel', body: { sessionId } })
      await engine.abortStream(streamId)
      if (activeStreamRef.current === streamId) activeStreamRef.current = null
      if (viewSessionRef.current !== sessionId) return
      flushStreamPatches()
      setStreaming(false)
      await loadHistory(sessionId)
    } catch (error) {
      if (viewSessionRef.current === sessionId) setMessages(previous => patchLastAssistant(previous,
        message => ({ ...message, error: error instanceof Error ? error.message : String(error) })))
    }
  }, [syncQueue, flushStreamPatches, loadHistory])

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
        forgetSubagentSession(sessionId)
        forgetCommandSession(sessionId)
      }
      setMessages([])
      setCommandJobs([])
      setTodos([])
    },
    []
  )

  /**
   * 把界面消息定位到引擎历史行。
   *
   * 界面里只有「历史回放」的消息带引擎 message_id；刚发出去的实时消息
   * id 在 run 首帧回填为引擎 ID。只允许精确 ID，不能按正文猜测轮次。
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
      return rows.find((row) => row.id === message.id) ?? null
    },
    []
  )

  /** 删除一整轮对话（该消息所在轮：从轮首用户消息到下一个用户消息之前），同步删引擎侧历史 */
  const deleteTurn = useCallback(
    async (sessionId: string, message: ChatMessage): Promise<void> => {
      if (activeStreamRef.current) return
      const row = await resolveEngineRow(sessionId, message)
      const turnId = message.conversationId ?? row?.conversationId
      if (!row || !turnId) throw new Error('未能定位该轮对话的引擎记录，请重新加载会话')
      const result = await engine.request({
        method: 'DELETE',
        path: `/conversation/turns/${encodeURIComponent(turnId)}`,
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
      if (!row?.id) throw new Error('未能定位该消息的稳定记录，请重新加载会话')
      if (row.id) {
        const result = await engine.request({
          method: 'POST',
          path: '/conversation/truncate',
          body: { sessionId: options.sessionId, messageId: row.id }
        })
        if (!result.ok) throw new Error(result.message || '引擎侧截断失败')
      }
      if (viewSessionRef.current !== options.sessionId) return
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
      await revertConversationFrom(engine.requestOrThrow, sessionId, userMessage)
      // A slow rollback may finish after navigation. Do not remove another session's messages.
      if (viewSessionRef.current !== sessionId) return
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === userMessage.id)
        return i >= 0 ? prev.slice(0, i) : prev
      })
    },
    []
  )

  return {
    messages,
    commandJobs,
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
    clearQueue,
    flushQueue,
    updateQueued,
    moveQueued,
    queueSendMode,
    setQueueSendMode,
    retargetQueuedModel,
    resumeStream
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
