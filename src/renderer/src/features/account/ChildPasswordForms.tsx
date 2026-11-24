import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type JSX
} from 'react'
import type { AccountState, ChildPasswordScope } from '@shared/account'
import { Dialog } from '@renderer/ui/Dialog'
import { SettingsDisclosure } from '../settings/SettingsGroup'
import { accountErrorMessage } from './account-errors'

type Mode = 'login' | 'recover' | 'manage' | 'self' | 'code'
type Props = { scope: ChildPasswordScope; blocked: boolean }
type SensitiveSave = (save: () => Promise<void>) => void

/** Unmount hidden credential inputs so reopening always starts masked and empty. */
function PasswordDisclosure({
  children,
  onClose,
  ...props
}: Omit<ComponentProps<typeof SettingsDisclosure>, 'defaultOpen' | 'onOpenChange'> & {
  onClose?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <SettingsDisclosure
      {...props}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onClose?.()
      }}
    >
      {open ? children : null}
    </SettingsDisclosure>
  )
}

function SecretField({
  name,
  label,
  kind,
  optional = false
}: {
  name: string
  label: string
  kind: 'current-password' | 'new-password' | 'off'
  optional?: boolean
}): JSX.Element {
  const [visible, show] = useState(false),
    hint = useId(),
    fresh = kind === 'new-password'
  return (
    <div className="account-field">
      <label htmlFor={hint}>
        {label}
        {optional ? <small>（选填）</small> : null}
      </label>
      <div className="child-password-field">
        <input
          id={hint}
          className="field__input"
          name={name}
          type={visible ? 'text' : 'password'}
          required={!optional}
          maxLength={kind === 'off' ? 256 : 512}
          autoComplete={kind}
          spellCheck={false}
          aria-describedby={fresh ? hint + '-help' : undefined}
        />
        <button
          type="button"
          className="btn"
          aria-label={(visible ? '隐藏' : '显示') + label}
          aria-pressed={visible}
          onClick={() => show((v) => !v)}
        >
          {visible ? '隐藏' : '显示'}
        </button>
      </div>
      {fresh ? <small id={hint + '-help'}>15–128 个字符，可以使用空格。</small> : null}
    </div>
  )
}

function PasswordForm({
  mode,
  scope,
  blocked,
  initialName = '',
  childId,
  onDone,
  onSensitiveSave,
  alternate
}: Props & {
  mode: Mode
  initialName?: string
  childId?: string
  onDone: (loginName: string) => void
  onSensitiveSave?: SensitiveSave
  alternate?: { label: string; select: () => void }
}): JSX.Element {
  const [busy, setBusy] = useState(false),
    [err, setError] = useState(''),
    [recover, setRecover] = useState(false)
  const sending = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const active = mode === 'login' || mode === 'recover',
    fresh = mode !== 'login' && mode !== 'code',
    optional = mode === 'manage' && !!initialName
  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (blocked || sending.current) return
    const form = e.currentTarget,
      data = new FormData(form),
      value = (k: string) => String(data.get(k) ?? '')
    const name = mode === 'self' || mode === 'code' ? initialName : value('loginName').trim(),
      password = value('newPassword')
    const len = Array.from(password.normalize('NFC')).length
    if (fresh && (!optional || password) && (len < 15 || len > 128)) {
      setError('新密码需为 15–128 个字符。')
      const field = form.elements.namedItem('newPassword')
      if (field instanceof HTMLInputElement) field.focus()
      return
    }
    if (optional && name.toLowerCase() === initialName && !password) {
      setError('登录名和密码都没有变化。')
      return
    }
    const save = async (): Promise<void> => {
      if (!mounted.current || sending.current) return
      sending.current = true
      setBusy(true)
      setError('')
      try {
        const api = window.aether.account
        if (mode === 'login') await api.childPasswordLogin(scope, name, value('password'))
        else if (mode === 'code') await api.copyChildResetCode(scope, value('password'))
        else if (mode === 'recover')
          await api.childPasswordRecover(scope, name, value('recoveryKey').trim(), password)
        else if (mode === 'manage' && childId)
          await api.setManagedChildLogin(scope, childId, {
            loginName: name,
            ...(password ? { password } : {})
          })
        else if (mode === 'self')
          await api.changeOwnChildPassword(
            scope,
            recover
              ? { recoveryKey: value('recoveryKey').trim() }
              : { currentPassword: value('password') },
            password
          )
        if (mounted.current) {
          form.reset()
          onDone(name.toLowerCase())
        }
      } catch (error) {
        if (mounted.current) setError(accountErrorMessage(error))
        // Let the account page request fresh proof and retry this same save if the server requires it.
        if (onSensitiveSave) throw error
      } finally {
        sending.current = false
        if (mounted.current) setBusy(false)
      }
    }
    if (onSensitiveSave) onSensitiveSave(save)
    else await save()
  }
  return (
    <form className="account-profile-form" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={busy || blocked} className="child-password-fields">
        {mode !== 'self' && mode !== 'code' ? (
          <label className="account-field">
            <span>子账号登录名</span>
            <input
              className="field__input"
              name="loginName"
              required
              minLength={3}
              maxLength={48}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,47}"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={initialName}
              title="3–48 位，以字母或数字开头，可使用点、下划线和短横线"
            />
          </label>
        ) : (
          <p className="account-context">登录名：{initialName}</p>
        )}
        {mode === 'login' || mode === 'code' || (mode === 'self' && !recover) ? (
          <SecretField
            key="old"
            name="password"
            label={active ? '子账号密码' : '当前密码'}
            kind="current-password"
          />
        ) : null}
        {mode === 'recover' || (mode === 'self' && recover) ? (
          <SecretField key="key" name="recoveryKey" label="子账号密码恢复码" kind="off" />
        ) : null}
        {fresh ? (
          <SecretField
            name="newPassword"
            label={mode === 'manage' && !initialName ? '初始密码' : '新密码'}
            kind="new-password"
            optional={optional}
          />
        ) : null}
        {mode === 'recover' ? (
          <p className="account-context">
            使用你在「修改子账号密码」里保存的一次性密码恢复码。没有恢复码时，可请主账号代为重置。
          </p>
        ) : null}
        {mode === 'self' ? (
          <p className="account-context">当前设备保持登录，其他设备需要重新登录。</p>
        ) : null}
        {mode === 'manage' && initialName ? (
          <p className="account-context">
            只改登录名时，密码留空。保存后，该子账号需要重新登录；重置密码还会作废旧的密码恢复码。
          </p>
        ) : null}
        {err ? (
          <p className="account-message account-message--error" role="alert">
            {err}
          </p>
        ) : null}
        <div className="account-actions">
          <button type="submit" className="btn btn--primary">
            {busy
              ? '正在提交…'
              : {
                  login: '登录子账号',
                  recover: '重置密码',
                  manage: '保存登录设置',
                  self: '保存新密码',
                  code: '生成并复制恢复码'
                }[mode]}
          </button>
          {mode === 'self' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setRecover((v) => !v)
                setError('')
              }}
            >
              {recover ? '用当前密码验证' : '改用恢复码验证'}
            </button>
          ) : null}
          {alternate ? (
            <button type="button" className="btn" onClick={alternate.select}>
              {alternate.label}
            </button>
          ) : null}
        </div>
      </fieldset>
    </form>
  )
}

export function ChildSignIn({ scope, blocked }: Props): JSX.Element {
  const [mode, setMode] = useState<'login' | 'recover'>('login'),
    [name, setName] = useState(''),
    [notice, setNotice] = useState('')
  return (
    <PasswordDisclosure
      layout="row"
      title="用子账号密码登录"
      description="使用主账号分配的登录名"
      onClose={() => {
        setMode('login')
        setName('')
        setNotice('')
      }}
    >
      {notice ? (
        <p role="status" className="account-message account-message--success">
          {notice}
        </p>
      ) : null}
      <PasswordForm
        key={mode}
        mode={mode}
        scope={scope}
        blocked={blocked}
        initialName={name}
        alternate={{
          label: mode === 'login' ? '忘记子账号密码' : '返回密码登录',
          select: () => {
            setMode(mode === 'login' ? 'recover' : 'login')
            setNotice('')
          }
        }}
        onDone={(n) => {
          if (mode === 'recover') {
            setName(n)
            setMode('login')
            setNotice('密码已重置，请用新密码登录。')
          }
        }}
      />
    </PasswordDisclosure>
  )
}

function LoginDetails({
  scope,
  blocked,
  childId,
  onDone,
  onSensitiveSave
}: Props & { childId?: string; onDone: () => void; onSensitiveSave?: SensitiveSave }): JSX.Element {
  const [info, setInfo] = useState<{ loginName: string | null } | null>(null),
    [err, setError] = useState(''),
    [retry, refresh] = useState(0)
  const { serviceUrl, userId, tenantId, sessionId } = scope
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let current = true
    setError('')
    setInfo(null)
    void window.aether.account
      .getChildLoginInfo({ serviceUrl, userId, tenantId, sessionId }, childId)
      .then((v) => {
        if (current) setInfo(v)
      })
      .catch((e) => {
        if (current) setError(accountErrorMessage(e))
      })
    return () => {
      current = false
    }
  }, [serviceUrl, userId, tenantId, sessionId, childId, retry])
  if (err)
    return (
      <>
        <p className="account-message account-message--error" role="alert">
          {err}
        </p>
        <button className="btn" onClick={() => refresh((v) => v + 1)}>
          重试
        </button>
      </>
    )
  if (!info)
    return (
      <p className="account-context" role="status">
        正在读取登录设置…
      </p>
    )
  if (!childId && !info.loginName)
    return (
      <p className="account-context">
        主账号还没有为你设置登录名和初始密码。设置后，你可以在这里自己改密码。
      </p>
    )
  return (
    <>
      <PasswordForm
        mode={childId ? 'manage' : 'self'}
        scope={scope}
        childId={childId}
        initialName={info.loginName ?? ''}
        blocked={blocked}
        onDone={onDone}
        onSensitiveSave={onSensitiveSave}
      />
      {!childId ? (
        <PasswordDisclosure
          onClose={() => setCopied(false)}
          title="备用密码恢复码"
          description="忘记密码时用它重新设置，不需要主账号代办"
        >
          <p className="account-context">
            输入当前密码，生成一枚只能使用一次的恢复码。新码会替换旧码，请把它存到安全的地方。
          </p>
          <PasswordForm
            mode="code"
            scope={scope}
            initialName={info.loginName ?? ''}
            blocked={blocked}
            onDone={() => setCopied(true)}
          />
          {copied ? (
            <p className="account-message account-message--success" role="status">
              恢复码已复制，请妥善保存。
            </p>
          ) : null}
        </PasswordDisclosure>
      ) : null}
    </>
  )
}

export function OwnChildPassword({
  scope,
  blocked,
  onChanged
}: Props & { onChanged: () => void }): JSX.Element {
  const [notice, setNotice] = useState('')
  return (
    <PasswordDisclosure
      layout="row"
      title="修改子账号密码"
      description="用当前密码或自己的恢复码验证"
      onClose={() => setNotice('')}
    >
      {notice ? (
        <p className="account-message account-message--success" role="status">
          {notice}
        </p>
      ) : null}
      <LoginDetails
        scope={scope}
        blocked={blocked}
        onDone={() => {
          setNotice('新密码已生效，其他设备已退出。')
          onChanged()
        }}
      />
    </PasswordDisclosure>
  )
}

export function ManagedChildLoginDialog({
  scope,
  childId,
  name,
  blocked,
  onClose,
  onSaved,
  onSensitiveSave
}: Props & {
  childId: string
  name: string
  onClose: () => void
  onSaved: () => void
  onSensitiveSave: SensitiveSave
}): JSX.Element {
  return (
    <Dialog title={'管理子账号登录：' + name} width={450} closeDisabled={blocked} onClose={onClose}>
      <LoginDetails
        scope={scope}
        childId={childId}
        blocked={blocked}
        onDone={onSaved}
        onSensitiveSave={onSensitiveSave}
      />
    </Dialog>
  )
}
export const childPasswordScope = (state: AccountState): ChildPasswordScope => ({
  serviceUrl: state.serviceUrl,
  userId: state.user?.id ?? null,
  tenantId: state.user?.tenantId ?? null,
  sessionId: state.user?.sessionId ?? null
})
