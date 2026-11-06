import { useId, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'

const PRESETS = ['128', '256', '512', '1000']

interface ContextWindowInputProps {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function ContextWindowInput({
  value,
  disabled,
  onChange,
  onSubmit
}: ContextWindowInputProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const expanded = open && !disabled

  const changeOpen = (next: boolean): void => {
    if (next) setActiveIndex(Math.max(0, PRESETS.indexOf(value.trim())))
    setOpen(next)
  }

  const choose = (preset: string): void => {
    onChange(preset)
    setOpen(false)
    inputRef.current?.focus({ preventScroll: true })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!expanded) changeOpen(true)
      else
        setActiveIndex((index) =>
          Math.max(0, Math.min(PRESETS.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        )
    } else if (expanded && event.key === 'Enter') {
      // Selecting a preset must not submit the surrounding model form.
      event.preventDefault()
      event.stopPropagation()
      choose(PRESETS[activeIndex])
    } else if (expanded && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (event.key === 'Tab') {
      setOpen(false)
    } else {
      onSubmit(event)
    }
  }

  return (
    <Popover
      className="context-window-input"
      panelClassName="model-form__popover"
      label="上下文窗口选项"
      placement="up"
      width={260}
      flush
      disabled={disabled}
      open={expanded}
      onOpenChange={changeOpen}
      trigger={() => (
        <div className="context-window-input__field">
          <input
            ref={inputRef}
            className="field__input context-window-input__value"
            role="combobox"
            aria-label="上下文窗口"
            aria-description="单位 K，1 K = 1000 token。可自由输入或用方向键选择预设，留空自动识别"
            aria-autocomplete="none"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
            value={value}
            disabled={disabled}
            placeholder="自动识别"
            inputMode="decimal"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              onChange(event.target.value)
              setOpen(false)
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          <span className="context-window-input__unit" aria-hidden="true">
            K
          </span>
          <button
            type="button"
            className="context-window-input__toggle"
            aria-label="选择上下文窗口预设"
            aria-haspopup="listbox"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              changeOpen(!expanded)
              inputRef.current?.focus({ preventScroll: true })
            }}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
      )}
    >
      <div id={listId} className="select__panel" role="listbox" aria-label="上下文窗口预设">
        {PRESETS.map((preset, index) => (
          <button
            key={preset}
            id={`${listId}-${index}`}
            type="button"
            role="option"
            aria-selected={value.trim() === preset}
            tabIndex={-1}
            className={`select__item${index === activeIndex ? ' is-highlight' : ''}`}
            // Keep the editable combobox focused while its portal handles a click.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(preset)}
          >
            <span className="select__item-head">
              {preset} K
              {value.trim() === preset ? (
                <Icon name="check" size={16} className="select__check" />
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  )
}
