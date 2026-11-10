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
        className={`chat__surface input-composer ui-input-shell ui-input-shell--multiline${className ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    )
  }
)

export const ComposerInput = forwardRef<
  MentionInputHandle,
  ComponentPropsWithoutRef<typeof MentionInput>
>(function ComposerInput({ className, ariaLabel = '消息', ...props }, ref) {
  return (
    <MentionInput
      {...props}
      ref={ref}
      ariaLabel={ariaLabel}
      className={`input-composer__input ui-input-field${className ? ` ${className}` : ''}`}
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
  loading = false,
  loadingLabel = '正在发送…',
  disabled,
  onClick,
  label = '发送',
  className = ''
}: {
  loading?: boolean
  loadingLabel?: string
  disabled: boolean
  onClick: () => void
  label?: string
  className?: string
}): JSX.Element {
  const action = loading ? loadingLabel : label
  return (
    <button
      type="button"
      className={`chat__send${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      aria-label={action}
      aria-busy={loading}
      title={loading ? action : `${action}（Enter）`}
      onClick={() => { if (!disabled && !loading) onClick() }}
    >
      {loading ? <Spinner size={14} /> : <Icon name="send" size={16} />}
    </button>
  )
}

/** Cancellation stays separate from sending the next instruction, so pointer
 * and keyboard users never get opposing actions from the same send affordance. */
export function ComposerStop({ loading = false, disabled, onClick }: {
  loading?: boolean
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  const action = loading ? '正在停止…' : '停止生成'
  return (
    <button
      type="button"
      className="chat__send input-composer__stop"
      disabled={disabled || loading}
      aria-label={action}
      aria-busy={loading}
      title={action}
      onClick={() => { if (!disabled && !loading) onClick() }}
    >
      {loading ? <Spinner size={14} /> : <Icon name="stop" size={14} />}
    </button>
  )
}
