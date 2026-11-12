import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { Spinner } from '@renderer/workbench/ui-primitives'
import './resource-settings.css'

/** Shared composition keeps the resource pages aligned without nesting settings cards. */
export function ResourceSettingsHeader({ title, count, description, children }: {
  title: string; count?: number; description?: string; children?: ReactNode
}): JSX.Element {
  return <header className="resource-header">
    <div className="resource-header__copy"><h2>{title}{count !== undefined ? <span>{count}</span> : null}</h2>
      {description ? <p>{description}</p> : null}</div>
    {children ? <div className="resource-header__actions">{children}</div> : null}
  </header>
}

export function ResourceSettingsEmpty({ icon = 'file', title, description, loading }: {
  icon?: IconName; title: string; description?: string; loading?: boolean
}): JSX.Element {
  return <div className="resource-empty" role="status">
    {loading ? <Spinner size={22} /> : <Icon name={icon} size={24} />}
    <div><strong>{title}</strong>{description ? <p>{description}</p> : null}</div>
  </div>
}

export function ResourceSettingsField({ label, wide, children }: {
  label: string; wide?: boolean; children: ReactNode
}): JSX.Element {
  return <div className={'resource-field' + (wide ? ' is-wide' : '')}><span>{label}</span>{children}</div>
}

export interface ResourceSettingsAction {
  label: string; icon: IconName; onSelect: () => void; disabled?: boolean; danger?: boolean
}

export function ResourceSettingsMenu({ label, disabled, actions }: {
  label: string; disabled?: boolean; actions: ResourceSettingsAction[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || disabled) return
    let frame = 0
    const focusFirst = (): void => {
      const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (!first || document.activeElement !== trigger.current) return
      // The shared popover measures its first frame while hidden.
      if (getComputedStyle(first).visibility === 'hidden' || !first.getClientRects().length) {
        frame = requestAnimationFrame(focusFirst)
        return
      }
      first.focus({ preventScroll: true })
    }
    focusFirst()
    return () => cancelAnimationFrame(frame)
  }, [open, disabled])
  return <Popover open={open} onOpenChange={setOpen} disabled={disabled} align="end" width={176}
    label={label + ' 的操作'} panelClassName="resource-menu" flush
    trigger={({ open: expanded }) => <button ref={trigger} type="button" className="resource-icon-button"
      aria-label={label + ' 的更多操作'} aria-expanded={expanded} title="更多操作" disabled={disabled}><Icon name="dots-horizontal" size={18} /></button>}>
    <div ref={menu} className="resource-menu__items" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!items.length) return
      event.preventDefault()
      const index = items.findIndex(item => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus({ preventScroll: true })
    }}>
      {actions.map(action => <button type="button" key={action.label} disabled={action.disabled}
        className={action.danger ? 'is-danger' : undefined} onClick={() => {
          setOpen(false)
          // Dialog dismissal needs a persistent target after this menu disappears.
          trigger.current?.focus({ preventScroll: true })
          action.onSelect()
        }}><Icon name={action.icon} size={15} />{action.label}</button>)}
    </div>
  </Popover>
}
