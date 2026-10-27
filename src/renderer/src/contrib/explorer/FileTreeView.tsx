import { useMemo, type HTMLAttributes, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from 'react'
import type { FsEntry } from '@shared/ipc'
import { paths } from '@renderer/core/workspace/fs-client'
import { compileExclude, isExcluded } from '@renderer/core/workspace/exclude'
import { FileTreeRow, FILE_TREE_ROW_HEIGHT } from './FileTreeRow'
import { Spinner } from '@renderer/workbench/ui-primitives'

const OVERSCAN = 10

export interface FileTreeRowModel {
  entry: FsEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  isActive: boolean
  isSelected: boolean
  compactChain?: string
  isCut?: boolean
  isIgnored?: boolean
  gitCode?: string
  gitTitle?: string
  gitClassName?: string
  gitDirty?: boolean
  trailing?: ReactNode
}

export interface FileTreeSnapshot {
  root: string | null
  showRoot: boolean
  children: ReadonlyMap<string, FsEntry[]>
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
  activeFilePath: string | null
  selection: ReadonlySet<string>
}

export interface FileTreeDecorations {
  byPath: ReadonlyMap<string, { code: string; title: string; className?: string }>
  dirtyDirs: ReadonlySet<string>
}

export function rootFileTreeEntry(root: string): FsEntry {
  return { name: paths.basename(root), path: root, isDirectory: true, size: 0, mtimeMs: 0 }
}

/** Both modes flatten only loaded directories. Filtering never authorizes a
 * recursive filesystem scan; an explicit search owns that separate operation. */
export function buildFileTreeRows({ snapshot, filter = '', filesExclude = {}, sortMode = 'default', compactFolders = true, cutPaths = [], decorations = { byPath: new Map(), dirtyDirs: new Set() } }: {
  snapshot: FileTreeSnapshot
  filter?: string
  filesExclude?: Record<string, boolean>
  sortMode?: 'default' | 'name'
  compactFolders?: boolean
  cutPaths?: readonly string[]
  decorations?: FileTreeDecorations
}): FileTreeRowModel[] {
  const { root, showRoot, expanded, loading, selection, activeFilePath } = snapshot
  const output: FileTreeRowModel[] = []
  const excludeRules = compileExclude(filesExclude)
  const nameFilter = filter.trim().toLowerCase()
  if (root && showRoot) {
    const rootExpanded = expanded.has(root)
    output.push({ entry: rootFileTreeEntry(root), depth: 0, isExpanded: rootExpanded,
      isLoading: loading.has(root), isActive: false, isSelected: selection.has(root),
      gitDirty: !rootExpanded && decorations.dirtyDirs.has(root.replace(/\\/g, '/')) })
    if (!rootExpanded) return output
  }
  const childrenOf = (directory: string): FsEntry[] => {
    const entries = snapshot.children.get(directory) ?? []
    return sortMode === 'default' ? entries : [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  const hidden = (entry: FsEntry, parentHidden: boolean): boolean => {
    if (!excludeRules.length) return false
    return isExcluded(excludeRules, root ? paths.relative(root, entry.path) : entry.path, entry.name, parentHidden)
  }
  const compactChain = (start: FsEntry, startHidden: boolean): { entry: FsEntry; chain: string } | null => {
    if (expanded.has(start.path)) return null
    let current = start
    let chain = ''
    let parentHidden = startHidden
    for (;;) {
      const visible = childrenOf(current.path).filter(entry => !hidden(entry, parentHidden))
      if (visible.length !== 1 || !visible[0].isDirectory || expanded.has(visible[0].path)) break
      chain = chain ? `${chain}/${current.name}` : current.name
      current = visible[0]
      parentHidden ||= hidden(current, parentHidden)
    }
    return chain ? { entry: current, chain } : null
  }
  const walk = (directory: string, depth: number, parentHidden: boolean): void => {
    for (const entry of childrenOf(directory)) {
      const entryHidden = hidden(entry, parentHidden)
      if (entryHidden) continue
      if (nameFilter && !entry.name.toLowerCase().includes(nameFilter)) {
        if (entry.isDirectory) walk(entry.path, depth + 1, entryHidden)
        continue
      }
      const compact = nameFilter || !compactFolders ? null : entry.isDirectory ? compactChain(entry, entryHidden) : null
      const shown = compact?.entry ?? entry
      const isExpanded = shown.isDirectory && expanded.has(shown.path)
      const key = shown.path.replace(/\\/g, '/')
      const change = decorations.byPath.get(key)
      output.push({ entry: shown, depth, isExpanded, isLoading: loading.has(shown.path),
        isActive: !shown.isDirectory && shown.path === activeFilePath,
        isSelected: selection.has(shown.path), compactChain: compact?.chain,
        isCut: cutPaths.some(path => paths.contains(path, shown.path)), isIgnored: shown.gitignored === true,
        gitCode: change?.code, gitTitle: change?.title, gitClassName: change?.className,
        gitDirty: shown.isDirectory ? !isExpanded && decorations.dirtyDirs.has(key) : undefined })
      if (isExpanded) walk(shown.path, depth + 1, false)
    }
  }
  if (root) walk(root, showRoot ? 1 : 0, false)
  return output
}

export function gitFileTreeClass(code: string): string {
  switch (code) {
    case 'M': return 'modified'
    case 'A': case 'U': return 'added'
    case 'D': return 'deleted'
    case 'R': case 'C': return 'renamed'
    default: return 'other'
  }
}

function highlightName(name: string, filter?: string): JSX.Element | string {
  if (!filter) return name
  const index = name.toLowerCase().indexOf(filter)
  if (index < 0) return name
  return <>{name.slice(0, index)}<mark className="tree-match">{name.slice(index, index + filter.length)}</mark>{name.slice(index + filter.length)}</>
}

function TreeRow({ row, cursor, filter, dropTarget, onContextMenu, onMouseDown }: {
  row: FileTreeRowModel; cursor: boolean; filter?: string; dropTarget: boolean
  onContextMenu: (event: ReactMouseEvent, entry: FsEntry) => void
  onMouseDown: (event: ReactMouseEvent, entry: FsEntry) => void
}): JSX.Element {
  const { entry, isExpanded, isLoading, isActive, isSelected, isCut, isIgnored } = row
  const className = [isActive ? 'is-active' : '', cursor ? 'is-cursor' : '', isCut ? 'is-cut' : '', isIgnored ? 'is-ignored' : '', dropTarget ? 'is-drop-target' : ''].filter(Boolean).join(' ')
  const gitClass = row.gitClassName ?? (row.gitCode ? gitFileTreeClass(row.gitCode) : '')
  return <FileTreeRow name={entry.name} nameContent={highlightName(entry.name, filter)} path={entry.path} title={entry.path}
    depth={row.depth} isDirectory={entry.isDirectory} isExpanded={isExpanded} isSelected={isSelected} focusable={false} className={className}
    nameClassName={`${row.gitCode ? `tree-row__name--${gitClass}` : ''}${row.gitDirty ? ' tree-row__name--dirty' : ''}`.trim()}
    labelSuffix={row.compactChain ? <span className="tree-row__chain" title={row.compactChain}>{row.compactChain}</span> : undefined}
    trailing={<>
      {row.gitCode ? <span className={`tree-row__git tree-row__git--${gitClass}`} title={row.gitTitle} aria-label={row.gitTitle}>{row.gitCode}</span>
        : row.gitDirty ? <span className="tree-row__git tree-row__git--dirty" title="该目录下有改动" aria-hidden>●</span> : null}
      {row.trailing}
      {isLoading ? <span className="tree-row__loading" role="status" aria-label="加载中"><Spinner size={12} /></span> : null}
    </>} indentGuides dataDir={entry.isDirectory ? entry.path : undefined} dataParentDir={entry.isDirectory ? undefined : paths.dirname(entry.path)}
    onMouseDown={event => onMouseDown(event, entry)} onContextMenu={event => onContextMenu(event, entry)} />
}

/** The actual virtualized tree used by Code and Work. Mutations and transport
 * stay outside this component; neither workspace can acquire the other's rights. */
export function FileTreeView({ rows, treeRef, focused, viewportHeight, scrollTop, cursorPath, filter, empty, emptyText = '目录为空', onScroll, onRowContextMenu, onRowMouseDown, onStickyMouseDown, isDropTarget, multiSelect = false, ...treeProps }: {
  rows: readonly FileTreeRowModel[]
  treeRef: Ref<HTMLDivElement>
  focused: boolean
  viewportHeight: number
  scrollTop: number
  cursorPath?: string | null
  filter?: string
  empty: boolean
  emptyText?: ReactNode
  onScroll: (scrollTop: number) => void
  onRowContextMenu?: (event: ReactMouseEvent, entry: FsEntry) => void
  onRowMouseDown?: (event: ReactMouseEvent, entry: FsEntry) => void
  onStickyMouseDown?: (event: ReactMouseEvent, entry: FsEntry) => void
  isDropTarget?: (entry: FsEntry) => boolean
  multiSelect?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'ref' | 'className' | 'children' | 'onScroll'>): JSX.Element {
  const stickyChain = useMemo(() => {
    if (!rows.length || !viewportHeight) return []
    const first = Math.min(rows.length - 1, Math.floor(scrollTop / FILE_TREE_ROW_HEIGHT))
    const chain: FileTreeRowModel[] = []
    let depth = rows[first].depth - 1
    for (let index = first - 1; index >= 0 && depth >= 0; index--) {
      const row = rows[index]
      if (row.depth === depth && row.entry.isDirectory) { chain.unshift(row); depth-- }
    }
    const limit = Math.max(1, Math.floor(viewportHeight * 0.4 / FILE_TREE_ROW_HEIGHT))
    return chain.length > limit ? chain.slice(chain.length - limit) : chain
  }, [rows, viewportHeight, scrollTop])
  const start = Math.max(0, Math.floor(scrollTop / FILE_TREE_ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / FILE_TREE_ROW_HEIGHT) + OVERSCAN)
  const visible = rows.slice(start, end)
  return <div className="explorer__body">
    <div {...treeProps} className={`explorer__tree${focused ? ' is-focused' : ''}`} ref={treeRef} role="tree" aria-multiselectable={multiSelect || undefined} tabIndex={0}
      onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      <div className="explorer__rows" style={{ height: rows.length * FILE_TREE_ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * FILE_TREE_ROW_HEIGHT}px)` }}>
          {visible.map(row => <TreeRow key={row.entry.path} row={row} cursor={row.entry.path === cursorPath} filter={filter}
            dropTarget={isDropTarget?.(row.entry) ?? false}
            onContextMenu={onRowContextMenu ?? (() => {})} onMouseDown={onRowMouseDown ?? (() => {})} />)}
        </div>
      </div>
      {empty ? <div className="explorer__hint">{emptyText}</div> : null}
    </div>
    {stickyChain.length ? <div className="explorer__sticky" aria-hidden>
      {stickyChain.map(row => <TreeRow key={row.entry.path} row={row} cursor={row.entry.path === cursorPath} filter={filter}
        dropTarget={false} onContextMenu={onRowContextMenu ?? (() => {})} onMouseDown={onStickyMouseDown ?? onRowMouseDown ?? (() => {})} />)}
    </div> : null}
  </div>
}
