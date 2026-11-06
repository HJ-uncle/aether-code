import { useEffect, useState, type JSX } from 'react'
import type { BrowserLocalFileContent, BrowserTabState } from '@shared/browser'
import { TextPreview } from '@renderer/core/editor/TextPreview'
import { formatSize } from '@renderer/core/editor/preview'
import { FilePreview } from '../editor/FilePreview'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { BrowserLocalDirectory } from './BrowserLocalDirectory'

/** A file tab reads only its own main-process grant; text never becomes page markup. */
export function BrowserLocalPreview({ tab }: { tab: BrowserTabState }): JSX.Element {
  const [result, setResult] = useState<{ key: string; content?: BrowserLocalFileContent; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${tab.tabId}:${tab.navigationId}:${attempt}`
  useEffect(() => {
    let active = true
    void window.aether.browser.readLocalFile(tab.tabId).then(content => {
      if (active) setResult({ key, content })
    }).catch((reason: unknown) => {
      if (active) setResult({ key, error: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { active = false }
  }, [tab.tabId, key])
  const current = result?.key === key ? result : null
  const file = tab.localFile!
  const content = current?.content
  return <section className="browser-local-preview" aria-label="本地文件预览">
    <div className="browser-local-preview__info">
      <Icon name={file.kind === 'directory' ? 'explorer' : 'file'} size={14} />
      <span className="browser-local-preview__name" title={file.path}>{file.name}</span>
      <span>{file.kind === 'directory' ? '文件夹' : formatSize(content && content.kind !== 'directory' ? content.size : file.size)}</span>
      {content?.kind === 'text' ? <span>{content.encoding} · 只读</span> : null}
    </div>
    {!current ? <div className="browser-empty" role="status"><Spinner size={20} /><span>正在读取文件…</span></div>
      : current.error ? <div className="browser-empty" role="alert">
        <Icon name="warning" size={28} /><p>{current.error}</p>
        <button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>重新读取</button>
      </div>
      : content?.kind === 'directory' ? <BrowserLocalDirectory key={content.path} tabId={tab.tabId} content={content} />
      : content?.kind === 'text' ? <>
        {content.truncated ? <div className="browser-local-preview__notice" role="status">文件较大，当前显示前 4 MiB 内容。</div> : null}
        <div className="browser-local-preview__text"><TextPreview key={key} content={content.text} name={file.name} /></div>
      </> : content?.kind === 'binary' ? <div className="browser-local-preview__binary">
        {file.name.toLowerCase().endsWith('.svg')
          ? <img className="browser-local-preview__image" src={`data:image/svg+xml;base64,${content.base64}`} alt={file.name} />
          : <FilePreview key={key} name={file.name} path={file.path} groupId={`browser:${tab.tabId}`} base64={content.base64} size={content.size} />}
      </div> : null}
  </section>
}
