import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { FsEntry } from '@shared/ipc'
import { readDir, paths } from '@renderer/core/workspace/fs-client'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { openWorkspaceResource } from '@renderer/core/editor/monaco-workspace'
import { monaco } from '@renderer/core/editor/monaco-setup'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'

export interface EditorPathPickerProps {
  directory: string
  workspaceRoot: string | null
  currentFile: string
  anchor: DOMRect
  onClose: () => void
}

/** Directory crumbs browse their children; the file crumb starts with its siblings. */
export function EditorPathPicker({ directory, workspaceRoot, currentFile, anchor, onClose }: EditorPathPickerProps): JSX.Element {
  const [folder, setFolder] = useState(directory)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const visible = useMemo(() => entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [entries, filter])
  const parent = paths.dirname(folder)
  const canGoUp = Boolean(workspaceRoot && parent !== folder &&
    (fileIdentity(parent) === fileIdentity(workspaceRoot) || fileIdentity(parent).startsWith(fileIdentity(workspaceRoot).replace(/\/+$/, '') + '/')))
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void readDir(folder).then((result) => {
      if (!cancelled) { setEntries(result); setLoading(false) }
    }).catch((reason: unknown) => {
      if (!cancelled) { setEntries([]); setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)) }
    })
    return () => { cancelled = true }
  }, [folder])
  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) close.current()
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close.current() }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  const browse = (path: string): void => { setFolder(path); setFilter(''); setSelected(0) }
  const pick = (entry: FsEntry): void => {
    if (entry.isDirectory) browse(entry.path)
    else {
      onClose()
      void openWorkspaceResource(monaco.Uri.file(entry.path)).catch(() => toast.error('无法打开所选文件'))
    }
  }
  return createPortal(<div ref={panel} className="editor-path-picker" role="dialog" aria-label="浏览文件路径"
    style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 328)), top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - 356)) }}>
    <header>
      <button type="button" aria-label="上一级目录" title="上一级目录" disabled={!canGoUp} onClick={() => browse(parent)}><Icon name="chevron-up" size={14} /></button>
      <span title={folder}>{paths.basename(folder)}</span>
      <button type="button" aria-label="关闭路径选择" onClick={onClose}><Icon name="close" size={14} /></button>
    </header>
    <input autoFocus aria-label="筛选同级文件" placeholder="筛选文件或文件夹…" value={filter}
      onChange={(event) => { setFilter(event.target.value); setSelected(0) }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setSelected((value) => Math.max(0, Math.min(visible.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
        } else if (event.key === 'Enter' && visible[selected]) { event.preventDefault(); pick(visible[selected]) }
      }} />
    <div className="editor-path-picker__list">
      {loading ? <p role="status">正在读取目录…</p> : error ? <p role="alert">{error}</p> : visible.length ? visible.map((entry, index) => (
        <button key={entry.path} type="button" className={`editor-path-picker__entry${index === selected ? ' is-selected' : ''}`}
          aria-current={fileIdentity(entry.path) === fileIdentity(currentFile) ? 'page' : undefined}
          title={entry.path} onClick={() => pick(entry)} onMouseEnter={() => setSelected(index)}>
          <Icon name={entry.isDirectory ? 'folder-outline' : 'file'} size={14} />
          <span>{entry.name}</span>
          {entry.isDirectory ? <Icon name="chevron-right" size={12} /> : null}
        </button>
      )) : <p>没有匹配的文件</p>}
    </div>
  </div>, document.body)
}
