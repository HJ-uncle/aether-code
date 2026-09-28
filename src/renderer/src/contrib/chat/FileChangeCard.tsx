import { useMemo, useState, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'
import { openFileFromChat } from './open-file'
import {
  MAX_RENDER_ROWS,
  computeLineDiff,
  diffForDeletedFile,
  diffForNewFile,
  diffStats
} from './diff'

/**
 * 文件改动卡片（git diff 风格）
 *
 * 头部：✓ 中文标题 + 文件路径 + +N/-M 统计；正文：行号 + 红删绿增。
 * 数据来自引擎 fileChange 帧（write_file/delete_file 前后的内容快照），
 * 内容过大/二进制时快照为空，退化为只展示元信息。
 */
export function FileChangeCard({
  change,
  state
}: {
  change: EngineFileChange
  state: 'running' | 'done' | 'error'
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const failed = state === 'error'

  const rows = useMemo(() => {
    if (change.truncated) return []
    if (change.kind === 'delete') return diffForDeletedFile(change.oldContent ?? '')
    if (change.isNew) return diffForNewFile(change.newContent ?? '')
    if (change.oldContent === null || change.newContent === null) return []
    return computeLineDiff(change.oldContent, change.newContent)
  }, [change])

  const stats = useMemo(() => diffStats(rows), [rows])
  const displayPath = change.displayPath || change.path
  const title = change.kind === 'delete' ? '删除文件' : change.isNew ? '新建文件' : '编辑文件'

  // 路径太长时只展示尾部两段（与参考样式一致），悬停看全路径
  const shortPath = useMemo(() => {
    const segments = displayPath.replace(/\\/g, '/').split('/')
    return segments.length > 2 ? `…/${segments.slice(-2).join('/')}` : displayPath
  }, [displayPath])

  const visibleRows = expanded ? rows : rows.slice(0, MAX_RENDER_ROWS)
  const hiddenCount = rows.length - visibleRows.length

  return (
    <details className={`diff-card${failed ? ' diff-card--error' : ''}`} open>
      <summary>
        <span className={`diff-card__icon${failed ? ' diff-card__icon--fail' : ''}`}>
          <Icon name={failed ? 'close' : 'check'} size={13} />
        </span>
        <span className="diff-card__title">{title}</span>
        <button
          type="button"
          className="diff-card__path diff-card__path--link"
          title={`在编辑器中打开 ${displayPath}`}
          onClick={(event) => {
            // 阻止冒泡到 summary：点路径是打开文件，不是折叠卡片
            event.preventDefault()
            event.stopPropagation()
            void openFileFromChat(change.path || displayPath)
          }}
        >
          {shortPath}
        </button>
        <span className="diff-card__spacer" />
        {change.truncated ? (
          <span className="diff-card__hint">内容未存档</span>
        ) : (
          <span className="diff-card__stats">
            <span className="diff-card__add">+{stats.added}</span>
            <span className="diff-card__del">-{stats.removed}</span>
          </span>
        )}
        <Icon name="chevron" size={13} />
      </summary>

      {change.truncated ? (
        <div className="diff-card__body diff-card__body--empty">
          文件过大或为二进制格式，未保存内容快照（无法展示差异，也不支持自动撤回）。
        </div>
      ) : rows.length === 0 ? (
        <div className="diff-card__body diff-card__body--empty">（无文本差异）</div>
      ) : (
        <div className="diff-card__body">
          {visibleRows.map((row, index) => (
            <div key={index} className={`diff-row diff-row--${row.type}`}>
              <span className="diff-row__no">{row.newNo ?? ''}</span>
              <span className="diff-row__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              </span>
              <span className="diff-row__text">{row.text || ' '}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <button type="button" className="diff-card__more" onClick={() => setExpanded(true)}>
              还有 {hiddenCount} 行，点击展开全部
            </button>
          ) : null}
        </div>
      )}
    </details>
  )
}
