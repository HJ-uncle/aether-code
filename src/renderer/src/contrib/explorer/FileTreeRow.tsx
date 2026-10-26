import type { CSSProperties, JSX, MouseEvent, ReactNode } from 'react'
import { FileGlyph } from './FileGlyph'

export const FILE_TREE_ROW_HEIGHT = 30
export const FILE_TREE_INDENT_BASE = 6
export const FILE_TREE_INDENT_STEP = 12

interface FileTreeRowProps {
  name: string
  nameContent?: ReactNode
  path: string
  title?: string
  depth: number
  isDirectory: boolean
  isExpanded?: boolean
  isSelected?: boolean
  isActive?: boolean
  className?: string
  nameClassName?: string
  nameStyle?: CSSProperties
  labelSuffix?: ReactNode
  trailing?: ReactNode
  icon?: ReactNode
  indentGuides?: boolean
  dataDir?: string
  dataParentDir?: string
  focusable?: boolean
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onDoubleClick?: (event: MouseEvent<HTMLElement>) => void
  onActivate?: () => void
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}

/** 文件树统一展示与焦点语义；数据、选择集合和拖放仍由各面板管理。 */
export function FileTreeRow({
  name,
  nameContent,
  path,
  title = path,
  depth,
  isDirectory,
  isExpanded = false,
  isSelected = false,
  isActive = false,
  className = '',
  nameClassName = '',
  nameStyle,
  labelSuffix,
  trailing,
  icon,
  indentGuides = false,
  dataDir,
  dataParentDir,
  focusable = true,
  onClick,
  onDoubleClick,
  onActivate,
  onMouseDown,
  onContextMenu
}: FileTreeRowProps): JSX.Element {
  const classes = [
    'tree-row', isSelected ? 'is-selected' : '', isActive ? 'is-active' : '', className
  ].filter(Boolean).join(' ')
  const style = {
    paddingLeft: FILE_TREE_INDENT_BASE + depth * FILE_TREE_INDENT_STEP,
    height: FILE_TREE_ROW_HEIGHT
  } as CSSProperties

  return (
    <div
      role="treeitem"
      aria-expanded={isDirectory ? isExpanded : undefined}
      aria-selected={isSelected || isActive}
      aria-level={depth + 1}
      className={classes}
      data-path={path}
      data-dir={dataDir}
      data-parent-dir={dataParentDir}
      style={style}
      title={title}
      tabIndex={focusable && onClick ? 0 : -1}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onActivate?.()
      }}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      {indentGuides ? Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="explorer__indent"
          style={{ left: FILE_TREE_INDENT_BASE + level * FILE_TREE_INDENT_STEP + 6 }}
          aria-hidden
        />
      )) : null}
      <span className={`tree-row__chevron${isExpanded ? ' is-open' : ''}`}>
        {isDirectory ? <span className="tree-row__chevron-glyph" /> : null}
      </span>
      {icon ?? (isDirectory ? (
        <span className={`tree-row__icon tree-row__icon--dir${isExpanded ? ' is-open' : ''}`} />
      ) : (
        <FileGlyph name={name} />
      ))}
      <span className="tree-row__labels">
        <span className={`tree-row__name ${nameClassName}`.trim()} style={nameStyle}>{nameContent ?? name}</span>
        {labelSuffix}
      </span>
      {trailing}
    </div>
  )
}
