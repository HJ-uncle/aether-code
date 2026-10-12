import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
  type RefObject
} from 'react'
import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import type { EngineFileChange } from '@shared/ipc'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { useApp } from '@renderer/core/app-context'
import { toast } from '@renderer/core/toast'
import { getAppMode, useAppMode } from '@renderer/core/platform/app-mode'
import { getEngineSource } from '@renderer/core/engine/source'
import { registerCommand } from '@renderer/core/platform/commands'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { IconButton, SectionHeading, Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { openAppSettings } from '../settings/app-settings-navigation'
import { Markdown } from '../chat/Markdown'
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
import { WorkTaskActions } from './WorkTaskActions'
import { WorkArtifactPanel } from './WorkArtifactPanel'
import { WorkGitPanel } from './WorkGitPanel'
import { WorkSubagentsPanel } from './WorkSubagentsPanel'
import { WorkInlineActivity } from './WorkInlineActivity'
import { WorkAgentManager } from './WorkAgentManager'
import { workMessageTimeline, workToolTarget } from './work-message-timeline'
import { WORK_ACTIVITY_PAGE_SIZE, WORK_MESSAGE_PAGE_SIZE, WORK_TASK_PAGE_SIZE, workMessageStart, workPageRange, workPaneRatio, workToolSnapshot, type WorkToolSnapshot } from './work-view-performance'
import { requestedThinkingMode } from '../chat/session-request-config'
import { findWorkArtifact } from './work-artifact-utils'
import { hideBrowserSurfaces, useBrowserState } from '../browser/browser-store'
import './work.css'
import '../chat/apple-chat-panels.css'

type WorkController = ReturnType<typeof useWorkController>
type WorkTask = WorkController['tasks'][number]
type Page = 'home' | 'projects' | 'artifacts' | 'browser' | 'automations' | 'connections' | 'agents'
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

interface WorkAutomation {
  id: string
  name: string
  description?: string
  cronExpr: string
  message: string
  sessionId: string
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  createdAt: number
  thinkingMode?: boolean | 'low' | 'medium' | 'high' | null
  timeoutSeconds?: number | null
}

const AUTOMATION_TIMEOUT_OPTIONS = [
  { value: '120', label: '2 分钟' },
  { value: '600', label: '10 分钟' },
  { value: '1800', label: '30 分钟' },
  { value: '3600', label: '60 分钟' },
  { value: '10800', label: '3 小时' },
  { value: '21600', label: '6 小时' },
  { value: '86400', label: '24 小时' },
  { value: 'custom', label: '自定义时长' }
]

function automationTimeoutLabel(seconds: number | null | undefined): string {
  const value = seconds ?? 120
  const preset = AUTOMATION_TIMEOUT_OPTIONS.find(option => option.value === String(value))
  if (preset) return preset.label
  const minutes = Math.floor(value / 60), remaining = value % 60
  return minutes ? `${minutes} 分钟${remaining ? ` ${remaining} 秒` : ''}` : `${remaining} 秒`
}

const VIEW_KEY = 'aether.work.view.v1'
const conversationPositions = new Map<string, { top: number; follow: boolean; firstId?: string | null; expanded?: boolean }>()
const pendingDrafts = new Map<string, { values: string[][]; freeText: string[] }>()
const changeStatCache = new WeakMap<EngineFileChange, ReturnType<typeof diffStats> | null>()
const MAX_WORK_VIEW_CACHE = 256
const NO_MESSAGES: ChatMessage[] = []

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
  { id: 'connections', label: '连接', icon: 'graph' }
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
  const [view, setView] = useState(initialView)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null)
  const [activitySelection, setActivitySelection] = useState<ActivitySelection | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [compactNavigation, setCompactNavigation] = useState(window.innerWidth <= 1160)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const set = useCallback((patch: Partial<ViewState>): void =>
    setView((previous) => ({ ...previous, ...patch })), [])
  const task = controller.activeTask
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
    void hideBrowserSurfaces()
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
  const openWorkspace = useCallback((tab: WorkspaceTab): void =>
    set({ workspace: true, tab, pane: 'workspace' }), [set])
  const openArtifact = useCallback((id: string): void => {
    setSelectedArtifact(id)
    openWorkspace('artifacts')
  }, [openWorkspace])
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
              title={item.title}
              aria-current={task?.id === item.id && view.page === 'home' ? 'true' : undefined}
              onClick={() => openTask(item.id)}
            >
              <span>{item.title}</span>
              {item.status === 'running' ? (
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
                <TaskStatus status={task.status} />
                <WorkTaskActions task={task} controller={controller} />
                {['running', 'waiting'].includes(task.status) && (
                  <button
                    className="btn btn--sm"
                    type="button"
                    onClick={() => void controller.stop().catch(reportError)}
                  >
                    <Icon name="stop" size={13} />
                    停止
                  </button>
                )}
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
                    selectArtifact={setSelectedArtifact}
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
              <ArtifactPanel
                controller={controller}
                selectedId={selectedArtifact}
                onSelect={setSelectedArtifact}
              />
              {!task && <p className="work-note">从工作台打开一个任务后，可在这里查看它的成果。</p>}
            </div>
          </div>
        ) : view.page === 'connections' ? (
          <Connections ready={controller.ready} />
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
              <Automations controller={controller} newTask={newTask} />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function TaskStatus({ status }: { status: WorkTask['status'] }): JSX.Element {
  return (
    <span className={`work-status work-status--${status}`}>
      {status === 'running' ? (
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
      {STATUS_LABEL[status]}
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
  onSelect,
  empty
}: {
  tasks: WorkTask[]
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
          <TaskStatus status={task.status} />
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
  const [firstId, setFirstId] = useState<string | null>(() => conversationPositions.get(positionKey)?.firstId ?? null)
  const expandedHistory = useRef(conversationPositions.get(positionKey)?.expanded ?? false)
  const start = useMemo(() => workMessageStart(controller.messages, firstId), [controller.messages, firstId])
  const firstIdRef = useRef(firstId)
  firstIdRef.current = controller.messages[start]?.id ?? firstId
  const prependAnchor = useRef<{ id: string; offset: number } | null>(null)
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
      <div className="work-conversation__toolbar">
        <h2>协作对话</h2>
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
          const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 70
          followRef.current = bottom
          setFollowing(bottom)
        }}
      >
        <div className="work-conversation__content">
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
          {controller.messages.slice(start).map((message) => (
            <WorkMessage
              key={message.id}
              message={message}
              fileContext={fileContext}
              onFileLink={onFileLink}
              openFile={openActivityFile}
              respond={respond}
              openActivity={openActivity}
            />
          ))}
          <WorkTurnFeedback controller={controller} openActivity={openActivity} />
        </div>
      </div>
      <div className="work-conversation__footer">
        {!following && (
          <button className="work-follow-latest" type="button" onClick={latest}>
            <Icon name="chevron-down" size={14} />
            回到最新
          </button>
        )}
        <WorkRunStatus key={task.id} controller={controller} />
        <WorkComposerV2 controller={controller} />
      </div>
    </section>
  )
}

/** Only real engine events change the phase; elapsed time never invents progress. */
function useWorkRunFeedback(controller: WorkController) {
  const mode = useAppMode()
  const [now, setNow] = useState(Date.now)
  const waiting = controller.pending.length > 0
  const active = controller.streaming || controller.launching || waiting
  const message = controller.messages.findLast((item) => item.role === 'assistant')
  const current = message && ['streaming', 'waiting'].includes(message.status) ? message : null
  const startedAt = current?.run?.startedAt ?? current?.startedAt ?? current?.createdAt
    ?? (controller.launching ? controller.activeTask?.createdAt : undefined)
  const running = current
    ? [...current.tools].reverse().find((tool) => tool.state === 'running' && !tool.hidden)
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
          ? `${toolDisplayName(running.name)}…`
          : thinking
            ? '正在思考…'
            : current?.content
              ? '正在生成回复…'
              : '等待 Agent 响应…'

  useEffect(() => {
    if (!active || mode !== 'work') return
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
function WorkTurnFeedback({ controller, openActivity }: {
  controller: WorkController
  openActivity: (toolId: string) => void
}): JSX.Element | null {
  const feedback = useWorkRunFeedback(controller)
  if (!feedback.active) return null
  const target = feedback.running ? workToolTarget(feedback.running, controller.workspacePath) : ''
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
    <div className="work-turn-feedback" data-phase={feedback.phase} aria-label="Agent 执行反馈">
      <span className="work-turn-feedback__indicator" aria-hidden="true">
        {feedback.waiting ? <Icon name="chat" size={16} /> : <Spinner size={16} />}
      </span>
      <div className="work-turn-feedback__body">
        <div className="work-turn-feedback__heading">
          <strong title={controller.agentIdentity.name || undefined}>{controller.agentIdentity.name || 'Agent'}</strong>
          <span>{feedback.label}</span>
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

/** Keep execution feedback beside the composer even while the user reads older messages. */
function WorkRunStatus({ controller }: { controller: WorkController }): JSX.Element | null {
  const feedback = useWorkRunFeedback(controller)
  const [stopping, setStopping] = useState(false)
  if (!feedback.active) return null
  const { waiting, elapsed } = feedback
  return (
    <div
      className="work-run-status"
      data-state={waiting ? 'waiting' : 'running'}
      data-phase={stopping ? 'stopping' : feedback.phase}
    >
      <div
        className="work-run-status__label"
        role="status"
        aria-live="polite"
        aria-label="任务运行状态"
      >
        {waiting && !stopping ? <Icon name="chat" size={14} /> : <Spinner size={13} />}
        <span>{stopping ? '正在停止…' : feedback.label}</span>
      </div>
      <span className="work-run-status__elapsed" title="本轮累计用时（含等待）">
        {elapsed}
      </span>
      <button
        className="work-quiet-button"
        type="button"
        aria-label="停止任务"
        disabled={stopping}
        onClick={async () => {
          setStopping(true)
          try {
            await controller.stop()
          } catch (error) {
            reportError(error)
          } finally {
            setStopping(false)
          }
        }}
      >
        <Icon name="stop" size={13} />
        停止
      </button>
    </div>
  )
}

const WorkMessage = memo(function WorkMessage({
  message,
  fileContext,
  onFileLink,
  openFile,
  respond,
  openActivity
}: {
  message: ChatMessage
  fileContext: ChatFileContext
  onFileLink: (event: MouseEvent<HTMLElement>) => void
  openFile: (path: string) => void
  respond: WorkController['respond']
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
        <div className="message__bubble"><UserMessageContent content={message.content} /></div>
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
      {message.error && (
        <p className="work-message__error" role="alert">
          {message.error}
        </p>
      )}
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
  return (
    <form
      className="work-pending"
      onSubmit={(event) => {
        event.preventDefault()
        if (submitting || answers.some((answer) => !answer) || !pending.requestId) return
        setSubmitting(true)
        setError('')
        void respond(pending.requestId, answers)
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setSubmitting(false))
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
      {error && (
        <p className="work-message__error" role="alert">
          {error}
        </p>
      )}
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
  selectArtifact: (id: string) => void
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
    ['browser', '浏览器'],
    ['activity', '活动'],
    ['subagents', '子代理'],
    ['git', 'Git']
  ]
  return (
    <section className="work-workspace" aria-label="任务工作区">
      <div className="work-workspace__tabs" role="tablist" aria-label="工作区内容">
        {tabs.map(([id, label], index) => (
          <button
            type="button"
            role="tab"
            id={`work-tab-${id}`}
            aria-controls={`work-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            key={id}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowLeft' ||
                event.key === 'ArrowRight' ||
                event.key === 'Home' ||
                event.key === 'End'
              ) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
                setTab(tabs[next][0])
                document.getElementById(`work-tab-${tabs[next][0]}`)?.focus()
              }
            }}
          >
            {label}
            {id === 'artifacts' && controller.artifacts.length > 0 && (
              <span>{controller.artifacts.length}</span>
            )}
          </button>
        ))}
      </div>
      {tabs.filter(([id]) => id === tab || visited.has(id)).map(([id]) => (
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
  selectArtifact: (id: string) => void
  activitySelection: ActivitySelection | null
  setTab: (tab: WorkspaceTab) => void
  source: number
}): JSX.Element {
  const revealBrowser = useCallback(() => setTab('browser'), [setTab])
  const tools = useWorkTools(id === 'subagents' ? controller.messages : NO_MESSAGES)
  return <div
    className={`work-workspace__body work-workspace__body--${id}`}
    hidden={hidden}
    role="tabpanel"
    id={`work-panel-${id}`}
    aria-labelledby={`work-tab-${id}`}
  >
    {id === 'artifacts' ? (
            <ArtifactPanel
              controller={controller}
              active={active}
              selectedId={selectedArtifact}
              onSelect={selectArtifact}
            />
          ) : id === 'sources' ? (
            <SourcePanel controller={controller} />
          ) : id === 'activity' ? (
            <ActivityPanel key={controller.activeTask?.id} messages={controller.messages} todos={controller.todos} selection={activitySelection} workspacePath={controller.activeTask?.workspacePath} />
          ) : id === 'subagents' ? (
            <WorkSubagentsPanel
              sessionId={controller.activeTask?.id ?? null}
              tools={tools}
              active={active}
              busy={controller.streaming || controller.loading || controller.pending.length > 0 || controller.uploading}
              onContinue={controller.continueSubagent}
            />
          ) : id === 'git' ? (
            <WorkGitPanel
              // Never fall back to the Code workspace when Work has no active
              // task. Git operations must stay scoped to the selected Work
              // task's directory and session.
              cwd={controller.activeTask?.workspacePath}
              sessionId={controller.activeTask?.id}
              active={active}
              onOpenFile={(path) =>
                void openFileFromChat(path, {
                  sessionId: controller.activeTask?.id ?? '',
                  workspaceRoot: controller.activeTask?.workspacePath
                }).catch(reportError)
              }
            />
          ) : (
            <WorkBrowser sessionId={controller.activeTask?.id} onReveal={revealBrowser} />
          )}
  </div>
}, (previous, next) => !previous.active && !next.active && previous.hidden === next.hidden && previous.source === next.source && previous.controller.activeTask?.id === next.controller.activeTask?.id)

function Automations({
  controller,
  newTask
}: {
  controller: WorkController
  newTask: () => void
}): JSX.Element {
  const [jobs, setJobs] = useState<WorkAutomation[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5')
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<WorkAutomation | null>(null)
  const [thinking, setThinking] = useState('auto')
  const [timeoutPreset, setTimeoutPreset] = useState('1800')
  const [customTimeout, setCustomTimeout] = useState('1800')
  const [timeoutChanged, setTimeoutChanged] = useState(false)
  const loadGenerationRef = useRef(0)
  const savingRef = useRef(false)
  const mutatingJobsRef = useRef(new Set<string>())
  const [mutatingJobs, setMutatingJobs] = useState<ReadonlySet<string>>(new Set())
  const activeSession = controller.activeTask?.id
  const timeoutSeconds = Number(timeoutPreset === 'custom' ? customTimeout : timeoutPreset)
  const timeoutValid = Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 86400
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    const source = getEngineSource()
    if (!controller.ready) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await requestOrThrow<WorkAutomation[]>({ method: 'GET', path: '/cron' })
      if (generation !== loadGenerationRef.current || source !== getEngineSource()) return
      setJobs(next)
      setError('')
    } catch (cause) {
      if (generation === loadGenerationRef.current && source === getEngineSource())
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === loadGenerationRef.current && source === getEngineSource()) setLoading(false)
    }
  }, [controller.ready])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => () => { loadGenerationRef.current += 1 }, [])
  const create = async (): Promise<void> => {
    const sessionId = editing?.sessionId ?? activeSession
    if (savingRef.current || !sessionId || !name.trim() || !message.trim() || !timeoutValid) return
    savingRef.current = true
    setSaving(true)
    const source = getEngineSource()
    try {
      const created = await requestOrThrow<WorkAutomation>({
        method: editing ? 'PUT' : 'POST',
        path: editing ? `/cron/${encodeURIComponent(editing.id)}` : '/cron',
        body: {
          name: name.trim(),
          cronExpr: cronExpr.trim(),
          message: message.trim(),
          sessionId,
          thinkingMode: thinking === 'off' ? false : thinking === 'on' ? true : thinking === 'auto' ? null : thinking,
          // Omission preserves legacy null/default semantics when editing another field.
          ...(!editing || timeoutChanged ? { timeoutSeconds } : {}),
          ...(!editing ? { enabled: true } : {})
        }
      })
      if (source !== getEngineSource()) return
      setJobs((previous) => editing ? previous.map(job => job.id === created.id ? created : job) : [created, ...previous])
      setName('')
      setMessage('')
      setShowForm(false)
      setEditing(null)
      setError('')
    } catch (cause) {
      if (source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const updateEnabled = async (job: WorkAutomation): Promise<void> => {
    if (mutatingJobsRef.current.has(job.id)) return
    mutatingJobsRef.current.add(job.id)
    setMutatingJobs(new Set(mutatingJobsRef.current))
    const source = getEngineSource()
    try {
      const updated = await requestOrThrow<WorkAutomation>({
        method: 'POST',
        path: `/cron/${encodeURIComponent(job.id)}/${job.enabled ? 'disable' : 'enable'}`,
        body: {}
      })
      if (source === getEngineSource()) setJobs((previous) => previous.map((item) => (item.id === job.id ? updated : item)))
    } catch (cause) {
      if (source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutatingJobsRef.current.delete(job.id)
      setMutatingJobs(new Set(mutatingJobsRef.current))
    }
  }
  const remove = async (job: WorkAutomation): Promise<void> => {
    if (mutatingJobsRef.current.has(job.id)) return
    mutatingJobsRef.current.add(job.id)
    setMutatingJobs(new Set(mutatingJobsRef.current))
    const source = getEngineSource()
    try {
      await requestOrThrow<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/cron/${encodeURIComponent(job.id)}`
      })
      if (source === getEngineSource()) setJobs((previous) => previous.filter((item) => item.id !== job.id))
    } catch (cause) {
      if (source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutatingJobsRef.current.delete(job.id)
      setMutatingJobs(new Set(mutatingJobsRef.current))
    }
  }
  return (
    <div className="work-automation">
      <div className="work-automation__toolbar">
        <div>
          <h2>自动化</h2>
          <p>把重复的 Work 任务交给引擎按计划运行，随时暂停或删除。</p>
        </div>
        <button
          className="btn btn--primary"
          type="button"
          onClick={() => {
            setEditing(null); setName(''); setMessage(''); setCronExpr('0 9 * * 1-5')
            setTimeoutPreset('1800'); setCustomTimeout('1800'); setTimeoutChanged(false)
            const requested = requestedThinkingMode(controller.thinkingMode)
            setThinking(requested === false ? 'off' : requested === true ? 'on' : requested ?? 'auto')
            setShowForm(true)
          }}
          disabled={saving || !controller.ready || !activeSession}
          title={!activeSession ? '请先打开一个 Work 任务' : undefined}
        >
          <Icon name="plus" size={15} />
          新建自动化
        </button>
      </div>
      {error && (
        <div className="work-error" role="alert">
          <Icon name="warning" size={15} />
          <span>{error}</span>
          <IconButton icon="close" label="关闭错误提示" onClick={() => setError('')} />
        </div>
      )}
      {showForm && (
        <form
          className="work-automation-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <label>
            名称
            <input
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              placeholder="工作日简报"
              required
            />
          </label>
          <label>
            时间表达式
            <input
              value={cronExpr}
              disabled={saving}
              onChange={(event) => setCronExpr(event.target.value)}
              placeholder="分 时 日 月 周"
              required
            />
          </label>
          <label className="work-automation-form__message">
            每次运行的目标
            <textarea
              value={message}
              disabled={saving}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="让 AI 完成什么工作？"
              rows={3}
              required
            />
          </label>
          <div className="work-automation-form__thinking">
            <span>思考档位</span>
            <Select ariaLabel="自动化思考档位" value={thinking} onChange={setThinking} disabled={saving} options={[
              { value: 'auto', label: '自动 · 使用模型默认' },
              { value: 'off', label: 'Off · 关闭思考' },
              { value: 'low', label: 'Low · 轻量思考' },
              { value: 'medium', label: 'Medium · 平衡思考' },
              { value: 'high', label: 'High · 深度思考' },
              ...(thinking === 'on' ? [{ value: 'on', label: 'On · 开启思考' }] : [])
            ]} />
          </div>
          <div className="work-automation-form__timeout">
            <span>单次最长运行时间</span>
            <Select ariaLabel="自动化最长运行时间" value={timeoutPreset} disabled={saving} options={AUTOMATION_TIMEOUT_OPTIONS} onChange={value => {
              if (value === 'custom' && timeoutPreset !== 'custom') setCustomTimeout(timeoutPreset)
              setTimeoutPreset(value); setTimeoutChanged(true)
            }} />
            {timeoutPreset === 'custom' ? <>
              <label>
                自定义时长（秒）
                <input type="number" min={1} max={86400} step={1} required value={customTimeout} disabled={saving}
                  aria-invalid={!timeoutValid} aria-describedby="automation-timeout-help automation-timeout-validation"
                  onChange={event => { setCustomTimeout(event.target.value); setTimeoutChanged(true) }} />
              </label>
              <span id="automation-timeout-validation" className={timeoutValid ? 'work-automation-form__hint' : 'work-automation-form__validation'}>
                {timeoutValid ? `当前为 ${automationTimeoutLabel(timeoutSeconds)}` : '请输入 1 至 86400 的整数秒数。'}
              </span>
            </> : null}
          </div>
          <p id="automation-timeout-help" className="work-automation-form__help">
            达到时限后会停止本次执行。运行中修改从下一次执行生效；同一自动化尚未完成时不会重复启动。
          </p>
          <div className="work-automation-form__actions">
            <span>{editing ? `继续使用「${controller.tasks.find(task => task.id === editing.sessionId)?.title || editing.name}」的会话和工作目录。` : '将继续使用当前任务的会话和工作目录。'}</span>
            <button type="button" className="work-quiet-button" disabled={saving} onClick={() => setShowForm(false)}>
              取消
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={saving || !name.trim() || !message.trim() || !timeoutValid}
            >
              {saving ? <Spinner size={13} /> : <Icon name="check" size={14} />}
              {saving ? '正在保存…' : '保存自动化'}
            </button>
          </div>
        </form>
      )}
      {!controller.ready ? (
        <EmptyState
          icon="engine"
          title="引擎尚未就绪"
          description="连接引擎后才能读取和管理自动化。"
        />
      ) : loading ? (
        <div className="work-loading">
          <Spinner />
          正在读取自动化…
        </div>
      ) : jobs.length ? (
        <div className="work-automation-list">
          {jobs.map((job) => (
            <article className="work-automation-row" key={job.id}>
              <div className="work-automation-row__icon">
                <Icon name="clock-outline" size={18} />
              </div>
              <div className="work-automation-row__content">
                <h3>{job.name}</h3>
                <p>{job.description || job.message}</p>
                <span>
                  {job.cronExpr} · {job.enabled ? '已启用' : '已暂停'}
                  {job.thinkingMode === false ? ' · 思考 Off' : typeof job.thinkingMode === 'string' ? ` · 思考 ${job.thinkingMode}` : ''}
                  {` · 单次最长 ${automationTimeoutLabel(job.timeoutSeconds)}`}
                </span>
                {job.lastRunAt ? <span>最近运行 {new Date(job.lastRunAt).toLocaleString()}</span> : null}
              </div>
              <button type="button" className="work-quiet-button" aria-label={`编辑自动化 ${job.name}`} disabled={saving || mutatingJobs.has(job.id)} onClick={() => {
                setEditing(job); setName(job.name); setCronExpr(job.cronExpr); setMessage(job.message)
                setThinking(job.thinkingMode === false ? 'off' : job.thinkingMode === true ? 'on' : job.thinkingMode ?? 'auto')
                const seconds = String(job.timeoutSeconds ?? 120)
                setTimeoutPreset(AUTOMATION_TIMEOUT_OPTIONS.some(option => option.value === seconds) ? seconds : 'custom')
                setCustomTimeout(seconds); setTimeoutChanged(false)
                setShowForm(true); setError('')
              }}>编辑</button>
              <button
                type="button"
                className="work-quiet-button"
                disabled={mutatingJobs.has(job.id)}
                onClick={() => void updateEnabled(job)}
              >
                {job.enabled ? '暂停' : '启用'}
              </button>
              <IconButton
                icon="trash"
                label={`删除自动化 ${job.name}`}
                disabled={mutatingJobs.has(job.id)}
                onClick={() => void remove(job)}
              />
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="clock-outline"
          title="还没有自动化"
          description={
            activeSession
              ? '从当前任务创建第一个定时工作，任务完成后仍会保留。'
              : '先打开一个 Work 任务，再为它添加定时运行。'
          }
        />
      )}
      {!activeSession && (
        <button type="button" className="btn" onClick={newTask}>
          回到工作台新建任务
        </button>
      )}
    </div>
  )
}

function ArtifactPanel({
  controller,
  active = true,
  selectedId,
  onSelect
}: {
  controller: WorkController
  active?: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const linkedPath = selectedId?.startsWith('path:') ? selectedId.slice(5) : null
  const artifact =
    controller.artifacts.find((item) => item.id === selectedId) ??
    (linkedPath
      ? {
          id: selectedId!,
          path: linkedPath,
          name: filename(linkedPath),
          content: null,
          status: 'draft' as const,
          createdAt: Date.now()
        }
      : controller.artifacts[0] ?? null)
  const addToConversation = (
    item: (typeof controller.artifacts)[number],
    selection?: string
  ): void => {
    if (selection) {
      controller.setDraft(
        `${controller.draft}${controller.draft ? '\n\n' : ''}引用「${item.name}」中的内容（${item.path}）：\n${selection
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n`
      )
    } else controller.addReference(item)
  }
  const changesRef = useRef<HTMLElement>(null)
  const [detailTab, setDetailTab] = useState<'preview' | 'changes'>('preview')
  const tools = useWorkTools(controller.messages)
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
        {controller.artifacts.length ? (
          controller.artifacts.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.id === artifact?.id}
              className={item.id === artifact?.id ? 'is-selected' : ''}
              key={item.id}
              onClick={() => onSelect(item.id)}
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
          <p className="work-list-empty">当前任务还没有成果文件。</p>
        )}
      </div>
      <div className="work-artifacts-shell__detail">
        <div className="work-artifacts-shell__tabs" role="tablist" aria-label="成果内容">
          <button type="button" role="tab" aria-selected={detailTab === 'preview'} onClick={() => setDetailTab('preview')}>预览</button>
          <button type="button" role="tab" aria-selected={detailTab === 'changes'} onClick={() => setDetailTab('changes')}>文件改动</button>
        </div>
        {detailTab === 'preview' ? (
          <WorkArtifactPanel
            artifact={artifact}
            workspaceRoot={controller.activeTask?.workspacePath}
            sessionId={controller.activeTask?.id}
            artifacts={controller.artifacts}
            onSelect={onSelect}
            onAddToConversation={(item, selection) => {
              addToConversation(item, selection)
              toast.success(selection ? '已引用选中内容' : '已添加到对话')
            }}
            onOpenFile={(item) =>
              void openFileFromChat(item.path, {
                sessionId: controller.activeTask?.id ?? '',
                workspaceRoot: controller.activeTask?.workspacePath
              }).catch(reportError)
            }
          />
        ) : (
          <WorkChangesPanel controller={controller} sectionRef={changesRef} standalone active={active} />
        )}
      </div>
    </div>
  )
}

function WorkChangesPanel({ controller, sectionRef, standalone = false, active = true }: { controller: WorkController; sectionRef?: RefObject<HTMLElement | null>; standalone?: boolean; active?: boolean }): JSX.Element | null {
  const sessionId = controller.activeTask?.id
  const [changes, setChanges] = useState<EngineFileChange[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(true)
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
  }, [sessionId, controller.ready, source, active])
  const captureScope = (): { generation: number; source: ReturnType<typeof getEngineSource>; sessionId?: string; ready: boolean } => ({
    generation: scopeGeneration.current,
    source,
    sessionId,
    ready: controller.ready
  })
  const scopeCurrent = (scope: ReturnType<typeof captureScope>): boolean =>
    mounted.current &&
    scope.generation === scopeGeneration.current &&
    scope.source === getEngineSource() &&
    scope.sessionId === controller.activeTask?.id &&
    scope.ready === controller.ready
  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current
    const scope = captureScope()
    const targetSessionId = scope.sessionId
    const isCurrent = (): boolean => generation === refreshGeneration.current && scopeCurrent(scope)
    if (!targetSessionId || !scope.ready) {
      if (isCurrent()) {
        setChanges([])
        setError('')
      }
      return
    }
    try {
      const result = await requestOrThrow<EngineFileChange[]>({
        method: 'GET',
        path: '/changes',
        query: { sessionId: targetSessionId, status: 'pending', view: 'net' }
      })
      if (!isCurrent()) return
      setChanges(Array.isArray(result) ? result : [])
      setError('')
    } catch (reason) {
      if (!isCurrent()) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [controller.ready, sessionId, source])
  useEffect(() => {
    if (active) void refresh()
  }, [refresh, active])
  useEffect(() => {
    if (active && previousStreaming.current && !controller.streaming) void refresh()
    previousStreaming.current = active && controller.streaming
  }, [controller.streaming, refresh, active])
  if (!sessionId) return null
  return (
    <section className="work-changes-panel" aria-label="文件改动" ref={sectionRef}>
      <button
        type="button"
        className="work-changes-panel__heading"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <strong>文件改动</strong>
        <span>{changes.length}</span>
      </button>
      {open &&
        (error ? (
          <p className="work-changes-panel__error" role="alert">
            {error}
            <button type="button" onClick={() => void refresh()}>
              重试
            </button>
          </p>
        ) : changes.length ? (
          <div className="work-changes-panel__list">
            {changes.map((change) => (
              <FileChangeCard key={change.id} change={change} state="done" fileContext={{ sessionId, workspaceRoot: controller.activeTask?.workspacePath }} />
            ))}
          </div>
        ) : standalone ? <EmptyState icon="file" title="还没有文件改动" description="任务创建或修改文件后，改动会显示在这里。" /> : null)}
    </section>
  )
}

function SourcePanel({ controller }: { controller: WorkController }): JSX.Element {
  const sources = controller.activeTask?.sources ?? []
  return sources.length ? (
    <div className="work-sources">
      <h3>
        任务资料 <span>{sources.length}</span>
      </h3>
      {sources.map((source) => (
        <div className="work-source-row" key={source.path}>
          <Icon name="file" size={18} />
          <div>
            <strong>{source.name}</strong>
            <span>{fileSize(source.size)}</span>
          </div>
          <button
            type="button"
            className="work-quiet-button"
            onClick={() => {
              controller.setDraft(
                `${controller.draft}${controller.draft ? '\n\n' : ''}参考资料：${source.name}\n路径：${source.path}\n`
              )
              toast.success('已添加到对话草稿')
            }}
          >
            添加到对话
          </button>
        </div>
      ))}
    </div>
  ) : (
    <EmptyState
      icon="paperclip"
      title="还没有添加资料"
      description="在对话输入区选择“添加资料”，或将文件拖入输入区。资料会随消息一起发送。"
    />
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

function ActivityPanel({ messages, todos, selection, workspacePath }: {
  messages: ChatMessage[]
  todos: WorkController['todos']
  selection: ActivitySelection | null
  workspacePath?: string | null
}): JSX.Element {
  const tools = useWorkTools(messages)
  const activities = useMemo(() => tools.filter(tool => !tool.hidden), [tools])
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
              title={`${toolDisplayName(tool.name)}${target ? ` · ${target}` : ''}`}
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
              <span>{toolDisplayName(tool.name)}{target && <small>{target}</small>}</span>
              <span className={`work-tool-state work-tool-state--${tool.state}`}>{TOOL_STATUS[tool.state]}</span>
            </button>
          )}) : <p className="work-list-empty">没有符合条件的活动</p>}
        </div>
        {selected ? (
          <article className="work-activity-detail" aria-label="活动详情">
            <header>
              <div><span className="work-activity-detail__eyebrow">工具调用</span><h3>{toolDisplayName(selected.name)}</h3></div>
              <span className={`work-tool-state work-tool-state--${selected.state}`}>{TOOL_STATUS[selected.state]}</span>
            </header>
            {selected.error ? <p className="work-activity-detail__error" role="alert">{selected.error}</p> : null}
            <ActivityDataBlock title="输入" value={selected.args} onCopy={copy} />
            <ActivityDataBlock title="输出" value={selected.result} onCopy={copy} />
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

function ActivityDataBlock({ title, value, onCopy }: { title: string; value?: string; onCopy: (value: string) => void }): JSX.Element | null {
  if (!value) return null
  return (
    <section className="work-activity-detail__block">
      <header><h4>{title}</h4><button type="button" onClick={() => onCopy(value)} aria-label={`复制${title}`}><Icon name="copy" size={13} />复制</button></header>
      <pre>{value}</pre>
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
              <TaskList tasks={tasks} onSelect={openTask} empty="" />
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


