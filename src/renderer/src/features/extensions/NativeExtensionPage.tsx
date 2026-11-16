import { useMemo, useRef, useState, type JSX } from 'react'
import { Select } from '@renderer/ui/Select'
import { Markdown } from '../conversation/shared/Markdown'
import { invokePluginDevelopment, type PluginDevelopmentSession } from '@renderer/core/engine/plugins'
import { invokeExtensionTool } from './host'
import { extensionRegistry } from './registry'
import { executeExtensionCommand, extensionHostContext } from './interactions'
import { nativeInitialValues, parseNativeDocument, resolveNativeArgs, type NativeAction, type NativeNode } from './native-document'
import type { ExtensionContext, ExtensionPage } from './types'

export function NativeExtensionPage({ page, context, development, onNavigate }: { page: ExtensionPage; context: ExtensionContext; development?: PluginDevelopmentSession; onNavigate: (id: string) => void }): JSX.Element {
  const document = useMemo(() => parseNativeDocument(page.application?.uiDocuments?.[page.localId] ?? ''), [page.application, page.localId])
  const [values, setValues] = useState(() => nativeInitialValues(document.root)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<unknown>()
  const lock = useRef(false)
  const run = async (action: NativeAction): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setResult(undefined)
    const registration = development ? { identity: page.identity, application: page.application, contributes: page.application?.manifest.contributes ?? {} } : extensionRegistry.getRegistration(page.identity.pluginId)
    try {
      if (!registration) throw new Error('插件已关闭。')
      const args = resolveNativeArgs(action.args ?? {}, values)
      if (action.command) setResult(await executeExtensionCommand(registration, action.command, context, args, development, onNavigate))
      else {
        if (page.declaration?.kind !== 'native' || !page.declaration.tools.includes(action.tool!)) throw new Error('此原生页面未声明该工具权限。')
        setResult(development ? await invokePluginDevelopment(development, action.tool!, args, context.sessionId, extensionHostContext(context)) : await invokeExtensionTool(registration, action.tool!, args, context))
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { lock.current = false; setBusy(false) }
  }
  const render = (node: NativeNode, key: string): JSX.Element => {
    const value = node.bind ? values[node.bind] : node.value, label = node.label ?? node.text ?? node.bind ?? node.id ?? '字段'
    const update = (next: string | boolean): void => { if (node.bind) setValues(previous => ({ ...previous, [node.bind!]: next })) }
    const children = node.children?.map((child, index) => render(child, `${key}.${index}`))
    if (node.type === 'heading') return <h2 key={key}>{node.text}</h2>
    if (node.type === 'divider') return <hr key={key} />
    if (node.type === 'button') return <button key={key} type="button" className={`btn${node.variant === 'primary' ? ' btn--primary' : node.variant === 'danger' ? ' btn--danger' : ''}`} disabled={busy || !node.action} onClick={() => { if (node.action) void run(node.action) }}>{label}</button>
    if (node.type === 'input' || node.type === 'textarea') return <label key={key} className="extension-native__field"><span>{label}</span>{node.type === 'input' ? <input className="ui-input" aria-label={label} value={String(value ?? '')} placeholder={node.placeholder} disabled={busy || !node.bind} onChange={event => update(event.target.value)} /> : <textarea className="ui-input" aria-label={label} value={String(value ?? '')} placeholder={node.placeholder} disabled={busy || !node.bind} onChange={event => update(event.target.value)} />}</label>
    if (node.type === 'select') return <label key={key} className="extension-native__field"><span>{label}</span><Select ariaLabel={label} value={String(value ?? '')} options={node.options ?? []} disabled={busy || !node.bind} onChange={update} /></label>
    if (node.type === 'checkbox') return <label key={key} className="extension-native__check"><input type="checkbox" checked={Boolean(value)} disabled={busy || !node.bind} onChange={event => update(event.target.checked)} /><span>{label}</span></label>
    if (node.type === 'image') return <img key={key} src={node.src} alt={node.alt ?? ''} className="extension-native__image" />
    if (node.type === 'markdown') return <Markdown key={key} text={node.text ?? ''} renderImages={false} readOnly />
    if (['stack', 'row', 'card'].includes(node.type)) return <div key={key} className={`extension-native__${node.type}`}>{node.label ? <strong>{node.label}</strong> : null}{children}</div>
    return <p key={key} className="extension-native__text">{node.text}</p>
  }
  return <div className="extension-native" aria-busy={busy}>{render(document.root, 'root')}{error ? <p role="alert">{error}</p> : null}{result !== undefined ? <pre className="extension-native__result" aria-label="插件操作结果">{JSON.stringify(result, null, 2)}</pre> : null}</div>
}
