import type { CommandJobSnapshot } from '@shared/command-job'
import { attachCommandJobs } from './command-job-state'
import type { ChatSsePayload, EngineFileChange, EngineTodo } from '@shared/ipc'
import type { RootRun } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { replayMessages, type EngineHistoryRow } from './chat-history'
import { reducePayload } from './chat-payload'
import { applyRootRuns } from './root-run-state'
import { inspectStreamCursor } from '@shared/stream-event'

export interface ChatRecoverySnapshot {
  schemaVersion: 1
  source: 'live' | 'persisted' | 'persisted-published'
  executionRun?: RootRun
  publishedUsage?: import('@shared/published-child').PublishedChildUsage
  subagentRecovery?: unknown
  projectionIndices?: number[]
  currentTurnComplete?: boolean
  subagentProjectionArchive?: { protocolVersion: 1; snapshotId: string; totalCount: number; originalProjectionCount: number; endpoint: '/chat/snapshot/projection' }
  bodyArchive?: { protocolVersion: 1; source: 'sealed-current-turn'; endpoint: '/chat/snapshot/body'; sha256: string; byteLength: number; chunkCount: number; originalProjectionCount: number; originalCurrentTurnComplete: boolean; previewComplete: false }
  sessionId: string
  eventId: string | null
  finished: boolean
  error?: string
  projection: ChatSsePayload[]
  run?: RootRun
  runs: RootRun[]
  history: EngineHistoryRow[]
  /** The compact snapshot omits older JSONL rows; the archive route can expand them. */
  historyCompacted?: boolean
  todos: EngineTodo[]
  changes: EngineFileChange[]
  commandJobs?: CommandJobSnapshot[]
  /** Full-session billing paired with the snapshot event watermark, independent of visible history. */
  sessionUsage?: Record<string, number>
  sessionSubagentUsage?: import('@renderer/contrib/chat/session-usage').SessionSubagentUsage
  /** Child runs sampled with sessionSubagentUsage, before independent live refreshes. */
  subagentRuns?: import('@shared/subagent').SubagentRun[]
}

/** Same-stream repeated or older delivery must never append text or tool arguments twice. */
export function acceptEventId(consumed: string | null, incoming?: string): boolean {
  const disposition = inspectStreamCursor(consumed, incoming)
  return disposition === 'untracked' || disposition === 'forward'
}

/** Replace the current assistant turn, never append a snapshot to already replayed partial text. */
export function restoreChatSnapshot(snapshot: ChatRecoverySnapshot): { messages: ChatMessage[]; todos: EngineTodo[] } {
  let messages = replayMessages(snapshot.history)
  let todos = snapshot.todos ?? []
  const run = snapshot.run
  if ((snapshot.source === 'live' || snapshot.source === 'persisted-published') && run && snapshot.projection.length) {
    const projectedUser = snapshot.projection.find(payload => payload.userMessage)?.userMessage as EngineHistoryRow | undefined
    if (projectedUser) {
      const user = replayMessages([projectedUser])[0]
      if (user) {
        const index = messages.findIndex(message => message.id === run.userMessageId)
        if (index < 0) messages.push(user)
        else messages[index] = user
      }
    }
    messages = messages.filter(message => message.role !== 'assistant' ||
      (message.runId !== run.runId && message.conversationId !== run.turnId && message.id !== run.assistantMessageId))
    let assistant: ChatMessage = {
      id: run.assistantMessageId, runId: run.runId, conversationId: run.turnId,
      role: 'assistant', content: '', thinking: '', tools: [], items: [],
      status: 'streaming', createdAt: run.createdAt, startedAt: run.createdAt
    }
    const publishedByTool = new Map<string, number>(), publishedByRun = new Map<string, number>()
    for (const [frameIndex, payload] of snapshot.projection.entries()) {
      if (payload.todo?.todos) todos = payload.todo.todos
      const previousTools = assistant.tools
      // The same fixed frame can be restored after another reference page or
      // a late body read; its fallback identity/time must remain stable.
      assistant = reducePayload(assistant, payload, { now: run.createdAt,
        fallbackId: `recovered:${run.runId}:${snapshot.projectionIndices?.[frameIndex] ?? frameIndex}` })
      if (assistant.tools !== previousTools) {
        publishedByTool.clear(); publishedByRun.clear()
        assistant.tools.forEach((tool, index) => {
          publishedByTool.set(tool.id, index)
          if (tool.subagentRef) publishedByRun.set(tool.subagentRef.identity.runId, index)
        })
      }
      if (payload.publishedChild) {
        const ref = payload.publishedChild, id = ref.identity.parentToolCallId
        const existing = publishedByTool.get(id) ?? publishedByRun.get(ref.identity.runId)
        // This draft is owned by snapshot restoration and is published once at
        // the end. Repeated child evidence should not copy every earlier card.
        if (existing === undefined) {
          const index = assistant.tools.length
          assistant.tools.push({ id, name: 'subagent', args: '', result: '', state: 'unknown', subagentRef: ref, startedAt: ref.identity.createdAt })
          assistant.items.push({ kind: 'tool', id })
          publishedByTool.set(id, index); publishedByRun.set(ref.identity.runId, index)
        } else {
          assistant.tools[existing] = { ...assistant.tools[existing], subagent: undefined, subagentRef: ref, state: 'unknown' }
          publishedByTool.set(id, existing); publishedByRun.set(ref.identity.runId, existing)
        }
      }
    }
    if (snapshot.publishedUsage) assistant = { ...assistant, publishedChildFence: snapshot.publishedUsage.fence }
    messages.push(assistant)
  }
  const execution = snapshot.executionRun ?? run
  const runs = [...snapshot.runs.filter(item => item.runId !== run?.runId), ...(execution ? [execution] : [])]
  messages = applyRootRuns(messages, runs)
  // Persisted status can have changed after the tool result was written (keep/revert).
  const changes = new Map((snapshot.changes ?? []).map(change => [change.id, change]))
  messages = messages.map(message => ({ ...message, tools: message.tools.map(tool => {
    const current = tool.change && changes.get(tool.change.id)
    return current ? { ...tool, change: { ...tool.change, ...current } } : tool
  }) }))
  return { messages: attachCommandJobs(messages, snapshot.commandJobs ?? [], snapshot.sessionId), todos }
}
