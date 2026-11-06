import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX, type Key, type ReactNode } from 'react'
import './git-virtual-list.css'

export const GIT_VIRTUAL_LIST_THRESHOLD = 100

export interface GitVirtualListProps<T> {
  items: readonly T[]
  itemKey: (item: T, index: number) => Key
  itemHeight: number | ((item: T, index: number) => number)
  renderItem: (item: T, index: number) => ReactNode
  className?: string
  /** All Git sections share the panel's scrolling element. */
  scrollParentSelector?: string
  overscan?: number
  threshold?: number
  /** Expanded rows with component-local state can stay alive outside the viewport. */
  retainedKeys?: ReadonlySet<Key>
}

interface PositionedItem<T> {
  item: T
  key: Key
  index: number
  top: number
  height: number
}

function scrollParentOf(element: HTMLElement, selector: string): HTMLElement | null {
  const selected = element.parentElement?.closest<HTMLElement>(selector)
  if (selected) return selected
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

/** First row whose bottom is below the requested coordinate. */
function firstVisible<T>(rows: readonly PositionedItem<T>[], coordinate: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const row = rows[middle]
    if (row.top + row.height <= coordinate) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Windowing stays in the existing panel scroll flow, as in Wuzu's page-mode
 * lists. Measured heights also accommodate Aether's expandable hunk rows.
 */
export function GitVirtualList<T>({
  items,
  itemKey,
  itemHeight,
  renderItem,
  className = '',
  scrollParentSelector = '.git-panel__content',
  overscan = 200,
  threshold = GIT_VIRTUAL_LIST_THRESHOLD,
  retainedKeys
}: GitVirtualListProps<T>): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const previousRetainedKeys = useRef<ReadonlySet<Key>>(new Set())
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [heights, setHeights] = useState<ReadonlyMap<Key, number>>(() => new Map())
  const [measurementVersion, setMeasurementVersion] = useState(0)
  const [focusedKey, setFocusedKey] = useState<Key | null>(null)
  const virtual = items.length > threshold
  const onMeasure = useCallback((key: Key, height: number): void => {
    if (height <= 0) return
    setHeights(previous => {
      if (Math.abs((previous.get(key) ?? 0) - height) < 0.5) return previous
      const next = new Map(previous)
      next.set(key, height)
      return next
    })
  }, [])

  const { rows, rowsByKey, totalHeight } = useMemo(() => {
    let top = 0
    const rows = items.map((item, index): PositionedItem<T> => {
      const key = itemKey(item, index)
      const estimate = typeof itemHeight === 'number' ? itemHeight : itemHeight(item, index)
      const height = heights.get(key) ?? Math.max(1, estimate)
      const row = { item, key, index, top, height }
      top += height
      return row
    })
    return { rows, rowsByKey: new Map(rows.map(row => [row.key, row])), totalHeight: top }
  }, [items, itemKey, itemHeight, heights])

  useLayoutEffect(() => {
    const liveKeys = new Set(items.map(itemKey))
    setHeights(previous => {
      if ([...previous.keys()].every(key => liveKeys.has(key))) return previous
      return new Map([...previous].filter(([key]) => liveKeys.has(key)))
    })
  }, [items, itemKey])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !virtual) return
    const parent = scrollParentOf(root, scrollParentSelector)
    if (!parent) return
    let frame = 0
    let width = root.getBoundingClientRect().width
    const measure = (): void => {
      frame = 0
      const bounds = root.getBoundingClientRect()
      const parentBounds = parent.getBoundingClientRect()
      const top = parentBounds.top + parent.clientTop - bounds.top
      const height = parent.clientHeight
      setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height })
      if (Math.abs(width - bounds.width) >= 0.5) {
        width = bounds.width
        // Rows outside the window must not retain measurements from a wider pane.
        setHeights(new Map())
        setMeasurementVersion(previous => previous + 1)
      }
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    resize.observe(parent)
    // Expanding a preceding section moves this list without resizing it.
    for (let node = root.parentElement; node && node !== parent; node = node.parentElement) {
      resize.observe(node)
      for (const sibling of node.children) resize.observe(sibling)
    }
    parent.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      parent.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [virtual, scrollParentSelector])

  const start = virtual ? firstVisible(rows, viewport.top - overscan) : 0
  const endCoordinate = viewport.top + viewport.height + overscan
  const end = virtual ? Math.min(rows.length, firstVisible(rows, endCoordinate) + 1) : rows.length
  const visibleRows = rows.slice(start, end)
  if (virtual) {
    const retained = new Set(retainedKeys)
    if (focusedKey !== null) retained.add(focusedKey)
    for (const key of retained) {
      const row = rowsByKey.get(key)
      if (row && (row.index < start || row.index >= end)) visibleRows.push(row)
    }
    visibleRows.sort((a, b) => a.index - b.index)
  }
  useLayoutEffect(() => {
    const mounted = new Set(visibleRows.map(row => row.key))
    const collapsed = [...previousRetainedKeys.current].filter(key => !retainedKeys?.has(key) && !mounted.has(key))
    previousRetainedKeys.current = retainedKeys ?? new Set()
    if (!collapsed.length) return
    // An offscreen expanded row can collapse when another commit is opened.
    // There is no DOM measurement for it until it returns to the viewport.
    setHeights(previous => {
      if (!collapsed.some(key => previous.has(key))) return previous
      const next = new Map(previous)
      for (const key of collapsed) next.delete(key)
      return next
    })
  }, [retainedKeys, visibleRows])

  return (
    <div ref={rootRef} className={`git-virtual-list${virtual ? ' is-virtual' : ''} ${className}`.trim()}
      style={virtual ? { height: totalHeight } : undefined} data-virtualized={virtual || undefined}>
      {visibleRows.map(row => (
        <MeasuredRow key={row.key} rowKey={row.key} top={virtual ? row.top : undefined}
          onMeasure={onMeasure} onFocus={setFocusedKey} measurementVersion={measurementVersion}>
          {renderItem(row.item, row.index)}
        </MeasuredRow>
      ))}
    </div>
  )
}

function MeasuredRow({ rowKey, top, onMeasure, onFocus, measurementVersion, children }: {
  rowKey: Key
  top?: number
  onMeasure: (key: Key, height: number) => void
  onFocus: (key: Key | null) => void
  measurementVersion: number
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => onMeasure(rowKey, element.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [rowKey, onMeasure, measurementVersion])
  return (
    <div ref={ref} className="git-virtual-list__item" style={top === undefined ? undefined : { position: 'absolute', top }}
      onFocusCapture={() => onFocus(rowKey)} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocus(null)
      }}>
      {children}
    </div>
  )
}
