import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { SubagentRunView, SubagentToolCall, SubagentToolDetailPage } from '@shared/subagent'
import { useApp } from '@renderer/core/app-context'
import { getSubagentToolDetail, listSubagentToolCalls } from '@renderer/core/engine/client'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import { useMotionPresence } from '@renderer/workbench/MotionPresence'
import { ToolResult } from './ToolResult'
import { looksLikeStructuredResult } from './ToolResultData'
import { WorkErrorNotice } from '../work/WorkErrorNotice'
import { WorkToolOutcome } from '../work/WorkToolOutcome'
import { workToolFeedback } from '../work/work-tool-feedback'
import { readActivityPreview } from '../work/work-activity-presentation'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { parseToolResult } from './tool-result'
import { toolDisplayName, toolParamSummary, toolPathArg } from './tool-names'
import { quietToolIcon } from './quiet-tool-icon'
import { loadSubagentToolWindow, subagentHistoryScope, subagentDetailOffsetTrail, SubagentHistorySupersededError,
  SUBAGENT_DETAIL_CHUNK_BYTES, SUBAGENT_TOOL_PAGE_SIZE, type SubagentToolWindow } from './subagent-tool-history'
import './subagent-history.css'

function ToolDetail({ call, run, latestSeq = run.lastSeq, visible, surfaceMode = 'code' }: {
  call: SubagentToolCall; run: SubagentRunView; latestSeq?: number; visible: boolean; surfaceMode?: 'code' | 'work'
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
  const parsed = useMemo(() => parseToolResult(output), [output])
  return <div className={`subagent-history__detail${surfaceMode === 'work' ? ' subagent-history__detail--work' : ''}`} aria-busy={loading}>
    <div className="subagent-history__toolbar"><span>{surfaceMode === 'work' ? '工具执行详情' : page ? `${page.detail.offset.toLocaleString()}–${(page.detail.offset + new TextEncoder().encode(page.detail.text).byteLength).toLocaleString()} / ${page.detail.totalBytes.toLocaleString()} 字节` : '读取原始参数与输出'}</span>
      <button type="button" disabled={!ready || loading} onClick={() => void load(0, latestSeq)}>{loading ? <Spinner size={12} /> : <Icon name="restart" size={14} />}更新详情</button></div>
    {error ? <p role="alert" className="subagent-history__error">{error}</p> : null}
    {page ? body ? <>
      {surfaceMode === 'code' ? <><div className="subagent-card__call-section">参数</div><pre className="subagent-card__call-pre">{JSON.stringify(body.args ?? {}, null, 2)}</pre></> : null}
      {output ? <><div className="subagent-card__call-section">输出</div><ToolResult parsed={parsed} toolName={call.name} textClassName="subagent-card__call-pre" surfaceMode={surfaceMode} /></> : surfaceMode === 'work' ? <p className="subagent-history__notice">本次详情未附输出</p> : null}
    </> : surfaceMode === 'work' ? <p className="subagent-history__notice" role="status">{complete ? '这条详情暂时无法整理，可在子代理对话中查看' : '内容较长，可在子代理对话中查看'}</p> : <><p className="subagent-history__notice">原始详情分段显示；每次只保留当前段，可继续读取后续内容。</p><pre className="subagent-card__call-pre">{page.detail.text}</pre></> : loading ? <p role="status">正在读取工具详情…</p> : null}
    {page && page.detail.offset > 0 ? <div className="subagent-history__navigation">
      {previousOffsets.current.length ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(previousOffsets.current.at(-1), page.asOfSeq)}>上一段内容</button> : null}
      <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(0, page.asOfSeq)}>回到开头</button>
    </div> : null}
    {page?.detail.hasMore ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load(page.detail.nextOffset, page.asOfSeq)}>下一段内容</button> : null}
    {page && page.asOfSeq !== latestSeq ? <p className="subagent-history__notice">代理已有新活动，更新详情可读取当前记录。</p> : null}
  </div>
}

export function SubagentToolRow({ call, run, latestSeq, open: controlledOpen, onToggle, visible = true, surfaceMode = 'code' }: {
  call: SubagentToolCall; run?: SubagentRunView; latestSeq?: number; open?: boolean; onToggle?: () => void; visible?: boolean; surfaceMode?: 'code' | 'work'
}): JSX.Element {
  const parsed = useMemo(() => parseToolResult(call.output), [call.output])
  const [manualOpen, setOpen] = useState<boolean | null>(null)
  const hasDetail = Boolean(run || call.output || call.error)
  const open = hasDetail && (controlledOpen ?? manualOpen ?? parsed.images.length > 0)
  const presence = useMotionPresence(open && visible)
  const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})
  const path = surfaceMode === 'work' ? toolPathArg(args) : null
  const summary = path ? path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : toolParamSummary(args, call.name)
  const outcomeTool: ToolActivity = {
    id: call.id, name: call.name, args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
    result: call.output ?? '', error: call.error?.message,
    metadata: call.error ? { commandJob: { error: call.error } } : undefined,
    state: call.status === 'failed' ? 'error' : call.status === 'succeeded' ? 'done' : call.status === 'cancelled' ? 'cancelled' : 'running'
  }
  const readRange = useMemo(() => surfaceMode === 'work' ? readActivityPreview({
    name: call.name, state: call.status === 'succeeded' ? 'done' : call.status,
    result: call.output ?? '', error: call.error?.message
  })?.range : undefined, [surfaceMode, call.name, call.status, call.output, call.error?.message])
  const feedback = surfaceMode === 'work' ? workToolFeedback(outcomeTool) : null
  const status = feedback?.label ?? (call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '执行中')
  return <div className={`subagent-card__call${surfaceMode === 'work' ? ' subagent-card__call--work' : ''}`}>
    {surfaceMode === 'code' ? <span className={`subagent-card__call-dot${call.status === 'failed' ? ' subagent-card__call-dot--fail' : ''}`} /> : null}
    <button type="button" className="subagent-card__call-toggle" aria-expanded={open} aria-label={surfaceMode === 'work' ? `${toolDisplayName(call.name)}${summary ? ` · ${summary}` : ''} · ${status}${readRange ? ` · ${readRange.label}` : ''}` : undefined} disabled={!hasDetail} onClick={onToggle ?? (() => setOpen(!open))}>
      {surfaceMode === 'work' ? <span className="subagent-card__call-icon" aria-hidden="true">{call.status === 'running' ? <Spinner size={14} /> : <Icon name={quietToolIcon(call.name)} size={16} />}</span> : null}
      <span className="subagent-card__call-name">{toolDisplayName(call.name)}</span>
      {surfaceMode === 'code' ? <span className="subagent-card__call-summary">· {status}</span> : null}
      {summary && (surfaceMode === 'code' || !looksLikeStructuredResult(summary)) ? <span className="subagent-card__call-args" title={path || summary}>{summary}</span> : null}
      {surfaceMode === 'work' && call.status !== 'succeeded' ? <span className="subagent-card__call-summary">{status}</span> : null}
      {readRange ? <span className="subagent-card__call-range" title={readRange.title}>{readRange.label}</span> : null}
      {surfaceMode === 'work' && hasDetail ? <Icon name="chevron-right" size={12} className="subagent-card__call-chevron" /> : null}
    </button>
    {presence.present ? <div className="ui-motion-collapse subagent-card__call-presence" {...presence.motionProps}><div className="ui-motion-collapse__content"><div className="subagent-card__call-detail">{surfaceMode === 'work' ? <WorkToolOutcome tool={outcomeTool} /> : call.error ? <WorkErrorNotice error={call.error.message} /> : null}
      {run ? <ToolDetail call={call} run={run} latestSeq={latestSeq} visible={open && visible} surfaceMode={surfaceMode} /> : call.output ? <><div className="subagent-card__call-section">输出</div><ToolResult parsed={parsed} toolName={call.name} textClassName="subagent-card__call-pre" surfaceMode={surfaceMode} /></> : null}
    </div></div></div> : null}
  </div>
}

/** Expanded history is a bounded window at an explicit watermark, separate from live summaries. */
export function SubagentToolHistory({ run, visible = true, surfaceMode = 'code' }: { run: SubagentRunView; visible?: boolean; surfaceMode?: 'code' | 'work' }): JSX.Element {
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
  return <div className={`subagent-history${surfaceMode === 'work' ? ' subagent-history--work' : ''}`} aria-busy={loading}>
    <div className="subagent-history__toolbar"><span>{window ? surfaceMode === 'work' ? `已显示 ${calls.length.toLocaleString()} / ${window.totalCount.toLocaleString()} 条记录` : `${window.totalCount.toLocaleString()} 条历史记录 · 当前显示 ${calls.length.toLocaleString()} 次调用` : '正在读取记录'}</span>
      <button type="button" disabled={!ready || loading} onClick={() => void load(true)}><Icon name="restart" size={14} />更新记录</button></div>
    {window && window.scope.atSeq !== run.lastSeq ? <p className="subagent-history__notice" role="status">记录已更新，点击“更新记录”查看新活动。</p> : null}
    {window?.droppedCount ? <p className="subagent-history__notice">已读取 {window.loadedCount.toLocaleString()} 项，当前显示最近读取的记录；更早内容保留在服务端，可更新记录从头读取。</p> : null}
    {error ? <p className="subagent-history__error" role="alert">{error}<button type="button" disabled={!ready || loading} onClick={() => void load(true)}>重试</button></p> : null}
    <div className="subagent-card__tools-list">{calls.map(call => <SubagentToolRow key={call.id} call={call} run={anchor} latestSeq={run.lastSeq} open={selected === call.id} onToggle={() => setSelected(selected === call.id ? null : call.id)} visible={visible} surfaceMode={surfaceMode} />)}</div>
    {window?.hasMore ? <button type="button" className="subagent-history__more" disabled={!ready || loading} onClick={() => void load()}>{loading ? <Spinner size={14} /> : null}加载更多记录</button> : loading ? <p className="subagent-history__notice" role="status">正在读取工具记录…</p> : !calls.length && !error ? <p className="subagent-history__notice">此页没有可显示的工具记录。</p> : null}
  </div>
}
