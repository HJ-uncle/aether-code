import type { FinalResultItem } from '@shared/final-result'
import { hasBinaryFileSignature } from '@shared/file-signature'

const BINARY_EXTENSION = /\.(?:pdf|doc[xm]?|dot[xm]?|xls[xmb]?|xltx?|ppt[xm]?|ppsx?|od[tps]|zip|gz|gzip|bz2|xz|7z|rar|tar|zst|png|jpe?g|gif|webp|bmp|ico|tiff?|avif|apng|heic|heif|svgz?|mp[34]|m4[av]|webm|og[gv]|mov|avi|wav|flac|ogg|aac|exe|dll|so|dylib|wasm|class|jar|pyc|sqlite3?|db|ttf|otf|woff2?)$/i
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|sql|graphql)$|application\/[^/]+\+(?:json|xml)$)/i
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/
const SAMPLE_BYTES = 8192

/** Older engines label unregistered source/config files as octet-stream. Only
 * verified bytes may override that hint; a display name never chooses a parser. */
export function finalResultText(bytes: Uint8Array, item: Pick<FinalResultItem, 'path' | 'mimeType' | 'kind'>): string | undefined {
  const mime = item.mimeType.split(';', 1)[0].trim().toLowerCase()
  if (item.kind === 'image' || BINARY_EXTENSION.test(item.path) ||
    mime && mime !== 'application/octet-stream' && !TEXT_MIME.test(mime)) return undefined
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  // UTF-16's BOM is authoritative: NUL bytes are normal in its ASCII text.
  if (encoding === 'utf-8' && hasBinaryFileSignature(bytes.subarray(0, SAMPLE_BYTES))) return undefined
  try {
    const decoder = new TextDecoder(encoding, { fatal: true })
    if (bytes.length > SAMPLE_BYTES) {
      // Stream the prefix to avoid rejecting a multibyte character at the
      // sample boundary. Binary data fails before allocating a large string.
      const sample = decoder.decode(bytes.subarray(0, SAMPLE_BYTES), { stream: true })
      if (CONTROL_CHARACTERS.test(sample)) return undefined
    }
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    return CONTROL_CHARACTERS.test(text) ? undefined : text
  } catch { return undefined }
}
