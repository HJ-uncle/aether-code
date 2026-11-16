import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { listPluginAgentTools, setPluginAgentTools, type PluginAgentTool } from '@renderer/core/engine/plugin-permissions'
import { listDevelopmentAgentTools, setDevelopmentAgentTools } from '@renderer/core/engine/plugin-development-permissions'
import type { PluginDevelopmentSession, PluginRecord } from '@renderer/core/engine/plugins'
import { Icon } from '@renderer/ui/icons'
import { Toggle } from '../settings/SettingsGroup'

type Props = { disabled: boolean; onBusyChange?: (busy: boolean) => void } & (
  | { plugin: PluginRecord; development?: never; onUpdated: (plugin: PluginRecord) => void }
  | { development: PluginDevelopmentSession; plugin?: never; onUpdated: (session: PluginDevelopmentSession) => void }
)
export function PluginAgentTools(props: Props): JSX.Element {
  const { disabled, onBusyChange } = props, target = props.development ?? props.plugin
  const targetId = props.development ? `${props.development.devSessionId}:${props.development.hash}` : props.plugin.id
  const source = getEngineSource(), identity = `${source}:${targetId}:${target.revision}`, current = useRef(identity), mounted = useRef(true), saving = useRef(false)
  const loadSequence = useRef(0)
  const permissions = JSON.stringify([target.agentDisabledTools, 'permissionGrants' in target ? target.permissionGrants : undefined])
  current.current = identity
  const [open, setOpen] = useState(false), [tools, setTools] = useState<PluginAgentTool[]>([]), [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const active = useCallback(() => mounted.current && current.current === identity && source === getEngineSource(), [identity, source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    setLoading(true); setError('')
    try { const values = await (props.development ? listDevelopmentAgentTools(props.development) : listPluginAgentTools(props.plugin)); if (active() && sequence === loadSequence.current) setTools(values) }
    catch (cause) { if (active() && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (active() && sequence === loadSequence.current) setLoading(false) }
  }, [targetId, active, permissions])
  useEffect(() => { if (open) void load() }, [open, load])
  const change = async (tool: PluginAgentTool, enabled: boolean): Promise<void> => {
    if (disabled || loading || saving.current || !active()) return
    const next = new Set(target.agentDisabledTools ?? [])
    if (enabled) next.delete(tool.name); else next.add(tool.name)
    saving.current = true; setBusy(true); setError(''); setNotice(''); onBusyChange?.(true)
    try {
      if (props.development) {
        const updated = await setDevelopmentAgentTools(props.development, [...next])
        if (active()) props.onUpdated(updated)
      } else {
        const updated = await setPluginAgentTools(props.plugin, [...next])
        if (source === getEngineSource()) props.onUpdated(updated)
      }
      if (active()) { setTools(previous => previous.map(item => item.name === tool.name ? { ...item, enabled } : item)); setNotice(`已${enabled ? '允许' : '禁用'} ${tool.name}`) }
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { saving.current = false; if (active()) { setBusy(false); onBusyChange?.(false) } }
  }
  const filtered = tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <details className="plugin-agent-tools" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Agent 工具</summary>
    {open ? <div role="region" aria-label="Agent 工具" aria-busy={loading || busy}>
      <p className="plugin-permissions__empty">选择此插件的 Agent 可以使用的工具。修改立即保存，并在下一次工具执行前生效。</p>
      <div className="plugin-agent-tools__toolbar"><label className="plugin-agent-tools__search"><Icon name="search" size={14} /><input type="search" aria-label="搜索 Agent 工具" placeholder="搜索工具" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="btn btn--icon btn--ghost" aria-label="刷新 Agent 工具" title="刷新" disabled={loading || busy || disabled} onClick={() => { void load() }}><Icon name="refresh" size={16} /></button></div>
      {error ? <p className="plugin-permissions__feedback is-error" role="alert">{error}</p> : null}
      {notice ? <p className="plugin-permissions__feedback" role="status">{notice}</p> : null}
      {loading ? <p className="plugin-permissions__empty" role="status">正在读取工具…</p> : <ul className="plugin-permissions__list">
        {filtered.map(tool => <li key={tool.name}><div className="plugin-permissions__copy"><strong>{tool.name}</strong><span>{tool.description}</span>{tool.reason ? <small>{tool.reason}</small> : null}</div><Toggle label={`允许 Agent 工具 ${tool.name}`} checked={tool.enabled} disabled={disabled || busy || !tool.available && !tool.enabled} onChange={enabled => { void change(tool, enabled) }} /></li>)}
      </ul>}
      {!loading && !error && !filtered.length ? <p className="plugin-permissions__empty">{query ? '没有匹配的工具。' : '暂无可用工具。'}</p> : null}
    </div> : null}
  </details>
}
