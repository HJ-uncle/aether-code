/**
 * 二进制文件预览（纯函数，可直接单测）
 *
 * 分流规则：能安全渲染成标签的（图片/视频）交给浏览器，
 * 其余一律用十六进制视图 —— 二进制没有"通用渲染"，硬猜格式只会产生乱码。
 *
 * 所有函数都不碰 DOM，输入输出都是字符串/字节，
 * 因此可以在没有 Electron 的环境里直接用真实样本测试。
 */

export type PreviewKind = 'image' | 'video' | 'hex'

/** 图片扩展名 → MIME。故意不含 svg：SVG 是文本，会在读取阶段被判为文本走编辑器 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng'
}

/** 视频扩展名 → MIME */
const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime'
}

/** 十六进制视图默认展示的字节数（512 行，足够看出文件头与结构） */
export const DEFAULT_HEX_BYTES = 16 * 1024

/** 取小写扩展名（不含点）；没有扩展名时返回空串 */
export function extensionOf(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex + 1).toLowerCase()
}

/** 已知类型的 MIME；未知返回 null（调用方决定回退为通用二进制） */
export function mimeFor(name: string): string | null {
  const ext = extensionOf(name)
  return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? null
}

/**
 * 预览方式。
 *
 * 注意：这里只看扩展名，不看内容 —— 决定权在读取阶段（主进程按是否含 NUL
 * 判定二进制）。一个扩展名是 .png 但实际是文本的文件会走编辑器，
 * 那比"按扩展名硬当图片"更不容易出错。
 */
export function previewKindFor(name: string): PreviewKind {
  const ext = extensionOf(name)
  if (IMAGE_TYPES[ext]) return 'image'
  if (VIDEO_TYPES[ext]) return 'video'
  return 'hex'
}

/**
 * base64 → 字节。
 *
 * maxBytes 用于只解码前一段：十六进制视图只需要文件头，
 * 而 base64 解码一个 32 MB 的文件只为看前 16 KB 是纯浪费。
 * 切片按 4 个字符一组对齐，保证不会切断一个 base64 组。
 */
export function base64ToBytes(base64: string, maxBytes?: number): Uint8Array {
  let source = base64

  if (maxBytes !== undefined) {
    const groups = Math.ceil(Math.max(maxBytes, 0) / 3)
    source = base64.slice(0, groups * 4)
  }

  const binary = globalThis.atob(source)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return maxBytes === undefined ? bytes : bytes.subarray(0, maxBytes)
}

/**
 * 生成标准十六进制转储：
 *
 *   00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|
 *
 * 不可打印字节显示为 '.'，与 `xxd` 的习惯一致。
 */
export function hexDump(bytes: Uint8Array, maxBytes = DEFAULT_HEX_BYTES): string {
  const limit = Math.min(bytes.length, maxBytes)
  const lines: string[] = []

  for (let offset = 0; offset < limit; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, limit))
    const hex: string[] = []
    let ascii = ''

    for (let i = 0; i < 16; i++) {
      const byte = slice[i]
      if (byte === undefined) {
        // 末行不足 16 字节：用空格补齐，保持列对齐
        hex.push('  ')
        ascii += ' '
        continue
      }
      hex.push(byte.toString(16).padStart(2, '0'))
      ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    }

    const hexPart = `${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}`
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart}  |${ascii}|`)
  }

  return lines.join('\n')
}

/**
 * 把 base64 包成可直接塞进 <img>/<video> 的 data URL。
 *
 * 未知类型回退到 octet-stream：浏览器会拒绝渲染，用户看到的是明确的
 * "无法播放"而不是静默空白。
 */
export function toDataUrl(base64: string, name: string): string {
  return `data:${mimeFor(name) ?? 'application/octet-stream'};base64,${base64}`
}

/** 人类可读的文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
