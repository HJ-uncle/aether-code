import type { ButtonHTMLAttributes, HTMLAttributes, JSX, ReactNode } from 'react'
import { Icon, type IconName } from './icons'

/**
 * Shared visual primitives for the renderer.
 *
 * These components deliberately contain no state or business behavior. They
 * only give repeated surfaces a single semantic hook so the visual language
 * can be tuned in one stylesheet without changing feature markup.
 */
export function GlassSurface({
  children,
  className = '',
  tone = 'card',
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  tone?: 'card' | 'inset' | 'floating'
}): JSX.Element {
  const classes = ['ui-surface', `ui-surface--${tone}`, className].filter(Boolean).join(' ')
  return <div className={classes} {...props}>{children}</div>
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  className = ''
}: {
  eyebrow?: string
  title: string
  description?: string
  className?: string
}): JSX.Element {
  return (
    <header className={['ui-section-heading', className].filter(Boolean).join(' ')}>
      {eyebrow ? <div className="ui-section-heading__eyebrow">{eyebrow}</div> : null}
      <h2 className="ui-section-heading__title">{title}</h2>
      {description ? <p className="ui-section-heading__description">{description}</p> : null}
    </header>
  )
}

/** Icon-only action with a stable accessible name and shared hit-area baseline. */
export function IconButton({
  icon,
  label,
  size = 16,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  icon: IconName
  label: string
  size?: number
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={['ui-icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      {...props}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/**
 * Shared indeterminate progress indicator. Keeping the ring as a primitive
 * prevents action glyphs (refresh, sync, sparkles) from rotating together
 * with their hit area while an operation is in flight.
 */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }): JSX.Element {
  return <span className={['ui-spinner', className].filter(Boolean).join(' ')} style={{ width: size, height: size }} aria-hidden="true" />
}
