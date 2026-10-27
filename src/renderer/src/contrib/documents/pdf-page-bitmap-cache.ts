const MAX_RETAINED_PAGES = 12
const pageSizes = new WeakMap<object, Map<number, { width: number; height: number }>>()
const documentKeys = new WeakMap<object, number>()
let documentSequence = 0
interface BitmapEntry { canvas: HTMLCanvasElement; renderKey: string }
const retained = new Map<string, BitmapEntry>()

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
  const key = bitmapKey(source, page)
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const context = copy.getContext('2d')
  if (!context) return
  context.drawImage(canvas, 0, 0)
  retained.delete(key)
  retained.set(key, { canvas: copy, renderKey })
  for (const oldest of retained.keys()) {
    if (retained.size <= MAX_RETAINED_PAGES) break
    if (oldest !== key) retained.delete(oldest)
  }
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
  const cached = retained.get(bitmapKey(source, page))
  if (!cached || cached.renderKey !== renderKey) return false
  canvas.width = cached.canvas.width
  canvas.height = cached.canvas.height
  const context = canvas.getContext('2d')
  if (!context) return false
  context.drawImage(cached.canvas, 0, 0)
  return true
}
