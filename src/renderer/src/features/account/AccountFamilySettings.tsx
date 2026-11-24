import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { AccountState, FamilyChild, FamilyIdentity, FamilyOverview } from '@shared/account'
import { Icon } from '@renderer/ui/icons'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { SettingsDisclosure, SettingsGroup } from '../settings/SettingsGroup'
import { ManagedChildLoginDialog } from './ChildPasswordForms'
import { accountErrorMessage } from './account-errors'

type SensitiveTask = (label: string, task: () => Promise<AccountState | null>) => void
interface Props {
  scope: FamilyIdentity
  blocked: boolean
  canReturn: boolean
  passwordAvailable: boolean
  onSensitive: SensitiveTask
}

/** Remount for every service, user, tenant or session change; no family data is cached on disk. */
export function AccountFamilySettings({ scope, blocked, canReturn, passwordAvailable, onSensitive }: Props): JSX.Element {
  const [family, setFamily] = useState<FamilyOverview | null>(null), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false), [name, setName] = useState('')
  const [loginFor, setLoginFor] = useState<FamilyChild | null>(null)
  const sequence = useRef(0), alive = useRef(true), readOnce = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current } }, [])
  const refresh = async (): Promise<void> => {
    const revision = ++sequence.current
    readOnce.current = true; setLoading(true); setError('')
    try {
      const next = await window.aether.account.family(scope)
      if (alive.current && revision === sequence.current) setFamily(next)
    } catch (cause) {
      if (alive.current && revision === sequence.current) { setFamily(null); setError(accountErrorMessage(cause)) }
    } finally { if (alive.current && revision === sequence.current) setLoading(false) }
  }
  const run = (label: string, work: () => Promise<AccountState | null>): void => {
    setError(''); setNotice('')
    onSensitive(label, async () => {
      if (!alive.current) return null
      try { return await work() }
      catch (cause) { if (alive.current) setError(accountErrorMessage(cause)); throw cause }
    })
  }
  const create = (event: FormEvent): void => {
    event.preventDefault()
    const label = name.trim()
    if (blocked || loading || !label || !family || family.used >= family.limit) return
    run('create', async () => {
      await window.aether.account.createChild(scope, label)
      if (alive.current) { setCreating(false); setName(''); setNotice('子账号已创建。'); await refresh() }
      return null
    })
  }
  const changeStatus = async (child: FamilyChild): Promise<void> => {
    const enable = child.status === 'disabled'
    if (!enable && !await confirmDialog({ title: '停用子账号', body: `「${child.name}」将无法继续登录。账号数据会保留，仍占用一个名额。`, confirmText: '停用', danger: true })) return
    if (!alive.current) return
    run('status', async () => {
      await window.aether.account.setChildStatus(scope, child.id, enable)
      if (alive.current) { setNotice(enable ? '子账号已启用。' : '子账号已停用。'); await refresh() }
      return null
    })
  }
  const enter = async (child: FamilyChild): Promise<void> => {
    if (!canReturn || child.status !== 'active') return
    if (!await confirmDialog({ title: '在此设备使用子账号', body: `此设备将切换到「${child.name}」。之后要使用主账号，需要重新登录。请将主账号的恢复文件或第三方登录凭证保管在自己手中。`, confirmText: '切换到子账号' }) || !alive.current) return
    run('enter', () => window.aether.account.enterChild(scope, child.id))
  }
  const full = !!family && family.used >= family.limit
  return <SettingsGroup title="子账号" ariaLabel="子账号管理" className="account-preferences">
    <SettingsDisclosure layout="row" title="管理子账号" description={family ? `已使用 ${family.used} / ${family.limit} 个名额` : '创建和管理独立账号空间'} onOpenChange={opened => { if (opened && !readOnce.current) void refresh() }}>
      <div className="account-family-toolbar"><span role="status">{loading ? '正在读取子账号…' : family ? `已使用 ${family.used} / ${family.limit} 个名额` : '子账号名额'}</span>
        <button type="button" className="btn account-icon-button" aria-label="刷新子账号" title="刷新子账号" disabled={blocked || loading} onClick={() => void refresh()}><Icon name="restart" size={15}/></button>
      </div>
      {error ? <p className="account-message account-message--error" role="alert">{error}</p> : null}
      {notice ? <p className="account-message account-message--success" role="status">{notice}</p> : null}
      {family?.children.map(child => <SettingsDisclosure key={child.id} className="account-family-member" layout="row" title={child.name} description={child.status === 'active' ? '可用' : '已停用'}>
        <div className="account-row-actions">
          {passwordAvailable && child.status === 'active' ? <button type="button" className="btn" disabled={blocked || loading} onClick={() => run('manage-login', async () => { setLoginFor(child); return null })}>设置登录</button> : null}
          {child.status === 'active' ? <button type="button" className="btn" disabled={blocked || loading || !canReturn} onClick={() => void enter(child)}>在此设备使用</button> : null}
          <button type="button" className="btn" disabled={blocked || loading} onClick={() => void changeStatus(child)}>{child.status === 'active' ? '停用' : '重新启用'}</button>
        </div>
        {child.status === 'active' && !canReturn ? <p className="account-context">先保存主账号恢复文件，或绑定可用的第三方账号，即可在此设备使用子账号。</p> : null}
      </SettingsDisclosure>)}
      {family && !family.used && !full ? <p className="account-context">还没有子账号。每个子账号都有独立的会话和账号数据。</p> : null}
      {full ? <p className="account-context">名额已用完，可联系服务管理员调整配额。停用的子账号仍占名额。</p> : null}
      {family && !full && (creating ? <form className="account-profile-form account-family-create" onSubmit={create}>
        <label className="account-field"><span>子账号名称</span><input className="field__input" autoFocus required maxLength={80} value={name} disabled={blocked} onChange={event => setName(event.target.value)} /></label>
        <div className="account-row-actions"><button type="submit" className="btn btn--primary" disabled={blocked || loading || !name.trim()}>创建子账号</button><button type="button" className="btn" disabled={blocked} onClick={() => { setCreating(false); setName('') }}>取消</button></div>
      </form> : <button type="button" className="btn account-family-add" disabled={blocked || loading} onClick={() => { setCreating(true); setNotice(''); setError('') }}>添加子账号</button>)}
    </SettingsDisclosure>
    {loginFor ? <ManagedChildLoginDialog key={loginFor.id} scope={scope} childId={loginFor.id} name={loginFor.name} blocked={blocked} onSensitiveSave={save => onSensitive('save-login', async () => { await save(); return null })} onClose={() => setLoginFor(null)} onSaved={() => { setLoginFor(null); setNotice('子账号的登录设置已保存。') }}/>: null}
  </SettingsGroup>
}
