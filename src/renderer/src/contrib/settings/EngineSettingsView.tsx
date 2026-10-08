import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { EngineMode, RemoteAuthCredential, RemoteAuthStatus } from '@shared/ipc'
import type { EngineImportProgress, EngineRuntimeCatalog } from '@shared/engine-import'
import { Icon } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { openAppSettings } from './app-settings-navigation'
import {
  SettingsContent,
  SettingsDisclosure,
  SettingsGroup,
  SettingsRow,
  Toggle
} from './SettingsGroup'
import './engine-settings.css'
import './settings-pages.css'

const ENGINE_PHASE_LABELS: Record<string, string> = {
  idle: '未启动',
  installing: '安装运行时',
  starting: '启动中',
  ready: '已就绪',
  stopping: '停止中',
  error: '错误'
}

const ENGINE_SOURCE_LABELS: Record<string, string> = {
  env: '环境变量指定',
  bundled: '应用内置',
  'dev-sibling': '开发目录引擎',
  imported: '已导入本地包'
}

const INITIAL_IMPORT_PROGRESS: EngineImportProgress = {
  phase: 'idle',
  files: 0,
  bytes: 0,
  message: ''
}

const EMPTY_REMOTE_AUTH: RemoteAuthStatus = { configured: false, type: null, source: 'none' }

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function shortBuildId(buildId: string): string {
  return buildId.length > 12 ? `${buildId.slice(0, 12)}…` : buildId
}

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
  const [remoteTokenSource, setRemoteTokenSource] = useState<'stored' | 'environment' | 'none'>(
    'none'
  )
  const [clearRemoteToken, setClearRemoteToken] = useState(false)
  const [remoteAuthStatus, setRemoteAuthStatus] = useState<RemoteAuthStatus>(EMPTY_REMOTE_AUTH)
  const [remoteAuthType, setRemoteAuthType] = useState<RemoteAuthCredential['type']>('api-key')
  const [remoteAuthValue, setRemoteAuthValue] = useState('')
  const [clearRemoteAuth, setClearRemoteAuth] = useState(false)
  const [authStatusLoading, setAuthStatusLoading] = useState(false)
  const [authStatusError, setAuthStatusError] = useState('')
  const [autoStart, setAutoStart] = useState(settings.autoStartEngine)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [tokenStatusError, setTokenStatusError] = useState('')
  const [saving, setSaving] = useState(false)
  const [runtimeCatalog, setRuntimeCatalog] = useState<EngineRuntimeCatalog | null>(null)
  const [selectedRuntimeId, setSelectedRuntimeId] = useState('')
  const [runtimeProgress, setRuntimeProgress] =
    useState<EngineImportProgress>(INITIAL_IMPORT_PROGRESS)
  const [runtimeError, setRuntimeError] = useState('')
  const [runtimeBusy, setRuntimeBusy] = useState<'import' | 'activate' | 'delete' | null>(null)

  const refreshRuntimeCatalog = async (selectId?: string): Promise<void> => {
    try {
      const catalog = await window.aether.engine.getLocalRuntimes()
      setRuntimeCatalog(catalog)
      setSelectedRuntimeId(selectId ?? catalog.activeId ?? '')
    } catch (error: unknown) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    let alive = true
    void window.aether.engine
      .getLocalRuntimes()
      .then((catalog) => {
        if (!alive) return
        setRuntimeCatalog(catalog)
        setSelectedRuntimeId(catalog.activeId ?? '')
      })
      .catch((error: unknown) => {
        if (alive) setRuntimeError(error instanceof Error ? error.message : String(error))
      })
    const offProgress = window.aether.engine.onImportProgress((progress) => {
      if (alive) setRuntimeProgress(progress)
    })
    return () => {
      alive = false
      offProgress()
    }
  }, [])

  useEffect(() => {
    let alive = true
    if (mode !== 'remote' || !remoteUrl.trim()) {
      setRemoteAuthStatus(EMPTY_REMOTE_AUTH)
      setAuthStatusLoading(false)
      setAuthStatusError('')
      return () => {
        alive = false
      }
    }
    setAuthStatusLoading(true)
    setAuthStatusError('')
    setRemoteAuthStatus(EMPTY_REMOTE_AUTH)
    // Status follows the destination; a delayed response from the previous server must not
    // display its credential as available on the newly entered address.
    const timer = window.setTimeout(() => {
      void window.aether.settings.remoteAuthStatus(remoteUrl.trim())
        .then((status) => {
          if (!alive) return
          setRemoteAuthStatus(status)
          setRemoteAuthType(status.type ?? 'api-key')
        })
        .catch((error: unknown) => {
          if (alive) setAuthStatusError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => { if (alive) setAuthStatusLoading(false) })
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [mode, remoteUrl])

  useEffect(() => {
    let alive = true
    void window.aether.settings
      .remoteTokenStatus()
      .then((status) => {
        if (alive) {
          setRemoteTokenConfigured(status.configured)
          setRemoteTokenSource(status.source)
        }
      })
      .catch((error: unknown) => {
        if (alive) setTokenStatusError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [])

  // 设置从主进程异步加载完成后同步到表单：渲染期间调和（React 官方模式，
  // 「存上一份引用、发现变化就地更新」），避免 effect 级联渲染
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (syncedSettings !== settings) {
    setSyncedSettings(settings)
    setMode(settings.engineMode)
    setPort(String(settings.preferredPort))
    setRemoteUrl(settings.remoteBaseUrl)
    if (settings.remoteBaseUrl !== syncedSettings.remoteBaseUrl) {
      setRemoteAuthValue('')
      setClearRemoteAuth(false)
    }
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
    remoteAuthValue.trim().length > 0 ||
    clearRemoteAuth ||
    autoStart !== settings.autoStartEngine

  // A remote outage is represented as `starting` while EngineHost performs
  // bounded-backoff reconnects. Keep Stop available so the user can cancel
  // that loop explicitly; ordinary startup remains busy/locked.
  const remoteReconnecting = snapshot.mode === 'remote' && snapshot.phase === 'starting' && snapshot.error?.includes('正在重新连接') === true
  const lifecycleBusy =
    (snapshot.phase === 'starting' && !remoteReconnecting) ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'
  const busy = lifecycleBusy || runtimeBusy !== null || saving
  const embeddedSaved = settings.engineMode === 'embedded' && mode === 'embedded'
  const canImportRuntime = embeddedSaved && runtimeBusy === null && !saving && !lifecycleBusy
  const canActivateRuntime = canImportRuntime && !dirty && !lifecycleBusy

  const importRuntime = async (): Promise<void> => {
    if (!canImportRuntime) return
    setRuntimeError('')
    setRuntimeBusy('import')
    setRuntimeProgress({
      ...INITIAL_IMPORT_PROGRESS,
      phase: 'extracting',
      message: '正在等待选择引擎包…'
    })
    try {
      const imported = await window.aether.engine.importLocalRuntime()
      if (!imported) {
        setRuntimeProgress(INITIAL_IMPORT_PROGRESS)
        return
      }
      await refreshRuntimeCatalog(imported.id)
      setRuntimeProgress((current) => ({
        ...current,
        phase: 'ready',
        message: `已导入 ${imported.name}`
      }))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setRuntimeError(message)
      setRuntimeProgress((current) => ({ ...current, phase: 'error', message }))
    } finally {
      setRuntimeBusy(null)
    }
  }

  const activateRuntime = async (id: string | null): Promise<void> => {
    if (!canActivateRuntime || id === (runtimeCatalog?.activeId ?? null)) return
    const confirmed = await confirmDialog({
      title: '切换本地引擎并重启？',
      body: '切换会中断当前任务，但会保留会话记录和模型配置。引擎重启完成后即可继续使用。',
      confirmText: id ? '使用此引擎并重启' : '恢复默认引擎并重启'
    })
    if (!confirmed || runtimeBusy !== null) return
    setRuntimeError('')
    setRuntimeBusy('activate')
    try {
      await window.aether.engine.activateLocalRuntime(id)
      await refreshRuntimeCatalog()
    } catch (error: unknown) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setRuntimeBusy(null)
    }
  }

  const deleteRuntime = async (): Promise<void> => {
    const runtime = selectedRuntime
    if (!runtime || !canDeleteRuntime) return
    const confirmed = await confirmDialog({
      title: '删除本地引擎？',
      body: `将删除“${runtime.name}”${runtime.version ? `（${runtime.version}）` : ''}的本地文件，之后需要重新导入才能使用。`,
      confirmText: '删除引擎',
      danger: true
    })
    if (!confirmed || runtimeBusy !== null) return
    setRuntimeError('')
    setRuntimeBusy('delete')
    try {
      await window.aether.engine.deleteLocalRuntime(runtime.id)
      await refreshRuntimeCatalog()
    } catch (error: unknown) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setRuntimeBusy(null)
    }
  }

  const save = async (restart: boolean): Promise<void> => {
    if (saving || runtimeBusy !== null) return
    const parsedPort = Number(port)
    setSaveError('')
    setSaved(false)
    setSaving(true)
    try {
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
        throw new Error('端口必须是 1–65535 的整数')
      const tokenMutation = clearRemoteToken ? '' : remoteToken.trim() || undefined
      const authMutation: RemoteAuthCredential | null | undefined = clearRemoteAuth
        ? null
        : remoteAuthValue.trim()
          ? { type: remoteAuthType, value: remoteAuthValue.trim() }
          : undefined
      await updateSettings(
        {
          engineMode: mode,
          preferredPort: parsedPort,
          remoteBaseUrl: remoteUrl.trim(),
          remoteWorkspaceRoot: remoteWorkspaceRoot.trim(),
          autoStartEngine: autoStart
        },
        tokenMutation,
        authMutation
      )
      if (tokenMutation !== undefined) {
        const status = await window.aether.settings.remoteTokenStatus()
        setRemoteTokenConfigured(status.configured)
        setRemoteTokenSource(status.source)
        setTokenStatusError('')
      }
      if (authMutation !== undefined) {
        const status = await window.aether.settings.remoteAuthStatus(remoteUrl.trim())
        setRemoteAuthStatus(status)
        setRemoteAuthType(status.type ?? 'api-key')
        setAuthStatusError('')
      }
      setRemoteToken('')
      setClearRemoteToken(false)
      setRemoteAuthValue('')
      setClearRemoteAuth(false)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
      if (restart) await engine.restart()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const activeRuntime =
    runtimeCatalog?.runtimes.find((runtime) => runtime.id === runtimeCatalog.activeId) ?? null
  const selectedRuntime =
    runtimeCatalog?.runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? null
  const canDeleteRuntime =
    embeddedSaved &&
    runtimeBusy === null &&
    !saving &&
    !lifecycleBusy &&
    selectedRuntime !== null &&
    selectedRuntime.id !== (runtimeCatalog?.activeId ?? null)
  const runtimeSource = snapshot.runtimeSource

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

      {mode === 'embedded' ? (
        <SettingsGroup
          title="本地引擎"
          footer="支持导入 .tgz 引擎包。导入过程不会停止当前任务；切换引擎需要重启。"
        >
          <SettingsContent className="engine-runtime__content">
            <div className="engine-runtime__import">
              <div className="engine-runtime__icon" aria-hidden="true">
                <Icon name="package-up" size={18} />
              </div>
              <div className="engine-runtime__import-copy">
                <strong>导入本地引擎包</strong>
                <span>选择已打包的 .tgz 文件，导入后可在下方选择使用。</span>
              </div>
              <button
                type="button"
                className={`btn${runtimeBusy === 'import' ? ' is-loading' : ''}`}
                disabled={!canImportRuntime}
                title={!embeddedSaved ? '请先保存“本地内置”运行方式' : undefined}
                onClick={() => void importRuntime()}
              >
                {runtimeBusy === 'import' ? '导入中…' : '导入引擎…'}
              </button>
            </div>
            {!embeddedSaved ? (
              <div className="engine-runtime__hint" role="status">
                请先选择“本地内置”并保存设置，再导入或切换本地引擎。
              </div>
            ) : null}
            {embeddedSaved && dirty ? (
              <div className="engine-runtime__hint" role="status">
                有未保存的设置，请先保存后再切换引擎。
              </div>
            ) : null}
            {runtimeProgress.phase !== 'idle' && runtimeProgress.phase !== 'error' ? (
              <div className={`engine-runtime__progress is-${runtimeProgress.phase}`} role="status">
                <span>
                  {runtimeProgress.message ||
                    (runtimeProgress.phase === 'ready' ? '引擎包已准备好' : '正在处理引擎包…')}
                </span>
                {runtimeProgress.phase !== 'ready' ? (
                  <small>
                    {runtimeProgress.files} 个文件 · {formatBytes(runtimeProgress.bytes)}
                  </small>
                ) : null}
              </div>
            ) : null}
            {runtimeError ? (
              <div className="settings-view__error engine-runtime__error" role="alert">
                {runtimeError}
              </div>
            ) : null}
          </SettingsContent>

          {runtimeCatalog && runtimeCatalog.runtimes.length > 0 ? (
            <SettingsContent className="engine-runtime__catalog">
              <div className="engine-runtime__catalog-head">
                <div>
                  <strong>已安装版本</strong>
                  <span>本机可用的引擎版本</span>
                </div>
                {activeRuntime ? <span className="engine-runtime__badge">正在运行</span> : null}
              </div>
              <div className="engine-runtime__selector">
                <div className="engine-runtime__selector-copy">
                  <span>运行版本</span>
                </div>
                <Select
                  value={selectedRuntimeId}
                  options={[
                    { value: '', label: '默认引擎', description: '使用应用随附的默认运行时' },
                    ...runtimeCatalog.runtimes.map((runtime) => ({
                      value: runtime.id,
                      label: `${runtime.version} · ${runtime.name}`,
                      description: `文件 ${runtime.fileName} · 构建 ${shortBuildId(runtime.buildId)}`
                    }))
                  ]}
                  onChange={setSelectedRuntimeId}
                  disabled={runtimeBusy !== null || saving}
                  ariaLabel="选择已导入的本地引擎"
                  title="选择已导入的本地引擎"
                  className="engine-runtime__select"
                  width={360}
                />
              </div>
              {selectedRuntime ? (
                <SettingsDisclosure
                  title="版本信息"
                  description={`${selectedRuntime.name} · ${selectedRuntime.version}`}
                  className="engine-runtime__details"
                >
                  <div className="engine-runtime__meta">
                    <span>名称 {selectedRuntime.name}</span>
                    <span>版本 {selectedRuntime.version}</span>
                    <span title={selectedRuntime.buildId}>
                      构建 {shortBuildId(selectedRuntime.buildId)}
                    </span>
                    <span title={selectedRuntime.fileName}>文件 {selectedRuntime.fileName}</span>
                    <span>导入于 {new Date(selectedRuntime.importedAt).toLocaleString()}</span>
                  </div>
                </SettingsDisclosure>
              ) : null}
              {/* 只有存在可执行操作时才渲染这一行。默认引擎下三个按钮都不出现，
                  空容器仍会吃掉自身高度，在「运行版本」和下方说明之间留下一段空隙 */}
              {runtimeCatalog.activeId !== null || selectedRuntimeId !== '' ? (
              <div className="engine-runtime__actions" aria-label="引擎版本操作">
                {selectedRuntimeId !== (runtimeCatalog.activeId ?? '') ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!canActivateRuntime}
                    title={dirty ? '请先保存设置' : undefined}
                    onClick={() => void activateRuntime(selectedRuntimeId || null)}
                  >
                    {runtimeBusy === 'activate' ? '重启中…' : '使用此引擎并重启'}
                  </button>
                ) : null}
                {runtimeCatalog.activeId !== null ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={!canActivateRuntime}
                    title={dirty ? '请先保存设置' : undefined}
                    onClick={() => void activateRuntime(null)}
                  >
                    恢复默认引擎
                  </button>
                ) : null}
                {selectedRuntime && selectedRuntime.id !== (runtimeCatalog.activeId ?? null) ? (
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    disabled={!canDeleteRuntime}
                    onClick={() => void deleteRuntime()}
                  >
                    {runtimeBusy === 'delete' ? '删除中…' : '删除此版本'}
                  </button>
                ) : null}
                {selectedRuntimeId === (runtimeCatalog.activeId ?? '') &&
                runtimeCatalog.activeId !== null ? (
                  <span className="engine-runtime__selection-note">此版本正在运行</span>
                ) : null}
              </div>
              ) : null}
            </SettingsContent>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={mode === 'embedded' ? '端口' : '远端地址'}>
        {mode === 'embedded' ? (
          <SettingsRow label="首选端口" description="端口被占用时自动向后探测可用端口">
            <input
              className="field__input sg__input sg__input--port"
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </SettingsRow>
        ) : (
          <>
            <SettingsRow
              label="远端地址"
              description="填写 HTTPS 服务地址后，可在个人账号中登录；本机可使用 HTTP。更换地址时，请同时替换或清除实例令牌。"
            >
              <input
                className="field__input sg__input sg__input--wide"
                type="text"
                placeholder="https://aether.example.com"
                value={remoteUrl}
                disabled={saving}
                aria-label="远端地址"
                onChange={(event) => {
                  setRemoteUrl(event.target.value)
                  // Draft credentials belong to the address at which they were entered.
                  setRemoteAuthValue('')
                  setClearRemoteAuth(false)
                }}
              />
            </SettingsRow>
            <SettingsRow
              label="远端工作目录"
              description="可选，填写远端机器上的绝对目录；保存并重新连接后对新会话生效，已有会话保留服务端目录。留空使用服务端沙箱。此设置不会打开或映射本机文件。"
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
              description="引擎实例的连接令牌，由服务管理员提供。加密保存，留空保留；清除后仍可使用启动环境中的令牌。账号登录在个人账号中管理。"
            >
              <div className="settings-view__token-field">
                <input
                  className="field__input sg__input sg__input--wide"
                  type="password"
                  autoComplete="new-password"
                  aria-label="远端令牌"
                  maxLength={4096}
                  disabled={saving}
                  placeholder={
                    clearRemoteToken
                      ? '保存后清除已存令牌'
                      : tokenStatusError
                        ? '读取失败，可重新输入或清除'
                        : remoteTokenConfigured
                          ? remoteTokenSource === 'environment'
                            ? '由启动环境变量提供，重新输入可迁移保存'
                            : '已配置（重新输入可替换）'
                          : '输入远端引擎令牌'
                  }
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
            {tokenStatusError ? (
              <SettingsContent>
                <div className="settings-view__error" role="alert">
                  {tokenStatusError}
                </div>
              </SettingsContent>
            ) : null}
            <SettingsRow label="个人账号" description="一键登录、完善个人资料，并管理第三方绑定和恢复凭证。">
              <button className="btn" type="button" disabled={saving} onClick={() => openAppSettings('account')}>管理个人账号</button>
            </SettingsRow>
            <SettingsDisclosure title="高级用户认证" description="管理员 API Key / JWT 兼容配置。个人账号登录后优先使用账号会话。">
            <SettingsRow
              label="认证方式"
              description={remoteAuthStatus.configured
                ? `当前已保存：${remoteAuthStatus.type === 'bearer' ? 'JWT' : 'API Key'}。下方选择仅用于新输入的凭据，填写并保存后替换。`
                : '选择新凭据的类型，填写并保存后生效。'}
            >
              <Select
                value={remoteAuthType}
                options={[
                  { value: 'api-key', label: 'API Key' },
                  { value: 'bearer', label: 'JWT（Bearer）' }
                ]}
                onChange={(value) => {
                  if (value === 'api-key' || value === 'bearer') setRemoteAuthType(value)
                }}
                disabled={saving || authStatusLoading}
                ariaLabel="远端认证方式"
                width={220}
              />
            </SettingsRow>
            <SettingsRow
              label="用户认证凭据"
              description="仅用于当前服务地址，通过系统密钥存储加密保存。留空保留原值；修改后保存并重新连接。清除后仍可使用绑定此地址的启动环境凭据。"
            >
              <div className="settings-view__token-field">
                <input
                  className="field__input sg__input sg__input--wide"
                  type="password"
                  autoComplete="new-password"
                  aria-label="远端用户认证凭据"
                  maxLength={16384}
                  disabled={saving || authStatusLoading}
                  placeholder={
                    authStatusLoading
                      ? '正在读取当前地址的配置…'
                      : clearRemoteAuth
                        ? '保存后清除已存凭据'
                        : authStatusError
                          ? '读取失败，可重新输入或清除'
                          : remoteAuthStatus.configured
                            ? `${remoteAuthStatus.source === 'environment' ? '环境已提供' : '已配置'} ${remoteAuthStatus.type === 'bearer' ? 'JWT' : 'API Key'}（输入可替换）`
                            : `输入${remoteAuthType === 'bearer' ? ' JWT' : ' API Key'}`
                  }
                  value={remoteAuthValue}
                  onChange={(event) => {
                    setRemoteAuthValue(event.target.value)
                    setClearRemoteAuth(false)
                  }}
                />
                {remoteAuthStatus.source === 'stored' || authStatusError ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={saving || authStatusLoading || clearRemoteAuth}
                    onClick={() => {
                      setRemoteAuthValue('')
                      setClearRemoteAuth(true)
                    }}
                  >
                    清除凭据
                  </button>
                ) : null}
              </div>
            </SettingsRow>
            {authStatusError ? (
              <SettingsContent>
                <div className="settings-view__error" role="alert">{authStatusError}</div>
              </SettingsContent>
            ) : null}
            </SettingsDisclosure>
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
          disabled={!dirty || saving || runtimeBusy !== null}
          onClick={() => void save(false)}
        >
          保存
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy || saving}
          title={mode === 'remote' ? '保存设置并重新连接远端引擎' : '保存设置并重启引擎使其生效'}
          onClick={() => void save(true)}
        >
          {mode === 'remote' ? '保存并重新连接' : '保存并重启'}
        </button>
        {saved ? <span className="settings-view__saved">已保存</span> : null}
        {saveError ? <span className="settings-view__error">{saveError}</span> : null}
      </div>

      <SettingsGroup title="当前状态" footer="状态会随引擎连接实时更新。">
        <SettingsContent className="engine-status__content">
          <div className="engine-status__hero">
            <span className={`engine-status__dot is-${snapshot.phase}`} aria-hidden="true" />
            <div className="engine-status__hero-copy">
              <strong>{remoteReconnecting ? '重新连接中' : snapshot.mode === 'remote' && snapshot.phase === 'starting' ? '连接中' : ENGINE_PHASE_LABELS[snapshot.phase] ?? snapshot.phase}</strong>
              <span>
                {snapshot.mode === 'remote' ? '远端服务' : '本地内置'} ·{' '}
                {snapshot.baseUrl || '尚未连接'}
              </span>
            </div>
            <span className="engine-status__badge">
              {snapshot.phase === 'ready' ? '已连接' : '未连接'}
            </span>
          </div>
          <dl className="kv engine-status__kv-summary">
            <dt>阶段</dt>
            <dd>{remoteReconnecting ? '重新连接中' : snapshot.mode === 'remote' && snapshot.phase === 'starting' ? '连接中' : ENGINE_PHASE_LABELS[snapshot.phase] ?? snapshot.phase}</dd>
            <dt>来源</dt>
            <dd>
              {snapshot.mode === 'remote'
                ? '远端服务'
                : snapshot.adopted
                  ? '复用已有引擎'
                  : runtimeSource
                    ? (ENGINE_SOURCE_LABELS[runtimeSource] ?? runtimeSource)
                    : '本应用启动'}
            </dd>
          </dl>
          <SettingsDisclosure title="查看连接详情" description="进程、版本与数据目录">
            <dl className="kv">
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
          </SettingsDisclosure>
          {snapshot.error ? (
            <div className="settings-view__error engine-status__error" role="alert">
              {snapshot.error}
            </div>
          ) : null}
        </SettingsContent>
      </SettingsGroup>

      <div className="settings-view__actions engine-status__actions">
        {snapshot.phase === 'idle' || snapshot.phase === 'error' ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void engine.start()}
          >
            <Icon name="play" size={16} />
            {snapshot.mode === 'remote' ? '连接' : '启动'}
          </button>
        ) : null}
        {snapshot.phase !== 'idle' && snapshot.phase !== 'error' ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void engine.stop()}>
            <Icon name="stop" size={16} />
            {snapshot.mode === 'remote' ? '断开连接' : '停止'}
          </button>
        ) : null}
        {snapshot.phase === 'ready' ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-label="重启"
            onClick={() => void engine.restart()}
          >
            <Icon name="restart" size={16} />
            {snapshot.mode === 'remote' ? '重新连接' : '重启'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
