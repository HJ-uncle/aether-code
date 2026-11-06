import { memo, useMemo, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { DIFF_APPROXIMATION_HINT } from '../chat/diff'
import { FileGlyph } from '../explorer/FileGlyph'
import { workFileChangeCode, workFileChangeStats, workFileIsNew } from './work-file-change-presentation'
import './work-tool-details.css'

const stateLabels: Record<ToolActivity['state'], string> = {
  running: '进行中', done: '已完成', error: '失败', unknown: '状态未知', cancelled: '已停止', waiting: '等待中', interrupted: '已中断'
}

/** The inspector owns diff rendering; the transcript retains an actionable receipt. */
export const WorkFileChangeRow = memo(function WorkFileChangeRow({ change, state, onOpenChange }: {
  change: EngineFileChange
  state: ToolActivity['state']
  onOpenChange?: (change: EngineFileChange) => void
}): JSX.Element {
  const stats = useMemo(() => change.kind === 'delete' ? null : workFileChangeStats(change), [change])
  const path = change.displayPath || change.path
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path
  const action = change.kind === 'delete' ? '删除文件' : workFileIsNew(change) ? '新建文件' : '编辑文件'
  const failure = state === 'error' || state === 'interrupted'
  return <button type="button" className="work-file-change-row" data-change-id={change.id} data-tool-state={state}
    aria-label={`查看${action} ${path} · ${stateLabels[state]}`} title={onOpenChange ? `查看改动：${path}` : path}
    disabled={!onOpenChange} onClick={() => onOpenChange?.(change)}>
    <span className="work-file-change-row__icon" aria-hidden="true">{state === 'running' ? <Spinner size={14} />
      : failure ? <Icon name="warning" size={14} /> : state === 'waiting' ? <Icon name="clock-outline" size={14} />
        : state === 'cancelled' ? <Icon name="stop" size={14} /> : state === 'unknown' ? <Icon name="info" size={14} /> : <FileGlyph name={path} size={15} />}</span>
    <span className="work-file-change-row__action">{action}</span>
    <span className="work-file-change-row__name" title={path}>{name}</span>
    {state !== 'done' ? <span className="work-file-change-row__state">{stateLabels[state]}</span> : null}
    {stats ? <span className="work-file-change-row__stats" title={stats.approximate ? DIFF_APPROXIMATION_HINT : '文件改动行数'}
      aria-label={`${stats.approximate ? '估算：' : ''}新增 ${stats.added} 行，删除 ${stats.removed} 行`}>
      {stats.approximate ? <span className="work-file-change-row__estimate">估算</span> : null}
      <span className="work-file-change-row__added">+{stats.added}</span><span className="work-file-change-row__removed">-{stats.removed}</span>
    </span> : <span className="work-file-change-row__code" data-change-code={workFileChangeCode(change)} title={action}>{workFileChangeCode(change)}</span>}
    <Icon name="chevron-right" size={12} className="work-file-change-row__chevron" />
  </button>
})
