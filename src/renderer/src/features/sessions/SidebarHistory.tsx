import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { SidebarTask } from './SidebarTask'
import { sortSessionSidebarTasks } from './sidebar-task'
import type { SessionTask } from './state'
import type { SessionTaskActionController } from './useSessionTaskActions'
import './sidebar-history.css'

const PAGE_SIZE = 20
const scopes = ['recent', 'archived'] as const
type Scope = typeof scopes[number]

export function SidebarHistory({ tasks, controller, selectedTaskId, visible, onOpen }: {
  tasks: readonly SessionTask[]
  controller: SessionTaskActionController
  selectedTaskId: string | null
  visible: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const lists = useMemo(() => ({
    recent: sortSessionSidebarTasks(tasks.filter(task => !task.archived)),
    archived: sortSessionSidebarTasks(tasks.filter(task => task.archived))
  }), [tasks])
  const [scope, setScope] = useState<Scope>('recent')
  const [limits, setLimits] = useState({ recent: PAGE_SIZE, archived: PAGE_SIZE })
  const positions = useRef({ recent: 0, archived: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const tabs = useRef<Partial<Record<Scope, HTMLButtonElement | null>>>({})
  const selection = useRef<string | null>(null)
  const reveal = useRef<string | null>(null)
  const panelId = useId()
  const items = lists[scope]
  const limit = limits[scope]
  const hasMore = items.length > limit

  useLayoutEffect(() => {
    if (!selectedTaskId) { selection.current = null; reveal.current = null; return }
    const nextScope = lists.archived.some(task => task.id === selectedTaskId) ? 'archived' : 'recent'
    const index = lists[nextScope].findIndex(task => task.id === selectedTaskId)
    if (index < 0) return
    if (selection.current !== selectedTaskId) {
      selection.current = selectedTaskId
      reveal.current = selectedTaskId
      if (scrollRef.current) positions.current[scope] = scrollRef.current.scrollTop
      setScope(nextScope)
    } else if (nextScope !== scope) return
    // Unpinning can move the selected task beyond the loaded page. Keep it
    // mounted without following background updates or changing the active tab.
    setLimits(previous => {
      const required = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
      return previous[nextScope] >= required ? previous : { ...previous, [nextScope]: required }
    })
    // Only an explicit task change follows selection. Live status updates and
    // manually browsing the other tab must leave the reading position alone.
  }, [selectedTaskId, lists, scope])

  useLayoutEffect(() => {
    if (visible && scrollRef.current) scrollRef.current.scrollTop = positions.current[scope]
  }, [scope, visible])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!visible || !root || !reveal.current || !root.clientHeight) return
    const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(reveal.current)}"]`)
    if (!row) return
    const bounds = root.getBoundingClientRect(), target = row.getBoundingClientRect()
    if (target.top < bounds.top) root.scrollTop -= bounds.top - target.top
    else if (target.bottom > bounds.bottom) root.scrollTop += target.bottom - bounds.bottom
    positions.current[scope] = root.scrollTop
    reveal.current = null
  }, [scope, limit, visible, selectedTaskId, lists])

  useEffect(() => {
    const root = scrollRef.current, end = endRef.current
    if (!visible || !hasMore || !root || !end) return
    let current = true
    const observer = new IntersectionObserver(entries => {
      if (!current || !root.clientHeight || !entries.some(entry => entry.isIntersecting)) return
      setLimits(previous => ({ ...previous, [scope]: Math.min(items.length, previous[scope] + PAGE_SIZE) }))
    }, { root, rootMargin: '0px 0px 48px 0px' })
    observer.observe(end)
    return () => { current = false; observer.disconnect() }
  }, [scope, limit, items.length, hasMore, visible])

  const selectScope = (next: Scope): void => {
    if (next === scope) return
    if (scrollRef.current) positions.current[scope] = scrollRef.current.scrollTop
    reveal.current = null
    setScope(next)
  }

  return <section className="work-sidebar__history" aria-label="会话历史">
    <div className="work-sidebar__history-tabs" role="tablist" aria-label="任务列表">
      {scopes.map(value => <button key={value} ref={element => { tabs.current[value] = element }} type="button"
        className="work-sidebar__history-tab" role="tab"
        aria-selected={scope === value} aria-controls={panelId} tabIndex={scope === value ? 0 : -1}
        onClick={() => selectScope(value)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'recent' : event.key === 'End' ? 'archived' : value === 'recent' ? 'archived' : 'recent'
          selectScope(next)
          tabs.current[next]?.focus()
        }}>{value === 'recent' ? '最近' : '归档'}</button>)}
    </div>
    <div key={scope} id={panelId} ref={scrollRef} className="work-sidebar__recent" role="tabpanel"
      aria-label={scope === 'recent' ? '最近任务' : '归档任务'} tabIndex={0}
      onScroll={event => { positions.current[scope] = event.currentTarget.scrollTop }}>
      {items.slice(0, limit).map(task => <SidebarTask key={task.id} task={task} controller={controller}
        selected={task.id === selectedTaskId} onOpen={onOpen} />)}
      {!items.length ? <p>{scope === 'recent' ? '开始后，任务会保存在这里。' : '暂无归档任务。'}</p> : null}
      {hasMore ? <div className="work-sidebar__history-sentinel" ref={endRef} aria-hidden="true" />
        : items.length > PAGE_SIZE ? <p className="work-sidebar__history-end">已显示全部</p> : null}
    </div>
  </section>
}
