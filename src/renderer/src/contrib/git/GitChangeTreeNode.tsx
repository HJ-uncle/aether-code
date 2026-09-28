/**
 * 改动目录树节点（移植自 wuzu-client components/code/GitChangeTreeNode.vue）
 *
 * 树形分组视图下的递归节点：目录节点可展开折叠，文件节点复用 GitChangeRow 的
 * 视觉（状态着色图标 / 增删计数 / hover 操作按钮 / 状态角标），仅多一层缩进。
 * 设计意图：目录树能让大改动按模块聚簇，比一屏平铺的路径列表更容易定位；
 * 缩进按 depth * 12px 递进，文件行比目录行多缩进 8px 以躲开 chevron 的位置。
 */
import { useState, type JSX, type MouseEvent } from 'react'
import type { GitFileChange } from '@shared/git-types'
import { STATUS_COLOR, STATUS_LETTER, visualKeyOf } from '@renderer/core/git/git-status-visuals'
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
    return (
      <div>
        <div
          className="git-tree__dir"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon
            name="chevron"
            size={12}
            className={`git-tree__chevron${collapsed ? ' is-collapsed' : ''}`}
          />
          <Icon name="explorer" size={13} className="git-tree__folder" />
          <span className="git-tree__name">{node.name}</span>
        </div>
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

  const rowClass = [
    'git-tree__file',
    'group',
    isSelected ? 'is-selected' : isActive ? 'is-active' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={rowClass}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
      title={file.path}
      onClick={(e) => onSelect?.(file, e)}
      onDoubleClick={() => onOpen?.(file)}
      onContextMenu={(e) => onContextMenuFile?.(file, e)}
    >
      {/* 图标染状态色：包一层 span 用 currentColor 上色 */}
      <span className="git-row__icon" style={{ color: statusColor }}>
        <Icon name={treeStatusIconName(file)} size={13} />
      </span>
      <span
        className={`git-row__name${file.changeType === 'deleted' ? ' is-deleted' : ''}`}
        style={{ color: statusColor }}
      >
        {node.name}
      </span>
      {showStats ? (
        <span className="git-row__stats">
          {file.additions > 0 ? <span className="git-row__add">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="git-row__del">-{file.deletions}</span> : null}
        </span>
      ) : null}
      <div className="git-row__actions">
        <button
          type="button"
          className="git-row__btn"
          title={file.staged ? '取消暂存' : '暂存'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleStage?.(file)
          }}
        >
          <Icon name={file.staged ? 'close' : 'plus'} size={13} />
        </button>
        <button
          type="button"
          className="git-row__btn"
          title="放弃更改"
          onClick={(e) => {
            e.stopPropagation()
            onDiscard?.(file)
          }}
        >
          <Icon name="restart" size={13} />
        </button>
      </div>
      <span className="git-row__code" style={{ color: statusColor }}>
        {statusLetter}
      </span>
    </div>
  )
}
