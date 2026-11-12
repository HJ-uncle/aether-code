const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'])

/** Only self-contained raster images reach img.src; tool output cannot initiate a network request. */
export function rasterDataUrl(value: string): string | null {
  const comma = value.indexOf(',')
  if (comma < 0) return null
  const header = value.slice(0, comma).toLowerCase()
  if (!/^data:image\/[a-z0-9.+-]+;base64$/.test(header)) return null
  const mime = header.slice(5, -7).replace('image/jpg', 'image/jpeg')
  if (!RASTER_MIMES.has(mime)) return null
  const data = value.slice(comma + 1).replace(/[\u0009-\u000d\u0020]/g, '')
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null
  let prefix: string
  try { prefix = atob(data.slice(0, 64)) } catch { return null }
  const bytes = [...prefix].map(char => char.charCodeAt(0))
  const starts = (...signature: number[]): boolean => signature.every((byte, index) => bytes[index] === byte)
  const valid = mime === 'image/png' ? starts(137, 80, 78, 71, 13, 10, 26, 10)
    : mime === 'image/jpeg' ? starts(255, 216, 255)
      : mime === 'image/gif' ? /^GIF8[79]a/.test(prefix)
        : mime === 'image/webp' ? prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP'
          : mime === 'image/bmp' ? prefix.startsWith('BM')
            : prefix.slice(4, 8) === 'ftyp' && /avi[fs]/.test(prefix.slice(8, 40))
  return valid ? `data:${mime};base64,${data}` : null
}

/** Geometry backgrounds are bounded PNGs; their declared size must match the pixel header. */
export function viewportScreenshot(value: unknown): { dataUrl: string; width: number; height: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const image = value as Record<string, unknown>
  if (typeof image.dataUrl !== 'string' || image.dataUrl.length > 1_398_126 ||
      typeof image.width !== 'number' || !Number.isInteger(image.width) || image.width < 1 || image.width > 1600 ||
      typeof image.height !== 'number' || !Number.isInteger(image.height) || image.height < 1 || image.height > 1600) return undefined
  const dataUrl = rasterDataUrl(image.dataUrl)
  if (!dataUrl?.startsWith('data:image/png;base64,')) return undefined
  const base64 = dataUrl.slice(22)
  const byteLength = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (byteLength > 1024 * 1024) return undefined
  const prefix = atob(dataUrl.slice(22, 86))
  if (prefix.length < 24 || prefix.slice(12, 16) !== 'IHDR') return undefined
  const uint32 = (offset: number): number => [0, 1, 2, 3].reduce((n, i) => n * 256 + prefix.charCodeAt(offset + i), 0)
  if (uint32(16) !== image.width || uint32(20) !== image.height) return undefined
  return { dataUrl, width: image.width, height: image.height }
}
