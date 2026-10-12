import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '@shared/subagent'
import { useApp } from '@renderer/core/app-context'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { getSubagentRuns, refreshSubagentRuns, requestSubagentCancellation, subscribeSubagents } from '@renderer/core/engine/subagent-store'
import { isSubagentActive, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { SubagentCard } from '../chat/SubagentCard'
import { toolDisplayName } from '../chat/tool-names'
import { resolveWorkSubagentGroup, workSubagentGroups, type WorkSubagentGroup } from './work-subagents'
import { newWorkSubagentTranscriptMemory, WorkSubagentTranscript, type WorkSubagentTranscriptMemory } from './WorkSubagentTranscript'
import './work-subagents.css'

export interface WorkSubagentsPanelProps {
  sessionId: string | null
  tools: ToolActivity[]
  busy?: boolean
  active?: boolean
  onContinue?: (run: SubagentRun, prompt: string) => Promise<void>
}

interface PanelMemory {
  selected: string | null
  listTop: number
  detailTop: Map<string, number>
  drafts: Map<string, string>
  errors: Map<string, string>
  views: Map<string, 'rounds' | 'transcript'>
  transcripts: Map<string, WorkSubagentTranscriptMemory>
}

function newMemory(): PanelMemory {
  return { selected: null, listTop: 0, detailTop: new Map(), drafts: new Map(), errors: new Map(), views: new Map(), transcripts: new Map() }
}

function currentAction(group: WorkSubagentGroup): string {
  const run = group.tools.find(tool => tool.subagent && isSubagentActive(tool.subagent.status))?.subagent
  const call = run ? [...run.toolCalls].reverse().find(item => item.status === 'running') : undefined
  if (call) return `正在${toolDisplayName(call.name)}`
  if (run?.status === 'cancelling') return '正在停止本轮工作'
  if (run?.status === 'queued') return '已排队，等待开始'
  return group.active ? '正在执行任务' : group.latest.subagent?.description || '点击查看过程与产出'
}

/** The list represents durable child contexts; run cards belong only in their own detail view. */
export function WorkSubagentsPanel({ sessionId, tools, busy = false, active: panelActive = true, onContinue }: WorkSubagentsPanelProps): JSX.Element {
  const { ready } = useApp()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [sendingKey, setSendingKey] = useState<string | null>(null)
  const [cancellingKey, setCancellingKey] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const sendingRef = useRef(false)
  const cancellingRef = useRef(false)
  const memoryBySession = useRef(new Map<string, PanelMemory>())
  const generation = useRef(0)
  const mounted = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const returningTo = useRef<string | null>(null)
  const source = getEngineSource()
  const scope = `${source}:${sessionId ?? ''}`
  if (!memoryBySession.current.has(scope)) memoryBySession.current.set(scope, newMemory())
  const memory = memoryBySession.current.get(scope)!
  const redraw = (): void => setRevision(value => value + 1)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  useLayoutEffect(() => {
    if (!panelActive) return
    const off = subscribeSubagents(redraw)
    const offSource = subscribeEngineSource(redraw)
    redraw()
    return () => { off(); offSource() }
  }, [panelActive])
  useEffect(() => {
    setError('')
    generation.current++
    sendingRef.current = false
    cancellingRef.current = false
    setSendingKey(null)
    setCancellingKey(null)
  }, [scope])
  useEffect(() => {
    // Keeping task-local drafts is useful, but references from a disconnected
    // engine must never be reused against the next engine source.
    for (const key of memoryBySession.current.keys()) if (!key.startsWith(`${source}:`)) memoryBySession.current.delete(key)
  }, [source])
  useEffect(() => {
    if (!sessionId || !ready || !panelActive) return
    let alive = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.hidden) return
      pending = true
      try {
        await refreshSubagentRuns(sessionId)
        if (alive && source === getEngineSource()) setError('')
      } catch (cause) {
        if (alive && source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId, ready, source, refreshKey, panelActive])

  const groups = useMemo(() => sessionId ? workSubagentGroups(sessionId, tools, getSubagentRuns(sessionId)) : [], [sessionId, tools, revision])
  const selected = resolveWorkSubagentGroup(groups, memory.selected)
  const activeRun = selected?.tools.find(tool => tool.subagent && isSubagentActive(tool.subagent.status))?.subagent
  const running = groups.filter(group => group.active)
  const completed = groups.filter(group => !group.active)
  const transcriptRun = selected?.tools.find(tool => tool.subagent)?.subagent
  const selectedView = selected ? memory.views.get(selected.key) ?? 'rounds' : 'rounds'
  if (selected && !memory.transcripts.has(selected.key)) memory.transcripts.set(selected.key, newWorkSubagentTranscriptMemory())
  useEffect(() => {
    if (!panelActive || !running.length) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [panelActive, running.length])
  useLayoutEffect(() => {
    if (!panelActive) return
    if (selected) {
      const previousKey = memory.selected
      const migrated = previousKey !== null && previousKey !== selected.key
      if (migrated) {
        for (const values of [memory.drafts, memory.errors]) {
          if (values.has(previousKey) && !values.has(selected.key)) values.set(selected.key, values.get(previousKey)!)
          values.delete(previousKey)
        }
        if (memory.detailTop.has(previousKey) && !memory.detailTop.has(selected.key)) memory.detailTop.set(selected.key, memory.detailTop.get(previousKey)!)
        memory.detailTop.delete(previousKey)
        if (memory.views.has(previousKey) && !memory.views.has(selected.key)) memory.views.set(selected.key, memory.views.get(previousKey)!)
        if (memory.transcripts.has(previousKey)) memory.transcripts.set(selected.key, memory.transcripts.get(previousKey)!)
        memory.views.delete(previousKey)
        memory.transcripts.delete(previousKey)
        memory.selected = selected.key
        redraw()
      }
      if (detailRef.current) detailRef.current.scrollTop = memory.detailTop.get(selected.key) ?? 0
      if (!migrated) backRef.current?.focus({ preventScroll: true })
    } else {
      if (listRef.current) listRef.current.scrollTop = memory.listTop
      if (returningTo.current) rowRefs.current.get(returningTo.current)?.focus({ preventScroll: true })
      returningTo.current = null
    }
  }, [scope, selected?.key, panelActive])
  useLayoutEffect(() => {
    if (panelActive && selectedView === 'rounds' && selected && detailRef.current)
      detailRef.current.scrollTop = memory.detailTop.get(selected.key) ?? 0
  }, [scope, selected?.key, selectedView, panelActive])

  const openDetail = (group: WorkSubagentGroup): void => {
    memory.listTop = listRef.current?.scrollTop ?? memory.listTop
    memory.selected = group.key
    redraw()
  }
  const backToList = (): void => {
    if (selected) {
      if (detailRef.current) memory.detailTop.set(selected.key, detailRef.current.scrollTop)
      returningTo.current = selected.key
    }
    memory.selected = null
    redraw()
  }
  const continueRun = async (group: WorkSubagentGroup): Promise<void> => {
    const run = group.latest.subagent
    const draft = memory.drafts.get(group.key) ?? ''
    if (!run?.continuation || !onContinue || !draft.trim() || group.active || busy || sendingRef.current || !ready) return
    sendingRef.current = true
    setSendingKey(group.key)
    memory.errors.delete(group.key)
    const currentGeneration = generation.current
    const current = (): boolean => mounted.current && currentGeneration === generation.current && source === getEngineSource()
    try {
      await onContinue(run, draft.trim())
      if (current() && memory.drafts.get(group.key) === draft) memory.drafts.delete(group.key)
    } catch (cause) {
      if (current()) memory.errors.set(group.key, cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) { sendingRef.current = false; setSendingKey(null); redraw() }
    }
  }
  const cancelRun = async (group: WorkSubagentGroup): Promise<void> => {
    const run = group.tools.find(tool => tool.subagent && isSubagentActive(tool.subagent.status))?.subagent
    if (!run || !ready || cancellingRef.current || run.status === 'cancelling') return
    cancellingRef.current = true
    setCancellingKey(group.key)
    memory.errors.delete(group.key)
    const currentGeneration = generation.current
    const current = (): boolean => mounted.current && currentGeneration === generation.current && source === getEngineSource()
    try {
      await requestSubagentCancellation(run.runId)
    } catch (cause) {
      if (current()) memory.errors.set(group.key, `停止失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (current()) { cancellingRef.current = false; setCancellingKey(null); redraw() }
    }
  }
  const renderRow = (group: WorkSubagentGroup): JSX.Element => {
    const run = group.latest.subagent
    const age = run ? Math.max(0, Math.round((now - (run.updatedAt || run.createdAt)) / 60000)) : 0
    return <button type="button" className="work-subagents__row" key={group.key} ref={node => { if (node) rowRefs.current.set(group.key, node); else rowRefs.current.delete(group.key) }} data-child-session-id={group.childSessionId} onClick={() => openDetail(group)} aria-label={`查看 ${group.label} 子代理详情`}>
      <span className={`work-subagents__avatar${group.active ? ' work-subagents__avatar--active' : ''}`}>
        {group.active ? <Spinner size={16} /> : <Icon name="account-outline" size={18} />}
      </span>
      <span className="work-subagents__row-content"><strong>{group.label}</strong><span>{currentAction(group)}</span></span>
      <span className="work-subagents__row-meta"><span>{toolStatusLabel(group.latest)}</span><span>{group.tools.length} 轮{!group.active && run ? ` · ${age ? `${age} 分钟前` : '刚刚'}` : ''}</span></span>
      <Icon name="chevron-right" size={16} />
    </button>
  }

  return <section className={`work-subagents${selected ? ' work-subagents--detail' : ''}`} aria-label="协作代理" onKeyDown={event => {
    if (event.key === 'Escape' && selected && event.target instanceof HTMLElement && !event.target.closest('textarea')) { event.preventDefault(); backToList() }
  }}>
    <header className="work-subagents__header">
      {selected ? <>
        <button type="button" className="work-subagents__back" ref={backRef} onClick={backToList} aria-label="返回子代理列表" title="返回子代理列表 (Esc)"><Icon name="chevron-right" size={18} /></button>
        <span className="work-subagents__avatar"><Icon name="account-outline" size={18} /></span>
        <div className="work-subagents__heading"><h3>{selected.label}</h3><p><span role="status" className={`work-subagents__status work-subagents__status--${selected.latest.state}`}>{toolStatusLabel(selected.latest)}</span> · {selected.tools.length} 轮工作 · 上下文持续保留</p></div>
        <span className="work-subagents__model" title={selected.modelId}>{selected.modelId}</span>
      </> : <div className="work-subagents__heading"><h3>协作代理</h3><p>{groups.length ? `${running.length} 个正在运行 · ${groups.length} 个代理` : '在对话中 @Agent，邀请它协作完成工作'}</p></div>}
      <button type="button" className="work-subagents__refresh" disabled={!sessionId || !ready} onClick={() => setRefreshKey(value => value + 1)} aria-label="刷新子代理状态" title="刷新状态"><Icon name="restart" size={16} /></button>
    </header>
    {error ? <div className="work-subagents__error" role="alert">状态更新失败：{error}</div> : null}
    {selected ? <>
      <div className="work-subagents__tabs" aria-label="子代理详情视图">
        <button type="button" aria-pressed={selectedView === 'rounds'} onClick={() => { memory.views.set(selected.key, 'rounds'); redraw() }}>工作轮次</button>
        <button type="button" aria-pressed={selectedView === 'transcript'} disabled={!transcriptRun?.childSessionId} title={!transcriptRun?.childSessionId ? '代理开始后可查看独立会话' : undefined} onClick={() => { if (detailRef.current) memory.detailTop.set(selected.key, detailRef.current.scrollTop); memory.views.set(selected.key, 'transcript'); redraw() }}>完整对话</button>
      </div>
      {selected.active ? <div className="work-subagents__live" role="status"><Spinner size={14} /><span>{currentAction(selected)}</span>{activeRun ? <button type="button" disabled={!ready || cancellingKey !== null || activeRun.status === 'cancelling'} onClick={() => void cancelRun(selected)}>{cancellingKey === selected.key || activeRun.status === 'cancelling' ? '正在停止…' : '停止本轮'}</button> : null}</div> : null}
      {selectedView === 'transcript' && transcriptRun?.childSessionId ? <WorkSubagentTranscript source={source} parentSessionId={sessionId!} childSessionId={transcriptRun.childSessionId} runId={transcriptRun.runId} name={selected.label} memory={memory.transcripts.get(selected.key)!} active={panelActive} running={selected.active} /> : <div className="work-subagents__detail" ref={detailRef} onScroll={event => memory.detailTop.set(selected.key, event.currentTarget.scrollTop)} aria-label={`${selected.label} 的工作记录`}>
        {[...selected.tools].reverse().map((tool, index) => <article className="work-subagents__round" key={tool.subagent?.runId || tool.id} data-run-id={tool.subagent?.runId}>
          <div className="work-subagents__round-heading"><span>第 {index + 1} 轮</span><time dateTime={tool.subagent?.createdAt ? new Date(tool.subagent.createdAt).toISOString() : undefined}>{tool.subagent?.createdAt ? new Date(tool.subagent.createdAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '历史记录'}</time></div>
          <SubagentCard tool={tool} sessionId={sessionId!} defaultOpen={index === selected.tools.length - 1} />
        </article>)}
      </div>}
      {selected.latest.subagent?.continuation && onContinue ? <form className="work-subagents__composer" onSubmit={event => { event.preventDefault(); void continueRun(selected) }}>
        <label htmlFor="work-subagent-followup">继续交给 {selected.label}</label>
        <textarea id="work-subagent-followup" value={memory.drafts.get(selected.key) ?? ''} onChange={event => { memory.drafts.set(selected.key, event.target.value); memory.errors.delete(selected.key); redraw() }} rows={2} placeholder="安排下一步，或补充要求；保留此代理的上下文" aria-describedby="work-subagent-followup-hint" onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void continueRun(selected) }
        }} />
        {memory.errors.get(selected.key) ? <p className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
        <div className="work-subagents__composer-actions"><p id="work-subagent-followup-hint">{selected.active ? '本轮执行中，可先写下下一步' : busy ? '请等待主任务结束后发送' : 'Ctrl / ⌘ Enter 继续执行'}</p><button type="submit" disabled={selected.active || busy || sendingKey !== null || !ready || !(memory.drafts.get(selected.key) ?? '').trim()}>{sendingKey === selected.key ? <><Spinner size={14} />正在提交…</> : <><Icon name="send" size={14} />继续执行</>}</button></div>
      </form> : memory.errors.get(selected.key) ? <p className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
    </> : <div className="work-subagents__list" ref={listRef} onScroll={event => { memory.listTop = event.currentTarget.scrollTop }}>
      {groups.length ? <>
        <section className="work-subagents__group" aria-label="正在运行的子代理"><h4>正在运行 <span>{running.length}</span></h4>{running.length ? running.map(renderRow) : <p className="work-subagents__group-empty">当前没有正在运行的子代理</p>}</section>
        <section className="work-subagents__group" aria-label="已结束的子代理"><h4>已结束 <span>{completed.length}</span></h4>{completed.length ? completed.map(renderRow) : <p className="work-subagents__group-empty">结束后的工作记录会保留在这里</p>}</section>
      </> : <div className="work-subagents__empty"><Icon name="account-outline" size={28} /><h4>让专长各异的 Agent 一起工作</h4><p>在对话中使用 @Agent 指定分工。这里会显示它的执行过程和产出，也能继续安排下一步。</p></div>}
    </div>}
  </section>
}
