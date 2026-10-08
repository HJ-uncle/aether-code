import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { AccountProfileInput, AccountProvider, AccountSession, AccountState, AccountUser } from '@shared/account'
import { Dialog } from '@renderer/workbench/Dialog'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Icon } from '@renderer/workbench/icons'
import { SettingsContent, SettingsDisclosure, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'
import { openAppSettings } from '../settings/app-settings-navigation'
import { ACCOUNT_STATUS_LABELS, dismissAccountOnboarding, publishAccountState, refreshAccount, requestAccountOnboarding, useAccount } from './account-store'
import { isOnboardingAccount } from './account-onboarding'
import { accountErrorMessage } from './account-errors'
import { AccountAvatar } from './AccountAvatar'
import './account.css'

function profileFields(user: AccountUser): AccountProfileInput {
  return { name: user.name, email: user.email ?? '', bio: user.bio ?? '' }
}

function ProfileForm({ user, busy, onSave, onboarding = false, saving = false }: {
  user: AccountUser; busy: boolean; onSave: (input: AccountProfileInput) => void; onboarding?: boolean; saving?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<AccountProfileInput>(() => profileFields(user))
  const changed = JSON.stringify(draft) !== JSON.stringify(profileFields(user))
  const submit = (event: FormEvent): void => { event.preventDefault(); if (!busy) onSave(draft) }
  return <form id={onboarding ? 'account-onboarding-form' : 'account-profile-form'} className="account-profile-form" onSubmit={submit}>
    <label className="account-field"><span>姓名</span><input className="field__input" aria-label="姓名" maxLength={80}
      value={draft.name ?? ''} disabled={busy} placeholder="留空使用随机姓名" autoComplete="name"
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
    <label className="account-field"><span>邮箱 <small>选填</small></span><input className="field__input" aria-label="邮箱" type="email" maxLength={254}
      value={draft.email ?? ''} disabled={busy} placeholder="用于个人资料展示" autoComplete="email"
      onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
    <label className="account-field"><span>简介 <small>选填</small></span><textarea className="field__input" aria-label="简介" maxLength={1000} rows={3}
      value={draft.bio ?? ''} disabled={busy} placeholder="简单介绍一下自己"
      onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></label>
    {!onboarding ? <div className="account-actions"><button className="btn btn--primary" type="submit" disabled={busy || !changed}>{saving ? '保存中…' : '保存资料'}</button></div> : null}
  </form>
}

function ProviderAction({ provider, linked, disabled, onLogin, onUnlink }: {
  provider: AccountProvider; linked: boolean; disabled: boolean;
  onLogin: (credential?: string) => void; onUnlink: () => void
}): JSX.Element {
  const [credential, setCredential] = useState('')
  return <SettingsRow label={provider.name} description={linked ? '已绑定到当前账号' : provider.type === 'credential' ? '使用此服务提供的登录凭证' : '在浏览器中安全授权'}>
    <div className="account-provider__controls">
      {!linked && provider.type === 'credential' ? <input className="field__input" type="password" autoComplete="off"
        aria-label={`${provider.name}登录凭证`} value={credential} disabled={disabled} maxLength={16384}
        placeholder="输入登录凭证" onChange={(event) => setCredential(event.target.value)} /> : null}
      <button type="button" className="btn" disabled={disabled || (!linked && provider.type === 'credential' && !credential.trim())}
        onClick={() => { if (linked) onUnlink(); else { const value = credential.trim(); setCredential(''); onLogin(value || undefined) } }}>
        {linked ? '解除绑定' : '继续'}
      </button>
    </div>
  </SettingsRow>
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '未知'
}

export function AccountSettingsView(): JSX.Element {
  const { account, loading, error: loadError, onboarding: onboardingRequest } = useAccount()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [sessions, setSessions] = useState<AccountSession[] | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const mounted = useRef(true)
  const operation = useRef(false)
  const accountIdentity = `${account.serviceUrl}:${account.user?.id ?? ''}`
  const currentIdentity = useRef(accountIdentity)
  currentIdentity.current = accountIdentity
  const currentlyLoading = useRef(loading)
  currentlyLoading.current = loading
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setSessions(null); setSessionsOpen(false); setSessionsLoading(false); setRecoveryKey(''); setError(''); setNotice('') }, [accountIdentity])
  const onboarding = isOnboardingAccount(onboardingRequest, account)
  const authenticated = account.status === 'authenticated'
  const blocked = !!busy || loading
  const httpUntrusted = account.transport === 'http-untrusted'
  const httpTrusted = account.transport === 'http-trusted'
  const loginBlocked = blocked || account.status === 'offline' || account.status === 'unavailable' || httpUntrusted || !account.serviceUrl
  const displayedError = error || loadError ? accountErrorMessage(error || loadError) : ''
  const accountMessage = account.message ? accountErrorMessage(account.message) : ''
  const user = account.user

  const perform = async (label: string, task: () => Promise<AccountState | null>, message = ''): Promise<AccountState | null> => {
    // A confirmation dialog may outlive an engine switch. Re-check the current
    // profile before its old callback can act on the newly selected account.
    if (operation.current || currentlyLoading.current || currentIdentity.current !== accountIdentity) return null
    operation.current = true
    setBusy(label); setError(''); setNotice('')
    try {
      const state = await task()
      if (state) publishAccountState(state)
      if (mounted.current && message && state) setNotice(message)
      return state
    } catch (cause) {
      if (mounted.current) setError(accountErrorMessage(cause))
      return null
    } finally {
      operation.current = false
      if (mounted.current) setBusy('')
    }
  }

  const loadSessions = async (): Promise<void> => {
    if (currentlyLoading.current || currentIdentity.current !== accountIdentity) return
    const identity = currentIdentity.current
    setSessionsLoading(true); setError('')
    try { const next = await window.aether.account.sessions(); if (mounted.current && identity === currentIdentity.current) setSessions(next) }
    catch (cause) { if (mounted.current && identity === currentIdentity.current) setError(accountErrorMessage(cause, '无法读取登录设备')) }
    finally { if (mounted.current && identity === currentIdentity.current) setSessionsLoading(false) }
  }

  const signInWith = async (provider: AccountProvider, credential?: string): Promise<void> => {
    if (loginBlocked) return
    const hadUser = authenticated
    const next = await perform(`provider:${provider.id}`, () => window.aether.account.externalLogin(provider.id, hadUser ? 'link' : 'login', credential), hadUser ? '已绑定第三方账号，原账号资料和数据保持不变。' : '登录成功。')
    if (!hadUser && next?.status === 'authenticated' && next.user && !next.user.email && !next.user.bio) requestAccountOnboarding(next)
  }

  return <div className="account-settings settings-view">
    <section className="account-summary" aria-label="账号概览">
      <AccountAvatar name={user?.name} avatarUrl={user?.avatarUrl} large />
      <div className="account-summary__copy"><h2>{user?.name || '让工作跟随你的账号'}</h2>
        <p>{user?.email || (user ? '在下方完善你的个人资料' : '一键登录，或恢复已有账号继续工作。')}</p>
        <span className={`account-status is-${account.status}`}>{loading ? '正在读取账号…' : httpUntrusted ? '等待确认内网连接' : ACCOUNT_STATUS_LABELS[account.status]}</span>
      </div>
      <button type="button" className="btn account-summary__refresh" aria-label="刷新账号状态" disabled={loading || !!busy} onClick={() => void refreshAccount()}><Icon name="restart" size={15} /></button>
    </section>

    {displayedError ? <p className="account-message account-message--error" role="alert">{displayedError}</p> : null}
    {notice ? <p className="account-message account-message--success" role="status">{notice}</p> : null}
    {accountMessage && accountMessage !== displayedError && !httpUntrusted && !(account.persistence === 'session' && account.status === 'authenticated') ? <p className="account-message" role="status">{accountMessage}</p> : null}
    {account.persistence === 'session' && user ? <p className="account-message account-message--warning" role="status">此设备的系统密钥存储暂不可用，当前登录仅在本次应用运行期间有效。请备份恢复凭证，或绑定第三方账号以便再次登录。</p> : null}

    {httpUntrusted || httpTrusted ? <section className="account-transport" aria-label="内网 HTTP 连接">
      <div className="account-transport__copy"><strong>{httpTrusted ? '已信任此内网服务' : '确认内网连接'}</strong>
        <span className="account-transport__address">{account.serviceUrl}</span>
        <p>HTTP 会明文传输登录凭证，仅用于可信内网。授权只对以上服务地址生效。</p>
      </div>
      <button type="button" className={`btn${httpUntrusted ? ' btn--primary' : ''}`} disabled={blocked} onClick={() => {
        void perform('http-trust', () => window.aether.account.setHttpTrust(account.serviceUrl, !httpTrusted))
      }}>{busy === 'http-trust' ? '正在更新…' : httpTrusted ? '撤销信任' : '信任此内网服务'}</button>
    </section> : null}

    {!authenticated ? <SettingsGroup title={account.status === 'expired' ? '重新登录' : '登录账号'}>
      {account.registrationEnabled ? <SettingsRow label="一键登录" description="自动创建账号，无需先填写个人资料。">
        <button type="button" className="btn btn--primary" disabled={loginBlocked} onClick={() => {
          void perform('register', () => window.aether.account.register()).then((next) => {
            if (next?.status === 'authenticated') requestAccountOnboarding(next)
          })
        }}>{busy === 'register' ? '正在创建…' : '一键登录'}</button>
      </SettingsRow> : null}
      <SettingsRow label="已有账号" description="导入备份文件，恢复原账号及其数据。">
        <button type="button" className="btn" disabled={loginBlocked} onClick={() => void perform('import', () => window.aether.account.importRecovery(), '已恢复账号。')}>导入恢复凭证</button>
      </SettingsRow>
      <SettingsDisclosure title="使用恢复码登录" description="已保存恢复码时，可以直接输入。">
        <form className="account-recovery-form" onSubmit={(event) => {
          event.preventDefault(); const key = recoveryKey.trim(); if (!key || loginBlocked) return
          setRecoveryKey(''); void perform('login', () => window.aether.account.login(key), '已恢复账号。')
        }}><input className="field__input" type="password" aria-label="恢复码" autoComplete="off" maxLength={16384} placeholder="输入恢复码" value={recoveryKey} disabled={loginBlocked} onChange={(event) => setRecoveryKey(event.target.value)} />
          <button className="btn" type="submit" disabled={loginBlocked || !recoveryKey.trim()}>登录已有账号</button></form>
      </SettingsDisclosure>
      {!account.serviceUrl || account.status === 'unavailable' ? <SettingsRow label="连接账号服务" description="账号使用当前引擎服务。可检查服务地址后重试。"><button className="btn" onClick={() => openAppSettings('general')}>引擎设置</button></SettingsRow> : null}
    </SettingsGroup> : null}

    {user ? <SettingsGroup title="个人资料" footer="姓名留空时自动生成随机姓名；邮箱和简介均为选填。">
      <SettingsContent><ProfileForm key={accountIdentity + ':' + user.name + ':' + user.email + ':' + user.bio} user={user} busy={blocked || !authenticated} saving={busy === 'profile'}
        onSave={(input) => void perform('profile', () => window.aether.account.updateProfile(input), '个人资料已保存。')} /></SettingsContent>
    </SettingsGroup> : null}

    {account.providers.length > 0 ? <SettingsGroup title={authenticated ? '绑定第三方账号' : '其他登录方式'} footer={authenticated ? '绑定会保留当前账号及其数据，之后可用第三方账号直接登录。' : '首次登录会自动创建账号，已有绑定会恢复原账号。'}>
      {account.providers.map(provider => <ProviderAction key={`${accountIdentity}:${provider.id}`} provider={provider}
        linked={authenticated && !!user?.identities.some(identity => identity.providerId === provider.id)} disabled={loginBlocked}
        onLogin={(credential) => void signInWith(provider, credential)}
        onUnlink={() => void (async () => {
          if (await confirmDialog({ title: '解除账号绑定', body: `解除 ${provider.name} 后，将不能通过它登录当前账号。请确认已备份恢复凭证或保留其他登录方式。`, confirmText: '解除绑定' })) {
            await perform('unlink', () => window.aether.account.unlink(provider.id), '已解除绑定。')
          }
        })()} />)}
      {busy.startsWith('provider:') ? <SettingsContent><div className="account-external-pending"><span role="status">请在浏览器中完成授权…</span><button type="button" className="btn" onClick={() => void window.aether.account.cancelExternalLogin().catch(() => setError('取消失败，请重试。'))}>取消登录</button></div></SettingsContent> : null}
    </SettingsGroup> : null}

    {user ? <SettingsGroup title="账号安全">
      <SettingsRow label="恢复凭证" description="备份后可在其他设备恢复账号，请妥善保管备份文件。"><button className="btn" disabled={blocked} onClick={() => void perform('backup', async () => {
        const saved = await window.aether.account.exportRecovery(); if (saved && mounted.current) setNotice('恢复凭证已备份。'); return null
      })}>备份恢复凭证</button></SettingsRow>
      <SettingsDisclosure title="登录设备" description="查看活动登录，撤销不再使用的会话。" defaultOpen={sessionsOpen}>
        <div className="account-session-actions"><button className="btn" disabled={blocked || sessionsLoading || !authenticated} onClick={() => { setSessionsOpen(true); void loadSessions() }}>{sessionsLoading ? '正在读取…' : '刷新登录设备'}</button></div>
        {sessions?.length === 0 ? <p className="account-muted">没有活动登录。</p> : null}
        {sessions?.map(session => <div className="account-session" key={session.id}><div><strong>{session.current ? '当前设备' : '其他设备'}</strong><span>最近使用 {formatTime(session.lastSeenAt)}</span><small>有效期至 {formatTime(session.expiresAt)}</small></div><button className="btn" disabled={blocked || !authenticated} onClick={() => void (async () => {
          const confirmed = await confirmDialog({ title: '撤销登录', body: session.current ? '撤销后此设备将退出登录。' : '撤销后此设备需要重新登录才能访问账号。', confirmText: '撤销登录' })
          if (!confirmed) return
          await perform('revoke', async () => { await window.aether.account.revokeSession(session.id); return window.aether.account.getState() }, '已撤销登录。')
          if (!session.current) await loadSessions()
        })()}>撤销登录</button></div>)}
      </SettingsDisclosure>
      <SettingsRow label="退出账号" description="此设备的登录状态将被清除，服务端账号和数据仍保留。"><button className="btn" disabled={blocked} onClick={() => void (async () => {
        if (await confirmDialog({ title: '退出账号', body: '确认已备份恢复凭证或绑定第三方账号，以便下次登录。', confirmText: '退出登录' })) await perform('logout', () => window.aether.account.logout())
      })()}>退出登录</button></SettingsRow>
      <SettingsDisclosure title="账号详情" description="查看账号标识、绑定身份及第三方资料。">
        <dl className="account-details"><dt>账号 ID</dt><dd>{user.id}</dd><dt>创建时间</dt><dd>{formatTime(user.createdAt)}</dd><dt>账号服务</dt><dd>{account.serviceUrl || '本地引擎'}</dd><dt>保存方式</dt><dd>{account.persistence === 'encrypted' ? '系统加密存储' : account.persistence === 'session' ? '仅本次运行' : '未保存'}</dd></dl>
        {user.identities.map(identity => <div className="account-identity" key={`${identity.providerId}:${identity.subject}`}><strong>{account.providers.find(provider => provider.id === identity.providerId)?.name || identity.providerId}</strong><p>{identity.name || identity.subject}{identity.email ? ` · ${identity.email}` : ''}</p>{identity.avatarUrl ? <p>{identity.avatarUrl}</p> : null}{identity.userData && Object.keys(identity.userData).length > 0 ? <pre>{JSON.stringify(identity.userData, null, 2)}</pre> : null}</div>)}
        {Object.keys(user.userData).length > 0 ? <details><summary>扩展资料</summary><pre className="account-data">{JSON.stringify(user.userData, null, 2)}</pre></details> : null}
        <button type="button" className="btn" disabled={blocked || !authenticated} onClick={() => void (async () => {
          if (await confirmDialog({ title: '退出所有设备', body: '所有设备需要重新登录，当前设备也将退出。', confirmText: '退出所有设备', danger: true })) await perform('logout-all', () => window.aether.account.logout(true))
        })()}>退出所有设备</button>
      </SettingsDisclosure>
    </SettingsGroup> : null}

    {onboarding && user && authenticated ? <Dialog title="完善个人资料" width={480} className="account-onboarding" onClose={() => { if (!busy) dismissAccountOnboarding() }} footer={<>
      <button type="button" className="btn" disabled={!!busy} onClick={dismissAccountOnboarding}>暂时跳过</button>
      <button type="submit" form="account-onboarding-form" className="btn btn--primary" disabled={blocked}>{busy === 'profile' ? '保存中…' : '保存并继续'}</button>
    </>}><p className="account-onboarding__intro">账号已准备好。你可以补充资料，也可以稍后在个人账号中修改。</p>
      <ProfileForm user={user} busy={blocked} onboarding onSave={(input) => void perform('profile', () => window.aether.account.updateProfile(input), '个人资料已保存。').then(next => { if (next) dismissAccountOnboarding() })} />
      {error ? <p className="account-message account-message--error" role="alert">{error}</p> : null}
    </Dialog> : null}
  </div>
}
