import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { assertEngineSource, getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { readSessionFile } from '@renderer/core/workspace/fs-client'
import { ImageViewerDialog } from './ImageViewerDialog'
import { classifyChatImage, chatImageFileSource } from './chat-image-source'
import type { ChatFileContext } from './chat-link'
import './chat-image.css'

/** A reply image keeps the same session and engine as the text around it.
 * Only the session file API may resolve model-supplied paths; never fall back
 * to the active editor or the unrestricted external-file picker. */
export function ChatImage({ href, alt, title, context }: {
  href: string; alt: string; title?: string | null; context?: ChatFileContext
}): JSX.Element {
  const { engine } = useApp()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [ownerSource] = useState(getEngineSource)
  const sessionId = context?.sessionId, workspaceRoot = context?.workspaceRoot
  const target = useMemo(() => classifyChatImage(href, sessionId, engine.snapshot.baseUrl), [href, sessionId, engine.snapshot.baseUrl])
  const request = useMemo(() => ({ target, sessionId, workspaceRoot, source }), [target, sessionId, workspaceRoot, source])
  const [loaded, setLoaded] = useState<{ request: typeof request; src?: string; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const [failedSource, setFailedSource] = useState('')
  const [expanded, setExpanded] = useState(false)
  const label = alt.trim() || title?.trim() || '结果图片'
  const current = ownerSource === source

  useEffect(() => {
    if (target.kind !== 'file') return
    let active = true
    void (async () => {
      try {
        assertEngineSource(ownerSource)
        if (!sessionId) throw new Error('这张图片缺少所属会话信息')
        const file = await readSessionFile(sessionId, target.path, workspaceRoot)
        assertEngineSource(ownerSource)
        const src = chatImageFileSource(file)
        if (active) setLoaded({ request, src })
      } catch (error) {
        if (active) setLoaded({ request, error: error instanceof Error ? error.message : '图片暂时无法加载' })
      }
    })()
    return () => { active = false }
  }, [request, target, sessionId, workspaceRoot, ownerSource, attempt])

  const result = loaded?.request === request ? loaded : undefined
  const src = target.kind === 'data' ? target.src : current ? result?.src : undefined
  const error = target.kind === 'unavailable' ? target.message
    : target.kind === 'file' && !current ? '图片所属连接已变化，请重新打开这条回复'
      : result?.error ?? (src && failedSource === src ? '图片内容无法解码' : undefined)
  const ready = !!src && !error
  // Portal clicks still bubble through React ancestors. Keep preview controls
  // from activating a Markdown link that also contains surrounding text.
  return <span className="md-image" onClick={event => { event.preventDefault(); event.stopPropagation() }}>
    {ready ? <button type="button" className="md-image__preview" aria-label={`放大查看 ${label}`}
      title={title ?? undefined} onClick={event => { event.preventDefault(); event.stopPropagation(); setExpanded(true) }}>
      <img src={src} alt={label} decoding="async" onError={() => setFailedSource(src)} />
    </button> : <span className="md-image__status" role="status" aria-label={label}>
      <span>{label}</span>
      <span className="md-image__hint">{error ?? '正在加载图片…'}</span>
      {target.kind === 'file' && current && error ? <button type="button" className="md-image__retry" onClick={() => {
        setLoaded(undefined); setFailedSource(''); setAttempt(value => value + 1)
      }}>重新加载图片</button> : null}
    </span>}
    <ImageViewerDialog src={src ?? null} title={label} open={expanded && ready} onClose={() => setExpanded(false)} />
  </span>
}
