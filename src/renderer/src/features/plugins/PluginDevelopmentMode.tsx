import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/ui/icons'
import { Select } from '@renderer/ui/Select'
import { getEngineSource } from '@renderer/core/engine/source'
import { listMemorySessions, type MemorySessionOption } from '@renderer/core/engine/memory-records'
import { closePluginDevelopment, invokePluginDevelopment, openPluginDevelopment, refreshPluginDevelopment, type PluginDevelopmentOpenResult, type PluginDevelopmentSession, type PluginInvocation } from '@renderer/core/engine/plugins'
import { ExtensionWebview } from '@renderer/features/extensions/ExtensionPage'
import { NativeExtensionPage } from '@renderer/features/extensions/NativeExtensionPage'
import { getExtensionContext } from '@renderer/features/extensions/host'
import { extensionId, type ExtensionPage } from '@renderer/features/extensions/types'
import { PluginDevelopmentPermissions } from './PluginDevelopmentPermissions'
import { openPluginBrowserPage } from '../browser/browser-store'

function resultText(value: unknown): string {
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

/** Source-directory sessions never enter the installed registry or replace a published plugin. */
export function PluginDevelopmentMode({ ready, onBack }: { ready: boolean; onBack: () => void }): JSX.Element {
  const source = getEngineSource(), mounted = useRef(true), operation = useRef(false)
  const activeSession = useRef<PluginDevelopmentSession | null>(null)
  const [path, setPath] = useState(''), [opened, setOpened] = useState<PluginDevelopmentOpenResult | null>(null)
  const [tool, setTool] = useState(''), [args, setArgs] = useState('{}')
  const [output, setOutput] = useState<PluginInvocation | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [permissionsBusy, setPermissionsBusy] = useState(false)
  const [sessions, setSessions] = useState<MemorySessionOption[]>([])
  const [sessionId, setSessionId] = useState(() => getExtensionContext().sessionId ?? '')
  const [sessionsError, setSessionsError] = useState('')
  const [tab, setTab] = useState<'preview' | 'tools' | 'permissions'>('preview'), [pageId, setPageId] = useState('')
  const session = opened?.session, tools = session?.manifest.tools ?? []
  const current = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false
    if (activeSession.current && source === getEngineSource()) void closePluginDevelopment(activeSession.current).catch(() => {})
  } }, [source])
  const loadSessions = useCallback(async (): Promise<void> => {
    if (!ready) return
    try { const value = await listMemorySessions(); if (current()) { setSessions(value); setSessionsError('') } }
    catch (cause) { if (current()) setSessionsError(cause instanceof Error ? cause.message : String(cause)) }
  }, [current, ready])
  useEffect(() => { void loadSessions() }, [loadSessions])
  const currentTool = tools.find(item => item.name === tool) ?? tools[0]
  const pages = opened?.application?.manifest.contributes?.pages ?? []
  const page = pages.find(item => item.id === pageId) ?? pages[0]
  const context = useMemo(() => {
    const previous = getExtensionContext()
    return { sessionId: sessionId || null, workspacePath: sessionId === previous.sessionId ? previous.workspacePath : null, engineReady: ready }
  }, [source, ready, sessionId])
  const preview: ExtensionPage | undefined = useMemo(() => session && opened?.application && page ? {
    id: extensionId(session.manifest.id, page.id), localId: page.id, title: page.title, scope: page.scope ?? 'global',
    identity: { pluginId: session.manifest.id, revision: session.revision, hash: session.hash, source, instanceId: `${session.devSessionId}:${session.hash}` },
    application: opened.application, declaration: page
  } : undefined, [opened, page, session, source])
  const navigate = useCallback((id: string): void => setPageId(id.split(':').at(-1) ?? ''), [])
  const accept = (value: PluginDevelopmentOpenResult): void => {
    activeSession.current = value.session
    setOpened(value); setPath(value.session.path); setOutput(null)
    const nextTool = value.session.manifest.tools.find(item => item.name === tool)?.name ?? value.session.manifest.tools[0]?.name ?? ''
    setTool(nextTool)
    const example = value.examples?.find(item => item.tool === nextTool)
    setArgs(example ? JSON.stringify(example.args, null, 2) : '{}')
    if (!value.application?.manifest.contributes?.pages?.length) setTab('tools')
  }
  const operate = async (action: () => Promise<void>): Promise<void> => {
    if (operation.current || !current()) return
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operation.current = false; if (current()) setBusy(false) }
  }
  const open = (): void => { void operate(async () => {
    const value = await openPluginDevelopment(path)
    if (current()) accept(value)
    else if (source === getEngineSource()) await closePluginDevelopment(value.session)
  }) }
  const refresh = (): void => { if (!session) return; void operate(async () => {
    setOutput(null)
    const value = await refreshPluginDevelopment(session)
    if (current()) { accept(value); setNotice('已读取本地最新内容。') }
  }) }
  const close = (): void => { if (!session) return; void operate(async () => {
    await closePluginDevelopment(session)
    if (current()) { activeSession.current = null; setOpened(null); setOutput(null); setTab('preview') }
  }) }
  const invoke = (): void => {
    if (!session || !currentTool) return
    void operate(async () => {
      setOutput(null)
      const parsed: unknown = JSON.parse(args)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象。')
      const result = await invokePluginDevelopment(session, currentTool.name, parsed as Record<string, unknown>, context.sessionId)
      if (current()) setOutput(result)
    })
  }
  return <section className="work-plugins work-plugins--development" aria-label="插件开发模式" aria-busy={busy || permissionsBusy}>
    <header className="work-plugins__heading work-plugins__heading--detail">
      <div className="work-plugins__title"><button type="button" className="btn btn--icon btn--ghost" aria-label="返回插件列表" title="返回插件列表" onClick={onBack}><Icon name="chevron-left" size={18} /></button><div><h1>开发模式</h1><p>打开源码工程，修改后刷新即可运行。</p></div></div>
      {session ? <div className="work-plugins__actions">{preview?.declaration?.kind === 'webview' ? <button type="button" className="btn btn--icon btn--ghost" aria-label="在浏览器中打开插件" title="在浏览器中打开" disabled={busy || permissionsBusy} onClick={() => { void operate(() => openPluginBrowserPage(preview, context, session)) }}><Icon name="globe" size={16} /></button> : null}<button type="button" className="btn btn--ghost" disabled={busy || permissionsBusy} onClick={close}>切换工程</button><button type="button" className="btn btn--icon btn--ghost" aria-label="重新读取本地插件" title="重新读取本地插件" disabled={busy || permissionsBusy} onClick={refresh}><Icon name="refresh" size={16} /></button></div> : null}
    </header>
    {error ? <div className="work-plugins__feedback is-error" role="alert">{error}</div> : null}
    {notice ? <div className="work-plugins__feedback" role="status">{notice}</div> : null}
    {busy ? <span className="sr-only" role="status">正在处理本地工程…</span> : null}
    {!ready ? <p className="work-plugins__empty" role="status">连接引擎后才能运行本地工程。</p> : !session ? <form className="work-plugins__surface work-plugins__development-source" onSubmit={event => { event.preventDefault(); open() }}>
      <label className="work-plugins__field"><span>引擎所在电脑的工程目录</span><input className="ui-input" aria-label="本地插件工程目录" value={path} disabled={busy} placeholder="D:\plugins\my-plugin" onChange={event => setPath(event.target.value)} /></label>
      <p className="work-plugins__note">选择包含 aether-plugin.json 的目录。开发运行不会安装插件或修改已发布版本。</p>
      <button type="submit" className="btn btn--primary" disabled={busy || !path.trim()}><Icon name="play" size={15} />打开开发工程</button>
    </form> : <div className="work-plugins__surface work-plugins__development-workbench">
      <div className="work-plugins__development-bar"><div className="work-plugins__development-identity"><strong>{session.manifest.name}</strong><span title={session.path}>{session.path}</span></div><span className="work-plugins__development-revision" title={session.hash}>r{session.revision}</span></div>
      <div className="work-plugins__development-context"><Select ariaLabel="开发模式绑定会话" disabled={busy || permissionsBusy} value={sessionId} options={[{ value: '', label: '未绑定会话' }, ...sessions.map(item => ({ value: item.sessionId, label: item.title?.trim() || item.sessionId }))]} onChange={setSessionId} /><button className="btn btn--icon btn--ghost" type="button" aria-label="刷新可绑定会话" title="刷新可绑定会话" onClick={() => { void loadSessions() }} disabled={busy || permissionsBusy}><Icon name="refresh" size={14} /></button>{sessionsError ? <span role="alert">{sessionsError}</span> : null}</div>
      <div className="work-plugins__segments" role="tablist" aria-label="开发模式视图">{pages.length ? <button type="button" role="tab" disabled={permissionsBusy} aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>界面预览</button> : null}<button type="button" role="tab" disabled={permissionsBusy} aria-selected={tab === 'tools'} onClick={() => setTab('tools')}>工具测试</button><button type="button" role="tab" disabled={busy || permissionsBusy} aria-selected={tab === 'permissions'} onClick={() => setTab('permissions')}>权限</button></div>
      {tab === 'permissions' ? <div className="work-plugins__development-run" role="tabpanel" aria-label="权限"><PluginDevelopmentPermissions session={session} ready={ready} onBusyChange={setPermissionsBusy} onChanged={value => { activeSession.current = value; setOpened(previous => previous ? { ...previous, session: value } : null) }} /></div> : tab === 'preview' && preview && page ? <div className="work-plugins__development-preview" role="tabpanel" aria-label="界面预览">
        {pages.length > 1 ? <Select ariaLabel="预览页面" value={page.id} options={pages.map(item => ({ value: item.id, label: item.title }))} onChange={setPageId} /> : null}
        {page.kind === 'webview' ? <ExtensionWebview key={`${session.devSessionId}:${session.hash}:${page.id}:${sessionId}`} page={preview} context={context} onNavigate={navigate} development={session} /> : page.kind === 'native' ? <NativeExtensionPage key={`${session.devSessionId}:${session.hash}:${page.id}:${sessionId}`} page={preview} context={context} onNavigate={navigate} development={session} /> : <p className="work-plugins__note">此页面使用工具表单，可在“工具测试”中运行。</p>}
      </div> : <div className="work-plugins__development-run" role="tabpanel" aria-label="工具测试">
        <label className="work-plugins__field"><span>功能</span><Select ariaLabel="开发模式工具" value={currentTool?.name ?? ''} disabled={busy} options={tools.map(item => ({ value: item.name, label: item.name, description: item.description }))} onChange={value => { setTool(value); const example = opened?.examples?.find(item => item.tool === value); setArgs(example ? JSON.stringify(example.args, null, 2) : '{}'); setOutput(null) }} /></label>
        <label className="work-plugins__field"><span>参数 JSON</span><textarea className="ui-input work-plugins__args" aria-label="开发模式参数 JSON" value={args} disabled={busy} onChange={event => setArgs(event.target.value)} /></label>
        <button type="button" className="btn btn--primary" disabled={busy || !currentTool} onClick={invoke}><Icon name="play" size={15} />运行本地代码</button>
        {output ? <pre className="work-plugins__result" aria-label="开发模式运行结果">{resultText(output.result)}{output.artifacts.length ? `\n\n产物：${output.artifacts.map(item => item.path).join('、')}` : ''}</pre> : null}
      </div>}
    </div>}
  </section>
}
