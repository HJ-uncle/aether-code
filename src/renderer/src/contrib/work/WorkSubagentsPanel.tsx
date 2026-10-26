import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { SubagentRun } from '@shared/subagent'
import type { PublishedChildReference } from '@shared/published-child'
import { useApp } from '@renderer/core/app-context'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { useCollaborationController } from '@renderer/core/engine/useCollaborationController'
import { getSubagentDirectory, getSubagentDiscovery, getSubagentRuns, loadMoreSubagentRuns, refreshSubagentRuns, restartSubagentDirectory, requestSubagentCancellation, captureSubagentRunScope, subscribeSubagents } from '@renderer/core/engine/subagent-store'
import { isSubagentActive, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { SubagentCard } from '../chat/SubagentCard'
import { ControllerReceiptHistory, ControllerTrackingRecovery, SubagentFollowupInput } from '../chat/SubagentFollowup'
import { CollaborationReceiptInspector } from '../chat/CollaborationReceiptInspector'
import { subagentToolPresentation } from '../chat/subagent-tool-presentation'
import { toolDisplayName } from '../chat/tool-names'
import { formatWorkSubagentDuration, resolveWorkSubagentGroup, workSubagentGroups, workSubagentStats, type WorkSubagentGroup } from './work-subagents'
import { newWorkSubagentTranscriptMemory, WorkSubagentTranscript, type WorkSubagentTranscriptMemory } from './WorkSubagentTranscript'
import { trimWorkSubagentSessionCaches } from './work-subagent-memory'
import { publishedDetailKey, publishedVisibleWindow, rememberPublishedDetail } from '@renderer/core/engine/published-card-memory'
import './work-subagents.css'

export interface WorkSubagentsPanelProps {
  sessionId: string | null
  rootRunId?: string
  tools: ToolActivity[]
  busy?: boolean
  active?: boolean
  publishedFixedChildren?: boolean
  onContinue?: (run: SubagentRun, prompt: string) => Promise<void>
}

interface PanelMemory {
  selected: string | null
  listTop: number
  detailTop: Map<string, number>
  drafts: Map<string, string>
  errors: Map<string, string>
  views: Map<string, 'rounds' | 'transcript'>
  followups: Map<string, boolean>
  transcripts: Map<string, WorkSubagentTranscriptMemory>
}

function newMemory(): PanelMemory {
  return { selected: null, listTop: 0, detailTop: new Map(), drafts: new Map(), errors: new Map(), views: new Map(), followups: new Map(), transcripts: new Map() }
}

const SHORT_WINDOW_QUERY = '(max-height: 720px)'
function subscribeShortWindow(notify: () => void): () => void {
  const query = window.matchMedia(SHORT_WINDOW_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
function shortWindowSnapshot(): boolean { return window.matchMedia(SHORT_WINDOW_QUERY).matches }
function serverWindowSnapshot(): boolean { return false }

function currentAction(group: WorkSubagentGroup): string {
  if (group.latest.subagentRef) return '已发布记录，点击查看过程与产出'
  const run = group.tools.find(tool => tool.subagent && isSubagentActive(tool.subagent.status))?.subagent ?? group.latest.subagent
  const presentation = subagentToolPresentation(run)
  const latest = run?.schemaVersion === 2 && run.latestActivity && isVisibleToolActivity(run.latestActivity) ? run.latestActivity : undefined
  const call = latest?.status === 'running' ? latest : [...presentation.calls].sort((a, b) =>
    ('revisionSeq' in b && typeof b.revisionSeq === 'number' ? b.revisionSeq : b.startedAt ?? 0) -
    ('revisionSeq' in a && typeof a.revisionSeq === 'number' ? a.revisionSeq : a.startedAt ?? 0)).find(item => item.status === 'running')
  if (call) return `正在${toolDisplayName(call.name)}`
  if (run?.status === 'cancelling') return '正在停止本轮工作'
  if (run?.status === 'queued') return '已排队，等待开始'
  if (run && isSubagentActive(run.status) && presentation.unseenActiveCount > 0) return '正在执行任务'
  if (latest) return `最近${toolDisplayName(latest.name)}`
  return group.active ? '正在执行任务' : group.latest.subagent?.description || '点击查看过程与产出'
}

/** The list represents durable child contexts; run cards belong only in their own detail view. */
export function WorkSubagentsPanel({ sessionId, rootRunId, tools, busy = false, active: panelActive = true, publishedFixedChildren = false, onContinue }: WorkSubagentsPanelProps): JSX.Element {
  const { ready } = useApp()
  const shortWindow = useSyncExternalStore(subscribeShortWindow, shortWindowSnapshot, serverWindowSnapshot)
  const followupId = useId()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [visibleCount, setVisibleCount] = useState(64)
  const [roundCount, setRoundCount] = useState(64)
  const [fixedDetails, setFixedDetails] = useState(new Map<string, SubagentRun>())
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
  const followupToggleRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const returningTo = useRef<string | null>(null)
  const selectedRunIdRef = useRef<string | undefined>(undefined)
  const selectedKeyRef = useRef<string | undefined>(undefined)
  const selectionRef = useRef({ key: '', generation: 0 })
  const source = getEngineSource()
  const scope = `${source}:${sessionId ?? ''}`
  if (!memoryBySession.current.has(scope)) memoryBySession.current.set(scope, newMemory())
  const memory = memoryBySession.current.get(scope)!
  memoryBySession.current.delete(scope)
  memoryBySession.current.set(scope, memory)
  trimWorkSubagentSessionCaches(memoryBySession.current)
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
    setVisibleCount(64)
    setRoundCount(64)
    setFixedDetails(new Map())
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
    if (!sessionId || !ready || !panelActive || publishedFixedChildren) return
    let alive = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.hidden) return
      pending = true
      try {
        await refreshSubagentRuns(sessionId, { selectedRunId: selectedRunIdRef.current })
        if (alive && source === getEngineSource()) setError('')
      } catch (cause) {
        if (alive && source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId, ready, source, refreshKey, panelActive, publishedFixedChildren])

  const groups = useMemo(() => sessionId ? workSubagentGroups(sessionId, tools.map(tool => tool.subagentRef && fixedDetails.has(publishedDetailKey(tool.subagentRef))
    ? { ...tool, subagent: fixedDetails.get(publishedDetailKey(tool.subagentRef)) } : tool), publishedFixedChildren ? [] : getSubagentRuns(sessionId)) : [], [sessionId, tools, revision, fixedDetails, publishedFixedChildren])
  const selected = resolveWorkSubagentGroup(groups, memory.selected)
  const activeRun = selected?.tools.find(tool => !tool.subagentRef && tool.subagent && isSubagentActive(tool.subagent.status))?.subagent
  const running = groups.filter(group => group.active)
  const completed = groups.filter(group => !group.active)
  const groupWindow = publishedVisibleWindow(groups, visibleCount)
  const visibleGroups = new Set(groupWindow.items.map(group => group.key))
  const roundWindow = publishedVisibleWindow(selected?.tools ?? [], roundCount)
  const transcriptRun = selected?.tools.find(tool => tool.subagent)?.subagent
  selectedRunIdRef.current = activeRun?.runId ?? transcriptRun?.runId
  selectedKeyRef.current = selected?.key
  const selectionKey = JSON.stringify([scope, selected?.key, selectedRunIdRef.current])
  if (selectionRef.current.key !== selectionKey) selectionRef.current = { key: selectionKey, generation: selectionRef.current.generation + 1 }
  const liveFollowup = useCollaborationController({ sessionId, rootRunId, source,
    childSessionId: selected?.childSessionId, invocationRunId: selectedRunIdRef.current,
    active: Boolean(activeRun && !publishedFixedChildren && !selected?.latest.subagentRef), ready, toolProfile: 'general', refreshKey,
    onUnacceptedDraft: message => { if (selected && !memory.drafts.has(selected.key)) { memory.drafts.set(selected.key, message); redraw() } } })
  const directory = getSubagentDirectory(sessionId)
  const discovery = getSubagentDiscovery(sessionId)
  const selectedView = selected ? memory.views.get(selected.key) ?? 'rounds' : 'rounds'
  useEffect(() => { setRoundCount(64) }, [selected?.key])
  // The resolver proves a legacy key belongs to this durable child. Read its
  // draft and disclosure choice before layout migration to avoid a hidden frame.
  const previousSelectedKey = selected && memory.selected !== selected.key ? memory.selected : null
  const selectedDraft = selected ? memory.drafts.get(selected.key) ?? (previousSelectedKey ? memory.drafts.get(previousSelectedKey) : undefined) ?? liveFollowup.restoredDraft?.message ?? '' : ''
  // Resize changes only the default. An explicit choice (or editing the draft)
  // must survive a smaller window, so the editor never disappears under focus.
  const followupExpanded = selected ? memory.followups.get(selected.key) ?? (previousSelectedKey ? memory.followups.get(previousSelectedKey) : undefined) ?? !shortWindow : false
  if (selected && !memory.transcripts.has(selected.key)) memory.transcripts.set(selected.key, newWorkSubagentTranscriptMemory())
  if (selected) {
    const transcript = memory.transcripts.get(selected.key)!
    memory.transcripts.delete(selected.key)
    memory.transcripts.set(selected.key, transcript)
  }
  while (memory.transcripts.size > 2) memory.transcripts.delete(memory.transcripts.keys().next().value!)
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
        if (memory.followups.has(previousKey) && !memory.followups.has(selected.key)) memory.followups.set(selected.key, memory.followups.get(previousKey)!)
        if (memory.transcripts.has(previousKey)) memory.transcripts.set(selected.key, memory.transcripts.get(previousKey)!)
        memory.views.delete(previousKey)
        memory.followups.delete(previousKey)
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
  const readDirectory = async (restart: boolean): Promise<void> => {
    if (!sessionId || !ready || publishedFixedChildren) return
    const currentGeneration = generation.current
    try {
      await (restart ? restartSubagentDirectory(sessionId) : loadMoreSubagentRuns(sessionId))
      if (mounted.current && currentGeneration === generation.current && source === getEngineSource()) setError('')
    } catch (cause) {
      if (mounted.current && currentGeneration === generation.current && source === getEngineSource())
        setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const rememberFixedDetail = (run: SubagentRun, reference: PublishedChildReference): void => {
    setFixedDetails(previous => rememberPublishedDetail(previous, run, reference, { source: getEngineSource(), sessionId }))
  }
  const continueRun = async (group: WorkSubagentGroup, draft: string): Promise<void> => {
    const run = group.latest.subagent
    if (group.latest.subagentRef && run && isSubagentActive(run.status)) return
    if (!run?.continuation || !onContinue || !draft.trim() || group.active || busy || sendingRef.current || !ready) return
    sendingRef.current = true
    setSendingKey(group.key)
    memory.errors.delete(group.key)
    const currentGeneration = generation.current
    const currentSelection = selectionRef.current.generation
    const current = (): boolean => mounted.current && currentGeneration === generation.current && source === getEngineSource()
      && currentSelection === selectionRef.current.generation && selectedKeyRef.current === group.key && selectedRunIdRef.current === run.runId
    try {
      await onContinue(run, draft.trim())
      if (current() && memory.drafts.get(group.key) === draft) memory.drafts.delete(group.key)
    } catch (cause) {
      if (current()) memory.errors.set(group.key, cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current && currentGeneration === generation.current) {
        sendingRef.current = false
        setSendingKey(key => key === group.key ? null : key)
        redraw()
      }
    }
  }
  const submitFollowup = async (group: WorkSubagentGroup): Promise<void> => {
    if (liveFollowup.busy) return
    const selectedGeneration = selectionRef.current.generation
    const sourceGeneration = generation.current
    const originalDraft = memory.drafts.get(group.key)
    const original = originalDraft ?? liveFollowup.restoredDraft?.message ?? ''
    const clearsSentDraft = !liveFollowup.pending || originalDraft === undefined || originalDraft.trim() === liveFollowup.pending.message
    const message = liveFollowup.pending?.message ?? original.trim()
    const accepted = liveFollowup.pending ? await liveFollowup.reconcile()
      : group.active ? await liveFollowup.send(message) : false
    if (accepted && clearsSentDraft && mounted.current && source === getEngineSource() && sourceGeneration === generation.current
      && selectedGeneration === selectionRef.current.generation && selectedKeyRef.current === group.key && memory.drafts.get(group.key) === originalDraft) {
      memory.drafts.delete(group.key)
      redraw()
    }
    if (!liveFollowup.pending && !group.active) await continueRun(group, original)
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
      await requestSubagentCancellation(run.runId, captureSubagentRunScope(run, source))
    } catch (cause) {
      if (current()) memory.errors.set(group.key, `停止失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (current()) { cancellingRef.current = false; setCancellingKey(null); redraw() }
    }
  }
  const renderRow = (group: WorkSubagentGroup): JSX.Element => {
    const run = group.latest.subagent
    const stats = workSubagentStats(group, now)
    const age = run ? Math.max(0, Math.round((now - (run.updatedAt || run.createdAt)) / 60000)) : 0
    const duration = formatWorkSubagentDuration(stats.durationMs)
    const latestTool = stats.latestTool?.name ? toolDisplayName(stats.latestTool.name) : undefined
    const status = toolStatusLabel(group.latest)
    return <button type="button" className="work-subagents__row" key={group.key} ref={node => { if (node) rowRefs.current.set(group.key, node); else rowRefs.current.delete(group.key) }} data-child-session-id={group.childSessionId} data-agent-status={stats.status} data-model-id={stats.modelId || undefined} data-tool-count={stats.toolCount} data-active-tool-count={stats.activeToolCount} data-pending={stats.pending ? 'true' : 'false'} onClick={() => openDetail(group)} aria-label={`查看 ${group.label} 子代理详情`}>
      <span className={`work-subagents__avatar${group.active ? ' work-subagents__avatar--active' : ''}`}>
        {group.active ? <Spinner size={16} /> : <Icon name="account-outline" size={18} />}
      </span>
      <span className="work-subagents__row-content"><strong>{group.label}</strong><span>{currentAction(group)}</span><span className="work-subagents__row-properties" aria-label="子代理属性">
        {stats.modelId ? <span className="work-subagents__row-model" title={`模型 ${stats.modelId}`}>模型 {stats.modelId}</span> : null}
        {latestTool ? <span title={`最近工具 ${latestTool}`}>最近 {latestTool}</span> : null}
        {stats.pending ? <span className="work-subagents__row-pending">待处理</span> : null}
      </span></span>
      <span className="work-subagents__row-meta"><span className={`work-subagents__row-status work-subagents__row-status--${group.active ? 'active' : 'complete'}`}>{status}</span><span>{group.tools.length} 轮 · {stats.toolCount} 工具{stats.activeToolCount ? ` · ${stats.activeToolCount} 执行中` : ''}</span><span>{duration ? `耗时 ${duration}` : !group.active && run ? (age ? `${age} 分钟前` : '刚刚') : '等待开始'}</span></span>
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
        <div className="work-subagents__heading"><h3>{selected.label}</h3><p><span role="status" className={`work-subagents__status work-subagents__status--${selected.latest.state}`}>{toolStatusLabel(selected.latest)}</span></p></div>
        <span className="work-subagents__model" title={selected.modelId}>{selected.modelId}</span>
      </> : <div className="work-subagents__heading"><h3>协作代理</h3><p>{publishedFixedChildren ? `已发布 ${groups.length} 个代理记录，按需查看详情` : discovery.state?.activeCount !== undefined
        ? discovery.state.activeCount > 0 ? `${discovery.state.activeCount} 个运行中` : groups.length ? `${groups.length} 个代理` : '暂无协作代理'
        : groups.length ? `${running.length} 个运行中 · ${groups.length} 个代理`
          : discovery.loading ? '正在发现协作代理…' : '在对话中 @Agent，邀请它协作完成工作'}</p></div>}
      {!publishedFixedChildren ? <button type="button" className="work-subagents__refresh" disabled={!sessionId || !ready} onClick={() => setRefreshKey(value => value + 1)} aria-label="刷新子代理状态" title="刷新状态"><Icon name="restart" size={16} /></button> : null}
    </header>
    {error || !publishedFixedChildren && discovery.error ? <div className="work-subagents__error" role="alert">状态更新失败：{error || discovery.error} · 保留上次确认状态</div> : null}
    {selected ? <>
      <div className="work-subagents__tabs" aria-label="子代理详情视图">
        <button type="button" aria-pressed={selectedView === 'rounds'} onClick={() => { memory.views.set(selected.key, 'rounds'); redraw() }}>工作轮次</button>
        <button type="button" aria-pressed={selectedView === 'transcript'} disabled={Boolean(selected.latest.subagentRef) || !transcriptRun?.childSessionId} title={selected.latest.subagentRef ? '当前显示固定发布记录；恢复实时更新后可查看独立会话' : !transcriptRun?.childSessionId ? '代理开始后可查看独立会话' : undefined} onClick={() => { if (detailRef.current) memory.detailTop.set(selected.key, detailRef.current.scrollTop); memory.views.set(selected.key, 'transcript'); redraw() }}>完整对话</button>
      </div>
      {selected.active ? <div className="work-subagents__live" role="status"><Spinner size={14} /><span className="work-subagents__live-label">{currentAction(selected)}</span>{activeRun ? <button type="button" disabled={!ready || cancellingKey !== null || activeRun.status === 'cancelling'} onClick={() => void cancelRun(selected)}>{cancellingKey === selected.key || activeRun.status === 'cancelling' ? '正在停止…' : '停止本轮'}</button> : null}</div> : null}
      {rootRunId && selected.childSessionId && selectedRunIdRef.current && !selected.latest.subagentRef && !publishedFixedChildren ? <CollaborationReceiptInspector
        key={selectionKey} target={{ rootRunId, rootSessionId: sessionId!, childSessionId: selected.childSessionId, invocationRunId: selectedRunIdRef.current }}
        source={source} ready={ready} visible={panelActive} /> : null}
      {selectedView === 'transcript' && !selected.latest.subagentRef && transcriptRun?.childSessionId ? <WorkSubagentTranscript source={source} parentSessionId={sessionId!} childSessionId={transcriptRun.childSessionId} runId={transcriptRun.runId} name={selected.label} memory={memory.transcripts.get(selected.key)!} active={panelActive} running={selected.active} /> : <div className="work-subagents__detail" ref={detailRef} onScroll={event => memory.detailTop.set(selected.key, event.currentTarget.scrollTop)} aria-label={`${selected.label} 的工作记录`}>
        {[...roundWindow.items].reverse().map((tool, index) => <article className="work-subagents__round" key={tool.subagent?.runId || tool.id} data-run-id={tool.subagent?.runId}>
          <div className="work-subagents__round-heading"><span>第 {selected.tools.length - roundWindow.end + index + 1} 轮</span><time dateTime={tool.subagent?.createdAt ? new Date(tool.subagent.createdAt).toISOString() : undefined}>{tool.subagent?.createdAt ? new Date(tool.subagent.createdAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '历史记录'}</time></div>
          <SubagentCard tool={tool} sessionId={sessionId!} defaultOpen={index === roundWindow.items.length - 1} visible={panelActive} onPublishedLoaded={rememberFixedDetail} />
        </article>)}
        <div className="work-subagents__pagination"><span>轮次 {roundWindow.start + 1}–{roundWindow.end} / {selected.tools.length}</span>
          {roundWindow.start > 0 ? <button type="button" className="btn btn--sm" onClick={() => setRoundCount(count => Math.max(64, count - 64))}>较新轮次</button> : null}
          {roundWindow.end < selected.tools.length ? <button type="button" className="btn btn--sm" onClick={() => setRoundCount(count => count + 64)}>较早轮次</button> : null}</div>
      </div>}
      {liveFollowup.pending || liveFollowup.restoredDraft || liveFollowup.history.length || activeRun && !selected.latest.subagentRef || selected.latest.subagent?.continuation && (!selected.latest.subagentRef || !isSubagentActive(selected.latest.subagent.status)) && onContinue ? <div className="work-subagents__followup">
        <button type="button" ref={followupToggleRef} className="work-subagents__followup-toggle" aria-expanded={followupExpanded} aria-controls={`${followupId}-form`} aria-label={`${followupExpanded ? '收起' : '展开'}${selected.active ? '补充要求给' : '继续交给'} ${selected.label}`} onClick={() => { memory.followups.set(selected.key, !followupExpanded); redraw() }}>
          <Icon name="chevron-down" size={14} /><span id={`${followupId}-label`}>{selected.active ? '补充要求给' : '继续交给'} {selected.label}</span>{!followupExpanded && (selectedDraft.trim() || liveFollowup.pending) ? <span className="work-subagents__draft-status">{liveFollowup.pending ? '结果待核对' : '已保留草稿'}</span> : null}
        </button>
        <form id={`${followupId}-form`} className="work-subagents__composer" hidden={!followupExpanded} onFocusCapture={() => memory.followups.set(selected.key, true)} onSubmit={event => { event.preventDefault(); void submitFollowup(selected) }}>
        <SubagentFollowupInput id={`${followupId}-input`} value={liveFollowup.pending?.message ?? selectedDraft} readOnly={Boolean(liveFollowup.pending)} onChange={value => { memory.drafts.set(selected.key, value); memory.errors.delete(selected.key); redraw() }} placeholder={selected.active ? '补充本轮要求；继续使用此代理的上下文' : '安排下一步，或补充要求；保留此代理的上下文'} labelledBy={`${followupId}-label`} describedBy={`${followupId}-hint`}
          onDismiss={() => { memory.followups.set(selected.key, false); redraw(); followupToggleRef.current?.focus() }} onSubmit={() => void submitFollowup(selected)} />
        <div className="work-subagents__composer-actions"><p id={`${followupId}-hint`}>{liveFollowup.pending ? '原要求已冻结；核对不会重复发送' : selected.active ? !rootRunId ? '正在确认主任务的协作上下文' : liveFollowup.capability === undefined ? '正在确认引擎协作能力…' : liveFollowup.capability ? '本轮补充要求将排队，保留当前代理上下文' : '当前引擎尚未启用运行中补充要求；草稿会保留' : busy ? '请等待主任务结束后发送' : 'Ctrl / ⌘ Enter 继续执行'}</p><button type="submit" disabled={liveFollowup.busy || sendingKey !== null || !ready || (!liveFollowup.pending && (!selectedDraft.trim() || (selected.active ? !liveFollowup.capability : busy)))}>{sendingKey === selected.key || liveFollowup.busy ? <><Spinner size={14} />{liveFollowup.pending ? '正在核对…' : '正在提交…'}</> : liveFollowup.pending ? '核对排队结果' : <><Icon name="send" size={14} />{selected.active ? '发送补充要求' : '继续执行'}</>}</button></div>
        {liveFollowup.notice ? <p className="work-subagents__followup-notice" role="status">{liveFollowup.notice}</p> : null}
        {liveFollowup.canRetry ? <button type="button" className="work-subagents__retry-original" disabled={liveFollowup.busy || !ready} onClick={() => void liveFollowup.retry().then(accepted => {
          if (accepted && selectedKeyRef.current === selected.key && memory.drafts.get(selected.key)?.trim() === liveFollowup.pending?.message) { memory.drafts.delete(selected.key); redraw() }
        })}>重试原请求</button> : null}
        {liveFollowup.pending ? <ControllerTrackingRecovery message={liveFollowup.pending.message} disabled={liveFollowup.busy || !ready} onForget={liveFollowup.forgetTracking} /> : null}
        {liveFollowup.restoredDraft && !liveFollowup.pending ? <button type="button" className="work-subagents__retry-original" disabled={liveFollowup.busy || !ready} onClick={() => {
          const original = liveFollowup.restoredDraft?.message
          void liveFollowup.discardDraft().then(cleared => { if (cleared && selectedKeyRef.current === selected.key && memory.drafts.get(selected.key) === original) { memory.drafts.delete(selected.key); redraw() } })
        }}>清除已结束的草稿</button> : null}
        </form>
        <ControllerReceiptHistory records={liveFollowup.history} rootRunId={rootRunId} invocationRunId={selectedRunIdRef.current} disabled={liveFollowup.busy || !ready} onQuery={liveFollowup.queryHistory} onRemove={liveFollowup.removeHistory} />
        {liveFollowup.error ? <p className="work-subagents__error" role="alert">{liveFollowup.error}</p> : null}
        {memory.errors.get(selected.key) ? <p className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
      </div> : memory.errors.get(selected.key) ? <p className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
    </> : <div className="work-subagents__list" ref={listRef} onScroll={event => { memory.listTop = event.currentTarget.scrollTop }}>
      {groups.length ? <>
        <section className="work-subagents__group" aria-label="正在运行的子代理"><h4>正在运行 <span>{running.length}</span></h4>{running.length ? running.filter(group => visibleGroups.has(group.key)).map(renderRow) : <p className="work-subagents__group-empty">当前没有正在运行的子代理</p>}</section>
        <section className="work-subagents__group" aria-label="已结束的子代理"><h4>{publishedFixedChildren ? '已发布记录' : '已结束'} <span>{completed.length}</span></h4>{completed.length ? completed.filter(group => visibleGroups.has(group.key)).map(renderRow) : <p className="work-subagents__group-empty">结束后的工作记录会保留在这里</p>}</section>
      </> : <div className="work-subagents__empty"><Icon name="account-outline" size={28} /><h4>让专长各异的 Agent 一起工作</h4><p>在对话中使用 @Agent 指定分工。这里会显示它的执行过程和产出，也能继续安排下一步。</p></div>}
      {groups.length > 64 ? <div className="work-subagents__pagination"><span>代理 {groupWindow.start + 1}–{groupWindow.end} / {groups.length}</span>
        {groupWindow.start > 0 ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => Math.max(64, count - 64))}>上一页</button> : null}
        {groupWindow.end < groups.length ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => count + 64)}>下一页</button> : null}</div> : null}
      {!publishedFixedChildren && directory.directory ? <div className="work-subagents__pagination" aria-busy={directory.loading}>
        <p>{directory.directory.schemaVersion === 1 ? '此引擎提供旧版列表，暂不支持分页。' : directory.directory.partial
          ? '这里显示已读取的代理记录，更多运行状态可继续加载查看。' : '当前代理列表已完整读取。'}</p>
        <div>
          {directory.directory.hasMore ? <button type="button" disabled={!ready || directory.loading} onClick={() => void readDirectory(false)}>{directory.loadingMore ? <><Spinner size={14} />正在读取…</> : '加载更多记录'}</button> : null}
          {directory.directory.schemaVersion === 2 && (directory.directory.pages.length > 1 || directory.directory.budgetTrimmed || directory.directory.recentCursors.length > 0)
            ? <button type="button" disabled={!ready || directory.loading} onClick={() => void readDirectory(true)}>返回第一页</button> : null}
        </div>
      </div> : null}
    </div>}
  </section>
}
