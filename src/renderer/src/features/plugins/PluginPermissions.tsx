import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { canSetAllPluginPermissions, grantedPluginPermissions, hasPreviousPluginPermissions, listPluginCapabilities, requestedPluginPermissions, revokePluginPermissions, setAllPluginPermissions, setPluginPermission, type PluginCapability, type PluginPermissionRecord } from '@renderer/core/engine/plugin-permissions'
import type { PluginRecord } from '@renderer/core/engine/plugins'
import { Icon } from '@renderer/ui/icons'
import { Toggle } from '../settings/SettingsGroup'
import { PluginAgentTools } from './PluginAgentTools'
import './plugin-permissions.css'

export function PluginPermissions({ plugins, disabled = false, onUpdated, onBusyChange }: {
  plugins: PluginRecord[]
  disabled?: boolean
  onUpdated: (plugin: PluginRecord) => void
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const source = getEngineSource(), mounted = useRef(true), running = useRef(false)
  const [capabilities, setCapabilities] = useState<PluginCapability[]>([])
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false)
  const [agentToolsBusy, setAgentToolsBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setLoaded(false); setError('')
    try { const result = await listPluginCapabilities(); if (current()) { setCapabilities(result); setLoaded(true) } }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) setLoading(false) }
  }, [current])
  useEffect(() => { void load() }, [load])
  const requested = new Set(plugins.flatMap(requestedPluginPermissions))
  const rows = capabilities.filter(capability => requested.has(capability.id))
  const previous = plugins.filter(hasPreviousPluginPermissions)
  const enableTargets = plugins.filter(plugin => canSetAllPluginPermissions(plugin, true, capabilities))
  const disableTargets = plugins.filter(plugin => canSetAllPluginPermissions(plugin, false, capabilities))
  const unavailable = loading || busy || agentToolsBusy || !loaded || disabled
  const update = (targets: PluginRecord[], action: (plugin: PluginRecord) => Promise<PluginRecord>, message: string): void => {
    if (running.current || unavailable || !current()) return
    if (!targets.length) return
    running.current = true; setBusy(true); onBusyChange?.(true); setError(''); setNotice('')
    void (async () => {
      const failures: string[] = []; let completed = 0
      for (const plugin of targets) {
        if (!current()) break
        try {
          const updated = await action(plugin)
          // The owner must invalidate global plugin state even if this panel closed.
          if (source === getEngineSource()) onUpdated(updated)
          if (!current()) break
          completed++
        } catch (cause) { failures.push(`${plugin.name}：${cause instanceof Error ? cause.message : String(cause)}`) }
      }
      if (current()) {
        if (completed) setNotice(`${completed === 1 && plugins.length === 1 ? '' : `${completed} 个插件` }${message}`)
        if (failures.length) setError(failures.join('\n'))
      }
    })().finally(() => { running.current = false; if (current()) { setBusy(false); onBusyChange?.(false) } })
  }
  const change = (capability: Pick<PluginCapability, 'id' | 'title'>, enabled: boolean): void => update(
    plugins.filter(plugin => requestedPluginPermissions(plugin).includes(capability.id) && grantedPluginPermissions(plugin).includes(capability.id) !== enabled),
    plugin => setPluginPermission(plugin, capability.id, enabled), `已${enabled ? '允许' : '关闭'}「${capability.title}」。`)
  return <section className="plugin-permissions" aria-label={plugins.length > 1 ? '批量插件权限' : '插件权限'} aria-busy={loading || busy}>
    <header className="plugin-permissions__heading"><div><h2>{plugins.length > 1 ? '所选插件的权限' : '平台权限'}</h2><p>仅调整插件已声明的权限。修改立即保存。</p></div><div className="plugin-permissions__toolbar" role="group" aria-label="权限操作"><button type="button" className="btn btn--ghost" aria-label="开启全部权限" disabled={unavailable || !enableTargets.length} onClick={() => update(enableTargets, plugin => setAllPluginPermissions(plugin, true, capabilities), '已开启全部可用的已声明权限。')}>全部开启</button><button type="button" className="btn btn--ghost" aria-label="关闭全部权限" disabled={unavailable || !disableTargets.length} onClick={() => update(disableTargets, plugin => setAllPluginPermissions(plugin, false, capabilities), '已关闭全部权限并撤销旧版授权。')}>全部关闭</button><button type="button" className="btn btn--icon btn--ghost" aria-label="刷新权限目录" title="刷新权限目录" disabled={loading || busy || disabled} onClick={() => { void load() }}><Icon name="refresh" size={16} /></button></div></header>
    {error ? <p className="plugin-permissions__feedback is-error" role="alert">{error}</p> : null}
    {notice ? <p className="plugin-permissions__feedback" role="status">{notice}</p> : null}
    {plugins.length === 1 ? <p className="plugin-permissions__version">管理草稿 r{plugins[0].revision}{plugins[0].publishedRevision ? ` · 已发布 r${plugins[0].publishedRevision}${plugins[0].enabled ? ' · 已启用' : ' · 已停用'}` : ' · 尚未发布'}</p> : null}
    {previous.length ? <div className="plugin-permissions__previous"><p>{plugins.length === 1 ? `现有授权属于 r${(previous[0] as PluginPermissionRecord).permissionRevision}。为当前草稿授权将替换旧版授权。` : `${previous.length} 个插件保留旧版授权。为草稿授权将替换对应的旧版授权。`}</p><button type="button" className="btn btn--ghost" disabled={unavailable} onClick={() => update(previous, revokePluginPermissions, '已撤销旧版本授权。')}>撤销旧版本授权</button></div> : null}
    {loading ? <p className="plugin-permissions__empty" role="status">正在读取权限…</p> : !loaded ? null : !plugins.length ? <p className="plugin-permissions__empty">选择插件后可批量调整权限。</p> : !requested.size ? <p className="plugin-permissions__empty">{plugins.length > 1 ? '所选插件均未申请平台权限。' : '此插件未申请平台权限。'}</p> : <ul className="plugin-permissions__list">
      {rows.map(capability => {
        const eligible = plugins.filter(plugin => requestedPluginPermissions(plugin).includes(capability.id))
        const granted = eligible.filter(plugin => grantedPluginPermissions(plugin).includes(capability.id)).length
        const unsupported = capability.available === false
        return <li key={capability.id}><div className="plugin-permissions__copy"><strong>{capability.title}</strong><span>{capability.description}</span>{plugins.length > 1 ? <small>{granted}/{eligible.length} 个已申请此权限的插件已开启</small> : null}{unsupported ? <small>当前引擎尚未开放此接口。</small> : null}</div><Toggle label={`${plugins.length > 1 ? '批量' : ''}允许${capability.title}`} checked={unsupported ? granted > 0 : granted === eligible.length && eligible.length > 0} disabled={unavailable || unsupported && !granted} onChange={enabled => change(capability, unsupported ? false : enabled)} /></li>
      })}
      {[...requested].filter(id => !capabilities.some(item => item.id === id)).map(id => {
        const granted = plugins.some(plugin => grantedPluginPermissions(plugin).includes(id))
        return <li key={id}><div className="plugin-permissions__copy"><strong>{id}</strong><span>当前引擎不支持此权限。</span></div><Toggle label={`${plugins.length > 1 ? '批量' : ''}允许${id}`} checked={granted} disabled={unavailable || !granted} onChange={() => change({ id, title: id }, false)} /></li>
      })}
    </ul>}
    {plugins.length === 1 ? <PluginAgentTools key={plugins[0].id} plugin={plugins[0]} disabled={loading || busy || !loaded || disabled} onUpdated={onUpdated} onBusyChange={value => { setAgentToolsBusy(value); onBusyChange?.(value) }} /> : null}
  </section>
}
