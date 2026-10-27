import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { acquirePdfDocument, type PdfLease } from './pdf-preview-session'
import { cachePdfPageSize, cachedPdfPageSize, retainPdfPageBitmap, restorePdfPageBitmap } from './pdf-page-bitmap-cache'
import { DOCUMENT_LIMITS, ensureMapGetOrInsertComputed, pdfCanvasSize, previewErrorMessage } from './document-kind'
import { PreviewMessage, PreviewZoom, usePreviewVisibility, usePreviewWidth, useStablePreviewWidth } from './preview-controls'

type PdfPreviewProps = { data: ArrayBuffer; name: string; sessionKey: string; active?: boolean; onRetry?: () => void }

const PdfPage = memo(function PdfPage({ pdf, name, page, zoom, width, active, onFailure, onActive }: {
  pdf: PDFDocumentProxy; name: string; page: number; zoom: number; width: number; active: boolean
  onFailure: (error: string) => void; onActive: (page: number) => void
}): JSX.Element {
  const shell = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const pageRequest = useRef(0)
  const [near, setNear] = useState(page <= 2), [natural, setNatural] = useState(() => cachedPdfPageSize(pdf, page) ?? { width: 0, height: 0 }), [rendered, setRendered] = useState(0)
  const renderKey = `${zoom}:${width}`
  const snapshotKey = useRef('')
  const renderedKey = useRef('')
  useEffect(() => {
    const element = shell.current
    if (!element || !active) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        setNear(entry.isIntersecting)
        if (entry.isIntersecting && entry.intersectionRatio >= 0.4) onActive(page)
      }
    }, { root: element.closest('.document-preview__body'), rootMargin: '700px 0px', threshold: [0, 0.4] })
    observer.observe(element)
    return () => observer.disconnect()
  }, [page, onActive, active])
  useEffect(() => {
    if (natural.width) return
    let disposed = false
    const request = ++pageRequest.current
    void pdf.getPage(page).then(value => {
      if (disposed || request !== pageRequest.current) return
      const viewport = value.getViewport({ scale: 1 })
      if (!(viewport.width > 0 && viewport.height > 0 && Number.isFinite(viewport.width + viewport.height))) throw new Error('PDF 页面的尺寸无法预览。')
      setNatural({ width: viewport.width, height: viewport.height })
      cachePdfPageSize(pdf, page, { width: viewport.width, height: viewport.height })
    }).catch((reason: unknown) => { if (!disposed) onFailure(previewErrorMessage(reason)) })
    return () => { disposed = true; pageRequest.current++; renderedKey.current = '' }
  }, [pdf, page, onFailure, natural.width])
  useLayoutEffect(() => {
    const target = canvas.current
    if (!target || !renderedKey.current || !near || snapshotKey.current === renderedKey.current) return
    snapshotKey.current = renderedKey.current
    retainPdfPageBitmap(pdf, page, target, renderedKey.current)
  })
  useEffect(() => {
    if (!active || !near || !natural.width || (!zoom && !width)) return
    const target = canvas.current
    const scale = zoom || Math.min(2, Math.max(32, width - 32) / natural.width)
    if (target && restorePdfPageBitmap(pdf, page, target, renderKey)) {
      renderedKey.current = renderKey
      target.style.width = `${natural.width * scale}px`
      target.style.height = `${natural.height * scale}px`
      setRendered(page)
    }
  }, [active, near, pdf, page, natural.width, natural.height, zoom, width, renderKey])
  useEffect(() => {
    const target = canvas.current
    if (near || !target) return
    target.width = 0
    target.height = 0
    renderedKey.current = ''
    setRendered(0)
  }, [near])
  useEffect(() => {
    const target = canvas.current
    if (!active || !near || !natural.width || (!zoom && !width) || !target || renderedKey.current === renderKey) return
    let disposed = false, rendering: RenderTask | undefined
    const timer = setTimeout(() => { disposed = true; rendering?.cancel(); onFailure('PDF 页面绘制超时，原文件已保留。') }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const documentPage = await pdf.getPage(page)
      if (disposed) return
      const scale = zoom || Math.min(2, Math.max(32, width - 32) / natural.width)
      const viewport = documentPage.getViewport({ scale })
      const pixels = pdfCanvasSize(viewport.width, viewport.height, devicePixelRatio || 1)
      const renderViewport = documentPage.getViewport({ scale: scale * pixels.density })
      target.width = pixels.width; target.height = pixels.height
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
      const context = target.getContext('2d')
      if (!context) throw new Error('无法准备 PDF 画布。')
      rendering = documentPage.render({ canvas: target, canvasContext: context, viewport: renderViewport })
      await rendering.promise
      if (!disposed) { renderedKey.current = renderKey; setRendered(page) }
    })().catch((reason: unknown) => {
      if (!disposed && (!(reason instanceof Error) || reason.name !== 'RenderingCancelledException')) onFailure(previewErrorMessage(reason))
    }).finally(() => clearTimeout(timer))
    return () => { disposed = true; clearTimeout(timer); rendering?.cancel() }
  }, [pdf, page, zoom, width, natural.width, natural.height, near, active, renderKey, onFailure])
  const scale = natural.width ? zoom || Math.min(2, Math.max(32, width - 32) / natural.width) : 1
  const size = { width: natural.width * scale, height: natural.height * scale }
  const shellStyle: CSSProperties = { width: size.width || undefined, height: size.height || undefined }
  return <div className="document-preview__pdf-shell" ref={shell} style={shellStyle} data-document-page={page}>
    <canvas aria-label={`${name} · 第 ${page} 页`} data-rendered-page={rendered} ref={canvas} />
  </div>
})

export default function PdfDocumentPreview({ data, name, sessionKey, active = true, onRetry }: PdfPreviewProps): JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState('')
  const [zoom, setZoom] = useState(0)
  const [source, setSource] = useState(data)
  if (source !== data) { setSource(data); setPdf(null); setError('') }
  const body = useRef<HTMLDivElement>(null)
  const width = usePreviewWidth(body, Boolean(pdf) && active), layoutReady = usePreviewVisibility(body, Boolean(pdf)), stableWidth = useStablePreviewWidth(width)
  const disposeDocument = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false
    const loadingCleanup = { current: () => {} }
    let lease: PdfLease | undefined
    disposeDocument.current = () => { disposed = true; lease?.release(true); loadingCleanup.current() }
    const timer = setTimeout(() => { if (!disposed) { setError('此 PDF 解析超时，原文件已保留。'); disposeDocument.current() } }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      ensureMapGetOrInsertComputed()
      const [library, source] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
      if (disposed) return
      lease = await acquirePdfDocument(sessionKey, data, async bytes => {
        if (disposed) throw new Error('PDF 预览已关闭。')
        const worker = new Worker(source.default, { type: 'module', name: 'aether-document-pdf' }), pdfWorker = library.PDFWorker.create({ port: worker })
        const task = library.getDocument({ data: bytes, worker: pdfWorker, enableXfa: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
          maxImageSize: 20_000_000, isOffscreenCanvasSupported: false, useSystemFonts: true, useWasm: false, stopAtErrors: true })
        const destroy = (): void => { void task.destroy().catch(() => {}); pdfWorker.destroy(); worker.terminate() }
        loadingCleanup.current = destroy
        try {
          const document = await task.promise
          if (disposed) { destroy(); throw new Error('PDF 预览已关闭。') }
          loadingCleanup.current = () => {}
          return { document, destroy }
        } catch (error) { destroy(); throw error }
      })
      if (disposed) { lease.release(); return }
      clearTimeout(timer); setPdf(lease.document)
    })().catch((reason: unknown) => {
      clearTimeout(timer)
      if (!disposed) setError(reason instanceof Error && reason.name === 'PasswordException' ? '此 PDF 已加密，Aether 暂不支持密码文档预览。' : previewErrorMessage(reason))
      lease?.release(true); loadingCleanup.current()
    })
    return () => { disposed = true; clearTimeout(timer); lease?.release(); loadingCleanup.current() }
  }, [data, sessionKey])
  const failure = useCallback((message: string) => { setError(message); disposeDocument.current() }, [])
  const onPageActive = useCallback(() => {}, [])
  if (error) return <PreviewMessage error={error} onRetry={onRetry} />
  if (!pdf) return <PreviewMessage />
  return <>
    <div className="document-preview__toolbar document-preview__toolbar--pdf-tools">
      <PreviewZoom zoom={zoom} onZoom={setZoom} />
      <span className="document-preview__page-label">{pdf.numPages} 页 · 连续滚动</span>
    </div>
    <div className="document-preview__body document-preview__body--pdf document-preview__body--continuous" ref={body} data-document-pages={pdf.numPages}>
      {layoutReady ? Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index + 1} pdf={pdf} name={name} page={index + 1} zoom={zoom} width={stableWidth} active={active}
        onFailure={failure} onActive={onPageActive} />) : <PreviewMessage />}
    </div>
  </>
}
