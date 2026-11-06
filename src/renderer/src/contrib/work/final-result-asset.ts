import type { FinalResultItem } from '@shared/final-result'

export const MAX_FINAL_RESULT_ASSET_BYTES = 32 * 1024 * 1024

export interface FinalResultAsset {
  bytes: ArrayBuffer
  base64: string
  text?: string
  mimeType: string
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Preview and download use the same verified bytes. A mutable path, a partial
 * response or even an asset with the wrong hash must never replace a delivery. */
export async function decodeFinalResultAsset(value: unknown, item: FinalResultItem): Promise<FinalResultAsset> {
  if (!Number.isSafeInteger(item.size) || item.size < 0) throw new Error('交付物大小无效')
  if (item.size > MAX_FINAL_RESULT_ASSET_BYTES) throw new Error('交付物超过 32 MiB 读取上限')
  if (!record(value) || typeof value.content !== 'string' || typeof value.isBinary !== 'boolean' ||
    value.tooLarge !== false || value.truncated !== false || value.totalSize !== item.size ||
    value.mimeType !== item.mimeType || !['base64', 'utf8'].includes(String(value.encoding))) {
    throw new Error('交付物内容不完整或与发布记录不一致')
  }
  let bytes: Uint8Array<ArrayBuffer>
  let base64: string
  if (value.encoding === 'base64') {
    const expectedLength = Math.ceil(item.size / 3) * 4
    const padding = (3 - item.size % 3) % 3
    const bodyLength = value.content.length - padding
    if (value.content.length !== expectedLength || /[^A-Za-z0-9+/]/.test(value.content.slice(0, bodyLength)) || value.content.slice(bodyLength) !== '='.repeat(padding)) {
      throw new Error('交付物数据编码无效')
    }
    const binary = atob(value.content)
    bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    base64 = value.content
  } else {
    if (value.isBinary || value.content.length > MAX_FINAL_RESULT_ASSET_BYTES) throw new Error('交付物数据编码无效')
    bytes = new TextEncoder().encode(value.content)
    let binary = ''
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    base64 = btoa(binary)
  }
  if (bytes.byteLength !== item.size) throw new Error('交付物字节数与发布记录不一致')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  if (sha256 !== item.sha256.replace(/^sha256:/i, '').toLowerCase()) throw new Error('交付物校验失败，请重新加载')
  let text: string | undefined
  if (!value.isBinary) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('交付物文本编码无效') }
  }
  return { bytes: bytes.buffer, base64, text, mimeType: item.mimeType }
}
