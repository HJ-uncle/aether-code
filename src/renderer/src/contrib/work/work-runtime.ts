import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useChat, type ChatAttachment, type SendOptions } from '@renderer/core/engine/useChat'
import type { ArchivePageAction } from '@renderer/core/engine/archive-pages'
import { useModels } from '@renderer/core/engine/model-store'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '@renderer/core/engine/chat-recovery'
import {
  assertEngineSource,
  getEngineStorageKey,
  getEngineSource,
  isRemoteEngine,
  sessionStorageKey
} from '@renderer/core/engine/source'
import {
  cancelAttachmentUpload,
  requestOrThrow,
  uploadAttachment
} from '@renderer/core/engine/client'
import { allowRoot, bindSessionWorkspace, copyIntoWorkspace, pickFolder } from '@renderer/core/workspace/fs-client'
import { isSupportedFile } from '@renderer/contrib/chat/useAttachments'
import { mentionToken, type Mention } from '@renderer/contrib/chat/mention-context'
import { buildWorkAgentMessage } from './work-agent-collaboration'
import { queuedDraft, useWorkNextTurnQueue } from './work-next-turn-queue'
import type { WorkQueueDraft } from '@shared/work-next-turn-api'
import { ATTACHMENTS_DIRECTORY } from '@shared/attachments'
import { loadSessionThinkingMode, saveSessionThinkingMode, type SessionThinkingMode } from '../chat/session-thinking-store'
import { loadSessionModelSelection, resolveSessionComposerModel, saveSessionModelSelection, type SessionModelSelection } from '../chat/session-model-store'
import { requestedThinkingMode } from '../chat/session-request-config'
import type { AgentCollaborator, SubagentRun } from '@shared/subagent'
import { pollWorkTaskStatuses } from './work-status-poller'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { useWorkAgentIdentity } from './work-agent-identity'
import {
  flushWorkDrafts,
  getWorkDraft,
  getWorkState,
  updateWorkDraft,
  updateWorkState,
  useWorkState,
  workArtifacts,
  workStatus,
  type WorkArtifact,
  type WorkTask
} from './work-state'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface WorkDefaultModelSelection { anchorRunId?: string; clientDefault: boolean }
const WORK_DEFAULT_MODELS_KEY = 'aether:workDefaultModelSelections'
function workDefaultModelSelections(source: string): Record<string, WorkDefaultModelSelection> {
  const table = Object.create(null) as Record<string, WorkDefaultModelSelection>
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(sessionStorageKey(WORK_DEFAULT_MODELS_KEY, source)) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return table
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const anchor = 'anchorRunId' in value ? value.anchorRunId : undefined
      if (anchor !== undefined && (typeof anchor !== 'string' || !anchor.trim())) continue
      const clientDefault = 'clientDefault' in value ? value.clientDefault : true
      if (typeof clientDefault !== 'boolean') continue
      table[id] = { ...(typeof anchor === 'string' ? { anchorRunId: anchor } : {}), clientDefault }
    }
  } catch { /* Unavailable persistence must not block choosing a model. */ }
  return table
}
function saveWorkDefaultModelSelection(id: string, selection: WorkDefaultModelSelection | null, source: string): void {
  const table = workDefaultModelSelections(source)
  delete table[id]
  if (selection) table[id] = selection
  const keys = Object.keys(table)
  while (keys.length > 100) delete table[keys.shift()!]
  try { localStorage.setItem(sessionStorageKey(WORK_DEFAULT_MODELS_KEY, source), JSON.stringify(table)) }
  catch { /* The current unsent choice remains usable without storage. */ }
}

/** Keep attachment bytes inside the engine-owned scratch workspace when the
 * user has not selected a project. The browser File API does not expose a
 * local path, so the engine workspace API is the only safe place to persist
 * these bytes without silently adopting Code's current project. */
function encodeBase64(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + chunkSize, data.length)))
  }
  return btoa(binary)
}

function scratchAttachmentPath(name: string): string {
  const base = name.split(/[\\/]/).filter(Boolean).at(-1) || 'file'
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_') || 'file'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  return `${ATTACHMENTS_DIRECTORY}/${stem}-${crypto.randomUUID()}${extension}`
}

/** Work owns its session IDs and drafts. Its transport selects the general
 * profile so task automation, Agent management, memory, MCP and skills are
 * available without widening Code's programming-only registry. */
export function useWorkController() {
  const { settings, ready: engineReady } = useApp()
  const source = getEngineStorageKey()
  const epoch = getEngineSource()
  const state = useWorkState(source)
  const chat = useChat({ commandOwner: 'work' })
  const { models } = useModels()
  // Older Work drafts stored database IDs; requests and both pickers use model IDs.
  const canonicalModelId = useCallback((value: string): string => models.find(model => model.id === value || model.modelId === value)?.modelId ?? value, [models])
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId) ?? null
  const activeId = activeTask?.id ?? null
  const nextTurnQueue = useWorkNextTurnQueue(activeId, epoch, engineReady)
  const [nextModel, setNextModel] = useState<{ source: string; taskId: string; modelId: string } | null>(null)
  const [selectedModel, setSelectedModel] = useState<{ source: string; id: string; selection: SessionModelSelection | null; defaultSelection: WorkDefaultModelSelection | null } | null>(null)
  const storedModelSelection = useMemo(() => activeId ? loadSessionModelSelection(activeId, source) : null, [activeId, source])
  const storedDefaultModelSelection = useMemo(() => activeId ? workDefaultModelSelections(source)[activeId] ?? null : null, [activeId, source])
  const localModelSelection = selectedModel?.source === source && selectedModel.id === activeId ? selectedModel : null
  const modelSelection = localModelSelection ? localModelSelection.selection : storedModelSelection
  const defaultModelSelection = localModelSelection ? localModelSelection.defaultSelection : storedDefaultModelSelection
  const sessionModelReady = Boolean(activeId && chat.sessionModel?.source === epoch && chat.sessionModel.sessionId === activeId)
  const useDefaultModelSelection = Boolean(sessionModelReady && defaultModelSelection && defaultModelSelection.anchorRunId === chat.sessionModel?.runId)
  const resolvedModelId = useDefaultModelSelection ? '' : activeTask && sessionModelReady ? resolveSessionComposerModel({
    configuredModelId: chat.sessionModel?.modelId,
    runId: chat.sessionModel?.runId,
    selection: modelSelection,
    defaultModelId: canonicalModelId(activeTask.modelId || settings.lastModelId)
  }) : activeTask?.modelId ?? state.homeModelId
  const modelId = canonicalModelId(resolvedModelId)
  // Work's default follows its configured client model, then the Agent/engine.
  // Keep this explicit empty choice separate from unknown restored run models.
  const requestModelId = useDefaultModelSelection ? defaultModelSelection?.clientDefault ? canonicalModelId(settings.lastModelId) : '' : modelId
  const followsEngineDefault = Boolean(useDefaultModelSelection ? !defaultModelSelection?.clientDefault :
    sessionModelReady && chat.sessionModel?.runId && !modelId)
  const agentId = activeTask ? activeTask.agentId ?? '' : state.homeAgentId
  const agentIdentity = useWorkAgentIdentity(agentId, engineReady)
  const securitySessionId = activeId ?? state.homeSessionId ?? null
  const [thinkingSelection, setThinkingSelection] = useState<{ source: string; id: string; mode: SessionThinkingMode } | null>(null)
  const thinkingFor = (id: string): SessionThinkingMode =>
    thinkingSelection?.source === source && thinkingSelection.id === id ? thinkingSelection.mode : loadSessionThinkingMode(id, source) ?? settings.thinkingMode
  const thinkingMode = thinkingFor(securitySessionId ?? '')
  const setThinkingMode = (mode: SessionThinkingMode): void => {
    if (!securitySessionId) return
    saveSessionThinkingMode(securitySessionId, mode, source)
    setThinkingSelection({ source, id: securitySessionId, mode })
  }
  const [loaded, setLoaded] = useState<{ source: string; epoch: number; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadCount, setUploadCount] = useState(0)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const pendingStart = useRef<{ source: string; id: string; text: string; mentions: Mention[] } | null>(null)
  const submitted = useRef(
    new Map<
      string,
      { source: string; text: string; mentions: Mention[]; attachments: ChatAttachment[]; createdAt: number; preserveDraft: boolean }
    >()
  )
  // Keep the exact failed turn separate from the editable draft. A user may
  // type a new draft while an error card is visible; retry must replay the
  // failed request the card refers to, including its captured attachments.
  const failedSubmissions = useRef(
    new Map<string, { text: string; mentions: Mention[]; attachments: ChatAttachment[] }>()
  )
  const stoppingTaskIdsRef = useRef(new Set<string>())
  const taskRevisionsRef = useRef(new Map<string, number>())
  const invalidateStatusProbe = (id: string): void => {
    taskRevisionsRef.current.set(id, (taskRevisionsRef.current.get(id) ?? 0) + 1)
  }
  const { resumeStream, send: chatSend, abort, respond: chatRespond, isHistoryReady, hasSessionWork } = chat
  useEffect(() => () => flushWorkDrafts(source), [source])

  /**
   * Work keeps the selected project on the task so it can be restored after a
   * restart.  The main-process fs allow-list is intentionally process-scoped,
   * though, so a restored task must grant that previously selected root again
   * before the editor starts its document watcher.  Without this preflight the
   * first file read/watch after restarting Work is rejected as an out-of-workspace
   * path even though the task still points at the same project.
   *
   * The remote engine owns its workspace over HTTP and must never be passed to
   * the local fs bridge.  A stale/deleted local folder is advisory: keep the task
   * usable and surface the failure through the existing Work error area.
   */
  useEffect(() => {
    // Home has the same persisted directory selection before a task exists.
    // Once a task is active, never fall back to the stale home value: creating a
    // task intentionally copies the home selection into its own scope.
    const root = activeTask ? activeTask.workspacePath : state.homeWorkspacePath
    // Wait for the source snapshot before checking the mode.  It starts with an
    // embedded default during boot, while a configured remote engine has not yet
    // published its snapshot; authorizing that remote root locally would defeat
    // the local/remote workspace boundary.
    if (!engineReady || !root || isRemoteEngine()) return
    let alive = true
    void allowRoot(root).catch((cause: unknown) => {
      if (alive && epoch === getEngineSource()) setError(messageOf(cause))
    })
    return () => {
      alive = false
    }
  }, [activeTask?.workspacePath, engineReady, epoch, state.homeWorkspacePath])

  // Home needs a real session before the first message so the composer can expose
  // security mode immediately. It is replaced after a home task is created.
  useEffect(() => {
    if (state.homeSessionId) return
    updateWorkState(source, (previous) =>
      previous.homeSessionId
        ? previous
        : { ...previous, homeSessionId: 'work-home-' + crypto.randomUUID() }
    )
  }, [source, state.homeSessionId])

  const updateTask = useCallback(
    (id: string, patch: Partial<WorkTask>) => {
      if (patch.status !== undefined) invalidateStatusProbe(id)
      updateWorkState(source, previous => {
        const task = previous.tasks.find(item => item.id === id)
        if (!task || (Object.keys(patch) as Array<keyof WorkTask>).every(key => Object.is(task[key], patch[key]))) return previous
        return { ...previous, tasks: previous.tasks.map(item => item.id === id ? { ...item, ...patch } : item) }
      })
    },
    [source]
  )

  useEffect(() => {
    if (!activeId || !sessionModelReady || epoch !== getEngineSource()) return
    // An external/cron run can change its requested model without touching Work
    // metadata. Persist the resolved selection so the next request and restart
    // follow that run, retaining a local unsent choice anchored to the same run.
    updateTask(activeId, { modelId: requestModelId })
  }, [activeId, sessionModelReady, epoch, requestModelId, updateTask])

  const probeAuthorityRef = useRef({ selectedId: activeId, selectedLive: false })
  probeAuthorityRef.current = {
    selectedId: activeId,
    selectedLive: Boolean(activeId && loaded?.id === activeId && loaded.source === source && loaded.epoch === epoch &&
      chat.sessionModel?.sessionId === activeId && chat.sessionModel.source === epoch && !chat.historyError &&
      (chat.streaming || chat.messages.findLast(message => message.role === 'assistant')?.status === 'waiting'))
  }
  /** SSE owns the selected run. Other rows use bounded, lightweight status probes. */
  useEffect(() => {
    if (!engineReady) return
    let cancelled = false
    let syncing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async (): Promise<void> => {
      if (syncing) return
      syncing = true
      try {
        await pollWorkTaskStatuses({
          tasks: () => getWorkState(source).tasks,
          revision: id => taskRevisionsRef.current.get(id) ?? 0,
          shouldPoll: task => !stoppingTaskIdsRef.current.has(task.id) &&
            !(probeAuthorityRef.current.selectedId === task.id && probeAuthorityRef.current.selectedLive),
          isCurrent: () => !cancelled && epoch === getEngineSource(),
          request: id => requestOrThrow({ method: 'GET', path: '/chat/status', query: { sessionId: id } }),
          apply: (id, status) => {
            const task = getWorkState(source).tasks.find(item => item.id === id)
            updateTask(id, {
              status,
              updatedAt: Date.now(),
              ...(status === 'running' || status === 'waiting'
                ? { runStartedAt: task?.runStartedAt ?? Date.now() }
                : { runStartedAt: undefined })
            })
          }
        })
      } finally {
        syncing = false
        if (!cancelled) timer = setTimeout(() => void sync(), document.hidden || getAppMode() !== 'work' ? 5000 : 1500)
      }
    }
    void sync()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [engineReady, epoch, source, updateTask])

  const optionsFor = useCallback(
    (task: WorkTask): SendOptions => ({
      sessionId: task.id,
      model: (task.id === activeId && sessionModelReady ? requestModelId : canonicalModelId(task.modelId || settings.lastModelId)) || undefined,
      workspacePaths: task.workspacePath ? [task.workspacePath] : undefined,
      attachments: task.attachments,
      thinkingMode: requestedThinkingMode(thinkingFor(task.id)),
      subagentModel: settings.subagentModelId || undefined,
      utilityModel: settings.utilityModelId || undefined,
      agentId: task.agentId || undefined,
      // An empty task resource array means "no manual override". Sending it
      // on every turn would be interpreted by the engine as an explicit
      // whitelist and would silently erase the selected Agent's own bindings.
      // The composer has no separate "disable all" state, so only non-empty
      // selections become request-level overrides; Agent bindings remain the
      // source of truth otherwise.
      skills: task.resources?.skills?.filter(Boolean).length ? task.resources.skills : undefined,
      mcpServers: task.resources?.mcpServers?.filter(Boolean).length ? task.resources.mcpServers : undefined,
      knowledgeBases: task.resources?.knowledgeBases?.filter(Boolean).length ? task.resources.knowledgeBases : undefined
      // The engine resolves global preferences and this session's override at
      // admission. A cached legacy scope must not overwrite those settings.
    }),
    [source, thinkingSelection, settings.lastModelId, settings.thinkingMode, settings.subagentModelId, settings.utilityModelId, canonicalModelId, activeId, sessionModelReady, requestModelId]
  )

  const enqueueNextTurn = async (text: string, mentions: Mention[], draftRevision: number): Promise<void> => {
    assertEngineSource(epoch)
    const task = getWorkState(source).tasks.find(item => item.id === activeId)
    if (!task || preparing || uploadCount > 0 || !isHistoryReady(task.id)) throw new Error('任务或附件尚未就绪，草稿已保留')
    const originalDraft = getWorkDraft(source, task.id), options = optionsFor(task), sentAttachments = [...task.attachments]
    const queuedModel = nextModel?.source === source && nextModel.taskId === task.id ? nextModel.modelId : undefined
    const resources = (ids: string[] | undefined): WorkQueueDraft['resources']['skills'] => ids?.length ? { kind: 'override', ids: [...ids] } : { kind: 'inherit' }
    const chosen = queuedModel === undefined ? options.model : canonicalModelId(queuedModel)
    const submission: WorkQueueDraft = {
      draft: queuedDraft(text, mentions, draftRevision),
      model: chosen ? { kind: 'explicit', modelId: chosen } : { kind: 'engine-default' },
      resources: { skills: resources(options.skills), mcpServers: resources(options.mcpServers), knowledgeBases: resources(options.knowledgeBases) },
      thinking: options.thinkingMode === false ? { kind: 'off' } : typeof options.thinkingMode === 'string' ? { kind: 'effort', effort: options.thinkingMode } : { kind: 'inherit' },
      ...(options.subagentModel ? { subagentModel: options.subagentModel } : {}), ...(options.utilityModel ? { utilityModel: options.utilityModel } : {}),
      attachments: sentAttachments.map(file => ({ path: file.path, name: file.name, type: file.type, size: file.size }))
    }
    await nextTurnQueue.enqueue(submission)
    if (epoch !== getEngineSource()) return
    // An ACK belongs to the captured draft. Later typing, navigation and new uploads win over cleanup.
    if (getWorkDraft(source, task.id) === originalDraft) updateWorkDraft(source, task.id, '', [])
    updateWorkState(source, previous => ({ ...previous, tasks: previous.tasks.map(item => item.id === task.id
      ? { ...item, attachments: item.attachments.filter(file => !sentAttachments.some(sent => sent.path === file.path)), updatedAt: Date.now() } : item) }))
  }

  const sendTask = useCallback(
    async (task: WorkTask, text: string, mentions: Mention[] = task.mentions ?? [], preserveDraft = false, collaborators?: AgentCollaborator[]): Promise<void> => {
      assertEngineSource(epoch)
      // The stream IPC resolves after its reader closes, possibly after an
      // authoritative terminal snapshot or a later task has been selected.
      // The hook's exact current-session gate owns admission; old IPC promises
      // must not turn into a cross-task or cross-turn composer lock.
      if (getWorkState(source).activeTaskId !== task.id || hasSessionWork(task.id)) return
      setError(null)
      // Authenticated Work sessions start on a private scratch root until an
      // explicitly selected project is bound. Do that before the first turn so
      // files, Git and tool output all use the task's selected workspace.
      if (task.workspacePath) await bindSessionWorkspace(task.id, task.workspacePath)
      updateTask(task.id, { status: 'running', agentLocked: true, runStartedAt: Date.now(), updatedAt: Date.now() })
      const submission = {
        source,
        text,
        mentions: [...mentions],
        attachments: preserveDraft ? [] : task.attachments,
        createdAt: Date.now(),
        preserveDraft
      }
      submitted.current.set(task.id, submission)
      if (!preserveDraft) failedSubmissions.current.delete(task.id)
      try {
        const prepared = buildWorkAgentMessage(text, mentions)
        const delegation = collaborators ?? prepared.collaborators
        const sendOptions = optionsFor(preserveDraft ? { ...task, attachments: [] } : task)
        // Clear the input box the moment the request is dispatched (not after the
        // stream finishes). Attachments/mentions are captured in sendOptions first,
        // so wiping the live store does not drop them from the outgoing request.
        if (!preserveDraft) {
          const sentAttachments = task.attachments
          updateWorkState(source, (previous) => ({
            ...previous,
            tasks: previous.tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    draft: '',
                    mentions: [],
                    attachments: item.attachments.filter(
                      (file) => !sentAttachments.some((sent) => sent.path === file.path)
                    ),
                    updatedAt: Date.now()
                  }
                : item
            )
          }))
        }
        await chatSend(prepared.message, {
          ...sendOptions,
          ...(delegation.length ? { collaborators: delegation } : {})
        })
        if (epoch !== getEngineSource()) return
        // A follow-up from the Agent panel is independent of an unsent composer
        // draft. Its attachments and mention offsets must stay untouched.
        if (preserveDraft) return
        updateWorkState(source, (previous) => ({
          ...previous,
          tasks: previous.tasks.map((item) => {
            if (item.id !== task.id) return item
            // Draft/attachments were already cleared on dispatch; here we only fold
            // the sent attachments into sources and refresh the title. Any text the
            // user typed while the request was in flight is preserved as-is.
            const combined = [...item.sources, ...task.attachments]
            return {
              ...item,
              title:
                item.title === '新任务'
                  ? text.trim().replace(/\s+/g, ' ').slice(0, 52) || item.title
                  : item.title,
              sources: combined.filter(
                (file, index) =>
                  combined.findIndex((other) => other.path === file.path) === index
              ),
              updatedAt: Date.now()
            }
          })
        }))
      } catch (cause) {
        if (epoch === getEngineSource() && submitted.current.get(task.id) === submission) {
          if (!preserveDraft) failedSubmissions.current.set(task.id, {
            text,
            mentions: [...mentions],
            attachments: [...task.attachments]
          })
          setError(messageOf(cause))
          updateTask(task.id, { status: 'error', runStartedAt: undefined })
        }
        if (preserveDraft) throw cause
      }
    },
    [epoch, bindSessionWorkspace, chatSend, hasSessionWork, optionsFor, updateTask, source]
  )
  const sendTaskRef = useRef(sendTask)
  useEffect(() => {
    sendTaskRef.current = sendTask
  }, [sendTask])

  useEffect(() => {
    if (!activeId || !engineReady) return
    let alive = true
    setError(null)
    setLoaded(null)
    void resumeStream(activeId)
      .then(async () => {
        if (!alive || epoch !== getEngineSource()) return
        setLoaded({ source, epoch, id: activeId })
        if (!isHistoryReady(activeId)) return
        const start = pendingStart.current
        if (start?.source === source && start.id === activeId) {
          pendingStart.current = null
          const task = getWorkState(source).tasks.find((item) => item.id === activeId)
          if (task) await sendTaskRef.current(task, start.text, start.mentions)
        }
      })
      .catch((cause) => {
        if (alive) {
          setLoaded({ source, epoch, id: activeId })
          setError(messageOf(cause))
        }
      })
    return () => {
      alive = false
    }
  }, [activeId, source, epoch, engineReady, resumeStream, isHistoryReady, historyAttempt])

  const restored = loaded?.source === source && loaded.epoch === epoch && loaded.id === activeId
  const previewReady = Boolean(chat.publishedRecovery?.source === epoch && chat.publishedRecovery.sessionId === activeId && chat.publishedRecovery.previewAvailable)
  const messages = restored || previewReady ? chat.messages : []
  const preparing = Boolean(activeId && pendingStart.current?.source === source && pendingStart.current.id === activeId)
  const agentLocked = Boolean(activeTask && (activeTask.agentLocked || activeTask.status !== 'draft' || messages.length > 0 || preparing))
  const workspaceLocked = isRemoteEngine() || Boolean(activeTask
    ? activeTask.status !== 'draft' || activeTask.attachments.length || preparing
    : state.homeAttachments.length)
  const streaming = Boolean((restored || previewReady) && chat.streaming)
  // Streaming text replaces the active message object on every token. File
  // receipts do not change during those frames, so keep the derived artifact
  // array stable until a receipt, task scope, or source actually changes.
  const artifactCache = useRef<{ scope: string; value: WorkArtifact[] }>({ scope: '', value: [] })
  const artifacts = useMemo(() => {
    const scope = `${source}\0${activeId ?? ''}`
    const next = workArtifacts(messages)
    const previous = artifactCache.current
    if (previous.scope === scope && previous.value.length === next.length && previous.value.every((item, index) => {
      const candidate = next[index]
      return item.id === candidate.id && item.path === candidate.path && item.name === candidate.name &&
        item.content === candidate.content && item.status === candidate.status && item.createdAt === candidate.createdAt
    })) return previous.value
    artifactCache.current = { scope, value: next }
    return next
  }, [activeId, messages, source])
  const pending = useMemo(
    () =>
      messages
        .flatMap((message) => message.interactions ?? (message.pending ? [message.pending] : []))
        .filter((item) => item.status !== 'answered'),
    [messages]
  )

  useEffect(() => {
    const observedId = chat.sessionModel?.sessionId
    if (!observedId || chat.sessionModel?.source !== epoch) return
    const next = workStatus(chat.messages, chat.streaming)
    const task = getWorkState(source).tasks.find((item) => item.id === observedId)
    if (next && task && next !== task.status)
      updateTask(observedId, {
        status: next,
        updatedAt: Date.now(),
        ...(next === 'running' || next === 'waiting'
          ? { runStartedAt: task.runStartedAt ?? Date.now() }
          : { runStartedAt: undefined })
      })
    const sent = submitted.current.get(observedId)
    const last = chat.messages.filter((message) => message.role === 'assistant').at(-1)
    if (
      sent?.source === source &&
      last &&
      last.createdAt >= sent.createdAt &&
      !chat.streaming
    ) {
      if (last.status === 'error' && task && !sent.preserveDraft) {
        const attachments = [...task.attachments, ...sent.attachments]
        failedSubmissions.current.set(observedId, {
          text: sent.text,
          mentions: [...sent.mentions],
          attachments: [...sent.attachments]
        })
        updateTask(observedId, {
          draft: task.draft || sent.text,
          attachments: attachments.filter(
            (item, index) => attachments.findIndex((other) => other.path === item.path) === index
          )
        })
      }
      if (['done', 'error', 'aborted', 'interrupted'].includes(last.status))
        submitted.current.delete(observedId)
    }
  }, [epoch, chat.messages, chat.streaming, chat.sessionModel, source, updateTask])

  const createTask = useCallback(
    async (text?: string, mentions: Mention[] = []): Promise<void> => {
      flushWorkDrafts(source)
      if (uploadCount) {
        setError('资料仍在上传，请完成后再新建任务。')
        return
      }
      const current = getWorkState(source)
      const fromHome = text !== undefined
      const draft = text ?? ''
      const id = (fromHome ? current.homeSessionId : null) ?? 'work-' + crypto.randomUUID()
      const now = Date.now()
      const task: WorkTask = {
        id,
        title: draft.trim().replace(/\s+/g, ' ').slice(0, 52) || '新任务',
        draft,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        // A remote workspace root is an explicit user selection.  Keep it on
        // the Work task just like a local folder selection so the first turn
        // binds the session before Git/files are read.  Previously remote
        // tasks always copied null from the Work home state and silently fell
        // back to an engine scratch directory, making the Work Git pane look
        // like a non-repository even when the configured remote project was a
        // valid Git checkout.
        workspacePath: current.homeWorkspacePath || (isRemoteEngine() ? settings.remoteWorkspaceRoot.trim() || null : null),
        modelId: current.homeModelId || settings.lastModelId,
        attachments: fromHome ? current.homeAttachments : [],
        sources: [],
        agentId: fromHome ? current.homeAgentId || undefined : undefined,
        mentions,
        resources: fromHome ? current.homeResources : { skills: [], mcpServers: [], knowledgeBases: [] },
        archived: false
      }
      if (fromHome && (draft.trim() || task.attachments.length))
        pendingStart.current = { source, id, text: draft, mentions }
      updateWorkState(source, (previous) => ({
        ...previous,
        tasks: [task, ...previous.tasks],
        activeTaskId: id,
        ...(fromHome ? { homeDraft: '', homeAttachments: [], homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } } : {})
      }))
    },
    [source, settings.lastModelId, settings.remoteWorkspaceRoot, uploadCount]
  )

  const selectTask = useCallback(
    (id: string): void => {
      flushWorkDrafts(source)
      if (!getWorkState(source).tasks.some((task) => task.id === id)) return
      setError(null)
      updateWorkState(source, (previous) => ({ ...previous, activeTaskId: id }))
      setHistoryAttempt((attempt) => attempt + 1)
    },
    [source]
  )

  const renameTask = useCallback(
    (id: string, title: string): void => {
      const next = title.trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!next) throw new Error('任务名称不能为空')
      if (!getWorkState(source).tasks.some((task) => task.id === id)) return
      updateTask(id, { title: next, updatedAt: Date.now() })
    },
    [source, updateTask]
  )

  const archiveTask = useCallback(
    (id: string, archived = true): void => {
      const task = getWorkState(source).tasks.find((item) => item.id === id)
      if (!task) return
      updateWorkState(source, (previous) => ({
        ...previous,
        activeTaskId: archived && previous.activeTaskId === id ? null : previous.activeTaskId,
        tasks: previous.tasks.map((item) =>
          item.id === id
            ? { ...item, archived, archivedAt: archived ? Date.now() : undefined, updatedAt: Date.now() }
            : item
        )
      }))
      if (archived && activeId === id) setHistoryAttempt((attempt) => attempt + 1)
    },
    [source, activeId]
  )

  const continueTask = useCallback(
    (id: string): void => {
      invalidateStatusProbe(id)
      flushWorkDrafts(source)
      const task = getWorkState(source).tasks.find((item) => item.id === id)
      if (!task) return
      updateWorkState(source, (previous) => ({
        ...previous,
        activeTaskId: id,
        tasks: previous.tasks.map((item) =>
          item.id === id
            ? {
                ...item,
                archived: false,
                archivedAt: undefined,
                status: ['done', 'error', 'stopped', 'interrupted'].includes(item.status) ? 'draft' : item.status,
                ...(item.status === 'running' || item.status === 'waiting' ? {} : { runStartedAt: undefined }),
                updatedAt: Date.now()
              }
            : item
        )
      }))
      setError(null)
      setHistoryAttempt((attempt) => attempt + 1)
    },
    [source]
  )
  const showHome = useCallback((): void => {
    flushWorkDrafts(source)
    setError(null)
    updateWorkState(source, (previous) => ({ ...previous, activeTaskId: null }))
  }, [source])
  const setDraft = useCallback(
    (draft: string, mentions: Mention[] = []): void => {
      updateWorkDraft(source, activeId, draft, mentions)
    },
    [activeId, source]
  )
  const setModel = useCallback(
    (next: string): void => {
      if (epoch !== getEngineSource()) return
      if (activeTask && ['running', 'waiting'].includes(activeTask.status)) return
      if (activeId) {
        if (!sessionModelReady) return
        const canonical = canonicalModelId(next)
        const selection = canonical ? { modelId: canonical, anchorRunId: chat.sessionModel?.runId } : null
        const defaultSelection = canonical ? null : { anchorRunId: chat.sessionModel?.runId, clientDefault: !followsEngineDefault }
        setSelectedModel({ source, id: activeId, selection, defaultSelection })
        saveSessionModelSelection(activeId, selection, source)
        saveWorkDefaultModelSelection(activeId, defaultSelection, source)
        updateTask(activeId, { modelId: canonical || (followsEngineDefault ? '' : canonicalModelId(settings.lastModelId)) })
      } else updateWorkState(source, (previous) => ({ ...previous, homeModelId: next }))
    },
    [activeId, activeTask, source, updateTask, epoch, sessionModelReady, chat.sessionModel, canonicalModelId, settings.lastModelId, followsEngineDefault]
  )
  const setAgent = useCallback(
    (agentId: string): boolean => {
      if (agentLocked || (activeId && pendingStart.current?.source === source && pendingStart.current.id === activeId)) return false
      if (activeId) updateTask(activeId, { agentId: agentId || undefined })
      else updateWorkState(source, (previous) => ({ ...previous, homeAgentId: agentId }))
      return true
    },
    [activeId, agentLocked, source, updateTask]
  )
  const resources = activeTask ? activeTask.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] } : state.homeResources
  const setResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const update = (current: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }) => ({
      ...current, [key]: current[key].includes(id) ? current[key] : [...current[key], id]
    })
    if (activeId) updateTask(activeId, { resources: update(activeTask?.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] }) })
    else updateWorkState(source, previous => ({ ...previous, homeResources: update(previous.homeResources) }))
  }, [activeId, activeTask?.resources, source, updateTask])
  const removeResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const update = (current: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }) => ({ ...current, [key]: current[key].filter(item => item !== id) })
    if (activeId) updateTask(activeId, { resources: update(activeTask?.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] }) })
    else updateWorkState(source, previous => ({ ...previous, homeResources: update(previous.homeResources) }))
  }, [activeId, activeTask?.resources, source, updateTask])
  const send = useCallback(
    async (text?: string, mentions: Mention[] = []): Promise<void> => {
      flushWorkDrafts(source)
      const currentTaskSending = activeTask ? hasSessionWork(activeTask.id) : false
      if (!engineReady || streaming || currentTaskSending || pending.length || uploadCount > 0) return
      if (!activeTask) {
        const home = getWorkDraft(source, null)
        await createTask(text ?? home.text, mentions.length ? mentions : home.mentions)
        return
      }
      if (!restored || !isHistoryReady(activeTask.id)) return
      const currentTask = getWorkState(source).tasks.find(task => task.id === activeTask.id)
      if (!currentTask) return
      const draft = text ?? currentTask.draft
      if (!draft.trim() && !currentTask.attachments.length) return
      await sendTask(currentTask, draft, mentions.length ? mentions : currentTask.mentions ?? [])
    },
    [
      engineReady,
      streaming,
      hasSessionWork,
      pending.length,
      uploadCount,
      activeTask,
      createTask,
      state.homeDraft,
      state.homeMentions,
      restored,
      sendTask,
      isHistoryReady,
      source
    ]
  )

  /** Replay the exact failed user turn from a Work error card. */
  const retryFailedTask = useCallback(async (): Promise<void> => {
    if (!activeTask || !engineReady) throw new Error('引擎尚未就绪，请稍后重试')
    if (streaming || pending.length || uploadCount > 0 || hasSessionWork(activeTask.id))
      throw new Error('当前任务仍在执行，请等待本轮结束后重试')
    if (!restored || !isHistoryReady(activeTask.id)) {
      setHistoryAttempt(attempt => attempt + 1)
      throw new Error('任务历史尚未就绪，正在重新读取后再试')
    }
    const latest = getWorkState(source).tasks.find(task => task.id === activeTask.id)
    if (!latest) throw new Error('任务已不存在，请重新打开任务')
    const failed = failedSubmissions.current.get(activeTask.id)
    const text = failed?.text ?? latest.draft
    const attachments = failed?.attachments ?? latest.attachments
    if (!text.trim() && !attachments.length) throw new Error('没有可重试的原始指令，请在输入框中重新描述任务')
    await sendTaskRef.current({ ...latest, attachments }, text, failed?.mentions ?? latest.mentions ?? [])
    failedSubmissions.current.delete(activeTask.id)
  }, [activeTask, engineReady, streaming, pending.length, uploadCount, hasSessionWork, restored, isHistoryReady, source])

  const stop = useCallback(async (): Promise<void> => {
    if (!activeTask || !engineReady) return
    // The user can stop before the first stream exists. Clearing the queued
    // start prevents the history preflight from launching it after this click.
    if (pendingStart.current?.source === source && pendingStart.current.id === activeTask.id) {
      pendingStart.current = null
      updateTask(activeTask.id, { status: 'stopped', runStartedAt: undefined, updatedAt: Date.now() })
      return
    }
    invalidateStatusProbe(activeTask.id)
    stoppingTaskIdsRef.current.add(activeTask.id)
    setError(null)
    try {
      if (chat.streaming) await abort()
      else {
        await requestOrThrow({
          method: 'POST',
          path: '/chat/cancel',
          body: { sessionId: activeTask.id }
        })
        assertEngineSource(epoch)
        await resumeStream(activeTask.id)
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      stoppingTaskIdsRef.current.delete(activeTask.id)
      invalidateStatusProbe(activeTask.id)
    }
  }, [activeTask, engineReady, chat.streaming, abort, epoch, resumeStream, source, updateTask])

  const continueSubagent = useCallback(async (run: SubagentRun, instruction: string): Promise<void> => {
    if (!activeTask || !instruction.trim()) throw new Error('请输入继续交给子代理的工作')
    if (!engineReady || !restored || !isHistoryReady(activeTask.id) || streaming || pending.length || uploadCount > 0)
      throw new Error('请等待当前任务完成或处理待确认事项，再继续子代理')
    const current = await requestOrThrow<SubagentRun>({ method: 'GET', path: `/subagent/runs/${encodeURIComponent(run.runId)}` })
    assertEngineSource(epoch)
    const latest = getWorkState(source)
    const task = latest.tasks.find(item => item.id === activeTask.id)
    if (latest.activeTaskId !== activeTask.id || !task || current.parentSessionId !== activeTask.id || current.runId !== run.runId)
      throw new Error('任务已切换，请在对应任务中继续子代理')
    if (['running', 'waiting'].includes(task.status) || !isHistoryReady(task.id))
      throw new Error('当前任务正在执行或等待确认，请完成后再继续子代理')
    if (['queued', 'running', 'cancelling'].includes(current.status)) throw new Error('这个子代理仍在运行，请等待本轮结束')
    if (hasSessionWork(activeTask.id)) throw new Error('当前任务已有请求正在发送')
    await sendTaskRef.current(task, instruction.trim(), [], true, [{ resumeRunId: current.runId }])
  }, [activeTask, engineReady, restored, isHistoryReady, streaming, pending.length, uploadCount, epoch, source, hasSessionWork, sendTask])

  const stopTask = useCallback(async (id: string): Promise<void> => {
    invalidateStatusProbe(id)
    const task = getWorkState(source).tasks.find((item) => item.id === id)
    if (!task || !engineReady) return
    if (activeTask?.id === id) {
      await stop()
      return
    }
    stoppingTaskIdsRef.current.add(id)
    try {
      await requestOrThrow({ method: 'POST', path: '/chat/cancel', body: { sessionId: id } })
      assertEngineSource(epoch)
      updateTask(id, { status: 'stopped', runStartedAt: undefined, updatedAt: Date.now() })
    } finally {
      stoppingTaskIdsRef.current.delete(id)
      invalidateStatusProbe(id)
    }
  }, [source, engineReady, activeTask?.id, stop, epoch, updateTask])

  const exportTask = useCallback(async (id: string): Promise<string> => {
    flushWorkDrafts(source)
    const task = getWorkState(source).tasks.find((item) => item.id === id)
    if (!task) throw new Error('任务不存在')
    let snapshot: ChatRecoverySnapshot | null = null
    try {
      snapshot = await requestOrThrow<ChatRecoverySnapshot>({
        method: 'GET', path: '/chat/snapshot', query: { sessionId: id }
      })
      assertEngineSource(epoch)
      if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== id)
        throw new Error('任务历史不匹配，请重试导出')
    } catch (cause) {
      // A never-sent draft has no engine session yet; it is still useful to
      // export its local metadata and attachments. Sent tasks must surface a
      // snapshot error instead of silently exporting an empty transcript.
      if (task.status !== 'draft') throw cause
    }
    const exportedMessages = snapshot
      ? restoreChatSnapshot(snapshot).messages
      : activeId === id ? messages : []
    const prompt = exportedMessages.find((message) => message.role === 'user')?.content || task.draft
    const snapshotStatus: WorkTask['status'] = snapshot?.run?.status === 'running' ? 'running' :
      snapshot?.run?.status === 'waiting' ? 'waiting' :
        snapshot?.run?.status === 'cancelled' ? 'stopped' :
          snapshot?.run?.status === 'interrupted' ? 'interrupted' :
            snapshot?.run?.status === 'failed' ? 'error' :
              snapshot?.run?.status === 'succeeded' ? 'done' : task.status
    const payload = JSON.stringify({
      title: task.title,
      status: snapshotStatus,
      workspacePath: task.workspacePath,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      prompt,
      attachments: task.attachments,
      sources: task.sources,
      historyCompacted: snapshot?.historyCompacted === true,
      transcript: exportedMessages.map((message) => ({
              role: message.role,
              content: message.content,
              thinking: message.thinking,
              status: message.status,
              createdAt: message.createdAt,
              attachments: message.attachments
            })),
      artifacts: workArtifacts(exportedMessages)
    }, null, 2)
    if (typeof document !== 'undefined') {
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${task.title.replace(/[\\/:*?"<>|]/g, '_') || 'work-task'}.json`
      // Chromium only promotes blob downloads from an attached anchor. A
      // detached `click()` is ignored in Electron, which made export appear
      // to work while never producing a file.
      link.style.display = 'none'
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    }
    return payload
  }, [source, epoch, activeId, messages])
  const respond = useCallback(
    async (requestId: string, values: string[]): Promise<void> => {
      if (!activeTask || !restored) return
      invalidateStatusProbe(activeTask.id)
      setError(null)
      try {
        await chatRespond(requestId, values, optionsFor(activeTask))
      } catch (cause) {
        // The pending card owns this interaction's error and recovery action.
        // Re-throw so it can offer a real response retry instead of leaving a
        // second, unrelated composer-level error behind.
        throw cause
      }
    },
    [activeTask, restored, chatRespond, optionsFor]
  )

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    setError(null)
    if (uploadCount > 0) {
      setError('资料上传完成后再更换项目，已添加的资料会保留。')
      return
    }
    if (isRemoteEngine()) {
      setError('远端任务使用独立沙箱，不能选择本机目录。')
      return
    }
    if (activeTask && (workspaceLocked || (pendingStart.current?.source === source && pendingStart.current.id === activeTask.id))) {
      setError('任务开始或添加资料后，工作目录保持固定。请新建任务以使用另一个目录。')
      return
    }
    if (!activeTask && state.homeAttachments.length) {
      setError('请先移除已添加的资料，再更换工作目录。')
      return
    }
    try {
      const root = await pickFolder()
      if (!root || epoch !== getEngineSource()) return
      // Folder selection is asynchronous. A task may be sent while the native
      // picker is open; recheck its current scope before applying the result.
      const latest = getWorkState(source)
      const latestTask = activeId ? latest.tasks.find(task => task.id === activeId) : null
      if (latest.activeTaskId !== activeId || (latestTask
        ? latestTask.status !== 'draft' || latestTask.attachments.length ||
          (pendingStart.current?.source === source && pendingStart.current.id === activeId)
        : latest.homeAttachments.length)) {
        setError('任务或资料状态已变化，工作目录保持固定。请新建任务以使用另一个目录。')
        return
      }
      if (activeId) updateTask(activeId, { workspacePath: root })
      else updateWorkState(source, (previous) => ({ ...previous, homeWorkspacePath: root }))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [activeTask, activeId, workspaceLocked, state.homeAttachments.length, epoch, source, updateTask, uploadCount])

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (!files.length) return
      setError(null)
      const taskId = activeId
      const root = activeTask ? activeTask.workspacePath : state.homeWorkspacePath
      const remote = isRemoteEngine()
      let sessionId = taskId ?? getWorkState(source).homeSessionId
      if (!sessionId) {
        sessionId = 'work-' + crypto.randomUUID()
        const homeSessionId = sessionId
        updateWorkState(source, (previous) => ({ ...previous, homeSessionId }))
      }
      setUploadCount((count) => count + 1)
      try {
        if (!remote && root) await allowRoot(root)
        for (const file of files) {
          if (!isSupportedFile(file)) throw new Error(`「${file.name}」的格式暂不支持`)
          if (file.size > 20 * 1024 * 1024)
            throw new Error(`「${file.name}」超过 20 MB，请缩小文件后重试`)
          assertEngineSource(epoch)
          const data = new Uint8Array(await file.arrayBuffer())
          assertEngineSource(epoch)
          const requestId = crypto.randomUUID()
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              if (remote) void cancelAttachmentUpload(requestId).catch(() => undefined)
              reject(new Error('资料上传超时，请重试'))
            }, 120_000)
          })
          const result = await Promise.race([
            remote
              ? uploadAttachment({
                  requestId,
                  sessionId,
                  fileName: file.name,
                  type: file.type || 'application/octet-stream',
                  data
                })
              : root
                ? copyIntoWorkspace({ root, fileName: file.name, data })
                : (async () => {
                    // No project is a valid Work state. Persist the attachment
                    // through the session-scoped engine API, which creates and
                    // owns the task's private scratch directory.
                    const relativePath = scratchAttachmentPath(file.name)
                    await requestOrThrow({
                      method: 'POST',
                      path: '/workspace/file',
                      body: {
                        sessionId,
                        path: relativePath,
                        content: encodeBase64(data),
                        encoding: 'base64'
                      }
                    })
                    return { path: relativePath, relativePath, size: data.byteLength }
                  })(),
            timeout
          ]).finally(() => clearTimeout(timer))
          assertEngineSource(epoch)
          const attachment: ChatAttachment = {
            path: 'relativePath' in result ? result.relativePath : result.path,
            ...('remoteUploadId' in result ? { remoteUploadId: result.remoteUploadId } : {}),
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: result.size
          }
          updateWorkState(source, (previous) =>
            taskId
              ? {
                  ...previous,
                  tasks: previous.tasks.map((task) =>
                    task.id === taskId
                      ? { ...task, attachments: [...task.attachments, attachment] }
                      : task
                  )
                }
              : { ...previous, homeAttachments: [...previous.homeAttachments, attachment] }
          )
        }
      } catch (cause) {
        if (epoch === getEngineSource()) setError(messageOf(cause))
      } finally {
        setUploadCount((count) => count - 1)
      }
    },
    [activeId, activeTask, state.homeWorkspacePath, epoch, source]
  )

  const removeAttachment = useCallback(
    (path: string): void => {
      updateWorkState(source, (previous) =>
        activeId
          ? {
              ...previous,
              tasks: previous.tasks.map((task) =>
                task.id === activeId
                  ? { ...task, attachments: task.attachments.filter((item) => item.path !== path) }
                  : task
              )
            }
          : {
              ...previous,
              homeAttachments: previous.homeAttachments.filter((item) => item.path !== path)
            }
      )
    },
    [source, activeId]
  )
  const addReference = useCallback(
    (artifact: WorkArtifact): void => {
      const latest = getWorkDraft(source, activeId)
      const current = latest.text
      const existing = latest.mentions
      const prefix = `${current}${current ? '\n\n' : ''}针对成果 `
      const mention: Mention = {
        source: 'file',
        displayText: artifact.name,
        path: artifact.path,
        textOffset: prefix.length
      }
      const token = mentionToken(mention)
      setDraft(`${prefix}${token}：\n`, [...existing, mention])
    },
    [source, activeId, setDraft]
  )

  const removeSource = useCallback((path: string): void => {
    if (!activeId || epoch !== getEngineSource()) return
    // A task reference has a shorter lifetime than the bytes used by its history.
    updateWorkState(source, previous => ({ ...previous, tasks: previous.tasks.map(task =>
      task.id === activeId ? { ...task, sources: task.sources.filter(item => item.path !== path) } : task) }))
  }, [source, activeId, epoch])

  const addSourceReference = useCallback((attachment: ChatAttachment): void => {
    if (!activeId || epoch !== getEngineSource()) return
    const latest = getWorkDraft(source, activeId)
    const prefix = `${latest.text}${latest.text ? '\n\n' : ''}参考资料 `
    const mention: Mention = { source: 'file', displayText: attachment.name, path: attachment.path, textOffset: prefix.length }
    setDraft(`${prefix}${mentionToken(mention)}：\n`, [...latest.mentions, mention])
  }, [source, activeId, epoch, setDraft])

  return {
    draftSource: source,
    tasks: state.tasks,
    archivedTasks: state.tasks.filter((task) => task.archived === true),
    activeTask,
    get homeDraft() { return getWorkDraft(source, null).text },
    get draft() { return getWorkDraft(source, activeId).text },
    attachments: activeTask?.attachments ?? state.homeAttachments,
    sources: activeTask?.sources ?? [],
    workspacePath: activeTask ? activeTask.workspacePath : state.homeWorkspacePath,
    agentId,
    agentIdentity,
    agentLocked,
    workspaceLocked,
    get mentions() { return getWorkDraft(source, activeId).mentions },
    utilityModel: settings.utilityModelId,
    resources,
    securitySessionId,
    thinkingMode,
    setThinkingMode,
    modelId,
    defaultModelId: followsEngineDefault ? '' : canonicalModelId(settings.lastModelId || agentIdentity.model),
    defaultModelSource: followsEngineDefault ? undefined : settings.lastModelId ? '客户端默认' : agentIdentity.model ? 'Agent 配置' : undefined,
    models,
    messages,
    usageSyncNotice: restored ? chat.usageSyncNotice : null,
    publishedRecovery: chat.publishedRecovery?.source === epoch && chat.publishedRecovery.sessionId === activeId ? chat.publishedRecovery : null,
    publishedFixedChildren: (restored || previewReady) && chat.publishedFixedChildren,
    cancelPublishedRecovery: chat.cancelPublishedRecovery,
    loadPublishedBody: chat.loadPublishedBody,
    retryPublishedRecovery: chat.retryPublishedRecovery,
    nextTurnQueue,
    enqueueNextTurn,
    nextQueueModelId: nextModel?.source === source && nextModel.taskId === activeId ? nextModel.modelId : modelId,
    setNextQueueModel: (value: string) => { if (activeId) setNextModel({ source, taskId: activeId, modelId: canonicalModelId(value) }) },
    workspaceRunId: restored && chat.sessionModel?.source === epoch && chat.sessionModel.sessionId === activeId ? chat.sessionModel.runId : undefined,
    contextCompaction: restored && chat.sessionModel?.source === epoch && chat.sessionModel.sessionId === activeId ? chat.sessionModel.compaction : undefined,
    todos: restored ? chat.todos : [],
    artifacts,
    pending,
    streaming,
    pendingInitialStart: preparing,
    launching: Boolean(engineReady && !error && !chat.historyError && activeId && pendingStart.current?.source === source && pendingStart.current.id === activeId),
    remote: isRemoteEngine(),
    ready: engineReady,
    modelReady: !activeId || sessionModelReady,
    loading: Boolean(activeId && engineReady && !restored && !previewReady),
    historyReady: !activeId || (restored && isHistoryReady(activeId)),
    historyRecovery: activeId && chat.connection.scope?.source === epoch && chat.connection.scope.sessionId === activeId
      ? chat.connection : null,
    recoveryNotice: activeId && chat.sessionModel?.source === epoch && chat.sessionModel.sessionId === activeId ? chat.recoveryNotice : null,
    dismissRecoveryNotice: chat.dismissRecoveryNotice,
    historyCompacted: restored && chat.historyCompacted,
    archiveRemaining: restored ? chat.archiveRemaining : null,
    archivePage: restored ? chat.archivePage : null,
    archiveLoading: restored && chat.archiveLoading,
    archiveError: restored ? chat.archiveError : null,
    loadArchive: (action: ArchivePageAction = 'older') => activeId ? chat.loadArchive(activeId, action) : Promise.resolve(),
    uploading: uploadCount > 0,
    error: error ?? (activeId ? chat.historyError : null),
    createTask,
    selectTask,
    showHome,
    setDraft,
    send,
    stop,
    stopTask,
    renameTask,
    archiveTask,
    continueTask,
    exportTask,
    respond,
    chooseWorkspace,
    addFiles,
    removeAttachment,
    removeSource,
    addSourceReference,
    setModel,
    setAgent,
    continueSubagent,
    setResource,
    removeResource,
    addReference,
    clearError: () => setError(null),
    retryHistory: () => setHistoryAttempt((attempt) => attempt + 1),
    retryFailedTask
  }
}
