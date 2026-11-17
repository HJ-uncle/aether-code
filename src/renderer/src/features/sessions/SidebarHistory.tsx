import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { toast } from '@renderer/core/toast'
import { getEngineSource } from '@renderer/core/engine/source'
import { ContextMenu, type ContextMenuItem } from '@renderer/ui/ContextMenu'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { PromptDialog } from '@renderer/ui/PromptDialog'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { buildProjectGroups, isProjectTaskArchived, PROJECT_PREFERENCES_KEY, type ProjectPreferences } from '../projects/project-preferences'
import { useProjectPreferences } from '../projects/useProjectPreferences'
import { SidebarTask } from './SidebarTask'
import { projectSidebarStatus, sortSessionSidebarTasks } from './sidebar-task'
import type { SessionTask } from './state'
import type { SessionTaskActionController } from './useSessionTaskActions'
import './sidebar-history.css'

const PAGE_SIZE = 6
const RECENT_INITIAL_SIZE = 12
const scopes = ['recent', 'projects', 'archived'] as const
type Scope = typeof scopes[number]
type ProjectGroup = { key: string; name: string; tasks: SessionTask[]; pinned: boolean; archived: boolean }

function groupTasksByProject(tasks: readonly SessionTask[], preferences: ProjectPreferences, scope: 'current' | 'archived'): ProjectGroup[] {
  const groups = buildProjectGroups(tasks, preferences, scope).map(group => ({ ...group, key: group.path }))
  const independent = sortSessionSidebarTasks(tasks.filter(task => !task.workspacePath && Boolean(task.archived) === (scope === 'archived')))
  // Independent sessions stay last in both collections, keeping project work primary.
  return independent.length ? [...groups, { key: '__independent__', name: '独立会话', tasks: independent, pinned: false, archived: false }] : groups
}

function scopeLabel(scope: Scope): string {
  return scope === 'recent' ? '最近任务' : scope === 'projects' ? '项目会话' : '归档任务'
}

export function SidebarHistory({ tasks, controller, selectedTaskId, visible, onOpen, onCreateTask, projectPreferencesKey = PROJECT_PREFERENCES_KEY }: {
  tasks: readonly SessionTask[]
  controller: SessionTaskActionController
  selectedTaskId: string | null
  visible: boolean
  onOpen: (id: string) => void
  /** Creates a task for a project path. null creates an independent task. */
  onCreateTask: (workspacePath: string | null) => void | Promise<void>
  /** Shares project names, pins, archives and sorting with the project page. */
  projectPreferencesKey?: string
}): JSX.Element {
  const { ready } = controller
  const [preferences, persistPreferences] = useProjectPreferences(projectPreferencesKey)
  const [renaming, setRenaming] = useState<ProjectGroup | null>(null)
  const mounted = useRef(true)
  const preferencesKeyRef = useRef(projectPreferencesKey)
  useLayoutEffect(() => { preferencesKeyRef.current = projectPreferencesKey }, [projectPreferencesKey])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const actionController = useRef(controller)
  useLayoutEffect(() => { actionController.current = controller }, [controller])
  // Streaming also replaces action closures. Forward row events to the latest
  // committed controller without invalidating every memoized history row.
  const taskActions = useMemo<SessionTaskActionController>(() => ({
    ready,
    renameTask: (id, title) => actionController.current.renameTask(id, title),
    archiveTask: (id, archived) => actionController.current.archiveTask(id, archived),
    deleteTask: id => actionController.current.deleteTask(id),
    stopTask: id => actionController.current.stopTask(id),
    exportTask: id => actionController.current.exportTask(id),
    addConversationReference: id => actionController.current.addConversationReference(id),
    setTaskPinned: (id, pinned) => actionController.current.setTaskPinned(id, pinned),
    setTaskLabelColor: (id, color) => actionController.current.setTaskLabelColor(id, color)
  }), [ready])
  const lists = useMemo(() => ({
    recent: sortSessionSidebarTasks(tasks.filter(task => !isProjectTaskArchived(task, preferences))),
    projects: groupTasksByProject(tasks, preferences, 'current'),
    archived: groupTasksByProject(tasks, preferences, 'archived')
  }), [tasks, preferences])
  const [scope, setScope] = useState<Scope>('recent')
  const [recentLimit, setRecentLimit] = useState(RECENT_INITIAL_SIZE)
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({})
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [projectMenu, setProjectMenu] = useState<{ key: string; x: number; y: number; id: number; anchor: HTMLElement | null } | null>(null)
  const menuSequence = useRef(0)
  const positions = useRef({ recent: 0, projects: 0, archived: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabs = useRef<Partial<Record<Scope, HTMLButtonElement | null>>>({})
  const projectHeadingRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const selection = useRef<string | null>(null)
  const projectSelection = useRef<string | null>(null)
  const reveal = useRef<string | null>(null)
  const panelId = useId()
  const recentItems = lists.recent
  const archivedItems = lists.archived
  const items = scope === 'recent' ? recentItems : scope === 'archived' ? archivedItems : lists.projects
  const hasMore = scope === 'recent' && recentItems.length > recentLimit
  const projectGroups = scope === 'archived' ? archivedItems : lists.projects

  useLayoutEffect(() => {
    if (!selectedTaskId) { selection.current = null; projectSelection.current = null; reveal.current = null; return }
    const selectedTask = tasks.find(task => task.id === selectedTaskId)
    if (!selectedTask) return
    const nextScope: Scope = isProjectTaskArchived(selectedTask, preferences) ? 'archived' : scope === 'projects' ? 'projects' : 'recent'
    let index = -1
    let selectedProjectKey: string | null = null
    if (nextScope !== 'recent') {
      const group = lists[nextScope].find(candidate => candidate.tasks.some(task => task.id === selectedTaskId))
      if (group) {
        selectedProjectKey = nextScope + ':' + group.key
        index = group.tasks.findIndex(task => task.id === selectedTaskId)
      }
    } else index = recentItems.findIndex(task => task.id === selectedTaskId)
    if (index < 0) return
    const selectionChanged = selection.current !== selectedTaskId
    if (selectionChanged) {
      selection.current = selectedTaskId
      reveal.current = selectedTaskId
      if (scrollRef.current) positions.current[scope] = scrollRef.current.scrollTop
      setScope(nextScope)
    } else if (nextScope !== scope) return
    if (nextScope !== 'recent' && selectedProjectKey) {
      // Status polling must preserve a project the user deliberately folded.
      // Only navigation to a different session should reveal its group again.
      const selectionKey = nextScope + ':' + selectedTaskId
      if (projectSelection.current !== selectionKey) {
        reveal.current = selectedTaskId
        setCollapsedProjects(previous => {
          if (!previous.has(selectedProjectKey!)) return previous
          const next = new Set(previous); next.delete(selectedProjectKey!); return next
        })
      }
      projectSelection.current = selectionKey
      setProjectLimits(previous => {
        const required = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
        return (previous[selectedProjectKey!] ?? PAGE_SIZE) >= required ? previous : { ...previous, [selectedProjectKey!]: required }
      })
    } else setRecentLimit(previous => {
      const required = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
      return Math.max(previous, required)
    })
  }, [selectedTaskId, lists, recentItems, scope, tasks, preferences])

  useLayoutEffect(() => {
    if (visible && scrollRef.current) scrollRef.current.scrollTop = positions.current[scope]
  }, [scope, visible])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!visible || !root || !reveal.current || !root.clientHeight) return
    const row = root.querySelector<HTMLElement>('[data-task-id="' + CSS.escape(reveal.current) + '"]')
    if (!row || row.closest('[data-collapsed="true"]')) return
    const bounds = root.getBoundingClientRect(), target = row.getBoundingClientRect()
    if (target.top < bounds.top) root.scrollTop -= bounds.top - target.top
    else if (target.bottom > bounds.bottom) root.scrollTop += target.bottom - bounds.bottom
    positions.current[scope] = root.scrollTop
    reveal.current = null
  }, [scope, recentLimit, projectLimits, collapsedProjects, visible, selectedTaskId, projectGroups, recentItems, archivedItems])

  const selectScope = (next: Scope): void => {
    if (next === scope) return
    if (scrollRef.current) positions.current[scope] = scrollRef.current.scrollTop
    reveal.current = null
    setProjectMenu(null)
    setScope(next)
  }

  const toggleProject = (key: string): void => setCollapsedProjects(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const toggleProjectPin = (key: string): void => {
    if (key === '__independent__') return
    persistPreferences(previous => ({ pinnedPaths: previous.pinnedPaths.includes(key)
      ? previous.pinnedPaths.filter(path => path !== key) : [...previous.pinnedPaths, key] }))
  }

  const toggleProjectArchive = async (group: ProjectGroup): Promise<void> => {
    const source = getEngineSource()
    if (!group.archived && !await confirmDialog({ title: '归档项目',
      body: `归档“${group.name}”后，可在“归档”中查看和恢复。已有任务与磁盘文件会保留，正在进行的任务不受影响。`, confirmText: '归档' })) return
    if (!mounted.current || source !== getEngineSource() || preferencesKeyRef.current !== projectPreferencesKey) return
    persistPreferences(previous => ({ archivedPaths: group.archived ? previous.archivedPaths.filter(path => path !== group.key)
      : [...previous.archivedPaths, group.key] }))
    setProjectMenu(null)
  }

  const showMoreProjectTasks = (key: string, total: number): void => setProjectLimits(previous => ({
    ...previous,
    [key]: Math.min(total, (previous[key] ?? PAGE_SIZE) + PAGE_SIZE)
  }))

  const createTask = (workspacePath: string | null): void => {
    void Promise.resolve(onCreateTask(workspacePath)).catch(error => toast.error(error instanceof Error ? error.message : '无法新建会话，请重试。'))
  }

  const menuItems = (group: ProjectGroup): ContextMenuItem[] => {
    const viewKey = scope + ':' + group.key
    const collapsed = collapsedProjects.has(viewKey)
    const pinned = group.pinned
    const hasMore = group.tasks.length > (projectLimits[viewKey] ?? PAGE_SIZE)
    return [
      { id: 'new', label: '新建会话', icon: <Icon name="plus" size={14} />, disabled: group.archived,
        hint: group.archived ? '请先恢复项目' : undefined, onSelect: () => createTask(group.key === '__independent__' ? null : group.key) },
      ...(group.key === '__independent__' ? [] : [
        { id: 'pin', label: pinned ? '取消置顶项目' : '置顶项目', icon: <Icon name={pinned ? 'pin' : 'pin-outline'} size={14} />, onSelect: () => toggleProjectPin(group.key) },
        { id: 'rename', label: '修改显示名称', icon: <Icon name="pencil" size={14} />, onSelect: () => setRenaming(group) },
        ...(preferences.names[group.key] ? [{ id: 'reset-name', label: '恢复目录名称', icon: <Icon name="undo" size={14} />,
          onSelect: () => persistPreferences(previous => { const names = { ...previous.names }; delete names[group.key]; return { names } }) }] : []),
        { id: 'archive', label: group.archived ? '恢复项目' : '归档项目', icon: <Icon name={group.archived ? 'undo' : 'archive'} size={14} />,
          onSelect: () => { void toggleProjectArchive(group) } }
      ]),
      { id: 'collapse', label: collapsed ? '展开项目' : '收起项目', icon: <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />, separatorBefore: true, onSelect: () => toggleProject(viewKey) },
      ...(hasMore ? [{ id: 'more', label: '显示更多会话', hint: '每次 ' + PAGE_SIZE + ' 条', onSelect: () => { showMoreProjectTasks(viewKey, group.tasks.length); setCollapsedProjects(previous => { const next = new Set(previous); next.delete(viewKey); return next }) } }] : [])
    ]
  }

  return <section className="work-sidebar__history" aria-label="会话历史">
    <div className="work-sidebar__history-tabs" role="tablist" aria-label="任务列表">
      {scopes.map(value => <button key={value} ref={element => { tabs.current[value] = element }} type="button"
        className="work-sidebar__history-tab" role="tab"
        aria-selected={scope === value} aria-controls={panelId} tabIndex={scope === value ? 0 : -1}
        onClick={() => selectScope(value)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = scopes.indexOf(value)
          const next = event.key === 'Home' ? scopes[0] : event.key === 'End' ? scopes.at(-1)! : scopes[(index + (event.key === 'ArrowRight' ? 1 : -1) + scopes.length) % scopes.length]
          selectScope(next)
          tabs.current[next]?.focus()
        }}>{value === 'recent' ? '最近' : value === 'projects' ? '项目' : '归档'}</button>)}
    </div>
    <div key={scope} id={panelId} ref={scrollRef} className="work-sidebar__recent" role="tabpanel"
      aria-label={scopeLabel(scope)} tabIndex={0}
      onScroll={event => { positions.current[scope] = event.currentTarget.scrollTop }}>
      {scope !== 'recent' ? projectGroups.map(group => {
        const viewKey = scope + ':' + group.key
        const collapsed = collapsedProjects.has(viewKey)
        const groupLimit = projectLimits[viewKey] ?? PAGE_SIZE
        const shownTasks = group.tasks.slice(0, groupLimit)
        const groupHasMore = group.tasks.length > groupLimit
        const status = projectSidebarStatus(group.tasks, ready, { includeArchived: scope === 'archived' })
        const headingId = panelId + '-' + group.key.replace(/[^a-zA-Z0-9_-]/g, '-')
        return <section key={group.key} className="work-sidebar__project-group" data-project-key={group.key}
          data-collapsed={collapsed || undefined} aria-labelledby={headingId}>
          <div className="work-sidebar__project-heading-row" onContextMenu={event => {
            event.preventDefault(); event.stopPropagation()
            setProjectMenu({ key: group.key, id: ++menuSequence.current, x: event.clientX, y: event.clientY, anchor: projectHeadingRefs.current[group.key] })
          }}>
            <button type="button" ref={element => { projectHeadingRefs.current[group.key] = element }} id={headingId}
              className="work-sidebar__project-heading" aria-expanded={!collapsed}
              aria-label={group.name + '，' + group.tasks.length + ' 个会话' + (collapsed ? '，已收起' : '，已展开') + (status ? '，' + status.detail : '')}
              title={(group.key === '__independent__' ? '没有绑定项目目录的会话' : group.key) + (status ? '\n' + status.detail : '')}
              onClick={() => toggleProject(viewKey)}
              onKeyDown={event => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault(); event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setProjectMenu({ key: group.key, id: ++menuSequence.current, x: rect.left, y: rect.bottom + 4, anchor: event.currentTarget })
              }}>
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} aria-hidden="true" />
              <Icon name="folder-outline" size={14} aria-hidden="true" />
              <span className="work-sidebar__project-name">{group.name}</span>
              {group.pinned ? <Icon name="pin" size={12} className="work-sidebar__project-pin" aria-label="已置顶" /> : null}
              {status ? <span className="work-sidebar__project-status" data-project-status={status.kind}
                role="img" aria-label={status.detail} title={status.detail}>
                {status.active ? <Spinner size={14} />
                  : status.kind === 'unread' ? <i className="work-sidebar__completion-dot" aria-hidden="true" />
                  : status.icon ? <Icon name={status.icon} size={14} aria-hidden="true" /> : null}
                {status.count > 1 ? <span aria-hidden="true">{status.count}</span> : null}
              </span> : null}
            </button>
            {!group.archived && <button type="button" className="work-sidebar__project-create" title="在此项目中新建会话" aria-label={'在' + group.name + '中新建会话'}
              onClick={event => { event.stopPropagation(); createTask(group.key === '__independent__' ? null : group.key) }}>
              <Icon name="plus" size={15} />
            </button>}
          </div>
          <div className="work-sidebar__project-content" data-collapsed={collapsed || undefined} inert={collapsed}>
            <div>
              {shownTasks.map(task => <SidebarTask key={task.id} task={task} controller={taskActions}
                selected={task.id === selectedTaskId} onOpen={onOpen} />)}
              {groupHasMore ? <button type="button" className="work-sidebar__project-more"
                onClick={() => showMoreProjectTasks(viewKey, group.tasks.length)}>
                展开显示
              </button> : null}
            </div>
          </div>
          {projectMenu?.key === group.key ? <ContextMenu key={projectMenu.id} x={projectMenu.x} y={projectMenu.y}
            anchor={projectHeadingRefs.current[group.key]} items={menuItems(group)}
            onClose={() => setProjectMenu(current => current?.id === projectMenu.id ? null : current)} /> : null}
        </section>
      }) : recentItems.slice(0, recentLimit).map(task => <SidebarTask key={task.id} task={task} controller={taskActions}
        selected={task.id === selectedTaskId} onOpen={onOpen} />)}
      {!items.length ? <p>{scope === 'recent' ? '开始后，任务会保存在这里。' : scope === 'projects' ? '暂无项目会话。' : '暂无归档任务。'}</p> : null}
      {hasMore ? <button type="button" className="work-sidebar__history-more"
        onClick={() => setRecentLimit(previous => Math.min(recentItems.length, previous + PAGE_SIZE))}>
        展开显示
      </button> : null}
    </div>
    {renaming && <PromptDialog title="修改项目显示名称" label="项目名称" initialValue={renaming.name} confirmLabel="保存"
      validate={value => !value ? '项目名称不能为空' : value.length > 80 ? '项目名称不能超过 80 个字符' : null}
      onConfirm={value => persistPreferences(previous => ({ names: { ...previous.names, [renaming.key]: value } }))}
      onClose={() => setRenaming(null)} />}
  </section>
}
