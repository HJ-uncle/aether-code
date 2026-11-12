import type { JSX } from 'react'
import { isPluginToolkitId } from '@shared/toolkits'
import { OUTLINE_ICON_PATHS, OUTLINE_ICON_STROKE } from '@renderer/ui/outline-icons'

// Menus, editable labels and restored messages share the same small outline symbols.
const BUILTIN_PATHS: Readonly<Record<string, string>> = {
  'agent-management': OUTLINE_ICON_PATHS['account-outline'],
  'skill-management': OUTLINE_ICON_PATHS['package-variant-closed'],
  'knowledge-management': OUTLINE_ICON_PATHS['book-open'],
  automation: OUTLINE_ICON_PATHS['clock-outline'],
  'plugin-management': OUTLINE_ICON_PATHS.extensions,
  'mcp-management': OUTLINE_ICON_PATHS.plug,
}

export function toolkitIconGlyph(id: string | undefined): { path: string; fill: 'none'; strokeWidth: number } {
  return { path: isPluginToolkitId(id) ? OUTLINE_ICON_PATHS.puzzle : BUILTIN_PATHS[id ?? ''] ?? OUTLINE_ICON_PATHS['package-variant-closed'], fill: 'none', strokeWidth: OUTLINE_ICON_STROKE }
}

export function ToolkitIcon({ id, size = 16, className }: { id: string | undefined; size?: number; className?: string }): JSX.Element {
  const glyph = toolkitIconGlyph(id)
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
    <path d={glyph.path} fill={glyph.fill} stroke="currentColor" strokeWidth={glyph.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
