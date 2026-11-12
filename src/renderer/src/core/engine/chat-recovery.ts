import type { CommandJobSnapshot } from '@shared/command-job'
import { attachCommandJobs } from './command-job-state'
import type { ChatSsePayload, EngineFileChange, EngineTodo } from '@shared/ipc'
import type { RootRun } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { replayMessages, type EngineHistoryRow } from './chat-history'
import { restoreProjectedTimeline } from './chat-snapshot-timeline'
import { applyRootRuns } from './root-run-state'
import { inspectStreamCursor } from '@shared/stream-event'
import { normalizeFinalResult } from '@shared/final-result'

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
  publicationRecovery?: { reason: string; lastConfirmedEventId: string }
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
  sessionSubagentUsage?: import('@renderer/features/conversation/shared/session-usage').SessionSubagentUsage
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
    for (const payload of snapshot.projection) if (payload.todo?.todos) todos = payload.todo.todos
    messages = restoreProjectedTimeline(snapshot, messages, run)
  }

  // Published stream checkpoints keep their original bytes. Current history
  // applies later asset withdrawals, including when a partial rollback kept
  // the conversation. Replaying an older checkpoint must not revive its cards.
  const currentResults = new Map(snapshot.history.flatMap(row => {
    const result = normalizeFinalResult(row.metadata?.finalResult)
    return row.role === 'assistant' && result && row.id === result.assistantMessageId &&
      result.sessionId === snapshot.sessionId && row.conversationId === result.turnId
      ? [[result.assistantMessageId, result] as const] : []
  }))
  messages = messages.map(message => {
    const result = currentResults.get(message.id)
    return result && message.role === 'assistant' && message.runId === result.runId &&
      message.conversationId === result.turnId ? { ...message, finalResult: result } : message
  })

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
