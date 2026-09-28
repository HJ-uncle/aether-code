/**
 * 改动文件行（移植自 wuzu-client components/code/GitChangeRow.vue）
 *
 * 一行 = 一个变更文件：状态着色图标 + 文件名 + 目录 + 增删计数 + 状态角标字母。
 * 设计意图（与源组件一致）：
 * - 文件名按变更类型着色而非只染角标：一眼扫过去能分出新增/删除/修改，
 *   只染角标则整列一个颜色看不出差别。
 * - 增删行数（+N -M）比 M/U 字母更能表达改动大小，二进制与全 0 不显示。
 * - 操作按钮（暂存/取消暂存/放弃更改）hover 才显示：用宽度过渡而非透明，
 *   否则按钮不可见仍占位，会和增删数字之间留出一大片死白。
 * - 冲突文件只留「标记已解决」（= 暂存该文件）：冲突状态下放弃更改语义不明。
 * 与源组件的差异：源没有 hunk 展开；按移植要求保留 hunks 级操作入口
 * （showHunks 时展开 hunksMap 里的 hunk 列表，逐条支持 discardHunk）。
 */
import { useMemo, useState, type JSX, type MouseEvent } from 'react'
import type { GitFileChange } from '@shared/git-types'
import { STATUS_COLOR, STATUS_LETTER, visualKeyOf } from '@renderer/core/git/git-status-visuals'
import { discardHunk, hunksOf, loadHunksFor } from '@renderer/core/git/git-store'
import { Icon } from '@renderer/workbench/icons'

export interface GitChangeRowProps {
  file: GitFileChange
  /** 单选激活态（当前 diff 预览中的文件），与多选 selected 分开着色 */
  active: boolean
  /** 处于多选集合中（Ctrl/Shift 点选命中） */
  selected?: boolean
  onSelect?: (file: GitFileChange, event: MouseEvent) => void
  onOpen?: (file: GitFileChange) => void
  onDiscard?: (file: GitFileChange) => void
  onToggleStage?: (file: GitFileChange) => void
  onContextMenu?: (file: GitFileChange, event: MouseEvent) => void
}

function statusIconName(file: GitFileChange): 'file' | 'graph' {
  // 图标集暂无 file-plus/file-remove/file-edit/file-question/source-merge，
  // 统一用 file（文件类）与 graph（冲突，暂代 source-merge），等主 Agent 补图标。
  return file.conflict ? 'graph' : 'file'
}

export function GitChangeRow({
  file,
  active,
  selected,
  onSelect,
  onOpen,
  onDiscard,
  onToggleStage,
  onContextMenu
}: GitChangeRowProps): JSX.Element {
  const [hunksOpen, setHunksOpen] = useState(false)
  const fileName = file.path.split('/').pop() ?? file.path
  const dirName = useMemo(() => {
    const parts = file.path.split('/')
    parts.pop()
    return parts.join('/')
  }, [file.path])

  const visualKey = visualKeyOf(file)
  const statusLetter = STATUS_LETTER[visualKey]
  const statusColor = STATUS_COLOR[visualKey]

  /** 二进制没有行数概念，全 0 时也不占位，免得一排 +0 -0 干扰视线 */
  const showStats = !file.binary && (file.additions > 0 || file.deletions > 0)

  const hunks = hunksOpen ? hunksOf(file.path) : []

  const rowClass = ['git-row', 'group', selected ? 'is-selected' : active ? 'is-active' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div
        className={rowClass}
        title={file.path}
        onClick={(e) => onSelect?.(file, e)}
        onDoubleClick={() => onOpen?.(file)}
        onContextMenu={(e) => onContextMenu?.(file, e)}
      >
        <Icon name={statusIconName(file)} size={13} className="git-row__icon" />
        <span
          className={`git-row__name${file.changeType === 'deleted' ? ' is-deleted' : ''}`}
          style={{ color: statusColor }}
          title={file.conflict ? `${fileName}（合并冲突，需手动解决）` : undefined}
        >
          {fileName}
        </span>
        <span className="git-row__dir">{dirName}</span>
        {showStats ? (
          <span className="git-row__stats">
            {file.additions > 0 ? <span className="git-row__add">+{file.additions}</span> : null}
            {file.deletions > 0 ? <span className="git-row__del">-{file.deletions}</span> : null}
          </span>
        ) : null}
        <div className={`git-row__actions${file.conflict ? ' git-row__actions--conflict' : ''}`}>
          {file.conflict ? (
            <button
              type="button"
              className="git-row__btn"
              title="标记为已解决（暂存该文件）"
              onClick={(e) => {
                e.stopPropagation()
                onToggleStage?.(file)
              }}
            >
              <Icon name="check" size={13} className="git-row__add" />
            </button>
          ) : (
            <>
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
              <button
                type="button"
                className="git-row__btn"
                title={hunksOpen ? '收起变更块' : '展开变更块（可逐块放弃）'}
                onClick={(e) => {
                  e.stopPropagation()
                  const next = !hunksOpen
                  setHunksOpen(next)
                  if (next) void loadHunksFor(file.path)
                }}
              >
                <Icon name={hunksOpen ? 'chevron' : 'chevron-right'} size={13} />
              </button>
            </>
          )}
        </div>
        <span className="git-row__code" style={{ color: statusColor }}>
          {statusLetter}
        </span>
      </div>
      {hunksOpen ? (
        <div className="git-row__hunks">
          {hunks.length === 0 ? (
            <div className="git-row__hunk git-row__hunk--empty">无变更块（或尚未加载）</div>
          ) : (
            hunks.map((h) => (
              <div key={h.id} className="git-row__hunk">
                <span className="git-row__hunk-range">
                  @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                </span>
                {h.heading ? <span className="git-row__hunk-heading">{h.heading}</span> : null}
                <button
                  type="button"
                  className="git-row__btn"
                  title="放弃此变更块"
                  onClick={(e) => {
                    e.stopPropagation()
                    void discardHunk(file.path, h.id)
                  }}
                >
                  <Icon name="restart" size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </>
  )
}
