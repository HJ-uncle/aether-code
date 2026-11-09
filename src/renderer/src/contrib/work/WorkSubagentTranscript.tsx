import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getSubagentProtocol, request } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { SubagentRun } from '@shared/subagent'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import type { ChatFileContext } from '../chat/chat-link'
import { getSessionMeta } from '../history/session-meta'
import { loadWorkSubagentTranscript, SUBAGENT_TRANSCRIPT_PAGE_SIZE, WorkTranscriptSupersededError, type WorkTranscriptWindow } from './work-subagent-transcript'
import { workSubagentErrorText, workSubagentFinalAnswer, workSubagentMessages } from './work-subagent-messages'
import { workMessageTimeline } from './work-message-timeline'
import { WorkMessageContent, WorkUserMessageBody } from './WorkMessageContent'
import { userMessageText } from '../chat/mention-context'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { workSubagentLiveMessage } from './work-subagent-live'
import { WorkErrorNotice } from './WorkErrorNotice'
import './work-subagent-transcript.css'

export interface WorkSubagentTranscriptMemory {
  window?: WorkTranscriptWindow
  scrollTop: number
  visibleCount: number
  expanded: Map<string, number>
  opened: Set<string>
}
export function newWorkSubagentTranscriptMemory(): WorkSubagentTranscriptMemory {
  return { scrollTop: 0, visibleCount: SUBAGENT_TRANSCRIPT_PAGE_SIZE, expanded: new Map(), opened: new Set() }
}

function TranscriptMessage({ message, messages, running, runId, memory, redraw, fileContext, active }: {
  message: ChatMessage; messages: ChatMessage[]; running: boolean; runId: string; memory: WorkSubagentTranscriptMemory
  redraw: () => void; fileContext: ChatFileContext; active: boolean
}): JSX.Element {
  const lastAssistant = messages.findLast(item => item.role === 'assistant')
  // Legacy child rows carry the parent's rootRunId. Only an exact invocation
  // identity proves this message belongs to the currently running child.
  const isRunning = running && message === lastAssistant && message.runId === runId
  if (message.role === 'user') return <TranscriptInstruction message={message} memory={memory} redraw={redraw} fileContext={fileContext} />
  const segments = workMessageTimeline(message)
  const answer = isRunning ? false : workSubagentFinalAnswer(message, messages)
  const display = { ...message, status: isRunning ? 'streaming' as const : message.status }
  const errorText = workSubagentErrorText(message)
  return <WorkMessageContent message={display} sessionId={fileContext.sessionId} fileContext={fileContext}
    active={active} readOnly defaultProcessOpen={false} turnSegments={segments} finalAnswer={answer}>
    {errorText ? <WorkErrorNotice compact className="work-subagent-transcript__failure" error={errorText}
      context={{ status: message.status === 'interrupted' ? 'interrupted' : message.status === 'aborted' ? 'cancelled' : 'failed',
        runId: message.runId ?? '', error: message.error }} /> : null}
  </WorkMessageContent>
}

function TranscriptInstruction({ message, memory, redraw, fileContext }: {
  message: ChatMessage; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext
}): JSX.Element {
  const open = memory.opened.has(message.id)
  const container = useRef<HTMLElement>(null)
  const collapseTop = useRef<number | null>(null)
  const contentId = `agent-instruction-${useId().replace(/:/g, '')}`
  const preview = useMemo(() => {
    const text = userMessageText(message.content).replace(/\s+/g, ' ').trim()
    return text.length > 180 ? `${text.slice(0, 177)}…` : text || (message.attachments?.length ? '查看任务附件' : '查看任务指令')
  }, [message.content, message.attachments?.length])
  useLayoutEffect(() => {
    if (open || collapseTop.current === null) return
    const article = container.current, scroll = article?.closest('.work-conversation__scroll')
    if (article && scroll) scroll.scrollTop += article.getBoundingClientRect().top - collapseTop.current
    collapseTop.current = null
  }, [open])
  return <article className={`work-message work-message--user work-subagent-instruction${open ? ' is-open' : ''}`}
    ref={container} data-message-id={message.id} aria-label="用户消息">
    <button type="button" className="work-subagent-instruction__summary" aria-expanded={open} aria-controls={contentId}
      aria-label={open ? '收起任务指令' : '展开任务指令'} onClick={() => {
        if (open) {
          const article = container.current, scroll = article?.closest('.work-conversation__scroll')
          if (article && scroll && article.getBoundingClientRect().top < scroll.getBoundingClientRect().top)
            collapseTop.current = scroll.getBoundingClientRect().top
          memory.opened.delete(message.id)
        } else memory.opened.add(message.id)
        redraw()
      }}>
      <span>{open ? '任务指令' : preview}</span><Icon name="chevron-down" size={13} />
    </button>
    <MotionPresence show={open} className="work-subagent-instruction__body" id={contentId}>
      <WorkUserMessageBody message={message} root={fileContext.workspaceRoot ?? null} fileContext={fileContext} collapsible={false} />
    </MotionPresence>
  </article>
}

/** Reads are coalesced from real run revisions. Reading older messages never
 * gets displaced by a live tail update; the reader can explicitly return. */
export function WorkSubagentTranscript({ source, parentSessionId, childSessionId, runId, name, memory, active = true, running = false, lastSeq = 0, status = '', refreshKey = 0, statusNote, liveRun }: {
  source: number; parentSessionId: string; childSessionId: string; runId: string; name: string; memory: WorkSubagentTranscriptMemory
  active?: boolean; running?: boolean; lastSeq?: number; status?: string; refreshKey?: number; statusNote?: string; liveRun?: SubagentRun
}): JSX.Element {
  const { ready } = useApp()
  const [revision, setRevision] = useState(0)
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
  const anchor = useRef<{ id: string; top: number } | 'tail' | null>(null)
  const redraw = (): void => setRevision(value => value + 1)
  const fileContext: ChatFileContext = { sessionId: childSessionId, receiptParentSessionId: parentSessionId, workspaceRoot: getSessionMeta(parentSessionId).workspacePath }
  const atTail = (): boolean => {
    const window = memory.window
    return (!window || window.lastPage >= Math.ceil(window.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE)) &&
      followingTail.current
  }
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
  const load = async (action: 'older' | 'newer' | 'refresh', followTail = false): Promise<void> => {
    if (!active || !ready || pending.current) return
    captureAnchor(followTail)
    if (action === 'older') followingTail.current = false
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
      const next = await loadWorkSubagentTranscript({ source, parentSessionId, childSessionId, runId, subagentProtocol }, input => request({ ...input, expectedEngine }), current, previous, action)
      if (!current()) return
      if (previous) memory.visibleCount += Math.max(0, next.rows.length - previous.rows.length)
      memory.window = next
      memory.visibleCount = Math.min(next.rows.length, Math.max(SUBAGENT_TRANSCRIPT_PAGE_SIZE, memory.visibleCount))
      // Disclosure keys follow replayed message IDs, which may be synthetic;
      // retain them for this bounded child conversation, not raw archive IDs.
      if (memory.expanded.size || memory.opened.size) {
        const keys = new Set(workSubagentMessages(next.rows).map(message => message.id))
        for (const key of memory.expanded.keys()) if (!keys.has(key)) memory.expanded.delete(key)
        for (const key of memory.opened) if (!keys.has(key)) memory.opened.delete(key)
      }
      if (action === 'refresh') setHasNew(false)
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
    if (!explicit && memory.window && !atTail()) { setHasNew(true); return }
    void load('refresh', explicit || !memory.window || atTail())
  }
  useEffect(() => {
    epoch.current++
    pending.current = false
    setLoading(false); setError(''); setHasNew(false)
    lastStarted.current = 0
    return () => { epoch.current++; if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined }
  }, [source, parentSessionId, childSessionId, active, ready, memory])
  useEffect(() => {
    // An explicit refresh belongs to the selected child, not to the next
    // detail opened while that request is in flight.
    dirty.current = false; force.current = false; anchor.current = null
  }, [source, parentSessionId, childSessionId, memory])
  useEffect(() => {
    const explicit = manualRevision.current !== refreshKey
    manualRevision.current = refreshKey
    schedule(explicit)
  }, [source, parentSessionId, childSessionId, runId, lastSeq, status, refreshKey, active, ready, memory])
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = memory.scrollTop }, [memory, active])
  useLayoutEffect(() => {
    const container = scroller.current, position = anchor.current
    if (!container || !position) return
    if (position === 'tail') { container.scrollTop = container.scrollHeight; followingTail.current = true }
    else {
      const row = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === position.id)
      if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - position.top
    }
    memory.scrollTop = container.scrollTop
    anchor.current = null
  }, [revision])
  const rows = memory.window?.rows ?? []
  const messages = useMemo(() => workSubagentMessages(rows.slice(-memory.visibleCount)), [memory, revision])
  const liveMessage = memory.window && memory.window.lastPage >= Math.ceil(memory.window.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE)
    ? workSubagentLiveMessage(liveRun, childSessionId, messages) : undefined
  const hasEarlier = rows.length > memory.visibleCount || (memory.window?.firstPage ?? 1) > 1
  const window = memory.window
  return <section className="work-subagent-transcript" aria-label={`${name} 的对话`}>
    {error ? <div className="work-subagent-transcript__error" role="alert"><span>{error}</span><button type="button" disabled={!ready || loading} onClick={() => schedule(true)} aria-label="重新读取子代理对话" title="重新读取"><Icon name="restart" size={14} /></button></div> : null}
    <div className="work-subagent-transcript__scroll work-conversation__scroll" ref={scroller} onScroll={event => {
      const node = event.currentTarget
      memory.scrollTop = node.scrollTop
      followingTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
    }} aria-busy={loading}>
      {hasEarlier ? <button type="button" className="work-subagent-transcript__earlier" disabled={!ready || loading} onClick={() => {
        if (rows.length > memory.visibleCount) { captureAnchor(false); memory.visibleCount += SUBAGENT_TRANSCRIPT_PAGE_SIZE; redraw() } else void load('older')
      }}><Icon name="chevron-up" size={14} />加载更早消息</button> : null}
      {window && (window.endpoint === '/conversation/history' || window.backend !== 'jsonl') ? <p className="work-subagent-transcript__notice">当前引擎仅提供保留的历史，早期记录可能不完整。</p> : null}
      {messages.map(message => <TranscriptMessage key={message.id} message={message} messages={messages} memory={memory} redraw={redraw} fileContext={fileContext} active={active} running={running} runId={runId} />)}
      {liveMessage ? <div className="work-subagent-transcript__live" data-live-run-id={liveMessage.runId}>
        <p className="work-subagent-transcript__notice">实时进度</p>
        <WorkMessageContent message={liveMessage} sessionId={childSessionId} fileContext={fileContext} active={active} readOnly defaultProcessOpen={false} finalAnswer={liveMessage.content ? { text: liveMessage.content } : false} />
      </div> : null}
      {statusNote && !messages.some(message => message.runId === runId &&
        (message.error?.trim() === statusNote.trim() || message.content.includes(statusNote))) ?
        <WorkErrorNotice compact className="work-subagent-transcript__failure" error={statusNote}
          context={{ status: status === 'interrupted' ? 'interrupted' : status === 'cancelled' ? 'cancelled' : 'failed', runId, error: statusNote }} /> : null}
      {window && window.lastPage < Math.ceil(window.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE) ? <button type="button" className="work-subagent-transcript__earlier" disabled={!ready || loading} onClick={() => void load('newer')}><Icon name="chevron-down" size={14} />加载较新消息</button> : null}
      {!messages.length ? <div className="work-subagent-transcript__empty" role="status">{loading ? <><Spinner size={18} /><p>正在读取对话…</p></> : window ? <><Icon name="chat" size={24} /><p>{running ? '正在等待代理写入消息…' : '此代理没有可用的对话记录。'}</p></> : <p>连接就绪后可读取此代理的对话。</p>}</div> : null}
    </div>
    {hasNew ? <button type="button" className="work-subagent-transcript__new" onClick={() => schedule(true)} disabled={!ready || loading}><Icon name="chevron-down" size={14} />查看最新消息</button> : null}
  </section>
}
