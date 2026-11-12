import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { PluginRunner } from '@renderer/features/plugins/PluginRunner'
import { currentAppearance, cssVar, watchTheme } from '@renderer/core/theme/palette'
import { PLUGIN_UI_THEME_TOKENS } from '@shared/plugin-ui'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionServices, invokeExtensionTool } from './host'
import { extensionId, type ExtensionContext, type ExtensionPage as ExtensionPageEntry } from './types'
import { requestExtensionPage } from './navigation'
import { extensionWebviewDocument } from './webview-document'
import './extensions.css'

class ExtensionBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('[extensions] 插件页面渲染失败', error, info.componentStack) }
  render(): ReactNode { return this.state.failed ? <div className="extension-page__notice" role="alert"><p>插件页面暂时无法显示。</p><button type="button" className="btn" onClick={this.props.onRetry}>重新打开</button></div> : this.props.children }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function Webview({ page, context, onNavigate }: { page: ExtensionPageEntry; context: ExtensionContext; onNavigate: (id: string) => void }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null), current = useRef(true), pending = useRef(new Set<string>())
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const [ready, setReady] = useState(false)
  const channel = useMemo(() => crypto.randomUUID(), [page.identity.instanceId, page.localId])
  const sendTheme = useCallback((): void => {
    if (!extensionRegistry.has(page.identity)) return
    frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, event: 'theme', value: {
      appearance: currentAppearance(), tokens: Object.fromEntries(PLUGIN_UI_THEME_TOKENS.map(name => [name, cssVar(name)]))
    } }, '*')
  }, [channel, page.identity])
  useEffect(() => watchTheme(sendTheme), [sendTheme])
  const html = page.application?.uiDocuments?.[page.localId]
  const document = useMemo(() => html ? extensionWebviewDocument(html, channel) : '', [html, channel])
  useEffect(() => {
    let mounted = true, url = ''
    setSource(''); setError(''); setReady(false)
    if (document) void window.aether.pluginUi.create(document).then(value => {
      url = value.url
      if (mounted) setSource(url)
      else void window.aether.pluginUi.release(url).catch(() => {})
    }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { mounted = false; if (url) void window.aether.pluginUi.release(url).catch(() => {}) }
  }, [document])
  const scopedContext = useRef(context); scopedContext.current = context
  const services = useSyncExternalStore(extensionServices.subscribe, extensionServices.getSnapshot)
  const snapshots = (): unknown => extensionServices.getSnapshot().filter(service => service.instanceId === page.identity.instanceId && (!service.sessionId || service.sessionId === scopedContext.current.sessionId))
    .map(({ open: _open, stop: _stop, ...value }) => value)
  useEffect(() => { frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, event: 'services', value: snapshots() }, '*') }, [services, context.sessionId, channel])
  useEffect(() => {
    current.current = true
    const receive = async (event: MessageEvent): Promise<void> => {
      if (event.source !== frame.current?.contentWindow || !object(event.data) || event.data.aetherPlugin !== 1 || event.data.channel !== channel) return
      if (event.data.event === 'ready') { if (extensionRegistry.has(page.identity)) setReady(true); return }
      const { id, method, params } = event.data
      if (typeof id !== 'string' || id.length > 64 || typeof method !== 'string' || !object(params) || pending.current.has(id)) return
      const respond = (value?: unknown, error?: string): void => {
        if (current.current && extensionRegistry.has(page.identity)) frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, id, value, error }, '*')
      }
      if (pending.current.size >= 8) { respond(undefined, '插件并发请求过多。'); return }
      pending.current.add(id)
      try {
        if (JSON.stringify(params).length > 256 * 1024) throw new Error('插件参数超过大小限制。')
        const registration = extensionRegistry.getRegistration(page.identity.pluginId)
        if (!registration || !extensionRegistry.has(page.identity)) throw new Error('插件已卸载。')
        let result: unknown
        if (method === 'context') result = { sessionId: scopedContext.current.sessionId ?? null, workspacePath: scopedContext.current.workspacePath ?? null, engineReady: Boolean(scopedContext.current.engineReady), pluginId: page.identity.pluginId, revision: page.identity.revision }
        else if (method === 'invoke') {
          const declaration = page.declaration
          if (declaration?.kind !== 'webview' || typeof params.tool !== 'string' || !declaration.tools.includes(params.tool) || !object(params.args)) throw new Error('此页面未声明该工具权限。')
          result = await invokeExtensionTool(registration, params.tool, params.args)
        } else if (method === 'navigate') {
          const target = typeof params.page === 'string' ? extensionId(page.identity.pluginId, params.page) : ''
          if (!extensionRegistry.getPage(target)) throw new Error('插件页面不存在。')
          onNavigate(target); result = null
        } else if (method === 'service.get') result = snapshots()
        else if (method === 'service.start' || method === 'service.stop' || method === 'service.status') {
          if (typeof params.id !== 'string' || !registration.contributes.services?.some(item => item.id === params.id)) throw new Error('插件服务不存在。')
          if (params.args !== undefined && !object(params.args)) throw new Error('服务参数需要 JSON 对象。')
          await extensionServices.action(extensionId(page.identity.pluginId, params.id), scopedContext.current, method === 'service.start' ? 'start' : method === 'service.stop' ? 'stop' : 'status', params.args as Record<string, unknown> | undefined)
          result = snapshots()
        } else throw new Error('插件请求的方法不受支持。')
        respond(result)
      } catch (cause) { respond(undefined, cause instanceof Error ? cause.message : String(cause)) }
      finally { pending.current.delete(id) }
    }
    const listener = (event: MessageEvent): void => { void receive(event) }
    window.addEventListener('message', listener)
    return () => { current.current = false; pending.current.clear(); window.removeEventListener('message', listener) }
  }, [channel, page, onNavigate])
  if (!html) return <p className="extension-page__notice" role="alert">插件页面文件不可用，请重新发布插件。</p>
  return <div className="extension-page__webview" aria-busy={!ready && !error}>{error ? <p role="alert">{error}</p> : null}{source ? <iframe ref={frame} title={page.title} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={source} tabIndex={ready ? 0 : -1} aria-hidden={!ready} data-ready={ready} onLoad={sendTheme} onError={() => setError('插件页面加载失败。')} /> : null}{!ready && !error ? <div className="extension-page__loading" role="status">正在打开插件…</div> : null}</div>
}

export function ExtensionPage({ contributionId, context, onNavigate }: { contributionId: string; context: ExtensionContext; onNavigate?: (id: string) => void }): JSX.Element {
  useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  const page = extensionRegistry.getPage(contributionId), [attempt, setAttempt] = useState(0)
  const navigate = useMemo(() => onNavigate ?? ((id: string) => requestExtensionPage(id, context.sessionId ?? undefined)), [onNavigate, context.sessionId])
  if (!page || !extensionVisible(page.scope, page.when, context)) return <p className="extension-page__notice" role="status">此插件页面当前不可用。</p>
  const Custom = page.component
  return <ExtensionBoundary key={`${page.identity.instanceId}:${page.id}:${context.sessionId ?? ''}:${attempt}`} onRetry={() => setAttempt(value => value + 1)}>
    <section className="extension-page" data-extension-id={page.identity.pluginId} data-extension-page={page.localId}>
      {Custom ? <Custom context={context} onNavigate={navigate} /> : page.declaration?.kind === 'webview' ? <Webview page={page} context={context} onNavigate={navigate} />
        : page.application ? <PluginRunner id={page.identity.pluginId} name={page.title} revision={page.identity.revision} initialTool={page.declaration?.kind === 'tool' ? page.declaration.tool : undefined} onBack={() => navigate('plugins')} onEdit={() => navigate('plugins')} /> : <p role="alert">插件没有可用的页面实现。</p>}
    </section>
  </ExtensionBoundary>
}
