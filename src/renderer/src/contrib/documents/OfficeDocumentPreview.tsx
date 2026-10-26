import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import { prepareOfficeArchive } from './office-archive'
import { documentFrame, passiveDocumentHtml } from './document-html'
import { PreviewMessage, PreviewPager, usePreviewVisibility, usePreviewWidth } from './preview-controls'
import { readPptxNotesForPreview, type PptxNotesPreview } from './pptx-notes'

export default function OfficeDocumentPreview({ data, kind, name, onRetry }: { data: ArrayBuffer; kind: 'docx' | 'pptx'; name: string; onRetry?: () => void }): JSX.Element {
  const [state, setState] = useState<{ pages?: string[]; error?: string } & PptxNotesPreview>({})
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(0)
  const [notesOpen, setNotesOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null), width = usePreviewWidth(body, Boolean(state.pages)), layoutReady = usePreviewVisibility(body, Boolean(state.pages))
  useEffect(() => {
    const controller = new AbortController()
    setState({}); setPage(1); setNotesOpen(false)
    const timer = setTimeout(() => { setState({ error: '此文档预览准备超时，请重试预览；若仍失败，请让 Aether 检查文件完整性。' }); controller.abort() }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const buffer = await prepareOfficeArchive(data, kind, controller.signal)
      let pages: string[], notesPreview: PptxNotesPreview = {}
      if (kind === 'pptx') {
        const { pptxToHtml } = await import('@jvmr/pptx-to-html')
        controller.signal.throwIfAborted()
        pages = await pptxToHtml(buffer, { width: 960, height: 540, scaleToFit: true, letterbox: false })
        notesPreview = await readPptxNotesForPreview(buffer, pages.length, controller.signal)
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
      if (!controller.signal.aborted) setState({ pages: safe, ...notesPreview })
    })().catch((error: unknown) => { clearTimeout(timer); if (!controller.signal.aborted) setState({ error: previewErrorMessage(error) }) })
    return () => { clearTimeout(timer); controller.abort() }
  }, [data, kind])
  const scale = zoom || Math.min(1, Math.max(0.2, (width - 24) / (kind === 'pptx' ? 960 : 840)))
  const srcDoc = useMemo(() => state.pages ? documentFrame(state.pages[page - 1] || '', name, scale) : '', [state.pages, page, name, scale])
  const note = state.notes?.[page - 1]
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
    {state.notesError || note && (note.text || note.truncated) ? <details className="document-preview__notes" open={notesOpen}
      onToggle={event => setNotesOpen(event.currentTarget.open)}>
      <summary>备注</summary>
      <div key={page} className="document-preview__notes-content" data-presentation-notes={page} aria-label={`第 ${page} 页备注`}>
        {state.notesError ? <p className="document-preview__notes-limit" role="status">{state.notesError}</p> : note?.text}
        {note?.truncated ? <p className="document-preview__notes-limit">备注较长，当前显示前 {note.text.length.toLocaleString()} 个字符。</p> : null}
      </div>
    </details> : null}
  </>
}
