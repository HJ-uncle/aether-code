import type { JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'

/** Icon-only action with shared busy feedback and keyboard behavior. */
export function EngineMonitorRefreshButton({ label, busy, disabled, onRefresh }: {
  label: string
  busy: boolean
  disabled?: boolean
  onRefresh: () => void | Promise<void>
}): JSX.Element {
  return <button type="button" className="btn btn--sm engine-resource__refresh"
    aria-label={label} title={label} aria-busy={busy} disabled={busy || disabled}
    onClick={event => {
      // A refresh inside the runtime summary must leave the disclosure open.
      event.preventDefault()
      event.stopPropagation()
      void onRefresh()
    }}>
    {busy ? <Spinner size={14} /> : <Icon name="refresh" size={16} />}
  </button>
}
