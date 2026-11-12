import type { BrowserTabState } from '@shared/browser'
import type { BrowserConnectionState } from '@shared/browser-api'
import { assertEngineSource, getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { getBrowserSurfaceOwner } from '@renderer/core/browser/presentation'
import type { ClientSurfaceScope } from '@renderer/core/platform/surface-scope'
import { toast } from '@renderer/core/toast'
import { pushPendingMention } from '../conversation/shared/pending-mentions'
import type { Mention } from '../conversation/shared/mention-context'
import { getSessionState } from '../sessions/state'

/** Sharing grants access to the exact page; the reference separately tells the composer which page the user selected. */
export async function addBrowserTabToChat(tab: BrowserTabState, connection: BrowserConnectionState, mode: ClientSurfaceScope): Promise<void> {
  if (tab.localFile) throw new Error('本地文件仅供本机预览，如需交给 AI，请通过会话附件添加。')
  const { sessionId, engineId } = connection
  if (connection.status !== 'connected' || !sessionId || !engineId) throw new Error('请先连接引擎并打开一个会话')
  const source = getEngineSource()
  const storage = getEngineStorageKey()
  const assertTarget = (): void => {
    assertEngineSource(source)
    const state = getSessionState(storage)
    const currentSession = state.activeTaskId ?? state.homeSessionId
    if (mode !== 'work' || getBrowserSurfaceOwner().mode !== mode || currentSession !== sessionId) throw new Error('当前会话已切换，请在目标会话重新添加网页')
  }
  assertTarget()
  const shared = await window.aether.browser.share(tab.tabId, { sessionId, engineId })
  assertTarget()
  const current = await window.aether.browser.getConnection()
  assertTarget()
  if (current.status !== 'connected' || current.sessionId !== sessionId || current.engineId !== engineId) throw new Error('浏览器连接已变化，请重新添加网页')
  const mention: Mention = {
    source: 'browser', path: shared.tabId, displayText: shared.title || shared.url || '浏览器网页',
    // Page titles and URLs are untrusted data, never executable instructions or filesystem paths.
    content: JSON.stringify({ tabId: shared.tabId, title: shared.title, url: shared.url, sessionId, engineId }, null, 2)
  }
  pushPendingMention(mention, { sessionId, source })
  toast.success('网页已添加到当前会话')
}
