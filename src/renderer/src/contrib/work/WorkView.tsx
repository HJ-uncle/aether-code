import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MutableRefObject,
  type MouseEvent
} from 'react'
import type { ChatAttachment, ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import type { EngineFileChange } from '@shared/ipc'
import type { CronAutomationRun } from '@shared/automation'
import type { ChatRecoverySnapshot } from '@renderer/core/engine/chat-recovery'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { useApp } from '@renderer/core/app-context'
import { toast } from '@renderer/core/toast'
import { getAppMode, setAppMode, useAppMode } from '@renderer/core/platform/app-mode'
import { buildConversationLink, parseConversationLink } from '@shared/conversation-link'
import { conversationLinkTask } from './work-conversation-reference'
import { getEngineSource, getEngineStorageKey, isEngineReady } from '@renderer/core/engine/source'
import { changeSecurityMode } from '@renderer/core/engine/security-store'
import { setBrowserSessionOverride } from '@renderer/core/browser/connection'
import { useWorkbenchClient, waitForWorkPreview } from '@renderer/core/workbench/client'
import { requestWorkPreview } from '@renderer/core/workbench/preview-request'
import { registerCommand } from '@renderer/core/platform/commands'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon, type IconName } from '@renderer/workbench/icons'
import type { ActionMenuItem } from '@renderer/workbench/ActionMenu'
import { IconButton, SectionHeading, Spinner } from '@renderer/workbench/ui-primitives'
import { openAppSettings } from '../settings/app-settings-navigation'
import { FileGlyph } from '../explorer/FileGlyph'
import { classifyChatLink } from '../chat/chat-link'
import type { ChatFileContext } from '../chat/chat-link'
import { openFileFromChat } from '../chat/open-file'
import { useWorkController } from './work-runtime'
import { WorkBrowser } from './WorkBrowser'
import { WorkComposer as WorkComposerV2 } from './WorkComposer'
import { WorkReferenceProvider, useWorkReferenceNavigation } from './WorkReferenceNavigation'
import { WorkNextTurnQueuePanel } from './WorkNextTurnQueue'
import { WorkTaskActions } from './WorkTaskActions'
import { WorkSelectionCheckbox } from './WorkSelectionCheckbox'
import { getTopOverlayId } from '@renderer/workbench/overlay'
import { useHoverDetail } from '@renderer/workbench/useHoverDetail'
import { WorkSidebarTask } from './WorkSidebarTask'
import { sortWorkSidebarTasks } from './work-sidebar-task'
import { WorkArtifactPanel, type WorkArtifactPanelProps } from './WorkArtifactPanel'
import { fileContentBytes } from '@renderer/core/workspace/file-content-bytes'
import { resourcePreviewEntries } from './work-resource-preview-policy'
import { useRetainedPreviews } from '@renderer/core/editor/useRetainedPreviews'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import { WorkSourcePreview, useWorkSourceFile } from './WorkSourcePreview'
import { assertSessionFileTarget, paths, readLocalRecoveryFile, resolveSessionFilePath, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { WorkGitPanel } from './WorkGitPanel'
import { WorkWorkspacePanel, type WorkFileRevealRequest } from './WorkWorkspacePanel'
import { WorkSubagentsPanel } from './WorkSubagentsPanel'
import { PublishedRecoveryNotice } from '../chat/PublishedRecoveryNotice'
import { SessionConnectionNotice } from '../chat/SessionConnectionNotice'
import { WorkMessageNav } from './WorkMessageNav'
import { workConversationGroups, workConversationEntries, workConversationComplete } from './work-conversation-turns'
import { workGroupedDisplayTurns } from './work-message-nav'
import { WorkArtifactsWorkspace } from './WorkArtifactsWorkspace'
import { workFinalResultCatalog } from './work-final-results'
import { WorkFinalDeliverables } from './WorkFinalDeliverables'
import { WorkRevertNotice } from './WorkRevertNotice'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { getMessageFinalResult } from '@renderer/core/engine/final-result'
import type { WorkArtifactSelection } from './work-session-artifacts'
import { TurnUsage, UsageMeter } from '../chat/ConversationUsage'
import { summarizeTurnUsage } from '../chat/turn-usage'
import { WorkProgressPanel, WorkProgressSync, WorkTodoProgress } from './WorkProgressPanel'
import { useWorkProgressChanges } from './useWorkProgressChanges'
import { workProgressTurnScope, workTurnProgressChanges } from './work-turn-progress'
import { MotionPresence, useMotionPresence } from '@renderer/workbench/MotionPresence'
import { WorkAgentManager } from './WorkAgentManager'
import { workToolTarget } from './work-message-timeline'
import { workMessageRunning } from './work-tool-presentation'
import { buildWorkInlineFileResolver } from './work-inline-file-references'
import { WorkMessageContent } from './WorkMessageContent'
import { workSubagentName } from './work-subagents'
import { serializeMessages } from '../chat/message-export'
import { WORK_MESSAGE_PAGE_SIZE, WORK_TASK_PAGE_SIZE, workMessageRange, workPaneRatio, workSplitRatio, workToolSnapshot, type WorkToolSnapshot } from './work-view-performance'
import { workConversationAwayFromBottom } from './work-conversation-scroll'
import { useWorkConversationScrollIntent } from './useWorkConversationScrollIntent'
import { requestedThinkingMode } from '../chat/session-request-config'
import { AutomationsView } from '../automations/AutomationsView'
import { subscribeAutomationEditor } from '../automations/automation-navigation'
import { EngineMonitorView } from './EngineMonitorView'
import { WorkErrorNotice } from './WorkErrorNotice'
import { recoverWorkTurn } from './work-turn-recovery'
import { workTaskRestart, type WorkTaskRestartPresentation } from './work-task-restart'
import { WorkRegenerateReplyButton, WorkUserMessageActions } from './WorkUserMessageActions'
import { flushWorkDrafts, getWorkState, updateWorkState, type WorkArtifact } from './work-state'
import { findWorkArtifact } from './work-artifact-utils'
import { browserAction, hideBrowserSurfaces, selectBrowserTab, useBrowserState } from '../browser/browser-store'
import './work.css'
import '../chat/apple-chat-panels.css'
import { WorkResourceTabs } from './WorkResourceTabs'
import { closeWorkResource, openExternalWorkFileResource, resolvedWorkResourceId, selectWorkResource, useWorkResources, workResourceBrowserTabs } from './work-resource-store'
import { workChangePathKey, type SessionFileChange } from './work-file-changes'
import { getRunningWorkTasks, WorkRunList } from './WorkRunList'
import { WorkServiceTray, partitionWorkServices } from './WorkServiceTray'
import { WorkTerminalPanel, type WorkTerminalPanelProps } from './WorkTerminalPanel'
import { onWorkTerminalRequest } from './work-terminal-navigation'
import { createLocalSession } from '../terminal/terminal-store'

type WorkController = ReturnType<typeof useWorkController>
type WorkTask = WorkController['tasks'][number]
type Page = 'home' | 'projects' | 'browser' | 'automations' | 'connections' | 'agents' | 'monitor'
type WorkspaceTab = 'files' | 'workspace' | 'sources' | 'browser' | 'subagents' | 'git' | 'terminal'
type ArtifactNavigation = Omit<WorkArtifactSelection, 'revision'>
type FinalSelection = { sessionId: string; runId: string; itemId: string; revision: number }
type WorkspaceEntry = { kind: 'surface'; id: WorkspaceTab } | { kind: 'resource'; id: string }
type ActivitySelection = { taskId: string; toolId: string; revision: number }
type TaskFilter = 'all' | 'running' | 'waiting' | 'done'
type ViewState = {
  page: Page
  collapsed: boolean
  workspace: boolean
  tab: WorkspaceTab
  pane: 'conversation' | 'workspace'
  ratio: number
}

const VIEW_KEY = 'aether.work.view.v1'
const conversationPositions = new Map<string, { top: number; follow: boolean; firstId?: string | null; expanded?: boolean }>()
const pendingDrafts = new Map<string, { values: string[][]; freeText: string[] }>()
const MAX_WORK_VIEW_CACHE = 256
const StableWorkSubagentsPanel = memo(WorkSubagentsPanel)
const StableWorkGitPanel = memo(WorkGitPanel)

function useWorkTools(messages: ChatMessage[]): ToolActivity[] {
  const previous = useRef<WorkToolSnapshot<ToolActivity> | undefined>(undefined)
  return useMemo(() => {
    const next = workToolSnapshot(messages, previous.current)
    previous.current = next
    return next.tools
  }, [messages])
}
function rememberConversationPosition(id: string, value: { top: number; follow: boolean; firstId?: string | null; expanded?: boolean }): void {
  conversationPositions.delete(id)
  conversationPositions.set(id, value)
  while (conversationPositions.size > MAX_WORK_VIEW_CACHE) {
    const oldest = conversationPositions.keys().next().value
    if (typeof oldest !== 'string') break
    conversationPositions.delete(oldest)
  }
}
function rememberPendingDraft(id: string, value: { values: string[][]; freeText: string[] }): void {
  pendingDrafts.delete(id)
  pendingDrafts.set(id, value)
  while (pendingDrafts.size > MAX_WORK_VIEW_CACHE) {
    const oldest = pendingDrafts.keys().next().value
    if (typeof oldest !== 'string') break
    pendingDrafts.delete(oldest)
  }
}
const NAVIGATION: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'home', label: '工作台', icon: 'chat' },
  { id: 'projects', label: '项目', icon: 'folder-outline' },
  { id: 'agents', label: 'Agent', icon: 'account-outline' },
  { id: 'browser', label: '浏览器', icon: 'search' },
  { id: 'automations', label: '自动化', icon: 'clock-outline' },
  { id: 'connections', label: '连接', icon: 'graph' },
  { id: 'monitor', label: '引擎监控', icon: 'engine' }
]
const TEMPLATES: Array<{ title: string; icon: IconName; text: string }> = [
  {
    title: '调研一个主题',
    icon: 'search',
    text: '请帮我调研以下主题，整理关键发现并列出可核对的来源：\n'
  },
  {
    title: '起草一份文档',
    icon: 'pencil',
    text: '请帮我起草一份文档。目标读者：\n文档主题：\n需要包含：'
  },
  {
    title: '分析资料',
    icon: 'graph',
    text: '请分析我提供的资料，提取关键数据、变化趋势和需要关注的问题。\n重点关注：'
  },
  {
    title: '整理行动计划',
    icon: 'check-all',
    text: '请将以下目标整理为清晰的行动计划，列出步骤、依赖和交付物：\n'
  }
]
const STATUS_LABEL: Record<WorkTask['status'], string> = {
  draft: '草稿',
  running: '进行中',
  waiting: '等你补充',
  done: '已完成',
  error: '执行失败',
  stopped: '已停止',
  interrupted: '连接中断'
}


function initialView(): ViewState {
  const fallback: ViewState = {
    page: 'home',
    collapsed: false,
    // Start with the conversation; files open when explicitly requested.
    workspace: false,
    tab: 'files',
    pane: 'conversation',
    // Keep the conversation as the primary surface.  The workspace is a
    // supporting inspector, so it should open at a useful but compact width.
    ratio: 56
  }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
    if (!value || typeof value !== 'object') return fallback
    const record = value as Record<string, unknown>
    const storedRatio = typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? record.ratio : null
    // 44% was the old default and made the workspace consume most of the
    // desktop on first launch.  Migrate only that untouched default; a user
    // who dragged the divider keeps their chosen ratio.
    const ratio = storedRatio === 44 ? 56 : storedRatio
    const workspace = record.workspace === true
    return {
      page: NAVIGATION.some((item) => item.id === record.page) ? (record.page as Page) : 'home',
      collapsed: record.collapsed === true,
      workspace,
      tab: (() => {
        const stored = String(record.tab)
        // Saved destinations must follow their replacement after navigation merges.
        if (stored === 'artifacts' || stored === 'activity' || stored === 'changes') return 'files'
        return ['files', 'workspace', 'sources', 'browser', 'subagents', 'git', 'terminal'].includes(stored)
          ? (stored as WorkspaceTab)
          : 'files'
      })(),
      pane: workspace && record.pane === 'workspace' ? 'workspace' : 'conversation',
      ratio: ratio === null ? 56 : Math.min(62, Math.max(35, ratio))
    }
  } catch {
    return fallback
  }
}

function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}
const workDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
function shortDate(value: number): string {
  return workDateFormatter.format(value)
}
function fileSize(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${Math.ceil(value / 1024)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`
}
function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

/** File links belong to this task; do not let the shared Markdown viewer route them through Code's selected workspace. */
function openWorkFileLink(
  event: MouseEvent<HTMLElement>,
  controller: WorkController,
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
  const artifact = findWorkArtifact(controller.artifacts, path, controller.activeTask.workspacePath)
  // A markdown link may point to a workspace file that has no write receipt.
  // Keep it in the Work surface as a synthetic artifact so the panel performs
  // the session-scoped read instead of silently routing through Code.
  openArtifact(artifact?.id ?? `path:${path}`)
}

/** Work has its own navigation and task state; keeping this root mounted preserves live work across mode changes. */
export function WorkView(): JSX.Element {
  const controller = useWorkController()
  const appMode = useAppMode()
  const browser = useBrowserState('work')
  const browserSource = getEngineSource()
  useLayoutEffect(() => {
    // The browser bridge must already know Work's task (or persisted home
    // session) when browser_open is the first tool, without a mounted panel.
    setBrowserSessionOverride(controller.securitySessionId, browserSource)
  }, [controller.securitySessionId, browserSource])
  useEffect(() => () => setBrowserSessionOverride(null), [])
  const [view, setView] = useState(initialView)
  const workspaceMotion = useMotionPresence(view.workspace)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [artifactSelection, setArtifactSelection] = useState<{ scope: string; id: string | null } | null>(null)
  const [fileRevealRequest, setFileRevealRequest] = useState<WorkFileRevealRequest | null>(null)
  const [terminalReveal, setTerminalReveal] = useState<{ scope: string; request: WorkTerminalPanelProps['reveal'] } | null>(null)
  const terminalRevision = useRef(0)
  const fileRevealRevision = useRef(0)
  const acknowledgeFileReveal = useCallback((request: WorkFileRevealRequest): void => {
    // A consumed opening must not replay over manual scroll/filter changes
    // when the workspace tab is closed and mounted again later.
    setFileRevealRequest(previous => previous === request ? null : previous)
  }, [])
  const conversationSelectionToggle = useRef<(() => void) | null>(null)
  const [conversationSelectMode, setConversationSelectMode] = useState(false)
  const [activitySelection, setActivitySelection] = useState<ActivitySelection | null>(null)
  const activityRevealRevision = useRef(0)
  const acknowledgeActivityReveal = useCallback((request: ActivitySelection): void => {
    // Completed navigation must not replay when history rows mount again.
    setActivitySelection(previous => previous === request ? null : previous)
  }, [])
  const [changeSelection, setChangeSelection] = useState<WorkArtifactSelection | null>(null)
  const [finalSelection, setFinalSelection] = useState<FinalSelection | null>(null)
  const [automationRequest, setAutomationRequest] = useState<{ jobId: string; revision: number } | null>(null)
  const automationRequestRevision = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const [compactNavigation, setCompactNavigation] = useState(window.innerWidth <= 1160)
  const [singlePane, setSinglePane] = useState(window.innerWidth <= 990)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const set = useCallback((patch: Partial<ViewState>): void =>
    setView((previous) => ({ ...previous, ...patch })), [])
  const task = controller.activeTask
  const latestUserMessageId = controller.messages.findLast(message => message.role === 'user')?.id
  const latestDeliveryKey = useMemo(() => workFinalResultCatalog(controller.messages, task?.id ?? '').deliveryKey,
    [controller.messages, task?.id])
  useEffect(() => {
    // Follow a new delivery, while text-only follow-ups leave the open file alone.
    setFinalSelection(null)
  }, [browserSource, task?.id, latestDeliveryKey])
  useEffect(() => {
    setChangeSelection(null)
  }, [browserSource, task?.id, latestUserMessageId])
  const fileTreeScope = JSON.stringify([browserSource, task?.id, task?.workspacePath ?? ''])
  // Filter before rendering children: an effect-only reset lets the old path
  // start a read using the newly selected task's session during that commit.
  const selectedArtifact = artifactSelection?.scope === fileTreeScope ? artifactSelection.id : null
  const setSelectedArtifact = useCallback((id: string | null): void => {
    setArtifactSelection({ scope: fileTreeScope, id })
  }, [fileTreeScope])
  const revealWorkspaceFile = useCallback((path: string): void => {
    setFileRevealRequest({ scope: fileTreeScope, path, revision: ++fileRevealRevision.current })
  }, [fileTreeScope])
  const fileResources = useWorkResources(task?.id ?? '')
  const fileResourceScope = fileTreeScope
  const handledFileReveal = useRef({ scope: fileResourceScope, revision: fileResources.reveal, selected: fileResources.selected })
  const activeTasks = useMemo(() => controller.tasks.filter((item) => !item.archived), [controller.tasks])
  const runningTasks = useMemo(() => getRunningWorkTasks(activeTasks), [activeTasks])
  const archivedTasks = useMemo(() => controller.tasks.filter((item) => item.archived), [controller.tasks])
  const sidebarTasks = useMemo(() => sortWorkSidebarTasks(activeTasks), [activeTasks])
  const sidebarArchivedTasks = useMemo(() => sortWorkSidebarTasks(archivedTasks), [archivedTasks])
  const waiting = useMemo(() => activeTasks.filter((item) => item.status === 'waiting').length, [activeTasks])
  const filteredTasks = useMemo(() => {
    const query = search.toLocaleLowerCase()
    return activeTasks.filter(item => (filter === 'all' || item.status === filter) && item.title.toLocaleLowerCase().includes(query))
  }, [activeTasks, filter, search])
  const revealRequestId = browser.revealRequest?.requestId ?? null
  const handledRevealRef = useRef<string | null>(null)
  useEffect(() => {
    // Selection in the unified Files pane is session scoped. Do not carry a
    // synthetic path from the previous task into a newly selected task.
    setSelectedArtifact(null)
    setChangeSelection(null)
    setActivitySelection(null)
    setConversationSelectMode(false)
  }, [task?.id, browserSource, task?.workspacePath, setSelectedArtifact])
  useEffect(() => {
    // Leaving before the reveal animation finishes cancels that navigation;
    // returning to a completed turn must not revive the old live request.
    if (view.page !== 'home' || appMode !== 'work') setActivitySelection(null)
  }, [view.page, appMode])
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view))
    } catch {
      /* Layout persistence must not block task execution. */
    }
  }, [view])
  useEffect(() => {
    // Opening through shared Markdown links registers a resource without a
    // surface callback. Consume new requests once; returning to a task must
    // not replay its last file opening over the user's selected surface.
    if (handledFileReveal.current.scope !== fileResourceScope) {
      handledFileReveal.current = { scope: fileResourceScope, revision: fileResources.reveal, selected: fileResources.selected }
      return
    }
    if (handledFileReveal.current.revision === fileResources.reveal && handledFileReveal.current.selected === fileResources.selected) return
    const foregroundRequest = handledFileReveal.current.revision !== fileResources.reveal
    handledFileReveal.current = { scope: fileResourceScope, revision: fileResources.reveal, selected: fileResources.selected }
    const file = fileResources.files.find(file => file.id === fileResources.selected)
    if (appMode !== 'work' || !task || !file) return
    // Resource tabs and Git previews share one active workspace file. Only
    // authenticated files from this task may move its tree selection.
    if (file.target?.sessionId === task.id && file.target.source === browserSource) {
      setSelectedArtifact(`path:${file.path}`)
      if (foregroundRequest) revealWorkspaceFile(file.path)
    }
    // Renames update resource identities without requesting navigation. Keep
    // the user's tree/history surface while its selected preview follows them.
    if (!foregroundRequest) return
    setView(previous => previous.page === 'home' && previous.workspace && previous.tab === 'browser' && previous.pane === 'workspace'
      ? previous
      : { ...previous, page: 'home', workspace: true, tab: 'browser', pane: 'workspace' })
  }, [appMode, task?.id, browserSource, fileResourceScope, fileResources.reveal, fileResources.selected, fileResources.files, revealWorkspaceFile])
  useEffect(() => {
    // Browser tool requests can arrive while Work's workspace is closed. Open
    // the owning surface before BrowserService waits for fresh native bounds.
    if (!revealRequestId || handledRevealRef.current === revealRequestId) return
    if (appMode !== 'work') return
    if (task && browser.revealRequest) {
      if (!workResourceBrowserTabs(browser.tabs, task.id).some(item => item.tabId === browser.revealRequest?.tabId)) return
      selectWorkResource(task.id, `web:${browser.revealRequest.tabId}`)
    }
    // A request for another task is still pending if the user opens it later.
    handledRevealRef.current = revealRequestId
    // Standalone browsing shares the task's tab identity, not its navigation.
    // Opening a local file must keep the surface the user is already using.
    setView((previous) => previous.page === 'browser' ? previous : !task
      ? { ...previous, page: 'browser' }
      :
      previous.page === 'home' && previous.workspace && previous.tab === 'browser' && previous.pane === 'workspace'
        ? previous
        : { ...previous, page: 'home', workspace: true, tab: 'browser', pane: 'workspace' }
    )
  }, [appMode, revealRequestId, task?.id])
  useEffect(() => {
    const ownsBrowserSurface =
      appMode === 'work' &&
      (view.page === 'browser' || (Boolean(task) &&
        view.page === 'home' && view.workspace && view.tab === 'browser'))
    if (appMode !== 'work' || ownsBrowserSurface) return
    let current = true
    void hideBrowserSurfaces(() => current && getAppMode() === 'work')
    return () => { current = false }
  }, [appMode, task?.id, view.page, view.workspace, view.tab, browser.tabs.length])
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) {
        setCompactNavigation(width <= 1160)
        setSinglePane(width <= 990)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Keep selection reconciliation out of render.  Artifact lists change while the
  // engine is streaming, and calling setState during render produces a warning and
  // can make the workspace flicker when the first artifact arrives.
  useEffect(() => {
    // A markdown link can target a workspace file without a write receipt. Keep
    // that synthetic `path:` selection alive while the session-scoped reader
    // loads it; the normal reconciliation below only applies to receipt IDs.
    if (selectedArtifact?.startsWith('path:')) return
    const hasSelection = controller.artifacts.some((item) => item.id === selectedArtifact)
    const next = controller.artifacts[0]?.id ?? null
    if (hasSelection || selectedArtifact?.startsWith('path:') || next === selectedArtifact) return
    setSelectedArtifact(next)
  }, [controller.artifacts, selectedArtifact, setSelectedArtifact])
  const navigate = useCallback((page: Page): void => {
    set(page === 'home' ? { page, workspace: false, pane: 'conversation' } : { page })
    setNavigationOpen(false)
    if (page === 'home') controller.showHome()
  }, [set, controller.showHome])
  const openTask = useCallback((id: string): void => {
    controller.selectTask(id)
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
  }, [set, controller.selectTask])
  useLayoutEffect(() => {
    const request = controller.draftFocusRequest
    if (request && request.source === getEngineStorageKey() && request.taskId === (controller.activeTask?.id ?? null))
      set({ page: 'home', pane: 'conversation' })
  }, [controller.draftFocusRequest, controller.activeTask?.id, set])
  const openConversation = useCallback((url: string): void => {
    try {
      const link = parseConversationLink(url)
      if (!link) throw new Error('会话链接格式不正确。')
      const target = conversationLinkTask(link)
      setAppMode('work')
      openTask(target.id)
    } catch (error) { toast.error(error instanceof Error ? error.message : '无法打开引用会话。') }
  }, [openTask])
  useEffect(() => {
    if (!controller.ready) return
    let draining = false
    let requested = false
    const drain = async (): Promise<void> => {
      if (draining) { requested = true; return }
      draining = true
      const epoch = getEngineSource()
      try {
        do {
          requested = false
          const links = await window.aether.conversationLinks.takePending()
          if (epoch !== getEngineSource()) {
            if (links.length) toast.info('连接已变化，请重新打开会话链接。')
            return
          }
          for (const link of links) openConversation(buildConversationLink(link))
        } while (requested)
      } catch (error) { toast.error(error instanceof Error ? error.message : '无法打开会话链接。') }
      finally { draining = false }
    }
    // Subscribe before draining so cold-start and already-running app links share one inbox.
    const off = window.aether.conversationLinks.onAvailable(() => { void drain() })
    void drain()
    return off
  }, [controller.ready, openConversation])
  const newTask = useCallback((): void => {
    controller.showHome()
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation', workspace: false })
    setSearch('')
    setFilter('all')
  }, [set, controller.showHome])
  useEffect(() => subscribeAutomationEditor(jobId => {
    setAutomationRequest({ jobId, revision: ++automationRequestRevision.current })
    setNavigationOpen(false)
    set({ page: 'automations' })
  }), [set])
  useEffect(() => {
    // A card opens a single draft; revisiting the management page must not replay it.
    if (view.page !== 'automations') setAutomationRequest(null)
  }, [view.page])
  const openAutomationRun = useCallback(async (run: CronAutomationRun): Promise<void> => {
    const source = getEngineSource()
    const storageSource = getEngineStorageKey()
    const snapshot = await requestOrThrow<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId: run.sessionId } })
    if (source !== getEngineSource()) throw new Error('引擎连接已变化，请重新打开运行记录。')
    if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== run.sessionId) throw new Error('运行会话返回了不匹配的历史。')
    const root = snapshot.run ?? snapshot.runs.at(-1)
    if (!root || root.sessionId !== run.sessionId) throw new Error('当前运行尚未建立可查看的会话。')
    flushWorkDrafts(storageSource)
    if (!getWorkState(storageSource).tasks.some(item => item.id === run.sessionId)) {
      const status: WorkTask['status'] = root.status === 'running' ? 'running' : root.status === 'waiting' ? 'waiting'
        : root.status === 'succeeded' ? 'done' : root.status === 'failed' ? 'error' : root.status === 'cancelled' ? 'stopped' : 'interrupted'
      updateWorkState(storageSource, previous => ({ ...previous, tasks: [{ id: run.sessionId, title: run.snapshot.name, draft: '', status,
        createdAt: root.createdAt, updatedAt: root.updatedAt, workspacePath: root.workspacePaths?.[0] ?? null,
        modelId: root.modelId || run.snapshot.effectiveModelId || '', agentId: run.snapshot.effectiveAgentId || run.snapshot.agentId,
        agentLocked: true, attachments: [], sources: [], origin: { kind: 'automation', jobId: run.jobId, runId: run.id } }, ...previous.tasks] }))
    }
    controller.selectTask(run.sessionId)
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
  }, [set, controller.selectTask])
  const openWorkspace = useCallback((tab: WorkspaceTab): void =>
    set({ workspace: true, tab, pane: 'workspace' }), [set])
  const openRunningTerminal = useCallback((): void => {
    if (!task) return
    const services = partitionWorkServices(controller.commandJobs, task.id)
    setTerminalReveal({ scope: JSON.stringify([browserSource, task.id]), request: {
      jobId: services.running[0]?.jobId ?? services.history[0]?.jobId ?? null,
      revision: ++terminalRevision.current
    } })
    openWorkspace('terminal')
  }, [task?.id, browserSource, controller.commandJobs, openWorkspace])
  useEffect(() => onWorkTerminalRequest(action => {
    if (appMode !== 'work') return
    if (!task) { toast.info('请先打开一个任务，再使用终端'); return }
    if (action === 'toggle' && view.page === 'home' && view.workspace && view.tab === 'terminal' && view.pane === 'workspace') {
      set({ workspace: false, pane: 'conversation' })
      return
    }
    // Start explicitly before mounting the view so its empty-state auto-create
    // cannot race the command palette's request for a new terminal.
    if (action === 'new') void createLocalSession(task.workspacePath ?? undefined, task.id)
    setTerminalReveal({ scope: JSON.stringify([browserSource, task.id]), request: {
      jobId: null, view: 'terminal', revision: ++terminalRevision.current
    } })
    set({ page: 'home', workspace: true, tab: 'terminal', pane: 'workspace' })
  }), [appMode, task?.id, task?.workspacePath, browserSource, view.page, view.workspace, view.tab, view.pane, set])
  const openSessionArtifacts = useCallback((request: ArtifactNavigation): void => {
    if (!task || request.sessionId !== task.id) return
    setFinalSelection(null)
    setChangeSelection(previous => ({ ...request, revision: (previous?.revision ?? 0) + 1 }))
    openWorkspace('files')
  }, [task?.id, openWorkspace])
  const openFinalItem = useCallback((result: FinalResult, item: FinalResultItem): void => {
    if (!task || result.sessionId !== task.id || !result.items.some(candidate => candidate.id === item.id)) return
    setChangeSelection(null)
    setFinalSelection(previous => ({ sessionId: result.sessionId, runId: result.runId, itemId: item.id, revision: (previous?.revision ?? 0) + 1 }))
    openWorkspace('files')
  }, [task?.id, openWorkspace])
  const openArtifact = useCallback((id: string, _openResource = true): void => {
    setFinalSelection(null)
    setSelectedArtifact(id)
    const artifact = !id.startsWith('path:') ? controller.artifacts.find(item => item.id === id) : null
    const path = id.startsWith('path:') ? id.slice(5) : artifact?.path
    if (path) revealWorkspaceFile(path)
    if (artifact && task) setChangeSelection(previous => ({ sessionId: task.id, path: artifact.path, view: 'current', revision: (previous?.revision ?? 0) + 1 }))
    // A file selection is a view change inside Work, not an instruction to
    // open the separate browser/resource surface. The preview resolves the
    // session-scoped path itself and keeps the conversation context stable.
    openWorkspace(id.startsWith('path:') ? 'workspace' : 'files')
  }, [openWorkspace, controller.artifacts, task?.id, revealWorkspaceFile, setSelectedArtifact])
  useWorkbenchClient(controller.securitySessionId, isEngineReady(), 'work', {
    context: () => ({ mode: 'work', selectedArtifact, files: controller.artifacts.slice(0, 100).map(item => ({ path: item.path, name: item.name, status: item.status })), hasMoreFiles: controller.artifacts.length > 100 }),
    open: async (path, _line, current) => {
      if (!current() || !controller.activeTask || controller.activeTask.id !== controller.securitySessionId) throw new Error('请先打开此任务的工作区。')
      const revision = requestWorkPreview(getEngineSource(), controller.securitySessionId, path)
      openArtifact(`path:${path}`)
      return waitForWorkPreview(controller.securitySessionId, path, current, revision)
    }
  })
  const setWorkspaceTab = useCallback((tab: WorkspaceTab): void => set({ tab }), [set])
  const closeWorkspace = useCallback((): void => {
    set({ workspace: false, pane: 'conversation' })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.work-task-heading button[aria-label="打开工作区"]')?.focus())
  }, [set])
  const setRatio = useCallback((ratio: number): void => set({ ratio }), [set])
  const openActivity = useCallback((toolId: string): void => {
    if (!task) return
    setActivitySelection({ taskId: task.id, toolId, revision: ++activityRevealRevision.current })
    set({ pane: 'conversation' })
  }, [task?.id, set])
  const openChange = useCallback((change: EngineFileChange): void => {
    if (!task || (change.sessionId && change.sessionId !== task.id)) return
    openSessionArtifacts({ sessionId: task.id, changeId: change.id, path: change.path, view: 'operation' })
  }, [task?.id, openSessionArtifacts])
  const newTaskRef = useRef(newTask)
  useLayoutEffect(() => {
    newTaskRef.current = newTask
  })
  useEffect(
    () =>
      registerCommand({
        id: 'aether.work.new',
        title: '新建 Work 任务',
        category: 'Work',
        run: () => {
          if (getAppMode() === 'work') newTaskRef.current()
        }
      }),
    []
  )

  return (
    <WorkReferenceProvider controller={controller} onSources={() => openWorkspace('sources')}
      onWorkspaceFile={path => openArtifact(`path:${path}`)} onArtifact={openArtifact}
      onBrowser={tabId => { selectBrowserTab(tabId); openWorkspace('browser') }}
      onAgent={() => navigate('agents')} onConversation={openConversation}>
    <div
      className="work-view"
      ref={rootRef}
      data-collapsed={view.collapsed}
      data-nav-open={compactNavigation && navigationOpen}
    >
      <MotionPresence show={compactNavigation && navigationOpen} asChild>
        <button
          className="work-navigation-scrim"
          type="button"
          aria-label="关闭导航抽屉"
          onClick={() => setNavigationOpen(false)}
        />
      </MotionPresence>
      <aside className="work-sidebar" aria-label="Work 导航">
        <div className="work-sidebar__top">
          <span className="work-sidebar__brand">我的工作</span>
          <IconButton
            icon="layout-sidebar"
            label={
              (compactNavigation ? !navigationOpen : view.collapsed)
                ? '展开 Work 导航'
                : '收起 Work 导航'
            }
            onClick={() =>
              compactNavigation
                ? setNavigationOpen(!navigationOpen)
                : set({ collapsed: !view.collapsed })
            }
          />
        </div>
        <button type="button" className="btn work-new-task" aria-label="新任务" onClick={newTask}>
          <Icon name="plus" size={16} />
          <span>新任务</span>
        </button>
        <nav className="work-navigation">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              type="button"
              className="work-navigation__item"
              aria-current={view.page === item.id ? 'page' : undefined}
              title={item.label}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.id === 'home' && (waiting > 0 || runningTasks.length > 0) && <b className="work-count"
                title={waiting ? `${waiting} 个任务等待处理` : `${runningTasks.length} 个任务运行中`}
                aria-label={waiting ? `${waiting} 个任务等待处理` : `${runningTasks.length} 个任务运行中`}
                data-waiting={waiting > 0 || undefined}>{waiting || runningTasks.length}</b>}
            </button>
          ))}
        </nav>
        <div className="work-sidebar__recent">
          <span className="work-eyebrow">最近任务</span>
          {sidebarTasks.map(item => <WorkSidebarTask key={`${browserSource}:${item.id}`} task={item} controller={controller}
            selected={task?.id === item.id && view.page === 'home'} onOpen={openTask} />)}
          {!activeTasks.length && <p>开始后，任务会保存在这里。</p>}
          {archivedTasks.length > 0 && (
            <details className="work-sidebar__archived">
              <summary>已归档 {archivedTasks.length}</summary>
              {sidebarArchivedTasks.map(item => <WorkSidebarTask key={`${browserSource}:${item.id}`} task={item} controller={controller}
                selected={task?.id === item.id && view.page === 'home'} onOpen={openTask} />)}
            </details>
          )}
        </div>
        <div className="work-sidebar__bottom">
          <span className="work-connection-status">
            <i data-ready={controller.ready} />
            <span>{controller.ready ? '引擎已连接' : '引擎未就绪'}</span>
          </span>
          <button
            type="button"
            className="work-navigation__item"
            title="设置"
            onClick={() => openAppSettings()}
          >
            <Icon name="settings" size={18} />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <main className="work-main" data-running-tasks={runningTasks.length ? 'true' : undefined}>
        {!(view.page === 'home' && task) ? <WorkRunList
          tasks={activeTasks}
          activeTaskId={task?.id ?? null}
          ready={controller.ready}
          onSelect={openTask}
          onStop={controller.stopTask}
        /> : null}
        {view.page === 'home' && task ? (
          <>
            <div
              className="work-task-body"
              data-workspace={workspaceMotion.present}
              data-pane={view.pane}
              style={{ '--work-conversation-ratio': `${view.ratio}%` } as CSSProperties}
            >
              <div className="work-task-primary">
                <header className="work-task-heading">
                  <div className="work-task-heading__title">
                    <button type="button" className="work-breadcrumb" onClick={newTask}>
                      工作台
                    </button>
                    <span aria-hidden="true">/</span>
                    <h1 title={`会话：${task.title}\n项目目录：${task.workspacePath ? filename(task.workspacePath) : '独立任务'}`}>{task.title}</h1>
                    {controller.agentId ? (
                      <button
                        type="button"
                        className="work-task-heading__agent"
                        aria-label="查看 Agent 配置"
                        title={controller.agentIdentity.error
                          ? `${controller.agentIdentity.error} · Agent ID：${controller.agentId}`
                          : `${controller.agentIdentity.name || controller.agentId}${controller.agentLocked ? ' · 当前任务使用的 Agent 已固定' : ''}`}
                        onClick={() => navigate('agents')}
                      >
                        <Icon name="account-outline" size={14} />
                        <span>{controller.agentIdentity.name || controller.agentId}</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="work-task-heading__actions">
                    {controller.sessionUsage && (controller.sessionUsage.total > 0 || controller.sessionUsage.unknownSubagents > 0) ? <UsageMeter
                      total={controller.sessionUsage.total} rounds={controller.sessionUsage.rounds} summary={controller.sessionUsage.summary}
                      messages={controller.messages} /> : null}
                    {controller.usageSyncNotice ? <span className="work-usage-notice" role="status" title={controller.usageSyncNotice}>统计待同步</span> : null}
                    <TaskStatus status={task.status} ready={controller.ready} />
                    <WorkRunList
                      tasks={activeTasks}
                      activeTaskId={task.id}
                      ready={controller.ready}
                      onSelect={openTask}
                      onStop={controller.stopTask}
                      inline
                    />
                    <WorkTaskActions
                      task={task}
                      controller={controller}
                      compact
                      showStop={false}
                      onSelectConversation={() => conversationSelectionToggle.current?.()}
                      conversationSelected={conversationSelectMode}
                      conversationDisabled={controller.messages.length === 0}
                    />
                    <WorkRootStop key={task.id} controller={controller} />
                    <IconButton
                      icon="layout-panel"
                      label={view.workspace ? '收起工作区' : '打开工作区'}
                      aria-pressed={view.workspace}
                      onClick={() =>
                        set({
                          workspace: !view.workspace,
                          pane: view.workspace ? 'conversation' : 'workspace'
                        })
                      }
                    />
                  </div>
                </header>
                <div className="work-mobile-tabs" aria-label="任务视图">
                  <button
                    type="button"
                    aria-pressed={view.pane === 'conversation'}
                    onClick={() => set({ pane: 'conversation' })}
                  >
                    协作对话
                  </button>
                  <button
                    type="button"
                    aria-pressed={view.pane === 'workspace'}
                    onClick={() => set({ workspace: true, pane: 'workspace' })}
                  >
                    工作区
                  </button>
                </div>
                <Conversation
                  key={`${getEngineSource()}:${task.id}`}
                  controller={controller}
                  active={!singlePane || !view.workspace || view.pane === 'conversation'}
                  openActivity={openActivity}
                  activitySelection={activitySelection?.taskId === task.id ? activitySelection : null}
                  onActivityRevealed={acknowledgeActivityReveal}
                  openChange={openChange}
                  openArtifact={openArtifact}
                  onOpenArtifacts={openSessionArtifacts}
                  onOpenFinalItem={openFinalItem}
                  selectionToggleRef={conversationSelectionToggle}
                  onSelectionModeChange={setConversationSelectMode}
                  onOpenTerminal={openRunningTerminal}
                />
              </div>
              {workspaceMotion.present && (
                <>
                  <WorkDivider ratio={view.ratio} setRatio={setRatio} />
                  <Workspace
                    key={`${getEngineSource()}:${task.id}`}
                    motionProps={workspaceMotion.motionProps}
                    controller={controller}
                    active={view.workspace && (!singlePane || view.pane === 'workspace')}
                    tab={view.tab}
                    setTab={setWorkspaceTab}
                    onClose={closeWorkspace}
                    selectedArtifact={selectedArtifact}
                    fileRevealRequest={fileRevealRequest?.scope === fileTreeScope ? fileRevealRequest : null}
                    onDidReveal={acknowledgeFileReveal}
                    selectArtifact={openArtifact}
                    changeSelection={changeSelection?.sessionId === task.id ? changeSelection : null}
                    finalSelection={finalSelection?.sessionId === task.id ? finalSelection : null}
                    onOpenArtifacts={openSessionArtifacts}
                    terminalReveal={terminalReveal?.scope === JSON.stringify([browserSource, task.id]) ? terminalReveal.request : null}
                  />
                </>
              )}
            </div>
          </>
        ) : view.page === 'home' ? (
          <div className="work-page work-home">
            <div className="work-page__inner">
              <SectionHeading
                eyebrow="WORK · 办公助手"
                title="今天，想完成什么？"
                description="交代目标、补充资料，把研究、写作和分析交给 AI 协作完成。"
              />
              <WorkComposerV2 controller={controller} home />
              <p className="work-capability-note">
                支持文件与 Agent 引用、技能与 MCP 资源、成果预览、活动追踪和自动化任务。
              </p>
              <div className="work-templates" aria-label="任务模板">
                {TEMPLATES.map((template) => (
                  <button
                    type="button"
                    key={template.title}
                    onClick={() => controller.setDraft(template.text)}
                  >
                    <Icon name={template.icon} size={17} />
                    <span>{template.title}</span>
                  </button>
                ))}
              </div>
              <section className="work-recent">
                <header>
                  <h2>最近任务</h2>
                  <span>{activeTasks.length} 项</span>
                </header>
                <div className="work-list-tools">
                  <div className="work-filters" aria-label="任务筛选">
                    {(
                      [
                        ['all', '全部'],
                        ['running', '进行中'],
                        ['waiting', '需要处理'],
                        ['done', '已完成']
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        type="button"
                        key={id}
                        aria-pressed={filter === id}
                        onClick={() => setFilter(id)}
                      >
                        {label}
                        {id === 'waiting' && waiting ? ` ${waiting}` : ''}
                      </button>
                    ))}
                  </div>
                  <label className="work-search">
                    <Icon name="search" size={14} />
                    <input
                      aria-label="搜索 Work 任务"
                      placeholder="搜索任务"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                </div>
                <TaskList
                  key={`${filter}:${search}`}
                  tasks={filteredTasks}
                  ready={controller.ready}
                  onSelect={openTask}
                  empty={
                    activeTasks.length
                      ? '没有符合筛选条件的任务。'
                      : '还没有任务。从上方写下你的目标，或选择一个模板开始。'
                  }
                />
              </section>
            </div>
          </div>
        ) : view.page === 'browser' ? (
          <section className="work-standalone-browser" aria-label="Work 浏览器">
            <header className="work-task-heading">
              <h1>浏览器</h1>
              <span className="work-note">浏览网页、查阅资料，随时开始工作。</span>
            </header>
            <WorkBrowser />
          </section>
        ) : view.page === 'projects' ? (
          <Projects controller={controller} openTask={openTask} />
        ) : view.page === 'connections' ? (
          <Connections ready={controller.ready} />
        ) : view.page === 'monitor' ? (
          <EngineMonitorView tasks={controller.tasks} />
        ) : view.page === 'agents' ? (
          <div className="work-page work-page--agents"><div className="work-page__inner work-page__inner--agents"><WorkAgentManager
            key={getEngineSource()}
            standalone
            returnToTask={Boolean(task)}
            onClose={() => set({ page: 'home' })}
            workspacePath={controller.workspacePath}
            selectedId={controller.agentId}
            locked={controller.agentLocked}
            onSelect={agent => {
              if (controller.setAgent(agent?.id ?? '')) navigate('home')
            }}
          /></div></div>
        ) : (
          <div className="work-page">
            <div className="work-page__inner">
              <SectionHeading title="自动化" description="让重复工作按计划执行。" />
              <AutomationsView ready={controller.ready} sessions={controller.tasks} currentSessionId={controller.activeTask?.id}
                currentAgentId={controller.agentId} thinkingMode={requestedThinkingMode(controller.thinkingMode)}
                openRequest={automationRequest} onOpenRun={openAutomationRun} onManageAgent={() => navigate('agents')} />
            </div>
          </div>
        )}
      </main>
    </div>
    </WorkReferenceProvider>
  )
}

function TaskStatus({ status, ready }: { status: WorkTask['status']; ready: boolean }): JSX.Element {
  // A lost observer cannot assert whether the durable run has reached a terminal state.
  const disconnected = !ready && (status === 'running' || status === 'waiting')
  return (
    <span className={`work-status work-status--${disconnected ? 'interrupted' : status}`}
      title={disconnected ? '连接中断，等待恢复确认' : undefined}>
      {disconnected ? <Icon name="warning" size={12} /> : status === 'running' ? (
        <Spinner size={12} />
      ) : (
        <Icon
          name={
            status === 'done'
              ? 'check'
              : status === 'error' || status === 'interrupted'
                ? 'warning'
                : status === 'waiting'
                  ? 'circle-dot'
                  : 'circle'
          }
          size={12}
        />
      )}
      {disconnected ? '连接中断' : STATUS_LABEL[status]}
    </span>
  )
}

function EmptyState({
  icon,
  title,
  description
}: {
  icon: IconName
  title: string
  description: string
}): JSX.Element {
  return (
    <div className="work-empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

function TaskList({
  tasks,
  ready,
  onSelect,
  empty
}: {
  tasks: WorkTask[]
  ready: boolean
  onSelect: (id: string) => void
  empty: string
}): JSX.Element {
  const [visibleCount, setVisibleCount] = useState(WORK_TASK_PAGE_SIZE)
  return tasks.length ? (
    <div className="work-task-list">
      {tasks.slice(0, visibleCount).map((task) => (
        <button
          type="button"
          className="work-task-row"
          key={task.id}
          onClick={() => onSelect(task.id)}
        >
          <Icon name="chat" size={17} />
          <span className="work-task-row__name">
            <strong>{task.title}</strong>
            <span>{task.workspacePath ? filename(task.workspacePath) : '独立任务'}</span>
          </span>
          <TaskStatus status={task.status} ready={ready} />
          <time dateTime={new Date(task.updatedAt).toISOString()}>{shortDate(task.updatedAt)}</time>
          <Icon name="chevron-right" size={14} />
        </button>
      ))}
      {visibleCount < tasks.length && <div className="work-list-pagination">
        <span>已显示 {Math.min(visibleCount, tasks.length)} / {tasks.length} 项任务</span>
        <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => count + WORK_TASK_PAGE_SIZE)}>显示更多任务</button>
      </div>}
    </div>
  ) : (
    <p className="work-list-empty">{empty}</p>
  )
}

function workConversationSummary(messages: ChatMessage[]): string {
  const user = messages.find((message) => message.role === 'user')
  const value = user?.content.replace(/\s+/g, ' ').trim()
  if (!value) return '未命名对话'
  return value.length > 72 ? `${value.slice(0, 72)}…` : value
}

function Conversation({
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
  controller: WorkController
  active: boolean
  openArtifact: (id: string) => void
  openActivity: (toolId: string) => void
  activitySelection: ActivitySelection | null
  onActivityRevealed: (request: ActivitySelection) => void
  openChange: (change: EngineFileChange) => void
  onOpenArtifacts: (request: ArtifactNavigation) => void
  onOpenFinalItem: (result: FinalResult, item: FinalResultItem) => void
  onOpenTerminal: () => void
  selectionToggleRef: MutableRefObject<(() => void) | null>
  onSelectionModeChange: (active: boolean) => void
}): JSX.Element {
  const { engine } = useApp()
  const task = controller.activeTask!
  const positionKey = `${getEngineSource()}:${task.id}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(conversationPositions.get(positionKey)?.follow ?? true)
  const mode = useAppMode()
  const [following, setFollowing] = useState(followRef.current)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const latestRequest = useRef(false)
  const [latestPending, setLatestPending] = useState(false)
  const hasNewerContentRef = useRef(false)
  const [bottomRequest, setBottomRequest] = useState(0)
  const measureScrollPosition = useCallback((): boolean | null => {
    const element = scrollRef.current
    const away = element ? workConversationAwayFromBottom(element) : null
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
  const scrollIntent = useWorkConversationScrollIntent(scrollRef, pauseFollowing, resumeFollowing, measureScrollPosition)
  const pauseReading = useCallback((): void => {
    scrollIntent.reset()
    pauseFollowing()
  }, [scrollIntent.reset, pauseFollowing])
  const followBottom = useCallback((): void => {
    const element = scrollRef.current
    if (!element || !active || mode !== 'work' || !followRef.current || !element.clientHeight) return
    element.scrollTop = element.scrollHeight
    const away = measureScrollPosition()
    if (latestRequest.current && !hasNewerContentRef.current && away === false) {
      latestRequest.current = false
      setLatestPending(false)
    }
  }, [active, mode, measureScrollPosition])
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const previousFileResolver = useRef<ChatFileContext['resolveInlineFile']>(undefined)
  const resolveInlineFile = useMemo(() => {
    const resolver = buildWorkInlineFileResolver(controller.messages, task.id, task.workspacePath, previousFileResolver.current)
    previousFileResolver.current = resolver
    return resolver
  }, [controller.messages, task.id, task.workspacePath])
  const fileContext = useMemo<ChatFileContext>(() => ({ sessionId: task.id, workspaceRoot: task.workspacePath, resolveInlineFile }), [task.id, task.workspacePath, resolveInlineFile])
  const onFileLink = useCallback((event: MouseEvent<HTMLElement>): void => openWorkFileLink(event, controllerRef.current, engine.snapshot.baseUrl, openArtifact), [engine.snapshot.baseUrl, openArtifact])
  const openActivityFile = useCallback((path: string): void => {
    openArtifact(`path:${path}`)
  }, [openArtifact])
  const respond = useCallback<WorkController['respond']>((...args) => controllerRef.current.respond(...args), [])
  const restartFailedTask = useCallback<WorkController['restartFailedTask']>((...args) => controllerRef.current.restartFailedTask(...args), [])
  const editSettledTurn = useCallback<WorkController['editSettledTurn']>((...args) => controllerRef.current.editSettledTurn(...args), [])
  const userMessageAction = useCallback<WorkController['userMessageAction']>((...args) => controllerRef.current.userMessageAction(...args), [])
  const recoverableMessageId = useMemo(() => {
    if (controller.streaming || controller.launching || controller.messageActionBusy || controller.pending.length || ['running', 'waiting'].includes(task.status)) return null
    const last = controller.messages.at(-1)
    return last && recoverWorkTurn(controller.messages, last.id) ? last.id : null
  }, [controller.messages, controller.streaming, controller.launching, controller.messageActionBusy, controller.pending.length, task.status])
  const restartPresentations = useMemo(() => {
    const queue = controller.nextTurnQueue
    const read = queue.state ? { state: queue.state, dispatchError: queue.error || controller.historyError || undefined } : null
    return new Map(controller.messages.filter(message => message.run && message.error).map(message =>
      [message.id, workTaskRestart(task.id, message.run!.runId, read, controller.messages)]))
  }, [controller.messages, controller.nextTurnQueue.state, controller.nextTurnQueue.error, controller.historyError, task.id])
  const restartableMessageId = !controller.streaming && !controller.launching && !controller.pending.length
    ? controller.messages.findLast(message => message.role === 'assistant')?.id : undefined
  const [firstId, setFirstId] = useState<string | null>(() => conversationPositions.get(positionKey)?.firstId ?? null)
  const lastMountedStart = useRef<number | undefined>(undefined)
  // Keep selection local to a task. Work selects complete conversation turns
  // (the user request together with the Agent response), so exporting one
  // item never produces a contextless half of a turn.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const expandedHistory = useRef(conversationPositions.get(positionKey)?.expanded ?? false)
  const [historyBrowsing, setHistoryBrowsing] = useState(expandedHistory.current)
  const setExpandedHistory = useCallback((value: boolean): void => {
    expandedHistory.current = value
    setHistoryBrowsing(value)
  }, [])
  const { start, end, newer } = useMemo(() => workMessageRange(controller.messages, following ? null : firstId, following ? undefined : lastMountedStart.current), [controller.messages, firstId, following])
  lastMountedStart.current = start
  const hasNewerContent = newer > 0 || Boolean(controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages)
  hasNewerContentRef.current = hasNewerContent
  const showLatest = latestPending || hasNewerContent || awayFromBottom
  const conversationGroups = useMemo(() => workConversationGroups(controller.messages), [controller.messages])
  const turnTodos = useMemo(() => controller.assignTodos(conversationGroups.map(group => ({
    id: group.id, identity: group.identity,
    owners: group.messages.flatMap(message => [message.conversationId ? `conversation:${message.conversationId}` : '', message.runId ? `run:${message.runId}` : '']).filter(Boolean)
  }))), [controller.assignTodos, conversationGroups, controller.todos])
  // Legacy and interrupted turns have durable edits but no published manifest.
  // Keep their review entry without promoting those edits to final deliveries.
  const receiptGroups = useMemo(() => conversationGroups.filter(group => {
    const answer = group.messages.findLast(message => message.role === 'assistant')
    return answer && !getMessageFinalResult(answer, task.id)
  }), [conversationGroups, task.id])
  const receiptTools = useMemo(() => receiptGroups.flatMap(group => group.messages.flatMap(message => message.tools)), [receiptGroups])
  const progress = useWorkProgressChanges(task.id, receiptTools, task.workspacePath, active && receiptGroups.length > 0, receiptGroups)
  const turnChanges = useMemo(() => workTurnProgressChanges(task.id, conversationGroups, progress.changes, task.workspacePath),
    [task.id, conversationGroups, progress.changes, task.workspacePath])
  const displayTurns = useMemo(() => workGroupedDisplayTurns(conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds), [conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds])
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
  const selectableGroups = useMemo(() => conversationGroups.filter(group => workConversationComplete(group, controller.displayTurns, controller.displayLoadedTurnIds)),
    [conversationGroups, controller.displayTurns, controller.displayLoadedTurnIds])
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
    setFirstId(controller.messages[Math.min(index, Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE))].id)
  }, [activitySelection])
  useEffect(() => {
    const container = scrollRef.current
    if (!activitySelection || !container || !active) return
    // A mounted row can still move while its disclosure grows. Reveal after
    // the actual ancestor transitions settle, without guessing a timer or
    // following later stream updates once the user has reached the receipt.
    let disposed = false, settling = false
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
    if (!expandedHistory.current && followRef.current && !copying && controller.messages.length > WORK_MESSAGE_PAGE_SIZE) {
      const next = controller.messages[controller.messages.length - WORK_MESSAGE_PAGE_SIZE].id
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
    if (!element || !active || mode !== 'work') return
    followBottom()
    measureScrollPosition()
  }, [controller.messages, controller.todos, controller.loading, controller.streaming, controller.launching, mode, firstId, historyBrowsing, bottomRequest, active, followBottom, measureScrollPosition])
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !active || mode !== 'work') return
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
  }, [active, mode, measureScrollPosition, followBottom])
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
    setFirstId(controller.messages[Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE)]?.id ?? null)
    setBottomRequest(value => value + 1)
  }
  const loadEarlier = (): void => {
    setExpandedHistory(true)
    const element = scrollRef.current
    const anchor = controller.messages[start]
    const article = anchor && element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (element && article) prependAnchor.current = { id: anchor.id, offset: article.getBoundingClientRect().top - element.getBoundingClientRect().top }
    pauseReading()
    setFirstId(controller.messages[Math.max(0, start - WORK_MESSAGE_PAGE_SIZE)].id)
  }
  const loadNewer = (): void => {
    const nextStart = Math.min(Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE), start + WORK_MESSAGE_PAGE_SIZE)
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
    setSelectMode((value) => !value)
    setSelectedIds(new Set())
  }, [])
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
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const allSelected = selectableGroups.length > 0 && selectableGroups.every((group) => selectedIds.has(group.id))
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableGroups.map((group) => group.id)))
  }, [allSelected, selectableGroups])
  const selectedGroups = useMemo(
    () => selectableGroups.filter((group) => selectedIds.has(group.id)),
    [selectableGroups, selectedIds]
  )
  const buildExportText = useCallback(() => {
    // The conversation is windowed for performance; export still uses the
    // complete task history so older messages are never silently omitted.
    return serializeMessages(selectedGroups.flatMap((group) => group.messages))
  }, [selectedGroups])
  const copySelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setSelectionNotice(`已复制 ${selectedGroups.length} 轮对话`)
        setSelectMode(false)
        setSelectedIds(new Set())
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
    setFirstId(controller.messages[atLatest ? Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE) : 0]?.id ?? null)
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
      <WorkRevertNotice sessionId={task.id} />
      <PublishedRecoveryNotice state={controller.publishedRecovery} onCancel={controller.cancelPublishedRecovery} onLoadBody={controller.loadPublishedBody} onRetry={controller.retryPublishedRecovery} />
      <MotionPresence show={selectMode}>
        <div className="work-conversation__select-bar" role="toolbar" aria-label="对话选择工具栏">
          <div className="work-conversation__selection-controls">
            <div className="work-conversation__selection-leading">
              <label className="work-conversation__select-all" title="选择或取消所有已完整加载的对话">
                <WorkSelectionCheckbox checked={allSelected} mixed={!allSelected && selectedGroups.length > 0}
                  disabled={!selectableGroups.length} label="全选对话" onChange={toggleAll} />
                <span>全选</span>
              </label>
              <span className="work-conversation__selection-count" role="status" aria-live="polite">已选 {selectedGroups.length} 轮</span>
            </div>
            <div className="work-conversation__selection-actions">
              <button type="button" className="work-conversation__selection-button" disabled={selectedGroups.length === 0} onClick={copySelected}><Icon name="copy" size={14} />复制</button>
              <button type="button" className="work-conversation__selection-button" disabled={selectedGroups.length === 0} onClick={exportSelected}><Icon name="upload-outline" size={14} />导出</button>
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
        <WorkServiceTray sessionId={task.id} jobs={controller.commandJobs} active={active} placement="rail" onOpenTerminal={onOpenTerminal} />
        <WorkMessageNav sessionKey={positionKey} messages={controller.messages} groups={conversationGroups}
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
            // Supplements share the reply, but regeneration belongs to the
            // original admission. Partial history must not retry a supplement.
            const originalMessage = group.messages.find(message => message.role === 'user' && !message.rootFollowup &&
              (!finalMessage?.run?.userMessageId || message.id === finalMessage.run.userMessageId))
            const finalResult = finalMessage ? getMessageFinalResult(finalMessage, task.id) : undefined
            const gap = historyGaps.get(group.id)
            const complete = selectableGroups.includes(group)
            return (
              <section key={group.id} data-turn-id={group.id} className={`work-conversation-turn${selectMode ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`}>
                {gap ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.displayHistoryLoading} onClick={() => loadDisplayHistory(gap.anchor)}>加载前面的 {gap.count} 轮对话</button> : null}
                <MotionPresence show={selectMode}>
                  <header className="work-conversation-turn__header">
                    <label className="work-conversation-turn__pick" title={complete ? `选择完整一轮对话（${group.messages.length} 条消息）` : '请先加载完整对话'}>
                      <WorkSelectionCheckbox
                        checked={selected}
                        disabled={!complete}
                        onChange={() => toggleConversation(group.id)}
                        label={`选择第 ${group.order ?? index + 1} 轮对话`}
                      />
                      <span>第 {group.order ?? index + 1} 轮</span>
                    </label>
                    <span className="work-conversation-turn__summary" title={workConversationSummary(group.messages)}>{workConversationSummary(group.messages)}</span>
                  </header>
                </MotionPresence>
                {workConversationEntries(group).map(({ key, message, segments, processKey }) => (
                  <WorkMessage
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
                    restartFailedTask={restartFailedTask}
                    restart={restartPresentations.get(message.id)}
                    canRestart={message.id === restartableMessageId && Boolean(message.run && ['failed', 'interrupted'].includes(message.run.status))}
                    editSettledTurn={editSettledTurn}
                    userMessageAction={userMessageAction}
                    regenerateMessageId={message === finalMessage && !workMessageRunning(message) ? originalMessage?.id : undefined}
                    showUserActions={!selectMode}
                    messageActionBusy={controller.messageActionBusy}
                    canMutateMessage={controller.ready && controller.historyReady && !controller.uploading && !controller.streaming && !controller.launching && !controller.pending.length && !['running', 'waiting'].includes(task.status)}
                    taskId={task.id}
                    canRecover={message.id === recoverableMessageId}
                    canRetry={controller.ready && controller.historyReady && !controller.uploading && (!controller.messageActionBusy || controller.restartPending)}
                    canRespond={mode === 'work' && controller.ready && controller.historyReady}
                    openChange={openChange}
                    revealTool={activitySelection && (segments
                      ? segments.some(segment => segment.kind === 'tools' && segment.tools.some(tool => tool.id === activitySelection.toolId))
                      : message.tools.some(tool => tool.id === activitySelection.toolId)) ? activitySelection : null}
                  />
                ))}
                {finalResult?.items.length ? <WorkFinalDeliverables result={finalResult} active={active} onOpenItem={onOpenFinalItem} /> : null}
                {turnTodos.has(group.id) ? <WorkTodoProgress todos={turnTodos.get(group.id)!} running={Boolean(finalMessage && workMessageRunning(finalMessage))} /> : null}
                {!finalResult && turnChanges.get(group.id)?.length ? <WorkProgressPanel sessionId={task.id} turnKey={group.id}
                  changes={turnChanges.get(group.id)!} workspacePath={task.workspacePath}
                  streaming={controller.streaming || controller.launching || ['running', 'waiting'].includes(task.status)} sync={progress}
                  scopedToTurn={workProgressTurnScope(task.id, group).kind === 'turn'} onOpenFile={openActivityFile} onOpenChange={openChange}
                  onShowChanges={() => onOpenArtifacts({ sessionId: task.id, turnScope: workProgressTurnScope(task.id, group) })} /> : null}
              </section>
            )
          })}
          {newer > 0 ? <button type="button" className="btn btn--sm work-history-load" onClick={loadNewer}>查看较新消息（{newer} 条）</button> : null}
          {newer === 0 && controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.archiveLoading} onClick={() => loadArchivePage('newer')}>查看较新归档页</button> : null}
          <WorkTurnFeedback controller={controller} announce={!showLatest} openActivity={openActivity} />
          {receiptGroups.length ? <WorkProgressSync state={progress} /> : null}
          {turnTodos.has('') ? <WorkTodoProgress todos={turnTodos.get('')!} running={controller.streaming || controller.launching || ['running', 'waiting'].includes(task.status)} /> : null}
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
        {showLatest && <WorkRunStatus controller={controller} />}
        <WorkNextTurnQueuePanel key={`queue:${controller.draftSource}:${task.id}`} scopeKey={`${controller.draftSource}:${task.id}`} queue={controller.nextTurnQueue} />
        <SessionConnectionNotice key={`connection:${controller.draftSource}:${task.id}`} ready={controller.ready} sessionId={task.id}
          source={getEngineSource()} connection={controller.historyRecovery}
          active={controller.streaming || ['running', 'waiting'].includes(task.status)}
          error={controller.historyError} onRetry={controller.retryHistory} />
        <WorkComposerV2 controller={controller} onPreserveReading={() => {
          // A card or composer resize can briefly create a gap before the
          // ResizeObserver catches up. Preserve intent, not that transient gap.
          if (!followRef.current) pauseReading()
        }} />
      </div>
    </section>
  )
}

/** Only real engine events change the phase; elapsed time never invents progress. */
function useWorkRunFeedback(controller: WorkController) {
  const mode = useAppMode()
  const [now, setNow] = useState(Date.now)
  const waiting = controller.pending.length > 0
  const recovering = !controller.ready || Boolean(controller.historyRecovery &&
    (controller.historyRecovery.phase === 'blocked' || controller.historyRecovery.failures > 0 &&
      ['connecting', 'retrying'].includes(controller.historyRecovery.phase)))
  const active = !recovering && (controller.streaming || controller.launching || controller.stopping || waiting)
  const message = controller.messages.findLast((item) => item.role === 'assistant')
  const current = message && (controller.stopping || ['streaming', 'waiting'].includes(message.status)) ? message : null
  const startedAt = current?.run?.startedAt ?? current?.startedAt ?? current?.createdAt
    ?? (controller.launching ? controller.activeTask?.createdAt : undefined)
  const running = current
    ? [...current.tools].reverse().find((tool) => tool.state === 'running' && isVisibleToolActivity(tool))
    : null
  const compacting = current?.run?.compaction?.phase === 'running'
  const thinking = current?.items?.at(-1)?.kind === 'thinking' || Boolean(current && !current.items?.length && current.thinking && !current.content && !running)
  const phase = controller.stopping
    ? 'stopping'
    : controller.launching
    ? 'preparing'
    : waiting
      ? 'waiting'
      : compacting
        ? 'compacting'
        : running
          ? 'tool'
          : thinking
            ? 'thinking'
            : current?.content
              ? 'generating'
              : 'processing'
  const label = controller.stopping
    ? '正在停止任务…'
    : controller.launching
    ? '正在准备任务…'
    : waiting
      ? controller.pending.some((item) => item.kind === 'permission')
        ? '等待确认'
        : '等你补充'
      : compacting
        ? '正在自动压缩上下文…'
        : running
          ? `${running.name === 'subagent' || running.subagent ? workSubagentName(running) : toolDisplayName(running.name)}…`
          : thinking
            ? '正在思考…'
            : current?.content
              ? '正在生成回复…'
              : '等待 Agent 响应…'

  useEffect(() => {
    if (!active || mode !== 'work') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, mode])

  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const elapsed =
    seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return { active, waiting, phase, label, elapsed, seconds, running }
}

/** The first response must be visible in the conversation, including the
 * preflight before the engine has emitted any assistant text or tool frames. */
function WorkTurnFeedback({ controller, announce, openActivity }: {
  controller: WorkController
  announce: boolean
  openActivity: (toolId: string) => void
}): JSX.Element | null {
  // Scrolling changes which status is announced, not whether this live card's
  // elapsed time advances: it can remain visible beside the fixed status.
  const feedback = useWorkRunFeedback(controller)
  const target = feedback.running ? workToolTarget(feedback.running, controller.workspacePath) : ''
  const fullTarget = feedback.running ? workToolTarget(feedback.running, undefined, true) : ''
  const activityLabel = feedback.running ? toolDisplayName(feedback.running.name) : ''
  const { triggerProps, tooltip } = useHoverDetail({ enabled: feedback.active && Boolean(fullTarget), label: activityLabel,
    content: <><div className="logline-hover__heading"><strong>{activityLabel}</strong></div><div className="logline-hover__target">{fullTarget}</div></> })
  if (!feedback.active) return null
  const agentName = feedback.running && (feedback.running.name === 'subagent' || feedback.running.subagent)
    ? workSubagentName(feedback.running)
    : controller.agentIdentity.name || 'Agent'
  const detail = feedback.phase === 'stopping'
    ? '正在停止当前任务，已生成的内容会保留。'
    : feedback.phase === 'preparing'
    ? '正在连接任务会话，准备开始执行。'
    : feedback.phase === 'waiting'
      ? '请回复上方的问题或确认请求，任务会继续执行。'
      : feedback.phase === 'compacting'
        ? '正在整理上下文，完成后继续当前任务。'
        : feedback.phase === 'thinking'
          ? 'Agent 已开始分析任务，结果会接着显示在这里。'
          : feedback.phase === 'generating'
            ? '回复正在生成，可以随时停止。'
            : feedback.phase === 'tool'
              ? target || '正在执行操作，点击可查看活动详情。'
              : feedback.seconds >= 15
                ? '暂未收到回复内容，可以继续等待或停止任务。'
                : '任务已发送，正在等待首个响应。'
  return (
    <><div className="work-turn-feedback" data-phase={feedback.phase} data-state={feedback.waiting ? 'waiting' : 'running'} data-current-run-feedback={announce ? 'true' : undefined} aria-label="Agent 执行反馈">
      <span className="work-turn-feedback__indicator" aria-hidden="true">
        {feedback.waiting ? <Icon name="chat" size={16} /> : <Spinner size={16} />}
      </span>
      <div className="work-turn-feedback__body">
        <div className="work-turn-feedback__heading">
          <strong title={agentName}>{agentName}</strong>
          <span role="status" aria-live={announce ? 'polite' : 'off'} aria-label="任务运行状态">{feedback.label}</span>
          <div className="work-turn-feedback__controls">
            <WorkRootStop controller={controller} compact />
            <span className="work-turn-feedback__elapsed" title="本轮累计用时（含等待）">{feedback.elapsed}</span>
          </div>
        </div>
        {feedback.running ? (
          <button {...triggerProps} type="button" className="work-turn-feedback__activity" aria-label="查看正在执行的活动" onClick={() => openActivity(feedback.running!.id)}>
            <span>{detail}</span><Icon name="chevron-right" size={12} />
          </button>
        ) : <p>{detail}</p>}
      </div>
    </div>{tooltip}</>
  )
}

/** Root cancellation stays discoverable when the conversation pane is hidden. */
function WorkRootStop({ controller, compact = false }: { controller: WorkController; compact?: boolean }): JSX.Element | null {
  const stopping = controller.stopping
  const active = controller.pendingInitialStart || controller.streaming || controller.launching || stopping || controller.pending.length > 0 || ['running', 'waiting'].includes(controller.activeTask?.status ?? '')
  if (!active) return null
  return <button className={compact ? 'work-quiet-button work-run-stop' : 'btn btn--sm'} type="button"
    aria-label={stopping ? '正在停止任务' : '停止任务'} aria-busy={stopping} title={stopping ? '正在停止任务' : '停止当前任务'}
    disabled={!controller.ready || stopping} onClick={() => {
    if (stopping) return
    void controller.stop().catch(reportError)
  }}>
    {stopping ? <Spinner size={13} /> : <Icon name="stop" size={13} />}
    {compact ? stopping ? '停止中' : '停止' : stopping ? '正在停止…' : '停止任务'}
  </button>
}

/** Reading earlier messages keeps one compact status beside the composer. */
function WorkRunStatus({ controller }: { controller: WorkController }): JSX.Element | null {
  const feedback = useWorkRunFeedback(controller)
  if (!feedback.active) return null
  const { waiting, elapsed } = feedback
  return (
    <div
      className="work-run-status"
      data-current-run-feedback="true"
      data-state={waiting ? 'waiting' : 'running'}
      data-phase={feedback.phase}
    >
      <div
        className="work-run-status__label"
        role="status"
        aria-live="polite"
        aria-label="任务运行状态"
      >
        {waiting ? <Icon name="chat" size={14} /> : <Spinner size={13} />}
        <span>{feedback.label}</span>
      </div>
      <WorkRootStop controller={controller} compact />
      <span className="work-run-status__elapsed" title="本轮累计用时（含等待）">
        {elapsed}
      </span>
    </div>
  )
}

const WorkMessage = memo(function WorkMessage({
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
  turnSegments?: import('./work-message-timeline').WorkMessageSegment[]
  processKey?: string
  deliveryResult?: FinalResult
  usage?: import('../chat/ConversationUsage').TurnUsageInfo
  active: boolean
  fileContext: ChatFileContext
  onFileLink: (event: MouseEvent<HTMLElement>) => void
  openFile: (path: string) => void
  respond: WorkController['respond']
  restartFailedTask: WorkController['restartFailedTask']
  restart?: WorkTaskRestartPresentation
  canRestart: boolean
  editSettledTurn: WorkController['editSettledTurn']
  userMessageAction: WorkController['userMessageAction']
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
    message.interactions?.filter((item) => item.status === 'pending') ??
    (message.pending ? [message.pending] : []), [message.interactions, message.pending])
  return (
    <WorkMessageContent
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
      replyActions={showUserActions && regenerateMessageId ? <WorkRegenerateReplyButton taskId={taskId} messageId={regenerateMessageId}
        canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
      userActions={showUserActions ? <WorkUserMessageActions taskId={taskId} messageId={message.id} content={message.content}
        canMutate={canMutateMessage} busy={messageActionBusy} onAction={userMessageAction} /> : null}
    >
      {message.error ? <WorkErrorNotice error={message.error} context={message.run} compact
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
        <WorkPending
          key={JSON.stringify([getEngineSource(), taskId, item.runId, item.requestId, item.toolCallId])}
          pending={item}
          sessionId={taskId}
          disabled={!active || !canRespond}
          respond={respond}
        />
      ))}
      {message.answered && <p className="work-note">已回复：{message.answered}</p>}
    </WorkMessageContent>
  )
})

function WorkPending({
  pending,
  sessionId,
  disabled,
  respond
}: {
  pending: PendingInteraction
  sessionId: string
  disabled: boolean
  respond: WorkController['respond']
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
  const blocked = disabled || submitting !== null || !pending.requestId
  const reply = async (replyValues: string[], fullAccess = false): Promise<void> => {
    const operation = scope.current
    const isCurrent = (): boolean => Boolean(operation?.current && !disabled &&
      source === getEngineSource() && isEngineReady() && getAppMode() === 'work' &&
      getWorkState(getEngineStorageKey()).activeTaskId === sessionId)
    if (busy.current || !isCurrent() || !pending.requestId || (fullAccess && !isPermission)) return
    busy.current = true
    setSubmitting(fullAccess ? 'full-access' : 'reply')
    setError('')
    let modeChanged = false
    try {
      if (fullAccess) {
        await changeSecurityMode(sessionId, 'full-access')
        modeChanged = true
      }
      // The controller wrapper follows the selected task. Never let a late
      // mode update submit the old approval through a different task's controller.
      if (!isCurrent()) return
      await respond(pending.requestId, replyValues)
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
      className="work-pending"
      aria-busy={submitting !== null}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <h3>{pending.kind === 'permission' ? '需要你的确认' : '请补充一下'}</h3>
      {isPermission ? <>
        <p className="work-pending__question">{pending.question}</p>
        <div className="work-pending__actions">
          {pending.options.map(option => <button
            key={option.value}
            type="button"
            className={`btn btn--sm${option.value === 'approved' ? ' btn--primary' : ''}`}
            disabled={blocked}
            title={option.description}
            onClick={() => void reply([option.value])}
          >{option.label}</button>)}
        </div>
        <div className="work-pending__footer">
          <button type="button" className="btn btn--sm btn--danger-ghost"
            disabled={blocked}
            title="仅对本会话生效：后续命令不再询问，并放行当前操作；同时解除工作区路径限制"
            onClick={() => void reply(['approved'], true)}>
            <Icon name="shield" size={14} />
            {submitting === 'full-access' ? '切换并放行中…' : '本会话改为完全访问并放行'}
          </button>
        </div>
      </> : pending.groups.map((group, index) => (
        <fieldset key={index} disabled={blocked}>
          <legend>{group.question}</legend>
          {group.options.map((option) => (
            <label className="work-pending__option" key={option.value}>
              <input
                type={group.multiSelect ? 'checkbox' : 'radio'}
                name={`${pending.toolCallId}-${index}`}
                checked={values[index]?.includes(option.value) ?? false}
                onChange={(event) =>
                  setValues((previous) =>
                    previous.map((list, groupIndex) =>
                      groupIndex !== index
                        ? list
                        : group.multiSelect
                          ? event.target.checked
                            ? [...list, option.value]
                            : list.filter((value) => value !== option.value)
                          : [option.value]
                    )
                  )
                }
              />
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {group.allowInput && (
            <input
              aria-label={`补充回答：${group.question}`}
              placeholder="也可以直接输入…"
              value={freeText[index] ?? ''}
              onChange={(event) =>
                setFreeText((previous) =>
                  previous.map((value, groupIndex) =>
                    groupIndex === index ? event.target.value : value
                  )
                )
              }
            />
          )}
        </fieldset>
      ))}
      {error ? <p className="work-pending__error" role="alert">{error}</p> : null}
      {!isPermission ? <button
        className="btn btn--primary"
        type="submit"
        disabled={blocked || answers.some((answer) => !answer)}
      >
        {submitting ? '正在提交…' : '提交回复'}
      </button> : null}
      {submitting ? <span className="work-pending__status" role="status">{submitting === 'full-access' ? '正在切换权限并放行当前操作…' : '正在提交回复…'}</span> : null}
    </form>
  )
}

function WorkDivider({
  ratio,
  setRatio
}: {
  ratio: number
  setRatio: (ratio: number) => void
}): JSX.Element {
  const drag = useRef<{ element: HTMLDivElement; parent: HTMLElement; startX: number; startRatio: number; width: number; next: number } | null>(null)
  const frame = useRef<number | null>(null)
  const paint = (): void => {
    const current = drag.current
    if (!current) return
    current.parent.style.setProperty('--work-conversation-ratio', `${current.next}%`)
    current.element.setAttribute('aria-valuenow', String(Math.round(current.next)))
  }
  const finish = (commit: boolean): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const current = drag.current
    if (!current) return
    if (commit) {
      paint()
      setRatio(current.next)
    } else {
      current.parent.style.setProperty('--work-conversation-ratio', `${current.startRatio}%`)
      current.element.setAttribute('aria-valuenow', String(Math.round(current.startRatio)))
    }
    drag.current = null
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])
  return (
    <div
      className="work-divider"
      role="separator"
      aria-label="调整对话与工作区宽度"
      aria-orientation="vertical"
      aria-valuemin={35}
      aria-valuemax={62}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          setRatio(workPaneRatio(ratio, 0, event.key === 'ArrowLeft' ? -2 : 2, 100))
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        const parent = event.currentTarget.parentElement
        if (!parent) return
        // Measure once; pointer moves paint locally instead of rerendering both panes.
        drag.current = { element: event.currentTarget, parent, startX: event.clientX, startRatio: ratio, width: parent.clientWidth, next: ratio }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.next = workPaneRatio(current.startRatio, current.startX, event.clientX, current.width)
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paint() })
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (current) current.next = workPaneRatio(current.startRatio, current.startX, event.clientX, current.width)
        finish(true)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
    />
  )
}

function WorkPanelDivider({
  ratio,
  setRatio,
  label,
  min = 20,
  max = 60
}: {
  ratio: number
  setRatio: (ratio: number) => void
  label: string
  min?: number
  max?: number
}): JSX.Element {
  const drag = useRef<{ element: HTMLDivElement; parent: HTMLElement; startX: number; startRatio: number; width: number; next: number } | null>(null)
  const frame = useRef<number | null>(null)
  const paint = (): void => {
    const current = drag.current
    if (!current) return
    current.element.setAttribute('aria-valuenow', String(Math.round(current.next)))
    current.parent.style.setProperty('--work-panel-split-ratio', `${current.next}%`)
  }
  const finish = (commit: boolean): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const current = drag.current
    if (!current) return
    if (commit) {
      paint()
      setRatio(current.next)
    } else {
      current.parent.style.setProperty('--work-panel-split-ratio', `${current.startRatio}%`)
      current.element.setAttribute('aria-valuenow', String(Math.round(current.startRatio)))
    }
    drag.current = null
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])
  return (
    <div
      className="work-panel-divider"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? -2 : 2
        setRatio(Math.max(min, Math.min(max, ratio + delta)))
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        const parent = event.currentTarget.parentElement
        if (!parent) return
        drag.current = { element: event.currentTarget, parent, startX: event.clientX, startRatio: ratio, width: parent.clientWidth, next: ratio }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.next = workSplitRatio(current.startRatio, current.startX, event.clientX, current.width, min, max)
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paint() })
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (current) current.next = workSplitRatio(current.startRatio, current.startX, event.clientX, current.width, min, max)
        finish(true)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
    />
  )
}

function Workspace({
  motionProps,
  controller,
  active,
  tab,
  setTab,
  onClose,
  selectedArtifact,
  fileRevealRequest,
  onDidReveal,
  selectArtifact,
  changeSelection,
  finalSelection,
  terminalReveal,
  onOpenArtifacts
}: {
  motionProps: ReturnType<typeof useMotionPresence>['motionProps']
  controller: WorkController
  active: boolean
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  onClose: () => void
  selectedArtifact: string | null
  fileRevealRequest: WorkFileRevealRequest | null
  onDidReveal: (request: WorkFileRevealRequest) => void
  selectArtifact: (id: string, openResource?: boolean) => void
  changeSelection: WorkArtifactSelection | null
  finalSelection: FinalSelection | null
  terminalReveal: WorkTerminalPanelProps['reveal']
  onOpenArtifacts: (request: ArtifactNavigation) => void
}): JSX.Element {
  const appMode = useAppMode()
  const sessionId = controller.activeTask!.id
  const resources = useWorkResources(sessionId)
  const browser = useBrowserState('work')
  const webTabs = workResourceBrowserTabs(browser.tabs, sessionId)
  const resourceCandidates = [
    ...resources.files.map(file => ({ id: file.id, name: file.name, title: file.path, file: true, fileName: file.name, directory: false })),
    ...webTabs.map(item => ({ id: `web:${item.tabId}`, name: item.title || (item.url === 'about:blank' ? '新网页' : item.url),
      title: item.localFile?.path ?? item.url, file: false, fileName: item.localFile?.name, directory: item.localFile?.kind === 'directory' }))
  ]
  const resourceOrder = useRef<string[]>([])
  resourceOrder.current = [
    ...resourceOrder.current.filter(id => resourceCandidates.some(item => item.id === id)),
    ...resourceCandidates.map(item => item.id).filter(id => !resourceOrder.current.includes(id))
  ]
  const orderedResources = resourceOrder.current.flatMap(id => {
    const item = resourceCandidates.find(candidate => candidate.id === id)
    return item ? [item] : []
  })
  const resourceIds = orderedResources.map(item => item.id)
  const resourceSignature = resourceIds.join('\u0000')
  const selectedResource = resolvedWorkResourceId(resources, webTabs.map(item => item.tabId), browser.activeTabId)
  // A single ordered entry list is the Work equivalent of Codex's unified tab
  // controller. Resource files/pages and built-in Work surfaces share the
  // same activation, close, keyboard and layout path.
  const [openEntries, setOpenEntries] = useState<WorkspaceEntry[]>(() => [{ kind: 'surface', id: tab }])
  const activateTab = useCallback((next: WorkspaceTab): void => {
    setOpenEntries(previous => previous.some(entry => entry.kind === 'surface' && entry.id === next)
      ? previous
      : [...previous, { kind: 'surface', id: next }])
    setTab(next)
  }, [setTab])
  useEffect(() => {
    // Closing the last tab can leave this pane mounted during its exit.
    // Reopening it must restore the remembered surface even if tab is unchanged.
    if (!active) return
    setOpenEntries(previous => previous.some(entry => entry.kind === 'surface' && entry.id === tab)
      ? previous
      : [...previous, { kind: 'surface', id: tab }])
  }, [tab, active])
  useEffect(() => {
    const live = new Set(resourceIds)
    setOpenEntries(previous => {
      const next = previous.filter(entry => entry.kind === 'surface' || live.has(entry.id))
      const existing = new Set(next.flatMap(entry => entry.kind === 'resource' ? [entry.id] : []))
      for (const id of resourceIds) {
        if (!existing.has(id)) next.push({ kind: 'resource', id })
      }
      const unchanged = next.length === previous.length && next.every((entry, index) => {
        const current = previous[index]
        return current?.kind === entry.kind && current.id === entry.id
      })
      return unchanged ? previous : next
    })
  }, [resourceSignature])
  const tabs: Array<[WorkspaceTab, string, IconName]> = [
    ['files', '成果', 'file'],
    ['workspace', '工作区', 'folder-outline'],
    ['sources', '资料', 'file'],
    ['subagents', '子代理', 'account-outline'],
    ['terminal', '终端', 'terminal'],
    ['git', 'Git', 'git']
  ]
  const labelFor = (id: WorkspaceTab): string => tabs.find(([candidate]) => candidate === id)?.[1] ?? '成果'
  const iconFor = (id: WorkspaceTab): IconName => tabs.find(([candidate]) => candidate === id)?.[2] ?? 'file'
  const resourceById = new Map(orderedResources.map(item => [item.id, item]))
  const visibleEntries = openEntries.filter(entry => {
    // Browser is an implementation surface for resource tabs, not a second
    // workspace destination. Keep it mounted when needed, but expose the
    // actual web/file tabs in the same strip as Code instead of a dead
    // "资源" placeholder tab.
    if (entry.kind === 'surface') return entry.id !== 'browser'
    return resourceById.has(entry.id)
  })
  const activateResource = useCallback((id: string): void => {
    const resource = resourceById.get(id)
    if (!resource) return
    if (id.startsWith('web:')) selectBrowserTab(id.slice(4))
    selectWorkResource(sessionId, id)
    setOpenEntries(previous => previous.some(entry => entry.kind === 'resource' && entry.id === id)
      ? previous
      : [...previous, { kind: 'resource', id }])
    setTab('browser')
  }, [resourceById, sessionId, setTab])
  const closeResource = useCallback((id: string): void => {
    const resource = resourceById.get(id)
    if (!resource) return
    const index = visibleEntries.findIndex(entry => entry.kind === 'resource' && entry.id === id)
    const remainingVisible = visibleEntries.filter(entry => !(entry.kind === 'resource' && entry.id === id))
    const fallback = remainingVisible[Math.max(0, Math.min(index - 1, remainingVisible.length - 1))]
    const removingLastResource = orderedResources.length === 1
    setOpenEntries(previous => previous.filter(entry =>
      !(entry.kind === 'resource' && entry.id === id) &&
      !(removingLastResource && entry.kind === 'surface' && entry.id === 'browser')
    ))
    if (!fallback) {
      // Browser is only a host for resource tabs. Reopening a closed, empty
      // workspace should return to a real surface rather than an empty host.
      setTab('files')
      onClose()
    }
    else if (tab === 'browser' && selectedResource === id) {
      if (fallback.kind === 'resource') activateResource(fallback.id)
      else setTab(fallback.id)
    }
    if (resource.file) {
      closeWorkResource(sessionId, id)
      return
    }
    browserAction(async () => {
      const source = getEngineSource()
      await window.aether.browser.close(id.slice(4))
      if (source !== getEngineSource() || getAppMode() !== 'work' || getWorkState(getEngineStorageKey()).activeTaskId !== sessionId) return
      if (resources.selected === id) closeWorkResource(sessionId, id)
    })
  }, [activateResource, browserAction, getAppMode, getEngineStorageKey, onClose, orderedResources, resourceById, resources.selected, selectedResource, sessionId, setTab, tab, visibleEntries])
  const closeTab = useCallback((closed: WorkspaceTab): void => {
    const index = visibleEntries.findIndex(entry => entry.kind === 'surface' && entry.id === closed)
    const remaining = openEntries.filter(entry => !(entry.kind === 'surface' && entry.id === closed))
    const remainingVisible = visibleEntries.filter(entry => !(entry.kind === 'surface' && entry.id === closed))
    setOpenEntries(remaining)
    if (!remainingVisible.length) { onClose(); return }
    if (tab !== closed) return
    const fallback = remainingVisible[Math.max(0, Math.min(index - 1, remainingVisible.length - 1))]
    if (!fallback) return
    if (fallback.kind === 'resource') activateResource(fallback.id)
    else setTab(fallback.id)
  }, [activateResource, onClose, openEntries, setTab, tab, visibleEntries])
  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Delete' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w')) {
      event.preventDefault(); event.stopPropagation()
      const entry = visibleEntries.find(item => item.kind === 'surface' ? `work-tab-${item.id}` === event.currentTarget.id : `work-resource-tab-${encodeURIComponent(item.id)}` === event.currentTarget.id)
      if (entry?.kind === 'resource') closeResource(entry.id)
      else if (entry) closeTab(entry.id)
      requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus())
      return
    }
    const list = event.currentTarget.closest('[role="tablist"]')
    const buttons = list ? [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(button => !button.disabled) : []
    const current = buttons.indexOf(event.currentTarget)
    const next = event.key === 'ArrowRight' ? (current + 1) % buttons.length : event.key === 'ArrowLeft' ? (current - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
    if (next < 0 || !buttons.length) return
    event.preventDefault()
    buttons[next]?.click()
    buttons[next]?.focus()
  }, [closeResource, closeTab, visibleEntries])
  const moreItems: ActionMenuItem[] = [
    {
      id: 'artifacts',
      label: '成果',
      icon: 'file',
      onSelect: () => activateTab('files')
    },
    {
      id: 'workspace',
      label: '工作区',
      icon: 'folder-outline',
      onSelect: () => activateTab('workspace')
    },
    { id: 'sources', label: '资料', icon: 'file', onSelect: () => activateTab('sources') },
    { id: 'subagents', label: '子代理', icon: 'account-outline', onSelect: () => activateTab('subagents') },
    { id: 'terminal', label: '终端', icon: 'terminal', onSelect: () => activateTab('terminal') },
    { id: 'git', label: 'Git', icon: 'git', onSelect: () => activateTab('git') }
  ]
  const tabsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const strip = tabsRef.current
    const activeEntry = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.closest<HTMLElement>('.work-workspace__tab')
    if (!strip || !activeEntry) return
    // scrollIntoView also moves ancestor scrollers, including the workspace.
    // Revealing a tab should only change this strip's horizontal position.
    const viewport = strip.getBoundingClientRect(), entry = activeEntry.getBoundingClientRect()
    const left = viewport.left + strip.clientLeft, right = left + strip.clientWidth
    if (entry.left < left) strip.scrollLeft += entry.left - left
    else if (entry.right > right) strip.scrollLeft += entry.right - right
  }, [selectedResource, tab, visibleEntries.length])
  return (
    <section className="work-workspace" aria-label="任务工作区" {...motionProps} data-motion-axis="x"
      onDragOver={(event: DragEvent<HTMLElement>) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        // Composer and attachment controls handle their own drops. Do not
        // also open the same file as a read-only resource tab when the event
        // bubbles through the workspace shell.
        if (event.defaultPrevented) return
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        const file = Array.from(event.dataTransfer.files).find(item => item.name)
        if (!file) return
        try {
          openExternalWorkFileResource(file, controller.activeTask!.id)
          // External files remain read-only resources. They are opened only
          // by an explicit drop/pick action, so this is the one path that
          // intentionally enters the resource surface.
          activateTab('browser')
        } catch (error) {
          reportError(error)
        }
      }}>
      <div className="work-workspace__tab-strip" role="toolbar" aria-label="工作区标签">
        <WorkResourceTabs sessionId={sessionId} onSelect={() => activateTab('browser')} items={moreItems} />
        <div ref={tabsRef} className="work-workspace__tabs" data-scroll-axis="x" role="tablist" aria-label="已打开的工作区">
          {visibleEntries.map((entry) => {
            if (entry.kind === 'surface') {
              const active = tab === entry.id
              return <div className={`work-workspace__tab${active ? ' is-active' : ''}`} key={`surface:${entry.id}`}>
                <button type="button" role="tab" id={`work-tab-${entry.id}`} aria-controls={`work-panel-${entry.id}`} aria-selected={active} tabIndex={active ? 0 : -1} className="work-workspace__tab-button" onClick={() => activateTab(entry.id)} onKeyDown={onTabKeyDown}>
                  <Icon name={iconFor(entry.id)} size={16} />
                  <span className="work-workspace__tab-label">{labelFor(entry.id)}</span>
                </button>
                <button type="button" className="work-workspace__tab-close" aria-label={`关闭${labelFor(entry.id)}`} onClick={() => closeTab(entry.id)}><Icon name="close" size={12} /></button>
              </div>
            }
            const resource = resourceById.get(entry.id)
            if (!resource) return null
            const active = tab === 'browser' && selectedResource === resource.id
            return <div className={`work-workspace__tab work-workspace__tab--resource${active ? ' is-active' : ''}`} key={`resource:${resource.id}`}>
              <button type="button" role="tab" id={`work-resource-tab-${encodeURIComponent(resource.id)}`} aria-controls="work-panel-browser" aria-selected={active} tabIndex={active ? 0 : -1} className="work-workspace__tab-button" title={resource.title} onClick={() => activateResource(resource.id)} onKeyDown={onTabKeyDown}>
                {resource.directory ? <Icon name="folder-outline" size={16} /> : resource.fileName
                  ? <FileGlyph name={resource.fileName} size={16} /> : <Icon name="eye-outline" size={16} />}
                <span className="work-workspace__tab-label">{resource.name}</span>
              </button>
              <button type="button" className="work-workspace__tab-close" aria-label={`关闭${resource.file ? '文档' : '网页'} ${resource.name}`} onClick={() => closeResource(resource.id)}><Icon name="close" size={12} /></button>
            </div>
          })}
        </div>
      </div>
      <div className="work-workspace__panes">
        {openEntries.filter((entry): entry is { kind: 'surface'; id: WorkspaceTab } => entry.kind === 'surface').map(({ id }) => (
          <WorkspacePane
            key={id}
            id={id}
            hidden={tab !== id}
            active={active && appMode === 'work' && tab === id}
            controller={controller}
            selectedArtifact={selectedArtifact}
            fileRevealRequest={fileRevealRequest}
            onDidReveal={onDidReveal}
            selectArtifact={selectArtifact}
            changeSelection={changeSelection}
            finalSelection={finalSelection}
            onOpenArtifacts={onOpenArtifacts}
            openTab={activateTab}
            source={getEngineSource()}
            terminalReveal={terminalReveal}
          />
        ))}
      </div>
    </section>
  )
}

/** Visited panes retain local drafts and selection, but hidden panes do not
 * rebuild message-derived diffs/activity on every incoming token. */
const WorkspacePane = memo(function WorkspacePane({ id, hidden, active, controller, selectedArtifact, fileRevealRequest, onDidReveal, selectArtifact, changeSelection, finalSelection, terminalReveal, onOpenArtifacts, openTab }: {
  id: WorkspaceTab
  hidden: boolean
  active: boolean
  controller: WorkController
  selectedArtifact: string | null
  fileRevealRequest: WorkFileRevealRequest | null
  onDidReveal: (request: WorkFileRevealRequest) => void
  selectArtifact: (id: string, openResource?: boolean) => void
  changeSelection: WorkArtifactSelection | null
  finalSelection: FinalSelection | null
  onOpenArtifacts: (request: ArtifactNavigation) => void
  openTab: (tab: WorkspaceTab) => void
  source: number
  terminalReveal: WorkTerminalPanelProps['reveal']
}): JSX.Element {
  const previewRevision = useRef(0)
  const previewScope = JSON.stringify([getEngineSource(), controller.activeTask?.id, controller.activeTask?.workspacePath])
  const [previewReveal, setPreviewReveal] = useState<{ path: string; reveal: TextPreviewReveal; scope: string } | null>(null)
  const selectWorkspaceFile = useCallback((path: string, reveal?: TextPreviewReveal): void => {
    // Keep the workspace tree as its own tab while reusing the same preview
    // component for the selected session-scoped file.
    setPreviewReveal(reveal ? { path, reveal: { ...reveal, revision: ++previewRevision.current }, scope: previewScope } : null)
    selectArtifact(`path:${path}`)
    openTab('workspace')
  }, [openTab, selectArtifact, previewScope])
  const openGitFile = useCallback((path: string): void => {
    selectArtifact(`path:${path}`)
    openTab('workspace')
  }, [openTab, selectArtifact])
  // Keep one derived tool snapshot per pane. `useChat` replaces the active
  // message object for each streamed token, while its tool receipt arrays stay
  // referentially stable until a tool actually changes. Passing this snapshot
  // lets the heavy activity/artifact/subagent panes skip text-only renders.
  const tools = useWorkTools(controller.messages)
  const [workspaceSplitRatio, setWorkspaceSplitRatio] = useState(32)
  return <div
    className={`work-workspace__body work-workspace__body--${id}`}
    hidden={hidden}
    inert={hidden || undefined}
    aria-hidden={hidden || undefined}
    role="tabpanel"
    id={`work-panel-${id}`}
    aria-labelledby={`work-tab-${id}`}
  >
    {!active && id === 'sources' ? null : id === 'files' ? (
            <WorkArtifactsWorkspace sessionId={controller.activeTask!.id} workspacePath={controller.activeTask?.workspacePath}
              ready={controller.ready} streaming={controller.streaming || controller.launching || ['running', 'waiting'].includes(controller.activeTask?.status ?? '')}
              active={active} tools={tools} messages={controller.messages} selection={changeSelection} finalSelection={finalSelection} onOpenCurrentFile={selectWorkspaceFile}
              onAddToConversation={(...args) => addWorkArtifactToConversation(controller, 'artifact', ...args)} />
          ) : id === 'workspace' ? (
            <div className="work-files-workspace" style={{ '--work-panel-split-ratio': `${workspaceSplitRatio}%` } as CSSProperties}>
              <div className="work-files-workspace__tree">
                <WorkWorkspacePanel
                  sessionId={controller.activeTask?.id}
                  workspaceRoot={controller.activeTask?.workspacePath}
                  active={active}
                  revealRequest={fileRevealRequest}
                  onDidReveal={onDidReveal}
                  onOpenFile={selectWorkspaceFile}
                  onAddToConversation={controller.addWorkspaceReferences}
                />
              </div>
              <WorkPanelDivider ratio={workspaceSplitRatio} setRatio={setWorkspaceSplitRatio} label="调整工作区文件与预览宽度" min={24} max={54} />
              <div className="work-files-workspace__preview">
                <TaskArtifactPanel
                  controller={controller}
                  active={active}
                  selectedId={selectedArtifact}
                  revealTarget={previewReveal?.scope === previewScope ? previewReveal : null}
                  onOpenFile={(item) => {
                    void openFileFromChat(item.path, {
                      sessionId: controller.activeTask?.id ?? '',
                      workspaceRoot: controller.activeTask?.workspacePath
                    }).then(() => openTab('browser')).catch(reportError)
                  }}
                />
              </div>
            </div>
          ) : id === 'sources' ? (
            <SourcePanel controller={controller} />
          ) : id === 'subagents' ? (
            <StableWorkSubagentsPanel
              sessionId={controller.activeTask?.id ?? null}
              rootRunId={controller.workspaceRunId}
              tools={tools}
              active={active}
              publishedFixedChildren={controller.publishedFixedChildren}
              busy={controller.streaming || controller.loading || controller.pending.length > 0 || controller.uploading}
              onContinue={controller.continueSubagent}
              attachments={[...(controller.activeTask?.sources ?? []), ...controller.attachments]}
            />
          ) : id === 'terminal' ? (
            <WorkTerminalPanel sessionId={controller.activeTask!.id} cwd={controller.activeTask?.workspacePath}
              jobs={controller.commandJobs} active={active} reveal={terminalReveal} />
          ) : id === 'git' ? (
            <StableWorkGitPanel
              // Never fall back to the Code workspace when Work has no active
              // task. Git operations must stay scoped to the selected Work
              // task's directory and session.
              cwd={controller.activeTask?.workspacePath}
              sessionId={controller.activeTask?.id}
              workspaceRunId={controller.workspaceRunId}
              active={active}
              onOpenFile={openGitFile}
            />
          ) : (
            <WorkResourcePane key={JSON.stringify([getEngineSource(), controller.activeTask?.id, controller.activeTask?.workspacePath])} controller={controller} onOpenArtifacts={onOpenArtifacts} active={active} />
          )}
  </div>
}, (previous, next) => !previous.active && !next.active && previous.hidden === next.hidden && previous.source === next.source && previous.controller.activeTask?.id === next.controller.activeTask?.id && previous.controller.activeTask?.workspacePath === next.controller.activeTask?.workspacePath)

function WorkResourcePane({ controller, onOpenArtifacts, active }: {
  controller: WorkController
  onOpenArtifacts: (request: ArtifactNavigation) => void
  active: boolean
}): JSX.Element {
  const sessionId = controller.activeTask!.id
  const resources = useWorkResources(sessionId)
  const browser = useBrowserState('work')
  const webTabs = workResourceBrowserTabs(browser.tabs, sessionId)
  const selected = resolvedWorkResourceId(resources, webTabs.map(tab => tab.tabId), browser.activeTabId)
  const file = resources.files.find(item => item.id === selected)
  const web = selected?.startsWith('web:') ? webTabs.find(item => item.tabId === selected.slice(4)) : undefined
  const selectedFileId = file?.id ?? null
  const retained = useRetainedPreviews(resourcePreviewEntries(resources.files), active ? selectedFileId : null,
    JSON.stringify([getEngineSource(), sessionId, controller.activeTask?.workspacePath]))
  const retainedIds = new Set(retained.map(entry => entry.id))
  if (active && selectedFileId) retainedIds.add(selectedFileId)
  return <>
    {/* Native browser bounds are released on hide; only file previews stay mounted. */}
    {active && web ? <div className="work-resource-browser"><WorkBrowser tabId={web.tabId} hideTabStrip /></div> : null}
    {!file && !web ? <EmptyState icon="file" title="文件和网页，在同一个地方查看" description="从成果、资料或对话中打开文件，也可以拖入电脑文件，或在“更多工作区”菜单中打开文件与网页。" /> : null}
    {resources.files.filter(item => retainedIds.has(item.id)).map(item => <WorkResourceFile
      key={JSON.stringify([getEngineSource(), sessionId, item.id])} controller={controller} file={item} onOpenArtifacts={onOpenArtifacts} active={active && item.id === file?.id} />)}
  </>
}

/** External resources cannot acquire a session history merely by sharing a filename. */
function useResourceArtifactPath(controller: WorkController, file: ReturnType<typeof useWorkResources>['files'][number], active = true): string | null {
  const sessionId = controller.activeTask?.id
  const source = getEngineSource()
  const identity = JSON.stringify([source, sessionId, file.path, file.target?.key])
  const [match, setMatch] = useState<{ identity: string; path: string } | null>(null)

  useEffect(() => {
    let subscribed = true
    const target = file.target
    setMatch(null)
    if (!target || target.sessionId !== sessionId || target.source !== source || !sessionId || !controller.ready || !active) {
      return () => { subscribed = false }
    }
    void (async () => {
      assertSessionFileTarget(target)
      const result = await requestOrThrow<SessionFileChange[]>({
        method: 'GET', path: '/changes', query: { sessionId }, expectedEngine: target.expectedEngine
      })
      assertSessionFileTarget(target)
      if (!subscribed) return
      const pathKey = workChangePathKey(file.path, target.root)
      const change = (Array.isArray(result) ? result : []).find(item =>
        item.sessionId === sessionId && workChangePathKey(item.path, target.root) === pathKey)
      if (change) setMatch({ identity, path: /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(change.path) ? change.path : paths.join(target.root, change.path) })
    })().catch(() => {
      // Only authenticated history can offer this link; a later activation retries.
      if (subscribed && source === getEngineSource()) setMatch(null)
    })
    return () => { subscribed = false }
  }, [controller.ready, controller.streaming, file.id, file.path, file.target, identity, sessionId, source, active])

  return match?.identity === identity ? match.path : null
}

function WorkResourceFile({ controller, file, onOpenArtifacts, active }: {
  controller: WorkController
  file: ReturnType<typeof useWorkResources>['files'][number]
  onOpenArtifacts: (request: ArtifactNavigation) => void
  active: boolean
}): JSX.Element {
  // External resources still belong to the visible Work conversation for
  // references/drafts, while their preview deliberately carries no session
  // file target and therefore cannot be written by the Agent.
  const sessionId = controller.activeTask?.id ?? file.target?.sessionId
  const artifactPath = useResourceArtifactPath(controller, file, active)
  const openArtifactHistory = (): void => {
    if (!artifactPath || !file.target || file.target.sessionId !== sessionId || !sessionId) return
    try {
      assertSessionFileTarget(file.target)
      onOpenArtifacts({ sessionId, path: artifactPath, view: 'operation', turnScope: { kind: 'session' } })
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
  }
  const addExternalToConversation = async (): Promise<void> => {
    let input = file.externalFile
    if (!input && file.externalPath) {
      const result = await readLocalRecoveryFile(file.externalPath)
      if (result.tooLarge || result.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请缩小文件后重试')
      const bytes = fileContentBytes(result)
      input = new File([bytes.buffer as ArrayBuffer], file.name, { type: 'application/octet-stream', lastModified: Date.now() })
    }
    if (!input) throw new Error('外部文件已失效，请重新选择或拖拽文件')
    await controller.addFiles([input])
    toast.success('已加入对话资料，发送时将上传副本')
  }
  return <div className="work-artifacts-shell__detail work-resource-file" hidden={!active}>
    {artifactPath ? <div className="work-artifacts-shell__tabs" aria-label="文件成果导航">
      <button type="button" onClick={openArtifactHistory} title="查看此文件在当前会话中的修改记录">在成果中查看改动</button>
    </div> : null}
    <WorkArtifactPanel
    artifact={{ id: file.id, path: file.path, name: file.name, content: null, status: 'ready', createdAt: 0 }}
    workspaceRoot={file.target?.root ?? controller.activeTask?.workspacePath} sessionId={sessionId} externalFile={file.externalFile} externalPath={file.externalPath} inResourceTab active={active}
    onAddToConversation={(item, selection, coverage, mention) => {
      if (mention || selection) {
        addWorkArtifactToConversation(controller, 'workspace', item, selection, coverage, mention)
      } else if (file.externalFile || file.externalPath) {
        void addExternalToConversation().catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : String(reason)))
      } else {
        try { controller.addWorkspaceReferences([{ path: item.path, kind: 'file' }]) }
        catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
      }
    }}
  />
  </div>
}

function addWorkArtifactToConversation(controller: WorkController, origin: 'workspace' | 'artifact', ...[item, selection, coverage, mention]: Parameters<NonNullable<WorkArtifactPanelProps['onAddToConversation']>>): void {
  try {
    if (origin === 'workspace' && !selection && !mention) {
      controller.addWorkspaceReferences([{ path: item.path, kind: 'file' }])
      return
    }
    controller.addMentions([mention ? { ...mention, origin } : { source: 'file', origin, path: item.path,
      displayText: selection ? `${item.name}（选区）` : item.name,
      ...(selection ? { content: coverage && coverage !== 'current' ? `来自${coverage === 'receipt' ? '历史回执' : '预览片段'}的选中内容：\n${selection}` : selection } : {}) }])
  } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
}

function TaskArtifactPanel({ controller, active, selectedId, revealTarget, onOpenFile }: {
  controller: WorkController
  active: boolean
  selectedId: string | null
  revealTarget?: { path: string; reveal: TextPreviewReveal } | null
  onOpenFile: (item: WorkArtifact) => void
}): JSX.Element {
  const path = selectedId?.startsWith('path:') ? selectedId.slice(5) : null
  const artifact = path ? { id: selectedId!, path, name: filename(path), content: null, status: 'ready' as const, createdAt: 0 }
    : controller.artifacts.find(item => item.id === selectedId) ?? null
  const root = controller.activeTask?.workspacePath
  const reveal = artifact && revealTarget && workChangePathKey(artifact.path, root) === workChangePathKey(revealTarget.path, root)
    ? revealTarget.reveal : undefined
  return <WorkArtifactPanel artifact={artifact} sessionId={controller.activeTask?.id} workspaceRoot={controller.activeTask?.workspacePath}
    active={active} reveal={reveal} onOpenFile={onOpenFile} onAddToConversation={(...args) => addWorkArtifactToConversation(controller, 'workspace', ...args)} />
}

function SourcePanel({ controller }: { controller: WorkController }): JSX.Element {
  const references = useWorkReferenceNavigation()
  const requested = references?.sourceSelection?.sessionId === controller.activeTask?.id ? references?.sourceSelection : null
  const sources = useMemo(() => {
    const files = [...(controller.activeTask?.sources ?? []), ...controller.attachments]
    return files.filter((file, index) => files.findIndex(other => other.path === file.path) === index)
  }, [controller.activeTask?.sources, controller.attachments])
  const root = controller.activeTask?.workspacePath ?? null
  const [selectedPath, setSelectedPath] = useState<string | null>(sources[0]?.path ?? null)
  const selected = sources.find((item) => item.path === selectedPath) ?? null
  useEffect(() => { if (requested) setSelectedPath(requested.source.path) }, [requested])
  useEffect(() => {
    // Keep a valid selection as the task's source list changes (attach / remove / task switch).
    if (!sources.some((item) => item.path === selectedPath)) setSelectedPath(sources[0]?.path ?? null)
  }, [sources, selectedPath])
  return sources.length ? (
    <div className="work-sources work-sources--manager">
      <h3>
        任务资料 <span>{sources.length}</span>
      </h3>
      <div className="work-sources__split">
        <ul className="work-sources__list" role="listbox" aria-label="资料文件">
          {sources.map((source) => (
            <SourceRow
              key={`${controller.draftSource}:${controller.activeTask?.id}:${source.path}`}
              controller={controller}
              source={source}
              root={root}
              selected={selected?.path === source.path}
              onSelect={() => setSelectedPath(source.path)}
            />
          ))}
        </ul>
        <div className="work-sources__preview">
          {selected ? (
            <WorkSourcePreview source={selected} root={root} sessionId={controller.activeTask?.id}
              onAddFile={() => { controller.addMentions([{ source: 'file', origin: 'attachment', path: selected.path, displayText: selected.name }]) }}
              onAddSelection={text => { controller.addMentions([{ source: 'file', origin: 'attachment', path: selected.path,
                displayText: `${selected.name}（选区）`, content: text }]) }} />
          ) : (
            <div className="work-sources__preview-empty">
              <Icon name="file" size={20} />
              <span>选择左侧资料查看内容</span>
            </div>
          )}
        </div>
      </div>
    </div>
  ) : (
    <EmptyState
      icon="paperclip"
      title="还没有添加资料"
      description="在对话输入区选择“添加资料”，或将文件拖入输入区。资料会随消息一起发送。"
    />
  )
}

/** 单个资料行：缩略图 + 名称/大小 + 悬浮操作（添加到对话、在文件夹中显示、删除） */
function SourceRow({
  controller,
  source,
  root,
  selected,
  onSelect
}: {
  controller: WorkController
  source: ChatAttachment
  root: string | null
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const isImage = source.type.startsWith('image/')
  const { file } = useWorkSourceFile(source, controller.activeTask?.id, root, isImage)
  const thumb = file?.base64 ? `data:${source.type};base64,${file.base64}` : null
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3200)
    return () => clearTimeout(timer)
  }, [confirming])
  const reveal = async (): Promise<void> => {
    try {
      if (controller.remote) throw new Error('远端资料无法在本机文件夹中显示，可在右侧预览')
      const sessionId = controller.activeTask?.id
      let target = sessionId ? await resolveSessionFilePath(sessionId, source.path, root)
        : root ? { path: paths.join(root, source.path) } : null
      if (!target) throw new Error('资料没有关联任务')
      await window.aether.fs.reveal(target.path)
    } catch (error) {
      // A restored local task can still point at a project root that the
      // engine's session binder has not persisted.  Reveal the same bounded
      // task-root candidates used by the read-only preview instead of hiding
      // the file behind a misleading session-path error.
      if (!controller.remote && root) {
        const candidates = workspaceRecoveryCandidates(source.path, root)
        for (const candidate of candidates) {
          try {
            await readLocalRecoveryFile(candidate)
            await window.aether.fs.reveal(candidate)
            return
          } catch { /* try the next bounded root */ }
        }
      }
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const remove = (): void => {
    controller.removeSource(source.path)
    setConfirming(false)
    toast.success('已从任务资料移除，历史附件仍保留')
  }
  return (
    <li className={`work-source-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="work-source-row__main"
        role="option"
        aria-selected={selected}
        title={source.path}
        onClick={onSelect}
      >
        {isImage && thumb ? (
          <img className="work-source-row__thumb" src={thumb} alt={source.name} />
        ) : (
          <span className="work-source-row__thumb work-source-row__thumb--icon">
            <FileGlyph name={source.name} size={18} />
          </span>
        )}
        <span className="work-source-row__info">
          <strong>{source.name}</strong>
          <span>{fileSize(source.size)}</span>
        </span>
      </button>
      <span className="work-source-row__actions">
        <button
          type="button"
          className="work-quiet-button"
          title="把该资料引用进当前对话草稿"
          onClick={() => {
            controller.addSourceReference(source)
            toast.success('已添加到对话草稿')
          }}
        >
          添加到对话
        </button>
        {!controller.remote && <IconButton icon="folder-outline" label="在文件夹中显示" size={14} onClick={() => void reveal()} />}
        <IconButton
          icon={confirming ? 'warning' : 'delete-outline'}
          label={confirming ? `确认移除 ${source.name}` : `从任务资料移除 ${source.name}`}
          size={14}
          onClick={() => (confirming ? remove() : setConfirming(true))}
        />
      </span>
    </li>
  )
}

function Projects({
  controller,
  openTask
}: {
  controller: WorkController
  openTask: (id: string) => void
}): JSX.Element {
  const groups = useMemo(() => {
    const result = new Map<string, WorkTask[]>()
    for (const task of controller.tasks) {
      if (task.archived || !task.workspacePath) continue
      const group = result.get(task.workspacePath)
      if (group) group.push(task)
      else result.set(task.workspacePath, [task])
    }
    return [...result]
  }, [controller.tasks])
  return (
    <div className="work-page">
      <div className="work-page__inner">
        <SectionHeading title="项目" description="按任务使用的工作目录，汇集相关工作。" />
        {groups.length ? (
          groups.map(([path, tasks]) => (
            <section className="work-project" key={path}>
              <header>
                <Icon name="folder-outline" size={20} />
                <div>
                  <h2>{filename(path)}</h2>
                  <p>{path}</p>
                </div>
                <span>{tasks.length} 项任务</span>
              </header>
              <TaskList tasks={tasks} ready={controller.ready} onSelect={openTask} empty="" />
            </section>
          ))
        ) : (
          <EmptyState
            icon="folder-outline"
            title="将相关工作放在一起"
            description="开始任务时选择工作目录，使用同一目录的任务会自动汇集到这里。项目指令和团队共享将在后续版本接入。"
          />
        )}
      </div>
    </div>
  )
}

function Connections({ ready }: { ready: boolean }): JSX.Element {
  const { engine } = useApp()
  return (
    <div className="work-page">
      <div className="work-page__inner">
        <SectionHeading title="连接" description="管理执行引擎、模型和可供任务使用的能力。" />
        <div className="work-connection-list">
          <ConnectionRow
            icon="account-outline"
            title="个人账号"
            description="登录、个人资料和设备会话"
            section="account"
          />
          <ConnectionRow
            icon="engine"
            title="AI 引擎"
            description={engine.snapshot.mode === 'remote' ? '远程引擎' : '本地引擎'}
            status={ready ? '已连接' : '未就绪'}
            section="general"
          />
          <ConnectionRow
            icon="model"
            title="模型"
            description="设置研究、写作与分析使用的模型"
            section="models"
          />
          <ConnectionRow
            icon="sparkles"
            title="技能"
            description="查看和管理已安装技能"
            section="skills"
          />
          <ConnectionRow
            icon="graph"
            title="MCP 服务"
            description="管理外部工具连接与授权"
            section="mcp"
          />
          <ConnectionRow
            icon="package-variant-closed"
            title="知识库"
            description="管理任务可引用的资料与检索范围"
            section="knowledge"
          />
        </div>
        <p className="work-note">连接设置会沿用当前引擎与账号范围，切换 Work 任务不会串用其他工作区。</p>
      </div>
    </div>
  )
}

function ConnectionRow({
  icon,
  title,
  description,
  status,
  section
}: {
  icon: IconName
  title: string
  description: string
  status?: string
  section: string
}): JSX.Element {
  return (
    <div className="work-connection-row">
      <Icon name={icon} size={21} />
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {status && <span>{status}</span>}
      <button type="button" className="btn btn--sm" onClick={() => openAppSettings(section)}>
        管理
      </button>
    </div>
  )
}


