import type { FsFileContent } from '@shared/ipc'

/** Data-URL generation is an explicit presentation cost, never part of reading
 * or caching a large preview. A Blob URL avoids a base64 string round trip. */
export function fileContentBytes(file: Pick<FsFileContent, 'bytes' | 'base64' | 'content'>): Uint8Array {
  if (file.bytes) return new Uint8Array(file.bytes)
  if (file.base64) return Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))
  return new TextEncoder().encode(file.content)
}

export function fileContentUrl(file: Pick<FsFileContent, 'bytes' | 'base64' | 'content'>, mime: string): { url: string; revoke: () => void } {
  if (file.base64) return { url: `data:${mime};base64,${file.base64}`, revoke: () => {} }
  const url = URL.createObjectURL(new Blob([fileContentBytes(file).buffer as ArrayBuffer], { type: mime }))
  return { url, revoke: () => URL.revokeObjectURL(url) }
}
