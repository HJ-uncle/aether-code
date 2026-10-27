import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import { prepareOfficeArchiveOffThread } from './office-archive-client'
import { cacheOfficePreview, getOfficePreview } from './office-preview-cache'
import { documentFrame, passiveDocumentHtml } from './document-html'
import { PreviewMessage, PreviewZoom, usePreviewVisibility, usePreviewWidth, useStablePreviewWidth } from './preview-controls'
import { readPptxNotesForPreview, type PptxNotesPreview } from './pptx-notes'

function ContinuousPage({ html, name, index, scale, onSize }: { html: string; name: string; index: number; scale: number; onSize: (index: number, height: number) => void }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const placeholder = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(index < 2)
  const [height, setHeight] = useState(0)
  const estimatedHeight = name.toLowerCase().endsWith('.pptx') ? 540 * scale : 1100 * scale
  const srcDoc = useMemo(() => near ? documentFrame(html, name, scale) : '', [html, name, scale, near])
  useEffect(() => {
    const element = placeholder.current
    if (!element) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setNear(entry.isIntersecting)
    }, { root: element.closest('.document-preview__body'), rootMargin: '800px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const child = frame.current
    if (!child || !near) return
    const update = (): void => {
      const body = child.contentDocument?.body
      if (!body) return
      const next = Math.max(200, Math.ceil((body.querySelector('main')?.getBoundingClientRect().height ?? body.getBoundingClientRect().height) + 2))
      if (Math.abs(next - height) < 2) return
      setHeight(next)
      onSize(index, next)
    }
    const observer = new ResizeObserver(update)
    child.addEventListener('load', update)
    if (child.contentDocument?.body) observer.observe(child.contentDocument.body)
    update()
    return () => { child.removeEventListener('load', update); observer.disconnect() }
  }, [near, srcDoc, index, height, onSize])
  return <div ref={placeholder} className="document-preview__continuous-page" data-document-page={index + 1} style={{ height: height || Math.max(200, Math.ceil(estimatedHeight)) }}>
    {near ? <iframe ref={frame} className="document-preview__frame" sandbox="allow-same-origin" referrerPolicy="no-referrer"
      title={`${name} · 第 ${index + 1} 页`} srcDoc={srcDoc} /> : null}
  </div>
}

export default function OfficeDocumentPreview({ data, kind, name, sessionKey, onRetry }: { data: ArrayBuffer; kind: 'docx' | 'pptx'; name: string; sessionKey: string; onRetry?: () => void }): JSX.Element {
  const cachedPages = useMemo(() => getOfficePreview(sessionKey, data), [sessionKey, data])
  const [state, setState] = useState<{ pages?: string[]; error?: string } & PptxNotesPreview>(() => cachedPages ? { pages: [...cachedPages] } : {})
  const [zoom, setZoom] = useState(0)
  const [notesOpen, setNotesOpen] = useState(false)
  const [visiblePage, setVisiblePage] = useState(1)
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({})
  const [source, setSource] = useState({ data, kind })
  if (source.data !== data || source.kind !== kind) {
    const pages = getOfficePreview(sessionKey, data)
    setPageHeights({})
    setSource({ data, kind }); setState(pages ? { pages: [...pages] } : {}); setVisiblePage(1); setNotesOpen(false)
  }
  const body = useRef<HTMLDivElement>(null), width = usePreviewWidth(body, Boolean(state.pages)), layoutReady = usePreviewVisibility(body, Boolean(state.pages))
  const stableWidth = useStablePreviewWidth(width)
  useEffect(() => {
    if (cachedPages) return
    const controller = new AbortController()
    const timer = setTimeout(() => { setState({ error: '此文档预览准备超时，请重试预览；若仍失败，请让 Aether 检查文件完整性。' }); controller.abort() }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const buffer = await prepareOfficeArchiveOffThread(data, kind, controller.signal)
      let pages: string[]
      if (kind === 'pptx') {
        const { pptxToHtml } = await import('@jvmr/pptx-to-html')
        controller.signal.throwIfAborted()
        pages = await pptxToHtml(buffer, { width: 960, height: 540, scaleToFit: true, letterbox: false })
      } else {
        const { parseAsync, renderDocument } = await import('docx-preview')
        const options = { inWrapper: false, ignoreFonts: true, useBase64URL: true, renderAltChunks: false,
          renderComments: false, experimental: false, breakPages: true, ignoreLastRenderedPageBreak: false }
        controller.signal.throwIfAborted()
        const documentModel = await parseAsync(buffer, options)
        controller.signal.throwIfAborted()
        const nodes = await renderDocument(documentModel, options)
        const style = nodes.filter((node): node is HTMLStyleElement => node instanceof HTMLStyleElement).map(node => node.outerHTML).join('')
        pages = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'SECTION').map(node => style + node.outerHTML)
      }
      controller.signal.throwIfAborted()
      if (!pages.length || pages.length > DOCUMENT_LIMITS.pages || pages.reduce((sum, html) => sum + html.length, 0) > DOCUMENT_LIMITS.htmlBytes) {
        throw new Error('此文档页数或渲染后版面超出预览预算（最多 100 页、32 MB HTML）。')
      }
      clearTimeout(timer)
      let htmlBytes = 0
      const sanitized: string[] = []
      for (const [index, html] of pages.entries()) {
        controller.signal.throwIfAborted()
        const safe = passiveDocumentHtml(html)
        htmlBytes += safe.length
        if (htmlBytes > DOCUMENT_LIMITS.htmlBytes) throw new Error('文档版面过于复杂，超出预览范围。')
        sanitized.push(safe)
        if (index === 0) {
          setState(previous => ({ ...previous, pages: [safe] }))
          if (kind === 'pptx') {
            void readPptxNotesForPreview(buffer, pages.length, controller.signal).then(notes => {
              if (!controller.signal.aborted) setState(previous => ({ ...previous, ...notes }))
            }).catch(() => { /* Abort belongs to the disposed preview. */ })
          }
        }
        if (index === 0 || index % 4 === 3) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (!controller.signal.aborted) {
        cacheOfficePreview(sessionKey, data, sanitized)
        setState(previous => ({ ...previous, pages: sanitized }))
      }
    })().catch((error: unknown) => { clearTimeout(timer); if (!controller.signal.aborted) setState({ error: previewErrorMessage(error) }) })
    return () => { clearTimeout(timer); controller.abort() }
  }, [data, kind, sessionKey, cachedPages])
  const scale = zoom || Math.min(1, Math.max(0.2, (stableWidth - 24) / (kind === 'pptx' ? 960 : 840)))
  const pages = state.pages ?? []
  const totalHeight = useMemo(() => pages.reduce((sum, _page, index) => sum + (pageHeights[index + 1] ?? (kind === 'pptx' ? 540 * scale + 18 : 1100)), 0), [pages, kind, scale, pageHeights])
  const rememberHeight = useCallback((page: number, height: number) => {
    setPageHeights(previous => previous[page] === height ? previous : { ...previous, [page]: height })
  }, [])
  const note = state.notes?.[visiblePage - 1]
  useEffect(() => {
    const element = body.current
    if (!element || pages.length < 2) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const center = element.scrollTop + element.clientHeight * 0.35
      let accumulated = 0
      for (let index = 0; index < pages.length; index++) {
        accumulated += pageHeights[index + 1] ?? (kind === 'pptx' ? 540 * scale + 18 : 1100)
        if (accumulated >= center) { setVisiblePage(index + 1); break }
      }
    }
    const scroll = (): void => { if (!frame) frame = requestAnimationFrame(update) }
    element.addEventListener('scroll', scroll, { passive: true })
    return () => { element.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
  }, [pages, kind, scale, pageHeights])
  if (state.error) return <PreviewMessage error={state.error} onRetry={onRetry} />
  if (!pages.length) return <PreviewMessage />
  return <>
    <PreviewZoom zoom={zoom} onZoom={setZoom} />
    <div className="document-preview__body document-preview__body--continuous" ref={body} data-document-pages={pages.length}>
      {layoutReady ? <div className="document-preview__continuous-content" style={{ minHeight: totalHeight }}>
        {pages.map((html, index) => <ContinuousPage key={index} html={html} name={name} index={index} scale={scale} onSize={rememberHeight} />)}
      </div> : <PreviewMessage />}
    </div>
    {state.notesError || note && (note.text || note.truncated) ? <details className="document-preview__notes" open={notesOpen}
      onToggle={event => setNotesOpen(event.currentTarget.open)}>
      <summary>备注 · 第 {visiblePage} 页</summary>
      <div key={visiblePage} className="document-preview__notes-content" data-presentation-notes={visiblePage} aria-label={`第 ${visiblePage} 页备注`}>
        {state.notesError ? <p className="document-preview__notes-limit" role="status">{state.notesError}</p> : note?.text}
        {note?.truncated ? <p className="document-preview__notes-limit">备注较长，当前显示前 {note.text.length.toLocaleString()} 个字符。</p> : null}
      </div>
    </details> : null}
  </>
}
