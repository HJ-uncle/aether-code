import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { FsEntry } from '@shared/ipc'
import { bindSessionWorkspace, captureSessionFileTarget, paths, readDir, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { captureSessionGitTarget } from '@renderer/core/git/git-target'
import { createGitClient } from '@renderer/core/git/git-client'
import { changeCode, changeCodeClass, changeTitle, normalizeGitPath } from '@renderer/core/git/git-format'
import { getEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { buildFileTreeRows, FileTreeView } from '@renderer/contrib/explorer/FileTreeView'
import './work-workspace-panel.css'

export interface WorkWorkspacePanelProps {
  sessionId?: string | null
  workspaceRoot?: string | null
  active?: boolean
  onOpenFile?: (path: string) => void
}

interface GitDecoration { code: string; className: string; title: string; additions: number; deletions: number }

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  // Work can point at a Linux remote workspace. Preserve case there; only
  // Windows drive/UNC paths use case-insensitive identity semantics.
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}


/**
 * Work 的文件树和 Code Explorer 保持同一套交互语义，但所有读取仍走
 * session-scoped workspace API。不能直接复用 ExplorerView：ExplorerView
 * 订阅的是本地 workspace-store，接入这里会把任务沙箱泄露到 Code 工作区。
 */
export function WorkWorkspacePanel({ sessionId, workspaceRoot, active = true, onOpenFile }: WorkWorkspacePanelProps): JSX.Element {
  const [target, setTarget] = useState<SessionFileTarget | null>(null)
  const [entriesByDir, setEntriesByDir] = useState<Record<string, FsEntry[]>>({})
  const entriesRef = useRef(entriesByDir)
  entriesRef.current = entriesByDir
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(new Set())
  const [nameFilterRaw, setNameFilterRaw] = useState('')
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [gitDecorations, setGitDecorations] = useState<Record<string, GitDecoration>>({})
  const [gitDirtyDirs, setGitDirtyDirs] = useState<ReadonlySet<string>>(new Set())
  const generation = useRef(0)
  const treeRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  useLayoutEffect(() => {
    const element = treeRef.current
    if (!element) return
    setViewportHeight(element.clientHeight)
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [target?.root])
  useEffect(() => {
    setScrollTop(0)
    setCursorPath(null)
    if (treeRef.current) treeRef.current.scrollTop = 0
  }, [target?.root])

  const loadDirectory = useCallback(async (nextTarget: SessionFileTarget, directory: string, requestGeneration: number): Promise<void> => {
    if (entriesRef.current[directory]) return
    setLoadingDirs(previous => new Set(previous).add(directory))
    try {
      const result = sortEntries(await readDir(directory, nextTarget))
      if (requestGeneration !== generation.current) return
      setEntriesByDir(previous => ({ ...previous, [directory]: result }))
    } catch (reason: unknown) {
      if (requestGeneration !== generation.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestGeneration === generation.current) {
        setLoadingDirs(previous => {
          const next = new Set(previous)
          next.delete(directory)
          return next
        })
      }
    }
  }, [])

  const loadGitStatus = useCallback(async (id: string, requestGeneration: number): Promise<void> => {
    try {
      const gitTarget = await captureSessionGitTarget(id, '')
      const result = await createGitClient(gitTarget).gitStatus()
      if (requestGeneration !== generation.current || !result.success) return
      if (!result.isRepo) {
        setGitDecorations({})
        setGitDirtyDirs(new Set())
        return
      }
      const next: Record<string, GitDecoration> = {}
      const dirty = new Set<string>()
      // The session binding is authoritative. workspaceRoot only recovers the
      // local path hint used before the first acknowledged engine run.
      const root = gitTarget.root
      const rootKey = pathKey(root)
      for (const change of result.files ?? []) {
        const absolute = paths.join(root, normalizeGitPath(change.path))
        next[pathKey(absolute)] = {
          code: changeCode(change), className: changeCodeClass(change), title: changeTitle(change),
          additions: change.additions ?? 0, deletions: change.deletions ?? 0
        }
        let directory = paths.dirname(absolute)
        while (pathKey(directory) !== rootKey && paths.contains(root, directory)) {
          dirty.add(pathKey(directory))
          const parent = paths.dirname(directory)
          if (parent === directory) break
          directory = parent
        }
      }
      setGitDecorations(next)
      setGitDirtyDirs(dirty)
    } catch {
      // A task may not have a repository yet. The tree remains useful and
      // Git's own tab reports repository errors with the actionable details.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const requestGeneration = ++generation.current
    setTarget(null)
    entriesRef.current = {}
    setEntriesByDir({})
    setExpanded(new Set())
    setLoadingDirs(new Set())
    setGitDecorations({})
    setGitDirtyDirs(new Set())
    setNameFilterRaw('')
    setActiveFilePath(null)
    setError('')
    if (!active || !sessionId) return () => { cancelled = true }
    const resolveTarget = async (): Promise<void> => {
      if (workspaceRoot) await bindSessionWorkspace(sessionId, workspaceRoot)
      const nextTarget = await captureSessionFileTarget(sessionId, workspaceRoot)
      if (cancelled || requestGeneration !== generation.current) return
      setTarget(nextTarget)
      setExpanded(new Set([nextTarget.root]))
      await Promise.all([loadDirectory(nextTarget, nextTarget.root, requestGeneration), loadGitStatus(sessionId, requestGeneration)])
    }
    const timer = setTimeout(() => { void resolveTarget().catch(reason => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }) }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // Invalidate in-flight directory/Git reads when the task pane is hidden
      // or replaced; late responses must not write into an unmounted scope.
      if (generation.current === requestGeneration) generation.current += 1
    }
  }, [active, sessionId, workspaceRoot, loadDirectory, loadGitStatus, getEngineSource()])

  const nameFilter = nameFilterRaw.trim().toLowerCase()
  const snapshot = useMemo(() => ({
    root: target?.root ?? null,
    showRoot: Boolean(workspaceRoot),
    children: new Map(Object.entries(entriesByDir)),
    expanded,
    loading: loadingDirs,
    selection: new Set<string>(),
    activeFilePath
  }), [target, workspaceRoot, entriesByDir, expanded, loadingDirs, activeFilePath])
  const decorations = useMemo(() => ({
    byPath: new Map(Object.entries(gitDecorations).map(([key, value]) => [key, { code: value.code, title: value.title, className: value.className }])),
    dirtyDirs: gitDirtyDirs
  }), [gitDecorations, gitDirtyDirs])
  const rows = useMemo(() => buildFileTreeRows({ snapshot, filter: nameFilter, decorations }).map(row => {
    const status = gitDecorations[pathKey(row.entry.path)]
    return status ? { ...row, gitCode: undefined, trailing: <span className="work-workspace-row__meta">
      <span className={`work-workspace-row__status work-workspace-row__status--${status.className}`} title={status.title}>{status.code}</span>
      {status.additions > 0 ? <span className="work-workspace-row__additions">+{status.additions}</span> : null}
      {status.deletions > 0 ? <span className="work-workspace-row__deletions">-{status.deletions}</span> : null}
    </span> } : row
  }), [snapshot, nameFilter, decorations, gitDecorations])

  const toggleDirectory = (directory: string): void => {
    if (!target) return
    if (expanded.has(directory)) {
      const next = new Set(expanded)
      next.delete(directory)
      setExpanded(next)
      return
    }
    if (!paths.contains(target.root, directory)) return
    const chain: string[] = []
    let current = directory
    while (current !== target.root && paths.contains(target.root, current)) {
      chain.unshift(current)
      const parent = paths.dirname(current)
      if (parent === current) break
      current = parent
    }
    const next = new Set(expanded)
    for (const path of chain) {
      if (next.has(path)) continue
      next.add(path)
      void loadDirectory(target, path, generation.current)
    }
    setExpanded(next)
  }

  const revealRow = (path: string): void => {
    const index = rows.findIndex(row => row.entry.path === path)
    const element = treeRef.current
    if (!element || index < 0) return
    const top = index * 30, bottom = top + 30
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }

  const activateRow = (path: string): void => {
    const row = rows.find(item => item.entry.path === path)
    if (!row) return
    setCursorPath(path)
    treeRef.current?.focus({ preventScroll: true })
    if (row.entry.isDirectory) toggleDirectory(path)
    else {
      setActiveFilePath(path)
      onOpenFile?.(path)
    }
  }

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!rows.length) return
    const index = Math.max(0, rows.findIndex(row => row.entry.path === cursorPath))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      setCursorPath(next.entry.path)
      revealRow(next.entry.path)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const row = rows[index]
      if (row.entry.isDirectory && ((event.key === 'ArrowRight') !== row.isExpanded)) toggleDirectory(row.entry.path)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateRow(rows[index].entry.path)
    } else if (event.key === 'Escape') setCursorPath(null)
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      const prefix = event.key.toLowerCase()
      const match = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row => row.entry.name.toLowerCase().startsWith(prefix))
      if (match) { setCursorPath(match.entry.path); revealRow(match.entry.path) }
    }
  }

  const refresh = (): void => {
    if (!target) return
    const requestGeneration = generation.current
    setError('')
    entriesRef.current = {}
    setEntriesByDir({})
    setExpanded(new Set([target.root]))
    void loadDirectory(target, target.root, requestGeneration)
    if (sessionId) void loadGitStatus(sessionId, requestGeneration)
  }

  if (!sessionId) {
    return <div className="work-workspace-panel work-workspace-panel--empty"><Icon name="folder-outline" size={24} /><strong>任务工作区尚未就绪</strong><span>选择一个 Work 任务后，可以查看它的独立文件。</span></div>
  }

  return <section className="work-workspace-panel" aria-label="工作区文件" data-session-id={sessionId}>
    <header className="work-workspace-panel__header">
      <div className="work-workspace-panel__title" title={target?.root ?? workspaceRoot ?? ''}>
        <span className="work-workspace-panel__root-label">资源</span>
        <strong>{workspaceRoot && target?.root ? paths.basename(target.root).toUpperCase() : '工作区'}</strong>
      </div>
      <div className="work-workspace-panel__actions" role="toolbar" aria-label="工作区工具">
        <button type="button" className="work-quiet-button" title="全部收起" aria-label="全部收起" onClick={() => target && setExpanded(new Set([target.root]))} disabled={!target}><Icon name="collapse-all" size={15} /></button>
        <button type="button" className="work-quiet-button" title="刷新" aria-label="刷新工作区文件" onClick={refresh} disabled={!target || loadingDirs.size > 0}>{loadingDirs.size > 0 ? <Spinner size={14} /> : <Icon name="restart" size={15} />}</button>
      </div>
    </header>
    <div className="work-workspace-panel__filter-wrap">
      <Icon name="search" size={15} />
      <input type="text" value={nameFilterRaw} onChange={event => setNameFilterRaw(event.target.value)} placeholder="筛选文件…" aria-label="筛选文件" />
      {nameFilterRaw ? <button type="button" aria-label="清除筛选" onClick={() => setNameFilterRaw('')}><Icon name="close" size={13} /></button> : null}
    </div>
    {error ? <div className="work-workspace-panel__error" role="alert"><Icon name="warning" size={15} /><span>{error}</span><button type="button" onClick={refresh}>重试</button></div> : null}
    <FileTreeView rows={rows} treeRef={treeRef} focused={focused} viewportHeight={viewportHeight} scrollTop={scrollTop}
      cursorPath={cursorPath} filter={nameFilter} onScroll={setScrollTop} aria-busy={loadingDirs.size > 0}
      empty={!loadingDirs.size && rows.length === (workspaceRoot ? 1 : 0) && Boolean(target && expanded.has(target.root))}
      emptyText={nameFilter ? '没有匹配的文件（仅筛选已加载目录）' : '此目录为空'}
      onRowMouseDown={(event: ReactMouseEvent, entry) => { if (event.button === 0) activateRow(entry.path) }}
      onStickyMouseDown={(_event, entry) => { setCursorPath(entry.path); revealRow(entry.path) }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={onTreeKeyDown} />
  </section>
}
