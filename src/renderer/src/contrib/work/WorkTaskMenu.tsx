import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Icon } from '@renderer/workbench/icons'
import '@renderer/workbench/action-menu.css'

/** Keep task menus on the shared menu surface so nested actions retain the
 * same keyboard navigation and viewport handling as the rest of the app. */
export function WorkTaskMenu({ items, label, disabled = false, className, open: controlledOpen, onOpenChange }: {
  items: ContextMenuItem[]
  label: string
  disabled?: boolean
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [localOpen, setLocalOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const open = controlledOpen ?? localOpen
  const setOpen = (value: boolean): void => {
    if (controlledOpen === undefined) setLocalOpen(value)
    onOpenChange?.(value)
  }

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPosition({ x: rect.left, y: rect.bottom + 4 })
  }, [open])

  return <span className={`action-menu${className ? ` ${className}` : ''}`}>
    <button
      ref={triggerRef}
      type="button"
      className="action-menu__trigger"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(!open)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
        }
      }}
    >
      <Icon name="dots-horizontal" size={16} />
    </button>
    {open && position ? <ContextMenu
      x={position.x}
      y={position.y}
      anchor={triggerRef.current}
      items={items}
      onClose={() => setOpen(false)}
    /> : null}
  </span>
}
