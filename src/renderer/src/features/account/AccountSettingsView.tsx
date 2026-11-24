import { Fragment, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { AccountProfileInput, AccountProvider, AccountSession, AccountState, AccountUser } from '@shared/account'
import type { EngineSnapshot, RemoteAuthCredential } from '@shared/ipc'
import { sameRemoteService } from '@shared/remote-service-url'
import { Dialog } from '@renderer/ui/Dialog'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { Icon } from '@renderer/ui/icons'
import { useHoverDetail } from '@renderer/ui/useHoverDetail'
import { SettingsDisclosure, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'
import { openAppSettings } from '../settings/app-settings-navigation'
import { ACCOUNT_STATUS_LABELS, dismissAccountOnboarding, publishAccountState, refreshAccount, requestAccountOnboarding, useAccount } from './account-store'
import { isOnboardingAccount } from './account-onboarding'
import { accountErrorMessage } from './account-errors'
import { AccountAvatar } from './AccountAvatar'
import { AccountFamilySettings } from './AccountFamilySettings'
import { ChildSignIn, OwnChildPassword, childPasswordScope } from './ChildPasswordForms'
import { AccountServiceCredentials } from './AccountServiceCredentials'
import './account.css'

const RECENT_AUTH_MS = 10 * 60_000
const identityOf = (account: AccountState): string => JSON.stringify([account.serviceUrl, account.user?.id, account.user?.tenantId, account.user?.sessionId])
const needsReauthentication = (user: AccountUser | null): boolean => {
  const timestamp = Date.parse(user?.authenticatedAt ?? '')
  return !Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp >= RECENT_AUTH_MS
}
const isReauthenticationError = (cause: unknown): boolean => /需要重新验证登录|重新验证身份|recent.auth|reauthentication.required/i.test(accountErrorMessage(cause))
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '未知'
}
function profileFields(user: AccountUser): AccountProfileInput {
  return { name: user.name, email: user.email ?? '', bio: user.bio ?? '' }
}
function ProfileForm({ user, busy, onSave, saving }: {
  user: AccountUser; busy: boolean; onSave: (input: AccountProfileInput) => void; saving: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<AccountProfileInput>(() => profileFields(user))
  const changed = JSON.stringify(draft) !== JSON.stringify(profileFields(user))
  const submit = (event: FormEvent): void => { event.preventDefault(); if (!busy && changed) onSave(draft) }
  return <form className="account-profile-form" onSubmit={submit}>
    <label className="account-field"><span>姓名</span><input className="field__input" maxLength={80} value={draft.name ?? ''} disabled={busy} placeholder="留空使用随机姓名" autoComplete="name" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
    <label className="account-field"><span>邮箱 <small>选填</small></span><input className="field__input" type="email" maxLength={254} value={draft.email ?? ''} disabled={busy} placeholder="仅用于资料展示，不能登录或找回账号" autoComplete="email" onChange={event => setDraft({ ...draft, email: event.target.value })} /></label>
    <label className="account-field"><span>简介 <small>选填</small></span><textarea className="field__input" maxLength={1000} rows={3} value={draft.bio ?? ''} disabled={busy} onChange={event => setDraft({ ...draft, bio: event.target.value })} /></label>
    <div className="account-actions"><button className="btn btn--primary" type="submit" disabled={busy || !changed}>{saving ? '保存中…' : '保存资料'}</button></div>
  </form>
}
function ProviderAction({ provider, linked = false, disabled, actionLabel, onLogin, onUnlink }: {
  provider: AccountProvider; linked?: boolean; disabled: boolean; actionLabel?: string
  onLogin: (credential?: string) => Promise<boolean>; onUnlink?: () => void
}): JSX.Element {
  const [credential, setCredential] = useState('')
  return <SettingsRow label={provider.name} description={linked ? '已绑定' : provider.type === 'credential' ? '使用此服务提供的登录凭据' : '在浏览器中授权'}>
    <div className="account-provider__controls">
      {!linked && provider.type === 'credential' ? <input className="field__input" type="password" autoComplete="current-password" aria-label={`${provider.name}登录凭据`} value={credential} disabled={disabled} maxLength={16384} placeholder="登录凭据" onChange={event => setCredential(event.target.value)} /> : null}
      <button type="button" className="btn" disabled={disabled || (!linked && provider.type === 'credential' && !credential.trim())} onClick={() => {
        if (linked) onUnlink?.()
        else void onLogin(credential.trim() || undefined).then(success => { if (success) setCredential('') })
      }}>{linked ? '解除绑定' : actionLabel ?? '继续'}</button>
    </div>
  </SettingsRow>
}
interface AccountAction { identity: string; label: string; task: () => Promise<AccountState | null>; message?: string; sensitive?: boolean }

export function AccountSettingsView(): JSX.Element {
  const { account, loading, error: loadError, onboarding: onboardingRequest } = useAccount()
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [signupOpen, setSignupOpen] = useState(false), [activationCode, setActivationCode] = useState('')
  const [loginOpen, setLoginOpen] = useState(false), [recoveryKey, setRecoveryKey] = useState('')
  const [sessions, setSessions] = useState<AccountSession[] | null>(null), [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState('')
  const [reauthOpen, setReauthOpen] = useState(false), [reauthKey, setReauthKey] = useState('')
  const pendingAction = useRef<AccountAction | null>(null), operation = useRef(false), mounted = useRef(true)
  const accountIdentity = identityOf(account), latest = useRef({ account, identity: accountIdentity, loading })
  latest.current = { account, identity: accountIdentity, loading }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingAction.current = null } }, [])
  useEffect(() => {
    pendingAction.current = null; setSignupOpen(false); setActivationCode('')
    setReauthOpen(false); setReauthKey(''); setRecoveryKey(''); setLoginOpen(false)
    setSessions(null); setSessionsLoading(false); setSessionsError(''); setError(''); setNotice('')
  }, [accountIdentity])
  const authenticated = account.status === 'authenticated', user = account.user
  // An expired session can still carry the same profile and session ID. Discard any suspended credential change.
  useEffect(() => {
    if (!authenticated) { pendingAction.current = null; setReauthOpen(false); setReauthKey('') }
  }, [authenticated])
  const isChild = user?.accountKind === 'child'
  const canReturnToParent = !!(account.recovery?.available && account.recovery.exportedAt) || !!user?.identities.some(i => account.providers.some(p => p.id === i.providerId))
  const canActivateExisting = authenticated && user?.accountKind === 'primary' && user.mainAccountActivated === false && account.registrationEnabled
  useEffect(() => { if (user?.mainAccountActivated) { setSignupOpen(false); setActivationCode('') } }, [user?.mainAccountActivated])
  const blocked = !!busy || loading
  const httpUntrusted = account.transport === 'http-untrusted', httpTrusted = account.transport === 'http-trusted'
  const loginBlocked = blocked || account.status === 'offline' || account.status === 'unavailable' || httpUntrusted || !account.serviceUrl
  const local = account.connectionMode === 'embedded'
  const roleLabel = isChild ? '子账号 · 由主账号管理' : user?.accountKind === 'primary' && user.mainAccountActivated ? '主账号' : ''
  const accountDescription = user ? [roleLabel, user.email].filter(Boolean).join(' · ') || '管理此账号的登录与恢复方式'
    : local ? '无需登录即可使用，工作保存在本机。' : '登录当前服务，访问其中保存的账号数据。'
  const hasRecovery = account.recovery?.available === true
  const onboarding = isOnboardingAccount(onboardingRequest, account)
  const displayedError = error || loadError ? accountErrorMessage(error || loadError) : ''
  const accountMessage = account.message ? accountErrorMessage(account.message) : ''
  const isCurrent = (identity: string): boolean => mounted.current && latest.current.identity === identity

  const perform = async (action: AccountAction, verified = false): Promise<AccountState | null> => {
    if (operation.current || latest.current.loading || !isCurrent(action.identity) || (action.sensitive && latest.current.account.status !== 'authenticated')) return null
    if (action.sensitive && !verified && needsReauthentication(latest.current.account.user)) {
      pendingAction.current = action; setError(''); setReauthOpen(true); return null
    }
    operation.current = true; setBusy(action.label); setError(''); setNotice('')
    try {
      const next = await action.task()
      // The main process may already have published this result. A later response
      // from a previous account must not restore its profile after a switch.
      if (next && (isCurrent(action.identity) || latest.current.identity === identityOf(next))) publishAccountState(next)
      if (isCurrent(action.identity) && action.message && next) setNotice(action.message)
      return next
    } catch (cause) {
      if (isCurrent(action.identity)) {
        if (action.sensitive && latest.current.account.status === 'authenticated' && isReauthenticationError(cause)) { pendingAction.current = action; setReauthOpen(true) }
        else setError(accountErrorMessage(cause))
      }
      return null
    } finally { operation.current = false; if (mounted.current) setBusy('') }
  }
  const action = (label: string, task: AccountAction['task'], message?: string, sensitive = false): AccountAction => ({ identity: accountIdentity, label, task, message, sensitive })
  const verify = async (task: AccountAction['task'], external = false): Promise<boolean> => {
    const pending = pendingAction.current
    if (!pending || !isCurrent(pending.identity) || latest.current.account.status !== 'authenticated') return false
    const next = await perform(action(external ? 'reauth-external' : 'reauth', task))
    if (!next || next.status !== 'authenticated' || !isCurrent(pending.identity) || pendingAction.current !== pending) return false
    pendingAction.current = null; setReauthOpen(false); setReauthKey('')
    await perform(pending, true)
    return true
  }
  const applyCredential = async (service: string, revision: number, credential: RemoteAuthCredential | null): Promise<EngineSnapshot> => {
    const current = latest.current.account
    if (operation.current || latest.current.loading || !mounted.current || current.connectionMode !== 'remote' || current.user
        || current.status === 'authenticated' || !sameRemoteService(current.serviceUrl, service)) throw new Error('账号或服务已变化，请在当前账号页重试。')
    operation.current = true; setBusy('service-credential')
    try { return await window.aether.account.applyServiceCredential(service, revision, credential) }
    finally { operation.current = false; if (mounted.current) setBusy('') }
  }
  const backup = async (): Promise<AccountState | null> => perform(action('backup', async () => {
    const saved = await window.aether.account.exportRecovery()
    if (!saved) return null
    const next = await window.aether.account.getState()
    if (isCurrent(accountIdentity)) { setNotice('登录凭证已保存。'); dismissAccountOnboarding() }
    return next
  }))
  const loadSessions = async (): Promise<void> => {
    if (sessionsLoading || latest.current.loading || !isCurrent(accountIdentity)) return
    setSessionsLoading(true); setSessionsError('')
    try { const next = await window.aether.account.sessions(); if (isCurrent(accountIdentity)) setSessions(next) }
    catch (cause) { if (isCurrent(accountIdentity)) setSessionsError(accountErrorMessage(cause, '无法读取登录会话')) }
    finally { if (isCurrent(accountIdentity)) setSessionsLoading(false) }
  }
  const revokeLogin = async (session: AccountSession): Promise<void> => {
    const confirmed = await confirmDialog({ title: '撤销登录会话',
      body: session.current ? '当前会话将失效，需要重新登录。' : `撤销 ${session.id.slice(0, 8)} 后，该会话需要重新登录。`, confirmText: '撤销登录' })
    if (!confirmed) return
    const next = await perform(action('revoke', async () => {
      await window.aether.account.revokeSession(session.id)
      return window.aether.account.getState()
    }, '登录会话已撤销。'))
    if (next?.status === 'authenticated' && isCurrent(accountIdentity)) await loadSessions()
  }
  const logoutAll = async (): Promise<void> => {
    const confirmed = await confirmDialog({ title: '退出所有登录会话', body: '所有登录会话（包括当前会话）都将失效，账号数据保留。', confirmText: '退出所有会话', danger: true })
    if (confirmed) await perform(action('logout-all', () => window.aether.account.logout(true)))
  }
  const logoutCurrent = async (): Promise<void> => {
    if (!user) return
    const body = isChild ? '此设备会退出子账号。要再次使用，请用子账号密码登录，或请主账号重新授权。' : account.recovery?.exportedAt || user.identities.length > 0
      ? '账号数据会保留。下次可用恢复文件、恢复码或已绑定的登录方式登录。'
      : '尚未记录恢复文件备份。请确认已保存恢复码；没有凭证或第三方登录方式将无法再次登录。账号数据会保留。'
    if (await confirmDialog({ title: '退出账号', body, confirmText: '退出登录' })) await perform(action('logout', () => window.aether.account.logout()))
  }
  const signInWith = async (provider: AccountProvider, credential?: string, openingCode?: string): Promise<boolean> => {
    if (loginBlocked) return false
    const next = await perform(action(`provider:${provider.id}`, () => window.aether.account.externalLogin(provider.id, authenticated ? 'link' : 'login', credential, openingCode ? {code:openingCode,serviceUrl:account.serviceUrl} : undefined), authenticated ? '已绑定登录方式。' : '已登录。', authenticated))
    if (!authenticated && next?.status === 'authenticated' && next.recovery?.available && !next.recovery.exportedAt) requestAccountOnboarding(next)
    return !!next
  }
  const regenerate = async (): Promise<void> => {
    const confirmed = await confirmDialog({ title: '重新生成恢复码', body: '旧恢复码和旧 API Key 将失效，其他登录会话会退出。当前会话保留。生成后请重新保存登录凭证。', confirmText: '重新生成', danger: true })
    if (!confirmed || !isCurrent(accountIdentity)) return
    await perform(action('regenerate', async () => {
      const next = await window.aether.account.regenerateRecovery()
      requestAccountOnboarding(next)
      return next
    }, '恢复码已更新，请保存新的登录凭证。', true))
  }
  const { triggerProps: loginHelpTriggerProps, tooltip: loginHelpTooltip } = useHoverDetail({ enabled: true, label: '个人账号登录说明', content: <>
    <strong className="account-login-help__title">账号属于当前服务</strong>
    <p>登录已有账号可重新访问该服务保存的数据。创建主账号需要管理员签发的开通码，原有本机历史不会自动迁入。</p>
    <p>恢复文件只保存登录凭证，不包含会话或文件。邮箱仅用于资料展示。</p>
  </> })

  return <div className="account-settings settings-view">
    <section className="account-summary" aria-label="账号概览">
      <AccountAvatar name={user?.name} avatarUrl={user?.avatarUrl} large />
      <div className="account-summary__copy"><h2>{user?.name || (local ? '本机工作空间' : '连接你的账号')}</h2>
        <p>{accountDescription}</p>
        <span className={`account-status is-${account.status}`}>{loading ? '正在读取账号…' : httpUntrusted ? '等待确认内网连接' : ACCOUNT_STATUS_LABELS[account.status]}</span>
      </div>
      <button type="button" className="btn account-icon-button" aria-label="刷新账号状态" title="刷新账号状态" disabled={blocked} onClick={() => void refreshAccount()}><Icon name="restart" size={15} /></button>
    </section>
    <div className="account-service"><span>{local ? '本机服务' : '远程服务'}</span><span className="account-service__address">{account.serviceUrl || '尚未连接'}</span><button type="button" className="btn account-icon-button" aria-label="查看个人账号登录说明" {...loginHelpTriggerProps}><Icon name="alert-circle" size={14} /></button>{loginHelpTooltip}</div>
    {!user && local ? <p className="account-context">登录后进入独立账号空间；退出后可回到本机空间。此处不迁移或同步本机文件。</p> : null}
    {displayedError && !signupOpen && !reauthOpen && !onboarding ? <p className="account-message account-message--error" role="alert">{displayedError}</p> : null}
    {notice ? <p className="account-message account-message--success" role="status">{notice}</p> : null}
    {accountMessage && accountMessage !== displayedError && !httpUntrusted && !(account.persistence === 'session' && authenticated) ? <p className="account-message" role="status">{accountMessage}</p> : null}
    {account.persistence === 'session' && user ? <p className="account-message account-message--warning" role="status">系统加密存储暂不可用，本次登录只在应用运行期间保留。请保存登录凭证。</p> : null}
    {httpUntrusted || httpTrusted ? <section className="account-transport" aria-label="内网 HTTP 连接"><div className="account-transport__copy"><strong>{httpTrusted ? '已信任此内网服务' : '确认内网连接'}</strong><p>HTTP 会明文传输登录凭证，仅用于可信内网。信任仅对当前地址生效。</p></div><button className="btn" disabled={blocked} onClick={() => void perform(action('http-trust', () => window.aether.account.setHttpTrust(account.serviceUrl, !httpTrusted)))}>{httpTrusted ? '撤销信任' : '信任此内网服务'}</button></section> : null}

    {!authenticated ? <>
      <div className="account-entry-actions"><button type="button" className="btn btn--primary" disabled={loginBlocked} aria-expanded={loginOpen} aria-controls="account-login-form" onClick={() => setLoginOpen(value => !value)}>{account.status === 'expired' ? '重新登录' : '登录已有账号'}</button>
        {account.registrationEnabled && account.status !== 'expired' ? <button className="btn" disabled={loginBlocked} onClick={() => { setError(''); setActivationCode(''); setSignupOpen(true) }}>创建主账号</button> : null}
      </div>
      {loginOpen ? <section id="account-login-form" className="account-login-panel" aria-label="登录已有账号">
        <p className="account-context">选择恢复文件，或粘贴恢复码。凭证必须属于上方服务。</p>
        <button type="button" className="btn" disabled={loginBlocked} onClick={() => void perform(action('import', () => window.aether.account.importRecovery(), '已登录原账号。'))}>选择恢复文件</button>
        <form className="account-login-key" onSubmit={event => {
          event.preventDefault(); const key = recoveryKey.trim(); if (!key || loginBlocked) return
          void perform(action('login', () => window.aether.account.login(key), '已登录原账号。')).then(next => { if (next) setRecoveryKey('') })
        }}><label className="account-field"><span>恢复码</span><input className="field__input" type="password" autoComplete="current-password" maxLength={4096} value={recoveryKey} disabled={loginBlocked} onChange={event => setRecoveryKey(event.target.value)} placeholder="粘贴已保存的恢复码" /></label><button className="btn btn--primary" type="submit" disabled={loginBlocked || !recoveryKey.trim()}>{busy === 'login' ? '正在登录…' : '登录'}</button></form>
        <p className="account-context">邮箱不能用于登录或找回账号。</p>
        {account.childPasswordAvailable ? <ChildSignIn key={accountIdentity} scope={childPasswordScope(account)} blocked={loginBlocked} /> : null}
      </section> : null}
      {!account.serviceUrl || account.status === 'unavailable' ? <button type="button" className="btn" onClick={() => openAppSettings('general')}>检查引擎连接</button> : null}
    </> : null}

    {authenticated && user && !isChild ? <SettingsGroup title="登录与恢复">
      <SettingsRow label="登录凭证" description={hasRecovery ? account.recovery?.exportedAt ? `最近保存于 ${formatTime(account.recovery.exportedAt)}` : '尚未保存恢复文件。建议现在保存，以便再次登录。' : '此设备没有恢复码。可使用已绑定的登录方式，或在「账号安全」中重新生成。'}>
        <div className="account-row-actions"><button className="btn" disabled={blocked || !hasRecovery} onClick={() => void backup()}>{busy === 'backup' ? '正在保存…' : '保存恢复文件'}</button><button className="btn" disabled={blocked || !hasRecovery} onClick={() => void perform(action('copy', async () => { await window.aether.account.copyRecovery(); if (isCurrent(accountIdentity)) setNotice('恢复码已复制，请妥善保管。'); return null }))}>复制恢复码</button></div>
      </SettingsRow>
      {account.providers.map(provider => <ProviderAction key={`${accountIdentity}:${provider.id}`} provider={provider} linked={!!user.identities.some(identity => identity.providerId === provider.id)} disabled={loginBlocked} actionLabel="绑定" onLogin={credential => signInWith(provider, credential)} onUnlink={() => void (async () => {
        if (await confirmDialog({ title: '解除账号绑定', body: `解除 ${provider.name} 后将不能通过它登录。请确认已保存恢复文件或保留其他登录方式。`, confirmText: '解除绑定' })) await perform(action('unlink', () => window.aether.account.unlink(provider.id), '已解除绑定。', true))
      })()} />)}
    </SettingsGroup> : null}
    {!authenticated && account.providers.length > 0 ? <SettingsGroup title="其他登录方式" footer="已有绑定可直接登录；首次开通请先选择「创建主账号」。">{account.providers.map(provider => <ProviderAction key={`${accountIdentity}:${provider.id}`} provider={provider} disabled={loginBlocked} onLogin={credential => signInWith(provider, credential)} />)}</SettingsGroup> : null}
    {busy.startsWith('provider:') ? <div className="account-external-pending"><span role="status">请在浏览器中完成授权…</span><button className="btn" onClick={() => void window.aether.account.cancelExternalLogin()}>取消授权</button></div> : null}

    {authenticated && user?.accountKind === 'primary' && user.mainAccountActivated === true && user.sessionId ? <AccountFamilySettings
      key={`family:${accountIdentity}`} scope={{ serviceUrl: account.serviceUrl, userId: user.id, tenantId: user.tenantId, sessionId: user.sessionId }}
      canReturn={canReturnToParent} passwordAvailable={account.childPasswordAvailable === true} blocked={loginBlocked}
      onSensitive={(label, task) => { void perform(action(`family:${label}`, task, undefined, true)) }} /> : null}
    <AccountServiceCredentials account={account} blocked={blocked} saving={busy === 'service-credential'} onSave={applyCredential} />

    {user ? <Fragment key={accountIdentity}>
      <SettingsGroup title="账号资料" ariaLabel="账号资料" className="account-preferences">
        <SettingsDisclosure layout="row" title="个人资料" description="姓名、邮箱和简介">
          <ProfileForm key={`${accountIdentity}:${user.name}:${user.email}:${user.bio}`} user={user} busy={blocked || !authenticated}
            saving={busy === 'profile'} onSave={input => void perform(action('profile', () => window.aether.account.updateProfile(input), '个人资料已保存。'))} />
        </SettingsDisclosure>
        <SettingsDisclosure layout="row" title="账号详情" description="账号 ID、服务地址和权限">
          <dl className="account-details">
            <dt>账号 ID</dt><dd>{user.id}</dd>
            <dt>创建时间</dt><dd><time dateTime={user.createdAt}>{formatTime(user.createdAt)}</time></dd>
            <dt>账号服务</dt><dd>{account.serviceUrl}</dd>
            <dt>保存方式</dt><dd>{account.persistence === 'encrypted' ? '系统加密存储' : account.persistence === 'session' ? '仅本次运行' : '未保存'}</dd>
            <dt>权限</dt><dd>{user.roles?.join('、') || '由服务管理'}</dd>
          </dl>
        </SettingsDisclosure>
      </SettingsGroup>
      <SettingsGroup title="账号安全" ariaLabel="账号安全" className="account-preferences">
        <SettingsDisclosure className="account-sessions" layout="row" title="登录会话" description="查看活动会话，撤销不再使用的登录。"
          onOpenChange={open => { if (open && sessions === null && authenticated) void loadSessions() }}>
          <div className="account-session-toolbar">
            <span role="status">{!authenticated ? '重新登录后可查看会话。' : sessionsLoading ? '正在读取登录会话…' : sessions?.length ? `${sessions.length} 个活动会话` : sessions ? '没有活动登录会话。' : ''}</span>
            <button type="button" className="btn account-icon-button" aria-label="刷新登录会话" title="刷新登录会话" disabled={blocked || sessionsLoading || !authenticated} onClick={() => void loadSessions()}>
              <Icon name="restart" size={15} />
            </button>
          </div>
          {authenticated && sessionsError ? <p className="account-session-error" role="alert">{sessionsError}</p> : null}
          {authenticated && sessions?.length ? <ul className="account-session-list">
            {sessions.map(session => <li className="account-session" key={session.id}>
              <div className="account-session__copy">
                <strong>{session.current ? '当前登录' : '其他登录'}</strong>
                <code>{session.id.slice(0, 8)}</code>
                <p className="account-session__times">
                  <span>最近使用 <time dateTime={session.lastSeenAt}>{formatTime(session.lastSeenAt)}</time></span>
                  <span>创建于 <time dateTime={session.createdAt}>{formatTime(session.createdAt)}</time></span>
                  <span>有效期至 <time dateTime={session.expiresAt}>{formatTime(session.expiresAt)}</time></span>
                </p>
              </div>
              <button type="button" className="btn" disabled={blocked} onClick={() => void revokeLogin(session)}>撤销登录</button>
            </li>)}
          </ul> : null}
          <div className="account-session-footer">
            <span>同时退出当前设备和其他设备。</span>
            <button type="button" className="btn" disabled={blocked || !authenticated} onClick={() => void logoutAll()}>退出所有会话</button>
          </div>
        </SettingsDisclosure>
        {!isChild ? <SettingsRow label="恢复码" description="重新生成后，旧恢复码和 API Key 会失效，其他会话将退出。">
          <button type="button" className="btn" disabled={blocked || !authenticated} onClick={() => void regenerate()}>重新生成</button>
        </SettingsRow> : null}
        {authenticated && user.accountKind === 'child' && account.childPasswordAvailable ? <OwnChildPassword scope={childPasswordScope(account)} blocked={blocked} onChanged={() => { if (sessions !== null) void loadSessions() }} /> : null}
        <SettingsRow label="当前设备" description={local ? '退出后回到本机工作空间，账号数据会保留。' : '退出此设备，服务端的账号数据会保留。'}>
          <button type="button" className="btn" disabled={blocked} onClick={() => void logoutCurrent()}>退出登录</button>
        </SettingsRow>
        {!authenticated && hasRecovery ? <SettingsRow label="保存登录凭证" description="可先保存此设备已有的恢复码，再重新登录。">
          <button type="button" className="btn" disabled={blocked} onClick={() => void backup()}>保存恢复文件</button>
        </SettingsRow> : null}
      </SettingsGroup>
    </Fragment> : null}

    {canActivateExisting ? <SettingsGroup title="子账号"><SettingsRow label="启用主账号" description="使用管理员签发的开通码，即可在现有账号中管理子账号。原有数据会保留。"><button type="button" className="btn" disabled={blocked} onClick={() => { setError(''); setActivationCode(''); setSignupOpen(true) }}>输入开通码</button></SettingsRow></SettingsGroup> : null}
    {signupOpen && !reauthOpen && (!authenticated || canActivateExisting) ? <Dialog title={canActivateExisting ? '启用主账号' : '创建主账号'} width={460} closeDisabled={!!busy} onClose={() => { setSignupOpen(false); setActivationCode(''); setError('') }} footer={<button className="btn" disabled={!!busy} onClick={() => { setSignupOpen(false); setActivationCode(''); setError('') }}>取消</button>}>
      <p className="account-dialog-copy">{canActivateExisting ? '开通后可管理自己的子账号；当前账号、会话和工作空间都保留。' : '请输入当前服务管理员签发的开通码。只在首次创建时使用，原有本机历史不会自动迁入新账号。'}</p>
      <form className="account-login-key" onSubmit={event => {
        event.preventDefault(); const code = activationCode.trim(); if (!code || loginBlocked) return
        if (canActivateExisting && user) { void perform(action('activate-primary', () => window.aether.account.activatePrimary({code, serviceUrl:account.serviceUrl, userId:user.id}), '主账号已开通。', true)); return }
        void perform(action('register', () => window.aether.account.register({code, serviceUrl:account.serviceUrl}))).then(next => { if (next?.status === 'authenticated') requestAccountOnboarding(next) })
      }}><label className="account-field"><span>主账号开通码</span><input className="field__input" type="password" autoComplete="off" spellCheck={false} maxLength={80} value={activationCode} disabled={loginBlocked} onChange={event => setActivationCode(event.target.value)} /></label><button type="submit" className="btn btn--primary" disabled={loginBlocked || !activationCode.trim()}>{canActivateExisting ? '启用主账号' : busy === 'register' ? '正在创建…' : '创建账号'}</button></form>
      {!canActivateExisting && account.providers.length > 0 ? <SettingsGroup title="使用第三方账号开通">{account.providers.map(provider => <ProviderAction key={provider.id} provider={provider} disabled={loginBlocked || !activationCode.trim()} actionLabel="授权并继续" onLogin={credential => signInWith(provider, credential, activationCode.trim())} />)}</SettingsGroup> : null}
      {busy.startsWith('provider:') ? <button className="btn" onClick={() => void window.aether.account.cancelExternalLogin()}>取消浏览器授权</button> : null}
      {displayedError ? <p className="account-message account-message--error" role="alert">{displayedError}</p> : null}
    </Dialog> : null}
    {onboarding && user && authenticated && !isChild ? <Dialog title="保存登录凭证" width={460} className="account-onboarding" closeDisabled={blocked} onClose={dismissAccountOnboarding} footer={<><button className="btn" disabled={blocked} onClick={dismissAccountOnboarding}>稍后</button><button className="btn btn--primary" disabled={blocked || !hasRecovery} onClick={() => void backup()}>{busy === 'backup' ? '正在保存…' : '保存恢复文件'}</button></>}><p className="account-dialog-copy">账号已准备好。保存恢复文件后，可以重新登录这个账号。</p><p className="account-dialog-copy account-context">这是登录凭证，不包含会话或文件。请妥善保管，不要分享。个人资料可以稍后在设置中填写。</p>{displayedError ? <p className="account-message account-message--error" role="alert">{displayedError}</p> : null}</Dialog> : null}
    {reauthOpen && authenticated && user ? <Dialog title="重新验证身份" width={460} className="account-reauth" closeDisabled={!!busy} onClose={() => { pendingAction.current = null; setReauthOpen(false); setReauthKey(''); setError('') }} footer={<button className="btn" disabled={!!busy} onClick={() => { pendingAction.current = null; setReauthOpen(false); setReauthKey(''); setError('') }}>取消</button>}>
      <p className="account-dialog-copy">为继续此操作，请验证当前账号。验证成功后会继续，不会退出账号。</p>
      <form className="account-login-key" onSubmit={event => { event.preventDefault(); if (reauthKey.trim() && !busy) void verify(() => window.aether.account.reauthenticate(reauthKey.trim())) }}><label className="account-field"><span>恢复码</span><input className="field__input" type="password" autoComplete="current-password" maxLength={4096} value={reauthKey} disabled={!!busy} onChange={event => setReauthKey(event.target.value)} /></label><button className="btn btn--primary" type="submit" disabled={!!busy || !reauthKey.trim()}>{busy === 'reauth' ? '正在验证…' : '验证并继续'}</button></form>
      {account.providers.filter(provider => user.identities.some(identity => identity.providerId === provider.id)).map(provider => <ProviderAction key={provider.id} provider={provider} disabled={!!busy} actionLabel="验证" onLogin={credential => verify(() => window.aether.account.externalLogin(provider.id, 'reauth', credential), provider.type !== 'credential')} />)}
      {busy === 'reauth-external' ? <button className="btn" onClick={() => void window.aether.account.cancelExternalLogin()}>取消浏览器授权</button> : null}
      {displayedError ? <p className="account-message account-message--error" role="alert">{displayedError}</p> : null}
    </Dialog> : null}
  </div>
}
