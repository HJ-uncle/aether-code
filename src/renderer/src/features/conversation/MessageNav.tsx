import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { DisplayHistoryTurn } from '@renderer/core/engine/display-history'
import { toast } from '@renderer/core/toast'
import { MessageNavRail, type NavTurn } from './shared/MessageNavRail'
import { userMessageText } from './shared/mention-context'
import { sessionNavigationTarget, sessionNavigationTurns, type SessionNavigationGroup } from './message-nav'
import './message-nav.css'

const TURN_SELECTOR = '.work-conversation__content > .work-conversation-turn[data-turn-id]'

export function MessageNav({
  sessionKey, messages, groups, historyIndex, loadedTurnIds, onLoadTurn, firstId, scrollRef, onWindowChange, onInspectHistory, onLatest
}: {
  /** Include engine source as well as task id so marks never cross engines. */
  sessionKey: string
  messages: ChatMessage[]
  groups: readonly SessionNavigationGroup[]
  historyIndex?: readonly DisplayHistoryTurn[] | null
  loadedTurnIds?: readonly string[]
  onLoadTurn?: (userMessageId: string) => Promise<boolean>
  firstId: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  onWindowChange: (firstId: string) => void
  /** Pause following and retain the selected window while new messages arrive. */
  onInspectHistory: () => void
  /** Host also handles returning from an unversioned archive page. */
  onLatest: () => void
}): JSX.Element {
  const turns = useMemo(() => sessionNavigationTurns(groups, historyIndex, loadedTurnIds), [groups, historyIndex, loadedTurnIds])
  const pending = useRef<{ userId: string; top: boolean; ready: boolean } | null>(null)
  const pendingCopy = useRef<string | null>(null)
  const current = useRef({ messages, groups, sessionKey, onLoadTurn, loadedTurnIds, historyIndex })
  current.current = { messages, groups, sessionKey, onLoadTurn, loadedTurnIds, historyIndex }
  const generation = useRef(0)
  useLayoutEffect(() => {
    generation.current++
    pending.current = null
    pendingCopy.current = null
    return () => { generation.current++; pendingCopy.current = null }
  }, [sessionKey])
  const [request, setRequest] = useState(0)
  const scrollToTurn = useCallback((turnId: string, top = false): boolean => {
    const container = scrollRef.current
    if (!container) return false
    const anchor = Array.from(container.querySelectorAll<HTMLElement>(TURN_SELECTOR))
      .find(node => node.dataset.turnId === turnId)
    if (!anchor) return false
    container.scrollTop = top ? 0 : Math.max(0,
      anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8)
    return true
  }, [scrollRef])
  const navigate = useCallback((turn: NavTurn, top = false): void => {
    onInspectHistory()
    const { loadedTurnIds: loaded, historyIndex: index, onLoadTurn: load } = current.current
    const needsLoad = Boolean(index?.some(entry => entry.userMessageId === turn.message.id) && !loaded?.includes(turn.message.id))
    const target = { userId: turn.message.id, top, ready: !needsLoad }
    const scope = ++generation.current
    pending.current = target
    setRequest(value => value + 1)
    if (needsLoad && load) void load(turn.message.id).then(ok => {
      if (scope !== generation.current || pending.current !== target) return
      if (ok) target.ready = true
      else pending.current = null
      setRequest(value => value + 1)
    })
  }, [onInspectHistory])
  useLayoutEffect(() => {
    const target = pending.current
    if (!target?.ready) return
    const group = groups.find(group => group.messages.some(message => message.id === target.userId))
    if (!group) return
    if (scrollToTurn(group.id, target.top)) { pending.current = null; return }
    const window = sessionNavigationTarget(messages, groups, group.id)
    if (window) onWindowChange(window.firstId)
  }, [firstId, groups, messages, onWindowChange, request, scrollToTurn])
  const top = useCallback(() => { if (turns[0]) navigate(turns[0], true) }, [navigate, turns])
  const latest = useCallback(() => {
    generation.current++
    pending.current = null
    onLatest()
  }, [onLatest])
  const copyText = useCallback((message: ChatMessage): void => {
    void navigator.clipboard.writeText(userMessageText(message.content))
      .then(() => toast.success('已复制'), () => toast.error('复制失败，请重试'))
  }, [])
  const copy = useCallback((message: ChatMessage) => {
    // Never copy the abbreviated index preview as though it were the prompt.
    const existing = current.current.messages.find(item => item.id === message.id)
    if (existing) { copyText(existing); return }
    const key = current.current.sessionKey
    pendingCopy.current = message.id
    void current.current.onLoadTurn?.(message.id).then(ok => {
      if (current.current.sessionKey !== key || pendingCopy.current !== message.id) return
      if (!ok) pendingCopy.current = null
      setRequest(value => value + 1)
    })
  }, [copyText])
  useLayoutEffect(() => {
    const message = messages.find(item => item.id === pendingCopy.current)
    if (message) { pendingCopy.current = null; copyText(message) }
  }, [messages, request, copyText])

  // Work mutations keep their existing confirmation and controller guards in
  // the message actions. This navigator only reads, copies and marks turns.
  // Keep the rail's footprint during loading and short conversations so the
  // message column never shifts beneath the fixed running-service button.
  return <div className="work-message-nav-slot">
    <MessageNavRail sessionId={`work:${sessionKey}`} turns={turns} containerRef={scrollRef}
      turnSelector={TURN_SELECTOR} navigationKey={`${firstId ?? ''}:${request}`}
      onNavigate={navigate} onTop={top} onBottom={latest} onCopy={copy} disabled
      className="work-message-nav" />
  </div>
}
