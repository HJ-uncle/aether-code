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
import { useExtensionMessageEvents } from './useExtensionMessageEvents'
import { serializeMessages, buildMessageExportDocument } from './shared/message-export'
import { sessionConversationAwayFromBottom } from './conversation-scroll'
import { useSessionConversationScrollIntent } from './useSessionConversationScrollIntent'
import { ErrorNotice } from './ErrorNotice'
import { recoverSessionTurn } from './turn-recovery'
import { sessionTaskRestart, continuationTarget, type SessionTaskRestartPresentation } from '../sessions/task-restart'
import { SessionRegenerateReplyButton, UserMessageActions } from '../sessions/UserMessageActions'
import { getSessionState } from '../sessions/state'
import { findSessionArtifact } from '../artifacts/artifact-utils'
import { type SessionController, type ActivitySelection, type ArtifactNavigation, EmptyState } from '../sessions/session-presentation'
import { SessionTurnFeedback, SessionRunStatus } from './SessionFeedback'
import { RootFollowupReceipt, useRootFollowupReceipts } from './RootFollowupReceipts'

const conversationPositions = new Map<string, { top: number; follow: boolean }>()

const pendingDrafts = new Map<string, { values: string[][]; freeText: string[] }>()

const MAX_SESSION_VIEW_CACHE = 256

function rememberConversationPosition(id: string, value: { top: number; follow: boolean }): void {
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
  selectionToggleRef: MutableRefObject<(() => void) | null>
  onSelectionModeChange: (active: boolean) => void
}): JSX.Element {
  const { engine } = useApp()
  const task = controller.activeTask!
  useExtensionMessageEvents(task.id, task.workspacePath, controller.messages, controller.ready && controller.historyReady, active)
  const taskRunning = controller.streaming || controller.launching || ['running', 'waiting'].includes(task.status)
  const positionKey = `${getEngineSource()}:${task.id}`
  const conversationGroups = useMemo(() => sessionConversationGroups(controller.messages), [controller.messages])
  const scrollRef = useRef<HTMLDivElement>(null)
  const readingAnchor = useRef<{ messageId: string; offset: number; scrollTop: number; navigation?: boolean; top?: boolean } | null>(null)
  const previousFirstMessageId = useRef<string | undefined>(controller.messages[0]?.id)
  const rememberReadingAnchor = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    const previous = readingAnchor.current
    // A deliberate target may be clamped in a short recovery snapshot. Its
    // intended alignment still matters when earlier history arrives later.
    if (previous?.navigation && Math.abs(previous.scrollTop - element.scrollTop) <= 1) return
    const messages = element.querySelectorAll<HTMLElement>('.work-conversation__content > .work-conversation-turn > .work-message[data-message-id]')
    const viewportTop = element.getBoundingClientRect().top
    let low = 0, high = messages.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (messages[middle].getBoundingClientRect().bottom <= viewportTop) low = middle + 1
      else high = middle
    }
    const message = messages[Math.min(low, messages.length - 1)]
    readingAnchor.current = message ? { messageId: message.dataset.messageId!,
      offset: message.getBoundingClientRect().top - viewportTop, scrollTop: element.scrollTop } : null
  }, [])
  const rememberNavigationAnchor = useCallback((messageId: string, top: boolean): void => {
    const element = scrollRef.current
    if (element) readingAnchor.current = { messageId, offset: 8, scrollTop: element.scrollTop, navigation: true, top }
  }, [])
  const followRef = useRef(conversationPositions.get(positionKey)?.follow ?? true)
  const [following, setFollowing] = useState(followRef.current)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [inlineFeedbackVisible, setInlineFeedbackVisible] = useState(true)
  const latestRequest = useRef(false)
  const [latestPending, setLatestPending] = useState(false)
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
    if (latestRequest.current && away === false) {
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
    return new Map(controller.messages.filter(message => message.run).map(message =>
      [message.id, sessionTaskRestart(task.id, message.run!, read, controller.messages)]))
  }, [controller.messages, controller.nextTurnQueue.state, controller.nextTurnQueue.error, controller.historyError, task.id])
  const restartableMessageId = !controller.streaming && !controller.launching && !controller.pending.length
    ? controller.messages.findLast(message => message.role === 'assistant')?.id : undefined
  // Keep selection local to a task. Work selects complete conversation turns
  // (the user request together with the Agent response), so exporting one
  // item never produces a contextless half of a turn.
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<{ all: boolean; ids: ReadonlySet<string> }>({ all: false, ids: new Set() })
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const showLatest = latestPending || awayFromBottom
  useEffect(() => {
    // Reading old turns (or retaining this component in Code mode) is not
    // seeing the new result. Reuse the conversation's existing scroll state.
    if (!task.completionUnread || task.status !== 'done' || !active || !following ||
      awayFromBottom || !controller.historyReady || controller.historyError ||
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
  }, [task.id, task.completionUnread, task.status, task.activity, active, following, awayFromBottom,
    controller.historyReady, controller.historyError, controller.displayHistoryLoading, controller.displayHistoryError,
    controller.currentRun?.runId, controller.currentRun?.status, controller.draftSource])
  const showPinnedFeedback = showLatest && !inlineFeedbackVisible
  const conversationDate = useSessionConversationDate(active)
  // Scroll/follow state changes do not change a turn's timeline. Reusing its
  // segments lets memoized messages skip rendering the entire loaded history.
  const conversationEntries = useMemo(() => new Map(conversationGroups.map(group =>
    [group.id, sessionConversationEntries(group)])), [conversationGroups])
  const followupReceipts = useRootFollowupReceipts(task.id, controller.messages)
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
  const selectableGroups = useMemo(() => conversationGroups.filter(group => sessionConversationComplete(group, controller.displayTurns, controller.displayLoadedTurnIds)),
    [conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds])
  const selectableGroupIds = useMemo(() => new Set(selectableGroups.map(group => group.id)), [selectableGroups])
  // Keep the user's all/except choice as older turns finish loading, without
  // reselecting a turn they explicitly unchecked or eagerly mounting history.
  const selectedIds = useMemo(() => new Set(selectMode ? selectableGroups.filter(group =>
    selection.all ? !selection.ids.has(group.id) : selection.ids.has(group.id)).map(group => group.id) : []),
  [selectMode, selectableGroups, selection])
  const turnUsage = useMemo(() => new Map(conversationGroups.map(group => [group.id, summarizeTurnUsage(group.messages)])), [conversationGroups])
  useLayoutEffect(() => {
    if (activitySelection) pauseReading()
  }, [activitySelection, pauseReading])
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
        .find(element => element.dataset.workToolId === activitySelection.toolId)
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
      // A disclosed stage can scroll inside the overall process. Bring the
      // receipt into each clipping viewport, starting with the innermost one.
      for (let processViewport = node.closest<HTMLElement>('[data-process-scroll]');
        processViewport && container.contains(processViewport);
        processViewport = processViewport.parentElement?.closest<HTMLElement>('[data-process-scroll]') ?? null) {
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
  }, [activitySelection, controller.messages, active, onActivityRevealed])
  const restoredPosition = useRef(false)
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
    if (element) rememberConversationPosition(positionKey, { top: element.scrollTop, follow: followRef.current })
  }, [positionKey])
  useLayoutEffect(() => {
    const previous = previousFirstMessageId.current
    previousFirstMessageId.current = controller.messages[0]?.id
    const element = scrollRef.current, anchor = readingAnchor.current
    // Only a newly prepended prefix needs compensation. Appended stream text,
    // disclosure changes and ordinary scrolling retain their existing intent.
    if (element && anchor && previous && previous !== controller.messages[0]?.id && !followRef.current &&
      controller.messages.findIndex(message => message.id === previous) > 0) {
      const message = element.querySelector<HTMLElement>(`.work-conversation__content > .work-conversation-turn > .work-message[data-message-id="${CSS.escape(anchor.messageId)}"]`)
      if (message) {
        const target = anchor.navigation ? message.closest<HTMLElement>('.work-conversation-turn') ?? message : message
        element.scrollTop = anchor.top ? 0 : element.scrollTop + target.getBoundingClientRect().top -
          element.getBoundingClientRect().top - anchor.offset
        anchor.scrollTop = element.scrollTop
      }
    }
    rememberReadingAnchor()
  }, [controller.messages, rememberReadingAnchor])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !active) return
    followBottom()
    measureScrollPosition()
  }, [controller.messages, controller.todos, controller.loading, controller.streaming, controller.launching, bottomRequest, active, followBottom, measureScrollPosition])
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
    latestRequest.current = true
    setLatestPending(true)
    followRef.current = true
    setFollowing(true)
    // Keep every loaded turn mounted while returning to the live tail.
    followBottom()
    setBottomRequest(value => value + 1)
  }
  const loadDisplayHistory = (): void => {
    if (controller.displayHistoryLoading) return
    void controller.loadDisplayTurn()
  }
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
        <MessageNav sessionKey={positionKey} messages={controller.messages} groups={conversationGroups}
          historyIndex={displayTurns} loadedTurnIds={controller.displayLoadedTurnIds} onLoadTurn={controller.loadDisplayTurn}
          scrollRef={scrollRef} onLatest={latest} onInspectHistory={pauseReading} onPositioned={rememberNavigationAnchor} />
      <div
        className="work-conversation__scroll"
        ref={scrollRef}
        {...scrollIntent.handlers}
        onScroll={event => {
          scrollIntent.handlers.onScroll?.(event)
          if (event.target === event.currentTarget) rememberReadingAnchor()
        }}
        onClickCapture={(event) => inspectActivity(event.target)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inspectActivity(event.target)
          scrollIntent.handlers.onKeyDownCapture?.(event)
        }}
      >
        <div className="work-conversation__content" data-history-start={0} data-history-end={controller.messages.length}>
          {controller.displayHistoryError ? <div className="work-history-notice" role="alert"><span>{controller.displayHistoryError}</span><button type="button" className="btn btn--sm" disabled={controller.displayHistoryLoading} onClick={loadDisplayHistory}>重新加载完整记录</button></div> : null}
          {controller.displayHistoryLoading && !controller.messages.length ? <p className="work-history-status" role="status">正在加载完整对话…</p> : null}
          {controller.displayHistoryCompleteness === 'sqlite_compacted' ? <p className="work-history-notice" role="status">此会话的部分早期记录已被旧版存储清理，以下仅显示仍保留的原始对话。</p> : null}
          {!controller.displayTurns && !controller.displayHistoryLoading && !controller.displayHistoryError && controller.historyCompacted ? <div className="work-history-notice" role="status"><span>当前记录经过压缩，正在显示的内容可能不完整。</span><button type="button" className="btn btn--sm" onClick={() => loadDisplayHistory()}>加载完整对话</button></div> : null}
          {controller.loading && !controller.launching && (
            <div className="work-loading">
              <Spinner />
              正在读取任务…
            </div>
          )}
          {!controller.loading && !controller.streaming && !controller.launching && !controller.messages.length && (
            <EmptyState
              icon="chat"
              title={task.archived ? '此会话已归档' : '一起完成这项工作'}
              description={task.archived ? '暂无对话记录。恢复会话后可继续输入。' : '在下方描述目标。执行过程、需要补充的问题和最终结果都会出现在这里。'}
            />
          )}
          {conversationGroups.map((group, index) => {
            const selected = selectedIds.has(group.id)
            const finalMessage = group.messages.findLast(message => message.role === 'assistant')
            // Results belong to the settled turn, including when a later turn is running.
            const turnRunning = Boolean(finalMessage && sessionMessageRunning(finalMessage))
            // Supplements share the reply, but regeneration belongs to the
            // original admission. Partial history must not retry a supplement.
            const originalMessage = group.messages.find(message => message.role === 'user' && !message.rootFollowup &&
              (!finalMessage?.run?.userMessageId || message.id === finalMessage.run.userMessageId))
            const finalResult = finalMessage ? getMessageFinalResult(finalMessage, task.id) : undefined
            const complete = selectableGroupIds.has(group.id)
            const time = formatSessionConversationTime(sessionConversationStartedAt(group), conversationDate)
            return (
              <section key={group.id} data-turn-id={group.id} className={`work-conversation-turn${selectMode ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`}>
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
                {conversationEntries.get(group.id)!.map(({ key, message, segments, processKey }) => (
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
                    waitForSourceChange={controller.waitForSourceChange}
                    actionablePending={controller.pending}
                    assertPendingResponse={controller.assertPendingResponse}
                    restartFailedTask={restartFailedTask}
                    restart={restartPresentations.get(message.id)}
                    canRestart={message.id === restartableMessageId && Boolean(message.run && continuationTarget(message.run))}
                    editSettledTurn={editSettledTurn}
                    userMessageAction={userMessageAction}
                    regenerateMessageId={message === finalMessage && !sessionMessageRunning(message) ? originalMessage?.id : undefined}
                    showUserActions={!selectMode}
                    readOnly={Boolean(task.archived)}
                    messageActionBusy={controller.messageActionBusy}
                    canMutateMessage={controller.ready && controller.historyReady && !controller.uploading && !controller.streaming && !controller.launching && !controller.pending.length && !['running', 'waiting'].includes(task.status)}
                    taskId={task.id}
                    canRecover={!task.archived && message.id === recoverableMessageId}
                    canRetry={!task.archived && controller.ready && controller.historyReady && !controller.uploading && (!controller.messageActionBusy || controller.restartPending)}
                    canRespond={!task.archived && controller.ready && controller.historyReady}
                    openChange={openChange}
                    revealTool={activitySelection && (segments
                      ? segments.some(segment => segment.kind === 'tools' && segment.tools.some(tool => tool.id === activitySelection.toolId))
                      : message.tools.some(tool => tool.id === activitySelection.toolId)) ? activitySelection : null}
                  />
                ))}
                {followupReceipts.filter(item => group.messages.some(message => message.runId === item.rootRunId)).map(item =>
                  <RootFollowupReceipt key={item.requestKey} item={item} fileContext={fileContext} onFileLink={onFileLink} />)}
                {!turnRunning && finalResult?.items.length ? <FinalDeliverables result={finalResult} active={active} onOpenItem={onOpenFinalItem} /> : null}
                {turnRunning && turnTodos.has(group.id) ? <TodoProgress todos={turnTodos.get(group.id)!} running={turnRunning} /> : null}
                {!turnRunning && turnChanges.get(group.id)?.length ? <ProgressPanel sessionId={task.id} turnKey={group.id}
                  changes={turnChanges.get(group.id)!} workspacePath={task.workspacePath}
                  streaming={taskRunning} sync={progress}
                  onDisclosureLayout={followBottom}
                  scopedToTurn={sessionProgressTurnScope(task.id, group).kind === 'turn'} onOpenFile={openActivityFile}
                  onOpenChange={change => {
                    const turnScope = sessionProgressTurnScope(task.id, group)
                    if (turnScope.kind === 'turn') onOpenArtifacts({ sessionId: task.id, path: change.path, view: 'turn', turnScope })
                    else openChange(change)
                  }}
                  onShowChanges={() => onOpenArtifacts({ sessionId: task.id, turnScope: sessionProgressTurnScope(task.id, group) })} /> : null}
              </section>
            )
          })}
          <SessionTurnFeedback controller={controller} announce={!showPinnedFeedback} openActivity={openActivity}
            onVisibilityChange={setInlineFeedbackVisible} />
          {receiptGroups.length ? <SessionProgressSync state={progress} /> : null}
          {taskRunning && turnTodos.has('') ? <TodoProgress todos={turnTodos.get('')!} running={taskRunning} /> : null}
        </div>
      </div>
      </div>
      {selectionNotice ? <div className="chat__toast" role="status">{selectionNotice}</div> : null}
      <div className="work-conversation__footer">
        <div className="work-conversation__floating">
          {showPinnedFeedback && <SessionRunStatus controller={controller} />}
        <MotionPresence show={showLatest} asChild>
            <button className="work-follow-latest" type="button" disabled={controller.archiveLoading} onClick={latest}>
              <Icon name="chevron-down" size={14} />
              回到最新
            </button>
          </MotionPresence>
        </div>
        {!task.archived && <NextTurnQueuePanel key={`queue:${controller.draftSource}:${task.id}`} scopeKey={`${controller.draftSource}:${task.id}`} queue={controller.nextTurnQueue} />}
        <SessionConnectionNotice key={`connection:${controller.draftSource}:${task.id}`} ready={controller.ready} sessionId={task.id}
          source={getEngineSource()} connection={controller.historyRecovery}
          active={controller.streaming || ['running', 'waiting'].includes(task.status)}
          error={controller.historyError} onRetry={controller.retryHistory} />
        {task.archived ? <div className="work-history-notice" role="status">
          <span>此会话已归档，恢复后可继续对话。</span>
          <button type="button" className="btn btn--sm" onClick={() => controller.archiveTask(task.id, false)}>恢复会话</button>
        </div> : <ComposerV2 controller={controller} onPreserveReading={() => {
          // A card or composer resize can briefly create a gap before the
          // ResizeObserver catches up. Preserve intent, not that transient gap.
          if (!followRef.current) pauseReading()
        }} />}
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
  waitForSourceChange,
  actionablePending,
  assertPendingResponse,
  restartFailedTask,
  restart,
  canRestart,
  editSettledTurn,
  userMessageAction,
  regenerateMessageId,
  showUserActions,
  readOnly,
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
  waitForSourceChange: SessionController['waitForSourceChange']
  actionablePending: readonly PendingInteraction[]
  assertPendingResponse: SessionController['assertPendingResponse']
  restartFailedTask: SessionController['restartFailedTask']
  restart?: SessionTaskRestartPresentation
  canRestart: boolean
  editSettledTurn: SessionController['editSettledTurn']
  userMessageAction: SessionController['userMessageAction']
  regenerateMessageId?: string
  showUserActions: boolean
  readOnly: boolean
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
    (readOnly ? [] : message.interactions ?? (message.pending ? [message.pending] : [])).filter(item =>
      actionablePending.some(current => current.runId === item.runId && current.requestId === item.requestId && current.toolCallId === item.toolCallId)),
    [readOnly, message.interactions, message.pending, actionablePending])
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
      replyActions={showUserActions && !readOnly && regenerateMessageId ? <SessionRegenerateReplyButton taskId={taskId} messageId={regenerateMessageId}
        canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
      userActions={showUserActions ? <UserMessageActions taskId={taskId} messageId={message.id} content={message.content}
        readOnly={readOnly} canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
    >
      {message.error || canRestart || restart?.busy ? <ErrorNotice error={message.error || '任务已停止'} context={message.run} compact
        resolved={restart?.resolved} busy={restart?.busy} busyLabel={restart?.label}
        recoveryError={restart?.error}
        onRetry={canRetry && (canRestart || restart?.status === 'unconfirmed') ? () => restartFailedTask(taskId, message.id) : undefined}
        retryLabel={restart?.status === 'unconfirmed' ? '核对并继续' : '继续'}
        onEdit={canRecover ? () => editSettledTurn(taskId, message.id) : undefined} /> : null}
      {canRecover && !message.error && !canRestart && !restart?.busy ? <div className="work-message__recovery">
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
          waitForSourceChange={waitForSourceChange}
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
  waitForSourceChange,
  assertPendingResponse
}: {
  pending: PendingInteraction
  sessionId: string
  disabled: boolean
  respond: SessionController['respond']
  waitForSourceChange: SessionController['waitForSourceChange']
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
    // Source-version conflicts are never authorizable through the session
    // full-access switch; only the engine-provided conflict choices may resume.
    if (busy.current || !isCurrent() || !requestId || !runId || (fullAccess && (!isPermission || pending.sourceChange))) return
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
      if (isCurrent() && !pending.sourceChange?.wait) {
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
  useEffect(() => {
    const wait = pending.sourceChange?.wait
    const requestId = pending.requestId
    const runId = pending.runId
    if (!wait || !requestId || !runId || disabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const status = await waitForSourceChange({ sessionId, runId, requestId })
        if (status.ready) {
          if (!stopped) await reply(['recheck'])
          return
        }
      } catch {
        // The durable engine continuation may already have won the race, or
        // the engine may be restarting. Keep the card and let the next poll
        // re-read the authoritative pending identity.
      }
      if (!stopped) {
        timer = setTimeout(() => { void poll() }, Math.max(750, wait.pollMs))
      }
    }
    void poll()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [key, disabled, pending.sourceChange?.wait, pending.requestId, pending.runId, sessionId, waitForSourceChange, reply])
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
