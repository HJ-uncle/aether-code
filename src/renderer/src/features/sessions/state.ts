import { useCallback, useSyncExternalStore } from 'react'
import type { ChatAttachment, ChatMessage } from '@renderer/core/engine/useChat'
import type { CommandJobSnapshot } from '@shared/command-job'
import { visibleChildCommandJobs } from '../../core/engine/command-job-state'
import { mergeFileChanges } from '../../core/engine/tool-file-changes'
import { isStoredMention, type Mention } from '@renderer/features/conversation/shared/mention-context'
import { storedAttachments } from '@renderer/features/conversation/shared/attachment-storage'
import { createDraftPersistenceScheduler } from './draft-persistence'
import type { RootRun, RootRunActivity, RootRunStatus } from '@shared/root-run'
import { normalizeSessionTaskActivity, sessionTaskStatusFromRun } from './status-poller'
import { trackSessionTaskCompletion } from '../conversation/completion-state'

export type TaskStatus =
  'draft' | 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'interrupted'
export type SessionTaskLabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'
export const SESSION_TASK_LABEL_COLORS: readonly SessionTaskLabelColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']
/** Only the execution watermark and waiting counts belong in the task list. */
export interface SessionTaskActivity {
  runId: string
  seq: number
  version: number
  status: RootRunStatus
  updatedAt: number
  pendingAsk: number
  pendingPermission: number
  execution?: RootRunActivity
}
export interface SessionResources {
  skills: string[]
  mcpServers: string[]
  knowledgeBases: string[]
  /** Sent labels stay out of the draft while the conversation keeps its knowledge scope. */
  knowledgeBaseMentionsConsumed?: string[]
  /** An authored empty selection overrides the previous run; absent keys still inherit Agent defaults. */
  resourceOverrides?: Array<'skills' | 'mcpServers' | 'knowledgeBases'>
  /** Absence restores the engine selection; [] explicitly disables all toolkits. */
  toolkits?: string[]
}
export interface SessionTask {
  id: string
  title: string
  draft: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  pinned?: boolean
  labelColor?: SessionTaskLabelColor
  activity?: SessionTaskActivity
  /** Cleared by opening the completed conversation, independent of list ordering. */
  completionUnread?: boolean
  /** Timestamp of the currently active turn. Kept separate from task age so
   * a long-lived task does not look like it has been running for days. */
  runStartedAt?: number
  workspacePath: string | null
  modelId: string
  attachments: ChatAttachment[]
  sources: ChatAttachment[]
  agentId?: string
  /** The engine fixes this binding at the first send, including the default Agent. */
  agentLocked?: boolean
  mentions?: Mention[]
  resources?: SessionResources
  /** 已归档任务仍保留在本地状态中，方便恢复历史与导出，不参与默认任务列表。 */
  archived?: boolean
  archivedAt?: number
  /** A real scheduler session can use a UUID rather than Work's client-generated prefix. */
  origin?: { kind: 'automation'; jobId: string; runId: string }
}
export interface SessionArtifact {
  producerChildSessionId?: string
  producerRunId?: string
  id: string
  path: string
  name: string
  content: string | null
  status: 'draft' | 'ready' | 'deleted' | 'unverified'
  createdAt: number
}
export interface SessionState {
  tasks: SessionTask[]
  activeTaskId: string | null
  homeDraft: string
  homeWorkspacePath: string | null
  homeAttachments: ChatAttachment[]
  homeSources: ChatAttachment[]
  homeModelId: string
  homeSessionId: string | null
  homeAgentId: string
  homeMentions: Mention[]
  homeResources: SessionResources
}

const states = new Map<string, SessionState>()
const listeners = new Map<string, Set<() => void>>()
export interface SessionDraft { text: string; mentions: Mention[] }
const drafts = new Map<string, Map<string | null, SessionDraft>>()
const draftListeners = new Map<string, Map<string | null, Set<() => void>>>()
const dirtyDrafts = new Map<string, Set<string | null>>()
const draftSaves = new Map<string, ReturnType<typeof createDraftPersistenceScheduler>>()
let watchingDraftLifecycle = false

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as Array<keyof T>
  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]))
}
export function sameMentions(left: Mention[], right: Mention[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => sameFields(item, right[index])))
}
function sourceDrafts(source: string): Map<string | null, SessionDraft> {
  let entries = drafts.get(source)
  if (!entries) { entries = new Map(); drafts.set(source, entries) }
  return entries
}
export function getSessionDraft(source: string, taskId: string | null): SessionDraft {
  const entries = sourceDrafts(source)
  const cached = entries.get(taskId)
  if (cached) return cached
  const state = getSessionState(source)
  const task = taskId ? state.tasks.find(item => item.id === taskId) : null
  const draft = { text: taskId ? task?.draft ?? '' : state.homeDraft, mentions: taskId ? task?.mentions ?? [] : state.homeMentions }
  entries.set(taskId, draft)
  return draft
}
function publishDraft(source: string, taskId: string | null, draft: SessionDraft): void {
  const previous = getSessionDraft(source, taskId)
  if (previous.text === draft.text && sameMentions(previous.mentions, draft.mentions)) return
  sourceDrafts(source).set(taskId, draft)
  for (const listener of draftListeners.get(source)?.get(taskId) ?? []) listener()
}

/** The input subscribes to its own draft; history and hidden panels do not render per character. */
export function updateSessionDraft(source: string, taskId: string | null, text: string, mentions: Mention[]): void {
  const previous = getSessionDraft(source, taskId)
  if (previous.text === text && sameMentions(previous.mentions, mentions)) return
  publishDraft(source, taskId, { text, mentions })
  let dirty = dirtyDrafts.get(source)
  if (!dirty) { dirty = new Set(); dirtyDrafts.set(source, dirty) }
  dirty.add(taskId)
  let save = draftSaves.get(source)
  if (!save) {
    save = createDraftPersistenceScheduler(() => updateSessionState(source, state => state))
    draftSaves.set(source, save)
  }
  save.schedule()
  if (!watchingDraftLifecycle && typeof window !== 'undefined') {
    watchingDraftLifecycle = true
    const flush = (): void => flushSessionDrafts()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
  }
}
export function flushSessionDrafts(source?: string): void {
  if (source !== undefined) draftSaves.get(source)?.flush()
  else for (const save of draftSaves.values()) save.flush()
}
export function onSessionDraftChanged(source: string, taskId: string | null, listener: () => void): () => void {
  let byTask = draftListeners.get(source)
  if (!byTask) { byTask = new Map(); draftListeners.set(source, byTask) }
  let subscribers = byTask.get(taskId)
  if (!subscribers) { subscribers = new Set(); byTask.set(taskId, subscribers) }
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (!subscribers.size) byTask.delete(taskId)
    if (!byTask.size) draftListeners.delete(source)
  }
}
export function useSessionDraft(source: string, taskId: string | null): SessionDraft {
  return useSyncExternalStore(
    useCallback(listener => onSessionDraftChanged(source, taskId, listener), [source, taskId]),
    useCallback(() => getSessionDraft(source, taskId), [source, taskId])
  )
}
export function sessionStorageKey(source: string): string {
  return 'aether.work.state.v1' + (source ? ':' + encodeURIComponent(source) : '')
}
const emptyState = (): SessionState => ({
  tasks: [],
  activeTaskId: null,
  homeDraft: '',
  homeWorkspacePath: null,
  homeAttachments: [],
  homeSources: [],
  homeModelId: '',
  homeSessionId: null,
  homeAgentId: '',
  homeMentions: [],
  homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] }
})

function attachments(value: unknown): ChatAttachment[] {
  return storedAttachments(value)
}

function resourceOverrides(value: unknown): NonNullable<SessionResources['resourceOverrides']> {
  return Array.isArray(value) ? [...new Set(value.filter((key): key is NonNullable<SessionResources['resourceOverrides']>[number] =>
    key === 'skills' || key === 'mcpServers' || key === 'knowledgeBases'))] : []
}

function consumedKnowledgeMentions(value: unknown, selected: unknown): string[] {
  return Array.isArray(value) && Array.isArray(selected) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && selected.includes(id)))] : []
}

export function normalizeSessionState(value: unknown): SessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState()
  const data = value as Partial<SessionState>
  const statuses: TaskStatus[] = [
    'draft',
    'running',
    'waiting',
    'done',
    'error',
    'stopped',
    'interrupted'
  ]
  const tasks = Array.isArray(data.tasks)
    ? data.tasks
        .filter(
          (task) =>
            task &&
            typeof task.id === 'string' &&
            (task.id.startsWith('work-') || storedAutomationOrigin(task.origin)) &&
            typeof task.title === 'string' &&
            typeof task.createdAt === 'number' && Number.isFinite(task.createdAt)
        )
        .map((task) => ({
          id: task.id,
          title: task.title,
          createdAt: task.createdAt,
          draft: typeof task.draft === 'string' ? task.draft : '',
          updatedAt: typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt) ? task.updatedAt : task.createdAt,
          ...(task.pinned === true ? { pinned: true } : {}),
          ...(SESSION_TASK_LABEL_COLORS.includes(task.labelColor!) ? { labelColor: task.labelColor } : {}),
          ...(normalizeSessionTaskActivity(task.activity) ? { activity: normalizeSessionTaskActivity(task.activity) } : {}),
          ...(task.status === 'done' && task.completionUnread === true ? { completionUnread: true } : {}),
          ...(typeof task.runStartedAt === 'number' && Number.isFinite(task.runStartedAt) && task.runStartedAt > 0
            ? { runStartedAt: task.runStartedAt }
            : {}),
          status: statuses.includes(task.status) ? task.status : 'draft',
          workspacePath: typeof task.workspacePath === 'string' ? task.workspacePath : null,
          modelId: typeof task.modelId === 'string' ? task.modelId : '',
          attachments: attachments(task.attachments),
          sources: attachments(task.sources),
          ...(typeof task.agentId === 'string' && task.agentId.trim() ? { agentId: task.agentId } : {}),
          ...(task.agentLocked === true ? { agentLocked: true } : {}),
          ...(storedAutomationOrigin(task.origin) ? { origin: { ...task.origin } } : {}),
          ...(Array.isArray(task.mentions) ? { mentions: task.mentions.filter(isStoredMention) } : {}),
          ...(task.resources && typeof task.resources === 'object' ? {
            resources: {
              skills: Array.isArray(task.resources.skills) ? task.resources.skills.filter((v): v is string => typeof v === 'string') : [],
              mcpServers: Array.isArray(task.resources.mcpServers) ? task.resources.mcpServers.filter((v): v is string => typeof v === 'string') : [],
              knowledgeBases: Array.isArray(task.resources.knowledgeBases) ? task.resources.knowledgeBases.filter((v): v is string => typeof v === 'string') : [],
              ...(Array.isArray(task.resources.knowledgeBaseMentionsConsumed) ? { knowledgeBaseMentionsConsumed: consumedKnowledgeMentions(task.resources.knowledgeBaseMentionsConsumed, task.resources.knowledgeBases) } : {}),
              ...(Array.isArray(task.resources.resourceOverrides) ? { resourceOverrides: resourceOverrides(task.resources.resourceOverrides) } : {}),
              ...(Array.isArray(task.resources.toolkits) ? { toolkits: [...new Set(task.resources.toolkits.filter((v): v is string => typeof v === 'string'))] } : {})
            }
          } : {}),
          ...(task.archived === true
            ? {
                archived: true,
                ...(typeof task.archivedAt === 'number' && Number.isFinite(task.archivedAt) ? { archivedAt: task.archivedAt } : {})
              }
            : {})
        }))
    : []
  return {
    tasks,
    activeTaskId: tasks.some((task) => task.id === data.activeTaskId) ? data.activeTaskId! : null,
    homeDraft: typeof data.homeDraft === 'string' ? data.homeDraft : '',
    homeWorkspacePath: typeof data.homeWorkspacePath === 'string' ? data.homeWorkspacePath : null,
    homeAttachments: attachments(data.homeAttachments),
    homeSources: attachments(data.homeSources),
    homeModelId: typeof data.homeModelId === 'string' ? data.homeModelId : '',
    homeSessionId:
      typeof data.homeSessionId === 'string' && data.homeSessionId.startsWith('work-')
        ? data.homeSessionId
        : null,
    homeAgentId: typeof data.homeAgentId === 'string' ? data.homeAgentId : '',
    homeMentions: Array.isArray(data.homeMentions) ? data.homeMentions.filter(isStoredMention) : [],
    homeResources: data.homeResources && typeof data.homeResources === 'object' ? {
      skills: Array.isArray(data.homeResources.skills) ? data.homeResources.skills.filter((v): v is string => typeof v === 'string') : [],
      mcpServers: Array.isArray(data.homeResources.mcpServers) ? data.homeResources.mcpServers.filter((v): v is string => typeof v === 'string') : [],
      knowledgeBases: Array.isArray(data.homeResources.knowledgeBases) ? data.homeResources.knowledgeBases.filter((v): v is string => typeof v === 'string') : [],
      ...(Array.isArray(data.homeResources.knowledgeBaseMentionsConsumed) ? { knowledgeBaseMentionsConsumed: consumedKnowledgeMentions(data.homeResources.knowledgeBaseMentionsConsumed, data.homeResources.knowledgeBases) } : {}),
      ...(Array.isArray(data.homeResources.resourceOverrides) ? { resourceOverrides: resourceOverrides(data.homeResources.resourceOverrides) } : {}),
      toolkits: Array.isArray(data.homeResources.toolkits) ? [...new Set(data.homeResources.toolkits.filter((v): v is string => typeof v === 'string'))] : []
    } : { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] }
  }
}

function storedAutomationOrigin(value: unknown): value is NonNullable<SessionTask['origin']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const origin = value as Record<string, unknown>
  return origin.kind === 'automation' && typeof origin.jobId === 'string' && origin.jobId.trim().length > 0
    && typeof origin.runId === 'string' && origin.runId.trim().length > 0
}

export function getSessionState(source: string): SessionState {
  const cached = states.get(source)
  if (cached) return cached
  let state = emptyState()
  try {
    state = normalizeSessionState(JSON.parse(localStorage.getItem(sessionStorageKey(source)) ?? 'null'))
  } catch {
    /* A damaged preference must not prevent opening Work. */
  }
  states.set(source, state)
  return state
}

export function updateSessionState(source: string, update: (state: SessionState) => SessionState): void {
  const original = getSessionState(source)
  const dirty = dirtyDrafts.get(source)
  // Structural writes include the latest draft, so sending/clearing a draft cannot
  // race a delayed autosave and restore text that has already been submitted.
  const previous = dirty?.size ? {
    ...original,
    ...(dirty.has(null) ? { homeDraft: getSessionDraft(source, null).text, homeMentions: getSessionDraft(source, null).mentions } : {}),
    tasks: original.tasks.map(task => dirty.has(task.id)
      ? { ...task, draft: getSessionDraft(source, task.id).text, mentions: getSessionDraft(source, task.id).mentions }
      : task)
  } : original
  const updated = update(previous)
  let next = updated
  if (updated.tasks !== previous.tasks) {
    const previousTasks = new Map(previous.tasks.map(task => [task.id, task]))
    const trackedTasks = updated.tasks.map(task => trackSessionTaskCompletion(previousTasks.get(task.id), task))
    if (trackedTasks.some((task, index) => task !== updated.tasks[index])) next = { ...updated, tasks: trackedTasks }
  }
  dirtyDrafts.delete(source)
  draftSaves.get(source)?.cancel()
  if (sameFields(original, next) || (
    sameFields({ ...original, tasks: next.tasks }, next) &&
    original.tasks.length === next.tasks.length && original.tasks.every((task, index) => sameFields(task, next.tasks[index]))
  )) return
  states.set(source, next)
  publishDraft(source, null, { text: next.homeDraft, mentions: next.homeMentions })
  const originalTasks = new Map(original.tasks.map(task => [task.id, task]))
  for (const task of next.tasks) {
    const oldTask = originalTasks.get(task.id)
    if (!oldTask || oldTask.draft !== task.draft || oldTask.mentions !== task.mentions)
      publishDraft(source, task.id, { text: task.draft, mentions: task.mentions ?? [] })
  }
  for (const id of originalTasks.keys()) {
    if (next.tasks.some(task => task.id === id)) continue
    // A removed task must not retain an editor snapshot that a late autosave
    // or a mounted draft subscriber can read back after the structural delete.
    drafts.get(source)?.delete(id)
    for (const listener of draftListeners.get(source)?.get(id) ?? []) listener()
  }
  try {
    localStorage.setItem(sessionStorageKey(source), JSON.stringify(next))
  } catch {
    /* In-memory tasks remain usable when storage is full. */
  }
  for (const listener of listeners.get(source) ?? []) listener()
}

/** Removes only local conversation state; workspace files belong to the user. */
export function removeSessionTask(source: string, id: string): void {
  updateSessionState(source, state => state.tasks.some(task => task.id === id) ? {
    ...state,
    tasks: state.tasks.filter(task => task.id !== id),
    activeTaskId: state.activeTaskId === id ? null : state.activeTaskId
  } : state)
}

export function markSessionTaskCompletionRead(source: string, id: string): void {
  updateSessionState(source, state => {
    if (!state.tasks.some(task => task.id === id && task.status === 'done' && task.completionUnread)) return state
    return { ...state, tasks: state.tasks.map(task => task.id === id
      ? { ...task, completionUnread: undefined } : task) }
  })
}

export function onSessionStateChanged(source: string, listener: () => void): () => void {
  let subscribers = listeners.get(source)
  if (!subscribers) { subscribers = new Set(); listeners.set(source, subscribers) }
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (!subscribers.size) listeners.delete(source)
  }
}
export function useSessionState(source: string): SessionState {
  return useSyncExternalStore(
    useCallback(listener => onSessionStateChanged(source, listener), [source]),
    useCallback(() => getSessionState(source), [source])
  )
}

export function sessionStatus(messages: ChatMessage[], streaming: boolean, root?: RootRun): TaskStatus | null {
  const last = messages.filter((message) => message.role === 'assistant').at(-1)
  // A transport can remain attached after the engine has published its terminal
  // root. Its lifetime must not turn a confirmed failure/completion into running.
  const authoritative = root ?? last?.run
  if (authoritative) return sessionTaskStatusFromRun({ run: authoritative }, 'interrupted')
  if (!last) return null
  if (last.status === 'waiting') return 'waiting'
  if (streaming || last.status === 'streaming') return 'running'
  if (last.status === 'aborted') return 'stopped'
  if (last.status === 'interrupted') return 'interrupted'
  return last.status === 'error' ? 'error' : 'done'
}

/** File versions come from engine write receipts, never from guessed Markdown filenames. */
export function sessionArtifacts(messages: ChatMessage[], commandJobs: CommandJobSnapshot[] = [], sessionId?: string): SessionArtifact[] {
  const receipts = new Map<string, { change: NonNullable<ChatMessage['tools'][number]['change']>; status: SessionArtifact['status'] }>()
  for (const message of messages)
    for (const tool of message.tools) {
      const changes = mergeFileChanges(tool.changes, tool.change)
      for (const change of changes) {
        if (sessionId && change.sessionId && change.sessionId !== sessionId) continue
        const previous = receipts.get(change.id)
        if (previous && (previous.change.path !== change.path || previous.change.kind !== change.kind ||
          previous.change.sessionId && change.sessionId && previous.change.sessionId !== change.sessionId)) continue
        // A later task failure does not undo a completed file write. Conversely,
        // a completed assistant message cannot certify an unresolved tool.
        const status = tool.state === 'done' && tool.metadata?.success !== false ? 'ready'
          : tool.state === 'running' && message.status === 'streaming' ? 'draft' : 'unverified'
        receipts.set(change.id, { change: mergeFileChanges(previous?.change, change)[0], status })
      }
    }
  // Child commands belong to the root conversation, but deliberately cannot
  // attach to its execute_cmd card. Only a visible owning run/turn may expose
  // their receipts; retained diagnostics must not revive a deleted turn.
  for (const job of sessionId ? visibleChildCommandJobs(messages, commandJobs, sessionId) : []) {
    const status: SessionArtifact['status'] = job.status === 'succeeded' ? 'ready' : job.status === 'running' ? 'draft' : 'unverified'
    for (const change of mergeFileChanges(job.changes)) {
      if (change.sessionId && change.sessionId !== sessionId) continue
      const previous = receipts.get(change.id)
      if (previous && (previous.change.path !== change.path || previous.change.kind !== change.kind ||
        previous.change.sessionId && change.sessionId && previous.change.sessionId !== change.sessionId)) continue
      const merged = mergeFileChanges(previous?.change, change)[0]
      receipts.set(change.id, { change: merged, status })
    }
  }
  const artifacts: SessionArtifact[] = []
  const liveWrites = new Map<string, SessionArtifact[]>()
  const ordered = [...receipts.values()]
  const sequenced = ordered.every(item => typeof item.change.seq === 'number')
  ordered.sort((a, b) => sequenced
    ? a.change.seq! - b.change.seq! : a.change.createdAt - b.change.createdAt)
  for (const { change, status } of ordered) {
    if (change.status === 'reverted') continue
    const normalized = change.path.replace(/\\/g, '/')
    const key = /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
    if (change.kind === 'delete') {
      // Retain the historical write as evidence, but never advertise a deleted
      // scratch document as a usable or still-running deliverable.
      for (const artifact of liveWrites.get(key) ?? []) artifact.status = 'deleted'
      liveWrites.delete(key)
      continue
    }
    const artifact: SessionArtifact = {
        id: change.id,
        path: change.path,
        name: normalized.split('/').at(-1) || change.path,
        content: change.newContent,
        status,
        createdAt: change.createdAt,
        ...(change.producerChildSessionId && change.producerRunId ? {
          producerChildSessionId: change.producerChildSessionId, producerRunId: change.producerRunId
        } : {})
    }
    artifacts.push(artifact)
    const writes = liveWrites.get(key) ?? []
    writes.push(artifact); liveWrites.set(key, writes)
  }
  return artifacts.sort((a, b) => b.createdAt - a.createdAt)
}

export function sessionArtifactStatusLabel(status: SessionArtifact['status']): string {
  return { ready: '已写入', draft: '写入中', deleted: '已删除', unverified: '待核验' }[status]
}
