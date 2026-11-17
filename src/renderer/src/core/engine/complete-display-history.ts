import type { EngineRequestResult } from '@shared/ipc'
import { cacheDisplayHistory, checkDisplayHistory, type DisplayHistoryCache, type DisplayHistoryPage } from './display-history'

export class DisplayHistoryUnsupportedError extends Error {
  constructor() {
    super('当前引擎暂不支持完整对话浏览，当前显示的是可恢复记录；请更新引擎后重新加载')
    this.name = 'DisplayHistoryUnsupportedError'
  }
}

interface CompleteDisplayHistoryOptions {
  sessionId: string
  previous?: DisplayHistoryCache | null
  userMessageId?: string
  request: (anchorMessageId: string | undefined, limit: number) => Promise<EngineRequestResult<unknown>>
  current: () => boolean
}

function sameEpoch(left: DisplayHistoryPage, right: DisplayHistoryPage): boolean {
  return left.mutationRevision === right.mutationRevision && left.grouping === right.grouping
}

/** Build a complete opening transcript without publishing intermediate pages.
 * Appends may extend the index during the read; a later tail refresh owns those
 * new turns, while destructive edits restart this transaction at most once. */
export async function loadCompleteDisplayHistory({ sessionId, previous, userMessageId, request, current }: CompleteDisplayHistoryOptions):
  Promise<{ cache: DisplayHistoryCache; missingAnchor: boolean } | null> {
  const limit = 10
  let cache = previous?.sessionId === sessionId ? previous : null
  let missingAnchor = false
  for (let attempt = 0; attempt < 2; attempt++) {
    let anchor = attempt === 0 ? userMessageId : undefined
    let epoch: DisplayHistoryPage | undefined
    let wanted: ReadonlySet<string> | undefined
    const requested = new Set<string>()
    while (true) {
      if (!current()) return null
      const result = await request(anchor, limit)
      if (!current()) return null
      if (!result.ok) {
        if (anchor && result.code === 40400) {
          if (anchor === userMessageId) missingAnchor = true
          break
        }
        if ([404, 405, 501, 50101].includes(result.code)) throw new DisplayHistoryUnsupportedError()
        throw new Error(result.message || '加载完整对话失败，请重试')
      }
      const page = checkDisplayHistory(result.data, anchor, limit)
      const changed = epoch ? !sameEpoch(epoch, page) : Boolean(anchor && cache && !sameEpoch(cache.page, page))
      if (!changed && wanted) {
        const indexed = new Set(page.turns.map(turn => turn.userMessageId))
        if ([...wanted].some(id => !indexed.has(id))) throw new Error('历史记录在加载期间发生变化，请重新加载')
      }
      cache = cacheDisplayHistory(sessionId, page, cache)
      if (changed) break
      epoch ??= page
      const expected = wanted ?? new Set(page.turns.map(turn => turn.userMessageId))
      wanted ??= expected
      if (anchor) {
        if (!cache.bodies.has(anchor)) throw new Error('完整对话记录缺少正文，请重新加载')
        requested.add(anchor)
      }
      const missing = page.turns.find(turn => expected.has(turn.userMessageId) && !cache!.bodies.has(turn.userMessageId))
      if (!missing) return { cache, missingAnchor: missingAnchor || Boolean(userMessageId && !cache.bodies.has(userMessageId)) }
      if (requested.has(missing.userMessageId)) throw new Error('完整对话记录加载没有进展，请重新加载')
      anchor = missing.userMessageId
    }
  }
  throw new Error('历史记录在加载期间有更新，请重新加载')
}
