import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { onFileTreeMemoryChanged, readFileTreeMemory, writeFileTreeMemory, type FileTreeMemory, type FileTreeScope } from '@renderer/core/workspace/file-tree-memory'

interface MemoryState { key: string | undefined; memory: FileTreeMemory }
function reconcileMemory(previous: MemoryState, key: string, next: FileTreeMemory): MemoryState {
  if (previous.key !== key) return { key, memory: next }
  const samePaths = (left: string[], right: string[]): boolean => left.length === right.length && left.every((path, index) => path === right[index])
  // Scrolling must not rebuild a large flattened tree. Preserve structural
  // references when only the viewport or cursor changed.
  const memory = { ...next,
    expanded: samePaths(previous.memory.expanded, next.expanded) ? previous.memory.expanded : next.expanded,
    selection: samePaths(previous.memory.selection, next.selection) ? previous.memory.selection : next.selection }
  return (Object.keys(memory) as (keyof FileTreeMemory)[]).every(field => previous.memory[field] === memory[field]) ? previous : { key, memory }
}

export function useFileTreeMemory(scope: FileTreeScope | null): {
  memory: FileTreeMemory
  updateMemory: (patch: Partial<FileTreeMemory>) => void
} {
  const initial = useMemo<FileTreeMemory>(() => scope ? readFileTreeMemory(scope) : {
    expanded: [], selection: [], cursorPath: null, activeFilePath: null, scrollTop: 0, scrollLeft: 0, filter: ''
  }, [scope?.key, scope?.root])
  const [state, setState] = useState({ key: scope?.key, memory: initial })
  const memory = state.key === scope?.key ? state.memory : initial
  useLayoutEffect(() => {
    if (!scope) return
    const sync = (key: string): void => {
      if (key !== scope.key) return
      const next = readFileTreeMemory(scope)
      setState(previous => reconcileMemory(previous, key, next))
    }
    sync(scope.key)
    return onFileTreeMemoryChanged(sync)
  }, [scope?.key, scope?.root])
  const updateMemory = useCallback((patch: Partial<FileTreeMemory>) => {
    if (!scope) return
    const next = writeFileTreeMemory(scope, patch)
    setState(previous => reconcileMemory(previous, scope.key, next))
  }, [scope?.key, scope?.root])
  return { memory, updateMemory }
}

/** Restore after rows have loaded and the pane has dimensions. A hidden pane
 * reports zero height/scroll and must not overwrite the last visible position. */
export function useFileTreeViewport({ scopeKey, treeRef, memory, updateMemory, ready, rowCount }: {
  scopeKey: string | undefined
  treeRef: RefObject<HTMLDivElement | null>
  memory: FileTreeMemory
  updateMemory: (patch: Partial<FileTreeMemory>) => void
  ready: boolean
  rowCount: number
}): { viewportHeight: number; scrollTop: number; onScroll: (top: number) => void } {
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scroll, setScroll] = useState({ key: scopeKey, top: memory.scrollTop })
  const restore = useRef<{ key: string | undefined; pending: boolean }>({ key: undefined, pending: true })
  const memoryRef = useRef(memory)
  useLayoutEffect(() => { memoryRef.current = memory }, [memory])
  useLayoutEffect(() => {
    const element = treeRef.current
    if (!element) return
    if (restore.current.key !== scopeKey) restore.current = { key: scopeKey, pending: true }
    if (!ready) restore.current.pending = true
    const measure = (): void => {
      if (!element.clientHeight) { restore.current.pending = true; return }
      setViewportHeight(element.clientHeight)
      if (!ready) return
      if (restore.current.pending) {
        element.scrollTop = memoryRef.current.scrollTop
        element.scrollLeft = memoryRef.current.scrollLeft
        restore.current.pending = false
      }
      setScroll(previous => previous.key === scopeKey && previous.top === element.scrollTop ? previous : { key: scopeKey, top: element.scrollTop })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scopeKey, ready, rowCount, treeRef])
  const onScroll = useCallback((top: number) => {
    const element = treeRef.current
    if (!ready || !element?.clientHeight || restore.current.pending || restore.current.key !== scopeKey) return
    setScroll(previous => previous.key === scopeKey && previous.top === top ? previous : { key: scopeKey, top })
    updateMemory({ scrollTop: top, scrollLeft: element.scrollLeft })
  }, [ready, scopeKey, treeRef, updateMemory])
  return { viewportHeight, scrollTop: scroll.key === scopeKey ? scroll.top : memory.scrollTop, onScroll }
}
