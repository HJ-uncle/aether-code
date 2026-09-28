import type { JSX } from 'react'
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
  placement = 'down',
  align = 'start',
  width,
  className
}: SelectProps): JSX.Element {
  const current = options.find((option) => option.value === value)

  return (
    <Popover
      className={`select${className ? ` ${className}` : ''}`}
      label={title ?? '选择'}
      placement={placement}
      align={align}
      width={width ?? 220}
      flush
      trigger={() => (
        <button type="button" className="select__trigger" disabled={disabled} title={title}>
          <span className="select__value">{current?.label ?? value}</span>
          <Icon name="chevron" size={12} className="select__caret" />
        </button>
      )}
    >
      <div className="select__panel" role="menu">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitem"
            className={`select__item${option.value === value ? ' is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span className="select__item-head">
              {option.label}
              {option.value === value ? <Icon name="check" size={12} className="select__check" /> : null}
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
