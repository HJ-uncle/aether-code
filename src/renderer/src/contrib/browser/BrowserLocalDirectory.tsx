import { useState, type JSX } from 'react'
import type { BrowserLocalDirectoryContent } from '@shared/browser'
import { Icon } from '@renderer/workbench/icons'
import { FileGlyph } from '@renderer/contrib/explorer/FileGlyph'
import { formatSize } from '@renderer/core/editor/preview'
import { browserAction, openLocalBrowserEntry } from './browser-store'

export function BrowserLocalDirectory({ tabId, content }: { tabId: string; content: BrowserLocalDirectoryContent }): JSX.Element {
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const entries = needle ? content.entries.filter(entry => entry.name.toLocaleLowerCase().includes(needle)) : content.entries
  const open = (path: string): void => {
    if (opening !== null) return
    setOpening(path)
    browserAction(async () => {
      try { await openLocalBrowserEntry(tabId, path) }
      finally { setOpening(null) }
    })
  }
  return <div className="browser-directory">
    <div className="browser-directory__toolbar">
      <button type="button" className="btn" aria-label="返回上级目录" title="返回上级目录"
        disabled={!content.parent || opening !== null} onClick={() => content.parent && open(content.parent)}>
        <Icon name="chevron-up" size={14} /><span>上级目录</span>
      </button>
      <input className="field__input browser-directory__filter" type="search" aria-label="筛选目录内容"
        placeholder="筛选当前目录" value={query} onChange={event => setQuery(event.target.value)} />
      <span className="browser-directory__count">{entries.length} 项</span>
    </div>
    {content.truncated ? <div className="browser-local-preview__notice" role="status">目录内容较多，仅显示前 2,000 项。</div> : null}
    <div className="browser-directory__list">
      <table aria-label="目录内容" className="browser-directory__table">
        <thead><tr><th scope="col">名称</th><th scope="col">大小</th><th scope="col">修改时间</th></tr></thead>
        <tbody>{entries.map(entry => <tr key={entry.path}>
          <td><button type="button" className="browser-directory__entry" title={entry.message ?? entry.name}
            disabled={entry.kind === 'unavailable' || opening !== null} onClick={() => open(entry.path)}>
            {entry.kind === 'directory' ? <Icon name="explorer" size={16} /> : entry.kind === 'unavailable'
              ? <Icon name="warning" size={16} /> : <FileGlyph name={entry.path} />}
            <span>{entry.name}</span>
          </button>{entry.message ? <span className="browser-directory__reason">{entry.message}</span> : null}</td>
          <td>{entry.kind === 'directory' ? '文件夹' : entry.size === undefined ? '—' : formatSize(entry.size)}</td>
          <td>{entry.modifiedAt === undefined ? '—' : new Date(entry.modifiedAt).toLocaleString()}</td>
        </tr>)}</tbody>
      </table>
      {entries.length === 0 ? <div className="browser-empty" role="status">
        <Icon name="explorer" size={30} /><p>{needle ? '没有匹配的文件或目录。' : '此目录为空。'}</p>
      </div> : null}
    </div>
  </div>
}
