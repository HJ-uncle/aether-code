import type { BrowserTabState } from '@shared/browser'
import type { BrowserConnectionState } from '@shared/browser-api'
import { getAppSettings } from '@renderer/core/app-provider'
import { assertEngineSource, getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { getAppMode, type AppMode } from '@renderer/core/platform/app-mode'
import { toast } from '@renderer/core/toast'
import { pushPendingMention } from '../chat/pending-mentions'
import { mentionToken, type Mention } from '../chat/mention-context'
import { getWorkDraft, getWorkState, updateWorkDraft, flushWorkDrafts } from '../work/work-state'

/** Sharing grants access to the exact page; the reference separately tells the composer which page the user selected. */
export async function addBrowserTabToChat(tab: BrowserTabState, connection: BrowserConnectionState, mode: AppMode): Promise<void> {
  const { sessionId, engineId } = connection
  if (connection.status !== 'connected' || !sessionId || !engineId) throw new Error('请先连接引擎并打开一个会话')
  const source = getEngineSource()
  const storage = getEngineStorageKey()
  const workTaskId = mode === 'work' ? getWorkState(storage).activeTaskId : null
  const assertTarget = (): void => {
    assertEngineSource(source)
    const work = getWorkState(storage)
    const currentSession = mode === 'work' ? work.activeTaskId ?? work.homeSessionId : getAppSettings().lastSessionId
    if (getAppMode() !== mode || currentSession !== sessionId) throw new Error('当前会话已切换，请在目标会话重新添加网页')
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
  if (mode === 'work') {
    const draft = getWorkDraft(storage, workTaskId)
    const prefix = draft.text + (draft.text && !/\s$/.test(draft.text) ? ' ' : '')
    updateWorkDraft(storage, workTaskId, prefix + mentionToken(mention) + ' ', [...draft.mentions, { ...mention, textOffset: prefix.length }])
    flushWorkDrafts(storage)
  } else pushPendingMention(mention, { sessionId, source })
  toast.success('网页已添加到当前会话')
}
