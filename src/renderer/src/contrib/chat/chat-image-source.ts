import type { FsFileContent } from '@shared/ipc'
import { mimeFor } from '../../core/editor/preview'
import { classifyChatLink } from './chat-link'
import { rasterDataUrl } from './tool-image'

export type ChatImageSource =
  | { kind: 'data'; src: string }
  | { kind: 'file'; path: string }
  | { kind: 'unavailable'; message: string }

export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024
const TOO_LARGE = '图片超过 20 MiB，无法在消息中预览。'
const INVALID_IMAGE = '图片数据无效或格式不支持。'
const INVALID_PATH = '图片路径无效，无法加载。'
const SVG_MIME = 'image/svg+xml'

function assertByteLimit(size: number): void {
  if (!Number.isFinite(size) || size < 0) throw new Error(INVALID_IMAGE)
  if (size > MAX_CHAT_IMAGE_BYTES) throw new Error(TOO_LARGE)
}

function boundedBase64(value: string): string {
  const data = value.replace(/[\u0009-\u000d\u0020]/g, '')
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(INVALID_IMAGE)
  assertByteLimit(data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0))
  return data
}

function encodeBytes(bytes: Uint8Array): string {
  assertByteLimit(bytes.byteLength)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function svgDataUrl(text: string): string {
  // SVG remains an image document. This result must never be used as HTML,
  // an iframe or an object; scripts/resources have the browser's img isolation.
  if (text.length > MAX_CHAT_IMAGE_BYTES) throw new Error(TOO_LARGE)
  const bytes = new TextEncoder().encode(text)
  assertByteLimit(bytes.byteLength)
  const root = text.replace(/^\uFEFF/, '').trimStart()
    .replace(/^(?:(?:<\?xml\b[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b[^>]*>)\s*)*/i, '')
  if (!/^<svg(?:\s|\/?>)/i.test(root)) throw new Error(INVALID_IMAGE)
  return `data:${SVG_MIME};base64,${encodeBytes(bytes)}`
}

function svgBase64Source(data: string): string {
  const payload = boundedBase64(data)
  let text: string
  try {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { throw new Error(INVALID_IMAGE) }
  return svgDataUrl(text)
}

function imageDataSource(value: string): string {
  const comma = value.indexOf(',')
  if (comma < 0) throw new Error(INVALID_IMAGE)
  const header = value.slice(0, comma).toLowerCase()
  const body = value.slice(comma + 1)
  if (/^data:image\/svg\+xml(?:;(?:charset=(?:utf-8|us-ascii)|utf8))?(?:;base64)?$/.test(header)) {
    if (header.endsWith(';base64')) return svgBase64Source(body)
    // Percent data is decoded once; encoded percent signs inside SVG text are literal.
    if (body.length > MAX_CHAT_IMAGE_BYTES * 3) throw new Error(TOO_LARGE)
    return svgDataUrl(decodeURIComponent(body))
  }
  if (!/^data:image\/[a-z0-9.+-]+;base64$/.test(header)) throw new Error(INVALID_IMAGE)
  const data = boundedBase64(body)
  const source = rasterDataUrl(`${header},${data}`)
  if (!source) throw new Error(INVALID_IMAGE)
  return source
}

function filePath(value: string): string {
  const path = value.replace(/^\/(?=[A-Za-z]:[\\/])/, '').replace(/^(?:\.[\\/])+/, '')
  if (!path || path.startsWith('#') || path.startsWith('//') || /[\u0000-\u001f\u007f]/.test(path) ||
      /^[A-Za-z]:(?![\\/])/.test(path) ||
      (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) ||
      path.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..')) throw new Error(INVALID_PATH)
  // Do not URL-decode filesystem paths: %, #, spaces and Unicode belong to the name.
  return path
}

function localFileUrlPath(href: string): string {
  // Requiring an empty authority also rejects file://localhost, which URL
  // normalizes to an empty hostname and would otherwise evade the host check.
  if (!/^file:\/\/\//i.test(href) || /[?#]/.test(href)) throw new Error('图片文件地址必须是无主机、无查询参数的本地文件 URL。')
  const url = new URL(href)
  if (url.hostname || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error(INVALID_PATH)
  return filePath(decodeURIComponent(url.pathname))
}

/** Classification never reads a file or authorizes a path. The caller must use
 * the message's authenticated session target for every returned file path. */
export function classifyChatImage(href: string, sessionId?: string, engineBaseUrl?: string): ChatImageSource {
  try {
    const value = href.trim()
    if (/^data:/i.test(value)) return { kind: 'data', src: imageDataSource(value) }
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(INVALID_PATH)
    if (/^file:/i.test(value)) return { kind: 'file', path: localFileUrlPath(value) }
    if (value.startsWith('/api/') || /^https?:/i.test(value)) {
      const target = classifyChatLink(value, sessionId, engineBaseUrl)
      if (target.kind === 'artifact') return { kind: 'file', path: target.path }
      if (target.kind === 'invalid') return { kind: 'unavailable', message: target.message }
      return { kind: 'unavailable', message: '外部图片链接暂不支持直接预览，请使用会话中的图片文件。' }
    }
    return { kind: 'file', path: filePath(value) }
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof URIError || error instanceof TypeError
      ? INVALID_IMAGE : error instanceof Error ? error.message : INVALID_IMAGE }
  }
}

/** Return self-contained bytes for img.src, or throw a user-facing load error.
 * File extensions select a MIME; signatures prevent text/HTML from posing as a raster. */
export function chatImageFileSource(file: FsFileContent): string {
  if (file.tooLarge) throw new Error(TOO_LARGE)
  if (file.truncated) throw new Error('图片内容不完整，无法预览，请重新读取。')
  assertByteLimit(file.size)
  const name = file.path.replace(/\\/g, '/').split('/').pop() ?? ''
  const svg = /\.svg$/i.test(name)
  const mime = svg ? SVG_MIME : mimeFor(name)
  if (!mime?.startsWith('image/')) throw new Error(INVALID_IMAGE)
  if (svg && !file.bytes && !file.base64) return svgDataUrl(file.content)
  const data = file.bytes ? encodeBytes(new Uint8Array(file.bytes)) : boundedBase64(file.base64 ?? '')
  if (svg) return svgBase64Source(data)
  if (mime === 'image/x-icon') {
    const prefix = atob(data.slice(0, 24))
    if (prefix.length < 6 || prefix.charCodeAt(0) !== 0 || prefix.charCodeAt(1) !== 0 ||
        prefix.charCodeAt(2) !== 1 || prefix.charCodeAt(3) !== 0 ||
        (prefix.charCodeAt(4) === 0 && prefix.charCodeAt(5) === 0)) throw new Error(INVALID_IMAGE)
    return `data:${mime};base64,${data}`
  }
  const source = rasterDataUrl(`data:${mime === 'image/apng' ? 'image/png' : mime};base64,${data}`)
  if (!source) throw new Error(INVALID_IMAGE)
  return source
}
