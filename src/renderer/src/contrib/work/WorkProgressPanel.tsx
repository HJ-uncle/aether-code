import { memo, useId, useMemo, useState, type JSX } from 'react'
import type { EngineFileChange, EngineTodo } from '@shared/ipc'
import { sessionStorageKey } from '@renderer/core/engine/source'
import { previewKindFor } from '@renderer/core/editor/preview'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { DIFF_APPROXIMATION_HINT } from '../chat/diff'
import { useCollapseMemory } from '../chat/useCollapseMemory'
import { workProgressChangeStatus, workProgressPath, type WorkProgressChange } from './work-progress-state'
import { workFileChangeCode, workFileChangeStats } from './work-file-change-presentation'
import { artifactChangesCancel } from './work-session-artifacts'
import type { WorkProgressSyncState } from './useWorkProgressChanges'
import { WorkChangeReviewActions } from './WorkChangeReviewActions'
import './work-progress-panel.css'

export interface WorkProgressPanelProps {
  sessionId: string
  turnKey: string
  changes: readonly WorkProgressChange[]
  scopedToTurn: boolean
  streaming: boolean
  sync: WorkProgressSyncState
  workspacePath?: string | null
  onOpenFile: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  onShowChanges: () => void
}

const TODO_LABELS: Record<EngineTodo['status'], string> = {
  pending: '待开始', in_progress: '进行中', done: '已完成', cancelled: '已取消'
}

export const WorkTodoProgress = memo(function WorkTodoProgress({ todos }: { todos: EngineTodo[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const done = todos.filter(todo => todo.status === 'done').length
  const cancelled = todos.filter(todo => todo.status === 'cancelled').length
  const current = todos.find(todo => todo.status === 'in_progress')
  if (!todos.length) return null
  return <section className="work-progress-panel" aria-label="执行反馈">
    <section className="work-progress-panel__section work-progress-panel__section--todos" aria-label="任务清单">
      <button type="button" className="work-progress-panel__todo-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        <span className="work-progress-panel__title"><Icon name="check-all" size={15} /><span>任务清单</span></span>
        <span className="work-progress-panel__count" aria-live="polite">{done} / {todos.length} 已完成{cancelled ? ` · ${cancelled} 已取消` : ''}</span>
        <Icon name="chevron-right" size={13} className="work-progress-panel__changes-chevron" />
      </button>
      {!expanded && current ? <div className="work-progress-panel__current-todo" aria-label="当前步骤">
        <Spinner size={12} /><span title={current.title}>{current.title}</span>
      </div> : null}
      <ol id={listId} className="work-progress-panel__todos" hidden={!expanded}>
        {todos.map(todo => <li key={todo.id} data-todo-id={todo.id} data-status={todo.status} aria-label={`${todo.title} · ${TODO_LABELS[todo.status]}`}>
          <span className={`work-progress-panel__todo-icon work-progress-panel__todo-icon--${todo.status}`} aria-hidden="true">
            {todo.status === 'in_progress' ? <Spinner size={14} /> : <Icon name={todo.status === 'done' ? 'check' : todo.status === 'cancelled' ? 'close' : 'circle'} size={15} />}
          </span>
          <span className="work-progress-panel__todo-text">{todo.title}</span>
          {todo.status !== 'done' ? <span className={`work-progress-panel__todo-status work-progress-panel__todo-status--${todo.status}`}>{TODO_LABELS[todo.status]}</span> : null}
        </li>)}
      </ol>
    </section>
  </section>
})

/** Each card receives only its owning turn's receipts from the shared ledger reader. */
export const WorkProgressPanel = memo(function WorkProgressPanel({ sessionId, turnKey, changes, scopedToTurn, streaming, sync, workspacePath, onOpenFile, onOpenChange, onShowChanges }: WorkProgressPanelProps): JSX.Element | null {
  const [changesMemory, setChangesOpen] = useCollapseMemory(sessionStorageKey(`work-progress-changes:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnKey)}`))
  const changesOpen = changesMemory ?? false
  const bodyId = useId()
  const visibleChanges = useMemo(() => changes.filter(change => !artifactChangesCancel(change.records)), [changes])
  const turnRecords = useMemo(() => visibleChanges.flatMap(file => file.records), [visibleChanges])
  const pendingFiles = visibleChanges.filter(change => workProgressChangeStatus(change.records).pending > 0).length
  const viewLabel = scopedToTurn ? '查看本轮成果' : '查看成果记录'
  if (!visibleChanges.length) return null
  return <section className="work-progress-panel" aria-label="本轮成果摘要" data-result-turn-id={turnKey}>
    <section className="work-progress-panel__section work-progress-panel__section--changes">
      <div className="work-progress-panel__changes">
        <div className="work-progress-panel__heading">
          <button type="button" className="work-progress-panel__changes-toggle" aria-expanded={changesOpen} aria-controls={bodyId}
            onClick={() => setChangesOpen(!changesOpen)}>
            <span className="work-progress-panel__title"><span>成果</span><span className="work-progress-panel__count">{visibleChanges.length} 个文件</span></span>
            <Icon className="work-progress-panel__changes-chevron" name="chevron-right" size={13} />
          </button>
          {scopedToTurn ? <WorkChangeReviewActions key={turnKey} sessionId={sessionId} workspacePath={workspacePath}
            changes={turnRecords} mode="turn" compact streaming={streaming} refreshing={sync.syncing}
            disabled={sync.syncError || sync.retryDisabled && !sync.syncing} onChanged={sync.retry} /> : null}
          <button type="button" className="work-progress-panel__review-summary" aria-label={scopedToTurn ? '查看本轮全部成果' : '查看全部成果记录'} title={viewLabel} onClick={onShowChanges}>
            <span>{pendingFiles ? `${pendingFiles} 个待确认` : '查看全部'}</span><Icon name="chevron-right" size={13} />
          </button>
        </div>
        <div id={bodyId} className="work-progress-panel__changes-body" hidden={!changesOpen}>
          <ul className="work-progress-panel__files">
            {visibleChanges.slice(0, 3).map(change => <WorkProgressFileRow key={change.key} change={change} workspacePath={workspacePath}
              onOpenFile={onOpenFile} onOpenChange={onOpenChange} onShowChanges={onShowChanges} />)}
          </ul>
          <footer className="work-progress-panel__footer">
            {visibleChanges.length > 3 ? <span>还有 {visibleChanges.length - 3} 个文件</span> : null}
            <button type="button" onClick={onShowChanges}>{viewLabel}<Icon name="chevron-right" size={12} /></button>
          </footer>
        </div>
      </div>
    </section>
  </section>
})

/** A session sync error cannot claim a new turn produced an artifact. */
export function WorkProgressSync({ state }: { state: WorkProgressSyncState }): JSX.Element | null {
  return state.syncError ? <div className="work-progress-panel work-progress-panel__sync">
    <span role="status">{state.syncing ? '正在重新同步成果记录…' : '成果记录暂未同步，将自动重试'}</span>
    <button type="button" disabled={state.retryDisabled} onClick={state.retry}>重新同步成果</button>
  </div> : null
}

const WorkProgressFileRow = memo(function WorkProgressFileRow({ change: { latest, records }, workspacePath, onOpenFile, onOpenChange, onShowChanges }: {
  change: WorkProgressChange
  workspacePath?: string | null
  onOpenFile: WorkProgressPanelProps['onOpenFile']
  onOpenChange: WorkProgressPanelProps['onOpenChange']
  onShowChanges: WorkProgressPanelProps['onShowChanges']
}): JSX.Element {
  const stats = useMemo(() => latest.kind === 'delete' ? null : workFileChangeStats(latest), [latest])
  const display = workProgressPath(latest.path, workspacePath)
  const separator = display.lastIndexOf('/')
  const name = display.slice(separator + 1)
  const directory = separator > 0 ? display.slice(0, separator) : ''
  const code = workFileChangeCode(latest)
  const kindLabel = code === 'U' ? '新增' : code === 'D' ? '删除' : '修改'
  const status = workProgressChangeStatus(records)
  const deleted = latest.kind === 'delete' && latest.status !== 'reverted'
  return <li data-change-id={latest.id}>
    <button type="button" className="work-progress-panel__file" title={`${latest.path}\n${kindLabel} · ${status.detail}`}
      aria-label={`${display} · ${kindLabel} · ${status.detail}`}
      onClick={() => onOpenChange ? onOpenChange(latest) : deleted ? onShowChanges() : onOpenFile(latest.path)}>
      <span className="work-progress-panel__file-icon"><Icon name={previewKindFor(latest.path) === 'image' ? 'image' : 'file'} size={18} /></span>
      <span className="work-progress-panel__file-label">
        <span className="work-progress-panel__file-name">{name}</span>
        {directory ? <span className="work-progress-panel__file-path">{directory}</span> : null}
      </span>
      {stats ? <span className="work-progress-panel__file-stats" title={stats.approximate ? DIFF_APPROXIMATION_HINT : '最新一次修改的增删行数'}
        aria-label={`最新修改${stats.approximate ? '估算' : ''}：新增 ${stats.added} 行，删除 ${stats.removed} 行`}>
        {stats.approximate ? <span className="work-progress-panel__file-estimate">约</span> : null}
        <span className="work-progress-panel__file-added">+{stats.added}</span><span className="work-progress-panel__file-removed">-{stats.removed}</span>
      </span> : <span className="work-progress-panel__file-code" data-change-code={code} title={kindLabel} aria-label={kindLabel}>{code}</span>}
      {!status.pending ? <span className="work-progress-panel__file-state" title={status.detail}>{status.label}</span> : null}
      <Icon name="chevron-right" size={12} />
    </button>
  </li>
})
