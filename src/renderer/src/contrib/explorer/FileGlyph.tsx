/**
 * 文件类型矢量图标（mdi 图标集 + seti 色板）。
 *
 * 资源管理器的文件树与 @ 文件引用面板共用同一实现，保证两处观感一致。
 * 颜色由 mdi 色板内联指定（明暗主题下一致，对齐 VSCode 文件图标行为）。
 */
import type { JSX } from 'react'
import { resolveFileIcon } from './file-icons'

export const FILE_GLYPH_SIZE = 16

export function FileGlyph({ name, size = FILE_GLYPH_SIZE }: { name: string; size?: number }): JSX.Element {
  const icon = resolveFileIcon(name)
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
