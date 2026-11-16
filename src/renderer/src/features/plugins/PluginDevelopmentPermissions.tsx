import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { listPluginCapabilities, type PluginCapability } from '@renderer/core/engine/plugin-permissions'
import { grantedDevelopmentPermissions, requestedDevelopmentPermissions, setDevelopmentPermission, type PluginDevelopmentPermissionSession } from '@renderer/core/engine/plugin-development-permissions'
import { Icon } from '@renderer/ui/icons'
import { Toggle } from '../settings/SettingsGroup'
import { PluginAgentTools } from './PluginAgentTools'
import './plugin-permissions.css'

/** Development grants belong to this source snapshot and never touch installed grants. */
export function PluginDevelopmentPermissions({ session, onChanged, ready = true, onBusyChange }: {
  session: PluginDevelopmentPermissionSession
  onChanged: (session: PluginDevelopmentPermissionSession) => void
  ready?: boolean
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const source = getEngineSource(), identity = `${source}:${session.devSessionId}:${session.revision}:${session.hash}`
  const mounted = useRef(true), active = useRef(identity), operation = useRef(0), running = useRef(false)
  active.current = identity
  const [capabilities, setCapabilities] = useState<PluginCapability[]>([])
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false)
  const [agentToolsBusy, setAgentToolsBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++ } }, [])
  useEffect(() => { operation.current++; running.current = false; setBusy(false); setError(''); setNotice('') }, [identity])
  const load = useCallback(async (): Promise<void> => {
    if (!ready) { setLoading(false); return }
    setLoading(true); setError('')
    try { const result = await listPluginCapabilities(); if (current()) { setCapabilities(result); setLoaded(true) } }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) setLoading(false) }
  }, [current, ready])
  useEffect(() => { void load() }, [load])
  const requested = requestedDevelopmentPermissions(session), grants = new Set(grantedDevelopmentPermissions(session))
  const change = (capability: string, enabled: boolean): void => {
    if (running.current || agentToolsBusy || !ready || !current()) return
    const ticket = ++operation.current, expectedIdentity = identity
    running.current = true; setBusy(true); onBusyChange?.(true); setError(''); setNotice('')
    const valid = (): boolean => current() && active.current === expectedIdentity && operation.current === ticket
    void setDevelopmentPermission(session, capability, enabled).then(value => {
      if (!valid()) return
      onChanged(value); setNotice('开发权限已更新。')
    }).catch(cause => { if (valid()) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (valid()) { running.current = false; setBusy(false); onBusyChange?.(false) } })
  }
  return <section className="plugin-permissions" aria-label="开发模式权限" aria-busy={loading || busy || agentToolsBusy}>
    <header className="plugin-permissions__heading"><div><h2>开发权限</h2><p>同一工程刷新后保留已有授权，新申请的能力默认关闭。</p></div><button type="button" className="btn btn--icon btn--ghost" aria-label="刷新开发权限目录" title="刷新开发权限目录" disabled={loading || busy || agentToolsBusy || !ready} onClick={() => { void load() }}><Icon name="refresh" size={16} /></button></header>
    {error ? <p className="plugin-permissions__feedback is-error" role="alert">{error}</p> : null}
    {notice ? <p className="plugin-permissions__feedback" role="status">{notice}</p> : null}
    {!ready ? <p className="plugin-permissions__empty" role="status">连接引擎后可调整开发权限。</p> : loading ? <p className="plugin-permissions__empty" role="status">正在读取权限…</p> : !loaded ? null : !requested.length ? <p className="plugin-permissions__empty">此工程未申请平台权限。</p> : <ul className="plugin-permissions__list">
      {requested.map(id => {
        const capability = capabilities.find(item => item.id === id)
        return <li key={id}><div className="plugin-permissions__copy"><strong>{capability?.title ?? id}</strong><span>{capability?.description ?? '当前引擎不支持此权限。'}</span>{capability?.available === false ? <small>当前引擎尚未开放此接口。</small> : null}</div>{capability ? <Toggle label={`开发模式允许${capability.title}`} checked={grants.has(id)} disabled={busy || agentToolsBusy || !ready || capability.available === false && !grants.has(id)} onChange={enabled => change(id, enabled)} /> : null}</li>
      })}
    </ul>}
    <PluginAgentTools key={session.devSessionId} development={session} disabled={loading || busy || !loaded || !ready} onUpdated={onChanged} onBusyChange={value => { setAgentToolsBusy(value); onBusyChange?.(value) }} />
  </section>
}
