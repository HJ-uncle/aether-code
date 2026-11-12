import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getSubagentProtocol, request } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { SubagentRun } from '@shared/subagent'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import type { ChatFileContext } from '../chat/chat-link'
import { getSessionMeta } from '../history/session-meta'
import { loadFullWorkSubagentTranscript, WorkTranscriptSupersededError, type WorkTranscriptWindow } from './work-subagent-transcript'
import { workSubagentErrorText, workSubagentMessages } from './work-subagent-messages'
import { workMessageTimeline } from './work-message-timeline'
import { WorkMessageContent } from './WorkMessageContent'
import { WorkSubagentInstruction } from './WorkSubagentInstruction'
import { workSubagentInstructionTime } from './work-subagent-instruction'
import { workSubagentLiveMessage } from './work-subagent-live'
import { WorkErrorNotice } from './WorkErrorNotice'
import './work-subagent-transcript.css'

export interface WorkSubagentTranscriptMemory {
  window?: WorkTranscriptWindow
  scrollTop: number
  loaded?: boolean
  expanded: Map<string, number>
  opened: Set<string>
}
export function newWorkSubagentTranscriptMemory(): WorkSubagentTranscriptMemory {
  return { scrollTop: 0, expanded: new Map(), opened: new Set() }
}

const EMPTY_ROWS: NonNullable<WorkTranscriptWindow['rows']> = []

const TranscriptMessage = memo(function TranscriptMessage({ message, isRunning, fileContext, active }: {
  message: ChatMessage; isRunning: boolean; fileContext: ChatFileContext; active: boolean
}): JSX.Element {
  const segments = useMemo(() => workMessageTimeline(message), [message])
  const display = useMemo(() => isRunning ? { ...message, status: 'streaming' as const } : message, [message, isRunning])
  const errorText = workSubagentErrorText(message)
  const time = workSubagentInstructionTime(message.createdAt)
  return <div className="work-subagent-transcript__reply">
    {time ? <div className="work-subagent-transcript__message-meta"><span>代理</span><time dateTime={time.dateTime} title={time.title}>{time.label}</time></div> : null}
    <WorkMessageContent message={display} sessionId={fileContext.sessionId} fileContext={fileContext}
    active={active} readOnly defaultProcessOpen={false} defaultThinkingOpen={false} showAllContent turnSegments={segments}>
    {errorText ? <WorkErrorNotice compact className="work-subagent-transcript__failure" error={errorText}
      context={{ status: message.status === 'interrupted' ? 'interrupted' : message.status === 'aborted' ? 'cancelled' : 'failed',
        runId: message.runId ?? '', error: message.error }} /> : null}
    </WorkMessageContent>
  </div>
})

/** Opens and invocation transitions reconcile the complete archive. Reading
 * earlier prose retains its anchor while the live summary updates separately. */
export function WorkSubagentTranscript({ source, parentSessionId, childSessionId, runId, name, memory, active = true, running = false, status = '', refreshKey = 0, statusNote, liveRun, onHistoryLoaded }: {
  source: number; parentSessionId: string; childSessionId: string; runId: string; name: string; memory: WorkSubagentTranscriptMemory
  active?: boolean; running?: boolean; lastSeq?: number; status?: string; refreshKey?: number; statusNote?: string; liveRun?: SubagentRun; onHistoryLoaded?: () => void
}): JSX.Element {
  const { ready } = useApp()
  const [, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasNew, setHasNew] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const epoch = useRef(0)
  const pending = useRef(false)
  const dirty = useRef(false)
  const force = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastStarted = useRef(0)
  const drainRef = useRef<() => void>(() => {})
  const manualRevision = useRef(refreshKey)
  const followingTail = useRef(true)
  const anchor = useRef<{ id: string; top: number } | { scrollTop: number } | 'tail' | null>(null)
  const redraw = useCallback((): void => setRevision(value => value + 1), [])
  const workspaceRoot = getSessionMeta(parentSessionId).workspacePath
  const fileContext = useMemo<ChatFileContext>(() => ({ sessionId: childSessionId, receiptParentSessionId: parentSessionId, workspaceRoot }), [childSessionId, parentSessionId, workspaceRoot])
  const captureAnchor = (followTail: boolean): void => {
    const container = scroller.current
    if (!container) return
    if (followTail) { anchor.current = 'tail'; return }
    const top = container.getBoundingClientRect().top
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.getBoundingClientRect().bottom > top)
    if (row?.dataset.messageId) anchor.current = { id: row.dataset.messageId, top: row.getBoundingClientRect().top - top }
  }
  const schedule = (explicit = false): void => {
    dirty.current = true
    force.current ||= explicit
    if (!active || !ready || pending.current || timer.current !== undefined) return
    timer.current = setTimeout(() => { timer.current = undefined; drainRef.current() }, Math.max(0, 1200 - (Date.now() - lastStarted.current)))
  }
  const load = async (followTail: boolean): Promise<void> => {
    if (!active || !ready || pending.current) return
    if (!memory.window && memory.loaded && !followTail) anchor.current = { scrollTop: memory.scrollTop }
    else captureAnchor(followTail)
    pending.current = true
    lastStarted.current = Date.now()
    setLoading(true)
    setError('')
    const generation = epoch.current
    const expectedEngine = getExpectedEngine()
    const current = (): boolean => generation === epoch.current && source === getEngineSource()
    try {
      const subagentProtocol = await getSubagentProtocol()
      if (!current()) return
      const previous = memory.window
      const next = await loadFullWorkSubagentTranscript({ source, parentSessionId, childSessionId, runId, subagentProtocol }, input => request({ ...input, expectedEngine }), current)
      if (!current()) return
      memory.window = next
      memory.loaded = true
      onHistoryLoaded?.()
      // Disclosure keys follow replayed message IDs, which may be synthetic;
      // retain them for this bounded child conversation, not raw archive IDs.
      if (memory.expanded.size || memory.opened.size) {
        const keys = new Set(workSubagentMessages(next.rows).map(message => message.id))
        for (const key of memory.expanded.keys()) if (!keys.has(key)) memory.expanded.delete(key)
        for (const key of memory.opened) if (!keys.has(key)) memory.opened.delete(key)
      }
      setHasNew(Boolean(previous && !followTail && next.rows.length > previous.rows.length))
      redraw()
    } catch (cause) {
      if (current() && !(cause instanceof WorkTranscriptSupersededError)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) {
        pending.current = false; setLoading(false)
        // A revision received during the request must get a trailing read.
        if (dirty.current) schedule()
      }
    }
  }
  drainRef.current = (): void => {
    if (!dirty.current || !active || !ready || pending.current) return
    dirty.current = false
    const explicit = force.current
    force.current = false
    void load(explicit || (memory.window ? followingTail.current : !memory.loaded))
  }
  useEffect(() => {
    epoch.current++
    pending.current = false
    setLoading(false); setError(''); setHasNew(false)
    lastStarted.current = 0
    return () => { epoch.current++; if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined }
  }, [source, parentSessionId, childSessionId, runId, active, ready, memory])
  useEffect(() => {
    // An explicit refresh belongs to the selected child, not to the next
    // detail opened while that request is in flight.
    dirty.current = false; force.current = false; anchor.current = null
  }, [source, parentSessionId, childSessionId, memory])
  useEffect(() => {
    const explicit = manualRevision.current !== refreshKey
    manualRevision.current = refreshKey
    schedule(explicit)
    // Run summaries already supply live prose/tool previews. Re-reading the
    // entire archive for each lastSeq token/tool update would erase the benefit
    // of collapsed process content. Settlement and new invocations reconcile it.
  }, [source, parentSessionId, childSessionId, runId, status, refreshKey, active, ready, memory])
  useLayoutEffect(() => { if (scroller.current && memory.window) scroller.current.scrollTop = memory.scrollTop }, [memory, active])
  useLayoutEffect(() => {
    const container = scroller.current, position = anchor.current
    if (!container || !position) return
    if (position === 'tail') { container.scrollTop = container.scrollHeight; followingTail.current = true }
    else if ('scrollTop' in position) container.scrollTop = position.scrollTop
    else {
      const row = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === position.id)
      if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - position.top
    }
    memory.scrollTop = container.scrollTop
    anchor.current = null
  }, [memory.window])
  const rows = memory.window?.rows ?? EMPTY_ROWS
  // Opening an instruction or receiving a live token must not replay every
  // historical tool. Completed assistant rows also retain stable memo props.
  const messages = useMemo(() => workSubagentMessages(rows), [rows])
  const lastAssistant = useMemo(() => messages.findLast(item => item.role === 'assistant'), [messages])
  const liveMessage = useMemo(() => memory.window ? workSubagentLiveMessage(liveRun, childSessionId, messages) : undefined, [memory.window, liveRun, childSessionId, messages])
  const window = memory.window
  return <section className="work-subagent-transcript" aria-label={`${name} 的对话`}>
    {error ? <div className="work-subagent-transcript__error" role="alert"><span>{error}</span><button type="button" disabled={!ready || loading} onClick={() => schedule(true)} aria-label="重新读取子代理对话" title="重新读取"><Icon name="refresh" size={14} /></button></div> : null}
    <div className="work-subagent-transcript__scroll work-conversation__scroll" ref={scroller} onScroll={event => {
      const node = event.currentTarget
      if (memory.window) memory.scrollTop = node.scrollTop
      followingTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
    }} aria-busy={loading}>
      {window && (window.endpoint === '/conversation/history' || window.backend !== 'jsonl') ? <p className="work-subagent-transcript__notice">当前引擎仅提供保留的历史，早期记录可能不完整。</p> : null}
      {messages.map(message => message.role === 'user'
        ? <WorkSubagentInstruction key={message.id} message={message} memory={memory} redraw={redraw} fileContext={fileContext} />
        : <TranscriptMessage key={message.id} message={message} fileContext={fileContext} active={active}
          isRunning={running && message === lastAssistant && message.runId === runId} />)}
      {liveMessage ? <div className="work-subagent-transcript__live" data-live-run-id={liveMessage.runId}>
        <p className="work-subagent-transcript__notice">实时进度</p>
        <WorkMessageContent message={liveMessage} sessionId={childSessionId} fileContext={fileContext} active={active} readOnly defaultProcessOpen={false} defaultThinkingOpen={false} showAllContent />
      </div> : null}
      {statusNote && !messages.some(message => message.runId === runId &&
        (message.error?.trim() === statusNote.trim() || message.content.includes(statusNote))) ?
        <WorkErrorNotice compact className="work-subagent-transcript__failure" error={statusNote}
          context={{ status: status === 'interrupted' ? 'interrupted' : status === 'cancelled' ? 'cancelled' : 'failed', runId, error: statusNote }} /> : null}
      {!messages.length ? <div className="work-subagent-transcript__empty" role="status">{loading ? <><Spinner size={18} /><p>正在读取对话…</p></> : window ? <><Icon name="chat" size={24} /><p>{running ? '正在等待代理写入消息…' : '此代理没有可用的对话记录。'}</p></> : <p>连接就绪后可读取此代理的对话。</p>}</div> : null}
    </div>
    {hasNew ? <button type="button" className="work-subagent-transcript__new" onClick={() => {
      followingTail.current = true
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      setHasNew(false)
    }}><Icon name="chevron-down" size={14} />查看最新消息</button> : null}
  </section>
}
