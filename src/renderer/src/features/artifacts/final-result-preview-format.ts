import type { FinalResultItem } from '@shared/final-result'

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif', 'image/apng': 'apng',
  'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov'
}

/** Display names can omit or change an extension. Only the published MIME and
 * original path choose the parser; the user's label stays unchanged everywhere. */
export function finalResultPreviewFormat(item: Pick<FinalResultItem, 'mimeType' | 'path'>): string {
  const originalName = item.path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const originalExtension = /\.([a-z\d]{1,16})$/i.exec(originalName)?.[1].toLowerCase()
  const extension = MIME_EXTENSIONS[item.mimeType.toLowerCase()] ?? originalExtension ?? 'bin'
  return `asset.${extension}`
}
