import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MOTION_REDUCED_QUERY } from '../../workbench/motion'
import { fileTreePathKey } from '../../core/workspace/file-tree-memory'
import type { FileTreeRowModel } from './FileTreeView'

export const FILE_TREE_MOTION_MS = 120
export interface FileTreeMotionRow {
  path: string; directory: boolean; expanded: boolean; index: number
}
interface TreeFrame {
  scope: string; filter: string; scrollTop: number
  visible: FileTreeMotionRow[]
  directories: Map<string, boolean>
}
interface TreeMotion { scope: string; filter: string; scrollTop: number; settling: Set<string> }

/** Animate real mounted rows only. Repainting removed descendants over their
 * successors creates two layers of text as soon as the virtual list closes. */
export function fileTreeSettlingPaths(after: readonly FileTreeMotionRow[], closed: readonly string[]): Set<string> {
  const closedKeys = new Set(closed.map(fileTreePathKey))
  const boundary = after.find(row => closedKeys.has(fileTreePathKey(row.path)))?.index
  // Newly visible siblings also move into the vacated space. Keep the shift
  // small and uniform instead of translating by a potentially huge subtree.
  return new Set(boundary === undefined ? [] : after.filter(row => row.index > boundary).map(row => row.path))
}

function reducedMotion(): boolean { return matchMedia(MOTION_REDUCED_QUERY).matches }
function subscribeReduced(listener: () => void): () => void {
  const media = matchMedia(MOTION_REDUCED_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

export function useFileTreeMotion(rows: readonly FileTreeRowModel[], start: number, end: number,
  scope: string, filter: string, scrollTop: number): TreeMotion | null {
  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion, () => true)
  const previous = useRef<TreeFrame | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [motion, setMotion] = useState<TreeMotion | null>(null)
  const frame = useMemo<TreeFrame>(() => {
    const visible = rows.slice(start, end).map((row, offset) => ({ path: row.entry.path,
      directory: row.entry.isDirectory, expanded: row.isExpanded, index: start + offset }))
    const directories = new Map(visible.filter(row => row.directory).map(row => [row.path, row.expanded]))
    // The viewport's first row may sit below an offscreen parent being collapsed.
    let depth = (rows[start]?.depth ?? 0) - 1
    for (let index = Math.min(start, rows.length) - 1; index >= 0 && depth >= 0; index--) {
      const row = rows[index]
      if (row.entry.isDirectory && row.depth === depth) { directories.set(row.entry.path, row.isExpanded); depth-- }
    }
    return { scope, filter, scrollTop, visible, directories }
  }, [rows, start, end, scope, filter, scrollTop])

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = frame
    const clear = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setMotion(null)
    }
    if (reduced || !before || before.scope !== scope || before.filter !== filter || before.scrollTop !== scrollTop) { clear(); return }
    const closed: string[] = []
    let toggled = false
    for (const row of rows) {
      if (!row.entry.isDirectory) continue
      const was = before.directories.get(row.entry.path)
      if (was === false && row.isExpanded) toggled = true
      if (was === true && !row.isExpanded) { closed.push(row.entry.path); toggled = true }
    }
    // Expanded children appear at their final row positions. Per-row entry
    // translation looks like a second movement after the branch is laid out.
    const settling = fileTreeSettlingPaths(frame.visible, closed)
    if (!settling.size) {
      if (toggled) {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
        setMotion(null)
      }
      return
    }
    if (timer.current) clearTimeout(timer.current)
    setMotion({ scope, filter, scrollTop, settling })
    timer.current = setTimeout(() => { timer.current = null; setMotion(null) }, FILE_TREE_MOTION_MS)
  }, [frame, rows, scope, filter, scrollTop, reduced])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  // A new source/root or user scroll never displays a frame from the old viewport.
  return !reduced && motion?.scope === scope && motion.filter === filter && motion.scrollTop === scrollTop ? motion : null
}
