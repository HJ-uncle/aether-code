import type { ChatSsePayload, EngineFileChange, EngineTodo } from '@shared/ipc'
import type { RootRun } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { replayMessages, type EngineHistoryRow } from './chat-history'
import { reducePayload } from './chat-payload'
import { applyRootRuns } from './root-run-state'

export interface ChatRecoverySnapshot {
  schemaVersion: 1
  source: 'live' | 'persisted'
  sessionId: string
  eventId: string | null
  finished: boolean
  error?: string
  projection: ChatSsePayload[]
  run?: RootRun
  runs: RootRun[]
  history: EngineHistoryRow[]
  todos: EngineTodo[]
  changes: EngineFileChange[]
}

/** Same-stream repeated or older delivery must never append text or tool arguments twice. */
export function acceptEventId(consumed: string | null, incoming?: string): boolean {
  if (!incoming || !consumed) return true
  const previous = consumed.lastIndexOf(':'), next = incoming.lastIndexOf(':')
  if (previous < 0 || next < 0 || consumed.slice(0, previous) !== incoming.slice(0, next)) return incoming !== consumed
  const oldSeq = Number(consumed.slice(previous + 1)), newSeq = Number(incoming.slice(next + 1))
  return Number.isSafeInteger(newSeq) && Number.isSafeInteger(oldSeq) && newSeq > oldSeq
}

/** Replace the current assistant turn, never append a snapshot to already replayed partial text. */
export function restoreChatSnapshot(snapshot: ChatRecoverySnapshot): { messages: ChatMessage[]; todos: EngineTodo[] } {
  let messages = replayMessages(snapshot.history)
  let todos = snapshot.todos ?? []
  const run = snapshot.run
  if (snapshot.source === 'live' && run && snapshot.projection.length) {
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
    for (const payload of snapshot.projection) {
      if (payload.todo?.todos) todos = payload.todo.todos
      assistant = reducePayload(assistant, payload)
    }
    messages.push(assistant)
  }
  const runs = [...snapshot.runs.filter(item => item.runId !== run?.runId), ...(run ? [run] : [])]
  messages = applyRootRuns(messages, runs)
  // Persisted status can have changed after the tool result was written (keep/revert).
  const changes = new Map((snapshot.changes ?? []).map(change => [change.id, change]))
  messages = messages.map(message => ({ ...message, tools: message.tools.map(tool => {
    const current = tool.change && changes.get(tool.change.id)
    return current ? { ...tool, change: { ...tool.change, ...current } } : tool
  }) }))
  return { messages, todos }
}
