import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, getEngineStorageKey, subscribeEngineSource } from '@renderer/core/engine/source'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { mcpToolDisplayName } from '@renderer/core/engine/tool-labels'
import { useApp } from '@renderer/core/app-context'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { sessionWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { useWorkState } from '@renderer/contrib/work/work-state'
import { SettingsContent, SettingsGroup, SettingsDisclosure, Toggle } from './SettingsGroup'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
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
/** MCP servers are managed here so stdio and HTTP connections are exercised through the same engine boundary as chat. */
export function McpSettingsView(): JSX.Element {
  const { engine, settings, ready } = useApp()
  const workspace = useWorkspace()
  const appMode = useAppMode()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const workState = useWorkState(getEngineStorageKey())
  const task = workState.tasks.find(item => item.id === workState.activeTaskId)
  const remote = engine.snapshot.mode === 'remote'
  const projectRoot = appMode === 'work' ? (task ? task.workspacePath : workState.homeWorkspacePath)
    : remote ? settings.remoteWorkspaceRoot.trim() || null : workspace.root
  const scope = JSON.stringify([source, appMode, task?.id, projectRoot])
  // A Work task may own a private engine directory even when its saved folder is null.
  // Resolve the same read-only binding as its file panel; never rebind it to Code's project.
  if (appMode === 'work' && task && task.status !== 'draft') return <McpSessionSettings key={scope}
    source={source} remote={remote} ready={ready} sessionId={task.id} workspaceHint={projectRoot} />
  return <McpSettingsContent key={scope} source={source} remote={remote} projectRoot={projectRoot} />
}

function McpSessionSettings({ source, remote, ready, sessionId, workspaceHint }: {
  source: number; remote: boolean; ready: boolean; sessionId: string; workspaceHint: string | null
}): JSX.Element {
  const [resolved, setResolved] = useState<{ root: string } | { error: string } | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!ready) return
    let current = true
    void sessionWorkspaceContext(sessionId, workspaceHint).then(context => {
      if (current && source === getEngineSource()) setResolved({ root: context.root })
    }).catch((cause: unknown) => {
      if (current && source === getEngineSource()) setResolved({ error: cause instanceof Error ? cause.message : '无法读取当前会话的项目目录' })
    })
    return () => { current = false }
  }, [source, ready, sessionId, workspaceHint, retry])
  if (ready && resolved && 'root' in resolved) return <McpSettingsContent source={source} remote={remote} projectRoot={resolved.root} />
  return <div className="settings-view settings-view--mcp"><SettingsGroup title="MCP 服务器">
    <SettingsContent>{!ready ? <span role="status">连接引擎后可读取当前会话的 MCP 配置。</span>
      : resolved && 'error' in resolved ? <div><p role="alert">无法确认当前会话的项目目录：{resolved.error}</p>
        <button type="button" className="btn" onClick={() => { setResolved(null); setRetry(value => value + 1) }}>重试读取项目目录</button></div>
        : <span role="status">正在确认当前会话的项目目录…</span>}</SettingsContent>
  </SettingsGroup></div>
}

function McpSettingsContent({ source, remote, projectRoot }: { source: number; remote: boolean; projectRoot: string | null }): JSX.Element {
  const query = useMemo((): Record<string, string> => projectRoot ? { path: projectRoot } : { scope: 'global' }, [projectRoot])
  const initialForm = useMemo<FormState>(() => ({ ...blank, scope: projectRoot ? 'project' : 'global' }), [projectRoot])
  const scopeOptions = projectRoot ? [{ value: 'project', label: '项目' }, { value: 'global', label: '全局' }] : [{ value: 'global', label: '全局' }]
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState<FormState>(initialForm)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discoveredTools, setDiscoveredTools] = useState<Record<string, McpTool[]>>({})
  const [formOpen, setFormOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('{\n  "mcpServers": {}\n}')
  const [jsonScope, setJsonScope] = useState<'project' | 'global'>(initialForm.scope)
  const [jsonBusy, setJsonBusy] = useState(false)
  const jsonId = useId(), fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true), refreshSequence = useRef(0)
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSequence.current++ } }, [])
  const refresh = useCallback(async () => {
    if (!isCurrent()) return
    const sequence = ++refreshSequence.current
    setError(''); setLoadError(''); setLoading(true)
    try {
      const next = await requestOrThrow<McpServer[]>({ method: 'GET', path: '/mcp/servers', query })
      if (isCurrent() && sequence === refreshSequence.current) setServers(next)
    } catch (e) { if (isCurrent() && sequence === refreshSequence.current) setLoadError(e instanceof Error ? e.message : String(e)) }
    finally { if (isCurrent() && sequence === refreshSequence.current) setLoading(false) }
  }, [query, isCurrent])
  useEffect(() => {
    setServers([]); setDiscoveredTools({}); setError(''); setNotice(''); setForm(initialForm); setEditing(null); setFormOpen(false)
    void refresh()
  }, [refresh, initialForm])
  useEffect(() => subscribeResourceCatalogueChanges(['mcp'], change => {
    setDiscoveredTools(current => { const next = { ...current }; delete next[change.id]; return next })
    void refresh()
  }), [refresh, source])
  const update = (key: keyof FormState, value: string): void => setForm(prev => ({ ...prev, [key]: value }))
  const reset = (): void => { setForm(initialForm); setEditing(null); setFormOpen(false) }
  const save = async (): Promise<void> => {
    if (!isCurrent() || !form.id.trim() || !form.name.trim() || busy || (form.scope === 'project' && !projectRoot)) return
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
  // JSON preserves empty arguments and significant whitespace when an existing command is edited.
  const edit = (server: McpServer): void => { setEditing(server.id); setFormOpen(true); setForm({ id: server.id, name: server.name, description: server.description ?? '', transportType: server.transportType, url: server.url ?? '', command: server.command ?? '', args: JSON.stringify(server.args ?? [], null, 2), env: JSON.stringify(server.env ?? {}, null, 2), headers: JSON.stringify(server.headers ?? {}, null, 2), disabledTools: (server.disabledTools ?? []).join('\n'), scope: server.scope ?? 'project', timeoutMs: server.timeoutMs === undefined ? '' : String(server.timeoutMs) }) }
  const toggle = async (server: McpServer, enabled: boolean): Promise<void> => { setBusy(true); setError(''); try { await requestOrThrow({ method: 'POST', path: `/mcp/servers/${encodeURIComponent(server.id)}/${enabled ? 'enable' : 'disable'}`, query: { ...(query ?? {}), scope: server.scope ?? 'project' } }); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const remove = async (server: McpServer): Promise<void> => { if (busy || !isCurrent()) return; const confirmed = await confirmDialog({ title: '删除 MCP 配置', body: `确定删除「${server.name || server.id}」吗？`, confirmText: '删除', danger: true }); if (!confirmed || !isCurrent()) return; setBusy(true); setError(''); try { await requestOrThrow({ method: 'DELETE', path: `/mcp/servers/${encodeURIComponent(server.id)}`, query: { ...(query ?? {}), scope: server.scope ?? 'project' } }); await refresh(); setNotice('MCP 配置已删除') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
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
    if (!isCurrent() || (jsonScope === 'project' && !projectRoot)) return
    setJsonBusy(true); setError(''); setNotice('')
    try {
      const value = await requestOrThrow<{ mcpServers: Record<string, unknown> }>({ method: 'GET', path: '/mcp/config/export', query: { ...(query ?? {}), scope: jsonScope } })
      setJsonText(JSON.stringify(value, null, 2)); setNotice('已加载当前 MCP JSON')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setJsonBusy(false) }
  }
  const importJson = async (): Promise<void> => {
    if (!isCurrent() || (jsonScope === 'project' && !projectRoot)) return
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
    <section className="mcp-servers" aria-label="MCP 服务器">
      <header className="mcp-servers__header">
        <div><h2>服务器 <span>{servers.length}</span></h2><p>管理连接与可用工具</p></div>
        <div className="mcp-toolbar">
          <button type="button" className="mcp-icon-button" aria-label="刷新 MCP 服务器" title="刷新" disabled={busy || loading} onClick={() => void refresh()}>
            {loading ? <Spinner size={15} /> : <Icon name="sync" size={15} />}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { setError(''); setForm(initialForm); setEditing(null); setFormOpen(true) }}>
            <Icon name="plus" size={14} />新增服务器
          </button>
        </div>
      </header>
      <div className="mcp-context">
        <Icon name={remote ? 'cloud-upload-outline' : 'folder-outline'} size={14} />
        <span>{projectRoot ? '当前项目目录' : '全局配置'}</span>
        <span className="mcp-context__path" title={projectRoot ?? undefined}>{projectRoot ?? '未指定项目'}</span>
      </div>
      {loadError ? <div className="mcp-message is-error" role="alert">MCP 配置读取失败：{loadError}</div> : null}
      {!formOpen && error ? <div className="mcp-message is-error" role="alert">{error}</div> : null}
      {notice ? <div className="mcp-message" role="status"><Icon name="check" size={14} />{notice}</div> : null}
      <div className="mcp-server-list" aria-busy={loading}>
        {servers.length === 0 ? <div className="mcp-empty" role="status">
          {loading ? <Spinner size={20} /> : <Icon name={loadError ? 'alert-circle' : 'package-variant-closed'} size={24} />}
          <div><strong>{loading ? '正在读取 MCP 服务器…' : loadError ? '暂时无法加载服务器' : '暂无 MCP 服务器'}</strong>
            <p>{loading ? '正在同步当前配置' : loadError ? '点击右上角刷新重试。' : '添加服务器，或从下方 JSON 导入配置。'}</p></div>
        </div> : servers.map(server => <McpServerRow key={(server.scope ?? 'project') + ':' + server.id}
          server={server} busy={busy} tools={discoveredTools[server.id]}
          onToggle={value => void toggle(server, value)} onTest={() => void test(server)}
          onEdit={() => { setError(''); edit(server) }} onRemove={() => void remove(server)}
          onToggleTool={(tool, enabled) => void toggleTool(server, tool, enabled)} />)}
      </div>
    </section>

    <section className="mcp-json">
      <button type="button" className="mcp-json__disclosure" aria-label="JSON 配置" aria-expanded={jsonOpen} aria-controls={jsonId} onClick={() => setJsonOpen(value => !value)}>
        <Icon name="file" size={18} />
        <span><strong>JSON 配置</strong><small>批量导入或编辑服务器配置</small></span>
        <Icon name={jsonOpen ? 'chevron-up' : 'chevron-down'} size={15} />
      </button>
      {jsonOpen ? <div id={jsonId} className="mcp-json__body" role="region" aria-label="MCP JSON 配置编辑器">
        <div className="mcp-json__toolbar">
          <div className="mcp-json__scope"><span>保存到</span><Select ariaLabel="MCP JSON 保存层级" value={jsonScope} disabled={jsonBusy || !projectRoot}
            onChange={value => { if (value === 'project' || value === 'global') setJsonScope(value) }} options={scopeOptions} /></div>
          <div className="mcp-toolbar">
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => { void readJsonFile(event.target.files?.[0]); event.target.value = '' }} />
            <button type="button" className="btn" disabled={jsonBusy} onClick={() => fileInput.current?.click()}>导入 JSON 文件</button>
            <button type="button" className="btn" disabled={jsonBusy} onClick={() => void exportJson()}>读取当前配置</button>
          </div>
        </div>
        <textarea className="ui-input mcp-json__editor" value={jsonText} disabled={jsonBusy} onChange={event => setJsonText(event.target.value)}
          spellCheck={false} aria-label="MCP JSON 配置" />
        <div className="mcp-json__footer">
          <p>支持标准 mcpServers JSON；校验通过后保存。</p>
          <button type="button" className="btn btn--primary" disabled={jsonBusy || !jsonText.trim()} onClick={() => void importJson()}>{jsonBusy ? '处理中…' : '应用 JSON'}</button>
        </div>
      </div> : null}
    </section>

    {formOpen ? <Dialog title={editing ? '编辑 MCP 服务器' : '新增 MCP 服务器'} width={640} className="mcp-editor" closeDisabled={busy} onClose={reset}
      footer={<><button type="button" className="btn" disabled={busy} onClick={reset}>取消</button>
        <button type="submit" form={jsonId + '-form'} className="btn btn--primary" disabled={busy || !form.id.trim() || !form.name.trim()}>{busy ? '保存中…' : '保存'}</button></>}>
      <form id={jsonId + '-form'} className="mcp-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <McpFormField label="显示名称"><input className="ui-input" value={form.name} disabled={busy} onChange={event => update('name', event.target.value)} placeholder="例如：项目资料" aria-label="MCP 名称" /></McpFormField>
        <McpFormField label="标识"><input className="ui-input" value={form.id} disabled={Boolean(editing) || busy} onChange={event => update('id', event.target.value)} placeholder="例如：project-docs" aria-label="MCP id" /></McpFormField>
        <McpFormField label="连接方式"><Select value={form.transportType} disabled={busy} onChange={value => update('transportType', value)} ariaLabel="MCP 传输类型"
          options={[{ value: 'stdio', label: 'stdio（本地命令）' }, { value: 'streamableHttp', label: 'Streamable HTTP' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]} /></McpFormField>
        <McpFormField label="保存到"><Select value={form.scope} disabled={Boolean(editing) || busy || !projectRoot} onChange={value => update('scope', value)} ariaLabel="MCP 服务器保存层级" options={scopeOptions} /></McpFormField>
        <McpFormField label={form.transportType === 'stdio' ? '启动命令' : '服务地址'} wide>
          <input className="ui-input" value={form.transportType === 'stdio' ? form.command : form.url} disabled={busy}
            onChange={event => update(form.transportType === 'stdio' ? 'command' : 'url', event.target.value)}
            placeholder={form.transportType === 'stdio' ? '例如：npx' : 'https://example.com/mcp'} aria-label={form.transportType === 'stdio' ? 'MCP 命令' : 'MCP URL'} />
        </McpFormField>
        {form.transportType === 'stdio' ? <McpFormField label="启动参数" wide>
          <textarea className="ui-input mcp-form__code" value={form.args} disabled={busy} onChange={event => update('args', event.target.value)}
            placeholder="每行一个参数，或粘贴 JSON 字符串数组" aria-label="MCP 参数" rows={3} />
        </McpFormField> : null}
        <McpFormField label="描述 · 可选" wide><input className="ui-input" value={form.description} disabled={busy}
          onChange={event => update('description', event.target.value)} placeholder="简要说明这个服务器的用途" aria-label="MCP 描述" /></McpFormField>
        <SettingsDisclosure title="高级选项" description={form.transportType === 'stdio' ? '环境变量、工具与超时' : '请求头、工具与超时'} className="mcp-form__advanced">
          <McpFormField label={form.transportType === 'stdio' ? '环境变量（JSON）' : '请求头（JSON）'}>
            <textarea className="ui-input mcp-form__code" value={form.transportType === 'stdio' ? form.env : form.headers} disabled={busy}
              onChange={event => update(form.transportType === 'stdio' ? 'env' : 'headers', event.target.value)}
              aria-label={form.transportType === 'stdio' ? 'MCP 环境变量' : 'MCP 请求头'} rows={3} />
          </McpFormField>
          <McpFormField label="禁用工具"><input className="ui-input" value={form.disabledTools} disabled={busy}
            onChange={event => update('disabledTools', event.target.value)} placeholder="每行一个或逗号分隔" aria-label="MCP 禁用工具" /></McpFormField>
          <McpFormField label="请求超时（毫秒）"><input className="ui-input" type="text" inputMode="numeric" value={form.timeoutMs} disabled={busy}
            onChange={event => update('timeoutMs', event.target.value)} placeholder="留空使用默认值，0 表示不限时" aria-label="MCP 请求超时" /></McpFormField>
        </SettingsDisclosure>
        {error ? <div className="mcp-message is-error mcp-form__error" role="alert">{error}</div> : null}
      </form>
    </Dialog> : null}
  </div>
}

function McpFormField({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }): JSX.Element {
  return <div className={'mcp-form__field' + (wide ? ' is-wide' : '')}><span>{label}</span>{children}</div>
}

function McpServerRow({ server, busy, tools, onToggle, onTest, onEdit, onRemove, onToggleTool }: {
  server: McpServer; busy: boolean; tools?: McpTool[]
  onToggle: (value: boolean) => void; onTest: () => void; onEdit: () => void; onRemove: () => void
  onToggleTool: (tool: McpTool, enabled: boolean) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const firstMenuItem = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menuOpen || busy) return
    let frame = 0
    const focusItem = (): void => {
      const item = firstMenuItem.current
      if (!item || document.activeElement !== menuTrigger.current) return
      // Popovers are hidden during their first measurement frame.
      if (getComputedStyle(item).visibility === 'hidden' || !item.getClientRects().length) {
        frame = requestAnimationFrame(focusItem)
        return
      }
      item.focus({ preventScroll: true })
    }
    focusItem()
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, busy])
  const name = server.name || server.id
  const runMenuAction = (action: () => void): void => {
    setMenuOpen(false)
    // The menu item disappears; dialogs must return focus to the persistent row action.
    menuTrigger.current?.focus({ preventScroll: true })
    action()
  }
  return <article className="mcp-server" aria-label={name}>
    <div className="mcp-server__row">
      <span className="mcp-server__icon" aria-hidden="true"><Icon name={server.transportType === 'stdio' ? 'terminal' : 'cloud-upload-outline'} size={18} /></span>
      <div className="mcp-server__copy">
        <h3 title={server.id}>{name}</h3>
        <div className="mcp-server__metadata"><span>{server.transportType}</span><span>{server.scope === 'global' ? '全局' : '项目'}</span><span>{server.enabled === false ? '已停用' : '已启用'}</span>{server.isBuiltIn ? <span>内置</span> : null}</div>
        {server.description ? <p>{server.description}</p> : null}
      </div>
      <div className="mcp-server__actions">
        <button type="button" className="btn" disabled={busy} onClick={onTest}>测试</button>
        <Toggle checked={server.enabled !== false} onChange={onToggle} label={name + ' 启用'} disabled={busy || server.isBuiltIn === true} />
        <Popover open={menuOpen} onOpenChange={setMenuOpen} disabled={busy} align="end" width={156} label={name + ' 的操作'} panelClassName="mcp-server-menu"
          trigger={({ open }) => <button ref={menuTrigger} type="button" className="mcp-icon-button" aria-label={name + ' 的更多操作'} title="更多操作" aria-expanded={open} disabled={busy}><Icon name="dots-horizontal" size={17} /></button>}>
          <div className="mcp-server-menu__actions">
            <button ref={firstMenuItem} type="button" onClick={() => runMenuAction(onEdit)}><Icon name="pencil" size={14} />编辑</button>
            <button type="button" className="is-danger" disabled={server.isBuiltIn === true} onClick={() => runMenuAction(onRemove)}><Icon name="trash" size={14} />删除</button>
          </div>
        </Popover>
      </div>
    </div>
    {tools ? <details className="mcp-server__tools">
      <summary><Icon name="chevron-right" size={12} /><span>工具 {tools.length}</span><span>连接成功</span></summary>
      <div className="mcp-tool-list">
        {tools.length ? tools.map(tool => {
          const prefix = 'mcp_' + server.id + '_'
          const definitionName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
          const label = mcpToolDisplayName(server.id, tool.name)
          return <div className="mcp-tool" key={tool.name}>
            <div><strong title={definitionName}>{label}</strong>{tool.description ? <p>{tool.description}</p> : null}</div>
            <Toggle checked={!server.disabledTools?.includes(definitionName)} onChange={value => onToggleTool(tool, value)} label={label + ' 启用'} disabled={busy} />
          </div>
        }) : <p className="mcp-tool-list__empty">此服务器未返回工具。</p>}
      </div>
    </details> : null}
  </article>
}
