import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { EngineMode } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'
import { SettingsContent, SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'

/**
 * 引擎设置
 *
 * 只管理「引擎怎么跑」。模型、密钥、MCP 等业务配置属于引擎自己的设置域，
 * 后续通过引擎的 /settings 与 /models 路由在专门的界面里做，不混在这里。
 */
export function EngineSettingsView(): JSX.Element {
  const { engine, settings, updateSettings } = useApp()
  const { snapshot } = engine

  const [mode, setMode] = useState<EngineMode>(settings.engineMode)
  const [port, setPort] = useState(String(settings.preferredPort))
  const [remoteUrl, setRemoteUrl] = useState(settings.remoteBaseUrl)
  const [remoteWorkspaceRoot, setRemoteWorkspaceRoot] = useState(settings.remoteWorkspaceRoot)
  const [remoteToken, setRemoteToken] = useState('')
  const [remoteTokenConfigured, setRemoteTokenConfigured] = useState(false)
  const [remoteTokenSource, setRemoteTokenSource] = useState<'stored' | 'environment' | 'none'>('none')
  const [clearRemoteToken, setClearRemoteToken] = useState(false)
  const [autoStart, setAutoStart] = useState(settings.autoStartEngine)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [tokenStatusError, setTokenStatusError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aether.settings.remoteTokenStatus().then((status) => {
      if (alive) {
        setRemoteTokenConfigured(status.configured)
        setRemoteTokenSource(status.source)
      }
    }).catch((error: unknown) => {
      if (alive) setTokenStatusError(error instanceof Error ? error.message : String(error))
    })
    return () => { alive = false }
  }, [])

  // 设置从主进程异步加载完成后同步到表单：渲染期间调和（React 官方模式，
  // 「存上一份引用、发现变化就地更新」），避免 effect 级联渲染
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (syncedSettings !== settings) {
    setSyncedSettings(settings)
    setMode(settings.engineMode)
    setPort(String(settings.preferredPort))
    setRemoteUrl(settings.remoteBaseUrl)
    setRemoteWorkspaceRoot(settings.remoteWorkspaceRoot)
    setAutoStart(settings.autoStartEngine)
  }

  const dirty =
    mode !== settings.engineMode ||
    port !== String(settings.preferredPort) ||
    remoteUrl !== settings.remoteBaseUrl ||
    remoteWorkspaceRoot !== settings.remoteWorkspaceRoot ||
    remoteToken.trim().length > 0 ||
    clearRemoteToken ||
    autoStart !== settings.autoStartEngine

  const busy =
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'

  const save = async (restart: boolean): Promise<void> => {
    if (saving) return
    const parsedPort = Number(port)
    setSaveError('')
    setSaved(false)
    setSaving(true)
    try {
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw new Error('端口必须是 1–65535 的整数')
      const tokenMutation = clearRemoteToken ? '' : remoteToken.trim() || undefined
      await updateSettings({
        engineMode: mode,
        preferredPort: parsedPort,
        remoteBaseUrl: remoteUrl.trim(),
        remoteWorkspaceRoot: remoteWorkspaceRoot.trim(),
        autoStartEngine: autoStart
      }, tokenMutation)
      if (tokenMutation !== undefined) {
        const status = await window.aether.settings.remoteTokenStatus()
        setRemoteTokenConfigured(status.configured)
        setRemoteTokenSource(status.source)
        setTokenStatusError('')
      }
      setRemoteToken('')
      setClearRemoteToken(false)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
      if (restart) await engine.restart()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-view settings-view--engine">
      <SettingsGroup title="运行方式">
        <SettingsRow
          label="本地内置"
          description="随应用启动引擎进程，数据存放在本机"
          onClick={() => setMode('embedded')}
        >
          <span
            className={`sg-radio${mode === 'embedded' ? ' is-on' : ''}`}
            role="radio"
            aria-checked={mode === 'embedded'}
          />
        </SettingsRow>
        <SettingsRow
          label="远端服务"
          description="连接远端引擎，发送任务并查看会话、改动和运行状态"
          onClick={() => setMode('remote')}
        >
          <span
            className={`sg-radio${mode === 'remote' ? ' is-on' : ''}`}
            role="radio"
            aria-checked={mode === 'remote'}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={mode === 'embedded' ? '端口' : '远端地址'}>
        {mode === 'embedded' ? (
          <SettingsRow label="首选端口" description="端口被占用时自动向后探测可用端口">
            <input
              className="field__input sg__input"
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </SettingsRow>
        ) : (
          <>
            <SettingsRow label="远端地址" description="本机独立开发服务可填 http://127.0.0.1:12323；其他地址请在下方填写连接令牌。更换服务地址时，请同时替换或清除已保存的令牌。">
              <input
                className="field__input sg__input sg__input--wide"
                type="text"
                placeholder="http://192.168.1.10:12323"
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              label="远端工作目录"
              description="可选，填写远端机器上的绝对目录；保存并重启后对新会话生效，已有会话保留服务端目录。留空使用服务端沙箱。此设置不会打开或映射本机文件。"
            >
              <input
                className="field__input sg__input sg__input--wide"
                type="text"
                aria-label="远端工作目录"
                placeholder="留空使用服务端沙箱"
                value={remoteWorkspaceRoot}
                disabled={saving}
                onChange={(event) => setRemoteWorkspaceRoot(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              label="远端令牌"
              description="与目标引擎的 AETHER_INSTANCE_TOKEN 一致；通过系统密钥存储加密保存，留空保留原值。修改后点击“保存并重启”。清除已保存的令牌后，若启动环境变量仍存在，将继续使用该变量。"
            >
              <div className="settings-view__token-field">
                <input
                  className="field__input sg__input sg__input--wide"
                  type="password"
                  autoComplete="new-password"
                  aria-label="远端令牌"
                  maxLength={4096}
                  disabled={saving}
                  placeholder={clearRemoteToken ? '保存后清除已存令牌' : tokenStatusError ? '读取失败，可重新输入或清除' : remoteTokenConfigured ? (remoteTokenSource === 'environment' ? '由启动环境变量提供，重新输入可迁移保存' : '已配置（重新输入可替换）') : '输入远端引擎令牌'}
                  value={remoteToken}
                  onChange={(event) => {
                    setRemoteToken(event.target.value)
                    setClearRemoteToken(false)
                  }}
                />
              {remoteTokenSource === 'stored' || tokenStatusError ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={saving || clearRemoteToken}
                    onClick={() => {
                      setRemoteToken('')
                      setClearRemoteToken(true)
                    }}
                  >
                    清除令牌
                  </button>
                ) : null}
              </div>
            </SettingsRow>
            {tokenStatusError ? <SettingsContent><div className="settings-view__error" role="alert">{tokenStatusError}</div></SettingsContent> : null}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="启动">
        <SettingsRow label="启动应用时自动连接引擎">
          <Toggle checked={autoStart} onChange={setAutoStart} label="启动应用时自动连接引擎" />
        </SettingsRow>
      </SettingsGroup>

      <div className="settings-view__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || saving}
          onClick={() => void save(false)}
        >
          保存
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy || saving}
          title="保存设置并重启引擎使其生效"
          onClick={() => void save(true)}
        >
          保存并重启
        </button>
        {saved ? <span className="settings-view__saved">已保存</span> : null}
        {saveError ? <span className="settings-view__error">{saveError}</span> : null}
      </div>

      <SettingsGroup title="当前状态">
        <SettingsContent>
          <dl className="kv">
            <dt>阶段</dt>
            <dd>{snapshot.phase}</dd>
            <dt>来源</dt>
            <dd>
              {snapshot.adopted
                ? '复用已有引擎（不由本应用启动）'
                : snapshot.mode === 'remote'
                  ? '远端服务'
                  : '本应用启动'}
            </dd>
            {snapshot.pid ? (
              <>
                <dt>进程</dt>
                <dd>pid {snapshot.pid}</dd>
              </>
            ) : null}
            <dt>地址</dt>
            <dd>{snapshot.baseUrl || '—'}</dd>
            {snapshot.version ? (
              <>
                <dt>版本</dt>
                <dd>{snapshot.version}</dd>
              </>
            ) : null}
            {snapshot.entryPath ? (
              <>
                <dt>入口</dt>
                <dd className="kv__mono" title={snapshot.entryPath}>
                  {snapshot.entryPath}
                </dd>
              </>
            ) : null}
            {snapshot.dataDir ? (
              <>
                <dt>数据</dt>
                <dd className="kv__mono" title={snapshot.dataDir}>
                  {snapshot.dataDir}
                </dd>
              </>
            ) : null}
          </dl>
        </SettingsContent>
        {snapshot.error ? <SettingsContent><div className="settings-view__error" role="alert">{snapshot.error}</div></SettingsContent> : null}
      </SettingsGroup>

      <div className="settings-view__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void engine.start()}>
          <Icon name="play" size={16} />
          启动
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || snapshot.phase === 'idle'}
          onClick={() => void engine.stop()}
        >
          <Icon name="stop" size={16} />
          停止
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void engine.restart()}>
          <Icon name="restart" size={16} />
          重启
        </button>
      </div>
    </div>
  )
}
