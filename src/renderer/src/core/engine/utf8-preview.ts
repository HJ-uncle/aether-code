/** Bound a preview by UTF-8 bytes without allocating an encoded buffer per character. */
export function utf8BytePreview(value: string | undefined, maxBytes = 2048): string | undefined {
  if (value === undefined) return undefined
  let bytes = 0
  let end = 0
  while (end < value.length) {
    const first = value.charCodeAt(end)
    const second = value.charCodeAt(end + 1)
    // TextEncoder emits four bytes for a valid pair and three replacement bytes
    // for a lone surrogate. Keep the same boundary without splitting a pair.
    const pair = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
    const size = first < 0x80 ? 1 : first < 0x800 ? 2 : pair ? 4 : 3
    if (bytes + size > maxBytes) break
    bytes += size
    end += pair ? 2 : 1
  }
  return end === value.length ? value : value.slice(0, end)
}
