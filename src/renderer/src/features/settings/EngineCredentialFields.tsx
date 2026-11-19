import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { RemoteAuthCredential, RemoteAuthStatus, RemoteTokenStatus } from '@shared/ipc'
import { remoteServiceUrl } from '@shared/remote-service-url'
import { Select } from '@renderer/ui/Select'
import { IconButton } from '@renderer/ui/ui-primitives'
import { SettingsRow } from './SettingsGroup'
import './engine-credentials.css'

export interface SecretDraft {
  address: string
  instanceToken?: string
  instanceGenerated?: boolean
  authType?: RemoteAuthCredential['type']
  authValue?: string
  authGenerated?: boolean
}

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
function CredentialInput({
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

export function EngineCredentialFields({
  address,
  secrets,
  onChange,
  disabled,
  revision,
  accountId
}: {
  address: string
  secrets: SecretDraft
  onChange: (patch: Partial<Omit<SecretDraft, 'address'>>) => void
  disabled: boolean
  revision: number
  accountId?: string | null
}): JSX.Element {
  const service = useMemo(() => {
    try {
      return remoteServiceUrl(address.trim())
    } catch {
      return ''
    }
  }, [address])
  const [status, setStatus] = useState<{
    address: string
    revision: number
    accountId?: string | null
    auth: RemoteAuthStatus | null
    token: RemoteTokenStatus | null
  } | null>(null)
  useEffect(() => {
    let alive = true
    if (!service) return
    // Only the address, current account, or a completed save invalidates this metadata.
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        window.aether.settings.remoteTokenStatus(service),
        window.aether.settings.remoteAuthStatus(service)
      ]).then(([token, auth]) => {
        if (alive)
          setStatus({
            address,
            revision,
            accountId,
            token: token.status === 'fulfilled' ? token.value : null,
            auth: auth.status === 'fulfilled' ? auth.value : null
          })
      })
    }, 220)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [address, service, revision, accountId])
  const target =
    status?.address === address && status.revision === revision && status.accountId === accountId
      ? status
      : null
  const token = target?.token,
    auth = target?.auth,
    personal = auth?.effective === 'account'
  const tokenError = !!target && !token,
    authError = !!target && !auth
  const type = secrets.authType ?? auth?.type ?? 'api-key',
    typeLabel = type === 'bearer' ? 'JWT' : 'API Key'
  const oldType = auth?.type === 'bearer' ? 'JWT' : 'API Key',
    disabledField = disabled || !service
  const disabledAuth = disabledField || !target
  const storedText = auth?.source === 'environment' ? '启动配置已提供' : '已保存'
  useEffect(() => {
    if (personal && secrets.authValue)
      onChange({ authValue: undefined, authGenerated: undefined, authType: undefined })
  }, [personal, secrets.authValue, onChange])
  const authDescription = personal
    ? '正在使用此服务的个人账号。若要改用服务凭据，请先退出账号。'
    : auth?.effective === 'signed-out'
      ? '已退出个人账号。要改用服务凭据，请重新输入并应用。'
      : '通常使用「个人账号」登录。这里仅用于服务认证；模型密钥在「模型」中设置。'
  const typeHint =
    type === 'bearer' ? 'JWT 由服务端签发，不能在此生成。' : 'API Key 须先由服务管理员登记。'
  return (
    <>
      <SettingsRow label="实例令牌" description="使用部署方提供的令牌；自建服务可在此生成。">
        <CredentialInput
          key={`${address}:${revision}:${disabledField}`}
          kind="instance"
          value={secrets.instanceToken}
          generated={secrets.instanceGenerated}
          placeholder={
            secrets.instanceToken === ''
              ? '应用后移除'
              : token?.source === 'environment'
                ? '启动配置已提供'
                : token?.configured
                  ? '已保存，留空保留'
                  : '输入实例令牌'
          }
          disabled={disabledField}
          canRemove={token?.source === 'stored' || tokenError}
          readError={tokenError}
          edit={(instanceToken, instanceGenerated) =>
            onChange({ instanceToken, instanceGenerated })
          }
        />
      </SettingsRow>
      <SettingsRow label="用户凭据" description={authDescription}>
        <div className="engine-credential__auth" aria-busy={!!service && !target}>
          <Select
            value={type}
            options={[
              { value: 'api-key', label: 'API Key' },
              { value: 'bearer', label: 'JWT（Bearer）' }
            ]}
            onChange={(value) => {
              if ((value === 'api-key' || value === 'bearer') && value !== type)
                onChange({ authType: value, authValue: undefined, authGenerated: undefined })
            }}
            disabled={disabledAuth || personal}
            ariaLabel="远端认证方式"
            width={150}
          />
          <CredentialInput
            key={`${address}:${revision}:${type}:${personal}:${disabledAuth}`}
            kind={type}
            value={secrets.authValue}
            generated={!personal && secrets.authGenerated}
            placeholder={
              secrets.authValue === ''
                ? '应用后移除'
                : personal
                  ? '已使用个人账号'
                  : auth?.configured
                    ? type === auth.type
                      ? `${storedText} ${oldType}，留空保留`
                      : `输入 ${typeLabel}；留空保留${storedText}的 ${oldType}`
                    : `输入 ${typeLabel}`
            }
            disabled={disabledAuth}
            personalAccount={personal}
            canRemove={auth?.source === 'stored' || authError}
            readError={authError}
            edit={(authValue, authGenerated) =>
              onChange({ authValue, authGenerated, authType: type })
            }
          />
          {!personal && !secrets.authGenerated && (
            <span className="engine-credential__hint">{typeHint}留空保留原值。</span>
          )}
        </div>
      </SettingsRow>
    </>
  )
}
