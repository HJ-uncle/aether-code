import {
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
import { registerCommand } from '@renderer/core/platform/commands'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { IconButton, SectionHeading, Spinner } from '@renderer/workbench/ui-primitives'
import { openAppSettings } from '../settings/app-settings-navigation'
import { Markdown } from '../chat/Markdown'
import { FileChangeCard } from '../chat/FileChangeCard'
import { computeLineDiff, diffForDeletedFile, diffForNewFile, diffStats } from '../chat/diff'
import { FileGlyph } from '../explorer/FileGlyph'
import { classifyChatLink } from '../chat/chat-link'
import { openFileFromChat } from '../chat/open-file'
import { useWorkController } from './work-runtime'
import { WorkBrowser } from './WorkBrowser'
import { WorkComposer as WorkComposerV2 } from './WorkComposer'
import { WorkTaskActions } from './WorkTaskActions'
import { WorkArtifactPanel } from './WorkArtifactPanel'
import { WorkGitPanel } from './WorkGitPanel'
import { findWorkArtifact } from './work-artifact-utils'
import { hideBrowserSurfaces, useBrowserState } from '../browser/browser-store'
import './work.css'
import '../chat/apple-chat-panels.css'

type WorkController = ReturnType<typeof useWorkController>
type WorkTask = WorkController['tasks'][number]
type Page = 'home' | 'projects' | 'artifacts' | 'automations' | 'connections'
type WorkspaceTab = 'artifacts' | 'sources' | 'browser' | 'activity' | 'git'
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
}

const VIEW_KEY = 'aether.work.view.v1'
const conversationPositions = new Map<string, { top: number; follow: boolean }>()
const pendingDrafts = new Map<string, { values: string[][]; freeText: string[] }>()
const NAVIGATION: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'home', label: '工作台', icon: 'chat' },
  { id: 'projects', label: '项目', icon: 'folder-outline' },
  { id: 'artifacts', label: '成果', icon: 'file' },
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
      tab: ['artifacts', 'sources', 'browser', 'activity', 'git'].includes(String(record.tab))
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
function shortDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
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
  const rootRef = useRef<HTMLDivElement>(null)
  const [compactNavigation, setCompactNavigation] = useState(window.innerWidth <= 1160)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const set = (patch: Partial<ViewState>): void =>
    setView((previous) => ({ ...previous, ...patch }))
  const task = controller.activeTask
  const activeTasks = controller.tasks.filter((item) => !item.archived)
  const archivedTasks = controller.tasks.filter((item) => item.archived)
  const waiting = activeTasks.filter((item) => item.status === 'waiting').length
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
    setView((previous) =>
      previous.page === 'home' && previous.workspace && previous.tab === 'browser'
        ? previous
        : { ...previous, page: 'home', workspace: true, tab: 'browser', pane: 'workspace' }
    )
  }, [appMode, revealRequestId])
  useEffect(() => {
    const ownsBrowserSurface =
      appMode === 'work' &&
      Boolean(task) &&
      view.page === 'home' &&
      view.workspace &&
      view.tab === 'browser'
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
  const navigate = (page: Page): void => {
    set({ page })
    setNavigationOpen(false)
    if (page === 'home') controller.showHome()
  }
  const openTask = (id: string): void => {
    controller.selectTask(id)
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
  }
  const newTask = (): void => {
    controller.showHome()
    setNavigationOpen(false)
    set({ page: 'home', pane: 'conversation' })
    setSearch('')
    setFilter('all')
  }
  const openWorkspace = (tab: WorkspaceTab): void =>
    set({ workspace: true, tab, pane: 'workspace' })
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
                controller={controller}
                openWorkspace={openWorkspace}
                openArtifact={(id) => {
                  setSelectedArtifact(id)
                  openWorkspace('artifacts')
                }}
              />
              {view.workspace && (
                <>
                  <WorkDivider ratio={view.ratio} setRatio={(ratio) => set({ ratio })} />
                  <Workspace
                    controller={controller}
                    tab={view.tab}
                    setTab={(tab) => set({ tab })}
                    selectedArtifact={selectedArtifact}
                    selectArtifact={setSelectedArtifact}
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
                首版使用当前引擎工具，Work 专属工具范围尚未接入。
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
                  tasks={activeTasks.filter(
                    (item) =>
                      (filter === 'all' || item.status === filter) &&
                      item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
                  )}
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
  return tasks.length ? (
    <div className="work-task-list">
      {tasks.map((task) => (
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
    </div>
  ) : (
    <p className="work-list-empty">{empty}</p>
  )
}

function Conversation({
  controller,
  openWorkspace,
  openArtifact
}: {
  controller: WorkController
  openWorkspace: (tab: WorkspaceTab) => void
  openArtifact: (id: string) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const mode = useAppMode()
  const [following, setFollowing] = useState(true)
  const [stepsOpen, setStepsOpen] = useState(true)
  const task = controller.activeTask!
  const contentKey = controller.messages
    .map(
      (message) =>
        `${message.id}:${message.content.length}:${message.status}:${message.tools.length}`
    )
    .join('|')
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const stored = conversationPositions.get(task.id)
    followRef.current = stored?.follow ?? true
    setFollowing(followRef.current)
    element.scrollTop = stored?.top ?? element.scrollHeight
    return () => {
      conversationPositions.set(task.id, { top: element.scrollTop, follow: followRef.current })
    }
  }, [task.id])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current && element.clientHeight)
      element.scrollTop = element.scrollHeight
  }, [contentKey, controller.loading, mode])
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
    followRef.current = true
    setFollowing(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
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
        </div>
      </div>
      <div
        className="work-conversation__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget
          if (!node.clientHeight) return
          const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 70
          followRef.current = bottom
          setFollowing(bottom)
        }}
      >
        <div className="work-conversation__content">
          {controller.loading && (
            <div className="work-loading">
              <Spinner />
              正在读取任务…
            </div>
          )}
          {!controller.loading && !controller.messages.length && (
            <EmptyState
              icon="chat"
              title="一起完成这项工作"
              description="在下方描述目标。执行过程、需要补充的问题和最终结果都会出现在这里。"
            />
          )}
          {controller.messages.map((message) => (
            <WorkMessage
              key={message.id}
              message={message}
              controller={controller}
              openArtifact={openArtifact}
            />
          ))}
          {controller.todos.length > 0 && (
            <section className="work-steps">
              <button
                type="button"
                className="work-steps__header"
                aria-expanded={stepsOpen}
                onClick={() => setStepsOpen(!stepsOpen)}
              >
                <Icon name={stepsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                <strong>工作步骤</strong>
                <span>
                  {controller.todos.filter((todo) => todo.status === 'done').length} /{' '}
                  {controller.todos.length}
                </span>
              </button>
              {stepsOpen && (
                <ol>
                  {controller.todos.map((todo) => (
                    <li key={todo.id}>
                      <span>{todo.title}</span>
                      <span className={`work-step-state work-step-state--${todo.status}`}>
                        {todo.status === 'in_progress' && <Spinner size={11} />}
                        {
                          {
                            pending: '待开始',
                            in_progress: '进行中',
                            done: '已完成',
                            cancelled: '已取消'
                          }[todo.status]
                        }
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
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

/** Keep execution feedback beside the composer even while the user reads older messages. */
function WorkRunStatus({ controller }: { controller: WorkController }): JSX.Element | null {
  const mode = useAppMode()
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const waiting = controller.pending.length > 0
  const active = controller.streaming || waiting
  const message = controller.messages.filter((item) => item.role === 'assistant').at(-1)
  const current = message && ['streaming', 'waiting'].includes(message.status) ? message : null
  const startedAt = current?.run?.startedAt ?? current?.startedAt ?? current?.createdAt
  const running = current
    ? [...current.tools].reverse().find((tool) => tool.state === 'running' && !tool.hidden)
    : null
  const compacting = current?.run?.compaction?.phase === 'running'
  const phase = stopping
    ? 'stopping'
    : waiting
      ? 'waiting'
      : compacting
        ? 'compacting'
        : running
          ? 'tool'
          : current?.content
            ? 'generating'
            : 'processing'
  const label = stopping
    ? '正在停止…'
    : waiting
      ? controller.pending.some((item) => item.kind === 'permission')
        ? '等待确认'
        : '等你补充'
      : compacting
        ? '正在自动压缩上下文…'
        : running
          ? `${toolDisplayName(running.name)}…`
          : current?.content
            ? '正在生成回复…'
            : '正在处理任务…'

  useEffect(() => {
    if (!active || mode !== 'work') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, mode])

  if (!active) return null
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const elapsed =
    seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return (
    <div
      className="work-run-status"
      data-state={waiting ? 'waiting' : 'running'}
      data-phase={phase}
    >
      <div
        className="work-run-status__label"
        role="status"
        aria-live="polite"
        aria-label="任务运行状态"
      >
        {waiting && !stopping ? <Icon name="chat" size={14} /> : <Spinner size={13} />}
        <span>{label}</span>
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

function WorkMessage({
  message,
  controller,
  openArtifact
}: {
  message: ChatMessage
  controller: WorkController
  openArtifact: (id: string) => void
}): JSX.Element {
  const { engine } = useApp()
  const pending =
    message.interactions?.filter((item) => item.status === 'pending') ??
    (message.pending ? [message.pending] : [])
  const task = controller.activeTask!
  return (
    <article
      className={`work-message work-message--${message.role}`}
      aria-label={message.role === 'user' ? '用户消息' : 'AI 回复'}
      onClickCapture={(event) =>
        openWorkFileLink(event, controller, engine.snapshot.baseUrl, openArtifact)
      }
    >
      {message.content && (
        <Markdown
          text={message.content}
          streaming={message.status === 'streaming'}
          fileContext={{ sessionId: task.id, workspaceRoot: task.workspacePath }}
        />
      )}
      {message.error && (
        <p className="work-message__error" role="alert">
          {message.error}
        </p>
      )}
      {pending.map((item) => (
        <WorkPending
          key={item.requestId || item.toolCallId}
          pending={item}
          respond={controller.respond}
        />
      ))}
      {message.answered && <p className="work-note">已回复：{message.answered}</p>}
    </article>
  )
}

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
    pendingDrafts.set(key, { values, freeText })
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
  const last = useRef<number | null>(null)
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
          setRatio(Math.max(35, Math.min(62, ratio + (event.key === 'ArrowLeft' ? -2 : 2))))
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        last.current = event.clientX
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (last.current === null) return
        const width = event.currentTarget.parentElement?.clientWidth || 1
        setRatio(Math.max(35, Math.min(62, ratio + ((event.clientX - last.current) / width) * 100)))
        last.current = event.clientX
      }}
      onPointerUp={(event) => {
        last.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        last.current = null
      }}
    />
  )
}

function Workspace({
  controller,
  tab,
  setTab,
  selectedArtifact,
  selectArtifact
}: {
  controller: WorkController
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  selectedArtifact: string | null
  selectArtifact: (id: string) => void
}): JSX.Element {
  const tabs: Array<[WorkspaceTab, string]> = [
    ['artifacts', '成果'],
    ['sources', '资料'],
    ['browser', '浏览器'],
    ['activity', '活动'],
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
      {tabs.map(([id]) => (
        <div
          key={id}
          className={`work-workspace__body${id === 'artifacts' ? ' work-workspace__body--artifacts' : ''}`}
          hidden={tab !== id}
          role="tabpanel"
          id={`work-panel-${id}`}
          aria-labelledby={`work-tab-${id}`}
        >
          {id === 'artifacts' ? (
            <ArtifactPanel
              controller={controller}
              selectedId={selectedArtifact}
              onSelect={selectArtifact}
            />
          ) : id === 'sources' ? (
            <SourcePanel controller={controller} />
          ) : id === 'activity' ? (
            <ActivityPanel messages={controller.messages} />
          ) : id === 'git' ? (
            <WorkGitPanel
              // Never fall back to the Code workspace when Work has no active
              // task. Git operations must stay scoped to the selected Work
              // task's directory and session.
              cwd={controller.activeTask?.workspacePath}
              sessionId={controller.activeTask?.id}
              active={tab === 'git'}
              onOpenFile={(path) =>
                void openFileFromChat(path, {
                  sessionId: controller.activeTask?.id ?? '',
                  workspaceRoot: controller.activeTask?.workspacePath
                }).catch(reportError)
              }
            />
          ) : (
            <WorkBrowser sessionId={controller.activeTask?.id} onReveal={() => setTab('browser')} />
          )}
        </div>
      ))}
    </section>
  )
}

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
  const activeSession = controller.activeTask?.id
  const load = useCallback(async () => {
    if (!controller.ready) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setJobs(await requestOrThrow<WorkAutomation[]>({ method: 'GET', path: '/cron' }))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [controller.ready])
  useEffect(() => {
    void load()
  }, [load])
  const create = async (): Promise<void> => {
    if (!activeSession || !name.trim() || !message.trim()) return
    setSaving(true)
    try {
      const created = await requestOrThrow<WorkAutomation>({
        method: 'POST',
        path: '/cron',
        body: {
          name: name.trim(),
          cronExpr: cronExpr.trim(),
          message: message.trim(),
          sessionId: activeSession,
          enabled: true
        }
      })
      setJobs((previous) => [created, ...previous])
      setName('')
      setMessage('')
      setShowForm(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const updateEnabled = async (job: WorkAutomation): Promise<void> => {
    try {
      const updated = await requestOrThrow<WorkAutomation>({
        method: 'POST',
        path: `/cron/${encodeURIComponent(job.id)}/${job.enabled ? 'disable' : 'enable'}`,
        body: {}
      })
      setJobs((previous) => previous.map((item) => (item.id === job.id ? updated : item)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const remove = async (job: WorkAutomation): Promise<void> => {
    try {
      await requestOrThrow<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/cron/${encodeURIComponent(job.id)}`
      })
      setJobs((previous) => previous.filter((item) => item.id !== job.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
          onClick={() => setShowForm((open) => !open)}
          disabled={!controller.ready || !activeSession}
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
              onChange={(event) => setName(event.target.value)}
              placeholder="工作日简报"
              required
            />
          </label>
          <label>
            时间表达式
            <input
              value={cronExpr}
              onChange={(event) => setCronExpr(event.target.value)}
              placeholder="分 时 日 月 周"
              required
            />
          </label>
          <label className="work-automation-form__message">
            每次运行的目标
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="让 AI 完成什么工作？"
              rows={3}
              required
            />
          </label>
          <div className="work-automation-form__actions">
            <span>将继续使用当前任务的会话和工作目录。</span>
            <button type="button" className="work-quiet-button" onClick={() => setShowForm(false)}>
              取消
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={saving || !name.trim() || !message.trim()}
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
                </span>
              </div>
              <button
                type="button"
                className="work-quiet-button"
                onClick={() => void updateEnabled(job)}
              >
                {job.enabled ? '暂停' : '启用'}
              </button>
              <IconButton
                icon="trash"
                label={`删除自动化 ${job.name}`}
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
  selectedId,
  onSelect
}: {
  controller: WorkController
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
  // Keep the compact list informative without exposing long workspace paths.
  // Stats come from the same diff implementation used by FileChangeCard, so the
  // numbers shown here always match the expanded diff below.
  const changeStats = useMemo(() => {
    const result = new Map<string, { added: number; removed: number; approximate: boolean }>()
    for (const message of controller.messages) {
      for (const tool of message.tools) {
        const change = tool.change
        if (!change || change.status === 'reverted') continue
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
        if (!rows) continue
        result.set(change.path.replace(/\\/g, '/'), diffStats(rows))
      }
    }
    return result
  }, [controller.messages])
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
      <WorkArtifactPanel
        artifact={artifact}
        workspaceRoot={controller.activeTask?.workspacePath}
        sessionId={controller.activeTask?.id}
        artifacts={controller.artifacts}
        onSelect={onSelect}
        onOpenChanges={() => changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
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
      <WorkChangesPanel controller={controller} sectionRef={changesRef} />
    </div>
  )
}

function WorkChangesPanel({ controller, sectionRef }: { controller: WorkController; sectionRef?: RefObject<HTMLElement | null> }): JSX.Element | null {
  const sessionId = controller.activeTask?.id
  const [changes, setChanges] = useState<EngineFileChange[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(true)
  const previousStreaming = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId || !controller.ready) {
      setChanges([])
      return
    }
    try {
      const result = await requestOrThrow<EngineFileChange[]>({
        method: 'GET',
        path: '/changes',
        query: { sessionId, status: 'pending', view: 'net' }
      })
      setChanges(Array.isArray(result) ? result : [])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [controller.ready, sessionId])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (previousStreaming.current && !controller.streaming) void refresh()
    previousStreaming.current = controller.streaming
  }, [controller.streaming, refresh])
  if (!sessionId || (!changes.length && !error)) return null
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
        ) : (
          <div className="work-changes-panel__list">
            {changes.map((change) => (
              <FileChangeCard key={change.id} change={change} state="done" />
            ))}
          </div>
        ))}
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

function ActivityPanel({ messages }: { messages: ChatMessage[] }): JSX.Element {
  const activities = messages.flatMap((message) => message.tools.filter((tool) => !tool.hidden))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = activities.find((item) => item.id === selectedId)
  return activities.length ? (
    <div className="work-activities">
      <div className="work-activities__list">
        {activities.map((tool) => (
          <button
            type="button"
            key={tool.id}
            onClick={() => setSelectedId(tool.id)}
            aria-pressed={selectedId === tool.id}
          >
            <Icon name="output" size={15} />
            <span>{toolDisplayName(tool.name)}</span>
            <span className={`work-tool-state work-tool-state--${tool.state}`}>
              {TOOL_STATUS[tool.state]}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="work-activity-detail">
          <h3>{toolDisplayName(selected.name)}</h3>
          {selected.args && (
            <>
              <h4>输入</h4>
              <pre>{selected.args}</pre>
            </>
          )}
          {(selected.error || selected.result) && (
            <>
              <h4>{selected.error ? '错误' : '结果'}</h4>
              <pre>{selected.error || selected.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  ) : (
    <EmptyState
      icon="output"
      title="暂无工具活动"
      description="任务调用工具时，详细输入、结果和错误会按顺序保存在这里。"
    />
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
    for (const task of controller.tasks)
      if (!task.archived && task.workspacePath)
        result.set(task.workspacePath, [...(result.get(task.workspacePath) ?? []), task])
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


