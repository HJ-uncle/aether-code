import { useState, type JSX } from 'react'
import { controllerSavedStatus, type ControllerSavedRecord } from '@renderer/core/engine/collaboration-contract'
import './subagent-followup.css'


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
          {item.kind === 'refused' && item.rejection.code === 409 ? <p>引擎以 409 拒绝接纳。请核对当前工作轮次、原请求标识与原文；上方保留引擎返回的具体原因。</p> : null}
          {item.kind === 'accepted' ? <dl className="collaboration-inspector__evidence">
            <div><dt>接纳序号</dt><dd>{item.receipt.acceptedSeq}</dd></div>
            <div><dt>消息标识</dt><dd>{item.receipt.messageId}</dd></div>
            <div><dt>尝试标识</dt><dd>{item.receipt.rootAttemptId}</dd></div>
            <div><dt>正文大小</dt><dd>{item.receipt.payloadBytes} B</dd></div>
            <div><dt>SHA-256</dt><dd>{item.receipt.payloadHash}</dd></div>
            {item.receipt.reason ? <div><dt>引擎原因</dt><dd>{item.receipt.reason}</dd></div> : null}
          </dl> : null}
          <div className="subagent-receipt-history__actions">
            {item.kind === 'accepted' ? <button type="button" className="link" disabled={disabled} onClick={() => void onQuery(item)}>查询原回执</button> : null}
            {item.kind === 'accepted' ? <button type="button" className="link" disabled={disabled} onClick={() => void navigator.clipboard.writeText(JSON.stringify({ rootSessionId: item.rootSessionId, recipientInvocationRunId: item.recipientInvocationRunId, receipt: item.receipt }, null, 2)).then(() => setNotice('回执证据已复制'), () => setNotice('复制失败，请手动保存回执证据'))}>复制回执证据</button> : null}
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

/** Shared keyboard behavior for the current collaboration detail. */
export function SubagentFollowupInput({ id, value, readOnly, onChange, onDismiss, onSubmit, placeholder, labelledBy, describedBy, className = 'ui-input' }: {
  id: string; value: string; readOnly: boolean; onChange: (value: string) => void
  onDismiss: () => void; onSubmit: () => void; placeholder: string; labelledBy: string; describedBy: string
  className?: string
}): JSX.Element {
  return <textarea className={className} id={id} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} rows={2}
    placeholder={placeholder} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit() }
    }} />
}
