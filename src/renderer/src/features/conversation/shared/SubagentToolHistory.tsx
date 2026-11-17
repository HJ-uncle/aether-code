import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { SubagentRunView, SubagentToolCall, SubagentToolDetailPage } from '@shared/subagent'
import { useApp } from '@renderer/core/app-context'
import { getSubagentToolDetail, listSubagentToolCalls } from '@renderer/core/engine/client'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { Spinner } from '@renderer/ui/ui-primitives'
import { Icon } from '@renderer/ui/icons'
import { useMotionPresence } from '@renderer/ui/MotionPresence'
import { ToolResult } from './ToolResult'
import { looksLikeStructuredResult } from './ToolResultData'
import { ToolOutcome } from '../ToolOutcome'
import { sessionToolFeedback } from '../tool-feedback'
import { readActivityPreview } from '../activity-presentation'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { parseToolResult } from './tool-result'
import { isCommandTool } from '@shared/command-receipt'
import { toolDisplayName, toolParamSummary, toolPathArg } from './tool-names'
import { quietToolIcon } from './quiet-tool-icon'
import { loadSubagentToolWindow, subagentHistoryScope, subagentDetailOffsetTrail, SubagentHistorySupersededError,
  SUBAGENT_DETAIL_CHUNK_BYTES, SUBAGENT_TOOL_PAGE_SIZE, type SubagentToolWindow } from './subagent-tool-history'
import './subagent-history.css'

function ToolDetail({ call, run, latestSeq = run.lastSeq, visible }: {
  call: SubagentToolCall; run: SubagentRunView; latestSeq?: number; visible: boolean
}): JSX.Element {
  const { ready } = useApp()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [page, setPage] = useState<SubagentToolDetailPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const pending = useRef(false)
  const previousOffsets = useRef<number[]>([])
  const identity = JSON.stringify([source, run.tenantId, run.runId, run.rootSessionId, run.parentSessionId, run.parentConversationId, run.parentMessageId, run.parentToolCallId, run.childSessionId, call.id])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const load = async (offset = 0, atSeq = page?.asOfSeq ?? run.lastSeq): Promise<void> => {
    if (!visible || !ready || pending.current) return
    const epoch = generation.current
    const current = (): boolean => epoch === generation.current && identity === currentIdentity.current && source === getEngineSource()
    pending.current = true
    setLoading(true)
    setError('')
    try {
      const next = await getSubagentToolDetail(run.runId, call.id, { atSeq, offset,
        parentSessionId: run.parentSessionId, rootSessionId: run.rootSessionId, limitBytes: SUBAGENT_DETAIL_CHUNK_BYTES })
      if (current()) {
        previousOffsets.current = page && page.asOfSeq === next.asOfSeq
          ? subagentDetailOffsetTrail(previousOffsets.current, page.detail.offset, next.detail.offset) : []
        setPage(next)
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) { pending.current = false; setLoading(false) } }
  }
  useEffect(() => {
    if (!visible) return
    generation.current++
    pending.current = false
    previousOffsets.current = []
    setPage(undefined)
    setError('')
    setLoading(false)
    if (ready) void load(0, run.lastSeq)
    return () => { generation.current++ }
  }, [identity, ready, visible])
  const complete = page && page.detail.offset === 0 && !page.detail.hasMore
  const body = useMemo((): Record<string, unknown> | undefined => {
    if (!complete || !page) return undefined
    try { const value: unknown = JSON.parse(page.detail.text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
    catch { return undefined }
  }, [page, complete])
  const output = typeof body?.output === 'string' ? body.output : undefined
  const parsed = useMemo(() => isCommandTool(call.name) ? { text: output ?? '', images: [] } : parseToolResult(output), [output, call.name])
  const metadata = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : undefined
  return <div className="subagent-history__detail subagent-history__detail--work" aria-busy={loading}>
    <div className="subagent-history__toolbar"><span>工具执行详情</span>
      <button type="button" disabled={!ready || loading} onClick={() => void load(0, latestSeq)}>{loading ? <Spinner size={12} /> : <Icon name="restart" size={14} />}更新详情</button></div>
    {error ? <p role="alert" className="subagent-history__error">{error}</p> : null}
    {page ? body ? <>
      {output ? <><div className="subagent-card__call-section">输出</div><ToolResult parsed={parsed} toolId={call.id} toolName={call.name} toolArgs={body?.args ?? call.args} metadata={metadata} fileContext={{ sessionId: run.childSessionId, receiptParentSessionId: run.rootSessionId }} active={visible} textClassName="subagent-card__call-pre" surfaceMode="work" /></> : <p className="subagent-history__notice">本次详情未附输出</p>}
    </> : <p className="subagent-history__notice" role="status">{complete ? '这条详情暂时无法整理，可在子代理对话中查看' : '内容较长，可在子代理对话中查看'}</p> : loading ? <p role="status">正在读取工具详情…</p> : null}
    {page && page.detail.offset > 0 ? <div className="subagent-history__navigation">
      {previousOffsets.current.length ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(previousOffsets.current.at(-1), page.asOfSeq)}>上一段内容</button> : null}
      <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(0, page.asOfSeq)}>回到开头</button>
    </div> : null}
    {page?.detail.hasMore ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(page.detail.nextOffset, page.asOfSeq)}>下一段内容</button> : null}
    {page && page.asOfSeq !== latestSeq ? <p className="subagent-history__notice">代理已有新活动，更新详情可读取当前记录。</p> : null}
  </div>
}

export function SubagentToolRow({ call, run, latestSeq, open: controlledOpen, onToggle, visible = true }: {
  call: SubagentToolCall; run?: SubagentRunView; latestSeq?: number; open?: boolean; onToggle?: () => void; visible?: boolean
}): JSX.Element {
  const parsed = useMemo(() => isCommandTool(call.name) ? { text: call.output ?? '', images: [] } : parseToolResult(call.output), [call.output, call.name])
  const [manualOpen, setOpen] = useState<boolean | null>(null)
  const hasDetail = Boolean(run || call.output || call.error)
  const open = hasDetail && (controlledOpen ?? manualOpen ?? parsed.images.length > 0)
  const presence = useMotionPresence(open && visible)
  const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})
  const path = toolPathArg(args)
  const summary = path ? path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : toolParamSummary(args, call.name)
  const outcomeTool: ToolActivity = {
    id: call.id, name: call.name, args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
    result: call.output ?? '', error: call.error?.message,
    metadata: call.error ? { commandJob: { error: call.error } } : undefined,
    state: call.status === 'failed' ? 'error' : call.status === 'succeeded' ? 'done' : call.status === 'cancelled' ? 'cancelled' : 'running'
  }
  const readRange = useMemo(() => readActivityPreview({
    name: call.name, state: call.status === 'succeeded' ? 'done' : call.status,
    result: call.output ?? '', error: call.error?.message
  })?.range, [call.name, call.status, call.output, call.error?.message])
  const feedback = sessionToolFeedback(outcomeTool)
  const status = feedback?.label ?? (call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '执行中')
  return <div className="subagent-card__call subagent-card__call--work">
    <button type="button" className="subagent-card__call-toggle" aria-expanded={open} aria-label={`${toolDisplayName(call.name)}${summary ? ` · ${summary}` : ''} · ${status}${readRange ? ` · ${readRange.label}` : ''}`} disabled={!hasDetail} onClick={onToggle ?? (() => setOpen(!open))}>
      <span className="subagent-card__call-icon" aria-hidden="true">{call.status === 'running' ? <Spinner size={14} /> : <Icon name={quietToolIcon(call.name)} size={16} />}</span>
      <span className="subagent-card__call-name">{toolDisplayName(call.name)}</span>
      {summary && !looksLikeStructuredResult(summary) ? <span className="subagent-card__call-args" title={path || summary}>{summary}</span> : null}
      {call.status !== 'succeeded' ? <span className="subagent-card__call-summary">{status}</span> : null}
      {readRange ? <span className="subagent-card__call-range" title={readRange.title}>{readRange.label}</span> : null}
      {hasDetail ? <Icon name="chevron-right" size={12} className="subagent-card__call-chevron" /> : null}
    </button>
    {presence.present ? <div className="ui-motion-collapse subagent-card__call-presence" {...presence.motionProps}><div className="ui-motion-collapse__content"><div className="subagent-card__call-detail"><ToolOutcome tool={outcomeTool} />
      {run ? <ToolDetail call={call} run={run} latestSeq={latestSeq} visible={open && visible} /> : call.output ? <><div className="subagent-card__call-section">输出</div><ToolResult parsed={parsed} toolId={call.id} toolName={call.name} toolArgs={call.args} active={open && visible} textClassName="subagent-card__call-pre" surfaceMode="work" /></> : null}
    </div></div></div> : null}
  </div>
}

/** Expanded history is a bounded window at an explicit watermark, separate from live summaries. */
export function SubagentToolHistory({ run, visible = true }: { run: SubagentRunView; visible?: boolean }): JSX.Element {
  const { ready } = useApp()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [window, setWindow] = useState<SubagentToolWindow>()
  const [anchor, setAnchor] = useState(run)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const identity = JSON.stringify([source, run.tenantId, run.runId, run.rootSessionId, run.parentSessionId, run.parentConversationId, run.parentMessageId, run.parentToolCallId, run.childSessionId])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const load = async (refresh = false): Promise<void> => {
    if (!visible || !ready || pending.current) return
    const epoch = generation.current
    const current = (): boolean => epoch === generation.current && identity === currentIdentity.current && source === getEngineSource()
    const target = refresh ? run : anchor
    const scope = subagentHistoryScope(target, source)
    pending.current = true
    setLoading(true)
    setError('')
    try {
      const next = await loadSubagentToolWindow(scope, (value, cursor) => listSubagentToolCalls(value.runId, {
        atSeq: value.atSeq, parentSessionId: value.parentSessionId, rootSessionId: value.rootSessionId,
        cursor, limit: SUBAGENT_TOOL_PAGE_SIZE }), current, refresh ? undefined : window)
      if (!current()) return
      setWindow(next)
      setSelected(value => value && !next.items.some(call => call.id === value) ? null : value)
      if (refresh) { setAnchor(target); setSelected(null) }
    } catch (cause) { if (current() && !(cause instanceof SubagentHistorySupersededError)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) { pending.current = false; setLoading(false) } }
  }
  useEffect(() => {
    if (!visible) return
    generation.current++
    pending.current = false
    setWindow(undefined)
    setAnchor(run)
    setSelected(null)
    setError('')
    setLoading(false)
    if (ready) void load(true)
    return () => { generation.current++ }
  }, [identity, ready, visible])
  const calls = window?.items.filter(isVisibleToolActivity) ?? []
  return <div className="subagent-history subagent-history--work" aria-busy={loading}>
    <div className="subagent-history__toolbar"><span>{window ? `已显示 ${calls.length.toLocaleString()} / ${window.totalCount.toLocaleString()} 条记录` : '正在读取记录'}</span>
      <button type="button" disabled={!ready || loading} onClick={() => void load(true)}><Icon name="restart" size={14} />更新记录</button></div>
    {window && window.scope.atSeq !== run.lastSeq ? <p className="subagent-history__notice" role="status">记录已更新，点击“更新记录”查看新活动。</p> : null}
    {window?.droppedCount ? <p className="subagent-history__notice">已读取 {window.loadedCount.toLocaleString()} 项，当前显示最近读取的记录；更早内容保留在服务端，可更新记录从头读取。</p> : null}
    {error ? <p className="subagent-history__error" role="alert">{error}<button type="button" disabled={!ready || loading} onClick={() => void load(true)}>重试</button></p> : null}
    <div className="subagent-card__tools-list">{calls.map(call => <SubagentToolRow key={call.id} call={call} run={anchor} latestSeq={run.lastSeq} open={selected === call.id} onToggle={() => setSelected(selected === call.id ? null : call.id)} visible={visible} />)}</div>
    {window?.hasMore ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load()}>{loading ? <Spinner size={14} /> : null}加载更多记录</button> : loading ? <p className="subagent-history__notice" role="status">正在读取工具记录…</p> : !calls.length && !error ? <p className="subagent-history__notice">此页没有可显示的工具记录。</p> : null}
  </div>
}
