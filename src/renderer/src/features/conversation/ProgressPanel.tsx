import { memo, useId, useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import { sessionStorageKey } from '@renderer/core/engine/source'
import { Icon } from '@renderer/ui/icons'
import { FileGlyph } from '../explorer/FileGlyph'
import { DIFF_APPROXIMATION_HINT } from './shared/diff'
import { useCollapseMemory } from './shared/useCollapseMemory'
import { sessionProgressChangeStatus, sessionProgressPath, type SessionProgressChange } from './progress-state'
import { sessionFileChangeCode, sessionFileChangeStats } from '../artifacts/file-change-presentation'
import { artifactChangesCancel } from '../artifacts/session-artifacts'
import type { SessionProgressSyncState } from './useSessionProgressChanges'
import { ChangeReviewActions } from '../artifacts/ChangeReviewActions'
import './progress-panel.css'
export { TodoProgress } from './TodoProgress'

const PREVIEW_FILE_COUNT = 5

export interface ProgressPanelProps {
  sessionId: string
  turnKey: string
  changes: readonly SessionProgressChange[]
  scopedToTurn: boolean
  streaming: boolean
  sync: SessionProgressSyncState
  workspacePath?: string | null
  onOpenFile: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  onShowChanges: () => void
  onDisclosureLayout?: () => void
}

/** Each card receives only its owning turn's receipts from the shared ledger reader. */
export const ProgressPanel = memo(function ProgressPanel({ sessionId, turnKey, changes, scopedToTurn, streaming, sync, workspacePath, onOpenFile, onOpenChange, onShowChanges, onDisclosureLayout }: ProgressPanelProps): JSX.Element | null {
  const [changesMemory, setChangesOpen] = useCollapseMemory(sessionStorageKey(`work-progress-changes:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnKey)}`))
  const changesOpen = changesMemory ?? false
  const previousOpen = useRef(changesOpen)
  useLayoutEffect(() => {
    if (previousOpen.current === changesOpen) return
    previousOpen.current = changesOpen
    // Preserve the conversation's follow/read choice before paint. Waiting for
    // its resize observer would expose a frame above the new bottom first.
    onDisclosureLayout?.()
  }, [changesOpen, onDisclosureLayout])
  const bodyId = useId()
  const visibleChanges = useMemo(() => changes.filter(change => !artifactChangesCancel(change.records)), [changes])
  const turnRecords = useMemo(() => visibleChanges.flatMap(file => file.records), [visibleChanges])
  const pendingFiles = visibleChanges.filter(change => sessionProgressChangeStatus(change.records).pending > 0).length
  const viewLabel = scopedToTurn ? '查看本轮成果' : '查看成果记录'
  const remainingFiles = Math.max(0, visibleChanges.length - PREVIEW_FILE_COUNT)
  if (!visibleChanges.length) return null
  return <section className="work-progress-panel" aria-label="本轮成果摘要" data-result-turn-id={turnKey}>
    <section className="work-progress-panel__section work-progress-panel__section--changes">
      <div className="work-progress-panel__changes">
        <div className="work-progress-panel__heading">
          <button type="button" className="work-progress-panel__changes-toggle" aria-expanded={changesOpen} aria-controls={bodyId}
            aria-label={`${changesOpen ? '收起' : '展开'}成果文件列表，共 ${visibleChanges.length} 个文件`}
            title={changesOpen ? '收起文件列表' : '展开文件列表'}
            onClick={() => setChangesOpen(!changesOpen)}>
            <Icon className="work-progress-panel__changes-chevron" name="chevron-right" size={14} />
          </button>
          <button type="button" className="work-progress-panel__review-summary" aria-label={scopedToTurn ? '查看本轮全部成果' : '查看全部成果记录'} title={viewLabel} onClick={onShowChanges}>
            <span className="work-progress-panel__title"><span>成果</span><span className="work-progress-panel__count" title={`${visibleChanges.length} 个文件`}>{visibleChanges.length} 个文件</span></span>
          </button>
          {scopedToTurn ? <ChangeReviewActions key={turnKey} sessionId={sessionId} workspacePath={workspacePath}
            changes={turnRecords} mode="turn" compact streaming={streaming} refreshing={sync.syncing}
            disabled={sync.syncError || sync.retryDisabled && !sync.syncing} onChanged={sync.retry} /> : null}
          {pendingFiles ? <button type="button" className="work-progress-panel__pending" aria-label={`${viewLabel}，${pendingFiles} 个文件待确认`} onClick={onShowChanges}>
            <span>{pendingFiles} 待确认</span><Icon name="chevron-right" size={13} />
          </button> : null}
        </div>
        <div id={bodyId} className="work-progress-panel__changes-body" hidden={!changesOpen}>
          <ul className="work-progress-panel__files">
            {visibleChanges.slice(0, PREVIEW_FILE_COUNT).map(change => <SessionProgressFileRow key={change.key} change={change} workspacePath={workspacePath}
              onOpenFile={onOpenFile} onOpenChange={onOpenChange} onShowChanges={onShowChanges} />)}
          </ul>
          {remainingFiles > 0 ? <footer className="work-progress-panel__footer work-progress-panel__overflow">
            <button type="button" aria-label={`${viewLabel}，共 ${visibleChanges.length} 个文件`} onClick={onShowChanges}>
              <span>还有 {remainingFiles} 个文件</span><Icon name="chevron-right" size={12} />
            </button>
          </footer> : null}
        </div>
      </div>
    </section>
  </section>
})

/** A session sync error cannot claim a new turn produced an artifact. */
export function SessionProgressSync({ state }: { state: SessionProgressSyncState }): JSX.Element | null {
  return state.syncError ? <div className="work-progress-panel work-progress-panel__sync">
    <span role="status">{state.syncing ? '正在重新同步成果记录…' : '成果记录暂未同步，将自动重试'}</span>
    <button type="button" disabled={state.retryDisabled} onClick={state.retry}>重新同步成果</button>
  </div> : null
}

const SessionProgressFileRow = memo(function SessionProgressFileRow({ change: { latest, records }, workspacePath, onOpenFile, onOpenChange, onShowChanges }: {
  change: SessionProgressChange
  workspacePath?: string | null
  onOpenFile: ProgressPanelProps['onOpenFile']
  onOpenChange: ProgressPanelProps['onOpenChange']
  onShowChanges: ProgressPanelProps['onShowChanges']
}): JSX.Element {
  const stats = useMemo(() => latest.kind === 'delete' ? null : sessionFileChangeStats(latest), [latest])
  const display = sessionProgressPath(latest.path, workspacePath)
  const separator = display.lastIndexOf('/')
  const name = display.slice(separator + 1)
  const directory = separator > 0 ? display.slice(0, separator) : ''
  const code = sessionFileChangeCode(latest)
  const kindLabel = code === 'U' ? '新增' : code === 'D' ? '删除' : '修改'
  const status = sessionProgressChangeStatus(records)
  const deleted = latest.kind === 'delete' && latest.status !== 'reverted'
  return <li data-change-id={latest.id}>
    <button type="button" className="work-progress-panel__file" title={`${latest.path}\n${kindLabel} · ${status.detail}`}
      aria-label={`${display} · ${kindLabel} · ${status.detail}`}
      onClick={() => onOpenChange ? onOpenChange(latest) : deleted ? onShowChanges() : onOpenFile(latest.path)}>
      <span className="work-progress-panel__file-icon"><FileGlyph name={latest.path} size={20} /></span>
      <span className="work-progress-panel__file-label">
        <span className="work-progress-panel__file-name">{name}</span>
        {directory ? <span className="work-progress-panel__file-path">{directory}</span> : null}
      </span>
      <span className="work-progress-panel__file-meta">
        {stats ? <span className="work-progress-panel__file-stats" title={stats.approximate ? DIFF_APPROXIMATION_HINT : '最新一次修改的增删行数'}
          aria-label={`最新修改${stats.approximate ? '估算' : ''}：新增 ${stats.added} 行，删除 ${stats.removed} 行`}>
          {stats.approximate ? <span className="work-progress-panel__file-estimate">约</span> : null}
          <span className="work-progress-panel__file-added">+{stats.added}</span><span className="work-progress-panel__file-removed">-{stats.removed}</span>
        </span> : <span className="work-progress-panel__file-code" data-change-code={code} title={kindLabel} aria-label={kindLabel}>{code}</span>}
        {!status.pending ? <span className="work-progress-panel__file-state" title={status.detail}>{status.label}</span> : null}
      </span>
      <Icon name="chevron-right" size={12} />
    </button>
  </li>
})
