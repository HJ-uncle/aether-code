import { useMemo, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { presentWorkError, workErrorStatusLabel, type WorkErrorPresentation } from './work-error-presenter'
import './work-error-notice.css'

export type { WorkErrorPresentation }
export { presentWorkError }

export function WorkErrorNotice({ error, className = '' }: { error: string; className?: string }): JSX.Element | null {
  const presentation = useMemo(() => presentWorkError(error), [error])
  const [open, setOpen] = useState(false)
  if (!error.trim()) return null
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
    </section>
  )
}
