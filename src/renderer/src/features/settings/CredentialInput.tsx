import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { RemoteAuthCredential } from '@shared/ipc'
import { IconButton } from '@renderer/ui/ui-primitives'
import './engine-credentials.css'

type Kind = 'instance' | RemoteAuthCredential['type']
type Feedback = 'idle' | 'copied' | 'manual' | 'revealed' | 'unavailable'
interface CredentialInputProps {
  kind: Kind
  value?: string
  generated?: boolean
  placeholder: string
  canRemove: boolean
  disabled: boolean
  personalAccount?: boolean
  readError: boolean
  edit: (value: string | undefined, generated?: boolean) => void
}

/** Only this edit's draft reaches the input or clipboard. Stored secrets are never requested. */
export function CredentialInput({
  kind,
  value,
  generated,
  placeholder,
  canRemove,
  disabled,
  personalAccount,
  readError,
  edit
}: CredentialInputProps): JSX.Element {
  const instance = kind === 'instance',
    subject = instance ? '实例令牌' : ' API Key'
  const [feedback, setFeedback] = useState<Feedback>('idle')
  const input = useRef<HTMLInputElement>(null),
    attempt = useRef(0),
    hintId = useId()
  const editable = !disabled && !personalAccount,
    revealed = editable && !!value && !!generated && feedback === 'revealed'
  // Ignore a clipboard result from a different address, type, revision or discarded edit.
  useLayoutEffect(
    () => () => {
      attempt.current++
    },
    []
  )
  useLayoutEffect(() => {
    const field = input.current
    if (!revealed || !field) return
    // The dialog handles Escape during document capture, before an input's React handler.
    // Give only this temporary, focused reveal the first Escape; normal dialog dismissal is unchanged.
    const conceal = (event: KeyboardEvent): void => {
      if (
        event.target !== field ||
        event.key !== 'Escape' ||
        event.isComposing ||
        event.keyCode === 229
      )
        return
      event.preventDefault()
      event.stopPropagation()
      setFeedback('manual')
    }
    window.addEventListener('keydown', conceal, true)
    field.focus()
    field.select()
    return () => window.removeEventListener('keydown', conceal, true)
  }, [revealed])
  useEffect(() => {
    if (feedback !== 'revealed' && feedback !== 'copied') return
    const timer = window.setTimeout(
      () => setFeedback(feedback === 'revealed' ? 'manual' : 'idle'),
      feedback === 'revealed' ? 15_000 : 2_000
    )
    return () => window.clearTimeout(timer)
  }, [feedback])
  const change = (next: string | undefined, isGenerated = false): void => {
    attempt.current++
    setFeedback('idle')
    edit(next, isGenerated)
  }
  const generate = (): void => {
    try {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
      change(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''), true)
    } catch {
      setFeedback('unavailable')
    }
  }
  const copy = async (): Promise<void> => {
    if (!editable || !value?.trim() || kind === 'bearer') return
    const id = ++attempt.current
    try {
      await navigator.clipboard.writeText(value.trim())
      if (id === attempt.current) setFeedback('copied')
    } catch {
      if (id === attempt.current) setFeedback('manual')
    }
  }
  const generateLabel = '生成随机' + subject,
    copyLabel = '复制' + subject,
    revealLabel = '显示并选中' + subject
  const clearLabel = instance ? '清除令牌' : '清除凭据'
  const setupHint = instance
    ? '在自建服务端将 AETHER_INSTANCE_TOKEN 设为此值，重启服务后再连接。'
    : '请交由服务管理员登记后再连接；此处不会自动登记。'
  const note =
    feedback === 'unavailable'
      ? '无法生成安全随机值，请使用服务管理员提供的凭据。'
      : feedback === 'copied'
        ? '已复制。' + (generated ? setupHint : '')
        : revealed
          ? '已选中，可手动复制。离开输入框或按 Esc 即可隐藏。'
          : feedback === 'manual'
            ? generated
              ? '剪贴板不可用。可点显示图标，手动复制本次生成的值。'
              : '剪贴板不可用，请从凭据的原处复制。'
            : generated && value
              ? '已生成，请复制。' + setupHint
              : value === ''
                ? '应用后移除本机保存的值。若启动配置提供了凭据，它仍然保留。'
                : readError
                  ? '未能读取此项的凭据状态，可重新输入或移除本机记录。'
                  : ''
  return (
    <div className="engine-credential">
      <div className="engine-credential__entry">
        <input
          ref={input}
          className="field__input sg__input sg__input--wide"
          type={revealed ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={instance ? '实例令牌' : '远端用户认证凭据'}
          aria-describedby={note ? hintId : undefined}
          maxLength={instance ? 4096 : 16384}
          placeholder={placeholder}
          value={personalAccount ? '' : (value ?? '')}
          disabled={!editable}
          onBlur={() => {
            if (revealed) setFeedback('manual')
          }}
          onChange={(event) => {
            const next = event.target.value
            change(next.trim() ? next : undefined)
          }}
        />
        {kind !== 'bearer' && !personalAccount && (
          <IconButton
            icon="sparkles"
            label={generateLabel}
            title={generateLabel}
            disabled={!editable}
            onClick={generate}
          />
        )}
        {kind !== 'bearer' && !personalAccount && !!value?.trim() && (
          <IconButton
            icon={feedback === 'copied' ? 'check' : 'copy'}
            label={copyLabel}
            title={copyLabel}
            disabled={!editable}
            onClick={() => void copy()}
          />
        )}
        {feedback === 'manual' && generated && value && !personalAccount && (
          <IconButton
            icon="eye-outline"
            label={revealLabel}
            title={revealLabel}
            disabled={!editable}
            onClick={() => setFeedback('revealed')}
          />
        )}
        {canRemove && (
          <IconButton
            icon="trash"
            label={clearLabel}
            title={clearLabel + '（仅移除本机保存的值）'}
            disabled={disabled || value === ''}
            onClick={() => change('')}
          />
        )}
      </div>
      <span className="engine-credential__hint" id={hintId} role="status">
        {note}
      </span>
    </div>
  )
}
