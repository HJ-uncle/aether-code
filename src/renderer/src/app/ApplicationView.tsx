import { type JSX, useLayoutEffect, useEffect, useState, useRef, useCallback, useMemo, type CSSProperties } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { CronAutomationRun } from '@shared/automation'
import type { ChatRecoverySnapshot } from '@renderer/core/engine/chat-recovery'
import { toast } from '@renderer/core/toast'
import { parseConversationLink, buildConversationLink } from '@shared/conversation-link'
import { conversationLinkTask } from '../features/conversation/conversation-reference'
import { onOpenConversationRequest } from '../features/conversation/conversation-navigation'
import { getEngineSource, getEngineStorageKey, isEngineReady, sessionStorageKey } from '@renderer/core/engine/source'
import { setBrowserSessionOverride } from '@renderer/core/browser/connection'
import { useWorkbenchClient, waitForSessionPreview } from '@renderer/core/workbench/client'
import { requestSessionPreview } from '@renderer/core/workbench/preview-request'
import { registerCommand } from '@renderer/core/platform/commands'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon } from '@renderer/ui/icons'
import { IconButton, SectionHeading } from '@renderer/ui/ui-primitives'
import { openAppSettings } from '../features/settings/app-settings-navigation'
import { useSessionController } from '../features/sessions/runtime'
import { Browser } from '../features/browser/Browser'
import { SessionReferenceProvider } from '../features/conversation/ReferenceNavigation'
import { ImageConversationProvider } from '../features/conversation/shared/image-conversation'
import { ToolImageGalleryProvider } from '../features/conversation/shared/ToolImageGalleryProvider'
import { TaskActions } from '../features/sessions/TaskActions'
import { SidebarHistory } from '../features/sessions/SidebarHistory'
import { type SessionFileRevealRequest } from '../features/workspace/WorkspacePanel'
import { sessionFinalResultCatalog } from '../features/artifacts/final-results'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import type { SessionArtifactSelection } from '../features/artifacts/session-artifacts'
import { UsageMeter } from '../features/conversation/shared/ConversationUsage'
import { useMotionPresence, MotionPresence } from '@renderer/ui/MotionPresence'
import { requestedThinkingMode } from '../features/conversation/shared/session-request-config'
import { subscribeAutomationEditor } from '../features/automations/automation-navigation'
import { flushSessionDrafts, getSessionState, updateSessionState } from '../features/sessions/state'
import { useBrowserState, hideBrowserSurfaces, selectBrowserTab } from '../features/browser/browser-store'
import './application.css'
import '../features/conversation/shared/apple-chat-panels.css'
import { useSessionResources, sessionResourceBrowserTabs, selectSessionResource } from '../features/workspace/resource-store'
import { type HomeFilter, Home } from '../features/sessions/Home'
import { TaskStatus as TaskStatus } from '../features/sessions/TaskStatus'
import { currentAppearance } from '@renderer/core/theme/palette'
import { unreadCompletedTaskCount } from '@shared/taskbar'
import { partitionCommandJobs } from '@renderer/core/engine/command-job-state'
import { type TerminalPanelProps } from '../features/terminal/TerminalPanel'
import { onSessionTerminalRequest } from '../features/terminal/terminal-navigation'
import { type SessionSubagentReveal, onSessionSubagentRequest } from '../features/collaboration/subagent-navigation'
import { createLocalSession } from '../features/terminal/terminal-store'
import { initialView, type ViewState, VIEW_KEY, type Page, type WorkspaceTab, NAVIGATION } from './navigation'
import { type ActivitySelection, type FinalSelection, type SessionTask, type ArtifactNavigation, filename, useSessionTools } from '../features/sessions/session-presentation'
import { SessionRootStop } from '../features/conversation/SessionFeedback'
import { Conversation } from '../features/conversation/ConversationView'
import { SessionDivider } from '../ui/PaneDivider'
import { Workspace } from '../features/workspace/WorkspaceView'
import { ResourceTabs } from '../features/workspace/ResourceTabs'
import { workspaceSurfaceTabs } from '../features/workspace/workspace-tabs'
import { useWorkspaceTabs } from '../features/workspace/useWorkspaceTabs'
import { useSyncExternalStore, Suspense } from 'react'
import { AgentManager, PluginManager, AutomationsView, EngineMonitorView, Projects } from './pages'
import { ExtensionPage, useExtensionContributions, getExtensionNavigationRequest, subscribeExtensionNavigation, getExtensionHostSnapshot, subscribeExtensionHost, publishExtensionEvent } from '@renderer/features/extensions'
import { isExtensionDestination, extensionIcon } from './navigation'
import { usePublishServiceTrayContext } from '@renderer/features/services/tray-context'

/** Application assembly owns navigation; domain views retain their own session state. */
export function ApplicationView(): JSX.Element {
  const controller = useSessionController()
  const browser = useBrowserState('work')
  const browserSource = getEngineSource()
  useLayoutEffect(() => {
    // The browser bridge must already know Work's task (or persisted home
    // session) when browser_open is the first tool, without a mounted panel.
    setBrowserSessionOverride(controller.securitySessionId, browserSource)
  }, [controller.securitySessionId, browserSource])
  useEffect(() => () => setBrowserSessionOverride(null), [])
  const [storedView, setView] = useState(initialView)
  const initialWorkspaceTab = useRef(storedView.tab)
  const task = controller.activeTask
  const activityTools = useSessionTools(controller.messages)
  const workspaceTabs = useWorkspaceTabs(browserSource, task?.id, initialWorkspaceTab.current)
  const view = useMemo(() => ({ ...storedView, tab: workspaceTabs.tab }), [storedView, workspaceTabs.tab])
  const selectWorkspaceTab = workspaceTabs.setTab
  const workspaceMotion = useMotionPresence(view.workspace)
  const [workspaceFocusRequest, setWorkspaceFocusRequest] = useState(0)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<HomeFilter>('all')
  const [artifactSelection, setArtifactSelection] = useState<{ scope: string; id: string | null } | null>(null)
  const [fileRevealRequest, setFileRevealRequest] = useState<SessionFileRevealRequest | null>(null)
  const [terminalReveal, setTerminalReveal] = useState<{ scope: string; request: TerminalPanelProps['reveal'] } | null>(null)
  const terminalRevision = useRef(0)
  const [subagentReveal, setSubagentReveal] = useState<SessionSubagentReveal | null>(null)
  const fileRevealRevision = useRef(0)
  const acknowledgeFileReveal = useCallback((request: SessionFileRevealRequest): void => {
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
  const [changeSelection, setChangeSelection] = useState<SessionArtifactSelection | null>(null)
  const [finalSelection, setFinalSelection] = useState<FinalSelection | null>(null)
  const [automationRequest, setAutomationRequest] = useState<{ jobId: string; revision: number } | null>(null)
  const automationRequestRevision = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const [compactNavigation, setCompactNavigation] = useState(window.innerWidth <= 1160)
  const [singlePane, setSinglePane] = useState(window.innerWidth <= 990)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const set = useCallback((patch: Partial<ViewState>): void => {
    if (patch.tab) selectWorkspaceTab(patch.tab)
    setView(previous => ({ ...previous, ...patch }))
  }, [selectWorkspaceTab])
  const extensionContext = useMemo(() => ({ sessionId: task?.id, workspacePath: task?.workspacePath, engineReady: controller.ready }), [task?.id, task?.workspacePath, controller.ready])
  const extensions = useExtensionContributions(extensionContext)
  const previousExtensionContext = useRef<typeof extensionContext | null>(null)
  useEffect(() => {
    if (!extensionContext.engineReady) return
    const previous = previousExtensionContext.current
    if (previous?.sessionId !== extensionContext.sessionId) {
      if (previous?.sessionId) publishExtensionEvent('session.closed', previous)
      if (extensionContext.sessionId) publishExtensionEvent('session.opened', extensionContext)
      if (extensionContext.sessionId) publishExtensionEvent('session.changed', extensionContext, { previousSessionId: previous?.sessionId ?? null })
    }
    previousExtensionContext.current = extensionContext
  }, [extensionContext])
  const extensionHost = useSyncExternalStore(subscribeExtensionHost, getExtensionHostSnapshot)
  const extensionRequest = useSyncExternalStore(subscribeExtensionNavigation, getExtensionNavigationRequest)
  const [extensionTarget, setExtensionTarget] = useState<ReturnType<typeof getExtensionNavigationRequest>>(null)
  const consumedExtensionRequest = useRef('')
  const switchingExtensionRequest = useRef('')
  useEffect(() => {
    if (!extensionRequest) return
    const requestKey = `${extensionRequest.source}:${extensionRequest.revision}`
    if (consumedExtensionRequest.current === requestKey) return
    if (extensionRequest.source !== getEngineSource()) { consumedExtensionRequest.current = requestKey; switchingExtensionRequest.current = ''; return }
    if (extensionRequest.sessionId && !controller.tasks.some(item => item.id === extensionRequest.sessionId)) {
      consumedExtensionRequest.current = requestKey; switchingExtensionRequest.current = ''; setExtensionTarget(null)
      toast.error('此会话已不存在，无法打开插件页面。'); return
    }
    if (extensionRequest.sessionId && extensionRequest.sessionId !== task?.id) {
      if (switchingExtensionRequest.current !== requestKey) {
        switchingExtensionRequest.current = requestKey; setExtensionTarget(null)
        controller.selectTask(extensionRequest.sessionId); set({ page: 'home', pane: 'conversation' })
      }
      return
    }
    // Only consume after the requested session is active. Re-enabling a plugin
    // cannot replay an old request and pull the user out of the manager.
    consumedExtensionRequest.current = requestKey; switchingExtensionRequest.current = ''
    if (extensionRequest.pageId === 'plugins') { setExtensionTarget(null); set({ page: 'plugins' }); return }
    if (!extensions.pages.some(page => page.id === extensionRequest.pageId) || !isExtensionDestination(extensionRequest.pageId)) return
    setExtensionTarget(extensionRequest)
    set({ page: extensionRequest.pageId })
    setNavigationOpen(false)
  }, [extensionRequest, task?.id, controller.tasks, controller.selectTask, extensions.pages, set])
  useEffect(() => {
    if (extensionTarget && (extensionTarget.pageId !== view.page || extensionTarget.source !== browserSource || extensionTarget.sessionId !== task?.id)) setExtensionTarget(null)
  }, [extensionTarget, view.page, browserSource, task?.id])
  useEffect(() => {
    if (isExtensionDestination(view.page) && !extensionHost.loading && !extensions.pages.some(page => page.id === view.page)) set({ page: 'home' })
  }, [view.page, extensionHost.loading, extensions.pages, set])
  const latestUserMessageId = controller.messages.findLast(message => message.role === 'user')?.id
  const latestDeliveryKey = useMemo(() => sessionFinalResultCatalog(controller.messages, task?.id ?? '').deliveryKey,
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
  const fileResources = useSessionResources(task?.id ?? '')
  const fileResourceScope = fileTreeScope
  const handledFileReveal = useRef({ scope: fileResourceScope, revision: fileResources.reveal, selected: fileResources.selected })
  const activeTasks = useMemo(() => controller.tasks.filter((item) => !item.archived), [controller.tasks])
  const completedUnreadCount = useMemo(() => unreadCompletedTaskCount(activeTasks), [activeTasks])
  useLayoutEffect(() => {
    // Include the resolved theme so system-mode changes also redraw an existing badge.
    const paint = (): void => { void window.aether.window.setCompletionBadge(completedUnreadCount, currentAppearance()).catch(() => undefined) }
    paint()
    const observer = new MutationObserver(paint)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] })
    return () => observer.disconnect()
  }, [completedUnreadCount, browserSource])
  const runningCount = useMemo(() => activeTasks.filter(item => item.status === 'running').length, [activeTasks])
  const waiting = useMemo(() => activeTasks.filter((item) => item.status === 'waiting').length, [activeTasks])
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
    if (view.page !== 'home') setActivitySelection(null)
  }, [view.page])
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
    if (!task || !file) return
    // Resource tabs and Git previews share one active workspace file. Only
    // authenticated files from this task may move its tree selection.
    if (file.target?.sessionId === task.id && file.target.source === browserSource) {
      setSelectedArtifact(`path:${file.path}`)
      if (foregroundRequest) revealWorkspaceFile(file.path)
    }
    // Renames update resource identities without requesting navigation. Keep
    // the user's tree/history surface while its selected preview follows them.
    if (!foregroundRequest) return
    set({ page: 'home', workspace: true, tab: 'browser', pane: 'workspace' })
  }, [task?.id, browserSource, fileResourceScope, fileResources.reveal, fileResources.selected, fileResources.files, revealWorkspaceFile, set])
  useEffect(() => {
    // Browser tool requests can arrive while Work's workspace is closed. Open
    // the owning surface before BrowserService waits for fresh native bounds.
    if (!revealRequestId || handledRevealRef.current === revealRequestId) return
    if (task && browser.revealRequest) {
      if (!sessionResourceBrowserTabs(browser.tabs, task.id).some(item => item.tabId === browser.revealRequest?.tabId)) return
      selectSessionResource(task.id, `web:${browser.revealRequest.tabId}`)
    }
    // A request for another task is still pending if the user opens it later.
    handledRevealRef.current = revealRequestId
    // Standalone browsing shares the task's tab identity, not its navigation.
    // Opening a local file must keep the surface the user is already using.
    if (view.page !== 'browser') set(task
      ? { page: 'home', workspace: true, tab: 'browser', pane: 'workspace' }
      : { page: 'browser' })
  }, [revealRequestId, task?.id, view.page, set])
  useEffect(() => {
    const ownsBrowserSurface =
      (view.page === 'browser' || (Boolean(task) &&
        view.page === 'home' && view.workspace && view.tab === 'browser'))
    if (ownsBrowserSurface) return
    let current = true
    void hideBrowserSurfaces(() => current)
    return () => { current = false }
  }, [task?.id, view.page, view.workspace, view.tab, browser.tabs.length])
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
    const requested = getExtensionNavigationRequest()
    if (requested) consumedExtensionRequest.current = `${requested.source}:${requested.revision}`
    switchingExtensionRequest.current = ''
    setExtensionTarget(null)
    set(page === 'home' ? { page, workspace: false, pane: 'conversation' } : { page })
    setNavigationOpen(false)
    if (page === 'home') controller.showHome()
  }, [set, controller.showHome])
  const openTask = useCallback((id: string): void => {
    const requested = getExtensionNavigationRequest()
    if (requested) consumedExtensionRequest.current = `${requested.source}:${requested.revision}`
    switchingExtensionRequest.current = ''
    setExtensionTarget(null)
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
      openTask(target.id)
    } catch (error) { toast.error(error instanceof Error ? error.message : '无法打开引用会话。') }
  }, [openTask])
  useEffect(() => onOpenConversationRequest(openConversation), [openConversation])
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
  const newProjectTask = useCallback(async (path: string): Promise<void> => {
    const id = await controller.createProjectTask(path)
    if (!id) throw new Error('资料仍在上传，请完成后再新建任务。')
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation', workspace: false })
    setSearch('')
    setFilter('all')
  }, [set, controller.createProjectTask])
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
    flushSessionDrafts(storageSource)
    if (!getSessionState(storageSource).tasks.some(item => item.id === run.sessionId)) {
      const status: SessionTask['status'] = root.status === 'running' ? 'running' : root.status === 'waiting' ? 'waiting'
        : root.status === 'succeeded' ? 'done' : root.status === 'failed' ? 'error' : root.status === 'cancelled' ? 'stopped' : 'interrupted'
      updateSessionState(storageSource, previous => ({ ...previous, tasks: [{ id: run.sessionId, title: run.snapshot.name, draft: '', status,
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
  // The workspace card is a destination switcher. Opening its 成果 entry
  // should return to the stable overview instead of replaying a stale file
  // review selection from a previous turn.
  const openWorkspaceOverview = useCallback((tab: WorkspaceTab): void => {
    if (tab === 'files') {
      setFinalSelection(null)
      setChangeSelection(null)
    }
    openWorkspace(tab)
  }, [openWorkspace])
  const openSubagents = useCallback((): void => {
    if (!task) return
    openWorkspace('subagents')
    set({ page: 'home', workspace: true, pane: 'workspace' })
  }, [task?.id, openWorkspace, set])
  const openGit = useCallback((): void => {
    if (!task) return
    openWorkspace('git')
    set({ page: 'home', workspace: true, pane: 'workspace' })
  }, [task?.id, openWorkspace, set])
  useEffect(() => onSessionSubagentRequest(request => {
    if (request.source !== getEngineSource() || request.sessionId !== task?.id) return
    setSubagentReveal(request)
    openWorkspace('subagents')
  }), [task?.id, openWorkspace])
  const openRunningTerminal = useCallback((jobId?: string): void => {
    if (!task) return
    const services = partitionCommandJobs(controller.commandJobs, task.id)
    setTerminalReveal({ scope: JSON.stringify([browserSource, task.id]), request: {
      jobId: jobId ?? services.running[0]?.jobId ?? services.history[0]?.jobId ?? null,
      revision: ++terminalRevision.current
    } })
    set({ page: 'home', workspace: true, tab: 'terminal', pane: 'workspace' })
    setNavigationOpen(false)
  }, [task?.id, browserSource, controller.commandJobs, set])
  // The home composer owns a real session too. Publishing that identity keeps
  // its running work visible in the global activity tray even before it is
  // promoted into a project task.
  usePublishServiceTrayContext({ source: browserSource, sessionId: task?.id ?? controller.securitySessionId,
    jobs: controller.commandJobs, tools: activityTools,
    onOpenTerminal: task ? openRunningTerminal : undefined,
    onOpenSubagents: task ? openSubagents : undefined,
    onOpenGit: task ? openGit : undefined })
  useEffect(() => onSessionTerminalRequest(action => {
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
  }), [task?.id, task?.workspacePath, browserSource, view.page, view.workspace, view.tab, view.pane, set])
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
      const revision = requestSessionPreview(getEngineSource(), controller.securitySessionId, path)
      openArtifact(`path:${path}`)
      return waitForSessionPreview(controller.securitySessionId, path, current, revision)
    }
  })
  const setWorkspaceTab = useCallback((tab: WorkspaceTab): void => set({ tab }), [set])
  const closeWorkspace = useCallback((): void => {
    // The leading control is the workspace pane's collapse action. The home
    // surface is opened explicitly when the last workspace destination closes.
    set({ workspace: false, pane: 'conversation' })
    setWorkspaceFocusRequest(previous => previous + 1)
  }, [set])
  const openWorkspaceHome = useCallback((): void => {
    set({ workspace: true, tab: 'home', pane: 'workspace' })
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
        title: '新建任务',
        category: '会话',
        run: () => {
          newTaskRef.current()
        }
      }),
    []
  )

  return (
    <ImageConversationProvider active={Boolean(controller.securitySessionId)}
      value={{ scope: JSON.stringify([getEngineSource(), task?.id ?? 'home', controller.securitySessionId, controller.workspacePath]), addImage: controller.addImage }}>
    <ToolImageGalleryProvider messages={controller.messages} source={getEngineSource()} sessionId={controller.securitySessionId ?? ''} active={true}>
    <SessionReferenceProvider controller={controller} onSources={() => openWorkspace('sources')}
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
      <aside className="work-sidebar" aria-label="应用导航">
        <div className="work-sidebar__top">
          <span className="work-sidebar__brand">我的工作</span>
          <IconButton
            icon="layout-sidebar"
            label={
              (compactNavigation ? !navigationOpen : view.collapsed)
                ? '展开 应用导航'
                : '收起 应用导航'
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
          {[...NAVIGATION.map(item => ({ ...item, key: item.id })), ...extensions.navigation.flatMap(item => isExtensionDestination(item.page) ? [{ id: item.page, label: item.title, icon: extensionIcon(item.icon), key: item.id }] : [])].map((item) => (
            <button
              key={item.key}
              type="button"
              className="work-navigation__item"
              aria-current={view.page === item.id ? 'page' : undefined}
              title={item.label}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.id === 'home' && (waiting > 0 || runningCount > 0) && <b className="work-count"
                title={waiting ? `${waiting} 个任务等待处理` : `${runningCount} 个任务运行中`}
                aria-label={waiting ? `${waiting} 个任务等待处理` : `${runningCount} 个任务运行中`}
                data-waiting={waiting > 0 || undefined}>{waiting || runningCount}</b>}
            </button>
          ))}
        </nav>
        <SidebarHistory key={browserSource} tasks={controller.tasks} controller={controller}
          selectedTaskId={view.page === 'home' ? task?.id ?? null : null}
          visible={compactNavigation ? navigationOpen : !view.collapsed} onOpen={openTask}
          onCreateTask={path => path ? newProjectTask(path) : newTask()}
          projectPreferencesKey={sessionStorageKey('aether.work.projects.v1', getEngineStorageKey())} />
        <div className="work-sidebar__bottom">
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
      <main className="work-main">
        <Suspense fallback={<div className="application-loading" role="status">正在打开…</div>}>
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
                    <TaskStatus task={task} ready={controller.ready} />
                    <TaskActions
                      task={task}
                      controller={controller}
                      compact
                      showStop={false}
                      onSelectConversation={() => conversationSelectionToggle.current?.()}
                      conversationSelected={conversationSelectMode}
                      conversationDisabled={controller.messages.length === 0}
                    />
                    <SessionRootStop key={task.id} controller={controller} />
                    <ResourceTabs
                      key={`${browserSource}:${task.id}`}
                      sessionId={task.id}
                      focusRequest={workspaceFocusRequest}
                      activeTab={view.workspace && (!singlePane || view.pane === 'workspace') ? view.tab : undefined}
                      visibleWorkspaceIds={[
                        'home',
                        'workspace',
                        ...(task.sources.length ? ['sources'] : []),
                        ...(controller.artifacts.length ? ['files'] : []),
                        ...(partitionCommandJobs(controller.commandJobs, task.id).running.length ? ['terminal'] : []),
                        ...(controller.publishedFixedChildren ? ['subagents'] : [])
                      ]}
                      onSelect={() => openWorkspace('browser')}
                      onNewTab={openWorkspaceHome}
                      items={workspaceSurfaceTabs(extensions.workspaceTabs).map(([id, label, icon]) => ({
                        id, label, icon, onSelect: () => openWorkspaceOverview(id)
                      }))}
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
                />
              </div>
              {workspaceMotion.present && (
                <>
                  <SessionDivider ratio={view.ratio} setRatio={setRatio} />
                  <Workspace
                    key={`${getEngineSource()}:${task.id}`}
                    motionProps={workspaceMotion.motionProps}
                    controller={controller}
                    active={view.workspace && (!singlePane || view.pane === 'workspace')}
                    tab={view.tab}
                    setTab={setWorkspaceTab}
                    openEntries={workspaceTabs.entries}
                    setOpenEntries={workspaceTabs.setEntries}
                    onClose={closeWorkspace}
                    onOpenHome={openWorkspaceHome}
                    selectedArtifact={selectedArtifact}
                    fileRevealRequest={fileRevealRequest?.scope === fileTreeScope ? fileRevealRequest : null}
                    onDidReveal={acknowledgeFileReveal}
                    selectArtifact={openArtifact}
                    changeSelection={changeSelection?.sessionId === task.id ? changeSelection : null}
                    finalSelection={finalSelection?.sessionId === task.id ? finalSelection : null}
                    onOpenArtifacts={openSessionArtifacts}
                    terminalReveal={terminalReveal?.scope === JSON.stringify([browserSource, task.id]) ? terminalReveal.request : null}
                    subagentReveal={subagentReveal?.source === getEngineSource() && subagentReveal.sessionId === task.id ? subagentReveal : null}
                  />
                </>
              )}
            </div>
          </>
        ) : view.page === 'home' ? (
          <Home controller={controller} tasks={activeTasks} filter={filter} onFilter={setFilter}
            search={search} onSearch={setSearch} onOpenTask={openTask} />
        ) : isExtensionDestination(view.page) ? (
          <ExtensionPage contributionId={view.page} context={extensionTarget?.pageId === view.page && extensionTarget.source === getEngineSource() && extensionTarget.sessionId === task?.id ? { ...extensionContext, ...extensionTarget.context } : extensionContext} />
        ) : view.page === 'browser' ? (
          <section className="work-standalone-browser" aria-label="浏览器">
            <header className="work-task-heading">
              <h1>浏览器</h1>
              <span className="work-note">浏览网页、查阅资料，随时开始工作。</span>
            </header>
            <Browser />
          </section>
        ) : view.page === 'projects' ? (
          <Projects key={getEngineStorageKey()} source={getEngineStorageKey()}
            tasks={controller.tasks} ready={controller.ready} controller={controller} onOpenTask={openTask} onNewTask={newProjectTask}
            remote={controller.remote} uploading={controller.uploading} />
        ) : view.page === 'monitor' ? (
          <EngineMonitorView tasks={controller.tasks} />
        ) : view.page === 'plugins' ? (
          <div className="work-page"><PluginManager key={getEngineSource()} ready={controller.ready} onCreateWithAI={() => {
            controller.preparePluginTask()
            set({ page: 'home', pane: 'conversation', workspace: false })
          }} /></div>
        ) : view.page === 'agents' ? (
          <div className="work-page work-page--agents"><div className="work-page__inner work-page__inner--agents"><AgentManager
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
        </Suspense>
      </main>
    </div>
    </SessionReferenceProvider>
    </ToolImageGalleryProvider></ImageConversationProvider>
  )
}
