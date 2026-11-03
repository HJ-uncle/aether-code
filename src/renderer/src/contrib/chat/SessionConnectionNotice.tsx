import { useState, type JSX } from 'react'
import type { RecoveryState } from '@renderer/core/engine/chat-recovery-loop'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import { sessionConnectionPresentation } from './session-connection-presentation'
import './session-connection-notice.css'

/** One shared transport status; a lost connection cannot prove a task is still running. */
export function SessionConnectionNotice({ ready, sessionId, source, connection, active, error, onRetry }: {
  ready: boolean
  sessionId: string
  source: number
  connection: RecoveryState | null
  active: boolean
  error?: string | null
  onRetry: () => void | Promise<unknown>
}): JSX.Element | null {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const presentation = sessionConnectionPresentation({ ready, sessionId, source, connection, active })
  if (!presentation) return null
  const detail = retryError || error || connection?.reason
  const retry = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    setRetryError('')
    try { await onRetry() }
    catch (cause) { setRetryError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setRetrying(false) }
  }
  return <div className="session-connection-notice" aria-label="会话连接状态">
    <div className="session-connection-notice__row">
      <span aria-hidden="true">{presentation.busy || retrying ? <Spinner size={13} /> : <Icon name="warning" size={13} />}</span>
      <span role="status" aria-live="polite">{presentation.label}</span>
      {presentation.retry ? <button type="button" className="chat__toolbar-btn" disabled={retrying} aria-busy={retrying} onClick={() => void retry()}>{retrying ? '正在重试…' : '重新加载'}</button> : null}
    </div>
    {detail ? <details><summary>查看连接详情</summary><p>{detail}</p></details> : null}
  </div>
}
