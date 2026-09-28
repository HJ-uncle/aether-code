import type { JSX, ReactNode } from 'react'

/**
 * 设置页 UI 原语（macOS HIG 分组列表）
 *
 *  macOS「系统设置」的标准形制：一个分组 = 组标题（小号灰字，位于卡片上方）
 *  + 一张圆角卡片，卡片内是一行行「标签在左、控件在右」的分隔行。
 *  控件统一用开关（Toggle）与分段选择器（Segmented），替代原生 checkbox/radio。
 */

/** 一个分组：标题 + 圆角卡片容器 */
export function SettingsGroup({
  title,
  footer,
  children
}: {
  title: string
  /** 组下方的灰字说明 */
  footer?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="sg">
      <h3 className="sg__title">{title}</h3>
      <div className="sg__card">{children}</div>
      {footer ? <p className="sg__footer">{footer}</p> : null}
    </section>
  )
}

/** 分组内的一行：标签 + 描述在左，控件在右 */
export function SettingsRow({
  label,
  description,
  children,
  onClick
}: {
  label: ReactNode
  description?: string
  children?: ReactNode
  /** 整行可点（如配合 Toggle 使用时点行即切换） */
  onClick?: () => void
}): JSX.Element {
  const body = (
    <>
      <div className="sg__row-text">
        <span className="sg__row-label">{label}</span>
        {description ? <span className="sg__row-desc">{description}</span> : null}
      </div>
      {children ? <div className="sg__row-control">{children}</div> : null}
    </>
  )
  if (onClick) {
    return (
      <div className="sg__row sg__row--clickable" role="button" tabIndex={0} onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
      >
        {body}
      </div>
    )
  }
  return <div className="sg__row">{body}</div>
}

/** 分组内的静态内容行（kv 信息、自定义内容），无控件槽位 */
export function SettingsContent({ children }: { children: ReactNode }): JSX.Element {
  return <div className="sg__row sg__row--content">{children}</div>
}

/** macOS 风格开关 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' is-on' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onChange(!checked)
      }}
    >
      <span className="toggle__knob" />
    </button>
  )
}

/** macOS 风格分段选择器（2~4 个互斥选项） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={`segmented__item${option.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
