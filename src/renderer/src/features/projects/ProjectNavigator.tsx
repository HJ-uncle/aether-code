import { useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/ui/icons'

export interface ProjectNavigationItem {
  path: string
  name: string
  taskCount: number
  updatedAt: number
  pinned: boolean
}

const ROW_HEIGHT = 64
const VIRTUAL_THRESHOLD = 100
const OVERSCAN = 5

function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (separator < 0) return path
  if (separator === 0 || separator === 2 && /^[a-z]:/i.test(trimmed)) return trimmed.slice(0, separator + 1)
  return trimmed.slice(0, separator)
}

export function ProjectNavigator({ items, selectedPath, onSelect, onOpen, onMenu, focusRequest }: {
  items: ProjectNavigationItem[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpen: (path: string) => void
  onMenu: (path: string, anchor: HTMLButtonElement, position: { x: number; y: number }) => void
  focusRequest: number
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<string | null>(null)
  const previousFocusRequest = useRef(focusRequest)
  const previousSelection = useRef<string | null>(null)
  const previousIndex = useRef(-1)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const virtual = items.length > VIRTUAL_THRESHOLD
  const selectedIndex = items.findIndex(item => item.path === selectedPath)
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0
  const maxTop = Math.max(0, items.length * ROW_HEIGHT - viewport.height)
  const top = Math.min(viewport.top, maxTop)
  const start = virtual ? Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN) : 0
  const end = virtual ? Math.min(items.length, Math.ceil((top + viewport.height) / ROW_HEIGHT) + OVERSCAN) : items.length
  const indexes = Array.from({ length: end - start }, (_, offset) => start + offset)
  // Retaining the roving tab stop keeps the list keyboard-accessible after a
  // pointer scroll moves the selected project beyond the rendered window.
  if (virtual && items.length && (activeIndex < start || activeIndex >= end)) indexes.push(activeIndex)
  indexes.sort((a, b) => a - b)

  const reveal = (index: number, focus: boolean): void => {
    const element = scrollRef.current
    const item = items[index]
    if (!element || !item) return
    if (focus) pendingFocus.current = item.path
    const height = element.clientHeight
    if (!height) return
    const rowTop = index * ROW_HEIGHT
    const nextTop = rowTop < element.scrollTop ? rowTop
      : rowTop + ROW_HEIGHT > element.scrollTop + height ? rowTop + ROW_HEIGHT - height : element.scrollTop
    element.scrollTop = Math.max(0, Math.min(nextTop, items.length * ROW_HEIGHT - height))
    setViewport(previous => previous.top === element.scrollTop && previous.height === height
      ? previous : { top: element.scrollTop, height })
    const row = rowRefs.current.get(item.path)
    if (focus && row?.getClientRects().length) {
      row.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void => {
      if (!element.clientHeight) return
      setViewport(previous => previous.top === element.scrollTop && previous.height === element.clientHeight
        ? previous : { top: element.scrollTop, height: element.clientHeight })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const height = element.clientHeight || viewport.height
    const nextTop = Math.max(0, Math.min(element.scrollTop, items.length * ROW_HEIGHT - height))
    if (element.scrollTop !== nextTop) element.scrollTop = nextTop
    setViewport(previous => previous.top === nextTop && previous.height === height ? previous : { top: nextTop, height })
    if ((previousSelection.current !== selectedPath || previousIndex.current !== selectedIndex) && selectedIndex >= 0) reveal(selectedIndex, false)
    previousSelection.current = selectedPath
    previousIndex.current = selectedIndex
    if (previousFocusRequest.current !== focusRequest) {
      previousFocusRequest.current = focusRequest
      reveal(activeIndex, true)
    }
  }, [items, selectedPath, focusRequest])

  useLayoutEffect(() => {
    const path = pendingFocus.current
    if (!path) return
    if (!items.some(item => item.path === path)) { pendingFocus.current = null; return }
    const row = rowRefs.current.get(path)
    if (row?.getClientRects().length) {
      row.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  })

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.work-project-nav-item') : null
      if (row?.dataset.projectPath) {
        event.preventDefault(); event.stopPropagation()
        const rect = row.getBoundingClientRect()
        onMenu(row.dataset.projectPath, row, { x: rect.left + 12, y: rect.bottom })
      }
      return
    }
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || !items.length) return
    const path = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-project-path]')?.dataset.projectPath : null
    const focusedIndex = path ? items.findIndex(item => item.path === path) : activeIndex
    const current = focusedIndex >= 0 ? focusedIndex : activeIndex
    const index = event.key === 'ArrowUp' ? Math.max(0, current - 1)
      : event.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (index === null) return
    event.preventDefault()
    event.stopPropagation()
    onSelect(items[index].path)
    reveal(index, true)
  }

  return <div ref={scrollRef} className="work-projects__navigation-list" role="listbox" aria-label="项目列表"
    onKeyDown={navigate} onScroll={event => {
      const element = event.currentTarget
      setViewport(previous => previous.top === element.scrollTop ? previous : { ...previous, top: element.scrollTop })
    }}>
    <div className="work-projects__navigation-items" role="presentation" data-virtualized={virtual || undefined}
      style={virtual ? { position: 'relative', height: items.length * ROW_HEIGHT } : undefined}>
      {indexes.map(index => {
        const item = items[index]
        return <button key={item.path} ref={node => { if (node) rowRefs.current.set(item.path, node); else rowRefs.current.delete(item.path) }}
          type="button" role="option" className="work-project-nav-item" data-project-path={item.path}
          aria-selected={item.path === selectedPath} aria-setsize={items.length} aria-posinset={index + 1}
          aria-haspopup="menu" aria-keyshortcuts="Shift+F10"
          aria-label={`${item.name}，${item.taskCount} 项任务${item.pinned ? '，已置顶' : ''}，${item.path}`}
          tabIndex={index === activeIndex ? 0 : -1} title={item.path}
          style={virtual ? { position: 'absolute', top: index * ROW_HEIGHT, width: '100%' } : undefined}
          onClick={() => onOpen(item.path)} onContextMenu={event => {
            event.preventDefault(); event.stopPropagation()
            onMenu(item.path, event.currentTarget, { x: event.clientX, y: event.clientY })
          }}>
          <Icon name="folder-outline" size={20} />
          <span className="work-project-nav-item__copy"><span className="work-project-nav-item__name">{item.name}</span>
            <span className="work-project-nav-item__path">{parentPath(item.path)}</span></span>
          {item.pinned && <Icon name="pin" size={12} className="work-project-nav-item__pin" />}
          <span className="work-project-nav-item__count" aria-hidden="true">{item.taskCount}</span>
        </button>
      })}
    </div>
  </div>
}
