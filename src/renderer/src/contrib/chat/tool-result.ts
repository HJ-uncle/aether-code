import { parseBrowserSnapshot, type ToolBrowserSnapshot } from './browser-snapshot'
import { rasterDataUrl, viewportScreenshot } from './tool-image'

export interface ToolResultImage {
  src: string
  alt: string
}

export interface ParsedToolResult {
  images: ToolResultImage[]
  text: string
  browserSnapshots?: ToolBrowserSnapshot[]
}

const INVALID_IMAGE = '[图片数据无效或格式不支持]'
const IMAGE_DATA_URL = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^\s"'<>\\)\]}]*/gi
const IMAGE_DATA_FIELDS = new Set(['dataurl', 'data_url', 'url', 'image_url'])

/**
 * Live events, history and MCP adapters wrap results differently. Decode their JSON layers here,
 * retaining ordinary text and metadata while replacing image bytes with readable references.
 */
export function parseToolResult(value: unknown): ParsedToolResult {
  const images: ToolResultImage[] = []
  const browserSnapshots: ToolBrowserSnapshot[] = []
  const snapshotKeys = new Set<string>()
  const imageIndexes = new Map<string, number>()
  const backgroundOwners = new WeakSet<object>()
  const ancestors = new WeakSet<object>()
  let replacements = 0

  const image = (dataUrl: string, label?: string): string => {
    replacements++
    const src = rasterDataUrl(dataUrl)
    if (!src) return INVALID_IMAGE
    let index = imageIndexes.get(src)
    if (index === undefined) {
      index = images.length
      imageIndexes.set(src, index)
      images.push({ src, alt: label || `工具输出图片 ${index + 1}` })
    }
    return `[图片 ${index + 1}]`
  }

  const visit = (item: unknown, depth: number, label?: string): unknown => {
    if (depth > 32) { replacements++; return '[结果嵌套过深，已省略]' }
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (/^[{[\"]/.test(trimmed)) {
        try {
          const before = replacements
          const decoded: unknown = JSON.parse(trimmed)
          const parsed = visit(decoded, depth + 1, label)
          // Preserve exact formatting for non-image tools, including quoted JSON strings.
          if (replacements !== before) return parsed
        } catch { /* Partial legacy results still have their inline image data redacted below. */ }
      }
      // Only a complete, valid data URL is normalized as one value. Ordinary surrounding prose
      // must stay intact, rather than being joined into the Base64 by whitespace removal.
      if (/^data:image\//i.test(trimmed)) {
        const standalone = rasterDataUrl(trimmed)
        if (standalone) return image(standalone, label)
      }
      return item.replace(IMAGE_DATA_URL, candidate => image(candidate, label))
    }
    if (!item || typeof item !== 'object') return item
    if (ancestors.has(item)) { replacements++; return '[循环引用]' }
    ancestors.add(item)
    try {
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1, label))
      const record = item as Record<string, unknown>
      const snapshot = parseBrowserSnapshot(record)
      if (snapshot) {
        // These pixels are already attached to the geometry view. Redact the raw JSON below,
        // without adding a second unannotated image above the same browser snapshot.
        backgroundOwners.add(record)
        if (record.interaction && typeof record.interaction === 'object') {
          backgroundOwners.add(record.interaction)
        }
        const key = JSON.stringify(snapshot)
        if (!snapshotKeys.has(key)) {
          snapshotKeys.add(key)
          browserSnapshots.push(snapshot)
        }
      }
      const ownLabel = [record.filename, record.name, record.title].find(
        candidate => typeof candidate === 'string' && candidate.trim() && !candidate.startsWith('data:')
      )
      const nextLabel = typeof ownLabel === 'string' ? ownLabel.slice(0, 200) : label
      const mime = record.mimeType ?? record.mime_type ?? record.media_type
      const isImage = record.type === 'image' || (typeof mime === 'string' && mime.startsWith('image/'))
      return Object.fromEntries(Object.entries(record).map(([key, child]) => {
        if (key === 'screenshot' && backgroundOwners.has(record)) {
          replacements++
          const background = viewportScreenshot(child)
          return [key, background ? { ...background, dataUrl: '[页面截图，见位置示意图]' } : INVALID_IMAGE]
        }
        // Explicit image URL fields own the entire payload, including malformed wrapped data.
        // Splitting these on whitespace would leak the remaining Base64 into the result text.
        if (IMAGE_DATA_FIELDS.has(key.toLowerCase()) && typeof child === 'string' && /^data:image\//i.test(child.trim())) {
          return [key, image(child.trim(), nextLabel)]
        }
        // MCP image blocks and Anthropic source blocks carry bare base64 instead of a data URL.
        if ((key === 'data' || key === 'base64') && typeof child === 'string' && isImage && !child.startsWith('data:')) {
          return [key, image(`data:${typeof mime === 'string' ? mime : 'image/unknown'};base64,${child}`, nextLabel)]
        }
        return [key, visit(child, depth + 1, nextLabel)]
      }))
    } finally { ancestors.delete(item) }
  }

  const cleaned = visit(value, 0)
  let text: string
  if (typeof cleaned === 'string') text = cleaned
  else if (cleaned == null) text = ''
  else {
    try { text = JSON.stringify(cleaned, null, 2) ?? String(cleaned) } catch { text = String(cleaned) }
  }
  return { images, text, ...(browserSnapshots.length ? { browserSnapshots } : {}) }
}
