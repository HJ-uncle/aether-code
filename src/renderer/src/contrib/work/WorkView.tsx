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
  type MouseEvent
} from 'react'
import type { ChatAttachment, ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import {
  AttachmentChip,
  AttachmentPreviewDialog,
  type AttachmentPreview
} from '../chat/AttachmentChip'
import type { EngineFileChange } from '@shared/ipc'
import type { CronAutomationRun } from '@shared/automation'
import type { ChatRecoverySnapshot } from '@renderer/core/engine/chat-recovery'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { useApp } from '@renderer/core/app-context'
import { toast } from '@renderer/core/toast'
import { getAppMode, useAppMode } from '@renderer/core/platform/app-mode'
import { getEngineSource, getEngineStorageKey, isRemoteEngine } from '@renderer/core/engine/source'
import { setBrowserSessionOverride } from '@renderer/core/browser/connection'
import { registerCommand } from '@renderer/core/platform/commands'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { IconButton, SectionHeading, Spinner } from '@renderer/workbench/ui-primitives'
import { openAppSettings } from '../settings/app-settings-navigation'
import { ToolResult } from '../chat/ToolResult'
import { UserMessageContent } from '../chat/UserMessageContent'
import { FileChangeCard } from '../chat/FileChangeCard'
import { computeLineDiff, diffForDeletedFile, diffForNewFile, diffStats } from '../chat/diff'
import { FileGlyph } from '../explorer/FileGlyph'
import { classifyChatLink } from '../chat/chat-link'
import type { ChatFileContext } from '../chat/chat-link'
import { openFileFromChat } from '../chat/open-file'
import { useWorkController } from './work-runtime'
import { WorkBrowser } from './WorkBrowser'
import { WorkComposer as WorkComposerV2 } from './WorkComposer'
import { WorkNextTurnQueuePanel } from './WorkNextTurnQueue'
import { WorkTaskActions } from './WorkTaskActions'
import { WorkArtifactPanel } from './WorkArtifactPanel'
import { workArtifactSelectionQuote, type WorkArtifactContent } from './work-artifact-content'
import { WorkSourcePreview, useWorkSourceFile } from './WorkSourcePreview'
import { Markdown } from '../chat/Markdown'
import { paths, readExternalFile, resolveSessionFilePath } from '@renderer/core/workspace/fs-client'
import { WorkGitPanel } from './WorkGitPanel'
import { WorkSubagentsPanel } from './WorkSubagentsPanel'
import { PublishedRecoveryNotice } from '../chat/PublishedRecoveryNotice'
import { WorkInlineActivity } from './WorkInlineActivity'
import { WorkAgentManager } from './WorkAgentManager'
import { workMessageTimeline, workToolTarget } from './work-message-timeline'
import { workSubagentName } from './work-subagents'
import { formatActivityValue, readActivityPreview } from './work-activity-presentation'
import { WORK_ACTIVITY_PAGE_SIZE, WORK_MESSAGE_PAGE_SIZE, WORK_TASK_PAGE_SIZE, workMessageRange, workPageRange, workPaneRatio, workToolSnapshot, type WorkToolSnapshot } from './work-view-performance'
import { requestedThinkingMode } from '../chat/session-request-config'
import { AutomationsView } from '../automations/AutomationsView'
import { subscribeAutomationEditor } from '../automations/automation-navigation'
import { EngineMonitorView } from './EngineMonitorView'
import { WorkErrorNotice } from './WorkErrorNotice'
import { flushWorkDrafts, getWorkDraft, getWorkState, updateWorkState, type WorkArtifact } from './work-state'
import { findWorkArtifact } from './work-artifact-utils'
import { hideBrowserSurfaces, useBrowserState } from '../browser/browser-store'
import './work.css'
import '../chat/apple-chat-panels.css'
import { WorkResourceTabs } from './WorkResourceTabs'
import { openExternalWorkFileResource, openExternalWorkPathResource, resolvedWorkResourceId, selectWorkResource, useWorkResources, workResourceBrowserTabs } from './work-resource-store'
import { changesForWorkFile, type SessionFileChange } from './work-file-changes'

type WorkController = ReturnType<typeof useWorkController>
type WorkTask = WorkController['tasks'][number]
type Page = 'home' | 'projects' | 'artifacts' | 'browser' | 'automations' | 'connections' | 'agents' | 'monitor'
type WorkspaceTab = 'artifacts' | 'sources' | 'browser' | 'activity' | 'subagents' | 'git'
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
const changeStatCache = new WeakMap<EngineFileChange, ReturnType<typeof diffStats> | null>()
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
  { id: 'artifacts', label: '成果', icon: 'file' },
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
const TOOL_STATUS: Record<ToolActivity['state'], string> = {
  running: '进行中',
  done: '已完成',
  error: '失败',
  unknown: '状态未知',
  cancelled: '已停止',
  waiting: '等待中',
  interrupted: '已中断'
}

function initialView(): ViewState {
  const fallback: ViewState = {
    page: 'home',
    collapsed: false,
    workspace: false,
    tab: 'artifacts',
    pane: 'conversation',
    ratio: 44
  }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
    if (!value || typeof value !== 'object') return fallback
    const record = value as Record<string, unknown>
    return {
      page: NAVIGATION.some((item) => item.id === record.page) ? (record.page as Page) : 'home',
      collapsed: record.collapsed === true,
      workspace: record.workspace === true,
      tab: ['artifacts', 'sources', 'browser', 'activity', 'subagents', 'git'].includes(String(record.tab))
        ? (record.tab as WorkspaceTab)
        : 'artifacts',
      pane: record.pane === 'workspace' ? 'workspace' : 'conversation',
      ratio: typeof record.ratio === 'number' ? Math.min(62, Math.max(35, record.ratio)) : 44
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
  const target = classifyChatLink(href, controller.activeTask.id, engineUrl)
  if (target.kind === 'external') return
  event.preventDefault()
  event.stopPropagation()
  if (target.kind === 'invalid') {
    toast.error(target.message)
    return
  }
  const path = target.path.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '')
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
  const browser = useBrowserState()
  const browserSource = getEngineSource()
  useLayoutEffect(() => {
    // The browser bridge must already know Work's task (or persisted home
    // session) when browser_open is the first tool, without a mounted panel.
    setBrowserSessionOverride(controller.securitySessionId, browserSource)
  }, [controller.securitySessionId, browserSource])
  useEffect(() => () => setBrowserSessionOverride(null), [])
  const [view, setView] = useState(initialView)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null)
  const [activitySelection, setActivitySelection] = useState<ActivitySelection | null>(null)
  const [automationRequest, setAutomationRequest] = useState<{ jobId: string; revision: number } | null>(null)
  const automationRequestRevision = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const [compactNavigation, setCompactNavigation] = useState(window.innerWidth <= 1160)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const set = useCallback((patch: Partial<ViewState>): void =>
    setView((previous) => ({ ...previous, ...patch })), [])
  const task = controller.activeTask
  const workResources = useWorkResources(task?.id ?? '')
  const activeTasks = useMemo(() => controller.tasks.filter((item) => !item.archived), [controller.tasks])
  const archivedTasks = useMemo(() => controller.tasks.filter((item) => item.archived), [controller.tasks])
  const waiting = useMemo(() => activeTasks.filter((item) => item.status === 'waiting').length, [activeTasks])
  const filteredTasks = useMemo(() => {
    const query = search.toLocaleLowerCase()
    return activeTasks.filter(item => (filter === 'all' || item.status === filter) && item.title.toLocaleLowerCase().includes(query))
  }, [activeTasks, filter, search])
  const revealRequestId = browser.revealRequest?.requestId ?? null
  const handledRevealRef = useRef<string | null>(null)
  useEffect(() => {
    if (!task || !workResources.reveal || appMode !== 'work') return
    set({ page: 'home', workspace: true, tab: 'browser', pane: 'workspace' })
  }, [task?.id, workResources.reveal, appMode, set])
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view))
    } catch {
      /* Layout persistence must not block task execution. */
    }
  }, [view])
  useEffect(() => {
    // Browser tool requests can arrive while Work's workspace is closed. Open
    // the owning surface before BrowserService waits for fresh native bounds.
    if (!revealRequestId || handledRevealRef.current === revealRequestId) return
    handledRevealRef.current = revealRequestId
    if (appMode !== 'work') return
    if (task && browser.revealRequest) {
      if (!workResourceBrowserTabs(browser.tabs, task.id).some(item => item.tabId === browser.revealRequest?.tabId)) return
      selectWorkResource(task.id, `web:${browser.revealRequest.tabId}`)
    }
    setView((previous) => !task
      ? { ...previous, page: 'browser' }
      :
      previous.page === 'home' && previous.workspace && previous.tab === 'browser'
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
      if (width) setCompactNavigation(width <= 1160)
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
  }, [controller.artifacts, selectedArtifact])
  const navigate = useCallback((page: Page): void => {
    set({ page })
    setNavigationOpen(false)
    if (page === 'home') controller.showHome()
  }, [set, controller.showHome])
  const openTask = useCallback((id: string): void => {
    controller.selectTask(id)
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
  }, [set, controller.selectTask])
  const newTask = useCallback((): void => {
    controller.showHome()
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
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
  const openArtifact = useCallback((id: string, openResource = true): void => {
    setSelectedArtifact(id)
    if (!openResource) return
    const artifact = controller.artifacts.find(item => item.id === id)
    const path = artifact?.path ?? (id.startsWith('path:') ? id.slice(5) : null)
    if (path && task) void openFileFromChat(path, { sessionId: task.id, workspaceRoot: task.workspacePath }).catch(async (reason: unknown) => {
      // A Work receipt can legitimately reference a sibling directory or a
      // file the user dragged in. If the session-scoped resolver rejects it,
      // offer a read-only local resource instead of a dead "outside workspace"
      // panel. No external fallback is attempted for remote engines.
      if (isRemoteEngine()) { reportError(reason); return }
      const raw = path.replace(/^path:/, '')
      const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(raw)
      const candidates = absolute
        ? task.workspacePath && (paths.contains(task.workspacePath, raw) || paths.contains(paths.dirname(task.workspacePath), raw)) ? [raw] : []
        : task.workspacePath
          ? [paths.join(task.workspacePath, raw), paths.join(paths.dirname(task.workspacePath), raw)]
          : []
      for (const candidate of candidates) {
        try {
          await readExternalFile(candidate)
          openExternalWorkPathResource(candidate, task.id)
          openWorkspace('browser')
          return
        } catch {
          // Try the sibling candidate before reporting the original resolver
          // error; the candidate probe is read-only and size-limited.
        }
      }
      reportError(reason)
    })
    else openWorkspace('artifacts')
  }, [controller.artifacts, task?.id, task?.workspacePath, openWorkspace])
  const setWorkspaceTab = useCallback((tab: WorkspaceTab): void => set({ tab }), [set])
  const setRatio = useCallback((ratio: number): void => set({ ratio }), [set])
  const openActivity = useCallback((toolId: string): void => {
    if (!task) return
    setActivitySelection(previous => ({ taskId: task.id, toolId, revision: (previous?.revision ?? 0) + 1 }))
    openWorkspace('activity')
  }, [task?.id, openWorkspace])
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
    <div
      className="work-view"
      ref={rootRef}
      data-collapsed={view.collapsed}
      data-nav-open={compactNavigation && navigationOpen}
    >
      {compactNavigation && navigationOpen && (
        <button
          className="work-navigation-scrim"
          type="button"
          aria-label="关闭导航抽屉"
          onClick={() => setNavigationOpen(false)}
        />
      )}
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
              {item.id === 'home' && waiting > 0 && <b className="work-count">{waiting}</b>}
            </button>
          ))}
        </nav>
        <div className="work-sidebar__recent">
          <span className="work-eyebrow">最近任务</span>
          {activeTasks.slice(0, 6).map((item) => (
            <button
              key={item.id}
              type="button"
              className="work-sidebar__task"
              title={!controller.ready && (item.status === 'running' || item.status === 'waiting')
                ? `${item.title} · 连接中断，等待恢复确认` : item.title}
              aria-current={task?.id === item.id && view.page === 'home' ? 'true' : undefined}
              onClick={() => openTask(item.id)}
            >
              <span>{item.title}</span>
              {!controller.ready && (item.status === 'running' || item.status === 'waiting') ? (
                <Icon name="warning" size={12} />
              ) : item.status === 'running' ? (
                <Spinner size={11} />
              ) : item.status === 'waiting' ? (
                <Icon name="circle-dot" size={12} />
              ) : null}
            </button>
          ))}
          {!activeTasks.length && <p>开始后，任务会保存在这里。</p>}
          {archivedTasks.length > 0 && (
            <details className="work-sidebar__archived">
              <summary>已归档 {archivedTasks.length}</summary>
              {archivedTasks.slice(0, 5).map((item) => (
                <div key={item.id} className="work-sidebar__archived-row">
                  <button
                    type="button"
                    className="work-sidebar__task"
                    onClick={() => openTask(item.id)}
                    title={item.title}
                  >
                    <span>{item.title}</span>
                  </button>
                  <WorkTaskActions task={item} controller={controller} />
                </div>
              ))}
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
      <main className="work-main">
        {view.page === 'home' && task ? (
          <>
            <header className="work-task-heading">
              <div className="work-task-heading__title">
                <button type="button" className="work-breadcrumb" onClick={newTask}>
                  工作台
                </button>
                <span aria-hidden="true">/</span>
                <h1 title={task.title}>{task.title}</h1>
                <span
                  className="work-task-heading__project"
                  title={task.workspacePath ?? undefined}
                >
                  {task.workspacePath ? filename(task.workspacePath) : '独立任务'}
                </span>
                <button
                  type="button"
                  className="work-task-heading__agent"
                  aria-label="查看 Agent 配置"
                  title={controller.agentIdentity.error
                    ? `${controller.agentIdentity.error} · Agent ID：${controller.agentId}`
                    : `${controller.agentIdentity.name || '正在读取 Agent'}${controller.agentLocked ? ' · 当前任务使用的 Agent 已固定' : ''}`}
                  onClick={() => navigate('agents')}
                >
                  <Icon name={controller.agentId ? 'account-outline' : 'sparkles'} size={14} />
                  <span>{controller.agentIdentity.name || (controller.agentIdentity.loading ? '正在读取 Agent…' : 'Agent 配置不可用')}</span>
                </button>
              </div>
              <div className="work-task-heading__actions">
                <TaskStatus status={task.status} ready={controller.ready} />
                <WorkTaskActions task={task} controller={controller} compact showStop={false} />
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
                工作区{controller.artifacts.length ? ` · ${controller.artifacts.length}` : ''}
              </button>
            </div>
            <div
              className="work-task-body"
              data-workspace={view.workspace}
              data-pane={view.pane}
              style={{ '--work-conversation-ratio': `${view.ratio}%` } as CSSProperties}
            >
              <Conversation
                key={`${getEngineSource()}:${task.id}`}
                controller={controller}
                openWorkspace={openWorkspace}
                openActivity={openActivity}
                openArtifact={openArtifact}
              />
              {view.workspace && (
                <>
                  <WorkDivider ratio={view.ratio} setRatio={setRatio} />
                  <Workspace
                    key={`${getEngineSource()}:${task.id}`}
                    controller={controller}
                    tab={view.tab}
                    setTab={setWorkspaceTab}
                    selectedArtifact={selectedArtifact}
                    selectArtifact={openArtifact}
                    activitySelection={activitySelection?.taskId === task.id ? activitySelection : null}
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
            <WorkBrowser onReveal={() => set({ page: 'browser' })} />
          </section>
        ) : view.page === 'projects' ? (
          <Projects controller={controller} openTask={openTask} />
        ) : view.page === 'artifacts' ? (
          <div className="work-page">
            <div className="work-page__inner">
              <SectionHeading
                title="成果"
                description="查看当前任务中已经生成的文件，并继续修改。"
              />
              <TaskArtifactPanel
                controller={controller}
                selectedId={selectedArtifact}
                onSelect={setSelectedArtifact}
              />
              {!task && <p className="work-note">从工作台打开一个任务后，可在这里查看它的成果。</p>}
            </div>
          </div>
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

function Conversation({
  controller,
  openWorkspace,
  openArtifact,
  openActivity
}: {
  controller: WorkController
  openWorkspace: (tab: WorkspaceTab) => void
  openArtifact: (id: string) => void
  openActivity: (toolId: string) => void
}): JSX.Element {
  const { engine } = useApp()
  const task = controller.activeTask!
  const positionKey = `${getEngineSource()}:${task.id}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(conversationPositions.get(positionKey)?.follow ?? true)
  const mode = useAppMode()
  const [following, setFollowing] = useState(followRef.current)
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const fileContext = useMemo<ChatFileContext>(() => ({ sessionId: task.id, workspaceRoot: task.workspacePath }), [task.id, task.workspacePath])
  const onFileLink = useCallback((event: MouseEvent<HTMLElement>): void => openWorkFileLink(event, controllerRef.current, engine.snapshot.baseUrl, openArtifact), [engine.snapshot.baseUrl, openArtifact])
  const openActivityFile = useCallback((path: string): void => {
    const active = controllerRef.current
    const artifact = findWorkArtifact(active.artifacts, path, active.activeTask?.workspacePath)
    openArtifact(artifact?.id ?? `path:${path}`)
  }, [openArtifact])
  const respond = useCallback<WorkController['respond']>((...args) => controllerRef.current.respond(...args), [])
  const retryFailedTask = useCallback<WorkController['retryFailedTask']>(() => controllerRef.current.retryFailedTask(), [])
  const [firstId, setFirstId] = useState<string | null>(() => conversationPositions.get(positionKey)?.firstId ?? null)
  const expandedHistory = useRef(conversationPositions.get(positionKey)?.expanded ?? false)
  const { start, end, newer } = useMemo(() => workMessageRange(controller.messages, firstId), [controller.messages, firstId])
  const firstIdRef = useRef(firstId)
  firstIdRef.current = controller.messages[start]?.id ?? firstId
  const prependAnchor = useRef<{ id: string; offset: number } | null>(null)
  const archiveNavigation = useRef<'older' | 'newer' | 'latest' | null>(null)
  const restoredPosition = useRef(false)
  useLayoutEffect(() => {
    if (!firstId && controller.messages.length) setFirstId(controller.messages[start].id)
    // Do not remove an older message while it is being read or copied. At the
    // live tail, advance the bounded window only when a new message arrives.
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
    if (element && followRef.current && element.clientHeight)
      element.scrollTop = element.scrollHeight
  }, [controller.messages, controller.loading, controller.streaming, controller.launching, mode, firstId])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (followRef.current && element.clientHeight) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const latest = (): void => {
    if (controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages) {
      archiveNavigation.current = 'latest'
      void controller.loadArchive('latest')
      return
    }
    expandedHistory.current = false
    followRef.current = true
    setFollowing(true)
    setFirstId(controller.messages[Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE)]?.id ?? null)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }
  const loadEarlier = (): void => {
    expandedHistory.current = true
    const element = scrollRef.current
    const anchor = controller.messages[start]
    const article = anchor && element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (element && article) prependAnchor.current = { id: anchor.id, offset: article.getBoundingClientRect().top - element.getBoundingClientRect().top }
    followRef.current = false
    setFollowing(false)
    setFirstId(controller.messages[Math.max(0, start - WORK_MESSAGE_PAGE_SIZE)].id)
  }
  const loadNewer = (): void => {
    const nextStart = Math.min(Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE), start + WORK_MESSAGE_PAGE_SIZE)
    const anchor = controller.messages[nextStart]
    const element = scrollRef.current
    const article = anchor && element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
    if (element && article) prependAnchor.current = { id: anchor.id, offset: article.getBoundingClientRect().top - element.getBoundingClientRect().top }
    expandedHistory.current = true
    followRef.current = false
    setFollowing(false)
    setFirstId(anchor?.id ?? null)
  }
  const loadArchivePage = (action: 'older' | 'newer'): void => {
    if (controller.archiveLoading) return
    archiveNavigation.current = action
    expandedHistory.current = true
    followRef.current = false
    setFollowing(false)
    void controller.loadArchive(action)
  }
  useLayoutEffect(() => {
    const action = archiveNavigation.current
    if (!action || !controller.archivePage) return
    archiveNavigation.current = null
    prependAnchor.current = null
    const atLatest = action === 'latest'
    expandedHistory.current = !atLatest
    followRef.current = atLatest
    setFollowing(atLatest)
    setFirstId(controller.messages[atLatest ? Math.max(0, controller.messages.length - WORK_MESSAGE_PAGE_SIZE) : 0]?.id ?? null)
    if (scrollRef.current) scrollRef.current.scrollTop = atLatest ? scrollRef.current.scrollHeight : 0
  }, [controller.archivePage])
  const inspectActivity = (target: EventTarget | null): void => {
    // Code's shared file cards activate with a role=button, including keyboard
    // events. All disclosures represent reading intent, regardless of markup.
    if (target instanceof Element && target.closest('.work-inline-activity button, .work-inline-activity [role="button"], .message__collapse-toggle')) {
      followRef.current = false
      setFollowing(false)
    }
  }
  return (
    <section className="work-conversation" aria-label="协作对话">
      <PublishedRecoveryNotice state={controller.publishedRecovery} onCancel={controller.cancelPublishedRecovery} onLoadBody={controller.loadPublishedBody} onRetry={controller.retryPublishedRecovery} />
      <div className="work-conversation__toolbar">
        <h2>协作对话</h2>
        {controller.usageSyncNotice ? <span className="subagent-history__notice" role="status" title={controller.usageSyncNotice}>统计待同步</span> : null}
        <div>
          <button type="button" onClick={() => openWorkspace('sources')}>
            资料{task.sources.length ? ` ${task.sources.length}` : ''}
          </button>
          <button type="button" onClick={() => openWorkspace('artifacts')}>
            成果{controller.artifacts.length ? ` ${controller.artifacts.length}` : ''}
          </button>
          <button type="button" onClick={() => openWorkspace('activity')}>
            活动
          </button>
          <button type="button" onClick={() => openWorkspace('subagents')}>
            子代理
          </button>
        </div>
      </div>
      {controller.recoveryNotice ? (
        <div className="chat__notice chat__notice--info" role="status" aria-live="polite">
          <span>{controller.recoveryNotice}</span>
          <button type="button" className="chat__toolbar-btn" onClick={controller.dismissRecoveryNotice}>知道了</button>
        </div>
      ) : null}
      <div
        className="work-conversation__scroll"
        ref={scrollRef}
        onClickCapture={(event) => inspectActivity(event.target)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inspectActivity(event.target)
        }}
        onScroll={(event) => {
          const node = event.currentTarget
          if (!node.clientHeight) return
          const bottom = newer === 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 70
          followRef.current = bottom
          setFollowing(bottom)
        }}
      >
        <div className="work-conversation__content" data-history-start={start} data-history-end={end}>
          {controller.archiveError ? <p className="chat__notice" role="alert">{controller.archiveError}</p> : null}
          {controller.archivePage?.unversioned ? <p className="subagent-history__notice" role="status">归档第 {controller.archivePage.firstPage} / {controller.archivePage.totalPages} 页 · 引擎未提供跨页版本一致性，每次仅显示当前页。</p> : null}
          {start === 0 && controller.historyCompacted ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.archiveLoading || controller.streaming || controller.launching} onClick={() => loadArchivePage('older')}>{controller.archiveLoading ? '正在加载历史归档…' : controller.archiveRemaining === null ? '查看更早归档' : `查看更早归档（${controller.archiveRemaining} 条）`}</button> : null}
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
          {controller.messages.slice(start, end).map((message) => (
            <WorkMessage
              key={message.id}
              message={message}
              fileContext={fileContext}
              onFileLink={onFileLink}
              openFile={openActivityFile}
              respond={respond}
              retryFailedTask={retryFailedTask}
              openActivity={openActivity}
            />
          ))}
          {newer > 0 ? <button type="button" className="btn btn--sm work-history-load" onClick={loadNewer}>查看较新消息（{newer} 条）</button> : null}
          {newer === 0 && controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages ? <button type="button" className="btn btn--sm work-history-load" disabled={controller.archiveLoading} onClick={() => loadArchivePage('newer')}>查看较新归档页</button> : null}
          <WorkTurnFeedback controller={controller} announce={following} openActivity={openActivity} />
        </div>
      </div>
      <div className="work-conversation__footer">
        {(!following || (controller.archivePage?.unversioned && controller.archivePage.lastPage < controller.archivePage.totalPages)) && (
          <button className="work-follow-latest" type="button" disabled={controller.archiveLoading} onClick={latest}>
            <Icon name="chevron-down" size={14} />
            回到最新
          </button>
        )}
        {!following && <WorkRunStatus controller={controller} />}
        <WorkNextTurnQueuePanel key={`${controller.draftSource}:${task.id}`} scopeKey={`${controller.draftSource}:${task.id}`} queue={controller.nextTurnQueue} />
        <WorkComposerV2 controller={controller} />
      </div>
    </section>
  )
}

/** Only real engine events change the phase; elapsed time never invents progress. */
function useWorkRunFeedback(controller: WorkController, tick = true) {
  const mode = useAppMode()
  const [now, setNow] = useState(Date.now)
  const waiting = controller.pending.length > 0
  const active = controller.streaming || controller.launching || waiting
  const message = controller.messages.findLast((item) => item.role === 'assistant')
  const current = message && ['streaming', 'waiting'].includes(message.status) ? message : null
  const startedAt = current?.run?.startedAt ?? current?.startedAt ?? current?.createdAt
    ?? (controller.launching ? controller.activeTask?.createdAt : undefined)
  const running = current
    ? [...current.tools].reverse().find((tool) => tool.state === 'running' && isVisibleToolActivity(tool))
    : null
  const compacting = current?.run?.compaction?.phase === 'running'
  const thinking = current?.items?.at(-1)?.kind === 'thinking' || Boolean(current && !current.items?.length && current.thinking && !current.content && !running)
  const phase = controller.launching
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
  const label = controller.launching
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
    if (!active || mode !== 'work' || !tick) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, mode, tick])

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
  // A historical inline card stays quiet; only the visible status owns a clock.
  const feedback = useWorkRunFeedback(controller, announce)
  if (!feedback.active) return null
  const target = feedback.running ? workToolTarget(feedback.running, controller.workspacePath) : ''
  const agentName = feedback.running && (feedback.running.name === 'subagent' || feedback.running.subagent)
    ? workSubagentName(feedback.running)
    : controller.agentIdentity.name || 'Agent'
  const detail = feedback.phase === 'preparing'
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
    <div className="work-turn-feedback" data-phase={feedback.phase} data-state={feedback.waiting ? 'waiting' : 'running'} data-current-run-feedback={announce ? 'true' : undefined} aria-label="Agent 执行反馈">
      <span className="work-turn-feedback__indicator" aria-hidden="true">
        {feedback.waiting ? <Icon name="chat" size={16} /> : <Spinner size={16} />}
      </span>
      <div className="work-turn-feedback__body">
        <div className="work-turn-feedback__heading">
          <strong title={agentName}>{agentName}</strong>
          <span role="status" aria-live={announce ? 'polite' : 'off'} aria-label="任务运行状态">{feedback.label}</span>
          <span className="work-turn-feedback__elapsed" title="本轮累计用时（含等待）">{feedback.elapsed}</span>
        </div>
        {feedback.running ? (
          <button type="button" className="work-turn-feedback__activity" aria-label="查看正在执行的活动" onClick={() => openActivity(feedback.running!.id)}>
            <span>{detail}</span><Icon name="chevron-right" size={12} />
          </button>
        ) : <p>{detail}</p>}
      </div>
    </div>
  )
}

/** Root cancellation stays discoverable when the conversation pane is hidden. */
function WorkRootStop({ controller }: { controller: WorkController }): JSX.Element | null {
  const [stopping, setStopping] = useState(false)
  const active = controller.pendingInitialStart || controller.streaming || controller.launching || controller.pending.length > 0 || ['running', 'waiting'].includes(controller.activeTask?.status ?? '')
  if (!active) return null
  return <button className="btn btn--sm" type="button" aria-label={stopping ? '正在停止任务' : '停止任务'} disabled={!controller.ready || stopping} onClick={() => {
    if (stopping) return
    setStopping(true)
    void controller.stop().catch(reportError).finally(() => setStopping(false))
  }}>
    {stopping ? <Spinner size={13} /> : <Icon name="stop" size={13} />}
    {stopping ? '正在停止…' : '停止任务'}
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
      <span className="work-run-status__elapsed" title="本轮累计用时（含等待）">
        {elapsed}
      </span>
    </div>
  )
}

/** 用户消息里的附件：与 Code 模式共用 AttachmentChip（图片缩略图 / 文件 chip，点击预览）。 */
function WorkAttachment({
  file,
  root,
  group
}: {
  file: ChatAttachment
  root: string | null
  group?: ChatAttachment[]
}): JSX.Element {
  const [preview, setPreview] = useState<AttachmentPreview | null>(null)
  const images = (group ?? [file]).filter((a) => a.type.startsWith('image/'))
  return (
    <>
      <AttachmentChip
        root={root}
        file={file}
        onPreview={(target, src) => setPreview({ file: target, src })}
      />
      {preview ? (
        <AttachmentPreviewDialog
          root={root}
          preview={preview}
          images={images}
          onNavigate={(next) => setPreview({ file: next, src: null })}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  )
}

const WorkMessage = memo(function WorkMessage({
  message,
  fileContext,
  onFileLink,
  openFile,
  respond,
  retryFailedTask,
  openActivity
}: {
  message: ChatMessage
  fileContext: ChatFileContext
  onFileLink: (event: MouseEvent<HTMLElement>) => void
  openFile: (path: string) => void
  respond: WorkController['respond']
  retryFailedTask: WorkController['retryFailedTask']
  openActivity: (toolId: string) => void
}): JSX.Element {
  const pending = useMemo(() =>
    message.interactions?.filter((item) => item.status === 'pending') ??
    (message.pending ? [message.pending] : []), [message.interactions, message.pending])
  const segments = useMemo(() => workMessageTimeline(message), [message])
  return (
    <article
      className={`work-message work-message--${message.role}`}
      aria-label={message.role === 'user' ? '用户消息' : 'AI 回复'}
      data-message-id={message.id}
      onClickCapture={onFileLink}
    >
      {message.role === 'user' ? (
        <div className="work-message__user">
          {message.attachments?.length ? (
            <div className="work-message__attachments" aria-label="附件">
              {message.attachments.map((file) => (
                <WorkAttachment key={file.path} file={file} root={fileContext.workspaceRoot ?? null} group={message.attachments} />
              ))}
            </div>
          ) : null}
          <div className="message__bubble"><UserMessageContent content={message.content} /></div>
        </div>
      ) : segments.map((segment, index) => segment.kind === 'tools' ? (
        <WorkInlineActivity key={segment.key} tools={segment.tools} fileContext={fileContext} onOpenActivity={openActivity} onOpenFile={openFile} />
      ) : (
        <Markdown
          key={segment.key}
          text={segment.text}
          streaming={message.status === 'streaming' && index === segments.length - 1}
          fileContext={fileContext}
        />
      ))}
      {message.error ? <WorkErrorNotice error={message.error} onRetry={retryFailedTask} retryLabel="重新发起任务" /> : null}
      {pending.map((item) => (
        <WorkPending
          key={item.requestId || item.toolCallId}
          pending={item}
          respond={respond}
        />
      ))}
      {message.answered && <p className="work-note">已回复：{message.answered}</p>}
    </article>
  )
})

function WorkPending({
  pending,
  respond
}: {
  pending: PendingInteraction
  respond: WorkController['respond']
}): JSX.Element {
  const key = pending.requestId || pending.toolCallId
  const [values, setValues] = useState<string[][]>(
    () => pendingDrafts.get(key)?.values ?? pending.groups.map(() => [])
  )
  const [freeText, setFreeText] = useState<string[]>(
    () => pendingDrafts.get(key)?.freeText ?? pending.groups.map(() => '')
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    rememberPendingDraft(key, { values, freeText })
  }, [key, values, freeText])
  const answers = pending.groups.map((_, index) =>
    [...(values[index] ?? []), freeText[index]?.trim()].filter(Boolean).join('、')
  )
  const submit = (): void => {
    if (submitting || answers.some((answer) => !answer) || !pending.requestId) return
    setSubmitting(true)
    setError('')
    void respond(pending.requestId, answers)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSubmitting(false))
  }
  return (
    <form
      className="work-pending"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <h3>{pending.kind === 'permission' ? '需要你的确认' : '请补充一下'}</h3>
      {pending.groups.map((group, index) => (
        <fieldset key={index} disabled={submitting}>
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
      {error ? <WorkErrorNotice error={error} onRetry={submit} retryLabel="重新提交回复" /> : null}
      <button
        className="btn btn--primary"
        type="submit"
        disabled={submitting || answers.some((answer) => !answer) || !pending.requestId}
      >
        {submitting ? '正在提交…' : '提交回复'}
      </button>
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

function Workspace({
  controller,
  tab,
  setTab,
  selectedArtifact,
  selectArtifact,
  activitySelection
}: {
  controller: WorkController
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  selectedArtifact: string | null
  selectArtifact: (id: string, openResource?: boolean) => void
  activitySelection: ActivitySelection | null
}): JSX.Element {
  const appMode = useAppMode()
  const [visited, setVisited] = useState(() => new Set<WorkspaceTab>([tab]))
  useEffect(() => setVisited(previous => {
    if (previous.has(tab)) return previous
    return new Set([...previous, tab])
  }), [tab])
  const tabs: Array<[WorkspaceTab, string]> = [
    ['artifacts', '成果'],
    ['sources', '资料'],
    ['browser', '资源'],
    ['activity', '活动'],
    ['subagents', '子代理'],
    ['git', 'Git']
  ]
  return (
    <section className="work-workspace" aria-label="任务工作区"
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
          setTab('browser')
        } catch (error) {
          reportError(error)
        }
      }}>
      <WorkResourceTabs sessionId={controller.activeTask!.id} active={tab === 'browser'} onSelect={() => setTab('browser')} />
      <div className="work-workspace__tools" role="toolbar" aria-label="工作区工具">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            id={`work-tab-${id}`}
            aria-controls={`work-panel-${id}`}
            aria-pressed={tab === id}
            key={id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'artifacts' && controller.artifacts.length > 0 && (
              <span>{controller.artifacts.length}</span>
            )}
          </button>
        ))}
      </div>
      {tabs.filter(([id]) => id === tab || (visited.has(id) && !['artifacts', 'sources', 'browser'].includes(id))).map(([id]) => (
        <WorkspacePane
          key={id}
          id={id}
          hidden={tab !== id}
          active={appMode === 'work' && tab === id}
          controller={controller}
          selectedArtifact={selectedArtifact}
          selectArtifact={selectArtifact}
          activitySelection={activitySelection}
          setTab={setTab}
          source={getEngineSource()}
        />
      ))}
    </section>
  )
}

/** Visited panes retain local drafts and selection, but hidden panes do not
 * rebuild message-derived diffs/activity on every incoming token. */
const WorkspacePane = memo(function WorkspacePane({ id, hidden, active, controller, selectedArtifact, selectArtifact, activitySelection, setTab }: {
  id: WorkspaceTab
  hidden: boolean
  active: boolean
  controller: WorkController
  selectedArtifact: string | null
  selectArtifact: (id: string, openResource?: boolean) => void
  activitySelection: ActivitySelection | null
  setTab: (tab: WorkspaceTab) => void
  source: number
}): JSX.Element {
  const revealBrowser = useCallback(() => setTab('browser'), [setTab])
  const sessionId = controller.activeTask?.id
  const workspacePath = controller.activeTask?.workspacePath
  const openGitFile = useCallback((path: string): void => {
    void openFileFromChat(path, { sessionId: sessionId ?? '', workspaceRoot: workspacePath }).catch(reportError)
  }, [sessionId, workspacePath])
  // Keep one derived tool snapshot per pane. `useChat` replaces the active
  // message object for each streamed token, while its tool receipt arrays stay
  // referentially stable until a tool actually changes. Passing this snapshot
  // lets the heavy activity/artifact/subagent panes skip text-only renders.
  const tools = useWorkTools(controller.messages)
  return <div
    className={`work-workspace__body work-workspace__body--${id}`}
    hidden={hidden}
    role="tabpanel"
    id={`work-panel-${id}`}
    aria-labelledby={`work-tab-${id}`}
  >
    {!active && ['artifacts', 'sources', 'browser'].includes(id) ? null : id === 'artifacts' ? (
            <TaskArtifactPanel
              controller={controller}
              active={active}
              selectedId={selectedArtifact}
              onSelect={selectArtifact}
            />
          ) : id === 'sources' ? (
            <SourcePanel controller={controller} />
          ) : id === 'activity' ? (
            <StableActivityPanel key={controller.activeTask?.id} tools={tools} todos={controller.todos} selection={activitySelection} workspacePath={controller.activeTask?.workspacePath} />
          ) : id === 'subagents' ? (
            <StableWorkSubagentsPanel
              sessionId={controller.activeTask?.id ?? null}
              rootRunId={controller.workspaceRunId}
              tools={tools}
              active={active}
              publishedFixedChildren={controller.publishedFixedChildren}
              busy={controller.streaming || controller.loading || controller.pending.length > 0 || controller.uploading}
              onContinue={controller.continueSubagent}
            />
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
            <WorkResourcePane controller={controller} onReveal={revealBrowser} />
          )}
  </div>
}, (previous, next) => !previous.active && !next.active && previous.hidden === next.hidden && previous.source === next.source && previous.controller.activeTask?.id === next.controller.activeTask?.id)

function WorkResourcePane({ controller, onReveal }: { controller: WorkController; onReveal: () => void }): JSX.Element {
  const sessionId = controller.activeTask!.id
  const resources = useWorkResources(sessionId)
  const browser = useBrowserState()
  const webTabs = workResourceBrowserTabs(browser.tabs, sessionId)
  const selected = resolvedWorkResourceId(resources, webTabs.map(tab => tab.tabId), browser.activeTabId)
  const file = resources.files.find(item => item.id === selected)
  const web = selected?.startsWith('web:') ? webTabs.find(item => item.tabId === selected.slice(4)) : undefined
  if (file) return <WorkResourceFile key={JSON.stringify([getEngineSource(), sessionId, file.id])} controller={controller} file={file} />
  if (web) return <WorkBrowser tabId={web.tabId} hideTabStrip onReveal={onReveal} />
  return <EmptyState icon="file" title="文件和网页，在同一个地方查看" description="从成果、资料或对话中打开文件，也可以拖入电脑文件或点击文件按钮；新建网页后也会显示在上方标签栏。" />
}

function WorkResourceFile({ controller, file }: { controller: WorkController; file: ReturnType<typeof useWorkResources>['files'][number] }): JSX.Element {
  // External resources still belong to the visible Work conversation for
  // references/drafts, while their preview deliberately carries no session
  // file target and therefore cannot be written by the Agent.
  const sessionId = controller.activeTask?.id ?? file.target?.sessionId
  const [tab, setTab] = useState<'preview' | 'changes'>('preview')
  const addExternalToConversation = async (): Promise<void> => {
    let input = file.externalFile
    if (!input && file.externalPath) {
      const result = await readExternalFile(file.externalPath)
      if (result.tooLarge || result.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请缩小文件后重试')
      const bytes = result.base64
        ? Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
        : new TextEncoder().encode(result.content)
      input = new File([bytes], file.name, { type: 'application/octet-stream', lastModified: Date.now() })
    }
    if (!input) throw new Error('外部文件已失效，请重新选择或拖拽文件')
    await controller.addFiles([input])
    toast.success('已加入对话资料，发送时将上传副本')
  }
  return <div className="work-artifacts-shell__detail work-resource-file">
    <div className="work-artifacts-shell__tabs" role="tablist" aria-label="文件内容">
      <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>预览</button>
      <button type="button" role="tab" aria-selected={tab === 'changes'} disabled={!file.target} onClick={() => setTab('changes')} title={file.target ? '查看此文件在任务中的改动' : '电脑文件没有任务改动记录'}>文件改动</button>
    </div>
    {tab === 'changes' && file.target ? <WorkChangesPanel sessionId={sessionId!} workspacePath={file.target.root} filePath={file.path} ready={controller.ready} streaming={controller.streaming} /> : <WorkArtifactPanel
    artifact={{ id: file.id, path: file.path, name: file.name, content: null, status: 'ready', createdAt: 0 }}
    workspaceRoot={file.target?.root} sessionId={sessionId} externalFile={file.externalFile} externalPath={file.externalPath} inResourceTab
    onAddToConversation={(item, selection, coverage) => {
      if (selection) {
        const draft = getWorkDraft(controller.draftSource, controller.activeTask?.id ?? null)
        controller.setDraft(`${draft.text}${draft.text ? '\n\n' : ''}${workArtifactSelectionQuote(item.name, item.path, selection, coverage)}`, draft.mentions)
        toast.success('已引用选中内容')
      } else if (file.externalFile || file.externalPath) {
        void addExternalToConversation().catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : String(reason)))
      } else {
        controller.addReference(item)
        toast.success('已添加到对话')
      }
    }}
  />}
  </div>
}

function TaskArtifactPanel({ controller, ...props }: {
  controller: WorkController
  active?: boolean
  selectedId: string | null
  onSelect: (id: string, openResource?: boolean) => void
}): JSX.Element {
  const tools = useWorkTools(controller.messages)
  return <StableArtifactPanel {...props} tools={tools} artifacts={controller.artifacts}
    sessionId={controller.activeTask?.id} workspacePath={controller.activeTask?.workspacePath}
    ready={controller.ready} streaming={controller.streaming} draftSource={controller.draftSource}
    setDraft={controller.setDraft} addReference={controller.addReference} />
}

function ArtifactPanel({
  artifacts,
  sessionId,
  workspacePath,
  ready,
  streaming,
  draftSource,
  setDraft,
  addReference,
  tools,
  active = true,
  selectedId,
  onSelect
}: {
  artifacts: WorkArtifact[]
  sessionId?: string
  workspacePath?: string | null
  ready: boolean
  streaming: boolean
  draftSource: string
  setDraft: WorkController['setDraft']
  addReference: WorkController['addReference']
  tools: ToolActivity[]
  active?: boolean
  selectedId: string | null
  onSelect: (id: string, openResource?: boolean) => void
}): JSX.Element {
  const linkedPath = selectedId?.startsWith('path:') ? selectedId.slice(5) : null
  const artifact =
    artifacts.find((item) => item.id === selectedId) ??
    (linkedPath
      ? {
          id: selectedId!,
          path: linkedPath,
          name: filename(linkedPath),
          content: null,
          status: 'draft' as const,
          createdAt: Date.now()
        }
      : artifacts[0] ?? null)
  const addToConversation = (
    item: WorkArtifact,
    selection?: string,
    selectionCoverage?: WorkArtifactContent['coverage']
  ): void => {
    if (selection) {
      // Drafts have their own subscription; read at click time so a memoized
      // preview appends to the latest input without rendering per keystroke.
      const draft = getWorkDraft(draftSource, sessionId ?? null)
      setDraft(
        `${draft.text}${draft.text ? '\n\n' : ''}${workArtifactSelectionQuote(item.name, item.path, selection, selectionCoverage)}`, draft.mentions
      )
    } else addReference(item)
  }
  const [detailTab, setDetailTab] = useState<'preview' | 'changes'>('preview')
  // Keep the compact list informative without exposing long workspace paths.
  // Stats come from the same diff implementation used by FileChangeCard, so the
  // numbers shown here always match the expanded diff below.
  const changeStats = useMemo(() => {
    const result = new Map<string, { added: number; removed: number; approximate: boolean }>()
    for (const tool of tools) {
        const change = tool.change
        if (!change || change.status === 'reverted') continue
        // Text tokens replace their message but retain immutable file receipts.
        // Reuse their diff rather than rerunning LCS for each streaming commit.
        const cached = changeStatCache.get(change)
        if (cached !== undefined) {
          if (cached) result.set(change.path.replace(/\\/g, '/'), cached)
          continue
        }
        const isNew = change.isNew ?? (!change.truncated && change.oldContent === null)
        const rows = change.truncated
          ? null
          : change.kind === 'delete'
            ? change.oldContent === null ? null : diffForDeletedFile(change.oldContent)
            : isNew
              ? change.newContent === null ? null : diffForNewFile(change.newContent)
              : change.oldContent === null || change.newContent === null
                ? null
                : computeLineDiff(change.oldContent, change.newContent)
        const stats = rows ? diffStats(rows) : null
        changeStatCache.set(change, stats)
        if (stats) result.set(change.path.replace(/\\/g, '/'), stats)
    }
    return result
  }, [tools])
  return (
    <div className="work-artifacts-shell">
      <div className="work-artifacts-shell__list" role="listbox" aria-label="成果文件">
        <div className="work-artifacts-shell__list-head">
          <h3>
            成果文件 <span>{artifacts.length}</span>
          </h3>
        </div>
        {artifacts.length ? (
          artifacts.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.id === artifact?.id}
              className={item.id === artifact?.id ? 'is-selected' : ''}
              key={item.id}
              onClick={() => onSelect(item.id, detailTab !== 'changes')}
              title={item.path}
            >
              <FileGlyph name={item.name} size={16} />
              <span>
                <strong>{item.name}</strong>
              </span>
              {(() => {
                const stats = changeStats.get(item.path.replace(/\\/g, '/'))
                return stats ? (
                  <span className="work-artifacts-shell__stats" title="文件改动行数">
                    <b>+{stats.added}</b><i>−{stats.removed}</i>
                  </span>
                ) : <span className={`work-artifacts-shell__status work-artifacts-shell__status--${item.status}`}>{item.status === 'ready' ? '已生成' : '进行中'}</span>
              })()}
            </button>
          ))
        ) : (
          <EmptyState
            icon="file"
            title="当前任务还没有成果文件"
            description="AI 创建或修改文件后，成果会出现在这里，可预览、复制或继续引用。"
          />
        )}
      </div>
      <div className="work-artifacts-shell__detail">
        <div className="work-artifacts-shell__tabs" role="tablist" aria-label="成果内容">
          <button type="button" role="tab" aria-selected={detailTab === 'preview'} onClick={() => setDetailTab('preview')}>预览</button>
          <button type="button" role="tab" aria-selected={detailTab === 'changes'} onClick={() => setDetailTab('changes')}>文件改动</button>
        </div>
        {detailTab === 'preview' ? (
          artifact ? (
            <WorkArtifactPanel
              artifact={artifact}
              workspaceRoot={workspacePath}
              sessionId={sessionId}
              artifacts={artifacts}
              onSelect={onSelect}
              onAddToConversation={(item, selection, selectionCoverage) => {
                addToConversation(item, selection, selectionCoverage)
                toast.success(selection ? '已引用选中内容' : '已添加到对话')
              }}
              onOpenFile={(item) =>
                void openFileFromChat(item.path, {
                  sessionId: sessionId ?? '',
                  workspaceRoot: workspacePath
                }).catch(reportError)
              }
            />
          ) : (
            <EmptyState
              icon="file"
              title="成果会出现在这里"
              description="AI 创建或修改文件后，可在此预览、复制或继续引用。"
            />
          )
        ) : (
          <WorkChangesPanel key={JSON.stringify([getEngineSource(), sessionId, artifact?.path])} sessionId={sessionId} workspacePath={workspacePath} filePath={artifact?.path} ready={ready} streaming={streaming} active={active} />
        )}
      </div>
    </div>
  )
}

const StableArtifactPanel = memo(ArtifactPanel)

function WorkChangesPanel({ sessionId, workspacePath, filePath, ready, streaming, active = true }: {
  sessionId?: string
  workspacePath?: string | null
  filePath?: string
  ready: boolean
  streaming: boolean
  active?: boolean
}): JSX.Element | null {
  const [changes, setChanges] = useState<EngineFileChange[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const previousStreaming = useRef(false)
  const refreshGeneration = useRef(0)
  const scopeGeneration = useRef(0)
  const mounted = useRef(false)
  const source = getEngineSource()
  useLayoutEffect(() => {
    mounted.current = true
    scopeGeneration.current += 1
    return () => {
      mounted.current = false
      scopeGeneration.current += 1
    }
  }, [sessionId, ready, source, active])
  const captureScope = (): { generation: number; source: ReturnType<typeof getEngineSource>; sessionId?: string; ready: boolean } => ({
    generation: scopeGeneration.current,
    source,
    sessionId,
    ready
  })
  const scopeCurrent = (scope: ReturnType<typeof captureScope>): boolean =>
    mounted.current &&
    scope.generation === scopeGeneration.current &&
    scope.source === getEngineSource() &&
    scope.sessionId === sessionId &&
    scope.ready === ready
  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current
    const scope = captureScope()
    const targetSessionId = scope.sessionId
    const isCurrent = (): boolean => generation === refreshGeneration.current && scopeCurrent(scope)
    if (!targetSessionId || !scope.ready || !filePath) {
      if (isCurrent()) {
        setChanges([])
        setError('')
        setLoading(false)
      }
      return
    }
    try {
      setLoading(true)
      const result = await requestOrThrow<SessionFileChange[]>({
        method: 'GET',
        path: '/changes',
        query: { sessionId: targetSessionId, status: 'pending', view: 'net' }
      })
      if (!isCurrent()) return
      setChanges(changesForWorkFile(Array.isArray(result) ? result : [], targetSessionId, filePath, workspacePath))
      setError('')
    } catch (reason) {
      if (!isCurrent()) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [ready, sessionId, source, filePath, workspacePath])
  useEffect(() => {
    if (active) void refresh()
  }, [refresh, active])
  useEffect(() => {
    if (active && previousStreaming.current && !streaming) void refresh()
    previousStreaming.current = active && streaming
  }, [streaming, refresh, active])
  if (!sessionId) return null
  return (
    <section className="work-changes-panel" aria-label="当前文件改动" data-file-path={filePath} aria-busy={loading}>
      <header className="work-changes-panel__heading">
        <FileGlyph name={filePath ? filename(filePath) : ''} size={16} />
        <strong title={filePath}>{filePath ? filename(filePath) : '请选择文件'}</strong>
        <span>本任务改动</span>
      </header>
      {loading ? <p className="work-changes-panel__notice" role="status"><Spinner size={14} />正在读取文件改动…</p> : error ? (
          <div className="work-changes-panel__error" role="alert">
            <p>暂时无法读取此文件的改动。<button type="button" onClick={() => void refresh()}>重试</button></p>
            <details><summary>查看详情</summary>{error}</details>
          </div>
        ) : changes.length ? (
          <div className="work-changes-panel__list">
            {changes.map((change) => (
              <FileChangeCard key={change.id} change={change} state="done" fileContext={{ sessionId, workspaceRoot: workspacePath }} />
            ))}
          </div>
        ) : <EmptyState icon="file" title={ready ? '此文件暂无待查看的改动' : '引擎尚未连接'} description={ready ? '这里只显示当前文件在本任务中的改动。已保留、已撤回或未记录的改动不会显示。' : '连接恢复后，可重新打开文件改动。'} />}
    </section>
  )
}

function SourcePanel({ controller }: { controller: WorkController }): JSX.Element {
  const sources = controller.activeTask?.sources ?? []
  const root = controller.activeTask?.workspacePath ?? null
  const [selectedPath, setSelectedPath] = useState<string | null>(sources[0]?.path ?? null)
  const selected = sources.find((item) => item.path === selectedPath) ?? null
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
              onSelect={() => {
                setSelectedPath(source.path)
                void openFileFromChat(source.path, { sessionId: controller.activeTask!.id, workspaceRoot: root }).catch(reportError)
              }}
            />
          ))}
        </ul>
        <div className="work-sources__preview">
          {selected ? (
            <WorkSourcePreview source={selected} root={root} sessionId={controller.activeTask?.id} />
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
      const target = sessionId ? await resolveSessionFilePath(sessionId, source.path)
        : root ? { path: paths.join(root, source.path) } : null
      if (!target) throw new Error('资料没有关联任务')
      await window.aether.fs.reveal(target.path)
    } catch (error) {
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

function WorkSteps({ todos }: { todos: WorkController['todos'] }): JSX.Element | null {
  if (!todos.length) return null
  return <details className="work-steps">
    <summary className="work-steps__header">
      <Icon name="check-all" size={15} />
      <strong>工作步骤</strong>
      <span>{todos.filter(todo => todo.status === 'done').length} / {todos.length}</span>
      <Icon name="chevron-down" size={13} />
    </summary>
    <ol>{todos.map(todo => <li key={todo.id}>
      <span>{todo.title}</span>
      <span className={`work-step-state work-step-state--${todo.status}`}>
        {todo.status === 'in_progress' && <Spinner size={11} />}
        {{ pending: '待开始', in_progress: '进行中', done: '已完成', cancelled: '已取消' }[todo.status]}
      </span>
    </li>)}</ol>
  </details>
}

function ActivityPanel({ tools, todos, selection, workspacePath }: {
  tools: ToolActivity[]
  todos: WorkController['todos']
  selection: ActivitySelection | null
  workspacePath?: string | null
}): JSX.Element {
  const activities = useMemo(() => tools.filter(isVisibleToolActivity), [tools])
  type ActivityFilter = 'all' | ToolActivity['state']
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const focusRequest = useRef<string | null>(null)
  const filtered = useMemo(() => activities.filter((tool) => filter === 'all' || tool.state === filter), [activities, filter])
  const availableStates = useMemo(() => new Set(activities.map(tool => tool.state)), [activities])
  const range = workPageRange(filtered.length, page, WORK_ACTIVITY_PAGE_SIZE)
  const filters: Array<[ActivityFilter, string]> = [
    ['all', '全部'],
    ['running', '进行中'],
    ['waiting', '等待中'],
    ['done', '已完成'],
    ['error', '失败'],
    ['cancelled', '已停止'],
    ['interrupted', '已中断'],
    ['unknown', '状态未知']
  ]
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[range.start]
  useLayoutEffect(() => {
    if (!selection) return
    setFilter('all')
    setSelectedId(selection.toolId)
    setPage(Math.floor(Math.max(0, activities.findIndex(item => item.id === selection.toolId)) / WORK_ACTIVITY_PAGE_SIZE))
    focusRequest.current = selection.toolId
  }, [selection])
  useLayoutEffect(() => {
    const id = focusRequest.current
    if (!id) return
    const item = itemRefs.current.get(id)
    if (!item) return
    focusRequest.current = null
    item.focus({ preventScroll: true })
    item.scrollIntoView({ block: 'nearest' })
  }, [selection, selectedId, range.page, filter])
  const selectPage = (nextPage: number): void => {
    const next = workPageRange(filtered.length, nextPage, WORK_ACTIVITY_PAGE_SIZE)
    setPage(next.page)
    setSelectedId(filtered[next.start]?.id ?? null)
  }
  const copy = (value: string): void => {
    if (!value) return
    void navigator.clipboard?.writeText(value).then(() => toast.success('已复制')).catch(reportError)
  }
  return (
    <div className="work-activities">
      <WorkSteps todos={todos} />
      <header className="work-activities__header">
        <div>
          <h2>活动</h2>
          <span>{activities.length} 个工具调用</span>
        </div>
        <div className="work-activities__filters" role="group" aria-label="活动筛选">
          {filters.filter(([id]) => id === 'all' || id === filter || availableStates.has(id)).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(0); setSelectedId(null) }}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {activities.length ? <div className="work-activities__split">
        <div className="work-activities__list" role="listbox" aria-label="工具活动列表">
          {range.pages > 1 && <div className="work-list-pagination" role="group" aria-label="活动分页">
            <button type="button" className="btn btn--sm" disabled={range.page === 0} onClick={() => selectPage(range.page - 1)}>上一页</button>
            <span aria-live="polite">{range.page + 1} / {range.pages}</span>
            <button type="button" className="btn btn--sm" disabled={range.page === range.pages - 1} onClick={() => selectPage(range.page + 1)}>下一页</button>
          </div>}
          {filtered.length ? filtered.slice(range.start, range.end).map((tool, offset) => {
            const target = workToolTarget(tool, workspacePath)
            const title = tool.name === 'subagent' || tool.subagent ? workSubagentName(tool) : toolDisplayName(tool.name)
            return (
            <button
              type="button"
              role="option"
              key={tool.id}
              ref={node => { if (node) itemRefs.current.set(tool.id, node); else itemRefs.current.delete(tool.id) }}
              onClick={() => setSelectedId(tool.id)}
              aria-selected={selected?.id === tool.id}
              aria-posinset={range.start + offset + 1}
              aria-setsize={filtered.length}
              tabIndex={selected?.id === tool.id ? 0 : -1}
              title={`${title}${target ? ` · ${target}` : ''}`}
              aria-label={`${title} · ${TOOL_STATUS[tool.state]}${target ? ` · ${target}` : ''}`}
              onKeyDown={event => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = range.start + offset
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))
                setSelectedId(filtered[next].id)
                setPage(Math.floor(next / WORK_ACTIVITY_PAGE_SIZE))
                focusRequest.current = filtered[next].id
              }}
            >
              <span className={`work-activities__icon work-activities__icon--${tool.state}`}>{tool.state === 'running' ? <Spinner size={14} /> : <Icon name={tool.state === 'error' ? 'warning' : tool.state === 'done' ? 'check' : 'output'} size={14} />}</span>
              <span>{title}{target && <small>{target}</small>}</span>
              <span className={`work-tool-state work-tool-state--${tool.state}`}>{TOOL_STATUS[tool.state]}</span>
            </button>
          )}) : <p className="work-list-empty">没有符合条件的活动</p>}
        </div>
        {selected ? (
          <article key={selected.id} className="work-activity-detail" aria-label="活动详情">
            <header>
              <div><span className="work-activity-detail__eyebrow">{selected.name === 'subagent' || selected.subagent ? '协作代理' : '工具调用'}</span><h3>{selected.name === 'subagent' || selected.subagent ? workSubagentName(selected) : toolDisplayName(selected.name)}</h3></div>
              <span className={`work-tool-state work-tool-state--${selected.state}`}>{TOOL_STATUS[selected.state]}</span>
            </header>
            {selected.error ? <WorkErrorNotice error={selected.error} /> : null}
            <ActivityResultBlock tool={selected} onCopy={copy} />
            <ActivityDataBlock title="输入参数" value={selected.args} onCopy={copy} collapsed />
          </article>
        ) : <EmptyState icon="output" title="选择一条活动" description="从左侧列表查看完整的输入、输出和错误。" />}
      </div> : <EmptyState
      icon="output"
      title="暂无工具活动"
      description="任务调用工具时，详细输入、结果和错误会按顺序保存在这里。"
      />}
    </div>
  )
}

const StableActivityPanel = memo(ActivityPanel)

function ActivityResultBlock({ tool, onCopy }: { tool: ToolActivity; onCopy: (value: string) => void }): JSX.Element {
  const preview = useMemo(() => readActivityPreview(tool), [tool.name, tool.state, tool.result])
  const output = tool.subagent?.resultSummary || tool.subagent?.partialOutput || tool.result
  return preview ? <>
    {preview.content ? <ActivityDataBlock title="文件内容" value={preview.content} onCopy={onCopy} toolName={tool.name} /> : <p className="work-note">文件内容为空</p>}
    <ActivityDataBlock title="读取信息与原始输出" value={tool.result} onCopy={onCopy} collapsed />
  </> : <ActivityDataBlock title={tool.subagent ? 'Agent 产出' : '输出'} value={output} onCopy={onCopy} toolName={tool.name} />
}

function ActivityDataBlock({ title, value, onCopy, collapsed = false, toolName }: {
  title: string
  value?: string
  onCopy: (value: string) => void
  collapsed?: boolean
  toolName?: string
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const formatted = useMemo(() => !collapsed || expanded ? formatActivityValue(value ?? '') : '', [value, collapsed, expanded])
  if (!value) return null
  return (
    <section className="work-activity-detail__block">
      <header><h4>{title}</h4><button type="button" onClick={() => onCopy(value)} aria-label={`复制${title}`}><Icon name="copy" size={13} />复制原文</button></header>
      {collapsed ? <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>查看{title}</summary>{expanded ? <ToolResult value={formatted} toolName={toolName} /> : null}</details> : <ToolResult value={formatted} toolName={toolName} />}
    </section>
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


