import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { EngineFileChange, EngineRequestInput } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { toast } from '@renderer/core/toast'
import { requestOrThrow } from '@renderer/core/engine/client'
import { changeIdsOf, keepChanges } from '@renderer/core/engine/change-actions'
import { dismissRevertReport, getRevertReport, groupRevertResults, revertChanges, revertComplete, revertStatusLabel, revertSummary, subscribeReverts, type RevertReport } from '@renderer/core/engine/change-revert'
import { assertEngineSource, getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { requestWorkPreviews } from '@renderer/core/workbench/preview-request'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { ActionMenu } from '@renderer/workbench/ActionMenu'
import { workChangeReviewIdentity, workChangeReviewTargets, type WorkChangeReviewAction, type WorkChangeReviewMode } from './work-change-review'
import './work-change-review.css'

export interface WorkChangeReviewActionsProps {
  sessionId: string
  workspacePath?: string | null
  changes: EngineFileChange[]
  streaming: boolean
  disabled?: boolean
  refreshing?: boolean
  onChanged: () => void
  mode?: WorkChangeReviewMode
  presentation?: 'buttons' | 'menu'
  compact?: boolean
}

// Row actions and the batch toolbar operate on the same files. A session lock
// prevents two mounted controls from submitting competing keep/revert requests.
const locks = new Map<string, symbol>()
const listeners = new Set<() => void>()
const subscribeLocks = (notify: () => void): (() => void) => { listeners.add(notify); return () => { listeners.delete(notify) } }
const notifyLocks = (): void => { for (const listener of listeners) listener() }

export function WorkChangeReviewActions(props: WorkChangeReviewActionsProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ScopedWorkChangeReviewActions key={`${source}:${props.sessionId}`} {...props} source={source} />
}

function ScopedWorkChangeReviewActions({ sessionId, workspacePath, changes, streaming, disabled = false, refreshing = false, onChanged, mode = 'batch', presentation = 'buttons', compact = false, source }: WorkChangeReviewActionsProps & { source: number }): JSX.Element | null {
  const { ready } = useApp()
  const scope = `${source}:${sessionId}`
  const locked = useSyncExternalStore(subscribeLocks, () => locks.has(scope))
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  const submission = useRef<{ ids: string[]; report?: RevertReport } | null>(null)
  const scopedReport = (() => {
    if (mode !== 'turn' || !report) return report
    // Successful creations may disappear from the visible card after refresh.
    // Keep the submitted identities so a partial report still includes them.
    const ids = new Set([...changes.map(change => change.id), ...submission.current?.ids ?? []])
    const results = report.results.filter(item => ids.has(item.id))
    const ownReport = submission.current?.report === report
    const total = ownReport ? Math.max(report.total, submission.current!.ids.length)
      : results.length === report.results.length ? report.total : results.length
    return results.length || ownReport ? { results, total,
      reverted: results.filter(item => item.status === 'reverted').length,
      conflicts: results.filter(item => item.status === 'conflict').length,
      unavailable: results.filter(item => item.status === 'unavailable').length,
      failed: results.filter(item => item.status === 'failed').length } : null
  })()
  const [working, setWorking] = useState<WorkChangeReviewAction | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const current = useRef({ sessionId, workspacePath, streaming, disabled, refreshing, ready, changes, onChanged })
  current.current = { sessionId, workspacePath, streaming, disabled, refreshing, ready, changes, onChanged }
  const mounted = useRef(false)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const keepTargets = useMemo(() => workChangeReviewTargets(sessionId, changes, 'keep', mode), [sessionId, changes, mode])
  const revertTargets = useMemo(() => workChangeReviewTargets(sessionId, changes, 'revert', mode), [sessionId, changes, mode])
  const pendingCount = changeIdsOf(keepTargets).length
  const canAct = ready && !streaming && !disabled && !refreshing && !locked
  const refreshingOnly = refreshing && ready && !streaming && !disabled && !locked
  const blockedReason = !ready ? '引擎尚未就绪，请连接后重新确认文件改动'
    : streaming ? '任务正在运行，请结束后重新确认文件改动'
      : locked ? '正在确认或处理文件改动'
        : disabled ? '文件改动暂不可确认，请等待数据就绪或处理错误后重试'
          : refreshing ? '文件改动正在刷新，请刷新完成后重新确认' : undefined
  const isCurrent = (): boolean => mounted.current && current.current.sessionId === sessionId && source === getEngineSource()
  const act = async (action: WorkChangeReviewAction): Promise<void> => {
    if (!isCurrent() || !current.current.ready || current.current.streaming || current.current.disabled || current.current.refreshing || locks.has(scope)) return
    const targets = workChangeReviewTargets(sessionId, current.current.changes, action, mode)
    const ids = changeIdsOf(targets)
    if (!ids.length) return
    const targetPaths = targets.map(change => change.path)
    const targetWorkspace = current.current.workspacePath
    const completed = current.current.onChanged
    const identity = workChangeReviewIdentity(targets)
    const token = Symbol(scope)
    locks.set(scope, token); notifyLocks()
    setWorking(action); setError(''); setNotice('')
    let attempted = false
    const assertCurrent = (): void => {
      assertEngineSource(source)
      if (!isCurrent()) throw new Error('当前任务已变化，未继续操作原任务改动')
      if (!current.current.ready) throw new Error('引擎尚未就绪，请连接后重新确认文件改动')
      if (current.current.streaming) throw new Error('任务正在运行，请结束后重新确认文件改动')
      if (current.current.disabled) throw new Error('文件改动暂不可确认，请等待数据就绪或处理错误后重试')
      if (current.current.refreshing) throw new Error('文件改动正在刷新，请刷新完成后重新确认')
      const latest = workChangeReviewTargets(sessionId, current.current.changes, action, mode)
      if (workChangeReviewIdentity(latest) !== identity) throw new Error('文件改动列表已更新，请重新检查后确认')
    }
    try {
      const paths = [...new Set(targets.map(change => change.displayPath || change.path))]
      const describedPaths = paths.slice(0, 12).join('\n') + (paths.length > 12 ? `\n另有 ${paths.length - 12} 个文件，详见当前改动列表。` : '')
      const pathDetails = mode === 'turn' ? '' : `${describedPaths}\n\n`
      const explicit = targets.some(change => change.requiresExplicitRevert)
      const confirmed = await confirmDialog({
        title: mode === 'turn' ? '撤回本轮成果' : action === 'keep' ? mode === 'single' ? '保留文件改动' : '保留待确认改动' : mode === 'single' ? '撤回文件改动' : '撤回待确认改动',
        body: `${mode === 'turn' ? '仅撤回本轮生成的文件改动（含已保留的改动）。\n' : ''}${action === 'keep' ? '保留' : '撤回'}以下 ${paths.length} 个文件的 ${ids.length} 处改动？\n\n${pathDetails}${action === 'keep'
          ? '文件内容不变，这些记录将从待确认列表移除。'
          : `${mode === 'turn' ? '本轮新增的文件将删除，修改或删除的文件将恢复到本轮之前。' : '文件将按快照恢复。'}仅恢复版本匹配的改动；冲突或缺少快照的文件会保留并逐项报告。对话历史保持不变。`}${action === 'revert' && explicit ? '\n这些记录包含命令运行前后的文件比较，可能包含同期手动编辑，请确认也需要撤回。' : ''}`,
        confirmText: mode === 'turn' ? '确认撤回' : action === 'keep' ? '保留' : '撤回',
        danger: action === 'revert'
      })
      if (!confirmed) return
      assertCurrent()
      const expectedEngine = getExpectedEngine()
      const request = async <T,>(input: EngineRequestInput): Promise<T> => {
        assertCurrent()
        attempted = true
        const response = await requestOrThrow<T>({ ...input, expectedEngine })
        // The receipt belongs to the original session even if its panel has
        // closed. Keep partial-conflict reports available when the user returns.
        // Changing the engine still invalidates the response and its cache.
        assertEngineSource(source)
        return response
      }
      if (action === 'keep') {
        await keepChanges(request, sessionId, targets)
        if (isCurrent()) setNotice(`已保留 ${ids.length} 处改动`)
      } else {
        if (mode === 'turn') submission.current = { ids }
        const outcome = await revertChanges(request, { sessionId, ids, scope: mode === 'batch' ? 'pending' : 'all' })
        if (mode === 'turn' && submission.current) submission.current.report = outcome
        if (isCurrent() && mode === 'single') setNotice(revertSummary(outcome))
        if (isCurrent() && mode === 'turn' && revertComplete(outcome) &&
            ids.every(id => outcome.results.some(item => item.id === id))) toast.success('本轮文件改动已撤回')
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (locks.get(scope) === token) { locks.delete(scope); notifyLocks() }
      // A response may arrive after this row or task unmounts. Its writes still
      // belong to the captured targets, never the file currently being viewed.
      // Even incomplete acknowledgements may have changed those disk files.
      if (attempted && source === getEngineSource()) requestWorkPreviews(source, sessionId, targetPaths, targetWorkspace)
      if (isCurrent()) {
        setWorking(null)
        if (attempted) completed()
      }
    }
  }
  if (!keepTargets.length && !revertTargets.length && !error && !notice && !(mode !== 'single' && scopedReport)) return null
  const keepLabel = mode === 'single' ? '保留此改动' : '保留待确认改动'
  const revertLabel = mode === 'turn' ? '撤回本轮成果' : mode === 'single' ? '撤回此改动' : '撤回待确认改动'
  return <div className={`work-change-review work-change-review--${mode}`}>
    <div className={`work-change-review__actions${refreshingOnly ? ' is-refreshing' : ''}`} role="group" aria-label={mode === 'turn' ? '本轮成果操作' : mode === 'single' ? '此文件改动操作' : '待确认改动操作'} aria-busy={working !== null || refreshing} aria-description={blockedReason} title={blockedReason}>
      {mode === 'batch' && pendingCount > 0 ? <span className="work-change-review__count">{pendingCount} 条修改待确认</span> : null}
      {presentation === 'menu' ? (keepTargets.length || revertTargets.length ? <ActionMenu label="批量改动操作" disabled={!canAct} className="work-change-review__menu"
        icon={<><span>批量操作</span><Icon name="chevron" size={13} /></>}
        items={[
          ...(keepTargets.length ? [{ id: 'keep', label: keepLabel, icon: 'check' as const, onSelect: () => void act('keep') }] : []),
          ...(revertTargets.length ? [{ id: 'revert', label: revertLabel, icon: 'undo' as const, danger: true, onSelect: () => void act('revert') }] : [])
        ]} /> : null) : <>
      {keepTargets.length ? <button type="button" aria-label={keepLabel} disabled={!canAct} onClick={() => void act('keep')}>
        {working === 'keep' ? <Spinner size={13} /> : <Icon name="check" size={13} />}{compact ? '保留' : keepLabel}
      </button> : null}
      {revertTargets.length ? <button type="button" aria-label={revertLabel} disabled={!canAct} onClick={() => void act('revert')}>
        {working === 'revert' ? <Spinner size={13} /> : <Icon name="undo" size={13} />}{mode === 'turn' && working === 'revert' ? '处理中' : compact ? '撤回' : revertLabel}
      </button> : null}
      </>}
      {mode !== 'turn' && streaming && (keepTargets.length || revertTargets.length) ? <span className="work-change-review__hint">任务结束后可确认</span> : null}
    </div>
    {error ? <p className="work-change-review__error" role="alert">{error}</p> : null}
    {notice ? <p className="work-change-review__notice" role="status">{notice}</p> : null}
    {mode !== 'single' && scopedReport ? <section className="work-change-review__report" aria-label="文件回退结果" aria-live="polite">
      <div>{revertSummary(scopedReport)}</div>
      {!revertComplete(scopedReport) ? <p>部分改动未恢复，文件和对话历史已保留，请查看逐文件结果。</p> : null}
      <details key={JSON.stringify(scopedReport.results.map(item => [item.id, item.status]))} open={!revertComplete(scopedReport)}>
        <summary>逐文件结果</summary>
        <ul>{groupRevertResults(scopedReport).map(({ path, items }) => <li key={path}>
          <span>{path.replace(/\\/g, '/')}</span>
          <span className="work-change-review__statuses">{[...new Set(items.map(item => item.status))].map(status => `${revertStatusLabel[status]} ${items.filter(item => item.status === status).length} 处`).join(' · ')}</span>
          {[...new Set(items.map(item => item.message).filter(Boolean))].map(message => <p key={message}>{message}</p>)}
        </li>)}</ul>
      </details>
      <button type="button" onClick={() => dismissRevertReport(sessionId)}>关闭结果</button>
    </section> : null}
  </div>
}
