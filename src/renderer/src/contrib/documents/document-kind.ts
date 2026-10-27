export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx'

export const DOCUMENT_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  xmlBytes: 16 * 1024 * 1024,
  entries: 1200,
  // XML has a base budget plus one element per stored cell. Style-heavy sheets
  // can still use the base, while arbitrary element bombs cannot turn a cell
  // increase into an unlimited DOM parse.
  xmlElements: 200_000,
  xmlElementsPerCell: 4,
  pages: 100,
  sheets: 24,
  rows: 50_000,
  columns: 256,
  cells: 500_000,
  imagePixels: 32_000_000,
  totalImagePixels: 64_000_000,
  previewImageEdge: 1920,
  previewImagePixels: 4_000_000,
  previewImageBytes: 2 * 1024 * 1024,
  // Data URLs expand the allowed 16 MB Office input by at least 4/3. Keep a
  // separate, bounded rendered-HTML budget instead of rejecting valid images.
  htmlBytes: 32 * 1024 * 1024,
  domNodes: 50_000,
  canvasPixels: 8_000_000,
  parseTimeoutMs: 30_000
})

/**
 * pdfjs-dist 6 uses the proposed Map#getOrInsertComputed API while rendering.
 * Electron can ship a Chromium version without that proposal, so provide the
 * small spec-compatible operation before loading pdfjs. Keeping this local to
 * the renderer avoids changing the global application behavior for other code.
 */
export function ensureMapGetOrInsertComputed(): void {
  type CompatibleMap = Map<unknown, unknown> & {
    getOrInsertComputed?: (key: unknown, callback: () => unknown) => unknown
  }
  const prototype = Map.prototype as CompatibleMap
  if (prototype.getOrInsertComputed) return
  Object.defineProperty(prototype, 'getOrInsertComputed', {
    configurable: true,
    writable: true,
    value(this: Map<unknown, unknown>, key: unknown, callback: () => unknown): unknown {
      if (this.has(key)) return this.get(key)
      const value = callback()
      this.set(key, value)
      return value
    }
  })
}

export function documentKindFor(name: string): DocumentKind | null {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return extension === 'pdf' || extension === 'docx' || extension === 'xlsx' || extension === 'pptx' ? extension : null
}

export function documentBytes(base64: string, size: number): ArrayBuffer {
  if (!Number.isSafeInteger(size) || size < 1 || size > DOCUMENT_LIMITS.inputBytes ||
    base64.length > Math.ceil(DOCUMENT_LIMITS.inputBytes / 3) * 4) {
    throw new Error('此文件超出 Aether 当前预览范围（最大 16 MB），原文件已保留。')
  }
  const binary = atob(base64)
  if (binary.length !== size) throw new Error('文件内容不完整，请重新读取后再试。')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function spreadsheetColumn(index: number): string {
  let text = ''
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) text = String.fromCharCode(65 + (value - 1) % 26) + text
  return text
}

export function previewErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : ''
  // Parser diagnostics are not a user-facing recovery instruction.
  return /^(?:此文件|此文档|此 PDF|文件结构|文件内容|文档版面|工作簿超出|所选表格区域|PDF 页面)/.test(message)
    ? message.slice(0, 240) : 'Aether 暂时无法解析此文档，原文件已保留。'
}

export function pdfCanvasSize(width: number, height: number, deviceScale: number): { width: number; height: number; density: number } {
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) throw new Error('PDF 页面的尺寸无法预览。')
  const density = Math.min(Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1, 2,
    Math.sqrt(DOCUMENT_LIMITS.canvasPixels / (width * height)), 16384 / Math.max(width, height))
  const pixelWidth = Math.max(1, Math.floor(width * density)), pixelHeight = Math.max(1, Math.floor(height * density))
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > DOCUMENT_LIMITS.canvasPixels) throw new Error('PDF 页面的尺寸超出预览范围。')
  return { width: pixelWidth, height: pixelHeight, density }
}
