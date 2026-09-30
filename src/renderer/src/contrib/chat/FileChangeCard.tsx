import { useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { EngineFileChange } from '@shared/ipc'
import { getRevertOutcome, revertStatusLabel, subscribeReverts } from '@renderer/core/engine/change-revert'
import { Icon } from '@renderer/workbench/icons'
import { openFileFromChat } from './open-file'
import {
  DIFF_APPROXIMATION_HINT,
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
  state: 'running' | 'done' | 'error' | 'unknown' | 'cancelled' | 'waiting' | 'interrupted'
}): JSX.Element {
  const { engine } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  /** 「还有 N 行」展开更多：只影响 body 内的行数，不影响卡片折叠 */
  const [visibleLimit, setVisibleLimit] = useState(MAX_RENDER_ROWS)
  /** 卡片折叠：默认展开（内容量大、是主要阅读对象），用户可点标题收起 */
  const [collapsed, setCollapsed] = useState(false)
  const failed = state === 'error'
  const outcome = useSyncExternalStore(subscribeReverts, () => getRevertOutcome(change.id))
  const rollbackLabel = outcome ? revertStatusLabel[outcome.status] : change.status === 'reverted' ? '已撤回' : null

  const isNew = change.isNew ?? (!change.truncated && change.oldContent === null)
  const rows = useMemo(() => {
    if (change.truncated) return null
    if (change.kind === 'delete') return change.oldContent === null ? null : diffForDeletedFile(change.oldContent)
    if (isNew) return change.newContent === null ? null : diffForNewFile(change.newContent)
    if (change.oldContent === null || change.newContent === null) return null
    return computeLineDiff(change.oldContent, change.newContent)
  }, [change, isNew])

  const stats = useMemo(() => rows === null ? null : diffStats(rows), [rows])
  const displayPath = change.displayPath || change.path
  const title = change.kind === 'delete' ? '删除文件' : isNew ? '新建文件' : '编辑文件'

  // 路径太长时只展示尾部两段（与参考样式一致），悬停看全路径
  const shortPath = useMemo(() => {
    const segments = displayPath.replace(/\\/g, '/').split('/')
    return segments.length > 2 ? `…/${segments.slice(-2).join('/')}` : displayPath
  }, [displayPath])

  const visibleRows = rows?.slice(0, visibleLimit) ?? []
  const hiddenCount = (rows?.length ?? 0) - visibleRows.length

  return (
    <div className={`diff-card${failed ? ' diff-card--error' : ''}${collapsed ? ' is-collapsed' : ''}`}>
      {/* 头部用 div[role=button] 而非 <button>：内部还有「路径」按钮，按钮不能嵌套按钮 */}
      <div
        className="diff-card__head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setCollapsed((value) => !value)
        }}
      >
        <span className={`diff-card__icon${failed ? ' diff-card__icon--fail' : ''}`}>
          <Icon name={failed ? 'close' : 'check'} size={16} />
        </span>
        <span className="diff-card__title">{title}</span>
        {remoteReadOnly ? <span className="diff-card__hint">远端快照</span> : null}
        {rollbackLabel ? <span className="diff-card__hint" title={outcome?.message}>{rollbackLabel}</span> : null}
        <button
          type="button"
          className="diff-card__path diff-card__path--link"
          title={remoteReadOnly ? `远端路径（尚未映射）：${displayPath}` : `在编辑器中打开 ${displayPath}`}
          disabled={remoteReadOnly}
          onClick={(event) => {
            // 阻止冒泡到头部：点路径是打开文件，不是折叠卡片
            event.preventDefault()
            event.stopPropagation()
            if (remoteReadOnly) return
            void openFileFromChat(change.path || displayPath)
          }}
        >
          {shortPath}
        </button>
        <span className="diff-card__spacer" />
        {stats === null ? (
          <span className="diff-card__hint">内容未存档</span>
        ) : (
          <span className="diff-card__stats" title={stats.approximate ? DIFF_APPROXIMATION_HINT : undefined}>
            {stats.approximate ? <span className="diff-card__hint">估算</span> : null}
            <span className="diff-card__add">{stats.approximate ? '≈' : ''}+{stats.added}</span>
            <span className="diff-card__del">{stats.approximate ? '≈' : ''}-{stats.removed}</span>
          </span>
        )}
        <Icon name="chevron" size={16} className="diff-card__chevron" />
      </div>

      {collapsed ? null : change.truncated ? (
        <div className="diff-card__body diff-card__body--empty">
          文件过大或为二进制格式，未保存内容快照（无法展示差异，也不支持自动撤回）。
        </div>
      ) : rows === null ? (
        <div className="diff-card__body diff-card__body--empty">缺少完整内容快照，无法计算差异。</div>
      ) : rows.length === 0 ? (
        <div className="diff-card__body diff-card__body--empty">
          {change.kind === 'delete' ? '（删除空文件）' : isNew ? '（新建空文件）' : '（无文本差异）'}
        </div>
      ) : (
        <div className="diff-card__body">
          {stats?.approximate ? <div className="diff-card__hint">{DIFF_APPROXIMATION_HINT}</div> : null}
          {visibleRows.map((row, index) => (
            <div key={index} className={`diff-row diff-row--${row.type}`}>
              <span className="diff-row__no">{row.newNo ?? ''}</span>
              <span className="diff-row__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              </span>
              <span className="diff-row__text">
                {row.text || ' '}
                {row.noNewline ? <span className="diff-card__hint">（文件末尾无换行）</span> : null}
              </span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <button type="button" className="diff-card__more" onClick={() => setVisibleLimit(limit => limit + MAX_RENDER_ROWS)}>
              还有 {hiddenCount} 行，继续展开 {Math.min(hiddenCount, MAX_RENDER_ROWS)} 行
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
