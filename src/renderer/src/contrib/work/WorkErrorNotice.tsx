import { useMemo, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { presentWorkError, workErrorStatusLabel, type WorkErrorPresentation } from './work-error-presenter'
import './work-error-notice.css'

export type { WorkErrorPresentation }
export { presentWorkError }

type WorkErrorNoticeProps = {
  error: string
  className?: string
  /** A real recovery operation owned by the caller (replay, reload, or read). */
  onRetry?: () => void | Promise<void>
  retryLabel?: string
}

export function WorkErrorNotice({ error, className = '', onRetry, retryLabel = '重试任务' }: WorkErrorNoticeProps): JSX.Element | null {
  const presentation = useMemo(() => presentWorkError(error), [error])
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState(false)
  if (!error.trim()) return null
  const retry = async (): Promise<void> => {
    if (!onRetry || retrying || !presentation.retryable) return
    setRetrying(true)
    setActionError('')
    try {
      await onRetry()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRetrying(false)
    }
  }
  const copyDetail = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      setActionError('当前环境不支持复制诊断，请展开详情后手动复制。')
      return
    }
    try {
      await navigator.clipboard.writeText(presentation.detail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '复制诊断失败，请展开详情后手动复制。')
    }
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
        {open ? <pre>{presentation.detail}</pre> : null}
      </details>
      <div className="work-error-notice__actions" role="group" aria-label="错误操作">
        {onRetry && presentation.retryable ? (
          <button type="button" className="btn btn--sm btn--primary" disabled={retrying} onClick={() => void retry()}>
            {retrying ? '正在重试…' : retryLabel}
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
