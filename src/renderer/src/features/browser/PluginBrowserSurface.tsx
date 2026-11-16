import { useCallback, type JSX } from 'react'
import { ExtensionWebview } from '../extensions/ExtensionPage'
import { getPluginBrowserDocument, navigatePluginBrowserPage } from './browser-store'

/** Browser chrome hosts the same opaque iframe as the plugin page; website views get no SDK. */
export function PluginBrowserSurface({ tabId }: { tabId: string }): JSX.Element {
  const document = getPluginBrowserDocument(tabId)
  const navigate = useCallback((page: string) => navigatePluginBrowserPage(tabId, page), [tabId])
  if (!document) return <div className="browser-empty" role="status">插件页面已关闭。</div>
  return <div className="browser-plugin-surface" data-plugin-browser-tab={tabId}>
    <ExtensionWebview key={`${tabId}:${document.generation}`} page={document.page} context={document.context} development={document.development} onNavigate={navigate} />
  </div>
}
