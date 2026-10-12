import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { request } from '@renderer/core/engine/client'
import { extractText, type EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import { errorText } from '@renderer/core/engine/subagent-state'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import { Markdown } from '../chat/Markdown'
import type { ChatFileContext } from '../chat/chat-link'
import { ToolResult } from '../chat/ToolResult'
import { parseToolResult } from '../chat/tool-result'
import { toolDisplayName } from '../chat/tool-names'
import { getSessionMeta } from '../history/session-meta'
import { loadWorkSubagentTranscript, SUBAGENT_TRANSCRIPT_PAGE_SIZE, workTranscriptText, WorkTranscriptSupersededError, type WorkTranscriptWindow } from './work-subagent-transcript'

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

function TranscriptText({ value, id, memory, redraw, fileContext, markdown = false, toolName }: {
  value: unknown; id: string; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext; markdown?: boolean; toolName?: string
}): JSX.Element {
  const parsed = useMemo(() => toolName ? parseToolResult(value) : undefined, [toolName, value])
  const text = parsed?.text ?? extractText(value)
  const preview = workTranscriptText(text, memory.expanded.get(id))
  return <div className="work-subagent-transcript__text">
    {markdown ? <Markdown text={preview.text} fileContext={fileContext} /> : parsed ? <ToolResult parsed={{ ...parsed, text: preview.text }} toolName={toolName} textClassName="work-subagent-transcript__pre" /> : <pre className="work-subagent-transcript__pre">{preview.text}</pre>}
    {preview.remaining ? <button type="button" className="work-subagent-transcript__expand" onClick={() => { memory.expanded.set(id, preview.nextLimit); redraw() }}>继续展开 · 还有 {preview.remaining.toLocaleString()} 字符<Icon name="chevron-down" size={14} /></button> : null}
  </div>
}

function TranscriptRow({ row, name, memory, redraw, fileContext, toolNames }: {
  row: EngineHistoryRow; name: string; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext; toolNames: Map<string, string>
}): JSX.Element {
  const id = row.id!
  const content = extractText(row.content)
  const reasoning = extractText(row.reasoningContent)
  const tool = row.toolCall
  const toolName = typeof row.toolCallId === 'string' ? toolNames.get(row.toolCallId) : undefined
  const label = row.role === 'user' ? '任务指令' : row.role === 'tool' ? toolName ? toolDisplayName(toolName) : '工具结果' : name
  const failure = row.success === false || row.metadata?.success === false
  const rowError = errorText(row.error) || errorText(row.metadata?.error)
  const bodyId = `${id}:body`
  const reasoningId = `${id}:reasoning`
  const argsId = `${id}:args`
  const toggle = (key: string, open: boolean): void => { if (open) memory.opened.add(key); else memory.opened.delete(key) }
  return <article className={`work-subagent-transcript__row work-subagent-transcript__row--${row.role === 'user' ? 'user' : row.role === 'tool' ? 'tool' : 'assistant'}`} data-transcript-id={id}>
    <header><strong>{label}</strong>{row.role === 'tool' ? <span className={failure ? 'work-subagent-transcript__failure' : undefined}>{failure ? '失败' : row.success === true || row.metadata?.success === true ? '成功' : '历史记录'}</span> : row.modelId ? <span title={row.modelId}>{row.modelId}</span> : null}{row.createdAt ? <time dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time> : null}</header>
    {reasoning ? <details open={memory.opened.has(reasoningId)} onToggle={event => { toggle(reasoningId, event.currentTarget.open); redraw() }}><summary><Icon name="brain" size={14} />思考过程</summary>{memory.opened.has(reasoningId) ? <TranscriptText value={reasoning} id={reasoningId} memory={memory} redraw={redraw} fileContext={fileContext} /> : null}</details> : null}
    {row.role === 'tool' ? <details open={memory.opened.has(bodyId)} onToggle={event => { toggle(bodyId, event.currentTarget.open); redraw() }}><summary><Icon name="output" size={14} />查看工具输出{rowError ? <span className="work-subagent-transcript__failure">{rowError}</span> : null}</summary>{memory.opened.has(bodyId) ? <TranscriptText value={row.content} id={bodyId} memory={memory} redraw={redraw} fileContext={fileContext} toolName={toolName || 'unknown'} /> : null}</details> : content ? <TranscriptText value={content} id={bodyId} memory={memory} redraw={redraw} fileContext={fileContext} markdown={row.role === 'assistant'} /> : null}
    {tool?.name ? <details open={memory.opened.has(argsId)} onToggle={event => { toggle(argsId, event.currentTarget.open); redraw() }}><summary><Icon name="play" size={14} />调用{toolDisplayName(tool.name)}<span>参数</span></summary>{memory.opened.has(argsId) ? <TranscriptText value={typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args ?? {}, null, 2)} id={argsId} memory={memory} redraw={redraw} fileContext={fileContext} /> : null}</details> : null}
    {row.role !== 'tool' && rowError ? <p className="work-subagent-transcript__failure" role="alert">{rowError}</p> : null}
    {row.metadata?.attachments?.length ? <p className="work-subagent-transcript__attachments">附件：{row.metadata.attachments.map(file => file.name).join('、')}</p> : null}
  </article>
}

/** Historical records are read explicitly and never injected back into a model. */
export function WorkSubagentTranscript({ source, parentSessionId, childSessionId, runId, name, memory, active = true, running = false }: {
  source: number; parentSessionId: string; childSessionId: string; runId: string; name: string; memory: WorkSubagentTranscriptMemory; active?: boolean; running?: boolean
}): JSX.Element {
  const { ready } = useApp()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const epoch = useRef(0)
  const pending = useRef(false)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  const redraw = (): void => setRevision(value => value + 1)
  const fileContext: ChatFileContext = { sessionId: childSessionId, workspaceRoot: getSessionMeta(parentSessionId).workspacePath }
  const captureAnchor = (): void => {
    const container = scroller.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-transcript-id]')).find(item => item.getBoundingClientRect().bottom > top)
    if (row?.dataset.transcriptId) anchor.current = { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top - top }
  }
  const load = async (action: 'older' | 'refresh'): Promise<void> => {
    if (!active || !ready || pending.current) return
    captureAnchor()
    pending.current = true
    setLoading(true)
    setError('')
    const generation = epoch.current
    const expectedEngine = getExpectedEngine()
    const current = (): boolean => generation === epoch.current && source === getEngineSource()
    try {
      const previous = memory.window
      const next = await loadWorkSubagentTranscript({ source, parentSessionId, childSessionId, runId }, input => request({ ...input, expectedEngine }), current, previous, action)
      if (!current()) return
      if (previous) memory.visibleCount += Math.max(0, next.rows.length - previous.rows.length)
      memory.window = next
      redraw()
    } catch (cause) {
      if (current() && !(cause instanceof WorkTranscriptSupersededError)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) { pending.current = false; setLoading(false) }
    }
  }
  useEffect(() => {
    epoch.current++
    pending.current = false
    setLoading(false)
    setError('')
    if (active && ready && (!memory.window || memory.window.identity.runId !== runId)) void load('refresh')
    return () => { epoch.current++ }
  }, [source, parentSessionId, childSessionId, runId, active, ready, memory])
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = memory.scrollTop
  }, [memory, active])
  useLayoutEffect(() => {
    const container = scroller.current
    const position = anchor.current
    if (!container || !position) return
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-transcript-id]')).find(item => item.dataset.transcriptId === position.id)
    if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - position.top
    anchor.current = null
  }, [revision])
  const rows = useMemo(() => (memory.window?.rows ?? []).filter(row => row.role !== 'system' && row.isSidechain !== true), [memory, revision])
  const toolNames = useMemo(() => new Map((memory.window?.rows ?? []).flatMap(row => row.toolCall?.id && row.toolCall.name ? [[row.toolCall.id, row.toolCall.name] as const] : [])), [memory, revision])
  const visible = rows.slice(-memory.visibleCount)
  const hasEarlier = rows.length > memory.visibleCount || (memory.window?.firstPage ?? 1) > 1
  const window = memory.window
  const availableOnly = window?.endpoint === '/conversation/history' || window?.backend !== 'jsonl'
  return <section className="work-subagent-transcript" aria-label={`${name} 的完整对话`}>
    <div className="work-subagent-transcript__toolbar"><span>{window ? `已读取 ${window.rows.length.toLocaleString()} / ${window.total.toLocaleString()} 条记录` : '读取此代理的独立会话记录'}</span><button type="button" disabled={!ready || loading} onClick={() => void load('refresh')} aria-label="更新子代理完整对话">{loading ? <Spinner size={14} /> : <Icon name="restart" size={14} />}更新对话</button></div>
    {window && availableOnly ? <p className="work-subagent-transcript__notice" role="status">当前后端提供可用历史；压缩前的部分记录可能未保留。</p> : null}
    {error ? <div className="work-subagent-transcript__error" role="alert"><span>{error}</span><button type="button" disabled={!ready || loading} onClick={() => void load('refresh')}>重试读取</button></div> : null}
    <div className="work-subagent-transcript__scroll" ref={scroller} onScroll={event => { memory.scrollTop = event.currentTarget.scrollTop }} aria-busy={loading}>
      {hasEarlier ? <button type="button" className="work-subagent-transcript__earlier" disabled={!ready || loading} onClick={() => { if (rows.length > memory.visibleCount) { captureAnchor(); memory.visibleCount += SUBAGENT_TRANSCRIPT_PAGE_SIZE; redraw() } else void load('older') }}><Icon name="chevron-up" size={14} />加载更早记录</button> : null}
      {visible.map(row => <TranscriptRow key={row.id} row={row} name={name} memory={memory} redraw={redraw} fileContext={fileContext} toolNames={toolNames} />)}
      {!visible.length ? <div className="work-subagent-transcript__empty" role="status">{loading ? <><Spinner size={18} /><p>正在读取完整对话…</p></> : window ? <><Icon name="chat" size={24} /><p>{running ? '此代理尚未写入对话记录，稍后可更新查看。' : '此代理没有可用的对话记录。'}</p></> : <p>连接就绪后可读取此代理的对话。</p>}</div> : null}
      {running && visible.length ? <p className="work-subagent-transcript__notice">本轮仍在运行，更新对话可查看新记录。</p> : null}
    </div>
  </section>
}
