import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { sameRemoteService } from '@shared/remote-service-url'
import { accountConnectionIssue, connectionLabel, runtimeSourceLabel } from '@renderer/core/engine/connection-status'
import { Spinner } from '@renderer/ui/ui-primitives'
import { accountErrorMessage } from '../account/account-errors'
import { refreshAccount } from '../account/account-store'
import { openAppSettings } from './app-settings-navigation'
import { EngineCredentialFields, type SecretDraft } from './EngineCredentialFields'
import { EngineLocalRuntimeSettings } from './EngineLocalRuntimeSettings'
import { connectionEditor, useConnectionEditor } from './engine-connection-editor'
import { SettingsContent, SettingsDisclosure, SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
import './engine-settings.css'
import './settings-pages.css'

const sameAddress = (left: string, right: string): boolean => left.trim() === right.trim() || sameRemoteService(left, right)

export function EngineSettingsView(): JSX.Element {
  const { engine, userSettings: settings, settingsLoaded, refreshSettings, updateSettings } = useApp()
  const { snapshot } = engine
  const { draft, operation, error } = useConnectionEditor()
  const mode = draft.mode ?? settings.engineMode, port = draft.port ?? String(settings.preferredPort)
  const address = draft.address ?? settings.remoteBaseUrl, autoStart = draft.autoStart ?? settings.autoStartEngine
  const [secretInput, setSecretInput] = useState<SecretDraft | null>(null)
  const secrets: SecretDraft = mode === 'remote' && secretInput?.address === address ? secretInput : { address }
  const [advancedChoice, setAdvanced] = useState<boolean>(), [runtimeBusy, setRuntimeBusy] = useState(false)
  const advanced = advancedChoice ?? (mode === 'embedded' && snapshot.mode === 'embedded' && snapshot.phase === 'error')
  const [versionPending, setVersionPending] = useState(false)
  const [openingAdmin, setOpeningAdmin] = useState(false), [adminError, setAdminError] = useState('')
  useEffect(() => { setAdminError('') }, [snapshot.instanceId, snapshot.baseUrl])
  const openAdmin = async (): Promise<void> => {
    if (openingAdmin) return
    setOpeningAdmin(true); setAdminError('')
    try { const result = await window.aether.engine.openAdmin(); if (!result.ok && mounted.current) setAdminError(result.message || '无法打开管理后台。') }
    catch { if (mounted.current) setAdminError('无法打开管理后台。请重新启动桌面以加载新版引擎。') }
    finally { if (mounted.current) setOpeningAdmin(false) }
  }
  const [credentialRevision, setCredentialRevision] = useState(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const configChanged = mode !== settings.engineMode || (mode === 'remote'
    ? !sameAddress(address, settings.remoteBaseUrl) || secrets.instanceToken !== undefined || secrets.authValue !== undefined
    : Number(port) !== settings.preferredPort)
  const onlyStartupChanged = !configChanged && autoStart !== settings.autoStartEngine
  const dirty = configChanged || onlyStartupChanged
  const matchesLive = snapshot.mode === mode && (mode !== 'remote' || sameAddress(address, snapshot.baseUrl))
  const switching = configChanged || (snapshot.phase === 'ready' && !matchesLive)
  const closing = operation === 'stop' || snapshot.phase === 'stopping'
  const savingPreference = operation === 'apply' && onlyStartupChanged && !snapshot.checkingConnection
  const checking = (operation === 'apply' && !savingPreference) || snapshot.checkingConnection === true
  const connecting = checking || operation === 'restart' || snapshot.phase === 'starting' || snapshot.phase === 'installing'
  const busy = connecting || closing || savingPreference || runtimeBusy || !settingsLoaded
  const accountNeeded = !switching && mode === 'remote' && snapshot.mode === 'remote' && accountConnectionIssue(snapshot)
  const disconnect = !dirty && !switching && snapshot.phase === 'ready'
  const checkAccountFirst = !accountNeeded && (configChanged || !matchesLive || snapshot.phase !== 'ready')
  const isExternal = snapshot.mode === 'remote' || snapshot.adopted
  const currentTarget = snapshot.baseUrl || (snapshot.phase !== 'idle' && snapshot.mode === 'remote' && settings.engineMode === 'remote' ? settings.remoteBaseUrl : '')
  const action = connecting ? 'cancel' : accountNeeded && !dirty ? 'account' : disconnect ? 'stop' : 'apply'
  const chooseVersionFirst = mode === 'embedded' && versionPending && !onlyStartupChanged && action === 'apply'
  const buttonText = savingPreference ? '正在保存…' : closing ? (isExternal ? '正在断开…' : '正在停止…') : action === 'cancel' ? '取消连接'
    : action === 'account' ? snapshot.connectionIssue === 'http-trust-required' ? '确认内网连接' : '前往登录'
    : action === 'stop' ? isExternal ? '断开连接' : '停止引擎'
    : chooseVersionFirst && !advanced ? '选用本机版本…' : onlyStartupChanged ? '应用设置' : switching ? (mode === 'embedded' ? '应用并启动' : '应用并连接')
    : mode === 'remote' ? '连接引擎' : '启动引擎'
  const changeSecrets = (patch: Partial<Omit<SecretDraft, 'address'>>): void => {
    setSecretInput(old => ({ ...(old?.address === address ? old : { address }), ...patch }))
    if (error) connectionEditor.edit({})
  }
  const goToAccount = (): void => {
    // A target change also invalidates any stale account read already in flight.
    void refreshAccount()
    openAppSettings('account')
  }
  const apply = async (accountAfter = false): Promise<void> => {
    if (busy) return
    if (chooseVersionFirst) { setAdvanced(true); return }
    if (accountAfter && !dirty && !checkAccountFirst) { goToAccount(); return }
    const id = connectionEditor.begin('apply')
    if (id === null) return
    try {
      if (onlyStartupChanged) {
        await updateSettings({ autoStartEngine: autoStart })
        if (!connectionEditor.current(id)) return
        connectionEditor.clearDraft()
        if (!accountAfter || !checkAccountFirst) {
          connectionEditor.finish(id)
          if (accountAfter && mounted.current) goToAccount()
          return
        }
        // The preference is saved. Managing an offline account still needs an explicit connection.
      }
      const parsed = mode === 'embedded' ? Number(port) : settings.preferredPort
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('端口必须是 1 至 65535 的整数。')
      if (mode === 'remote' && !address.trim()) throw new Error('请输入服务地址，例如 https://aether.example.com。')
      const result = await window.aether.engine.applyConnection({ engineMode: mode, preferredPort: parsed,
        remoteBaseUrl: mode === 'remote' ? address.trim() : settings.remoteBaseUrl,
        autoStartEngine: autoStart,
        ...(secrets.instanceToken !== undefined ? { instanceToken: secrets.instanceToken.trim() } : {}),
        ...(secrets.authValue !== undefined ? { userCredential: secrets.authValue.trim() ? { type: secrets.authType ?? 'api-key', value: secrets.authValue.trim() } : null } : {}) })
      if (!connectionEditor.current(id)) return
      await refreshSettings()
      if (!connectionEditor.current(id)) return
      if (result.phase === 'error' && !accountConnectionIssue(result)) throw new Error(result.error || '引擎未就绪，请检查连接设置。')
      connectionEditor.clearDraft()
      if (mounted.current) {
        setSecretInput(null); setCredentialRevision(value => value + 1)
        if (accountAfter && (result.phase === 'ready' || accountConnectionIssue(result))) goToAccount()
      }
      connectionEditor.finish(id)
    } catch (cause) {
      if (!connectionEditor.current(id)) return
      if (mounted.current && mode === 'embedded' && !onlyStartupChanged) setAdvanced(true)
      connectionEditor.finish(id, accountErrorMessage(cause, onlyStartupChanged && !accountAfter ? '无法保存启动偏好，请重试。' : '无法应用连接设置，请重试。'))
    }
  }
  const lifecycle = async (kind: 'stop' | 'restart'): Promise<void> => {
    const id = connectionEditor.begin(kind)
    if (id === null) return
    try {
      const next = kind === 'stop' ? await window.aether.engine.stop() : await window.aether.engine.restart()
      if (next.phase === 'error' && !accountConnectionIssue(next)) throw new Error(next.error || '操作未完成，请重试。')
      await refreshSettings()
      connectionEditor.finish(id)
    } catch (cause) { connectionEditor.finish(id, accountErrorMessage(cause)) }
  }
  return <div className="settings-view settings-view--engine">
    <SettingsGroup title="当前连接" ariaLabel="当前引擎连接">
      <SettingsContent className="engine-status__content">
        <div className="engine-status__hero" aria-live="polite">
          <span className={`engine-status__dot is-${snapshot.phase}`} aria-hidden="true" />
          <div className="engine-status__hero-copy"><strong>{snapshot.phase === 'ready' ? '已连接' : connectionLabel(snapshot)}</strong>
            <span title={currentTarget || undefined}>{snapshot.phase === 'idle' ? '当前没有活动连接' : `${snapshot.mode === 'embedded' ? '本机引擎' : '其他引擎'}${currentTarget ? ` · ${currentTarget}` : ''}`}</span>
          </div>
        </div>
        {snapshot.phase === 'error' && (accountConnectionIssue(snapshot)
          ? <p className="engine-connection__note">{snapshot.connectionIssue === 'http-trust-required' ? '此服务使用 HTTP。请在「个人账号」确认是否信任这个地址。' : '已找到这个服务，需要登录后才能开始工作。'}</p>
          : snapshot.error && <p className="engine-connection__error" role="alert">{snapshot.error}</p>)}
        {snapshot.phase === 'ready' && <SettingsRow label="管理后台" description={isExternal ? '查看服务器状态，管理成员和权限。' : '桌面会连接本机实例，进入后使用管理员凭据登录。'}>
          <button className="btn" type="button" data-testid="engine-open-admin" disabled={openingAdmin || busy || dirty || switching} onClick={() => void openAdmin()}>{openingAdmin ? '正在打开…' : '打开管理后台'}</button>
        </SettingsRow>}
        {adminError && <p className="engine-connection__error" role="alert">{adminError}</p>}
        {snapshot.phase === 'ready' && <SettingsDisclosure title="连接详情"><dl className="kv engine-connection__kv">
          <dt>服务地址</dt><dd>{snapshot.baseUrl}</dd><dt>版本</dt><dd>{snapshot.version || '—'}</dd>
          <dt>运行时来源</dt><dd>{runtimeSourceLabel(snapshot)}</dd>
          {snapshot.mode === 'embedded' && <><dt>进程 PID</dt><dd>{snapshot.pid ?? '未提供'}</dd>
            {snapshot.entryPath && <><dt>引擎入口</dt><dd>{snapshot.entryPath}</dd></>}
            {snapshot.dataDir && <><dt>数据库文件</dt><dd>{snapshot.dataDir}</dd></>}
          </>}
        </dl><button type="button" className="btn" disabled={busy || dirty || switching} onClick={() => void lifecycle('restart')}>{isExternal ? '重新连接' : '重启引擎'}</button></SettingsDisclosure>}
      </SettingsContent>
    </SettingsGroup>
    <form data-testid="engine-connection-draft" aria-label="连接设置" noValidate onSubmit={event => { event.preventDefault(); if (action === 'apply' && !closing) void apply() }}>
      <SettingsGroup title="连接设置">
        <div role="radiogroup" aria-label="引擎来源" className="engine-connection__choices">
          {([{ value: 'embedded', label: '本机引擎（推荐）', hint: '由 Aether 在这台电脑上启动。' },
            { value: 'remote', label: '连接其他引擎', hint: '使用已有的服务地址，也可以是 localhost。' }] as const).map(option =>
            <label className="engine-connection__option" key={option.value}>
              <input type="radio" name="engine-source" aria-label={option.label} checked={mode === option.value} disabled={busy}
                onChange={() => { setSecretInput(null); connectionEditor.edit({ mode: option.value }) }} />
              <span><strong>{option.label}</strong><small>{option.hint}</small></span>
            </label>)}
        </div>
        {mode === 'remote' && <>
          <SettingsRow label="服务地址"><input className="field__input sg__input sg__input--wide" aria-label="服务地址" placeholder="https://aether.example.com"
            inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} value={address} disabled={busy}
            onChange={event => { setSecretInput(null); connectionEditor.edit({ address: event.target.value }) }} /></SettingsRow>
          {action !== 'account' && <SettingsRow label="个人账号" description={checkAccountFirst ? '会先连接上面填写的服务，再打开它的账号页面。' : undefined}>
            <button type="button" className="btn" aria-label="管理个人账号" disabled={busy} onClick={() => void apply(true)}>管理个人账号</button>
          </SettingsRow>}
        </>}
        <details className="sg__disclosure engine-connection__advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary className="sg__disclosure-summary"><span className="sg__disclosure-title">高级设置</span><span className="sg__disclosure-chevron" aria-hidden="true" /></summary>
          {(advanced || runtimeBusy || versionPending) && <div className="engine-connection__advanced-body">
            <SettingsRow label="启动应用时自动连接"><Toggle checked={autoStart} disabled={busy} onChange={value => connectionEditor.edit({ autoStart: value })} label="启动应用时自动连接引擎" /></SettingsRow>
            {mode === 'embedded' ? <>
              <SettingsRow label="首选端口" description="端口已被占用时，自动选择可用端口。"><input className="field__input sg__input sg__input--port" type="number" aria-label="首选端口" value={port} min={1} max={65535} disabled={busy} onChange={event => connectionEditor.edit({ port: event.target.value })} /></SettingsRow>
              <EngineLocalRuntimeSettings snapshot={snapshot} embeddedApplied={settings.engineMode === 'embedded'} locked={connecting || closing || savingPreference || !settingsLoaded} configChanged={configChanged} busy={runtimeBusy} setBusy={setRuntimeBusy} onPendingChange={setVersionPending} />
            </> : <EngineCredentialFields address={address} secrets={secrets} onChange={changeSecrets} disabled={busy} revision={credentialRevision} accountId={snapshot.accountId} />}
          </div>}
        </details>
      </SettingsGroup>
      <div className="engine-connection__actions engine-status__actions">
        {error && <p className="engine-connection__error" role="alert">{error}</p>}
        {checking && <span role="status" className="engine-connection__progress"><Spinner size={12} />正在检查连接…</span>}
        {chooseVersionFirst && advanced && <span className="engine-connection__hint" id="engine-version-choice">请先选用上方的本机版本。</span>}
        {disconnect && isExternal && !connecting && !closing && <span className="engine-connection__hint">断开只影响当前应用，服务仍会运行。</span>}
        <button data-testid="engine-connection-primary" type={action === 'apply' ? 'submit' : 'button'}
          className={`btn${action === 'account' || action === 'apply' ? ' btn--primary' : ''}`}
          aria-describedby={chooseVersionFirst && advanced ? 'engine-version-choice' : undefined}
          disabled={closing || savingPreference || runtimeBusy || !settingsLoaded || (chooseVersionFirst && advanced)}
          onClick={action === 'apply' ? undefined : () => { if (action === 'account') goToAccount(); else void lifecycle('stop') }}>{buttonText}</button>
      </div>
    </form>
  </div>
}
