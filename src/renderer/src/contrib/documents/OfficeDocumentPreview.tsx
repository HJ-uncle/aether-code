import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import { prepareOfficeArchive } from './office-archive'
import { documentFrame, passiveDocumentHtml } from './document-html'
import { PreviewMessage, PreviewPager, usePreviewVisibility, usePreviewWidth } from './preview-controls'

export default function OfficeDocumentPreview({ data, kind, name, onRetry }: { data: ArrayBuffer; kind: 'docx' | 'pptx'; name: string; onRetry?: () => void }): JSX.Element {
  const [state, setState] = useState<{ pages?: string[]; error?: string }>({})
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(0)
  const body = useRef<HTMLDivElement>(null), width = usePreviewWidth(body, Boolean(state.pages)), layoutReady = usePreviewVisibility(body, Boolean(state.pages))
  useEffect(() => {
    const controller = new AbortController()
    setState({}); setPage(1)
    const timer = setTimeout(() => { setState({ error: '此文档解析时间较长，请重试或使用本机应用打开。' }); controller.abort() }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const buffer = await prepareOfficeArchive(data, kind, controller.signal)
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
        throw new Error('此文档超出预览范围（最多 100 页）。')
      }
      const safe: string[] = []
      for (const html of pages) { controller.signal.throwIfAborted(); safe.push(passiveDocumentHtml(html)); await new Promise<void>(resolve => setTimeout(resolve, 0)) }
      clearTimeout(timer)
      if (!controller.signal.aborted) setState({ pages: safe })
    })().catch((error: unknown) => { clearTimeout(timer); if (!controller.signal.aborted) setState({ error: previewErrorMessage(error) }) })
    return () => { clearTimeout(timer); controller.abort() }
  }, [data, kind])
  const scale = zoom || Math.min(1, Math.max(0.2, (width - 24) / (kind === 'pptx' ? 960 : 840)))
  const srcDoc = useMemo(() => state.pages ? documentFrame(state.pages[page - 1] || '', name, scale) : '', [state.pages, page, name, scale])
  if (state.error) return <PreviewMessage error={state.error} onRetry={onRetry} />
  if (!state.pages) return <PreviewMessage />
  return <>
    <PreviewPager page={page} total={state.pages.length} onPage={setPage} zoom={zoom} onZoom={setZoom} />
    <div className="document-preview__body" ref={body}>
      {/* The resource panel can become visible after the first layout pass. Remount
          when its measured width settles so Chromium recomputes the srcdoc viewport. */}
      {layoutReady ? <iframe key={`${page}-${Math.round(width)}`} className="document-preview__frame" sandbox="allow-same-origin" referrerPolicy="no-referrer"
        title={`${name} · 第 ${page} 页`} srcDoc={srcDoc} data-document-page={page} /> : <PreviewMessage />}
    </div>
  </>
}
