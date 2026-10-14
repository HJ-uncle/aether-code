import { createContext, useContext, useEffect, useId, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '@shared/subagent'
import type { PublishedChildReference } from '@shared/published-child'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource } from '@renderer/core/engine/source'
import { isSubagentActive } from '@renderer/core/engine/subagent-state'
import { assertSubagentConnection, captureSubagentConnection, getSubagentRun } from '@renderer/core/engine/client'
import { useCollaborationController } from '@renderer/core/engine/useCollaborationController'
import { controllerSavedStatus, type ControllerSavedRecord } from '@renderer/core/engine/collaboration-contract'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import type { SubagentControllerScope } from './subagent-controller-scope'
import './subagent-followup.css'

export const SubagentControllerContext = createContext<SubagentControllerScope | undefined>(undefined)

/** ACKs stay queryable after the outbox is cleared. Local removal never
 * changes the engine queue; every query uses the frozen original key/scope. */
export function ControllerReceiptHistory({ records, rootRunId, invocationRunId, disabled, onQuery, onRemove }: {
  records: ControllerSavedRecord[]; rootRunId?: string; invocationRunId?: string; disabled: boolean
  onQuery: (record: ControllerSavedRecord) => Promise<boolean>; onRemove: (record: ControllerSavedRecord) => Promise<boolean>
}): JSX.Element | null {
  const [notice, setNotice] = useState(''), [confirmKey, setConfirmKey] = useState<string>()
  if (!records.length) return null
  return <details className="subagent-receipt-history">
    <summary>已发送的补充要求 <span>{records.length}</span></summary>
    <p>接纳不代表已执行。查询只核对原回执；移除只清理本地记录，不取消或重发。</p>
    <div className="subagent-receipt-history__list">
      {records.map(item => <article key={item.requestKey} data-request-key={item.requestKey}>
        <details><summary><span>{controllerSavedStatus(item)}</span><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></summary>
          <p className="subagent-receipt-history__scope">{item.rootRunId === rootRunId && item.recipientInvocationRunId === invocationRunId ? '当前工作轮次' : '较早工作轮次'} · {item.recipientInvocationRunId}</p>
          <pre>{item.message}</pre><p className="subagent-receipt-history__scope">请求标识：{item.requestKey}</p>
          {item.kind === 'refused' ? <p>{item.rejection.message}（{item.rejection.code}）</p> : null}
          <div className="subagent-receipt-history__actions">
            {item.kind === 'accepted' ? <button type="button" className="link" disabled={disabled} onClick={() => void onQuery(item)}>查询原回执</button> : null}
            <button type="button" className="link" disabled={disabled} onClick={() => void navigator.clipboard.writeText(item.message).then(() => setNotice('原文已复制'), () => setNotice('复制失败，请手动保存原文'))}>复制原文</button>
            <button type="button" className="link" disabled={disabled} onClick={() => setConfirmKey(item.requestKey)}>移除此本地记录</button>
          </div>
          {confirmKey === item.requestKey ? <div className="subagent-receipt-history__confirm"><p>移除后将无法在此查询。原请求仍可能在引擎中执行，请先保存需要的原文。</p>
            <button type="button" className="link" disabled={disabled} onClick={() => void onRemove(item).then(removed => { if (removed) { setConfirmKey(undefined); setNotice('已移除此本地记录；原请求未取消或重发') } })}>确认移除记录</button>
            <button type="button" className="link" disabled={disabled} onClick={() => setConfirmKey(undefined)}>保留记录</button>
          </div> : null}
        </details>
      </article>)}
    </div>
    {notice ? <p role="status">{notice}</p> : null}
  </details>
}

export function ControllerTrackingRecovery({ message, disabled, onForget }: { message: string; disabled: boolean; onForget: () => Promise<boolean> }): JSX.Element {
  const [notice, setNotice] = useState('')
  return <details className="subagent-tracking-recovery"><summary>移除本地跟踪记录</summary>
    <p>原请求结果可能未知。请先复制或保存原文。移除只清理本地跟踪，不会取消原请求，也不会重新发送；它仍可能在原引擎执行。</p>
    <div><button type="button" className="link" disabled={disabled} onClick={() => void navigator.clipboard.writeText(message).then(() => setNotice('原文已复制'), () => setNotice('复制失败，请先手动保存上方原文'))}>复制原文</button>
      <button type="button" className="link" disabled={disabled} onClick={() => void onForget()}>确认移除本地记录</button></div>
    {notice ? <p role="status">{notice}</p> : null}
  </details>
}

/** Historical evidence keeps its exact watermark. Current controls use a
 * separate, explicitly requested read and never hydrate the history card. */
export function CodePublishedSubagentControl({ reference, visible }: { reference: PublishedChildReference; visible: boolean }): JSX.Element | null {
  const scope = useContext(SubagentControllerContext)
  if (!scope || scope.source !== reference.source || scope.source !== getEngineSource() || scope.sessionId !== reference.sessionId || scope.rootRunId !== reference.fence.rootRunId || reference.identity.parentSessionId !== scope.sessionId || reference.identity.rootSessionId !== scope.sessionId) return null
  return <PublishedCurrentControl key={JSON.stringify([scope, reference.identity])} reference={reference} scope={scope} visible={visible} />
}
function PublishedCurrentControl({ reference, scope, visible }: { reference: PublishedChildReference; scope: SubagentControllerScope; visible: boolean }): JSX.Element {
  const { ready } = useApp(), mounted = useRef(true), pending = useRef(false)
  const [run, setRun] = useState<SubagentRun>(), [loading, setLoading] = useState(false), [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const read = async (): Promise<void> => {
    if (pending.current || !ready || !visible) return
    pending.current = true; setLoading(true); setError('')
    const connection = captureSubagentConnection()
    const verify = (): void => { assertSubagentConnection(connection); if (!mounted.current || scope.source !== getEngineSource()) throw new Error('代理所属会话或引擎已变化，请返回当前会话重试') }
    try {
      verify()
      const identity = reference.identity
      const current = await getSubagentRun(identity.runId, { connection, verify, parentSessionId: identity.parentSessionId, rootSessionId: identity.rootSessionId, parentConversationId: identity.parentConversationId })
      verify()
      for (const key of ['tenantId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'createdAt'] as const) if (current[key] !== identity[key]) throw new Error('当前代理身份与此记录不一致，请重新确认')
      setRun(current)
    } catch (cause) { if (mounted.current && scope.source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; if (mounted.current) setLoading(false) }
  }
  return <section className="subagent-current" aria-label={`当前代理 ${reference.identity.agentName || '子代理'}`}>
    <div className="subagent-current__header"><span>当前代理{run ? isSubagentActive(run.status) ? ' · 正在运行' : ' · 本轮已结束' : ''}</span>
      <button type="button" className="link" disabled={loading || !ready || !visible} onClick={() => void read()}>{loading ? <><Spinner size={12} />正在确认…</> : run ? '刷新当前状态' : '查看当前代理'}</button>
    </div>
    <p className="subagent-current__hint">上方保留已发布记录；这里单独确认当前状态，补充要求仍交给同一轮代理。</p>
    {error ? <p className="subagent-followup__error" role="alert">{error}</p> : null}
    {run ? <CodeSubagentFollowup run={run} sessionId={scope.sessionId} source={scope.source} visible={visible} /> : null}
  </section>
}

/** Shared editing and keyboard behavior in the Code card and Work detail. */
export function SubagentFollowupInput({ id, value, readOnly, onChange, onDismiss, onSubmit, placeholder, labelledBy, describedBy }: {
  id: string; value: string; readOnly: boolean; onChange: (value: string) => void
  onDismiss: () => void; onSubmit: () => void; placeholder: string; labelledBy: string; describedBy: string
}): JSX.Element {
  return <textarea id={id} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} rows={2}
    placeholder={placeholder} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit() }
    }} />
}

export function CodeSubagentFollowup({ run, sessionId, source, visible }: { run: SubagentRun; sessionId: string; source: number; visible: boolean }): JSX.Element | null {
  const scope = useContext(SubagentControllerContext)
  // Published cards never render this component. A trusted message root and
  // direct child owner must both match before exposing a live control.
  if (!scope || scope.source !== source || scope.sessionId !== sessionId || run.rootSessionId !== sessionId || run.parentSessionId !== sessionId || !run.childSessionId) return null
  return <BoundFollowup key={JSON.stringify([source, sessionId, scope.rootRunId, run.runId])} run={run} scope={scope} visible={visible} />
}

function BoundFollowup({ run, scope, visible }: { run: SubagentRun; scope: SubagentControllerScope; visible: boolean }): JSX.Element | null {
  const { ready } = useApp()
  const id = useId(), toggle = useRef<HTMLButtonElement>(null), mounted = useRef(true)
  const [expanded, setExpanded] = useState(false), [draft, setDraft] = useState<string | undefined>(), [refreshKey, setRefreshKey] = useState(0)
  const draftRef = useRef(draft); draftRef.current = draft
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const active = isSubagentActive(run.status)
  const controller = useCollaborationController({ sessionId: scope.sessionId, rootRunId: scope.rootRunId, source: scope.source,
    childSessionId: run.childSessionId, invocationRunId: run.runId, active, ready: ready && visible, toolProfile: 'code', refreshKey,
    onUnacceptedDraft: message => { if (draftRef.current === undefined) { draftRef.current = message; setDraft(message) } } })
  const submit = async (retry = false): Promise<void> => {
    if (controller.busy || !visible) return
    const original = draftRef.current
    const clearsSentDraft = !controller.pending || original === undefined || original.trim() === controller.pending.message
    const accepted = retry ? await controller.retry() : controller.pending ? await controller.reconcile() : await controller.send((original ?? controller.restoredDraft?.message ?? '').trim())
    if (accepted && clearsSentDraft && mounted.current && scope.source === getEngineSource() && draftRef.current === original) { draftRef.current = undefined; setDraft(undefined) }
  }
  if (!active && !controller.pending && !controller.restoredDraft && !controller.history.length && draft === undefined && !controller.notice && !controller.error) return null
  const editableDraft = draft ?? controller.restoredDraft?.message ?? ''
  const label = run.agentName?.trim() || '子代理'
  return <section className="subagent-followup" aria-label={`补充要求给 ${label}`}>
    <button ref={toggle} type="button" className="subagent-followup__toggle" aria-expanded={expanded} aria-controls={`${id}-form`} onClick={() => setExpanded(value => !value)}>
      <Icon name="chevron-down" size={14} /><span id={`${id}-label`}>补充要求给 {label}</span>
      {!expanded && (editableDraft.trim() || controller.pending) ? <span className="subagent-followup__draft-status">{controller.pending ? '结果待核对' : '已保留草稿'}</span> : null}
    </button>
    <form id={`${id}-form`} className="subagent-followup__form" hidden={!expanded} onSubmit={event => { event.preventDefault(); void submit() }}>
      <SubagentFollowupInput id={`${id}-input`} value={controller.pending?.message ?? editableDraft} readOnly={Boolean(controller.pending)} onChange={value => { draftRef.current = value; setDraft(value) }}
        onDismiss={() => { setExpanded(false); toggle.current?.focus() }} onSubmit={() => void submit()} placeholder="补充本轮要求；继续使用此代理的上下文" labelledBy={`${id}-label`} describedBy={`${id}-hint`} />
      <div className="subagent-followup__actions"><p id={`${id}-hint`}>{controller.pending ? '原要求已冻结；核对不会重复发送' : !active ? '此代理本轮已结束，原文已保留' : controller.capability === undefined ? '正在确认引擎协作能力…' : controller.capability ? '补充要求将排队；Ctrl / ⌘ Enter 发送' : '当前引擎尚未启用运行中补充；草稿会保留'}</p>
        <button className="btn btn--primary btn--sm" type="submit" disabled={controller.busy || !ready || !visible || (!controller.pending && (!active || !controller.capability || !editableDraft.trim()))}>
          {controller.busy ? <><Spinner size={14} />{controller.pending ? '正在核对…' : '正在提交…'}</> : controller.pending ? '核对排队结果' : <><Icon name="send" size={14} />发送补充要求</>}
        </button>
      </div>
      {controller.canRetry ? <button type="button" className="btn btn--sm" disabled={controller.busy || !ready || !visible} onClick={() => void submit(true)}>重试原请求</button> : null}
      {controller.pending ? <ControllerTrackingRecovery message={controller.pending.message} disabled={controller.busy || !ready || !visible} onForget={controller.forgetTracking} /> : null}
      {controller.restoredDraft && !controller.pending ? <button type="button" className="link" disabled={controller.busy || !ready || !visible} onClick={() => {
        const original = controller.restoredDraft?.message
        void controller.discardDraft().then(cleared => { if (cleared && mounted.current && (draftRef.current === undefined || draftRef.current === original)) { draftRef.current = undefined; setDraft(undefined) } })
      }}>清除已结束的草稿</button> : null}
      {active && controller.capability === false ? <button type="button" className="link" disabled={controller.busy || !ready} onClick={() => setRefreshKey(value => value + 1)}>重新检查能力</button> : null}
    </form>
    <ControllerReceiptHistory records={controller.history} rootRunId={scope.rootRunId} invocationRunId={run.runId} disabled={controller.busy || !ready || !visible} onQuery={controller.queryHistory} onRemove={controller.removeHistory} />
    {controller.notice ? <p className="subagent-followup__notice" role="status">{controller.notice}</p> : null}
    {controller.error ? <p className="subagent-followup__error" role="alert">{controller.error}</p> : null}
  </section>
}
