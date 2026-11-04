import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import { prepareOfficeArchiveOffThread } from './office-archive-client'
import { cacheOfficePreview, getOfficePreview, type CachedOfficePreview } from './office-preview-cache'
import { documentFrame, passiveDocumentHtml } from './document-html'
import { PreviewMessage, PreviewZoom, usePreviewWidth, useStablePreviewWidth } from './preview-controls'
import { readPptxNotesForPreview, type PptxNotesPreview } from './pptx-notes'
import { bridgeFrameSelection } from './document-selection'
import { officeVisiblePage } from './office-visible-page'

const PAGE_GAP = 16
const RECENT_PAGES = 3
const pageHeight = (height: number, scale: number): number => Math.max(200, Math.ceil(height * scale + 2))

function ContinuousPage({ html, name, index, scale, height, retained, active, onSize }: {
  html: string; name: string; index: number; scale: number; height: number; retained: boolean; active: boolean
  onSize: (index: number, intrinsicHeight: number) => void
}): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ scale, onSize })
  latest.current = { scale, onSize }
  const resize = useRef<(() => void) | null>(null)
  // Changing srcdoc navigates the child document and decodes every image again.
  // Only this trusted parent changes zoom; the sandbox never enables scripts.
  const srcDoc = useMemo(() => documentFrame(html, name, 1), [html, name])
  useEffect(() => {
    return frame.current && retained && active ? bridgeFrameSelection(frame.current) : undefined
  }, [retained, active, srcDoc])
  useEffect(() => {
    const child = frame.current
    if (!child || !retained || !active) return
    let lastHeight = 0
    const update = (): void => {
      const main = child.contentDocument?.querySelector<HTMLElement>('main.document-page')
      if (!main) return
      const zoom = latest.current.scale
      if (main.style.zoom !== String(zoom)) main.style.zoom = String(zoom)
      const next = main.getBoundingClientRect().height / zoom
      if (next <= 0 || Math.abs(next - lastHeight) < 0.5) return
      lastHeight = next
      latest.current.onSize(index, next)
    }
    const observer = new ResizeObserver(update)
    const loaded = (): void => {
      observer.disconnect()
      const main = child.contentDocument?.querySelector('main.document-page')
      if (main) observer.observe(main)
      update()
    }
    resize.current = update
    child.addEventListener('load', loaded)
    loaded()
    return () => { resize.current = null; child.removeEventListener('load', loaded); observer.disconnect() }
  }, [retained, active, srcDoc, index])
  useLayoutEffect(() => { resize.current?.() }, [scale])
  return <div className="document-preview__continuous-page" data-document-page={index + 1} style={{ height }}>
    {retained ? <iframe ref={frame} className="document-preview__frame" sandbox="allow-same-origin" referrerPolicy="no-referrer" data-document-selection-frame="true"
      title={`${name} · 第 ${index + 1} 页`} srcDoc={srcDoc} /> : null}
  </div>
}

export default function OfficeDocumentPreview({ data, kind, name, sessionKey, active = true, onRetry }: { data: ArrayBuffer; kind: 'docx' | 'pptx'; name: string; sessionKey: string; active?: boolean; onRetry?: () => void }): JSX.Element {
  const cacheKey = JSON.stringify([sessionKey, kind])
  const cachedPreview = useMemo(() => getOfficePreview(cacheKey, data), [cacheKey, data])
  const [state, setState] = useState<Partial<CachedOfficePreview> & { error?: string }>(() => cachedPreview ?? {})
  const [zoom, setZoom] = useState(0)
  const [notesOpen, setNotesOpen] = useState(false)
  const [visiblePage, setVisiblePage] = useState(1)
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({})
  const [pageRetention, setPageRetention] = useState({ near: [0, 1], recent: [] as number[] })
  const [source, setSource] = useState({ data, cacheKey })
  if (source.data !== data || source.cacheKey !== cacheKey) {
    setPageHeights({})
    setPageRetention({ near: [0, 1], recent: [] })
    setSource({ data, cacheKey }); setState(cachedPreview ?? {}); setVisiblePage(1); setNotesOpen(false)
  }
  const body = useRef<HTMLDivElement>(null), width = usePreviewWidth(body, active && Boolean(state.pages))
  const stableWidth = useStablePreviewWidth(width)
  // Hidden retained previews keep their last nonzero layout and their frames.
  const layoutReady = stableWidth > 0
  useEffect(() => {
    if (cachedPreview) return
    const controller = new AbortController()
    const timer = setTimeout(() => { setState({ error: '此文档预览准备超时，请重试预览；若仍失败，请让 Aether 检查文件完整性。' }); controller.abort() }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      let buffer: ArrayBuffer
      let pages: string[]
      if (kind === 'pptx') {
        const [prepared, { pptxToHtml }] = await Promise.all([
          prepareOfficeArchiveOffThread(data, kind, controller.signal), import('@jvmr/pptx-to-html')])
        buffer = prepared
        controller.signal.throwIfAborted()
        pages = await pptxToHtml(buffer, { width: 960, height: 540, scaleToFit: true, letterbox: false })
      } else {
        const [prepared, { parseAsync, renderDocument }] = await Promise.all([
          prepareOfficeArchiveOffThread(data, kind, controller.signal), import('docx-preview')])
        buffer = prepared
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
      let notesReady: Promise<PptxNotesPreview> = Promise.resolve({})
      for (const [index, html] of pages.entries()) {
        controller.signal.throwIfAborted()
        const safe = passiveDocumentHtml(html)
        htmlBytes += safe.length
        if (htmlBytes > DOCUMENT_LIMITS.htmlBytes) throw new Error('文档版面过于复杂，超出预览范围。')
        sanitized.push(safe)
        if (index === 0) {
          setState(previous => ({ ...previous, pages: [safe] }))
          if (kind === 'pptx') {
            notesReady = readPptxNotesForPreview(buffer, pages.length, controller.signal).then(notes => {
              if (!controller.signal.aborted) setState(previous => ({ ...previous, ...notes }))
              return notes
            }).catch(() => ({})) // Abort belongs to the disposed preview.
          }
        }
        if (index === 0 || index % 4 === 3) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (!controller.signal.aborted) {
        setState(previous => ({ ...previous, pages: sanitized }))
        const notes = await notesReady
        if (!controller.signal.aborted) cacheOfficePreview(cacheKey, data, sanitized, notes)
      }
    })().catch((error: unknown) => { clearTimeout(timer); if (!controller.signal.aborted) setState({ error: previewErrorMessage(error) }) })
    return () => { clearTimeout(timer); controller.abort() }
  }, [data, kind, cacheKey, cachedPreview])
  const scale = zoom || Math.min(1, Math.max(0.2, (stableWidth - 24) / (kind === 'pptx' ? 960 : 840)))
  const pages = state.pages ?? []
  const estimatedHeight = kind === 'pptx' ? 540 : 1100
  const totalHeight = useMemo(() => pages.reduce((sum, _page, index) => sum + pageHeight(pageHeights[index] ?? estimatedHeight, scale) + (index ? PAGE_GAP : 0), 0), [pages, estimatedHeight, scale, pageHeights])
  const rememberHeight = useCallback((page: number, height: number) => {
    setPageHeights(previous => previous[page] === height ? previous : { ...previous, [page]: height })
  }, [])
  const retainedPages = useMemo(() => new Set([...pageRetention.near,
    ...pageRetention.recent.filter(index => !pageRetention.near.includes(index)).slice(0, RECENT_PAGES)]), [pageRetention])
  useEffect(() => {
    const element = body.current
    if (!element || !active || !layoutReady) return
    const observer = new IntersectionObserver(entries => {
      setPageRetention(previous => {
        const near = new Set(previous.near)
        let recent = previous.recent
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.documentPage) - 1
          if (entry.isIntersecting) {
            near.add(index)
            recent = [index, ...recent.filter(page => page !== index)]
          } else {
            if (near.delete(index)) recent = [index, ...recent.filter(page => page !== index)]
          }
        }
        return { near: [...near], recent: recent.slice(0, near.size + RECENT_PAGES) }
      })
    }, { root: element, rootMargin: '800px 0px' })
    for (const page of element.querySelectorAll('[data-document-page]')) observer.observe(page)
    return () => observer.disconnect()
  }, [active, layoutReady, pages.length, data, cacheKey])
  const note = state.notes?.[visiblePage - 1]
  useEffect(() => {
    const element = body.current
    if (!element || !active || pages.length < 2) return
    let frame = 0
    const update = (): void => {
      frame = 0
      setVisiblePage(officeVisiblePage(element.scrollTop, element.clientHeight, element.scrollHeight,
        pages.map((_page, index) => pageHeight(pageHeights[index] ?? estimatedHeight, scale)), PAGE_GAP))
    }
    const scroll = (): void => { if (!frame) frame = requestAnimationFrame(update) }
    element.addEventListener('scroll', scroll, { passive: true })
    scroll()
    return () => { element.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
  }, [pages, estimatedHeight, scale, pageHeights, active])
  if (state.error) return <PreviewMessage error={state.error} onRetry={onRetry} />
  if (!pages.length) return <PreviewMessage />
  return <>
    <PreviewZoom zoom={zoom} onZoom={setZoom} />
    <div className="document-preview__body document-preview__body--continuous" ref={body} data-document-pages={pages.length}>
      {layoutReady ? <div className="document-preview__continuous-content" style={{ minHeight: totalHeight }}>
        {pages.map((html, index) => <ContinuousPage key={index} html={html} name={name} index={index} scale={scale}
          height={pageHeight(pageHeights[index] ?? estimatedHeight, scale)} retained={retainedPages.has(index)} active={active} onSize={rememberHeight} />)}
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
