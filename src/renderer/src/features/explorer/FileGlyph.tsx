/**
 * 文件类型矢量图标（mdi 图标集 + seti 色板）。
 *
 * 资源管理器的文件树与 @ 文件引用面板共用同一实现，保证两处观感一致。
 * 代码文件沿用 seti 色板，办公文档用主题令牌；交付附件也复用这组标识。
 */
import type { JSX } from 'react'
import { resolveFileIcon } from './file-icons'

export const FILE_GLYPH_SIZE = 16

export function FileGlyph({ name, mimeType, size = FILE_GLYPH_SIZE }: { name: string; mimeType?: string; size?: number }): JSX.Element {
  const icon = resolveFileIcon(name, mimeType)
  return (
    <svg
      className="tree-row__glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ color: icon.color }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}
