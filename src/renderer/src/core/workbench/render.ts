import { captureSessionFileTarget, readFile } from '../workspace/fs-client'
import { documentBytes } from '../../contrib/documents/document-kind'
import { passiveDocumentHtml } from '../../contrib/documents/document-html'
import { prepareOfficeArchiveOffThread } from '../../contrib/documents/office-archive-client'
import type { WorkbenchCommand } from './client'
import { renderDocxPages } from './docx-render'
import { renderXlsxDocument } from './render-xlsx'
import type { XlsxPreviewNavigation, XlsxPreviewRegion } from '../../../../shared/office-render'

type OfficeRenderFormat = 'pptx' | 'docx' | 'xlsx' | 'pdf'

// Retain only one version owned by one source/session binding. Every request
// still re-reads and hashes the actual file before it may use these pages.
interface RenderedPages { pages: string[]; regions?: XlsxPreviewRegion[]; navigation?: XlsxPreviewNavigation }
let pageCache: { key: string; format: OfficeRenderFormat; document: RenderedPages; expiresAt: number } | undefined
const MAX_PAGE_CACHE_BYTES = 32 * 1024 * 1024
const MAX_PAGES = 100

const formatForPath = (path: string): OfficeRenderFormat => {
  const match = /\.([^.]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (match === 'pptx' || match === 'docx' || match === 'xlsx' || match === 'pdf') return match
  throw new Error('当前画面检查仅支持 DOCX、XLSX、PPTX 和 PDF。')
}

async function renderPdfPages(data: ArrayBuffer, signal: AbortSignal): Promise<string[]> {
  const [library, workerSource] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  const worker = new Worker(workerSource.default, { type: 'module', name: 'aether-workbench-pdf' })
  const pdfWorker = library.PDFWorker.create({ port: worker })
  const loading = library.getDocument({ data, worker: pdfWorker, enableXfa: false, useWorkerFetch: false,
    disableAutoFetch: true, disableStream: true, maxImageSize: 20_000_000,
    isOffscreenCanvasSupported: false, useSystemFonts: true, useWasm: false, stopAtErrors: true })
  try {
    const pdf = await loading.promise
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw new Error(`PDF 页数超出 Aether 画面检查范围（最多 ${MAX_PAGES} 页）。`)
    const pages: string[] = []
    for (let index = 1; index <= pdf.numPages; index++) {
      signal.throwIfAborted()
      const page = await pdf.getPage(index)
      const natural = page.getViewport({ scale: 1 })
      const scale = Math.min(960 / natural.width, 540 / natural.height, 2)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法准备 PDF 画面画布。')
      await page.render({ canvas, canvasContext: context, viewport }).promise
      const dataUrl = canvas.toDataURL('image/png')
      pages.push(`<div class="aether-pdf-page"><img alt="PDF 第 ${index} 页" src="${dataUrl}" /></div>`)
    }
    return pages
  } finally {
    await loading.destroy().catch(() => {})
    pdfWorker.destroy()
    worker.terminate()
  }
}

async function renderPages(format: OfficeRenderFormat, data: ArrayBuffer, signal: AbortSignal): Promise<RenderedPages> {
  if (format === 'pptx') {
    const [prepared, { pptxToHtml }] = await Promise.all([
      prepareOfficeArchiveOffThread(data, 'pptx', signal), import('@jvmr/pptx-to-html'),
    ])
    const pages = await pptxToHtml(prepared, { width: 960, height: 540, scaleToFit: true, letterbox: false })
    if (!pages.length || pages.length > MAX_PAGES) throw new Error(`PPTX 页数超出 Aether 画面检查范围（最多 ${MAX_PAGES} 页）。`)
    return { pages: pages.map(passiveDocumentHtml) }
  }
  if (format === 'docx') return { pages: await renderDocxPages(data, signal) }
  if (format === 'xlsx') return renderXlsxDocument(data, signal)
  return { pages: await renderPdfPages(data, signal) }
}

export async function renderWorkbenchPage(sessionId: string, args: WorkbenchCommand['args'], current: () => boolean): Promise<Record<string, unknown>> {
  if (typeof args.path !== 'string' || !Number.isInteger(args.page) || !args.page || args.page < 1 || args.page > MAX_PAGES ||
    typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)) throw new Error('办公文件画面请求缺少文件版本或页码。')
  const format = formatForPath(args.path)
  const regionPreview = format === 'docx' || format === 'xlsx'
  const unit = regionPreview ? '预览区域' : '页'
  const assertCurrent = (): void => { if (!current()) throw new Error('会话已切换或请求已过期，本次画面作废。') }
  assertCurrent()
  const target = await captureSessionFileTarget(sessionId)
  assertCurrent()
  const file = await readFile(args.path, target)
  assertCurrent()
  if (file.truncated || file.tooLarge || !file.base64) throw new Error(`未能完整读取原始 ${format.toUpperCase()}，不能生成视觉验收画面。`)
  const data = documentBytes(file.base64, file.size)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  if (sha256 !== args.expectedHash) throw new Error('客户端读到的文件版本已变化，请重新渲染。')
  const key = JSON.stringify([target.key, args.path, sha256, format])
  if (pageCache && (pageCache.key !== key || pageCache.expiresAt < Date.now())) pageCache = undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    let rendered = pageCache?.document
    if (!rendered) {
      rendered = await renderPages(format, data, controller.signal)
      assertCurrent(); controller.signal.throwIfAborted()
      const { pages } = rendered
      if (pages.length <= MAX_PAGES && pages.reduce((size, html) => size + html.length * 2, 0) <= MAX_PAGE_CACHE_BYTES) {
        pageCache = { key, format, document: rendered, expiresAt: Date.now() + 120_000 }
      }
    }
    const { pages } = rendered
    if (!pages.length || args.page > pages.length) throw new Error(`编号超出范围，此文件有 ${pages.length}${regionPreview ? ' 个预览区域' : ' 页'}。`)
    const html = passiveDocumentHtml(pages[args.page - 1])
    if (!target.expectedEngine) throw new Error('引擎身份未就绪。')
    const image = await window.aether.office.renderPage({ html, format, sessionId, path: args.path, sha256, page: args.page,
      pageCount: pages.length, expectedEngine: target.expectedEngine })
    assertCurrent()
    return { ...image, sessionId, path: args.path, sha256, page: args.page, pageCount: pages.length,
      renderer: `aether-${format}-preview-${regionPreview ? '2.0.0' : '1.0.0'}`, mimeType: 'image/png', hasDataUrl: true,
      visualVerification: false,
      ...(rendered.navigation ? { currentRegion: rendered.regions![args.page - 1], navigation: rendered.navigation } : {}),
      description: `原始 ${format.toUpperCase()} 第 ${args.page}/${pages.length} ${unit}画面。${regionPreview ? '按原内容顺序分区，编号不是原生打印页码。' : ''}请检查布局、文字重叠、裁切与可读性，再决定验收结果。`,
      boundary: format === 'pdf'
        ? 'Aether PDF.js 画面预览，非外部 PDF 阅读器原生渲染；截图成功仅证明该版本该页已渲染。'
        : format === 'xlsx'
          ? 'Aether 表格预览，复用客户端的单元格、数字格式和图表；按内容分区，非 Excel 打印分页。复杂对象、条件格式和部分高级特性可能未显示；截图成功不代表验收通过。'
          : format === 'docx'
            ? 'Aether docx-preview 连续内容预览，分页和字体可能与 Word 不同；截图成功仅证明该版本该区段已渲染。'
            : 'Aether HTML 预览，非 PowerPoint 原生渲染；截图成功仅证明该版本该页已渲染。' }
  } finally { clearTimeout(timer); controller.abort() }
}
