import { useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { EngineMode } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'

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
  const [autoStart, setAutoStart] = useState(settings.autoStartEngine)
  const [saved, setSaved] = useState(false)

  // 设置从主进程异步加载完成后同步到表单：渲染期间调和（React 官方模式，
  // 「存上一份引用、发现变化就地更新」），避免 effect 级联渲染
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (syncedSettings !== settings) {
    setSyncedSettings(settings)
    setMode(settings.engineMode)
    setPort(String(settings.preferredPort))
    setRemoteUrl(settings.remoteBaseUrl)
    setAutoStart(settings.autoStartEngine)
  }

  const dirty =
    mode !== settings.engineMode ||
    port !== String(settings.preferredPort) ||
    remoteUrl !== settings.remoteBaseUrl ||
    autoStart !== settings.autoStartEngine

  const busy =
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'

  const save = async (restart: boolean): Promise<void> => {
    const parsedPort = Number(port)
    await updateSettings({
      engineMode: mode,
      preferredPort: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 12323,
      remoteBaseUrl: remoteUrl.trim(),
      autoStartEngine: autoStart
    })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
    if (restart) await engine.restart()
  }

  return (
    <div className="settings-view">
      <fieldset className="field">
        <legend>运行方式</legend>
        <label className="field__radio">
          <input
            type="radio"
            name="engine-mode"
            checked={mode === 'embedded'}
            onChange={() => setMode('embedded')}
          />
          <span>
            本地内置
            <small>随应用启动引擎进程，数据存放在本机</small>
          </span>
        </label>
        <label className="field__radio">
          <input
            type="radio"
            name="engine-mode"
            checked={mode === 'remote'}
            onChange={() => setMode('remote')}
          />
          <span>
            远端服务
            <small>连接已部署的引擎，不启动本地进程</small>
          </span>
        </label>
      </fieldset>

      {mode === 'embedded' ? (
        <label className="field">
          <span className="field__label">首选端口</span>
          <input
            className="field__input"
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
          <small className="field__hint">端口被占用时自动向后探测可用端口</small>
        </label>
      ) : (
        <label className="field">
          <span className="field__label">远端地址</span>
          <input
            className="field__input"
            type="text"
            placeholder="http://192.168.1.10:12323"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
          />
          <small className="field__hint">需可从本机访问，且该地址已放行本机来源</small>
        </label>
      )}

      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={autoStart}
          onChange={(event) => setAutoStart(event.target.checked)}
        />
        <span>启动应用时自动连接引擎</span>
      </label>

      <div className="settings-view__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty}
          onClick={() => void save(false)}
        >
          保存
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          title="保存设置并重启引擎使其生效"
          onClick={() => void save(true)}
        >
          保存并重启
        </button>
        {saved ? <span className="settings-view__saved">已保存</span> : null}
      </div>

      <fieldset className="field">
        <legend>当前状态</legend>
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
          <dt>进程</dt>
          <dd>{snapshot.pid ? `pid ${snapshot.pid}` : '—'}</dd>
          <dt>地址</dt>
          <dd>{snapshot.baseUrl || '—'}</dd>
          <dt>版本</dt>
          <dd>{snapshot.version ?? '—'}</dd>
          <dt>入口</dt>
          <dd className="kv__mono" title={snapshot.entryPath ?? ''}>
            {snapshot.entryPath ?? '—'}
          </dd>
          <dt>数据</dt>
          <dd className="kv__mono" title={snapshot.dataDir ?? ''}>
            {snapshot.dataDir ?? '—'}
          </dd>
        </dl>
        {snapshot.error ? <div className="settings-view__error">{snapshot.error}</div> : null}
      </fieldset>

      <div className="settings-view__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void engine.start()}>
          <Icon name="play" size={13} />
          启动
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || snapshot.phase === 'idle'}
          onClick={() => void engine.stop()}
        >
          <Icon name="stop" size={13} />
          停止
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void engine.restart()}>
          <Icon name="restart" size={13} />
          重启
        </button>
      </div>
    </div>
  )
}
