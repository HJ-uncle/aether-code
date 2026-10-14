import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
  type JSX,
  type ReactNode
} from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { MentionInput, type MentionInputHandle } from './MentionInput'
import './input-composer.css'

/** Modes own drafts and transport; this surface owns the common input geometry. */
export const InputComposer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function InputComposer({ className, children, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className={`chat__surface input-composer${className ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    )
  }
)

export const ComposerInput = forwardRef<
  MentionInputHandle,
  ComponentPropsWithoutRef<typeof MentionInput>
>(function ComposerInput({ className, ...props }, ref) {
  return (
    <MentionInput
      {...props}
      ref={ref}
      className={`input-composer__input${className ? ` ${className}` : ''}`}
    />
  )
})

export function ComposerPolish({
  busy,
  disabled,
  onClick,
  title = 'AI 润色：让指令更清晰具体'
}: {
  busy: boolean
  disabled: boolean
  onClick: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className="chat__icon-btn chat__polish-btn"
      disabled={disabled || busy}
      aria-busy={busy}
      title={title}
      aria-label="AI 润色输入"
      onClick={onClick}
    >
      {busy ? <Spinner size={14} /> : <Icon name="sparkles" size={16} />}
    </button>
  )
}

export function ComposerToolbar({
  leading,
  trailing
}: {
  leading: ReactNode
  trailing: ReactNode
}): JSX.Element {
  return (
    <div className="chat__toolbar input-composer__toolbar">
      <div className="input-composer__leading">{leading}</div>
      <div className="chat__toolbar-spacer" />
      <div className="input-composer__trailing">{trailing}</div>
    </div>
  )
}

export function ComposerSend({
  stopping = false,
  loading = false,
  disabled,
  onClick,
  label = '发送',
  className = ''
}: {
  stopping?: boolean
  loading?: boolean
  disabled: boolean
  onClick: () => void
  label?: string
  className?: string
}): JSX.Element {
  const action = stopping ? '停止生成' : label
  return (
    <button
      type="button"
      className={`chat__send${stopping ? ' chat__send--stop' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      aria-label={action}
      title={stopping ? action : `${action}（Enter）`}
      onClick={onClick}
    >
      {loading ? <Spinner size={14} /> : <Icon name={stopping ? 'stop' : 'send'} size={16} />}
    </button>
  )
}
