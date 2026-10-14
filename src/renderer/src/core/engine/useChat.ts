import type { CommandJobSnapshot } from '@shared/command-job'
import { attachCommandJobs } from './command-job-state'
import { subscribeCommandJobs, getCommandJobs, ingestCommandJob, forgetCommandSession, refreshCommandJobs, activateCommandSession, deactivateCommandSession } from './command-job-store'
import type { SubagentRun, SubagentDiscoveryRef } from '@shared/subagent'
import { normalizeRootRunCompaction, normalizeRootRunRequestConfig, type RootRun, type RootRunCompaction, type RootRunRequestConfig } from '@shared/root-run'
import { applyRootRun, finishTransport, mergeRootRun, normalizeRootRun } from './root-run-state'
import { applyToolResult, normalizeTool, type EngineHistoryRow } from './chat-history'
export { extractText } from './chat-history'
import { attachSubagentRuns, applySubagentDeletions } from './subagent-state'
import { ingestSubagentEventResult, ingestSubagentRun, ingestSubagentRunResult, getSubagentRuns, refreshSubagentRuns, subscribeSubagents, subscribeSubagentDeletions, forgetSubagentSession, hasActiveSubagents } from './subagent-store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createSessionUsageAnchor, sessionUsageTotal, type SessionUsageAnchor } from '@renderer/contrib/chat/session-usage'
import type { UsageTotal } from '@renderer/contrib/chat/usage'
import { reducePayload } from './chat-payload'
import { acceptEventId, restoreChatSnapshot, type ChatRecoverySnapshot } from './chat-recovery'
import { preparePublishedSnapshot } from './published-snapshot-client'
import { createPublishedHydrationBuffer } from './published-hydration-buffer'
import { advancePublishedChild, parsePublishedUsage } from './published-child-recovery'
import { createPublishedUsageRefresh, publishedUsageOwner, type PublishedUsageScope } from './published-usage-refresh'
import { createPublishedRecoveryControl, PublishedRecoveryCancelledError, type PublishedRecoveryProgress } from './published-recovery-control'
import { createRecoveryLoop, createRecoverySingleFlight, durableCancelBody, recoverSnapshot, recoveryFailure, reducedEventCursor,
  sameRecoveryScope, type RecoveryLease, type RecoveryOutcome, type RecoveryRestoreResult, type RecoveryScope, type RecoveryState } from './chat-recovery-loop'
import type { EngineFileChange, EngineTodo, StreamEvent } from '@shared/ipc'
import * as engine from './client'
import { assertEngineSource, getEngineSource, isEngineReady, isRemoteEngine, subscribeEngineSource } from './source'
import { revertConversationFrom } from './change-revert'
import {
  buildToolResponse,
  normalizePending,
  type PendingInteraction
} from './pending'
import { patchSessionMeta } from '@renderer/contrib/history/session-meta'
import type { MemoryScope } from './memory'
import { ARCHIVE_PAGE_SIZE, loadArchiveWindow, mergeArchiveProjection, type ArchiveWindow } from './archive-pages'
import { createIdleRootDiscovery } from './idle-root-discovery'
import { createHistoryMutationGuard } from './history-mutation'
import { getAppMode, onAppModeChanged } from '@renderer/core/platform/app-mode'
import { createQueuedChatEntry, editQueuedChatEntry, type QueuedChatEntry } from './chat-queue-entry'
import { dispatchChatRequest } from './chat-send-request'

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
  /** Unloaded exact published reference; never a latest/complete run. */
  subagentRef?: import('@shared/published-child').PublishedChildReference
  /** A trusted lifecycle deletion prevents an older resident projection from reviving this dispatch. */
  subagentDeletion?: SubagentDiscoveryRef
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
  publishedChildFence?: import('@shared/published-child').PublishedChildFence
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
  /** Model owning the latest input snapshot; a model-only frame can announce the next model independently. */
  contextModelId?: string
  /** Source of the latest input snapshot, independent of output usage estimates. */
  contextUsageEstimated?: boolean
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
  /** 远端上传后由主进程分配的 opaque 引用；本地附件不设置。 */
  remoteUploadId?: string
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
  collaborators?: import('@shared/subagent').AgentCollaborator[]
  model?: string
  /** Knowledge-base IDs selected for this session; an empty array explicitly disables RAG. */
  knowledgeBases?: string[]
  /** Skill IDs explicitly selected from the composer resource menu. */
  skills?: string[]
  /** MCP server IDs explicitly selected from the composer resource menu. */
  mcpServers?: string[]
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
  thinkingMode?: 'low' | 'medium' | 'high' | boolean
  /** 子代理专用模型（空/undefined = 跟随主模型）；来自设置「按用途指派」 */
  subagentModel?: string
  /** 轻任务专用模型（图片理解等旁路调用）；来自设置「按用途指派」 */
  utilityModel?: string
  /**
   * 已由会话设置确认的长期记忆范围。缺省时由引擎兼容旧客户端并自行决定；
   * Aether UI 会在设置尚未确认时显式发送 off，避免误把旧会话升级成全局记忆。
   */
  memoryScope?: MemoryScope
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ==================== Hook ====================

export interface ChatSessionModelContext {
  source: number
  sessionId: string
  modelId?: string
  runId?: string
  requestConfig?: RootRunRequestConfig
  compaction?: RootRunCompaction
}

export function useChat(options: { commandOwner?: string } = {}): {
  messages: ChatMessage[]
  /** Authoritative lifetime billing plus only usage added after the current snapshot. */
  sessionUsage: UsageTotal
  usageSyncNotice: string | null
  publishedRecovery: PublishedRecoveryProgress | null
  publishedFixedChildren: boolean
  cancelPublishedRecovery: () => void
  loadPublishedBody: () => void
  retryPublishedRecovery: () => void
  commandJobs: CommandJobSnapshot[]
  sessionModel: ChatSessionModelContext | null
  streaming: boolean
  /** Transport recovery is independent of the durable execution outcome. */
  connection: RecoveryState
  historyError: string | null
  isHistoryReady: (sessionId: string) => boolean
  /** The compact snapshot omitted older JSONL rows that can be loaded on demand. */
  historyCompacted: boolean
  archiveRemaining: number | null
  archiveLoading: boolean
  archiveError: string | null
  /** Expand the explicit transcript archive into the visible chat timeline. */
  loadArchive: (sessionId: string) => Promise<void>
  /** 会话待办清单（引擎 todo 工具维护，随 \x00__todo__ 帧整表下发） */
  todos: EngineTodo[]
  send: (text: string, options: SendOptions) => Promise<void>
  /** Exact selected-session admission gate, including synchronous dispatch and recovery. */
  hasSessionWork: (sessionId?: string | null) => boolean
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
  retargetQueuedModel: (model: string, sessionId: string) => void
  /**
   * 恢复断开的流（刷新页面 / 切回会话后调用）。
   * 返回 true 表示该会话确有进行中的流且已成功挂接；false 表示无需恢复。
   */
  resumeStream: (sessionId: string) => Promise<boolean>
} {
  const commandOwner = options.commandOwner ?? 'code'
  const renderSource = getEngineSource()
  const sourceRef = useRef(renderSource)
  const [messages, dispatchMessages] = useState<ChatMessage[]>([])
  const publishedHydrationRef = useRef<{
    snapshotId: string; sessionId: string; source: number
    buffer: ReturnType<typeof createPublishedHydrationBuffer<ChatMessage[]>>
    active: () => boolean; activate: () => void; cancel: () => void
  } | null>(null)
  const setMessages = useCallback((update: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[]), input?: unknown): void => {
    const hydration = publishedHydrationRef.current
    if (typeof update === 'function' && hydration?.active()) {
      if (input !== undefined) hydration?.buffer.account(input)
      hydration?.buffer.record(update)
    } else if (typeof update !== 'function') { hydration?.cancel(); publishedHydrationRef.current = null }
    dispatchMessages(update)
  }, [])
  const [sessionUsageAnchor, setSessionUsageAnchor] = useState<SessionUsageAnchor | null>(null)
  const sessionUsageAnchorRef = useRef<SessionUsageAnchor | null>(null)
  const [usageSyncNotice, setUsageSyncNotice] = useState<string | null>(null)
  const usageRefreshRef = useRef<ReturnType<typeof createPublishedUsageRefresh> | null>(null)
  const publishedControlRef = useRef<ReturnType<typeof createPublishedRecoveryControl> | null>(null)
  const [publishedRecovery, setPublishedRecovery] = useState<PublishedRecoveryProgress | null>(null)
  const commitUsageAnchor = useCallback((anchor: SessionUsageAnchor | null): void => {
    sessionUsageAnchorRef.current = anchor
    setSessionUsageAnchor(anchor)
    setUsageSyncNotice(null)
  }, [])
  const sessionUsage = useMemo(() => sessionUsageTotal(messages, sessionUsageAnchor), [messages, sessionUsageAnchor])
  const [commandJobs, setCommandJobs] = useState<CommandJobSnapshot[]>([])
  const [sessionModel, setSessionModel] = useState<ChatSessionModelContext | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const restoredSessionRef = useRef<string | null>(null)
  const isHistoryReady = useCallback((sessionId: string): boolean => restoredSessionRef.current === sessionId && sourceRef.current === getEngineSource(), [])
  const [todos, setTodos] = useState<EngineTodo[]>([])
  const [historyCompacted, setHistoryCompacted] = useState(false)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [archiveRemaining, setArchiveRemaining] = useState<number | null>(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const archiveWindowRef = useRef<ArchiveWindow | undefined>(undefined)
  const archiveLoadingRef = useRef<object | null>(null)

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
  // Subagent store notifications can arrive for every child tool delta. Keep
  // them on the same 80 ms cadence as the root stream so a hidden Work pane
  // cannot turn a high-frequency child transcript into a full-tree render.
  const subagentAttachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStreamPatches = useCallback((): void => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
    lastFlushAtRef.current = Date.now()
    const patches = pendingPatchesRef.current
    pendingPatchesRef.current = []
    if (patches.length === 0) return
    // Each patch was admitted to the recovery ledger when scheduled. Recording
    // this group again would both duplicate replay and hide its actual size.
    dispatchMessages((prev) => {
      let next = prev
      for (const patch of patches) next = patch(next)
      return next
    })
    const sessionId = viewSessionRef.current
    if (sessionId) {
      const runs = getSubagentRuns(sessionId)
      setMessages(previous => attachSubagentRuns(previous, runs), runs)
    }
  }, [])

  const scheduleStreamPatch = useCallback(
    (patch: (prev: ChatMessage[]) => ChatMessage[], input?: unknown): void => {
      const hydration = publishedHydrationRef.current
      if (hydration?.active()) {
        if (input !== undefined) hydration.buffer.account(input)
        hydration.buffer.record(patch)
      }
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
      if (subagentAttachTimerRef.current) clearTimeout(subagentAttachTimerRef.current)
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
  const approvalRefreshRef = useRef<{ sessionId: string; source: number } | null>(null)
  const historyRequestRef = useRef(0)
  const consumedEventIdRef = useRef<string | null>(null)
  const viewEpochRef = useRef(0)
  const mountedRef = useRef(true)
  const stoppingRef = useRef<RecoveryScope | null>(null)
  const recoveryAttemptRef = useRef<(lease: RecoveryLease) => Promise<RecoveryOutcome>>(async () => 'retry')
  const [connection, setConnection] = useState<RecoveryState>({ scope: null, phase: 'idle', failures: 0 })
  const [snapshotReads] = useState(() => createRecoverySingleFlight<RecoveryRestoreResult<ChatRecoverySnapshot>>())
  const [idleRootDiscovery] = useState(createIdleRootDiscovery)
  const [historyMutationGuard] = useState(createHistoryMutationGuard)
  const [recoveryLoop] = useState(() => createRecoveryLoop({
    attempt: lease => recoveryAttemptRef.current(lease),
    isScopeCurrent: scope => mountedRef.current && sourceRef.current === getEngineSource() &&
      scope.source === sourceRef.current && scope.sessionId === viewSessionRef.current && scope.viewEpoch === viewEpochRef.current,
    onState: state => { if (mountedRef.current) setConnection(state) }
  }))
  const recoveryScope = useCallback((sessionId: string): RecoveryScope => ({
    source: sourceRef.current, sessionId, viewEpoch: viewEpochRef.current
  }), [])
  const scopeIsCurrent = useCallback((scope: RecoveryScope): boolean => mountedRef.current &&
    sourceRef.current === getEngineSource() && sameRecoveryScope(scope, recoveryScope(viewSessionRef.current ?? '')), [recoveryScope])
  const invalidateRecovery = useCallback((): void => {
    viewEpochRef.current++
    historyRequestRef.current++
    recoveryLoop.cancel()
    snapshotReads.clear()
    idleRootDiscovery.clear()
    usageRefreshRef.current?.clear()
    publishedHydrationRef.current?.cancel()
    publishedHydrationRef.current = null
    publishedControlRef.current?.cancel()
    publishedControlRef.current = null
    if (mountedRef.current) setPublishedRecovery(null)
    stoppingRef.current = null
  }, [recoveryLoop, snapshotReads, idleRootDiscovery])
  const hasSessionWork = useCallback((sessionId = viewSessionRef.current): boolean => {
    if (!sessionId || sessionId !== viewSessionRef.current) return false
    const scope = recoveryScope(sessionId)
    const recovery = recoveryLoop.state()
    const run = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
    return Boolean(activeStreamRef.current || durableCancelBody(sessionId, run) ||
      (stoppingRef.current && sameRecoveryScope(scope, stoppingRef.current)) ||
      (recovery.scope && sameRecoveryScope(scope, recovery.scope) && ['connecting', 'retrying'].includes(recovery.phase)))
  }, [recoveryLoop, recoveryScope])
  const recoverRef = useRef<(sessionId: string) => Promise<boolean>>(async () => false)
  const [publishedUsageRefresh] = useState(() => createPublishedUsageRefresh({
    current: scope => scopeIsCurrent(scope) && scope.historyEpoch === historyRequestRef.current &&
      restoredSessionRef.current === scope.sessionId && !historyMutationGuard.blocked(scope),
    authority: () => sessionUsageAnchorRef.current?.publishedChildren,
    read: async scope => {
      const result = await engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', subagentProtocol: 2,
        query: { sessionId: scope.sessionId, childRecoveryProtocol: 1 } })
      if (!result.ok || !result.data || result.data.schemaVersion !== 1 || result.data.sessionId !== scope.sessionId)
        throw new Error(result.message || '无法同步用量统计')
      return parsePublishedUsage(result.data.subagentRecovery, scope.source, scope.sessionId)
    },
    accept: (_scope, usage) => {
      const anchor = sessionUsageAnchorRef.current
      if (!anchor) return
      const next = { ...anchor, children: usage.scalar, publishedChildren: usage }
      sessionUsageAnchorRef.current = next
      setSessionUsageAnchor(next)
    },
    pending: (_scope, message) => setUsageSyncNotice(message),
    ownerChanged: scope => { void recoverRef.current(scope.sessionId).catch(() => {}) }
  }))
  useEffect(() => { usageRefreshRef.current = publishedUsageRefresh }, [publishedUsageRefresh])
  const cancelPublishedRecovery = useCallback((): void => {
    publishedHydrationRef.current?.cancel()
    publishedHydrationRef.current = null
    publishedControlRef.current?.cancel()
    setPublishedRecovery(previous => previous ? { ...previous, phase: 'cancelled' } : previous)
  }, [])
  const loadPublishedBody = useCallback((): void => { publishedControlRef.current?.requestBody() }, [])
  const retryPublishedRecovery = useCallback((): void => {
    const sessionId = viewSessionRef.current
    if (!sessionId) return
    const oldStream = activeStreamRef.current
    flushStreamPatches()
    invalidateRecovery()
    activeStreamRef.current = null
    // This detaches only the renderer reader; the durable run keeps executing.
    if (oldStream) void engine.abortStream(oldStream).catch(() => {})
    void recoverRef.current(sessionId).catch(() => {})
  }, [flushStreamPatches, invalidateRecovery])
  const selectView = useCallback((sessionId: string): void => {
    activateCommandSession(sessionId, commandOwner)
    if (viewSessionRef.current === sessionId) return
    const oldStream = activeStreamRef.current
    invalidateRecovery()
    viewSessionRef.current = sessionId
    restoredSessionRef.current = null
    setHistoryError(null)
    consumedEventIdRef.current = null
    activeStreamRef.current = null
    activeSessionRef.current = null
    activeRunIdRef.current = null
    optimisticIdsRef.current = {}
    rootRunsRef.current.clear()
    answeringRef.current.clear()
    approvalRefreshRef.current = null
    pendingPatchesRef.current = []
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    throttleTimerRef.current = null
    setStreaming(false)
    setMessages([])
    commitUsageAnchor(null)
    setSessionModel(null)
    setCommandJobs([])
    setTodos([])
    setHistoryCompacted(false)
    setArchiveExpanded(false)
    archiveWindowRef.current = undefined
    archiveLoadingRef.current = null
    setArchiveRemaining(null)
    setArchiveLoading(false)
    setArchiveError(null)
    // Detach only this client. The server owns the old run's eventual outcome.
    if (oldStream) void engine.abortStream(oldStream)
  }, [commandOwner, invalidateRecovery, commitUsageAnchor])
  useEffect(() => () => deactivateCommandSession(commandOwner), [commandOwner])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateRecovery()
      const streamId = activeStreamRef.current
      activeStreamRef.current = null
      pendingPatchesRef.current = []
      if (streamId) void engine.abortStream(streamId).catch(() => {})
    }
  }, [invalidateRecovery])

  /**
   * 连续发送队列：流式进行中用户继续发的消息先进队列，
   * 当前流结束（完成/出错/中止）后按序自动发出。
   *
   * 队列本体放 state 而非 ref：托盘 UI 要实时渲染排队消息
   * （预览/删除/清空），ref 变更不触发重渲染。
   * 发送逻辑在事件回调里读队列，用 queueRef 镜像一份保证拿到最新值。
   */
  type QueuedEntry = QueuedChatEntry
  const [queue, setQueue] = useState<QueuedEntry[]>([])
  const queueRef = useRef<QueuedEntry[]>([])
  const syncQueue = useCallback((next: QueuedEntry[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  /** 队列调度：当前无活动流时按模式发出 —— serial 只发队首，batch 全队列合并成一条 */
  const drainQueue = useCallback(async (): Promise<void> => {
    if (!isEngineReady() || sourceRef.current !== getEngineSource() || hasSessionWork()) return
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
  }, [syncQueue, hasSessionWork])

  /** 手动发出队列（托盘「发送」按钮）：与 drainQueue 同逻辑，仅供空闲时调用 */
  const flushQueue = useCallback(async (): Promise<void> => {
    if (!isEngineReady() || sourceRef.current !== getEngineSource() || hasSessionWork()) return
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
  }, [syncQueue, hasSessionWork])

  /**
   * send 的实际执行体（不含排队判断）。由 send（带排队）与 drainQueue 共用。
   * useCallback 初始化顺序：drainQueue 引用它，因此声明在其之前。
   */
  const sendInternalRef = useRef<(text: string, options: SendOptions) => Promise<void>>(async () => {})
  const drainQueueRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const scope = connection.scope
    const run = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
    // A task can finish while the client is disconnected. A recovered terminal
    // snapshot must release its queue just as an observed terminal frame does.
    if (connection.phase === 'idle' && scope && scopeIsCurrent(scope) && run?.status === 'succeeded') {
      void drainQueueRef.current().catch(() => {})
    }
  }, [connection, scopeIsCurrent])

  useEffect(() => subscribeEngineSource(() => {
    const oldStream = activeStreamRef.current
    invalidateRecovery()
    sourceRef.current = getEngineSource()
    activeStreamRef.current = null
    activeSessionRef.current = null
    viewSessionRef.current = null
    restoredSessionRef.current = null
    setHistoryError(null)
    activeRunIdRef.current = null
    consumedEventIdRef.current = null
    optimisticIdsRef.current = {}
    rootRunsRef.current.clear()
    answeringRef.current.clear()
    approvalRefreshRef.current = null
    pendingPatchesRef.current = []
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    throttleTimerRef.current = null
    syncQueue([])
    setStreaming(false)
    setMessages([])
    commitUsageAnchor(null)
    setSessionModel(null)
    setCommandJobs([])
    setTodos([])
    // Detach only: POST cancel would target the new server.
    if (oldStream) void engine.abortStream(oldStream)
  }), [syncQueue, invalidateRecovery, commitUsageAnchor])

  useEffect(() => {
    const offCommands = subscribeCommandJobs(() => {
      const sessionId = viewSessionRef.current
      if (sessionId) {
        const jobs = getCommandJobs(sessionId)
        setCommandJobs(previous => previous.length === jobs.length && previous.every((job, index) => job === jobs[index]) ? previous : jobs)
        setMessages(previous => attachCommandJobs(previous, jobs, sessionId), jobs)
      }
    })
    let childScope: string | null = null
    let childStatuses = new Map<string, SubagentRun['status']>()
    const attachChildren = (): void => {
      if (subagentAttachTimerRef.current) clearTimeout(subagentAttachTimerRef.current)
      subagentAttachTimerRef.current = null
      const sessionId = viewSessionRef.current
      if (!sessionId) return
      const runs = getSubagentRuns(sessionId)
      setMessages((prev) => attachSubagentRuns(prev, runs), runs)
    }
    const offSubagents = subscribeSubagents(() => {
      const sessionId = viewSessionRef.current
      if (!sessionId) return
      if (childScope !== sessionId) { childScope = sessionId; childStatuses = new Map() }
      const runs = getSubagentRuns(sessionId)
      const urgent = runs.some(run => childStatuses.get(run.runId) !== run.status &&
        run.status !== 'queued' && run.status !== 'running')
      childStatuses = new Map(runs.map(run => [run.runId, run.status]))
      if (urgent) { attachChildren(); reconcileChildren(true); return }
      if (subagentAttachTimerRef.current) return
      // The latest durable child snapshot is read when the timer fires rather
      // than captured per notification; intermediate revisions are folded into
      // one parent projection. Cancelling and terminal transitions bypass the
      // timer so stop/error feedback never waits behind streaming updates.
      subagentAttachTimerRef.current = setTimeout(attachChildren, STREAM_THROTTLE_MS)
    })
    const offDeletions = subscribeSubagentDeletions((observation) => {
      const sessionId = viewSessionRef.current
      if (!sessionId || sessionId !== observation.parentSessionId || sourceRef.current !== observation.source) return
      // Capture the accepted tombstones before discovery releases its bounded
      // W fences. React can run the updater after that acknowledgement.
      setMessages(previous => viewSessionRef.current === sessionId && sourceRef.current === observation.source
        ? applySubagentDeletions(previous, observation.refs) : previous, observation.refs)
    })
    const reconcileChildren = (force = false): void => {
      const sessionId = viewSessionRef.current
      if (!sessionId || !mountedRef.current || sourceRef.current !== getEngineSource() || !isEngineReady() ||
        getAppMode() !== commandOwner || document.hidden || historyMutationGuard.blocked(recoveryScope(sessionId))) return
      const authority = sessionUsageAnchorRef.current?.publishedChildren
      if (authority) {
        const scope: PublishedUsageScope = { ...recoveryScope(sessionId), historyEpoch: historyRequestRef.current,
          owner: publishedUsageOwner(authority) }
        void publishedUsageRefresh.request(scope, force)
        return
      }
      // Discovery must not depend on a previously loaded active child or an
      // open panel. An idle parent's later-page child remains server-owned.
      void refreshSubagentRuns(sessionId, { force }).catch(() => {})
      if (hasActiveSubagents(sessionId)) void refreshCommandJobs(sessionId).catch(() => {})
    }
    const reconcile = (): void => {
      const sessionId = viewSessionRef.current
      reconcileChildren()
      if (!sessionId) return
      const scope = recoveryScope(sessionId)
      const current = (): boolean => scopeIsCurrent(scope) && isEngineReady() && getAppMode() === commandOwner &&
        restoredSessionRef.current === sessionId && !activeStreamRef.current && !stoppingRef.current &&
        !historyMutationGuard.blocked(scope) && !approvalRefreshRef.current && answeringRef.current.size === 0 && recoveryLoop.state().phase === 'idle'
      if (!current()) return
      // Finishing one root detaches its SSE, but does not freeze the selected
      // session. Other clients and automation can start the next root there.
      void idleRootDiscovery.check(scope, {
        current,
        read: async () => {
          const result = await engine.request<{ run?: unknown }>({ method: 'GET', path: '/chat/status', query: { sessionId } })
          return result.ok ? normalizeRootRun(result.data?.run) : undefined
        },
        known: () => activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined,
        refresh: () => recoverRef.current(sessionId)
      }).catch(() => {})
    }
    const timer = setInterval(reconcile, 2500)
    const offMode = onAppModeChanged(reconcile)
    const onVisible = (): void => { if (!document.hidden) reconcileChildren(true) }
    document.addEventListener('visibilitychange', onVisible)
    const off = engine.onStreamEvent((event: StreamEvent) => {
      // Reject before ingesting child/job snapshots; IDs can collide across engines.
      if (sourceRef.current !== getEngineSource() || event.streamId !== activeStreamRef.current) return
      if (!acceptEventId(consumedEventIdRef.current, event.eventId)) return
      publishedHydrationRef.current?.buffer.account(event)
      const acknowledge = (status: 'applied' | 'verified-duplicate' | 'gap' | 'invalid' = 'applied'): void => {
        consumedEventIdRef.current = reducedEventCursor(consumedEventIdRef.current, event.eventId, status)
        if (event.eventId && (status === 'applied' || status === 'verified-duplicate')) recoveryLoop.progress(recoveryScope(viewSessionRef.current ?? ''))
      }
      if (event.type === 'payload') {
        if (event.payload.subagentEvent) {
          const result = ingestSubagentEventResult(event.payload.subagentEvent)
          if (result.status === 'gap' || result.status === 'invalid') {
            applyEvent({ streamId: event.streamId, type: 'snapshot-required' })
            return
          }
          acknowledge(result.status)
          if (result.run) {
            const scope = recoveryScope(viewSessionRef.current ?? '')
            const run = result.run, eventId = event.eventId
            setMessages(previous => scopeIsCurrent(scope) ? advancePublishedChild(previous, run, { source: scope.source, sessionId: scope.sessionId, eventId }) : previous, { run, scope, eventId })
          }
          if (result.run) void refreshCommandJobs(result.run.parentSessionId).catch(() => {})
          return
        }
        const result = event.payload.toolEnd ?? event.payload.toolResult
        if (result) {
          const normalized = normalizeTool(result)
          if (normalized.subagent) {
            const child = ingestSubagentRunResult(normalized.subagent)
            if (child.status === 'gap' || child.status === 'invalid') {
              applyEvent({ streamId: event.streamId, type: 'snapshot-required' })
              return
            }
            if (child.run) {
              const scope = recoveryScope(viewSessionRef.current ?? '')
              const run = child.run, eventId = event.eventId
              setMessages(previous => scopeIsCurrent(scope) ? advancePublishedChild(previous, run, { source: scope.source, sessionId: scope.sessionId, eventId }) : previous, { run, scope, eventId })
            }
          }
          if (normalized.commandJob) ingestCommandJob(normalized.commandJob)
          // Child snapshots carry their own session ownership; ordinary results require the active stream below.
        }
      }
      // 只处理当前这条流，忽略历史流的迟到事件
      if (event.streamId !== activeStreamRef.current) return
      // Delta gaps require a fresh exact snapshot. Ordinary content remains on
      // v1 acknowledgement until its reducer supplies a corresponding result.
      if (event.type !== 'snapshot-required' && !(event.type === 'payload' && (event.payload as { code?: string }).code === 'snapshot_required')) acknowledge()
      applyEvent(event)
    })
    return () => {
      off(); offSubagents(); offDeletions(); offCommands(); offMode(); clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      if (subagentAttachTimerRef.current) clearTimeout(subagentAttachTimerRef.current)
      subagentAttachTimerRef.current = null
    }

    function recover(sessionId: string): void {
      recoveryLoop.retry(recoveryScope(sessionId))
      void recoverRef.current(sessionId)
    }

    function refreshWaitingRun(sessionId: string): void {
      const refresh = { sessionId, source: getEngineSource() }
      approvalRefreshRef.current = refresh
      setStreaming(true)
      // A conflict says this client's request may be stale, not that it was
      // rejected. Let the durable snapshot decide whether it remains pending.
      void recoverRef.current(sessionId).catch(() => {}).finally(() => {
        if (approvalRefreshRef.current !== refresh) return
        approvalRefreshRef.current = null
        if (refresh.source === getEngineSource() && viewSessionRef.current === sessionId && !activeStreamRef.current) setStreaming(false)
      })
    }

    function isApprovalConflict(status: number | undefined, code: unknown, message: string): boolean {
      // Older engines wrap admission failures in HTTP 200 JSON or SSE errors.
      // Match only explicit request conflicts; temporary outages stay retryable.
      return status === 404 || status === 409 || [404, 409, 40400, 40900].includes(Number(code)) ||
        /^(Run is no longer waiting|Request already answered differently|Pending request not found(?: for this run and session)?|Run not found)$/.test(message)
    }

    function applyEvent(event: StreamEvent): void {
      const eventScope = recoveryScope(viewSessionRef.current ?? '')
      if (event.type === 'snapshot-required' || (event.type === 'payload' && (event.payload as { code?: string }).code === 'snapshot_required')) {
        const sessionId = activeSessionRef.current
        const previousStream = activeStreamRef.current
        activeStreamRef.current = null
        if (previousStream) void engine.abortStream(previousStream)
        const run = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
        setStreaming(run?.status === 'running')
        if (sessionId && viewSessionRef.current === sessionId) recover(sessionId)
        return
      }
      if (event.type === 'payload') {
        const failure = event.payload as { error?: unknown; code?: unknown }
        if (typeof failure.error === 'string' && isApprovalConflict(undefined, failure.code, failure.error)) {
          applyEvent({ streamId: event.streamId, type: 'error', message: failure.error,
            code: typeof failure.code === 'number' ? failure.code : undefined })
          return
        }
      }
      if (event.type === 'done' || event.type === 'error') {
        // 终态是关键帧：先立即 flush 掉攒着的流式 patch，再落终态 ——
        // 否则最后一波正文会晚 80ms 出现在「已完成」的消息上
        flushStreamPatches()
        const run = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
        // A closed subscription cannot turn a still-running durable task into a failure.
        const receivedAt = Date.now()
        if (!run || run.status !== 'running') setMessages((prev) => patchLastAssistant(prev, (msg) => finishTransport(msg, event.type === 'error' && !run ? event.message : undefined, receivedAt)), { event, receivedAt })
        setStreaming(run?.status === 'running')
        activeStreamRef.current = null
        answeringRef.current.clear()
        reconcileChildren(true)
        reconcile()
        if (run && run.status !== 'running') recoveryLoop.cancel()
        if (run?.status === 'succeeded') void drainQueueRef.current()
        else if (!run && event.type === 'done' && activeSessionRef.current === viewSessionRef.current) {
          // A remote proxy may close the SSE stream just after the payloads and
          // before the terminal run frame is observed locally. Recover the
          // durable snapshot so the message gets its real status instead of
          // remaining an unlabelled interrupted transport.
          const sessionId = activeSessionRef.current
          if (sessionId) {
            recover(sessionId)
          }
        }
        else if (event.type === 'error' && run?.status === 'waiting' && isApprovalConflict(event.status, event.code, event.message) &&
          activeSessionRef.current === viewSessionRef.current) {
          const sessionId = activeSessionRef.current
          if (sessionId) refreshWaitingRun(sessionId)
        }
        else if ((!run || run.status === 'running') && activeSessionRef.current === viewSessionRef.current) {
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
        setSessionModel({ source: sourceRef.current, sessionId: merged.sessionId, runId: merged.runId, modelId: merged.modelId, requestConfig: merged.requestConfig, compaction: merged.compaction })
        const optimistic = { ...optimisticIdsRef.current }
        setMessages((prev) => scopeIsCurrent(eventScope) ? applyRootRun(prev, merged, optimistic) : prev, { merged, optimistic, eventScope })
        return
      }
      if (event.payload.userMsgId || event.payload.assistantMsgId) {
        const ids = { ...optimisticIdsRef.current }
        const activeRunId = activeRunIdRef.current
        setMessages((prev) => !scopeIsCurrent(eventScope) ? prev : prev.map(message => {
          if (event.payload.userMsgId && message.id === ids.userId) return { ...message, id: event.payload.userMsgId }
          if (event.payload.assistantMsgId && message.role === 'assistant' && (message.id === ids.assistantId || message.runId === activeRunId)) return { ...message, id: event.payload.assistantMsgId }
          return message
        }), { event, ids, activeRunId, eventScope })
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
      const receipt = { now: Date.now(), fallbackId: newId() }
      const ownerRunId = activeRunIdRef.current ?? undefined
      // 流式数据帧走节流队列：高频 content/thinking delta 攒 80ms 合并一次渲染
      scheduleStreamPatch((prev) => {
        if (!scopeIsCurrent(eventScope)) return prev
        const result = payload.toolEnd ?? payload.toolResult
        // Approval frames can also carry tool results; preserve their pending interaction first.
        const updated = result && !normalizePending(payload) ? applyToolResult(prev, result, ownerRunId) : prev
        if (updated !== prev) return updated
        return patchLastAssistant(prev, (msg) => ({
          // 首个数据帧即本轮真实起点：起流到首帧之间的建连耗时不计入使用时间
          ...(msg.startedAt ? {} : { startedAt: receipt.now }),
          ...reducePayload(msg, payload, receipt)
        }))
      }, { payload, receipt, ownerRunId, eventScope })
    }
  }, [flushStreamPatches, scheduleStreamPatch, recoveryLoop, recoveryScope, scopeIsCurrent, commandOwner, idleRootDiscovery, historyMutationGuard, publishedUsageRefresh])

  /** 统一起流：设置激活流 ID 并发出请求 */
  const runStream = useCallback(async (body: Record<string, unknown>) => {
    assertEngineSource(renderSource)
    invalidateRecovery()
    const scope = recoveryScope(typeof body.sessionId === 'string' ? body.sessionId : '')
    const streamId = newId()
    activeStreamRef.current = streamId
    consumedEventIdRef.current = null
    activeSessionRef.current = typeof body.sessionId === 'string' ? body.sessionId : null
    viewSessionRef.current = activeSessionRef.current
    try {
    const protocol = await engine.getSubagentProtocol()
    if (!scopeIsCurrent(scope) || activeStreamRef.current !== streamId) return
    await engine.startStream({
      ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}),
      streamId,
      path: '/chat',
      body,
      // A Work stream may be resumed while its surface is hidden behind Code;
      // derive the profile from the hook owner so a mode switch cannot turn a
      // general-profile run into a Code-profile resume.
      toolProfile: commandOwner === 'work' ? 'general' : 'code'
    }) } catch (error) {
      if (!scopeIsCurrent(scope) || activeStreamRef.current !== streamId) return
      activeStreamRef.current = null
      setHistoryError(error instanceof Error ? error.message : '连接中断，正在重新连接')
      if (scope.sessionId) {
        recoveryLoop.retry(scope)
        void recoverRef.current(scope.sessionId)
      }
      throw error
    }
  }, [commandOwner, renderSource, invalidateRecovery, recoveryLoop, recoveryScope, scopeIsCurrent])

  const send = useCallback(
    async (text: string, options: SendOptions) => {
      assertEngineSource(renderSource)
      const trimmed = text.trim()
      // Remote attachments are uploaded into the server session workspace by
      // useAttachments; keep their registered paths when constructing chat
      // requests. Only local workspace paths remain mode-gated below.
      const attachments = options.attachments ?? []
      if ((!trimmed && attachments.length === 0)) return

      // 顺手记下「这条会话在哪个项目里」——会话历史面板的「打开项目目录」靠它
      const workspacePath = options.workspacePaths?.[0]
      if (!isRemoteEngine() && options.sessionId && workspacePath) {
        patchSessionMeta(options.sessionId, { workspacePath })
      }

      // 流式进行中不抢占（引擎对同会话新请求是 abort 旧流，不是排队）：
      // 入队等待，当前流结束后由 drainQueue 按序发出
      if (hasSessionWork(options.sessionId)) {
        syncQueue([...queueRef.current, createQueuedChatEntry(newId(), trimmed, options, attachments)])
        return
      }

      await sendInternalRef.current(trimmed, options)
    },
    [syncQueue, renderSource, hasSessionWork]
  )

  /**
   * 合并发送：把队列中尚未发出的消息与本条合并成一条（正文用空行拼接）。
   * 本条已在流中时合并队列全部；本条未发送时只合并队列。
   */
  const mergeAndSend = useCallback(
    async (text: string, options: SendOptions): Promise<void> => {
      assertEngineSource(renderSource)
      const trimmed = text.trim()
      const pending = [...queueRef.current]
      syncQueue([])
      const parts = [trimmed, ...pending.map((item) => item.text)].filter(Boolean)
      const mergedAttachments = pending.flatMap((item) => item.attachments)
      if (parts.length === 0 && mergedAttachments.length === 0) return
      if (hasSessionWork(options.sessionId)) {
        syncQueue([createQueuedChatEntry(newId(), parts.join('\n\n'), options, [...(options.attachments ?? []), ...mergedAttachments])])
        return
      }
      await sendInternalRef.current(parts.join('\n\n'), {
        ...options,
        attachments: [...(options.attachments ?? []), ...mergedAttachments]
      })
    },
    [syncQueue, renderSource, hasSessionWork]
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
          item.id === id ? editQueuedChatEntry(item, text, attachments) : item
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
    (model: string, sessionId: string): void => {
      const list = queueRef.current
      if (!sessionId || list.length === 0) return
      syncQueue(list.map((item) => item.options.sessionId === sessionId ? { ...item, options: { ...item.options, model } } : item))
    },
    [syncQueue]
  )

  const sendInternal = useCallback(
    async (text: string, options: SendOptions) => {
      assertEngineSource(renderSource)
      const trimmed = text.trim()
      const attachments = options.attachments ?? []
      // 允许「只发附件不发文字」：多模态模型的常见用法就是丢张图让它看
      if ((!trimmed && attachments.length === 0) || hasSessionWork(options.sessionId)) return
      selectView(options.sessionId)

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
      setMessages((prev) => [...prev, userMessage, assistantMessage], [userMessage, assistantMessage])
      setStreaming(true)

      await dispatchChatRequest(runStream, trimmed, options, isRemoteEngine())
    },
    [runStream, renderSource, hasSessionWork, selectView]
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
  const prepareInView = useCallback((snapshot: ChatRecoverySnapshot, source: number, current: () => boolean): Promise<ChatRecoverySnapshot> => {
    const control = createPublishedRecoveryControl()
    publishedHydrationRef.current?.cancel()
    publishedControlRef.current?.cancel()
    publishedControlRef.current = control
    let active = false, finished = false, settled = false
    let latest: ChatRecoverySnapshot | undefined
    let resolve!: (preview: ChatRecoverySnapshot) => void, reject!: (cause: unknown) => void
    const ready = new Promise<ChatRecoverySnapshot>((done, fail) => { resolve = done; reject = fail })
    const buffer = createPublishedHydrationBuffer<ChatMessage[]>({ current,
      exhausted: () => {
        control.cancel()
        if (current()) setPublishedRecovery(previous => previous ? { ...previous, phase: 'cancelled',
          message: '实时更新较多，已暂停较早记录加载；当前任务继续更新，可重新同步记录' } : previous)
      }
    })
    const publish = (preview: ChatRecoverySnapshot): void => {
      if (!current() || !buffer.valid()) return
      latest = preview
      if (!active) return
      flushStreamPatches()
      // Only replace the fixed prefix. Reapply each already accepted live
      // message edit, while todos, ownership and scalar billing stay live.
      dispatchMessages(buffer.rebase(restoreChatSnapshot(preview).messages))
    }
    const hydration = { snapshotId: snapshot.subagentProjectionArchive!.snapshotId, sessionId: snapshot.sessionId, source, buffer,
      active: () => active,
      activate: () => { active = true; if (latest) publish(latest); if (finished) buffer.finish() },
      cancel: () => { buffer.cancel(); control.cancel() }
    }
    publishedHydrationRef.current = hydration
    void preparePublishedSnapshot(snapshot, source, () => { if (!current()) throw new Error('会话或连接已切换') }, {
      signal: control.signal, waitForBody: control.waitForBody,
      progress: (preview, progress) => {
        if (!current() || !buffer.valid()) return
        latest = preview
        setPublishedRecovery(progress)
        if (!settled) { settled = true; resolve(preview) }
        else publish(preview)
      }
    }).then(() => { finished = true; if (active) buffer.finish() }, cause => {
      if (!settled) { settled = true; reject(cause) }
      if (current()) setPublishedRecovery(previous => previous ? { ...previous,
        phase: cause instanceof PublishedRecoveryCancelledError ? 'cancelled' : 'failed',
        message: previous.message ?? (cause instanceof Error ? cause.message : '记录恢复失败，请重新同步') } : previous)
      buffer.cancel()
    }).finally(() => {
      if (publishedControlRef.current === control) publishedControlRef.current = null
    })
    return ready
  }, [flushStreamPatches])
  const activatePublishedSnapshot = useCallback((snapshot: ChatRecoverySnapshot, source: number): void => {
    const hydration = publishedHydrationRef.current
    if (hydration && hydration.source === source && hydration.sessionId === snapshot.sessionId &&
      hydration.snapshotId === snapshot.publishedUsage?.snapshotId) hydration.activate()
  }, [])
  const restoreSession = useCallback((sessionId: string): Promise<RecoveryRestoreResult<ChatRecoverySnapshot>> => {
    if (!sessionId || !isEngineReady() || renderSource !== getEngineSource()) return Promise.resolve({ kind: 'stale' })
    selectView(sessionId)
    const scope = recoveryScope(sessionId)
    if (activeStreamRef.current) return Promise.resolve({ kind: 'attached' })
    return snapshotReads.read(scope, async () => {
    if (!scopeIsCurrent(scope) || !isEngineReady()) return { kind: 'stale' }
    const source = scope.source
    const generation = ++historyRequestRef.current
    const current = () => scopeIsCurrent(scope) && generation === historyRequestRef.current && !activeStreamRef.current
    try {
      const capabilities = await engine.getSubagentCapabilities()
      const protocol = capabilities.protocol
      if (!current()) return { kind: 'stale' }
      const [result] = await Promise.all([
        engine.request<ChatRecoverySnapshot>({ ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}), method: 'GET', path: '/chat/snapshot', query: { sessionId, ...(capabilities.childRecovery ? { childRecoveryProtocol: 1 } : {}) } }),
        capabilities.childRecovery ? Promise.resolve() : refreshSubagentRuns(sessionId).catch(() => {})
      ])
      if (!current()) return { kind: 'stale' }
      if (!result.ok || !result.data || result.data.schemaVersion !== 1 || result.data.sessionId !== sessionId) {
        const message = !result.ok && result.message ? result.message : '无法读取任务历史，正在重新连接'
        setHistoryError(message)
        const failure = result.ok ? 'retry' : recoveryFailure(result.code, message)
        return typeof failure === 'object' ? { kind: 'blocked', message: failure.blocked } : { kind: 'retry' }
      }
      const snapshot = capabilities.childRecovery
        ? await prepareInView(result.data, source, () => scopeIsCurrent(scope) && generation === historyRequestRef.current)
        : result.data
      if (!current()) return { kind: 'stale' }
      const restored = restoreChatSnapshot(snapshot)
      setHistoryCompacted(Boolean(snapshot.historyCompacted) || snapshot.history.some(row =>
        row.role === 'system' && row.metadata?.isCompactSummary === true))
      setArchiveExpanded(false)
      archiveWindowRef.current = undefined
      archiveLoadingRef.current = null
      setArchiveRemaining(null)
      setArchiveLoading(false)
      setArchiveError(null)
      for (const job of snapshot.commandJobs ?? []) ingestCommandJob(job)
      for (const run of snapshot.subagentRuns ?? []) ingestSubagentRun(run)
      rootRunsRef.current.clear()
      for (const run of snapshot.runs) rootRunsRef.current.set(run.runId, run)
      if (snapshot.run) rootRunsRef.current.set(snapshot.run.runId, snapshot.run)
      if (snapshot.executionRun) rootRunsRef.current.set(snapshot.executionRun.runId, snapshot.executionRun)
      const configuredRun = snapshot.executionRun ?? snapshot.run ?? [...snapshot.runs].filter(run => run.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0]
      setSessionModel({ source, sessionId, modelId: configuredRun?.modelId, runId: configuredRun?.runId, requestConfig: normalizeRootRunRequestConfig(configuredRun?.requestConfig), compaction: normalizeRootRunCompaction(configuredRun?.compaction) })
      activeRunIdRef.current = configuredRun?.runId ?? null
      activeSessionRef.current = sessionId
      consumedEventIdRef.current = snapshot.eventId
      optimisticIdsRef.current = {}
      for (const message of restored.messages) for (const tool of message.tools) {
        if (tool.subagent) ingestSubagentRun(tool.subagent)
        if (tool.commandJob) ingestCommandJob(tool.commandJob)
      }
      const restoredMessages = attachCommandJobs(attachSubagentRuns(restored.messages, getSubagentRuns(sessionId), true), getCommandJobs(sessionId), sessionId)
      commitUsageAnchor(createSessionUsageAnchor(restoredMessages, snapshot.sessionUsage, snapshot.sessionSubagentUsage, snapshot.subagentRuns, snapshot.publishedUsage))
      dispatchMessages(restoredMessages)
      activatePublishedSnapshot(snapshot, source)
      setCommandJobs(getCommandJobs(sessionId))
      setTodos(restored.todos)
      setHistoryError(null)
      setStreaming((snapshot.executionRun ?? snapshot.run)?.status === 'running')
      restoredSessionRef.current = sessionId
      return { kind: 'restored', snapshot }
    } catch (cause) {
      if (!current()) return { kind: 'stale' }
      if (cause instanceof PublishedRecoveryCancelledError) return { kind: 'blocked', message: cause.message }
      const message = cause instanceof Error ? cause.message : '无法读取任务历史，正在重新连接'
      setHistoryError(message)
      const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'number' ? cause.code : 0
      const failure = recoveryFailure(code, message)
      return typeof failure === 'object' ? { kind: 'blocked', message: failure.blocked } : { kind: 'retry' }
    }
    })
  }, [selectView, renderSource, snapshotReads, recoveryScope, scopeIsCurrent, commitUsageAnchor, prepareInView, activatePublishedSnapshot])

  const loadArchive = useCallback(async (sessionId: string): Promise<void> => {
    if (!sessionId || !isEngineReady() || renderSource !== getEngineSource() || hasSessionWork(sessionId) || archiveLoadingRef.current || historyMutationGuard.blocked(recoveryScope(sessionId))) return
    const source = getEngineSource()
    const generation = ++historyRequestRef.current
    const loading = {}
    archiveLoadingRef.current = loading
    setArchiveLoading(true)
    setArchiveError(null)
    const current = () => source === getEngineSource() && generation === historyRequestRef.current && viewSessionRef.current === sessionId && !activeStreamRef.current
    try {
      const window = await loadArchiveWindow(async (page, pageSize) => {
        if (!current()) throw new Error('会话或连接已切换')
        const result = await engine.request<EngineHistoryRow[]>({ method: 'GET', path: '/conversation/archive', query: { sessionId, current: String(page), pageSize: String(pageSize) } })
        if (!current()) throw new Error('会话或连接已切换')
        return result
      }, sessionId, archiveWindowRef.current)
      const capabilities = await engine.getSubagentCapabilities()
      const protocol = capabilities.protocol
      if (!current()) return
      const result = await engine.request<ChatRecoverySnapshot>({ ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}), method: 'GET', path: '/chat/snapshot', query: { sessionId, ...(capabilities.childRecovery ? { childRecoveryProtocol: 1 } : {}) } })
      if (!current()) return
      if (!result.ok || !result.data || result.data.schemaVersion !== 1 || result.data.sessionId !== sessionId) throw new Error(result.message || '读取会话快照失败，请重试')
      const snapshot = capabilities.childRecovery
        ? await prepareInView({ ...result.data, history: mergeArchiveProjection(window.rows, result.data.history) }, source, () => source === getEngineSource() && generation === historyRequestRef.current && viewSessionRef.current === sessionId && mountedRef.current)
        : result.data
      if (!current()) return
      const restored = restoreChatSnapshot({ ...snapshot, history: mergeArchiveProjection(window.rows, snapshot.history), historyCompacted: false })
      for (const job of snapshot.commandJobs ?? []) ingestCommandJob(job)
      for (const run of snapshot.subagentRuns ?? []) ingestSubagentRun(run)
      for (const message of restored.messages) for (const tool of message.tools) {
        if (tool.subagent) ingestSubagentRun(tool.subagent)
        if (tool.commandJob) ingestCommandJob(tool.commandJob)
      }
      rootRunsRef.current.clear()
      for (const run of snapshot.runs) rootRunsRef.current.set(run.runId, run)
      if (snapshot.run) rootRunsRef.current.set(snapshot.run.runId, snapshot.run)
      if (snapshot.executionRun) rootRunsRef.current.set(snapshot.executionRun.runId, snapshot.executionRun)
      const configuredRun = snapshot.executionRun ?? snapshot.run ?? [...snapshot.runs].filter(run => run.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0]
      setSessionModel({ source, sessionId, modelId: configuredRun?.modelId, runId: configuredRun?.runId, requestConfig: normalizeRootRunRequestConfig(configuredRun?.requestConfig), compaction: normalizeRootRunCompaction(configuredRun?.compaction) })
      const restoredMessages = attachCommandJobs(attachSubagentRuns(restored.messages, getSubagentRuns(sessionId), true), getCommandJobs(sessionId), sessionId)
      commitUsageAnchor(createSessionUsageAnchor(restoredMessages, snapshot.sessionUsage, snapshot.sessionSubagentUsage, snapshot.subagentRuns, snapshot.publishedUsage))
      dispatchMessages(restoredMessages)
      activatePublishedSnapshot(snapshot, source)
      setCommandJobs(getCommandJobs(sessionId))
      setTodos(restored.todos)
      archiveWindowRef.current = window
      setArchiveRemaining((window.firstPage - 1) * ARCHIVE_PAGE_SIZE)
      setArchiveExpanded(true)
    } catch (error) {
      if (current()) setArchiveError(error instanceof Error ? error.message : '加载历史归档失败，请重试')
    } finally {
      if (archiveLoadingRef.current === loading) { archiveLoadingRef.current = null; setArchiveLoading(false) }
    }
  }, [renderSource, hasSessionWork, historyMutationGuard, recoveryScope, commitUsageAnchor, prepareInView, activatePublishedSnapshot])

  /** Snapshot and watermark describe the same state; subscribe only after replacing the current turn. */
  const attemptRecovery = useCallback((lease: RecoveryLease): Promise<RecoveryOutcome> => recoverSnapshot(lease,
    () => restoreSession(lease.scope.sessionId), async (snapshot, subscription) => {
    const protocol = await engine.getSubagentProtocol()
    if (!subscription.isCurrent()) return
    const sessionId = subscription.scope.sessionId
    const streamId = 'resume-' + newId()
    activeStreamRef.current = streamId
    activeSessionRef.current = sessionId
    setStreaming(true)
    // A resumed stream is a long-lived subscription. Awaiting the IPC call
    // here keeps Work's history gate closed until the server finishes, so
    // switching to another running task would remain stuck on "读取任务".
    // Stream frames still arrive through the shared event listener; only the
    // short-lived admission result is needed by the caller.
    const disconnected = (error?: unknown): void => {
      if (!subscription.isCurrent() || activeStreamRef.current !== streamId) return
      activeStreamRef.current = null
      // Keep session/run ownership so Stop works even with no active subscription.
      setStreaming((snapshot.executionRun ?? snapshot.run)?.status === 'running')
      setHistoryError(error instanceof Error ? error.message : '连接中断，正在重新连接')
      recoveryLoop.retry(subscription.scope)
    }
    void engine.startStream({ streamId, path: '/chat/stream', method: 'GET',
      ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}),
      toolProfile: commandOwner === 'work' ? 'general' : 'code',
      query: { sessionId, lastEventId: snapshot.eventId! }, body: undefined }).then(result => {
        // IPC can fail before the stream reader is registered (for example
        // when the engine switches during recovery). Do not leave the task
        // permanently marked as streaming in that narrow window.
        if (!result.ok) disconnected()
      }).catch(disconnected)
  }), [restoreSession, commandOwner, recoveryLoop])
  const resumeStream = useCallback((sessionId: string): Promise<boolean> => {
    if (!sessionId || !isEngineReady() || renderSource !== getEngineSource()) return Promise.resolve(false)
    selectView(sessionId)
    if (activeStreamRef.current) return Promise.resolve(true)
    // A caller retry after authentication/session repair is an explicit new
    // attempt; the blocked generation never spins by itself.
    if (recoveryLoop.state().phase === 'blocked') recoveryLoop.cancel()
    return recoveryLoop.resume(recoveryScope(sessionId))
  }, [selectView, recoveryLoop, recoveryScope, renderSource])
  useEffect(() => { recoveryAttemptRef.current = attemptRecovery; recoverRef.current = resumeStream }, [attemptRecovery, resumeStream])

  const loadHistory = useCallback(async (sessionId: string): Promise<void> => {
    await resumeStream(sessionId)
  }, [resumeStream])

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
      const source = getEngineSource()
      assertEngineSource(renderSource)
      // A security-mode request may finish after its card was unmounted. Old
      // callbacks must never retarget the hook to the session they captured.
      if (viewSessionRef.current !== options.sessionId) return
      if (activeStreamRef.current || approvalRefreshRef.current || answeringRef.current.has(requestId)) return
      const target = messages.find(message => message.interactions?.some(item => item.requestId === requestId && item.status === 'pending'))
      const pending = target?.interactions?.find(item => item.requestId === requestId && item.status === 'pending')
      const currentRun = pending?.runId ? rootRunsRef.current.get(pending.runId) : undefined
      const currentPending = currentRun?.pending.find(item => item.requestId === requestId)
      if (!target?.run || !pending?.runId || target.run.status !== 'waiting' ||
        target.run.sessionId !== options.sessionId || pending.runId !== target.run.runId || target.runId !== pending.runId ||
        currentRun?.sessionId !== options.sessionId || currentRun.status !== 'waiting' || currentPending?.status !== 'pending' ||
        currentPending.toolCallId !== pending.toolCallId || currentPending.toolName !== pending.toolName || currentPending.kind !== pending.kind) {
        throw new Error('待应答请求已变化，请重新加载会话')
      }
      answeringRef.current.add(requestId)
      activeRunIdRef.current = target.runId ?? null
      optimisticIdsRef.current = { assistantId: target.id }
      setStreaming(true)
      let responseStreamId: string | null = null
      let responseScope: RecoveryScope | null = null
      try {
        // The engine restores the original model/workspace and acknowledges the request before UI marks it answered.
        const response = runStream({ sessionId: options.sessionId, runId: target.runId, toolResponse: buildToolResponse(pending, values) })
        responseStreamId = activeStreamRef.current
        responseScope = recoveryScope(options.sessionId)
        await response
      } catch (error) {
        if (source !== getEngineSource() || (responseScope && !scopeIsCurrent(responseScope)) || viewSessionRef.current !== options.sessionId ||
          (activeStreamRef.current !== null && activeStreamRef.current !== responseStreamId)) return
        answeringRef.current.delete(requestId)
        // IPC failures can reject before emitting a stream event. Release only
        // this submission so the unchanged durable request can be retried.
        if (activeStreamRef.current === responseStreamId) activeStreamRef.current = null
        setStreaming(false)
        throw error
      }
    }, [messages, runStream, renderSource, recoveryScope, scopeIsCurrent]
  )

  const abort = useCallback(async (): Promise<void> => {
    const source = getEngineSource()
    assertEngineSource(renderSource)
    const streamId = activeStreamRef.current
    const sessionId = viewSessionRef.current ?? activeSessionRef.current
    if (!sessionId || stoppingRef.current) return
    const knownRun = activeRunIdRef.current ? rootRunsRef.current.get(activeRunIdRef.current) : undefined
    if (!streamId && !durableCancelBody(sessionId, knownRun) && !hasSessionWork(sessionId)) return
    flushStreamPatches()
    invalidateRecovery()
    const scope = recoveryScope(sessionId)
    stoppingRef.current = scope
    activeStreamRef.current = null
    syncQueue([])
    try {
      let body = durableCancelBody(sessionId, knownRun)
      if (!body) {
        // Admission may have succeeded before the first run frame reached this
        // client. Read the durable identity rather than cancelling a later run.
        const restored = await restoreSession(sessionId)
        if (!scopeIsCurrent(scope)) return
        if (restored.kind !== 'restored') throw new Error('未能确认要停止的运行，正在恢复连接，请稍后重试')
        body = durableCancelBody(sessionId, restored.snapshot.executionRun ?? restored.snapshot.run)
      }
      if (body) await engine.requestOrThrow({ method: 'POST', path: '/chat/cancel', body })
      if (!scopeIsCurrent(scope)) return
      stoppingRef.current = null
      if (streamId) void engine.abortStream(streamId).catch(() => {})
      // Only the next authoritative snapshot can mark the run cancelled.
      await loadHistory(sessionId)
    } catch (error) {
      if (source === getEngineSource() && scopeIsCurrent(scope)) {
        stoppingRef.current = null
        setHistoryError(error instanceof Error ? error.message : String(error))
        recoveryLoop.retry(scope)
        void resumeStream(sessionId)
      }
    } finally {
      if (stoppingRef.current === scope) stoppingRef.current = null
      if (streamId) void engine.abortStream(streamId).catch(() => {})
    }
  }, [syncQueue, flushStreamPatches, loadHistory, renderSource, hasSessionWork, invalidateRecovery, recoveryScope, scopeIsCurrent, restoreSession, recoveryLoop, resumeStream])

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
      const source = getEngineSource()
      assertEngineSource(renderSource)
      if (hasSessionWork(sessionId)) return
      invalidateRecovery()
      const scope = recoveryScope(viewSessionRef.current ?? '')
      const mutation = historyMutationGuard.begin(scope)
      try {
        if (sessionId) {
          const result = await engine.request({
            method: 'DELETE',
            path: '/conversation/history',
            query: { sessionId }
          })
          assertEngineSource(source)
          if (!result.ok) throw new Error(result.message || '引擎侧历史删除失败')
          forgetSubagentSession(sessionId)
          forgetCommandSession(sessionId)
        }
        if (!scopeIsCurrent(scope)) return
        rootRunsRef.current.clear()
        activeRunIdRef.current = null
        activeSessionRef.current = null
        consumedEventIdRef.current = null
        pendingPatchesRef.current = []
        if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
        throttleTimerRef.current = null
        setStreaming(false)
        setHistoryError(null)
        setMessages([])
        commitUsageAnchor(null)
        setCommandJobs([])
        setTodos([])
      } finally {
        historyMutationGuard.release(mutation)
      }
    },
    [renderSource, hasSessionWork, invalidateRecovery, recoveryScope, scopeIsCurrent, historyMutationGuard, commitUsageAnchor]
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
      const source = getEngineSource()
      assertEngineSource(renderSource)
      if (hasSessionWork(sessionId)) return
      if (viewSessionRef.current !== sessionId) return
      invalidateRecovery()
      const scope = recoveryScope(sessionId)
      const mutation = historyMutationGuard.begin(scope)
      try {
        const row = await resolveEngineRow(sessionId, message)
        assertEngineSource(source)
        if (!scopeIsCurrent(scope)) return
        const turnId = message.conversationId ?? row?.conversationId
        if (!row || !turnId) throw new Error('未能定位该轮对话的引擎记录，请重新加载会话')
        const result = await engine.request({
          method: 'DELETE',
          path: `/conversation/turns/${encodeURIComponent(turnId)}`,
          query: { sessionId }
        })
        assertEngineSource(source)
        if (!result.ok) throw new Error(result.message || '引擎侧删除失败')
        if (!scopeIsCurrent(scope)) return
        const refreshed = await restoreSession(sessionId)
        if (!scopeIsCurrent(scope)) return
        if (refreshed.kind !== 'restored') throw new Error('本轮已删除，但未能重新加载会话，请刷新后查看')
      } finally {
        historyMutationGuard.release(mutation)
      }
    },
    [restoreSession, resolveEngineRow, renderSource, hasSessionWork, invalidateRecovery, recoveryScope, scopeIsCurrent, historyMutationGuard]
  )

  /**
   * 从某条用户消息处重试：删除该消息及其后的所有历史（引擎侧 + 界面），
   * 再以原内容重新发送。重新发送（用户消息）与重新生成（取其前一条
   * 用户消息）都走这里。
   */
  const retryFrom = useCallback(
    async (userMessage: ChatMessage, options: SendOptions): Promise<void> => {
      const source = getEngineSource()
      assertEngineSource(renderSource)
      if (hasSessionWork(options.sessionId)) return
      if (viewSessionRef.current !== options.sessionId) return
      invalidateRecovery()
      const scope = recoveryScope(options.sessionId)
      const mutation = historyMutationGuard.begin(scope)
      try {
        const row = await resolveEngineRow(options.sessionId, userMessage)
        assertEngineSource(source)
        if (!scopeIsCurrent(scope)) return
        if (!row?.id) throw new Error('未能定位该消息的稳定记录，请重新加载会话')
        if (row.id) {
          const result = await engine.request({
            method: 'POST',
            path: '/conversation/truncate',
            body: { sessionId: options.sessionId, messageId: row.id }
          })
          assertEngineSource(source)
          if (!result.ok) throw new Error(result.message || '引擎侧截断失败')
        }
        if (!scopeIsCurrent(scope)) return
        // Truncation changes authoritative lifetime billing. Re-anchor before the
        // retry stream instead of subtracting only the visible portion locally.
        const refreshed = await restoreSession(options.sessionId)
        if (!scopeIsCurrent(scope)) return
        if (refreshed.kind !== 'restored') throw new Error('历史已截断，但未能重新加载会话，请刷新后重试')
        await send(userMessage.content, {
          ...options,
          attachments: userMessage.attachments
        })
      } finally {
        historyMutationGuard.release(mutation)
      }
    },
    [resolveEngineRow, restoreSession, send, renderSource, hasSessionWork, invalidateRecovery, recoveryScope, scopeIsCurrent, historyMutationGuard]
  )

  /**
   * 消息级回退（对齐 wuzu-client 的 revert-files 语义）：
   * 把该用户消息起之后所有轮次产生的文件改动按快照恢复（含已保留的），
   * 再截断该消息及之后的对话历史。不自动重发，由调用方决定回填输入框。
   */
  const revertFrom = useCallback(
    async (sessionId: string, userMessage: ChatMessage): Promise<void> => {
      const source = getEngineSource()
      assertEngineSource(renderSource)
      if (hasSessionWork(sessionId)) throw new Error('会话运行中，请先停止再回退')
      if (viewSessionRef.current !== sessionId) return
      invalidateRecovery()
      const scope = recoveryScope(sessionId)
      const mutation = historyMutationGuard.begin(scope)
      try {
        await revertConversationFrom(async <T,>(input: Parameters<typeof engine.requestOrThrow>[0]) => {
          assertEngineSource(source)
          const result = await engine.requestOrThrow<T>(input)
          assertEngineSource(source)
          return result
        }, sessionId, userMessage)
        assertEngineSource(source)
        // A slow rollback may finish after navigation. Do not remove another session's messages.
        if (!scopeIsCurrent(scope)) return
        const refreshed = await restoreSession(sessionId)
        if (!scopeIsCurrent(scope)) return
        if (refreshed.kind !== 'restored') throw new Error('回退已完成，但未能重新加载会话，请刷新后查看')
      } finally {
        historyMutationGuard.release(mutation)
      }
    },
    [restoreSession, renderSource, hasSessionWork, invalidateRecovery, recoveryScope, scopeIsCurrent, historyMutationGuard]
  )

  return {
    messages,
    sessionUsage,
    usageSyncNotice,
    publishedRecovery,
    publishedFixedChildren: Boolean(sessionUsageAnchor?.publishedChildren),
    cancelPublishedRecovery,
    loadPublishedBody,
    retryPublishedRecovery,
    commandJobs,
    sessionModel,
    streaming,
    hasSessionWork,
    connection,
    historyError,
    isHistoryReady,
    historyCompacted: historyCompacted && (!archiveExpanded || (archiveRemaining ?? 0) > 0),
    archiveRemaining,
    archiveLoading,
    archiveError,
    loadArchive,
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
