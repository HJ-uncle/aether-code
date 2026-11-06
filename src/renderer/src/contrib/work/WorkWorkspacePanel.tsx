import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { FsEntry } from '@shared/ipc'
import { bindSessionWorkspace, captureSessionFileTarget, copy, createFile, createFolder, invalidateSessionFileTarget, paths, readDir, rename, stat, trash, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { captureSessionGitTarget } from '@renderer/core/git/git-target'
import { createGitClient } from '@renderer/core/git/git-client'
import { changeCode, changeCodeClass, changeTitle, normalizeGitPath } from '@renderer/core/git/git-format'
import { engineStorageKey, getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { createFileTreeScope, fileTreePathKey as pathKey, readFileTreeMemory, restoreFileTreeExpansion, writeFileTreeMemory, type FileTreeMemory, type FileTreeScope } from '@renderer/core/workspace/file-tree-memory'
import { resolveFileTreeReveal } from '@renderer/core/workspace/file-tree-reveal'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { buildFileTreeRows, FileTreeView } from '@renderer/contrib/explorer/FileTreeView'
import { FILE_TREE_ROW_HEIGHT } from '@renderer/contrib/explorer/FileTreeRow'
import { useFileTreeMemory, useFileTreeViewport } from '@renderer/contrib/explorer/use-file-tree-memory'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { copyFilePaths, revealFile } from '@renderer/core/editor/file-context-actions'
import { validateWorkEntryName, workCopyName, workOperationPaths } from './work-workspace-actions'
import { syncWorkFileOperation } from './work-resource-store'
import { WorkWorkspaceSearch } from './WorkWorkspaceSearch'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import './work-workspace-panel.css'

export interface WorkFileRevealRequest {
  scope: string
  path: string
  revision: number
}

export interface WorkWorkspacePanelProps {
  sessionId?: string | null
  workspaceRoot?: string | null
  active?: boolean
  revealRequest?: WorkFileRevealRequest | null
  onDidReveal?: (request: WorkFileRevealRequest) => void
  onOpenFile?: (path: string, reveal?: TextPreviewReveal) => void
}

interface GitDecoration { code: string; className: string; title: string; additions: number; deletions: number }
type NameAction = { kind: 'file' | 'folder'; directory: string } | { kind: 'rename'; entry: FsEntry }
interface WorkspaceMenu { x: number; y: number; entry: FsEntry | null; paths: string[]; owner: string; revision: number }

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

function directoryEntries(children: Record<string, FsEntry[]>, directory: string): FsEntry[] | undefined {
  return children[directory] ?? Object.entries(children).find(([path]) => pathKey(path) === pathKey(directory))?.[1]
}

function reconcileTreeMemory(scope: FileTreeScope, saved: FileTreeMemory, restored: ReadonlySet<string>, children: Record<string, FsEntry[]>, complete: boolean): void {
  const latest = readFileTreeMemory(scope)
  const samePaths = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((path, index) => path === right[index])
  const resolve = (path: string | null): string | null => {
    if (!path) return null
    const rootKey = pathKey(scope.root), key = pathKey(path)
    if (key === rootKey) return scope.root
    const segments = key.slice(rootKey === '/' ? 1 : rootKey.length + 1).split('/')
    let directory = scope.root
    for (let index = 0; index < segments.length; index++) {
      const entries = directoryEntries(children, directory)
      // A collapsed or failed branch has no proof that the remembered file
      // disappeared. Keep its preference without authorizing another read.
      if (!entries) return path
      const candidate = `${rootKey === '/' ? '' : rootKey}/${segments.slice(0, index + 1).join('/')}`
      const entry = entries.find(item => pathKey(item.path) === candidate)
      if (!entry) return null
      if (index === segments.length - 1) return entry.path
      if (!entry.isDirectory) return null
      directory = entry.path
    }
    return path
  }
  const patch: Partial<FileTreeMemory> = {}
  if (samePaths(latest.expanded, saved.expanded)) patch.expanded = [...restored]
  // Restoration is asynchronous; newer clicks and keyboard selection own
  // their fields even when they happen before the initial tree is ready.
  if (complete) {
    if (samePaths(latest.selection, saved.selection)) patch.selection = latest.selection.flatMap(path => resolve(path) ?? [])
    if (latest.cursorPath === saved.cursorPath) patch.cursorPath = resolve(latest.cursorPath)
    if (latest.activeFilePath === saved.activeFilePath) patch.activeFilePath = resolve(latest.activeFilePath)
  }
  if (Object.keys(patch).length) writeFileTreeMemory(scope, patch)
}

/**
 * Work 的文件树和 Code Explorer 保持同一套交互语义，但所有读取仍走
 * session-scoped workspace API。不能直接复用 ExplorerView：ExplorerView
 * 订阅的是本地 workspace-store，接入这里会把任务沙箱泄露到 Code 工作区。
 */
export function WorkWorkspacePanel({ sessionId, workspaceRoot, active = true, revealRequest, onDidReveal, onOpenFile }: WorkWorkspacePanelProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const requestKey = JSON.stringify([source, sessionId, workspaceRoot ?? ''])
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const [resolved, setResolved] = useState<{ target: SessionFileTarget; requestKey: string } | null>(null)
  // Props change before effects clean up. Never render the previous session's
  // rows or accept its scroll events during that intervening commit.
  const target = resolved?.requestKey === requestKey ? resolved.target : null
  const [searchScope, setSearchScope] = useState<string | null>(null)
  const searchVisible = searchScope === requestKey
  const [visitedSearchScope, setVisitedSearchScope] = useState<string | null>(null)
  const scope = useMemo(() => target && target.source === source
    ? createFileTreeScope('work', engineStorageKey(target.expectedEngine ?? getExpectedEngine()), target.sessionId, target.root)
    : null, [target, source])
  const { memory, updateMemory } = useFileTreeMemory(scope)
  const expanded = useMemo(() => new Set(memory.expanded), [memory.expanded])
  const selection = useMemo(() => new Set(memory.selection), [memory.selection])
  const nameFilterRaw = memory.filter
  const activeFilePath = memory.activeFilePath
  const cursorPath = memory.cursorPath
  const setNameFilterRaw = (filter: string): void => updateMemory({ filter })
  const setExpanded = (value: ReadonlySet<string>): void => updateMemory({ expanded: [...value] })
  const setCursorPath = (path: string | null): void => updateMemory({ cursorPath: path })
  const [entriesByDir, setEntriesByDir] = useState<Record<string, FsEntry[]>>({})
  const entriesRef = useRef(entriesByDir)
  entriesRef.current = entriesByDir
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(new Set())
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<WorkspaceMenu | null>(null)
  const menuRevision = useRef(0)
  const [nameAction, setNameAction] = useState<{ owner: string; revision: number; action: NameAction } | null>(null)
  const nameRevision = useRef(0)
  const [clipboard, setClipboard] = useState<{ owner: string; paths: string[]; mode: 'cut' | 'copy' } | null>(null)
  const [sortMode, setSortMode] = useState<'default' | 'name'>('default')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const selectionAnchor = useRef<string | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [gitDecorations, setGitDecorations] = useState<Record<string, GitDecoration>>({})
  const [gitDirtyDirs, setGitDirtyDirs] = useState<ReadonlySet<string>>(new Set())
  const generation = useRef(0)
  const restoration = useRef(0)
  const directoryRequests = useRef(new Map<string, number>())
  const directoryLoads = useRef(new Map<string, { generation: number; promise: Promise<FsEntry[] | null> }>())
  const treeRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const revealRef = useRef(revealRequest)
  revealRef.current = revealRequest
  const handledReveal = useRef<WorkFileRevealRequest | null>(null)
  const pendingReveal = useRef<{ request: WorkFileRevealRequest; path: string } | null>(null)

  const loadDirectory = useCallback(async (nextTarget: SessionFileTarget, directory: string, requestGeneration: number, force = false): Promise<FsEntry[] | null> => {
    const key = pathKey(directory)
    if (!force) {
      const cached = directoryEntries(entriesRef.current, directory)
      if (cached) return cached
      const pending = directoryLoads.current.get(key)
      if (pending?.generation === requestGeneration) return pending.promise
    }
    const request = (directoryRequests.current.get(key) ?? 0) + 1
    directoryRequests.current.set(key, request)
    const owner = requestKeyRef.current
    const current = (): boolean => owner === requestKeyRef.current && requestGeneration === generation.current && directoryRequests.current.get(key) === request
    setLoadingDirs(previous => new Set(previous).add(directory))
    const promise = (async (): Promise<FsEntry[] | null> => {
      try {
        const result = sortEntries(await readDir(directory, nextTarget))
        if (!current()) return null
        entriesRef.current = { ...entriesRef.current, [directory]: result }
        setEntriesByDir(entriesRef.current)
        return result
      } catch (reason: unknown) {
        if (!current()) return null
        setError(reason instanceof Error ? reason.message : String(reason))
        // Keep the previous rows. A failed read is not an empty directory,
        // and the shared restorer preserves its unverified expansion paths.
        return null
      } finally {
        if (current()) {
          directoryLoads.current.delete(key)
          setLoadingDirs(previous => new Set([...previous].filter(path => pathKey(path) !== key)))
        }
      }
    })()
    directoryLoads.current.set(key, { generation: requestGeneration, promise })
    return promise
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
    const restoreRequest = ++restoration.current
    const current = (): boolean => !cancelled && requestKeyRef.current === requestKey && requestGeneration === generation.current && restoreRequest === restoration.current
    setResolved(null)
    setReady(false)
    entriesRef.current = {}
    setEntriesByDir({})
    setLoadingDirs(new Set())
    setGitDecorations({})
    setGitDirtyDirs(new Set())
    setError('')
    setMenu(null)
    setNameAction(null)
    setClipboard(null)
    selectionAnchor.current = null
    if (!sessionId) return () => { cancelled = true }
    const resolveTarget = async (): Promise<void> => {
      if (workspaceRoot) await bindSessionWorkspace(sessionId, workspaceRoot)
      const nextTarget = await captureSessionFileTarget(sessionId, workspaceRoot)
      if (!current()) return
      setResolved({ target: nextTarget, requestKey })
      const nextScope = createFileTreeScope('work', engineStorageKey(nextTarget.expectedEngine ?? getExpectedEngine()), nextTarget.sessionId, nextTarget.root)
      const saved = readFileTreeMemory(nextScope)
      const rootEntries = await loadDirectory(nextTarget, nextTarget.root, requestGeneration)
      let complete = rootEntries !== null
      const restored = await restoreFileTreeExpansion({ root: nextTarget.root, expanded: saved.expanded, rootEntries,
        keepRootExpanded: !workspaceRoot,
        current,
        readChildren: async directory => {
          const entries = await loadDirectory(nextTarget, directory, requestGeneration)
          if (!entries) complete = false
          return entries
        } })
      if (!current()) return
      if (rootEntries) {
        reconcileTreeMemory(nextScope, saved, restored, entriesRef.current, complete)
      }
      setReady(true)
      void loadGitStatus(sessionId, requestGeneration)
    }
    const timer = setTimeout(() => { void resolveTarget().catch(reason => {
      if (!current()) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setReady(true)
    }) }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // Only identity/unmount invalidates reads. Hiding the pane keeps its
      // loaded tree and remembered viewport intact.
      generation.current += 1
    }
  }, [sessionId, workspaceRoot, loadDirectory, loadGitStatus, source, requestKey])

  const nameFilter = nameFilterRaw.trim().toLowerCase()
  const snapshot = useMemo(() => ({
    root: target?.root ?? null,
    showRoot: Boolean(workspaceRoot),
    children: new Map(Object.entries(entriesByDir)),
    expanded,
    loading: loadingDirs,
    selection,
    activeFilePath
  }), [target, workspaceRoot, entriesByDir, expanded, loadingDirs, activeFilePath, selection])
  const decorations = useMemo(() => ({
    byPath: new Map(Object.entries(gitDecorations).map(([key, value]) => [key, { code: value.code, title: value.title, className: value.className }])),
    dirtyDirs: gitDirtyDirs
  }), [gitDecorations, gitDirtyDirs])
  const rows = useMemo(() => buildFileTreeRows({ snapshot, filter: nameFilter, decorations, sortMode,
    cutPaths: clipboard?.owner === requestKey && clipboard.mode === 'cut' ? clipboard.paths : [] }).map(row => {
    const status = gitDecorations[pathKey(row.entry.path)]
    return status ? { ...row, gitCode: undefined, trailing: <span className="work-workspace-row__meta">
      <span className={`work-workspace-row__status work-workspace-row__status--${status.className}`} title={status.title}>{status.code}</span>
      {status.additions > 0 ? <span className="work-workspace-row__additions">+{status.additions}</span> : null}
      {status.deletions > 0 ? <span className="work-workspace-row__deletions">-{status.deletions}</span> : null}
    </span> } : row
  }), [snapshot, nameFilter, decorations, gitDecorations, sortMode, clipboard, requestKey])
  const { viewportHeight, scrollTop, onScroll } = useFileTreeViewport({
    scopeKey: scope?.key, treeRef, memory, updateMemory, ready: ready && active, rowCount: rows.length
  })
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  useEffect(() => {
    if (!active || !ready || !target || !scope || !revealRequest || revealRequest.scope !== requestKey || handledReveal.current === revealRequest) return
    let cancelled = false
    const requestGeneration = generation.current
    const current = (): boolean => !cancelled && requestKeyRef.current === requestKey && generation.current === requestGeneration && revealRef.current === revealRequest
    void (async () => {
      let result = await resolveFileTreeReveal({ root: target.root, path: revealRequest.path, current,
        readChildren: directory => loadDirectory(target, directory, requestGeneration) })
      // A Git/chat opening may refer to a file created after this tree was
      // cached. Revalidate that branch once before treating it as absent.
      if (!result && current()) result = await resolveFileTreeReveal({ root: target.root, path: revealRequest.path, current,
        readChildren: directory => loadDirectory(target, directory, requestGeneration, true) })
      if (!current()) return
      // Deleted historical files are a completed request too. Reopening the
      // tab later must not replay an obsolete selection over the user's work.
      if (!result) { onDidReveal?.(revealRequest); return }
      const latest = readFileTreeMemory(scope)
      pendingReveal.current = { request: revealRequest, path: result.path }
      handledReveal.current = revealRequest
      // Merge into the latest memory: unrelated expanded branches and a
      // filter that already shows this file still belong to the user.
      updateMemory({ expanded: [...latest.expanded, ...result.ancestors], selection: [result.path],
        activeFilePath: result.path, cursorPath: result.path,
        filter: rowsRef.current.some(row => pathKey(row.entry.path) === pathKey(result.path)) ? latest.filter : '' })
    })().catch(reason => {
      if (current()) {
        setError(reason instanceof Error ? reason.message : String(reason))
        onDidReveal?.(revealRequest)
      }
    })
    return () => { cancelled = true }
  }, [active, ready, target, scope, requestKey, revealRequest, loadDirectory, updateMemory, onDidReveal])

  useLayoutEffect(() => {
    const pending = pendingReveal.current, element = treeRef.current
    if (!active || !ready || !pending || pending.request !== revealRequest || pending.request.scope !== requestKey || !element?.clientHeight) return
    const index = rows.findIndex(row => pathKey(row.entry.path) === pathKey(pending.path))
    if (index < 0) return
    // Virtual rows may not have DOM nodes yet. Scroll by their logical index
    // after expansion and viewport restoration, then persist the new offset.
    const top = index * FILE_TREE_ROW_HEIGHT, bottom = top + FILE_TREE_ROW_HEIGHT
    const stickyHeight = element.parentElement?.querySelector('.explorer__sticky')?.getBoundingClientRect().height ?? 0
    // Sticky ancestor rows cover the top of the viewport. Center an offscreen
    // target so upward navigation cannot leave it selected behind that layer.
    if (top < element.scrollTop + stickyHeight || bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - (element.clientHeight - FILE_TREE_ROW_HEIGHT) / 2)
    }
    pendingReveal.current = null
    onScroll(element.scrollTop)
    onDidReveal?.(pending.request)
  }, [active, ready, requestKey, revealRequest, rows, viewportHeight, onScroll, onDidReveal])

  const toggleDirectory = (directory: string): void => {
    if (!target || !scope) return
    const key = pathKey(directory), rootKey = pathKey(target.root)
    const latest = readFileTreeMemory(scope).expanded.map(path => pathKey(path) === rootKey ? target.root : path)
    if (latest.some(path => pathKey(path) === key)) {
      setExpanded(new Set(latest.filter(path => pathKey(path) !== key)))
      return
    }
    if (key === rootKey) {
      setExpanded(new Set(latest).add(target.root))
      void loadDirectory(target, directory, generation.current)
      return
    }
    if (!paths.contains(target.root, directory)) return
    const chain: string[] = []
    let current = directory
    // Directory entries use slash paths on Windows. Adding that root alias
    // to the chain used to replace the bound root and collapse the whole tree.
    while (pathKey(current) !== rootKey && paths.contains(target.root, current)) {
      chain.unshift(current)
      const parent = paths.dirname(current)
      if (parent === current) break
      current = parent
    }
    const next = new Set(latest)
    for (const path of chain) {
      if ([...next].some(candidate => pathKey(candidate) === pathKey(path))) continue
      next.add(path)
      void loadDirectory(target, path, generation.current)
    }
    setExpanded(next)
  }

  const revealRow = (path: string): void => {
    const index = rows.findIndex(row => row.entry.path === path)
    const element = treeRef.current
    if (!element || index < 0) return
    const top = index * FILE_TREE_ROW_HEIGHT, bottom = top + FILE_TREE_ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }

  const activateRow = (path: string): void => {
    const row = rows.find(item => item.entry.path === path)
    if (!row) return
    updateMemory({ cursorPath: path, selection: [path] })
    treeRef.current?.focus({ preventScroll: true })
    if (row.entry.isDirectory) toggleDirectory(path)
    else {
      updateMemory({ activeFilePath: path })
      onOpenFile?.(path)
    }
  }

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const command = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (command && ['a', 'c', 'x', 'v'].includes(key)) {
      event.preventDefault(); event.stopPropagation()
      if (key === 'a') selectPaths(rows.filter(row => pathKey(row.entry.path) !== pathKey(target?.root ?? '')).map(row => row.entry.path))
      else if (key === 'v') void pasteInto(destination(entryFor(cursorPath)))
      else copySelection(key === 'x' ? 'cut' : 'copy')
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation(); void deletePaths(memory.selection); return
    }
    if (event.key === 'F2') {
      event.preventDefault(); event.stopPropagation()
      const entry = entryFor(cursorPath)
      if (entry) beginName({ kind: 'rename', entry })
      return
    }
    if (!rows.length) return
    const index = Math.max(0, rows.findIndex(row => row.entry.path === cursorPath))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (event.shiftKey) {
        const anchor = selectionAnchor.current ?? cursorPath ?? next.entry.path
        selectionAnchor.current = anchor
        const from = Math.max(0, rows.findIndex(row => row.entry.path === anchor)), to = rows.indexOf(next)
        updateMemory({ cursorPath: next.entry.path, selection: rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(row => row.entry.path) })
      } else { selectionAnchor.current = next.entry.path; updateMemory({ cursorPath: next.entry.path, selection: [next.entry.path] }) }
      revealRow(next.entry.path)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const row = rows[index]
      if (row.entry.isDirectory && ((event.key === 'ArrowRight') !== row.isExpanded)) toggleDirectory(row.entry.path)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const row = rows[event.key === 'Home' ? 0 : rows.length - 1]
      updateMemory({ cursorPath: row.entry.path, selection: [row.entry.path] })
      revealRow(row.entry.path)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateRow(rows[index].entry.path)
    } else if (event.key === 'Escape') updateMemory({ cursorPath: null, selection: [] })
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      const prefix = event.key.toLowerCase()
      const match = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row => row.entry.name.toLowerCase().startsWith(prefix))
      if (match) { updateMemory({ cursorPath: match.entry.path, selection: [match.entry.path] }); revealRow(match.entry.path) }
    }
  }

  const refresh = async (): Promise<void> => {
    if (!sessionId || busyRef.current || requestKeyRef.current !== requestKey) return
    const requestGeneration = ++generation.current
    const restoreRequest = ++restoration.current
    const current = (): boolean => requestKeyRef.current === requestKey && requestGeneration === generation.current && restoreRequest === restoration.current
    setError('')
    setReady(false)
    setLoadingDirs(new Set())
    try {
      // A recovered binding may differ from a previously successful target.
      // Resolve it through the read-only endpoint, never the task's saved hint.
      invalidateSessionFileTarget(sessionId)
      const nextTarget = await captureSessionFileTarget(sessionId)
      if (!current()) return
      const nextScope = createFileTreeScope('work', engineStorageKey(nextTarget.expectedEngine ?? getExpectedEngine()), nextTarget.sessionId, nextTarget.root)
      const saved = readFileTreeMemory(nextScope)
      if (target?.key !== nextTarget.key) {
        // Rows and operations captured under the old binding cannot be shown
        // as if they belonged to the newly recovered directory.
        entriesRef.current = {}
        setEntriesByDir({})
        setLoadingDirs(new Set())
        setGitDecorations({})
        setGitDirtyDirs(new Set())
        setClipboard(null)
        setMenu(null)
        setNameAction(null)
        selectionAnchor.current = null
      }
      setResolved({ target: nextTarget, requestKey })
      // Preserve rows and viewport for a refresh of the same binding.
      const rootEntries = await loadDirectory(nextTarget, nextTarget.root, requestGeneration, true)
      let complete = rootEntries !== null
      const restored = await restoreFileTreeExpansion({ root: nextTarget.root, expanded: saved.expanded, rootEntries,
        keepRootExpanded: !workspaceRoot, current,
        readChildren: async directory => {
          const entries = await loadDirectory(nextTarget, directory, requestGeneration, true)
          if (!entries) complete = false
          return entries
        } })
      if (!current()) return
      if (rootEntries) reconcileTreeMemory(nextScope, saved, restored, entriesRef.current, complete)
      void loadGitStatus(sessionId, requestGeneration)
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (current()) setReady(true)
    }
  }

  const entryFor = (path: string | null): FsEntry | null => path ? rows.find(row => pathKey(row.entry.path) === pathKey(path))?.entry ?? null : null
  const destination = (entry: FsEntry | null): string | null => target ? entry?.isDirectory ? entry.path : entry ? paths.dirname(entry.path) : target.root : null
  const currentOwner = (): boolean => requestKeyRef.current === requestKey && activeRef.current
  const selectPaths = (selected: string[]): void => updateMemory({ selection: selected, cursorPath: selected[0] ?? null })
  const copySelection = (mode: 'copy' | 'cut', selected = memory.selection): void => {
    if (!target || !currentOwner()) return
    const files = workOperationPaths(selected, target.root)
    if (files.length) setClipboard({ owner: requestKey, mode, paths: files })
  }
  const runOperation = async (operation: (captured: SessionFileTarget) => Promise<void>, propagate = false): Promise<void> => {
    if (!target || !currentOwner() || busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { await operation(target) }
    catch (reason) {
      if (currentOwner()) setError(reason instanceof Error ? reason.message : String(reason))
      if (propagate) throw reason
    } finally {
      busyRef.current = false
      setBusy(false)
      if (currentOwner()) await refresh()
    }
  }
  const beginName = (action: NameAction): void => {
    if (!target || !currentOwner() || busyRef.current) return
    if (action.kind === 'rename' && pathKey(action.entry.path) === pathKey(target.root)) return
    setNameAction({ owner: requestKey, revision: ++nameRevision.current, action })
  }
  const submitName = async (name: string): Promise<void> => {
    if (!nameAction || nameAction.owner !== requestKey || !currentOwner()) return
    const action = nameAction.action
    await runOperation(async captured => {
      const directory = action.kind === 'rename' ? paths.dirname(action.entry.path) : action.directory
      const path = paths.join(directory, name)
      if (action.kind === 'rename') {
        if (action.entry.path === path) return
        await rename(action.entry.path, path, captured)
        syncWorkFileOperation(captured, action.entry.path, path)
      } else if (action.kind === 'file') await createFile(path, captured)
      else await createFolder(path, captured)
      if (!currentOwner() || !scope) return
      const latest = readFileTreeMemory(scope)
      const moved = (value: string): string => action.kind === 'rename' && paths.contains(action.entry.path, value)
        ? `${path}${value.replace(/\\/g, '/').slice(action.entry.path.replace(/\\/g, '/').length)}` : value
      updateMemory({ expanded: [...new Set([...latest.expanded.map(moved), captured.root, directory])],
        selection: [path], cursorPath: path, filter: '',
        ...(latest.activeFilePath ? { activeFilePath: moved(latest.activeFilePath) } : {}) })
      if (latest.activeFilePath && moved(latest.activeFilePath) !== latest.activeFilePath) onOpenFile?.(moved(latest.activeFilePath))
      await loadDirectory(captured, directory, generation.current, true)
    }, true)
  }
  const pasteInto = async (directory: string | null): Promise<void> => {
    const clip = clipboard
    if (!directory || !clip || clip.owner !== requestKey || !target) return
    await runOperation(async captured => {
      const created: string[] = []
      let entries = await readDir(directory, captured)
      for (const path of workOperationPaths(clip.paths, captured.root)) {
        if (!currentOwner()) return
        const info = await stat(path, captured)
        if (info.isDirectory && paths.contains(path, directory)) throw new Error('不能把文件夹放到它自身或子目录中')
        if (clip.mode === 'cut' && pathKey(paths.dirname(path)) === pathKey(directory)) continue
        const name = clip.mode === 'copy' ? workCopyName(paths.basename(path), info.isDirectory, entries) : paths.basename(path)
        const next = paths.join(directory, name)
        if (clip.mode === 'cut' && entries.some(entry => pathKey(entry.path) === pathKey(next))) throw new Error(`目标已存在「${name}」，请先重命名`)
        if (!currentOwner()) return
        if (clip.mode === 'cut') {
          await rename(path, next, captured)
          syncWorkFileOperation(captured, path, next)
          if (currentOwner() && scope) {
            const activePath = readFileTreeMemory(scope).activeFilePath
            if (activePath && paths.contains(path, activePath)) {
              const moved = `${next}${activePath.replace(/\\/g, '/').slice(path.replace(/\\/g, '/').length)}`
              updateMemory({ activeFilePath: moved })
              onOpenFile?.(moved)
            }
          }
          // Consume each successful move; a later conflict must not leave
          // already moved sources on the clipboard for the next retry.
          setClipboard(previous => previous?.owner === requestKey
            ? { ...previous, paths: previous.paths.filter(source => pathKey(source) !== pathKey(path)) } : previous)
        } else await copy(path, next, captured)
        created.push(next)
        entries = [...entries, { name, path: next, isDirectory: info.isDirectory, size: info.size, mtimeMs: info.mtimeMs }]
      }
      if (!currentOwner() || !created.length || !scope) return
      if (clip.mode === 'cut') setClipboard(null)
      const latest = readFileTreeMemory(scope)
      updateMemory({ expanded: [...new Set([...latest.expanded, captured.root, directory])], selection: created, cursorPath: created[0], filter: '' })
      await loadDirectory(captured, directory, generation.current, true)
    })
  }
  const deletePaths = async (selected: string[]): Promise<void> => {
    if (!target || !currentOwner()) return
    const files = workOperationPaths(selected, target.root)
    if (!files.length) return
    const accepted = await confirmDialog({ title: '删除文件', body: files.length === 1 ? `确定删除「${paths.basename(files[0])}」吗？` : `确定删除选中的 ${files.length} 项吗？`, confirmText: '删除', danger: true })
    if (!accepted || !currentOwner()) return
    await runOperation(async captured => {
      for (const path of files) {
        if (!currentOwner()) return
        await trash(path, captured)
        syncWorkFileOperation(captured, path)
      }
      if (!currentOwner() || !scope) return
      const latest = readFileTreeMemory(scope), retained = (path: string): boolean => !files.some(parent => paths.contains(parent, path))
      updateMemory({ selection: latest.selection.filter(retained), expanded: latest.expanded.filter(retained),
        cursorPath: latest.cursorPath && retained(latest.cursorPath) ? latest.cursorPath : null,
        activeFilePath: latest.activeFilePath && retained(latest.activeFilePath) ? latest.activeFilePath : null })
      if (clipboard?.owner === requestKey) setClipboard(previous => previous ? { ...previous, paths: previous.paths.filter(retained) } : null)
    })
  }
  const locateActive = async (): Promise<void> => {
    if (!target || !scope || !activeFilePath) return
    const result = await resolveFileTreeReveal({ root: target.root, path: activeFilePath, current: currentOwner,
      readChildren: directory => loadDirectory(target, directory, generation.current) })
    if (!result || !currentOwner()) return
    const latest = readFileTreeMemory(scope)
    updateMemory({ expanded: [...new Set([...latest.expanded, ...result.ancestors])], selection: [result.path], cursorPath: result.path, filter: '' })
    requestAnimationFrame(() => {
      if (!currentOwner()) return
      const index = rowsRef.current.findIndex(row => pathKey(row.entry.path) === pathKey(result.path))
      if (treeRef.current && index >= 0) { treeRef.current.scrollTop = Math.max(0, index * FILE_TREE_ROW_HEIGHT - treeRef.current.clientHeight / 2); onScroll(treeRef.current.scrollTop) }
      treeRef.current?.focus({ preventScroll: true })
    })
  }
  const openContext = (event: ReactMouseEvent, entry: FsEntry | null): void => {
    event.preventDefault(); event.stopPropagation()
    if (!target || !currentOwner()) return
    const selected = entry ? selection.has(entry.path) ? memory.selection : [entry.path] : []
    if (entry) { selectPaths(selected); selectionAnchor.current = entry.path }
    setMenu({ x: event.clientX, y: event.clientY, entry, paths: selected, owner: requestKey, revision: ++menuRevision.current })
  }
  const menuItems = (): ContextMenuItem[] => {
    if (!menu || menu.owner !== requestKey || !target) return []
    const entry = menu.entry, directory = destination(entry), selected = workOperationPaths(menu.paths, target.root)
    const items: ContextMenuItem[] = []
    if (entry && !entry.isDirectory) items.push({ id: 'open', label: '打开', onSelect: () => activateRow(entry.path) })
    if (directory) items.push(
      { id: 'newFile', label: '新建文件', disabled: busy, onSelect: () => beginName({ kind: 'file', directory }) },
      { id: 'newFolder', label: '新建文件夹', disabled: busy, onSelect: () => beginName({ kind: 'folder', directory }) })
    if (entry && pathKey(entry.path) !== pathKey(target.root)) items.push({ id: 'rename', label: '重命名', hint: 'F2', disabled: busy, onSelect: () => beginName({ kind: 'rename', entry }) })
    if (menu.paths.length) items.push(
      { id: 'absolute', label: '复制绝对路径', onSelect: () => void copyFilePaths(menu.paths) },
      { id: 'relative', label: '复制相对路径', onSelect: () => void copyFilePaths(menu.paths, target.root) })
    if (selected.length) items.push(
      { id: 'cut', label: selected.length > 1 ? `剪切 ${selected.length} 项` : '剪切', hint: 'Ctrl+X', disabled: busy, onSelect: () => copySelection('cut', selected) },
      { id: 'copy', label: selected.length > 1 ? `复制 ${selected.length} 项` : '复制', hint: 'Ctrl+C', onSelect: () => copySelection('copy', selected) })
    items.push({ id: 'paste', label: '粘贴', hint: 'Ctrl+V', disabled: busy || !clipboard?.paths.length || clipboard.owner !== requestKey, onSelect: () => void pasteInto(directory) })
    if (entry) items.push({ id: 'reveal', label: '在文件资源管理器中显示', disabled: target.expectedEngine?.mode === 'remote',
      hint: target.expectedEngine?.mode === 'remote' ? '远端文件' : undefined, onSelect: () => void revealFile(entry.path) })
    if (selected.length) items.push({ id: 'delete', label: selected.length > 1 ? `删除 ${selected.length} 项` : '删除', hint: 'Delete', danger: true, disabled: busy, onSelect: () => void deletePaths(selected) })
    items.push({ id: 'refresh', label: '刷新', disabled: busy, onSelect: () => void refresh() })
    return items
  }

  const selectRow = (event: ReactMouseEvent, entry: FsEntry): void => {
    if (event.button !== 0) return
    treeRef.current?.focus({ preventScroll: true })
    if (event.shiftKey) {
      const anchor = selectionAnchor.current ?? cursorPath ?? entry.path
      const from = rows.findIndex(row => pathKey(row.entry.path) === pathKey(anchor)), to = rows.findIndex(row => row.entry.path === entry.path)
      const selected = rows.slice(Math.min(Math.max(0, from), to), Math.max(from, to) + 1).map(row => row.entry.path)
      updateMemory({ cursorPath: entry.path, selection: selected }); return
    }
    selectionAnchor.current = entry.path
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path)
      updateMemory({ cursorPath: entry.path, selection: [...next] }); return
    }
    activateRow(entry.path)
  }

  if (!sessionId) {
    return <div className="work-workspace-panel work-workspace-panel--empty"><Icon name="folder-outline" size={24} /><strong>任务工作区尚未就绪</strong><span>选择一个 Work 任务后，可以查看它的独立文件。</span></div>
  }

  return <section className="work-workspace-panel" aria-label="工作区文件" data-session-id={sessionId} data-view={searchVisible ? 'search' : 'files'}>
    <header className="work-workspace-panel__header">
      <div className="work-workspace-panel__title" title={target?.root ?? workspaceRoot ?? ''}>
        <div className="work-workspace-panel__switch" role="group" aria-label="工作区浏览方式">
          <button type="button" aria-label="浏览工作区文件" aria-pressed={!searchVisible} onClick={() => setSearchScope(null)}><Icon name="folder-outline" size={14} /><span>文件</span></button>
          <button type="button" aria-label="搜索工作区内容" aria-pressed={searchVisible} disabled={!target} onClick={() => { setSearchScope(requestKey); setVisitedSearchScope(requestKey) }}><Icon name="search" size={14} /><span>搜索</span></button>
        </div>
      </div>
      <div className="work-workspace-panel__actions" role="toolbar" aria-label="工作区工具" hidden={searchVisible}>
        <button type="button" className="work-quiet-button" title="新建文件" aria-label="新建文件" onClick={() => { const directory = destination(entryFor(cursorPath)); if (directory) beginName({ kind: 'file', directory }) }} disabled={!target || busy}><Icon name="file-plus-outline" size={15} /></button>
        <button type="button" className="work-quiet-button" title="新建文件夹" aria-label="新建文件夹" onClick={() => { const directory = destination(entryFor(cursorPath)); if (directory) beginName({ kind: 'folder', directory }) }} disabled={!target || busy}><Icon name="folder-outline" size={15} /><Icon name="plus" size={8} /></button>
        <button type="button" className="work-quiet-button" title={sortMode === 'default' ? '排序：文件夹在前' : '排序：按名称'} aria-label="切换排序方式" onClick={() => setSortMode(previous => previous === 'default' ? 'name' : 'default')} disabled={!target}><Icon name="sort" size={15} /></button>
        <button type="button" className="work-quiet-button" title="定位当前文件" aria-label="定位当前文件" onClick={() => void locateActive()} disabled={!target || !activeFilePath}><Icon name="locate" size={15} /></button>
        <button type="button" className="work-quiet-button" title="全部收起" aria-label="全部收起" onClick={() => target && setExpanded(new Set([target.root]))} disabled={!target}><Icon name="collapse-all" size={15} /></button>
        <button type="button" className="work-quiet-button" title="刷新" aria-label="刷新工作区文件" onClick={() => void refresh()} disabled={!target || busy || loadingDirs.size > 0}>{loadingDirs.size > 0 ? <Spinner size={14} /> : <Icon name="restart" size={15} />}</button>
      </div>
    </header>
    {target && visitedSearchScope === requestKey ? <div className="work-workspace-panel__search" hidden={!searchVisible}>
      <WorkWorkspaceSearch key={target.key} target={target} active={active && searchVisible} onOpenFile={(path, reveal) => {
        updateMemory({ activeFilePath: path }); onOpenFile?.(path, reveal)
      }} />
    </div> : null}
    <div className="work-workspace-panel__files" hidden={searchVisible}>
    <div className="work-workspace-panel__filter-wrap">
      <Icon name="search" size={15} />
      <input type="text" value={nameFilterRaw} onChange={event => setNameFilterRaw(event.target.value)} placeholder="筛选文件…" aria-label="筛选文件" />
      {nameFilterRaw ? <button type="button" aria-label="清除筛选" onClick={() => setNameFilterRaw('')}><Icon name="close" size={13} /></button> : null}
    </div>
    {error ? <div className="work-workspace-panel__error" role="alert">
      <div className="work-workspace-panel__error-summary"><Icon name="warning" size={15} />
        <span>{/ENOENT|no such file|Bound workspace is no longer available/i.test(error) ? '工作区目录暂时不可用' : '工作区操作未完成'}</span>
        <button type="button" onClick={() => void refresh()}>重试</button>
      </div>
      <details key={error}><summary>详细信息</summary><pre>{error}</pre></details>
    </div> : null}
    <FileTreeView rows={rows} motionScope={scope?.key ?? requestKey} treeRef={treeRef} focused={focused} viewportHeight={viewportHeight} scrollTop={scrollTop}
      cursorPath={cursorPath} filter={nameFilter} onScroll={onScroll} aria-busy={!ready || loadingDirs.size > 0} multiSelect
      empty={!loadingDirs.size && rows.length === (workspaceRoot ? 1 : 0) && Boolean(target && expanded.has(target.root))}
      emptyText={nameFilter ? '没有匹配的文件（仅筛选已加载目录）' : '此目录为空'}
      onRowMouseDown={selectRow} onRowContextMenu={openContext}
      onContextMenu={event => { if (!(event.target as HTMLElement).closest('.tree-row')) openContext(event, null) }}
      onStickyMouseDown={(_event, entry) => { setCursorPath(entry.path); revealRow(entry.path) }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={onTreeKeyDown} />
    </div>
    {active && menu?.owner === requestKey ? <ContextMenu key={`menu:${menu.owner}:${menu.revision}`} x={menu.x} y={menu.y} items={menuItems()} anchor={treeRef.current}
      onClose={() => setMenu(previous => previous === menu ? null : previous)} /> : null}
    {active && nameAction?.owner === requestKey ? <PromptDialog key={`name:${nameAction.owner}:${nameAction.revision}`}
      title={nameAction.action.kind === 'rename' ? '重命名' : nameAction.action.kind === 'file' ? '新建文件' : '新建文件夹'}
      label={nameAction.action.kind === 'rename' ? '新名称' : '名称'} initialValue={nameAction.action.kind === 'rename' ? nameAction.action.entry.name : ''}
      confirmLabel={nameAction.action.kind === 'rename' ? '重命名' : '创建'} validate={validateWorkEntryName}
      onConfirm={submitName} onClose={() => setNameAction(previous => previous === nameAction ? null : previous)} /> : null}
  </section>
}
