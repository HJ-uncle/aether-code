import { useEffect, useRef, useState, type JSX, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon, type IconName } from './icons'
import { Popover } from './Popover'
import './action-menu.css'

export interface ActionMenuItem {
  id: string
  label: string
  onSelect: () => void | Promise<void>
  icon?: IconName
  description?: string
  disabled?: boolean
  danger?: boolean
}

interface ActionMenuProps {
  items: ActionMenuItem[]
  label?: string
  disabled?: boolean
  className?: string
  icon?: ReactNode
}

/**
 * Compact, keyboard accessible overflow menu used where a row has one primary
 * action and less frequent operations. Popover owns positioning; this component
 * owns menu semantics and closes after every selection.
 */
export function ActionMenu({
  items,
  label = '更多操作',
  disabled = false,
  className,
  icon
}: ActionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const item = menuRef.current?.querySelector<HTMLButtonElement>(
        `[data-action-index="${activeIndex}"]`
      )
      item?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [activeIndex, open])

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    const available = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled)
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (available.length === 0) return
      const current = available.findIndex(({ index }) => index === activeIndex)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = available[(current + delta + available.length) % available.length]
      setActiveIndex(next.index)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (available.length > 0) setActiveIndex((event.key === 'Home' ? available[0] : available.at(-1))!.index)
    }
  }

  const run = (item: ActionMenuItem): void => {
    if (item.disabled) return
    setOpen(false)
    triggerRef.current?.focus()
    void item.onSelect()
  }

  return (
    <Popover
      className={`action-menu${className ? ` ${className}` : ''}`}
      label={label}
      placement="up"
      align="end"
      width={220}
      flush
      open={open}
      disabled={disabled}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          const first = items.findIndex((item) => !item.disabled)
          setActiveIndex(first >= 0 ? first : 0)
        }
      }}
      trigger={() => (
        <button
          type="button"
          ref={triggerRef}
          className="action-menu__trigger"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onKeyDown={onKeyDown}
        >
          {icon ?? <Icon name="dots-horizontal" size={16} />}
        </button>
      )}
    >
      <div ref={menuRef} className="action-menu__panel" role="menu" onKeyDown={onKeyDown}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-action-index={index}
            disabled={item.disabled}
            className={`action-menu__item${item.danger ? ' action-menu__item--danger' : ''}${index === activeIndex ? ' is-highlight' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => run(item)}
          >
            {item.icon ? <Icon name={item.icon} size={16} /> : <span className="action-menu__item-spacer" />}
            <span className="action-menu__item-copy">
              <span>{item.label}</span>
              {item.description ? <small>{item.description}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  )
}
