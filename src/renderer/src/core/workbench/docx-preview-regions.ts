/** Complete visual regions of continuous DOCX content. Input must already be
 * sanitized with passiveDocumentHtml; these regions are not Word page numbers. */
export interface DocxPreviewRegionOptions {
  maxRegions?: number
  maxHtmlBytes?: number
}

const WIDTH = 960, HEIGHT = 540, LABEL_HEIGHT = 32
const CONTENT_HEIGHT = HEIGHT - LABEL_HEIGHT, OVERLAP_X = 64, OVERLAP_Y = 64
const frameBase = `html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white;color:black;color-scheme:light}*{animation:none!important;transition:none!important}`

function offsets(extent: number, viewport: number, overlap: number, maximum: number): number[] {
  if (!Number.isFinite(extent) || extent <= 0) throw new Error('DOCX 连续预览尺寸无效，不能证明内容已完整显示。')
  const count = extent <= viewport ? 1 : Math.ceil((extent - viewport) / (viewport - overlap)) + 1
  if (count > maximum) throw new Error(`DOCX 连续内容超过 ${maximum} 个预览区域，未返回截断画面。`)
  return Array.from({ length: count }, (_, index) => Math.min(index * (viewport - overlap), Math.max(0, extent - viewport)))
}

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let listener: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason ?? new Error('DOCX 预览已取消。'))
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
    })])
  } finally { if (listener) signal.removeEventListener('abort', listener) }
}

/** No font reduction or inferred Word pagination: every region is a viewport
 * onto the same continuously laid out docx-preview section, with overlap. */
export async function docxPreviewRegions(sectionHtml: readonly string[], signal: AbortSignal,
  options: DocxPreviewRegionOptions = {}): Promise<string[]> {
  const maxRegions = options.maxRegions ?? 100, maxHtmlBytes = options.maxHtmlBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(maxRegions) || maxRegions < 1 || !sectionHtml.length) throw new Error('DOCX 预览区域预算无效。')
  const regions: { html: string; section: number; x: number; y: number; width: number; height: number; sourceWidth: number }[] = []
  let totalBytes = 0
  for (const [index, html] of sectionHtml.entries()) {
    signal.throwIfAborted()
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;visibility:hidden;pointer-events:none;border:0`
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        iframe.onload = () => resolve()
        iframe.onerror = () => reject(new Error('无法建立 DOCX 预览测量区域。'))
      })
      // Match office-render's capture frame. The user's document stays outside
      // the application DOM; CSP blocks URLs and the sandbox never runs scripts.
      iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'none';connect-src 'none';img-src data:;style-src 'unsafe-inline';font-src 'none';base-uri 'none';form-action 'none';object-src 'none';frame-src 'none'"><style>${frameBase}</style></head><body><div id="docx-source" style="position:relative;width:max-content">${html}</div></body></html>`
      document.body.append(iframe)
      await cancellable(loaded, signal)
      const child = iframe.contentDocument, source = child?.getElementById('docx-source')
      if (!child || !source) throw new Error('DOCX 预览测量区域不可用。')
      await cancellable(child.fonts.ready, signal)
      await cancellable(Promise.all(Array.from(child.images, async image => {
        await image.decode()
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('DOCX 图片未完整解码，不能返回完整预览。')
      })), signal)
      signal.throwIfAborted()
      // Root sections normally expand vertically. Include overflow geometry,
      // but refuse text hidden by the source renderer's own clipping: tiling an
      // already clipped DOM must not masquerade as complete visual evidence.
      const rectangle = source.getBoundingClientRect()
      const sourceWidth = rectangle.width
      let left = 0, top = 0, right = 0, bottom = 0
      let textLineHeight = 0, visited = 0
      const record = (bounds: DOMRect, element: Element): void => {
        if (bounds.width <= 0 || bounds.height <= 0) return
        for (let ancestor: Element | null = element; ancestor && ancestor !== source; ancestor = ancestor.parentElement) {
          const style = child.defaultView!.getComputedStyle(ancestor), box = ancestor.getBoundingClientRect()
          const clips = (overflow: string): boolean => ['hidden', 'clip', 'auto', 'scroll'].includes(overflow)
          if (clips(style.overflowX) && (bounds.left < box.left - 1 || bounds.right > box.right + 1) ||
              clips(style.overflowY) && (bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1))
            throw new Error('DOCX 原始预览内部存在裁切，无法完整显示内容；不能将截断画面作为完整验收。')
        }
        left = Math.min(left, bounds.left - rectangle.left); top = Math.min(top, bounds.top - rectangle.top)
        right = Math.max(right, bounds.right - rectangle.left); bottom = Math.max(bottom, bounds.bottom - rectangle.top)
      }
      const walker = child.createTreeWalker(source, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        if (++visited % 128 === 0) signal.throwIfAborted()
        const node = walker.currentNode, element = node.parentElement
        if (!node.textContent?.trim() || !element || element.closest('style')) continue
        const range = child.createRange(); range.selectNodeContents(node)
        for (const bounds of range.getClientRects()) { textLineHeight = Math.max(textLineHeight, bounds.height); record(bounds, element) }
      }
      for (const element of source.querySelectorAll('img,svg,table')) record(element.getBoundingClientRect(), element)
      for (const element of source.querySelectorAll('p,div,hr')) {
        const style = child.defaultView!.getComputedStyle(element)
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent' ||
            ['borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth'].some(key => parseFloat(style[key as 'borderTopWidth']) > 0))
          record(element.getBoundingClientRect(), element)
      }
      if (textLineHeight + 4 >= CONTENT_HEIGHT) throw new Error('DOCX 文字行高超过预览区域，无法提供可读的完整行画面。')
      // Section min-height can be an empty paper-sized tail. It does not need
      // several blank inspection images; retain the actual source layout width
      // while tiling only through the last painted content, plus breathing room.
      right = right > 0 ? Math.min(Math.max(rectangle.width, source.scrollWidth), right + 16) : rectangle.width
      bottom = bottom > 0 ? Math.min(Math.max(rectangle.height, source.scrollHeight), bottom + 16) : rectangle.height
      left = Math.floor(left); top = Math.floor(top)
      const width = Math.ceil(right - left), height = Math.ceil(bottom - top)
      const horizontal = offsets(width, WIDTH, OVERLAP_X, maxRegions)
      const vertical = offsets(height, CONTENT_HEIGHT, Math.max(OVERLAP_Y, Math.ceil(textLineHeight) + 4), maxRegions)
      if (regions.length + horizontal.length * vertical.length > maxRegions)
        throw new Error(`DOCX 连续内容超过 ${maxRegions} 个预览区域，未返回截断画面。`)
      for (const y of vertical) for (const x of horizontal) {
        totalBytes += html.length * 2 + 2048
        if (totalBytes > maxHtmlBytes) throw new Error('DOCX 连续内容预览超过 HTML 预算，未返回截断画面。')
        regions.push({ html, section: index + 1, x: x + left, y: y + top, width: Math.ceil(right), height: Math.ceil(bottom), sourceWidth })
      }
    } finally {
      iframe.onload = null; iframe.onerror = null; iframe.remove()
    }
  }
  return regions.map(({ html, section, x, y, width, height, sourceWidth }, index) =>
    `<div data-docx-preview-region="${index + 1}" style="width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white;color:black">` +
    `<div style="box-sizing:border-box;height:${LABEL_HEIGHT}px;padding:7px 12px;font:12px/18px system-ui,sans-serif;color:#475569;background:#f8fafc">DOCX 预览区域 ${index + 1}/${regions.length} · 内容区段 ${section} · x ${x}–${Math.min(x + WIDTH, width)} / y ${y}–${Math.min(y + CONTENT_HEIGHT, height)} px（非 Word 页码）</div>` +
    `<div data-docx-region-clip style="position:relative;width:${WIDTH}px;height:${CONTENT_HEIGHT}px;overflow:hidden">` +
    `<div style="position:absolute;left:${-x}px;top:${-y}px;width:${sourceWidth}px">${html}</div></div></div>`)
}
