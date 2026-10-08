import { useId, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { openAppSettings } from '../settings/app-settings-navigation'
import { ACCOUNT_STATUS_LABELS, useAccount } from './account-store'
import { AccountAvatar } from './AccountAvatar'
import './account.css'

export function AccountMenu(): JSX.Element {
  const { account, loading } = useAccount()
  const button = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const tooltipId = useId()
  const user = account.user
  const show = (): void => { setAnchor(button.current?.getBoundingClientRect() ?? null) }
  return <>
    <button ref={button} type="button" className="menu-bar__action account-menu__trigger"
      aria-label={user ? '个人账号' : '登录账号'} aria-describedby={anchor ? tooltipId : undefined}
      onMouseEnter={show} onMouseLeave={() => setAnchor(null)} onFocus={show} onBlur={() => setAnchor(null)}
      onKeyDown={(event) => { if (event.key === 'Escape') setAnchor(null) }}
      onClick={() => { setAnchor(null); openAppSettings('account') }}>
      <AccountAvatar name={user?.name} avatarUrl={user?.avatarUrl} />
      {!user ? <span>登录</span> : null}
      {user && account.status !== 'authenticated' ? <span className="account-menu__status-dot" /> : null}
    </button>
    {anchor ? createPortal(<div id={tooltipId} role="tooltip" className="account-hover material"
      style={{ top: anchor.bottom + 8, right: Math.max(12, window.innerWidth - anchor.right) }}>
      <div className="account-hover__identity"><AccountAvatar name={user?.name} avatarUrl={user?.avatarUrl} large />
        <div><strong>{user?.name || '个人账号'}</strong><span>{loading ? '正在读取…' : ACCOUNT_STATUS_LABELS[account.status]}</span></div>
      </div>
      {user?.email ? <p>{user.email}</p> : null}
      {user?.bio ? <p className="account-hover__bio">{user.bio}</p> : null}
      <span className="account-hover__hint">{user ? '点击查看和编辑个人资料' : '点击登录或恢复已有账号'}</span>
    </div>, document.body) : null}
  </>
}
