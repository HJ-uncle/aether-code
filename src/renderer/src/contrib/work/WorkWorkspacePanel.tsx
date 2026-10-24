import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { FsEntry } from '@shared/ipc'
import { bindSessionWorkspace, captureSessionFileTarget, paths, readDir, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { getEngineSource } from '@renderer/core/engine/source'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import './work-workspace-panel.css'

export interface WorkWorkspacePanelProps {
  sessionId?: string | null
  workspaceRoot?: string | null
  active?: boolean
  onOpenFile?: (path: string) => void
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function iconFor(entry: FsEntry): IconName {
  return entry.isDirectory ? 'folder-outline' : 'file'
}

/**
 * A small, read-only explorer for the active Work task's authenticated
 * workspace.  It deliberately uses SessionFileTarget for every read so an
 * open Work task cannot accidentally inspect the global Code workspace.
 */
export function WorkWorkspacePanel({ sessionId, workspaceRoot, active = true, onOpenFile }: WorkWorkspacePanelProps): JSX.Element {
  const [target, setTarget] = useState<SessionFileTarget | null>(null)
  const [directory, setDirectory] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const reload = useCallback(async (nextTarget: SessionFileTarget, nextDirectory: string, requestGeneration: number): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = sortEntries(await readDir(nextDirectory, nextTarget))
      if (requestGeneration !== generation.current) return
      setEntries(result)
      setDirectory(nextDirectory)
    } catch (reason: unknown) {
      if (requestGeneration !== generation.current) return
      setEntries([])
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const requestGeneration = ++generation.current
    setTarget(null)
    setDirectory(null)
    setEntries([])
    setError('')
    if (!active || !sessionId) return () => { cancelled = true }
    const resolveTarget = async (): Promise<SessionFileTarget> => {
      // A selected local/remote project is an explicit Work scope.  Reconcile
      // the authenticated engine binding before reading so this panel follows
      // the task's directory instead of exposing a stale generated scratch
      // root from an earlier admission.
      if (workspaceRoot) await bindSessionWorkspace(sessionId, workspaceRoot)
      return captureSessionFileTarget(sessionId, workspaceRoot)
    }
    // StrictMode replays mount effects. Defer the transport launch until the
    // replay cleanup has run so the first setup cannot leave a duplicate
    // directory request queued behind a Git lease.
    const timer = setTimeout(() => {
      void resolveTarget().then(nextTarget => {
        if (cancelled) return
        setTarget(nextTarget)
        void reload(nextTarget, nextTarget.root, requestGeneration)
      }).catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
    }, 0)
    return () => { cancelled = true; clearTimeout(timer) }
  // A Work task's id and engine source form the authorization boundary.  An
  // explicitly selected workspace is reconciled above before any read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, workspaceRoot, getEngineSource()])

  const pathSegments = useMemo(() => {
    if (!target || !directory) return []
    const root = target.root.replace(/\\/g, '/').replace(/\/+$/, '')
    const current = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    if (current.toLowerCase() === root.toLowerCase()) return []
    return current.slice(root.length).replace(/^\/+/, '').split('/').filter(Boolean)
  }, [directory, target])

  const navigate = (nextDirectory: string): void => {
    if (!target || loading) return
    // Each navigation supersedes the previous directory request.  This keeps
    // a slow response from an earlier click from replacing the new folder.
    const requestGeneration = ++generation.current
    void reload(target, nextDirectory, requestGeneration)
  }

  const openEntry = (entry: FsEntry): void => {
    if (entry.isDirectory) {
      navigate(entry.path)
      return
    }
    onOpenFile?.(entry.path)
  }

  const parent = target && directory && directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== target.root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    ? paths.dirname(directory)
    : null

  if (!sessionId) {
    return <div className="work-workspace-panel work-workspace-panel--empty"><Icon name="folder-outline" size={24} /><strong>任务工作区尚未就绪</strong><span>选择一个 Work 任务后，可以查看它的独立文件。</span></div>
  }

  return <section className="work-workspace-panel" aria-label="工作区文件">
    <header className="work-workspace-panel__header">
      <div>
        <strong>工作区文件</strong>
        <span title={target?.root ?? workspaceRoot ?? ''}>{target?.root ?? '正在连接任务工作区…'}</span>
      </div>
      <button type="button" className="work-quiet-button" onClick={() => target && directory && navigate(directory)} disabled={!target || !directory || loading} aria-label="刷新工作区文件">
        {loading ? <Spinner size={14} /> : <Icon name="sync" size={14} />} 刷新
      </button>
    </header>
    <nav className="work-workspace-panel__breadcrumbs" aria-label="工作区路径">
      <button type="button" onClick={() => target && navigate(target.root)} disabled={!target || loading}>根目录</button>
      {pathSegments.map((segment, index) => {
        const path = paths.join(target?.root ?? '', ...pathSegments.slice(0, index + 1))
        return <span key={`${path}:${segment}`}><span aria-hidden="true">/</span><button type="button" onClick={() => navigate(path)} disabled={loading}>{segment}</button></span>
      })}
    </nav>
    {error ? <div className="work-workspace-panel__error" role="alert"><Icon name="warning" size={15} /><span>{error}</span><button type="button" onClick={() => target && directory && navigate(directory)}>重试</button></div> : null}
    <div className="work-workspace-panel__list" role="list" aria-busy={loading}>
      {parent ? <button type="button" className="work-workspace-entry work-workspace-entry--parent" onClick={() => navigate(parent)}><Icon name="chevron-up" size={16} /><span>返回上级目录</span></button> : null}
      {entries.map(entry => <button type="button" role="listitem" className={`work-workspace-entry${entry.isDirectory ? ' is-directory' : ''}`} key={entry.path} onClick={() => openEntry(entry)} title={entry.path}>
        <Icon name={iconFor(entry)} size={17} />
        <span className="work-workspace-entry__name">{entry.name}</span>
        <small>{entry.isDirectory ? '文件夹' : formatBytes(entry.size)}</small>
        {entry.gitignored ? <em>已忽略</em> : null}
      </button>)}
      {!loading && !error && !entries.length ? <div className="work-workspace-panel__empty"><Icon name="folder-outline" size={20} /><span>此目录为空</span></div> : null}
      {loading && !entries.length ? <div className="work-workspace-panel__empty"><Spinner size={18} /><span>读取工作区…</span></div> : null}
    </div>
  </section>
}

