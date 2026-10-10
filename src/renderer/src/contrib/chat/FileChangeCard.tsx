import { useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { EngineFileChange } from '@shared/ipc'
import { getRevertOutcome, revertStatusLabel, subscribeReverts } from '@renderer/core/engine/change-revert'
import { Icon } from '@renderer/workbench/icons'
import { openFileFromChat } from './open-file'
import { useCollapseMemory } from './useCollapseMemory'
import {
  FILE_CHANGE_PREVIEW_ROWS,
  compactFileChangeRows,
  fileChangeInitiallyCollapsed,
  fileChangeLanguage,
  highlightFileChangeLine,
  takeFileChangePreviewRows
} from './file-change-preview'
import {
  DIFF_APPROXIMATION_HINT,
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
  /** 分批渲染差异片段，不把省略的未修改内容计入预览。 */
  const [visibleLimit, setVisibleLimit] = useState(FILE_CHANGE_PREVIEW_ROWS)
  // 删除只保留摘要；用户主动选择优先于默认值，分页回收后也不重新展开。
  const [manualCollapsed, setCollapsed] = useCollapseMemory(`file-change:${change.id}`)
  const collapsed = manualCollapsed ?? fileChangeInitiallyCollapsed(change)
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

  const previewRows = useMemo(() => compactFileChangeRows(rows ?? []), [rows])
  const visibleRows = useMemo(() => takeFileChangePreviewRows(previewRows, visibleLimit), [previewRows, visibleLimit])
  const language = fileChangeLanguage(displayPath)
  const highlightedRows = useMemo(
    () => collapsed ? [] : visibleRows.map(row => row.type === 'gap' ? '' : highlightFileChangeLine(row.text || ' ', language)),
    [collapsed, visibleRows, language]
  )
  const hasMore = previewRows.length > visibleRows.length
  const stateIcon = failed ? 'close' : state === 'running' ? 'restart' : state === 'done' ? 'check' : 'clock-outline'

  return (
    <div className={`diff-card${failed ? ' diff-card--error' : ''}${collapsed ? ' is-collapsed' : ''}`} data-change-kind={change.kind}>
      {/* 头部用 div[role=button] 而非 <button>：内部还有「路径」按钮，按钮不能嵌套按钮 */}
      <div
        className="diff-card__head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`${title} ${displayPath}`}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setCollapsed(!collapsed)
        }}
      >
        <span className={`diff-card__icon diff-card__icon--${state}`}>
          <Icon name={stateIcon} size={14} />
        </span>
        <span className="diff-card__title">{title}</span>
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
      {remoteReadOnly || rollbackLabel ? (
        <div className="diff-card__metadata">
          {remoteReadOnly ? <span className="diff-card__hint">远端快照</span> : null}
          {rollbackLabel ? <span className="diff-card__hint" title={outcome?.message}>{rollbackLabel}</span> : null}
        </div>
      ) : null}

      {collapsed ? null : change.truncated ? (
        <div className="diff-card__body diff-card__body--empty">
          文件过大或为二进制格式，未保存内容快照（无法展示差异，也不支持自动撤回）。
        </div>
      ) : rows === null ? (
        <div className="diff-card__body diff-card__body--empty">缺少完整内容快照，无法计算差异。</div>
      ) : previewRows.length === 0 ? (
        <div className="diff-card__body diff-card__body--empty">
          {change.kind === 'delete' ? '（删除空文件）' : isNew ? '（新建空文件）' : '（无文本差异）'}
        </div>
      ) : (
        <>
          {stats?.approximate ? <div className="diff-card__notice">{DIFF_APPROXIMATION_HINT}</div> : null}
          <div className="diff-card__body" tabIndex={0} aria-label={`${displayPath} 文件差异`}>
            <div className="diff-card__lines">
              {visibleRows.map((row, index) => row.type === 'gap' ? (
                <div key={index} className="diff-card__gap">
                  <span>已省略 {row.count} 行未修改内容</span>
                </div>
              ) : (
                <div key={index} className={`diff-row diff-row--${row.type}`}>
                  <span className="diff-row__gutter" aria-hidden="true">
                    <span className="diff-row__no">{row.type === 'del' ? row.oldNo ?? '' : row.newNo ?? ''}</span>
                    <span className="diff-row__sign">
                      {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
                    </span>
                  </span>
                  <span className="diff-row__text">
                    {/* highlight.js 对源文本转义后生成着色 span，不注入模型提供的 HTML。 */}
                    <code dangerouslySetInnerHTML={{ __html: highlightedRows[index] }} />
                    {row.noNewline ? <span className="diff-card__hint">（文件末尾无换行）</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {hasMore ? (
            <button type="button" className="diff-card__more" onClick={() => setVisibleLimit(limit => limit + FILE_CHANGE_PREVIEW_ROWS)}>
              展开更多差异
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
