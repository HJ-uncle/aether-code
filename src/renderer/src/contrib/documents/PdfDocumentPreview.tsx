import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFWorker, RenderTask } from 'pdfjs-dist'
import { DOCUMENT_LIMITS, ensureMapGetOrInsertComputed, pdfCanvasSize, previewErrorMessage } from './document-kind'
import { PreviewMessage, PreviewPager, usePreviewVisibility, usePreviewWidth } from './preview-controls'

type PdfEditTool = 'none' | 'text' | 'highlight' | 'ink'
type Point = { x: number; y: number }
type PdfAnnotation =
  | { page: number; kind: 'text'; x: number; y: number; text: string }
  | { page: number; kind: 'highlight'; x: number; y: number; width: number; height: number }
  | { page: number; kind: 'ink'; points: Point[] }
type DraftText = { x: number; y: number; value: string } | null

type PdfPreviewProps = { data: ArrayBuffer; name: string; onRetry?: () => void }

function basenameWithoutExtension(name: string): string {
  const clean = name.replace(/\\/g, '/').split('/').pop() || 'document.pdf'
  return clean.replace(/\.pdf$/i, '') || 'document'
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * pdf-lib's built-in Helvetica font is WinAnsi-only.  Rendering non-Latin
 * text into a small PNG keeps Chinese/Japanese/Korean annotations usable
 * without shipping a large font or corrupting the source PDF.
 */
async function rasterizeText(text: string): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境无法准备文字批注。')
  const lines = text.split(/\r?\n/).flatMap(line => {
    const chunks: string[] = []
    for (let offset = 0; offset < Math.max(1, line.length); offset += 36) chunks.push(line.slice(offset, offset + 36) || ' ')
    return chunks
  }).slice(0, 30)
  const font = '14px sans-serif', lineHeight = 20, padding = 6
  context.font = font
  const width = Math.max(80, Math.min(560, Math.ceil(Math.max(...lines.map(line => context.measureText(line).width), 0)) + padding * 2))
  const height = Math.max(lineHeight + padding * 2, lines.length * lineHeight + padding * 2)
  const scale = 2
  canvas.width = width * scale; canvas.height = height * scale
  context.scale(scale, scale)
  context.font = font; context.textBaseline = 'top'; context.fillStyle = '#1b1b1b'
  lines.forEach((line, index) => context.fillText(line, padding, padding + index * lineHeight))
  const encoded = canvas.toDataURL('image/png').split(',')[1]
  if (!encoded) throw new Error('无法生成文字批注图像。')
  const binary = atob(encoded), bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return { bytes, width, height }
}

export default function PdfDocumentPreview({ data, name, onRetry }: PdfPreviewProps): JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState('')
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(0), [renderedPage, setRenderedPage] = useState(0)
  const [tool, setTool] = useState<PdfEditTool>('none')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [draft, setDraft] = useState<DraftText>(null)
  const [drawing, setDrawing] = useState<Point[]>([])
  const [saving, setSaving] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const body = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), pageShell = useRef<HTMLDivElement>(null)
  const width = usePreviewWidth(body, Boolean(pdf)), layoutReady = usePreviewVisibility(body, Boolean(pdf))
  const disposeDocument = useRef<() => void>(() => {})

  useEffect(() => {
    let disposed = false, task: PDFDocumentLoadingTask | undefined, worker: Worker | undefined, pdfWorker: PDFWorker | undefined
    setPdf(null); setError(''); setPage(1); setTool('none'); setAnnotations([]); setDraft(null); setSaveNotice('')
    const cleanup = (): void => { void task?.destroy().catch(() => {}); pdfWorker?.destroy(); worker?.terminate() }
    disposeDocument.current = cleanup
    const timer = setTimeout(() => { if (!disposed) { disposed = true; setError('此 PDF 解析超时，原文件已保留。'); cleanup() } }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      ensureMapGetOrInsertComputed()
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
      if (!disposed) setError(reason instanceof Error && reason.name === 'PasswordException' ? '此 PDF 已加密，Aether 暂不支持密码文档预览。' : previewErrorMessage(reason))
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
      setError('PDF 页面绘制超时，原文件已保留。')
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
      setPageSize({ width: viewport.width, height: viewport.height })
      const context = target.getContext('2d')
      if (!context) throw new Error('无法准备 PDF 画布。')
      rendering = documentPage.render({ canvas: target, canvasContext: context, viewport: renderViewport })
      try { await rendering.promise; if (!disposed) setRenderedPage(page) }
      finally { documentPage.cleanup() }
    })().catch((reason: unknown) => { if (!disposed) { disposeDocument.current(); setError(previewErrorMessage(reason)) } }).finally(() => clearTimeout(timer))
    return () => { disposed = true; clearTimeout(timer); rendering?.cancel(); target.width = 0; target.height = 0 }
  }, [pdf, page, zoom, width, layoutReady, error])

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>): Point | null => {
    const rect = pageShell.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }, [])
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool !== 'ink') return
    const point = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrawing([point])
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool !== 'ink' || drawing.length === 0) return
    const point = pointFromEvent(event)
    if (point) setDrawing(previous => [...previous, point])
  }
  const finishDrawing = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool !== 'ink' || drawing.length < 2) { setDrawing([]); return }
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* pointer may already be released */ }
    setAnnotations(previous => [...previous, { page, kind: 'ink', points: drawing }])
    setDrawing([])
  }
  const onPageClick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool === 'text') {
      const point = pointFromEvent(event)
      if (point) setDraft({ x: point.x, y: point.y, value: '' })
    } else if (tool === 'highlight') {
      const point = pointFromEvent(event)
      if (point) setAnnotations(previous => [...previous, { page, kind: 'highlight', x: point.x, y: point.y, width: 0.28, height: 0.045 }])
    }
  }
  const commitDraft = (): void => {
    if (!draft?.value.trim()) { setDraft(null); return }
    setAnnotations(previous => [...previous, { page, kind: 'text', x: draft.x, y: draft.y, text: draft.value.trim() }])
    setDraft(null)
  }
  const saveEditedPdf = async (): Promise<void> => {
    if (!pdf || annotations.length === 0 || saving) return
    setSaving(true); setSaveNotice('')
    try {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
      const edited = await PDFDocument.load(data.slice(0), { ignoreEncryption: false })
      const font = await edited.embedFont(StandardFonts.Helvetica)
      for (const annotation of annotations) {
        const targetPage = edited.getPage(annotation.page - 1)
        const { width: pdfWidth, height: pdfHeight } = targetPage.getSize()
        if (annotation.kind === 'text') {
          const needsImage = [...annotation.text].some(character => (character.codePointAt(0) ?? 0) > 255)
          if (needsImage) {
            const raster = await rasterizeText(annotation.text)
            const image = await edited.embedPng(raster.bytes)
            const imageWidth = Math.min(pdfWidth * 0.8, Math.max(40, raster.width * 0.75))
            const imageHeight = imageWidth * raster.height / raster.width
            targetPage.drawImage(image, { x: annotation.x * pdfWidth, y: pdfHeight - annotation.y * pdfHeight - imageHeight, width: imageWidth, height: imageHeight })
          } else {
            targetPage.drawText(annotation.text, { x: annotation.x * pdfWidth, y: pdfHeight - annotation.y * pdfHeight - 14, size: 14, font, color: rgb(0.1, 0.1, 0.1), maxWidth: pdfWidth * 0.8 })
          }
        } else if (annotation.kind === 'highlight') {
          targetPage.drawRectangle({ x: annotation.x * pdfWidth, y: pdfHeight - (annotation.y + annotation.height) * pdfHeight,
            width: annotation.width * pdfWidth, height: annotation.height * pdfHeight, color: rgb(1, 0.88, 0.1), opacity: 0.38, borderWidth: 0 })
        } else if (annotation.points.length > 1) {
          for (let index = 1; index < annotation.points.length; index += 1) {
            const from = annotation.points[index - 1], to = annotation.points[index]
            targetPage.drawLine({ start: { x: from.x * pdfWidth, y: pdfHeight - from.y * pdfHeight }, end: { x: to.x * pdfWidth, y: pdfHeight - to.y * pdfHeight }, thickness: 2, color: rgb(0.1, 0.35, 0.9), opacity: 0.9 })
          }
        }
      }
      const bytes = await edited.save()
      downloadBytes(bytes, `${basenameWithoutExtension(name)}-edited.pdf`)
      setSaveNotice('已保存编辑后的 PDF 副本，原文件保持不变。')
      setTool('none')
    } catch (reason: unknown) {
      setSaveNotice(reason instanceof Error ? `保存失败：${reason.message}` : `保存失败：${String(reason)}`)
    } finally { setSaving(false) }
  }

  if (error) return <PreviewMessage error={error} onRetry={onRetry} />
  if (!pdf) return <PreviewMessage />
  const currentAnnotations = annotations.filter(annotation => annotation.page === page)
  const shellStyle: CSSProperties = { width: pageSize.width || undefined, height: pageSize.height || undefined }
  return <>
    <PreviewPager page={page} total={pdf.numPages} onPage={setPage} zoom={zoom} onZoom={setZoom} />
    <div className="document-preview__toolbar document-preview__toolbar--pdf-edit" role="group" aria-label="PDF 编辑工具">
      <span className="document-preview__edit-label">编辑 PDF</span>
      <button type="button" aria-pressed={tool === 'text'} onClick={() => { setTool(tool === 'text' ? 'none' : 'text'); setDraft(null) }}>文字</button>
      <button type="button" aria-pressed={tool === 'highlight'} onClick={() => setTool(tool === 'highlight' ? 'none' : 'highlight')}>高亮</button>
      <button type="button" aria-pressed={tool === 'ink'} onClick={() => setTool(tool === 'ink' ? 'none' : 'ink')}>画笔</button>
      <button type="button" onClick={() => setAnnotations([])} disabled={annotations.length === 0}>清空</button>
      <button type="button" onClick={() => void saveEditedPdf()} disabled={annotations.length === 0 || saving}>{saving ? '保存中…' : '另存为 PDF'}</button>
      <span className="document-preview__edit-hint">{tool === 'none' ? '原正文保持不变，可添加批注后另存为' : tool === 'text' ? '点击页面输入文字' : tool === 'highlight' ? '点击页面添加高亮' : '按住鼠标绘制'}</span>
      {saveNotice && <span className="document-preview__edit-notice" role="status">{saveNotice}</span>}
    </div>
    <div className="document-preview__body document-preview__body--pdf" ref={body} aria-busy={renderedPage !== page}>
      {layoutReady ? <div className="document-preview__pdf-shell" ref={pageShell} style={shellStyle}>
        <canvas aria-label={`${name} · 第 ${page} 页`} data-document-page={page} data-rendered-page={renderedPage} ref={canvas} />
        <div className={`document-preview__pdf-overlay${tool === 'none' ? ' document-preview__pdf-overlay--readonly' : ''}`} role="application" aria-label="PDF 编辑画布"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishDrawing} onClick={onPageClick}>
          {currentAnnotations.map((annotation, index) => annotation.kind === 'text' ? <span key={`${index}-${annotation.x}`} className="document-preview__pdf-annotation document-preview__pdf-annotation--text" style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}>{annotation.text}</span> : annotation.kind === 'highlight' ? <span key={`${index}-${annotation.x}`} className="document-preview__pdf-annotation document-preview__pdf-annotation--highlight" style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%`, width: `${annotation.width * 100}%`, height: `${annotation.height * 100}%` }} /> : <svg key={`${index}-${annotation.points[0]?.x}`} className="document-preview__pdf-annotation document-preview__pdf-annotation--ink" viewBox="0 0 1 1" preserveAspectRatio="none"><polyline points={annotation.points.map(point => `${point.x},${point.y}`).join(' ')} /></svg>)}
          {drawing.length > 1 && <svg className="document-preview__pdf-annotation document-preview__pdf-annotation--ink" viewBox="0 0 1 1" preserveAspectRatio="none"><polyline points={drawing.map(point => `${point.x},${point.y}`).join(' ')} /></svg>}
          {draft && <input autoFocus className="document-preview__pdf-draft" value={draft.value} placeholder="输入文字，按 Enter 完成" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} onChange={event => setDraft({ ...draft, value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitDraft() } if (event.key === 'Escape') setDraft(null) }} onBlur={commitDraft} onClick={event => event.stopPropagation()} />}
        </div>
      </div> : <PreviewMessage />}
    </div>
  </>
}
