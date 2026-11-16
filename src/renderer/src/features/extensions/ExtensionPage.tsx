import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { PluginRunner } from '@renderer/features/plugins/PluginRunner'
import { invokePluginCapability, invokePluginDevelopment, respondPluginAgent, streamPluginCapability, type PluginCapabilityStreamEvent, type PluginDevelopmentSession } from '@renderer/core/engine/plugins'
import { getEngineSource, isEngineReady } from '@renderer/core/engine/source'
import { currentAppearance, cssVar, watchTheme } from '@renderer/core/theme/palette'
import { PLUGIN_UI_THEME_TOKENS } from '@shared/plugin-ui'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionServices, invokeExtensionTool } from './host'
import { extensionId, type ExtensionContext, type ExtensionPage as ExtensionPageEntry } from './types'
import { requestExtensionPage } from './navigation'
import { extensionWebviewDocument } from './webview-document'
import { ExtensionServices } from './services'
import { browserAction, openPluginBrowserPage } from '../browser/browser-store'
import { Icon } from '@renderer/ui/icons'
import { NativeExtensionPage } from './NativeExtensionPage'
import { PluginRunInteraction, type PluginRunDecision, type PluginRunPending } from './PluginRunInteraction'
import { authorizeExtensionHost, executeExtensionCommand, extensionHostContext, invokeExtensionHostAction, subscribeExtensionEvents } from './interactions'
import './extensions.css'

class ExtensionBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('[extensions] 插件页面渲染失败', error, info.componentStack) }
  render(): ReactNode { return this.state.failed ? <div className="extension-page__notice" role="alert"><p>插件页面暂时无法显示。</p><button type="button" className="btn" onClick={this.props.onRetry}>重新打开</button></div> : this.props.children }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export function ExtensionWebview({ page, context, onNavigate, development }: { page: ExtensionPageEntry; context: ExtensionContext; onNavigate: (id: string) => void; development?: PluginDevelopmentSession }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null), current = useRef(true), pending = useRef(new Set<string>())
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const [ready, setReady] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, PluginRunDecision>>({})
  const channel = useMemo(() => crypto.randomUUID(), [page.identity.instanceId, page.localId])
  const active = useCallback(() => current.current && page.identity.source === getEngineSource() && isEngineReady() && (Boolean(development) || extensionRegistry.has(page.identity)), [page.identity, development])
  const registration = useMemo(() => development ? { identity: page.identity, application: page.application, contributes: page.application?.manifest.contributes ?? {} } : undefined, [development, page.identity, page.application])
  const serviceHost = useMemo(() => development && registration ? new ExtensionServices(async (_registration, tool, args, context) => invokePluginDevelopment(development, tool, args, context?.sessionId), active, () => registration) : extensionServices, [development, registration, active])
  useEffect(() => { if (registration) serviceHost.ensure(registration, context) }, [serviceHost, registration, context])
  useEffect(() => () => { if (development) { serviceHost.clear(); extensionServices.remove(page.identity) } }, [development, serviceHost, page.identity])
  const sendTheme = useCallback((): void => {
    if (!active()) return
    frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, event: 'theme', value: {
      appearance: currentAppearance(), tokens: Object.fromEntries(PLUGIN_UI_THEME_TOKENS.map(name => [name, cssVar(name)]))
    } }, '*')
  }, [channel, active])
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
  const services = useSyncExternalStore(serviceHost.subscribe, serviceHost.getSnapshot)
  const snapshots = (): unknown => serviceHost.getSnapshot().filter(service => service.instanceId === page.identity.instanceId && (!service.sessionId || service.sessionId === scopedContext.current.sessionId))
    .map(({ open: _open, stop: _stop, ...value }) => value)
  useEffect(() => { frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, event: 'services', value: snapshots() }, '*') }, [services, context.sessionId, channel])
  useEffect(() => {
    current.current = true
    const scope = { active: true }
    type Stream = { controller: AbortController; sequence: number; acknowledge?: (sequence: number) => void; runId?: string }
    const streams = new Map<string, Stream>()
    const subscriptions = new Map<string, string>(); let interestOff: (() => void) | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined, cursor: number | undefined, polling = false, stopped = false
    const poll = async (): Promise<void> => {
      if (stopped || polling || !subscriptions.size || !active()) return
      polling = true
      try {
        const result = await invokePluginCapability({ pluginId: page.identity.pluginId, revision: page.identity.revision, hash: page.identity.hash, devSessionId: development?.devSessionId, sessionId: scopedContext.current.sessionId, capability: 'events.subscribe', method: 'poll', args: { ...(cursor !== undefined ? { cursor } : {}), limit: 50 } })
        if (!stopped && active() && object(result) && Array.isArray(result.events)) {
          if (typeof result.nextCursor === 'number') cursor = result.nextCursor
          for (const event of result.events) for (const [subscription, type] of subscriptions) if (object(event) && (type === '*' || event.type === type)) frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, event: 'host-event', subscription, value: event }, '*')
        }
      } catch (cause) { if (!stopped) { setError(cause instanceof Error ? cause.message : String(cause)); subscriptions.clear(); interestOff?.(); interestOff = undefined } }
      finally { polling = false; if (!stopped && subscriptions.size) pollTimer = setTimeout(() => { void poll() }, 1500) }
    }
    const receive = async (event: MessageEvent): Promise<void> => {
      if (event.source !== frame.current?.contentWindow || !object(event.data) || event.data.aetherPlugin !== 1 || event.data.channel !== channel) return
      if (event.data.event === 'ready') { if (active()) setReady(true); return }
      if (event.data.event === 'stream-cancel') { if (typeof event.data.id === 'string') streams.get(event.data.id)?.controller.abort(); return }
      if (event.data.event === 'stream-ack') {
        const stream = typeof event.data.id === 'string' ? streams.get(event.data.id) : undefined
        if (typeof event.data.sequence === 'number') stream?.acknowledge?.(event.data.sequence)
        return
      }
      const { id, method, params } = event.data
      if (typeof id !== 'string' || id.length > 64 || typeof method !== 'string' || !object(params) || pending.current.has(id)) return
      const respond = (value?: unknown, error?: string): void => {
        if (active() || error) frame.current?.contentWindow?.postMessage({ aetherPlugin: 1, channel, id, value, error }, '*')
      }
      pending.current.add(id)
      try {
        const registered = registration ?? extensionRegistry.getRegistration(page.identity.pluginId)
        if (!registered || !active()) throw new Error('插件已关闭或引擎连接已变化。')
        let result: unknown
        if (method === 'context') result = { ...extensionHostContext(scopedContext.current), sessionId: scopedContext.current.sessionId ?? null, workspacePath: scopedContext.current.workspacePath ?? null, engineReady: Boolean(scopedContext.current.engineReady), pluginId: page.identity.pluginId, revision: page.identity.revision }
        else if (method === 'invoke') {
          const declaration = page.declaration
          if (declaration?.kind !== 'webview' || typeof params.tool !== 'string' || !declaration.tools.includes(params.tool) || !object(params.args)) throw new Error('此页面未声明该工具权限。')
          result = development ? await invokePluginDevelopment(development, params.tool, params.args, scopedContext.current.sessionId, extensionHostContext(scopedContext.current)) : await invokeExtensionTool(registered, params.tool, params.args, scopedContext.current)
        } else if (method === 'commands.execute') {
          if (typeof params.command !== 'string' || !object(params.args)) throw new Error('插件命令参数无效。')
          result = await executeExtensionCommand(registered, params.command, { ...scopedContext.current }, params.args, development, onNavigate)
        } else if (method.startsWith('ui.')) {
          result = await invokeExtensionHostAction(registered, { ...scopedContext.current }, method.slice(3), params, development)
        } else if (method === 'events.subscribe') {
          if (typeof params.event !== 'string' || !params.event) throw new Error('事件订阅无效。')
          await authorizeExtensionHost(registered, scopedContext.current, 'events.subscribe', development)
          interestOff ??= subscribeExtensionEvents(() => {})
          const subscription = crypto.randomUUID(); subscriptions.set(subscription, params.event); result = { subscription }
          clearTimeout(pollTimer); pollTimer = setTimeout(() => { void poll() }, 0)
        } else if (method === 'events.unsubscribe') {
          if (typeof params.subscription !== 'string') throw new Error('事件订阅标识无效。')
          subscriptions.delete(params.subscription); if (!subscriptions.size) { clearTimeout(pollTimer); interestOff?.(); interestOff = undefined }; result = null
        } else if (method === 'capability.stream') {
          if (!['ai.run', 'agents.manage'].includes(String(params.capability)) || params.method !== 'stream' || !object(params.args)) throw new Error('此能力不支持流式调用。')
          const bound = { ...scopedContext.current }, stream: Stream = { controller: new AbortController(), sequence: 0 }
          const source = getEngineSource(), identity = { pluginId: page.identity.pluginId, revision: page.identity.revision, hash: page.identity.hash, devSessionId: development?.devSessionId, sessionId: bound.sessionId }
          let parked: PluginRunPending | undefined, terminal = false
          streams.set(id, stream)
          const clearDecision = (): void => { if (scope.active) setDecisions(previous => { const next = { ...previous }; delete next[id]; return next }) }
          const valid = (): boolean => scope.active && active() && bound.sessionId === scopedContext.current.sessionId && bound.workspacePath === scopedContext.current.workspacePath && !stream.controller.signal.aborted
          const dispatch = async (value: PluginCapabilityStreamEvent): Promise<void> => {
            if (!valid()) throw new Error('插件会话或工作区已变化。')
            if (value.type === 'started' && value.runId) { stream.runId = value.runId; parked = undefined; clearDecision() }
            if (value.type === 'pending') {
              stream.runId = value.runId; parked = value
              setDecisions(previous => ({ ...previous, [id]: { event: value, ready: false, respond: async () => { throw new Error('正在准备确认请求。') }, cancel: () => stream.controller.abort() } }))
            }
            // A parked durable segment is not the plugin's final completion.
            if (value.type === 'complete' && object(value.result) && value.result.status === 'blocked') return
            await new Promise<void>((resolve, reject) => {
              const sequence = ++stream.sequence
              const finish = (error?: unknown): void => {
                stream.acknowledge = undefined; stream.controller.signal.removeEventListener('abort', cancelled)
                if (error !== undefined) reject(error); else resolve()
              }
              const cancelled = (): void => finish(stream.controller.signal.reason ?? new Error('插件任务已取消。'))
              stream.acknowledge = received => { if (received === sequence) finish() }
              stream.controller.signal.addEventListener('abort', cancelled, { once: true })
              try {
                const target = frame.current?.contentWindow
                if (!target) throw new Error('插件页面已关闭。')
                target.postMessage({ aetherPlugin: 1, channel, id, event: 'stream', sequence, value }, '*')
              } catch (error) { finish(error) }
            })
          }
          try {
            result = await streamPluginCapability({ ...identity, capability: String(params.capability), method: 'stream', args: params.args }, { signal: stream.controller.signal, onEvent: dispatch })
            while (object(result) && result.status === 'blocked') {
              if (!parked) throw new Error('插件任务已暂停，但未提供可确认的请求。')
              const request = parked
              stream.controller.signal.throwIfAborted()
              result = await new Promise<unknown>((resolve, reject) => {
                let responding = false
                const cancelled = (): void => { stream.controller.signal.removeEventListener('abort', cancelled); reject(stream.controller.signal.reason ?? new Error('插件任务已取消。')) }
                stream.controller.signal.addEventListener('abort', cancelled, { once: true })
                setDecisions(previous => ({ ...previous, [id]: { event: request, ready: true, cancel: () => stream.controller.abort(), respond: async output => {
                  if (!valid() || responding || parked !== request) throw new Error('当前确认请求已结束或变化。')
                  responding = true; let resumed = false
                  try {
                    const next = await respondPluginAgent({ ...identity, runId: request.runId, requestId: request.pending.requestId, toolCallId: request.pending.toolCallId, output }, {
                      signal: stream.controller.signal, onEvent: async value => {
                        if (value.type === 'started') resumed = true
                        // A rejected host answer has not resumed the plugin task; the card owns retry feedback.
                        if (value.type === 'error' && !resumed) return
                        await dispatch(value)
                      }
                    })
                    stream.controller.signal.removeEventListener('abort', cancelled); resolve(next)
                  } catch (error) {
                    responding = false
                    // A request rejected before resume keeps the real card available for retry.
                    if (resumed || !valid()) { stream.controller.signal.removeEventListener('abort', cancelled); reject(error) }
                    throw error
                  }
                } } }))
              })
            }
            terminal = true
          } finally {
            if (!terminal && params.capability === 'agents.manage' && stream.runId && source === getEngineSource()) void invokePluginCapability({ ...identity, capability: 'agents.manage', method: 'cancel', args: { runId: stream.runId } }).catch(() => {})
            stream.controller.abort(); streams.delete(id); clearDecision()
          }
        } else if (method === 'capability') {
          if (typeof params.capability !== 'string' || typeof params.method !== 'string' || !object(params.args)) throw new Error('平台能力参数无效。')
          result = await invokePluginCapability({ pluginId: page.identity.pluginId, revision: page.identity.revision, hash: page.identity.hash, devSessionId: development?.devSessionId, sessionId: scopedContext.current.sessionId, capability: params.capability, method: params.method, args: params.args })
        } else if (method === 'download') {
          if (!source) throw new Error('插件页面尚未就绪。')
          const { fileName, content, encoding } = params
          if (typeof fileName !== 'string' || fileName.length > 240 || typeof content !== 'string' ||
              (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64')) throw new Error('插件保存参数无效。')
          result = await window.aether.pluginUi.download(source, { fileName, content, encoding })
        } else if (method === 'navigate') {
          const target = typeof params.page === 'string' ? extensionId(page.identity.pluginId, params.page) : ''
          if (development ? !registered.contributes.pages?.some(item => item.id === params.page) : !extensionRegistry.getPage(target)) throw new Error('插件页面不存在。')
          onNavigate(target); result = null
        } else if (method === 'service.get') result = snapshots()
        else if (method === 'service.start' || method === 'service.stop' || method === 'service.status') {
          if (typeof params.id !== 'string' || !registered.contributes.services?.some(item => item.id === params.id)) throw new Error('插件服务不存在。')
          if (params.args !== undefined && !object(params.args)) throw new Error('服务参数需要 JSON 对象。')
          await serviceHost.action(extensionId(page.identity.pluginId, params.id), scopedContext.current, method === 'service.start' ? 'start' : method === 'service.stop' ? 'stop' : 'status', params.args as Record<string, unknown> | undefined)
          result = snapshots()
        } else throw new Error('插件请求的方法不受支持。')
        respond(result)
      } catch (cause) { respond(undefined, cause instanceof Error ? cause.message : String(cause)) }
      finally { pending.current.delete(id) }
    }
    const listener = (event: MessageEvent): void => { void receive(event) }
    window.addEventListener('message', listener)
    return () => { scope.active = false; stopped = true; for (const stream of streams.values()) stream.controller.abort(); streams.clear(); setDecisions({}); subscriptions.clear(); clearTimeout(pollTimer); interestOff?.(); current.current = false; pending.current.clear(); window.removeEventListener('message', listener) }
  }, [channel, page, onNavigate, source, development, registration, serviceHost, active, context.sessionId, context.workspacePath])
  if (!html) return <p className="extension-page__notice" role="alert">{development ? '插件页面文件不可用，请检查源码后刷新本地工程。' : '插件页面文件不可用，请重新发布插件。'}</p>
  return <div className="extension-page__webview" aria-busy={!ready && !error}>{error ? <p role="alert">{error}</p> : null}{source ? <iframe ref={frame} title={page.title} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={source} inert={Object.keys(decisions).length > 0} tabIndex={ready ? 0 : -1} aria-hidden={!ready} data-ready={ready} onLoad={sendTheme} onError={() => setError('插件页面加载失败。')} /> : null}{!ready && !error ? <div className="extension-page__loading" role="status">正在打开插件…</div> : null}{Object.keys(decisions).length ? <div className="extension-page__interactions">{Object.entries(decisions).map(([id, decision]) => <PluginRunInteraction key={`${id}:${decision.event.runId}:${decision.event.pending.requestId}`} decision={decision} pluginName={page.title} />)}</div> : null}</div>
}

export function ExtensionPage({ contributionId, context, onNavigate }: { contributionId: string; context: ExtensionContext; onNavigate?: (id: string) => void }): JSX.Element {
  useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  const page = extensionRegistry.getPage(contributionId), [attempt, setAttempt] = useState(0)
  const navigate = useMemo(() => onNavigate ?? ((id: string) => requestExtensionPage(id, context.sessionId ?? undefined, context)), [onNavigate, context.sessionId, context.workspacePath, context.engineReady, context.messageId, context.messageRole, context.filePath, context.selectionText, context.targetId])
  if (!page || !extensionVisible(page.scope, page.when, context)) return <p className="extension-page__notice" role="status">此插件页面当前不可用。</p>
  const Custom = page.component
  return <ExtensionBoundary key={`${page.identity.instanceId}:${page.id}:${context.sessionId ?? ''}:${attempt}`} onRetry={() => setAttempt(value => value + 1)}>
    <section className="extension-page" data-extension-id={page.identity.pluginId} data-extension-page={page.localId} data-extension-session={context.sessionId ?? undefined}>
      {page.declaration?.kind === 'webview' ? <div className="extension-page__toolbar"><button type="button" className="btn btn--icon btn--ghost" aria-label="在浏览器中打开插件" title="在浏览器中打开" onClick={() => browserAction(() => openPluginBrowserPage(page, context))}><Icon name="globe" size={16} /></button></div> : null}
      {Custom ? <Custom context={context} onNavigate={navigate} /> : page.declaration?.kind === 'webview' ? <ExtensionWebview page={page} context={context} onNavigate={navigate} />
        : page.declaration?.kind === 'native' ? <NativeExtensionPage page={page} context={context} onNavigate={navigate} />
        : page.application ? <PluginRunner id={page.identity.pluginId} name={page.title} revision={page.identity.revision} sessionId={context.sessionId} initialTool={page.declaration?.kind === 'tool' ? page.declaration.tool : undefined} onBack={() => navigate('plugins')} onEdit={() => navigate('plugins')} /> : <p role="alert">插件没有可用的页面实现。</p>}
    </section>
  </ExtensionBoundary>
}
