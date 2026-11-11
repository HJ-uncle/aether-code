import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { getEngineSource, getEngineStorageKey, sessionStorageKey } from '@renderer/core/engine/source'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { getTopOverlayId } from '@renderer/workbench/overlay'
import { useHoverDetail } from '@renderer/workbench/useHoverDetail'
import type { WorkTask } from './work-state'
import { WorkTaskStatus } from './WorkTaskStatus'
import { WorkProjectNavigator } from './WorkProjectNavigator'
import { useWorkTaskActions, type WorkTaskActionController } from './useWorkTaskActions'
import { WORK_TASK_PAGE_SIZE } from './work-view-performance'
import './work-projects.css'

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'short' })
const projectName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || path
interface ProjectGroup { path: string; name: string; tasks: WorkTask[]; matches: WorkTask[]; updatedAt: number; pinned: boolean; archived: boolean }
interface ProjectPreferences { pinnedPaths: string[]; archivedPaths: string[]; names: Record<string, string>; selectedPath: string | null; selectedCollection: 'projects' | 'independent'; sort: 'recent' | 'name' }
interface ProjectMenu { id: number; path: string; anchor: HTMLButtonElement; x: number; y: number }

function readPreferences(key: string): ProjectPreferences {
  const fallback: ProjectPreferences = { pinnedPaths: [], archivedPaths: [], names: {}, selectedPath: null, selectedCollection: 'projects', sort: 'recent' }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return fallback
    const record = value as Record<string, unknown>
    return {
      pinnedPaths: Array.isArray(record.pinnedPaths) ? [...new Set(record.pinnedPaths.filter((path): path is string => typeof path === 'string'))] : [],
      archivedPaths: Array.isArray(record.archivedPaths) ? [...new Set(record.archivedPaths.filter((path): path is string => typeof path === 'string'))] : [],
      names: record.names && typeof record.names === 'object' && !Array.isArray(record.names)
        ? Object.fromEntries(Object.entries(record.names).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))) : {},
      selectedPath: typeof record.selectedPath === 'string' ? record.selectedPath : null,
      selectedCollection: record.selectedCollection === 'independent' ? 'independent' : 'projects',
      sort: record.sort === 'name' ? 'name' : 'recent'
    }
  } catch { return fallback }
}

export function WorkProjects({ tasks, ready, controller, onOpenTask, onNewTask, source, remote, uploading }: {
  tasks: WorkTask[]; ready: boolean; onOpenTask: (id: string) => void; onNewTask: (path: string) => Promise<void>
  source: string; remote: boolean; uploading: boolean; controller: WorkTaskActionController
}): JSX.Element {
  const storageKey = sessionStorageKey('aether.work.projects.v1', source)
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey))
  const [search, setSearch] = useState('')
  const [searchCollection, setSearchCollection] = useState<'projects' | 'independent' | null>(null)
  const [filter, setFilter] = useState<'all' | 'pinned' | 'archived'>('all')
  const [independentScope, setIndependentScope] = useState<'current' | 'archived'>('current')
  const [menu, setMenu] = useState<ProjectMenu | null>(null)
  const menuSequence = useRef(0)
  const [renaming, setRenaming] = useState<ProjectGroup | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [mobileDetail, setMobileDetail] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const [recoverFocus, setRecoverFocus] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const allProjectsRef = useRef<HTMLButtonElement>(null)
  const independentRef = useRef<HTMLButtonElement>(null)
  const persist = (change: Partial<ProjectPreferences>): void => {
    const next = { ...preferences, ...change }
    setPreferences(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Browsing remains available if storage is full. */ }
  }
  const groups = useMemo(() => {
    const byPath = new Map<string, WorkTask[]>()
    // Full paths distinguish same-name projects; reading the list never changes task ownership.
    for (const task of tasks) {
      if (task.archived || !task.workspacePath) continue
      const group = byPath.get(task.workspacePath)
      if (group) group.push(task)
      else byPath.set(task.workspacePath, [task])
    }
    const pins = new Set(preferences.pinnedPaths)
    const archived = new Set(preferences.archivedPaths)
    return [...byPath].map(([path, items]): ProjectGroup => {
      const sorted = items.sort((a, b) => b.updatedAt - a.updatedAt)
      return { path, name: preferences.names[path] || projectName(path), tasks: sorted, matches: sorted,
        updatedAt: sorted[0].updatedAt, pinned: pins.has(path), archived: archived.has(path) }
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
      (preferences.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : b.updatedAt - a.updatedAt) || a.path.localeCompare(b.path))
  }, [tasks, preferences.pinnedPaths, preferences.archivedPaths, preferences.names, preferences.sort])
  const query = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => groups.flatMap(group => {
    if (filter === 'archived' ? !group.archived : group.archived || filter === 'pinned' && !group.pinned) return []
    if (!query || group.path.toLocaleLowerCase().includes(query) || group.name.toLocaleLowerCase().includes(query)) return [group]
    const matches = group.tasks.filter(task => task.title.toLocaleLowerCase().includes(query))
    return matches.length ? [{ ...group, matches }] : []
  }), [groups, query, filter])
  // A default sandbox is an execution directory, not a selected project. Keep
  // these sessions reachable without inventing a directory or changing ownership.
  const independentTasks = useMemo(() => tasks.filter(task => !task.workspacePath).sort((a, b) => {
    const priority = (task: WorkTask): number => task.status === 'waiting' ? 2 : task.status === 'running' ? 1 : 0
    return priority(b) - priority(a) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  }), [tasks])
  const currentIndependent = independentTasks.filter(task => !task.archived)
  const archivedIndependent = independentTasks.length - currentIndependent.length
  const scopedIndependent = independentTasks.filter(task => Boolean(task.archived) === (independentScope === 'archived'))
  const independentMatches = scopedIndependent.filter(task => !query || task.title.toLocaleLowerCase().includes(query))
  const independentRunning = currentIndependent.filter(task => task.status === 'running').length
  const independentWaiting = currentIndependent.filter(task => task.status === 'waiting').length
  const independentActivity = !ready && independentRunning + independentWaiting
    ? `${independentRunning + independentWaiting} 个连接中断`
    : [independentRunning && `${independentRunning} 个进行中`, independentWaiting && `${independentWaiting} 个待处理`].filter(Boolean).join(' · ')
  // Searching can temporarily select a match without overwriting the user's remembered project.
  const selected = filtered.find(group => group.path === preferences.selectedPath) ?? filtered[0]
  const onlyIndependent = !groups.length && independentTasks.length > 0
  const collection = query && searchCollection ? searchCollection : preferences.selectedCollection
  const automaticSearch = Boolean(query) && searchCollection === null
  const showIndependent = independentTasks.length > 0 && (onlyIndependent ||
    collection === 'independent' && (!automaticSearch || independentMatches.length > 0 || !selected) ||
    automaticSearch && !selected && independentMatches.length > 0)
  useLayoutEffect(() => {
    if (onlyIndependent) setMobileDetail(true)
  }, [onlyIndependent])
  useLayoutEffect(() => {
    // Removing the final pin must not strand a narrow window in an empty detail pane.
    if (!selected && !showIndependent && mobileDetail) {
      setMobileDetail(false)
      allProjectsRef.current?.focus()
    }
  }, [selected, showIndependent, mobileDetail])
  useEffect(() => {
    if (!recoverFocus || menu) return
    // Wait for menu/dialog focus restoration before handing off a removed row's focus.
    const frame = requestAnimationFrame(() => {
      setRecoverFocus(false)
      if (getTopOverlayId()) return
      if (showIndependent) independentRef.current?.focus()
      else if (selected) setFocusRequest(value => value + 1)
      else allProjectsRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [recoverFocus, menu, selected, showIndependent])
  const navigation = useMemo(() => filtered.map(group => ({ path: group.path, name: group.name,
    taskCount: group.matches.length, updatedAt: group.updatedAt, pinned: group.pinned })), [filtered])
  const total = groups.reduce((count, group) => count + group.tasks.length, 0)
  const clearSearch = (): void => { setSearch(''); setSearchCollection(null); searchRef.current?.focus() }
  const selectProject = (path: string): void => {
    setSearchCollection('projects')
    persist({ selectedPath: path, selectedCollection: 'projects' })
  }
  const togglePin = (project = selected): void => {
    if (!project) return
    if (filter === 'pinned' && project.pinned) { setMobileDetail(false); setRecoverFocus(true) }
    persist({ pinnedPaths: project.pinned ? preferences.pinnedPaths.filter(path => path !== project.path)
      : [...preferences.pinnedPaths, project.path] })
  }
  const openMenu = (path: string, anchor: HTMLButtonElement, position: { x: number; y: number }): void => {
    // A new request must not inherit the previous menu's exit animation, even at the same coordinates.
    setMenu({ id: ++menuSequence.current, path, anchor, ...position })
  }
  const perform = (operation: (assertCurrent: () => void) => Promise<void>): void => {
    if (busy.current) return
    const epoch = getEngineSource()
    const assertCurrent = (): void => {
      if (!mounted.current || source !== getEngineStorageKey() || epoch !== getEngineSource()) throw new Error('项目连接已变化，请重新打开菜单。')
    }
    busy.current = true
    void (async () => { assertCurrent(); await operation(assertCurrent) })()
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : '操作失败，请重试。'))
      .finally(() => { busy.current = false })
  }
  const menuProject = menu && groups.find(project => project.path === menu.path)
  const menuItems: ContextMenuItem[] = menuProject ? [
    { id: 'view', label: '查看项目', icon: <Icon name="folder-outline" size={16} />, onSelect: () => { selectProject(menuProject.path); setMobileDetail(true) } },
    { id: 'new', label: '在此项目中新建任务', icon: <Icon name="plus" size={16} />, disabled: !ready || uploading || menuProject.archived,
      hint: menuProject.archived ? '请先恢复项目' : uploading ? '资料上传中' : !ready ? '等待连接' : undefined,
      onSelect: () => perform(async () => onNewTask(menuProject.path)) },
    { id: 'pin', label: menuProject.pinned ? '取消置顶项目' : '置顶项目', icon: <Icon name="pin" size={16} />, separatorBefore: true,
      onSelect: () => togglePin(menuProject) },
    { id: 'rename', label: '修改显示名称', icon: <Icon name="pencil" size={16} />, onSelect: () => setRenaming(menuProject) },
    ...(preferences.names[menuProject.path] ? [{ id: 'reset-name', label: '恢复目录名称', icon: <Icon name="undo" size={16} />,
      onSelect: () => { const names = { ...preferences.names }; delete names[menuProject.path]; persist({ names }) } }] : []),
    { id: 'copy-name', label: '复制项目名称', icon: <Icon name="copy" size={16} />, separatorBefore: true,
      onSelect: () => perform(async () => { await navigator.clipboard.writeText(menuProject.name); toast.success('已复制项目名称') }) },
    { id: 'copy-path', label: '复制项目路径', icon: <Icon name="copy" size={16} />,
      onSelect: () => perform(async () => { await navigator.clipboard.writeText(menuProject.path); toast.success('已复制项目路径') }) },
    { id: 'folder', label: '在文件夹中打开', icon: <Icon name="folder-outline" size={16} />, disabled: remote,
      hint: remote ? '远端目录' : undefined, title: remote ? '远端项目不能通过本机文件管理器打开' : undefined,
      onSelect: () => perform(async assertCurrent => {
        if (remote) throw new Error('远端项目不能通过本机文件管理器打开')
        await window.aether.fs.allowRoot(menuProject.path); assertCurrent()
        await window.aether.system.openWith(menuProject.path, 'file-explorer')
      }) },
    { id: 'archive', label: menuProject.archived ? '恢复项目' : '归档项目', icon: <Icon name={menuProject.archived ? 'undo' : 'folder-outline'} size={16} />, separatorBefore: true,
      onSelect: () => perform(async assertCurrent => {
        if (!menuProject.archived && !await confirmDialog({ title: '归档项目',
          body: `归档“${menuProject.name}”后，可在“已归档”中查看和恢复。已有任务与磁盘文件会保留，正在进行的任务不受影响。`, confirmText: '归档' })) return
        assertCurrent()
        persist({ archivedPaths: menuProject.archived ? preferences.archivedPaths.filter(path => path !== menuProject.path)
          : [...preferences.archivedPaths, menuProject.path] })
        setMobileDetail(false)
        setRecoverFocus(true)
        toast.success(menuProject.archived ? '已恢复项目' : '已归档项目')
      }) }
  ] : []

  return <section className="work-projects" aria-label="项目" data-detail={mobileDetail && (Boolean(selected) || showIndependent) || undefined} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && searchRef.current) {
      event.preventDefault(); event.stopPropagation(); searchRef.current.focus(); searchRef.current.select()
    }
  }}>
    <header className="work-projects__header">
      <div className="work-projects__heading">
        <h1>项目</h1>
        <p className="work-projects__summary">{groups.length} 个项目<span>·</span>{total} 项任务
          {independentTasks.length > 0 && <><span>·</span>{currentIndependent.length} 个独立会话</>}</p>
      </div>
      {(groups.length > 0 || independentTasks.length > 0) && <label className="work-projects__search ui-input-shell">
        <Icon name="search" size={16} />
        <input ref={searchRef} className="ui-input-field" type="search" aria-label="搜索项目或任务"
          placeholder="搜索项目或任务" value={search} onChange={event => { setSearch(event.target.value); setSearchCollection(null); setMobileDetail(previous => onlyIndependent && previous) }}
          onKeyDown={event => {
            if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); clearSearch() }
          }} />
        {search && <button type="button" className="work-projects__clear" aria-label="清除搜索" onClick={clearSearch}>
          <Icon name="close" size={14} />
        </button>}
      </label>}
    </header>
    {groups.length > 0 || independentTasks.length > 0 ? <div className="work-projects__body">
      <nav className="work-projects__navigation" aria-label="浏览项目">
        <div className="work-projects__navigation-toolbar">
          <div className="work-projects__filters" role="group" aria-label="项目筛选">
            <button ref={allProjectsRef} type="button" aria-label="全部项目" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
            <button type="button" aria-label="仅看置顶" title="只显示置顶项目，与左侧的置顶会话相互独立" aria-pressed={filter === 'pinned'} onClick={() => setFilter('pinned')}>仅看置顶</button>
            <button type="button" aria-label="已归档" aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>已归档</button>
          </div>
          <Select ariaLabel="项目排序" title="项目排序" value={preferences.sort}
            options={[{ value: 'recent', label: '最近更新' }, { value: 'name', label: '名称排序' }]}
            onChange={value => persist({ sort: value === 'name' ? 'name' : 'recent' })} width={160}
            className="work-projects__sort" align="end" />
        </div>
        {filtered.length ? <WorkProjectNavigator items={navigation} selectedPath={showIndependent ? null : selected?.path ?? null}
          onSelect={selectProject} onOpen={path => { selectProject(path); setMobileDetail(true) }} onMenu={openMenu} focusRequest={focusRequest} />
          : <div className="work-projects__navigation-empty" role="status">
            <Icon name={query ? 'search' : 'pin'} size={24} />
            <strong>{query ? '没有匹配的项目或任务' : filter === 'archived' ? '没有已归档项目' : filter === 'pinned' ? '还没有置顶项目' : '暂无活动项目'}</strong>
            <p>{query ? '试试其他名称、路径或关键词。' : filter === 'archived' ? '归档的项目会保留在这里，随时可以恢复。'
              : filter === 'pinned' ? '返回“全部”，右键项目并选择“置顶项目”。' : '可在“已归档”中查看和恢复项目。'}</p>
          </div>}
        <div className="work-projects__navigation-footer" role="status">{query ? `找到 ${filtered.length} 个项目` : `${filtered.length} 个项目`}</div>
        {independentTasks.length > 0 && <div className="work-projects__standalone-section">
          <button ref={independentRef} type="button" className="work-projects__standalone" aria-label="独立会话"
            aria-pressed={showIndependent} onClick={() => { setSearchCollection('independent'); persist({ selectedCollection: 'independent' }); setMobileDetail(true) }}>
            <Icon name="chat" size={20} />
            <span className="work-projects__standalone-copy"><strong>独立会话</strong>
              <span>{query ? `${independentMatches.length} 个匹配会话` : independentActivity || '未归属项目的会话'}</span>
            </span>
            <span className="work-projects__standalone-count">{currentIndependent.length}</span>
          </button>
        </div>}
      </nav>
      {showIndependent ? <IndependentDetail tasks={independentMatches}
        total={scopedIndependent.length} archivedCount={archivedIndependent} ready={ready} query={query} scope={independentScope}
        onScope={setIndependentScope} controller={controller} onOpenTask={onOpenTask} showDetail={mobileDetail}
        onBack={() => { setMobileDetail(false); requestAnimationFrame(() => independentRef.current?.focus()) }} />
        : selected ? <ProjectDetail key={`${selected.path}:${query}`} group={selected} ready={ready} query={query} showDetail={mobileDetail}
        controller={controller} onOpenTask={onOpenTask} onPin={() => togglePin()} onMenu={anchor => {
          const rect = anchor.getBoundingClientRect(); openMenu(selected.path, anchor, { x: rect.right, y: rect.bottom + 4 })
        }} onBack={() => { setMobileDetail(false); setFocusRequest(value => value + 1) }} />
        : <div className="work-projects__detail-empty">
          <Icon name="folder-outline" size={32} /><p>{query ? '没有找到匹配的内容' : '选择一个项目，查看相关任务'}</p>
        </div>}
    </div> : <div className="work-projects__empty">
      <Icon name="folder-outline" size={32} /><h2>将相关工作放在一起</h2>
      <p>开始任务时选择工作目录，同一目录的任务会自动归集到这里。</p>
    </div>}
    {menu && menuProject && <ContextMenu key={menu.id} x={menu.x} y={menu.y} anchor={menu.anchor} items={menuItems}
      onClose={() => setMenu(current => current?.id === menu.id ? null : current)} />}
    {renaming && <PromptDialog title="修改项目显示名称" label="项目名称" initialValue={renaming.name} confirmLabel="保存"
      validate={value => !value ? '项目名称不能为空' : value.length > 80 ? '项目名称不能超过 80 个字符' : null}
      onConfirm={value => {
        if (!mounted.current || source !== getEngineStorageKey()) throw new Error('项目连接已变化，请重新操作。')
        persist({ names: { ...preferences.names, [renaming.path]: value } })
      }} onClose={() => setRenaming(null)} />}
  </section>
}

function ProjectDetail({ group, ready, controller, query, showDetail, onOpenTask, onPin, onMenu, onBack }: {
  group: ProjectGroup; ready: boolean; query: string; showDetail: boolean; onOpenTask: (id: string) => void; onPin: () => void
  onMenu: (anchor: HTMLButtonElement) => void; onBack: () => void; controller: WorkTaskActionController
}): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    // In a narrow window the navigator becomes hidden; move keyboard focus into the visible pane.
    if (showDetail && backRef.current?.getClientRects().length) backRef.current.focus()
  }, [showDetail])
  return <section className="work-project-detail" data-project-path={group.path} aria-label={`${group.name}的任务`}>
    <header className="work-project-detail__header">
      <button ref={backRef} type="button" className="work-project-detail__back" onClick={onBack}><Icon name="chevron-left" size={16} />返回项目</button>
      <div className="work-project-detail__identity">
        <span className="work-project-detail__icon"><Icon name="folder-outline" size={24} /></span>
        <div><h2>{group.name}</h2><p title={group.path}>{group.path}</p></div>
        <button type="button" className="work-project-detail__pin" aria-label={group.pinned ? '取消置顶项目' : '置顶项目'}
          title={group.pinned ? '取消置顶项目' : '置顶项目'} aria-pressed={group.pinned} onClick={onPin}>
          <Icon name="pin" size={16} />
        </button>
        <button type="button" className="work-project-detail__pin" aria-label="项目操作" title="项目操作" aria-haspopup="menu"
          onClick={event => onMenu(event.currentTarget)}><Icon name="dots-horizontal" size={16} /></button>
      </div>
      <div className="work-project-detail__metadata">
        <span>{query ? `${group.matches.length} 项匹配任务` : `${group.tasks.length} 项任务`}</span>
        {group.archived && <span>已归档</span>}
        <span>最近更新 {dateFormatter.format(group.updatedAt)}</span>
      </div>
    </header>
    <TaskCollectionRows tasks={group.matches} ready={ready} controller={controller} onOpenTask={onOpenTask} />
  </section>
}

function IndependentDetail({ tasks, total, archivedCount, ready, controller, query, scope, onScope, showDetail, onBack, onOpenTask }: {
  tasks: WorkTask[]; total: number; archivedCount: number; ready: boolean; controller: WorkTaskActionController; query: string
  scope: 'current' | 'archived'; onScope: (scope: 'current' | 'archived') => void; showDetail: boolean
  onBack: () => void; onOpenTask: (id: string) => void
}): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (showDetail && backRef.current?.getClientRects().length) backRef.current.focus()
  }, [showDetail])
  return <section className="work-project-detail work-independent-detail" data-independent-sessions="true" aria-label="独立会话">
    <header className="work-project-detail__header">
      <button ref={backRef} type="button" className="work-project-detail__back" onClick={onBack}>
        <Icon name="chevron-left" size={16} />返回项目
      </button>
      <div className="work-project-detail__identity">
        <span className="work-project-detail__icon"><Icon name="chat" size={24} /></span>
        <div><h2>独立会话</h2><p>未归属项目的会话</p></div>
        <Select ariaLabel="独立会话范围" value={scope} options={[{ value: 'current', label: '当前会话' }, { value: 'archived', label: '已归档会话' }]}
          onChange={value => onScope(value === 'archived' ? 'archived' : 'current')} width={160} align="end" className="work-independent-detail__scope" />
      </div>
      <div className="work-project-detail__metadata">
        <span>{query ? `${tasks.length} 个匹配会话` : `${total} 个会话`}</span>
        <span>{scope === 'archived' ? '已归档' : '活动会话优先'}</span>
      </div>
    </header>
    <TaskCollectionRows key={`${scope}:${query}`} tasks={tasks} ready={ready} controller={controller} onOpenTask={onOpenTask}
      empty={query ? '没有匹配的独立会话' : scope === 'archived' ? '没有已归档会话'
        : archivedCount ? '当前没有会话，可切换到“已归档会话”查看。' : '暂无独立会话'} />
  </section>
}

function TaskCollectionRows({ tasks, ready, controller, onOpenTask, empty }: {
  tasks: WorkTask[]; ready: boolean; controller: WorkTaskActionController; onOpenTask: (id: string) => void; empty?: string
}): JSX.Element {
  const [count, setCount] = useState(WORK_TASK_PAGE_SIZE)
  const listRef = useRef<HTMLUListElement>(null)
  const pendingFocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    listRef.current?.querySelectorAll<HTMLButtonElement>('.work-project-task')[pendingFocus.current]?.focus()
    pendingFocus.current = null
  }, [count])
  return <>
    <div className="work-project-detail__columns" aria-hidden="true"><span>会话</span><span>状态</span><span>更新时间</span></div>
    <div className="work-projects__task-scroll">
      <ul ref={listRef} className="work-project-detail__tasks">
        {tasks.slice(0, count).map(task => <li key={task.id}><ProjectTask task={task} ready={ready} controller={controller} onOpen={onOpenTask} /></li>)}
      </ul>
      {!tasks.length && empty && <p className="work-independent-detail__empty" role="status">{empty}</p>}
      {tasks.length > count && <button type="button" className="work-project-detail__more"
        onClick={event => { if (event.detail === 0) pendingFocus.current = count; setCount(value => value + WORK_TASK_PAGE_SIZE) }}>
        显示更多任务（{count} / {tasks.length}）<Icon name="chevron-down" size={14} />
      </button>}
    </div>
  </>
}

function ProjectTask({ task, ready, controller, onOpen }: {
  task: WorkTask; ready: boolean; controller: WorkTaskActionController; onOpen: (id: string) => void
}): JSX.Element {
  const date = new Date(task.updatedAt)
  const { items, dialogs } = useWorkTaskActions(task, controller)
  const [menu, setMenu] = useState<{ id: number; x: number; y: number; anchor: HTMLElement; closing?: boolean } | null>(null)
  const menuSequence = useRef(0)
  const detail = useHoverDetail({ enabled: !menu, label: '任务详情', content: <div className="work-project-task-detail">
    <strong>{task.title}</strong><div><WorkTaskStatus task={task} ready={ready} /><span>更新于 {fullDateFormatter.format(date)}</span></div>
  </div> })
  return <>
    <div className="work-project-task-row" data-menu-open={Boolean(menu) || undefined}
      onContextMenu={event => {
        if (!event.currentTarget.contains(event.target as Node)) return
        event.preventDefault(); event.stopPropagation()
        const anchor = event.currentTarget.querySelector<HTMLButtonElement>('.work-project-task')!
        setMenu({ id: ++menuSequence.current, x: event.clientX, y: event.clientY, anchor })
      }}
      onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node)) return
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault(); event.stopPropagation()
        const anchor = event.target instanceof HTMLButtonElement ? event.target : detail.triggerProps.ref.current
        if (!anchor) return
        const rect = anchor.getBoundingClientRect()
        setMenu({ id: ++menuSequence.current, x: rect.left, y: rect.bottom + 4, anchor })
      }}>
      <button {...detail.triggerProps} type="button" className="work-project-task" data-task-id={task.id}
        aria-label={`打开任务：${task.title}`} aria-haspopup="menu" aria-expanded={Boolean(menu && !menu.closing)} aria-keyshortcuts="Shift+F10"
        onClick={() => onOpen(task.id)}>
        <span className="work-project-task__title">{task.title}</span><WorkTaskStatus task={task} ready={ready} />
        <time dateTime={date.toISOString()}>{dateFormatter.format(date)}</time>
      </button>
      <button type="button" className="work-project-task__menu" title="会话菜单" aria-label={`${task.title}的会话菜单`}
        aria-haspopup="menu" aria-expanded={Boolean(menu && !menu.closing)} onClick={event => {
          if (menu && !menu.closing) { setMenu(null); return }
          const anchor = event.currentTarget, rect = anchor.getBoundingClientRect()
          setMenu({ id: ++menuSequence.current, x: rect.right, y: rect.bottom + 4, anchor })
        }}><Icon name="dots-horizontal" size={16} /></button>
    </div>
    {menu && <ContextMenu key={menu.id} x={menu.x} y={menu.y} anchor={menu.anchor} items={items}
      onDismiss={() => setMenu(current => current?.id === menu.id ? { ...current, closing: true } : current)}
      onClose={() => setMenu(current => current?.id === menu.id ? null : current)} />}
    {detail.tooltip}
    {dialogs}
  </>
}
