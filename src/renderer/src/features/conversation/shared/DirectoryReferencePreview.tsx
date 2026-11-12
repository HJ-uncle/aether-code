import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import type { FsEntry } from '@shared/ipc'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import { getEngineSource, isEngineReady, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import { captureSessionFileTarget, paths, readDir } from '@renderer/core/workspace/fs-client'
import { formatSize } from '@renderer/core/editor/preview'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { FileGlyph } from '../../explorer/FileGlyph'
import './directory-reference-preview.css'

function directoryPath(root: string, candidate: string): string {
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '')
  if (hasEncodedPathTraversal(candidate) || /[\u0000-\u001f\u007f]/.test(candidate) ||
    normalized.split('/').some(part => part === '..')) throw new Error('目录路径无效')
  const result = !normalized || normalized === '.' ? root
    : /^(?:[A-Za-z]:|\/)/.test(normalized) ? normalized : paths.join(root, normalized)
  if (!paths.contains(root, result)) throw new Error('目录不属于当前工作区')
  return result.replace(/\\/g, '/')
}

/** Browse the referenced owner without rebinding it or opening a directory as a text document. */
export function DirectoryReferencePreview({ path, root, sessionId, onOpenFile }: {
  path: string
  root: string | null
  sessionId?: string
  onOpenFile: (entry: FsEntry) => void
}): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const ready = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const scope = JSON.stringify([source, root, sessionId, path])
  const [location, setLocation] = useState<{ scope: string; path: string }>()
  const currentPath = location?.scope === scope ? location.path : path
  const [attempt, setAttempt] = useState(0)
  const request = JSON.stringify([scope, currentPath, ready, attempt])
  const [result, setResult] = useState<{ request: string; root: string; path: string; entries: FsEntry[]; error?: string }>()
  useEffect(() => {
    if (sessionId && !ready) return
    let current = true
    void (async () => {
      try {
        const target = sessionId ? await captureSessionFileTarget(sessionId, root) : undefined
        const selectedRoot = target?.root ?? root
        if (!selectedRoot) throw new Error('目录没有关联工作区')
        const directory = directoryPath(selectedRoot, currentPath)
        const entries = await readDir(directory, target)
        if (current && source === getEngineSource()) setResult({ request, root: selectedRoot, path: directory,
          entries: entries.filter(entry => paths.contains(selectedRoot, entry.path)).sort((left, right) =>
            Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name, 'zh-CN', { numeric: true })) })
      } catch (reason) {
        if (current && source === getEngineSource()) setResult({ request, root: root ?? '', path: currentPath, entries: [],
          error: reason instanceof Error ? reason.message : '目录读取失败' })
      }
    })()
    return () => { current = false }
  }, [source, ready, sessionId, root, currentPath, request])
  const visible = result?.request === request ? result : undefined
  const parent = visible ? paths.dirname(visible.path) : ''
  const canGoUp = Boolean(visible && !visible.error && paths.contains(visible.root, parent) && parent !== visible.path)
  const browse = (next: string): void => setLocation({ scope, path: next })
  return <section className="reference-directory" aria-label="目录内容" aria-busy={!visible}>
    <div className="reference-directory__toolbar">
      <button type="button" className="reference-directory__button" aria-label="返回上级目录" disabled={!canGoUp} onClick={() => browse(parent)}>
        <Icon name="chevron-up" size={16} /><span>上级目录</span>
      </button>
      <p aria-label="当前目录" title={visible?.path ?? currentPath}>{visible?.path ?? currentPath}</p>
      <button type="button" className="reference-directory__button" aria-label="刷新目录" onClick={() => setAttempt(value => value + 1)}><Icon name="refresh" size={16} /></button>
    </div>
    {!visible ? <div className="reference-directory__status" role="status"><Spinner size={16} />正在读取目录…</div>
      : visible.error ? <div className="reference-directory__status" role="alert"><span>{visible.error}</span>
        <button type="button" className="reference-directory__button" onClick={() => setAttempt(value => value + 1)}>重试读取</button></div>
        : visible.entries.length === 0 ? <p className="reference-directory__status" role="status">此目录为空</p>
          : <ul className="reference-directory__list">{visible.entries.map(entry => <li key={entry.path}>
            <button type="button" className="reference-directory__entry" aria-label={`${entry.isDirectory ? '打开目录' : '打开文件'} ${entry.name}`}
              onClick={() => entry.isDirectory ? browse(entry.path) : onOpenFile(entry)}>
              {entry.isDirectory ? <Icon name="folder-outline" size={18} /> : <FileGlyph name={entry.name} size={18} />}
              <span className="reference-directory__name">{entry.name}</span>
              <span className="reference-directory__detail">{entry.isDirectory ? '文件夹' : formatSize(entry.size)}</span>
              {entry.isDirectory ? <Icon name="chevron-right" size={14} /> : null}
            </button>
          </li>)}</ul>}
  </section>
}
