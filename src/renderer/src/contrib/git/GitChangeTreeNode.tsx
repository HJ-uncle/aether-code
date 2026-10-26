/**
 * Git 改动目录树：共用文件树行展示，递归、多选、打开和暂存操作仍由这里管理。
 */
import { useState, type JSX, type MouseEvent } from 'react'
import type { GitFileChange } from '@shared/git-types'
import { STATUS_COLOR, STATUS_LETTER, visualKeyOf } from '@renderer/core/git/git-status-visuals'
import { FileTreeRow } from '@renderer/contrib/explorer/FileTreeRow'
import { Icon, type IconName } from '@renderer/workbench/icons'

function treeStatusIconName(file: GitFileChange): IconName {
  if (file.binary) return 'file-question-outline'
  if (file.conflict) return 'source-merge'
  if (file.changeType === 'added' || file.changeType === 'untracked') return 'file-plus-outline'
  if (file.changeType === 'deleted') return 'file-remove-outline'
  return 'file-edit-outline'
}

export interface GitChangeTreeNodeData {
  key: string
  name: string
  isDir: boolean
  file?: GitFileChange
  children?: GitChangeTreeNodeData[]
}

export interface GitChangeTreeNodeProps {
  node: GitChangeTreeNodeData
  depth: number
  selectedPath: string
  /** 所属分组，多选 key 用；由面板按 section 传入 */
  group: 'staged' | 'unstaged' | 'conflict'
  /** 多选集合（元素为 `分组:路径`），由面板维护 */
  selectedKeys?: Set<string>
  onSelect?: (file: GitFileChange, event: MouseEvent) => void
  onOpen?: (file: GitFileChange) => void
  onDiscard?: (file: GitFileChange) => void
  onToggleStage?: (file: GitFileChange) => void
  onContextMenuFile?: (file: GitFileChange, event: MouseEvent) => void
}

export function GitChangeTreeNode({
  node,
  depth,
  selectedPath,
  group,
  selectedKeys,
  onSelect,
  onOpen,
  onDiscard,
  onToggleStage,
  onContextMenuFile
}: GitChangeTreeNodeProps): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)

  if (node.isDir) {
    const toggle = (): void => setCollapsed((value) => !value)
    return (
      <div>
        <FileTreeRow
          name={node.name}
          path={node.key}
          depth={depth}
          isDirectory
          isExpanded={!collapsed}
          className="git-tree__dir"
          onClick={toggle}
          onActivate={toggle}
        />
        {!collapsed && node.children
          ? node.children.map((child) => (
              <GitChangeTreeNode
                key={child.key}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                group={group}
                selectedKeys={selectedKeys}
                onSelect={onSelect}
                onOpen={onOpen}
                onDiscard={onDiscard}
                onToggleStage={onToggleStage}
                onContextMenuFile={onContextMenuFile}
              />
            ))
          : null}
      </div>
    )
  }

  const file = node.file
  if (!file) return null

  const isActive = selectedPath === file.path
  const isSelected = selectedKeys ? selectedKeys.has(`${group}:${file.path}`) : false
  const visualKey = visualKeyOf(file)
  const statusLetter = STATUS_LETTER[visualKey]
  const statusColor = STATUS_COLOR[visualKey]
  const showStats = !file.binary && (file.additions > 0 || file.deletions > 0)

  return (
    <FileTreeRow
      name={node.name}
      path={file.path}
      depth={depth}
      isDirectory={false}
      isSelected={isSelected}
      isActive={!isSelected && isActive}
      className="git-tree__file group"
      nameClassName={file.changeType === 'deleted' ? 'is-deleted' : ''}
      nameStyle={{ color: statusColor }}
      icon={<span className="git-row__icon" style={{ color: statusColor }}>
        <Icon name={treeStatusIconName(file)} size={16} />
      </span>}
      onClick={(event) => onSelect?.(file, event)}
      onActivate={() => onOpen?.(file)}
      onDoubleClick={() => onOpen?.(file)}
      onContextMenu={(event) => onContextMenuFile?.(file, event)}
      trailing={<>
        {showStats ? (
          <span className="git-row__stats">
            {file.additions > 0 ? <span className="git-row__add">+{file.additions}</span> : null}
            {file.deletions > 0 ? <span className="git-row__del">-{file.deletions}</span> : null}
          </span>
        ) : null}
        <span className="git-row__actions">
          <button
            type="button"
            className="git-row__btn"
            title={file.staged ? '取消暂存' : '暂存'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleStage?.(file)
            }}
          >
            <Icon name={file.staged ? 'close' : 'plus'} size={16} />
          </button>
          <button
            type="button"
            className="git-row__btn"
            title="放弃更改"
            onClick={(event) => {
              event.stopPropagation()
              onDiscard?.(file)
            }}
          >
            <Icon name="restart" size={16} />
          </button>
        </span>
        <span className="git-row__code" style={{ color: statusColor }}>{statusLetter}</span>
      </>}
    />
  )
}
