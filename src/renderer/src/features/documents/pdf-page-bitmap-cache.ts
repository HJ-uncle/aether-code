const MAX_RETAINED_PAGES = 12
export const PDF_BITMAP_CACHE_BYTES = 64 * 1024 * 1024
const pageSizes = new WeakMap<object, Map<number, { width: number; height: number }>>()
const documentKeys = new WeakMap<object, number>()
let documentSequence = 0
interface BitmapEntry { canvas: HTMLCanvasElement; renderKey: string; bytes: number }
const retained = new Map<string, BitmapEntry>()
let retainedBytes = 0

function removeBitmap(key: string): void {
  const entry = retained.get(key)
  if (!entry) return
  retained.delete(key)
  retainedBytes -= entry.bytes
  // Release the backing pixel store now rather than waiting for canvas GC.
  entry.canvas.width = 0
  entry.canvas.height = 0
}

function bitmapKey(source: object | string, page: number): string {
  if (typeof source === 'string') return `${source}:${page}`
  let key = documentKeys.get(source)
  if (!key) { key = ++documentSequence; documentKeys.set(source, key) }
  return `${key}:${page}`
}

/** Pixel snapshots outlive a Work tab's React subtree, but not the bounded cache.
 * Restoring a bitmap does not consume it: nearby pages remain cheap to revisit. */
export function retainPdfPageBitmap(source: object | string, page: number, canvas: HTMLCanvasElement, renderKey: string): void {
  if (!canvas.width || !canvas.height) return
  const bytes = canvas.width * canvas.height * 4
  if (!Number.isSafeInteger(bytes) || bytes > PDF_BITMAP_CACHE_BYTES) return
  const key = bitmapKey(source, page)
  const current = retained.get(key)
  if (current?.renderKey === renderKey && current.canvas.width === canvas.width && current.canvas.height === canvas.height) {
    retained.delete(key); retained.set(key, current)
    return
  }
  removeBitmap(key)
  // Evict before allocating: both retained and transient snapshot pixels obey
  // the byte budget, independently of the separate live page canvas.
  for (const oldest of retained.keys()) {
    if (retained.size < MAX_RETAINED_PAGES && retainedBytes + bytes <= PDF_BITMAP_CACHE_BYTES) break
    removeBitmap(oldest)
  }
  const copy = document.createElement('canvas')
  try {
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext('2d')
    if (!context) { copy.width = 0; copy.height = 0; return }
    context.drawImage(canvas, 0, 0)
  } catch {
    // A best-effort cache allocation must not discard a successfully drawn PDF.
    copy.width = 0; copy.height = 0
    return
  }
  retained.set(key, { canvas: copy, renderKey, bytes })
  retainedBytes += bytes
}

export function cachedPdfPageSize(pdf: object, page: number): { width: number; height: number } | undefined {
  return pageSizes.get(pdf)?.get(page)
}

export function cachePdfPageSize(pdf: object, page: number, size: { width: number; height: number }): void {
  const sizes = pageSizes.get(pdf) ?? new Map()
  sizes.set(page, size)
  pageSizes.set(pdf, sizes)
}

export function restorePdfPageBitmap(source: object | string, page: number, canvas: HTMLCanvasElement, renderKey: string): boolean {
  const key = bitmapKey(source, page), cached = retained.get(key)
  if (!cached || cached.renderKey !== renderKey) return false
  canvas.width = cached.canvas.width
  canvas.height = cached.canvas.height
  const context = canvas.getContext('2d')
  if (!context) return false
  context.drawImage(cached.canvas, 0, 0)
  retained.delete(key); retained.set(key, cached)
  return true
}

export function pdfPageBitmapCacheStats(): { entries: number; bytes: number } {
  return { entries: retained.size, bytes: retainedBytes }
}
