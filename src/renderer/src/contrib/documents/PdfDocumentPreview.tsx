import { useEffect, useRef, useState, type JSX } from 'react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFWorker, RenderTask } from 'pdfjs-dist'
import { DOCUMENT_LIMITS, ensureMapGetOrInsertComputed, pdfCanvasSize, previewErrorMessage } from './document-kind'
import { PreviewMessage, PreviewPager, usePreviewVisibility, usePreviewWidth } from './preview-controls'

export default function PdfDocumentPreview({ data, name, onRetry }: { data: ArrayBuffer; name: string; onRetry?: () => void }): JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState('')
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(0), [renderedPage, setRenderedPage] = useState(0)
  const body = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), width = usePreviewWidth(body, Boolean(pdf)), layoutReady = usePreviewVisibility(body, Boolean(pdf))
  const disposeDocument = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false, task: PDFDocumentLoadingTask | undefined, worker: Worker | undefined, pdfWorker: PDFWorker | undefined
    setPdf(null); setError(''); setPage(1)
    const cleanup = (): void => { void task?.destroy().catch(() => {}); pdfWorker?.destroy(); worker?.terminate() }
    disposeDocument.current = cleanup
    const timer = setTimeout(() => { if (!disposed) { disposed = true; setError('此 PDF 解析时间较长，请重试或使用本机应用打开。'); cleanup() } }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      ensureMapGetOrInsertComputed()
      // Electron may lag the browser runtime APIs used by the generic PDF.js
      // bundle. The legacy build carries PDF.js' compatibility shims and must
      // be paired with its matching worker; mixing the generic and legacy
      // builds can fail only when the first page is rendered.
      const [library, source] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
      if (disposed) return
      worker = new Worker(source.default, { type: 'module', name: 'aether-document-pdf' })
      pdfWorker = library.PDFWorker.create({ port: worker })
      task = library.getDocument({ data: data.slice(0), worker: pdfWorker,
        enableXfa: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
        maxImageSize: 20_000_000, isOffscreenCanvasSupported: false, useSystemFonts: true, useWasm: false, stopAtErrors: true })
      const document = await task.promise
      if (disposed) { await task.destroy(); return }
      if (document.numPages > 1000) throw new Error('此 PDF 超出预览范围（最多 1000 页）。')
      clearTimeout(timer); setPdf(document)
    })().catch((reason: unknown) => {
      clearTimeout(timer)
      if (!disposed) setError(reason instanceof Error && reason.name === 'PasswordException' ? '此 PDF 已加密，请使用本机应用打开。' : previewErrorMessage(reason))
      cleanup()
    })
    return () => { disposed = true; clearTimeout(timer); cleanup() }
  }, [data])
  useEffect(() => {
    if (!pdf || !canvas.current || !layoutReady || error) return
    let disposed = false, rendering: RenderTask | undefined
    const target = canvas.current
    setRenderedPage(0)
    const timer = setTimeout(() => {
      disposed = true; rendering?.cancel(); disposeDocument.current()
      setError('PDF 页面绘制时间较长，请重试或使用本机应用打开。')
    }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const documentPage = await pdf.getPage(page)
      if (disposed) { documentPage.cleanup(); return }
      const natural = documentPage.getViewport({ scale: 1 })
      if (!(natural.width > 0 && natural.height > 0 && Number.isFinite(natural.width + natural.height))) throw new Error('PDF 页面的尺寸无法预览。')
      const scale = zoom || Math.min(2, Math.max(32, width - 32) / natural.width)
      const viewport = documentPage.getViewport({ scale })
      const pixels = pdfCanvasSize(viewport.width, viewport.height, devicePixelRatio || 1)
      const renderViewport = documentPage.getViewport({ scale: scale * pixels.density })
      target.width = pixels.width; target.height = pixels.height
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
      const context = target.getContext('2d')
      if (!context) throw new Error('无法准备 PDF 画布。')
      rendering = documentPage.render({ canvas: target, canvasContext: context, viewport: renderViewport })
      try { await rendering.promise; if (!disposed) setRenderedPage(page) }
      finally { documentPage.cleanup() }
    })().catch((reason: unknown) => { if (!disposed) { disposeDocument.current(); setError(previewErrorMessage(reason)) } }).finally(() => clearTimeout(timer))
    return () => { disposed = true; clearTimeout(timer); rendering?.cancel(); target.width = 0; target.height = 0 }
  }, [pdf, page, zoom, width, layoutReady, error])
  if (error) return <PreviewMessage error={error} onRetry={onRetry} />
  if (!pdf) return <PreviewMessage />
  return <>
    <PreviewPager page={page} total={pdf.numPages} onPage={setPage} zoom={zoom} onZoom={setZoom} />
    <div className="document-preview__body document-preview__body--pdf" ref={body} aria-busy={renderedPage !== page}>
      {layoutReady ? <canvas ref={canvas} aria-label={`${name} · 第 ${page} 页`} data-document-page={page} data-rendered-page={renderedPage} /> : <PreviewMessage />}
    </div>
  </>
}
