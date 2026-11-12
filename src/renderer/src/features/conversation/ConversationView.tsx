import { type MouseEvent, type MutableRefObject, type JSX, useRef, useState, useCallback, useMemo, useEffect, useLayoutEffect, memo } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { EngineFileChange } from '@shared/ipc'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { useApp } from '@renderer/core/app-context'
import { toast } from '@renderer/core/toast'
import { getEngineSource, isEngineReady, getEngineStorageKey } from '@renderer/core/engine/source'
import { changeSecurityMode } from '@renderer/core/engine/security-store'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { classifyChatLink } from './shared/chat-link'
import type { ChatFileContext } from './shared/chat-link'
import { Composer as ComposerV2 } from '../composer/Composer'
import { NextTurnQueuePanel } from './NextTurnQueue'
import { SelectionCheckbox } from '../../ui/SelectionCheckbox'
import { getTopOverlayId } from '@renderer/ui/overlay'
import { markSessionTaskCompletionRead } from '../sessions/state'
import { PublishedRecoveryNotice } from './shared/PublishedRecoveryNotice'
import { SessionConnectionNotice } from './shared/SessionConnectionNotice'
import { MessageNav } from './MessageNav'
import { sessionConversationGroups, sessionConversationComplete, sessionConversationEntries } from './conversation-turns'
import { useSessionConversationDate, formatSessionConversationTime, sessionConversationStartedAt } from './conversation-time'
import { sessionGroupedDisplayTurns } from './message-nav'
import { FinalDeliverables } from '../artifacts/FinalDeliverables'
import { RevertNotice } from '../artifacts/RevertNotice'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { getMessageFinalResult } from '@renderer/core/engine/final-result'
import { TurnUsage } from './shared/ConversationUsage'
import { summarizeTurnUsage } from './shared/turn-usage'
import { TodoProgress, ProgressPanel, SessionProgressSync } from './ProgressPanel'
import { useSessionProgressChanges } from './useSessionProgressChanges'
import { sessionTurnProgressChanges, sessionProgressTurnScope } from './turn-progress'
import { MotionPresence } from '@renderer/ui/MotionPresence'
import { PermissionCard } from '../interactions/PermissionCard'
import { QuestionCard } from '../interactions/QuestionCard'
import { sessionMessageRunning } from './tool-presentation'
import { buildSessionInlineFileResolver } from './inline-file-references'
import { MessageContent } from './MessageContent'
import { serializeMessages, buildMessageExportDocument } from './shared/message-export'
import { sessionMessageRange, SESSION_MESSAGE_PAGE_SIZE } from '../sessions/view-performance'
import { sessionConversationAwayFromBottom } from './conversation-scroll'
import { useSessionConversationScrollIntent } from './useSessionConversationScrollIntent'
import { ErrorNotice } from './ErrorNotice'
import { recoverSessionTurn } from './turn-recovery'
import { sessionTaskRestart, type SessionTaskRestartPresentation } from '../sessions/task-restart'
import { SessionRegenerateReplyButton, UserMessageActions } from '../sessions/UserMessageActions'
import { getSessionState } from '../sessions/state'
import { findSessionArtifact } from '../artifacts/artifact-utils'
import { ServiceTray } from '@renderer/features/services/ServiceTray'
import { type SessionController, type ActivitySelection, type ArtifactNavigation, EmptyState } from '../sessions/session-presentation'
import { SessionTurnFeedback, SessionRunStatus } from './SessionFeedback'

const conversationPositions = new Map<string, { top: number; follow: boolean; firstId?: string | null; expanded?: boolean }>()

const pendingDrafts = new Map<string, { values: string[][]; freeText: string[] }>()

const MAX_SESSION_VIEW_CACHE = 256

function rememberConversationPosition(id: string, value: { top: number; follow: boolean; firstId?: string | null; expanded?: boolean }): void {
  conversationPositions.delete(id)
  conversationPositions.set(id, value)
  while (conversationPositions.size > MAX_SESSION_VIEW_CACHE) {
    const oldest = conversationPositions.keys().next().value
    if (typeof oldest !== 'string') break
    conversationPositions.delete(oldest)
  }
}

function rememberPendingDraft(id: string, value: { values: string[][]; freeText: string[] }): void {
  pendingDrafts.delete(id)
  pendingDrafts.set(id, value)
  while (pendingDrafts.size > MAX_SESSION_VIEW_CACHE) {
    const oldest = pendingDrafts.keys().next().value
    if (typeof oldest !== 'string') break
    pendingDrafts.delete(oldest)
  }
}

/** File links belong to this task; do not let the shared Markdown viewer route them through Code's selected workspace. */
function openSessionFileLink(
  event: MouseEvent<HTMLElement>,
  controller: SessionController,
  engineUrl: string,
  openArtifact: (id: string) => void
): void {
  const link = event.target instanceof Element ? event.target.closest('a') : null
  const href = link?.getAttribute('href')
  if (!href || !controller.activeTask) return
  // Resolved receipt paths are literal filenames, including # names and files
  // without extensions; URL classification must not reroute those references.
  const fileReference = link?.getAttribute('data-work-file-path')
  const target = fileReference ? { kind: 'file' as const, path: fileReference }
    : classifyChatLink(href, controller.activeTask.id, engineUrl)
  if (target.kind === 'external') return
  event.preventDefault()
  event.stopPropagation()
  if (target.kind === 'invalid') {
    toast.error(target.message)
    return
  }
  const path = fileReference ? target.path.replace(/\\/g, '/')
    : target.path.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '')
  const artifact = findSessionArtifact(controller.artifacts, path, controller.activeTask.workspacePath)
  // A markdown link may point to a workspace file that has no write receipt.
  // Keep it in the Work surface as a synthetic artifact so the panel performs
  // the session-scoped read instead of silently routing through Code.
  openArtifact(artifact?.id ?? `path:${path}`)
}

function sessionConversationSummary(messages: ChatMessage[]): string {
  const user = messages.find((message) => message.role === 'user')
  const value = user?.content.replace(/\s+/g, ' ').trim()
  if (!value) return '未命名对话'
  return value.length > 72 ? `${value.slice(0, 72)}…` : value
}

export function Conversation({
  controller,
  active,
  openArtifact,
  openActivity,
  activitySelection,
  onActivityRevealed,
  openChange,
  onOpenArtifacts,
  onOpenFinalItem,
  onOpenTerminal,
  selectionToggleRef,
  onSelectionModeChange
}: {
  controller: SessionController
  active: boolean
  openArtifact: (id: string) => void
  openActivity: (toolId: string) => void
  activitySelection: ActivitySelection | null
  onActivityRevealed: (request: ActivitySelection) => void
  openChange: (change: EngineFileChange) => void
  onOpenArtifacts: (request: ArtifactNavigation) => void
  onOpenFinalItem: (result: FinalResult, item: FinalResultItem) => void
  onOpenTerminal: (jobId?: string) => void
  selectionToggleRef: MutableRefObject<(() => void) | null>
  onSelectionModeChange: (active: boolean) => void
}): JSX.Element {
  const { engine } = useApp()
  const task = controller.activeTask!
  const taskRunning = controller.streaming || controller.launching || ['running', 'waiting'].includes(task.status)
  const positionKey = `${getEngineSource()}:${task.id}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(conversationPositions.get(positionKey)?.follow ?? true)
  const [following, setFollowing] = useState(followRef.current)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [inlineFeedbackVisible, setInlineFeedbackVisible] = useState(true)
  const latestRequest = useRef(false)
  const [latestPending, setLatestPending] = useState(false)
  const hasNewerContentRef = useRef(false)
  const [bottomRequest, setBottomRequest] = useState(0)
  const measureScrollPosition = useCallback((): boolean | null => {
    const element = scrollRef.current
    const away = element ? sessionConversationAwayFromBottom(element) : null
    if (away !== null) setAwayFromBottom(away)
    return away
  }, [])
  const pauseFollowing = useCallback((): void => {
    latestRequest.current = false
    setLatestPending(false)
    followRef.current = false
    setFollowing(false)
  }, [])
  const resumeFollowing = useCallback((): void => {
    // The bottom of a loaded archive page is not necessarily the latest turn.
    if (hasNewerContentRef.current) return
    followRef.current = true
    setFollowing(true)
  }, [])
  const scrollIntent = useSessionConversationScrollIntent(scrollRef, pauseFollowing, resumeFollowing, measureScrollPosition)
  const pauseReading = useCallback((): void => {
    scrollIntent.reset()
    pauseFollowing()
  }, [scrollIntent.reset, pauseFollowing])
  const followBottom = useCallback((): void => {
    const element = scrollRef.current
    if (!element || !active || !followRef.current || !element.clientHeight) return
    element.scrollTop = element.scrollHeight
    const away = measureScrollPosition()
    if (latestRequest.current && !hasNewerContentRef.current && away === false) {
      latestRequest.current = false
      setLatestPending(false)
    }
  }, [active, measureScrollPosition])
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const previousFileResolver = useRef<ChatFileContext['resolveInlineFile']>(undefined)
  const resolveInlineFile = useMemo(() => {
    const resolver = buildSessionInlineFileResolver(controller.messages, task.id, task.workspacePath, previousFileResolver.current)
    previousFileResolver.current = resolver
    return resolver
  }, [controller.messages, task.id, task.workspacePath])
  const fileContext = useMemo<ChatFileContext>(() => ({ sessionId: task.id, workspaceRoot: task.workspacePath, resolveInlineFile }), [task.id, task.workspacePath, resolveInlineFile])
  const onFileLink = useCallback((event: MouseEvent<HTMLElement>): void => openSessionFileLink(event, controllerRef.current, engine.snapshot.baseUrl, openArtifact), [engine.snapshot.baseUrl, openArtifact])
  const openActivityFile = useCallback((path: string): void => {
    openArtifact(`path:${path}`)
  }, [openArtifact])
  const respond = useCallback<SessionController['respond']>((...args) => controllerRef.current.respond(...args), [])
  const restartFailedTask = useCallback<SessionController['restartFailedTask']>((...args) => controllerRef.current.restartFailedTask(...args), [])
  const editSettledTurn = useCallback<SessionController['editSettledTurn']>((...args) => controllerRef.current.editSettledTurn(...args), [])
  const userMessageAction = useCallback<SessionController['userMessageAction']>((...args) => controllerRef.current.userMessageAction(...args), [])
  const recoverableMessageId = useMemo(() => {
    if (controller.streaming || controller.launching || controller.messageActionBusy || controller.pending.length || ['running', 'waiting'].includes(task.status)) return null
    const last = controller.messages.at(-1)
    return last && recoverSessionTurn(controller.messages, last.id) ? last.id : null
  }, [controller.messages, controller.streaming, controller.launching, controller.messageActionBusy, controller.pending.length, task.status])
  const restartPresentations = useMemo(() => {
    const queue = controller.nextTurnQueue
    const read = queue.state ? { state: queue.state, dispatchError: queue.error || controller.historyError || undefined } : null
    return new Map(controller.messages.filter(message => message.run && message.error).map(message =>
      [message.id, sessionTaskRestart(task.id, message.run!.runId, read, controller.messages)]))
  }, [controller.messages, controller.nextTurnQueue.state, controller.nextTurnQueue.error, controller.historyError, task.id])
  const restartableMessageId = !controller.streaming && !controller.launching && !controller.pending.length
    ? controller.messages.findLast(message => message.role === 'assistant')?.id : undefined
  const [firstId, setFirstId] = useState<string | null>(() => conversationPositions.get(positionKey)?.firstId ?? null)
  const lastMountedStart = useRef<number | undefined>(undefined)
  // Keep selection local to a task. Work selects complete conversation turns
  // (the user request together with the Agent response), so exporting one
  // item never produces a contextless half of a turn.
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<{ all: boolean; ids: ReadonlySet<string> }>({ all: false, ids: new Set() })
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const expandedHistory = useRef(conversationPositions.get(positionKey)?.expanded ?? false)
  const [historyBrowsing, setHistoryBrowsing] = useState(expandedHistory.current)
  const setExpandedHistory = useCallback((value: boolean): void => {
    expandedHistory.current = value
    setHistoryBrowsing(value)
  }, [])
  const { start, end, newer } = useMemo(() => sessionMessageRange(controller.messages, following ? null : firstId, following ? undefined : lastMountedStart.current), [controller.messages, firstId, following])
  lastMountedStart.current = start
  const hasNewerContent = newer > 0 || Boolean(controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages)
  hasNewerContentRef.current = hasNewerContent
  const showLatest = latestPending || hasNewerContent || awayFromBottom
  useEffect(() => {
    // Reading old turns (or retaining this component in Code mode) is not
    // seeing the new result. Reuse the conversation's existing scroll state.
    if (!task.completionUnread || task.status !== 'done' || !active || !following ||
      hasNewerContent || awayFromBottom || !controller.historyReady || controller.historyError ||
      controller.displayHistoryLoading || controller.displayHistoryError ||
      task.activity && (controller.currentRun?.runId !== task.activity.runId || controller.currentRun.status !== 'succeeded')) return
    const acknowledge = (): void => {
      const element = scrollRef.current
      if (element && sessionConversationAwayFromBottom(element) === false && !document.hidden && document.hasFocus() && !getTopOverlayId())
        markSessionTaskCompletionRead(controller.draftSource, task.id)
    }
    acknowledge()
    window.addEventListener('focus', acknowledge)
    document.addEventListener('visibilitychange', acknowledge)
    return () => {
      window.removeEventListener('focus', acknowledge)
      document.removeEventListener('visibilitychange', acknowledge)
    }
  }, [task.id, task.completionUnread, task.status, task.activity, active, following, hasNewerContent, awayFromBottom,
    controller.historyReady, controller.historyError, controller.displayHistoryLoading, controller.displayHistoryError,
    controller.currentRun?.runId, controller.currentRun?.status, controller.draftSource])
  const showPinnedFeedback = showLatest && !inlineFeedbackVisible
  const conversationDate = useSessionConversationDate(active)
  const conversationGroups = useMemo(() => sessionConversationGroups(controller.messages), [controller.messages])
  const turnTodos = useMemo(() => controller.assignTodos(conversationGroups.map(group => ({
    id: group.id, identity: group.identity,
    owners: group.messages.flatMap(message => [message.conversationId ? `conversation:${message.conversationId}` : '', message.runId ? `run:${message.runId}` : '']).filter(Boolean)
  }))), [controller.assignTodos, conversationGroups, controller.todos])
  // Published deliveries list selected assets; every turn still needs its full
  // file-change ledger for the result summary and review after completion.
  const receiptGroups = useMemo(() => conversationGroups.filter(group =>
    group.messages.some(message => message.role === 'assistant')
  ), [conversationGroups])
  const receiptTools = useMemo(() => receiptGroups.flatMap(group => group.messages.flatMap(message => message.tools)), [receiptGroups])
  const progress = useSessionProgressChanges(task.id, receiptTools, task.workspacePath, active && receiptGroups.length > 0, receiptGroups)
  const turnChanges = useMemo(() => sessionTurnProgressChanges(task.id, conversationGroups, progress.changes, task.workspacePath),
    [task.id, conversationGroups, progress.changes, task.workspacePath])
  const displayTurns = useMemo(() => sessionGroupedDisplayTurns(conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds), [conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds])
  const historyGaps = useMemo(() => {
    const index = displayTurns
    const result = new Map<string, { count: number; anchor: string }>()
    if (!index) return result
    const positions = new Map(index.map((turn, position) => [turn.userMessageId, position]))
    let previous = -1
    for (const group of conversationGroups) {
      const user = group.messages.find(message => message.role === 'user')
      const position = user ? positions.get(user.id) : undefined
      if (position === undefined) continue
      if (position > previous + 1) result.set(group.id, {
        count: position - previous - 1,
        anchor: index[previous < 0 ? Math.max(0, position - 2) : previous + 1].userMessageId
      })
      previous = position
    }
    return result
  }, [displayTurns, conversationGroups])
  // A short gap is an implementation detail of the display-history index:
  // loading the latest two complete turns avoids a large first response, but
  // leaving a one-turn button in the transcript makes a normal conversation
  // look incomplete. Fill a few small gaps in the background and retain the
  // explicit affordance only for genuinely large history jumps.
  const autoDisplayAnchorsRef = useRef(new Set<string>())
  const autoDisplayLoadsRef = useRef(0)
  useEffect(() => {
    autoDisplayAnchorsRef.current.clear()
    autoDisplayLoadsRef.current = 0
  }, [positionKey])
  const selectableGroups = useMemo(() => conversationGroups.filter(group => sessionConversationComplete(group, controller.displayTurns, controller.displayLoadedTurnIds)),
    [conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds])
  // Keep the user's all/except choice as older turns finish loading, without
  // reselecting a turn they explicitly unchecked or eagerly mounting history.
  const selectedIds = useMemo(() => new Set(selectMode ? selectableGroups.filter(group =>
    selection.all ? !selection.ids.has(group.id) : selection.ids.has(group.id)).map(group => group.id) : []),
  [selectMode, selectableGroups, selection])
  const turnUsage = useMemo(() => new Map(conversationGroups.map(group => [group.id, summarizeTurnUsage(group.messages)])), [conversationGroups])
  const visibleConversationGroups = useMemo(
    () => conversationGroups.filter((group) => group.endIndex > start && group.startIndex < end),
    [conversationGroups, end, start]
  )
  useLayoutEffect(() => {
    if (!activitySelection) return
    const index = controller.messages.findIndex(message => message.tools?.some(tool => tool.id === activitySelection.toolId))
    if (index < 0) return
    pauseReading()
    setExpandedHistory(true)
    setFirstId(controller.messages[Math.min(index, Math.max(0, controller.messages.length - SESSION_MESSAGE_PAGE_SIZE))].id)
  }, [activitySelection])
  useEffect(() => {
    const container = scrollRef.current
    if (!activitySelection || !container || !active) return
    // A mounted row can still move while its disclosure grows. Reveal after
    // the actual ancestor transitions settle, without guessing a timer or
    // following later stream updates once the user has reached the receipt.
    let disposed = false, settling = false
    const inspectedViewports = new WeakSet<HTMLElement>()
    const reveal = (): boolean => {
      const node = Array.from(container.querySelectorAll<HTMLElement>('[data-work-tool-id]'))
        .find(element => element.dataset.sessionToolId === activitySelection.toolId)
      if (!node || !node.getClientRects().length) return false
      const animations: Animation[] = []
      for (let parent: HTMLElement | null = node; parent && parent !== container; parent = parent.parentElement) {
        if (parent.dataset.motionState === 'entering' || parent.dataset.motionState === 'closing') return false
        animations.push(...parent.getAnimations().filter(animation => animation.playState === 'running' || animation.pending))
      }
      if (animations.length) {
        if (!settling) {
          settling = true
          void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
            settling = false
            if (!disposed && reveal()) observer.disconnect()
          })
        }
        return false
      }
      const processViewport = node.closest<HTMLElement>('.work-message__process-viewport')
      if (processViewport && container.contains(processViewport)) {
        if (!inspectedViewports.has(processViewport)) {
          // An explicit jump is reading intent, even though no wheel or pointer
          // event reaches the inner process panel to stop its live following.
          processViewport.dispatchEvent(new Event('work-process-inspect'))
          inspectedViewports.add(processViewport)
        }
        const viewportBounds = processViewport.getBoundingClientRect()
        const viewportTop = viewportBounds.top + processViewport.clientTop
        processViewport.scrollTop += node.getBoundingClientRect().top - viewportTop - 12
        const targetBounds = node.getBoundingClientRect()
        const viewportBottom = viewportTop + processViewport.clientHeight
        // A long output can exceed the panel. Its receipt's leading row, rather
        // than the entire expanded result, must be visible before acknowledging.
        const leadingHeight = Math.min(targetBounds.height, 28)
        if (leadingHeight <= 0 || targetBounds.top < viewportTop - 1 ||
          targetBounds.top + leadingHeight > viewportBottom + 1) return false
      }
      container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - 20
      node.tabIndex = -1
      node.focus({ preventScroll: true })
      onActivityRevealed(activitySelection)
      return true
    }
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
    if (!reveal()) observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-motion-state'] })
    return () => { disposed = true; observer.disconnect() }
  }, [activitySelection, firstId, active, onActivityRevealed])
  const firstIdRef = useRef(firstId)
  firstIdRef.current = controller.messages[start]?.id ?? firstId
  const prependAnchor = useRef<{ id: string; offset: number } | null>(null)
  const archiveNavigation = useRef<'older' | 'newer' | 'latest' | null>(null)
  const pendingDisplayTurn = useRef<string | null>(null)
  const lastDisplayRequest = useRef<string | undefined>(undefined)
  const [displayRequest, setDisplayRequest] = useState(0)
  const restoredPosition = useRef(false)
  useLayoutEffect(() => {
    if (!firstId && controller.messages.length) setFirstId(controller.messages[start].id)
    // The tail stays bounded, but a manual upward scroll freezes this prefix.
    // Replacing an optimistic message ID must not itself move the reader.
    const selection = window.getSelection()
    const copying = selection && !selection.isCollapsed && selection.anchorNode && scrollRef.current?.contains(selection.anchorNode)
    if (!expandedHistory.current && followRef.current && !copying && controller.messages.length > SESSION_MESSAGE_PAGE_SIZE) {
      const next = controller.messages[controller.messages.length - SESSION_MESSAGE_PAGE_SIZE].id
      if (next !== firstId) setFirstId(next)
    }
  }, [controller.messages, firstId, start, following])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || controller.loading || restoredPosition.current) return
    restoredPosition.current = true
    const stored = conversationPositions.get(positionKey)
    followRef.current = stored?.follow ?? true
    setFollowing(followRef.current)
    element.scrollTop = stored?.top ?? element.scrollHeight
  }, [positionKey, controller.loading, controller.messages.length])
  useLayoutEffect(() => () => {
    const element = scrollRef.current
    if (element) rememberConversationPosition(positionKey, { top: element.scrollTop, follow: followRef.current, firstId: firstIdRef.current, expanded: expandedHistory.current })
  }, [positionKey])
  useLayoutEffect(() => {
    const anchor = prependAnchor.current, element = scrollRef.current
    if (!anchor || !element) return
    const message = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (message) element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
    prependAnchor.current = null
  }, [firstId])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !active) return
    followBottom()
    measureScrollPosition()
  }, [controller.messages, controller.todos, controller.loading, controller.streaming, controller.launching, firstId, historyBrowsing, bottomRequest, active, followBottom, measureScrollPosition])
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !active) return
    let frame: number | null = null
    const update = (): void => {
      frame = null
      followBottom()
      measureScrollPosition()
    }
    // Disclosure animations and window resizes can change overflow without a
    // scroll event. Coalesce their measurements without resuming paused reading.
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = window.requestAnimationFrame(update)
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [active, measureScrollPosition, followBottom])
  const latest = (): void => {
    scrollIntent.reset()
    pendingDisplayTurn.current = null
    prependAnchor.current = null
    latestRequest.current = true
    setLatestPending(true)
    followRef.current = true
    setFollowing(true)
    // Start the actual navigation now; the following layout pass and resize
    // observer finish it if archive/window/Markdown changes grow the content.
    followBottom()
    if (controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages) {
      archiveNavigation.current = 'latest'
      void controller.loadArchive('latest')
      return
    }
    setExpandedHistory(false)
    followRef.current = true
    setFollowing(true)
    setFirstId(controller.messages[Math.max(0, controller.messages.length - SESSION_MESSAGE_PAGE_SIZE)]?.id ?? null)
    setBottomRequest(value => value + 1)
  }
  const loadEarlier = (): void => {
    setExpandedHistory(true)
    const element = scrollRef.current
    const anchor = controller.messages[start]
    const article = anchor && element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (element && article) prependAnchor.current = { id: anchor.id, offset: article.getBoundingClientRect().top - element.getBoundingClientRect().top }
    pauseReading()
    setFirstId(controller.messages[Math.max(0, start - SESSION_MESSAGE_PAGE_SIZE)].id)
  }
  const loadNewer = (): void => {
    const nextStart = Math.min(Math.max(0, controller.messages.length - SESSION_MESSAGE_PAGE_SIZE), start + SESSION_MESSAGE_PAGE_SIZE)
    const anchor = controller.messages[nextStart]
    const element = scrollRef.current
    const article = anchor && element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (element && article) prependAnchor.current = { id: anchor.id, offset: article.getBoundingClientRect().top - element.getBoundingClientRect().top }
    setExpandedHistory(true)
    pauseReading()
    setFirstId(anchor?.id ?? null)
  }
  const loadArchivePage = (action: 'older' | 'newer'): void => {
    if (controller.archiveLoading) return
    archiveNavigation.current = action
    setExpandedHistory(true)
    pauseReading()
    void controller.loadArchive(action)
  }
  const loadDisplayHistory = (userMessageId?: string): void => {
    if (controller.displayHistoryLoading) return
    setExpandedHistory(true)
    pauseReading()
    pendingDisplayTurn.current = userMessageId ?? null
    lastDisplayRequest.current = userMessageId
    void controller.loadDisplayTurn(userMessageId).then(ok => {
      if (ok) setDisplayRequest(value => value + 1)
    })
  }
  useEffect(() => {
    if (!active || !following || !controller.displayTurns || controller.displayHistoryLoading ||
      controller.displayHistoryError || autoDisplayLoadsRef.current >= 3) return
    const candidate = [...historyGaps.values()].find(gap => gap.count > 0 && gap.count <= 2)
    if (!candidate || autoDisplayAnchorsRef.current.has(candidate.anchor)) return
    autoDisplayAnchorsRef.current.add(candidate.anchor)
    autoDisplayLoadsRef.current += 1
    lastDisplayRequest.current = candidate.anchor
    void controller.loadDisplayTurn(candidate.anchor).then(ok => {
      if (!ok) autoDisplayAnchorsRef.current.delete(candidate.anchor)
    })
  }, [active, following, historyGaps, controller.displayTurns, controller.displayHistoryLoading, controller.displayHistoryError, controller.loadDisplayTurn])
  useLayoutEffect(() => {
    const id = pendingDisplayTurn.current
    if (!id || !controller.displayLoadedTurnIds.includes(id)) return
    const group = conversationGroups.find(group => group.messages.some(message => message.id === id))
    if (!group) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (node && scrollRef.current) {
      scrollRef.current.scrollTop += node.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - 8
      pendingDisplayTurn.current = null
    } else setFirstId(group.messages[0].id)
  }, [displayRequest, controller.displayLoadedTurnIds, conversationGroups, firstId])
  const toggleSelectMode = useCallback(() => {
    setSelectMode(!selectMode)
    setSelection({ all: !selectMode, ids: new Set() })
  }, [selectMode])
  useEffect(() => {
    selectionToggleRef.current = toggleSelectMode
    return () => {
      if (selectionToggleRef.current === toggleSelectMode) selectionToggleRef.current = null
    }
  }, [selectionToggleRef, toggleSelectMode])
  useEffect(() => {
    onSelectionModeChange(selectMode)
  }, [onSelectionModeChange, selectMode])
  const toggleConversation = useCallback((id: string) => {
    setSelection((previous) => {
      const next = new Set(previous.ids)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...previous, ids: next }
    })
  }, [])
  const allSelected = selectableGroups.length > 0 && selectableGroups.every((group) => selectedIds.has(group.id))
  const toggleAll = useCallback(() => {
    setSelection({ all: !allSelected, ids: new Set() })
  }, [allSelected])
  const selectedGroups = useMemo(
    () => selectableGroups.filter((group) => selectedIds.has(group.id)),
    [selectableGroups, selectedIds]
  )
  const buildExportText = useCallback(() => {
    // Include complete loaded turns beyond the mounted viewport; incomplete
    // history remains unavailable until its original body has been loaded.
    const body = serializeMessages(selectedGroups.flatMap((group) => group.messages))
    return buildMessageExportDocument(body, {
      title: task.title,
      workspace: task.workspacePath,
      turnCount: selectedGroups.length
    })
  }, [selectedGroups, task.title, task.workspacePath])
  const copySelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setSelectionNotice(`已复制 ${selectedGroups.length} 轮对话`)
        setSelectMode(false)
        setSelection({ all: false, ids: new Set() })
      },
      () => setSelectionNotice('复制失败')
    )
  }, [buildExportText, selectedGroups.length])
  const exportSelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `aether-Work导出-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`
    // Keep the anchor attached for Chromium/Electron, where a detached click
    // can be ignored before the download has been scheduled.
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    setSelectionNotice(`已导出 ${selectedGroups.length} 轮对话`)
  }, [buildExportText, selectedGroups.length])
  useEffect(() => {
    if (!selectionNotice) return
    const timer = window.setTimeout(() => setSelectionNotice(null), 1800)
    return () => window.clearTimeout(timer)
  }, [selectionNotice])
  useLayoutEffect(() => {
    const action = archiveNavigation.current
    if (!action || !controller.archivePage) return
    scrollIntent.reset()
    archiveNavigation.current = null
    prependAnchor.current = null
    const atLatest = action === 'latest'
    setExpandedHistory(!atLatest)
    followRef.current = atLatest
    setFollowing(atLatest)
    setFirstId(controller.messages[atLatest ? Math.max(0, controller.messages.length - SESSION_MESSAGE_PAGE_SIZE) : 0]?.id ?? null)
    if (scrollRef.current) scrollRef.current.scrollTop = atLatest ? scrollRef.current.scrollHeight : 0
  }, [controller.archivePage])
  const inspectActivity = (target: EventTarget | null): void => {
    // Opening details is reading intent. Copy, preview, permission and closing
    // controls must not silently disable following the next streamed result.
    if (!(target instanceof Element) || !scrollRef.current?.contains(target)) return
    const control = target.closest('button, summary, [role="button"]')
    if (!control || control.matches(':disabled')) return
    const opening = control.getAttribute('aria-expanded') === 'false' && control.matches('.work-inline-activity button, .work-tool-activity button, .work-tool-activity summary, .work-tool-activity [role="button"], .work-message__process-toggle, .logline, .message__collapse-toggle')
    const paging = control.matches('.work-inline-activity__pages button, button.subagent-card__header:not([aria-expanded]), .subagent-history__more, .subagent-history__toolbar button, .subagent-history__error button')
    if (opening || paging) pauseReading()
  }
  return (
    <section className="work-conversation" aria-label="协作对话" onKeyDown={event => {
      if (selectMode && event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented && !getTopOverlayId()) {
        event.preventDefault()
        event.stopPropagation()
        toggleSelectMode()
      }
    }}>
      <RevertNotice sessionId={task.id} />
      <PublishedRecoveryNotice state={controller.publishedRecovery} onCancel={controller.cancelPublishedRecovery} onLoadBody={controller.loadPublishedBody} onRetry={controller.retryPublishedRecovery} />
      <MotionPresence show={selectMode}>
        <div className="work-conversation__select-bar" role="toolbar" aria-label="对话选择工具栏">
          <div className="work-conversation__selection-controls">
            <div className="work-conversation__selection-leading">
              <label className="work-conversation__select-all" title="选择或取消所有已完整加载的对话">
                <SelectionCheckbox checked={allSelected} mixed={!allSelected && selectedGroups.length > 0}
                  disabled={!selectableGroups.length} label="全选对话" onChange={toggleAll} />
                <span>全选</span>
              </label>
              <span className="work-conversation__selection-count" role="status" aria-live="polite">已选 {selectedGroups.length} 轮</span>
            </div>
            <div className="work-conversation__selection-actions">
              <button type="button" className="work-conversation__selection-button" disabled={selectedGroups.length === 0} onClick={copySelected}><Icon name="copy" size={14} />复制</button>
              <button type="button" className="work-conversation__selection-button" disabled={selectedGroups.length === 0} onClick={exportSelected}><Icon name="download" size={14} />导出</button>
              <span className="work-conversation__selection-separator" aria-hidden="true" />
              <button type="button" className="work-conversation__selection-button work-conversation__selection-button--done" title="退出选择（Esc）" onClick={toggleSelectMode}>完成</button>
            </div>
          </div>
        </div>
      </MotionPresence>
      {controller.recoveryNotice ? (
        <div className="chat__notice chat__notice--info" role="status" aria-live="polite">
          <span>{controller.recoveryNotice}</span>
          <button type="button" className="chat__toolbar-btn" onClick={controller.dismissRecoveryNotice}>知道了</button>
        </div>
      ) : null}
      <div className="work-conversation__body">
        <ServiceTray sessionId={task.id} jobs={controller.commandJobs} active={active} placement="rail" onOpenTerminal={onOpenTerminal} />
        <MessageNav sessionKey={positionKey} messages={controller.messages} groups={conversationGroups}
          historyIndex={displayTurns} loadedTurnIds={controller.displayLoadedTurnIds} onLoadTurn={(id) => {
            lastDisplayRequest.current = id
            return controller.loadDisplayTurn(id)
          }}
          firstId={firstId} scrollRef={scrollRef} onWindowChange={setFirstId} onLatest={latest}
          onInspectHistory={() => {
            pendingDisplayTurn.current = null
            setExpandedHistory(true)
            pauseReading()
          }} />
      <div
        className="work-conversation__scroll"
        data-browsing-history={historyBrowsing ? 'true' : undefined}
        ref={scrollRef}
        {...scrollIntent.handlers}
        onClickCapture={(event) => inspectActivity(event.target)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inspectActivity(event.target)
          scrollIntent.handlers.onKeyDownCapture?.(event)
        }}
      >
        <div className="work-conversation__content" data-history-start={start} data-history-end={end}>
          {controller.displayHistoryError ? <div className="work-history-notice" role="alert"><span>{controller.displayHistoryError}</span><button type="button" className="btn btn--sm" disabled={controller.displayHistoryLoading} onClick={() => loadDisplayHistory(lastDisplayRequest.current)}>重新加载完整记录</button></div> : null}
          {controller.displayHistoryLoading ? <p className="work-history-status" role="status">正在加载完整对话…</p> : null}
          {controller.displayHistoryCompleteness === 'sqlite_compacted' ? <p className="work-history-notice" role="status">此会话的部分早期记录已被旧版存储清理，以下仅显示仍保留的原始对话。</p> : null}
          {!controller.displayTurns && !controller.displayHistoryLoading && !controller.displayHistoryError && controller.historyCompacted ? <div className="work-history-notice" role="status"><span>当前记录经过压缩，正在显示的内容可能不完整。</span><button type="button" className="btn btn--sm" onClick={() => loadDisplayHistory()}>加载完整对话</button></div> : null}
          {start > 0 && <button type="button" className="btn btn--sm work-history-load" onClick={loadEarlier}>查看更早消息（{start} 条）</button>}
          {controller.loading && !controller.launching && (
            <div className="work-loading">
              <Spinner />
              正在读取任务…
            </div>
          )}
          {!controller.loading && !controller.streaming && !controller.launching && !controller.messages.length && (
            <EmptyState
              icon="chat"
              title="一起完成这项工作"
              description="在下方描述目标。执行过程、需要补充的问题和最终结果都会出现在这里。"
            />
          )}
          {visibleConversationGroups.map((group, index) => {
            const selected = selectedIds.has(group.id)
            const finalMessage = group.messages.findLast(message => message.role === 'assistant')
            // Results belong to the settled turn, including when a later turn is running.
            const turnRunning = Boolean(finalMessage && sessionMessageRunning(finalMessage))
            // Supplements share the reply, but regeneration belongs to the
            // original admission. Partial history must not retry a supplement.
            const originalMessage = group.messages.find(message => message.role === 'user' && !message.rootFollowup &&
              (!finalMessage?.run?.userMessageId || message.id === finalMessage.run.userMessageId))
            const finalResult = finalMessage ? getMessageFinalResult(finalMessage, task.id) : undefined
            const gap = historyGaps.get(group.id)
            const complete = selectableGroups.includes(group)
            const time = formatSessionConversationTime(sessionConversationStartedAt(group), conversationDate)
            return (
              <section key={group.id} data-turn-id={group.id} className={`work-conversation-turn${selectMode ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`}>
                {gap && (gap.count > 2 || !following) ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.displayHistoryLoading} onClick={() => loadDisplayHistory(gap.anchor)}>加载前面的 {gap.count} 轮对话</button> : null}
                {time ? <div className="work-conversation-turn__timestamp"><time dateTime={time.dateTime} title={time.title}>{time.label}</time></div> : null}
                <MotionPresence show={selectMode}>
                  <header className="work-conversation-turn__header">
                    <label className="work-conversation-turn__pick" title={complete ? `选择完整一轮对话（${group.messages.length} 条消息）` : '请先加载完整对话'}>
                      <SelectionCheckbox
                        checked={selected}
                        disabled={!complete}
                        onChange={() => toggleConversation(group.id)}
                        label={`选择第 ${group.order ?? index + 1} 轮对话`}
                      />
                      <span>第 {group.order ?? index + 1} 轮</span>
                    </label>
                    <span className="work-conversation-turn__summary" title={sessionConversationSummary(group.messages)}>{sessionConversationSummary(group.messages)}</span>
                  </header>
                </MotionPresence>
                {sessionConversationEntries(group).map(({ key, message, segments, processKey }) => (
                  <SessionMessage
                    key={key}
                    message={message}
                    turnSegments={segments}
                    processKey={processKey}
                    deliveryResult={message.id === finalResult?.assistantMessageId ? finalResult : undefined}
                    usage={message === finalMessage ? turnUsage.get(group.id) ?? undefined : undefined}
                    active={active}
                    fileContext={fileContext}
                    onFileLink={onFileLink}
                    openFile={openActivityFile}
                    respond={respond}
                    actionablePending={controller.pending}
                    assertPendingResponse={controller.assertPendingResponse}
                    restartFailedTask={restartFailedTask}
                    restart={restartPresentations.get(message.id)}
                    canRestart={message.id === restartableMessageId && Boolean(message.run && ['failed', 'interrupted'].includes(message.run.status))}
                    editSettledTurn={editSettledTurn}
                    userMessageAction={userMessageAction}
                    regenerateMessageId={message === finalMessage && !sessionMessageRunning(message) ? originalMessage?.id : undefined}
                    showUserActions={!selectMode}
                    messageActionBusy={controller.messageActionBusy}
                    canMutateMessage={controller.ready && controller.historyReady && !controller.uploading && !controller.streaming && !controller.launching && !controller.pending.length && !['running', 'waiting'].includes(task.status)}
                    taskId={task.id}
                    canRecover={message.id === recoverableMessageId}
                    canRetry={controller.ready && controller.historyReady && !controller.uploading && (!controller.messageActionBusy || controller.restartPending)}
                    canRespond={controller.ready && controller.historyReady}
                    openChange={openChange}
                    revealTool={activitySelection && (segments
                      ? segments.some(segment => segment.kind === 'tools' && segment.tools.some(tool => tool.id === activitySelection.toolId))
                      : message.tools.some(tool => tool.id === activitySelection.toolId)) ? activitySelection : null}
                  />
                ))}
                {!turnRunning && finalResult?.items.length ? <FinalDeliverables result={finalResult} active={active} onOpenItem={onOpenFinalItem} /> : null}
                {turnRunning && turnTodos.has(group.id) ? <TodoProgress todos={turnTodos.get(group.id)!} running={turnRunning} /> : null}
                {!turnRunning && turnChanges.get(group.id)?.length ? <ProgressPanel sessionId={task.id} turnKey={group.id}
                  changes={turnChanges.get(group.id)!} workspacePath={task.workspacePath}
                  streaming={taskRunning} sync={progress}
                  onDisclosureLayout={followBottom}
                  scopedToTurn={sessionProgressTurnScope(task.id, group).kind === 'turn'} onOpenFile={openActivityFile} onOpenChange={openChange}
                  onShowChanges={() => onOpenArtifacts({ sessionId: task.id, turnScope: sessionProgressTurnScope(task.id, group) })} /> : null}
              </section>
            )
          })}
          {newer > 0 ? <button type="button" className="btn btn--sm work-history-load" onClick={loadNewer}>查看较新消息（{newer} 条）</button> : null}
          {newer === 0 && controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.archiveLoading} onClick={() => loadArchivePage('newer')}>查看较新归档页</button> : null}
          <SessionTurnFeedback controller={controller} announce={!showPinnedFeedback} openActivity={openActivity}
            onVisibilityChange={setInlineFeedbackVisible} />
          {receiptGroups.length ? <SessionProgressSync state={progress} /> : null}
          {taskRunning && turnTodos.has('') ? <TodoProgress todos={turnTodos.get('')!} running={taskRunning} /> : null}
        </div>
      </div>
      </div>
      {selectionNotice ? <div className="chat__toast" role="status">{selectionNotice}</div> : null}
      <div className="work-conversation__footer">
        <MotionPresence show={showLatest} asChild>
          <button className="work-follow-latest" type="button" disabled={controller.archiveLoading} onClick={latest}>
            <Icon name="chevron-down" size={14} />
            回到最新
          </button>
        </MotionPresence>
        {showPinnedFeedback && <SessionRunStatus controller={controller} />}
        <NextTurnQueuePanel key={`queue:${controller.draftSource}:${task.id}`} scopeKey={`${controller.draftSource}:${task.id}`} queue={controller.nextTurnQueue} />
        <SessionConnectionNotice key={`connection:${controller.draftSource}:${task.id}`} ready={controller.ready} sessionId={task.id}
          source={getEngineSource()} connection={controller.historyRecovery}
          active={controller.streaming || ['running', 'waiting'].includes(task.status)}
          error={controller.historyError} onRetry={controller.retryHistory} />
        <ComposerV2 controller={controller} onPreserveReading={() => {
          // A card or composer resize can briefly create a gap before the
          // ResizeObserver catches up. Preserve intent, not that transient gap.
          if (!followRef.current) pauseReading()
        }} />
      </div>
    </section>
  )
}

const SessionMessage = memo(function SessionMessage({
  message,
  turnSegments,
  processKey,
  deliveryResult,
  usage,
  active,
  fileContext,
  onFileLink,
  openFile,
  respond,
  actionablePending,
  assertPendingResponse,
  restartFailedTask,
  restart,
  canRestart,
  editSettledTurn,
  userMessageAction,
  regenerateMessageId,
  showUserActions,
  messageActionBusy,
  canMutateMessage,
  taskId,
  canRecover,
  canRetry,
  canRespond,
  openChange,
  revealTool
}: {
  message: ChatMessage
  turnSegments?: import('./message-timeline').SessionMessageSegment[]
  processKey?: string
  deliveryResult?: FinalResult
  usage?: import('./shared/ConversationUsage').TurnUsageInfo
  active: boolean
  fileContext: ChatFileContext
  onFileLink: (event: MouseEvent<HTMLElement>) => void
  openFile: (path: string) => void
  respond: SessionController['respond']
  actionablePending: readonly PendingInteraction[]
  assertPendingResponse: SessionController['assertPendingResponse']
  restartFailedTask: SessionController['restartFailedTask']
  restart?: SessionTaskRestartPresentation
  canRestart: boolean
  editSettledTurn: SessionController['editSettledTurn']
  userMessageAction: SessionController['userMessageAction']
  regenerateMessageId?: string
  showUserActions: boolean
  messageActionBusy: boolean
  canMutateMessage: boolean
  taskId: string
  canRecover: boolean
  canRetry: boolean
  canRespond: boolean
  openChange: (change: EngineFileChange) => void
  revealTool: ActivitySelection | null
}): JSX.Element {
  const pending = useMemo(() =>
    (message.interactions ?? (message.pending ? [message.pending] : [])).filter(item =>
      actionablePending.some(current => current.runId === item.runId && current.requestId === item.requestId && current.toolCallId === item.toolCallId)),
    [message.interactions, message.pending, actionablePending])
  return (
    <MessageContent
      message={message}
      sessionId={taskId}
      fileContext={fileContext}
      active={active}
      onFileLink={onFileLink}
      onOpenFile={openFile}
      onOpenChange={openChange}
      revealTool={revealTool}
      turnSegments={turnSegments}
      processKey={processKey}
      deliveryResult={deliveryResult}
      usage={usage ? <TurnUsage {...usage} /> : null}
      replyActions={showUserActions && regenerateMessageId ? <SessionRegenerateReplyButton taskId={taskId} messageId={regenerateMessageId}
        canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
      userActions={showUserActions ? <UserMessageActions taskId={taskId} messageId={message.id} content={message.content}
        canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
    >
      {message.error ? <ErrorNotice error={message.error} context={message.run} compact
        resolved={restart?.resolved} busy={restart?.busy} busyLabel={restart?.label}
        recoveryError={restart?.error}
        onRetry={canRetry && (canRestart || restart?.status === 'unconfirmed') ? () => restartFailedTask(taskId, message.id) : undefined}
        retryLabel={restart?.status === 'unconfirmed' ? '核对并重启' : '重启任务'}
        onEdit={canRecover ? () => editSettledTurn(taskId, message.id) : undefined} /> : null}
      {canRecover && !message.error ? <div className="work-message__recovery">
        <button type="button" className="btn btn--sm" onClick={() => editSettledTurn(taskId, message.id)}
          title="将原指令与附件带回输入框，保留已有草稿">
          <Icon name="pencil" size={13} />{message.status === 'error' ? '编辑后重试' : '编辑后继续'}
        </button>
      </div> : null}
      {pending.map((item) => (
        <SessionPending
          key={JSON.stringify([getEngineSource(), taskId, item.runId, item.requestId, item.toolCallId])}
          pending={item}
          sessionId={taskId}
          disabled={!active || !canRespond}
          respond={respond}
          assertPendingResponse={assertPendingResponse}
        />
      ))}
      {message.answered && <p className="work-note">已回复：{message.answered}</p>}
    </MessageContent>
  )
})

function SessionPending({
  pending,
  sessionId,
  disabled,
  respond,
  assertPendingResponse
}: {
  pending: PendingInteraction
  sessionId: string
  disabled: boolean
  respond: SessionController['respond']
  assertPendingResponse: SessionController['assertPendingResponse']
}): JSX.Element {
  const source = getEngineSource()
  const key = JSON.stringify([source, sessionId, pending.runId, pending.requestId, pending.toolCallId])
  const isPermission = pending.kind === 'permission'
  const [values, setValues] = useState<string[][]>(
    () => pendingDrafts.get(key)?.values ?? pending.groups.map(() => [])
  )
  const [freeText, setFreeText] = useState<string[]>(
    () => pendingDrafts.get(key)?.freeText ?? pending.groups.map(() => '')
  )
  const [submitting, setSubmitting] = useState<'reply' | 'full-access' | null>(null)
  const busy = useRef(false)
  const scope = useRef<{ current: boolean } | null>(null)
  useLayoutEffect(() => {
    const operation = { current: true }
    scope.current = operation
    return () => { operation.current = false }
  }, [key, disabled])
  const [error, setError] = useState('')
  useEffect(() => {
    rememberPendingDraft(key, { values, freeText })
  }, [key, values, freeText])
  const answers = pending.groups.map((_, index) =>
    [...(values[index] ?? []), freeText[index]?.trim()].filter(Boolean).join('、')
  )
  const blocked = disabled || submitting !== null || !pending.requestId || !pending.runId
  const reply = async (replyValues: string[], fullAccess = false): Promise<void> => {
    const operation = scope.current
    const isCurrent = (): boolean => Boolean(operation?.current && !disabled &&
      source === getEngineSource() && isEngineReady() && getSessionState(getEngineStorageKey()).activeTaskId === sessionId)
    const requestId = pending.requestId, runId = pending.runId
    if (busy.current || !isCurrent() || !requestId || !runId || (fullAccess && !isPermission)) return
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new Error('当前确认请求已结束或变化')
      assertPendingResponse(requestId, runId)
    }
    busy.current = true
    setSubmitting(fullAccess ? 'full-access' : 'reply')
    setError('')
    let modeChanged = false
    try {
      assertCurrent()
      if (fullAccess) {
        await changeSecurityMode(sessionId, 'full-access', assertCurrent)
        modeChanged = true
      }
      // The controller wrapper follows the selected task. Never let a late
      // mode update submit the old approval through a different task's controller.
      if (!isCurrent()) return
      assertCurrent()
      await respond(requestId, replyValues)
    } catch (reason) {
      if (isCurrent()) {
        const detail = reason instanceof Error ? reason.message : String(reason)
        setError(fullAccess
          ? `${modeChanged ? '完全访问已开启，但本次操作未能放行' : '切换完全访问失败，尚未提交放行'}：${detail}`
          : `回复未提交：${detail}`)
      }
    } finally {
      busy.current = false
      if (scope.current?.current) setSubmitting(null)
    }
  }
  const submit = (): void => {
    if (isPermission || answers.some(answer => !answer)) return
    void reply(answers)
  }
  return (
    <form
      className={`work-pending${isPermission ? ' work-pending--permission' : ' work-pending--question'}`}
      aria-label={isPermission ? '操作确认' : '补充信息'}
      aria-busy={submitting !== null}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {isPermission ? <PermissionCard pending={pending} blocked={blocked} submitting={submitting}
        onReply={(values, fullAccess) => { void reply(values, fullAccess) }} /> : (
        <QuestionCard pending={pending} values={values} freeText={freeText} blocked={blocked}
          submitting={submitting !== null}
          onSelect={(index, value, checked) => setValues(previous => previous.map((list, groupIndex) =>
            groupIndex !== index ? list : pending.groups[index].multiSelect
              ? checked ? [...list, value] : list.filter(item => item !== value)
              : [value]))}
          onText={(index, text) => setFreeText(previous => previous.map((value, groupIndex) =>
            groupIndex === index ? text : value))} />
      )}
      {error ? <p className="work-pending__error" role="alert">{error}</p> : null}
      {submitting ? <span className="work-pending__status" role="status">{submitting === 'full-access' ? '正在切换权限并放行当前操作…' : '正在提交回复…'}</span> : null}
    </form>
  )
}
