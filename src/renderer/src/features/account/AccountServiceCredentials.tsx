import { useEffect, useRef, useState, type JSX } from 'react'
import type { AccountState, ServiceCredentialContext } from '@shared/account'
import type { EngineSnapshot, RemoteAuthCredential } from '@shared/ipc'
import { remoteServiceUrl, sameRemoteService } from '@shared/remote-service-url'
import { useApp } from '@renderer/core/app-context'
import { Select } from '@renderer/ui/Select'
import { CredentialInput } from '../settings/CredentialInput'
import { SettingsDisclosure, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'
import { accountErrorMessage } from './account-errors'

type SaveCredential = (service: string, revision: number, value: RemoteAuthCredential | null) => Promise<EngineSnapshot>
const methods = [{ value: 'api-key', label: 'API Key' }, { value: 'bearer', label: 'JWT（Bearer）' }]
const labelOf = (type: RemoteAuthCredential['type']): string => type === 'bearer' ? 'JWT' : 'API Key'

/** The live service wins; when authentication blocks startup, use the selected (saved) service. */
export function AccountServiceCredentials({ account, blocked, saving, onSave }: {
  account: AccountState; blocked: boolean; saving: boolean; onSave: SaveCredential
}): JSX.Element | null {
  const { engine: { snapshot }, userSettings, settingsLoaded } = useApp()
  const live = snapshot.phase === 'ready'
  const remote = live ? snapshot.mode === 'remote' : settingsLoaded && userSettings.engineMode === 'remote'
  if (!remote) return null
  let service: string
  try { service = remoteServiceUrl(live ? snapshot.baseUrl : userSettings.remoteBaseUrl) } catch { return null }
  const matched = account.connectionMode === 'remote' && sameRemoteService(service, account.serviceUrl)
  const personal = matched && (!!account.user || account.status === 'authenticated')
  return <ServiceDisclosure key={service} service={service} personal={personal} identity={personal ? JSON.stringify([account.user?.tenantId, account.user?.id]) : ''}
    blocked={blocked || !matched || snapshot.checkingConnection === true || snapshot.phase === 'starting' || snapshot.phase === 'stopping'}
    untrusted={matched && account.transport === 'http-untrusted'} saving={saving} onSave={onSave} />
}

interface EditorProps {
  service: string; personal: boolean; blocked: boolean; saving: boolean; untrusted: boolean; onSave: SaveCredential
}
function ServiceDisclosure({ identity, ...props }: EditorProps & { identity: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <SettingsGroup title="高级认证">
    <div onToggle={event => { if (event.target instanceof HTMLDetailsElement) setOpen(event.target.open) }}>
      <SettingsDisclosure title="服务访问凭据" description={props.personal ? '当前使用个人账号。' : '使用管理员提供的 API Key 或 JWT 访问当前服务。'}>
        {open ? <CredentialEditor key={identity} {...props} /> : null}
      </SettingsDisclosure>
    </div>
  </SettingsGroup>
}

function CredentialEditor({ service, personal, blocked, saving, untrusted, onSave }: EditorProps): JSX.Element {
  const [context, setContext] = useState<ServiceCredentialContext | null | undefined>(undefined)
  const metadata = context?.status
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState<{ type?: RemoteAuthCredential['type']; value?: string; generated?: boolean }>({})
  const [feedback, setFeedback] = useState<{ error?: boolean; message: string } | null>(null)
  const active = useRef(false), submitting = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    void window.aether.account.getServiceCredentialContext(service).then(
      state => { if (current) setContext(state) }, () => { if (current) setContext(null) })
    return () => { current = false }
  }, [service, revision])
  const accountInUse = personal || metadata?.effective === 'account'
  const type = draft.type ?? metadata?.type ?? 'api-key'
  const typeLabel = labelOf(type), readError = metadata === null
  const disabled = blocked || !context || accountInUse
  const canApply = !disabled && draft.value !== undefined && (!untrusted || draft.value === '')
  const stored = metadata?.type && metadata.configured
    ? `${metadata.source === 'environment' ? '启动配置已提供' : '已保存'} ${labelOf(metadata.type)}` : ''
  const description = context === null ? '无法读取当前服务的账号状态，请收起后重新展开。' : accountInUse ? '当前使用个人账号。如需改用服务凭据，请先退出账号。'
    : metadata?.effective === 'signed-out' ? '已退出个人账号。要改用服务凭据，请重新输入并应用。'
      : untrusted ? '请先在上方确认信任此内网服务。' : '此凭据仅用于当前服务。模型供应商的密钥请在「模型」中设置。'
  // A new personal identity, service, or closed disclosure unmounts this editor and discards its draft.
  const submit = async (): Promise<void> => {
    if (submitting.current || !canApply || !context || draft.value === undefined) return
    const clearing = draft.value === '', value = clearing ? null : { type, value: draft.value.trim() }
    if (value && !value.value) return
    submitting.current = true; setFeedback(null)
    try {
      const result = await onSave(service, context.revision, value)
      if (!active.current) return
      setDraft({}); setContext(undefined); setRevision(current => current + 1)
      if (clearing && result.connectionIssue === 'authentication-required') {
        setFeedback({ message: '已移除本机凭据。此服务需要重新登录或提供凭据。' })
      } else if (clearing && result.connectionIssue === 'http-trust-required') {
        setFeedback({ message: '已移除本机凭据。重新连接前，请先在上方确认信任此内网服务。' })
      } else if (result.phase === 'error') {
        setFeedback({ error: true, message: result.error || '服务连接未就绪，请检查连接状态。' })
      } else {
        setFeedback({ message: clearing ? '已移除本机保存的凭据。' : '已应用服务访问凭据。' })
      }
    } catch (error) { if (active.current) setFeedback({ error: true, message: accountErrorMessage(error, '无法应用服务访问凭据，请重试。') }) }
    finally { submitting.current = false }
  }
  return <>
    <SettingsRow label="用户凭据" description={description}>
      <div className="engine-credential__auth" aria-busy={context === undefined || saving}>
        <Select value={type} options={methods} ariaLabel="远端认证方式" width={150} disabled={disabled}
          onChange={next => { if ((next === 'api-key' || next === 'bearer') && next !== type) { setDraft({ type: next }); setFeedback(null) } }} />
        <CredentialInput key={`${type}:${accountInUse}:${revision}`} kind={type} value={draft.value} generated={draft.generated}
          personalAccount={accountInUse} disabled={disabled} readError={readError} canRemove={!accountInUse && (metadata?.source === 'stored' || readError)}
          placeholder={accountInUse ? '已使用个人账号' : draft.value === '' ? '应用后移除' : stored ? `${stored}，留空保留` : `输入 ${typeLabel}`}
          edit={(value, generated) => { setDraft({ type, value, generated }); setFeedback(null) }} />
        {!accountInUse && !draft.generated ? <span className="engine-credential__hint">{type === 'bearer' ? 'JWT 由服务端签发，不能在此生成。' : 'API Key 须由服务管理员登记。'}</span> : null}
      </div>
    </SettingsRow>
    {!accountInUse ? <div className="account-service-credential-actions"><button type="button" className="btn" disabled={!canApply} onClick={() => void submit()}>{saving ? '正在应用…' : '应用凭据'}</button></div> : null}
    {feedback ? <p className={`account-message account-message--${feedback.error ? 'error' : 'success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p> : null}
  </>
}
