import { useCallback, useSyncExternalStore } from 'react'
import type { ChatAttachment, ChatMessage } from '@renderer/core/engine/useChat'
import { isStoredMention, type Mention } from '@renderer/contrib/chat/mention-context'
import { createDraftPersistenceScheduler } from './work-draft-persistence'

export type WorkTaskStatus =
  'draft' | 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'interrupted'
export interface WorkTask {
  id: string
  title: string
  draft: string
  status: WorkTaskStatus
  createdAt: number
  updatedAt: number
  workspacePath: string | null
  modelId: string
  attachments: ChatAttachment[]
  sources: ChatAttachment[]
  agentId?: string
  /** The engine fixes this binding at the first send, including the default Agent. */
  agentLocked?: boolean
  mentions?: Mention[]
  resources?: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
  /** 已归档任务仍保留在本地状态中，方便恢复历史与导出，不参与默认任务列表。 */
  archived?: boolean
  archivedAt?: number
  /** A real scheduler session can use a UUID rather than Work's client-generated prefix. */
  origin?: { kind: 'automation'; jobId: string; runId: string }
}
export interface WorkArtifact {
  id: string
  path: string
  name: string
  content: string | null
  status: 'draft' | 'ready'
  createdAt: number
}
export interface WorkState {
  tasks: WorkTask[]
  activeTaskId: string | null
  homeDraft: string
  homeWorkspacePath: string | null
  homeAttachments: ChatAttachment[]
  homeModelId: string
  homeSessionId: string | null
  homeAgentId: string
  homeMentions: Mention[]
  homeResources: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
}

const states = new Map<string, WorkState>()
const listeners = new Map<string, Set<() => void>>()
export interface WorkDraft { text: string; mentions: Mention[] }
const drafts = new Map<string, Map<string | null, WorkDraft>>()
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
function sourceDrafts(source: string): Map<string | null, WorkDraft> {
  let entries = drafts.get(source)
  if (!entries) { entries = new Map(); drafts.set(source, entries) }
  return entries
}
export function getWorkDraft(source: string, taskId: string | null): WorkDraft {
  const entries = sourceDrafts(source)
  const cached = entries.get(taskId)
  if (cached) return cached
  const state = getWorkState(source)
  const task = taskId ? state.tasks.find(item => item.id === taskId) : null
  const draft = { text: taskId ? task?.draft ?? '' : state.homeDraft, mentions: taskId ? task?.mentions ?? [] : state.homeMentions }
  entries.set(taskId, draft)
  return draft
}
function publishDraft(source: string, taskId: string | null, draft: WorkDraft): void {
  const previous = getWorkDraft(source, taskId)
  if (previous.text === draft.text && sameMentions(previous.mentions, draft.mentions)) return
  sourceDrafts(source).set(taskId, draft)
  for (const listener of draftListeners.get(source)?.get(taskId) ?? []) listener()
}

/** The input subscribes to its own draft; history and hidden panels do not render per character. */
export function updateWorkDraft(source: string, taskId: string | null, text: string, mentions: Mention[]): void {
  const previous = getWorkDraft(source, taskId)
  if (previous.text === text && sameMentions(previous.mentions, mentions)) return
  publishDraft(source, taskId, { text, mentions })
  let dirty = dirtyDrafts.get(source)
  if (!dirty) { dirty = new Set(); dirtyDrafts.set(source, dirty) }
  dirty.add(taskId)
  let save = draftSaves.get(source)
  if (!save) {
    save = createDraftPersistenceScheduler(() => updateWorkState(source, state => state))
    draftSaves.set(source, save)
  }
  save.schedule()
  if (!watchingDraftLifecycle && typeof window !== 'undefined') {
    watchingDraftLifecycle = true
    const flush = (): void => flushWorkDrafts()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
  }
}
export function flushWorkDrafts(source?: string): void {
  if (source !== undefined) draftSaves.get(source)?.flush()
  else for (const save of draftSaves.values()) save.flush()
}
export function onWorkDraftChanged(source: string, taskId: string | null, listener: () => void): () => void {
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
export function useWorkDraft(source: string, taskId: string | null): WorkDraft {
  return useSyncExternalStore(
    useCallback(listener => onWorkDraftChanged(source, taskId, listener), [source, taskId]),
    useCallback(() => getWorkDraft(source, taskId), [source, taskId])
  )
}
export function workStorageKey(source: string): string {
  return 'aether.work.state.v1' + (source ? ':' + encodeURIComponent(source) : '')
}
const emptyState = (): WorkState => ({
  tasks: [],
  activeTaskId: null,
  homeDraft: '',
  homeWorkspacePath: null,
  homeAttachments: [],
  homeModelId: '',
  homeSessionId: null,
  homeAgentId: '',
  homeMentions: [],
  homeResources: { skills: [], mcpServers: [], knowledgeBases: [] }
})

function attachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  return (
    value
      .filter((item): item is ChatAttachment =>
        Boolean(
          item &&
          typeof item === 'object' &&
          typeof item.path === 'string' &&
          typeof item.name === 'string' &&
          typeof item.type === 'string' &&
          typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
        )
      )
      // Upload tokens live in the main process only. Persisted remote paths are already
      // checked by its session-relative attachment adapter when a draft is restored.
      .map(({ path, name, type, size }) => ({ path, name, type, size }))
  )
}

export function normalizeWorkState(value: unknown): WorkState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState()
  const data = value as Partial<WorkState>
  const statuses: WorkTaskStatus[] = [
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
              knowledgeBases: Array.isArray(task.resources.knowledgeBases) ? task.resources.knowledgeBases.filter((v): v is string => typeof v === 'string') : []
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
      knowledgeBases: Array.isArray(data.homeResources.knowledgeBases) ? data.homeResources.knowledgeBases.filter((v): v is string => typeof v === 'string') : []
    } : { skills: [], mcpServers: [], knowledgeBases: [] }
  }
}

function storedAutomationOrigin(value: unknown): value is NonNullable<WorkTask['origin']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const origin = value as Record<string, unknown>
  return origin.kind === 'automation' && typeof origin.jobId === 'string' && origin.jobId.trim().length > 0
    && typeof origin.runId === 'string' && origin.runId.trim().length > 0
}

export function getWorkState(source: string): WorkState {
  const cached = states.get(source)
  if (cached) return cached
  let state = emptyState()
  try {
    state = normalizeWorkState(JSON.parse(localStorage.getItem(workStorageKey(source)) ?? 'null'))
  } catch {
    /* A damaged preference must not prevent opening Work. */
  }
  states.set(source, state)
  return state
}

export function updateWorkState(source: string, update: (state: WorkState) => WorkState): void {
  const original = getWorkState(source)
  const dirty = dirtyDrafts.get(source)
  // Structural writes include the latest draft, so sending/clearing a draft cannot
  // race a delayed autosave and restore text that has already been submitted.
  const previous = dirty?.size ? {
    ...original,
    ...(dirty.has(null) ? { homeDraft: getWorkDraft(source, null).text, homeMentions: getWorkDraft(source, null).mentions } : {}),
    tasks: original.tasks.map(task => dirty.has(task.id)
      ? { ...task, draft: getWorkDraft(source, task.id).text, mentions: getWorkDraft(source, task.id).mentions }
      : task)
  } : original
  const next = update(previous)
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
  try {
    localStorage.setItem(workStorageKey(source), JSON.stringify(next))
  } catch {
    /* In-memory tasks remain usable when storage is full. */
  }
  for (const listener of listeners.get(source) ?? []) listener()
}

export function onWorkStateChanged(source: string, listener: () => void): () => void {
  let subscribers = listeners.get(source)
  if (!subscribers) { subscribers = new Set(); listeners.set(source, subscribers) }
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (!subscribers.size) listeners.delete(source)
  }
}
export function useWorkState(source: string): WorkState {
  return useSyncExternalStore(
    useCallback(listener => onWorkStateChanged(source, listener), [source]),
    useCallback(() => getWorkState(source), [source])
  )
}

export function workStatus(messages: ChatMessage[], streaming: boolean): WorkTaskStatus | null {
  const last = messages.filter((message) => message.role === 'assistant').at(-1)
  if (!last) return null
  if (last.status === 'waiting') return 'waiting'
  if (streaming || last.status === 'streaming') return 'running'
  if (last.status === 'aborted') return 'stopped'
  if (last.status === 'interrupted') return 'interrupted'
  return last.status === 'error' ? 'error' : 'done'
}

/** File versions come from engine write receipts, never from guessed Markdown filenames. */
export function workArtifacts(messages: ChatMessage[]): WorkArtifact[] {
  const seen = new Map<string, WorkArtifact>()
  for (const message of messages)
    for (const tool of message.tools) {
      const change = tool.change
      if (!change || change.kind !== 'write' || change.status === 'reverted') continue
      seen.set(change.id, {
        id: change.id,
        path: change.path,
        name: change.path.replace(/\\/g, '/').split('/').at(-1) || change.path,
        content: change.newContent,
        status: message.status === 'done' ? 'ready' : 'draft',
        createdAt: change.createdAt
      })
    }
  return [...seen.values()].sort((a, b) => b.createdAt - a.createdAt)
}
