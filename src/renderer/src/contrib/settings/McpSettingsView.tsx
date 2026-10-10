import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { mcpToolDisplayName } from '@renderer/core/engine/tool-labels'
import { useApp } from '@renderer/core/app-context'
import { currentWorkspacePaths } from '@renderer/core/workspace/workspace-store'
import { SettingsContent, SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { parseMcpTimeout } from './mcp-config'
import './mcp-settings.css'
import './settings-pages.css'

type Transport = 'stdio' | 'sse' | 'http' | 'streamableHttp'
interface McpServer { id: string; name: string; description?: string; transportType: Transport; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; disabledTools?: string[]; timeoutMs?: number; enabled?: boolean; scope?: 'project' | 'global'; isBuiltIn?: boolean }
interface McpTool { name: string; description?: string }
interface FormState { id: string; name: string; transportType: Transport; url: string; command: string; args: string; env: string; headers: string; disabledTools: string; description: string; scope: 'project' | 'global'; timeoutMs: string }
const blank: FormState = { id: '', name: '', transportType: 'stdio', url: '', command: '', args: '', env: '{}', headers: '{}', disabledTools: '', description: '', scope: 'project', timeoutMs: '' }
function parseJson(value: string, label: string): Record<string, string> { const parsed = JSON.parse(value || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 对象`); return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])) }
function configQuery(remote: boolean, remoteRoot: string): Record<string, string> | undefined { const path = remote ? remoteRoot.trim() : currentWorkspacePaths()[0]; return path ? { path } : undefined }

/** MCP servers are managed here so stdio and HTTP connections are exercised through the same engine boundary as chat. */
export function McpSettingsView(): JSX.Element {
  const { engine, settings } = useApp()
  const workspace = useWorkspace()
  const remote = engine.snapshot.mode === 'remote'
  const query = useMemo(() => configQuery(remote, settings.remoteWorkspaceRoot), [remote, settings.remoteWorkspaceRoot, workspace.root])
  const [servers, setServers] = useState<McpServer[]>([])
  const [form, setForm] = useState<FormState>(blank)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discoveredTools, setDiscoveredTools] = useState<Record<string, McpTool[]>>({})
  const [formOpen, setFormOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(true)
  const [jsonText, setJsonText] = useState('{\n  "mcpServers": {}\n}')
  const [jsonScope, setJsonScope] = useState<'project' | 'global'>('project')
  const [jsonBusy, setJsonBusy] = useState(false)
  const refresh = useCallback(async () => {
    setError('')
    if (!remote && !workspace.root) { setServers([]); return }
    try { setServers(await requestOrThrow<McpServer[]>({ method: 'GET', path: '/mcp/servers', query })) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [query, remote, workspace.root])
  useEffect(() => {
    setServers([]); setDiscoveredTools({}); setError(''); setNotice(''); setForm(blank); setEditing(null); setFormOpen(false)
    void refresh()
  }, [refresh])
  const update = (key: keyof FormState, value: string): void => setForm(prev => ({ ...prev, [key]: value }))
  const reset = (): void => { setForm(blank); setEditing(null); setFormOpen(false) }
  const save = async (): Promise<void> => {
    if (!form.id.trim() || !form.name.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), description: form.description.trim(), transportType: form.transportType, scope: form.scope, disabledTools: form.disabledTools.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean) }
      const timeoutMs = parseMcpTimeout(form.timeoutMs)
      if (timeoutMs !== undefined) body.timeoutMs = timeoutMs
      else if (editing) body.timeoutMs = null
      if (!editing) body.enabled = true
      if (form.transportType === 'stdio') {
        const rawArgs = form.args.trim()
        let args: string[]
        if (rawArgs.startsWith('[')) {
          const parsed: unknown = JSON.parse(rawArgs)
          if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('启动参数必须是 JSON 字符串数组')
          args = parsed
        } else args = form.args.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        body.command = form.command.trim(); body.args = args; body.env = parseJson(form.env, '环境变量')
      }
      else { body.url = form.url.trim(); body.headers = parseJson(form.headers, '请求头') }
      if (!editing) body.id = form.id.trim().toLowerCase()
      await requestOrThrow({ method: editing ? 'PATCH' : 'POST', path: editing ? `/mcp/servers/${encodeURIComponent(editing)}` : '/mcp/servers', query: editing ? { ...(query ?? {}), scope: form.scope } : query, body })
      reset(); await refresh(); setNotice('MCP 配置已保存')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const edit = (server: McpServer): void => { setEditing(server.id); setFormOpen(true); setForm({ id: server.id, name: server.name, description: server.description ?? '', transportType: server.transportType, url: server.url ?? '', command: server.command ?? '', args: (server.args ?? []).join('\n'), env: JSON.stringify(server.env ?? {}, null, 2), headers: JSON.stringify(server.headers ?? {}, null, 2), disabledTools: (server.disabledTools ?? []).join('\n'), scope: server.scope ?? 'project', timeoutMs: server.timeoutMs === undefined ? '' : String(server.timeoutMs) }) }
  const toggle = async (server: McpServer, enabled: boolean): Promise<void> => { setBusy(true); setError(''); try { await requestOrThrow({ method: 'POST', path: `/mcp/servers/${encodeURIComponent(server.id)}/${enabled ? 'enable' : 'disable'}`, query: { ...(query ?? {}), scope: server.scope ?? 'project' } }); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const remove = async (server: McpServer): Promise<void> => { if (busy) return; const confirmed = await confirmDialog({ title: '删除 MCP 配置', body: `确定删除「${server.name || server.id}」吗？`, confirmText: '删除', danger: true }); if (!confirmed) return; setBusy(true); setError(''); try { await requestOrThrow({ method: 'DELETE', path: `/mcp/servers/${encodeURIComponent(server.id)}`, query: { ...(query ?? {}), scope: server.scope ?? 'project' } }); await refresh(); setNotice('MCP 配置已删除') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const test = async (server: McpServer): Promise<void> => { setBusy(true); setError(''); setNotice(''); try { const result = await requestOrThrow<{ toolCount: number; tools?: McpTool[] }>({ method: 'POST', path: `/mcp/servers/${encodeURIComponent(server.id)}/test`, timeoutMs: server.timeoutMs, query: { ...(query ?? {}), scope: server.scope ?? 'project' } }); setDiscoveredTools(current => ({ ...current, [server.id]: result.tools ?? [] })); setNotice(`${server.name} 连接成功，发现 ${result.toolCount} 个工具`) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const toolDefinitionName = (server: McpServer, tool: McpTool): string => {
    const prefix = `mcp_${server.id}_`
    return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
  }
  const toggleTool = async (server: McpServer, tool: McpTool, enabled: boolean): Promise<void> => {
    const name = toolDefinitionName(server, tool)
    const disabled = new Set(server.disabledTools ?? [])
    if (enabled) disabled.delete(name); else disabled.add(name)
    setBusy(true); setError('')
    try { await requestOrThrow({ method: 'PATCH', path: `/mcp/servers/${encodeURIComponent(server.id)}`, query: { ...(query ?? {}), scope: server.scope ?? 'project' }, body: { disabledTools: [...disabled] } }); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const exportJson = async (): Promise<void> => {
    setJsonBusy(true); setError(''); setNotice('')
    try {
      const value = await requestOrThrow<{ mcpServers: Record<string, unknown> }>({ method: 'GET', path: '/mcp/config/export', query: { ...(query ?? {}), scope: jsonScope } })
      setJsonText(JSON.stringify(value, null, 2)); setNotice('已加载当前 MCP JSON')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setJsonBusy(false) }
  }
  const importJson = async (): Promise<void> => {
    setJsonBusy(true); setError(''); setNotice('')
    try {
      const config: unknown = JSON.parse(jsonText)
      await requestOrThrow({ method: 'POST', path: '/mcp/config/import', query, body: { scope: jsonScope, config } })
      await refresh(); setNotice('MCP JSON 已校验并原子保存')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setJsonBusy(false) }
  }
  const readJsonFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try { setJsonText(await file.text()); setNotice(`已载入 ${file.name}，请检查后应用`) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <div className="settings-view settings-view--mcp">
    <SettingsGroup title="MCP JSON 配置" footer="可粘贴标准 mcpServers JSON，一次导入多个服务器。导入前会校验全部条目，失败时不会写入任何更改。未知字段会原样保留，但引擎只使用已支持的传输与连接字段。">
      <SettingsContent className="mcp-json__toolbar">
        <div className="mcp-json__scope"><span>保存层级</span><select className="field__input" value={jsonScope} disabled={jsonBusy} onChange={e => setJsonScope(e.target.value as 'project' | 'global')}><option value="project">项目</option><option value="global">全局</option></select></div>
        <div className="mcp-toolbar"><label className="btn"><input type="file" accept=".json,application/json" hidden onChange={e => void readJsonFile(e.target.files?.[0])} />导入 JSON 文件</label><button type="button" className="btn" disabled={jsonBusy} title="读取当前引擎配置" onClick={() => void exportJson()}>读取当前配置</button><button type="button" className="btn btn--primary" disabled={jsonBusy || !jsonText.trim()} onClick={() => void importJson()}>{jsonBusy ? '处理中…' : '应用 JSON'}</button><button type="button" className="btn" disabled={jsonBusy} onClick={() => setJsonOpen(value => !value)}>{jsonOpen ? '收起' : '展开'}</button></div>
      </SettingsContent>
      {jsonOpen ? <SettingsContent><textarea className="field__input mcp-json__editor" value={jsonText} disabled={jsonBusy} onChange={e => setJsonText(e.target.value)} spellCheck={false} aria-label="MCP JSON 配置" placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "type": "streamableHttp",\n      "url": "https://example.com/mcp"\n    }\n  }\n}'} /></SettingsContent> : null}
    </SettingsGroup>
    <SettingsGroup title="MCP 服务器" footer={remote ? '当前管理远端引擎的 MCP 配置，保存位置由远端版本与配置决定。凭据只发送到该引擎。' : '配套引擎默认将项目配置保存到 .ae/mcp.json，并兼容读取旧配置；显式配置路径与全局配置保持独立。'}>
      <SettingsContent><div className="mcp-toolbar"><button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>刷新</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => { setForm(blank); setEditing(null); setFormOpen(true) }}>新增服务器</button></div></SettingsContent>
      {servers.length === 0 ? <SettingsContent><span className="mcp-empty">暂无 MCP 服务器</span></SettingsContent> : servers.map(server => <div key={server.id} className="mcp-server-block"><SettingsRow label={server.name || server.id} description={`${server.id} · ${server.transportType}${server.scope === 'global' ? ' · 全局' : ' · 项目'}`}><div className="mcp-actions"><Toggle checked={server.enabled !== false} onChange={value => void toggle(server, value)} label={`${server.name} 启用`} disabled={busy || server.isBuiltIn === true} /><button type="button" className="btn" disabled={busy} onClick={() => void test(server)}>测试</button><button type="button" className="btn" disabled={busy} onClick={() => { setEditing(server.id); edit(server) }}>编辑</button><button type="button" className="btn btn--danger-ghost" disabled={busy || server.isBuiltIn === true} onClick={() => void remove(server)}>删除</button></div></SettingsRow>{discoveredTools[server.id]?.map(tool => {
        const definitionName = toolDefinitionName(server, tool)
        const label = mcpToolDisplayName(server.id, tool.name)
        const description = [label !== definitionName ? definitionName : '', tool.description].filter(Boolean).join(' · ')
        return <SettingsRow key={tool.name} label={label} description={description}><Toggle checked={!server.disabledTools?.includes(definitionName)} onChange={value => void toggleTool(server, tool, value)} label={`${label} 启用`} disabled={busy} /></SettingsRow>
      })}</div>)}
    </SettingsGroup>
    {formOpen ? <SettingsGroup title={editing ? `编辑 · ${editing}` : '新增 MCP 服务器'}><SettingsContent><div className="mcp-form">
      <input className="field__input" value={form.id} disabled={Boolean(editing) || busy} onChange={e => update('id', e.target.value)} placeholder="id（小写、数字、连字符）" aria-label="MCP id" />
      <input className="field__input" value={form.name} disabled={busy} onChange={e => update('name', e.target.value)} placeholder="显示名称" aria-label="MCP 名称" />
      <select className="field__input" value={form.transportType} disabled={busy} onChange={e => update('transportType', e.target.value as Transport)} aria-label="MCP 传输类型"><option value="stdio">stdio（本地命令）</option><option value="streamableHttp">Streamable HTTP</option><option value="http">HTTP</option><option value="sse">SSE</option></select>
      <input className="field__input" value={form.transportType === 'stdio' ? form.command : form.url} disabled={busy} onChange={e => update(form.transportType === 'stdio' ? 'command' : 'url', e.target.value)} placeholder={form.transportType === 'stdio' ? '命令，例如 npx' : '服务 URL'} aria-label={form.transportType === 'stdio' ? 'MCP 命令' : 'MCP URL'} />
      {form.transportType === 'stdio' ? <textarea className="field__input" value={form.args} disabled={busy} onChange={e => update('args', e.target.value)} placeholder="参数（每行一个）" aria-label="MCP 参数" rows={3} /> : null}
      <textarea className="field__input" value={form.transportType === 'stdio' ? form.env : form.headers} disabled={busy} onChange={e => update(form.transportType === 'stdio' ? 'env' : 'headers', e.target.value)} placeholder={form.transportType === 'stdio' ? '{ } 环境变量 JSON' : '{ } 请求头 JSON'} aria-label={form.transportType === 'stdio' ? 'MCP 环境变量' : 'MCP 请求头'} rows={3} />
      <input className="field__input" value={form.disabledTools} disabled={busy} onChange={e => update('disabledTools', e.target.value)} placeholder="禁用工具（每行一个或逗号分隔）" aria-label="MCP 禁用工具" />
      <input className="field__input" value={form.description} disabled={busy} onChange={e => update('description', e.target.value)} placeholder="描述（可选）" aria-label="MCP 描述" />
      <label className="mcp-timeout"><span>请求超时 <small>留空使用默认；0 表示不限；停止引擎或切换连接会取消测试。</small></span><input className="field__input" type="text" inputMode="numeric" value={form.timeoutMs} disabled={busy} onChange={e => update('timeoutMs', e.target.value)} placeholder="默认（毫秒）" aria-label="MCP 请求超时" /></label>
      <label className="mcp-scope">保存层级 <select className="field__input" value={form.scope} disabled={Boolean(editing) || busy} onChange={e => update('scope', e.target.value)}><option value="project">项目</option><option value="global">全局</option></select></label>
      <div className="mcp-form__actions"><button type="button" className="btn btn--primary" disabled={busy || !form.id.trim() || !form.name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button><button type="button" className="btn" disabled={busy} onClick={reset}>取消</button></div>
    </div></SettingsContent></SettingsGroup> : null}
    {error ? <div className="settings-view__error" role="alert">{error}</div> : null}{notice ? <div className="mcp-notice" role="status">{notice}</div> : null}
  </div>
}
