import { CommandJobCard } from './CommandJobCard'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { PublishedRecoveryNotice } from './PublishedRecoveryNotice'
import { SessionConnectionNotice } from './SessionConnectionNotice'
import { publishedVisibleWindow } from '@renderer/core/engine/published-card-memory'
import { visibleChildCommandJobs } from '@renderer/core/engine/command-job-state'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { horizontalWheelTarget } from '@renderer/core/platform/horizontal-scroll'
import { codeWorkbenchAdapter, useWorkbenchClient } from '@renderer/core/workbench/client'
import { useChat, type ChatMessage, type ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { engineConnectionKey, engineStorageKey, getEngineSource } from '@renderer/core/engine/source'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { rootStatusLabel } from '@renderer/core/engine/root-run-state'
import { SessionTray } from './SessionTray'
import { queuedDraft } from '../work/work-next-turn-queue'
import { FileChangeCard } from './FileChangeCard'
import { SubagentCard } from './SubagentCard'
import { SubagentControllerContext } from './SubagentFollowup'
import { subagentControllerScope } from './subagent-controller-scope'
import { Markdown } from './Markdown'
import { UserMessageContent } from './UserMessageContent'
import { getSessionMeta, subscribeSessionMeta } from '../history/session-meta'
import type { ChatFileContext } from './chat-link'
import { toolDisplayName } from './tool-names'
import { CompactToolRow } from './CompactToolRow'
import { toolPresentation } from './tool-presentation'
import { useCollapseMemory } from './useCollapseMemory'
import { ThinkingRow } from './ThinkingRow'
import { registerPendingSession, requestSessionListRefresh, touchPendingSession } from '../history/pending-sessions'
import { useModels } from '@renderer/core/engine/model-store'
import { DEFAULT_CONTEXT_WINDOW_BUDGET } from '@renderer/core/engine/models'
import { contextPresentation, contextPresentationLimit } from './context-presentation'
import { changeSecurityMode } from '@renderer/core/engine/security-store'
import { utilityChat } from '@renderer/core/engine/utility-chat'
import { useCodegraphIndex } from '@renderer/core/engine/useCodegraphIndex'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { refreshGit } from '@renderer/core/git/git-store'
import { currentWorkspacePaths, useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence, useMotionPresence } from '@renderer/workbench/MotionPresence'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { CompletionPopover } from '@renderer/workbench/CompletionPopover'
import { ContextMenu } from '@renderer/workbench/ContextMenu'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { ModelPicker } from '../models/ModelPicker'
import { ComposerOptions } from './ComposerOptions'
import { loadSessionModelSelection, resolveSessionComposerModel, saveSessionModelSelection, type SessionModelSelection } from './session-model-store'
import { loadSessionThinkingMode, saveSessionThinkingMode, type SessionThinkingMode } from './session-thinking-store'
import { composerThinkingMode, requestedThinkingMode, resolveSessionRequestConfig, loadSessionRequestSelection, saveSessionRequestSelection, type SessionRequestSelection } from './session-request-config'
import { normalizeRootRunRequestConfig, type RootRunRequestConfig } from '@shared/root-run'
import { MessageNavRail, type NavTurn } from './MessageNavRail'
import { groupIntoTurns } from './usage'
import { TurnUsage, UsageMeter, type TurnUsageInfo } from './ConversationUsage'
import { useAttachments, shouldAttachPastedText, createPastedTextFile } from './useAttachments'
import { ImageConversationProvider } from './image-conversation'
import { ToolImageGalleryProvider } from './ToolImageGalleryProvider'
import { replaceImageAttachmentReferences } from './image-attachment-reference'
import { AttachmentStrip } from './AttachmentStrip'
import { attachmentIdentity, attachmentReferences, freezeAttachmentReferences } from './attachment-references'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { knowledgeBindingKey, saveKnowledgeBinding } from '@renderer/core/engine/knowledge'
import { ResourcePicker, type ResourceItem } from './ResourcePicker'
import './apple-chat-panels.css'
import { RootFollowupDelivery, RootFollowupFeedback, useRootFollowup } from './RootFollowup'
import { rootFollowupCanSubmit, rootFollowupLimitation, rootFollowupMessage, rootFollowupRun } from './root-followup'

/** Older engines/models can omit the window; use the model initialization default. */
const CONTEXT_WINDOW_FALLBACK = DEFAULT_CONTEXT_WINDOW_BUDGET

/** 消息窗口分页：只渲染尾部约 300 条消息（按轮次对齐切割），滚顶自动加载更早的 */
const MESSAGE_PAGE_SIZE = 300
/** 距顶多少 px 内触发加载更早消息 */
const LOAD_EARLIER_PX = 120

/** 消息操作不随流式帧换引用，但点击时必须使用最新已提交的会话与权限。 */
function useCommittedCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const committed = useRef(callback)
  useLayoutEffect(() => { committed.current = callback }, [callback])
  return useCallback((...args: Args) => committed.current(...args), [])
}

function sameTurnUsage(previous: TurnUsageInfo | undefined, next: TurnUsageInfo): previous is TurnUsageInfo {
  return Boolean(previous && previous.tokens === next.tokens && previous.askedAt === next.askedAt &&
    previous.startedAt === next.startedAt && previous.endedAt === next.endedAt &&
    previous.model === next.model && previous.streaming === next.streaming &&
    previous.summary.length === next.summary.length && previous.summary.every((row, index) => {
      const other = next.summary[index]
      return row.label === other.label && row.group === other.group && row.tokens === other.tokens &&
        row.child === other.child && row.unknown === other.unknown && row.title === other.title && row.subtotal === other.subtotal &&
        (row.shareOf === other.shareOf || row.shareOf != null && other.shareOf != null &&
          row.shareOf.tokens === other.shareOf.tokens && row.shareOf.label === other.shareOf.label)
    }))
}

type ComposerResources = { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
type RejectedDraft = { text: string; mentions: Mention[]; attachments: ChatAttachment[]; root: string | null }
function loadLegacyComposerResources(sessionId: string, source: string): RootRunRequestConfig {
  try {
    const raw = localStorage.getItem(`aether:composer-resources:${source || 'embedded'}:${sessionId}`)
    const stored = raw ? normalizeRootRunRequestConfig(JSON.parse(raw)) ?? {} : {}
    const knowledge = localStorage.getItem(knowledgeBindingKey(sessionId, source))
    return knowledge === null ? stored : { ...stored, ...normalizeRootRunRequestConfig({ knowledgeBases: JSON.parse(knowledge) }) }
  } catch { return {} }
}

/** 按工作区相对路径读 base64 data URL（图片缩略图 / 放大查看共用） */
import {
  AttachmentChip,
  AttachmentPreviewDialog,
  type AttachmentPreview
} from './AttachmentChip'
import { type Mention, type MentionInputHandle } from './MentionInput'
import { InputComposer, ComposerInput, ComposerPolish, ComposerToolbar, ComposerSend, ComposerStop } from './InputComposer'
import { loadChatDraftState, saveChatDraft, saveChatDraftForSubmission, nextChatDraftRevision } from './draft-store'
import {
  preserveMentions,
  userMessageDraft,
  userMessageText
} from './mention-context'
import { MentionRefPicker } from './MentionRefPicker'
import { buildAgentMentionMessage } from './agent-references'
import { consumePendingMentions, subscribePendingMentions } from './pending-mentions'
import { serializeMessages } from './message-export'
import { appendMessageDraft, restoreMessageDraft } from './message-draft-merge'

function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`
}

/** 字节数 → 人类可读（附件条上展示大小） */
/**
 * 对话视图（P0 核心）
 *
 * 只依赖 useChat 暴露的抽象，不直接接触 IPC / SSE —— 因此后续换成
 * 多会话、多 Agent、附件等能力时，改动集中在 hook 层。
 */
export function ChatView(): JSX.Element {
  const { engine, ready, settings, updateSettings, settingsLoaded } = useApp()
  const appMode = useAppMode()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const connectionKey = engineConnectionKey(engine.snapshot)
  const storageSource = engineStorageKey(engine.snapshot)
  const sourceEpoch = getEngineSource()
  const { messages, sessionUsage, usageSyncNotice, publishedRecovery, cancelPublishedRecovery, loadPublishedBody, retryPublishedRecovery, commandJobs, sessionModel, streaming, stopping, stopError, dismissStopError, hasSessionWork, connection, historyError, recoveryNotice, dismissRecoveryNotice, historyCompacted, archiveRemaining, archivePage, archiveLoading, archiveError, loadArchive, todos, send, respond, abort, resumeStream, deleteTurn, retryFrom, truncateFrom, revertFrom, queue, queueState, removeQueued, clearQueue, flushQueue, updateQueued, moveQueued, mergeQueued, pauseQueue, reconcileQueue, retargetQueuedModel } = useChat()
  const { models, loaded: modelsLoaded } = useModels()
  const workspace = useWorkspace()
  // AppProvider 按引擎来源统一恢复或创建会话。这里提前创建会与远端选择
  // 竞争：本地设置为空的首帧会覆盖刚恢复的远端会话，使历史响应失效。
  const sessionId = settingsLoaded ? settings.lastSessionId : ''
  useWorkbenchClient(sessionId, ready, 'code', codeWorkbenchAdapter(sessionId))
  const codegraphRoot = remoteReadOnly ? settings.remoteWorkspaceRoot.trim() || undefined : workspace.root || undefined
  const [input, setInput] = useState('')
  const [rejectedDrafts, setRejectedDrafts] = useState<Record<string, RejectedDraft>>({})
  /** 同步记录编辑器的最新文本，避免润色请求返回时覆盖用户刚刚的修改。 */
  const inputValueRef = useRef('')
  const draftEditRevision = useRef(nextChatDraftRevision())
  const submissionFlight = useRef<object | null>(null)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    inputValueRef.current = input
  }, [input])
  /** AI 润色进行中（禁用润色按钮，防止重复点击） */
  const [polishing, setPolishing] = useState(false)
  /** 输入框里的引用 chip（文件/目录/源码/终端），由 MentionInput 序列化时同步 */
  const mentionsRef = useRef<Mention[]>([])
  const [, refreshMentionLabels] = useState(0)
  /** 多选模式：按消息粒度勾选，复制或导出为 Markdown */
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  /** 轻提示（复制 / 导出等即时反馈），短暂展示后自动消失 */
  const [toast, setToast] = useState<string | null>(null)
  /** 用户手动选择的模型；null 表示未选择，跟随设置（设置异步加载后自动生效） */
  const [selectedModel, setSelectedModel] = useState<{ source: string; sessionId: string; selection: SessionModelSelection } | null>(null)
  const storedModelSelection = useMemo(() => loadSessionModelSelection(sessionId, storageSource), [sessionId, storageSource])
  const modelSelection = selectedModel?.source === storageSource && selectedModel.sessionId === sessionId ? selectedModel.selection : storedModelSelection
  const sessionModelReady = sessionModel?.source === sourceEpoch && sessionModel.sessionId === sessionId
  const modelId = resolveSessionComposerModel({
    configuredModelId: sessionModelReady ? sessionModel.modelId : undefined,
    runId: sessionModelReady ? sessionModel.runId : undefined,
    selection: modelSelection,
    defaultModelId: settings.lastModelId
  })
  const canExecute = ready && sessionModelReady
  const taskActive = streaming || stopping || hasSessionWork(sessionId)
  const followupRun = useMemo(() => rootFollowupRun(messages, sessionId, sessionModelReady ? sessionModel.runId : undefined), [messages, sessionId, sessionModelReady, sessionModel])
  const rootWaiting = followupRun?.status === 'waiting'
  const rootAccepting = taskActive && !stopping && !rootWaiting && followupRun?.status === 'running'
  const rootFollowup = useRootFollowup({ sessionId, rootRunId: followupRun?.runId, source: sourceEpoch,
    active: rootAccepting, ready: canExecute && appMode === 'code', toolProfile: 'code' })
  const immediateIntent = taskActive && rootFollowup.delivery === 'current'
  const storedThinkingMode = useMemo(() => loadSessionThinkingMode(sessionId, storageSource), [sessionId, storageSource])
  const storedRequestSelection = useMemo(() => loadSessionRequestSelection(sessionId, storageSource), [sessionId, storageSource])
  const legacyResources = useMemo(() => loadLegacyComposerResources(sessionId, storageSource), [sessionId, storageSource])
  const [selectedRequest, setSelectedRequest] = useState<{ source: string; sessionId: string; selection: SessionRequestSelection } | null>(null)
  const requestSelection = selectedRequest?.source === storageSource && selectedRequest.sessionId === sessionId ? selectedRequest.selection : storedRequestSelection
  /**
   * Resource picking is available while a newly opened session is still
   * hydrating its first model run. Keep an explicit selection made in that
   * window instead of dropping it behind the sessionModelReady guard; the
   * pending patch is anchored as soon as the run arrives.
   */
  const [pendingRequestPatch, setPendingRequestPatch] = useState<{
    source: string
    epoch: number
    sessionId: string
    patch: RootRunRequestConfig
  } | null>(null)
  const composerRequest = { ...resolveSessionRequestConfig({
    serverConfig: sessionModelReady ? sessionModel.requestConfig : undefined,
    runId: sessionModelReady ? sessionModel.runId : undefined,
    selection: requestSelection,
    fallbackConfig: { ...legacyResources, agentId: settings.lastAgentId || undefined,
      subagentModel: settings.subagentModelId || undefined, utilityModel: settings.utilityModelId || undefined,
      thinkingMode: requestedThinkingMode(storedThinkingMode ?? settings.thinkingMode) }
  }), ...(pendingRequestPatch?.source === storageSource && pendingRequestPatch.epoch === sourceEpoch && pendingRequestPatch.sessionId === sessionId ? pendingRequestPatch.patch : {}) }
  const composerResources: ComposerResources = { skills: composerRequest.skills ?? [], mcpServers: composerRequest.mcpServers ?? [], knowledgeBases: composerRequest.knowledgeBases ?? [] }
  const thinkingMode = composerThinkingMode(composerRequest.thinkingMode)
  const updateComposerRequest = useCallback((patch: RootRunRequestConfig): void => {
    if (!sessionId || sourceEpoch !== getEngineSource()) return
    if (!sessionModelReady) {
      setPendingRequestPatch(previous => previous?.source === storageSource && previous.epoch === sourceEpoch && previous.sessionId === sessionId
        ? { ...previous, patch: { ...previous.patch, ...patch } }
        : { source: storageSource, epoch: sourceEpoch, sessionId, patch })
      return
    }
    const selection: SessionRequestSelection = { anchorRunId: sessionModel.runId,
      config: { ...(requestSelection?.anchorRunId === sessionModel.runId ? requestSelection?.config : {}), ...patch },
      omitThinkingMode: Object.hasOwn(patch, 'thinkingMode') ? patch.thinkingMode === undefined :
        requestSelection?.anchorRunId === sessionModel.runId && requestSelection?.omitThinkingMode }
    setSelectedRequest({ source: storageSource, sessionId, selection })
    saveSessionRequestSelection(sessionId, storageSource, selection)
  }, [sessionId, sessionModelReady, sourceEpoch, sessionModel, requestSelection, storageSource])
  useEffect(() => {
    if (!sessionModelReady || !sessionId || pendingRequestPatch?.source !== storageSource || pendingRequestPatch.epoch !== sourceEpoch || pendingRequestPatch.sessionId !== sessionId) return
    const patch = pendingRequestPatch.patch
    setPendingRequestPatch(null)
    updateComposerRequest(patch)
  }, [sessionModelReady, sessionId, pendingRequestPatch, storageSource, sourceEpoch, updateComposerRequest])
  const selectThinkingMode = useCallback((mode: SessionThinkingMode): void => {
    updateComposerRequest({ thinkingMode: requestedThinkingMode(mode) })
    saveSessionThinkingMode(sessionId, mode, storageSource)
  }, [updateComposerRequest, sessionId, storageSource])
  const assignedModelBaselineRef = useRef<{ source: string; epoch: number; sessionId: string; subagentModel: string; utilityModel: string } | null>(null)
  useEffect(() => {
    if (!sessionModelReady) { assignedModelBaselineRef.current = null; return }
    const next = { source: storageSource, epoch: sourceEpoch, sessionId,
      subagentModel: settings.subagentModelId, utilityModel: settings.utilityModelId }
    const previous = assignedModelBaselineRef.current
    assignedModelBaselineRef.current = next
    // Initial global defaults and navigation never rewrite a restored run. A later
    // explicit settings edit applies only to this source/session's next request.
    if (!previous || previous.source !== next.source || previous.epoch !== next.epoch || previous.sessionId !== next.sessionId) return
    const patch: RootRunRequestConfig = {}
    if (previous.subagentModel !== next.subagentModel) patch.subagentModel = next.subagentModel
    if (previous.utilityModel !== next.utilityModel) patch.utilityModel = next.utilityModel
    if (Object.keys(patch).length) updateComposerRequest(patch)
  }, [sessionModelReady, storageSource, sourceEpoch, sessionId, settings.subagentModelId, settings.utilityModelId, updateComposerRequest])
  const activeSessionIdRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<MentionInputHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  /** @ 触发的内联补全关键词；null 表示未触发（光标不在 @ 段内） */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  /** / 资源菜单触发的关键词；选择后绑定到本轮会话并显示为资源 chip。 */
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  /** Last input snapshot used to detect a user deleting a /resource token manually. */
  const resourceTextRef = useRef('')
  /** Clearing the editor after send must not clear the session's resource bindings. */
  const suppressResourceReconcileRef = useRef(false)
  /** 「+」菜单里手动打开的工作空间选择面板（与 @ 补全共用 FileRefPalette） */
  const [manualPalette, setManualPalette] = useState(false)
  useEffect(() => {
    // Keep-alive composers must release completion keys when their scope changes.
    setMentionQuery(null)
    setResourceQuery(null)
    setManualPalette(false)
  }, [appMode, sessionId, storageSource])
  /** 「+」按钮弹出的附件/引用菜单（视口坐标） */
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null)
  // 附件：落盘到当前工作区，发送时把相对路径交给引擎（图片→视觉/OCR，文本→smart_read）
  const replaceImageDraftRef = useRef<(previous: ChatAttachment, next: ChatAttachment) => void>(() => {})
  const attachmentChangeRef = useRef<(files: readonly ChatAttachment[]) => void>(() => {})
  const attach = useAttachments(remoteReadOnly ? null : workspace.root, sessionId, { active: appMode === 'code',
    onReplace: (previous, next) => replaceImageDraftRef.current(previous, next),
    loadDraft: () => {
      const saved = loadChatDraftState(sessionId, storageSource)
      return (saved.attachmentRoot ?? null) === (remoteReadOnly ? null : workspace.root) ? saved.attachments ?? [] : []
    },
    onChange: files => attachmentChangeRef.current(files) })
  const currentAttachmentReferences = useMemo(() => attachmentReferences(attach.attachments), [attach.attachments])
  const attachmentStateRef = useRef(attach.attachments)
  attachmentStateRef.current = attach.attachments
  const imageConversationScope = JSON.stringify([sourceEpoch, sessionId, workspace.root])
  /** 附件点击预览（图片放大 / 文本查看，统一 AttachmentPreviewDialog） */
  const [previewImage, setPreviewImage] = useState<(AttachmentPreview & { scope: string; draft: boolean }) | null>(null)
  /** 预览来源的同组图片（查看器内左右翻页） */
  const [previewGroup, setPreviewGroup] = useState<ChatAttachment[]>([])
  const previewAttachment = useCallback((file: ChatAttachment, src: string | null, group?: ChatAttachment[], draft = false) => {
    setPreviewImage({ file, src, scope: imageConversationScope, draft })
    setPreviewGroup(group ?? (file.type.startsWith('image/') ? [file] : []))
  }, [imageConversationScope])
  useEffect(() => { setPreviewImage(null); setPreviewGroup([]) }, [imageConversationScope])

  /** AI 润色输入框内容：用轻任务模型改写得更清晰；chip 引用会随文本一起被序列化给模型 */
  const handlePolish = async (): Promise<void> => {
    const text = input.trim()
    if (!canExecute || polishing || !text) return
    const requestSessionId = sessionId
    activeSessionIdRef.current = requestSessionId
    setPolishing(true)
    try {
      const res = await utilityChat({
        // 轻任务模型为空时跟随当前主对话模型。
        model: composerRequest.utilityModel || modelId || undefined,
        systemPrompt:
          '你是「发给 AI 编程助手的指令」的润色器。把用户的草稿改写得更清晰、具体、可执行：' +
          '补全主语和对象、拆开含糊的复合要求、修正错别字；保留原文中的 @路径 引用 token 原样不动；' +
          '保持用户原语言；不要添加用户没说的需求；只输出润色后的文本本身，不要解释、不要引号。',
        userPrompt: text,
        temperature: 0.3,
        maxTokens: 1500
      })
      // Utility calls are independent, one-shot requests. A background engine
      // reconnect may advance its generation while the request is in flight;
      // do not discard a valid result when the user is still in this session.
      if (activeSessionIdRef.current !== requestSessionId) return
      // 请求期间用户可能已经继续编辑；此时丢弃旧结果，绝不能覆盖新草稿。
      if (inputValueRef.current.trim() !== text) return
      const polished = res.text.trim()
      if (polished && polished !== text) {
        const draft = preserveMentions(polished, mentionsRef.current)
        mentionsRef.current = draft.mentions
        resourceTextRef.current = draft.text
        inputValueRef.current = draft.text
        inputRef.current?.setDraft(draft.text, draft.mentions)
        setInput(draft.text)
        scheduleDraftSave(draft.text)
        inputRef.current?.focus()
      } else {
        setToast('润色结果与原文一致')
      }
    } catch (err) {
      if (activeSessionIdRef.current !== requestSessionId) return
      setToast(err instanceof Error ? `润色失败：${err.message}` : '润色失败，请稍后重试')
    } finally {
      if (activeSessionIdRef.current === requestSessionId) setPolishing(false)
    }
  }

  const setAttachmentDragging = attach.setDragging
  useEffect(() => {
    setAttachmentDragging(false)
    mentionsRef.current = []
    setMentionQuery(null)
    setResourceQuery(null)
    resourceTextRef.current = ''
    setManualPalette(false)
    setAttachMenu(null)
    setPreviewImage(null)
    setPolishing(false)
  }, [connectionKey, sourceEpoch, setAttachmentDragging])

  // Lifetime billing is anchored to the authoritative server snapshot. Loading
  // archived transcript pages must not make previously billed tokens new spend.
  const usageTotal = sessionUsage
  // Input occupancy is an invocation snapshot; request billing stays cumulative
  // in usageTotal. A later invocation may legitimately use less context.
  const contextDisplay = useMemo(() => contextPresentation(messages), [messages])
  const contextUsage = contextDisplay.primary
  const contextUsed = contextUsage?.used ?? 0
  const contextCompaction = sessionModelReady ? sessionModel.compaction : undefined
  // Pair the input with its own model/window. A pending model-only frame or a
  // composer selection must not redivide old input by another model's window.
  const contextLimit = contextPresentationLimit(contextUsage, models, modelId, CONTEXT_WINDOW_FALLBACK)
  // 按用户提问切分轮次：每轮末尾展示「一问一答」的累计 token
  const turns = useMemo(() => groupIntoTurns(messages), [messages])
  const committedTurnUsage = useRef<ReadonlyMap<string, TurnUsageInfo>>(new Map())
  const usageByMessage = useMemo(() => {
    const next = new Map<string, TurnUsageInfo>()
    for (const turn of turns) {
      if (turn.tokens <= 0) continue
      let lastAssistant: ChatMessage | undefined
      for (let index = turn.messages.length - 1; index >= 0; index--) {
        if (turn.messages[index].role === 'assistant') { lastAssistant = turn.messages[index]; break }
      }
      if (!lastAssistant) continue
      const usage: TurnUsageInfo = {
        tokens: turn.tokens, summary: turn.summary, askedAt: turn.askedAt,
        startedAt: turn.startedAt, endedAt: turn.endedAt, model: turn.modelId ?? modelId,
        streaming: turn.messages.some(message => message.status === 'streaming')
      }
      const previous = committedTurnUsage.current.get(lastAssistant.id)
      next.set(lastAssistant.id, sameTurnUsage(previous, usage) ? previous : usage)
    }
    return next
  }, [turns, modelId])
  // groupIntoTurns 重算历史明细时也保留相同用量的引用，避免历史消息全部穿透 memo。
  useLayoutEffect(() => { committedTurnUsage.current = usageByMessage }, [usageByMessage])

  // ── 消息窗口分页 ────────────────────────────────────────────────────────────
  // 长会话（几百上千条消息）一次全量渲染会让 DOM 规模爆炸、切换会话卡顿。
  // 只渲染尾部约 MESSAGE_PAGE_SIZE 条消息（按轮次边界切，不切断一问一答），
  // 滚到顶部附近时自动向前加载一页。窗口在会话内只增不减（流式追加不收缩，
  // 避免阅读中途内容被挤走）；切换会话时重置。
  const sourceSessionKey = JSON.stringify([connectionKey, sourceEpoch, sessionId])
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const [navigationStart, setNavigationStart] = useState<{ key: string; turnId: string } | null>(null)
  const { visibleTurns, hiddenTurnCount } = useMemo(() => {
    if (turns.length === 0) return { visibleTurns: turns, hiddenTurnCount: 0 }
    let count = 0
    let start = turns.length
    while (start > 0 && count < visibleCount) {
      start -= 1
      count += turns[start].messages.length
    }
    // Explicitly opened history remains mounted as the live tail grows, even
    // after returning to follow mode. Only a session switch resets that window.
    const pinned = navigationStart?.key === sourceSessionKey ? turns.findIndex(turn => turn.id === navigationStart.turnId) : -1
    if (pinned >= 0) start = Math.min(start, pinned)
    return { visibleTurns: turns.slice(start), hiddenTurnCount: start }
  }, [turns, visibleCount, navigationStart, sourceSessionKey])
  useLayoutEffect(() => {
    const first = visibleTurns[0]
    if (navigationStart?.key === sourceSessionKey && first && navigationStart.turnId !== first.id)
      setNavigationStart({ key: sourceSessionKey, turnId: first.id })
  }, [visibleTurns, navigationStart, sourceSessionKey])
  /** 向前加载一页前的滚动快照：加载后用来补偿 scrollTop，防止视口跳动 */
  const prependSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const pendingMessageNavigation = useRef<{ key: string; turnId: string; top: boolean } | null>(null)
  const navigationScrollTop = useRef<number | null>(null)
  const hiddenTurnCountRef = useRef(hiddenTurnCount)
  hiddenTurnCountRef.current = hiddenTurnCount
  const mountedMessageCount = useRef(0)
  mountedMessageCount.current = visibleTurns.reduce((total, turn) => total + turn.messages.length, 0)
  const loadEarlier = useCallback(() => {
    if (hiddenTurnCountRef.current === 0) return
    const el = scrollRef.current
    if (el) prependSnapshotRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    setVisibleCount(count => Math.max(count, mountedMessageCount.current) + MESSAGE_PAGE_SIZE)
  }, [])
  // 前插加载完成后做 scrollTop 补偿：新内容插在顶部，视口要往下推同样的高度差
  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current
    const el = scrollRef.current
    if (!snapshot || !el) return
    prependSnapshotRef.current = null
    el.scrollTop = snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight)
  }, [visibleTurns])
  // 左侧导航栏的条目：每条用户消息一个圆点（turn.id 即首条用户消息 ID）
  const navTurns = useMemo<NavTurn[]>(
    () =>
      turns
        .map((turn) => {
          const message = turn.messages.find((m) => m.role === 'user')
          if (!message) return null
          return {
            id: turn.id,
            message,
          // 预览用可读正文：协议注释里的下标会让纯文本预览出现一串花括号
          preview: userMessageText(message.content).replace(/\s+/g, ' ').slice(0, 60)
          }
        })
        .filter((item): item is NavTurn => item !== null),
    [turns]
  )

  useEffect(() => {
    activeSessionIdRef.current = sessionId
  }, [sessionId])

  const draftRecoveryKey = JSON.stringify([storageSource, sessionId])
  const rejectedDraft = rejectedDrafts[draftRecoveryKey]
  const attachmentRoot = remoteReadOnly ? null : workspace.root
  const draftScopeRef = useRef({ key: sourceSessionKey, root: attachmentRoot })
  if (draftScopeRef.current.key !== sourceSessionKey || draftScopeRef.current.root !== attachmentRoot) {
    draftScopeRef.current = { key: sourceSessionKey, root: attachmentRoot }
  }
  const displayedSessionRef = useRef(sourceSessionKey)
  useLayoutEffect(() => { displayedSessionRef.current = sourceSessionKey }, [sourceSessionKey])
  const historyEditRef = useRef<{ key: string } | null>(null)
  const [historyEdit, setHistoryEdit] = useState<{ key: string } | null>(null)
  const historyEditBusy = historyEdit?.key === sourceSessionKey

  useEffect(() => {
    if (!sessionId) return
    // The input draft is restored by the following effect. Reset this edge detector
    // here so a session/source switch cannot remove bindings from the new session.
    resourceTextRef.current = ''
  }, [sessionId, storageSource, sourceEpoch])

  const chooseComposerResource = useCallback((item: ResourceItem): void => {
    const key = item.kind === 'skill' ? 'skills' : item.kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const current = composerResources[key]
    // A binding is session-scoped. Selecting the same row again should focus the
    // existing chip instead of appending a second raw `/kind:id` token that cannot
    // be removed independently from the single binding entry.
    if (current.includes(item.id)) {
      // The binding already exists (for example, selected through the dedicated
      // KB picker), but the slash query still needs to be consumed from the draft.
      suppressResourceReconcileRef.current = true
      inputRef.current?.completeSlash(`/${item.kind}:${item.id}`)
      suppressResourceReconcileRef.current = false
      inputRef.current?.focus()
      setResourceQuery(null)
      return
    }
    const next = current.includes(item.id) ? current : [...current, item.id]
    updateComposerRequest({ [key]: next })
    if (item.kind === 'kb' && sessionId) saveKnowledgeBinding(sessionId, next, storageSource)
    suppressResourceReconcileRef.current = true
    inputRef.current?.completeSlash(`/${item.kind}:${item.id}`)
    suppressResourceReconcileRef.current = false
    setResourceQuery(null)
  }, [composerResources, sessionId, storageSource, updateComposerRequest])

  /** Remove bindings whose slash token the user deleted from the draft. */
  const reconcileComposerResources = useCallback((text: string): void => {
    const previous = resourceTextRef.current
    resourceTextRef.current = text
    if (suppressResourceReconcileRef.current || !previous || !sessionId) return
    const removed: Array<{ kind: 'skill' | 'mcp' | 'kb'; id: string }> = []
    const inspect = (kind: 'skill' | 'mcp' | 'kb', ids: readonly string[]): void => {
      for (const id of ids) {
        const token = `/${kind}:${id}`
        if (previous.includes(token) && !text.includes(token)) removed.push({ kind, id })
      }
    }
    inspect('skill', composerResources.skills)
    inspect('mcp', composerResources.mcpServers)
    inspect('kb', composerResources.knowledgeBases)
    if (!removed.length) return
    const patch: RootRunRequestConfig = {}
    for (const { kind, id } of removed) {
      const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
      const values = (patch[key] ?? composerResources[key]).filter(value => value !== id)
      patch[key] = values
      if (kind === 'kb') saveKnowledgeBinding(sessionId, values, storageSource)
    }
    updateComposerRequest(patch)
  }, [composerResources.knowledgeBases, composerResources.mcpServers, composerResources.skills, sessionId, storageSource, updateComposerRequest])

  const removeComposerResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const next = composerResources[key].filter(item => item !== id)
    updateComposerRequest({ [key]: next })
    inputRef.current?.removeTextToken(`/${kind}:${id}`)
    if (kind === 'kb') saveKnowledgeBinding(sessionId, next, storageSource)
  }, [composerResources, sessionId, storageSource, updateComposerRequest])

  // 切换会话时重置分页窗口（sessionId 声明之后，依赖其值）
  useEffect(() => {
    prependSnapshotRef.current = null
    setVisibleCount(MESSAGE_PAGE_SIZE)
    setNavigationStart(null)
  }, [sourceSessionKey])

  // 启动 / 会话切换时回放引擎侧历史：conversations 表本来是 AI 的上下文来源，
  // 把同一份数据还原到界面，解决「重启后界面空白但 AI 记得一切」的割裂感
  const historyLoadedRef = useRef('')
  useEffect(() => {
    if (!ready) { historyLoadedRef.current = ''; return }
    if (!sessionId) return
    if (historyLoadedRef.current === sourceSessionKey) return
    historyLoadedRef.current = sourceSessionKey
    // Initial history loading and transport recovery share useChat's cancellable
    // single-flight loop, including failures while /health still reports ready.
    void resumeStream(sessionId).catch(() => {})
  }, [ready, sessionId, sourceSessionKey, resumeStream])

  const archiveNavigationRef = useRef<'older' | 'newer' | 'latest' | null>(null)
  const loadArchivedPage = useCallback((action: 'older' | 'newer' | 'latest' = 'older'): void => {
    if (archiveLoading) return
    const requestedView = sourceSessionKey
    const el = scrollRef.current
    archiveNavigationRef.current = action
    if (el && !archivePage?.unversioned) prependSnapshotRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    followBottomRef.current = false
    setFollowBottom(false)
    void loadArchive(sessionId, action).then(() => {
      if (displayedSessionRef.current === requestedView) setVisibleCount(count => count + MESSAGE_PAGE_SIZE)
    })
  }, [archiveLoading, archivePage, sourceSessionKey, sessionId, loadArchive])

  // ── 每会话输入草稿（对齐 wuzu lobster-chat:draft）──
  // 切会话/重启时恢复该会话未发送的草稿；保存走防抖，不用 effect 持久化
  // （避免会话切换瞬间把旧会话文本写进新会话槽位）。
  const draftSessionRef = useRef('')
  const draftTimerRef = useRef(0)
  const pendingDraftSaveRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current?.()
    pendingDraftSaveRef.current = null
    if (!sessionId || draftSessionRef.current === sourceSessionKey) return
    draftSessionRef.current = sourceSessionKey
    const draft = loadChatDraftState(sessionId, storageSource)
    mentionsRef.current = draft.mentions
    inputRef.current?.setDraft(draft.text, draft.mentions)
    setInput(draft.text)
    inputValueRef.current = draft.text
    draftEditRevision.current = draft.revision
  }, [sessionId, sourceSessionKey, storageSource])
  useEffect(() => () => {
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current?.()
  }, [])

  // 先恢复草稿再插入新引用，避免打开隐藏的对话面板时被恢复 effect 覆盖。
  useEffect(() => {
    const drain = (): void => {
      if (!sessionId || sourceEpoch !== getEngineSource() || !inputRef.current) return
      const queue = consumePendingMentions({ sessionId, source: sourceEpoch })
      for (const mention of queue) inputRef.current.insertMention(mention)
      if (queue.length) inputRef.current.focus()
    }
    drain()
    return subscribePendingMentions(drain)
  }, [sessionId, sourceEpoch])

  /** 用户编辑后防抖保存草稿（仅 onChange 路径，程序化 setInput 由调用方自行保存） */
  const scheduleDraftSave = useCallback(
    (text: string) => {
      window.clearTimeout(draftTimerRef.current)
      if (!sessionId || sourceEpoch !== getEngineSource()) return
      const mentions = [...mentionsRef.current]
      const revision = draftEditRevision.current
      const attachmentState = { attachments: [...attachmentStateRef.current], root: attachmentRoot }
      const persist = (): void => { saveChatDraft(sessionId, text, storageSource, mentions, revision, attachmentState) }
      pendingDraftSaveRef.current = persist
      draftTimerRef.current = window.setTimeout(() => {
        pendingDraftSaveRef.current = null
        persist()
      }, 400)
    },
    [sessionId, sourceEpoch, storageSource, attachmentRoot]
  )
  attachmentChangeRef.current = files => {
    attachmentStateRef.current = [...files]
    if (!sessionId || sourceEpoch !== getEngineSource()) return
    // A scope can change before the text debounce fires. Persist completed
    // attachment receipts immediately so returning to that draft can restore them.
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current = null
    draftEditRevision.current = saveChatDraft(sessionId, inputValueRef.current, storageSource, mentionsRef.current,
      nextChatDraftRevision(draftEditRevision.current), { attachments: files, root: attachmentRoot })
  }
  replaceImageDraftRef.current = (previous, next): void => {
    const draft = replaceImageAttachmentReferences({ text: inputValueRef.current, mentions: mentionsRef.current }, previous, next)
    if (draft.text === inputValueRef.current && draft.mentions.every((mention, index) => mention === mentionsRef.current[index])) return
    draftEditRevision.current += 1
    inputValueRef.current = draft.text
    mentionsRef.current = draft.mentions
    setInput(draft.text)
    inputRef.current?.setDraft(draft.text, draft.mentions)
    scheduleDraftSave(draft.text)
  }

  // ── 吸底跟随（对齐 wuzu-client CliChatView）──
  // 内容增高不能改变用户的阅读选择；手势暂停后，回到底部才恢复跟随。
  const [followBottom, setFollowBottom] = useState(true)
  const followBottomRef = useRef(true)
  // 非跟随期间来了新内容 → 显示「回到底部」按钮
  const [hasNewWhileUnfollowed, setHasNewWhileUnfollowed] = useState(false)
  /** 对齐 Wuzu：距底 8px 内才恢复跟随；较大的距离只用于显示回到底部按钮。 */
  const RESUME_FOLLOW_PX = 8
  const SHOW_BACK_TO_BOTTOM_PX = 80

  const measureDistToBottom = useCallback((): number => {
    const el = scrollRef.current
    if (!el) return 0
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }, [])

  const resumeFollowBottom = useCallback((): void => {
    pendingMessageNavigation.current = null
    navigationScrollTop.current = null
    followBottomRef.current = true
    setFollowBottom(true)
    setHasNewWhileUnfollowed(false)
  }, [])

  const scrollToBottom = useCallback(
    (force = false) => {
      const el = scrollRef.current
      if (!el) return
      if (!force && !followBottomRef.current) {
        // 非跟随时不滚动，按实际距离决定「回到底部」按钮浮不浮出
        setHasNewWhileUnfollowed(measureDistToBottom() > SHOW_BACK_TO_BOTTOM_PX)
        return
      }
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
      if (Math.abs(el.scrollTop - bottom) > 1) el.scrollTop = bottom
    },
    [measureDistToBottom]
  )

  // 用户手势离开吸底：只认「向上滚轮」与「按在滚动容器本身（滚动条）上」。
  // 点消息内部不算 —— 否则点气泡里的按钮会被误判为离开底部。
  const handleListWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // 思考正文有自己的滚动区域；上翻它不能改变外层消息列表的跟随状态。
      if ((event.target as HTMLElement).closest('.logline__detail--thinking')) return
      // 横移代码/表格不会离开消息底部；全局滚轮委托会在 React 冒泡之后执行。
      if (horizontalWheelTarget(event.nativeEvent)) return
      if (!event.deltaY || event.ctrlKey) return
      pendingMessageNavigation.current = null
      navigationScrollTop.current = null
      if (event.deltaY > 0) {
        if (!followBottomRef.current && measureDistToBottom() < RESUME_FOLLOW_PX) resumeFollowBottom()
        return
      }
      const el = scrollRef.current
      if (!el || el.scrollHeight <= el.clientHeight) return
      followBottomRef.current = false
      setFollowBottom(false)
    },
    [measureDistToBottom, resumeFollowBottom]
  )

  const handleListPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    pendingMessageNavigation.current = null
    navigationScrollTop.current = null
    const el = scrollRef.current
    if (!el || el.scrollHeight <= el.clientHeight) return
    followBottomRef.current = false
    setFollowBottom(false)
  }, [])

  // Editing a live child is an explicit choice to stay at that card. Streaming
  // or resize observations must not pull the focused editor out of view.
  const handleListFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest('.subagent-followup, .subagent-current')) return
    followBottomRef.current = false
    setFollowBottom(false)
  }, [])

  // 滚回底部附近（含拖动滚动条）时恢复跟随；滚到顶部附近时加载更早的消息
  const handleListScroll = useCallback(() => {
    const el = scrollRef.current
    // Short turns can share the bottom clamp. That programmatic landing must
    // not resume streaming follow or prepend another page over the selection.
    const navigationLanding = navigationScrollTop.current
    if (el && navigationLanding !== null) {
      if (Math.abs(el.scrollTop - navigationLanding) <= 2) return
      navigationScrollTop.current = null
    }
    const editingChild = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('.subagent-followup, .subagent-current'))
    if (!editingChild && !followBottomRef.current && measureDistToBottom() < RESUME_FOLLOW_PX) resumeFollowBottom()
    if (el && el.scrollTop < LOAD_EARLIER_PX) loadEarlier()
  }, [measureDistToBottom, resumeFollowBottom, loadEarlier])

  // 与正文提交一起在绘制前贴底，避免先露出新的一行、下一帧才滚动的闪跳。
  useLayoutEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom, followBottom])

  // 图片解码、过程展开与输入区变高不一定带来新消息；监听真实布局变化。
  // 保留轮次为容器的直接子节点，导航与历史前插仍使用相同的锚点。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const resize = new ResizeObserver(() => {
      if (followBottomRef.current) scrollToBottom()
    })
    resize.observe(el)
    for (const child of el.children) resize.observe(child)
    const children = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element) resize.unobserve(node)
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) resize.observe(node)
        }
      }
    })
    children.observe(el, { childList: true })
    return () => { children.disconnect(); resize.disconnect() }
  }, [scrollToBottom])

  // 切换会话或引擎来源时恢复 Wuzu 的默认状态：新会话第一次渲染始终从底部开始，
  // 不继承上一个会话用户上翻后的暂停状态。
  useLayoutEffect(() => {
    prependSnapshotRef.current = null
    resumeFollowBottom()
    scrollToBottom(true)
  }, [sourceSessionKey, resumeFollowBottom, scrollToBottom])

  // 回到底部按钮：立即贴底并恢复跟随
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    resumeFollowBottom()
    scrollToBottom(true)
  }, [resumeFollowBottom, scrollToBottom])

  const landMessageNavigation = useCallback((turnId: string, top: boolean): boolean => {
    const container = scrollRef.current
    const anchor = container?.querySelector<HTMLElement>(`:scope > .chat__turn[data-turn-id="${CSS.escape(turnId)}"]`)
    if (!container || !anchor) return false
    prependSnapshotRef.current = null
    container.scrollTop = top ? 0 : Math.max(0,
      anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8)
    navigationScrollTop.current = container.scrollTop
    setHasNewWhileUnfollowed(measureDistToBottom() > SHOW_BACK_TO_BOTTOM_PX)
    return true
  }, [measureDistToBottom])

  const navigateMessageTurn = useCallback((turn: NavTurn, top = false): void => {
    const index = turns.findIndex(item => item.id === turn.id)
    if (index < 0) return
    const first = turns[Math.min(index, hiddenTurnCount)]
    setNavigationStart({ key: sourceSessionKey, turnId: first.id })
    followBottomRef.current = false
    setFollowBottom(false)
    prependSnapshotRef.current = null
    navigationScrollTop.current = null
    pendingMessageNavigation.current = { key: sourceSessionKey, turnId: turn.id, top }
    if (landMessageNavigation(turn.id, top)) { pendingMessageNavigation.current = null; return }
    // The rail describes all loaded turns, while Code initially mounts only
    // the tail. Expand through the requested turn before measuring its anchor.
    const required = turns.slice(index).reduce((total, item) => total + item.messages.length, 0)
    setVisibleCount(count => Math.max(count, required))
  }, [turns, hiddenTurnCount, sourceSessionKey, landMessageNavigation])

  useLayoutEffect(() => {
    const target = pendingMessageNavigation.current
    if (!target) return
    const index = turns.findIndex(turn => turn.id === target.turnId)
    if (target.key !== sourceSessionKey || index < 0) {
      pendingMessageNavigation.current = null
      return
    }
    if (landMessageNavigation(target.turnId, target.top)) { pendingMessageNavigation.current = null; return }
    // A streamed append may arrive in the same commit as the window expansion.
    const required = turns.slice(index).reduce((total, turn) => total + turn.messages.length, 0)
    setVisibleCount(count => Math.max(count, required))
  }, [visibleTurns, turns, sourceSessionKey, landMessageNavigation])

  const navigateMessageTop = useCallback(() => {
    if (navTurns[0]) navigateMessageTurn(navTurns[0], true)
  }, [navTurns, navigateMessageTurn])
  useLayoutEffect(() => {
    if (!archivePage || !archiveNavigationRef.current) return
    const action = archiveNavigationRef.current
    archiveNavigationRef.current = null
    if (archivePage.unversioned) {
      prependSnapshotRef.current = null
      setVisibleCount(200)
      if (scrollRef.current) scrollRef.current.scrollTop = action === 'latest' ? scrollRef.current.scrollHeight : 0
    }
  }, [archivePage])

  const showBackToBottom = !followBottom && hasNewWhileUnfollowed

  // 输入框高度随内容增长：contenteditable 交给 CSS（max-height + overflow），无需 JS 撑高

  // 一轮对话结束（完成/中止/出错）时刷新 git：Agent 改了哪些文件此刻刚落盘定局。
  // refreshGit 是模块级函数（引用恒定），不属于 hook 依赖
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (!remoteReadOnly && wasStreaming.current && !streaming) void refreshGit(workspace.root)
    wasStreaming.current = streaming
  }, [streaming, workspace.root, remoteReadOnly])

  const selectModel = useCallback(
    (next: string) => {
      if (!sessionId || !sessionModelReady || sourceEpoch !== getEngineSource()) return
      const selection = { modelId: next, anchorRunId: sessionModel?.runId }
      setSelectedModel({ source: storageSource, sessionId, selection })
      saveSessionModelSelection(sessionId, selection, storageSource)
      void updateSettings({ lastModelId: next })
      // 运行中切换模型：把队列里待发消息的模型改写为新模型，
      // 避免出现「正在运行的回合显示成输入框后选的模型」这类错标
      void retargetQueuedModel(next, sessionId).catch(cause => setToast(cause instanceof Error ? cause.message : String(cause)))
    },
    [updateSettings, retargetQueuedModel, sessionId, sessionModelReady, sessionModel, sourceEpoch, storageSource]
  )

  // 默认选中：列表就绪后，若当前模型未选中或已失效（被删/改名），自动落到第一个
  const modelExists = models.some((model) => model.modelId === modelId)
  useEffect(() => {
    if (!sessionModelReady || !modelsLoaded || models.length === 0 || modelExists || sessionModel?.runId || modelSelection) return
    // Recovery and catalog fallback must not rewrite another session's queued requests.
    const selection = { modelId: models[0].modelId, anchorRunId: sessionModel?.runId }
    setSelectedModel({ source: storageSource, sessionId, selection })
    saveSessionModelSelection(sessionId, selection, storageSource)
  }, [sessionModelReady, modelsLoaded, models, modelExists, sessionModel, modelSelection, sessionId, storageSource])

  const buildSendOptions = useCallback(
    () => ({
      sessionId,
      ...composerRequest,
      model: modelId || undefined,
      // Memory preferences are durable engine state. Do not replay the previous
      // run's legacy scope over a newly changed default or session override.
      memoryScope: undefined,
      workspacePaths: remoteReadOnly ? [] : currentWorkspacePaths()
    }),
    [sessionId, composerRequest, modelId, remoteReadOnly]
  )

  const recoverRejectedDraft = useCallback((draft: RejectedDraft): void => {
    if (draft.attachments.length && draft.root !== attachmentRoot) return
    // A later draft belongs to the user too. Append recovered content instead
    // of overwriting edits made while the rejected request was in flight.
    const current = inputValueRef.current
    const recovered = preserveMentions(current.trim() ? `${current}\n\n${draft.text}` : draft.text,
      [...mentionsRef.current, ...draft.mentions])
    inputValueRef.current = recovered.text
    mentionsRef.current = recovered.mentions
    setInput(recovered.text)
    inputRef.current?.setDraft(recovered.text, recovered.mentions)
    attach.restore(draft.attachments)
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current = null
    draftEditRevision.current = saveChatDraft(sessionId, recovered.text, storageSource, recovered.mentions, nextChatDraftRevision(draftEditRevision.current), { attachments: attachmentStateRef.current, root: attachmentRoot })
    setRejectedDrafts(previous => {
      const next = { ...previous }; delete next[draftRecoveryKey]; return next
    })
  }, [attach.restore, attachmentRoot, draftRecoveryKey, sessionId, storageSource])

  const resolveRootFollowup = useCallback((operation: () => Promise<boolean>, sentMessage: string): void => {
    const original = inputValueRef.current, originalMentions = mentionsRef.current, revision = draftEditRevision.current, sentScope = draftScopeRef.current
    let sameDraft = false
    try { sameDraft = rootFollowupMessage(original, originalMentions, attach.attachments) === sentMessage } catch { /* Later attachment edits belong to the user. */ }
    void operation().then(accepted => {
      if (!accepted || !sameDraft || sourceEpoch !== getEngineSource() || displayedSessionRef.current !== sourceSessionKey || draftScopeRef.current !== sentScope
        || inputValueRef.current !== original || mentionsRef.current !== originalMentions || draftEditRevision.current !== revision) return
      inputValueRef.current = ''; mentionsRef.current = []; setInput('')
      suppressResourceReconcileRef.current = true; inputRef.current?.clear(); suppressResourceReconcileRef.current = false
      resourceTextRef.current = ''
      window.clearTimeout(draftTimerRef.current); pendingDraftSaveRef.current = null
      draftEditRevision.current = saveChatDraft(sessionId, '', storageSource)
    })
  }, [attach.attachments, sourceEpoch, sourceSessionKey, sessionId, storageSource])

  const submit = useCallback(() => {
    // When the slash palette is open, Enter belongs to palette selection;
    // ResourcePicker's document listener consumes it after this guard.
    if (resourceQuery !== null || mentionQuery !== null || manualPalette) return
    const text = input.trim()
    // 允许「只发附件」：丢张截图直接问，是视觉模型的常见用法
    const files = attach.attachments
    if ((!text && files.length === 0) || submissionFlight.current || stopping || rootFollowup.busy || rootFollowup.pending || attach.uploading || !canExecute || !sessionId || sourceEpoch !== getEngineSource() || historyEditRef.current?.key === sourceSessionKey) return
    if (immediateIntent) {
      if (!rootFollowupCanSubmit(rootAccepting, rootFollowup.capability)) return
      let message: string
      try { message = rootFollowupMessage(input, mentionsRef.current, files) }
      catch (cause) { setToast(cause instanceof Error ? cause.message : String(cause)); return }
      resolveRootFollowup(() => rootFollowup.send(message), message)
      return
    }
    // 流式进行中不再拦截：send 内部会入队，当前流结束后自动按序发出
    // Mentions are workspace-relative.  They are safe for remote sessions;
    // the main-process remote adapter strips local paths and resolves them
    // against the session-bound server workspace.
    const { message, collaborators } = buildAgentMentionMessage(input, mentionsRef.current)
    const original: RejectedDraft = { text: input, mentions: [...mentionsRef.current], attachments: files, root: attachmentRoot }
    const sentScope = draftScopeRef.current
    const revision = draftEditRevision.current
    let authored: ReturnType<typeof queuedDraft>
    try {
      window.clearTimeout(draftTimerRef.current); pendingDraftSaveRef.current = null
      saveChatDraftForSubmission(sessionId, input, storageSource, mentionsRef.current, revision, { attachments: files, root: attachmentRoot })
      authored = queuedDraft(input, mentionsRef.current, revision)
    }
    catch (cause) { setToast(cause instanceof Error ? cause.message : String(cause)); return }
    const flight = {}
    let admitted = false
    submissionFlight.current = flight; setSubmitting(true)
    const releaseComposer = (): void => {
      if (submissionFlight.current !== flight) return
      submissionFlight.current = null; setSubmitting(false)
    }
    const onAdmitted = (): void => {
      if (admitted) return
      admitted = true
      // The stream continues after admission. Clear only this authored draft,
      // and never let its eventual completion unlock a newer composer send.
      try {
        if (sourceEpoch !== getEngineSource() || displayedSessionRef.current !== sourceSessionKey || draftScopeRef.current !== sentScope
          || draftEditRevision.current !== revision || inputValueRef.current !== original.text) return
        setInput(''); inputValueRef.current = ''; mentionsRef.current = []
        suppressResourceReconcileRef.current = true; inputRef.current?.clear(); suppressResourceReconcileRef.current = false
        resourceTextRef.current = ''
        attach.removeSubmitted(files)
        window.clearTimeout(draftTimerRef.current); pendingDraftSaveRef.current = null
        draftEditRevision.current = saveChatDraft(sessionId, '', storageSource)
      } finally { releaseComposer() }
    }
    // 占位条目（若该会话是本次新建的）刷新时间戳，继续待在列表顶部；
    // 引擎落库后由列表侧的 prune 让它退场
    touchPendingSession(sessionId)
    // 发送是用户主动发起的「看最新输出」动作：无条件吸底（覆盖任何此前上滚导致的非跟随态），
    // 否则 80ms 流式节流窗口内 followBottom 已是 false 时整轮都不再跟随
    resumeFollowBottom()
    void send(message, {
      ...buildSendOptions(),
      queueDraft: authored,
      ...(collaborators.length ? { collaborators } : {}),
      attachments: files.length > 0 ? freezeAttachmentReferences(files) : undefined
    }, onAdmitted).catch(cause => {
      // Post-admission stream failures already belong to the transcript and
      // recovery UI; they must not restore a message that the engine accepted.
      if (admitted) return
      const current = sourceEpoch === getEngineSource() && displayedSessionRef.current === sourceSessionKey && draftScopeRef.current === sentScope
      if (!current || draftEditRevision.current !== revision || inputValueRef.current !== original.text) setRejectedDrafts(previous => ({ ...previous, [draftRecoveryKey]: original }))
      if (current) setToast(cause instanceof Error ? cause.message : String(cause))
    }).finally(releaseComposer)
    scrollToBottom(true)
  }, [attach, attachmentRoot, buildSendOptions, input, canExecute, stopping, sourceEpoch, sourceSessionKey, draftRecoveryKey, storageSource, send, sessionId, resumeFollowBottom, scrollToBottom, resourceQuery, mentionQuery, manualPalette, rootFollowup, rootAccepting, immediateIntent, resolveRootFollowup])

  /** 托盘的「发送」：空闲时按当前模式（逐条/合并）立即发出队列 */
  const flushQueueFromTray = useCallback(async () => {
    if (!canExecute || !sessionId || sourceEpoch !== getEngineSource() || historyEditRef.current?.key === sourceSessionKey) return
    await flushQueue()
  }, [flushQueue, canExecute, sessionId, sourceEpoch, sourceSessionKey])

  /**
   * 授权卡片上的「一路放行」入口。
   *
   * 只切模式不动当前这一步是没用的：引擎已经对本次调用下了 ask 决定并在等应答，
   * 切模式不会让挂起的流自己恢复。所以调用方要「先切模式、再放行」——
   * 切模式保证恢复后的后续命令不再被拦，放行用于解开眼前这一次。
   */
  const allowAllForSession = useCallback(
    async () => {
      if (!canExecute || sourceEpoch !== getEngineSource()) throw new Error('当前连接不能修改安全模式')
      await changeSecurityMode(sessionId, 'full-access')
      if (sourceEpoch !== getEngineSource()) throw new Error('引擎连接已变化，请在当前会话重试')
    },
    [canExecute, sessionId, sourceEpoch]
  )

  /**
   * 新建会话：换上新的会话 ID 即开一条全新对话。
   *
   * 不引入会话对象：sessionId 本就跟随 settings.lastSessionId，换 ID 后
   * 上面的回放 effect 会重新取历史（新 ID 无记录 → 空对话）。
   * 仅切换视图；旧会话由引擎继续执行，useChat 的会话边界隔离后续输出。
   */
  const createSession = useCallback(() => {
    if (!canExecute || sourceEpoch !== getEngineSource()) return
    const generated = newSessionId()
    // 引擎只列举「有对话记录」的会话，空会话不出现在列表里；
    // 先登记本地占位条目，让新建的会话在侧栏立刻可见
    registerPendingSession(generated)
    void updateSettings({ lastSessionId: generated })
  }, [updateSettings, canExecute, sourceEpoch])

  // 回合结束（流式停止）时通知会话列表重新拉取：首条消息落库后引擎才开始
  // 返回该会话，此时 lastSessionId 没变、列表页的刷新 effect 不会触发，
  // 占位条目需要这次信号才能退场换成真条目（时间/摘要有真实数据）
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) requestSessionListRefresh()
    wasStreamingRef.current = streaming
  }, [streaming])

  // ── 多选导出 ────────────────────────────────────────────────────────────────
  const toggleSelectMode = useCallback(() => {
    setSelectMode((value) => !value)
    setSelectedIds(new Set())
  }, [])

  const toggleMessage = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const allSelected = messages.length > 0 && messages.every((m) => selectedIds.has(m.id))
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(messages.map((m) => m.id)))
  }, [allSelected, messages])

  /** 选中内容按会话时间顺序（而非点击顺序）序列化成 Markdown */
  const buildExportText = useCallback(() => {
    const picked = messages.filter((m) => selectedIds.has(m.id))
    return serializeMessages(picked)
  }, [messages, selectedIds])

  const copySelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setToast(`已复制 ${selectedIds.size} 项`)
        // 复制是这一步的终点：退出多选，回到正常阅读状态
        setSelectMode(false)
        setSelectedIds(new Set())
      },
      () => setToast('复制失败')
    )
  }, [buildExportText, selectedIds])

  // ── 消息级操作（hover 工具条）─────────────────────────────────────────────
  const copyMessage = useCallback((message: ChatMessage) => {
    void navigator.clipboard.writeText(serializeMessages([message])).then(
      () => setToast('已复制'),
      () => setToast('复制失败')
    )
  }, [])

  /** 轻提示：出现后短暂停留自动消失，不打断后续操作 */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  /** 错误提示（替代 window.alert，主题化展示） */
  const showError = useCallback((err: unknown, prefix?: string) => {
    const message = err instanceof Error ? err.message : String(err)
    void confirmDialog({
      title: '操作失败',
      body: prefix ? `${prefix}${message}` : message,
      confirmText: '知道了'
    })
  }, [])

  /** 删除引擎侧该消息之后的历史并重新发送（重新发送 / 重新生成共用） */
  const retryTurn = useCommittedCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource() || historyEditRef.current) return
      // 重新生成（助手消息）等价于从它前面的用户提问处重发
      const index = messages.findIndex((m) => m.id === message.id)
      const userMessage =
        message.role === 'user' ? message : messages.slice(0, index).reverse().find((m) => m.role === 'user')
      if (!userMessage) return
      void confirmDialog({
        title: message.role === 'user' ? '重新发送' : '重新生成',
        body: message.role === 'user' ? '删除此后的对话并重新发送？' : '删除本轮回答并重新生成？',
        danger: true
      }).then((confirmed) => {
        if (!confirmed || sourceEpoch !== getEngineSource() || historyEditRef.current) return
        void retryFrom(userMessage, buildSendOptions()).catch(showError)
      })
    }
  )

  const deleteTurnById = useCommittedCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource() || historyEditRef.current) return
      void confirmDialog({
        title: '删除本轮',
        body: '删除这一轮问答（含引擎侧历史）？',
        danger: true,
        confirmText: '删除'
      }).then((confirmed) => {
        if (!confirmed || sourceEpoch !== getEngineSource() || historyEditRef.current) return
        void deleteTurn(sessionId, message).catch((err) => showError(err))
      })
    }
  )

  /**
   * 「添加到对话」：在现有草稿后追加历史正文、引用 chip 和附件。
   *
   * 正文里的引用原数据（代码块 / 终端输出）会换回 `@路径` token，chip 按 token 下标重建，
   * 所以能原样改完再发，当前尚未发送的内容也会保留。
   */
  const refillFromMessage = useCallback((message: ChatMessage) => {
    if (sourceEpoch !== getEngineSource() || displayedSessionRef.current !== sourceSessionKey || historyEditRef.current) return
    const draft = appendMessageDraft({ text: inputValueRef.current, mentions: mentionsRef.current }, userMessageDraft(message.content))
    inputValueRef.current = draft.text
    mentionsRef.current = draft.mentions
    resourceTextRef.current = draft.text
    inputRef.current?.setDraft(draft.text, draft.mentions)
    setInput(draft.text)
    attach.restore(message.attachments ?? [])
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current = null
    draftEditRevision.current = saveChatDraft(sessionId, draft.text, storageSource, draft.mentions, nextChatDraftRevision(draftEditRevision.current), { attachments: attachmentStateRef.current, root: attachmentRoot })
    inputRef.current?.focus()
  }, [attach.restore, sessionId, storageSource, sourceEpoch, sourceSessionKey])

  const editFromMessage = useCommittedCallback((message: ChatMessage) => {
    if (!canExecute || taskActive || sourceEpoch !== getEngineSource() || displayedSessionRef.current !== sourceSessionKey || historyEditRef.current) return
    const operation = { key: sourceSessionKey }
    const operationScope = draftScopeRef.current
    const isCurrentScope = (): boolean => sourceEpoch === getEngineSource()
      && displayedSessionRef.current === sourceSessionKey && draftScopeRef.current === operationScope
    historyEditRef.current = operation
    setHistoryEdit(operation)
    void (async () => {
      try {
        const confirmed = await confirmDialog({
          title: '从此处重新编辑',
          body: '删除这条消息及后续对话，并将原指令和附件带回输入框。已生成的文件保持不变，当前草稿会保留；编辑后由你发送。',
          danger: true,
          confirmText: '重新编辑'
        })
        if (!confirmed || !isCurrentScope()) return
        await truncateFrom(sessionId, message)
        if (!isCurrentScope()) return
        // Read the live draft after the server settles: text typed while the
        // request was pending belongs to the user and must survive recovery.
        const draft = restoreMessageDraft({ text: inputValueRef.current, mentions: mentionsRef.current }, userMessageDraft(message.content))
        inputValueRef.current = draft.text
        mentionsRef.current = draft.mentions
        resourceTextRef.current = draft.text
        inputRef.current?.setDraft(draft.text, draft.mentions)
        setInput(draft.text)
        attach.restore(message.attachments ?? [])
        window.clearTimeout(draftTimerRef.current)
        pendingDraftSaveRef.current = null
        draftEditRevision.current = saveChatDraft(sessionId, draft.text, storageSource, draft.mentions, nextChatDraftRevision(draftEditRevision.current), { attachments: attachmentStateRef.current, root: attachmentRoot })
        inputRef.current?.focus()
      } catch (error) {
        if (isCurrentScope()) showError(error)
      } finally {
        if (historyEditRef.current === operation) {
          historyEditRef.current = null
          setHistoryEdit(null)
        }
      }
    })()
  })

  /** 消息级回退（对齐 wuzu revert-files）：恢复该消息后全部文件改动（含已保留）并截断对话，原文回填输入框 */
  const revertToMessage = useCommittedCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource() || historyEditRef.current) return
      void (async () => {
        // 引用 chip 一并还原：当初能改「这段代码」再发，回退后也应该能
        const draft = userMessageDraft(message.content)
        void revertFrom(sessionId, message)
          .then((completed) => {
            if (!completed) return
            if (sourceEpoch !== getEngineSource()) return
            const revision = saveChatDraft(sessionId, draft.text, storageSource, draft.mentions, nextChatDraftRevision())
            if (displayedSessionRef.current !== sourceSessionKey) return
            mentionsRef.current = draft.mentions
            resourceTextRef.current = draft.text
            inputRef.current?.setDraft(draft.text, draft.mentions)
            setInput(draft.text)
            inputValueRef.current = draft.text
            draftEditRevision.current = revision
          })
          .catch(showError)
      })()
    }
  )

  /** 挂起卡片的应答提交：引用稳定，保证 MessageItem memo 生效（流式时不让所有历史消息跟着重渲染） */
  const respondToEngine = useCommittedCallback(
    (requestId: string, values: string[]) => {
      if (!canExecute || sourceEpoch !== getEngineSource()) return
      void respond(requestId, values, buildSendOptions()).catch(showError)
    }
  )

  const exportSelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `aether-对话导出-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    setToast(`已导出 ${selectedIds.size} 项`)
  }, [buildExportText, selectedIds])

  // 列表不含引擎环境中的默认模型；提供配置入口，不能据空列表断言对话不可用。
  const needsModel = canExecute && modelsLoaded && models.length === 0

  const cgIndex = useCodegraphIndex({ sessionId, path: codegraphRoot, active: appMode === 'code', ready })

  return (
    <ImageConversationProvider value={{ scope: imageConversationScope, addImage: attach.addImage }} active={appMode === 'code' && Boolean(sessionId)}>
    <ToolImageGalleryProvider messages={messages} source={sourceEpoch} sessionId={sessionId} active={appMode === 'code'}>
    <div className="chat">
      <PublishedRecoveryNotice state={publishedRecovery} onCancel={cancelPublishedRecovery} onLoadBody={loadPublishedBody} onRetry={retryPublishedRecovery} />
      <div className="chat__topbar">
        {remoteReadOnly ? <span className="chat__workspace" title="任务在远端引擎的会话工作目录中执行">远端会话</span> : workspace.root ? (
          <span className="chat__workspace" title={`Agent 的工作区：${workspace.root}`}>
            {workspace.root.replace(/\\/g, '/').split('/').pop()}
          </span>
        ) : null}
        <div className="chat__toolbar-spacer" />
        {usageSyncNotice ? <span className="subagent-history__notice" role="status" title={usageSyncNotice}>统计待同步</span> : null}
        {usageTotal.total > 0 || usageTotal.unknownSubagents > 0 ? (
          <UsageMeter
            total={usageTotal.total}
            rounds={usageTotal.rounds}
            summary={usageTotal.summary}
            messages={messages}
          />
        ) : null}
        <button
          type="button"
          className="chat__toolbar-btn"
          title="新建会话（开一条全新对话）"
          disabled={!canExecute}
          onClick={createSession}
        >
          <Icon name="plus" size={16} />
          新建
        </button>
        <button
          type="button"
          className={`chat__toolbar-btn${selectMode ? ' is-active' : ''}`}
          disabled={messages.length === 0}
          title="多选消息，可复制或导出为 Markdown"
          onClick={toggleSelectMode}
        >
          <Icon name="check" size={16} />
          多选
        </button>
      </div>

      {selectMode ? (
        <div className="chat__select-bar">
          <div className="chat__select-leading">
            <button type="button" className="chat__toolbar-btn" onClick={toggleAll}>
              {allSelected ? '取消全选' : '全选'}
            </button>
            <span className="chat__select-count">已选 {selectedIds.size} 项</span>
          </div>
          <div className="chat__select-actions">
            <button
              type="button"
              className="chat__toolbar-btn"
              disabled={selectedIds.size === 0}
              onClick={copySelected}
            >
              复制
            </button>
            <button
              type="button"
              className="chat__toolbar-btn"
              disabled={selectedIds.size === 0}
              onClick={exportSelected}
            >
              导出
            </button>
            <button type="button" className="chat__toolbar-btn chat__toolbar-btn--done" onClick={toggleSelectMode}>
              完成
            </button>
          </div>
        </div>
      ) : null}

      <div className="chat__body">
        <MessageNavRail
          sessionId={sessionId}
          turns={navTurns}
          containerRef={scrollRef}
          disabled={!canExecute || streaming || selectMode || Boolean(historyEdit)}
          onCopy={copyMessage}
          onRetry={retryTurn}
          onRevert={revertToMessage}
          onDelete={deleteTurnById}
          onNavigate={navigateMessageTurn}
          onTop={navigateMessageTop}
          onBottom={jumpToBottom}
          navigationKey={hiddenTurnCount}
        />
        <div
          className="chat__messages"
          data-chat-scroll-region="true"
          data-follow-bottom={followBottom}
          ref={scrollRef}
          onWheel={handleListWheel}
          onPointerDown={handleListPointerDown}
          onFocusCapture={handleListFocus}
          onScroll={handleListScroll}
        >
        {/* 非跟随期间来了新内容：浮动「回到底部」（对齐 wuzu-client） */}
        <MotionPresence show={showBackToBottom} asChild>
          <button type="button" className="chat__back-to-bottom" onClick={jumpToBottom}>
            <Icon name="chevron-double-down" size={16} />
          </button>
        </MotionPresence>
        {messages.length === 0 && !historyCompacted && !archivePage ? (
          <div className="chat__empty">
            <h2>Agent IDE</h2>
            <p>
              {ready && remoteReadOnly
                ? '远端已连接。输入任务即可开始；新会话使用设置中的远端工作目录，未填写时使用服务端沙箱。'
                : ready
                ? '引擎已就绪。输入你的问题或任务，Agent 会调用工具直接在你的工作区里完成。'
                : '正在准备引擎，就绪后即可开始对话。'}
            </p>
          </div>
        ) : (
          <>
            {archiveError ? <p className="chat__notice" role="alert">{archiveError}</p> : null}
            {archivePage?.unversioned ? <div className="chat__notice" role="status"><span>归档第 {archivePage.firstPage} / {archivePage.totalPages} 页 · 引擎未提供跨页版本一致性，每次仅显示当前页。</span></div> : null}
            {historyCompacted ? (
              <button
                type="button"
                className="chat__load-earlier"
                onClick={() => loadArchivedPage('older')}
                data-archive-page="true"
                disabled={archiveLoading}
              >
                {archiveLoading ? '正在加载历史归档…' : archiveRemaining === null ? '当前上下文已压缩，点击加载仍保留在归档中的更早对话' : `还有 ${archiveRemaining} 条更早的归档记录，点击继续加载`}
              </button>
            ) : null}
            {hiddenTurnCount > 0 ? (
              <button
                type="button"
                className="chat__load-earlier"
                onClick={loadEarlier}
              >
                还有 {hiddenTurnCount} 轮更早的对话，点击或滚到顶部加载
              </button>
            ) : null}
            {visibleTurns.map((turn) => (
            <div key={turn.id} className="chat__turn" data-turn-id={turn.id}>
              {turn.messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    sessionId={sessionId}
                    controllerSource={appMode === 'code' && sessionModelReady ? sourceEpoch : undefined}
                    usage={usageByMessage.get(message.id)}
                    disabled={!canExecute || streaming}
                  onAllowAll={allowAllForSession}
                  selectionMode={selectMode}
                  selected={selectedIds.has(message.id)}
                  onToggleSelect={toggleMessage}
                  onRespond={respondToEngine}
                  onCopy={copyMessage}
                  onRetryFrom={retryTurn}
                  onRefill={refillFromMessage}
                  onEditFrom={editFromMessage}
                  onRevertFiles={revertToMessage}
                  onDeleteTurn={deleteTurnById}
                  canAct={canExecute && !streaming && !selectMode && !historyEdit}
                  workspaceRoot={workspace.root}
                  onPreviewImage={previewAttachment}
                />
                ))}
            </div>
            ))}
            {archivePage?.unversioned && archivePage.lastPage < archivePage.totalPages ? <div className="chat__notice"><button type="button" className="chat__load-earlier" disabled={archiveLoading} onClick={() => loadArchivedPage('newer')}>查看较新归档页</button><button type="button" className="chat__load-earlier" disabled={archiveLoading} onClick={() => loadArchivedPage('latest')}>回到最新归档</button></div> : null}
          </>
        )}
        </div>
      </div>

      {needsModel ? (
        <div className="chat__notice">
          <span>尚未配置模型，请先添加模型。</span>
          <button type="button" className="link" onClick={() => openAppSettings('models')}>
            去添加模型
          </button>
        </div>
      ) : null}

      {visibleChildCommandJobs(messages, commandJobs, sessionId).length > 0 ? (
        <section className="command-job-children" aria-label="子代理后台命令">
          <div className="command-job-card__meta">子代理后台命令</div>
          {visibleChildCommandJobs(messages, commandJobs, sessionId).map(job => <CommandJobCard key={job.jobId} job={job} sessionId={sessionId} />)}
        </section>
      ) : null}
      <div
        className={`chat__composer${attach.dragging ? ' is-dragover' : ''}`}
        onDragOver={(event) => {
          // 不 preventDefault 的话浏览器会直接打开被拖入的文件
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (!canExecute) return
          attach.setDragging(true)
        }}
        onDragLeave={(event) => {
          // 移到子元素上也会触发 leave：只有真正离开容器才取消高亮
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          attach.setDragging(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          attach.setDragging(false)
          if (!canExecute) return
          attach.accept([...event.dataTransfer.files])
        }}
      >
        <SessionTray
          key={sourceSessionKey}
          sessionId={sessionId}
          streaming={streaming}
          todos={todos}
          queue={queue}
          workspaceRoot={workspace.root}
          queueState={queueState}
          onPauseQueue={pauseQueue}
          onReconcileQueue={reconcileQueue}
          onMergePending={mergeQueued}
          onUpdateQueued={updateQueued}
          onMoveQueued={moveQueued}
          onRemoveQueued={removeQueued}
          onClearQueue={clearQueue}
          onMergeQueue={flushQueueFromTray}
        />
        <SessionConnectionNotice key={sourceSessionKey} ready={ready} sessionId={sessionId} source={sourceEpoch}
          connection={connection} active={streaming || messages.some(message => message.run?.status === 'running')}
          error={historyError} onRetry={() => resumeStream(sessionId)} />
        {stopError ? <div className="chat__notice" role="alert">
          <span>{stopError}</span>
          <button type="button" className="chat__toolbar-btn" aria-label="关闭停止提示" onClick={dismissStopError}>关闭</button>
        </div> : null}
        {rejectedDraft ? <div className="chat__notice" role="status">
          <span>{rejectedDraft.attachments.length > 0 && rejectedDraft.root !== attachmentRoot ? '未发送内容已保留，请切回原工作区后找回。' : '有一条消息未发送成功，内容已保留。'}</span>
          <button type="button" className="chat__toolbar-btn" disabled={rejectedDraft.attachments.length > 0 && rejectedDraft.root !== attachmentRoot}
            onClick={() => recoverRejectedDraft(rejectedDraft)}>找回未发送内容</button>
        </div> : null}
        {recoveryNotice ? (
          <div className="chat__notice chat__notice--info" role="status" aria-live="polite">
            <span>{recoveryNotice}</span>
            <button type="button" className="chat__toolbar-btn" onClick={dismissRecoveryNotice}>知道了</button>
          </div>
        ) : null}
        {sessionModelReady && modelsLoaded && modelId && !modelExists ? (
          <div className="chat__notice" role="status">
            当前模型未在模型列表中。继续发送将使用会话原模型，也可在模型菜单中重新选择或配置。
          </div>
        ) : null}
        <InputComposer ref={composerRef}>
          {(attach.attachments.length > 0 || attach.uploading) ? (
            <div className="chat__attach-strip">
              <AttachmentStrip root={workspace.root} sessionId={sessionId}
                references={currentAttachmentReferences} mentions={mentionsRef.current}
                onPreview={(file, src) => previewAttachment(file, src, attach.attachments.filter(item => item.type.startsWith('image/')), true)}
                onRemove={file => { inputRef.current?.removeAttachmentReferences(attachmentIdentity(file)); attach.remove(file.path) }}
                onReorder={attach.reorder} />
              {attach.uploading ? (
                <span className="attach-chip attach-chip--busy">
                  <span className="attach-chip__progress" role="status" title={attach.uploadingFileName ?? undefined}>
                    正在上传 {attach.uploadingFileName}{attach.uploadingCount > 1 ? `（${attach.uploadingCount} 个待完成）` : ''}
                  </span>
                  <button type="button" className="attach-chip__cancel" aria-label="取消上传" onClick={attach.cancelUpload}>
                    取消
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          {(composerResources.skills.length + composerResources.mcpServers.length + composerResources.knowledgeBases.length) > 0 ? (
            <div className="resource-binding-strip" aria-label="本轮对话资源">
              {composerResources.skills.map(id => <button key={`skill:${id}`} type="button" aria-label={`移除技能 ${id}`} className="resource-binding-chip is-skill" title={`移除技能 ${id}`} onClick={() => removeComposerResource('skill', id)}>技能 · {id}<span aria-hidden="true">×</span></button>)}
              {composerResources.mcpServers.map(id => <button key={`mcp:${id}`} type="button" aria-label={`移除 MCP ${id}`} className="resource-binding-chip is-mcp" title={`移除 MCP ${id}`} onClick={() => removeComposerResource('mcp', id)}>MCP · {id}<span aria-hidden="true">×</span></button>)}
              {composerResources.knowledgeBases.map(id => <button key={`kb:${id}`} type="button" aria-label={`移除知识库 ${id}`} className="resource-binding-chip is-kb" title={`移除知识库 ${id}`} onClick={() => removeComposerResource('kb', id)}>知识库 · {id}<span aria-hidden="true">×</span></button>)}
            </div>
          ) : null}

          <ComposerInput
            ref={inputRef}
            value={input}
            attachmentReferences={currentAttachmentReferences}
            attachmentRoot={workspace.root}
            attachmentSessionId={sessionId}
            disabled={!settingsLoaded}
            placeholder={
              ready ? taskActive ? `补充要求，Enter ${immediateIntent ? '立即补充' : '排到下一轮'}，Shift+Enter 换行；@ 引用文件，/ 选择资源` : '输入消息，Enter 发送，Shift+Enter 换行；@ 引用文件或协作 Agent，/ 选择资源' : '可先准备问题和代码引用，引擎就绪后发送'
            }
            onChange={(text, mentions) => {
              draftEditRevision.current += 1
              mentionsRef.current = mentions
              refreshMentionLabels(revision => revision + 1)
              reconcileComposerResources(text)
              inputValueRef.current = text
              setInput(text)
              scheduleDraftSave(text)
            }}
            onSubmit={submit}
            onPasteFiles={(files) => { if (canExecute) attach.accept(files) }}
            onPasteText={(text, insertion) => {
              // 长文本落成「粘贴的文本-xxx.txt」附件；短文本返回 false 由输入框自行插入
              if (!canExecute || !shouldAttachPastedText(text) || (!remoteReadOnly && !workspace.root)) return false
              insertion.cancel()
              attach.accept([createPastedTextFile(text)])
              return true
            }}
            onMentionQuery={(query) => { setMentionQuery(query); if (query !== null) setResourceQuery(null) }}
            onSlashQuery={(query) => { setResourceQuery(query); if (query !== null) setMentionQuery(null) }}
          />
          <ComposerPolish busy={polishing} disabled={!canExecute || !input.trim()} title="AI 润色：让指令更清晰具体（使用轻任务模型）" onClick={() => void handlePolish()} />
            <CompletionPopover open={canExecute && appMode === 'code' && (mentionQuery !== null || manualPalette)} anchorRef={composerRef} onClose={() => { setManualPalette(false); setMentionQuery(null) }}>
            <MentionRefPicker
              open={canExecute && appMode === 'code' && (mentionQuery !== null || manualPalette)}
              root={workspace.root}
              sessionId={sessionId}
              attachments={currentAttachmentReferences}
              query={mentionQuery ?? ''}
              showSearch={manualPalette && mentionQuery === null}
              onSelect={(mention) => {
                if (mentionQuery !== null) inputRef.current?.completeMention(mention)
                else inputRef.current?.insertMention(mention)
                setManualPalette(false)
                setMentionQuery(null)
              }}
              onClose={() => {
                setManualPalette(false)
                setMentionQuery(null)
                inputRef.current?.focus()
              }}
            />
            </CompletionPopover>
          <CompletionPopover open={appMode === 'code' && resourceQuery !== null} anchorRef={composerRef} onClose={() => setResourceQuery(null)}>
            <ResourcePicker
              query={resourceQuery ?? ''}
              projectPath={remoteReadOnly ? settings.remoteWorkspaceRoot.trim() || undefined : workspace.root || undefined}
              source={sourceEpoch}
              onSelect={chooseComposerResource}
              onClose={() => { setResourceQuery(null); inputRef.current?.focus() }}
            />
          </CompletionPopover>
          {attach.error ? (
            <div className="chat__attach-hint" role="alert">
              <span>{attach.error}</span>
              <button type="button" className="chat__attach-hint-close" aria-label="关闭附件错误" onClick={attach.clearError}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
          {appMode === 'code' && previewImage?.scope === imageConversationScope ? (
            <AttachmentPreviewDialog
              root={workspace.root}
              preview={previewImage}
              images={previewGroup}
              onNavigate={(file) => setPreviewImage(previous => previous ? { ...previous, file, src: null } : null)}
              onApply={previewImage.draft ? (file) => attach.addImage(file, previewImage.file.path) : undefined}
              onClose={() => setPreviewImage(null)}
            />
          ) : null}
          <input
            ref={attach.fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // 清空 value：否则再次选择同一个文件不会触发 change
              event.target.value = ''
              if (!canExecute) return
              attach.accept(files)
            }}
          />

          {/* 工具条：左「＋ / 权限 / Agent」，右「模型 / 语音 / 发送」——同 Trae 的排布 */}
          <ComposerToolbar leading={<>
            <button
              type="button"
              className={`chat__icon-btn${attach.dragging ? ' is-active' : ''}`}
              disabled={!canExecute || attach.uploading || (!remoteReadOnly && !workspace.root)}
              title={
                remoteReadOnly ? '上传附件到远端引擎当前会话工作区' : workspace.root
                  ? '添加附件或引用（图片 / 文本 / 工作空间文件 / 目录）'
                  : '先打开一个项目目录再添加附件'
              }
              aria-label="添加附件或引用"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setAttachMenu({ x: rect.left, y: rect.top })
              }}
            >
              <Icon name="plus" size={16} />
            </button>
            {attachMenu ? (
              <ContextMenu
                x={attachMenu.x}
                y={attachMenu.y - 8}
                onClose={() => setAttachMenu(null)}
                items={[
                  {
                    id: 'upload',
                    label: '上传附件',
                    hint: '图片 / 文本 / 文档',
                    onSelect: () => {
                      setAttachMenu(null)
                      attach.pick()
                    }
                  },
                  {
                    id: 'workspace',
                    label: '引用工作空间文件 / 目录',
                    hint: '@ 引用，随消息发送给 Agent',
                    onSelect: () => {
                      setAttachMenu(null)
                      setManualPalette(true)
                      inputRef.current?.focus()
                    }
                  }
                ]}
              />
            ) : null}

            <ComposerOptions sessionId={sessionId} modelId={modelId} thinkingMode={thinkingMode} onThinkingChange={selectThinkingMode} />

            {/* 仅当项目「尚未建索引」时才露出建索引入口；已建索引则不占位（重建走设置页 / 菜单） */}
            {(cgIndex.known || cgIndex.queryFailed) && !cgIndex.initialized ? (
              <button
                type="button"
                className={`chat__index-cta${cgIndex.busy ? ' is-active' : ''}`}
                disabled={!canExecute || !sessionId || cgIndex.busy || cgIndex.checking}
                title={
                  cgIndex.error || (codegraphRoot
                    ? `为「${codegraphRoot.replace(/\\/g, '/').split('/').pop()}」创建代码图索引（Agent 随之可查询符号 / 调用关系 / 影响面）`
                    : '为当前会话工作区创建代码图索引')
                }
                onClick={cgIndex.queryFailed ? cgIndex.refresh : cgIndex.start}
              >
                <Icon name="search" size={16} />
                <span className="picker__label">{cgIndex.label ?? '建索引'}</span>
              </button>
            ) : null}

            </>} trailing={<>

            {contextUsage !== null || contextCompaction ? (
              <ContextUsageIndicator
                requestEstimate={contextDisplay.requestEstimate}
                key={`${sourceEpoch}:${sessionId}`}
                used={contextUsed}
                limit={contextLimit}
                estimated={contextUsage?.estimated}
                provisional={contextUsage?.provisional}
                usageKnown={contextUsage !== null}
                compaction={contextCompaction}
                streaming={streaming}
              />
            ) : null}

            <ModelPicker
              active={appMode === 'code'}
              scopeKey={sessionId}
              value={modelId}
              disabled={!sessionModelReady || !ready || immediateIntent}
              onChange={selectModel}
              onManage={() => openAppSettings('models')}
            />

            {taskActive ? <ComposerStop loading={stopping} disabled={!ready} onClick={() => { void abort().catch(() => {}) }} /> : null}
            {taskActive ? <RootFollowupDelivery controller={rootFollowup} disabled={stopping || !canExecute} /> : null}
            <ComposerSend label={historyEditBusy ? '正在重新编辑…' : immediateIntent ? '立即补充' : taskActive ? '排到下一轮' : '发送'} loading={rootFollowup.busy} loadingLabel="正在提交补充…"
              disabled={submitting || historyEditBusy || !canExecute || stopping || Boolean(rootFollowup.pending) || attach.uploading || (!input.trim() && attach.attachments.length === 0)
                || (immediateIntent && (!rootFollowupCanSubmit(rootAccepting, rootFollowup.capability) || Boolean(rootFollowupLimitation(mentionsRef.current, attach.attachments))))} onClick={submit} />
          </>} />
        </InputComposer>
          <RootFollowupFeedback key={JSON.stringify([sourceEpoch, sessionId])} controller={rootFollowup} active={taskActive} limitation={rootWaiting ? '请先处理上方确认，任务恢复后可立即补充；草稿已保留。' : !rootAccepting && taskActive ? '正在确认当前任务是否可接收补充，草稿已保留。' : rootFollowupLimitation(mentionsRef.current, attach.attachments)}
            onFocusInput={() => inputRef.current?.focus()}
            fallbackHint={!ready ? '引擎尚未就绪，草稿会保留。' : taskActive && !immediateIntent ? 'Enter 排到下一轮 · Shift + Enter 换行' : 'Enter 发送 · Shift + Enter 换行'}
            onResolve={resolveRootFollowup}
            canRestore={!input.trim() && !attach.attachments.length} onRestore={message => {
              if (inputValueRef.current.trim()) return
              const recovered = userMessageDraft(message)
              draftEditRevision.current += 1; inputValueRef.current = recovered.text; mentionsRef.current = recovered.mentions
              setInput(recovered.text); inputRef.current?.setDraft(recovered.text, recovered.mentions); scheduleDraftSave(recovered.text)
              inputRef.current?.focus()
            }} />
      </div>

      {toast ? (
        <div className="chat__toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
    </ToolImageGalleryProvider></ImageConversationProvider>
  )
}

// ==================== 消息渲染 ====================

const MessageItem = memo(function MessageItem({
  message,
  sessionId,
  controllerSource,
  usage,
  disabled,
  onAllowAll,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onRespond,
  onCopy,
  onRetryFrom,
  onRefill,
  onEditFrom,
  onRevertFiles,
  onDeleteTurn,
  canAct,
  workspaceRoot,
  onPreviewImage
}: {
  message: ChatMessage
  /** 当前会话 ID（子代理停止按钮走 /subagent/cancel 要用） */
  sessionId: string
  controllerSource?: number
  /** 该轮的累计用量：只挂在最后一条 AI 消息底部的过程行上 */
  usage?: TurnUsageInfo
  disabled: boolean
  /** 把本会话切成 full-access（用于授权卡片的一键放行） */
  onAllowAll: () => Promise<void>
  /** 多选模式：true 时消息头部显示复选框 */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onRespond: (requestId: string, values: string[]) => void
  /** 复制该消息文本 */
  onCopy: (message: ChatMessage) => void
  /** 从该用户消息处删除此后内容并重新发送（重新发送 / 重新生成共用） */
  onRetryFrom: (message: ChatMessage) => void
  /** 把这条用户消息（含引用 chip）放回输入框，改完再发 */
  onRefill: (message: ChatMessage) => void
  /** 截断这条用户消息及后续历史，再回填草稿，不自动发送或回退文件。 */
  onEditFrom: (message: ChatMessage) => void
  /** 消息级回退：恢复该消息后所有文件改动（含已保留）并截断对话 */
  onRevertFiles: (message: ChatMessage) => void
  /** 删除该消息所在的一整轮对话 */
  onDeleteTurn: (message: ChatMessage) => void
  /** 是否允许执行重试/删除（流式进行中或多选模式下禁止） */
  canAct: boolean
  /** 工作区根目录：附件图片缩略图按相对路径回读 */
  workspaceRoot: string | null
  /** 图片附件点击放大 */
  onPreviewImage: (file: ChatAttachment, src: string | null, group?: ChatAttachment[]) => void
}): JSX.Element {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const [copied, setCopied] = useState(false)

  const pick = selectionMode ? (
    <label className="message__pick">
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect?.(message.id)}
        aria-label={isUser ? '选择这条用户消息' : '选择这条 Agent 消息'}
      />
    </label>
  ) : null

  const copy = (): void => {
    onCopy(message)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const actions = selectionMode || streaming ? null : (
    <div className="message__actions">
      <button
        type="button"
        className="message__action"
        title={copied ? '已复制' : '复制'}
        aria-label="复制"
        onClick={copy}
      >
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
      {isUser ? (
        <>
          <button
            type="button"
            className="message__action"
            title="添加到对话：把这条消息（含引用）放回输入框，改完再发"
            aria-label="添加到对话"
            disabled={!canAct}
            onClick={() => onRefill(message)}
          >
            <Icon name="pencil" size={16} />
          </button>
          <button
            type="button"
            className="message__action"
            title="从此处重新编辑：删除这条消息及后续对话，保留文件并将原指令带回输入框"
            aria-label="从此处重新编辑"
            disabled={!canAct}
            onClick={() => onEditFrom(message)}
          >
            <Icon name="file-edit-outline" size={16} />
          </button>
          <button
            type="button"
            className="message__action"
            title="回退到此处：撤销此消息及后续轮次的全部文件修改（含已保留），并删除对应对话"
            aria-label="回退到此处"
            disabled={!canAct}
            onClick={() => onRevertFiles(message)}
          >
            <Icon name="restart" size={16} />
          </button>
          <button
            type="button"
            className="message__action"
            title="删除此后的对话并重新发送"
            aria-label="重新发送"
            disabled={!canAct}
            onClick={() => onRetryFrom(message)}
          >
            <Icon name="send" size={16} />
          </button>
        </>
      ) : (
        <button
          type="button"
          className="message__action"
          title="从上一条提问处重新生成"
          aria-label="重新生成"
          disabled={!canAct}
          onClick={() => onRetryFrom(message)}
        >
          <Icon name="restart" size={16} />
        </button>
      )}
      <button
        type="button"
        className="message__action message__action--danger"
        title="删除这一轮问答"
        aria-label="删除本轮"
        disabled={!canAct}
        onClick={() => onDeleteTurn(message)}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  )

  if (isUser) {
    // 用户消息：右对齐气泡，无角色标签 —— 对齐靠位置与底色区分
    return (
      <article className="message message--user" data-message-id={message.id} data-turn-id={message.conversationId}>
        {pick}
        <div className="message__bubble-wrap">
          {actions}
          <div className="message__bubble">
            <UserMessageContent content={message.content} />
          </div>
          {message.attachments && message.attachments.length > 0 ? (
            <div className="message__attachments">
              {message.attachments.map((file) => (
                <AttachmentChip
                  key={file.path}
                  root={workspaceRoot}
                  file={file}
                  sessionId={sessionId}
                  referenceLabel={file.referenceLabel}
                  onPreview={(f, src) =>
                    onPreviewImage(f, src, message.attachments?.filter((a) => a.type.startsWith('image/')) ?? [])
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className="message message--assistant" data-message-id={message.id} data-turn-id={message.conversationId}>
      {pick}

      <SubagentControllerContext.Provider value={subagentControllerScope(message, sessionId, controllerSource)}>
        <MessageTimeline message={message} sessionId={sessionId} streaming={streaming} />
      </SubagentControllerContext.Provider>

      <div className="message__meta">
        {/* 该轮累计用量常显；操作图标随悬停出现，两者同行（用量在左） */}
        <div className="message__footer">
          {usage ? (
            <TurnUsage
              tokens={usage.tokens}
              summary={usage.summary}
              askedAt={usage.askedAt}
              startedAt={usage.startedAt}
              endedAt={usage.endedAt}
              model={usage.model}
              streaming={usage.streaming}
            />
          ) : message.modelId ? <span className="turn-usage__model">{message.modelId}</span> : null}
          {actions}
        </div>

        <MessageRunStatus message={message} />
        {(() => {
          const interactions = message.interactions ?? (message.pending ? [message.pending] : [])
          // 只有仍处于 waiting 的请求才是可操作的待办。已回答项以及终态运行
          // 中遗留的 pending 记录属于审计历史，折叠展示，避免对话区不断堆积
          // 已完成的警示卡片，也避免让用户误以为它们仍在等待选择。
          // 无 durable requestId 的旧交互无法走当前应答协议，不能显示永久禁用
          // 的操作按钮。保留为历史记录，等待新的运行快照提供可应答请求。
          const active = interactions.filter(item => message.status === 'waiting' && item.status === 'pending' &&
            Boolean(item.requestId) && item.runId === message.run?.runId && message.run?.status === 'waiting')
          const history = interactions.filter(item => !active.includes(item))
          return (
            <>
              {history.length > 0 ? <InteractionHistory interactions={history} /> : null}
              {active.map((pending) => (
                <PendingCard
                  key={pending.requestId ?? pending.toolCallId}
                  pending={pending}
                  disabled={disabled || !pending.requestId || message.run?.status !== 'waiting'}
                  onAllowAll={onAllowAll}
                  onRespond={(values) => { if (pending.requestId) onRespond(pending.requestId, values) }}
                />
              ))}
            </>
          )
        })()}
      </div>

      {message.error ? <div className="message__error">{message.error}</div> : null}
    </article>
  )
})

/** 图片与全尺寸卡片保留在时间线中，过程块收起也能看到工具产出的图片。 */
function isFullSizeTool(tool: ToolActivity): boolean {
  return (
    toolPresentation(tool).images.length > 0 ||
    tool.name === 'subagent' ||
    (tool.name === 'execute_cmd' && Boolean(tool.commandJob)) ||
    ((tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'delete_file') &&
      Boolean(tool.change))
  )
}

/** 过程块内的紧凑条目：一段思考 或 一次过程性工具调用 */
type CompactEntry = { kind: 'thinking'; text: string } | { kind: 'tool'; tool: ToolActivity }

/** 内联段落：正文段 / 全尺寸卡片（diff）/ 单个子代理 / 子代理组，在过程块之后按原顺序渲染 */
type InlineSegment =
  | { type: 'process'; entries: CompactEntry[] }
  | { type: 'tool'; tool: ToolActivity }
  | { type: 'content'; text: string }
  | { type: 'subagent-group'; tools: ToolActivity[] }

/** Each message observes its own root run before displaying the active tool. */
function isMessageCompacting(message: ChatMessage): boolean {
  return (message.status === 'streaming' || message.status === 'waiting') && message.run?.compaction?.phase === 'running' && !['failed', 'cancelled', 'interrupted'].includes(message.run.status)
}

function streamStatusText(message: ChatMessage): string {
  if (isMessageCompacting(message)) return '正在自动压缩上下文…'
  // 正在执行的工具优先：用户最关心的是「此刻在干什么」
  const running = [...message.tools].reverse().find((tool) => tool.state === 'running' && isVisibleToolActivity(tool))
  if (running) return `${toolDisplayName(running.name)}…`
  // 已有正文流出说明在生成回复
  if (message.content) return '正在生成回复…'
  return '处理中…'
}

/** 用量下方只保留一个状态位置，运行提示与最终结果在这里切换。 */
function MessageRunStatus({ message }: { message: ChatMessage }): JSX.Element | null {
  const compacting = isMessageCompacting(message)
  const active = (message.status === 'streaming' || compacting) && !message.pending
  if (!active && !message.run) return null
  const text = active ? streamStatusText(message)
    : compacting ? '正在自动压缩上下文…'
    : message.status === 'interrupted' ? '已中断'
    : message.status === 'aborted' ? '已取消'
    : message.status === 'error' ? '失败'
    : message.status === 'done' ? '已完成'
    : rootStatusLabel(message.run!.status)
  return (
    <div
      className={`message__run-status ${active ? 'message__streaming-hint' : 'pending-card__hint'}`}
      role="status"
      aria-live="polite"
      aria-label="运行状态"
    >
      {/* Reserve the same icon column in every state, so completion never shifts the label. */}
      <span className="message__run-status-icon" aria-hidden="true">
        {active ? <Spinner size={10} className="message__spinner" /> : null}
      </span>
      <span className={`message__run-status-text${active ? ' message__streaming-text' : ''}`}>{text}</span>
    </div>
  )
}

/**
 * 消息时间线：只合并连续的思考 / 工具调用，正文与全尺寸卡片保留真实发生位置。
 *
 * useChat 在收 SSE 帧时同步维护 message.items（帧严格按发生顺序到达）。
 * 每段连续的过程性条目可折叠；正文不会因为收拢工具而移到工具之后。
 */
function MessageTimeline({
  message,
  sessionId,
  streaming
}: {
  message: ChatMessage
  sessionId: string
  streaming: boolean
}): JSX.Element | null {
  const fileSessionId = message.run?.sessionId ?? sessionId
  const storedWorkspacePath = useSyncExternalStore(subscribeSessionMeta,
    () => getSessionMeta(fileSessionId).workspacePath)
  const fileWorkspaceRoot = message.run?.workspacePaths?.[0] ?? storedWorkspacePath
  const fileContext = useMemo<ChatFileContext>(() => ({ sessionId: fileSessionId, workspaceRoot: fileWorkspaceRoot }),
    [fileSessionId, fileWorkspaceRoot])
  const { inline } = useMemo(() => {
    const toolById = new Map(
      message.tools
        .filter(isVisibleToolActivity)
        .map((tool) => [tool.id, tool])
    )
    let processEntries: CompactEntry[] = []
    const inline: InlineSegment[] = []
    const flushProcess = (): void => {
      if (processEntries.length) inline.push({ type: 'process', entries: processEntries })
      processEntries = []
    }
    const seen = new Set<string>()

    for (const item of message.items) {
      if (item.kind === 'thinking') {
        processEntries.push({ kind: 'thinking', text: item.text })
      } else if (item.kind === 'tool') {
        const tool = toolById.get(item.id)
        if (!tool || seen.has(tool.id)) continue
        seen.add(tool.id)
        if (isFullSizeTool(tool)) { flushProcess(); inline.push({ type: 'tool', tool }) }
        else processEntries.push({ kind: 'tool', tool })
      } else if (item.kind === 'content') {
        flushProcess()
        inline.push({ type: 'content', text: item.text })
      }
      // interaction：应答卡片由 MessageItem 单独渲染，时间线不占位
    }

    // 兜底：tools 里存在但时间线没记录的条目（异常帧序），挂到过程块末尾
    for (const tool of toolById.values()) {
      if (seen.has(tool.id)) continue
      if (isFullSizeTool(tool)) { flushProcess(); inline.push({ type: 'tool', tool }) }
      else processEntries.push({ kind: 'tool', tool })
    }

    flushProcess()

    // 把连续的子代理段收进一个组（对齐 wuzu 的 AgentSubagentGroup）：
    // 并行派发 N 个子代理会产生 N 张连续大卡片，占满整屏还看不清彼此关系；
    // 收成一组后默认只露「子代理 ×N」一行汇总。单个出现时仍保持原位全显（走 tool 分支）。
    const grouped: InlineSegment[] = []
    let pendingSubagents: ToolActivity[] = []
    const flushSubagents = (): void => {
      if (pendingSubagents.length === 0) return
      if (pendingSubagents.length === 1) grouped.push({ type: 'tool', tool: pendingSubagents[0] })
      else grouped.push({ type: 'subagent-group', tools: [...pendingSubagents] })
      pendingSubagents = []
    }
    for (const segment of inline) {
      if (segment.type === 'tool' && segment.tool.name === 'subagent') {
        pendingSubagents.push(segment.tool)
        continue
      }
      flushSubagents()
      grouped.push(segment)
    }
    flushSubagents()

    return { inline: grouped }
  }, [message.items, message.tools])

  if (inline.length === 0) return null

  // Wuzu Code 只自动展开当前时间线末尾的过程块；较早的过程块保留为摘要，
  // 否则一次包含多轮工具调用的回答会把正文推到很远的位置。
  const lastProcessIndex = inline.reduce(
    (last, item, itemIndex) => (item.type === 'process' ? itemIndex : last),
    -1
  )

  return (
    <>
      {inline.map((segment, index) => {
        return (
          segment.type === 'process' ? (
            <ProcessGroup
              key={`p-${index}`}
              entries={segment.entries}
              streaming={streaming}
              autoOpen={streaming && index === lastProcessIndex}
              collapseKey={`${message.id}:${index}`}
            />
          ) : segment.type === 'tool' ? (
            <div key={`t-${segment.tool.id}`} className="message__tools">
              <ToolItem tool={segment.tool} sessionId={sessionId} />
            </div>
          ) : segment.type === 'subagent-group' ? (
            <div key={`sg-${segment.tools[0].id}`} className="message__tools">
              <SubagentGroup tools={segment.tools} sessionId={sessionId} />
            </div>
          ) : (
            <div key={`c-${index}`} className="message__content">
              <Markdown text={segment.text} streaming={streaming} fileContext={fileContext} />
            </div>
          )
        )
      })}
    </>
  )
}

/**
 * 子代理组（对齐 wuzu 的 AgentSubagentGroup）
 *
 * 并行派发多个子代理时收拢为一组：组头显示调用次数、整体状态与失败提示，
 * 默认收起只露一行汇总，点开后逐张渲染子代理卡片。
 */
function SubagentGroup({
  tools,
  sessionId
}: {
  tools: ToolActivity[]
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyPresence = useMotionPresence(open)
  const [visibleCount, setVisibleCount] = useState(64)
  const window = publishedVisibleWindow(tools, visibleCount)
  const running = tools.some((tool) => tool.state === 'running')
  const failCount = tools.filter((tool) => tool.state === 'error').length
  const unknownCount = tools.filter((tool) => tool.state === 'unknown').length
  const cancelledCount = tools.filter((tool) => tool.state === 'cancelled').length

  return (
    <div className="subagent-group">
      <button
        type="button"
        className="subagent-group__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="subagent-group__name">子代理</span>
        <span className="subagent-group__count">{tools.length} 次调用</span>
        <span className="subagent-group__status">
          {running ? '运行中' : failCount ? '有任务失败' : unknownCount ? '含未知状态' : cancelledCount ? '含已取消任务' : '已完成'}
        </span>
        {failCount > 0 ? (
          <span className="subagent-group__fail">{failCount} 失败</span>
        ) : null}
        <Icon name="chevron" size={16} className="subagent-group__chevron" />
      </button>
      {bodyPresence.present ? (
        <div className="ui-motion-collapse" {...bodyPresence.motionProps}><div className="ui-motion-collapse__content"><div className="subagent-group__body">
          {window.items.map((tool) => (
            <SubagentCard key={tool.id} tool={tool} sessionId={sessionId} visible={open} />
          ))}
          {tools.length > 64 ? <div className="subagent-history__navigation"><span>调用 {window.start + 1}–{window.end} / {tools.length}</span>
            {window.start > 0 ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => Math.max(64, count - 64))}>上一页</button> : null}
            {window.end < tools.length ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => count + 64)}>下一页</button> : null}</div> : null}
        </div></div></div>
      ) : null}
    </div>
  )
}

/**
 * 过程区（思考 + 过程性工具调用）
 *
 * 对齐 wuzu-client 的双层折叠形制：
 * - 单条思考 / 工具调用是一行 24px 紧凑日志行（圆点 + 名称 + 摘要 + hover 才出现的箭头）；
 * - 一轮结束后，整段过程收成一行摘要「过程 · 思考 N 段 · 工具调用 M」，点开原样还原；
 *   流式进行中只展开时间线最后一段，方便实时围观；用户手动点过后以用户为准。
 */
function ProcessGroup({
  entries,
  streaming,
  autoOpen,
  collapseKey
}: {
  entries: CompactEntry[]
  streaming: boolean
  /** 只有当前时间线最后一个过程块才有自动展开资格。 */
  autoOpen: boolean
  /** 折叠记忆的稳定 key（消息 id）；分页回收/切换会话后能恢复用户手动的折叠选择 */
  collapseKey?: string
}): JSX.Element {
  // 折叠状态：默认只展开当前末段 / 历史收起；一旦用户手动点过，以用户选择为准
  const [manual, setManual] = useCollapseMemory(collapseKey ? `process:${collapseKey}` : undefined)
  const expanded = manual ?? autoOpen

  const thinkingCount = entries.filter((entry) => entry.kind === 'thinking').length
  const toolCount = entries.length - thinkingCount
  const summaryParts: string[] = []
  if (thinkingCount > 0) summaryParts.push(`思考 ${thinkingCount} 段`)
  if (toolCount > 0) summaryParts.push(`工具调用 ${toolCount}`)
  const failCount = entries.filter(
    (entry) => entry.kind === 'tool' && entry.tool.state === 'error'
  ).length
  if (failCount > 0) summaryParts.push(`${failCount} 失败`)
  const lastThinkingIndex = entries.reduce(
    (last, entry, index) => (entry.kind === 'thinking' ? index : last),
    -1
  )

  return (
    <div className="process">
      <button
        type="button"
        className="process__summary"
        aria-expanded={expanded}
        onClick={() => setManual(!expanded)}
      >
        <span className="process__summary-dot" />
        <span className="process__summary-text">
          {streaming ? '过程中' : '过程'} · {summaryParts.join(' · ')}
        </span>
        <Icon name="chevron" size={16} className="process__chevron" />
      </button>
      <MotionPresence show={expanded}>
        <div className="process__body">
          {entries.map((entry, index) =>
            entry.kind === 'thinking' ? (
              <ThinkingRow
                key={`think-${index}`}
                text={entry.text}
                autoOpen={autoOpen && index === lastThinkingIndex}
                memoryKey={collapseKey ? `think:${collapseKey}:${index}` : undefined}
              />
            ) : (
              <CompactToolRow key={entry.tool.id} tool={entry.tool} />
            )
          )}
        </div>
      </MotionPresence>
    </div>
  )
}

/**
 * 等待应答卡片
 *
 * 引擎发出提问/授权帧后会挂起当前流等待应答 —— 用户看到的就是"卡住了"。
 * 这张卡片是唯一的出口，因此要显眼并把原因说清楚（尤其是安全拦截，
 * 用户需要知道被拦的是哪条命令才能判断该不该放行）。
 */
function PendingCard({
  pending,
  disabled,
  onAllowAll,
  onRespond
}: {
  pending: PendingInteraction
  disabled: boolean
  onAllowAll: () => Promise<void>
  onRespond: (values: string[]) => void
}): JSX.Element {
  const sourceEpoch = getEngineSource()
  const [groupSelected, setGroupSelected] = useState<Record<number, string[]>>({})
  const [groupInput, setGroupInput] = useState<Record<number, string>>({})
  const [allowAllBusy, setAllowAllBusy] = useState(false)
  const [allowAllError, setAllowAllError] = useState<string | null>(null)
  const currentRequestRef = useRef(true)
  useEffect(() => {
    currentRequestRef.current = true
    return () => { currentRequestRef.current = false }
  }, [pending.requestId, pending.runId, sourceEpoch])
  const isPermission = pending.kind === 'permission'

  const toggle = (groupIndex: number, value: string, multi: boolean): void => {
    setGroupSelected((prev) => {
      const current = prev[groupIndex] ?? []
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : multi
          ? [...current, value]
          : [value]
      return { ...prev, [groupIndex]: next }
    })
  }

  /**
   * 一键放行：先切会话模式，再放行当前这一步。
   *
   * 切模式失败时**仍然放行**——用户点这个按钮的意图是「继续做下去」，
   * 而单次放行本身足以解开眼前这次拦截（引擎会把该命令写入会话白名单）。
   * 失败只提示，不阻断。
   */
  const allowAll = async (): Promise<void> => {
    if (disabled || allowAllBusy || sourceEpoch !== getEngineSource()) return
    setAllowAllBusy(true)
    setAllowAllError(null)
    try {
      await onAllowAll()
    } catch (err) {
      if (currentRequestRef.current) setAllowAllError(err instanceof Error ? err.message : String(err))
    } finally {
      if (currentRequestRef.current) setAllowAllBusy(false)
    }
    if (currentRequestRef.current && sourceEpoch === getEngineSource()) onRespond(['approved'])
  }

  return (
    <div className={`pending-card${isPermission ? ' pending-card--permission' : ''}`}>
      <div className="pending-card__title">
        <span>{isPermission ? '允许这次操作？' : '需要你确认'}</span>
        <span className="pending-card__state">等待你的选择</span>
      </div>

      {isPermission ? (
        <>
          <div className="pending-card__question">{pending.question}</div>
          <div className="pending-card__options">
            {pending.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn--sm${option.value === 'approved' ? ' btn--primary' : ''}`}
                disabled={disabled}
                title={option.description}
                onClick={() => onRespond([option.value])}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        // 提问：对齐 wuzu AskUserQuestion —— 每个问题一组：tab 胶囊 + 标题 +
        // 选项卡（标题 + 描述 + 勾选框）+ 自由输入框，底部「跳过 / 提交」
        <>
          {pending.groups.map((group, groupIndex) => (
            <div key={groupIndex} className="pending-card__group">
              <div className="pending-card__group-head">
                {group.tab ? <span className="pending-card__tab">{group.tab}</span> : null}
                <span className="pending-card__group-question">{group.question}</span>
              </div>
              {group.options.length > 0 ? (
                <div className="pending-card__choices">
                  {group.options.map((option) => {
                    const checked = (groupSelected[groupIndex] ?? []).includes(option.value)
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`pending-card__choice${checked ? ' pending-card__choice--on' : ''}`}
                        aria-pressed={checked}
                        disabled={disabled}
                        onClick={() => toggle(groupIndex, option.value, group.multiSelect)}
                      >
                        <span className="pending-card__choice-body">
                          <span className="pending-card__choice-label">{option.label}</span>
                          {option.description ? (
                            <span className="pending-card__choice-desc">{option.description}</span>
                          ) : null}
                        </span>
                        <span
                          className={`pending-card__choice-box${group.multiSelect ? '' : ' pending-card__choice-box--radio'}`}
                        >
                          {checked ? <Icon name="check" size={16} /> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {group.allowInput ? (
                <input
                  type="text"
                  className="pending-card__input ui-input"
                  aria-label={group.question}
                  placeholder="或直接输入回复…"
                  disabled={disabled}
                  value={groupInput[groupIndex] ?? ''}
                  onChange={(event) =>
                    setGroupInput((prev) => ({ ...prev, [groupIndex]: event.target.value }))
                  }
                />
              ) : null}
            </div>
          ))}
          <div className="pending-card__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled}
              onClick={() => onRespond(['跳过'])}
            >
              跳过
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={disabled}
              onClick={() => {
                const values: string[] = []
                pending.groups.forEach((group, groupIndex) => {
                  const picked = groupSelected[groupIndex] ?? []
                  const freeText = (groupInput[groupIndex] ?? '').trim()
                  if (group.multiSelect) {
                    values.push(...picked)
                  } else if (picked.length > 0) {
                    values.push(picked[0])
                  }
                  if (freeText) values.push(freeText)
                })
                onRespond(values.length > 0 ? values : ['跳过'])
              }}
            >
              提交
            </button>
          </div>
        </>
      )}

      {isPermission ? (
        <div className="pending-card__footer">
          <button
            type="button"
            className="btn btn--sm btn--danger-ghost"
            disabled={disabled || allowAllBusy}
            title="本会话内所有命令不再询问，并放行当前这一步（注意：同时会解除 Agent 的工作区路径限制）"
            onClick={() => void allowAll()}
          >
            <Icon name="shield" size={16} />
            {allowAllBusy ? '切换中…' : '本会话改为完全访问并放行'}
          </button>
          {allowAllError ? (
            <span className="pending-card__hint pending-card__hint--error">
              未切换会话模式：{allowAllError}
            </span>
          ) : (
            <span className="pending-card__hint">连续被拦时用它一次放开</span>
          )}
        </div>
      ) : null}

      {disabled ? <div className="pending-card__hint">等待上一轮响应结束后可继续操作</div> : null}
    </div>
  )
}

/**
 * 已处理的交互记录只保留一条可展开的时间线摘要。
 * RootRun 会永久保留 answered 记录以保证幂等应答和审计，因此不能在 UI
 * 层把每一条记录都当成新的待办卡片渲染。
 */
function InteractionHistory({ interactions }: { interactions: PendingInteraction[] }): JSX.Element {
  const permissionCount = interactions.filter(item => item.kind === 'permission').length
  const summary = '确认记录'

  const choiceText = (pending: PendingInteraction): string => {
    if (!pending.output) return pending.status === 'answered' ? '已提交' : pending.requestId && pending.runId ? '未执行' : '请重新发起任务'
    // Free-text answers can contain commas; preserve the submitted text exactly.
    return pending.output
  }

  const historyQuestion = (pending: PendingInteraction): string => {
    const question = pending.kind === 'ask' && pending.groups.length > 1
      ? pending.groups.map((group, index) => `${index + 1}. ${group.question}`).join('\n')
      : pending.question
    if (pending.kind === 'permission' && pending.status === 'answered') {
      const reason = question.replace(/^安全策略拦截了此操作，是否允许执行？/, '安全策略原因：')
      return `当时请求确认（已处理）：\n${reason}`
    }
    return question
  }

  const statusText = (pending: PendingInteraction): string => {
    if (pending.status === 'answered') {
      if (pending.kind === 'permission') {
        if (pending.output === 'approved') return '已允许这次操作'
        if (pending.output === 'rejected') return '已拒绝这次操作'
        return '已处理，未记录授权结果'
      }
      return '已应答 Agent 提问'
    }
    if (!pending.requestId || !pending.runId) return '历史请求，当前不可应答'
    return '已结束，未执行'
  }

  return (
    <details className="interaction-history pending-card--history">
      <summary className="pending-card__summary">
        <Icon name="chevron" size={14} className="interaction-history__chevron" />
        <Icon name={permissionCount === interactions.length ? 'shield' : 'chat'} size={16} />
        <span className="pending-card__summary-text">{summary}</span>
        <span className="pending-card__summary-choice">{interactions.length} 项</span>
      </summary>
      <div className="pending-card__history-list">
        {interactions.map((pending, index) => (
          <div
            className="pending-card__history-item"
            key={pending.requestId ?? pending.toolCallId ?? index}
            // Older persisted runs may predate requestId; toolCallId is still
            // stable and keeps each audit entry addressable after recovery.
            data-request-id={pending.requestId ?? pending.toolCallId}
          >
            <div className="pending-card__history-row interaction-history__result">
              <Icon name={pending.kind === 'permission' ? 'shield' : 'chat'} size={14} />
              <span>{statusText(pending)}</span>
              {pending.kind === 'ask' ? (
                <span className="pending-card__summary-choice">{choiceText(pending)}</span>
              ) : null}
            </div>
            <div className="pending-card__history-question">{historyQuestion(pending)}</div>
          </div>
        ))}
      </div>
    </details>
  )
}

function ToolItem({
  tool,
  sessionId
}: {
  tool: ToolActivity
  sessionId: string
}): JSX.Element {
  // 子代理： Trae 风格执行详情卡片（目标任务 / 执行详情 / 返回结果 / 底栏统计）
  if (tool.name === 'subagent') return <SubagentCard tool={tool} sessionId={sessionId} />
  if (tool.name === 'execute_cmd' && tool.commandJob) return <CommandJobCard job={tool.commandJob} sessionId={sessionId} />

  // 文件写入/删除：git diff 风格卡片（引擎下发了内容快照时）
  if (
    (tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'delete_file') &&
    tool.change
  ) {
    return <FileChangeCard change={tool.change} state={tool.state} />
  }

  // 其余过程性工具由 ProcessSection 里的紧凑日志行承接，走到这里说明是兜底
  return <CompactToolRow tool={tool} />
}
