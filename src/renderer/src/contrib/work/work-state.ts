import { useSyncExternalStore } from 'react'
import type { ChatAttachment, ChatMessage } from '@renderer/core/engine/useChat'
import type { Mention } from '@renderer/contrib/chat/MentionInput'

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
  mentions?: Mention[]
  resources?: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
  /** 已归档任务仍保留在本地状态中，方便恢复历史与导出，不参与默认任务列表。 */
  archived?: boolean
  archivedAt?: number
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
const listeners = new Set<() => void>()
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
          typeof item.size === 'number'
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
            task.id.startsWith('work-') &&
            typeof task.title === 'string' &&
            typeof task.createdAt === 'number'
        )
        .map((task) => ({
          ...task,
          draft: typeof task.draft === 'string' ? task.draft : '',
          updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : task.createdAt,
          status: statuses.includes(task.status) ? task.status : 'draft',
          workspacePath: typeof task.workspacePath === 'string' ? task.workspacePath : null,
          modelId: typeof task.modelId === 'string' ? task.modelId : '',
          attachments: attachments(task.attachments),
          sources: attachments(task.sources),
          agentId: typeof task.agentId === 'string' ? task.agentId : undefined,
          mentions: Array.isArray(task.mentions) ? (task.mentions as Mention[]) : [],
          resources: task.resources && typeof task.resources === 'object' ? {
            skills: Array.isArray(task.resources.skills) ? task.resources.skills.filter((v): v is string => typeof v === 'string') : [],
            mcpServers: Array.isArray(task.resources.mcpServers) ? task.resources.mcpServers.filter((v): v is string => typeof v === 'string') : [],
            knowledgeBases: Array.isArray(task.resources.knowledgeBases) ? task.resources.knowledgeBases.filter((v): v is string => typeof v === 'string') : []
          } : { skills: [], mcpServers: [], knowledgeBases: [] },
          ...(task.archived === true
            ? {
                archived: true,
                ...(typeof task.archivedAt === 'number' ? { archivedAt: task.archivedAt } : {})
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
    homeMentions: Array.isArray(data.homeMentions) ? (data.homeMentions as Mention[]) : [],
    homeResources: data.homeResources && typeof data.homeResources === 'object' ? {
      skills: Array.isArray(data.homeResources.skills) ? data.homeResources.skills.filter((v): v is string => typeof v === 'string') : [],
      mcpServers: Array.isArray(data.homeResources.mcpServers) ? data.homeResources.mcpServers.filter((v): v is string => typeof v === 'string') : [],
      knowledgeBases: Array.isArray(data.homeResources.knowledgeBases) ? data.homeResources.knowledgeBases.filter((v): v is string => typeof v === 'string') : []
    } : { skills: [], mcpServers: [], knowledgeBases: [] }
  }
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
  const next = update(getWorkState(source))
  states.set(source, next)
  try {
    localStorage.setItem(workStorageKey(source), JSON.stringify(next))
  } catch {
    /* In-memory tasks remain usable when storage is full. */
  }
  for (const listener of listeners) listener()
}

export function useWorkState(source: string): WorkState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => getWorkState(source)
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
