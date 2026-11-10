import ExcelJS from 'exceljs'
import { captureSessionFileTarget, readFile } from '../workspace/fs-client'
import { documentBytes } from '../../contrib/documents/document-kind'
import { passiveDocumentHtml } from '../../contrib/documents/document-html'
import { prepareOfficeArchiveOffThread } from '../../contrib/documents/office-archive-client'
import type { WorkbenchCommand } from './client'

type OfficeRenderFormat = 'pptx' | 'docx' | 'xlsx' | 'pdf'

// Retain only one version owned by one source/session binding. Every request
// still re-reads and hashes the actual file before it may use these pages.
let pageCache: { key: string; format: OfficeRenderFormat; pages: string[]; expiresAt: number } | undefined
const MAX_PAGE_CACHE_BYTES = 32 * 1024 * 1024
const MAX_PAGES = 100

const formatForPath = (path: string): OfficeRenderFormat => {
  const match = /\.([^.]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (match === 'pptx' || match === 'docx' || match === 'xlsx' || match === 'pdf') return match
  throw new Error('当前画面检查仅支持 DOCX、XLSX、PPTX 和 PDF。')
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character))

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

async function renderDocxPages(data: ArrayBuffer, signal: AbortSignal): Promise<string[]> {
  const [prepared, { parseAsync, renderDocument }] = await Promise.all([
    prepareOfficeArchiveOffThread(data, 'docx', signal), import('docx-preview'),
  ])
  const options = { inWrapper: false, ignoreFonts: true, useBase64URL: true,
    renderAltChunks: false, renderComments: false, experimental: false,
    breakPages: true, ignoreLastRenderedPageBreak: false }
  const model = await parseAsync(prepared, options)
  signal.throwIfAborted()
  const nodes = await renderDocument(model, options)
  const style = nodes.filter((node): node is HTMLStyleElement => node instanceof HTMLStyleElement)
    .map(node => node.outerHTML).join('')
  const pages = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'SECTION')
    .map(node => passiveDocumentHtml(`${style}<div style="width:960px;height:540px;overflow:hidden;background:white"><div style="transform:scale(.5);transform-origin:top left">${node.outerHTML}</div></div>`))
  if (!pages.length || pages.length > MAX_PAGES) throw new Error(`DOCX 页数超出 Aether 画面检查范围（最多 ${MAX_PAGES} 页）。`)
  return pages
}

async function renderXlsxPages(data: ArrayBuffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data, { ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting', 'dataValidations'] })
  if (workbook.worksheets.length < 1) throw new Error('XLSX 没有可检查的工作表。')
  const pages: string[] = [], rowChunk = 48, columnChunk = 20
  for (const sheet of workbook.worksheets) {
    const rowCount = Math.max(1, sheet.rowCount), columnCount = Math.max(1, sheet.columnCount)
    for (let rowStart = 1; rowStart <= rowCount; rowStart += rowChunk) {
      for (let columnStart = 1; columnStart <= columnCount; columnStart += columnChunk) {
        if (pages.length >= MAX_PAGES) throw new Error(`XLSX 画面检查范围超过 ${MAX_PAGES} 个表格区域，请缩小工作簿后重试。`)
        const rows = Math.min(rowChunk, rowCount - rowStart + 1), columns = Math.min(columnChunk, columnCount - columnStart + 1)
        const header = `<style>.aether-sheet-page{width:960px;height:500px;overflow:hidden;padding:16px;box-sizing:border-box;background:white;color:#1f2937;font:12px/1.35 system-ui,sans-serif}.aether-sheet-page table{border-collapse:collapse;table-layout:fixed;width:100%}.aether-sheet-page td{border:1px solid #d1d5db;padding:4px 6px;max-width:180px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.aether-sheet-page tr:first-child td{font-weight:600;background:#f3f4f6}.aether-sheet-heading{padding:8px 16px;background:#f8fafc;color:#475569;font:12px system-ui,sans-serif}.aether-sheet-heading span{margin-left:12px;color:#64748b}</style><div class="aether-sheet-heading"><strong>${escapeHtml(sheet.name)}</strong><span>第 ${rowStart}-${rowStart + rows - 1} 行 · 第 ${columnStart}-${columnStart + columns - 1} 列</span></div>`
        const body = Array.from({ length: rows }, (_, rowIndex) => {
          const cells = Array.from({ length: columns }, (_, columnIndex) => {
            const cell = sheet.getCell(rowStart + rowIndex, columnStart + columnIndex)
            const text = cell.text || (cell.value === null || cell.value === undefined ? '' : String(cell.value))
            return `<td>${escapeHtml(text)}</td>`
          }).join('')
          return `<tr>${cells}</tr>`
        }).join('')
        pages.push(passiveDocumentHtml(`${header}<div class="aether-sheet-page"><table><tbody>${body}</tbody></table></div>`))
      }
    }
  }
  return pages
}

async function renderPages(format: OfficeRenderFormat, data: ArrayBuffer, signal: AbortSignal): Promise<string[]> {
  if (format === 'pptx') {
    const [prepared, { pptxToHtml }] = await Promise.all([
      prepareOfficeArchiveOffThread(data, 'pptx', signal), import('@jvmr/pptx-to-html'),
    ])
    const pages = await pptxToHtml(prepared, { width: 960, height: 540, scaleToFit: true, letterbox: false })
    if (!pages.length || pages.length > MAX_PAGES) throw new Error(`PPTX 页数超出 Aether 画面检查范围（最多 ${MAX_PAGES} 页）。`)
    return pages.map(passiveDocumentHtml)
  }
  if (format === 'docx') return renderDocxPages(data, signal)
  if (format === 'xlsx') return renderXlsxPages(data)
  return renderPdfPages(data, signal)
}

export async function renderWorkbenchPage(sessionId: string, args: WorkbenchCommand['args'], current: () => boolean): Promise<Record<string, unknown>> {
  if (typeof args.path !== 'string' || !Number.isInteger(args.page) || !args.page || args.page < 1 || args.page > MAX_PAGES ||
    typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)) throw new Error('办公文件画面请求缺少文件版本或页码。')
  const format = formatForPath(args.path)
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
    let pages = pageCache?.pages
    if (!pages) {
      pages = await renderPages(format, data, controller.signal)
      assertCurrent(); controller.signal.throwIfAborted()
      if (pages.length <= MAX_PAGES && pages.reduce((size, html) => size + html.length * 2, 0) <= MAX_PAGE_CACHE_BYTES) {
        pageCache = { key, format, pages, expiresAt: Date.now() + 120_000 }
      }
    }
    if (!pages.length || args.page > pages.length) throw new Error(`页码超出范围，此文件有 ${pages.length} 页。`)
    const html = passiveDocumentHtml(pages[args.page - 1])
    if (!target.expectedEngine) throw new Error('引擎身份未就绪。')
    const image = await window.aether.office.renderPage({ html, format, sessionId, path: args.path, sha256, page: args.page,
      pageCount: pages.length, expectedEngine: target.expectedEngine })
    assertCurrent()
    return { ...image, sessionId, path: args.path, sha256, page: args.page, pageCount: pages.length,
      renderer: `aether-${format}-preview-1.0.0`, mimeType: 'image/png', hasDataUrl: true,
      visualVerification: false,
      description: `原始 ${format.toUpperCase()} 第 ${args.page}/${pages.length} 页画面。请检查布局、文字重叠、裁切与可读性，再决定验收结果。`,
      boundary: format === 'pdf'
        ? 'Aether PDF.js 画面预览，非外部 PDF 阅读器原生渲染；截图成功仅证明该版本该页已渲染。'
        : format === 'xlsx'
          ? 'Aether ExcelJS 表格预览，复杂对象、条件格式和部分高级 Excel 特性可能未显示；截图成功仅证明该版本该表已渲染。'
          : format === 'docx'
            ? 'Aether docx-preview 连续内容预览，分页和字体可能与 Word 不同；截图成功仅证明该版本该区段已渲染。'
            : 'Aether HTML 预览，非 PowerPoint 原生渲染；截图成功仅证明该版本该页已渲染。' }
  } finally { clearTimeout(timer); controller.abort() }
}
