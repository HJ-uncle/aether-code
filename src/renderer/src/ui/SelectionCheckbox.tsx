import { useLayoutEffect, useRef, type JSX } from 'react'
import { Icon } from '@renderer/ui/icons'

/** Keep native checkbox semantics while avoiding platform-specific checkbox chrome. */
export function SelectionCheckbox({ checked, mixed = false, disabled = false, label, onChange }: {
  checked: boolean
  mixed?: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = mixed }, [mixed])
  return <span className="work-selection-check">
    <input ref={input} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
    <Icon name={mixed ? 'minus' : 'check'} size={12} />
  </span>
}
