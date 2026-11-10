import { captureSessionFileTarget, readFile } from '../workspace/fs-client'
import { documentBytes } from '../../contrib/documents/document-kind'
import { passiveDocumentHtml } from '../../contrib/documents/document-html'
import { prepareOfficeArchiveOffThread } from '../../contrib/documents/office-archive-client'
import type { WorkbenchCommand } from './client'

// Retain only one version owned by one source/session binding. Every request
// still re-reads and hashes the actual file before it may use these pages.
let pageCache: { key: string; pages: string[]; expiresAt: number } | undefined
const MAX_PAGE_CACHE_BYTES = 32 * 1024 * 1024

export async function renderWorkbenchPage(sessionId: string, args: WorkbenchCommand['args'], current: () => boolean): Promise<Record<string, unknown>> {
  if (typeof args.path !== 'string' || !/\.pptx$/i.test(args.path) || !Number.isInteger(args.page) || !args.page || args.page < 1 || args.page > 100 ||
    typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)) throw new Error('幻灯片画面请求缺少文件版本或页码。')
  const assertCurrent = (): void => { if (!current()) throw new Error('会话已切换或请求已过期，本次画面作废。') }
  assertCurrent()
  const target = await captureSessionFileTarget(sessionId)
  assertCurrent()
  const file = await readFile(args.path, target)
  assertCurrent()
  if (file.truncated || file.tooLarge || !file.base64) throw new Error('未能完整读取原始 PPTX，不能生成视觉验收画面。')
  const data = documentBytes(file.base64, file.size)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  if (sha256 !== args.expectedHash) throw new Error('客户端读到的文件版本已变化，请重新渲染。')
  const key = JSON.stringify([target.key, args.path, sha256])
  if (pageCache && (pageCache.key !== key || pageCache.expiresAt < Date.now())) pageCache = undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    let pages = pageCache?.pages
    if (!pages) {
      const [prepared, { pptxToHtml }] = await Promise.all([
        prepareOfficeArchiveOffThread(data, 'pptx', controller.signal), import('@jvmr/pptx-to-html')])
      assertCurrent(); controller.signal.throwIfAborted()
      // This is exactly the original-PPTX parser used by OfficeDocumentPreview,
      // not a new layout inferred from extracted slide text.
      pages = await pptxToHtml(prepared, { width: 960, height: 540, scaleToFit: true, letterbox: false })
      assertCurrent(); controller.signal.throwIfAborted()
      if (pages.length <= 100 && pages.reduce((size, html) => size + html.length * 2, 0) <= MAX_PAGE_CACHE_BYTES) {
        pages = pages.map(passiveDocumentHtml)
        pageCache = { key, pages, expiresAt: Date.now() + 120_000 }
      }
    }
    if (!pages.length || pages.length > 100 || args.page > pages.length) throw new Error(`页码超出范围，此文件有 ${pages.length} 页。`)
    const html = passiveDocumentHtml(pages[args.page - 1])
    if (!target.expectedEngine) throw new Error('引擎身份未就绪。')
    const image = await window.aether.office.renderPage({ html, sessionId, path: args.path, sha256, page: args.page,
      pageCount: pages.length, expectedEngine: target.expectedEngine })
    assertCurrent()
    return { ...image, sessionId, path: args.path, sha256, page: args.page, pageCount: pages.length,
      renderer: 'aether-pptx-to-html-1.1.2', mimeType: 'image/png', hasDataUrl: true,
      visualVerification: false,
      description: `原始 PPTX 第 ${args.page}/${pages.length} 页画面。请检查布局、文字重叠、裁切与可读性，再决定验收结果。`,
      boundary: 'Aether 原文件预览（Chromium + pptx-to-html），非 PowerPoint 原生渲染；不支持动画、SmartArt、嵌入字体及部分高级图形。固定960×540，非16:9原稿会缩放至16:9。截图成功仅证明该版本该页已渲染，不代表视觉验收通过。' }
  } finally { clearTimeout(timer); controller.abort() }
}
