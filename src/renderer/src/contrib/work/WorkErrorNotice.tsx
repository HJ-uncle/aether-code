import { useMemo, useRef, useState, type JSX } from 'react'
import { ActionMenu, type ActionMenuItem } from '@renderer/workbench/ActionMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence, useMotionPresence } from '@renderer/workbench/MotionPresence'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { presentWorkError, workErrorStatusLabel, type WorkErrorContext, type WorkErrorPresentation } from './work-error-presenter'
import './work-error-notice.css'

export type { WorkErrorPresentation }
export { presentWorkError }

type WorkErrorNoticeProps = {
  error: string
  context?: WorkErrorContext
  className?: string
  /** A real recovery operation owned by the caller (replay, reload, or read). */
  onRetry?: () => void | Promise<void>
  retryLabel?: string
  /** Root replies use a quiet recovery row; tool diagnostics retain their layout. */
  compact?: boolean
  onEdit?: () => void | Promise<void>
  busy?: boolean
  busyLabel?: string
  recoveryError?: string
  /** Only the caller can confirm that a later run resolved this failure. */
  resolved?: boolean
}

export function WorkErrorNotice({
  error, context, className = '', onRetry, retryLabel, compact = false, onEdit,
  busy = false, busyLabel = '正在重启…', recoveryError = '', resolved = false
}: WorkErrorNoticeProps): JSX.Element | null {
  const presentation = useMemo(() => presentWorkError(error, context), [error, context])
  const [open, setOpen] = useState(false)
  const presence = useMotionPresence(open)
  const [retrying, setRetrying] = useState(false)
  const [editing, setEditing] = useState(false)
  const actionPending = useRef(false)
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState(false)
  if (!error.trim()) return null
  const recovering = busy || retrying
  const actionBusy = recovering || editing
  const feedback = actionError || recoveryError
  const diagnosticDetail = compact && feedback ? `${presentation.detail}\n\n恢复操作：\n${feedback}` : presentation.detail
  const retry = async (): Promise<void> => {
    if (!onRetry || actionPending.current || actionBusy || resolved || !presentation.retryable) return
    actionPending.current = true
    setRetrying(true)
    setActionError('')
    try {
      await onRetry()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionPending.current = false
      setRetrying(false)
    }
  }
  const edit = async (): Promise<void> => {
    if (!onEdit || actionPending.current || actionBusy || resolved) return
    actionPending.current = true
    setEditing(true)
    setActionError('')
    try {
      await onEdit()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionPending.current = false
      setEditing(false)
    }
  }
  const copyDetail = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      setActionError('当前环境不支持复制诊断，请展开详情后手动复制。')
      return
    }
    try {
      await navigator.clipboard.writeText(diagnosticDetail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '复制诊断失败，请展开详情后手动复制。')
    }
  }
  if (compact) {
    const menuItems: ActionMenuItem[] = [
      { id: 'details', label: '查看诊断详情', icon: 'info', onSelect: () => setOpen(true) },
      { id: 'copy', label: copied ? '已复制诊断' : '复制诊断', icon: copied ? 'check' : 'copy', disabled: copied, onSelect: copyDetail }
    ]
    if (onEdit) menuItems.push({ id: 'edit', label: '编辑后重试', icon: 'pencil', separatorBefore: true, disabled: actionBusy, onSelect: edit })
    return <>
      <MotionPresence show={!resolved}>
        <section className={`work-error-notice work-error-notice--compact${className ? ` ${className}` : ''}`} role="status">
          <div className="work-error-notice__recovery-row">
            <p className="work-error-notice__reason">{compactSummary(presentation.summary)}</p>
            <div className="work-error-notice__recovery-actions" role="group" aria-label="任务恢复操作">
              {(onRetry || recovering) && presentation.retryable ? (
                <button type="button" className="btn btn--sm btn--primary" disabled={actionBusy || !onRetry} onClick={() => void retry()}>
                  {recovering ? <Spinner size={12} /> : null}
                  {recovering ? busyLabel : retryLabel ?? '重启任务'}
                </button>
              ) : null}
              <ActionMenu label="任务恢复更多操作" items={menuItems} />
            </div>
          </div>
          {feedback ? <p className="work-error-notice__action-error">{compactSummary(feedback)}</p> : null}
        </section>
      </MotionPresence>
      <Dialog
        title="诊断详情"
        className="work-error-diagnostics"
        open={open && !resolved}
        onClose={() => setOpen(false)}
        footer={<>
          <button type="button" className="btn btn--sm" disabled={copied} onClick={() => void copyDetail()}>
            {copied ? '已复制诊断' : '复制诊断'}
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setOpen(false)}>完成</button>
        </>}
      >
        <pre className="work-error-diagnostics__detail">{diagnosticDetail}</pre>
        {feedback ? <p className="work-error-diagnostics__error" role="status">{compactSummary(feedback)}</p> : null}
      </Dialog>
    </>
  }
  return (
    <section className={`work-error-notice${className ? ` ${className}` : ''}`} role="alert">
      <div className="work-error-notice__heading">
        <Icon name="warning" size={15} aria-hidden="true" />
        <div>
          <strong>{presentation.title}</strong>
          <p>{presentation.summary}</p>
        </div>
      </div>
      {presentation.status || presentation.code || presentation.runId ? (
        <div className="work-error-notice__meta" aria-label="错误上下文">
          {presentation.status ? <span>{workErrorStatusLabel(presentation.status)}</span> : null}
          {presentation.code ? <span>{presentation.code}</span> : null}
          {presentation.runId ? <span title={presentation.runId}>run {presentation.runId.slice(0, 8)}</span> : null}
        </div>
      ) : null}
      <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>{open ? '收起诊断详情' : '查看诊断详情'}</summary>
        {presence.present ? <pre {...presence.motionProps}>{presentation.detail}</pre> : null}
      </details>
      <div className="work-error-notice__actions" role="group" aria-label="错误操作">
        {onRetry && presentation.retryable ? (
          <button type="button" className="btn btn--sm btn--primary" disabled={actionBusy} onClick={() => void retry()}>
            {recovering ? '正在重试…' : retryLabel ?? '重试任务'}
          </button>
        ) : null}
        <button type="button" className="btn btn--sm" disabled={copied} onClick={() => void copyDetail()}>
          {copied ? '已复制诊断' : '复制诊断'}
        </button>
      </div>
      {actionError ? <p className="work-error-notice__action-error" role="status">{actionError}</p> : null}
    </section>
  )
}

function compactSummary(value: string): string {
  // Unknown provider errors can contain an entire response on one line. The
  // recovery row stays readable; diagnostics and copying retain the full text.
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}
