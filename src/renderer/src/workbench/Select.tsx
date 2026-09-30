import { useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './icons'
import { Popover, type PopoverAlign, type PopoverPlacement } from './Popover'

export interface SelectOption {
  value: string
  label: string
  /** 次要说明：展示在选项下方，帮助区分相近选项 */
  description?: string
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** 触发区悬浮提示 */
  title?: string
  /** 无障碍名称；默认复用 title。 */
  ariaLabel?: string
  /** 浮层展开方向，默认向下 */
  placement?: PopoverPlacement
  align?: PopoverAlign
  /** 浮层宽度 */
  width?: number
  /** 触发区附加类名 */
  className?: string
}

/**
 * 通用下拉选择
 *
 * 替代原生 `<select>`：原生控件的下拉由系统绘制，字体/圆角/配色都跟应用
 * 整体割裂（尤其深色下会露出系统白底列表），且无法带选项说明文字。
 * 这里统一走 Popover 面板，与模型选择器、思考模式选择器同一形制。
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  placement = 'down',
  align = 'start',
  width,
  className
}: SelectProps): JSX.Element {
  const current = options.find((option) => option.value === value)
  /** 键盘导航：下拉打开时 ↑↓ 移动高亮、Enter 选中（模式同 GitPickDialog） */
  const [activeIndex, setActiveIndex] = useState(-1)
  /** Popover 经 onOpenChange 透出的开合态，供打开时同步高亮项 */
  const [open, setOpen] = useState(false)

  // 打开时高亮当前选中项；关闭后复位，下次打开重新定位。
  // 用 React 官方「渲染时调整 state」模式（同 Popover 的 prevOpen），
  // 避免在 effect 里同步 setState 触发级联渲染（react-hooks/set-state-in-effect）
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      const selected = options.findIndex((option) => option.value === value)
      setActiveIndex(selected >= 0 ? selected : 0)
    } else {
      setActiveIndex(-1)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (!open || options.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (i < 0 ? 0 : Math.min(i + 1, options.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i < 0 ? options.length - 1 : Math.max(i - 1, 0)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = options[activeIndex]
      if (picked) {
        onChange(picked.value)
        setOpen(false)
      }
    }
  }

  return (
    <Popover
      className={`select${className ? ` ${className}` : ''}`}
      label={title ?? '选择'}
      placement={placement}
      align={align}
      width={width ?? 220}
      flush
      open={open}
      onOpenChange={setOpen}
      trigger={() => (
        <button
          type="button"
          className="select__trigger"
          disabled={disabled}
          title={title}
          aria-label={ariaLabel ?? title}
          onKeyDown={onKeyDown}
        >
          <span className="select__value">{current?.label ?? value}</span>
          <Icon name="chevron" size={16} className="select__caret" />
        </button>
      )}
    >
      {/* 浮层 portal 到 body，但 React 事件仍沿组件树冒泡，这里能接住面板内的按键 */}
      <div className="select__panel" role="menu" onKeyDown={onKeyDown}>
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={
              index === activeIndex && open
                ? (el) => el?.scrollIntoView({ block: 'nearest' })
                : null
            }
            type="button"
            role="menuitem"
            className={`select__item${option.value === value ? ' is-active' : ''}${index === activeIndex ? ' is-highlight' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              onChange(option.value)
              setOpen(false)
            }}
          >
            <span className="select__item-head">
              {option.label}
              {option.value === value ? <Icon name="check" size={16} className="select__check" /> : null}
            </span>
            {option.description ? (
              <small className="select__item-desc">{option.description}</small>
            ) : null}
          </button>
        ))}
      </div>
    </Popover>
  )
}
