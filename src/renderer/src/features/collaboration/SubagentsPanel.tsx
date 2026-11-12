import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '@shared/subagent'
import { builtinAgentName } from '@shared/builtin-agents'
import type { PublishedChildReference } from '@shared/published-child'
import { useApp } from '@renderer/core/app-context'
import type { ChatAttachment, ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { useCollaborationController } from '@renderer/core/engine/useCollaborationController'
import { assertSubagentConnection, captureSubagentConnection, getSubagentRun } from '@renderer/core/engine/client'
import { getSubagentDirectory, getSubagentDiscovery, getSubagentRuns, loadMoreSubagentRuns, refreshSubagentRuns, restartSubagentDirectory, requestSubagentCancellation, captureSubagentRunScope, subscribeSubagents } from '@renderer/core/engine/subagent-store'
import { isSubagentActive, isSubagentNeedsUser, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { Popover } from '@renderer/ui/Popover'
import { SubagentCard } from '../conversation/shared/SubagentCard'
import { FileGlyph } from '../explorer/FileGlyph'
import { ControllerReceiptHistory, ControllerTrackingRecovery, SubagentFollowupInput } from '../conversation/shared/SubagentFollowup'
import { CollaborationReceiptInspector } from '../conversation/shared/CollaborationReceiptInspector'
import { subagentToolPresentation } from '../conversation/shared/subagent-tool-presentation'
import { toolDisplayName } from '../conversation/shared/tool-names'
import { formatSessionSubagentDuration, resolveSessionSubagentGroup, sessionSubagentGroups, sessionSubagentStats, type SessionSubagentGroup } from './subagents'
import { newSessionSubagentTranscriptMemory, SubagentTranscript, type SubagentTranscriptMemory } from './SubagentTranscript'
import { trimSessionSubagentSessionCaches, trimSessionSubagentTranscriptWindows } from './subagent-memory'
import { searchSessionSubagentGroups, sessionSubagentTaskSummary } from './subagent-list-presentation'
import { SubagentListRow } from './SubagentListRow'
import { sessionSubagentTiming } from './subagent-timing'
import { publishedDetailKey, publishedVisibleWindow, rememberPublishedDetail } from '@renderer/core/engine/published-card-memory'
import './subagents.css'
import { subagentFollowupMessage, subagentInstructionIssue } from './subagent-followup-message'
import type { SessionSubagentReveal } from './subagent-navigation'

export interface SubagentsPanelProps {
  reveal?: SessionSubagentReveal | null
  sessionId: string | null
  rootRunId?: string
  tools: ToolActivity[]
  busy?: boolean
  active?: boolean
  publishedFixedChildren?: boolean
  onContinue?: (run: SubagentRun, prompt: string) => Promise<void>
  attachments?: readonly ChatAttachment[]
}

interface PanelMemory {
  selected: string | null
  publishedRunId?: string
  query: string
  listTop: number
  detailTop: Map<string, number>
  drafts: Map<string, string>
  attachments: Map<string, Set<string>>
  errors: Map<string, string>
  views: Map<string, 'rounds' | 'transcript'>
  followups: Map<string, boolean>
  transcripts: Map<string, SubagentTranscriptMemory>
}

function newMemory(): PanelMemory {
  return { selected: null, query: '', listTop: 0, detailTop: new Map(), drafts: new Map(), attachments: new Map(), errors: new Map(), views: new Map(), followups: new Map(), transcripts: new Map() }
}

// The workspace remounts on task switches. Keep this bounded reading state
// outside its lifetime, but discard it immediately when the engine changes.
const memoryBySession = new Map<string, PanelMemory>()
subscribeEngineSource(() => memoryBySession.clear())

const QUEUED_HINT = '等待执行名额，可在设置 → 模型调整并发数量'

function currentAction(group: SessionSubagentGroup): string {
  if (group.latest.subagentRef) return '已发布记录，点击查看过程与产出'
  const run = group.tools.find(tool => tool.subagent && isSubagentActive(tool.subagent.status))?.subagent ?? group.latest.subagent
  if (run?.status === 'queued') return QUEUED_HINT
  const presentation = subagentToolPresentation(run)
  const latest = run?.schemaVersion === 2 && run.latestActivity && isVisibleToolActivity(run.latestActivity) ? run.latestActivity : undefined
  const call = latest?.status === 'running' ? latest : [...presentation.calls].sort((a, b) =>
    ('revisionSeq' in b && typeof b.revisionSeq === 'number' ? b.revisionSeq : b.startedAt ?? 0) -
    ('revisionSeq' in a && typeof a.revisionSeq === 'number' ? a.revisionSeq : a.startedAt ?? 0)).find(item => item.status === 'running')
  if (call) return `正在${toolDisplayName(call.name)}`
  if (run?.status === 'cancelling') return '正在停止本轮工作'
  if (run && isSubagentActive(run.status) && presentation.unseenActiveCount > 0) return '正在执行任务'
  if (latest) return `最近${toolDisplayName(latest.name)}`
  return group.active ? '正在执行任务' : group.latest.subagent?.description || '点击查看过程与产出'
}

/** The list represents durable child contexts; run cards belong only in their own detail view. */
export function SubagentsPanel({ sessionId, rootRunId, tools, busy = false, active: panelActive = true, publishedFixedChildren = false, onContinue, attachments = [], reveal }: SubagentsPanelProps): JSX.Element {
  const { ready } = useApp()
  const followupId = useId()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const manualRefresh = useRef(false)
  const [visibleCount, setVisibleCount] = useState(64)
  const [roundCount, setRoundCount] = useState(64)
  const [fixedDetails, setFixedDetails] = useState(new Map<string, SubagentRun>())
  const [conversationControl, setConversationControl] = useState<{ scope: string; key: string; run: SubagentRun } | null>(null)
  const [sendingKey, setSendingKey] = useState<string | null>(null)
  const [cancellingKey, setCancellingKey] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const sendingRef = useRef(false)
  const continuingRef = useRef<{ scope: string; key: string; runId: string; childSessionId: string; draft: string; files?: Set<string> } | null>(null)
  const cancellingRef = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const returningTo = useRef<string | null>(null)
  const appliedReveal = useRef<SessionSubagentReveal | null>(null)
  const selectedRunIdRef = useRef<string | undefined>(undefined)
  const selectedKeyRef = useRef<string | undefined>(undefined)
  const selectionRef = useRef({ key: '', generation: 0 })
  const source = getEngineSource()
  const scope = `${source}:${sessionId ?? ''}`
  if (!memoryBySession.has(scope)) memoryBySession.set(scope, newMemory())
  const memory = memoryBySession.get(scope)!
  memoryBySession.delete(scope)
  memoryBySession.set(scope, memory)
  trimSessionSubagentSessionCaches(memoryBySession)
  const redraw = (): void => setRevision(value => value + 1)
  const availableAttachments = [...new Map(attachments.map(file => [file.path, file])).values()]
  const referencedFiles = (key: string): ChatAttachment[] => availableAttachments.filter(file => memory.attachments.get(key)?.has(file.path))

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
    setConversationControl(null)
    generation.current++
    sendingRef.current = false
    continuingRef.current = null
    cancellingRef.current = false
    manualRefresh.current = false
    setSendingKey(null)
    setCancellingKey(null)
  }, [scope])
  useEffect(() => {
    if (!sessionId || !ready || !panelActive || publishedFixedChildren) return
    let alive = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.hidden) return
      pending = true
      try {
        const force = manualRefresh.current
        manualRefresh.current = false
        await refreshSubagentRuns(sessionId, { selectedRunId: selectedRunIdRef.current, force })
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

  const groups = useMemo(() => sessionId ? sessionSubagentGroups(sessionId, tools.map(tool => tool.subagentRef && fixedDetails.has(publishedDetailKey(tool.subagentRef))
    ? { ...tool, subagent: fixedDetails.get(publishedDetailKey(tool.subagentRef)) } : tool), publishedFixedChildren ? [] : getSubagentRuns(sessionId)) : [], [sessionId, tools, revision, fixedDetails, publishedFixedChildren])
  const selectedGroup = resolveSessionSubagentGroup(groups, memory.selected)
  const publishedTool = memory.publishedRunId ? selectedGroup?.tools.find(tool => tool.subagentRef?.identity.runId === memory.publishedRunId) : undefined
  const selected = selectedGroup && publishedTool ? { ...selectedGroup, latest: publishedTool, tools: [publishedTool], active: false } : selectedGroup
  useEffect(() => {
    const sent = continuingRef.current
    if (!sent || sent.scope !== scope) return
    const admitted = groups.find(group => group.childSessionId === sent.childSessionId)?.tools.some(tool =>
      tool.subagent?.runId !== sent.runId && tool.subagent?.resumeFromRunId === sent.runId)
    if (!admitted) return
    // The parent stream remains open while the resumed child works. Release only
    // this accepted submission so live requirements can reach its new invocation.
    continuingRef.current = null
    sendingRef.current = false
    setSendingKey(key => key === sent.key ? null : key)
    if (memory.drafts.get(sent.key) === sent.draft && memory.attachments.get(sent.key) === sent.files) {
      memory.drafts.delete(sent.key)
      memory.attachments.delete(sent.key)
    }
    redraw()
  }, [groups, scope, memory])
  const activeRun = selected?.tools.find(tool => !tool.subagentRef && tool.subagent && isSubagentActive(tool.subagent.status))?.subagent
  const running = groups.filter(group => group.active)
  const filteredGroups = useMemo(() => searchSessionSubagentGroups(groups, memory.query), [groups, memory.query])
  const filteredRunning = filteredGroups.filter(group => group.active)
  const awaitingAnswer = filteredGroups.filter(group => !group.active && isSubagentNeedsUser(group.latest.subagent))
  const completed = filteredGroups.filter(group => !group.active && !isSubagentNeedsUser(group.latest.subagent))
  const groupWindow = publishedVisibleWindow(filteredGroups, visibleCount)
  const visibleGroups = new Set(groupWindow.items.map(group => group.key))
  const visibleRunning = filteredRunning.filter(group => visibleGroups.has(group.key))
  const visibleAwaitingAnswer = awaitingAnswer.filter(group => visibleGroups.has(group.key))
  const visibleCompleted = completed.filter(group => visibleGroups.has(group.key))
  const roundWindow = publishedVisibleWindow(selected?.tools ?? [], roundCount)
  const transcriptRun = activeRun ?? selected?.tools.find(tool => tool.subagent)?.subagent
  const transcriptIdentity = activeRun ?? selected?.latest.subagentRef?.identity ?? transcriptRun
  const fixedConversation = Boolean(publishedFixedChildren || selected?.latest.subagentRef)
  const continuationRun = fixedConversation ? conversationControl?.scope === scope && conversationControl.key === selected?.key
    ? conversationControl.run : undefined : selected?.latest.subagent
  const fixedBusy = Boolean(fixedConversation && continuationRun && isSubagentActive(continuationRun.status))
  useEffect(() => {
    const reference = selected?.latest.subagentRef
    if (!reference || !sessionId || !ready || !panelActive) return
    let alive = true
    const connection = captureSubagentConnection()
    const selection = selected.key
    const verify = (): void => {
      assertSubagentConnection(connection)
      if (!alive || source !== getEngineSource()) throw new Error('子代理选择已变化')
    }
    const loadControl = async (): Promise<void> => {
      try {
        // This is a separate current read. The immutable publication and its
        // atSeq remain untouched; admission still checks concurrent child work.
        await refreshSubagentRuns(sessionId, { selectedRunId: reference.identity.runId })
        verify()
        const known = getSubagentRuns(sessionId).filter(run => run.tenantId === reference.identity.tenantId &&
          run.rootSessionId === reference.identity.rootSessionId && run.childSessionId === reference.identity.childSessionId)
          .sort((a, b) => Number(isSubagentActive(b.status)) - Number(isSubagentActive(a.status)) || b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0]
        const run = await getSubagentRun(known?.runId ?? reference.identity.runId, { connection, verify,
          parentSessionId: sessionId, rootSessionId: reference.identity.rootSessionId })
        verify()
        if (run.tenantId !== reference.identity.tenantId || run.parentSessionId !== sessionId ||
          run.rootSessionId !== reference.identity.rootSessionId || run.childSessionId !== reference.identity.childSessionId) throw new Error('子代理归属不一致，无法继续')
        setConversationControl({ scope, key: selection, run })
        memory.errors.delete(selection); redraw()
      } catch (cause) {
        if (alive && source === getEngineSource()) { memory.errors.set(selection, cause instanceof Error ? cause.message : String(cause)); redraw() }
      }
    }
    void loadControl()
    return () => { alive = false }
  }, [scope, selected?.key, selected?.latest.subagentRef?.identity.runId, sessionId, ready, panelActive, refreshKey])
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
  const selectedStats = selected ? sessionSubagentStats(selected, now) : null
  const selectedTiming = selected ? sessionSubagentTiming(selected.latest, now) : null
  useEffect(() => { setRoundCount(64) }, [selected?.key])
  // The resolver proves a legacy key belongs to this durable child. Read its
  // draft and disclosure choice before layout migration to avoid a hidden frame.
  const previousSelectedKey = selected && memory.selected !== selected.key ? memory.selected : null
  const selectedDraft = selected ? memory.drafts.get(selected.key) ?? (previousSelectedKey ? memory.drafts.get(previousSelectedKey) : undefined) ?? liveFollowup.restoredDraft?.message ?? '' : ''
  if (selected && !memory.transcripts.has(selected.key)) memory.transcripts.set(selected.key, newSessionSubagentTranscriptMemory())
  if (selected) {
    const transcript = memory.transcripts.get(selected.key)!
    memory.transcripts.delete(selected.key)
    memory.transcripts.set(selected.key, transcript)
  }
  while (memory.transcripts.size > 2) memory.transcripts.delete(memory.transcripts.keys().next().value!)
  const trimTranscriptWindows = (): void => trimSessionSubagentTranscriptWindows(memoryBySession,
    panelActive && selected ? memory.transcripts.get(selected.key) : undefined)
  trimTranscriptWindows()
  const timingActive = panelActive && (selected ? selected.active : groups.some(group => group.active))
  useEffect(() => {
    if (!timingActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [timingActive])
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
        if (memory.attachments.has(previousKey) && !memory.attachments.has(selected.key)) memory.attachments.set(selected.key, memory.attachments.get(previousKey)!)
        memory.attachments.delete(previousKey)
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
      if (returningTo.current) (rowRefs.current.get(returningTo.current) ?? searchRef.current)?.focus({ preventScroll: true })
      returningTo.current = null
    }
  }, [scope, selected?.key, panelActive])
  useLayoutEffect(() => {
    if (panelActive && selected && detailRef.current)
      detailRef.current.scrollTop = memory.detailTop.get(selected.key) ?? 0
  }, [scope, selected?.key, panelActive])

  useLayoutEffect(() => {
    if (!panelActive || !reveal || appliedReveal.current === reveal || reveal.source !== source || reveal.sessionId !== sessionId) return
    const group = reveal.childSessionId ? groups.find(item => item.childSessionId === reveal.childSessionId)
      : resolveSessionSubagentGroup(groups, `legacy:${reveal.toolCallId}`)
    if (!group) return
    appliedReveal.current = reveal
    memory.listTop = listRef.current?.scrollTop ?? memory.listTop
    memory.selected = group.key
    memory.publishedRunId = reveal.publishedRunId
    redraw()
  }, [panelActive, reveal, source, sessionId, groups, memory])

  const openDetail = (group: SessionSubagentGroup): void => {
    memory.listTop = listRef.current?.scrollTop ?? memory.listTop
    memory.selected = group.key
    memory.publishedRunId = undefined
    redraw()
  }
  const searchGroups = (query: string): void => {
    memory.query = query
    memory.listTop = 0
    if (listRef.current) listRef.current.scrollTop = 0
    setVisibleCount(64)
    redraw()
  }
  const backToList = (): void => {
    if (selected) {
      if (detailRef.current) memory.detailTop.set(selected.key, detailRef.current.scrollTop)
      returningTo.current = selected.key
    }
    memory.selected = null
    memory.publishedRunId = undefined
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
  const continueRun = async (group: SessionSubagentGroup, draft: string): Promise<void> => {
    const run = fixedConversation ? continuationRun : group.latest.subagent
    if (group.latest.subagentRef && run && isSubagentActive(run.status)) return
    if (!run?.continuation || !onContinue || !draft.trim() || group.active || fixedBusy || busy || sendingRef.current || !ready) return
    sendingRef.current = true
    setSendingKey(group.key)
    memory.errors.delete(group.key)
    const currentGeneration = generation.current
    const currentSelection = selectionRef.current.generation
    const originalFiles = memory.attachments.get(group.key)
    const sent = { scope, key: group.key, runId: run.runId, childSessionId: run.childSessionId, draft, files: originalFiles }
    continuingRef.current = sent
    const current = (): boolean => mounted.current && currentGeneration === generation.current && source === getEngineSource()
      && currentSelection === selectionRef.current.generation && selectedKeyRef.current === group.key && selectedRunIdRef.current === run.runId
    try {
      await onContinue(run, subagentFollowupMessage(draft, referencedFiles(group.key)))
      if (current() && memory.drafts.get(group.key) === draft) {
        memory.drafts.delete(group.key)
        if (memory.attachments.get(group.key) === originalFiles) memory.attachments.delete(group.key)
      }
    } catch (cause) {
      if (current()) memory.errors.set(group.key, cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current && currentGeneration === generation.current && continuingRef.current === sent) {
        continuingRef.current = null
        sendingRef.current = false
        setSendingKey(key => key === group.key ? null : key)
        redraw()
      }
    }
  }
  const submitFollowup = async (group: SessionSubagentGroup): Promise<void> => {
    if (liveFollowup.busy) return
    const selectedGeneration = selectionRef.current.generation
    const sourceGeneration = generation.current
    const originalDraft = memory.drafts.get(group.key)
    const originalFiles = memory.attachments.get(group.key)
    const original = originalDraft ?? liveFollowup.restoredDraft?.message ?? ''
    const issue = !liveFollowup.pending && subagentInstructionIssue(original)
    if (issue) { memory.errors.set(group.key, issue); redraw(); return }
    let composed: string
    try { composed = subagentFollowupMessage(original, referencedFiles(group.key)) }
    catch (cause) { memory.errors.set(group.key, cause instanceof Error ? cause.message : String(cause)); redraw(); return }
    const clearsSentDraft = !liveFollowup.pending || originalDraft === undefined || composed === liveFollowup.pending.message
    const message = liveFollowup.pending?.message ?? composed
    const accepted = liveFollowup.pending ? await liveFollowup.reconcile()
      : group.active ? await liveFollowup.send(message) : false
    if (accepted && clearsSentDraft && mounted.current && source === getEngineSource() && sourceGeneration === generation.current
      && selectedGeneration === selectionRef.current.generation && selectedKeyRef.current === group.key && memory.drafts.get(group.key) === originalDraft) {
      memory.drafts.delete(group.key)
      if (memory.attachments.get(group.key) === originalFiles) memory.attachments.delete(group.key)
      redraw()
    }
    if (!liveFollowup.pending && !group.active) await continueRun(group, original)
  }
  const cancelRun = async (group: SessionSubagentGroup): Promise<void> => {
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
  const retryFollowup = async (group: SessionSubagentGroup): Promise<void> => {
    const originalDraft = memory.drafts.get(group.key)
    const originalFiles = memory.attachments.get(group.key)
    const originalMessage = liveFollowup.pending?.message
    const sourceGeneration = generation.current
    const selectedGeneration = selectionRef.current.generation
    let matches = originalDraft === undefined
    try { matches ||= subagentFollowupMessage(originalDraft ?? '', referencedFiles(group.key)) === originalMessage }
    catch { /* A changed oversized draft must remain intact while retrying the frozen request. */ }
    const accepted = await liveFollowup.retry()
    if (accepted && matches && mounted.current && source === getEngineSource() && sourceGeneration === generation.current
      && selectedGeneration === selectionRef.current.generation && selectedKeyRef.current === group.key
      && memory.drafts.get(group.key) === originalDraft && memory.attachments.get(group.key) === originalFiles) {
      memory.drafts.delete(group.key)
      memory.attachments.delete(group.key)
      redraw()
    }
  }
  const renderRow = (group: SessionSubagentGroup): JSX.Element => {
    const stats = sessionSubagentStats(group, now)
    const status = toolStatusLabel(group.latest)
    const task = sessionSubagentTaskSummary(group) || currentAction(group)
    const role = builtinAgentName(group.latest.subagent?.continuation?.builtinRole)
    const tone = stats.status === 'queued' || isSubagentNeedsUser(group.latest.subagent) ? 'waiting' : group.active ? 'active' : ['failed', 'error', 'interrupted', 'blocked'].includes(stats.status) ? 'error' : 'complete'
    return <SubagentListRow key={group.key} group={group} stats={stats} now={now} status={status} task={task} role={role} tone={tone}
      onOpen={() => openDetail(group)}
      rowRef={node => { if (node) rowRefs.current.set(group.key, node); else rowRefs.current.delete(group.key) }} />
  }
  const listStatus = publishedFixedChildren ? '已发布记录' : discovery.state?.activeCount
    ? `${discovery.state.activeCount} 个进行中` : running.length ? `${running.length} 个已载入代理进行中`
      : groups.length ? '' : discovery.loading ? '正在发现协作代理…' : '暂无协作代理'

  return <section className={`work-subagents${selected ? ' work-subagents--detail' : ''}`} aria-label="协作代理" onKeyDown={event => {
    if (!selected && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && searchRef.current) { event.preventDefault(); event.stopPropagation(); searchRef.current.focus() }
    // Popover handles Escape at document level. Let it close the information
    // surface before a later Escape navigates away from the agent detail.
    if (event.key === 'Escape' && event.currentTarget.querySelector(':is(.work-subagents__info-trigger, .work-subagents__attachment-trigger)[aria-expanded="true"]')) return
    if (event.key === 'Escape' && selected && event.target instanceof HTMLElement && !event.target.closest('textarea')) { event.preventDefault(); backToList() }
  }}>
    <header className="work-subagents__header">
      {selected ? <>
        <button type="button" className="work-subagents__back" ref={backRef} onClick={backToList} aria-label="返回子代理列表" title="返回子代理列表 (Esc)"><Icon name="chevron-right" size={18} /></button>
        <div className="work-subagents__heading"><h3 title={selected.label}>{selected.label}</h3><p>
          <span role="status" className={`work-subagents__status${fixedConversation ? '' : ` work-subagents__status--${selected.latest.state}`}`}>{fixedConversation ? '会话历史' : toolStatusLabel(selected.latest)}</span>
          <span className="work-subagents__detail-duration">{selectedTiming?.durationText}</span>
          {selectedTiming?.timestamp ? <time className="work-subagents__detail-time" dateTime={selectedTiming.timestamp.dateTime} title={selectedTiming.timestamp.full}>{selectedTiming.timestamp.text}</time> : null}
        </p></div>
        {activeRun ? <button type="button" className="work-subagents__stop" aria-label="停止本轮" title="停止本轮" disabled={!ready || cancellingKey !== null || activeRun.status === 'cancelling'} onClick={() => void cancelRun(selected)}>{cancellingKey === selected.key || activeRun.status === 'cancelling' ? <Spinner size={14} /> : <Icon name="stop" size={14} />}</button> : null}
        <Popover key={`${scope}:${selected.key}`} align="end" width={280} label="代理信息" className="work-subagents__info" panelClassName="work-subagents__info-panel"
          trigger={({ open }) => <button type="button" className="work-subagents__info-trigger" aria-label="代理信息" aria-expanded={open} title="代理信息"><Icon name="info" size={16} /></button>}>
          <dl className="work-subagents__facts">
            {fixedConversation ? <div><dt>内容</dt><dd>此代理的独立会话，包含后续消息。主会话的发布摘要保持原样。</dd></div> : null}
            {builtinAgentName(selected.latest.subagent?.continuation?.builtinRole) ? <div><dt>角色</dt><dd>{builtinAgentName(selected.latest.subagent?.continuation?.builtinRole)}</dd></div> : null}
            {selectedStats?.modelId ? <div><dt>模型</dt><dd>{selectedStats.modelId}</dd></div> : null}
            <div><dt>工作轮次</dt><dd>{selected.tools.length} 轮</dd></div>
            <div><dt>工具调用</dt><dd>{selectedStats?.toolCount ?? 0} 次{selectedStats?.activeToolCount ? ` · ${selectedStats.activeToolCount} 执行中` : ''}</dd></div>
            {formatSessionSubagentDuration(selectedStats?.durationMs) ? <div><dt>本轮耗时</dt><dd>{formatSessionSubagentDuration(selectedStats?.durationMs)}</dd></div> : null}
          </dl>
          {rootRunId && selected.childSessionId && selectedRunIdRef.current && !selected.latest.subagentRef && !publishedFixedChildren ? <CollaborationReceiptInspector
            key={selectionKey} target={{ rootRunId, rootSessionId: sessionId!, childSessionId: selected.childSessionId, invocationRunId: selectedRunIdRef.current }}
            source={source} ready={ready} visible={panelActive} /> : null}
        </Popover>
      </> : <div className="work-subagents__heading"><h3>协作代理 {groups.length ? <span className="work-subagents__count" title={`已载入 ${groups.length} 个代理`} aria-label={`已载入 ${groups.length} 个代理`}>{groups.length}</span> : null}</h3>{listStatus ? <p>{listStatus}</p> : null}</div>}
      {!publishedFixedChildren || selected && transcriptIdentity?.childSessionId ? <button type="button" className="work-subagents__refresh" disabled={!sessionId || !ready} onClick={() => { manualRefresh.current = true; setRefreshKey(value => value + 1) }} aria-label={selected ? "刷新子代理对话" : "刷新子代理状态"} title={selected ? "刷新对话" : "刷新状态"}><Icon name="refresh" size={16} /></button> : null}
    </header>
    {!selected && (groups.length >= 12 || memory.query) ? <div className="work-subagents__searchbar">
      <label className="work-subagents__search"><Icon name="search" size={14} /><input className="ui-input ui-input--compact" ref={searchRef} type="search" aria-label="搜索已载入代理" placeholder="搜索已载入代理" value={memory.query}
        onChange={event => searchGroups(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape' && memory.query) { event.preventDefault(); event.stopPropagation(); searchGroups('') } }} /></label>
      {memory.query.trim() ? <span className="work-subagents__search-count" role="status">{filteredGroups.length} 个匹配 · 已载入 {groups.length} 个</span> : null}
    </div> : null}
    {error || !publishedFixedChildren && discovery.error ? <div className="work-subagents__error" role="alert">状态更新失败：{error || discovery.error} · 保留上次确认状态</div> : null}
    {selected ? <>
      {transcriptRun?.compaction ? <p className="work-subagents__compaction" role="status" title={transcriptRun.compaction.phase === 'failed' ? transcriptRun.compaction.error : undefined}>
        {transcriptRun.compaction.phase === 'running' ? <Spinner size={12} /> : <Icon name={transcriptRun.compaction.phase === 'succeeded' ? 'check' : 'info'} size={12} />}
        {transcriptRun.compaction.phase === 'running' ? '正在自动压缩上下文…' : transcriptRun.compaction.phase === 'succeeded' ? '上下文已自动压缩' : '本次上下文压缩未完成'}
      </p> : null}
      {transcriptIdentity?.childSessionId ? <SubagentTranscript source={source} parentSessionId={sessionId!} childSessionId={transcriptIdentity.childSessionId} runId={transcriptIdentity.runId} name={selected.label} memory={memory.transcripts.get(selected.key)!} active={panelActive} running={!fixedConversation && selected.active} lastSeq={transcriptRun?.lastSeq} status={transcriptRun?.status} refreshKey={refreshKey} statusNote={!fixedConversation ? transcriptRun?.error?.message : undefined} liveRun={!fixedConversation ? activeRun : undefined} onHistoryLoaded={trimTranscriptWindows} /> : <div className="work-subagents__detail" ref={detailRef} onScroll={event => memory.detailTop.set(selected.key, event.currentTarget.scrollTop)} aria-label={`${selected.label} 的工作记录`}>
        <p className="work-subagents__snapshot-note">{selected.latest.subagentRef || publishedFixedChildren ? '已发布快照 · 此处保留发布时的记录' : '代理开始后可查看独立对话'}</p>
        {[...roundWindow.items].reverse().map((tool, index) => <article className="work-subagents__round" key={tool.subagent?.runId || tool.id} data-run-id={tool.subagent?.runId}>
          <SubagentCard tool={tool} sessionId={sessionId!} defaultOpen={index === roundWindow.items.length - 1} visible={panelActive} readOnly onPublishedLoaded={rememberFixedDetail} surfaceMode="work" round={{ number: selected.tools.length - roundWindow.end + index + 1, createdAt: tool.subagent?.createdAt }} />
        </article>)}
        {selected.tools.length > 64 ? <div className="work-subagents__pagination"><span>轮次 {roundWindow.start + 1}–{roundWindow.end} / {selected.tools.length}</span>
          {roundWindow.start > 0 ? <button type="button" className="btn btn--sm" onClick={() => setRoundCount(count => Math.max(64, count - 64))}>较新轮次</button> : null}
          {roundWindow.end < selected.tools.length ? <button type="button" className="btn btn--sm" onClick={() => setRoundCount(count => count + 64)}>较早轮次</button> : null}</div> : null}
      </div>}
      {liveFollowup.pending || liveFollowup.restoredDraft || liveFollowup.history.length || activeRun && !selected.latest.subagentRef || continuationRun?.continuation && onContinue ? <div className="work-subagents__followup">
        <form id={`${followupId}-form`} className="work-subagents__composer" onSubmit={event => { event.preventDefault(); void submitFollowup(selected) }}>
        <span id={`${followupId}-label`} className="work-subagents__input-label">{selected.active ? '补充要求给' : '继续交给'} {selected.label}</span>
        <div className="work-subagents__composer-editor ui-input-shell ui-input-shell--multiline">
        <SubagentFollowupInput className="ui-input-field" id={`${followupId}-input`} value={liveFollowup.pending?.message ?? selectedDraft} readOnly={Boolean(liveFollowup.pending)} onChange={value => { memory.drafts.set(selected.key, value); memory.errors.delete(selected.key); redraw() }} placeholder={selected.active ? '补充要求…' : isSubagentNeedsUser(selected.latest.subagent) ? '回答问题…' : '继续安排任务…'} labelledBy={`${followupId}-label`} describedBy={`${followupId}-hint${memory.errors.has(selected.key) ? ` ${followupId}-error` : ''}`}
          onDismiss={() => backRef.current?.focus()} onSubmit={() => void submitFollowup(selected)} />
        <div className="work-subagents__composer-actions">
          {availableAttachments.length ? <Popover align="start" width={280} label="引用任务资料" panelClassName="work-subagents__attachment-menu"
            trigger={({ open }) => <button type="button" className="work-subagents__attachment-trigger" aria-label="引用任务资料" title="引用任务资料" aria-expanded={open} disabled={Boolean(liveFollowup.pending) || liveFollowup.busy || sendingKey !== null}><Icon name="paperclip" size={15} />{referencedFiles(selected.key).length ? <span>{referencedFiles(selected.key).length}</span> : null}</button>}>
            <div role="group" aria-label="可引用的任务资料">{availableAttachments.map(file => <label key={file.path}><input type="checkbox" checked={memory.attachments.get(selected.key)?.has(file.path) ?? false} disabled={Boolean(liveFollowup.pending) || liveFollowup.busy || sendingKey !== null}
              onChange={event => { const next = new Set(memory.attachments.get(selected.key)); if (event.target.checked) next.add(file.path); else next.delete(file.path); memory.attachments.set(selected.key, next); redraw() }} /><FileGlyph name={file.name} size={16} /><span title={file.path}>{file.name}</span></label>)}</div>
          </Popover> : null}
          <button type="submit" aria-label={liveFollowup.pending ? '核对排队结果' : selected.active ? '发送补充要求' : '继续执行'} title={liveFollowup.pending ? '核对排队结果' : 'Ctrl / ⌘ Enter'} disabled={liveFollowup.busy || sendingKey !== null || !ready || (!liveFollowup.pending && (!selectedDraft.trim() || (selected.active ? !liveFollowup.capability : busy || fixedBusy)))}>{sendingKey === selected.key || liveFollowup.busy ? <Spinner size={14} /> : <Icon name={liveFollowup.pending ? 'refresh' : 'send'} size={15} />}</button>
        </div>
        </div>
        {referencedFiles(selected.key).length && !liveFollowup.pending ? <div className="work-subagents__attachment-chips">{referencedFiles(selected.key).map(file => <span key={file.path} title={file.path}><FileGlyph name={file.name} size={12} />{file.name}<button type="button" aria-label={`移除引用 ${file.name}`} disabled={liveFollowup.busy || sendingKey !== null} onClick={() => { const next = new Set(memory.attachments.get(selected.key)); next.delete(file.path); memory.attachments.set(selected.key, next); redraw() }}><Icon name="close" size={12} /></button></span>)}</div> : null}
        <p id={`${followupId}-hint`} className={`work-subagents__composer-hint${!liveFollowup.pending && (selected.active ? Boolean(rootRunId && liveFollowup.capability) : !busy && !fixedBusy) ? " work-subagents__composer-hint--quiet" : ""}`}>{liveFollowup.pending ? '原要求已冻结；核对不会重复发送' : selected.active ? !rootRunId ? '正在确认主任务的协作上下文' : liveFollowup.capability === undefined ? '正在确认引擎协作能力…' : liveFollowup.capability ? '保留代理上下文 · Ctrl / ⌘ Enter 发送' : '当前引擎尚未启用运行中补充要求；草稿会保留' : fixedBusy ? '此代理仍在执行，完成后可继续' : busy ? '请等待主任务结束后发送' : '保留代理上下文 · Ctrl / ⌘ Enter 继续'}</p>
        {liveFollowup.notice ? <p className="work-subagents__followup-notice" role="status">{liveFollowup.notice}</p> : null}
        {liveFollowup.canRetry ? <button type="button" className="work-subagents__retry-original" disabled={liveFollowup.busy || !ready} onClick={() => void retryFollowup(selected)}>重试原请求</button> : null}
        {liveFollowup.pending ? <ControllerTrackingRecovery message={liveFollowup.pending.message} disabled={liveFollowup.busy || !ready} onForget={liveFollowup.forgetTracking} /> : null}
        {liveFollowup.restoredDraft && !liveFollowup.pending ? <button type="button" className="work-subagents__retry-original" disabled={liveFollowup.busy || !ready} onClick={() => {
          const original = liveFollowup.restoredDraft?.message
          void liveFollowup.discardDraft().then(cleared => { if (cleared && selectedKeyRef.current === selected.key && memory.drafts.get(selected.key) === original) { memory.drafts.delete(selected.key); redraw() } })
        }}>清除已结束的草稿</button> : null}
        </form>
        <ControllerReceiptHistory records={liveFollowup.history} rootRunId={rootRunId} invocationRunId={selectedRunIdRef.current} disabled={liveFollowup.busy || !ready} onQuery={liveFollowup.queryHistory} onRemove={liveFollowup.removeHistory} />
        {liveFollowup.error ? <p className="work-subagents__error" role="alert">{liveFollowup.error}</p> : null}
        {memory.errors.get(selected.key) ? <p id={`${followupId}-error`} className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
      </div> : memory.errors.get(selected.key) ? <p className="work-subagents__error" role="alert">{memory.errors.get(selected.key)}</p> : null}
    </> : <div className="work-subagents__list" ref={listRef} onScroll={event => { memory.listTop = event.currentTarget.scrollTop }}>
      {groups.length ? <>
        {visibleAwaitingAnswer.length ? <section className="work-subagents__group" aria-label="等待回答的子代理"><h4>待回答 <span>{awaitingAnswer.length}</span></h4>{visibleAwaitingAnswer.map(renderRow)}</section> : null}
        {visibleRunning.length ? <section className="work-subagents__group" aria-label="正在运行的子代理"><h4>进行中 <span>{filteredRunning.length}</span></h4>{visibleRunning.map(renderRow)}</section> : null}
        {visibleCompleted.length ? <section className="work-subagents__group" aria-label="已结束的子代理"><h4>{publishedFixedChildren ? '已发布记录' : '已结束'} <span>{completed.length}</span></h4>{visibleCompleted.map(renderRow)}</section> : null}
        {!filteredGroups.length ? <p className="work-subagents__search-empty">已载入的代理中没有匹配结果。</p> : null}
      </> : <div className="work-subagents__empty"><Icon name="users" size={28} /><h4>让 Agent 协作完成任务</h4><p>使用 @ 选择调研、执行或通用角色。同一角色可以添加多个，完成后也能继续安排下一步。</p></div>}
      {filteredGroups.length > 64 ? <div className="work-subagents__pagination"><span>代理 {groupWindow.start + 1}–{groupWindow.end} / {filteredGroups.length}{memory.query.trim() ? ' 个匹配' : ''}</span>
        {groupWindow.start > 0 ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => Math.max(64, count - 64))}>上一页</button> : null}
        {groupWindow.end < filteredGroups.length ? <button type="button" className="btn btn--sm" onClick={() => setVisibleCount(count => count + 64)}>下一页</button> : null}</div> : null}
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
