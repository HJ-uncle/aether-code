import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getSubagentProtocol, request } from '@renderer/core/engine/client'
import { extractText, type EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { taskPlanTranscriptRows } from '@renderer/core/engine/task-plan'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import { errorText } from '@renderer/core/engine/subagent-state'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import { useMotionPresence } from '@renderer/workbench/MotionPresence'
import { Markdown } from '../chat/Markdown'
import type { ChatFileContext } from '../chat/chat-link'
import { ToolResult } from '../chat/ToolResult'
import { looksLikeStructuredResult } from '../chat/ToolResultData'
import { parseToolResult } from '../chat/tool-result'
import { parseToolResultData } from '../chat/tool-result-data'
import { quietToolIcon } from '../chat/quiet-tool-icon'
import { toolDisplayName, toolParamSummary, toolPathArg } from '../chat/tool-names'
import { getSessionMeta } from '../history/session-meta'
import { loadWorkSubagentTranscript, SUBAGENT_TRANSCRIPT_PAGE_SIZE, workTranscriptText, WorkTranscriptSupersededError, type WorkTranscriptWindow } from './work-subagent-transcript'
import { workTranscriptItems, type WorkTranscriptItem } from './work-subagent-transcript-presentation'
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

function TranscriptText({ value, id, memory, redraw, fileContext, markdown = false, toolName }: {
  value: unknown; id: string; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext; markdown?: boolean; toolName?: string
}): JSX.Element {
  const parsed = useMemo(() => toolName ? parseToolResult(value) : undefined, [toolName, value])
  // Truncating a JSON receipt before parsing makes an otherwise readable result
  // disappear. Structured fields already expand incrementally in ToolResult.
  const structured = useMemo(() => parsed ? parseToolResultData(parsed.text) : null, [parsed])
  const text = parsed?.text ?? extractText(value)
  const preview = workTranscriptText(text, memory.expanded.get(id))
  const output = parsed ? { ...parsed, text: structured ? parsed.text : preview.text } : undefined
  const hasMedia = Boolean(parsed?.images.length || parsed?.browserSnapshots?.length)
  return <div className="work-subagent-transcript__text">
    {markdown ? <Markdown text={preview.text} fileContext={fileContext} /> : output ? <ToolResult parsed={output} toolName={toolName} textClassName="work-subagent-transcript__pre" surfaceMode="work" structured /> : <pre className="work-subagent-transcript__pre">{preview.text}</pre>}
    {hasMedia && output?.text ? <details className="work-subagent-transcript__media-text"><summary>文字说明</summary><ToolResult parsed={{ images: [], text: output.text }} textClassName="work-subagent-transcript__pre" surfaceMode="work" structured /></details> : null}
    {!structured && preview.remaining ? <button type="button" className="work-subagent-transcript__expand" onClick={() => { memory.expanded.set(id, preview.nextLimit); redraw() }}>继续展开 · 还有 {preview.remaining.toLocaleString()} 字符<Icon name="chevron-down" size={14} /></button> : null}
  </div>
}

function transcriptArgs(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return '' }
}

function TranscriptAttachments({ row }: { row: EngineHistoryRow }): JSX.Element | null {
  return row.metadata?.attachments?.length ? <p className="work-subagent-transcript__attachments">附件：{row.metadata.attachments.map(file => file.name).join('、')}</p> : null
}

function TranscriptTool({ item, memory, redraw, fileContext }: {
  item: WorkTranscriptItem; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext
}): JSX.Element {
  const { row, result, toolName } = item
  const outcome = result ?? (row.role === 'tool' ? row : undefined)
  // Keep the original result key when an earlier page reveals its invocation.
  const bodyId = `${outcome?.id ?? row.id}:body`
  const invocationBodyId = `${row.id}:body`
  const argsId = `${row.id}:args`
  const open = memory.opened.has(bodyId) || Boolean(result && memory.opened.has(invocationBodyId))
  const presence = useMotionPresence(open)
  const args = transcriptArgs(row.toolCall?.args)
  const path = toolPathArg(args)
  const summary = path ? path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : toolParamSummary(args)
  const outcomeError = errorText(outcome?.error) || errorText(outcome?.metadata?.error)
  const explicitStatus = outcome?.metadata?.status ?? row.metadata?.status
  const failed = outcome?.success === false || outcome?.metadata?.success === false || Boolean(outcomeError) || explicitStatus === 'failed' || explicitStatus === 'error'
  const status = failed ? '失败' : explicitStatus === 'cancelled' ? '已取消' : explicitStatus === 'interrupted' ? '已中断' :
    explicitStatus === 'blocked' || explicitStatus === 'waiting' ? '等待处理' : explicitStatus === 'running' ? '处理中' :
      explicitStatus === 'queued' ? '等待执行' : explicitStatus === 'cancelling' ? '正在取消' : !outcome ? '结果未载入' : ''
  const reasoning = extractText(outcome?.reasoningContent)
  const reasoningId = `${outcome?.id ?? row.id}:reasoning`
  return <details className="work-subagent-transcript__tool" data-transcript-id={result?.id} open={open} onToggle={event => {
    if (result) memory.opened.delete(invocationBodyId)
    if (event.currentTarget.open) memory.opened.add(bodyId); else memory.opened.delete(bodyId)
    redraw()
  }}>
    <summary title={[toolName, outcome?.modelId, outcome?.createdAt ? new Date(outcome.createdAt).toLocaleString() : row.createdAt ? new Date(row.createdAt).toLocaleString() : undefined].filter(Boolean).join(' · ') || undefined}>
      <Icon name={quietToolIcon(toolName ?? '')} size={14} />
      <span className="work-subagent-transcript__tool-name">{toolName ? toolDisplayName(toolName) : '工具输出'}</span>
      {summary && !looksLikeStructuredResult(summary) ? <span className="work-subagent-transcript__tool-target" title={path || summary}>{summary}</span> : null}
      {status ? <span className={`work-subagent-transcript__tool-status${failed || explicitStatus === 'interrupted' ? ' work-subagent-transcript__failure' : ''}`}>{status}</span> : null}
      <Icon name="chevron-down" size={12} className="work-subagent-transcript__tool-chevron" />
    </summary>
    {presence.present ? <div className="work-subagent-transcript__tool-body" {...presence.motionProps}>
      {args ? <details className="work-subagent-transcript__input" open={memory.opened.has(argsId)} onToggle={event => {
        if (event.currentTarget.open) memory.opened.add(argsId); else memory.opened.delete(argsId)
      }}><summary>输入参数</summary><TranscriptText value={args} id={argsId} memory={memory} redraw={redraw} fileContext={fileContext} toolName={toolName || 'unknown'} /></details> : null}
      {outcomeError ? <p className="work-subagent-transcript__failure" role="alert">{outcomeError}</p> : null}
      {reasoning ? <details open={memory.opened.has(reasoningId)} onToggle={event => {
        if (event.currentTarget.open) memory.opened.add(reasoningId); else memory.opened.delete(reasoningId)
      }}><summary>思考过程</summary><TranscriptText value={reasoning} id={reasoningId} memory={memory} redraw={redraw} fileContext={fileContext} /></details> : null}
      {outcome ? <><TranscriptText value={outcome.content} id={bodyId} memory={memory} redraw={redraw} fileContext={fileContext} toolName={toolName || 'unknown'} /><TranscriptAttachments row={outcome} /></> : <p className="work-subagent-transcript__pending">当前记录中尚无此工具的输出。</p>}
    </div> : null}
  </details>
}

function TranscriptRow({ item, name, memory, redraw, fileContext }: {
  item: WorkTranscriptItem; name: string; memory: WorkSubagentTranscriptMemory; redraw: () => void; fileContext: ChatFileContext
}): JSX.Element {
  const { row, showIdentity } = item
  const id = row.id!
  const content = extractText(row.content)
  const reasoning = extractText(row.reasoningContent)
  const rowError = errorText(row.error) || errorText(row.metadata?.error)
  const bodyId = `${id}:body`
  const reasoningId = `${id}:reasoning`
  const reasoningPresence = useMotionPresence(memory.opened.has(reasoningId))
  const isTool = row.role === 'tool'
  const toolOnly = isTool || Boolean(row.toolCall && !content && !reasoning && !rowError && !row.metadata?.attachments?.length)
  const createdAt = row.createdAt ? new Date(row.createdAt) : undefined
  const timestamp = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : undefined
  const meta = [row.modelId, timestamp?.toLocaleString()].filter(Boolean).join(' · ')
  return <article className={`work-subagent-transcript__row work-subagent-transcript__row--${row.role === 'user' ? 'user' : toolOnly ? 'tool' : 'assistant'}${showIdentity ? ' work-subagent-transcript__row--start' : ''}`} data-transcript-id={id} title={meta || undefined}>
    {showIdentity ? <header title={meta || undefined}><strong>{row.role === 'user' ? '任务指令' : name}</strong>{timestamp ? <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>{timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time> : null}</header> : null}
    {!isTool && reasoning ? <details className="work-subagent-transcript__reasoning" open={memory.opened.has(reasoningId)} onToggle={event => {
      if (event.currentTarget.open) memory.opened.add(reasoningId); else memory.opened.delete(reasoningId)
      redraw()
    }}><summary><Icon name="brain" size={14} />思考过程</summary>{reasoningPresence.present ? <div {...reasoningPresence.motionProps}><TranscriptText value={reasoning} id={reasoningId} memory={memory} redraw={redraw} fileContext={fileContext} /></div> : null}</details> : null}
    {!isTool && content ? <TranscriptText value={content} id={bodyId} memory={memory} redraw={redraw} fileContext={fileContext} markdown={row.role === 'assistant'} /> : null}
    {!isTool && rowError ? <p className="work-subagent-transcript__failure" role="alert">{rowError}</p> : null}
    {!isTool ? <TranscriptAttachments row={row} /> : null}
    {row.toolCall || isTool ? <TranscriptTool item={item} memory={memory} redraw={redraw} fileContext={fileContext} /> : null}
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
  const load = async (action: 'older' | 'newer' | 'refresh'): Promise<void> => {
    if (!active || !ready || pending.current) return
    captureAnchor()
    pending.current = true
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
      if (next.revision === undefined) { anchor.current = null; memory.scrollTop = 0; if (scroller.current) scroller.current.scrollTop = 0 }
      memory.window = next
      memory.visibleCount = Math.min(next.rows.length, Math.max(SUBAGENT_TRANSCRIPT_PAGE_SIZE, memory.visibleCount))
      const keys = new Set(next.rows.flatMap(row => [`${row.id}:body`, `${row.id}:reasoning`, `${row.id}:args`]))
      for (const key of memory.expanded.keys()) if (!keys.has(key)) memory.expanded.delete(key)
      for (const key of memory.opened) if (!keys.has(key)) memory.opened.delete(key)
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
  const rows = useMemo(() => taskPlanTranscriptRows(memory.window?.rows ?? []).filter(row => row.role !== 'system' && row.isSidechain !== true), [memory, revision])
  const visible = rows.slice(-memory.visibleCount)
  const items = workTranscriptItems(visible, memory.window?.rows ?? rows)
  const hasEarlier = rows.length > memory.visibleCount || (memory.window?.firstPage ?? 1) > 1
  const window = memory.window
  const availableOnly = window?.endpoint === '/conversation/history' || window?.backend !== 'jsonl'
  return <section className="work-subagent-transcript work-subagent-transcript--compact" aria-label={`${name} 的完整对话`}>
    <div className="work-subagent-transcript__toolbar"><span>{window ? `当前窗口 ${window.rows.length.toLocaleString()} / ${window.total.toLocaleString()} 条记录` : '读取此代理的独立会话记录'}</span><button type="button" disabled={!ready || loading} onClick={() => void load('refresh')} aria-label="更新子代理完整对话">{loading ? <Spinner size={14} /> : <Icon name="restart" size={14} />}更新对话</button></div>
    {window?.windowed ? <p className="work-subagent-transcript__notice">加载更早内容后，点“更新对话”回到最新记录。</p> : null}
    {window && window.revision === undefined ? <p className="work-subagent-transcript__notice" role="status">归档第 {window.firstPage} / {Math.max(1, Math.ceil(window.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE))} 页 · 引擎未提供跨页版本一致性，每次仅显示当前页。</p> : null}
    {window && availableOnly ? <p className="work-subagent-transcript__notice" role="status">当前后端提供可用历史；压缩前的部分记录可能未保留。</p> : null}
    {error ? <div className="work-subagent-transcript__error" role="alert"><span>{error}</span><button type="button" disabled={!ready || loading} onClick={() => void load('refresh')}>重试读取</button></div> : null}
    <div className="work-subagent-transcript__scroll" ref={scroller} onScroll={event => { memory.scrollTop = event.currentTarget.scrollTop }} aria-busy={loading}>
      {hasEarlier ? <button type="button" className="work-subagent-transcript__earlier" disabled={!ready || loading} onClick={() => { if (rows.length > memory.visibleCount) { captureAnchor(); memory.visibleCount += SUBAGENT_TRANSCRIPT_PAGE_SIZE; redraw() } else void load('older') }}><Icon name="chevron-up" size={14} />加载更早记录</button> : null}
      {items.map(item => <TranscriptRow key={item.row.id} item={item} name={name} memory={memory} redraw={redraw} fileContext={fileContext} />)}
      {window && window.lastPage < Math.ceil(window.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE) ? <button type="button" className="work-subagent-transcript__earlier" disabled={!ready || loading} onClick={() => void load('newer')}><Icon name="chevron-down" size={14} />加载较新记录</button> : null}
      {!visible.length ? <div className="work-subagent-transcript__empty" role="status">{loading ? <><Spinner size={18} /><p>正在读取完整对话…</p></> : window ? <><Icon name="chat" size={24} /><p>{running ? '此代理尚未写入对话记录，稍后可更新查看。' : '此代理没有可用的对话记录。'}</p></> : <p>连接就绪后可读取此代理的对话。</p>}</div> : null}
      {running && visible.length ? <p className="work-subagent-transcript__notice">本轮仍在运行，更新对话可查看新记录。</p> : null}
    </div>
  </section>
}
