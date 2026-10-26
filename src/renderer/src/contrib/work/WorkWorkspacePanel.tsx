import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { FsEntry } from '@shared/ipc'
import { bindSessionWorkspace, captureSessionFileTarget, paths, readDir, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { captureSessionGitTarget } from '@renderer/core/git/git-target'
import { createGitClient } from '@renderer/core/git/git-client'
import { changeCode, changeCodeClass, changeTitle, normalizeGitPath } from '@renderer/core/git/git-format'
import { getEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { FileTreeRow } from '@renderer/contrib/explorer/FileTreeRow'
import './work-workspace-panel.css'

export interface WorkWorkspacePanelProps {
  sessionId?: string | null
  workspaceRoot?: string | null
  active?: boolean
  onOpenFile?: (path: string) => void
}

interface GitDecoration { code: string; className: string; title: string; additions: number; deletions: number }
interface WorkTreeRow {
  entry: FsEntry
  depth: number
  isRoot?: boolean
  isExpanded: boolean
  isLoading: boolean
  git?: GitDecoration
  gitDirty?: boolean
}

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

function rootEntryOf(root: string): FsEntry {
  return { name: paths.basename(root), path: root, isDirectory: true, size: 0, mtimeMs: 0 }
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
  // Filtering is a user-facing search affordance, so it must not depend on
  // whether the user happened to expand every parent directory first. Load
  // known child directories progressively while a filter is active; the tree
  // itself remains collapsed and only matching paths are revealed.
  useEffect(() => {
    if (!nameFilter || !target) return
    const requestGeneration = generation.current
    const directories = Object.values(entriesByDir)
      .flat()
      .filter(entry => entry.isDirectory)
    for (const directory of directories) {
      if (!entriesRef.current[directory.path] && !loadingDirs.has(directory.path)) {
        void loadDirectory(target, directory.path, requestGeneration)
      }
    }
  }, [entriesByDir, loadDirectory, loadingDirs, nameFilter, target])
  const rows = useMemo((): WorkTreeRow[] => {
    if (!target) return []
    const output: WorkTreeRow[] = []
    const rootKey = pathKey(target.root)
    const rootExpanded = expanded.has(target.root)
    if (workspaceRoot) output.push({
      entry: rootEntryOf(target.root), depth: 0, isRoot: true,
      isExpanded: rootExpanded, isLoading: loadingDirs.has(target.root),
      gitDirty: !rootExpanded && gitDirtyDirs.has(rootKey)
    })
    if (!rootExpanded) return output

    const walk = (directory: string, depth: number): void => {
      for (const entry of entriesByDir[directory] ?? []) {
        const matches = !nameFilter || entry.name.toLowerCase().includes(nameFilter)
        if (!matches) {
          if (entry.isDirectory) walk(entry.path, depth + 1)
          continue
        }
        const isExpanded = entry.isDirectory && expanded.has(entry.path)
        const git = gitDecorations[pathKey(entry.path)]
        output.push({
          entry, depth, isExpanded,
          isLoading: entry.isDirectory && loadingDirs.has(entry.path),
          git,
          gitDirty: entry.isDirectory && !isExpanded && gitDirtyDirs.has(pathKey(entry.path))
        })
        if (isExpanded) walk(entry.path, depth + 1)
      }
    }
    walk(target.root, workspaceRoot ? 1 : 0)
    return output
  }, [entriesByDir, expanded, gitDecorations, gitDirtyDirs, loadingDirs, nameFilter, target, workspaceRoot])

  const toggleDirectory = (directory: string): void => {
    if (!target) return
    const next = new Set(expanded)
    if (next.has(directory)) next.delete(directory)
    else {
      next.add(directory)
      void loadDirectory(target, directory, generation.current)
    }
    setExpanded(next)
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

  return <section className="work-workspace-panel" aria-label="工作区文件">
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
    <div className="work-workspace-panel__tree" role="tree" aria-busy={loadingDirs.size > 0}>
      {rows.map(row => {
        const isDirectory = row.entry.isDirectory
        const status = row.git
        const isActive = !isDirectory && row.entry.path === activeFilePath
        const activate = (): void => {
          if (isDirectory) toggleDirectory(row.entry.path)
          else {
            setActiveFilePath(row.entry.path)
            onOpenFile?.(row.entry.path)
          }
        }
        return <FileTreeRow
          key={row.entry.path}
          name={row.entry.name}
          path={row.entry.path}
          title={status?.title ?? row.entry.path}
          depth={row.depth}
          isDirectory={isDirectory}
          isExpanded={row.isExpanded}
          isActive={isActive}
          className={`work-workspace-row${row.isRoot ? ' is-root' : ''}`}
          nameClassName={status ? `tree-row__name--${status.className}` : ''}
          onClick={activate}
          onActivate={activate}
          trailing={<span className="work-workspace-row__meta">
            {row.isLoading ? <Spinner size={13} /> : null}
            {status ? <><span className={`work-workspace-row__status work-workspace-row__status--${status.className}`} title={status.title}>{status.code}</span>{status.additions > 0 ? <span className="work-workspace-row__additions">+{status.additions}</span> : null}{status.deletions > 0 ? <span className="work-workspace-row__deletions">-{status.deletions}</span> : null}</> : row.gitDirty ? <span className="work-workspace-row__dirty" title="目录中有改动">•</span> : null}
          </span>}
        />
      })}
      {!loadingDirs.size && !rows.some(row => !row.isRoot) && target && expanded.has(target.root) ? <div className="work-workspace-panel__empty"><Icon name="folder-outline" size={20} /><span>{nameFilter ? '没有匹配的文件' : '此目录为空'}</span></div> : null}
    </div>
  </section>
}
